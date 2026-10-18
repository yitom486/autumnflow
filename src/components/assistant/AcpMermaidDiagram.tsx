import React, { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";
import { cn } from "@/lib/utils";
import { Maximize2, ZoomIn, ZoomOut, RotateCcw, Copy, Check, X, SunMedium, Moon } from "lucide-react";
import { useLightboxViewport } from "@/hooks/useLightboxViewport";
import { useThemeStore, THEMES } from "@/stores/useThemeStore";
import { MermaidSvg, readMindmapBranch, type MindmapBranch } from "./MermaidSvg";

/**
 * Mermaid diagram renderer — lives behind React.lazy so the ~MB
 * mermaid+d3 dependency graph only loads when a mermaid fence appears.
 * Security: `securityLevel: "strict"` (DOMPurify-sanitized SVG, no scripts/
 * authored callbacks); local mindmap controls are attached after sanitization.
 * Errors fall back to the classic code fence, never a blank box.
 */
let lastMermaidTheme: string | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
function ensureInit(isDark: boolean) {
  const targetTheme = isDark ? "dark" : "default";
  if (lastMermaidTheme === targetTheme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: targetTheme,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  });
  lastMermaidTheme = targetTheme;
}

function renderDiagram(code: string, id: string, isDark: boolean) {
  // Mermaid configuration and diagram databases are shared. Keep parsing,
  // hierarchy capture and rendering together, including across themed cards.
  const result = renderQueue.then(async () => {
    ensureInit(isDark);
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(code);
    const db = diagram.db as { getMindmap?: () => unknown };
    const hierarchy = typeof db.getMindmap === "function" ? readMindmapBranch(db.getMindmap()) : null;
    return { ...await mermaid.render(id, code), hierarchy };
  });
  renderQueue = result.catch(() => undefined);
  return result;
}

interface MermaidLightboxProps {
  svg: string;
  code: string;
  isDark: boolean;
  onToggleTheme: () => void;
  onClose: () => void;
  tree: MindmapBranch | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
}

const MermaidLightbox: React.FC<MermaidLightboxProps> = ({
  svg,
  code,
  isDark,
  onToggleTheme,
  onClose,
  tree, collapsed, onToggle,
}) => {
  const { canvasRef, scale, setScale, position, isDragging, reset, pointerHandlers } = useLightboxViewport(onClose);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-background/95 backdrop-blur-md animate-fade-slide-in select-none"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid 图表放大预览"
    >
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/80 backdrop-blur-sm z-10 shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <span className="w-2 h-2 rounded-full bg-primary" />
          <span>Mermaid 架构流程图</span>
          <span className="text-[11px] text-muted-foreground font-mono hidden sm:inline">（滚轮缩放 · 拖拽平移）</span>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleTheme}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={isDark ? "切换为浅色主题 (当前: 深色)" : "切换为深色主题 (当前: 浅色)"}
          >
            {isDark ? <SunMedium className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-500" />}
          </button>
          <div className="w-[1px] h-4 bg-border mx-1" />
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(0.25, +(s - 0.25).toFixed(2)))}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="缩小 (-)"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs font-mono px-1.5 min-w-[48px] text-center text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(4, +(s + 0.25).toFixed(2)))}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="放大 (+)"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={reset}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="重置缩放与位置 (0)"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <div className="w-[1px] h-4 bg-border mx-1" />
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-muted text-xs text-muted-foreground hover:text-foreground transition-colors"
            title="复制 Mermaid 源码"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{copied ? "已复制" : "复制代码"}</span>
          </button>
          <div className="w-[1px] h-4 bg-border mx-1" />
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="关闭 (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 主画布视口 */}
      <div
        ref={canvasRef}
        data-lightbox-canvas
        className={cn(
          "flex-1 relative overflow-hidden overscroll-none touch-none flex items-center justify-center cursor-grab active:cursor-grabbing",
          isDragging && "cursor-grabbing"
        )}
        {...pointerHandlers}
        onDoubleClick={reset}
        onClick={(e) => e.stopPropagation()}
      >
        <MermaidSvg
          svg={svg} tree={tree} collapsed={collapsed} onToggle={onToggle}
          className={cn("select-none flex items-center justify-center p-8 max-w-none", isDragging ? "transition-none" : "transition-transform duration-75 ease-out")}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: "center center",
          }}
        />
      </div>
    </div>,
    document.body,
  );
};

