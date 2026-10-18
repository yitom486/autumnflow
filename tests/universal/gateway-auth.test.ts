// @vitest-environment node
/**
 * 网关强制鉴权（安全修复回归）：
 * - 不带 token 的 /api/universal/*（包括 terminal/exec）一律 401，哪怕没有 Origin 头；
 * - 正确 token 才放行；token 正确但 Origin / Host 不可信照样 401；
 * - PTY WebSocket 升级同样要 token（`?token=`）。
 */
import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { buildApp, shutdownBridges } from "../../server/gateway";
import { handleUniversal } from "../../server/universal/routes";
import { gatewayAuthHeaders, gatewayBootstrapUrl, GATEWAY_SESSION_COOKIE } from "../../server/universal/security";
import { attachPtyUpgrade } from "../../server/universal/pty";
import { TEST_GATEWAY_TOKEN, authedRequest } from "../helpers/gateway-auth";
import { rmTempDir } from "../helpers/tmp-cleanup";

const app = buildApp();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-auth-"));

afterAll(async () => {
  await shutdownBridges();
  // Windows 上刚退出的 PowerShell 子进程可能还短暂占着 cwd，重试几次再删。
  rmTempDir(tmp);
});

const isWin = process.platform === "win32";

function execBody(marker: string): string {
  // 有副作用的“无害”命令：执行了就会生成 marker 文件，便于断言“根本没执行”。
  const command = isWin ? `New-Item -ItemType File -Path '${marker}' | Out-Null; Write-Output pwned` : `touch '${marker}' && echo pwned`;
  return JSON.stringify({ cwd: tmp, command });
}

async function readAll(res: Response): Promise<string> {
  return res.body ? await new Response(res.body).text() : "";
}

describe("gateway auth: token is mandatory", () => {
  it("rejects unauthenticated terminal/exec without Origin (the old curl exploit) and never runs it", async () => {
    const marker = path.join(tmp, "noauth.marker");
    const res = await app.fetch(
      new Request("http://127.0.0.1:3004/api/universal/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: execBody(marker),
      })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.gatewayUnauthorized).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("rejects a wrong token and a malformed Authorization header", async () => {
    for (const authorization of ["Bearer not-the-token", "Basic abc", "Bearer "]) {
      const res = await app.fetch(
        new Request("http://127.0.0.1:3004/api/universal/agents", { headers: { authorization } })
      );
      expect(res.status, authorization).toBe(401);
    }
  });

  it("rejects GET routes without token too (agents list, workspace default)", async () => {
    for (const p of ["/api/universal/agents", "/api/universal/workspace/default", "/api/universal/terminal/pty/status"]) {
      const res = await app.fetch(new Request(`http://127.0.0.1:3004${p}`));
      expect(res.status, p).toBe(401);
    }
  });

  it("accepts the desktop HttpOnly session cookie and rejects a wrong one", async () => {
    const good = await app.fetch(
      new Request("http://127.0.0.1:3004/api/universal/agents", {
        headers: { cookie: `${GATEWAY_SESSION_COOKIE}=${encodeURIComponent(TEST_GATEWAY_TOKEN)}` },
      })
    );
    expect(good.status).toBe(200);
    const bad = await app.fetch(
      new Request("http://127.0.0.1:3004/api/universal/agents", {
        headers: { cookie: `${GATEWAY_SESSION_COOKIE}=wrong` },
      })
    );
    expect(bad.status).toBe(401);

    const crossOrigin = await app.fetch(
      new Request("http://127.0.0.1:3004/api/universal/agents", {
        headers: {
          cookie: `${GATEWAY_SESSION_COOKIE}=${encodeURIComponent(TEST_GATEWAY_TOKEN)}`,
          origin: "http://127.0.0.1:9999",
        },
      })
    );
    expect(crossOrigin.status).toBe(401);
    const sameOrigin = await app.fetch(
      new Request("http://127.0.0.1:3004/api/universal/agents", {
        headers: {
          cookie: `${GATEWAY_SESSION_COOKIE}=${encodeURIComponent(TEST_GATEWAY_TOKEN)}`,
          origin: "http://127.0.0.1:3004",
        },
      })
    );
    expect(sameOrigin.status).toBe(200);
  });

  it("accepts the correct token and actually executes", async () => {
    const marker = path.join(tmp, "authed.marker");
    const res = await app.fetch(
      authedRequest("http://127.0.0.1:3004/api/universal/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: execBody(marker),
      })
    );
    expect(res.status).toBe(200);
    expect(await readAll(res)).toContain("pwned");
    expect(fs.existsSync(marker)).toBe(true);
    // Windows CI 上 PowerShell 冷启动常超过 vitest 默认的 5s。
  }, 30_000);

  it("keeps origin + host checks even with a valid token", async () => {
    const evil = await app.fetch(
      authedRequest("http://127.0.0.1:3004/api/universal/agents", { headers: { Origin: "https://evil.example" } })
    );
    expect(evil.status).toBe(401);
    const rebinding = await app.fetch(
      authedRequest("http://attacker.example:3004/api/universal/agents", { headers: { Host: "attacker.example:3004" } })
    );
    expect(rebinding.status).toBe(401);
    const local = await app.fetch(
      authedRequest("http://127.0.0.1:3004/api/universal/agents", { headers: { Origin: "http://localhost:5188" } })
    );
    expect(local.status).toBe(200);
    expect(local.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5188");
  });

  it("handleUniversal enforces auth on its own (no fail-open when mounted directly)", async () => {
    const res = (await handleUniversal(new Request("http://127.0.0.1/api/universal/agents")))!;
    expect(res.status).toBe(401);
    const ok = (await handleUniversal(authedRequest("http://127.0.0.1/api/universal/agents")))!;
    expect(ok.status).toBe(200);
  });

  it("accepts ?token= only when explicitly allowed (WebSocket upgrade path)", () => {
    const url = `http://127.0.0.1:3004/api/universal/terminal/pty?token=${TEST_GATEWAY_TOKEN}`;
    expect(gatewayAuthHeaders(new Request(url)).ok).toBe(false);
    expect(gatewayAuthHeaders(new Request(url), { allowQueryToken: true }).ok).toBe(true);
    expect(gatewayAuthHeaders(new Request(url.replace(TEST_GATEWAY_TOKEN, "nope")), { allowQueryToken: true }).ok).toBe(false);
  });

  it("builds the browser bootstrap URL with the full token", () => {
    expect(gatewayBootstrapUrl("http://localhost:5188/")).toBe(`http://localhost:5188/?token=${TEST_GATEWAY_TOKEN}`);
  });
});

describe("gateway auth: PTY WebSocket upgrade", () => {
  /** 发一个原始 WS 升级请求，返回服务端回的 HTTP 状态码。 */
  function upgradeStatus(port: number, query: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: `/api/universal/terminal/pty?cwd=${encodeURIComponent(tmp)}${query}`,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode || 101);
      });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode || 0);
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("rejects the upgrade without token and lets a tokened one past auth", async () => {
    const server = http.createServer((_q, s) => s.end());
    await attachPtyUpgrade(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await upgradeStatus(port, "")).toBe(401);
      expect(await upgradeStatus(port, "&token=wrong")).toBe(401);
      // 过了鉴权：有 node-pty 时 101 升级成功，没有时 501（但绝不是 401）。
      const authed = await upgradeStatus(port, `&token=${TEST_GATEWAY_TOKEN}`);
      expect([101, 501]).toContain(authed);
    } finally {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  });
});
