import React, { Suspense, lazy, memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  MarkdownTextPrimitive,
  memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from "@assistant-ui/react-markdown";
import "@assistant-ui/react-markdown/styles/dot.css";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import ReactMarkdown from "react-markdown";
import { Check, Copy, CornerDownLeft, Info, Lightbulb, AlertCircle, AlertTriangle, ShieldAlert } from "lucide-react";
import { useMessagePartText, type TextMessagePartComponent } from "@assistant-ui/react";
import { closeOpenFences, hasMath, preprocessMarkdown } from "@/lib/markdown-preprocess";
import { getMathPlugins, loadMathPlugins, subscribeMath } from "@/components/assistant/math-plugins";
import { useDeviceFps } from "@/lib/fps-adaptive";
import { cn } from "@/lib/utils";
import { AcpImageView, isSafeLinkHref, isSafeMediaSrc } from "@/components/assistant/AcpMedia";
import { Citation } from "@/components/primitives/Citations";
import { getHighlighter, ensureLanguage } from "@/components/magicui/code-comparison";
import { useThemeStore } from "@/stores/useThemeStore";
import { StableTextPart } from "./StableTextPart";

const ReactArtifactCard = lazy(() =>
  import("./ReactArtifactCard").then((m) => ({ default: m.ReactArtifactCard }))
);

export interface ExtendedCodeHeaderProps extends CodeHeaderProps {
  wrap?: boolean;
  onToggleWrap?: () => void;
}

export function inferCodeLanguage(rawLang: string | undefined, codeStr: string): string {
  const clean = (rawLang || "").split(/\s+/)[0]?.toLowerCase().trim();
  if (clean === "tree") {
    return "yaml";
  }
  if (clean && clean !== "plaintext" && clean !== "text" && clean !== "code") {
    return clean;
  }
  // Directory tree characters (├, └, │, ─) or paths with comments (e.g. apps/desktop/... # comment)
  if (
    /[├└│─]/.test(codeStr) ||
    /(?:^|\n)\s*[\w.-]+[/\\]\s*#/.test(codeStr) ||
    /(?:^|\n)\s*#\s+/.test(codeStr)
  ) {
    return "yaml";
  }
  // Shell scripts / commands ($ bun, npm, git, etc.)
  if (/(?:^|\n)\s*[$>]\s+\w+/.test(codeStr) || /(?:^|\n)\s*(?:npm|pnpm|bun|yarn|git|cargo|docker)\s+/.test(codeStr)) {
    return "bash";
  }
  return "plaintext";
}

export const AcpCodeHeader: React.FC<ExtendedCodeHeaderProps> = memo(({ language, code, wrap, onToggleWrap }) => {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const cleanLang = (language || "").toLowerCase().trim();
  const isPreviewable = cleanLang === "react" || cleanLang === "tsx" || cleanLang === "jsx" || cleanLang === "html";
  const hasDisplayBadge = language && language !== "code" && language !== "plaintext" && language !== "text";

  const copy = () => {
    if (!code || copied) return;
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between rounded-t-lg border border-b-0 border-border bg-background/80 px-3 py-1 text-[11px] font-mono text-muted-foreground">
        <div className="flex items-center gap-2">
          {hasDisplayBadge ? (
            <span className="font-semibold text-foreground/80">{language}</span>
          ) : null}
          {isPreviewable && (
            <button
              type="button"
              onClick={() => setShowPreview((p) => !p)}
              className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-sans font-medium transition-colors flex items-center gap-1",
                showPreview
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground hover:bg-primary/20"
              )}
              title={showPreview ? "切回代码视图" : "实时渲染并预览此交互组件"}
            >
              <span>{showPreview ? "查看源码" : "运行预览"}</span>
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onToggleWrap && (
            <button
              type="button"
              onClick={onToggleWrap}
              className={cn(
                "flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors text-[10px] cursor-pointer",
                wrap
                  ? "bg-accent text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
              )}
              title={wrap ? "关闭自动换行 (当前换行)" : "开启自动换行 (当前单行截断)"}
            >
              <CornerDownLeft className="w-3 h-3" />
              <span>{wrap ? "已换行" : "换行"}</span>
            </button>
          )}
          <button
            onClick={copy}
            className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
            title="复制代码"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>

      {showPreview && isPreviewable && (
        <Suspense
          fallback={
            <div className="p-3 text-xs text-muted-foreground animate-pulse border border-border bg-background/60">
              沙箱加载中…
            </div>
          }
        >
          <ReactArtifactCard
            code={code}
            template={cleanLang === "html" ? "html" : "react"}
            title={`${language} 原型预览`}
            className="rounded-t-none mt-0 border-t-0"
          />
        </Suspense>
      )}
    </div>
  );
});

