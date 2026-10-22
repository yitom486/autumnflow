/**
 * /api/universal/workspace/* — default workspace, folder validation (adding a
 * workspace in the UI) and the read-only file browser used by @-mentions.
 */
import { Hono, type Context } from "hono";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { dangerousRootReason, ensureGatewayToken, isAppInstallDir } from "../security";
import { json, jsonBody, optStr } from "./shared";

export const workspaceRouter = new Hono();

/**
 * `wsl -l -q`（UTF-16 解码后）→ 发行版名（纯函数，可测）。
 * 兼容默认发行版的 `*` / ` (Default)` 后缀；无发行版时 wsl 吐的是帮助文本
 *（含 URL/冒号/Microsoft Store 行），一并过滤，绝不把它们当发行版。
 * 跳过标题行，去重保序。
 */
export function parseWslDistros(raw: string): string[] {
  const out: string[] = [];
  for (let line of String(raw || "").split("\n")) {
    line = line
      .replace(/\0/g, "")
      .replace(/\r/g, "")
      .trim()
      .replace(/\*$/, "")
      .replace(/\s*\(Default\)$/i, "")
      .trim();
    if (!line) continue;
    if (/windows subsystem for linux/i.test(line)) continue;
    if (/^https?:\/\//i.test(line) || /microsoft store/i.test(line)) continue;
    if (/^distributions can be/i.test(line) || /:$/.test(line)) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

let cachedDistros: { time: number; list: string[] } | null = null;
let inFlightDistros: Promise<string[]> | null = null;
/** 发行版列表的缓存时长：wsl.exe 冷启动很慢，别让它进请求路径。 */
const WSL_DISTRO_TTL = 10 * 60_000;

export async function getWslDistrosAsync(force = false): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const fresh = cachedDistros && Date.now() - cachedDistros.time < WSL_DISTRO_TTL;
  if (!force && fresh) return cachedDistros!.list;
  if (inFlightDistros) return inFlightDistros;

  // 缓存还在但过期了：先用旧值，后台刷新。wsl.exe 冷启动要十几秒，
  // 目录选择器不该为它等——旧值顶多差一个刚装的发行版。
  if (!force && cachedDistros?.list?.length) {
    void getWslDistrosAsync(true).catch(() => {});
    return cachedDistros.list;
  }

  inFlightDistros = new Promise<string[]>((resolve, reject) => {
    const child = spawn("wsl.exe", ["-l", "-q"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      if (cachedDistros?.list?.length) {
        resolve(cachedDistros.list);
      } else {
        reject(new Error("wsl.exe 调用超时 (25s)，可能是 WSL 虚拟机冷启动唤醒中，请稍后重试"));
      }
    }, 25_000);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        const text = Buffer.concat(chunks).toString("utf16le");
        const list = parseWslDistros(text);
        cachedDistros = { time: Date.now(), list };
        resolve(list);
      } else {
        if (cachedDistros?.list?.length) {
          resolve(cachedDistros.list);
        } else {
          reject(new Error(`wsl.exe 退出异常 (code: ${code})`));
        }
      }
    });

    child.on("error", (err: any) => {
      clearTimeout(timer);
      const msg = String(err?.message || err);
      if (/ENOENT/i.test(msg)) {
        reject(new Error("本机未安装 WSL：请在管理员 PowerShell 跑 wsl --install，装好发行版后重启网关"));
      } else {
        reject(new Error(`wsl 调用失败: ${msg}`));
      }
    });
  }).finally(() => {
    inFlightDistros = null;
  });

  return inFlightDistros;
}

/**
 * 不阻塞的发行版列表：只用缓存。
 *
 * 缓存是热的就直接用；冷了就后台去跑（wsl.exe 冷启动要十几秒），这一次先不给
 * WSL 快捷项——目录选择器打开时本地目录要立刻能看。
 */
function cachedWslDistros(): string[] {
  if (cachedDistros?.list?.length) {
    if (Date.now() - cachedDistros.time >= WSL_DISTRO_TTL) void getWslDistrosAsync(true).catch(() => {});
    return cachedDistros.list;
  }
  void getWslDistrosAsync().catch(() => {});
  return [];
}

workspaceRouter.get("/wsl-distros", async () => {
  if (process.platform !== "win32") return json({ ok: true, distros: [] as string[], roots: [] as DirectoryRoot[] });
  try {
    const distros = await getWslDistrosAsync();
    const roots: DirectoryRoot[] = [];
    for (const d of distros) roots.push({ label: `WSL: ${d}`, path: await wslHomePath(d), distro: d });
    return json({ ok: true, distros, roots });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message || "获取 WSL 发行版失败" }, 500);
  }
});

