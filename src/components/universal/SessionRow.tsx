import React, { useState } from "react";
import { motion } from "framer-motion";
import {
  Trash2,
  GitFork,
  Copy,
  Terminal,
  MessageSquare,
} from "lucide-react";
import { SPRING_LAYOUT } from "@/lib/motion-primitives";
import { MarqueeLabel } from "@/components/primitives/AISidebar";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuLabel,
  ContextMenuShortcut,
} from "@/components/motion/ContextMenu";

export interface SessionItem {
  sessionId: string;
  title?: string | null;
  cwd?: string;
  updatedAt?: string | null;
  origin?: "created" | "imported" | "subagent";
  kind?: "main" | "subagent";
  parentSessionId?: string;
  /** 这个会话绑定的智能体（会话与运行时绑定，左侧列表跨运行时展示）。 */
  agentId?: string;
  /** 绑定运行时的显示名（列表里标出来）。 */
  agentLabel?: string;
  /** 这一轮正在跑。 */
  running?: boolean;
  _meta?: Record<string, unknown> | null;
}

export function compactTimeAgo(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export interface SessionRowProps {
  session: SessionItem;
  active: boolean;
  supportsFork: boolean;
  onOpen: (s: SessionItem) => void;
  onFork: (s: SessionItem) => void;
  onDelete: (s: SessionItem) => void;
  /** 这一轮正在跑（智能体还在干活）。 */
  running?: boolean;
  /** 会话绑定的运行时名字，显示在标题前面。 */
  agentLabel?: string;
}

export const SessionRow = React.memo<SessionRowProps>(
  ({ session, active, supportsFork, onOpen, onFork, onDelete, running, agentLabel }) => {
    const time = compactTimeAgo(session.updatedAt);
    const [hovered, setHovered] = useState(false);
    const sessionTitle = session.title || "未命名会话";

    return (
      <ContextMenu>
        <ContextMenuTrigger>
          <motion.div
            layout
            transition={SPRING_LAYOUT}
            onClick={() => onOpen(session)}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            data-slot="session-row"
            data-session-id={session.sessionId}
            className={`group relative flex items-center justify-between rounded-md px-2 py-1.5 cursor-pointer text-xs transition-colors select-none ${
              active
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            }`}
          >
            {/* 彻底去除原生 title 属性，告别生硬白底遮挡 tooltip */}
            <div className="min-w-0 flex-1 pr-1.5 flex items-center gap-1.5 overflow-hidden">
              {running && (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-success animate-pulse"
                  title="正在运行"
                  aria-label="正在运行"
                />
              )}
              {agentLabel && (
                <span
                  className="shrink-0 rounded bg-muted px-1 py-px font-mono text-[9px] text-muted-foreground group-hover:bg-accent"
                  title={`绑定运行时：${agentLabel}`}
                >
                  {agentLabel}
                </span>
              )}
              <MarqueeLabel active={hovered || active} className="text-xs">
                {sessionTitle}
              </MarqueeLabel>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {/* Action icons on hover */}
              <span className="hidden group-hover:flex items-center gap-1">
                {supportsFork && (
                  <button
                    type="button"
                    title="Fork 会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFork(session);
                    }}
                    className="p-0.5 rounded hover:text-foreground transition-colors"
                  >
                    <GitFork className="w-3 h-3" />
                  </button>
                )}
                <button
                  type="button"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(session);
                  }}
                  className="p-0.5 rounded hover:text-destructive transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>

              {/* Timestamp or Active blue indicator */}
              {active ? (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-signal shrink-0 group-hover:hidden"
                  title="活动会话"
                />
              ) : time ? (
                <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums shrink-0 group-hover:hidden">
                  {time}
                </span>
              ) : null}
            </div>
          </motion.div>
        </ContextMenuTrigger>

        <ContextMenuContent ariaLabel={`会话 ${sessionTitle} 操作菜单`}>
          <ContextMenuLabel>会话操作</ContextMenuLabel>
          <ContextMenuItem onSelect={() => onOpen(session)}>
            <MessageSquare className="w-3.5 h-3.5 text-primary shrink-0" />
            <span>进入会话</span>
          </ContextMenuItem>
          {supportsFork && (
            <ContextMenuItem onSelect={() => onFork(session)}>
              <GitFork className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span>分叉新会话 (Fork)</span>
              <ContextMenuShortcut>Fork</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(sessionTitle);
            }}
          >
            <Copy className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span>复制会话标题</span>
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(session.sessionId);
            }}
          >
            <Terminal className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <span>复制会话 ID</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            tone="destructive"
            onSelect={() => onDelete(session)}
          >
            <Trash2 className="w-3.5 h-3.5 text-destructive shrink-0" />
            <span>删除此会话</span>
            <ContextMenuShortcut>Del</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }
);
SessionRow.displayName = "SessionRow";