export const AcpSyntaxHighlighter: React.FC<{
  language?: string;
  code: string;
  wrap?: boolean;
}> = memo(({ language, code, wrap = false }) => {
  const theme = useThemeStore((s) => s.theme);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const cleanLang = inferCodeLanguage(language, code);

    // 节流防抖：在流式输出期间（高达 180~240 帧/秒），避免重度 Shiki 语法树在每一帧都阻塞主线程，
    // 75ms 节流窗口内由原生的 pre/code 无闪烁同帧渲染，停顿或完成后无缝过渡至完整高亮 HTML。
    const timer = setTimeout(async () => {
      try {
        const hl = await getHighlighter();
        const l = await ensureLanguage(hl, cleanLang);
        const shikiTheme = theme === "light" ? "github-light-high-contrast" : "github-dark-default";
        const out = hl.codeToHtml(code, {
          lang: l,
          theme: shikiTheme,
        });
        if (active) setHighlighted(out);
      } catch {
        if (active) setHighlighted(null);
      }
    }, 75);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [code, language, theme]);

  if (!highlighted) {
    return (
      <pre
        className={cn(
          "overflow-x-auto rounded-b-lg border border-t-0 border-border bg-background/80 px-3 py-2.5 text-xs leading-relaxed font-mono text-foreground select-text",
          wrap && "whitespace-pre-wrap break-words"
        )}
      >
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      data-testid="acp-highlighted-code"
      className={cn(
        "overflow-x-auto rounded-b-lg border border-t-0 border-border bg-background/80 px-3 py-2.5 text-xs leading-relaxed font-mono text-foreground [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_pre]:!border-0 [&_code]:!bg-transparent [&_code]:!p-0 select-text",
        wrap && "whitespace-pre-wrap break-words [&_pre]:!whitespace-pre-wrap [&_code]:!whitespace-pre-wrap"
      )}
      dangerouslySetInnerHTML={{ __html: highlighted }}
    />
  );
});

const ALERT_STYLES: Record<string, {
  border: string;
  bg: string;
  text: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}> = {
  NOTE: {
    border: "border-blue-500/30",
    bg: "bg-blue-500/10",
    text: "text-blue-500",
    icon: Info,
    label: "Note",
  },
  TIP: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-500/10",
    text: "text-emerald-500",
    icon: Lightbulb,
    label: "Tip",
  },
  IMPORTANT: {
    border: "border-purple-500/30",
    bg: "bg-purple-500/10",
    text: "text-purple-500",
    icon: AlertCircle,
    label: "Important",
  },
  WARNING: {
    border: "border-amber-500/30",
    bg: "bg-amber-500/10",
    text: "text-amber-500",
    icon: AlertTriangle,
    label: "Warning",
  },
  CAUTION: {
    border: "border-rose-500/30",
    bg: "bg-rose-500/10",
    text: "text-rose-500",
    icon: ShieldAlert,
    label: "Caution",
  },
};

