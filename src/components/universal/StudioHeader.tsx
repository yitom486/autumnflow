import { cn } from "@/lib/utils";
import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  Bot,
  Plug,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  GitFork,
  Cpu,
  FileDiff,
  Plus,
  MoreHorizontal,
  XCircle,
  Trash2,
  LogOut,
  Gauge,
  Info,
  ChevronDown,
  Terminal,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { agentQuota, type AgentSummary } from "@/lib/universal-api";
import { DeepSeekCredentialsDialog } from "./DeepSeekCredentialsDialog";
import { WorkspaceDropdown } from "./WorkspaceDropdown";
import { GatewayDot } from "./GatewayDot";
import { useStudioStore, type RecentWorkspace } from "@/stores/useStudioStore";
import { QuotaCard, QuotaRing } from "./QuotaCard";
import { SubagentMenu } from "./SessionHistoryTools";

export interface StudioHeaderProps {
  /** 编辑器打开时聊天栏变窄：隐藏中间的会话标题，避免挤压重叠 */
  compact?: boolean;
  agents: AgentSummary[];
  activeAgentId: string;
  onSelectAgent: (id: string) => void;
  onConnect: () => void;
  connecting: boolean;
  onOpenAuth: () => void;
  onLogout: () => void;
  authOk?: boolean | null;

  sessionId: string | null;
  sessionTitle?: string;
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } } | null;

  currentWorkspace: string | null;
  recentWorkspaces: RecentWorkspace[];
  onSelectWorkspace: (path: string, name?: string) => void;

  terminalOpen: boolean;
  onToggleTerminal: () => void;

  hasChangesCwd: boolean;
  supportsFork: boolean;
  supportsProviders: boolean;
  busy: boolean;
  isStreaming: boolean;

  onNewSession: () => void;
  onForkSession: () => void;
  onOpenProviders: () => void;
  onOpenChanges: () => void;
  onCloseSession: () => void;
  onDeleteSession: () => void;
  onClearMessages: () => void;
}

const MenuItem: React.FC<{ icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; disabled?: boolean }> = ({ icon: I, label, onClick, disabled }) => (
  <button type="button" onClick={onClick} disabled={disabled} className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 transition-colors">
    <I className="w-3.5 h-3.5" />
    <span>{label}</span>
  </button>
);

/**
 * Compact agent chip: dot + agent name (+ shield). Click → popover with agent
 * picker, connect, pid / protocol / version / capabilities and auth actions.
 * Keeps the header to one non-wrapping line at any width.
 */
