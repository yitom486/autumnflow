/**
 * /api/universal/fs/* — 工作台文件树 + 编辑器的文件接口。
 *
 * 安全规则（与 git / workspace 路由同级，再收紧）：
 * - 所有请求都过 routes.ts 里的网关令牌校验；
 * - cwd 必须是已存在目录，且不能是文件系统根 / 系统目录（dangerousRootReason）；
 * - 目标路径一律相对 cwd 解析，realpath 后（含父目录）必须仍在 cwd 内：`..`、绝对路径、软链接逃逸都拒绝；
 * - 不允许写 / 改 / 删 `.git` 目录内的东西，不允许删除或重命名 cwd 本身；
 * - 写入带 mtime 乐观锁：客户端带上打开时的 mtimeMs，磁盘已被改动则 409；
 * - 删除进回收站（Electron 注入 shell.trashItem；否则移到 ~/.autumnflow/trash），不真删。
 */
import { Hono, type Context } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";
import { z } from "zod";
import { dangerousRootReason } from "../security";
import { resolveAppHome } from "../app-paths";
import { json, jsonBody } from "./shared";

export const filesRouter = new Hono();

export const FS_READ_MAX = 2 * 1024 * 1024; // 编辑器单文件上限 2MB
export const FS_NOTEBOOK_MAX = 20 * 1024 * 1024; // .ipynb 带图片输出，放宽到 20MB（只读查看）
export const FS_LIST_MAX = 5000;
const HIDDEN_DIRS = new Set(["node_modules", ".git"]);

/**
 * 不参与文件监听的目录：构建产物与工具缓存。
 *
 * watcher 一开就会把整棵树走一遍（每个目录一个 watcher）。只忽略
 * node_modules/.git 时，一个 Go 项目的 .cache/gomod（十几万文件）能把这次
 * 扫描拖到一分钟以上——网关是单进程，这段时间里文件树、打开文件、聊天流
 * 全排在后面，看起来就是"打不开"。
 */
const WATCH_IGNORED_DIRS = [
  "node_modules", ".git", ".cache", ".local", ".tools", ".next", ".nuxt", ".turbo",
  ".gradle", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".ruff_cache", ".tox", ".parcel-cache", ".sass-cache", ".terraform",
  "dist", "build", "out", "target", "vendor", "coverage", ".nyc_output",
];
const WATCH_IGNORED_RE = new RegExp(`[\\\\/](${WATCH_IGNORED_DIRS.join("|")})([\\\\/]|$)`);

/**
 * 工作区的 .gitignore 规则（VS Code 的默认行为：被忽略的文件不进文件树）。
 *
 * 项目自己的 .gitignore 才是权威——.cache/、dist/、build/ 这些噪音目录通常都
 * 在里面，比我们硬编码一份名单准得多，也不用每个项目单独配。规则按 mtime 缓存，
 * 改完 .gitignore 下一个请求就生效。
 */
type IgnoreCache = { mtimeMs: number; ig: ReturnType<typeof ignore> };
const ignoreCache = new Map<string, IgnoreCache>();

async function loadIgnore(root: string): Promise<ReturnType<typeof ignore> | null> {
  const file = path.join(root, ".gitignore");
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(file);
  } catch {
    ignoreCache.delete(root);
    return null;
  }
  const hit = ignoreCache.get(root);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.ig;
  let ig: ReturnType<typeof ignore> | null = null;
  try {
    ig = ignore().add(await fs.promises.readFile(file, "utf8"));
  } catch {
    ig = null;
  }
  if (ig) ignoreCache.set(root, { mtimeMs: st.mtimeMs, ig });
  else ignoreCache.delete(root);
  return ig;
}

/** 该路径是否被 .gitignore 忽略（相对工作区根，POSIX 分隔）。 */
async function isIgnored(root: string, rel: string): Promise<boolean> {
  if (!rel) return false;
  const ig = await loadIgnore(root);
  if (!ig) return false;
  return matchesIgnore(ig, rel);
}

