import { permissionInScope, elicitationInScope } from "@/lib/interaction-scope";
import React from "react";
import {
  ActionBarPrimitive,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDown,
  ArrowRight,
  CornerDownLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  History,
  Pencil,
  RefreshCw,
  Bot,
  User,
  Wrench,
  Info,
  SquareTerminal,
  Terminal,
  FileText,
  PencilLine,
  Search,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AcpMarkdownText, AcpStandaloneMarkdown } from "@/components/assistant/AcpMarkdown";
import { AcpContentBlocks, AcpSessionArtifacts } from "./AcpSessionArtifacts";
import { AcpToolContents } from "./AcpToolContents";
import { AcpImagePart } from "@/components/assistant/AcpMedia";
import { TurnChanges } from "@/components/assistant/TurnChanges";
import { TurnDiffViewer } from "@/components/assistant/TurnDiffViewer";
import {
  MessageAvatar,
  MessageBubble,
  MessageBubbleContent,
  MessageContent,
} from "@/components/agents/message";
import {
  DiffButton,
  FileEditCard,
  FileReadCard,
  LiveElapsed,
  SearchCard,
  StatusDot,
  TerminalCard,
  type WidgetTool,
} from "@/components/assistant/AcpToolWidgets";
import {
  isGenerativeTool,
  AcpGenerativeToolCard,
  studioGenerativeUIComponents,
  stripGenerativeToolPlaceholders,
  type GenerativeCardAction,
} from "@/components/assistant/toolkit";
import {
  extractFileFromTool,
  fmtElapsed,
  resolveToolDisplayTitle,
  resolveWidgetKey,
  toolPath,
  toolCommand,
  toolText,
  firstLines,
  strField,
  isToolActive,
} from "@/components/assistant/tool-widget-utils";
import type { Message } from "@/lib/message-types";
import { partitionTurnContent } from "@/lib/threads";
import type { UsageState } from "@/stores/useStudioStore";
import { activeKey, sessionOf, useStudioMessages, useStudioStore } from "@/stores/useStudioStore";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { cn } from "@/lib/utils";
import { MessageScroller } from "@/components/primitives/MessageScroller";
import { ActionSwap, MagneticButton } from "@/components/atoms/MotionButtons";
import { Citations, type CitationItem } from "@/components/primitives/Citations";
import { Loader } from "@/components/motion/loader";
import { AgentActivity, type AgentActivityItem } from "@/components/agents/agent-activity";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { ReasoningText } from "@/components/agents/loading-states/reasoning-text";
import { TextScramble } from "@/components/motion/text-scramble";
import { TextShimmer } from "@/components/motion/text-shimmer";
import { FolderDown } from "lucide-react";
import { ACP_PATH_MIME, decodeDragRefs, getActiveDragRefs } from "@/lib/composer-drop";
import { sendDropToComposer } from "@/lib/composer-bridge";

export interface AssistantChatViewProps {
  agentName?: string;
  onSelectSuggestion: (prompt: string) => void;
  onOpenDiff?: (filePath?: string | null) => void;
  /** 会话横幅：已连接但无活动会话时提示建会话/失败原因。 */
  connected?: boolean;
  sessionId?: string | null;
  sessionError?: string | null;
  sessionLoading?: boolean;
  onEnsureSession?: () => void;
  onNewSession?: () => void;
  /** 当前工作区（本轮改动面板定位文件状态用）。 */
  cwd?: string | null;
  /** 生成式卡片交互回传回调 */
  onGenerativeAction?: (action: GenerativeCardAction) => void | Promise<void>;
}

// ---------- part renderers (Text 由 AcpMarkdownText 直供 primitive) ----------

/** 智能体首 Token 到达前的思考/等待指示器 (beUI ReasoningText 驱动，平滑字符级梯级渐变与状态推进) */
const ThinkingStateCapsule: React.FC<{ startedAt?: number; statusHint?: string }> = ({ startedAt, statusHint }) => {
  const [elapsed, setElapsed] = React.useState(() =>
    startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 100) / 10) : 0
  );
  const hasPendingPermission = useStudioStore((s) => s.pendingPerms.some(p => permissionInScope(p, s.activeAgentId, s.sessionId)));
  const hasPendingElicitation = useStudioStore((s) => s.pendingElic.some(e => elicitationInScope(e, s.activeAgentId, s.sessionId)));

  React.useEffect(() => {
    if (hasPendingPermission || hasPendingElicitation) return;
    const start = startedAt || Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 100) / 10));
    }, 100);
    return () => clearInterval(timer);
  }, [startedAt, hasPendingPermission, hasPendingElicitation]);

  const timeStr = `(${elapsed.toFixed(1)}s)`;

  /**
   * 只显示后端真实事件给出的状态（onStateUpdate / onToolCall / onNotice / onActivity
   * 都会写入 statusHint）。不再轮播「正在规划执行策略 / 正在检索上下文」这类凭空
   * 捏造的阶段——用户看到的是智能体此刻实际在做的事，而不是一份固定的文案表。
   */
  const label = React.useMemo(() => {
    const hint = statusHint?.trim();
    if (!hint) return "正在思考";
    // ReasoningText 会自行补省略号，这里去掉已有的尾缀避免「……」叠加
    return hint.replace(/[…\.\s]+$/, "").slice(0, 48);
  }, [statusHint]);

  return (
    <div className="rounded-card border border-line bg-surface/90 px-3.5 py-1.5 shadow-card backdrop-blur-xs transition-all duration-300 w-fit max-w-md flex items-center gap-2.5 text-[12px] text-ink-2 font-medium select-none">
      {hasPendingPermission ? (
        <>
          <span className="size-2 rounded-full shrink-0 bg-amber-500 animate-ping" />
          <span className="text-amber-500 font-medium">等待用户确认授权…</span>
        </>
      ) : hasPendingElicitation ? (
        <>
          <span className="size-2 rounded-full shrink-0 bg-blue-500 animate-ping" />
          <span className="text-blue-500 font-medium">等待用户回应提问…</span>
        </>
      ) : (
        <ReasoningText
          variant="swap"
          text={label}
          shimmerDuration={2}
          indicator={
            <Loader variant="ascii-braille" size={13} className="text-primary font-bold shrink-0" />
          }
        />
      )}
      <span className="tabular-nums font-mono text-[10px] text-muted-foreground ml-auto pl-1">
        {timeStr}
      </span>
    </div>
  );
};

/**
 * 上下文用量面板：窗口占用 % + 进度条常显，点击展开本轮运行时明细。
 * 缓存命中率只有 agent 真下发 cachedTokens 时才出现，绝不编造。
 */
