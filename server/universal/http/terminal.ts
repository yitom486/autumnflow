/**
 * /api/universal/terminal/* — integrated terminal.
 * - pty/status: lets the UI pick a mode (available=false under Bun/dev →
 *   one-shot exec). The PTY itself is a WebSocket upgrade (see ../pty.ts).
 * - pty/resize: separate POST — WS text frames go to the shell verbatim,
 *   no control frames mixed in (avoids user echo colliding with a protocol).
 * - exec: one-shot command, output streamed back.
 */
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { json, jsonBody, optStr } from "./shared";

export const terminalRouter = new Hono();

terminalRouter.get("/pty/status", async () => {
  const { isPtyAvailable, ptyUnavailableReason } = await import("../pty");
  const { resolveInteractiveShell } = await import("../platform/shell");
  const available = isPtyAvailable();
  const shell = resolveInteractiveShell();
  return json({
    ok: true,
    available,
    reason: available ? null : ptyUnavailableReason(),
    shell: shell.shell,
    shellKind: shell.kind,
    shellLabel: shell.label,
  });
});

const numLike = z.union([z.number(), z.string()]).nullish();
const resizeBody = z.looseObject({ ptyId: optStr, cols: numLike, rows: numLike });

terminalRouter.post("/pty/resize", jsonBody(resizeBody), async (c) => {
  try {
    const body = c.get("body");
    const { getPtySession } = await import("../pty");
    const s = getPtySession(String(body.ptyId || ""));
    if (!s) return json({ ok: false, error: "unknown pty session（已退出或未创建）" }, 404);
    s.resize(Number(body.cols), Number(body.rows));
    return json({ ok: true });
  } catch (err: any) {
    return json({ ok: false, error: err.message || "pty resize 失败" }, 500);
  }
});

// Basic guards only (cwd required + exists + is-dir, non-empty, 8k length cap).
// Every caller must already hold the gateway token (routes.ts auth middleware).
const EXEC_MAX_CHARS = 8000;
const execBody = z.looseObject({ cwd: optStr, command: optStr });

terminalRouter.post("/exec", jsonBody(execBody), async (c) => {
  try {
    const body = c.get("body");
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const cmd = String(body.command || "").trim();
    if (!cmd) return json({ ok: false, error: "command is required" }, 400);
    if (cmd.length > EXEC_MAX_CHARS) {
      return json({ ok: false, error: `command too long (max ${EXEC_MAX_CHARS} chars)` }, 400);
    }

    const { spawn } = await import("node:child_process");
    const { execSpawnForCwd } = await import("../wsl");
    // cwd 必须显式给出且存在：不再悄悄回落到 process.cwd()（no-silent-fallbacks.md）。
    if (!cwd) return json({ ok: false, error: "cwd is required" }, 400);
    const targetCwd = path.resolve(cwd);
    let isDir = false;
    try {
      isDir = fs.existsSync(targetCwd) && fs.statSync(targetCwd).isDirectory();
    } catch (err) {
      return json({ ok: false, error: `无法访问工作目录 ${targetCwd}：${(err as Error).message}` }, 400);
    }
    if (!isDir) return json({ ok: false, error: `工作目录不存在或不是目录：${targetCwd}` }, 400);
    // WSL 工作区：UNC 不能做子进程 cwd，改走 wsl.exe --cd（shell 真目录不变）。
    const plan = execSpawnForCwd(process.platform, targetCwd, cmd, process.cwd());
    const proc = spawn(plan.shell, plan.args, {
      cwd: plan.spawnCwd,
      env: { ...process.env, TERM: "xterm-256color" },
      windowsHide: true,
    });

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        proc.stdout.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        proc.stderr.on("data", (chunk: Buffer) => controller.enqueue(chunk));
        proc.on("close", (code) => {
          controller.enqueue(enc.encode(`\r\n\x1b[90m[Process finished with exit code ${code ?? 0}]\x1b[0m\r\n`));
          controller.close();
        });
        proc.on("error", (err) => {
          controller.enqueue(enc.encode(`\r\n\x1b[31m[Process error: ${err.message}]\x1b[0m\r\n`));
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err: any) {
    console.error(`[Universal] terminal exec failed: ${err.message || err}`);
    return json({ ok: false, error: err.message }, 500);
  }
});