/**
 * 后台预热快捷根目录：发行版列表 + 各发行版的家目录。
 *
 * wsl.exe 冷启动要十几秒，\\wsl.localhost 的网络路径探测也要几百毫秒。网关启动
 * 时先在后台跑一遍，目录选择器打开时就不用等——哪怕选的是本地 Windows 目录，
 * 快捷项和列表也在同一个响应里。
 */
export async function warmWorkspaceRoots(): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const distros = await getWslDistrosAsync(true);
    await Promise.all(distros.map((d) => wslHomePath(d)));
  } catch {
    // 预热失败不影响功能：真正要用时会重试
  }
}

workspaceRouter.get("/default", () => {
  let cwd = process.cwd();
  if (isAppInstallDir(cwd) || (process.platform === "linux" && /^\/mnt\/[a-zA-Z](\/|$)/.test(cwd))) {
    cwd = os.homedir();
  }
  return json({ ok: true, path: cwd, name: path.basename(cwd) || "home", platform: process.platform });
});

const validateBody = z.looseObject({ path: optStr });

workspaceRouter.post("/validate", jsonBody(validateBody), (c) => {
  try {
    const target = String(c.get("body").path || "").trim();
    if (!target) return json({ ok: false, error: "路径不能为空" }, 400);

    // 核心边界隔离：若 Windows 宿主机网关收到纯 POSIX 路径（以 / 开头且无盘符），
    // 绝不允许调用 path.resolve 盲目将其解析为当前驱动器盘符（如 D:\home\...）
    if (process.platform === "win32" && target.startsWith("/")) {
      return json(
        {
          ok: false,
          error: `指定的路径 [${target}] 为 POSIX/Linux 环境原生路径，当前网关为 Windows 宿主机。\n请切换至 WSL 原生环境或 SSH 远端网关直连后再打开该工作区。`,
        },
        400
      );
    }

    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return json({ ok: false, error: "指定的路径不存在或不是有效目录" }, 400);
    }
    // 用户在 UI 里选的工作区 = 会话 cwd = 智能体允许写入的根（见
    // AgentConnection.sessionRoots）。这里只拦“选了等于放开整台机器”的根。
    const bad = dangerousRootReason(resolved);
    if (bad) return json({ ok: false, error: bad }, 403);
    const isGit = fs.existsSync(path.join(resolved, ".git"));
    return json({ ok: true, path: resolved, name: path.basename(resolved), isGit });
  } catch (err: any) {
    console.error(`[Universal] workspace validate failed: ${err.message || err}`);
    return json({ ok: false, error: err.message || "校验工作区失败" }, 400);
  }
});

export interface DirectoryEntry {
  name: string;
  path: string;
  isGit: boolean;
  mtimeMs?: number;
}

export interface DirectoryRoot {
  label: string;
  path: string;
  distro?: string;
}

/**
 * WSL 家目录路径的缓存。
 *
 * `\\wsl.localhost\<distro>\home` 是网络路径，探测一次要几百毫秒到几秒；打开
 * 目录选择器时每个发行版都要探一次，缓存住才不至于每次都卡。
 */
const wslHomeCache = new Map<string, { time: number; path: string }>();
const WSL_HOME_TTL = 5 * 60_000;

/** 发行版里的家目录（第一个用户目录），探测结果缓存 5 分钟。 */
async function wslHomePath(distro: string): Promise<string> {
  const wslRoot = `\\\\wsl.localhost\\${distro}`;
  const wslHome = `${wslRoot}\\home`;
  const hit = wslHomeCache.get(distro);
  if (hit && Date.now() - hit.time < WSL_HOME_TTL) return hit.path;
  let target = wslRoot;
  try {
    const subs = await fs.promises.readdir(wslHome, { withFileTypes: true });
    const userDir = subs.find((s) => s.isDirectory() && s.name !== "lost+found");
    target = userDir ? path.join(wslHome, userDir.name) : wslHome;
  } catch {
    target = wslRoot;
  }
  wslHomeCache.set(distro, { time: Date.now(), path: target });
  return target;
}

/**
 * 获取快捷根目录列表（磁盘驱动器、用户目录、WSL 实例）。按目标发行版/平台严格隔离。
 *
 * 必须是异步的：这里要跑 wsl.exe 并访问 WSL 的网络路径，两样都慢；同步做会把
 * 整个网关堵住，目录选择器要等好几秒，其它请求也一起排队。
 */
