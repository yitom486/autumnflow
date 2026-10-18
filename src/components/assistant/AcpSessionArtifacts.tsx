import React, { useState } from "react";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { artifactKey, type SessionArtifact } from "../../../shared/acp-session-state";
import { AcpStandaloneMarkdown } from "./AcpMarkdown";
import { AcpImageView } from "./AcpMedia";
import { useStudioStore } from "@/stores/useStudioStore";
import { sessionRpc } from "@/lib/universal-api";
import { Button } from "@/components/atoms/Button";

function ResourceUri({ uri, title }: { uri: string; title?: string }) {
  const external = /^https?:\/\//i.test(uri);
  return external ? <a href={uri} target="_blank" rel="noopener noreferrer" className="text-primary underline break-all">{title || uri}</a>
    : <span className="break-all select-text">{title ? `${title} · ` : ""}{uri}</span>;
}

export function AcpContentBlocks({ blocks }: { blocks?: ContentBlock[] | null }) {
  return <div className="space-y-2">{(blocks ?? []).map((block, index) => {
    switch (block.type) {
      case "text": return <AcpStandaloneMarkdown key={index} content={block.text} />;
      case "image": return <AcpImageView key={index} src={`data:${block.mimeType};base64,${block.data}`} alt="智能体提供的图片" />;
      case "audio": return <div key={index} className="space-y-1"><p className="text-xs text-muted-foreground">音频</p><audio aria-label="智能体提供的音频" controls preload="none" src={`data:${block.mimeType};base64,${block.data}`} className="max-w-full" /></div>;
      case "resource_link": return <div key={index} className="rounded-md border border-border p-2"><ResourceUri uri={block.uri} title={block.title ?? block.name} />{block.description && <p className="text-xs text-muted-foreground whitespace-pre-wrap">{block.description}</p>}</div>;
      case "resource": return <div key={index} className="rounded-md border border-border p-2 space-y-2"><ResourceUri uri={block.resource.uri} />{"text" in block.resource
        ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs select-text">{block.resource.text}</pre>
        : <a href={`data:${block.resource.mimeType || "application/octet-stream"};base64,${block.resource.blob}`} download="resource" className="text-primary underline">下载二进制资源</a>}</div>;
    }
  })}</div>;
}

const compactionStatus = (status: string) => ({ in_progress: "正在整理上下文", completed: "上下文整理完成", failed: "上下文整理失败", cancelled: "上下文整理已取消" }[status] ?? status);

export function AcpSessionArtifacts({ entries }: { entries?: SessionArtifact[] }) {
  const agentId = useStudioStore(state => state.activeAgentId);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <div className="space-y-2">{entries?.map(entry => {
    let title: string;
    let content: React.ReactNode;
    switch (entry.kind) {
      case "plan": {
        const plan = entry.value;
        title = "执行计划";
        content = plan.type === "items" ? <ol className="space-y-1">{plan.entries.map((item, i) => <li key={i} className="flex items-start gap-2"><span aria-label={item.status} className="text-muted-foreground">{item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"}</span><span>{item.content}</span></li>)}</ol>
          : plan.type === "markdown" ? <AcpStandaloneMarkdown content={plan.content} /> : <ResourceUri uri={plan.uri} />;
        break;
      }
      case "compaction": title = compactionStatus(entry.value.status); content = <>{entry.value.error && <p role="alert" className="text-destructive whitespace-pre-wrap">{entry.value.error}</p>}<AcpContentBlocks blocks={entry.value.summary} /></>; break;
      case "message": title = "会话消息"; content = <><p className="text-xs text-muted-foreground break-all">{entry.value.senderSessionId ?? "发送方"} → {entry.value.recipientSessionId ?? "当前会话"}</p><AcpContentBlocks blocks={entry.value.content} /></>; break;
      case "subagent": title = entry.value.title || "子任务"; content = <><p className="whitespace-pre-wrap">{entry.value.description}</p>{entry.value.state && <p className="text-xs text-muted-foreground">{({ running: "执行中", idle: "已就绪", requires_action: "等待处理", unknown: "状态未确认" }[entry.value.state.state] ?? entry.value.state.state)}</p>}
        {entry.value.capabilities?.cancel != null && <Button size="xs" disabled={cancelling === entry.value.sessionId} onClick={async () => {
          const sessionId = entry.value.sessionId;
          setCancelling(sessionId); setError("");
          try { await sessionRpc(agentId, "cancel", { sessionId }); }
          catch (err) { setError(err instanceof Error ? err.message : "取消失败"); }
          finally { setCancelling(null); }
        }}>{cancelling === entry.value.sessionId ? "正在停止…" : "停止子任务"}</Button>}
        {error && <p role="alert" className="text-destructive text-xs">{error}</p>}</>; break;
    }
    return <details key={artifactKey(entry)} open className="rounded-lg border border-border p-3 text-sm"><summary className="cursor-pointer font-medium focus-visible:outline focus-visible:outline-primary">{title}</summary><div className="mt-2 space-y-2">{content}</div></details>;
  })}</div>;
}
