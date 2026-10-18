import React from "react";
import { useQuery } from "@tanstack/react-query";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { useStudioStore } from "@/stores/useStudioStore";
import { fetchTerminalOutput } from "@/lib/universal-api";
import { AcpContentBlocks } from "./AcpSessionArtifacts";

function TerminalContent({ terminalId }: { terminalId: string }) {
  const agentId = useStudioStore(s => s.activeAgentId);
  const sessionId = useStudioStore(s => s.sessionId);
  const result = useQuery({ queryKey: ["acp-terminal", agentId, sessionId, terminalId],
    queryFn: () => fetchTerminalOutput(agentId, { sessionId: sessionId!, terminalId }), enabled: !!sessionId,
    retry: false, refetchInterval: query => query.state.error || query.state.data?.exitStatus ? false : 1000 });
  return <div className="rounded-md border border-border bg-muted/30 p-2 space-y-1">
    <p className="text-xs text-muted-foreground">终端输出{result.data?.exitStatus && ` · 退出码 ${result.data.exitStatus.exitCode ?? "—"}`}</p>
    {result.isPending ? <p role="status" className="text-xs">正在读取…</p> : result.error ? <p className="text-xs text-muted-foreground">终端已释放或暂不可用</p>
      : <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs select-text">{result.data?.output}{result.data?.truncated ? "\n…输出已截断" : ""}</pre>}
  </div>;
}

export function AcpToolContents({ content }: { content?: ToolCallContent[] }) {
  return <div className="space-y-2">{content?.map((part, index) => {
    switch (part.type) {
      case "content": return <AcpContentBlocks key={index} blocks={[part.content]} />;
      case "terminal": return <TerminalContent key={index} terminalId={part.terminalId} />;
      case "diff": return <details key={index} open className="rounded-md border border-border p-2 text-xs"><summary className="cursor-pointer break-all font-medium">{part.path}</summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2"><div><p className="text-muted-foreground">修改前</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words select-text">{part.oldText ?? "（新建文件）"}</pre></div>
          <div><p className="text-muted-foreground">修改后</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words select-text">{part.newText}</pre></div></div></details>;
    }
  })}</div>;
}