/**
 * 卡片 / 折叠区的展开状态记在会话里，不记在组件里：切走再切回来还是原样。
 * `id` 在会话内唯一（消息 id + 区块名）。
 */
function useSessionDisclosure(id: string): [boolean, (open: boolean) => void] {
  const open = useStudioStore((s) => sessionOf(s).ui.open[id] ?? false);
  const setOpen = React.useCallback(
    (next: boolean) => {
      const s = useStudioStore.getState();
      s.setUiOpen(activeKey(s), id, next);
    },
    [id]
  );
  return [open, setOpen];
}

const UsagePanel: React.FC<{ msg: Message }> = ({ msg }) => {
  const [open, setOpen] = useSessionDisclosure(`${msg.id}:usage`);
  const u = msg.usage as UsageState;
  const pct = u.size > 0 ? Math.min(1, u.used / u.size) : 0;
  const remain = Math.max(0, u.size - u.used);
  const bar = pct < 0.7 ? "bg-success" : pct < 0.9 ? "bg-warning" : "bg-destructive";
  const turnMs =
    msg.startedAt != null && msg.completedAt != null ? msg.completedAt - msg.startedAt : null;
  const thoughtMs =
    msg.thoughtTiming?.startedAt != null && msg.thoughtTiming.completedAt != null
      ? msg.thoughtTiming.completedAt - msg.thoughtTiming.startedAt
      : null;
  const doneTools = (msg.toolCalls || []).filter((t) => t.startedAt != null && t.completedAt != null);
  const toolMs = doneTools.reduce((a, t) => a + (t.completedAt! - t.startedAt!), 0);
  // 缓存命中率的分母是「提示词总量 = 新增输入 + 缓存命中」。
  // agent（agy-acp-map）已在 _meta.promptTokens / _meta.cacheHitRate 里给出规范口径，优先采用；
  // 缺失时才在本地折算：有 inputTokens 用 input+cached，否则退回 totalTokens。
  // 直接用 totalTokens 做分母在「缓存量 > 本轮输出」时会算出 1338.5% 这种数字。
  const cacheBase =
    u.promptTokens ??
    (u.inputTokens != null
      ? u.inputTokens + (u.cachedTokens ?? 0)
      : (u.totalTokens ?? u.used));
  const cacheRate =
    u.cacheHitRate ??
    (u.cachedTokens != null && cacheBase > 0 ? Math.min(1, u.cachedTokens / cacheBase) : null);
  const row = "flex items-center justify-between gap-2";
  return (
    <div className="rounded-lg bg-background/70 border border-border px-3 py-2">
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left">
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <span>
            {u.size > 0 ? `context ${u.used.toLocaleString()}/${u.size.toLocaleString()}` : "上下文占用：agent 未提供"}
          </span>
          {u.size > 0 && <span className="tabular-nums">{(pct * 100).toFixed(1)}%</span>}
          {u.cost ? (
            <span>
              · {u.costScope === "session" ? "会话累计费用" : "运行时费用"} ${u.cost.amount} {u.cost.currency}
            </span>
          ) : null}
          {cacheRate != null ? <span>· 缓存 {(cacheRate * 100).toFixed(1)}%</span> : null}
          <ChevronDown
            className={cn("w-3 h-3 ml-auto transition-transform duration-300", open && "rotate-180")}
          />
        </div>
        {u.size > 0 && <div className="h-1 rounded-full bg-muted overflow-hidden mt-1.5">
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", bar)}
            style={{ width: `${(pct * 100).toFixed(1)}%` }}
          />
        </div>}
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 mt-1.5 border-t border-border/60 font-mono text-[10px] text-muted-foreground animate-fade-slide-in">
          <div className={row}><span>窗口总量</span><span className="tabular-nums">{u.size > 0 ? u.size.toLocaleString() : "agent 未提供"}</span></div>
          <div className={row}><span>剩余</span><span className="tabular-nums">{u.size > 0 ? remain.toLocaleString() : "agent 未提供"}</span></div>
          <div className={row}><span>本轮用时</span><span className="tabular-nums">{turnMs != null ? fmtElapsed(turnMs) : "—"}</span></div>
          <div className={row}><span>思考用时</span><span className="tabular-nums">{thoughtMs != null ? fmtElapsed(thoughtMs) : "—"}</span></div>
          <div className={row}>
            <span>工具调用</span>
            <span className="tabular-nums">{doneTools.length}/{(msg.toolCalls || []).length} · {fmtElapsed(toolMs)}</span>
          </div>
          {cacheRate != null ? (
            <div className={row}>
              <span>缓存命中</span>
              <span className="tabular-nums">{(cacheRate * 100).toFixed(1)}%（{u.cachedTokens!.toLocaleString()}/{cacheBase.toLocaleString()}）</span>
            </div>
          ) : (
            <div className={row}><span>缓存命中</span><span>agent 未提供</span></div>
          )}
          {u.inputTokens != null || u.outputTokens != null ? (
            <div className={cn(row, "col-span-2")}>
              <span>本轮消耗 (输入 / 输出)</span>
              <span className="tabular-nums">{(u.inputTokens ?? 0).toLocaleString()} / {(u.outputTokens ?? 0).toLocaleString()}</span>
            </div>
          ) : null}
          {u.totalTokens != null && (
            <div className={cn(row, "col-span-2")}><span>本轮累计 tokens（多次模型请求）</span><span>{u.totalTokens.toLocaleString()}</span></div>
          )}
          {u.thoughtTokens != null && (
            <div className={row}><span>本轮推理 tokens</span><span>{u.thoughtTokens.toLocaleString()}</span></div>
          )}
          {u.cachedWriteTokens != null && (
            <div className={row}><span>本轮缓存写入 tokens</span><span>{u.cachedWriteTokens.toLocaleString()}</span></div>
          )}
          {(u as any).sessionTotalTokens != null ? (
            <div className={cn(row, "col-span-2 text-muted-foreground/80")}>
              <span>会话累计</span>
              <span className="tabular-nums">{((u as any).sessionTotalTokens).toLocaleString()} tokens</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};




type AcpToolCall = WidgetTool;





// ---------- messages ----------

const SUGGESTIONS = [
  {
    title: "梳理这个仓库的结构",
    prompt: "请阅读当前工作区，说明关键目录和模块各自负责什么、入口在哪里、模块之间怎么调用。",
    hint: "只读",
  },
  {
    title: "审查未提交的改动",
    prompt: "请查看当前工作区未提交的改动（git diff），指出可能的 bug、边界情况和缺少的测试。",
    hint: "git diff",
  },
  {
    title: "为未提交的改动补测试",
    prompt: "请为当前工作区未提交的改动补充单元测试，并运行测试确认通过。",
    hint: "会写文件",
  },
  {
    title: "生成代码改进建议",
    prompt: "请通读当前核心代码，分析潜在的架构坏味道、性能瓶颈并给出重构建议。",
    hint: "架构分析",
  },
];

const AssistantWelcome: React.FC<{
  agentName: string;
  onSelectSuggestion: (prompt: string) => void;
  connected?: boolean;
  sessionId?: string | null;
  sessionError?: string | null;
  sessionLoading?: boolean;
  onEnsureSession?: () => void;
  cwd?: string | null;
}> = ({ agentName, onSelectSuggestion, connected, sessionId, sessionError, sessionLoading, onEnsureSession, cwd }) => (
  <div className="max-w-3xl xl:max-w-4xl 2xl:max-w-5xl mx-auto pt-[10vh] pb-8 px-2 space-y-6">
    <div className="space-y-1.5 select-none">
      <h2 className="text-[22px] leading-tight font-semibold text-foreground tracking-[-0.01em]">
        {agentName}
      </h2>
      <div className="flex items-center gap-2 text-xs text-muted-foreground font-mono min-w-0">
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            connected ? "bg-success" : "bg-muted-foreground/50",
          )}
        />
        <span className="shrink-0">{connected ? "已连接" : "未连接"}</span>
        <span className="text-border">/</span>
        <span className="truncate" title={cwd || undefined}>{cwd || "未选择工作区"}</span>
      </div>
    </div>

    {connected && !sessionId && (
      <div
        className={cn(
          "rounded-md border px-3 py-2 text-xs",
          sessionError ? "border-warning/50 bg-warning/10" : "border-border bg-card",
        )}
      >
        <div className="flex items-center gap-2">
          {sessionLoading ? (
            <span className="inline-flex items-center text-muted-foreground text-xs">正在建立会话，模型列表马上就来…</span>
          ) : sessionError ? (
            <span className="text-warning font-medium">建会话失败：{sessionError}</span>
          ) : (
            <span className="text-muted-foreground">已连接，尚未建立会话</span>
          )}
          {!sessionLoading && (
            <button
              type="button"
              onClick={() => onEnsureSession?.()}
              className="ml-auto h-6 px-2 rounded-md bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors shrink-0"
            >
              {sessionError ? "重试" : "建立会话"}
            </button>
          )}
        </div>
      </div>
    )}

    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-muted-foreground px-1">常用任务</div>
      <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
        {SUGGESTIONS.map((item, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => onSelectSuggestion(item.prompt)}
            className="group w-full flex items-center gap-3 px-3 h-10 text-left text-[13px] text-foreground bg-card/40 hover:bg-accent transition-colors cursor-pointer"
            title={item.prompt}
          >
            <span className="flex-1 truncate">{item.title}</span>
            <span className="font-mono text-[11px] text-muted-foreground shrink-0">{item.hint}</span>
            <CornerDownLeft className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
          </button>
        ))}
      </div>
    </div>
  </div>
);

