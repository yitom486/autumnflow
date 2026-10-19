/**
 * 内置工作区/目录选择面板 (In-App Workspace Picker Modal)
 *
 * 彻底替换原生系统文件对话框，提供沉浸式暗黑 IDE 风格的目录导航体验：
 * - 紧凑高密度、等宽路径面包屑与盘符/WSL 快捷切换
 * - 支持子目录即时过滤与路径直接输入
 * - 键盘完整支持 (ArrowUp/Down 移动, Enter 钻入, Ctrl+Enter 打开, Esc 关闭)
 * - 原生兼容 WSL (\\wsl.localhost 或 Linux 原生路径) 与 本机 Windows
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  Folder,
  FolderGit2,
  HardDrive,
  Home,
  Monitor,
  Search,
  Terminal,
  X,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { browseDirectories, launchWslGateway, DEFAULT_WSL_GATEWAY_PORT, type BrowseDirectoriesResult, type BrowseDirectoryEntry } from "@/lib/universal-api";
import { getGatewayBase, setGatewayBase, setGatewayToken } from "@/lib/gateway-auth";
import { runCommand } from "@/lib/commands";
import { cn } from "@/lib/utils";
import { toEnvironmentNativeCwd } from "@/lib/threads";
import { isPosixEnvironment } from "@/stores/useStudioStore";

export const WorkspacePickerModal: React.FC = () => {
  const open = useWorkbenchStore((s) => s.workspacePickerOpen);
  const targetDistro = useWorkbenchStore((s) => s.workspacePickerDistro);
  const initialPath = useWorkbenchStore((s) => s.workspacePickerInitialPath);
  const customTitle = useWorkbenchStore((s) => s.workspacePickerTitle);
  const customConfirmLabel = useWorkbenchStore((s) => s.workspacePickerConfirmLabel);
  const onSelectCallback = useWorkbenchStore((s) => s.workspacePickerOnSelect);
  const close = useWorkbenchStore((s) => s.closeWorkspacePicker);

  const base = getGatewayBase();
  const wslNativeDistro = typeof localStorage !== "undefined" ? localStorage.getItem("acp_wsl_native_distro") : null;
  const isWslNative = Boolean(wslNativeDistro);
  const activeDistro = targetDistro || (isWslNative ? wslNativeDistro : null);
  const [reconnectingWsl, setReconnectingWsl] = useState(false);

  const [currentPath, setCurrentPath] = useState<string>("");
  const [displayPath, setDisplayPath] = useState<string>("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [roots, setRoots] = useState<BrowseDirectoriesResult["roots"]>([]);
  const [entries, setEntries] = useState<BrowseDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [filterQuery, setFilterQuery] = useState("");
  const [manualInputOpen, setManualInputOpen] = useState(false);
  const [manualInputPath, setManualInputPath] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  // 加载指定目录或初始目录
  const loadPath = async (dir?: string, distro?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const effectiveDistro = distro ?? activeDistro;
      const res = await browseDirectories({ dir, distro: effectiveDistro });
      if (res.ok) {
        setCurrentPath(res.current);
        setDisplayPath(res.displayPath || res.current);
        setParentPath(res.parent);
        setRoots(res.roots || []);
        setEntries(res.entries || []);
        setSelectedIndex(-1);
        setFilterQuery("");
      } else {
        setError(res.error || "读取目录失败");
      }
    } catch (err: any) {
      setError(err?.message || "网络或网关请求失败");
    } finally {
      setLoading(false);
    }
  };

  // 弹窗打开时初始化
  useEffect(() => {
    if (!open) return;
    setManualInputOpen(false);
    setManualInputPath("");
    void loadPath(initialPath || undefined, activeDistro);
  }, [open, activeDistro, initialPath]);

  // 过滤后的目录列表
  const filteredEntries = useMemo(() => {
    if (!filterQuery.trim()) return entries;
    const q = filterQuery.trim().toLowerCase();
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, filterQuery]);

  // 选中的目标路径：若高亮了列表某项，则为该项；否则为当前所在目录
  const activeSelectedPath = useMemo(() => {
    if (selectedIndex >= 0 && selectedIndex < filteredEntries.length) {
      return filteredEntries[selectedIndex].path;
    }
    return currentPath;
  }, [selectedIndex, filteredEntries, currentPath]);

  // 打开并加载为工作区（或触发回调）
  const handleConfirmOpen = (pathOrCurrent?: string) => {
    const rawTarget = pathOrCurrent || activeSelectedPath;
    if (!rawTarget) return;
    // 提纯为目标环境原生 CWD 路径（若属于 WSL / POSIX 体系，彻底剥离 Windows UNC 包装和盘符）
    const isPosix = Boolean(targetDistro) || isPosixEnvironment();
    const target = toEnvironmentNativeCwd(rawTarget, isPosix);
    close();
    if (onSelectCallback) {
      onSelectCallback(target);
    } else {
      void runCommand("workspace.open", target);
    }
  };

  // 键盘快捷键监听
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }

      // Ctrl+Enter: 立即打开选中的目录为工作区
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        handleConfirmOpen();
        return;
      }

      // 未在手动输入路径框中时
      if (!manualInputOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = prev + 1;
            return next >= filteredEntries.length ? 0 : next;
          });
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => {
            const next = prev - 1;
            return next < 0 ? filteredEntries.length - 1 : next;
          });
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (selectedIndex >= 0 && selectedIndex < filteredEntries.length) {
            // 钻入该目录
            void loadPath(filteredEntries[selectedIndex].path, targetDistro);
          } else {
            // 打开当前目录
            handleConfirmOpen();
          }
        } else if (e.key === "Backspace" && document.activeElement !== filterInputRef.current) {
          if (parentPath) {
            e.preventDefault();
            void loadPath(parentPath, targetDistro);
          }
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, manualInputOpen, selectedIndex, filteredEntries, currentPath, parentPath, targetDistro]);

  // 自动滚动高亮行到可视区
  useEffect(() => {
    if (selectedIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      if (activeEl) {
        activeEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIndex]);

  // 降级：使用系统原生选择器
  const handleFallbackSystemDialog = async () => {
    close();
    if (window.autumnflow?.openDirectory) {
      try {
        const picked = await window.autumnflow.openDirectory({ defaultPath: currentPath || undefined });
        if (picked) {
          if (onSelectCallback) {
            onSelectCallback(picked);
          } else {
            void runCommand("workspace.open", picked);
          }
        }
      } catch {}
    }
  };

  // 面包屑分段
  const breadcrumbs = useMemo(() => {
    if (!currentPath) return [];
    // 检查 Windows UNC 路径或一般路径
    const isWslUnc = /^\\\\wsl(?:\$|\.localhost)\\/i.test(currentPath);
    if (isWslUnc) {
      const parts = currentPath.split("\\").filter(Boolean);
      // parts[0] = wsl.localhost, parts[1] = Ubuntu, ...
      const segments: Array<{ name: string; path: string }> = [];
      let acc = `\\\\${parts[0]}`;
      for (let i = 1; i < parts.length; i++) {
        acc += `\\${parts[i]}`;
        segments.push({ name: parts[i], path: acc });
      }
      return segments;
    }

    // Windows 盘符路径 D:\a\b
    if (/^[a-zA-Z]:\\/i.test(currentPath)) {
      const drive = currentPath.slice(0, 3);
      const rest = currentPath.slice(3).split("\\").filter(Boolean);
      const segments: Array<{ name: string; path: string }> = [{ name: drive, path: drive }];
      let acc = drive;
      for (const p of rest) {
        acc = acc.endsWith("\\") ? `${acc}${p}` : `${acc}\\${p}`;
        segments.push({ name: p, path: acc });
      }
      return segments;
    }

    // Linux 路径 /home/user/proj
    const parts = currentPath.split("/").filter(Boolean);
    const segments: Array<{ name: string; path: string }> = [{ name: "/", path: "/" }];
    let acc = "";
    for (const p of parts) {
      acc += `/${p}`;
      segments.push({ name: p, path: acc });
    }
    return segments;
  }, [currentPath]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-100"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="flex h-[540px] w-full max-w-2xl flex-col rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={customTitle || "选择工作区文件夹"}
      >
        {/* 头部：标题与环境指示 */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/80 px-3.5 bg-muted/20">
          <div className="flex items-center gap-2">
            <Folder className="h-4 w-4 text-primary shrink-0" />
            <span className="font-semibold text-xs text-foreground tracking-tight">
              {customTitle || "打开工作区文件夹"}
            </span>
            {targetDistro ? (
              <span className="flex items-center gap-1 rounded-sm bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary font-medium">
                <Terminal className="h-3 w-3" />
                WSL: {targetDistro}
              </span>
            ) : isWslNative ? (
              <span className="flex items-center gap-1 rounded-sm bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-500 font-semibold border border-emerald-500/30">
                <Terminal className="h-3 w-3" />
                WSL: {wslNativeDistro || "Ubuntu"} (真环境)
              </span>
            ) : base ? (
              <span className="flex items-center gap-1 rounded-sm bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary font-medium">
                <Terminal className="h-3 w-3" />
                远端网关
              </span>
            ) : (
              <span className="flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                <Monitor className="h-3 w-3" />
                本机环境
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            title="关闭 (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 快捷根目录选择 (Quick Roots) */}
        {roots.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border/40 px-3 py-1.5 bg-background/40 no-scrollbar">
            <span className="text-[10px] text-muted-foreground shrink-0 uppercase tracking-wider font-medium">快捷根:</span>
            {roots.map((r) => {
              const isActive = currentPath.toLowerCase().startsWith(r.path.toLowerCase());
              return (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => void loadPath(r.path, r.distro || targetDistro)}
                  className={cn(
                    "flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] font-mono shrink-0 transition-colors border",
                    isActive
                      ? "border-primary/40 bg-primary/10 text-primary font-medium"
                      : "border-border/50 text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {r.distro ? (
                    <Terminal className="h-3 w-3 shrink-0" />
                  ) : r.label.includes("~") ? (
                    <Home className="h-3 w-3 shrink-0" />
                  ) : (
                    <HardDrive className="h-3 w-3 shrink-0" />
                  )}
                  <span>{r.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* 路径导航栏：上一级 + 面包屑 / 手动输入 */}
        <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-3 bg-muted/10 font-mono text-xs">
          <button
            type="button"
            disabled={!parentPath || loading}
            onClick={() => parentPath && void loadPath(parentPath, targetDistro)}
            className="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:pointer-events-none transition-colors"
            title="返回上一级 (Backspace)"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>

          {manualInputOpen ? (
            <div className="flex flex-1 items-center gap-1">
              <input
                type="text"
                value={manualInputPath}
                onChange={(e) => setManualInputPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (manualInputPath.trim()) {
                      void loadPath(manualInputPath.trim(), targetDistro);
                      setManualInputOpen(false);
                    }
                  } else if (e.key === "Escape") {
                    setManualInputOpen(false);
                  }
                }}
                autoFocus
                placeholder="输入绝对路径并回车..."
                className="flex-1 bg-background px-2 py-0.5 text-xs text-foreground border border-input rounded-sm focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => {
                  if (manualInputPath.trim()) void loadPath(manualInputPath.trim(), targetDistro);
                  setManualInputOpen(false);
                }}
                className="rounded-sm bg-primary px-2 py-0.5 text-[11px] text-primary-foreground font-medium"
              >
                跳转
              </button>
              <button
                type="button"
                onClick={() => setManualInputOpen(false)}
                className="rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                取消
              </button>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-between min-w-0">
              <div className="flex items-center gap-0.5 overflow-x-auto no-scrollbar py-0.5">
                {breadcrumbs.map((seg, idx) => (
                  <React.Fragment key={seg.path}>
                    {idx > 0 && <span className="text-muted-foreground/40 px-0.5">/</span>}
                    <button
                      type="button"
                      onClick={() => void loadPath(seg.path, targetDistro)}
                      className={cn(
                        "rounded px-1 py-0.5 hover:bg-accent hover:text-foreground truncate max-w-32 transition-colors",
                        idx === breadcrumbs.length - 1 ? "text-foreground font-medium" : "text-muted-foreground"
                      )}
                      title={seg.path}
                    >
                      {seg.name}
                    </button>
                  </React.Fragment>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  setManualInputPath(currentPath);
                  setManualInputOpen(true);
                }}
                className="text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded-sm hover:bg-accent shrink-0 ml-1"
                title="手动输入路径"
              >
                编辑路径
              </button>
            </div>
          )}
        </div>

        {/* 快速过滤条 */}
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/40 px-3 bg-background/50">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={filterInputRef}
            type="text"
            value={filterQuery}
            onChange={(e) => {
              setFilterQuery(e.target.value);
              setSelectedIndex(-1);
            }}
            placeholder="在当前目录下过滤子文件夹..."
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          {filterQuery && (
            <button
              type="button"
              onClick={() => setFilterQuery("")}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* 目录内容列表 (核心区域) */}
        <div ref={listRef} className="flex-1 overflow-y-auto p-1.5 font-sans select-none focus:outline-none">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-muted-foreground gap-2">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span>正在读取目录…</span>
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center max-w-md mx-auto">
              <div className="rounded-full bg-destructive/10 p-2.5 mb-3 text-destructive">
                <AlertCircle className="h-5 w-5" />
              </div>
              <p className="text-xs font-semibold text-foreground mb-1">
                {error.includes("fetch") || error.includes("Network") ? "网关连接失败" : "读取目录失败"}
              </p>
              <p className="text-[11px] text-muted-foreground mb-4 font-mono break-all leading-relaxed">
                {error}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {base && (
                  <button
                    type="button"
                    onClick={() => {
                      localStorage.removeItem("acp_wsl_native_distro");
                      setGatewayBase("");
                      window.location.reload();
                    }}
                    className="rounded-sm bg-primary px-3 py-1 font-mono text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors shadow-xs"
                  >
                    切回本机 Windows 网关
                  </button>
                )}
                {wslNativeDistro && (
                  <button
                    type="button"
                    disabled={reconnectingWsl}
                    onClick={async () => {
                      setReconnectingWsl(true);
                      try {
                        const res = await launchWslGateway(wslNativeDistro, DEFAULT_WSL_GATEWAY_PORT);
                        if (res.ok && res.url) {
                          if (res.token) setGatewayToken(res.token, true);
                          await loadPath(undefined, null);
                        } else {
                          setError(res.error || "启动 WSL 网关失败");
                        }
                      } catch (e: any) {
                        setError(e?.message || "重连失败");
                      } finally {
                        setReconnectingWsl(false);
                      }
                    }}
                    className="rounded-sm border border-border px-3 py-1 font-mono text-xs font-medium hover:bg-accent text-foreground transition-colors"
                  >
                    {reconnectingWsl ? "正在拉起网关…" : "重新拉起 WSL 网关"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void loadPath(undefined, targetDistro)}
                  className="rounded-sm border border-border/60 px-3 py-1 font-mono text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                >
                  重试
                </button>
              </div>
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center p-4 text-muted-foreground text-xs">
              <Folder className="h-8 w-8 stroke-1 text-muted-foreground/40 mb-2" />
              <p className="text-foreground/80 font-medium">
                {filterQuery ? "未找到匹配的子文件夹" : "此目录下无子文件夹"}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                您可以直接点击右下角“打开当前目录”将本目录设为工作区。
              </p>
            </div>
          ) : (
            filteredEntries.map((item, idx) => {
              const isSelected = selectedIndex === idx;
              return (
                <div
                  key={item.path}
                  onClick={() => setSelectedIndex(idx)}
                  onDoubleClick={() => void loadPath(item.path, targetDistro)}
                  className={cn(
                    "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-xs cursor-pointer transition-colors",
                    isSelected
                      ? "bg-primary/15 text-primary font-medium"
                      : "text-foreground/90 hover:bg-accent hover:text-foreground"
                  )}
                >
                  {item.isGit ? (
                    <FolderGit2 className={cn("h-4 w-4 shrink-0", isSelected ? "text-primary" : "text-amber-500")} />
                  ) : (
                    <Folder className={cn("h-4 w-4 shrink-0", isSelected ? "text-primary" : "text-muted-foreground")} />
                  )}

                  <span className="flex-1 truncate font-mono text-[11.5px]">{item.name}</span>

                  {item.isGit && (
                    <span className="rounded-sm bg-amber-500/10 px-1 py-0.2 text-[9.5px] font-mono text-amber-500">
                      git
                    </span>
                  )}

                  <span className="text-[10px] text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity font-mono">
                    双击进入 ↵
                  </span>
                </div>
              );
            })
          )}
        </div>

        {/* 底部工具条：路径展示与操作按钮 */}
        <div className="flex h-12 shrink-0 items-center justify-between border-t border-border/80 px-3.5 bg-muted/30">
          <div className="flex items-center gap-2 min-w-0 max-w-[55%]">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider shrink-0 font-medium">
              目标:
            </span>
            <span className="truncate font-mono text-[11px] text-foreground/80" title={activeSelectedPath}>
              {activeSelectedPath || "未选择"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleFallbackSystemDialog}
              className="hidden sm:flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground mr-2 transition-colors"
              title="降级调用操作系统文件管理器"
            >
              <ExternalLink className="h-3 w-3" />
              <span>系统选择器</span>
            </button>

            <button
              type="button"
              onClick={close}
              className="rounded-md border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              取消
            </button>

            <button
              type="button"
              disabled={!activeSelectedPath || loading}
              onClick={() => handleConfirmOpen()}
              className="flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity shadow-sm"
            >
              <Check className="h-3.5 w-3.5" />
              <span>{customConfirmLabel || (onSelectCallback ? "选择此目录" : "打开为工作区")}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