export const AgentStatusChip: React.FC<{
  agents: AgentSummary[];
  activeAgentId: string;
  onSelectAgent: (id: string) => void;
  onConnect: () => void;
  connecting: boolean;
  onOpenAuth: () => void;
  onLogout: () => void;
  authOk?: boolean | null;
  sessionId?: string | null;
}> = ({ agents, activeAgentId, onSelectAgent, onConnect, connecting, onOpenAuth, onLogout, authOk, sessionId }) => {
  const [open, setOpen] = useState(false);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [deepseekCredOpen, setDeepseekCredOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const storeQuota = useStudioStore((s) => s.quota);
  const setQuota = useStudioStore((s) => s.setQuota);
  const setInput = useStudioStore((s) => s.setInput);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, [open]);

  const active = agents.find((a) => a.id === activeAgentId);

  const isMatchingStoreQuota =
    storeQuota &&
    (storeQuota.runtimeId === activeAgentId ||
      ((activeAgentId === "antigravity-stdio" || activeAgentId === "agy") &&
        (storeQuota.runtimeId === "agy" || storeQuota.runtimeId === "antigravity-stdio")) ||
      (activeAgentId === "codex" &&
        (storeQuota.runtimeId === "codex" || storeQuota.runtimeId === "codex-acp")));
  const quota = isMatchingStoreQuota ? storeQuota : (active?.status?.quota ?? null);
  const connected = Boolean(active?.status?.connected);
  const caps = active?.status?.agentCapabilities as any;
  const proto = active?.status?.protocolVersion;
  const agentInfo = active?.status?.agentInfo as any;
  const pid = active?.status?.pid;
  const isAuthed = authOk === true || (authOk !== false && quota?.status === "ok");
  const dot = connected ? "bg-success" : connecting ? "bg-warning animate-pulse" : "bg-muted-foreground/40";

  const handleRefreshQuota = useCallback(async () => {
    setRefreshingQuota(true);
    try {
      const res = await agentQuota(activeAgentId);
      if (res?.ok && res.quota) {
        setQuota(res.quota);
      }
    } catch (e) {
      console.warn("探测配额失败:", e);
    } finally {
      setRefreshingQuota(false);
    }
  }, [activeAgentId, setQuota]);

  // 切换智能体或展开卡片时，自动静默触发最新配额探测
  useEffect(() => {
    if (activeAgentId) {
      void handleRefreshQuota();
    }
  }, [activeAgentId, open, handleRefreshQuota]);

  const rawTitle = active?.title || activeAgentId;
  const displayTitle = rawTitle.includes("OpenCode (") ? "OpenCode" : rawTitle;

  return (
    <div ref={ref} className="relative flex items-center gap-1.5 min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="agent-chip"
        title={`${displayTitle} · ${connected ? "已连接" : connecting ? "连接中" : "未连接"}${connected && isAuthed ? " · 已认证" : ""}${quota?.primaryWindow ? ` · 限额剩余: ${quota.primaryWindow.percentLeft}%` : ""}`}
        className="h-7 min-w-0 max-w-[240px] flex items-center gap-1.5 rounded-md border border-transparent hover:border-border hover:bg-muted pl-2 pr-1.5 text-[13px] font-medium text-foreground"
      >
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", dot)} />
        <span className="truncate">{displayTitle}</span>
        {quota?.primaryWindow ? (
          <div className="flex items-center gap-1 shrink-0" title={`${quota.primaryWindow.label || "限额"}剩余: ${quota.primaryWindow.percentLeft}%`}>
            <QuotaRing percentLeft={quota.primaryWindow.percentLeft} size={14} className="shrink-0" />
            <span className="text-[10px] font-mono text-muted-foreground">{quota.primaryWindow.percentLeft}%</span>
          </div>
        ) : quota?.credits && quota.credits.unlimited !== true && quota.credits.balance !== undefined && Number.isFinite(Number(quota.credits.balance)) ? (
          <span
            className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-500 font-semibold shrink-0"
            title={`账户余额${quota.credits.currency ? ` (${quota.credits.currency})` : ""}`}
          >
            {quota.credits.currency === "CNY" ? "¥" : quota.credits.currency === "USD" ? "$" : ""}
            {Number(quota.credits.balance).toFixed(2)}
          </span>
        ) : quota?.account?.plan && !quota.account.plan.includes("(") && quota.account.plan.length <= 8 ? (
          <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-500 font-semibold shrink-0" title={`订阅计划: ${quota.account.plan}`}>
            {quota.account.plan}
          </span>
        ) : null}
        {connected && isAuthed && <ShieldCheck className="w-3 h-3 text-success shrink-0" aria-label="已认证" />}
        {connected && authOk === false && <ShieldAlert className="w-3 h-3 text-warning shrink-0" aria-label="需认证" />}
        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      </button>
      {!connected && (
        <Button size="sm" variant="default" onClick={onConnect} disabled={connecting} className="h-7 px-2.5 text-xs gap-1.5 font-medium shadow-none shrink-0">
          {connecting ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Plug className="w-3 h-3" />}
          <span>{connecting ? "连接中" : "连接"}</span>
        </Button>
      )}
      {open && (
        <div role="dialog" aria-label="智能体状态" className="absolute left-0 top-full mt-1.5 w-80 rounded-lg border border-border bg-popover shadow-lg text-xs z-50 whitespace-normal">
          <div className="p-1 max-h-56 overflow-y-auto border-b border-border/60">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => { onSelectAgent(a.id); }}
                className={cn("w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left hover:bg-accent", a.id === activeAgentId ? "text-foreground font-medium bg-accent/60" : "text-muted-foreground")}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", a.status?.connected ? "bg-success" : "bg-muted-foreground/30")} />
                <span className="truncate flex-1">{a.title.replace(/\s*\([^)]*\)/g, "").trim()}</span>
                {a.status?.quota?.primaryWindow && (
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {a.status.quota.primaryWindow.percentLeft}%
                  </span>
                )}
                {a.status?.connected && <span className="text-[10px] text-success">已连接</span>}
              </button>
            ))}
          </div>
          <div className="p-3 space-y-1.5 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground truncate">{displayTitle}</span>
              {connected && <span className="font-mono text-[10px]">ACP v{proto ?? "1"}</span>}
            </div>
            <div className="flex items-center gap-1.5">
              <PlugZap className={cn("w-3 h-3", connected ? "text-success" : "text-muted-foreground")} />
              <span>{connected ? "已连接" : connecting ? "连接中…" : "未连接"}</span>
              {connected && pid ? <span className="font-mono">· pid {pid}</span> : null}
              {agentInfo?.version && <span className="font-mono">· v{agentInfo.version}</span>}
            </div>
            {connected && (
              <div className="flex items-center gap-1.5">
                {isAuthed ? (
                  <>
                    <ShieldCheck className="w-3 h-3 text-success shrink-0" />
                    <span>
                      已认证
                      {quota?.account?.email || quota?.account?.name ? (
                        <>（账号: <strong className="font-mono text-foreground font-medium">{quota.account.email || quota.account.name}</strong>）</>
                      ) : (
                        "（复用本地登录凭据）"
                      )}
                    </span>
                  </>
                ) : authOk === false ? (
                  <>
                    <ShieldAlert className="w-3 h-3 text-warning shrink-0" />
                    <span>需要登录认证</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="w-3 h-3 shrink-0" />
                    <span>认证状态探测中</span>
                  </>
                )}
              </div>
            )}
            <QuotaCard
              quota={quota}
              agentTitle={active?.title}
              agentId={activeAgentId}
              refreshing={refreshingQuota}
              onRefresh={handleRefreshQuota}
            />
            <div className="pt-2 flex items-center gap-1.5">
              {!connected ? (
                <Button size="sm" onClick={() => { onConnect(); }} disabled={connecting} className="h-7 px-2.5 text-xs gap-1.5">
                  <Plug className="w-3 h-3" /> {connecting ? "连接中" : "连接"}
                </Button>
              ) : authOk === false ? (
                <Button size="sm" variant="outline" onClick={() => { setOpen(false); onOpenAuth(); }} className="h-7 px-2.5 text-xs gap-1.5 border-warning/40 text-warning hover:bg-warning/10">
                  <ShieldAlert className="w-3 h-3" /> 去认证
                </Button>
              ) : null}
              {connected && (
                <Button size="sm" variant="ghost" onClick={() => { setOpen(false); onLogout(); }} className="h-7 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-destructive">
                  <LogOut className="w-3 h-3" /> 退出登录
                </Button>
              )}
              {activeAgentId === "deepseek" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setOpen(false); setDeepseekCredOpen(true); }}
                  className="h-7 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <KeyRound className="w-3 h-3" /> DeepSeek 凭据
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
      <DeepSeekCredentialsDialog
        isOpen={deepseekCredOpen}
        onClose={() => setDeepseekCredOpen(false)}
        agentId={activeAgentId}
        onChanged={handleRefreshQuota}
      />
    </div>
  );
};