export const AcpBlockquote: React.FC<{ className?: string; children?: React.ReactNode }> = memo(({ className, children, ...props }) => {
  const childArray = React.Children.toArray(children);
  const contentChildren = childArray.filter(
    (c) => typeof c !== "string" || c.trim().length > 0
  );
  const firstChild = contentChildren[0];

  if (React.isValidElement(firstChild) && (firstChild.props as any)?.children) {
    const pChildren = React.Children.toArray((firstChild.props as any).children);
    const firstText = typeof pChildren[0] === "string" ? pChildren[0] : "";
    const match = firstText.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(\n)?/i);

    if (match) {
      const alertType = match[1].toUpperCase();
      const style = ALERT_STYLES[alertType] || ALERT_STYLES.NOTE;
      const Icon = style.icon;
      const restText = firstText.slice(match[0].length);
      const remainingPChildren = restText ? [restText, ...pChildren.slice(1)] : pChildren.slice(1);
      const newFirstChild = React.cloneElement(firstChild as React.ReactElement<any>, {}, ...remainingPChildren);
      const otherChildren = contentChildren.slice(1);

      return (
        <div
          data-alert={alertType.toLowerCase()}
          className={cn(
            "my-3 rounded-lg border px-3.5 py-2.5 text-xs text-foreground shadow-xs leading-relaxed",
            style.border,
            style.bg,
            className
          )}
          {...props}
        >
          <div className={cn("flex items-center gap-1.5 font-semibold text-[12px] mb-1 select-none", style.text)}>
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <span>{style.label}</span>
          </div>
          <div className="space-y-1.5 [&>p]:my-1">
            {newFirstChild}
            {otherChildren}
          </div>
        </div>
      );
    }
  }

  return (
    <blockquote
      className={cn("my-2 border-l-2 border-primary/50 pl-3 text-muted-foreground italic", className)}
      {...props}
    >
      {children}
    </blockquote>
  );
});

/**
 * 结构级 AST 语义比对器：
 * 严格忽略 position（行、列、字符 offset 偏移量）与 data 等解析元数据，
 * 仅深度比对节点类型、标签名、文本值、业务属性（className/href/src等）以及子节点语义树。
 * 这彻底杜绝了尾部追加新 token 导致前序已渲染块（段落、表格、代码块）因 position 偏移而无谓重渲染的问题。
 */
export function areHastNodesSemanticallyEqual(prev: any, next: any, depth = 0): boolean {
  if (Object.is(prev, next)) return true;
  if (depth > 64) return false;
  if (!prev || !next || typeof prev !== "object" || typeof next !== "object") return false;

  if (Array.isArray(prev)) {
    if (!Array.isArray(next) || prev.length !== next.length) return false;
    for (let i = 0; i < prev.length; i++) {
      if (!areHastNodesSemanticallyEqual(prev[i], next[i], depth + 1)) return false;
    }
    return true;
  }
  if (Array.isArray(next)) return false;

  if (prev.type !== next.type) return false;
  if (prev.tagName !== next.tagName) return false;
  if (prev.value !== next.value) return false;

  // 比对 properties（className、href、src、alt、align 等）
  const prevProps = prev.properties || {};
  const nextProps = next.properties || {};
  const prevPropKeys = Object.keys(prevProps);
  const nextPropKeys = Object.keys(nextProps);
  if (prevPropKeys.length !== nextPropKeys.length) return false;
  for (const k of prevPropKeys) {
    if (!areHastNodesSemanticallyEqual(prevProps[k], nextProps[k], depth + 1)) return false;
  }

  // 递归比对子节点语义，完全豁免 position/offset/data
  const prevChildren = prev.children || [];
  const nextChildren = next.children || [];
  if (prevChildren.length !== nextChildren.length) return false;
  for (let i = 0; i < prevChildren.length; i++) {
    if (!areHastNodesSemanticallyEqual(prevChildren[i], nextChildren[i], depth + 1)) return false;
  }

  return true;
}