/**
 * 规则匹配。`build/` 这种只作用于目录的规则要带尾斜杠才命中，
 * 而条目是不是目录只有调用方知道，所以两种写法都试一遍。
 */
export function matchesIgnore(ig: ReturnType<typeof ignore>, rel: string): boolean {
  try {
    if (ig.ignores(rel)) return true;
  } catch {
    return false;
  }
  try {
    return ig.ignores(rel.endsWith("/") ? rel : rel + "/");
  } catch {
    return false;
  }
}

type TrashFn = (abs: string) => Promise<void>;
let trashImpl: TrashFn | null = null;
/** Electron 主进程注入系统回收站（shell.trashItem）。 */
export function setTrashImpl(fn: TrashFn | null) {
  trashImpl = fn;
}
async function moveToTrash(abs: string): Promise<string> {
  if (trashImpl) {
    await trashImpl(abs);
    return "system";
  }
  const dir = path.join(process.env.ACP_TRASH_DIR || path.join(resolveAppHome(), "trash"), String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(abs));
  try {
    fs.renameSync(abs, dest);
  } catch {
    fs.cpSync(abs, dest, { recursive: true });
    fs.rmSync(abs, { recursive: true, force: true });
  }
  return dest;
}

class FsError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** 解析并校验 cwd：存在、是目录、不是危险根；返回 realpath。 */
export function resolveRoot(rawCwd: string): string {
  if (!rawCwd) throw new FsError(400, "cwd 不能为空");
  const abs = path.resolve(rawCwd);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new FsError(400, "cwd 不存在");
  }
  if (!fs.statSync(real).isDirectory()) throw new FsError(400, "cwd 不是目录");
  const bad = dangerousRootReason(real);
  if (bad) throw new FsError(403, bad);
  return real;
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 把相对路径解析到 root 内。文件可以还不存在（创建 / 写入），此时校验最近的已存在祖先的 realpath。
 */
export function resolveInside(root: string, rel: string, opts: { allowRoot?: boolean } = {}): { abs: string; rel: string } {
  if (typeof rel !== "string") throw new FsError(400, "path 无效");
  if (rel.includes("\0")) throw new FsError(400, "path 含非法字符");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw new FsError(400, "path 必须是相对工作区的路径");
  const abs = path.resolve(root, rel);
  if (!inside(root, abs)) throw new FsError(403, "路径越出工作区");
  // realpath 最近的已存在祖先，防软链接逃逸
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = fs.realpathSync(probe);
  if (!inside(root, real)) throw new FsError(403, "路径经软链接越出工作区");
  const relOut = path.relative(root, abs).split(path.sep).join("/");
  if (!opts.allowRoot && relOut === "") throw new FsError(400, "不能对工作区根目录执行此操作");
  return { abs, rel: relOut };
}

function assertWritable(rel: string) {
  if (rel.split("/").some((seg) => seg === ".git")) throw new FsError(403, "不允许修改 .git 目录");
}

function handle(fn: (c: Context) => Promise<Response> | Response) {
  return async (c: Context) => {
    try {
      return await fn(c);
    } catch (err: any) {
      if (err instanceof FsError) return json({ ok: false, error: err.message }, err.status);
      if (err?.code === "ENOENT") return json({ ok: false, error: "文件不存在" }, 404);
      if (err?.code === "EEXIST") return json({ ok: false, error: "目标已存在" }, 409);
      if (err?.code === "EACCES" || err?.code === "EPERM") return json({ ok: false, error: "没有权限" }, 403);
      console.error("[Universal] fs route failed:", err);
      return json({ ok: false, error: err?.message || "文件操作失败" }, 500);
    }
  };
}

const statOf = (abs: string) => {
  const st = fs.statSync(abs);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
};

