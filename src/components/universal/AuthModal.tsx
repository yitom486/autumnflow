import React, { useEffect, useState } from "react";
import { X, ShieldCheck, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { AgentSummary } from "@/lib/universal-api";
import { authenticateAgent } from "@/lib/universal-api";
import { useStudioStore } from "@/stores/useStudioStore";
import { AcpAuthTerminal } from "./AcpAuthTerminal";
import { ElicitationCard, type ElicitationCardProps } from "./ElicitationCard";

export interface UniversalAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  agent: AgentSummary | undefined;
  onAuthenticated: () => void;
  onLogout: () => void;
  /** Local-auth probe result from App (session/list without authenticate). */
  authOk?: boolean | null;
  onElicitationRespond?: ElicitationCardProps["onRespond"];
}

export const UniversalAuthModal: React.FC<UniversalAuthModalProps> = ({ isOpen, onClose, agent, onAuthenticated, onLogout, authOk, onElicitationRespond }) => {
  const [methodId, setMethodId] = useState("");
  const [terminal, setTerminal] = useState<{ ptyId: string; cwd: string } | null>(null);
  const pending = useStudioStore(state => state.pendingElic);
  const respondingId = useStudioStore(state => state.respondingId);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (!isOpen) setTerminal(null); }, [isOpen]);

  if (!isOpen) return null;
  const methods = agent?.status?.authMethods || [];
  const activeMethod = methodId || methods[0]?.id || "";

  const runAuth = async () => {
    if (!agent || !activeMethod) {
      setMsg("该 Agent 未广播 authMethods，无需认证或暂不支持。");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const result = await authenticateAgent(agent.id, activeMethod);
      if (result?.terminal) { setTerminal(result.terminal); return; }
      setMsg("认证成功，可以开始会话。");
      onAuthenticated();
    } catch (e: any) {
      setMsg("认证失败: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80">
      <div role="dialog" aria-modal="true" aria-label="智能体认证" className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card p-6 text-foreground space-y-4">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-success" />
            <div>
              <h2 className="font-bold">认证 · {agent?.title || agent?.id}</h2>
              <p className="text-xs text-muted-foreground font-mono">{agent?.command} {(agent?.args || []).join(" ")}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted">
            <X className="w-5 h-5" />
          </button>
        </div>

        {authOk === true && (
          <div className="p-3 rounded-xl bg-success/10 border border-success/30 text-xs text-success">
            本地登录态复用成功：该 Agent 可直接创建会话，无需再走 authenticate（如 codex 会自动读取你本地 ~/.codex/auth.json）。
          </div>
        )}
        {agent?.authHint && (
          <div className="p-3 rounded-xl bg-background border border-border text-xs text-muted-foreground">
            壳原则 · {agent.authHint}
          </div>
        )}
        {authOk === false && (
          <div className="p-3 rounded-xl bg-warning/30 border border-warning/30 text-xs text-warning">
            本地暂无可用登录态（探测 session/list 返回需认证），请在下方选择一种方式完成 authenticate。
          </div>
        )}

        {methods.length === 0 ? (
          <p className="text-xs text-muted-foreground">该 Agent 未声明 authMethods（initialize.authMethods 为空），通常可直接创建会话。若实际遇到 auth_required，请在 Agent 文档中确认登录方式（如 codex 需先 `codex login` 或配置 OPENAI_API_KEY 后重连）。</p>
        ) : (
          <div className="space-y-2">
            {methods.map((m) => (
              <label key={m.id} className={`flex gap-2 p-2.5 rounded-xl border cursor-pointer text-xs ${activeMethod === m.id ? "border-primary bg-muted/40" : "border-border"}`}>
                <input type="radio" name="authm" checked={activeMethod === m.id} onChange={() => setMethodId(m.id)} />
                <div>
                  <div className="font-semibold text-foreground">{m.name || m.id} <span className="font-mono text-muted-foreground">{m.id}</span></div>
                  {m.description && <div className="text-muted-foreground">{m.description}</div>}
                  {"type" in m && <Badge variant="outline" className="mt-1 text-[10px] font-mono">{m.type === "terminal" ? "终端登录" : m.type}</Badge>}
                </div>
              </label>
            ))}
          </div>
        )}

        {terminal && agent && <AcpAuthTerminal key={terminal.ptyId} agentId={agent.id} {...terminal}
          onComplete={() => { setTerminal(null); setMsg("认证完成，已重新连接智能体。"); onAuthenticated(); }}
          onError={message => { setTerminal(null); setMsg(message); }} />}
        {onElicitationRespond && pending.filter(item => item.agentId === agent?.id).map(item => <ElicitationCard key={item.elicitationId} e={item} onRespond={onElicitationRespond} busy={respondingId === item.elicitationId} />)}

        {msg && <div className="text-xs p-2.5 rounded-xl bg-background border border-border text-muted-foreground">{msg}</div>}

        <div className="flex justify-between pt-2 border-t border-border">
          <Button size="sm" variant="outline" onClick={onLogout} disabled={!agent?.status.agentCapabilities?.auth?.logout || busy || !!terminal} className="text-xs gap-1.5">
            <LogOut className="w-3.5 h-3.5" /> logout
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={onClose} className="text-xs">关闭</Button>
            <Button size="sm" variant="default" onClick={runAuth} disabled={busy || !!terminal || !activeMethod} className="text-xs gap-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} /> {busy ? "认证中..." : "authenticate"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