export const StudioHeader: React.FC<StudioHeaderProps> = ({
  agents,
  activeAgentId,
  onSelectAgent,
  onConnect,
  connecting,
  onOpenAuth,
  onLogout,
  authOk,
  sessionId,
  sessionTitle,
  usage,
  currentWorkspace,
  recentWorkspaces,
  onSelectWorkspace,
  terminalOpen,
  onToggleTerminal,
  hasChangesCwd,
  supportsFork,
  supportsProviders,
  busy,
  isStreaming,
  onNewSession,
  onForkSession,
  onOpenProviders,
  onOpenChanges,
  onCloseSession,
  onDeleteSession,
  onClearMessages,
  compact,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const active = agents.find((a) => a.id === activeAgentId);
  const connected = Boolean(active?.status?.connected);
  const caps = active?.status?.agentCapabilities as any;
  const proto = active?.status?.protocolVersion;
  const agentInfo = active?.status?.agentInfo as any;
  const pid = active?.status?.pid;

  // Close more menu on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [menuOpen]);

  return (
    <header className="@container h-12 border-b border-border bg-background px-3 flex items-center justify-between gap-2 shrink-0 z-20 select-none whitespace-nowrap overflow-visible">
      {/* LEFT: compact agent status chip (agent / connection / pid / auth in a popover) + workspace */}
      <div className="flex items-center gap-2 min-w-0 shrink">
        <span className="sr-only">AutumnFlow</span>
        <AgentStatusChip
          agents={agents}
          activeAgentId={activeAgentId}
          onSelectAgent={onSelectAgent}
          onConnect={onConnect}
          connecting={connecting}
          onOpenAuth={onOpenAuth}
          onLogout={onLogout}
          authOk={authOk}
          sessionId={sessionId}
        />
        <GatewayDot />
        <div className="min-w-0 hidden @lg:block">
          <WorkspaceDropdown
            currentWorkspace={currentWorkspace}
            recentWorkspaces={recentWorkspaces}
            onSelectWorkspace={onSelectWorkspace}
          />
        </div>
      </div>

      {/* CENTER: Current Session Title & Token Usage */}
      <div className={cn("hidden @3xl:flex items-center gap-2 min-w-0 flex-1 justify-center max-w-lg", compact && "!hidden")}>
        {sessionId ? (
          <div className="flex items-center gap-2 min-w-0 px-2 py-1">
            <span
              className="text-[13px] font-medium text-foreground truncate max-w-[260px] sm:max-w-[360px]"
              title={`会话 ${sessionId}`}
            >
              {sessionTitle || "当前会话"}
            </span>
            {usage && (
              <span className="items-center gap-1 font-mono text-[10px] text-muted-foreground hidden lg:inline-flex pl-1 border-l border-border/60">
                <Gauge className="w-3 h-3" />
                {usage.used.toLocaleString()}/{usage.size.toLocaleString()}
                {usage.cost && <span className="text-success">${usage.cost.amount}</span>}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground truncate">尚未开始会话 · 发送第一条消息即新建</span>
        )}
      </div>

      {/* RIGHT: Actions (Changes, Terminal, Providers, + New Session, More Menu) */}
      <div className="flex items-center gap-1.5 shrink-0">
        <SubagentMenu key={`${activeAgentId}:${sessionId}`} agentId={activeAgentId} sessionId={sessionId} />
        {/* Code Changes / Diff */}
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenChanges}
          disabled={busy || !hasChangesCwd}
          title={hasChangesCwd ? "查看本地代码变更 (Ctrl+Shift+D)" : "未选择工作区"}
          className={`hidden @lg:inline-flex h-7 px-2 text-xs gap-1.5 rounded-md border border-border bg-transparent shadow-none hover:bg-muted transition-colors ${
            hasChangesCwd ? "text-foreground" : "text-muted-foreground opacity-60"
          }`}
        >
          <FileDiff className="w-3.5 h-3.5" />
          <span className="hidden @2xl:inline">变更</span>
          
        </Button>

        {/* Integrated Terminal Drawer */}
        <Button
          size="sm"
          variant="outline"
          onClick={onToggleTerminal}
          title="集成终端 (Ctrl+`)"
          aria-pressed={terminalOpen}
          className={`hidden @lg:inline-flex h-7 px-2 text-xs gap-1.5 rounded-md border shadow-none transition-colors ${
            terminalOpen ? "border-border bg-accent text-foreground" : "border-border bg-transparent text-foreground hover:bg-muted"
          }`}
        >
          <Terminal className="w-3.5 h-3.5" />
          <span className="hidden @2xl:inline">终端</span>
        </Button>

        {/* Providers */}
        {supportsProviders && (
          <Button
            size="sm"
            variant="outline"
            onClick={onOpenProviders}
            disabled={busy}
            title="Providers（模型通道与网关配置）"
            className="h-7 px-2 text-xs gap-1.5 rounded-md border border-border bg-transparent shadow-none text-foreground hover:bg-muted hidden @lg:inline-flex"
          >
            <Cpu className="w-3.5 h-3.5" />
            <span className="hidden @2xl:inline">通道</span>
          </Button>
        )}

        {/* Primary New Session Button (Monochromatic High-Contrast) */}
        <button
          type="button"
          onClick={() => onNewSession()}
          disabled={isStreaming || busy}
          title="新会话（可设置工作目录与 MCP）"
          className={`h-7 px-2.5 text-xs gap-1.5 font-medium rounded-md flex items-center cursor-pointer transition-colors disabled:opacity-50 ${
            connected ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border text-foreground hover:bg-muted"
          }`}
        >
          <Plus className="w-3.5 h-3.5" />
          <span className="hidden @md:inline">新会话</span>
        </button>

        {/* More Actions Menu (...) */}
        <div className="relative" ref={menuRef}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setMenuOpen(!menuOpen)}
            className="h-7 w-7 p-0 flex items-center justify-center shadow-none bg-transparent text-muted-foreground hover:text-foreground"
            title="更多会话与智能体操作"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </Button>

          {menuOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-48 p-1 rounded-lg border border-border bg-popover shadow-lg text-xs z-50">
              <div className="@lg:hidden">
                <div className="px-2.5 py-1.5"><WorkspaceDropdown currentWorkspace={currentWorkspace} recentWorkspaces={recentWorkspaces} onSelectWorkspace={onSelectWorkspace} /></div>
                <MenuItem icon={FileDiff} label="变更" disabled={busy || !hasChangesCwd} onClick={() => { setMenuOpen(false); onOpenChanges(); }} />
                <MenuItem icon={Terminal} label={terminalOpen ? "关闭终端" : "终端"} onClick={() => { setMenuOpen(false); onToggleTerminal(); }} />
                {supportsProviders && <MenuItem icon={Cpu} label="通道" disabled={busy} onClick={() => { setMenuOpen(false); onOpenProviders(); }} />}
                <div className="my-1 border-t border-border/60" />
              </div>
              {supportsFork && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onForkSession();
                  }}
                  disabled={busy || !sessionId}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 transition-colors"
                >
                  <GitFork className="w-3.5 h-3.5" />
                  <span>Fork 会话</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onClearMessages();
                }}
                disabled={isStreaming}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>清空消息记录</span>
              </button>

              {sessionId && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onCloseSession();
                  }}
                  disabled={busy}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 transition-colors"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  <span>关闭会话</span>
                </button>
              )}

              {sessionId && (
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onDeleteSession();
                  }}
                  disabled={busy}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-destructive hover:bg-destructive/10 disabled:opacity-40 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>删除会话</span>
                </button>
              )}

              <div className="my-1 border-t border-border/60" />

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>退出 Agent 登录</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