// GET /list?cwd=&dir= : 单层目录（懒加载），目录在前，按名称排序
//
// 只做一次 readdir：以前这里对每个条目还同步 stat 一次（size/mtime），而文件树
// 根本不用这两个字段——几百个条目的目录就是几百次同步 I/O，把网关的事件循环卡住。
// 同步 stat 换成异步也不划算（还是白读），索性不读。
//
// 被 .gitignore 忽略的条目默认不返回（VS Code 的默认行为），?hidden=1 可以全显示。
filesRouter.get("/list", handle(async (c) => {
  const root = resolveRoot(c.req.query("cwd") || "");
  const { abs, rel } = resolveInside(root, c.req.query("dir") || "", { allowRoot: true });
  const st = await fs.promises.stat(abs);
  if (!st.isDirectory()) throw new FsError(400, "dir 不是目录");
  const showHidden = c.req.query("hidden") === "1";
  const dirents = await fs.promises.readdir(abs, { withFileTypes: true });
  const entries: Array<{ name: string; path: string; type: "file" | "dir" | "other"; symlink: boolean }> = [];
  for (const e of dirents) {
    if (!showHidden && HIDDEN_DIRS.has(e.name)) continue;
    const childAbs = path.join(abs, e.name);
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (!showHidden && (await isIgnored(root, childRel))) continue;
    const isLink = e.isSymbolicLink();
    let type: "file" | "dir" | "other" = e.isDirectory() ? "dir" : e.isFile() ? "file" : "other";
    if (isLink) {
      try {
        const real = await fs.promises.realpath(childAbs);
        // 指向工作区外的软链接不可展开
        if (!inside(root, real)) type = "other";
        else type = (await fs.promises.stat(real)).isDirectory() ? "dir" : "file";
      } catch {
        type = "other";
      }
    }
    entries.push({ name: e.name, path: childRel, type, symlink: isLink });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : b.type === "dir" ? 1 : 0));
  return json({
    ok: true,
    root,
    dir: rel,
    entries: entries.slice(0, FS_LIST_MAX),
    total: entries.length,
    truncated: entries.length > FS_LIST_MAX,
  });
}));

// GET /read?cwd=&path= : 文本内容 + mtime（编辑器打开 / 冲突检测用）
filesRouter.get("/read", handle(async (c) => {
  const root = resolveRoot(c.req.query("cwd") || "");
  const { abs, rel } = resolveInside(root, c.req.query("path") || "");
  const st = await fs.promises.stat(abs);
  if (!st.isFile()) throw new FsError(400, "不是文件");
  const max = /\.ipynb$/i.test(rel) ? FS_NOTEBOOK_MAX : FS_READ_MAX;
  if (st.size > max) return json({ ok: false, error: `文件超过 ${max / 1024 / 1024}MB，暂不支持在编辑器中打开`, size: st.size }, 413);
  const buf = await fs.promises.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return json({ ok: false, error: "二进制文件不支持在编辑器中打开", binary: true }, 415);
  return json({ ok: true, path: rel, text: buf.toString("utf8"), size: st.size, mtimeMs: Math.round(st.mtimeMs) });
}));

const writeBody = z.object({
  cwd: z.string(),
  path: z.string(),
  text: z.string().max(FS_READ_MAX * 2),
  /** 打开文件时的 mtimeMs；磁盘上已变化 → 409。新文件传 null。 */
  baseMtimeMs: z.number().nullable().optional(),
  force: z.boolean().optional(),
});

