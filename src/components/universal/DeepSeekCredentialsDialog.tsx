import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, KeyRound, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  getAgentCredentials,
  reconnectAgent,
  saveAgentApiKey,
  type AgentCredentialState,
} from "@/lib/universal-api";

export interface DeepSeekCredentialsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  agentId: string;
  /** 保存或重连后通知外部刷新智能体状态 / 配额。 */
  onChanged?: () => void;
}

/**
 * DeepSeek 凭据面板。
 *
 * DSH 的 ACP 面没有 authMethods，客户端无法走 ACP 认证；密钥属于 harness 的
 * 配置。这里补两条可操作路径：切到已登录的 DeepSeek Account 模型分组，或把
 * `DEEPSEEK_API_KEY` 写进 DSH 的 user-env（`$DSH_HOME/.env`）后重连。
 */
export const DeepSeekCredentialsDialog: React.FC<DeepSeekCredentialsDialogProps> = ({
  isOpen,
  onClose,
  agentId,
  onChanged,
}) => {
  const [state, setState] = useState<AgentCredentialState | null>(null);
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await getAgentCredentials(agentId));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!isOpen) return;
    setApiKey("");
    setMsg(null);
    setError(null);
    void load();
  }, [isOpen, load]);

  if (!isOpen) return null;

  const save = async () => {
    if (!apiKey.trim()) {
      setError("请先粘贴 API Key");
      return;
    }
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const next = await saveAgentApiKey(agentId, apiKey);
      setState(next);
      setApiKey("");
      setMsg("已保存到 DSH 的 user-env 文件；点「重连」后生效。");
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const reconnect = async () => {
    setReconnecting(true);
    setError(null);
    setMsg(null);
    try {
      await reconnectAgent(agentId);
      setMsg("已重连，新的凭据已生效。");
      onChanged?.();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setReconnecting(false);
    }
  };

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText("dsh --profile web");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制失败，请手动输入命令");
    }
  };

  const sourceText = !state
    ? "读取中…"
    : state.source === "env"
      ? "已配置（进程环境变量）"
      : state.source === "file"
        ? "已配置（DSH user-env 文件）"
        : "未配置";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="DeepSeek 凭据"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card p-6 text-foreground space-y-4"
      >
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-primary" />
            <div>
              <h2 className="font-bold">DeepSeek 凭据</h2>
              <p className="text-xs text-muted-foreground">
                当前模型走 <code className="font-mono">deepseek-official</code>（API Key 路由），需要 <code className="font-mono">DEEPSEEK_API_KEY</code>。
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted" aria-label="关闭">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
          <span className="text-muted-foreground">本地状态</span>
          <span className="font-medium">
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : sourceText}
          </span>
        </div>
        {state?.path && (
          <p className="text-[11px] text-muted-foreground font-mono break-all">{state.path}</p>
        )}

        <div className="rounded-lg border border-border/60 p-3 space-y-1.5 text-xs">
          <p className="font-medium">方案 A · 用你已登录的平台账户（不改配置）</p>
          <p className="text-muted-foreground">
            输入框左下角模型菜单 → 展开 <strong className="text-foreground">DeepSeek Account</strong> 分组 → 选同名模型。
            这条路由用 harness 的网页登录，不需要 API Key。
          </p>
        </div>

        <div className="rounded-lg border border-border/60 p-3 space-y-2 text-xs">
          <p className="font-medium">方案 B · 保存 API Key</p>
          <div className="flex items-center gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-..."
              spellCheck={false}
              autoComplete="off"
              aria-label="DeepSeek API Key"
              className="flex-1 h-8 rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Button size="sm" variant="ghost" className="h-8 px-2 text-[11px]" onClick={() => setShowKey((v) => !v)}>
              {showKey ? "隐藏" : "显示"}
            </Button>
            <Button size="sm" className="h-8 px-3 text-xs" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "保存"}
            </Button>
          </div>
          <p className="text-muted-foreground">
            写入 DSH 的 user-env 文件（与 harness 官方支持的启动环境层一致，不碰它自己的凭据仓库）；
            托管凭据仓库里若已有同名引用，仍以那边为准。
          </p>
        </div>

        <div className="rounded-lg border border-border/60 p-3 space-y-1.5 text-xs">
          <p className="font-medium">方案 C · 在 DSH 自己的设置里配置</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted/40 px-2 py-1 font-mono text-[11px]">dsh --profile web</code>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] gap-1" onClick={copyCommand}>
              {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
          <p className="text-muted-foreground">浏览器里打开 设置 → 模型 → 保存 API Key，回到 AutumnFlow 重连即可。</p>
        </div>

        {(msg || error) && (
          <div className={`rounded-lg px-3 py-2 text-xs ${error ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-500"}`}>
            {error || msg}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={reconnect} disabled={reconnecting}>
            <RefreshCw className={`w-3 h-3 ${reconnecting ? "animate-spin" : ""}`} />
            保存后重连生效
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onClose}>
            关闭
          </Button>
        </div>
      </div>
    </div>
  );
};