const GenerativeActionContext = React.createContext<
  ((action: GenerativeCardAction) => void | Promise<void>) | undefined
>(undefined);

const AssistantInlineToolPart: React.FC<{ toolCallId: string }> = ({ toolCallId }) => {
  const messageId = useAuiState((s) => s.message.id);
  const tc = useStudioStore((s) =>
    sessionOf(s).messages.find((m) => m.id === messageId)?.toolCalls?.find((t) => t.id === toolCallId)
  );
  const onGenerativeAction = React.useContext(GenerativeActionContext);
  if (!tc || !isGenerativeTool(tc)) return null;
  return (
    <AcpGenerativeToolCard
      tool={tc}
      onAction={
        onGenerativeAction
          ? async (act) => {
              await onGenerativeAction({
                ...act,
                messageId,
                toolCallId: tc.id,
              });
            }
          : undefined
      }
    />
  );
};

const USER_MESSAGE_PARTS = {
  Text: AcpMarkdownText,
  Image: AcpImagePart,
};

const ASSISTANT_MESSAGE_PARTS = {
  Text: AcpMarkdownText,
  Reasoning: () => null,
  Image: AcpImagePart,
  tools: {
    Override: AssistantInlineToolPart as any,
  },
  GenerativeUI: {
    components: studioGenerativeUIComponents,
  },
};

/** 独立 Memoized 正文容器：隔绝思维链/工具组频繁重排与时间戳跳秒，支持正文与生成式交互卡片按占位符交错混排 */
const AssistantMessageBody: React.FC = React.memo(() => (
  <div className="space-y-2">
    <MessagePrimitive.Parts components={ASSISTANT_MESSAGE_PARTS} />
  </div>
));

/** 入场动效播完就记下来：由状态决定播不播，不靠组件挂载。 */
function markMessageSeen(id: string | undefined) {
  if (!id) return;
  const message = sessionOf(useStudioStore.getState()).messages.find((m) => m.id === id);
  if (!message || message.seenAt) return;
  useStudioStore.getState().patchMessage(id, { seenAt: Date.now() });
}

const enterAnimation = (seenAt: number | undefined) => (seenAt ? "" : "animate-fade-slide-in");
const handleEnterAnimationEnd = (id: string | undefined) => (event: React.AnimationEvent) => {
  if (event.target === event.currentTarget) markMessageSeen(id);
};