export async function getSystemDirectoryRoots(distro?: string): Promise<DirectoryRoot[]> {
  const roots: DirectoryRoot[] = [];

  // 1. 若指定了 WSL 发行版，只返回该 WSL 实例内部的专用快捷根，彻底隔离 Windows 驱动器
  if (distro && process.platform === "win32") {
    roots.push({ label: `WSL: ${distro} 家目录 (~)`, path: await wslHomePath(distro), distro });
    roots.push({ label: `WSL: ${distro} 根目录 (/)`, path: `\\\\wsl.localhost\\${distro}`, distro });
    return roots;
  }

  // 2. 若在 Linux/WSL 网关内部原生运行，返回 Linux 专属根目录
  if (process.platform === "linux") {
    roots.push({ label: "用户目录 (~)", path: os.homedir() });
    roots.push({ label: "根目录 (/)", path: "/" });
    const userHome = path.join("/home");
    if (fs.existsSync(userHome)) {
      roots.push({ label: "/home", path: userHome });
    }
    return roots;
  }

  // 3. 宿主机 Windows 环境：返回本地用户目录与驱动器
  const home = os.homedir();
  roots.push({ label: "用户目录 (~)", path: home });

  if (process.platform === "win32") {
    // 快速扫描 Windows 驱动器 C:\ ~ Z:\
    for (const drive of ["C", "D", "E", "F", "G", "H", "Z"]) {
      const rootPath = `${drive}:\\`;
      try {
        if (fs.existsSync(rootPath)) {
          roots.push({ label: `本地磁盘 (${drive}:)`, path: rootPath });
        }
      } catch {}
    }
    // 快速探测已安装的 WSL 发行版（不阻塞：冷启动时先不给 WSL 快捷项）
    try {
      const distros = cachedWslDistros();
      for (const d of distros) {
        roots.push({ label: `WSL: ${d}`, path: await wslHomePath(d), distro: d });
      }
    } catch {}
  }
  return roots;
}

/** 供内置工作区选择器浏览目录的只读接口。 */
workspaceRouter.get("/directories", async (c) => {
  const requestedDir = c.req.query("dir")?.trim();
  const requestedDistro = c.req.query("distro")?.trim();

  let targetDir = requestedDir || "";

  // 1. 若无指定路径，按发行版或用户家目录初始化
  if (!targetDir) {
    if (requestedDistro && process.platform === "win32") {
      targetDir = await wslHomePath(requestedDistro);
    } else {
      targetDir = os.homedir();
    }
  } else if (requestedDistro && process.platform === "win32" && (targetDir.startsWith("/") || targetDir.startsWith("~"))) {
    // 将 Linux 风格的路径映射为 WSL UNC 路径
    const clean = targetDir.replace(/^~/, "").replace(/^\/+/, "");
    targetDir = clean
      ? `\\\\wsl.localhost\\${requestedDistro}\\${clean.replace(/\//g, "\\")}`
      : `\\\\wsl.localhost\\${requestedDistro}`;
  }

  // 规范化路径
  try {
    targetDir = path.resolve(targetDir);
  } catch {
    targetDir = os.homedir();
  }

  if (!fs.existsSync(targetDir)) {
    return json(
      {
        ok: false,
        error: `目录不存在: ${targetDir}`,
        current: os.homedir(),
        parent: null,
        roots: await getSystemDirectoryRoots(requestedDistro),
        entries: [],
      },
      404
    );
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(targetDir);
  } catch (err: any) {
    return json({ ok: false, error: `无法访问该目录: ${err?.message || err}` }, 403);
  }

  if (!stat.isDirectory()) {
    targetDir = path.dirname(targetDir);
  }

  // 计算 parent
  let parent: string | null = path.dirname(targetDir);
  if (parent === targetDir) {
    parent = null;
  } else if (process.platform === "win32") {
    const isWslRoot = /^\\\\wsl(?:\$|\.localhost)\\[^\\]+$/i.test(targetDir);
    if (isWslRoot) parent = null;
  }

  // 友好显示路径
  let displayPath = targetDir;
  let distro = requestedDistro || null;
  const wslMatch = /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)[\\\/]([^\\\/]+)(?:[\\\/](.*))?$/i.exec(targetDir);
  if (wslMatch) {
    distro = wslMatch[1];
    const sub = wslMatch[2] ? `/${wslMatch[2].replace(/[\\\/]+/g, "/")}` : "/";
    displayPath = `WSL (${distro}): ${sub}`;
  }

  const IGNORED_NAMES = new Set([
    "$Recycle.Bin",
    "System Volume Information",
    "Recovery",
    "node_modules",
    ".git",
    "AppData",
    "Application Data",
  ]);

  const entries: DirectoryEntry[] = [];
  try {
    const rawItems = await fs.promises.readdir(targetDir, { withFileTypes: true });
    // 每个条目要 stat 一次、再探一次 .git；同步做会把网关堵住（WSL 网络路径上
    // 尤其慢）。异步并行，I/O 还能重叠。
    const candidates = rawItems
      .filter((item) => (item.isDirectory() || item.isSymbolicLink()) && !IGNORED_NAMES.has(item.name) && !item.name.startsWith("$"))
      .slice(0, 300);
    const probed = await Promise.all(
      candidates.map(async (item) => {
        const fullSubPath = path.join(targetDir, item.name);
        try {
          const [isGit, subStat] = await Promise.all([
            fs.promises
              .access(path.join(fullSubPath, ".git"))
              .then(() => true)
              .catch(() => false),
            fs.promises.stat(fullSubPath),
          ]);
          if (!subStat.isDirectory()) return null;
          return { name: item.name, path: fullSubPath, isGit, mtimeMs: Math.round(subStat.mtimeMs) };
        } catch {
          return null; // 权限不足跳过
        }
      }),
    );
    for (const e of probed) if (e) entries.push(e);
  } catch (err: any) {
    return json({ ok: false, error: `读取目录内容失败: ${err?.message || err}` }, 500);
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return json({
    ok: true,
    current: targetDir,
    displayPath,
    distro,
    parent,
    roots: await getSystemDirectoryRoots(distro || requestedDistro),
    entries,
  });
});

