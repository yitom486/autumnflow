import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  shellForPlatform,
  clampPtySize,
  resolvePtyCwd,
  createPtySession,
  getPtySession,
  destroyPtySession,
  isPtyAvailable,
  type PtySpawner,
} from "../../server/universal/pty";
import { handleUniversal } from "../../server/universal/routes";
import { buildPtyWsUrl, ptyWsCandidateBases } from "@/lib/universal-api";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { authedRequest } from "../helpers/gateway-auth";

/** 假 pty 工厂：复刻 ConPTY 死后 resize 同步抛错的行为。 */
function fakeSpawner(log: string[]): PtySpawner {
  const child = {
    onData: (cb: (d: string) => void) => {},
    onExit: (cb: (e: { exitCode: number }) => void) => {
      child.__exitCb = cb;
    },
    write: (data: string) => {
      log.push(`write:${data}`);
    },
    resize: (cols: number, rows: number) => {
      if (child.__exited) throw new Error("Cannot resize a pty that has already exited");
      log.push(`resize:${cols}x${rows}`);
    },
    kill: () => {
      child.__exited = true;
      log.push("kill");
      child.__exitCb?.({ exitCode: 0 });
    },
    process: "fake",
    __exited: false,
    __exitCb: null as ((e: { exitCode: number }) => void) | null,
  };
  return ((_shell: string, _args: string[], _opts: Record<string, unknown>) => child) as unknown as PtySpawner;
}

describe("pty helpers (真终端服务端)", () => {
  it("selects a real shell per platform", () => {
    const win = shellForPlatform("win32");
    expect(win.shell).toBeTruthy();
    expect(Array.isArray(win.args)).toBe(true);
    expect(shellForPlatform("linux").shell).toBeTruthy();
  });

  it("clamps size and NaN", () => {
    expect(clampPtySize(80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(clampPtySize(1, 1000)).toEqual({ cols: 20, rows: 100 });
    expect(clampPtySize(NaN, NaN)).toEqual({ cols: 80, rows: 24 });
  });

  it("guards cwd", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acp-pty-"));
    try {
      expect(resolvePtyCwd(tmp)).toMatchObject({ ok: true });
      expect(resolvePtyCwd(path.join(tmp, "nope"))).toMatchObject({ ok: false });
      expect(resolvePtyCwd("")).toMatchObject({ ok: false });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("swallows resize-after-exit (ConPTY 死后 resize 不崩进程）", () => {
    const log: string[] = [];
    const fake = fakeSpawner(log);
    const s = createPtySession("test-pty-1", os.tmpdir(), { cols: 80, rows: 24 }, (shell, args, opts) => {
      expect(opts.useConptyDll).toBe(false);
      return fake(shell, args, opts);
    });
    expect(getPtySession("test-pty-1")).toBe(s);
    s.resize(100, 30);
    expect(log).toContain("resize:100x30");
    let code = -1;
    s.onExit((c) => (code = c));
    s.kill();
    expect(code).toBe(0);
    expect(s.exited).toBe(true);
    // 死后写与 resize 都是空操作、不抛错
    expect(() => {
      s.write("echo hi");
      s.resize(120, 40);
    }).not.toThrow();
    expect(log.filter((l) => l.startsWith("write:")).length).toBe(0);
    destroyPtySession("test-pty-1");
    expect(getPtySession("test-pty-1")).toBeUndefined();
  });

  it("status/resize routes", async () => {
    useStudioStore.getState().resetStudio();
    const status = await handleUniversal(
      authedRequest("http://localhost/api/universal/terminal/pty/status", { method: "GET" })
    );
    const sj = await status!.json();
    expect(sj.ok).toBe(true);
    expect(typeof sj.available).toBe("boolean");
    expect(typeof isPtyAvailable()).toBe("boolean");

    const resize = await handleUniversal(
      authedRequest("http://localhost/api/universal/terminal/pty/resize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ptyId: "ghost", cols: 80, rows: 24 }),
      })
    );
    expect(resize!.status).toBe(404);
  });

  it("builds WS url and candidate bases", () => {
    expect(buildPtyWsUrl("ws://127.0.0.1:25005", "p1", "D:/r", 80, 24)).toBe(
      "ws://127.0.0.1:25005/api/universal/terminal/pty?ptyId=p1&cwd=D%3A%2Fr&cols=80&rows=24"
    );
    // 同源即回环时去重
    expect(ptyWsCandidateBases("127.0.0.1:25005", "http:")).toEqual(["ws://127.0.0.1:25005"]);
    // vite dev：同源 + 回环直连兜底
    expect(ptyWsCandidateBases("localhost:25188", "http:")).toEqual([
      "ws://localhost:25188",
      "ws://127.0.0.1:25005",
    ]);
  });
});