export function memoizeStableMarkdownComponents(components: Record<string, any> = {}) {
  return Object.fromEntries(
    Object.entries(components).map(([key, value]) => {
      if (!value) return [key, value];
      const Component = value;
      const WithoutNode = ({ node, ...props }: any) => {
        return <Component {...props} />;
      };
      WithoutNode.displayName = `StableMemo(${key})`;
      return [
        key,
        memo(WithoutNode, (prev, next) => {
          return areHastNodesSemanticallyEqual(prev.node, next.node);
        }),
      ];
    })
  );
}

/** 结构语义 Memoized 组件映射，完整覆盖所有 GFM 标签并为表格赋予高稳定性布局 */
const acpComponents = memoizeStableMarkdownComponents({
  h1: ({ className, ...props }: any) => (
    <h1 className={cn("text-base font-bold text-foreground mt-3 mb-1.5", className)} {...props} />
  ),
  h2: ({ className, ...props }: any) => (
    <h2 className={cn("text-[15px] font-bold text-foreground mt-3 mb-1.5", className)} {...props} />
  ),
  h3: ({ className, ...props }: any) => (
    <h3 className={cn("text-sm font-bold text-foreground mt-2.5 mb-1", className)} {...props} />
  ),
  h4: ({ className, ...props }: any) => (
    <h4 className={cn("text-[13px] font-bold text-foreground mt-2 mb-1", className)} {...props} />
  ),
  h5: ({ className, ...props }: any) => (
    <h5 className={cn("text-[12px] font-bold text-foreground mt-2 mb-1", className)} {...props} />
  ),
  h6: ({ className, ...props }: any) => (
    <h6 className={cn("text-[11px] font-bold text-foreground mt-1.5 mb-1 text-muted-foreground", className)} {...props} />
  ),
  p: ({ className, ...props }: any) => (
    <p className={cn("my-1.5 leading-relaxed", className)} {...props} />
  ),
  ul: ({ className, ...props }: any) => (
    <ul className={cn("my-1.5 ml-4 list-disc space-y-1 marker:text-muted-foreground", className)} {...props} />
  ),
  ol: ({ className, ...props }: any) => (
    <ol className={cn("my-1.5 ml-4 list-decimal space-y-1 marker:text-muted-foreground", className)} {...props} />
  ),
  li: ({ className, ...props }: any) => (
    <li className={cn("leading-relaxed", className)} {...props} />
  ),
  blockquote: AcpBlockquote,
  a: ({ className, href, children, ...props }: any) => {
    if (!isSafeLinkHref(href)) {
      return <span className="text-muted-foreground">{children}</span>;
    }
    const text = typeof children === "string" ? children.trim() : Array.isArray(children) ? children.join("").trim() : "";
    const citationMatch = text.match(/^\[?(\d+)\]?$/);
    if (citationMatch) {
      const idx = parseInt(citationMatch[1], 10);
      return (
        <Citation
          citationId={`ref-${idx}`}
          index={idx}
          idPrefix="source"
          label={`查看引用 ${idx}`}
          className={className}
        />
      );
    }
    return (
      <a
        className={cn("text-primary underline-offset-2 hover:underline", className)}
        target="_blank"
        rel="noreferrer"
        href={href}
        {...props}
      >
        {children}
      </a>
    );
  },
  strong: ({ className, ...props }: any) => (
    <strong className={cn("font-semibold", className)} {...props} />
  ),
  b: ({ className, ...props }: any) => (
    <b className={cn("font-semibold", className)} {...props} />
  ),
  em: ({ className, ...props }: any) => (
    <em className={cn("italic", className)} {...props} />
  ),
  i: ({ className, ...props }: any) => (
    <i className={cn("italic", className)} {...props} />
  ),
  hr: ({ className, ...props }: any) => <hr className={cn("my-3 border-border", className)} {...props} />,
  table: ({ className, ...props }: any) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border bg-card/40 transition-[height] duration-75">
      <table className={cn("w-full text-xs border-collapse table-auto sm:table-fixed [contain:inline-size]", className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }: any) => (
    <thead className={cn("bg-muted/70 sticky top-0 z-1", className)} {...props} />
  ),
  tbody: ({ className, ...props }: any) => (
    <tbody className={cn("divide-y divide-border/40", className)} {...props} />
  ),
  tr: ({ className, ...props }: any) => (
    <tr className={cn("transition-colors hover:bg-muted/30", className)} {...props} />
  ),
  th: ({ className, ...props }: any) => (
    <th className={cn("px-3 py-2 text-left font-semibold text-foreground border-b border-border break-words [overflow-wrap:anywhere] min-w-[70px]", className)} {...props} />
  ),
  td: ({ className, ...props }: any) => (
    <td className={cn("px-3 py-2 border-b border-border/60 align-top break-words [overflow-wrap:anywhere] min-w-[70px] tabular-nums", className)} {...props} />
  ),
  pre: ({ className, ...props }: any) => (
    <pre className={cn("overflow-x-auto rounded-b-lg border border-t-0 border-border bg-background/80 px-3 py-2.5 text-xs leading-relaxed font-mono text-foreground", className)} {...props} />
  ),
  code: function AcpCode({ className, ...props }: any) {
    const isBlock = useIsMarkdownCodeBlock();
    if (!isBlock) {
      return (
        <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground", className)} {...props} />
      );
    }
    return <code className={className} {...props} />;
  },
  img: function AcpImg({ src, alt }: any) {
    if (!isSafeMediaSrc(src)) {
      return (
        <span className="text-muted-foreground text-xs">
          {typeof alt === "string" && alt ? alt : "（已拦截不安全图片地址）"}
        </span>
      );
    }
    return <AcpImageView src={src} alt={typeof alt === "string" ? alt : undefined} />;
  },
  kbd: ({ className, ...props }: any) => (
    <kbd
      className={cn(
        "inline-flex items-center justify-center font-mono text-[11px] font-semibold px-1.5 py-0.5 rounded border border-border bg-muted/80 text-foreground shadow-xs select-all mx-0.5 align-middle tracking-tight",
        className
      )}
      {...props}
    />
  ),
  mark: ({ className, ...props }: any) => (
    <mark className={cn("bg-primary/20 text-foreground px-1 py-0.5 rounded font-medium", className)} {...props} />
  ),
  del: ({ className, ...props }: any) => (
    <del className={cn("line-through opacity-70", className)} {...props} />
  ),
  s: ({ className, ...props }: any) => (
    <s className={cn("line-through opacity-70", className)} {...props} />
  ),
  ins: ({ className, ...props }: any) => (
    <ins className={cn("underline underline-offset-2 decoration-primary", className)} {...props} />
  ),
  u: ({ className, ...props }: any) => (
    <u className={cn("underline underline-offset-2", className)} {...props} />
  ),
  sub: ({ className, ...props }: any) => (
    <sub className={cn("text-[10px] align-sub", className)} {...props} />
  ),
  sup: ({ className, ...props }: any) => (
    <sup className={cn("text-[10px] align-super", className)} {...props} />
  ),
  abbr: ({ className, ...props }: any) => (
    <abbr
      className={cn("underline decoration-dotted underline-offset-4 cursor-help", className)}
      {...props}
    />
  ),
  details: ({ className, ...props }: any) => (
    <details
      className={cn(
        "my-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs transition-colors open:bg-muted/50",
        className
      )}
      {...props}
    />
  ),
  summary: ({ className, ...props }: any) => (
    <summary
      className={cn(
        "font-medium text-foreground cursor-pointer select-none outline-none py-0.5 hover:text-primary transition-colors flex items-center gap-1.5",
        className
      )}
      {...props}
    />
  ),
  span: ({ className, ...props }: any) => <span className={className} {...props} />,
  div: ({ className, ...props }: any) => <div className={className} {...props} />,
  section: ({ className, ...props }: any) => <section className={className} {...props} />,
  CodeHeader: AcpCodeHeader,
  SyntaxHighlighter: AcpSyntaxHighlighter,
});