filesRouter.post("/write", jsonBody(writeBody), handle((c) => {
  const b = c.get("body") as z.infer<typeof writeBody>;
  const root = resolveRoot(b.cwd);
  const { abs, rel } = resolveInside(root, b.path);
  assertWritable(rel);
  const exists = fs.existsSync(abs);
  if (exists && !fs.statSync(abs).isFile()) throw new FsError(400, "目标不是文件");
  if (!b.force) {
    if (exists && b.baseMtimeMs != null) {
      const cur = statOf(abs);
      if (cur.mtimeMs !== b.baseMtimeMs) {
        return json({ ok: false, conflict: true, error: "文件已在磁盘上被修改", mtimeMs: cur.mtimeMs, text: fs.readFileSync(abs, "utf8") }, 409);
      }
    }
    if (exists && b.baseMtimeMs === null) return json({ ok: false, conflict: true, error: "文件已存在" }, 409);
  }
  if (!fs.existsSync(path.dirname(abs))) throw new FsError(400, "父目录不存在");
  const tmp = `${abs}.acp-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, b.text, "utf8");
  fs.renameSync(tmp, abs); // 原子替换
  return json({ ok: true, path: rel, ...statOf(abs) });
}));

const createBody = z.object({ cwd: z.string(), path: z.string(), type: z.enum(["file", "dir"]) });
filesRouter.post("/create", jsonBody(createBody), handle((c) => {
  const b = c.get("body") as z.infer<typeof createBody>;
  const root = resolveRoot(b.cwd);
  const { abs, rel } = resolveInside(root, b.path);
  assertWritable(rel);
  if (fs.existsSync(abs)) throw new FsError(409, "目标已存在");
  if (b.type === "dir") fs.mkdirSync(abs, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "", { flag: "wx" });
  }
  return json({ ok: true, path: rel, type: b.type });
}));

const renameBody = z.object({ cwd: z.string(), from: z.string(), to: z.string() });
filesRouter.post("/rename", jsonBody(renameBody), handle((c) => {
  const b = c.get("body") as z.infer<typeof renameBody>;
  const root = resolveRoot(b.cwd);
  const from = resolveInside(root, b.from);
  const to = resolveInside(root, b.to);
  assertWritable(from.rel);
  assertWritable(to.rel);
  if (!fs.existsSync(from.abs)) throw new FsError(404, "源文件不存在");
  if (fs.existsSync(to.abs)) throw new FsError(409, "目标已存在");
  fs.mkdirSync(path.dirname(to.abs), { recursive: true });
  fs.renameSync(from.abs, to.abs);
  return json({ ok: true, from: from.rel, to: to.rel });
}));

const deleteBody = z.object({ cwd: z.string(), path: z.string() });
filesRouter.post("/delete", jsonBody(deleteBody), handle(async (c) => {
  const b = c.get("body") as z.infer<typeof deleteBody>;
  const root = resolveRoot(b.cwd);
  const { abs, rel } = resolveInside(root, b.path);
  assertWritable(rel);
  if (!fs.existsSync(abs)) throw new FsError(404, "文件不存在");
  const where = await moveToTrash(abs);
  return json({ ok: true, path: rel, trashed: where });
}));

// GET /watch?cwd= : SSE，推送 { type: add|change|unlink|addDir|unlinkDir, path }（100ms 合并）
filesRouter.get("/watch", handle(async (c) => {
  const root = resolveRoot(c.req.query("cwd") || "");
  const { watch } = await import("chokidar");
  const enc = new TextEncoder();
  // chokidar 的 ignored 是同步回调，所以规则要先读出来（按 mtime 缓存）。
  const ignoreMatcher = (await loadIgnore(root)) ?? ignore();
  let watcher: Awaited<ReturnType<typeof watch>> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let pending: Array<{ type: string; path: string }> = [];
  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch {}
      };
      send({ type: "ready", root });
      watcher = watch(root, {
        ignoreInitial: true,
        ignored: (p: string) => {
          if (/\.acp-\d+-\d+\.tmp$/.test(p)) return true;
          if (WATCH_IGNORED_RE.test(p)) return true;
          // 被 .gitignore 忽略的目录同样不监听（与文件树显示的一致）
          const rel = path.relative(root, p).split(path.sep).join("/");
          return rel ? matchesIgnore(ignoreMatcher, rel) : false;
        },
        awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
        depth: 20,
      });
      watcher.on("all", (type: string, p: string) => {
        pending.push({ type, path: path.relative(root, p).split(path.sep).join("/") });
        if (!timer) timer = setTimeout(() => {
          timer = null;
          const batch = pending; pending = [];
          send({ type: "batch", events: batch });
        }, 100);
      });
      watcher.on("error", (e: unknown) => send({ type: "error", error: String((e as Error)?.message || e) }));
      ping = setInterval(() => send({ type: "ping" }), 25_000);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      if (ping) clearInterval(ping);
      void watcher?.close();
    },
  });
  c.req.raw.signal?.addEventListener("abort", () => {
    if (ping) clearInterval(ping);
    void watcher?.close();
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}));
