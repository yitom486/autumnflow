/**
 * 工作区文件树：react-arborist（虚拟滚动 + 完整键盘导航 + 拖拽移动 + 行内重命名），
 * 目录懒加载（/fs/list），文件监听（/fs/watch）自动刷新，git 状态徽标（/git/status）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from "react-arborist";
import {
  ChevronRight, File, FileCode2, FileJson, FileText, Folder, FolderOpen, FilePlus2, FolderPlus, RefreshCw, ChevronsDownUp, Image as ImageIcon, Link2, Search, Eye,
} from "lucide-react";
import { fsCreate, fsDelete, fsList, fsRename, fsWatch, type FsEntry } from "@/lib/fs-api";
import { gitStatus, searchWorkspace, type SearchMatch } from "@/lib/universal-api";
import { openDiff, openFile, applyWatchEvents } from "@/lib/workbench-actions";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { cn } from "@/lib/utils";
import { ACP_PATH_MIME, encodeDragRefs, setActiveDragRefs } from "@/lib/composer-drop";
import { reportError } from "@/lib/error-bus";

interface TreeNode {
  id: string; // 相对路径
  name: string;
  type: FsEntry["type"];
  symlink?: boolean;
  children?: TreeNode[] | null; // dir: 数组（未加载为空数组 + loaded=false）；file: null
  loaded?: boolean;
}

const toNode = (e: FsEntry): TreeNode => ({
  id: e.path,
  name: e.name,
  type: e.type,
  symlink: e.symlink,
  children: e.type === "dir" ? [] : null,
  loaded: false,
});

function replaceChildren(nodes: TreeNode[], dir: string, children: TreeNode[]): TreeNode[] {
  if (dir === "") return mergeLoaded(nodes, children);
  return nodes.map((n) => {
    if (n.id === dir) return { ...n, children: mergeLoaded(n.children || [], children), loaded: true };
    if (n.children && dir.startsWith(n.id + "/")) return { ...n, children: replaceChildren(n.children, dir, children) };
    return n;
  });
}
/** 刷新一层时保留已展开子目录的子树 */
function mergeLoaded(old: TreeNode[], fresh: TreeNode[]): TreeNode[] {
  const byId = new Map(old.map((n) => [n.id, n]));
  return fresh.map((n) => {
    const prev = byId.get(n.id);
    return prev && prev.type === "dir" && n.type === "dir" && prev.loaded ? { ...n, children: prev.children, loaded: true } : n;
  });
}
function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children && id.startsWith(n.id + "/")) {
      const f = findNode(n.children, id);
      if (f) return f;
    }
  }
}

/** git status 并发合并（纯逻辑，可测）：进行中再调只记 queued，finish 返回是否需补跑一次。 */
export class RefreshCoalescer {
  private busy = false;
  private queued = false;
  begin(): boolean {
    if (this.busy) {
      this.queued = true;
      return false;
    }
    this.busy = true;
    return true;
  }
  finish(): boolean {
    const q = this.queued;
    this.busy = false;
    this.queued = false;
    return q;
  }
}

/** 悬停预取延时：鼠标停留目录这么久未展开，后台悄悄加载一层（命中即省一次 RTT）。 */
export const HOVER_PREFETCH_MS = 250;

/** 该节点值得悬停预取？（未加载过的目录；根目录由挂载加载，不走这里） */
export function shouldPrefetchDir(node: { type: string; loaded?: boolean } | null | undefined): boolean {
  return !!node && node.type === "dir" && !node.loaded;
}

export const STATUS_LABEL: Record<string, string> = { M: "已修改", A: "已添加", D: "已删除", R: "已重命名", "?": "未跟踪", U: "冲突", C: "已复制" };
export function statusClass(s: string): string {
  if (s === "D" || s === "U") return "text-destructive";
  if (s === "A" || s === "?") return "text-success";
  return "text-warning";
}