/**
 * 流式 Markdown 文本部件（MessagePrimitive.Parts 的 Text 槽）。
 * - 文本取自 part 上下文，无需传参
 * - defer: 解析降优先级，token 流不阻塞输入/滚动
 * - smooth(默认开): 打字机揭示动效，prefers-reduced-motion 自动关
 * - componentsByLanguage.mermaid: 图表走懒加载渲染器（与引擎无关，
 *   streamdown 同理也要另装插件；此处直接注册即可）
 */
const AcpMermaidDiagram = lazy(() => import("./AcpMermaidDiagram"));

const MermaidBlock: React.FC<{ code: string }> = ({ code }) => (
  <div data-mermaid-block>
    <Suspense
      fallback={
        <div
          className="my-2 flex items-center gap-2 rounded-lg border border-border bg-background/60 px-3 py-4 text-xs text-muted-foreground"
          role="status"
        >
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
          <span className="animate-pulse">图表组件加载中…</span>
        </div>
      }
    >
      <AcpMermaidDiagram code={code} />
    </Suspense>
  </div>
);

const ReactPreviewBlock: React.FC<{ code: string }> = ({ code }) => (
  <Suspense
    fallback={
      <div className="my-2 p-3 text-xs text-muted-foreground animate-pulse border border-border rounded-lg bg-background/60">
        正在挂载沙箱组件…
      </div>
    }
  >
    <ReactArtifactCard code={code} template="react" />
  </Suspense>
);