export default function AcpMermaidDiagram({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tree, setTree] = useState<MindmapBranch | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => { setCollapsed(new Set()); }, [code]);
  const toggleBranch = (id: string) => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const appTheme = useThemeStore((s) => s.theme);
  const isAppDark = THEMES[appTheme]?.isDark ?? true;
  const [cardTheme, setCardTheme] = useState<"auto" | "light" | "dark">("auto");
  const effectiveIsDark = cardTheme === "auto" ? isAppDark : cardTheme === "dark";

  const handleToggleTheme = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCardTheme((prev) => {
      const currentDark = prev === "auto" ? isAppDark : prev === "dark";
      return currentDark ? "light" : "dark";
    });
  };

  const id = `aui-mmd-${rawId}-${effectiveIsDark ? "dark" : "light"}`;

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    renderDiagram(code, id, effectiveIsDark)
      .then(({ svg, hierarchy }) => {
        if (!cancelled) { setTree(hierarchy); setSvg(svg); }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code, id, effectiveIsDark]);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (error) {
    return (
      <div className="my-2">
        <div className="rounded-t-lg border border-b-0 border-border bg-background/80 px-3 py-1 font-mono text-[11px] text-warning">
          图表语法无法渲染，已回退为代码（{error.slice(0, 120)}）
        </div>
        <pre className="overflow-x-auto rounded-b-lg border border-border bg-background/80 px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className="my-2 flex items-center gap-2 rounded-lg border border-border bg-background/60 px-3 py-4 text-xs text-muted-foreground"
        role="status"
      >
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
        <span className="animate-pulse">图表渲染中…</span>
      </div>
    );
  }

  return (
    <>
      <div
        data-mermaid-diagram
        className="group/mmd relative my-2 overflow-hidden rounded-lg border border-border bg-background/60 p-3 hover:border-primary/40 transition-colors"
      >
        {tree && <div className="mb-2 pr-24 text-[11px] text-muted-foreground">点击带 + / − 标记的节点展开或折叠分支</div>}
        {/* 右上角快捷操作条 */}
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover/mmd:opacity-100 transition-opacity bg-card/90 border border-border/80 rounded-md p-0.5 shadow-sm z-10 backdrop-blur-xs">
          <button
            type="button"
            onClick={handleToggleTheme}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title={effectiveIsDark ? "切换为浅色主题 (当前: 深色)" : "切换为深色主题 (当前: 浅色)"}
          >
            {effectiveIsDark ? (
              <SunMedium className="w-3.5 h-3.5 text-amber-400" />
            ) : (
              <Moon className="w-3.5 h-3.5 text-indigo-500" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="放大查看 / 全屏预览"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="复制 Mermaid 源码"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>

        {/* 图表内容，点击可直接打开全屏弹窗 */}
        <MermaidSvg
          svg={svg} tree={tree} collapsed={collapsed} onToggle={toggleBranch}
          className="overflow-x-auto cursor-zoom-in [&_svg]:mx-auto [&_svg]:max-w-full [&_svg]:h-auto"
          onClick={() => setLightboxOpen(true)}
          title="点击放大查看"
        />
      </div>

      {lightboxOpen && (
        <MermaidLightbox
          svg={svg}
          code={code}
          isDark={effectiveIsDark}
          onToggleTheme={handleToggleTheme}
          onClose={() => setLightboxOpen(false)}
          tree={tree} collapsed={collapsed} onToggle={toggleBranch}
        />
      )}
    </>
  );
}