/**
 * Workspace file browser for @-mentions (read-only).
 * Same trust level as the git inspection endpoints: cwd must exist+be a
 * directory, everything stays confined to cwd, outputs are capped.
 * - GET /files?cwd=&q=&limit= : recursive list
 * - GET /read?cwd=&file= : capped text read
 */
const WS_FILE_IGNORES = new Set([
  "node_modules", ".git", "dist", "release", "release-local", "release-node",
  "electron-dist", ".next", "out", "build", "target", "coverage", ".venv",
  "venv", "__pycache__", ".turbo", ".cache",
]);
const WS_FILES_LIMIT = 200;
const WS_WALK_DEPTH = 6;
const WS_READ_MAX = 65536;

function walkWorkspaceFiles(root: string, q: string, limit: number): { files: Array<{ path: string; size: number; mtimeMs: number }>; truncated: boolean } {
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const needle = q.trim().toLowerCase();
  let truncated = false;
  const visit = (dir: string, depth: number): void => {
    if (out.length >= limit) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // unreadable subdirectory (permissions): skip it, the rest of the tree is still listable
      return;
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1
    );
    for (const e of entries) {
      if (out.length >= limit) {
        truncated = true;
        return;
      }
      if (WS_FILE_IGNORES.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < WS_WALK_DEPTH) visit(abs, depth + 1);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (!needle || rel.toLowerCase().includes(needle)) {
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = fs.statSync(abs);
            size = st.size;
            mtimeMs = Math.round(st.mtimeMs);
          } catch {
            // unreadable stat: still listable, size unknown
          }
          out.push({ path: rel, size, mtimeMs });
        }
      }
      // symlinks and others are skipped (no escape via link)
    }
  };
  visit(root, 0);
  return { files: out, truncated };
}

function workspaceTextMime(rel: string): string {
  const ext = rel.split(".").pop()?.toLowerCase() || "";
  if (ext === "json") return "application/json";
  if (["md", "markdown", "txt", "log", "csv", "tsv", "xml", "yml", "yaml", "html", "css", "toml", "ini", "cfg", "sh", "ps1"].includes(ext)) return `text/${ext === "yml" ? "yaml" : ext === "markdown" ? "markdown" : "plain"}`;
  return "text/plain";
}

/** cwd query param must be an existing directory; returns the resolved path or an error Response. */
function workspaceCwd(c: Context): string | Response {
  const rawCwd = c.req.query("cwd") || "";
  const cwd = path.resolve(rawCwd);
  try {
    if (!rawCwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return json({ ok: false, error: "cwd 不存在或不是有效目录" }, 400);
    }
  } catch (err: any) {
    return json({ ok: false, error: err.message || "cwd 校验失败" }, 400);
  }
  return cwd;
}