/** 文件状态 → 所在目录汇总（目录显示一个圆点） */
export function buildGitMaps(files: Array<{ path: string; status: string }>, prefix = "") {
  const fileMap = new Map<string, string>();
  const dirSet = new Set<string>();
  for (const f of files) {
    let p = f.path;
    if (prefix) {
      if (!p.startsWith(prefix)) continue;
      p = p.slice(prefix.length);
    }
    p = p.replace(/\/$/, "");
    fileMap.set(p, f.status);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join("/"));
  }
  return { fileMap, dirSet };
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "c", "cpp", "h", "css", "html", "sh", "vue", "svelte"].includes(ext)) return FileCode2;
  if (["json", "jsonc"].includes(ext)) return FileJson;
  if (["md", "markdown", "txt", "log", "yml", "yaml", "toml"].includes(ext)) return FileText;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return ImageIcon;
  return File;
}

function fileColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx"].includes(ext)) return "text-sky-500";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "text-amber-400";
  if (["json", "jsonc"].includes(ext)) return "text-amber-500";
  if (["css", "scss", "less"].includes(ext)) return "text-violet-400";
  if (["md", "markdown", "txt"].includes(ext)) return "text-emerald-500";
  if (["png", "jpg", "jpeg", "svg", "ico", "webp"].includes(ext)) return "text-pink-400";
  if (["py"].includes(ext)) return "text-blue-400";
  if (["rs"].includes(ext)) return "text-orange-500";
  return "text-muted-foreground";
}

const joinAbs = (cwd: string, rel: string) => {
  const sep = cwd.includes("\\") && !cwd.includes("/") ? "\\" : "/";
  return rel ? `${cwd.replace(/[\\/]$/, "")}${sep}${rel.split("/").join(sep)}` : cwd;
};

interface MenuState { x: number; y: number; node: TreeNode | null }