const UserMessageView: React.FC = () => {
  const messageId = useAuiState((s) => s.message.id);
  const isEditing = useAuiState((s) => s.message.composer.isEditing);
  const acp = useStudioStore((s) => sessionOf(s).messages.find((m) => m.id === messageId));
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    const text = acp?.content || "";
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  if (isEditing) return <EditComposerView />;
  const threadRunning = useAuiState((s) => s.thread.isRunning);
  return (
    <MessagePrimitive.Root
      id={messageId}
      data-slot="message"
      data-message-id={messageId}
      data-preview-text={acp?.content || ""}
      data-from="user"
      className={cn("flex gap-3 justify-end items-start group", enterAnimation(acp?.seenAt))}
      onAnimationEnd={handleEnterAnimationEnd(messageId)}
    >
      <MessageContent className="items-end max-w-[80%]">
        <MessageBubble variant="soft" align="end" className="w-full" layout={false}>
          <MessageBubbleContent
            layout={false}
            className="rounded-2xl bg-secondary text-secondary-foreground px-3.5 py-2 break-words whitespace-pre-wrap text-sm leading-relaxed font-sans shadow-xs border border-border/40"
          >
            <MessagePrimitive.Parts components={USER_MESSAGE_PARTS} />
            {/* 底部 meta 单行：常驻挂载，只换透明度，宽高恒定不挤布局 */}
            <div className="flex items-center justify-end gap-0.5 pt-1.5">
              {acp?.timestamp && (
                <span className="text-[10px] font-mono text-muted-foreground/80 select-none mr-1">{acp.timestamp}</span>
              )}
              <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-sm:opacity-100 transition-opacity">
                <MagneticButton
                  strength={0.2}
                  onClick={copy}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                  title="复制内容"
                >
                  <ActionSwap stateKey={copied ? "copied" : "idle"}>
                    {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                  </ActionSwap>
                </MagneticButton>
                <ActionBarPrimitive.Root className="flex items-center">
                  <ActionBarPrimitive.Edit asChild>
                    <MagneticButton
                      strength={0.2}
                      disabled={threadRunning}
                      className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors disabled:opacity-40"
                      title="编辑后重发"
                    >
                      <Pencil className="w-3 h-3" />
                    </MagneticButton>
                  </ActionBarPrimitive.Edit>
                </ActionBarPrimitive.Root>
              </span>
            </div>
          </MessageBubbleContent>
        </MessageBubble>
        <div className="flex justify-end">
          <BranchPickerView className="justify-end" />
        </div>
      </MessageContent>
      <MessageAvatar>
        <User className="w-4 h-4" />
      </MessageAvatar>
    </MessagePrimitive.Root>
  );
};

const EditComposerView: React.FC = () => {
  return (
    <MessagePrimitive.Root className="flex flex-col items-end [contain-intrinsic-size:auto_200px] [content-visibility:auto]">
      <ComposerPrimitive.Root className="flex w-full max-w-[80%] cursor-text flex-col rounded-2xl rounded-tr-xs border border-primary/40 bg-card transition-[border-color] ml-auto">
        <ComposerPrimitive.Input
          className="min-h-14 w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground outline-none"
          autoFocus
        />
        <div className="mx-2.5 mb-2.5 flex items-center gap-1.5 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm" className="h-8 px-3">
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm" className="h-8 px-3">
              更新
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
};

const BranchPickerView: React.FC<{ className?: string }> = ({ className }) => {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
    >
      <BranchPickerPrimitive.Previous asChild>
        <button className="p-1 rounded hover:text-foreground transition-colors" title="上一分支">
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </BranchPickerPrimitive.Previous>
      <span className="font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <button className="p-1 rounded hover:text-foreground transition-colors" title="下一分支">
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
};

const AssistantMessageView: React.FC<{
  agentName: string;
  cwd?: string | null;
  onNewSession?: () => void;
  onGenerativeAction?: (action: GenerativeCardAction) => void | Promise<void>;
}> = ({ agentName, cwd, onNewSession, onGenerativeAction }) => {
  const messageId = useAuiState((s) => s.message.id);
  const running = useAuiState((s) => s.message.status?.type === "running");
  const isCopied = useAuiState((s) => s.message.isCopied);
  const acp = useStudioStore((s) => sessionOf(s).messages.find((m) => m.id === messageId));
  const isSystem = acp?.role === "system";
  const [turnChangesOpen, setTurnChangesOpen] = React.useState(false);
  const [activityOpen, setActivityOpen] = useSessionDisclosure(`${messageId}:activity`);
  const [citationsOpen, setCitationsOpen] = useSessionDisclosure(`${messageId}:citations`);

  const { progress, conclusion } = React.useMemo(
    () => partitionTurnContent(acp?.content || "", acp?.progressContent, (acp?.toolCalls?.length ?? 0) > 0),
    [acp?.content, acp?.progressContent, acp?.toolCalls]
  );

  // 本轮实际改动过的文件（edit/diff/delete 且能定位路径），去重保序。
  const editedFiles = React.useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tc of acp?.toolCalls || []) {
      const kind = (tc.kind || "").toLowerCase();
      if (kind !== "edit" && kind !== "diff" && kind !== "delete") continue;
      const p = toolPath(tc);
      if (p && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  }, [acp?.toolCalls]);

  // 常规工具（命令执行、文件编辑等）保持在折叠区；生成式 UI 工具内嵌于正文流渲染
  const regularTools = React.useMemo(() => {
    return (acp?.toolCalls || []).filter((tc) => !isGenerativeTool(tc));
  }, [acp?.toolCalls]);

  const activeTools = React.useMemo(
    () => regularTools.filter((t) => isToolActive(t.status)),
    [regularTools]
  );
  const latestTool = activeTools.length > 0 ? activeTools[activeTools.length - 1] : null;
  const liveLabel = latestTool
    ? `正在调用 ${resolveToolDisplayTitle(latestTool)}…`
    : (acp?.statusHint || "模型思考与工具执行推进中…");

  const activityItems = React.useMemo<AgentActivityItem[]>(() => {
    const items: AgentActivityItem[] = [];

    // 1. 思考过程 (Thinking Trace)
    if (acp?.thought) {
      const doneMs =
        acp.thoughtTiming?.startedAt != null && acp.thoughtTiming.completedAt != null
          ? acp.thoughtTiming.completedAt - acp.thoughtTiming.startedAt
          : null;
      items.push({
        id: `${messageId}-thought`,
        type: "trace",
        kind: "thinking",
        label: "思考过程",
        detail: (
          <span className="font-mono text-[10px] text-muted-foreground">
            ({acp.thought.length} 字
            {doneMs != null ? ` · 用时 ${fmtElapsed(doneMs)}` : ""})
          </span>
        ),
        defaultExpanded: true,
        fullContent: (
          <div data-reasoning-trace={messageId} className="relative mt-1 pl-3 border-l-2 border-primary/40 text-[12.5px] leading-relaxed text-muted-foreground font-sans break-words max-h-[300px] overflow-y-auto overscroll-contain select-text">
            <AcpStandaloneMarkdown content={acp.thought} />
          </div>
        ),
      });
    }

    // 2. 阶段推进记录 (Progress Trace)
    if (progress && progress.trim()) {
      items.push({
        id: `${messageId}-progress`,
        type: "trace",
        kind: "write",
        label: "阶段推进记录",
        detail: (
          <span className="font-mono text-[10px] text-muted-foreground">
            ({progress.trim().length} 字 · {running ? "正在推进…" : "(已收拢)"})
          </span>
        ),
        fullContent: (
          <div className="mt-1 rounded-lg border border-border/60 bg-muted/20 p-2.5 max-h-[220px] overflow-y-auto overscroll-contain text-xs text-muted-foreground leading-relaxed break-words font-sans">
            <AcpStandaloneMarkdown content={progress} />
          </div>
        ),
      });
    }

    // 3. 常规工具调用 (Regular Tools)
    for (const tc of regularTools) {
      const displayTitle = resolveToolDisplayTitle(tc);
      const targetFile = extractFileFromTool(displayTitle) || toolPath(tc);
      const widgetKey = resolveWidgetKey(tc);
      const isFileTool = widgetKey === "file-edit" || widgetKey === "file-read" || !!targetFile;
      const cmd = toolCommand(tc);
      const isTerminal = widgetKey === "terminal" || !!cmd;
      const output = toolText(tc.rawOutput) || toolText((tc as any).output ?? (tc as any).result);
      const err = toolText(tc.rawError) || toolText((tc as any).error);
      const hasDetails = Boolean((output && output.trim()) || (err && err.trim()));
      const shortId = tc.id ? (tc.id.length > 12 ? `${tc.id.slice(0, 8)}…` : tc.id) : null;

      const cleanTitle =
        isFileTool && targetFile
          ? targetFile
          : isTerminal && cmd
            ? (cmd.trim().split("\n")[0].length > 80 ? `${cmd.trim().split("\n")[0].slice(0, 77)}…` : cmd.trim().split("\n")[0])
            : (displayTitle.length > 80 ? `${displayTitle.slice(0, 77)}…` : displayTitle);

      const openInTerminal = () => {
        if (!cmd) return;
        const st = useStudioStore.getState();
        const toolCwd =
          strField(tc.rawInput, ["cwd", "workdir", "workDir", "dir", "directory"]) || null;
        st.setTerminalCwd(toolCwd);
        st.setTerminalPrefill(cmd);
        st.setTerminalOpen(true);
      };

      const actionKind =
        widgetKey === "terminal"
          ? "run"
          : widgetKey === "file-read"
            ? "read"
            : widgetKey === "file-edit"
              ? "edit"
              : widgetKey === "search"
                ? "search"
                : (tc.kind || "run");

      items.push({
        id: tc.id || `tc-${items.length}`,
        type: "tool",
        action: actionKind as any,
        target: cleanTitle,
        status: tc.status,
        extra: (
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {shortId && (
              <span
                className="text-[10px] text-ink-3/60 font-mono select-all cursor-default"
                title={`调用 ID: ${tc.id}`}
              >
                {shortId}
              </span>
            )}
            <LiveElapsed startedAt={tc.startedAt} completedAt={tc.completedAt} />
            {isFileTool && targetFile && <DiffButton file={targetFile} />}
            {isTerminal && cmd && (
              <button
                type="button"
                onClick={openInTerminal}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-chip bg-field border border-line-strong hover:bg-hover-2 text-ink-2 text-[10px] font-sans transition-colors shrink-0 cursor-pointer"
                title="在终端中打开（只填入、不自动执行）"
              >
                <Terminal className="w-3 h-3" />
                <span>终端打开</span>
              </button>
            )}
            <StatusDot status={tc.status} />
          </div>
        ),
        expandedContent:
          hasDetails || tc.content?.length || isToolActive(tc.status) || tc.status === "failed" ? (
            <div className="space-y-1 mt-1">
              <AcpToolContents content={tc.content} />
              {(output || err) && (
                <div className="rounded-control border border-line bg-inset/70 overflow-hidden font-mono text-[11px]">
                  {output && (
                    <pre className="px-2.5 py-2 overflow-x-auto text-ink whitespace-pre-wrap break-words max-h-[160px]">
                      <code>{firstLines(output, 10).shown}</code>
                    </pre>
                  )}
                  {err && (
                    <pre className="px-2.5 py-2 overflow-x-auto text-red whitespace-pre-wrap break-words max-h-[120px] border-t border-red/30">
                      <code>{firstLines(err, 8).shown}</code>
                    </pre>
                  )}
                </div>
              )}
            </div>
          ) : undefined,
      });
    }

    return items;
  }, [acp?.thought, acp?.thoughtTiming, progress, regularTools, running, messageId]);

  const activitySummary = React.useMemo(() => {
    const total = regularTools.length;
    const failedCount = regularTools.filter((t) => t.status === "failed").length;
    const successCount = Math.max(0, total - failedCount);
    const thoughtMs =
      acp?.thoughtTiming?.startedAt != null && acp.thoughtTiming.completedAt != null
        ? acp.thoughtTiming.completedAt - acp.thoughtTiming.startedAt
        : null;

    if (total > 0) {
      return (
        <span className="flex items-center gap-1.5 flex-wrap">
          <span>工具调用 · {total}</span>
          {failedCount > 0 ? (
            <span className="font-mono text-[10px] text-ink-3">
              <span className={cn(successCount > 0 ? "text-amber-500 font-semibold" : "text-red font-semibold")}>
                {successCount}/{total} 成功
              </span>
              <span className="opacity-70">({failedCount} 次失败/重试)</span>
            </span>
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground">
              （全部成功 {total}/{total}）
            </span>
          )}
          {thoughtMs != null && (
            <span className="text-[10px] text-muted-foreground font-mono">
              · 思考用时 {fmtElapsed(thoughtMs)}
            </span>
          )}
        </span>
      );
    }
    if (acp?.thought) {
      return <span>思考过程{thoughtMs != null ? ` · 用时 ${fmtElapsed(thoughtMs)}` : ""}</span>;
    }
    return undefined;
  }, [regularTools, acp?.thought, acp?.thoughtTiming]);

  const citations: CitationItem[] = React.useMemo(() => {
    if (acp?.citations && Array.isArray(acp.citations) && acp.citations.length > 0) {
      return acp.citations;
    }
    // 流式生成期间跳过反复的全文字符串正则扫描，等流式结束再一次性解析
    if (running) return [];
    const content = acp?.content || "";
    if (!content.includes("http")) return [];

    const regex = /(?<!\!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    const items: CitationItem[] = [];
    const seen = new Set<string>();
    let match;
    let idx = 1;
    while ((match = regex.exec(content)) !== null) {
      const title = match[1].trim();
      const url = match[2].trim();
      if (!seen.has(url)) {
        seen.add(url);
        try {
          const u = new URL(url);
          items.push({
            id: `ref-${idx++}`,
            title: title.match(/^\d+$/) ? u.hostname : title,
            domain: u.hostname,
            url,
          });
        } catch {
          items.push({
            id: `ref-${idx++}`,
            title,
            url,
          });
        }
      }
    }
    return items;
  }, [acp?.citations, acp?.content]);

  const headerStatusHint = React.useMemo(() => {
    const raw = acp?.statusHint?.trim();
    if (!raw) return "生成中…";
    // 工具执行流已有 AgentActivity 独立展示，顶栏不重复输出冗长命令与已完成文案，保持单行精简
    if (raw.startsWith("正在调用") || raw.startsWith("正在执行")) {
      return "正在执行工具…";
    }
    if (raw.includes("已完成") || raw.includes("已取消")) {
      return "正在生成…";
    }
    // 强制单行上限截断（最多 24 个字符）
    return raw.length > 24 ? `${raw.slice(0, 22)}…` : raw;
  }, [acp?.statusHint]);

  // If this is an orphan/synthetic message id without backing in store, never render a phantom hanging capsule
  if (!acp && !running) {
    return null;
  }
  // 首 token 到达前：无正文、无思考、无工具调用。
  // 不渲染整张卡（空卡会被骨架屏撑成又高又窄），只给一行紧凑状态胶囊。
  const awaitingFirstToken =
    running && Boolean(acp) && !acp?.content && !acp?.thought && !acp?.artifacts?.length && !acp?.contentBlocks?.length && !(acp?.toolCalls && acp.toolCalls.length > 0) && !(acp?.images && acp.images.length > 0);

  if (awaitingFirstToken) {
    return (
      <MessagePrimitive.Root
        id={messageId}
        data-slot="message"
        data-message-id={messageId}
        data-preview-text=""
        data-from="assistant"
        className={cn("flex gap-3 justify-start items-start group", enterAnimation(acp?.seenAt))}
        onAnimationEnd={handleEnterAnimationEnd(messageId)}
      >
        <MessageAvatar>
          <Bot className="w-4 h-4 text-primary" />
        </MessageAvatar>
        <MessageContent>
          <ThinkingStateCapsule startedAt={acp?.startedAt} statusHint={acp?.statusHint} />
        </MessageContent>
      </MessagePrimitive.Root>
    );
  }

  if (!acp) {
    return null;
  }

  // 如果某轮助手消息非运行中且完全未产生任何正文、思考、工具调用或图片（例如刚开始就被取消），不渲染幽灵空卡
  const isEmptyTurn =
    !running &&
    !acp.content &&
    !acp.thought &&
    !acp.artifacts?.length &&
    !acp.contentBlocks?.length &&
    !(acp.toolCalls && acp.toolCalls.length > 0) &&
    !(acp.images && acp.images.length > 0);

  if (isEmptyTurn) {
    return null;
  }

  return (
    <MessagePrimitive.Root
      id={messageId}
      data-slot="message"
      data-message-id={messageId}
      data-preview-text=""
      data-from="assistant"
      className={cn("flex gap-3 justify-start items-start group", enterAnimation(acp?.seenAt))}
      onAnimationEnd={handleEnterAnimationEnd(messageId)}
    >
      <MessageAvatar className={cn(
        "transition-colors",
        running ? "bg-primary text-primary-foreground border-primary/40 shadow-sm" : "bg-muted text-foreground"
      )}>
        <Bot className="w-4 h-4" />
      </MessageAvatar>
      <MessageContent className="min-w-0 max-w-full">
        <div
          data-streaming={running ? "true" : "false"}
          className="acp-stream-ring relative w-full rounded-2xl"
        >
          <MessageBubble
            variant="outline"
            className="w-full max-w-full"
            layout={false}
          >
            <MessageBubbleContent
              layout={false}
              className="w-full max-w-full rounded-2xl p-4 sm:p-5 space-y-3 text-foreground shadow-xs"
            >
              <div className="flex items-center justify-between gap-4 text-[11px] pb-2 border-b border-border/70">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold text-foreground shrink-0">
              {isSystem ? "System" : agentName}
            </span>
            {acp?.model && (
              <Badge variant="secondary" className="text-[10px] h-4 px-1.5 font-mono shrink-0">
                {acp.model}
              </Badge>
            )}
            {acp?.mode && acp.mode !== "default" && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 font-mono text-muted-foreground shrink-0">
                {acp.mode}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-muted-foreground min-w-0 max-w-[50%] justify-end">
            {running ? (
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse shrink-0" />
                <span
                  className="inline-block text-muted-foreground text-[11px] truncate whitespace-nowrap max-w-[180px]"
                  title={headerStatusHint}
                >
                  {headerStatusHint}
                </span>
              </span>
            ) : (
              <>
                {acp?.startedAt != null && acp?.completedAt != null && (
                  <span className="font-mono tabular-nums shrink-0">用时 {fmtElapsed(acp.completedAt - acp.startedAt)}</span>
                )}
                {acp?.timestamp && <span className="shrink-0">{acp.timestamp}</span>}
              </>
            )}
          </div>
        </div>

        {acp?.plan && acp.plan.length > 0 && (
          <div className="rounded-lg bg-background/70 border border-border px-3 py-2 text-xs space-y-1.5">
            <div className="font-semibold text-muted-foreground">执行计划</div>
            {acp.plan.map((pl, idx) => (
              <div key={idx} className="flex items-center gap-2 text-muted-foreground">
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    pl.status === "completed"
                      ? "bg-success"
                      : pl.status === "in_progress"
                        ? "bg-warning animate-pulse"
                        : "bg-muted-foreground",
                  )}
                />
                <span className="flex-1 truncate">{pl.content}</span>
                {pl.priority && (
                  <span className="font-mono text-[10px] text-muted-foreground">{pl.priority}</span>
                )}
              </div>
            ))}
          </div>
        )}

        {acp?.usage && <UsagePanel msg={acp} />}

        {/* 等待态已提前 return 胶囊；此处只有到达过 token 的消息 */}
        <>
          {/* 过程区：AgentActivity 统一自适应执行流 (思考链 + 阶段推进记录 + 工具调用流) */}
          {(activityItems.length > 0 || (running && !!acp?.statusHint)) && (
            <div className="rounded-xl border border-line/70 bg-surface/80 p-2.5 shadow-xs transition-colors">
              <AgentActivity
                open={activityOpen}
                onOpenChange={setActivityOpen}
                items={activityItems}
                status={running ? "working" : "complete"}
                duration={
                  acp?.startedAt != null && acp?.completedAt != null
                    ? (acp.completedAt - acp.startedAt) / 1000
                    : 0
                }
                collapseOnComplete={true}
                maxHeight={280}
                activeLabel={
                  <ThinkingShimmer duration={1.8} className="font-medium text-foreground">
                    {liveLabel}
                  </ThinkingShimmer>
                }
                summary={activitySummary}
                renderWorkingStatus={({ label, duration }) => (
                  <div className="flex items-center gap-2 text-xs min-w-0">
                    <Loader
                      variant="ascii-braille"
                      size={13}
                      speed={0.8}
                      className="text-primary font-bold shrink-0"
                    />
                    {/* 状态标签只占一行：工具名可能是一整条命令，展开成三行会把
                        下面的工具列表挤到屏外。 */}
                    <span className="min-w-0 flex-1 truncate" title={typeof label === "string" ? label : undefined}>
                      {typeof label === "string" ? (
                        <ThinkingShimmer duration={1.8} className="font-medium text-foreground">
                          {label}
                        </ThinkingShimmer>
                      ) : (
                        label
                      )}
                    </span>
                    {regularTools.length > 0 && (
                      <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                        · 工具调用 · {regularTools.length}
                      </span>
                    )}
                    {duration > 0 && (
                      <span className="shrink-0 whitespace-nowrap font-mono text-[10px] tabular-nums text-muted-foreground ml-auto">
                        {Math.round(duration)}s
                      </span>
                    )}
                  </div>
                )}
              />
            </div>
          )}
          {editedFiles.length > 0 && !running && (
            <TurnDiffViewer
              files={editedFiles}
              cwd={cwd}
              className="my-2"
              onOpenChangesModal={() => setTurnChangesOpen(true)}
            />
          )}
          <GenerativeActionContext.Provider value={onGenerativeAction}>
            <AssistantMessageBody />
            <AcpContentBlocks blocks={acp.contentBlocks} />
            <AcpSessionArtifacts entries={acp.artifacts} />
          </GenerativeActionContext.Provider>
          {citations.length > 0 && <Citations citations={citations} idPrefix={`msg-${messageId}`} open={citationsOpen} onOpenChange={setCitationsOpen} />}
          {acp?.content && /Reasoning Cache Expired|referenced reasoning item .* expired/i.test(acp.content) && (
            <div className="mt-2.5 p-3 rounded-lg border border-warning/40 bg-warning/10 flex items-center justify-between gap-3 text-xs">
              <span className="text-foreground">上游服务端思考缓存已超时失效，请开启新会话继续。</span>
              <button
                type="button"
                onClick={() => {
                  if (onNewSession) onNewSession();
                  else useStudioStore.getState().newThread(useStudioStore.getState().activeAgentId);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>立即开启新会话</span>
              </button>
            </div>
          )}
        </>

        {/* 固定 h-7 槽位：bar 的挂载/卸载只换透明度，不挤布局；
            hover 时官方 Floating 模式以 data-floating 浮层盖在卡内 */}
        <div className="flex items-center gap-1 h-7 text-muted-foreground select-none">
          <BranchPickerView />
          {editedFiles.length > 0 && !running && (
            <button
              type="button"
              onClick={() => setTurnChangesOpen(true)}
              className="flex items-center gap-1 px-1.5 py-1 rounded-lg hover:text-foreground hover:bg-muted/80 transition-colors text-[11px]"
              title={`本轮改动了 ${editedFiles.length} 个文件，点击查看/还原`}
            >
              <History className="w-3.5 h-3.5" />
              <span className="tabular-nums">改动 {editedFiles.length}</span>
            </button>
          )}
          <ActionBarPrimitive.Root
            hideWhenRunning
            autohide="not-last"
            autohideFloat="always"
            className="flex items-center gap-1 data-[floating=true]:absolute data-[floating=true]:bottom-2 data-[floating=true]:left-3 data-[floating=true]:z-10 data-[floating=true]:rounded-full data-[floating=true]:border data-[floating=true]:border-border data-[floating=true]:bg-card/95 data-[floating=true]:px-1.5 data-[floating=true]:py-1 data-[floating=true]:shadow-md data-[floating=true]:backdrop-blur"
          >
            <ActionBarPrimitive.Copy asChild>
              <MagneticButton
                strength={0.2}
                onClick={() => {
                  const toCopy = stripGenerativeToolPlaceholders(conclusion || acp?.content || "");
                  if (toCopy) {
                    navigator.clipboard.writeText(toCopy).catch(() => {});
                  }
                }}
                className="p-1.5 rounded-lg hover:text-foreground hover:bg-muted/80 transition-colors cursor-pointer"
                title="复制最终结论"
              >
                <ActionSwap stateKey={isCopied ? "copied" : "idle"}>
                  {isCopied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                </ActionSwap>
              </MagneticButton>
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload asChild>
              <MagneticButton
                strength={0.2}
                className="p-1.5 rounded-lg hover:text-foreground hover:bg-muted/80 transition-colors"
                title="重新生成"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </MagneticButton>
            </ActionBarPrimitive.Reload>
          </ActionBarPrimitive.Root>
        </div>
            </MessageBubbleContent>
          </MessageBubble>
        </div>
      </MessageContent>
      <TurnChanges
        open={turnChangesOpen}
        onClose={() => setTurnChangesOpen(false)}
        cwd={cwd ?? null}
        files={editedFiles}
      />
    </MessagePrimitive.Root>
  );
};

const SystemMessageView: React.FC = () => {
  const messageId = useAuiState((s) => s.message.id);
  const messages = useStudioMessages();
  const idx = messages.findIndex((m) => m.id === messageId);
  const [open, setOpen] = useSessionDisclosure(`${messageId}:system`);

  // 若未找到，或非连续系统消息首条，直接返回 null（由首条聚合渲染整个集群）
  if (idx < 0) return null;
  if (idx > 0 && messages[idx - 1]?.role === "system") {
    return null;
  }

  // 收集自当前节点开始的所有连续系统消息
  const cluster: Message[] = [];
  for (let i = idx; i < messages.length; i++) {
    if (messages[i].role === "system") {
      cluster.push(messages[i]);
    } else {
      break;
    }
  }

  if (cluster.length === 0) return null;

  // 单条系统消息：保持经典胶囊
  if (cluster.length === 1) {
    const content = cluster[0].content || "";
    return (
      <MessagePrimitive.Root
        id={messageId}
        data-slot="message"
        data-message-id={messageId}
        data-from="system"
        className="w-full flex items-center justify-center my-3 px-4 select-none animate-fade-slide-in"
      >
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-muted/60 border border-border/70 text-muted-foreground text-xs shadow-xs max-w-xl text-center">
          <Info className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
          <span className="leading-relaxed">{content}</span>
        </div>
      </MessagePrimitive.Root>
    );
  }

  // 多条连续系统消息：合并为单行紧凑动态容器，显示最新状态并支持展开，杜绝堆积霸屏
  const latest = cluster[cluster.length - 1];
  const latestSummary = latest.content.replace(/^.*?\]\s*/, "") || latest.content;

  return (
    <MessagePrimitive.Root
      id={messageId}
      data-slot="message"
      data-message-id={messageId}
      data-from="system"
      className="w-full flex flex-col items-center justify-center my-2.5 px-4 select-none animate-fade-slide-in"
    >
      <div className="rounded-2xl bg-muted/60 border border-border/70 text-muted-foreground text-xs shadow-xs max-w-xl w-fit overflow-hidden transition-all">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 px-3.5 py-1.5 hover:bg-muted/80 transition-colors cursor-pointer select-none"
        >
          <Info className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
          <span className="font-semibold text-foreground text-[12px]">
            系统记录 · {cluster.length} 项操作
          </span>
          <span className="text-[11px] text-muted-foreground truncate max-w-[280px]">
            (最新: {latestSummary})
          </span>
          <ChevronDown
            className={cn("w-3.5 h-3.5 ml-1 transition-transform duration-200 shrink-0", open && "rotate-180")}
          />
        </button>
        {open && (
          <div className="border-t border-border/60 bg-muted/30 px-3.5 py-2 max-h-[140px] overflow-y-auto space-y-1 text-[11px] font-mono divide-y divide-border/40">
            {cluster.map((m, i) => (
              <div key={m.id || i} className="py-1 text-muted-foreground flex items-center justify-between gap-3">
                <span className="truncate">{m.content}</span>
                {m.timestamp && <span className="text-[10px] opacity-70 shrink-0 font-sans">{m.timestamp}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </MessagePrimitive.Root>
  );
};

const ThreadMessageRouter: React.FC<{
  agentName: string;
  cwd?: string | null;
  onNewSession?: () => void;
  onGenerativeAction?: (action: GenerativeCardAction) => void | Promise<void>;
}> = ({ agentName, cwd, onNewSession, onGenerativeAction }) => {
  const role = useAuiState((s) => s.message.role);
  if (role === "user") return <UserMessageView />;
  if (role === "system") return <SystemMessageView />;
  return (
    <AssistantMessageView
      agentName={agentName}
      cwd={cwd}
      onNewSession={onNewSession}
      onGenerativeAction={onGenerativeAction}
    />
  );
};

const ThreadLoadEarlier: React.FC = () => {
  const visible = useAuiState((s) => s.thread.hasEarlier || s.thread.isLoadingEarlier);
  const loading = useAuiState((s) => s.thread.isLoadingEarlier);
  if (!visible) return null;
  return (
    <div className="flex justify-center pb-4">
      <ThreadPrimitive.LoadEarlier asChild>
        <button
          className="px-3 py-1.5 rounded-full border border-border bg-card/90 text-xs text-muted-foreground hover:text-primary hover:border-primary/40 shadow-sm transition-colors disabled:opacity-60"
          title="加载更早的历史消息"
        >
          <span className={cn(loading && "animate-pulse")}>
            {loading ? "正在加载…" : "加载更早的消息"}
          </span>
        </button>
      </ThreadPrimitive.LoadEarlier>
    </div>
  );
};

// ---------- root view (composer 由 App 包在同一 Provider 内渲染) ----------

export const AssistantChatView: React.FC<AssistantChatViewProps> = ({
  agentName = "Agent",
  onSelectSuggestion,
  connected,
  sessionId,
  sessionError,
  sessionLoading,
  onEnsureSession,
  onNewSession,
  cwd,
  onGenerativeAction,
}) => {
  const { viewportRef, contentRef, restoreTo, position } = useStickToBottom<HTMLDivElement>();
  const [dragOver, setDragOver] = React.useState(false);

  // 滚动位置是会话的：切走时记下，切回来原样放回（新会话的内容晚一两帧才铺上，
  // 放不到位的会等内容长高再放）；没离开过的会话贴底。
  const viewKey = useStudioStore(activeKey);
  React.useLayoutEffect(() => {
    const saved = sessionOf(useStudioStore.getState(), viewKey).ui.scroll;
    restoreTo(saved && !saved.pinned ? saved.top : null);
    return () => useStudioStore.getState().setScroll(viewKey, position());
  }, [viewKey, restoreTo, position]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    const internalRefs = decodeDragRefs(dt.getData(ACP_PATH_MIME)) || getActiveDragRefs() || [];
    const files = Array.from(dt.files || []);
    const text = dt.getData("text/plain");
    sendDropToComposer({
      internalRefs: internalRefs.length ? internalRefs : undefined,
      files: files.length ? files : undefined,
      text: text || undefined,
    });
  };

  return (
    <ThreadPrimitive.Root
      className="flex-1 flex flex-col min-h-0 bg-background relative overflow-hidden"
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-background/85 backdrop-blur-xs border-2 border-dashed border-primary/70 rounded-xl m-2 pointer-events-none transition-all animate-in fade-in duration-150">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-3 ring-8 ring-primary/5">
            <FolderDown className="w-6 h-6 animate-bounce" />
          </div>
          <span className="text-sm font-semibold text-foreground">松开以引用至 Agent 对话</span>
          <span className="text-xs text-muted-foreground mt-1">支持工作区文件、文件夹 @ 引用及外部文件附件</span>
        </div>
      )}
      <MessageScroller
        navigation="rail"
        externalViewportRef={viewportRef}
        showScrollToBottom={false}
        railClassName="right-2.5 z-20"
      >
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          turnAnchor="top"
          autoScroll={false}
          className="flex-1 overflow-y-auto [scrollbar-gutter:stable] p-4 md:p-6"
        >
          <ThreadPrimitive.Empty>
            <AssistantWelcome
              agentName={agentName}
              onSelectSuggestion={onSelectSuggestion}
              connected={connected}
              sessionId={sessionId}
              sessionError={sessionError}
              sessionLoading={sessionLoading}
              onEnsureSession={onEnsureSession}
              cwd={cwd}
            />
          </ThreadPrimitive.Empty>
          <div ref={contentRef} className="max-w-3xl xl:max-w-4xl 2xl:max-w-5xl mx-auto space-y-6 px-3 sm:px-4">
            <ThreadLoadEarlier />
            <ThreadPrimitive.Messages>
              {() => (
                <ThreadMessageRouter
                  agentName={agentName}
                  cwd={cwd}
                  onNewSession={onNewSession}
                  onGenerativeAction={onGenerativeAction}
                />
              )}
            </ThreadPrimitive.Messages>
          </div>
          <ThreadPrimitive.ViewportFooter className="max-w-3xl xl:max-w-4xl 2xl:max-w-5xl mx-auto sticky bottom-0 z-10 flex justify-center pointer-events-none h-0 overflow-visible">
            <ThreadPrimitive.ScrollToBottom asChild>
              <button
                className="absolute bottom-3 pointer-events-auto flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border bg-popover text-xs text-muted-foreground hover:text-foreground shadow-md transition-colors disabled:invisible"
                title="回到底部"
              >
                <ArrowDown className="w-3.5 h-3.5" />
                回到底部
              </button>
            </ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </MessageScroller>
    </ThreadPrimitive.Root>
  );
};

export const AssistantLoadingSkeleton: React.FC = () => (
  <div className="space-y-2 py-1 max-w-3xl xl:max-w-4xl 2xl:max-w-5xl mx-auto px-3 sm:px-4">
    <Skeleton className="h-3.5 w-[92%]" />
    <Skeleton className="h-3.5 w-[78%]" />
    <Skeleton className="h-3.5 w-[64%]" />
  </div>
);