const HtmlPreviewBlock: React.FC<{ code: string }> = ({ code }) => (
  <Suspense
    fallback={
      <div className="my-2 p-3 text-xs text-muted-foreground animate-pulse border border-border rounded-lg bg-background/60">
        正在挂载 HTML 沙箱…
      </div>
    }
  >
    <ReactArtifactCard code={code} template="html" />
  </Suspense>
);

const customByLanguage = {
  mermaid: { SyntaxHighlighter: MermaidBlock },
  "react-preview": { SyntaxHighlighter: ReactPreviewBlock },
  "tsx-preview": { SyntaxHighlighter: ReactPreviewBlock },
  "jsx-preview": { SyntaxHighlighter: ReactPreviewBlock },
  "html-preview": { SyntaxHighlighter: HtmlPreviewBlock },
  "ui-preview": { SyntaxHighlighter: ReactPreviewBlock },
};

const BASE_REMARK = [remarkGfm];
const BASE_REHYPE = [rehypeRaw];
const fencesOnly = (t: string) => closeOpenFences(t);

const AcpMarkdownContent = memo(() => {
  const components = useMemo(() => acpComponents, []);
  const byLanguage = useMemo(() => customByLanguage, []);
  const { smoothOptions } = useDeviceFps();
  const part = useMessagePartText();
  const text = part.text;
  /**
   * 打字机只在「这一 part 仍在生成」时启用。
   *
   * 轮次结束时 `convertAcpMessage` 会把正文收缩为结论（`partitionTurnContent` 把过程段落
   * 收进折叠区），正文不再是 displayedText 的前缀——此时若继续走 smooth，
   * `useSmooth` 会命中 `!text.startsWith(displayedText)` 并清空重打，用户看到的就是
   * 每轮结束时整段答案“消失再重新打一遍”。关闭 smooth 后收尾只发生一次结构变化，
   * 不会再有重打动画。
   */
  const smooth = process.env.NODE_ENV === "test" || part.status.type !== "running" ? false : smoothOptions;
  const math = useSyncExternalStore(subscribeMath, getMathPlugins, getMathPlugins);
  const needsMath = useMemo(() => hasMath(text), [text]);
  useEffect(() => {
    if (needsMath && !math) void loadMathPlugins();
  }, [needsMath, math]);
  const useMath = needsMath && !!math;
  const remarkPlugins = useMemo(() => (useMath ? [...BASE_REMARK, ...math!.remark] : BASE_REMARK), [useMath, math]);
  const rehypePlugins = useMemo(() => (useMath ? [rehypeRaw, ...math!.rehype] : BASE_REHYPE), [useMath, math]);
  const preprocess = useMemo(() => (useMath ? (t: string) => preprocessMarkdown(math!.preprocess(t)) : preprocessMarkdown), [useMath, math]);
  return (
    <MarkdownTextPrimitive
      defer={false}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      preprocess={preprocess}
      className="acp-md text-sm leading-relaxed break-words text-foreground"
      components={components}
      componentsByLanguage={byLanguage}
      smooth={smooth}
    />
  );
});