export const FileTreePanel: React.FC<{ cwd: string | null }> = ({ cwd }) => {
  const [data, setData] = useState<TreeNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState(() => buildGitMaps([]));
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [results, setResults] = useState<{ engine: string; matches: SearchMatch[]; truncated: boolean; elapsedMs: number } | null>(null);
  const searchSeq = useRef(0);
  const treeRef = useRef<TreeApi<TreeNode> | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 240, h: 400 });
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  /** 被 .gitignore 忽略的条目默认不显示（VS Code 的默认行为），这里可以临时打开。 */
  const [showIgnored, setShowIgnored] = useState(false);
  const showIgnoredRef = useRef(showIgnored);
  showIgnoredRef.current = showIgnored;
  /** 当前目录有多少条目被截断了（null = 没有截断）。 */
  const [truncated, setTruncated] = useState<{ total: number; shown: number } | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const activeId = useWorkbenchStore((s) => s.activeId);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // Measure the CONTENT box (clientWidth/Height include the py-1 padding, which made
    // the tree 8px taller than its box), floor to whole px, batch in rAF and skip
    // no-op updates — otherwise a scrollbar toggling on hover (classic Windows
    // scrollbars) feeds back into the observer: "ResizeObserver loop completed…".
    let raf = 0;
    let last = { w: -1, h: -1 };
    const measure = () => {
      raf = 0;
      const cs = getComputedStyle(el);
      const w = Math.max(0, Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
      const h = Math.max(0, Math.floor(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)));
      if (w === last.w && h === last.h) return;
      last = { w, h };
      setSize({ w, h });
    };
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(measure);
    });
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // 内容搜索：2 字起查，250ms 防抖，过期响应丢弃（只留最新一次）。
  useEffect(() => {
    if (!searchOpen || !cwd) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearchErr(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void searchWorkspace(cwd, q, 100).then(
        (r) => {
          if (searchSeq.current !== seq) return;
          setResults(r);
          setSearchErr(null);
          setSearching(false);
        },
        (e) => {
          if (searchSeq.current !== seq) return;
          setSearchErr((e as Error).message);
          setSearching(false);
        }
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [searchOpen, cwd, query]);

  const loadDir = useCallback(async (dir: string) => {
    if (!cwd) return;
    try {
      const res = await fsList(cwd, dir, { hidden: showIgnoredRef.current });
      setData((d) => replaceChildren(d, dir, res.entries.map(toNode)));
      setTruncated(res.truncated ? { total: res.total ?? res.entries.length, shown: res.entries.length } : null);
      setError(null);
    } catch (e) {
      if (dir === "") setError((e as Error).message);
    }
  }, [cwd]);

  const gitCoal = useRef(new RefreshCoalescer());
  const refreshGit = useCallback(async () => {
    // 进行中再调只排队，跑完补一次（watch 风暴 + 远端 RTT 下不叠请求）。
    if (!gitCoal.current.begin()) return;
    try {
      do {
        const c = cwdRef.current;
        if (!c) return;
        try {
          const r = await gitStatus(c);
          const repo = (r.repo || "").replace(/\\/g, "/");
          const here = c.replace(/\\/g, "/");
          const prefix = here.startsWith(repo + "/") ? here.slice(repo.length + 1) + "/" : "";
          setGit(buildGitMaps(r.files, prefix));
        } catch {
          setGit(buildGitMaps([])); // 不是 git 仓库
        }
      } while (gitCoal.current.finish());
    } finally {
      // begin 成功即 busy，finish 已在循环里清零；异常穿透时强制复位防卡死
      gitCoal.current.finish();
    }
  }, []);

  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPrefetch = useCallback(() => {
    if (prefetchTimer.current) {
      clearTimeout(prefetchTimer.current);
      prefetchTimer.current = null;
    }
  }, []);
  const schedulePrefetch = useCallback((n: TreeNode) => {
    cancelPrefetch();
    if (!shouldPrefetchDir(n)) return;
    prefetchTimer.current = setTimeout(() => {
      prefetchTimer.current = null;
      // 期间已展开（onToggle 加载过）就不用；还停留在未加载态才后台取一层
      if (shouldPrefetchDir(findNode(dataRef.current, n.id))) void loadDir(n.id);
    }, HOVER_PREFETCH_MS);
  }, [cancelPrefetch, loadDir]);

  useEffect(() => {
    setData([]);
    if (!cwd) return;
    void loadDir("");
    void refreshGit();
    let gitTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = fsWatch(cwd, (events) => {
      const dirs = new Set(events.map((e) => (e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/")) : "")));
      for (const d of dirs) {
        const n = d === "" ? null : findNode(dataRef.current, d);
        if (d === "" || n?.loaded) void loadDir(d);
      }
      void applyWatchEvents(cwd, events);
      if (gitTimer) clearTimeout(gitTimer);
      gitTimer = setTimeout(() => void refreshGit(), 300);
    });
    return () => {
      stop();
      cancelPrefetch();
      if (gitTimer) clearTimeout(gitTimer);
    };
  }, [cwd, loadDir, refreshGit, cancelPrefetch]);

  const onToggle = useCallback((id: string) => {
    cancelPrefetch();
    const n = findNode(dataRef.current, id);
    if (n && n.type === "dir" && !n.loaded) void loadDir(id);
  }, [cancelPrefetch, loadDir]);

  const parentOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");

  const guard = async (fn: () => Promise<unknown>, what: string) => {
    try {
      await fn();
    } catch (e) {
      reportError("文件树", new Error(`${what}失败：${(e as Error).message}`));
    }
  };

  const createIn = async (dirId: string, type: "file" | "dir") => {
    if (!cwd) return;
    let name: string | null = null;
    try {
      name = window.prompt(type === "file" ? "新文件名" : "新文件夹名");
    } catch {
      name = type === "file" ? "untitled.txt" : "new-folder";
    }
    if (!name) return;
    const rel = dirId ? `${dirId}/${name}` : name;
    await guard(async () => {
      await fsCreate(cwd, rel, type);
      await loadDir(dirId);
      if (type === "file") void openFile(cwd, rel, { pin: true });
    }, "新建");
  };

  const ctxItems = (node: TreeNode | null) => {
    if (!cwd) return [];
    const dirId = node ? (node.type === "dir" ? node.id : parentOf(node.id)) : "";
    const wb = window.autumnflow?.workbench;
    const copy = (t: string) => (wb ? wb.copyText(t) : navigator.clipboard.writeText(t));
    const items: Array<{ label: string; run: () => void; danger?: boolean } | "sep"> = [
      { label: "新建文件…", run: () => void createIn(dirId, "file") },
      { label: "新建文件夹…", run: () => void createIn(dirId, "dir") },
    ];
    if (node) {
      items.push("sep");
      if (node.type === "file") items.push({ label: "打开（固定标签）", run: () => void openFile(cwd, node.id, { pin: true }) });
      if (node.type === "file" && git.fileMap.has(node.id)) items.push({ label: "查看改动对比", run: () => void openDiff(cwd, node.id) });
      items.push(
        { label: "重命名…", run: () => treeRef.current?.get(node.id)?.edit() },
        { label: "删除（移到回收站）", danger: true, run: () => void guard(async () => {
          if (!window.confirm(`把 ${node.id} 移到回收站？`)) return;
          await fsDelete(cwd, node.id);
          await loadDir(parentOf(node.id));
          const st = useWorkbenchStore.getState();
          st.tabs.filter((t) => t.path === node.id || t.path.startsWith(node.id + "/")).forEach((t) => st.closeTab(t.id));
        }, "删除") },
        "sep",
      );
    }
    const abs = joinAbs(cwd, node?.id || "");
    if (wb) items.push({ label: "在文件管理器中显示", run: () => void wb.reveal(abs) });
    items.push({ label: "复制路径", run: () => void copy(abs) });
    if (node) items.push({ label: "复制相对路径", run: () => void copy(node.id) });
    return items;
  };

  const Node = useMemo(() => {
    const Comp = ({ node, style, dragHandle }: NodeRendererProps<TreeNode>) => {
      const d = node.data;
      const isDir = d.type === "dir";
      const st = isDir ? null : git.fileMap.get(d.id);
      const dirChanged = isDir && git.dirSet.has(d.id);
      const Icon = isDir ? (node.isOpen ? FolderOpen : Folder) : d.type === "other" ? Link2 : fileIcon(d.name);
      return (
        <div
          ref={dragHandle}
          style={style}
          className={cn(
            "group relative flex h-full items-center gap-1.5 pr-2 text-xs cursor-pointer select-none rounded-md transition-colors",
            node.isSelected ? "bg-accent/85 font-medium text-foreground ring-1 ring-border/50" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            node.isFocused && !node.isSelected && "bg-accent/35",
            d.id === activeId && !node.isSelected && "text-foreground font-medium"
          )}
          draggable={true}
          onDragStart={(e) => {
            // 拖到聊天输入框 = @ 引用（文件树内部移动仍由 react-dnd 处理）
            if (d.type === "other") return;
            const refs = [{ path: d.id, kind: isDir ? ("dir" as const) : ("file" as const) }];
            setActiveDragRefs(refs);
            e.dataTransfer.setData(ACP_PATH_MIME, encodeDragRefs(refs));
            e.dataTransfer.setData("text/plain", `@${d.id}${isDir ? "/" : ""}`);
            e.dataTransfer.effectAllowed = "copyMove";
          }}
          onDragEnd={() => {
            setActiveDragRefs(null);
          }}
          onClick={() => {
            if (isDir) node.toggle();
            else if (cwdRef.current && d.type === "file") void openFile(cwdRef.current, d.id, { pin: false });
          }}
          onMouseEnter={() => {
            if (isDir) schedulePrefetch(d);
          }}
          onMouseLeave={cancelPrefetch}
          onDoubleClick={() => {
            if (!isDir && cwdRef.current && d.type === "file") void openFile(cwdRef.current, d.id, { pin: true });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            node.select();
            setMenu({ x: e.clientX, y: e.clientY, node: d });
          }}
          title={st ? `${d.id} · ${STATUS_LABEL[st] || st}` : d.id}
        >
          {/* beUI Branch connecting lines for nested depth */}
          {node.level > 0 &&
            Array.from({ length: node.level }).map((_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-border/60"
                style={{ left: `${8 + i * 16}px` }}
              />
            ))}

          <span className="w-3.5 shrink-0 flex justify-center z-10">
            {isDir && (
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform duration-200 ease-out",
                  node.isOpen ? "rotate-90 text-foreground" : "text-muted-foreground/80"
                )}
              />
            )}
          </span>
          <Icon
            className={cn(
              "h-3.5 w-3.5 shrink-0 z-10 transition-colors",
              isDir ? (node.isOpen ? "text-primary" : "text-primary/75") : fileColor(d.name)
            )}
          />
          {node.isEditing ? (
            <input
              autoFocus
              defaultValue={d.name}
              className="h-5 flex-1 min-w-0 rounded-sm border border-ring bg-background px-1 text-xs text-foreground outline-none z-10"
              onFocus={(e) => e.currentTarget.select()}
              onBlur={() => node.reset()}
              onKeyDown={(e) => {
                if (e.key === "Escape") node.reset();
                if (e.key === "Enter") node.submit(e.currentTarget.value);
              }}
            />
          ) : (
            <span className={cn("flex-1 truncate z-10 text-xs", st && statusClass(st), st === "D" && "line-through")}>
              {d.name}
            </span>
          )}
          {st && <span className={cn("ml-1 w-3 text-right font-mono text-[10px] font-semibold z-10", statusClass(st))}>{st === "?" ? "U" : st}</span>}
          {dirChanged && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-warning/80 z-10" aria-label="包含改动" />}
        </div>
      );
    };
    return Comp;
  }, [git, activeId, schedulePrefetch, cancelPrefetch]);

  if (!cwd) {
    return <div className="p-4 text-xs text-muted-foreground">先在左侧选择一个工作区，或用“文件 → 打开文件夹”。</div>;
  }
  const rootName = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;

  return (
    <div className="flex h-full flex-col" onClick={() => setMenu(null)}>
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" title={cwd}>{rootName}</span>
        <div className="flex items-center gap-0.5 text-muted-foreground">
          <button className="rounded p-1 hover:bg-accent hover:text-foreground" title="新建文件" onClick={() => void createIn("", "file")}><FilePlus2 className="h-3.5 w-3.5" /></button>
          <button className="rounded p-1 hover:bg-accent hover:text-foreground" title="新建文件夹" onClick={() => void createIn("", "dir")}><FolderPlus className="h-3.5 w-3.5" /></button>
          <button className="rounded p-1 hover:bg-accent hover:text-foreground" title="内容搜索" onClick={() => { setSearchOpen((v) => !v); setQuery(""); setResults(null); setSearchErr(null); }}><Search className="h-3.5 w-3.5" /></button>
          <button className="rounded p-1 hover:bg-accent hover:text-foreground" title="刷新" onClick={() => { void loadDir(""); void refreshGit(); }}><RefreshCw className="h-3.5 w-3.5" /></button>
          <button className="rounded p-1 hover:bg-accent hover:text-foreground" title="全部折叠" onClick={() => treeRef.current?.closeAll()}><ChevronsDownUp className="h-3.5 w-3.5" /></button>
          <button
            className={cn("rounded p-1 hover:bg-accent hover:text-foreground", showIgnored && "bg-accent text-foreground")}
            title={showIgnored ? "隐藏被 .gitignore 忽略的文件" : "显示被 .gitignore 忽略的文件"}
            aria-pressed={showIgnored}
            onClick={() => {
              const next = !showIgnored;
              setShowIgnored(next);
              showIgnoredRef.current = next;
              setData([]);
              void loadDir("");
            }}
          >
            <Eye className={cn("h-3.5 w-3.5", !showIgnored && "opacity-60")} />
          </button>
        </div>
      </div>
      {truncated && (
        <div className="shrink-0 border-b border-border bg-warning/10 px-2 py-1 text-[11px] text-warning">
          该目录有 {truncated.total.toLocaleString()} 个条目，已显示前 {truncated.shown.toLocaleString()} 个
        </div>
      )}
      {searchOpen && (
        <div className="shrink-0 border-b border-border px-2 py-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchOpen(false);
                setQuery("");
                setResults(null);
                setSearchErr(null);
              }
            }}
            placeholder="搜工作区内容…（2 字起，Esc 关闭）"
            spellCheck={false}
            className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground/60"
            aria-label="工作区内容搜索"
          />
          <div className="mt-1 font-mono text-[10px] text-muted-foreground">
            {searching ? "搜索中…" : searchErr ? <span className="text-destructive">{searchErr}</span> : results ? `${results.matches.length} 命中 · ${results.engine} · ${results.elapsedMs}ms${results.truncated ? " · 已截断" : ""}` : "rg 优先、无则全量扫描"}
          </div>
          {results && results.matches.length > 0 && (
            <div className="mt-1 max-h-64 overflow-y-auto rounded-md border border-border/60">
              {results.matches.map((m, i) => (
                <button
                  key={`${m.file}:${m.line}:${i}`}
                  type="button"
                  onClick={() => cwd && void openFile(cwd, m.file, { pin: true, line: m.line })}
                  className="flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-accent"
                  title={`${m.file}:${m.line}`}
                >
                  <span className="shrink-0 font-mono text-[10px] text-primary">
                    {m.file.split("/").pop()}
                    <span className="text-muted-foreground">:{m.line}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">{m.text.trim()}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div
        ref={boxRef}
        className="acp-tree-box flex-1 min-h-0 min-w-0 overflow-hidden py-1"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, node: null });
        }}
      >
        {error ? (
          <div className="p-3 text-xs text-destructive">{error}</div>
        ) : (
          <Tree<TreeNode>
            ref={treeRef}
            data={data}
            width={size.w}
            height={size.h}
            rowHeight={26}
            indent={16}
            overscanCount={8}
            openByDefault={false}
            disableMultiSelection
            aria-label="工作区文件"
            className="acp-tree"
            rowClassName="outline-none focus:outline-none focus-visible:outline-none"
            onToggle={onToggle}
            disableDrop={({ parentNode }) => !!parentNode && parentNode.data?.type !== "dir" && !parentNode.isRoot}
            onActivate={(n: NodeApi<TreeNode>) => {
              if (n.data.type === "file") void openFile(cwd, n.id, { pin: false });
            }}
            onRename={({ id, name }) => guard(async () => {
              if (!name || name.includes("/") || name.includes("\\")) throw new Error("名称无效");
              const to = parentOf(id) ? `${parentOf(id)}/${name}` : name;
              if (to === id) return;
              await fsRename(cwd, id, to);
              await loadDir(parentOf(id));
            }, "重命名")}
            onMove={({ dragIds, parentId }) => guard(async () => {
              const dest = parentId || "";
              for (const id of dragIds) {
                const name = id.split("/").pop()!;
                const to = dest ? `${dest}/${name}` : name;
                if (to !== id && !dest.startsWith(id + "/")) await fsRename(cwd, id, to);
                await loadDir(parentOf(id));
              }
              await loadDir(dest);
            }, "移动")}
          >
            {Node}
          </Tree>
        )}
      </div>
      {menu && (
        <div
          className="fixed z-[95] min-w-48 rounded-md border border-border bg-popover p-1 text-xs text-popover-foreground shadow-lg"
          style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 280) }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxItems(menu.node).map((it, i) =>
            it === "sep" ? (
              <div key={i} className="my-1 h-px bg-border" />
            ) : (
              <button
                key={i}
                className={cn("flex w-full items-center rounded-sm px-2 py-1.5 text-left hover:bg-accent", it.danger && "text-destructive")}
                onClick={() => { setMenu(null); it.run(); }}
              >
                {it.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
};

export default FileTreePanel;