workspaceRouter.get("/files", (c) => {
  const cwd = workspaceCwd(c);
  if (cwd instanceof Response) return cwd;
  const q = (c.req.query("q") || "").slice(0, 200);
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "", 10) || 50, 1), WS_FILES_LIMIT);
  const { files, truncated } = walkWorkspaceFiles(cwd, q, limit);
  return json({ ok: true, repo: cwd, files, truncated });
});

workspaceRouter.get("/read", (c) => {
  const cwd = workspaceCwd(c);
  if (cwd instanceof Response) return cwd;
  const file = c.req.query("file") || "";
  const abs = path.normalize(path.join(cwd, file));
  if (!file || (abs !== cwd && !abs.startsWith(cwd + path.sep))) {
    return json({ ok: false, error: "file 必须位于工作区内" }, 400);
  }
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return json({ ok: false, error: "文件不存在" }, 404);
    }
    const rel = path.relative(cwd, abs).split(path.sep).join("/");
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) {
      return json({ ok: false, error: "二进制文件不支持作为附件引用（请用文件选择器）" }, 415);
    }
    const text = buf.toString("utf8");
    const truncated = text.length > WS_READ_MAX;
    const st = fs.statSync(abs);
    return json({
      ok: true,
      repo: cwd,
      file: rel,
      mimeType: workspaceTextMime(rel),
      size: st.size,
      text: truncated ? text.slice(0, WS_READ_MAX) : text,
      truncated,
    });
  } catch (err: any) {
    return json({ ok: false, error: err.message || "读取文件失败" }, 400);
  }
});

const wslLaunchBody = z.looseObject({
  distro: z.string().min(1),
  port: z.number().int().positive().optional(),
});