export const AcpMarkdownText: TextMessagePartComponent = memo(() => (
  <StableTextPart>
    <AcpMarkdownContent />
  </StableTextPart>
));

export interface AcpStandaloneMarkdownProps {
  content: string;
  className?: string;
}

const InPreContext = React.createContext(false);

const StandaloneCodeBlock: React.FC<{ language?: string; codeString: string }> = memo(({ language, codeString }) => {
  const isTree = useMemo(
    () => /([├└│─]|(?:^|\n)\s*[\w.-]+[/\\](\s*#|\s*$))/m.test(codeString),
    [codeString]
  );
  const [wrap, setWrap] = useState(isTree);
  const inferredLang = useMemo(() => inferCodeLanguage(language, codeString), [language, codeString]);
  const displayLang = language || (isTree ? "tree" : "");

  return (
    <div className="my-1.5 select-text">
      <AcpCodeHeader
        language={displayLang}
        code={codeString}
        wrap={wrap}
        onToggleWrap={() => setWrap((w) => !w)}
      />
      <AcpSyntaxHighlighter language={inferredLang} code={codeString} wrap={wrap} />
    </div>
  );
});

/**
 * 独立 Markdown 渲染器（用于工作台 Markdown 文件高亮预览、阶段推进记录折叠区、独立弹窗等无需 assistant-ui PartContext 的场景）。
 * 完整支持 GFM 表格、Shiki 高亮代码块、Mermaid 流程图、GitHub Alert 呼出框及安全 HTML 标签。
 */
export const AcpStandaloneMarkdown: React.FC<AcpStandaloneMarkdownProps> = memo(({ content, className }) => {
  const math = useSyncExternalStore(subscribeMath, getMathPlugins, getMathPlugins);
  const needsMath = useMemo(() => hasMath(content), [content]);
  useEffect(() => {
    if (needsMath && !math) void loadMathPlugins();
  }, [needsMath, math]);
  const useMath = needsMath && !!math;
  const remarkPlugins = useMemo(() => (useMath ? [...BASE_REMARK, ...math!.remark] : BASE_REMARK), [useMath, math]);
  const rehypePlugins = useMemo(() => (useMath ? [rehypeRaw, ...math!.rehype] : BASE_REHYPE), [useMath, math]);
  const processed = useMemo(() => (useMath ? preprocessMarkdown(math!.preprocess(content)) : preprocessMarkdown(content)), [useMath, math, content]);

  return (
    <div className={cn("acp-md text-xs leading-relaxed break-words text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          ...(acpComponents as any),
          pre: ({ children }: any) => (
            <InPreContext.Provider value={true}>
              {children}
            </InPreContext.Provider>
          ),
          code: function StandaloneCode({ className: codeClassName, children, ...props }: any) {
            const inPre = React.useContext(InPreContext);
            const match = /language-([-\w]+)/.exec(codeClassName || "");
            const codeString = String(children || "").replace(/\n$/, "");
            if (inPre || match) {
              const lang = match ? match[1] : "";
              if (lang.toLowerCase() === "mermaid") {
                return <MermaidBlock code={codeString} />;
              }
              return (
                <StandaloneCodeBlock language={lang} codeString={codeString} />
              );
            }
            return (
              <code className={cn("rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground", codeClassName)} {...props}>
                {children}
              </code>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
});

