import React from "react";
import { List, PlusCircle, Trash2, XCircle, Gauge, Command, Settings2, GitFork, Cpu, FileDiff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { SessionInfo } from "@/stores/useStudioStore";

export interface SessionControlsProps {
  sessionId: string | null;
  modes: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string; description?: string }> } | null;
  configOptions: Array<{ id: string; name: string; description?: string; type: string; currentValue?: unknown; options?: Array<{ value: string; name?: string }> }> | null;
  availableCommands: Array<{ name: string; description?: string }>;
  usage: { used: number; size: number; cost?: { amount: number; currency: string } } | null;
  sessionInfo: SessionInfo | null;
  capabilities: Record<string, any> | null | undefined;
  onNewSession: () => void;
  onCloseSession: () => void;
  onDeleteSession: () => void;
  onListSessions: () => void;
  onSetMode: (modeId: string) => void;
  onSetConfig: (configId: string, value: unknown) => void;
  onInsertCommand: (name: string) => void;
  onForkSession: () => void;
  onOpenProviders: () => void;
  onOpenChanges: () => void;
  hasChangesCwd: boolean;
  supportsFork: boolean;
  supportsProviders: boolean;
  busy: boolean;
}

export const SessionControls: React.FC<SessionControlsProps> = (p) => {
  return (
    <div className="px-4 py-2 border-b border-border/70 bg-background/50 text-xs space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className="font-mono text-[10px]">session: {p.sessionId ? p.sessionId.slice(0, 18) + (p.sessionId.length > 18 ? "…" : "") : "(new on send)"}</Badge>
        {p.sessionInfo?.title && <span className="text-muted-foreground truncate max-w-[240px]">{p.sessionInfo.title}</span>}
        {p.usage && (
          <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
            <Gauge className="w-3 h-3 text-primary" />
            {p.usage.used.toLocaleString()}/{p.usage.size.toLocaleString()}
            {p.usage.cost && <span className="text-success">${p.usage.cost.amount} {p.usage.cost.currency}</span>}
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => p.onNewSession()} disabled={p.busy} className="h-6 text-[11px] gap-1"><PlusCircle className="w-3 h-3" />new</Button>
        {p.supportsFork && (
          <Button size="sm" variant="outline" onClick={p.onForkSession} disabled={p.busy || !p.sessionId} title="Fork 当前会话" className="h-6 text-[11px] gap-1"><GitFork className="w-3 h-3" />fork</Button>
        )}
        {p.supportsProviders && (
          <Button size="sm" variant="outline" onClick={p.onOpenProviders} disabled={p.busy} title="Providers（模型通道）" className="h-6 text-[11px] gap-1"><Cpu className="w-3 h-3" />providers</Button>
        )}
        <Button size="sm" variant="outline" onClick={p.onOpenChanges} disabled={p.busy || !p.hasChangesCwd} title="查看工作区代码变更（git diff）" className="h-6 text-[11px] gap-1"><FileDiff className="w-3 h-3" />变更</Button>
        <Button size="sm" variant="outline" onClick={p.onListSessions} disabled={p.busy} className="h-6 text-[11px] gap-1"><List className="w-3 h-3" />list</Button>
        <Button size="sm" variant="outline" onClick={p.onCloseSession} disabled={p.busy || !p.sessionId} className="h-6 text-[11px] gap-1"><XCircle className="w-3 h-3" />close</Button>
        <Button size="sm" variant="outline" onClick={p.onDeleteSession} disabled={p.busy || !p.sessionId} className="h-6 text-[11px] gap-1 text-destructive"><Trash2 className="w-3 h-3" />delete</Button>
      </div>

      {((p.modes?.availableModes?.length || 0) > 0 || (p.configOptions?.length || 0) > 0 || (p.availableCommands?.length || 0) > 0) && (
        <div className="flex items-start gap-4 flex-wrap">
          {p.modes?.availableModes && p.modes.availableModes.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">mode:</span>
              <select
                value={p.modes.currentModeId || ""}
                onChange={(e) => e.target.value && p.onSetMode(e.target.value)}
                className="bg-card border border-border rounded-lg px-1.5 py-1 text-[11px] outline-none"
              >
                {p.modes.availableModes.map((m) => (
                  <option key={m.id} value={m.id} className="bg-card">{m.name || m.id}</option>
                ))}
              </select>
            </div>
          )}
          {p.configOptions && p.configOptions.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <Settings2 className="w-3 h-3 text-muted-foreground" />
              {p.configOptions.map((c) => (
                <label key={c.id} className="flex items-center gap-1 text-muted-foreground">
                  <span title={c.description}>{c.name || c.id}</span>
                  {c.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(c.currentValue)}
                      onChange={(e) => p.onSetConfig(c.id, e.target.checked)}
                    />
                  ) : (
                    <select
                      value={String(
                        Array.isArray(c.currentValue)
                          ? JSON.stringify(c.currentValue)
                          : (c.currentValue as any)?.value ?? (c.currentValue as any) ?? ""
                      )}
                      onChange={(e) => p.onSetConfig(c.id, e.target.value)}
                      className="bg-card border border-border rounded px-1 py-0.5 text-[11px] max-w-[160px]"
                    >
                      {(c.options || []).map((o: any) =>
                        o && Array.isArray(o.options) ? (
                          <optgroup key={o.group || o.name} label={o.name || o.group}>
                            {o.options.map((sub: any) => (
                              <option key={String(sub.value)} value={String(sub.value)} className="bg-card" title={sub.description}>
                                {sub.name || sub.value}
                              </option>
                            ))}
                          </optgroup>
                        ) : (
                          <option key={String(o.value ?? o)} value={String(o.value ?? o)} className="bg-card" title={o.description}>
                            {o.name || o.value}
                          </option>
                        )
                      )}
                    </select>
                  )}
                </label>
              ))}
            </div>
          )}
          {p.availableCommands.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <Command className="w-3 h-3 text-muted-foreground" />
              {p.availableCommands.slice(0, 12).map((c) => (
                <button
                  key={c.name}
                  onClick={() => p.onInsertCommand(c.name.startsWith("/") ? c.name : `/${c.name}`)}
                  title={c.description}
                  className="px-1.5 py-0.5 rounded border border-border text-[11px] font-mono text-muted-foreground hover:border-primary hover:text-primary"
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
