/**
 * /api/universal/git/* — workspace git inspection for the "view code changes" UI.
 * Same trust level as the fs/terminal client capabilities (local dev tool).
 * Guards: cwd must exist + be a git repo; file must stay inside cwd;
 * outputs are byte-capped.
 */
import { Hono, type Context } from "hono";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { json, jsonBody, optStr, type BodyEnv } from "./shared";
import { gitSpawnForCwd, parseWslCwd, wslUncFromLinux } from "../wsl";

const GIT_MAX_BYTES = 300_000;

/**
 * 跑一条 git 命令。
 *
 * 必须是异步的：spawnSync 会把整个网关的事件循环堵住——文件树在每次文件变动
 * 后都会问一次 git status，智能体提交时会连续写文件，于是 git status 一次次
 * 同步执行，其它请求（回应提问、聊天流）全排在后面，界面就成了"提交中…"卡住。
 */
function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    try {
      // WSL 工作区：UNC 做不了子进程 cwd，改走 wsl.exe --cd（仓库语义不变）。
      const plan = gitSpawnForCwd(process.platform, cwd, args, process.cwd());
      const child = spawn(plan.shell, plan.args, {
        cwd: plan.spawnCwd,
        windowsHide: true,
      });
      let out = "";
      let err = "";
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, out: (out || err).slice(0, GIT_MAX_BYTES) });
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(false);
      }, 15_000);
      child.stdout?.on("data", (d) => { out += String(d); });
      child.stderr?.on("data", (d) => { err += String(d); });
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
    } catch (err) {
      resolve({ ok: false, out: (err as Error).message });
    }
  });
}

async function resolveRepo(cwd: string): Promise<{ repo?: string; error?: string }> {
  if (!cwd || !fs.existsSync(cwd)) {
    if (process.platform === "win32" && String(cwd || "").trim().startsWith("/")) {
      return { error: "cwd 不存在：Windows 网关不认 Linux 路径，WSL 目录请用 \\\\wsl$\\<distro>\\... 形式" };
    }
    return { error: "cwd 不存在" };
  }
  const wsl = process.platform === "win32" ? parseWslCwd(cwd) : null;
  const top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok || !top.out.trim()) return { error: "该目录不是 git 仓库" };
  // WSL 下 rev-parse 吐的是 Linux 路径：映回 UNC，下游 fs 读盘与 prefix 检查才一致。
  const root = wsl ? wslUncFromLinux(wsl.distro, top.out.trim()) : top.out.trim();
  // Normalize Windows separators for reliable prefix checks.
  return { repo: path.normalize(root) };
}

export interface GitFileChange {
  path: string;
  status: string;
  staged: boolean;
}

function parsePorcelain(out: string): GitFileChange[] {
  const changes: GitFileChange[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // Format: XY SP path (rename: "old" -> "new")
    const x = line[0] || " ";
    const y = line[1] || " ";
    let p = line.slice(3).trim();
    const arrow = p.indexOf(" -> ");
    if (arrow >= 0) p = p.slice(arrow + 4).trim();
    if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
      p = p.slice(1, -1);
    }
    const staged = x !== " " && x !== "?";
    const status = x === "?" ? "?" : (x !== " " ? x : y);
    changes.push({ path: p, status, staged });
  }
  return changes.slice(0, 500);
}

/** Resolve `file` inside `repo`; null when it escapes the repo. */
function repoRelative(repo: string, file: string): { abs: string; rel: string } | null {
  const abs = path.normalize(path.resolve(repo, file));
  if (!file || (abs !== repo && !abs.startsWith(repo + path.sep))) return null;
  return { abs, rel: path.relative(repo, abs).replace(/\\/g, "/") };
}

const fileOpBody = z.looseObject({ cwd: optStr, file: optStr });

/** POST stage/restore share the same shape: {cwd, file} → git <args> -- <rel>. */
function fileOp(gitArgs: string[], label: string) {
  return async (c: Context<BodyEnv<z.infer<typeof fileOpBody>>>) => {
    try {
      const body = c.get("body");
      const resolved = await resolveRepo(String(body.cwd || ""));
      if (!resolved.repo) return json({ ok: false, error: resolved.error }, 400);
      const target = repoRelative(resolved.repo, String(body.file || ""));
      if (!target) return json({ ok: false, error: "file 必须位于仓库内" }, 400);
      const res = await runGit(resolved.repo, [...gitArgs, "--", target.rel]);
      if (!res.ok) return json({ ok: false, error: res.out || `${label} 失败` }, 500);
      return json({ ok: true });
    } catch (err: any) {
      return json({ ok: false, error: err.message || `${label} 失败` }, 400);
    }
  };
}

export const gitRouter = new Hono();

gitRouter.post("/stage", jsonBody(fileOpBody), fileOp(["add"], "git add"));
gitRouter.post("/restore", jsonBody(fileOpBody), fileOp(["restore"], "git restore"));

gitRouter.get("/status", async (c) => {
  const resolved = await resolveRepo(c.req.query("cwd") || "");
  if (!resolved.repo) return json({ ok: false, error: resolved.error }, 400);
  const repo = resolved.repo;
  const branch = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const porcelain = await runGit(repo, ["status", "--porcelain=v1", "-uall"]);
  if (!porcelain.ok) return json({ ok: false, error: porcelain.out.slice(0, 300) || "git status 失败" }, 500);
  return json({
    ok: true,
    repo,
    branch: branch.ok ? branch.out.trim() : "",
    files: parsePorcelain(porcelain.out),
  });
});

// GET /file?cwd=&file= : before (HEAD) + after (worktree) texts.
gitRouter.get("/file", async (c) => {
  const resolved = await resolveRepo(c.req.query("cwd") || "");
  if (!resolved.repo) return json({ ok: false, error: resolved.error }, 400);
  const repo = resolved.repo;
  const target = repoRelative(repo, c.req.query("file") || "");
  if (!target) return json({ ok: false, error: "file 必须位于仓库内" }, 400);
  const { abs, rel } = target;
  const numstat = await runGit(repo, ["diff", "--numstat", "--", rel]);
  const binary = numstat.ok && numstat.out.split("\n").some((l) => l.startsWith("-\t-\t"));
  let before: string | null = null;
  let after: string | null = null;
  let unified: string | null = null;
  if (!binary) {
    const show = await runGit(repo, ["show", `HEAD:${rel}`]);
    if (show.ok) before = show.out.slice(0, GIT_MAX_BYTES);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const buf = fs.readFileSync(abs);
        if (!buf.includes(0)) after = buf.toString("utf8").slice(0, GIT_MAX_BYTES);
      }
    } catch (err) {
      // Deleted / unreadable worktree file: the diff view shows "no after" (same as a deletion).
      console.warn(`[Universal] git/file worktree read failed ${abs}: ${(err as Error).message}`);
      after = null;
    }
    const diff = await runGit(repo, ["diff", "HEAD", "--no-color", "-U3", "--", rel]);
    if (diff.ok && diff.out.trim()) unified = diff.out.slice(0, GIT_MAX_BYTES);
  }
  return json({
    ok: true,
    repo,
    file: rel,
    binary,
    truncated: (before?.length || 0) >= GIT_MAX_BYTES || (after?.length || 0) >= GIT_MAX_BYTES,
    before,
    after,
    unified,
  });
});

// Read-only endpoints: any other method is a 405 (not a generic 404).
gitRouter.all("/status", () => json({ ok: false, error: "method not allowed" }, 405));
gitRouter.all("/file", () => json({ ok: false, error: "method not allowed" }, 405));
