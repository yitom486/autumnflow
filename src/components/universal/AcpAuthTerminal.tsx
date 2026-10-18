import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { apiFetch, getGatewayBase, withTokenQuery } from "@/lib/gateway-auth";
import { buildPtyWsUrl, ptyWsCandidateBases, ptyResize } from "@/lib/universal-api";

export function AcpAuthTerminal({ agentId, ptyId, cwd, onComplete, onError }: {
  agentId: string; ptyId: string; cwd: string; onComplete: () => void; onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onComplete, onError }); callbacks.current = { onComplete, onError };
  useEffect(() => {
    const term = new Terminal({ cols: 80, rows: 18, fontSize: 13, cursorBlink: true });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current!); fit.fit(); term.focus();
    let socket: WebSocket | undefined, disposed = false, completed = false;
    const endpoint = `/api/universal/agents/${encodeURIComponent(agentId)}/authenticate/terminal/${encodeURIComponent(ptyId)}`;
    const candidates = ptyWsCandidateBases(window.location.host, window.location.protocol, 13005, getGatewayBase());
    const connect = (index: number) => {
      if (disposed) return;
      if (index >= candidates.length) { callbacks.current.onError("无法连接认证终端"); return; }
      let opened = false;
      const ws = new WebSocket(withTokenQuery(buildPtyWsUrl(candidates[index], ptyId, cwd, term.cols, term.rows)));
      socket = ws;
      ws.onopen = () => { opened = true; };
      ws.onmessage = event => term.write(String(event.data));
      ws.onclose = async () => {
        if (disposed) return;
        if (!opened) { connect(index + 1); return; }
        try {
          const response = await apiFetch(`${endpoint}/finish`, { method: "POST" });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || "认证进程未成功完成");
          completed = true;
          if (!disposed) callbacks.current.onComplete();
        } catch (error) { if (!disposed) callbacks.current.onError(error instanceof Error ? error.message : "认证失败"); }
      };
      ws.onerror = () => {}; // Connection failures are handled once in onclose.
    };
    connect(0);
    const input = term.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(data); });
    const resize = new ResizeObserver(() => { fit.fit(); void ptyResize(ptyId, term.cols, term.rows).catch(() => {}); });
    resize.observe(host.current!);
    return () => {
      disposed = true; input.dispose(); resize.disconnect(); socket?.close(); term.dispose();
      if (!completed) void apiFetch(endpoint, { method: "DELETE" }).catch(() => {});
    };
  }, [agentId, ptyId, cwd]);
  return <div ref={host} role="region" aria-label="交互式认证终端" className="h-64 overflow-hidden rounded-lg border border-border bg-background p-2" />;
}
