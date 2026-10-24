import React, { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import ReactMarkdown from "react-markdown";
import { sessionRpc, buildTranscriptFromReplay } from "@/lib/universal-api";
import { normalizeSessions, invalidateSessions } from "@/lib/acp-queries";
import type { SessionItem } from "./SessionRow";

/** Shared shell of the history dialogs: the project's Dialog, open while mounted. */
function HistoryDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[80vh] gap-0 overflow-hidden border-border bg-card p-0 sm:max-w-[720px]">
      <DialogHeader className="border-b border-border px-4 py-3 pr-12">
        <DialogTitle className="truncate text-sm">{title}</DialogTitle>
      </DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}

export function ExternalHistoryDialog({ agentId, onClose, onOpen }: {
  agentId: string; onClose: () => void; onOpen: (session: SessionItem) => void;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [filter, setFilter] = useState("");
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["universal", "external-history", agentId, cursor],
    queryFn: () => sessionRpc(agentId, "list", cursor ? { cursor } : {}), retry: false });
  const sessions = normalizeSessions(query.data).filter(row => row.kind !== "subagent" &&
    (row.title || row.sessionId).toLowerCase().includes(filter.toLowerCase()));
  return <HistoryDialog title="导入外部历史" onClose={onClose}>
    <div className="space-y-3 p-4 text-sm">
      <p className="text-xs text-muted-foreground">仅添加会话引用。原始对话仍由对应 Agent 保存。</p>
      <Input aria-label="筛选本页历史" placeholder="筛选本页标题或 ID" value={filter} onChange={e => setFilter(e.target.value)} />
      {(error || query.error) && <p role="alert" className="text-destructive">{error || query.error?.message}</p>}
      <div className="max-h-[45vh] space-y-1 overflow-y-auto">
        {query.isPending ? <p className="text-muted-foreground">正在读取历史…</p> : sessions.length === 0 ? <p className="text-muted-foreground">本页没有匹配的主会话</p> : sessions.map(row =>
          <button key={row.sessionId} type="button" disabled={!!importing || !!row.origin}
            className="flex w-full min-w-0 items-center gap-3 rounded-md p-2 text-left hover:bg-muted disabled:opacity-50"
            onClick={async () => {
              setImporting(row.sessionId); setError("");
              try {
                await sessionRpc(agentId, "import", { sessionId: row.sessionId, title: row.title, cwd: row.cwd });
                invalidateSessions(qc, agentId); onOpen(row); onClose();
              } catch (error) { setError((error as Error).message); }
              finally { setImporting(null); }
            }}>
            <span className="min-w-0 flex-1"><span className="block truncate">{row.title || "未命名会话"}</span><span className="block truncate text-xs text-muted-foreground">{row.cwd}</span></span>
            <span className="shrink-0 text-xs text-muted-foreground">{row.origin ? "已添加" : importing === row.sessionId ? "正在添加…" : "导入"}</span>
          </button>)}
      </div>
      <div className="flex justify-between text-xs">
        <Button variant="ghost" size="sm" disabled={!cursor || query.isFetching} onClick={() => setCursor(undefined)}>返回首页</Button>
        <Button variant="ghost" size="sm" disabled={!query.data?.nextCursor || query.isFetching} onClick={() => setCursor(query.data.nextCursor)}>下一页</Button>
      </div>
    </div>
  </HistoryDialog>;
}

export function SubagentMenu({ agentId, sessionId }: { agentId: string; sessionId: string | null }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<SessionItem | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const query = useQuery({ queryKey: ["universal", "children", agentId, sessionId],
    queryFn: () => sessionRpc(agentId, "children", { sessionId }).then(normalizeSessions),
    enabled: !!sessionId, refetchInterval: 2000 });
  useEffect(() => { setSelected(null); setOpen(false); }, [agentId, sessionId]);
  useEffect(() => {
    if (!open) return;
    const click = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  const children = query.data || [];
  if (!sessionId || !children.length) return null;
  return <div ref={ref} className="relative shrink-0">
    <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(value => !value)}
      title="查看子智能体会话" className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
      <GitBranch className="size-3.5" /><span>子任务 {children.length}</span><ChevronDown className="size-3" />
    </button>
    {open && <div className="absolute right-0 top-full z-50 mt-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
      {children.map(child => <button key={child.sessionId} type="button" onClick={() => { setSelected(child); setOpen(false); }}
        className="block w-full truncate rounded p-2 text-left text-xs hover:bg-muted" title={child.sessionId}>{child.title || "子会话"}</button>)}
    </div>}
    {selected && <SubagentViewer key={`${agentId}:${selected.sessionId}`} agentId={agentId} child={selected} onClose={() => setSelected(null)} />}
  </div>;
}

function SubagentViewer({ agentId, child, onClose }: { agentId: string; child: SessionItem; onClose: () => void }) {
  const query = useQuery({ queryKey: ["universal", "child-history", agentId, child.sessionId],
    queryFn: () => sessionRpc(agentId, "view-child", { sessionId: child.sessionId }),
    retry: false, refetchInterval: query => query.state.data?.source === "live" ? 3000 : false });
  const transcript = buildTranscriptFromReplay(query.data?.replayed || []);
  return <HistoryDialog title={child.title || "子智能体会话"} onClose={onClose}>
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-xs">
      <Button variant="ghost" size="sm" onClick={onClose}><ArrowLeft />返回主会话</Button>
      <span className="text-muted-foreground">只读 · {query.data?.source === "live" ? "近期运行记录" : "Agent 历史回放"}</span>
    </div>
    <div className="max-h-[60vh] space-y-4 overflow-y-auto p-4 text-sm">
      {query.isPending && <p className="text-muted-foreground">正在读取子会话…</p>}
      {query.error && <p role="alert" className="text-destructive">{query.error.message}</p>}
      {!query.isPending && !query.error && !transcript.messages.length && <p className="text-muted-foreground">该子会话暂未提供可显示的记录。</p>}
      {transcript.messages.map((message, i) => <article key={i} className="space-y-2 break-words">
        <p className="text-xs text-muted-foreground">{message.role === "user" ? "任务输入" : "子智能体"}</p>
        {message.content && <div className="acp-md"><ReactMarkdown>{message.content}</ReactMarkdown></div>}
        {message.thought && <details className="text-xs text-muted-foreground"><summary>思考记录</summary><p className="whitespace-pre-wrap">{message.thought}</p></details>}
        {message.toolCalls?.map(tool => <p key={tool.id} className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{tool.title} · {tool.status}</p>)}
      </article>)}
    </div>
  </HistoryDialog>;
}
