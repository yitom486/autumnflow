import React from "react";
import {
  Check,
  Copy,
  FileDiff,
  FileText,
  PencilLine,
  Search,
  SquareTerminal,
  Terminal,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStudioStore } from "@/stores/useStudioStore";

/**
 * Generative UI（展示型）：同一份 ACP 工具调用数据，按工具种类渲染专属卡片，
 * 未知种类回落通用行。只画 arriving 数据，不编造；纯前端，无需后端改动。
 */

import {
  type WidgetTool,
  type WidgetKey,
  isToolActive,
  isToolTerminal,
  toolText,
  firstLines,
  lastLines,
  strField,
  toolPath,
  toolCommand,
  isDiffText,
  resolveWidgetKey,
  resolveToolDisplayTitle,
  fmtElapsed,
} from "./tool-widget-utils";

export type { WidgetTool, WidgetKey };

/**
 * 真实耗时：完成后静态，运行中每 500ms 跳一次。
 * 数据来自 App 发送路径的客户端打点（首见/终态时间戳）。
 */
export const LiveElapsed: React.FC<{ startedAt?: number; completedAt?: number }> = ({
  startedAt,
  completedAt,
}) => {
  const [, setTick] = React.useState(0);
  const live = startedAt != null && completedAt == null;
  React.useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [live, startedAt]);
  if (startedAt == null) return null;
  const ms = (completedAt ?? Date.now()) - startedAt;
  return <span className="font-mono text-[10px] text-muted-foreground/80 tabular-nums">{fmtElapsed(ms)}</span>;
};

// ---------- shared bits ----------

export function StatusDot({ status }: { status: WidgetTool["status"] }) {
  const active = isToolActive(status);
  return (
    <span
      className={cn(
        "w-2 h-2 rounded-full shrink-0",
        active
          ? "bg-warning animate-pulse"
          : status === "completed"
            ? "bg-success"
            : status === "cancelled"
              ? "bg-muted-foreground"
              : "bg-destructive",
      )}
    />
  );
}

export const CopyTextBtn: React.FC<{ text: string; title?: string }> = ({ text, title }) => {
  const [copied, setCopied] = React.useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1 hover:text-foreground transition-colors shrink-0"
      title={title || "复制"}
    >
      {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
      {copied ? "已复制" : "复制"}
    </button>
  );
};

export const DiffButton: React.FC<{ file: string | null }> = ({ file }) => {
  const onOpenDiff = useStudioStore((s) => s.setGitChangesOpen);
  if (!file) return null;
  return (
    <button
      type="button"
      onClick={() => onOpenDiff(true, file)}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-chip bg-field border border-line hover:bg-hover-2 text-ink-2 text-[10px] font-sans transition-colors shrink-0 cursor-pointer"
      title={`在 Git 审查中查看 ${file}`}
    >
      <FileDiff className="w-3 h-3 text-accent" />
      <span>Diff</span>
    </button>
  );
};

function CardShell({
  icon,
  title,
  right,
  dot,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
  dot: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-background/80 border border-border text-xs text-muted-foreground animate-fade-slide-in overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {icon}
        <span className="flex-1 truncate font-mono" title={title}>
          {title}
        </span>
        {right}
        {dot}
      </div>
      {children}
    </div>
  );
}

// ---------- widgets ----------

function CodePreview({ text, maxLines = 12 }: { text: string; maxLines?: number }) {
  if (!text) return null;
  const { shown, total } = firstLines(text, maxLines);
  return (
    <div className="mx-1.5 mb-1.5 rounded-md border border-border/60 bg-background/60 overflow-hidden">
      <pre className="px-2.5 py-2 overflow-x-auto text-[11px] leading-relaxed font-mono text-foreground/90 whitespace-pre">
        <code>{shown}</code>
      </pre>
      <div className="flex items-center justify-between px-2.5 py-1 border-t border-border/60 font-mono text-[10px] text-muted-foreground/80">
        <span className="tabular-nums">{total} 行{total > maxLines ? `（前 ${maxLines} 行）` : ""}</span>
        <CopyTextBtn text={text} title="复制全部内容" />
      </div>
    </div>
  );
}

function DiffPreview({ text, maxLines = 24 }: { text: string; maxLines?: number }) {
  const all = text.split("\n");
  const shown = all.slice(0, maxLines);
  return (
    <div className="mx-1.5 mb-1.5 rounded-md border border-border/60 bg-background/60 overflow-hidden">
      <pre className="px-2 py-2 overflow-x-auto text-[11px] leading-relaxed font-mono whitespace-pre">
        <code>
          {shown.map((line, i) => (
            <div
              key={i}
              className={cn(
                "px-1.5 rounded",
                line.startsWith("+") && !line.startsWith("+++") && "bg-success/15 text-foreground",
                line.startsWith("-") && !line.startsWith("---") && "bg-destructive/15 text-foreground",
                line.startsWith("@@") && "text-primary",
              )}
            >
              {line || " "}
            </div>
          ))}
        </code>
      </pre>
      {all.length > maxLines && (
        <div className="px-2.5 py-1 border-t border-border/60 font-mono text-[10px] text-muted-foreground/80 tabular-nums">
          …还有 {all.length - maxLines} 行
        </div>
      )}
    </div>
  );
}

