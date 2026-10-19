import React from "react";
import ApprovalCard, { type ApprovalOptionItem, type ApprovalQuestion } from "@/components/primitives/ApprovalCard";
import type { PendingPermission } from "@/lib/universal-api";

export interface PermissionDialogProps {
  pending: PendingPermission[];
  onRespond: (p: PendingPermission, optionId: string | null) => void;
  respondingId: string | null;
  className?: string;
}

export const PermissionDialog: React.FC<PermissionDialogProps> = ({ pending, onRespond, respondingId, className }) => {
  if (pending.length === 0) return null;
  return (
    <div className={`space-y-2.5 ${className || ""}`}>
      {pending.map((p) => (
        <PermissionCard key={p.permissionId} p={p} onRespond={onRespond} busy={respondingId === p.permissionId} />
      ))}
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

function PermissionCard({
  p,
  onRespond,
  busy,
}: {
  p: PendingPermission;
  onRespond: PermissionDialogProps["onRespond"];
  busy: boolean;
}) {
  const tool = p.toolCall as any;
  const toolTitle = tool?.title || tool?.toolCallId || p.permissionId;
  const kind = tool?.kind ? `[${tool.kind}] ` : "";

  // Extract relevant tool details for user context (command, file path, etc.)
  const toolDetail =
    tool?.command ||
    (tool?.rawInput?.command ? String(tool.rawInput.command) : "") ||
    tool?.path ||
    (tool?.rawInput?.path ? String(tool.rawInput.path) : "") ||
    tool?.description ||
    "";

  const options: ApprovalOptionItem[] = (p.options && p.options.length > 0)
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
        onDismiss={() => {
          onRespond(p, null);
        }}
        className="w-full max-w-full"
      />
    </fieldset>
  );
}