/** 一键在目标 WSL 发行版内拉起/直连原生 Headless 网关。 */
workspaceRouter.post("/wsl-launch", jsonBody(wslLaunchBody), async (c) => {
  if (process.platform !== "win32") {
    return json({ ok: false, error: "WSL 原生环境仅在 Windows 宿主机上可用" }, 400);
  }
  const body = c.get("body");
  const distro = body.distro.trim();
  // WSL 专用独立端口默认为 25006，彻底避免与 Windows 本地宿主机网关 (25005) 端口冲突
  const port = body.port || 25006;
  const token = ensureGatewayToken();

  // 1. 探针：检查 port 是否已经有健康的 WSL 原生 Linux 网关且令牌匹配
  const probe = async (): Promise<boolean> => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/universal/workspace/default`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.status !== 200) return false;
      const data = await res.json().catch(() => null);
      // 必须是 Linux 平台的真实 WSL 网关，绝不能误判为 Windows 本机宿主
      if (!data || data.platform !== "linux") return false;
      return true;
    } catch {
      return false;
    }
  };

  if (await probe()) {
    return json({ ok: true, url: `http://127.0.0.1:${port}`, distro, reused: true, token });
  }

  // 异步执行 WSL 脚本辅助函数：通过 stdio ignore 避免 stdin 挂起，且绝不阻塞 Bun 主事件循环
  const execWsl = (
    bashScript: string,
    timeoutMs = 15000
  ): Promise<{ stdout: string; stderr: string; code: number | null; error?: Error }> => {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let finished = false;

      const child = spawn("wsl.exe", ["-d", distro, "--", "bash", "-lc", bashScript], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          try {
            child.kill();
          } catch {}
          resolve({
            stdout,
            stderr,
            code: null,
            error: new Error(`WSL 命令执行超时 (${timeoutMs}ms)`),
          });
        }
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code: null, error: err });
        }
      });

      child.on("close", (code) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        }
      });
    });
  };

  // 纯净 Linux PATH：完全屏蔽 Windows 继承过来的含括号空格路径（如 Program Files (x86)），防止 bash 语法解析错误
  const cleanLinuxPath = `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"`;

  // 1.5 探查 WSL 内部已有的有效令牌（若已有合法 64 位 token 则复用，保证前后端和 WSL 内部一致）
  let effectiveToken = token;
  const probeTokenRes = await execWsl(
    `cat ~/.autumnflow/.gateway-token 2>/dev/null || cat ~/.acp-studio/.gateway-token 2>/dev/null`,
    5000
  );
  const existingWslToken = (probeTokenRes.stdout || "").replace(/[\r\n\0]/g, "").trim();
  if (/^[0-9a-f]{64}$/.test(existingWslToken)) {
    effectiveToken = existingWslToken;
  }

  // 2. 检测 WSL 内部的 runtime (bun 或 node)
  const probeRuntime = await execWsl(
    `${cleanLinuxPath} && (command -v bun || [ -x "$HOME/.bun/bin/bun" ] && echo "$HOME/.bun/bin/bun" || command -v node || find "$HOME/.nvm" -name node -type f -perm /111 2>/dev/null | head -n 1)`,
    12000
  );

  const runtimeLines = (probeRuntime.stdout || "")
    .replace(/\0/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("/") && (l.endsWith("/bun") || l.endsWith("/node")));
  const runtime = runtimeLines[0] || "";

  if (!runtime) {
    return json(
      {
        ok: false,
        error: `WSL 发行版 [${distro}] 内未检测到 Bun 或 Node 环境。\n请在 WSL 中运行: curl -fsSL https://bun.sh/install | bash 进行安装。`,
        debug: {
          distro,
          code: probeRuntime.code,
          stdout: probeRuntime.stdout,
          stderr: probeRuntime.stderr,
          error: probeRuntime.error ? probeRuntime.error.message : null,
        },
      },
      400
    );
  }

  // 3. 计算工程根目录在 WSL 中的 Linux 挂载路径
  const cwd = process.cwd();
  const driveMatch = /^([a-zA-Z]):[\\\/](.*)$/.exec(cwd);
  if (!driveMatch) {
    return json({ ok: false, error: "无法将当前工作目录映射为 WSL 挂载路径" }, 500);
  }
  const driveLetter = driveMatch[1].toLowerCase();
  const subPath = driveMatch[2].replace(/\\/g, "/");
  const linuxProjectRoot = `/mnt/${driveLetter}/${subPath}`;

  // 4. 以后台守护进程方式在 WSL 内部启动网关（自动同步同一令牌，重定向输入避免终端退出时断开）
  const wslLogDir = (process.env.ACP_WSL_LOG_DIR || "~/.autumnflow/logs").trim();
  const logFile = `${wslLogDir}/acp-wsl-gateway-${port}.log`;
  const wslHost = (process.env.ACP_WSL_HOST || process.env.HOST || "0.0.0.0").trim();
  // 用 printf 纯净写入 64 位 token 并加锁权限；
  // 启动前先彻底释放端口残留进程，防止 EADDRINUSE 导致启动失败；
  // 进程内自动读取 ~/.autumnflow/.gateway-token，不把 token 拼入 export 命令行参数以防 ps 泄露。
  const killOldScript = `fuser -k ${port}/tcp 2>/dev/null; for p in $(ss -lptn 'sport = :${port}' 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill -9 $p 2>/dev/null; done; sleep 0.5`;
  const launchScript = `mkdir -p ~/.autumnflow "${wslLogDir}" && if [ ! -f ~/.autumnflow/.gateway-token ] && [ -f ~/.acp-studio/.gateway-token ]; then cp ~/.acp-studio/.gateway-token ~/.autumnflow/.gateway-token; fi && printf "%s\\n" "${effectiveToken}" > ~/.autumnflow/.gateway-token && chmod 600 ~/.autumnflow/.gateway-token 2>/dev/null && ${killOldScript} && cd "${linuxProjectRoot}" && ${cleanLinuxPath} && export PORT=${port} && export HOST=${wslHost} && nohup ${runtime} server/index.ts --port ${port} --host ${wslHost} < /dev/null > "${logFile}" 2>&1 & sleep 1`;

  const launchResult = await execWsl(launchScript, 10000);
  if (launchResult.error) {
    return json({ ok: false, error: `启动 WSL 网关失败: ${launchResult.error.message}` }, 500);
  }

  // 5. 等待网关就绪（轮询最多 10 秒）
  const start = Date.now();
  while (Date.now() - start < 10000) {
    await new Promise((r) => setTimeout(r, 400));
    if (await probe()) {
      return json({ ok: true, url: `http://127.0.0.1:${port}`, distro, reused: false, token: effectiveToken });
    }
  }

  // 若超时，读取日志
  const readLog = await execWsl(`cat "${logFile}"`, 3000);
  const errLog = (readLog.stdout || "").replace(/\0/g, "").slice(-500);

  return json(
    {
      ok: false,
      error: `WSL 网关在端口 ${port} 启动超时。\n${errLog ? `日志输出:\n${errLog}` : "请检查 WSL 内是否有端口冲突或依赖缺失。"}`,
    },
    500
  );
});
