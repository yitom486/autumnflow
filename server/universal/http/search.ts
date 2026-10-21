/**
 * /api/universal/search — 工作区内容搜索（文件树搜索条用）。
 * 引擎：rg --json 优先（快），无 rg 回落 Node walk（`engine` 字段 loud 标注，不装快）。
 * Guards: cwd 必需 + 是目录，q 1..200 字符，结果数/字节双封顶。
 * WSL 工作区：rg 经 wsl.exe 起（与 git 同式）；walk 经 \\wsl$ 直读，本来就行。
 */
import { Hono } from "hono";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseWslCwd } from "../wsl";
import { json } from "./shared";

export interface SearchMatch {
  file: string;
  line: number;
  col: number;
  text: string;
}

const SEARCH_MAX_Q = 200;
const SEARCH_DEFAULT_LIMIT = 100;
const SEARCH_MAX_LIMIT = 500;
const SEARCH_MAX_BYTES = 300_000;
/** walk 回落的跳过表（rg 侧靠 .gitignore + 显式 !.git，再加 --max-filesize）。 */
const WALK_SKIP = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "vendor",
]);
const WALK_MAX_FILE = 1_000_000;

function toRel(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join("/");
}

/**
 * 同 git.ts 的 WSL 式 spawn：UNC 做不了子进程 cwd，wsl.exe --cd 中转。
 *
 * 异步跑：spawnSync 会把网关的事件循环堵住——全工作区搜索可能要跑十几秒，
 * 那段时间里聊天流、回应提问全排在后面。
 */
function runTool(
  tool: string,
  args: string[],
  cwd: string
): Promise<{ ok: boolean; stdout: string; error: string }> {
  return new Promise((resolve) => {
    try {
      const wsl = process.platform === "win32" ? parseWslCwd(cwd) : null;
      const cmd = wsl ? "wsl.exe" : tool;
      const full = wsl ? ["-d", wsl.distro, "--cd", wsl.linuxPath, "--", tool, ...args] : args;
      const child = spawn(cmd, full, {
        cwd: wsl ? process.cwd() : cwd,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, stdout, error: stderr });
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch {}
        finish(false);
      }, 15000);
      child.stdout?.on("data", (d) => { stdout += String(d); });
      child.stderr?.on("data", (d) => { stderr += String(d); });
      child.on("error", (e) => {
        stderr = String(e?.message || e);
        finish(false);
      });
      child.on("close", (code) => finish(code === 0));
    } catch (err) {
      resolve({ ok: false, stdout: "", error: (err as Error).message });
    }
  });
}

function pushMatch(
  out: SearchMatch[],
  file: string,
  line: number,
  col: number,
  text: string,
  limit: number
): boolean {
  if (out.length >= limit) return false;
  out.push({ file, line, col, text: text.slice(0, 500) });
  return out.length < limit;
}

/** rg --json 流解析（match 事件取首个 submatch 列；binary/bytes 行丢弃）。 */
export function parseRgJson(stdout: string, limit: number): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  let truncated = false;
  for (const ln of stdout.split("\n")) {
    const line = ln.trim();
    if (!line) continue;
    let ev: any = null;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行（rg 的统计行之类）：跳过
    }
    if (!ev || ev.type !== "match" || !ev.data) continue;
    const p = ev.data?.path?.text;
    const text = ev.data?.lines?.text;
    if (typeof p !== "string" || typeof text !== "string") continue;
    const sub = Array.isArray(ev.data.submatches) ? ev.data.submatches[0] : null;
    const col = sub && Array.isArray(sub.m) ? Number(sub.m[0]) + 1 : 1;
    if (!pushMatch(matches, String(p).replace(/\\/g, "/"), Number(ev.data.line_number) || 1, col || 1, text.replace(/\r?\n$/, ""), limit)) {
      truncated = true;
      break;
    }
  }
  return { matches, truncated };
}

/** 无 rg 回落：Node walk + 行扫描（smart-case 与 rg 默认一致：全小写不分大小写）。 */
export function walkSearch(cwd: string, q: string, limit: number): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  let truncated = false;
  const needle = q.toLowerCase() === q ? q.toLowerCase() : q;
  const fold = q.toLowerCase() === q;
  const stop = () => {
    truncated = true;
  };
  const scanFile = (abs: string): boolean => {
    let buf: Buffer;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > WALK_MAX_FILE) return true;
      buf = fs.readFileSync(abs);
    } catch {
      return true; // 删了/读不了：跳过
    }
    if (buf.includes(0)) return true; // 二进制
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const hay = fold ? ln.toLowerCase() : ln;
      const at = hay.indexOf(needle);
      if (at >= 0) {
        if (!pushMatch(matches, toRel(cwd, abs), i + 1, at + 1, ln, limit)) {
          stop();
          return false;
        }
      }
    }
    return true;
  };
  const walk = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (WALK_SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!walk(abs)) return false;
      } else if (e.isFile()) {
        if (!scanFile(abs)) return false;
      }
    }
    return true;
  };
  walk(cwd);
  return { matches, truncated };
}

export const searchRouter = new Hono();

searchRouter.get("/", async (c) => {
  const t0 = Date.now();
  const cwd = (c.req.query("cwd") || "").trim();
  const q = (c.req.query("q") || "").trim();
  const limit = Math.min(
    Math.max(parseInt(c.req.query("limit") || "", 10) || SEARCH_DEFAULT_LIMIT, 1),
    SEARCH_MAX_LIMIT
  );
  if (!cwd) return json({ ok: false, error: "cwd is required" }, 400);
  if (!q || q.length > SEARCH_MAX_Q)
    return json({ ok: false, error: "q 必需且不超过 200 字符" }, 400);
  const root = path.resolve(cwd);
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return json({ ok: false, error: `工作目录不存在或不是目录：${root}` }, 400);
    }
  } catch (err) {
    return json({ ok: false, error: `无法访问工作目录：${(err as Error).message}` }, 400);
  }
  let engine: "rg" | "walk" = "walk";
  let matches: SearchMatch[] = [];
  let truncated = false;
  const r = await runTool("rg", [
    "--json",
    "--line-number",
    "--column",
    "--no-heading",
    "--max-count",
    "8",
    "--max-filesize",
    "1M",
    "-g",
    "!.git/**",
    "--",
    q,
  ], root);
  if (r.ok && r.stdout.trim()) {
    engine = "rg";
    const parsed = parseRgJson(r.stdout, limit);
    matches = parsed.matches;
    truncated = parsed.truncated;
  } else {
    const walked = walkSearch(root, q, limit);
    matches = walked.matches;
    truncated = walked.truncated;
  }
  const bytes = matches.reduce((n, m) => n + m.text.length, 0);
  if (bytes > SEARCH_MAX_BYTES) {
    // 极端情况：按字节再砍一刀（match 级截断，不编造）
    let acc = 0;
    const kept: SearchMatch[] = [];
    for (const m of matches) {
      if (acc + m.text.length > SEARCH_MAX_BYTES) {
        truncated = true;
        break;
      }
      acc += m.text.length;
      kept.push(m);
    }
    matches = kept;
  }
  return json({ ok: true, engine, matches, truncated, elapsedMs: Date.now() - t0 });
});