export const FileReadCard: React.FC<{ tc: WidgetTool }> = ({ tc }) => {
  const path = toolPath(tc);
  const output = toolText(tc.rawOutput);
  return (
    <CardShell
      icon={<FileText className="w-3.5 h-3.5 text-primary shrink-0" />}
      title={path || resolveToolDisplayTitle(tc)}
      right={
        <>
          <LiveElapsed startedAt={tc.startedAt} completedAt={tc.completedAt} />
          <DiffButton file={path} />
        </>
      }
      dot={<StatusDot status={tc.status} />}
    >
      {output ? (
        <CodePreview text={output} />
      ) : isToolActive(tc.status) ? (
        <div className="mx-1.5 mb-1.5 px-2.5 py-2 font-mono text-[11px] text-muted-foreground animate-pulse">
          正在读取…
        </div>
      ) : null}
    </CardShell>
  );
};

export const FileEditCard: React.FC<{ tc: WidgetTool }> = ({ tc }) => {
  const path = toolPath(tc);
  const output = toolText(tc.rawOutput);
  const err = toolText(tc.rawError);
  return (
    <CardShell
      icon={<PencilLine className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      title={path || resolveToolDisplayTitle(tc)}
      right={
        <>
          <LiveElapsed startedAt={tc.startedAt} completedAt={tc.completedAt} />
          <DiffButton file={path} />
        </>
      }
      dot={<StatusDot status={tc.status} />}
    >
      {output ? (
        isDiffText(output) ? (
          <DiffPreview text={output} />
        ) : (
          <CodePreview text={output} />
        )
      ) : err ? (
        <div className="mx-1.5 mb-1.5 px-2.5 py-2 rounded-md border border-destructive/40 bg-destructive/10 font-mono text-[11px] text-destructive break-words">
          {firstLines(err, 8).shown}
        </div>
      ) : isToolActive(tc.status) ? (
        <div className="mx-1.5 mb-1.5 px-2.5 py-2 font-mono text-[11px] text-muted-foreground animate-pulse">
          正在写入…
        </div>
      ) : null}
    </CardShell>
  );
};

export const TerminalCard: React.FC<{ tc: WidgetTool }> = ({ tc }) => {
  const cmd = toolCommand(tc);
  const output = toolText(tc.rawOutput);
  const err = toolText(tc.rawError);
  const failed = tc.status === "failed";
  const openInTerminal = () => {
    if (!cmd) return;
    const st = useStudioStore.getState();
    // 工具自带的执行目录（有则带，无则空→抽屉回落当前工作区，绝不编造）。
    const toolCwd =
      strField(tc.rawInput, ["cwd", "workdir", "workDir", "dir", "directory"]) || null;
    st.setTerminalCwd(toolCwd);
    st.setTerminalPrefill(cmd);
    st.setTerminalOpen(true);
  };
  return (
    <CardShell
      icon={<SquareTerminal className="w-3.5 h-3.5 text-primary shrink-0" />}
      title={cmd}
      right={
        <>
          <LiveElapsed startedAt={tc.startedAt} completedAt={tc.completedAt} />
          {cmd && (
            <button
              type="button"
              onClick={openInTerminal}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/10 hover:bg-primary/20 text-primary text-[10px] font-sans transition-colors shrink-0"
              title="在终端中打开（只填入、不自动执行）"
            >
              <Terminal className="w-3 h-3" />
              <span>终端打开</span>
            </button>
          )}
        </>
      }
      dot={<StatusDot status={tc.status} />}
    >
      {output || err || isToolActive(tc.status) ? (
        <div className="mx-1.5 mb-1.5 rounded-md border border-border/60 bg-muted/60 overflow-hidden">
          {output && (
            <pre className="px-2.5 py-2 overflow-x-auto text-[11px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap break-words">
              <code>{lastLines(output, 12).shown}</code>
            </pre>
          )}
          {err && (
            <pre className="px-2.5 py-2 overflow-x-auto text-[11px] leading-relaxed font-mono text-destructive whitespace-pre-wrap break-words border-t border-destructive/30">
              <code>{lastLines(err, 8).shown}</code>
            </pre>
          )}
          {!output && !err && (
            <div className="px-2.5 py-2 font-mono text-[11px] text-muted-foreground animate-pulse">
              执行中…
            </div>
          )}
          {failed && !err && (
            <div className="px-2.5 py-1 border-t border-destructive/30 font-mono text-[10px] text-destructive">
              执行失败
            </div>
          )}
        </div>
      ) : null}
    </CardShell>
  );
};

export const SearchCard: React.FC<{ tc: WidgetTool }> = ({ tc }) => {
  const query = strField(tc.rawInput, ["pattern", "query", "text", "keyword"]) || tc.title;
  const output = toolText(tc.rawOutput);
  const matchLines = output ? output.split("\n").filter((l) => l.trim()).length : 0;
  return (
    <CardShell
      icon={<Search className="w-3.5 h-3.5 text-primary shrink-0" />}
      title={query.length > 120 ? query.slice(0, 119) + "…" : query}
      right={
        <>
          {matchLines > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground/80 tabular-nums">
              {matchLines} 命中
            </span>
          )}
          <LiveElapsed startedAt={tc.startedAt} completedAt={tc.completedAt} />
        </>
      }
      dot={<StatusDot status={tc.status} />}
    >
      {output ? (
        <CodePreview text={output} maxLines={8} />
      ) : isToolActive(tc.status) ? (
        <div className="mx-1.5 mb-1.5 px-2.5 py-2 font-mono text-[11px] text-muted-foreground animate-pulse">
          搜索中…
        </div>
      ) : null}
    </CardShell>
  );
};

export function WidgetFallbackIcon() {
  return <Wrench className="w-3.5 h-3.5 text-primary shrink-0" />;
}
