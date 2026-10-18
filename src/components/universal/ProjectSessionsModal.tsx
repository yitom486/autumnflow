import React, { useState } from "react";
import {
  Search,
  Folder,
  Cloud,
  X,
} from "lucide-react";
import { SessionRow, type SessionItem } from "./SessionRow";

export interface ProjectSessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectName: string;
  isCloud?: boolean;
  sessions: SessionItem[];
  activeSessionId: string | null;
  supportsFork: boolean;
  onOpenSession: (s: SessionItem) => void;
  onForkSession: (s: SessionItem) => void;
  onDeleteSession: (s: SessionItem) => void;
}

export const ProjectSessionsModal: React.FC<ProjectSessionsModalProps> = ({
  isOpen,
  onClose,
  projectName,
  isCloud,
  sessions,
  activeSessionId,
  supportsFork,
  onOpenSession,
  onForkSession,
  onDeleteSession,
}) => {
  const [filter, setFilter] = useState("");

  if (!isOpen) return null;

  const query = filter.trim().toLowerCase();
  const filtered = query
    ? sessions.filter((s) => `${s.title || ""} ${s.sessionId}`.toLowerCase().includes(query))
    : sessions;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-xs p-4 animate-in fade-in duration-150 select-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden max-h-[80vh] animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {isCloud ? (
              <Cloud className="w-4 h-4 text-muted-foreground shrink-0" />
            ) : (
              <Folder className="w-4 h-4 text-primary shrink-0" />
            )}
            <h3 className="font-semibold text-sm text-foreground truncate">{projectName}</h3>
            <span className="text-[11px] font-mono text-muted-foreground/80 px-1.5 py-0.5 rounded bg-muted">
              {sessions.length} 个会话
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filter input */}
        <div className="px-4 py-2.5 border-b border-border/40 shrink-0">
          <div className="relative flex items-center">
            <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2.5 pointer-events-none" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜索此项目下的所有会话..."
              autoFocus
              className="w-full bg-muted/40 border border-border/60 rounded-md pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/60"
            />
          </div>
        </div>

        {/* Sessions list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-muted-foreground">未找到匹配会话</div>
          ) : (
            filtered.map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                active={s.sessionId === activeSessionId}
                supportsFork={supportsFork}
                onOpen={(sess) => {
                  onOpenSession(sess);
                  onClose();
                }}
                onFork={onForkSession}
                onDelete={onDeleteSession}
              />
            ))
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-4 py-2 border-t border-border/40 text-[11px] text-muted-foreground flex items-center justify-between shrink-0 bg-muted/20">
          <span>点击切换会话 · 支持实时搜索</span>
          <span className="font-mono text-[10px]">点击外部或 ✕ 关闭</span>
        </div>
      </div>
    </div>
  );
};
