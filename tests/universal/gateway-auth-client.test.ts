/**
 * 前端令牌接线（src/lib/gateway-auth.ts）：取 token 的优先级、地址栏抹除、
 * 请求头 / WS 查询串注入、401 判定。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GATEWAY_TOKEN_STORAGE_KEY,
  apiFetch,
  apiUrl,
  bootstrapGatewayToken,
  clearGatewayToken,
  gatewayHost,
  getGatewayBase,
  getGatewayToken,
  isLoopbackBase,
  parseGatewayBase,
  setGatewayBase,
  setGatewayToken,
  verifyGatewayToken,
  withTokenQuery,
} from "@/lib/gateway-auth";
import { ptyWsCandidateBases } from "@/lib/universal-api";

const realFetch = globalThis.fetch;

beforeEach(() => {
  clearGatewayToken();
  setGatewayBase("");
  delete (window as any).autumnflow;
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as any).autumnflow;
});

describe("gateway token bootstrap", () => {
  it("reads ?token= from the address bar, persists it, then strips it from the URL", async () => {
    window.history.replaceState(null, "", "/?token=abc123&x=1#h");
    expect(await bootstrapGatewayToken()).toBe("abc123");
    expect(localStorage.getItem(GATEWAY_TOKEN_STORAGE_KEY)).toBe("abc123");
    expect(window.location.search).toBe("?x=1");
    expect(window.location.hash).toBe("#h");
  });

  it("falls back to the stored token on later loads", async () => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, "stored-token");
    expect(await bootstrapGatewayToken()).toBe("stored-token");
  });

  it("prefers the Electron preload token and does not persist it", async () => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, "stale");
    (window as any).autumnflow = { platform: "linux", versions: {}, getGatewayToken: async () => "from-electron" };
    expect(await bootstrapGatewayToken()).toBe("from-electron");
    expect(getGatewayToken()).toBe("from-electron");
    expect(localStorage.getItem(GATEWAY_TOKEN_STORAGE_KEY)).toBe("stale");
  });

  it("returns null when no source has a token", async () => {
    expect(await bootstrapGatewayToken()).toBeNull();
  });

  it("cookie mode never reads the preload token or injects Authorization/query", async () => {
    (window as any).autumnflow = {
      platform: "win32",
      authMode: "cookie",
      versions: {},
      getGatewayToken: async () => "must-not-be-used",
    };
    expect(await bootstrapGatewayToken()).toBeNull();
    const spy = vi.fn(async () => new Response("{}"));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiFetch("/api/universal/agents");
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
    expect(withTokenQuery("ws://h/api/universal/terminal/pty?ptyId=1")).toBe(
      "ws://h/api/universal/terminal/pty?ptyId=1"
    );
  });
});

describe("token injection", () => {
  it("apiFetch adds Authorization and keeps caller headers", async () => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, "tkn");
    await bootstrapGatewayToken();
    const spy = vi.fn(async () => new Response("{}"));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiFetch("/api/universal/agents", { headers: { "Content-Type": "application/json" } });
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1];
    const h = new Headers(init.headers);
    expect(h.get("Authorization")).toBe("Bearer tkn");
    expect(h.get("Content-Type")).toBe("application/json");
  });

  it("withTokenQuery appends the token for WebSocket URLs", async () => {
    localStorage.setItem(GATEWAY_TOKEN_STORAGE_KEY, "a b");
    await bootstrapGatewayToken();
    expect(withTokenQuery("ws://h/api/universal/terminal/pty?ptyId=1")).toBe("ws://h/api/universal/terminal/pty?ptyId=1&token=a%20b");
  });
});

describe("verifyGatewayToken", () => {
  it("maps gateway 401 to unauthorized, agent 401 / 200 to ok, network error to unreachable", async () => {
    globalThis.fetch = (async () => Response.json({ ok: false, gatewayUnauthorized: true }, { status: 401 })) as typeof fetch;
    expect(await verifyGatewayToken()).toBe("unauthorized");
    globalThis.fetch = (async () => Response.json({ ok: false, authRequired: true }, { status: 401 })) as typeof fetch;
    expect(await verifyGatewayToken()).toBe("ok");
    globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;
    expect(await verifyGatewayToken()).toBe("ok");
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await verifyGatewayToken()).toBe("unreachable");
  });
});

describe("gateway base (远端/WSL 网关）", () => {
  it("parses empty as local, http(s) host as remote, rejects the rest", () => {
    expect(parseGatewayBase("")).toEqual({ kind: "local" });
    expect(parseGatewayBase("   ")).toEqual({ kind: "local" });
    expect(parseGatewayBase("http://127.0.0.1:4004/")).toEqual({ kind: "remote", base: "http://127.0.0.1:4004" });
    expect(parseGatewayBase("HTTPS://wsl:4004")).toEqual({ kind: "remote", base: "https://wsl:4004" });
    expect(parseGatewayBase("ws://127.0.0.1:4004").kind).toBe("invalid");
    expect(parseGatewayBase("http://127.0.0.1:4004/api").kind).toBe("invalid");
    expect(parseGatewayBase("notaurl").kind).toBe("invalid");
  });

  it("apiUrl prefixes relative paths only when a remote base is set", () => {
    expect(getGatewayBase()).toBe("");
    expect(apiUrl("/api/universal/agents")).toBe("/api/universal/agents");
    setGatewayBase("http://127.0.0.1:4004");
    expect(getGatewayBase()).toBe("http://127.0.0.1:4004");
    expect(apiUrl("/api/universal/agents")).toBe("http://127.0.0.1:4004/api/universal/agents");
    expect(apiUrl("ws://x/y")).toBe("ws://x/y");
  });

  it("apiFetch hits the remote base with the token", async () => {
    setGatewayBase("http://127.0.0.1:4004");
    setGatewayToken("remote-tkn");
    const spy = vi.fn(async () => new Response("{}"));
    globalThis.fetch = spy as unknown as typeof fetch;
    await apiFetch("/api/universal/agents");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4004/api/universal/agents");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer remote-tkn");
  });

  it("isolates tokens per base (no cross-gateway leakage)", () => {
    setGatewayToken("local-tkn");
    setGatewayBase("http://127.0.0.1:4004");
    expect(getGatewayToken()).toBeNull();
    setGatewayToken("remote-tkn");
    setGatewayBase("");
    expect(getGatewayToken()).toBe("local-tkn");
    setGatewayBase("http://127.0.0.1:4004");
    expect(getGatewayToken()).toBe("remote-tkn");
  });

  it("flags non-loopback http bases", () => {
    expect(isLoopbackBase("")).toBe(true);
    expect(isLoopbackBase("http://localhost:4004")).toBe(true);
    expect(isLoopbackBase("http://127.0.0.1:4004")).toBe(true);
    expect(isLoopbackBase("http://[::1]:4004")).toBe(true);
    expect(isLoopbackBase("http://192.168.1.10:4004")).toBe(false);
    expect(isLoopbackBase("http://example.com")).toBe(false);
  });

  it("strips the scheme for display (gatewayHost)", () => {
    expect(gatewayHost("http://127.0.0.1:4004")).toBe("127.0.0.1:4004");
    expect(gatewayHost("https://example.com")).toBe("example.com");
    expect(gatewayHost("")).toBe("");
  });

  it("puts the custom WS base first for PTY reconnects", () => {
    expect(ptyWsCandidateBases("localhost:5188", "http:", 3004, "http://127.0.0.1:4004")).toEqual([
      "ws://127.0.0.1:4004",
      "ws://localhost:5188",
      "ws://127.0.0.1:3004",
    ]);
    // 与同源重复时去重
    expect(ptyWsCandidateBases("127.0.0.1:4004", "http:", 3004, "http://127.0.0.1:4004")).toEqual([
      "ws://127.0.0.1:4004",
      "ws://127.0.0.1:3004",
    ]);
  });
});
