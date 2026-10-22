import React, { useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { setGatewayToken, verifyGatewayToken } from "@/lib/gateway-auth";

interface Props {
  /** 为什么出现令牌页：没有令牌 / 令牌被网关拒绝 / 读取令牌失败。 */
  reason: "missing" | "rejected" | "error";
  detail?: string;
  onAuthorized: () => void;
}

/**
 * 网关令牌页：浏览器模式下没有 / 令牌失效时显示。只拼装 shadcn 组件，不自带视觉样式。
 * Electron 正常情况下不会看到它（token 由主进程经 preload 直接给）。
 */
export function GatewayTokenGate({ reason, detail, onAuthorized }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    reason === "rejected" ? "当前保存的令牌被网关拒绝（可能网关换了新令牌），请重新输入。" : reason === "error" ? detail || "读取令牌失败" : null
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    setError(null);
    setGatewayToken(t);
    const state = await verifyGatewayToken();
    setBusy(false);
    if (state === "unauthorized") {
      setError("令牌不正确，网关返回 401。请确认复制的是完整的 64 位令牌。");
      return;
    }
    if (state === "unreachable") {
      setError("连不上网关（127.0.0.1:25015）。请先启动网关：bun run dev:server");
      return;
    }
    onAuthorized();
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="w-4 h-4 text-primary" /> 需要网关访问令牌
          </CardTitle>
          <CardDescription>
            AutumnFlow 的本地网关要求每个请求都带令牌，防止本机其他程序或网页冒用它执行命令。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
            <li>
              最简单：打开网关启动日志里 <span className="font-mono text-foreground">open the UI with:</span> 后面那条链接。
            </li>
            <li>
              或者把 <span className="font-mono text-foreground">~/.autumnflow/.gateway-token</span> 的内容粘贴到下面。
            </li>
          </ol>
          <form onSubmit={submit} className="flex gap-2">
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              placeholder="粘贴 64 位令牌"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="font-mono"
            />
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              连接
            </Button>
          </form>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
