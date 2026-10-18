import React, { useState, useMemo } from "react";
import { motion } from "framer-motion";
import {
  Plus,
  Search,
  ChevronRight,
  ChevronDown,
  Folder,
  Boxes,
  Settings,
  Trash2,
  GitFork,
  Bot,
  RefreshCw,
  PlusCircle,
  Cloud,
  MoreHorizontal,
  X,
  FolderOpen,
  Copy,
  Terminal,
  MessageSquare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";
import { isSameCwd, normalizeCwd, toEnvironmentNativeCwd } from "@/lib/threads";
import type { AgentSummary } from "@/lib/universal-api";
import { getWorkspaceEnv, isPosixEnvironment, type RecentWorkspace, useStudioStore } from "@/stores/useStudioStore";
import { SPRING_LAYOUT, SPRING_SWAP } from "@/lib/motion-primitives";
import { AISidebar, type SidebarResource, MarqueeLabel } from "@/components/primitives/AISidebar";
import { SessionRow, type SessionRowProps, type SessionItem, compactTimeAgo } from "./SessionRow";
import { ProjectSessionsModal, type ProjectSessionsModalProps } from "./ProjectSessionsModal";

export { SessionRow, type SessionRowProps, type SessionItem, compactTimeAgo };
export { ProjectSessionsModal, type ProjectSessionsModalProps };

export interface SidebarProps {
  agents: AgentSummary[];
  activeAgentId: string;
  onSelectAgent: (id: string) => void;
  onConnectAgent: (id: string) => void;
  connectingId: string | null;
  authOk: Record<string, boolean | null>;
  sessions: SessionItem[];
  sessionsLoading: boolean;
  sessionsError?: string;
  activeSessionId: string | null;
  onRefreshSessions: () => void;
  onNewSession: (targetCwd?: string) => void;
  onOpenSession: (s: SessionItem) => void;
  onForkSession: (s: SessionItem) => void;
  onDeleteSession: (s: SessionItem) => void;
  supportsFork: boolean;
  supportsList: boolean;
  onOpenProviders: () => void;
  supportsProviders: boolean;
  onManageCustom: () => void;
  /** One-click empty-session cleanup (null/false hides it). */
  cleaningEmpty?: boolean;
  onCleanupEmpty?: () => void;
  currentWorkspace?: string | null;
  recentWorkspaces?: RecentWorkspace[];
  onSelectWorkspace?: (path: string, name?: string) => void;
  onOpenSettings?: () => void;
  onImportHistory?: () => void;
}

function shortCwd(cwd?: string): string {
  if (!cwd) return "";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.slice(-1)[0] || "";
}


/** Memoized single agent row */
export interface AgentRowProps {
  agent: AgentSummary;
  active: boolean;
  authOk: boolean | null | undefined;
  connecting: boolean;
  onSelect: (id: string) => void;
  onConnect: (id: string) => void;
}

export const AgentRow = React.memo<AgentRowProps>(
  ({ agent, active, authOk, connecting, onSelect, onConnect }) => {
    const connected = agent.status?.connected;
    return (
      <div
        onClick={() => onSelect(agent.id)}
        title={agent.authHint ? `认证复用：${agent.authHint}` : agent.description}
        className={`rounded-md px-2.5 py-1.5 cursor-pointer border transition-colors ${
          active ? "bg-muted/70 border-border font-medium" : "border-transparent hover:bg-muted/40"
        }`}
      >
        <div className="flex items-center gap-2">
          <Bot className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-xs text-foreground truncate flex-1">{agent.title}</span>
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              connected ? "bg-success" : "bg-muted-foreground/40"
            }`}
          />
        </div>
      </div>
    );
  }
);
AgentRow.displayName = "AgentRow";



export const Sidebar: React.FC<SidebarProps> = (p) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({});
  const [modalProject, setModalProject] = useState<{
    name: string;
    items: SessionItem[];
    isCloud?: boolean;
  } | null>(null);

  const MAX_VISIBLE_SESSIONS = 5;

  // Group sessions by directory/project
  const projectGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = query
      ? p.sessions.filter((s) => `${s.title || ""} ${s.sessionId}`.toLowerCase().includes(query))
      : p.sessions;

    const isPosix = isPosixEnvironment();

    // 通用路径提纯与规范化（零硬编码，适用于 WSL、SSH 远程、本地 Windows）
    const sanitizePath = (p?: string | null): string | null => {
      if (!p) return null;
      return toEnvironmentNativeCwd(p, isPosix);
    };

    // 自适应环境判定：
    // 检查是否有任何原生 POSIX 路径（非 Windows 盘符开头，包含 /）
    const hasAnyPosixSess = p.sessions.some((s) => {
      const c = s.cwd;
      return Boolean(c && (c.startsWith("/") || /^(?:\\\\|\/\/)wsl(?:\$|\.localhost)/i.test(c)) && !/^[a-zA-Z]:/.test(c));
    });

    const isPathMatchingEnv = (pathStr?: string | null): boolean => {
      const clean = sanitizePath(pathStr);
      if (!clean) return false;
      const isWin = /^[a-zA-Z]:[\\\/]/i.test(clean) || /^\/mnt\/[a-zA-Z](\/|$)/i.test(clean);
      if (isPosix && hasAnyPosixSess) {
        return !isWin;
      } else if (!isPosix) {
        // Windows 环境下只匹配属于 Windows 的工作区
        return isWin;
      }
      return true;
    };

    const map = new Map<
      string,
      {
        id: string;
        name: string;
        path?: string;
        items: SessionItem[];
        isCurrent: boolean;
        isCloud?: boolean;
      }
    >();

    // 1. Seed recent workspaces (仅加载属于当前环境的工程)
    if (p.recentWorkspaces && p.recentWorkspaces.length > 0) {
      for (const rawW of p.recentWorkspaces) {
        const wPath = sanitizePath(rawW.path) || rawW.path;
        if (!isPathMatchingEnv(wPath)) continue;
        const key = normalizeCwd(wPath) || wPath;
        const name = rawW.name || shortCwd(wPath) || wPath;
        const isCurrent = Boolean(p.currentWorkspace && isSameCwd(p.currentWorkspace, wPath));
        map.set(key, {
          id: key,
          name,
          path: wPath,
          items: [],
          isCurrent,
          isCloud: name.toLowerCase().includes("cli") || name.toLowerCase().includes("cloud"),
        });
      }
    }

    // 2. Seed current workspace if not present in recents
    if (p.currentWorkspace && isPathMatchingEnv(p.currentWorkspace)) {
      const curPath = sanitizePath(p.currentWorkspace) || p.currentWorkspace;
      const curKey = normalizeCwd(curPath) || curPath;
      if (!map.has(curKey)) {
        const name = shortCwd(curPath) || curPath;
        map.set(curKey, {
          id: curKey,
          name,
          path: curPath,
          items: [],
          isCurrent: true,
          isCloud: name.toLowerCase().includes("cli") || name.toLowerCase().includes("cloud"),
        });
      }
    }

    // 3. Distribute sessions to matching project
    for (const rawSess of filtered) {
      const cleanCwd = sanitizePath(rawSess.cwd) || rawSess.cwd;
      const sess = cleanCwd !== rawSess.cwd ? { ...rawSess, cwd: cleanCwd } : rawSess;
      const sessCwd = sess.cwd ? (normalizeCwd(sess.cwd) || sess.cwd) : null;

      // 若历史会话关联的目录与当前环境不符，在当前视图中过滤
      if (sessCwd && !isPathMatchingEnv(sessCwd)) {
        continue;
      }

      let matchedKey: string | null = null;

      if (sessCwd) {
        for (const [key, grp] of map.entries()) {
          if (grp.path && isSameCwd(grp.path, sess.cwd)) {
            matchedKey = key;
            break;
          }
        }
        if (!matchedKey) {
          const rawPath = sess.cwd || sessCwd;
          const name = shortCwd(rawPath) || rawPath;
          const isCurrent = Boolean(p.currentWorkspace && isSameCwd(p.currentWorkspace, rawPath));
          matchedKey = sessCwd;
          map.set(matchedKey, {
            id: matchedKey,
            name,
            path: rawPath,
            items: [],
            isCurrent,
            isCloud: name.toLowerCase().includes("cli") || name.toLowerCase().includes("cloud"),
          });
        }
      } else {
        if (p.currentWorkspace && isPathMatchingEnv(p.currentWorkspace)) {
          matchedKey = normalizeCwd(p.currentWorkspace) || p.currentWorkspace;
        } else {
          matchedKey = "general";
          if (!map.has(matchedKey)) {
            map.set(matchedKey, {
              id: "general",
              name: "General",
              items: [],
              isCurrent: false,
            });
          }
        }
      }

      if (matchedKey) {
        const grp = map.get(matchedKey);
        if (grp) grp.items.push(sess);
      }
    }

    // 4. 确保当前正在活跃会话（即使尚未在 sessions 列表里）自动并入当前激活的项目组中
    if (p.activeSessionId) {
      const allSessionIds = new Set<string>();
      for (const grp of map.values()) {
        for (const item of grp.items) allSessionIds.add(item.sessionId);
      }
      if (!allSessionIds.has(p.activeSessionId)) {
        let grp = p.currentWorkspace
          ? map.get(normalizeCwd(sanitizePath(p.currentWorkspace) || p.currentWorkspace) || p.currentWorkspace)
          : undefined;
        if (!grp) {
          for (const g of map.values()) {
            if (g.isCurrent) {
              grp = g;
              break;
            }
          }
        }
        if (!grp && map.size > 0) {
          grp = map.values().next().value;
        }
        if (grp) {
          grp.items.unshift({
            sessionId: p.activeSessionId,
            title: `当前会话 (${p.activeSessionId.slice(0, 8)})`,
            cwd: grp.path || p.currentWorkspace || undefined,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }

    // Sort: 当前激活工作区置顶，其余按名称字母排序
    const list = Array.from(map.values());
    list.sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    // 容底保护：若所有工程过滤后为空，自动展示当前工作区，防止侧边栏出现空洞
    if (list.length === 0) {
      const curPath = p.currentWorkspace || "";
      const curName = curPath ? (shortCwd(curPath) || curPath) : "工作区";
      list.push({
        id: curPath || "default",
        name: curName,
        path: curPath || undefined,
        items: [],
        isCurrent: true,
      });
    }

    return list;
  }, [p.sessions, searchQuery, p.recentWorkspaces, p.currentWorkspace]);

  const expandedIds = useMemo(() => {
    return projectGroups
      .filter((grp) => !collapsedProjects[grp.id || grp.name])
      .map((grp) => grp.id || grp.name);
  }, [projectGroups, collapsedProjects]);

  const handleExpandedChange = (ids: string[]) => {
    const nextCollapsed: Record<string, boolean> = {};
    const expandedSet = new Set(ids);
    for (const grp of projectGroups) {
      const gid = grp.id || grp.name;
      if (!expandedSet.has(gid)) {
        nextCollapsed[gid] = true;
      }
    }
    setCollapsedProjects(nextCollapsed);
  };

  const sidebarResources: SidebarResource[] = useMemo(() => {
    return projectGroups.map((grp) => {
      const isExpanded = !collapsedProjects[grp.id || grp.name];
      const total = grp.items.length;
      const needsTruncation = total > MAX_VISIBLE_SESSIONS && !expandedProjects[grp.id || grp.name];

      let visibleItems = grp.items;
      if (needsTruncation) {
        const activeIdx = grp.items.findIndex((s) => s.sessionId === p.activeSessionId);
        if (activeIdx >= MAX_VISIBLE_SESSIONS) {
          visibleItems = [
            ...grp.items.slice(0, MAX_VISIBLE_SESSIONS - 1),
            grp.items[activeIdx],
          ];
        } else {
          visibleItems = grp.items.slice(0, MAX_VISIBLE_SESSIONS);
        }
      }

      const sessionChildren: SidebarResource[] = visibleItems.map((s) => ({
        id: s.sessionId,
        label: s.title || "未命名会话",
        kind: "session",
        metadata: { session: s, project: grp },
        badge: (
          <span className="font-mono text-[10px] text-muted-foreground/60 shrink-0">
            {compactTimeAgo(s.updatedAt)}
          </span>
        ),
      }));

      if (total > MAX_VISIBLE_SESSIONS) {
        sessionChildren.push({
          id: `${grp.id || grp.name}_more`,
          label: total - visibleItems.length > 0 ? `更多 ${total - visibleItems.length} 个...` : "查看全部...",
          kind: "bookmark",
          metadata: { isMore: true, project: grp },
          icon: <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />,
        });
      } else if (total === 0) {
        sessionChildren.push({
          id: `${grp.id || grp.name}_empty`,
          label: "暂无会话 (+ 新建)",
          kind: "file",
          metadata: { isNewPlaceholder: true, project: grp },
        });
      }

      return {
        id: grp.id || grp.name,
        label: grp.name,
        kind: "project",
        metadata: { project: grp, path: grp.path, isCurrent: grp.isCurrent, isCloud: grp.isCloud },
        badge: (
          <div className="flex items-center gap-1 shrink-0">
            {grp.isCurrent && (
              <span className="text-[9.5px] px-1 py-0.2 rounded bg-primary/15 text-primary font-mono font-medium">
                当前
              </span>
            )}
            <button
              type="button"
              title={`在 ${grp.name} 中新建会话`}
              aria-label={`在 ${grp.name} 中新建会话`}
              onClick={(e) => {
                e.stopPropagation();
                if (grp.path && p.onSelectWorkspace) {
                  p.onSelectWorkspace(grp.path, grp.name);
                }
                p.onNewSession(grp.path);
              }}
              className="opacity-0 group-hover/resource:opacity-100 p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-all shrink-0 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        ),
        children: sessionChildren,
      };
    });
  }, [projectGroups, collapsedProjects, expandedProjects, p.activeSessionId, p.currentWorkspace, p.onSelectWorkspace, p.onNewSession]);

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-sidebar flex flex-col text-xs overflow-hidden select-none z-10 transition-colors">
      {/* 1. 顶部：新会话为主操作，搜索 / 清理 / 刷新为次要图标 */}
      <div className="h-12 px-2 flex items-center gap-1 border-b border-border shrink-0">
        <button
          type="button"
          onClick={() => p.onNewSession()}
          className="flex-1 h-7 px-2 rounded-md flex items-center gap-2 text-[13px] font-medium text-foreground hover:bg-accent transition-colors cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5 text-muted-foreground" />
          <span>新会话</span>
        </button>
        {p.onImportHistory && <button type="button" onClick={p.onImportHistory} title="导入外部历史" aria-label="导入外部历史"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"><MoreHorizontal className="size-3.5" /></button>}
        <button
          type="button"
          onClick={() => setShowSearch(!showSearch)}
          title="搜索会话"
          aria-label="搜索会话"
          aria-pressed={showSearch}
          className={`h-7 w-7 rounded-md flex items-center justify-center transition-colors ${showSearch ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent"}`}
        >
          <Search className="w-3.5 h-3.5" />
        </button>
        {p.onCleanupEmpty && (
          <button
            type="button"
            onClick={p.onCleanupEmpty}
            disabled={p.cleaningEmpty}
            title="清理空会话"
            aria-label="清理空会话"
            className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
          >
            <Trash2 className={`w-3.5 h-3.5 ${p.cleaningEmpty ? "animate-pulse" : ""}`} />
          </button>
        )}
        <button
          type="button"
          onClick={p.onRefreshSessions}
          title="刷新会话列表"
          aria-label="刷新会话列表"
          className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${p.sessionsLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Optional Search Input */}
      {p.sessionsError && <p role="alert" className="px-3 py-2 text-xs text-destructive">会话索引读取失败：{p.sessionsError}</p>}
      {showSearch && (
        <div className="px-2 pt-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="按标题或 ID 搜索"
            autoFocus
            className="w-full h-7 bg-background border border-input rounded-md px-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-ring"
          />
        </div>
      )}

      {/* 2. 只保留真正可用的入口（原 Conversation History 实为新建会话、Automations 无功能，已移除） */}
      <div className="px-2 pt-2 shrink-0">
        <button
          type="button"
          onClick={p.onManageCustom}
          className="w-full h-7 flex items-center gap-2 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-left"
        >
          <Boxes className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate flex-1">自定义智能体</span>
        </button>
      </div>

      {/* 4. Projects Tree Header */}
      <div className="mt-3 px-4 pb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground shrink-0 select-none">
        <span>项目</span>
        <div className="flex items-center gap-1 text-muted-foreground">
          <button
            type="button"
            onClick={() => {
              useWorkbenchStore.getState().openWorkspacePicker();
            }}
            title="打开本地项目文件夹 (Ctrl+O)"
            aria-label="打开本地项目文件夹"
            className="h-5 w-5 rounded flex items-center justify-center hover:text-foreground hover:bg-accent cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => p.onNewSession()}
            title="新建会话"
            aria-label="新建会话"
            className="h-5 w-5 rounded flex items-center justify-center hover:text-foreground hover:bg-accent cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 5. Scrollable Project Groups & Conversations Tree powered by BeUI AISidebar */}
      {projectGroups.length === 0 ? (
        <div className="flex-1 px-3 py-6 text-center text-muted-foreground text-xs">
          暂无会话项目
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 py-1">
          <AISidebar
            items={sidebarResources}
            activeId={p.activeSessionId}
            expandedIds={expandedIds}
            onExpandedChange={handleExpandedChange}
            onActiveChange={(id) => {
              if (id.endsWith("_more")) {
                const moreItem = sidebarResources
                  .flatMap((g) => g.children || [])
                  .find((c) => c.id === id);
                if (moreItem?.metadata?.project) {
                  setModalProject(moreItem.metadata.project as any);
                }
                return;
              }
              if (id.endsWith("_empty")) {
                const emptyItem = sidebarResources
                  .flatMap((g) => g.children || [])
                  .find((c) => c.id === id);
                const prj = emptyItem?.metadata?.project as any;
                if (prj?.path && p.onSelectWorkspace) {
                  p.onSelectWorkspace(prj.path, prj.name);
                }
                p.onNewSession(prj?.path);
                return;
              }

              const sess = p.sessions.find((s) => s.sessionId === id);
              if (sess) {
                if (sess.cwd && p.onSelectWorkspace && p.currentWorkspace !== sess.cwd) {
                  const grp = projectGroups.find((g) => g.path && isSameCwd(g.path, sess.cwd));
                  p.onSelectWorkspace(sess.cwd, grp?.name);
                }
                p.onOpenSession(sess);
              }
            }}
            onItemClick={(item) => {
              if (item.kind === "project" && item.metadata?.path) {
                if (p.onSelectWorkspace && p.currentWorkspace !== item.metadata.path) {
                  p.onSelectWorkspace(item.metadata.path as string, item.label);
                }
              }
            }}
            renderIcon={(item, expanded) => {
              if (item.kind === "project" || item.kind === "folder") {
                return (
                  <div className="flex items-center gap-1 shrink-0">
                    <motion.span
                      className="grid size-3 place-items-center text-muted-foreground"
                      animate={{ rotate: expanded ? 90 : 0 }}
                      transition={SPRING_SWAP}
                    >
                      <ChevronRight className="w-3 h-3 shrink-0" />
                    </motion.span>
                    {item.metadata?.isCloud ? (
                      <Cloud className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    ) : expanded ? (
                      <FolderOpen className="w-3.5 h-3.5 text-primary shrink-0" />
                    ) : (
                      <Folder className="w-3.5 h-3.5 text-primary/80 shrink-0" />
                    )}
                  </div>
                );
              }
              if (item.id.endsWith("_more")) {
                return <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
              }
              if (item.id.endsWith("_empty")) {
                return <PlusCircle className="w-3.5 h-3.5 text-primary/70 shrink-0" />;
              }
              return <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
            }}
            renderMenu={(item, controls) => {
              if (item.kind !== "session") return null;
              const session = item.metadata?.session as SessionItem;
              if (!session) return null;

              return (
                <div className="flex flex-col py-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      controls.close();
                      p.onOpenSession(session);
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-foreground transition-colors text-left cursor-pointer"
                  >
                    <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>进入会话</span>
                  </button>
                  {p.supportsFork && (
                    <button
                      type="button"
                      onClick={() => {
                        controls.close();
                        p.onForkSession(session);
                      }}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-foreground transition-colors text-left cursor-pointer"
                    >
                      <GitFork className="w-3.5 h-3.5 text-muted-foreground" />
                      <span>分叉新会话 (Fork)</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      controls.close();
                      void navigator.clipboard.writeText(session.title || session.sessionId);
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-foreground transition-colors text-left cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>复制会话标题</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      controls.close();
                      void navigator.clipboard.writeText(session.sessionId);
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-foreground transition-colors text-left cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>复制会话 ID</span>
                  </button>
                  <div className="my-1 h-px bg-border/60" />
                  <button
                    type="button"
                    onClick={() => {
                      controls.close();
                      p.onDeleteSession(session);
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-destructive/15 text-destructive transition-colors text-left cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    <span>删除此会话</span>
                  </button>
                </div>
              );
            }}
            onDelete={(item) => {
              if (item.kind === "session" && item.metadata?.session) {
                p.onDeleteSession(item.metadata.session as SessionItem);
              }
            }}
            className="space-y-0.5"
          />
        </div>
      )}

      {/* 6. Bottom Sticky Settings Bar */}
      <div className="p-2 border-t border-border shrink-0">
        <button
          type="button"
          onClick={() => (p.onOpenSettings ? p.onOpenSettings() : p.onNewSession())}
          title="设置新会话的工作目录与 MCP 服务"
          className="w-full h-7 flex items-center gap-2 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-xs cursor-pointer"
        >
          <Settings className="w-3.5 h-3.5" />
          <span>会话设置</span>
        </button>
      </div>

      {/* 7. Modal for viewing all sessions in a project */}
      {modalProject && (
        <ProjectSessionsModal
          isOpen={Boolean(modalProject)}
          onClose={() => setModalProject(null)}
          projectName={modalProject.name}
          isCloud={modalProject.isCloud}
          sessions={modalProject.items}
          activeSessionId={p.activeSessionId}
          supportsFork={p.supportsFork}
          onOpenSession={p.onOpenSession}
          onForkSession={p.onForkSession}
          onDeleteSession={p.onDeleteSession}
        />
      )}
    </aside>
  );
};
