import React from "react";
import { ShieldAlert } from "lucide-react";
import ApprovalCard, { type ApprovalOptionItem, type ApprovalQuestion } from "@/components/primitives/ApprovalCard";
import { ElicitationCard } from "@/components/universal/ElicitationCard";
import type { PendingElicitation, PendingPermission } from "@/lib/universal-api";
import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";

export interface InteractionPanelProps {
  permissions: PendingPermission[];
  elicitations: PendingElicitation[];
  onRespondPermission: (p: PendingPermission, optionId: string | null) => void;
  onRespondElicitation: (e: PendingElicitation, result: CreateElicitationResponse) => void;
  respondingId: string | null;
}

/**
 * 权限与提问的独立弹窗。
 *
 * 这两类请求会阻塞当前这一轮，所以它们必须从工具列表里独立出来、明确地弹到
 * 台面上，而不是藏在某张卡片里。
 *
 * 浮层是项目自己的（非模态）：输入框仍然可用，用户可以直接输入一条新消息来
 * 结束这次等待（等同于拒绝当前请求并继续）。内嵌的卡片带自己的 `<form>` 与
 * 折叠菜单，放进 Radix 的 Dialog 门户会吞掉交互，因此这里沿用项目既有的浮层
 * 写法（与凭据弹窗一致）。
 */
export const InteractionPanel: React.FC<InteractionPanelProps> = ({
  permissions,
  elicitations,
  onRespondPermission,
  onRespondElicitation,
  respondingId,
}) => {
  if (permissions.length === 0 && elicitations.length === 0) return null;

  return (
    <div
      role="dialog"
      aria-label="等待你的选择"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/70 p-4 pt-[12vh] backdrop-blur-[2px]"
    >
      <div className="w-full max-w-[min(620px,calc(100vw-32px))] space-y-3 rounded-2xl border border-border bg-card p-5 text-foreground shadow-2xl">
        <div className="flex items-start gap-2 border-b border-border pb-3">
          <ShieldAlert className="mt-0.5 w-5 h-5 shrink-0 text-warning" />
          <div>
            <h2 className="text-sm font-bold">智能体正在等待你的选择</h2>
            <p className="text-xs text-muted-foreground">
              这一轮在等你：选择一项、拒绝，或者直接在输入框里发一条新消息来继续。
            </p>
          </div>
        </div>

        {permissions.map((p) => (
          <PermissionPrompt
            key={p.permissionId}
            p={p}
            busy={respondingId === p.permissionId}
            onRespond={onRespondPermission}
          />
        ))}
        {elicitations.map((e) => (
          <ElicitationCard
            key={e.elicitationId}
            e={e}
            busy={respondingId === e.elicitationId}
            onRespond={(item, result) => onRespondElicitation(item, result)}
          />
        ))}
      </div>
    </div>
  );
};

function getOptionDescription(kind?: string): string | undefined {
  switch (kind) {
    case "allow_once":
      return "仅授权当前一次调用执行";
    case "allow_always":
      return "在当前会话中对此类操作始终放行，不再询问";
    case "reject_once":
      return "拒绝当前执行请求";
    case "reject_always":
      return "在当前会话中对此类操作永久拒绝并拦截";
    default:
      return undefined;
  }
}

function PermissionPrompt({
  p,
  onRespond,
  busy,
}: {
  p: PendingPermission;
  onRespond: InteractionPanelProps["onRespondPermission"];
  busy: boolean;
}) {
  const tool = p.toolCall as any;
  const toolTitle = tool?.title || tool?.toolCallId || p.permissionId;
  const kind = tool?.kind ? `[${tool.kind}] ` : "";
  const toolDetail =
    tool?.command ||
    (tool?.rawInput?.command ? String(tool.rawInput.command) : "") ||
    tool?.path ||
    (tool?.rawInput?.path ? String(tool.rawInput.path) : "") ||
    tool?.description ||
    "";

  const options: ApprovalOptionItem[] = p.options && p.options.length > 0
    ? p.options.map((o) => ({
        label: o.name || o.optionId,
        description: getOptionDescription(o.kind),
        value: o.optionId,
      }))
    : [
        { label: "允许执行", description: "仅允许当前操作一次", value: "allow_once" },
        { label: "拒绝执行", description: "取消此操作", value: "reject_once" },
      ];

  const question: ApprovalQuestion = {
    q: `【安全授权】执行 ${kind}${toolTitle}`,
    description: toolDetail ? String(toolDetail).slice(0, 160) : undefined,
    type: "radio",
    options,
  };

  return (
    <fieldset disabled={busy} aria-busy={busy} className="min-w-0">
      <ApprovalCard
        externallyManaged
        questions={[question]}
        labels={{
          skip: "拒绝",
          continue: "授权执行",
          send: busy ? "提交中…" : "批准执行",
          customPlaceholder: "说明或参数补充（可选）…",
          sentMessage: "授权请求已处理",
        }}
        onSubmitted={(answers) => {
          const selectedIdx = answers[0]?.[0] ?? 0;
          const opt = options[selectedIdx];
          const optionId = typeof opt === "string" ? opt : (opt?.value || p.options?.[selectedIdx]?.optionId || null);
          onRespond(p, optionId);
        }}
        onDismiss={() => onRespond(p, null)}
        className="w-full max-w-full"
      />
    </fieldset>
  );
}
