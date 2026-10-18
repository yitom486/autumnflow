import React, { useState, useRef, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Maximize2,
  Minimize2,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Copy,
  Check,
  Download,
  Layers,
  ArrowRightLeft,
  GitCommit,
  Grid,
  Calendar,
  Sparkles,
  SunMedium,
  Moon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useThemeStore, THEMES } from "@/stores/useThemeStore";
import { branchControls, visibleFlowNodes, MindmapDiagramSvg, type DiagramFolding } from "./InteractiveDiagram";

export type DiagramType =
  | "mindmap"
  | "architecture"
  | "sequence"
  | "flowchart"
  | "quadrant"
  | "timeline";

export type AccentColor =
  | "emerald"
  | "blue"
  | "indigo"
  | "violet"
  | "amber"
  | "rose"
  | "cyan";

export interface EditorialDiagramCardProps {
  title: string;
  diagramType: DiagramType;
  description?: string;
  theme?: "light" | "dark" | "system";
  accent?: AccentColor;
  data: Record<string, any>;
}

// 1-Accent 聚焦配色方案字典
const ACCENT_MAP: Record<
  AccentColor,
  {
    border: string;
    bg: string;
    text: string;
    fill: string;
    stroke: string;
    dot: string;
  }
> = {
  emerald: {
    border: "border-emerald-500/60",
    bg: "bg-emerald-500/10",
    text: "text-emerald-500 dark:text-emerald-400",
    fill: "#10b981",
    stroke: "#10b981",
    dot: "bg-emerald-500",
  },
  blue: {
    border: "border-blue-500/60",
    bg: "bg-blue-500/10",
    text: "text-blue-500 dark:text-blue-400",
    fill: "#3b82f6",
    stroke: "#3b82f6",
    dot: "bg-blue-500",
  },
  indigo: {
    border: "border-indigo-500/60",
    bg: "bg-indigo-500/10",
    text: "text-indigo-500 dark:text-indigo-400",
    fill: "#6366f1",
    stroke: "#6366f1",
    dot: "bg-indigo-500",
  },
  violet: {
    border: "border-violet-500/60",
    bg: "bg-violet-500/10",
    text: "text-violet-500 dark:text-violet-400",
    fill: "#8b5cf6",
    stroke: "#8b5cf6",
    dot: "bg-violet-500",
  },
  amber: {
    border: "border-amber-500/60",
    bg: "bg-amber-500/10",
    text: "text-amber-500 dark:text-amber-400",
    fill: "#f59e0b",
    stroke: "#f59e0b",
    dot: "bg-amber-500",
  },
  rose: {
    border: "border-rose-500/60",
    bg: "bg-rose-500/10",
    text: "text-rose-500 dark:text-rose-400",
    fill: "#f43f5e",
    stroke: "#f43f5e",
    dot: "bg-rose-500",
  },
  cyan: {
    border: "border-cyan-500/60",
    bg: "bg-cyan-500/10",
    text: "text-cyan-500 dark:text-cyan-400",
    fill: "#06b6d4",
    stroke: "#06b6d4",
    dot: "bg-cyan-500",
  },
};

const DIAGRAM_TYPE_META: Record<
  DiagramType,
  { label: string; icon: React.FC<{ className?: string }> }
> = {
  architecture: { label: "系统架构分层", icon: Layers },
  mindmap: { label: "交互式思维导图", icon: Layers },
  sequence: { label: "交互时序图", icon: ArrowRightLeft },
  flowchart: { label: "流程与状态机", icon: GitCommit },
  quadrant: { label: "四象限决策矩阵", icon: Grid },
  timeline: { label: "演进里程碑", icon: Calendar },
};

export const EditorialDiagramCard: React.FC<EditorialDiagramCardProps> = ({
  title,
  diagramType,
  description,
  theme: preferredTheme,
  accent = "emerald",
  data,
}) => {
  const [zoom, setZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const sourceKey = JSON.stringify(data);
  useEffect(() => { setCollapsed(new Set()); }, [sourceKey, diagramType]);
  const folding: DiagramFolding = { collapsed, toggle: id => setCollapsed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }) };
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);

  const appTheme = useThemeStore((s) => s.theme);
  const isAppDark = THEMES[appTheme]?.isDark ?? true;
  const [cardTheme, setCardTheme] = useState<"auto" | "light" | "dark">(
    preferredTheme === "light" ? "light" : preferredTheme === "dark" ? "dark" : "auto"
  );
  const effectiveIsDark = cardTheme === "auto" ? isAppDark : cardTheme === "dark";

  const handleToggleTheme = () => {
    setCardTheme((prev) => {
      const currentDark = prev === "auto" ? isAppDark : prev === "dark";
      return currentDark ? "light" : "dark";
    });
  };

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    fullscreenButtonRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsFullscreen(false);
      } else if (event.key === "Tab") {
        const dialog = containerRef.current?.closest('[role="dialog"]');
        const buttons = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') || []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (buttons.length && (index < 0 || (event.shiftKey ? index === 0 : index === buttons.length - 1))) {
          event.preventDefault();
          buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
      requestAnimationFrame(() => fullscreenButtonRef.current?.focus());
    };
  }, [isFullscreen]);

  const accentStyles = ACCENT_MAP[accent] || ACCENT_MAP.emerald;
  const meta = DIAGRAM_TYPE_META[diagramType] || DIAGRAM_TYPE_META.architecture;
  const Icon = meta.icon;

  const handleCopySvg = () => {
    if (!containerRef.current) return;
    const svgEl = containerRef.current.querySelector("svg");
    if (!svgEl) return;
    navigator.clipboard.writeText(svgEl.outerHTML).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleDownloadSvg = () => {
    if (!containerRef.current) return;
    const svgEl = containerRef.current.querySelector("svg");
    if (!svgEl) return;
    const blob = new Blob([svgEl.outerHTML], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.toLowerCase().replace(/\s+/g, "-")}-${diagramType}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const card = (
    <div
      data-editorial-diagram={diagramType}
      role={isFullscreen ? "dialog" : undefined}
      aria-modal={isFullscreen ? true : undefined}
      aria-label={isFullscreen ? `${title} 全屏预览` : undefined}
      className={cn(
        "my-3.5 rounded-xl border border-border/70 overflow-hidden shadow-sm transition-all duration-200",
        effectiveIsDark ? "dark bg-card/95 text-card-foreground" : "light bg-card text-card-foreground shadow-xs",
        isFullscreen
          ? "fixed inset-4 z-[100] flex flex-col bg-background/95 backdrop-blur-md shadow-2xl border-border"
          : ""
      )}
    >
      {/* 顶部 Editorial Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b border-border/50 text-xs">
        <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
          <div className={cn("p-1 rounded-md shrink-0", accentStyles.bg)}>
            <Icon className={cn("w-3.5 h-3.5", accentStyles.text)} />
          </div>
          <span className="font-semibold text-foreground truncate min-w-0" title={title}>
            {title}
          </span>
          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono tracking-tight bg-secondary/80 text-muted-foreground border border-border/40 shrink-0 whitespace-nowrap">
            {meta.label}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono shrink-0 whitespace-nowrap">
            <Sparkles className="w-2.5 h-2.5 text-muted-foreground/70" />
            editorial
          </span>
        </div>

        {/* 交互工具条 */}
        <div className="flex items-center gap-1 text-muted-foreground">
          <button
            type="button"
            onClick={handleToggleTheme}
            className="p-1 rounded hover:text-foreground hover:bg-muted/80 transition-colors"
            title={effectiveIsDark ? "切换为浅色主题 (当前: 深色)" : "切换为深色主题 (当前: 浅色)"}
            aria-label={effectiveIsDark ? "切换为浅色主题" : "切换为深色主题"}
          >
            {effectiveIsDark ? (
              <SunMedium className="w-3.5 h-3.5 text-amber-400" />
            ) : (
              <Moon className="w-3.5 h-3.5 text-indigo-500" />
            )}
          </button>
          <div className="w-[1px] h-3 bg-border/60 mx-1" />
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(z + 0.15, 2.0))}
            className="p-1 rounded hover:text-foreground hover:bg-muted/80 transition-colors"
            title="放大"
            aria-label="放大"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(z - 0.15, 0.6))}
            className="p-1 rounded hover:text-foreground hover:bg-muted/80 transition-colors"
            title="缩小"
            aria-label="缩小"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          {zoom !== 1 && (
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="p-1 rounded hover:text-foreground hover:bg-muted/80 transition-colors text-[10px] font-mono"
              title="重置缩放"
              aria-label="重置缩放"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <div className="w-[1px] h-3 bg-border/60 mx-1" />
          <button
            type="button"
            onClick={handleCopySvg}
            className="p-1 rounded hover:text-foreground hover:bg-muted/80 transition-colors"
            title="复制 SVG 源码"
            aria-label="复制 SVG 源码"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={handleDownloadSvg}
            className="p-1 rounded hover:text-foreground hover:bg-muted/80 transition-colors"
            title="下载 SVG 矢量文件"
            aria-label="下载 SVG"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            ref={fullscreenButtonRef}
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-1 rounded hover:text-foreground hover:bg-muted/80 transition-colors"
            title={isFullscreen ? "退出全屏" : "全屏放大"}
            aria-label={isFullscreen ? "退出全屏" : "全屏放大"}
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {description && (
        <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border/30 bg-muted/10">
          {description}
        </div>
      )}

      {/* SVG 矢量图表画布区域 */}
      <div
        ref={containerRef}
        className={cn(
          "relative overflow-auto p-4 select-none transition-colors",
          effectiveIsDark ? "bg-background/95" : "bg-muted/15",
          isFullscreen ? "flex-1 min-h-[500px]" : "min-h-[280px]"
        )}
      >
        <div
          style={{
            transform: `scale(${zoom})`,
            transformOrigin: "top center",
            transition: "transform 0.15s ease-out",
          }}
          className="w-fit min-w-full flex justify-center py-1 mx-auto"
        >
          {diagramType === "architecture" && (
            <ArchitectureDiagramSvg data={data} accent={accent} isDark={effectiveIsDark} folding={folding} />
          )}
          {diagramType === "sequence" && (
            <SequenceDiagramSvg data={data} accent={accent} isDark={effectiveIsDark} />
          )}
          {diagramType === "flowchart" && (
            <FlowchartDiagramSvg data={data} accent={accent} isDark={effectiveIsDark} folding={folding} />
          )}
          {diagramType === "mindmap" && <MindmapDiagramSvg data={data} color={accentStyles.stroke} isDark={effectiveIsDark} folding={folding} />}
          {diagramType === "quadrant" && (
            <QuadrantDiagramSvg data={data} accent={accent} isDark={effectiveIsDark} />
          )}
          {diagramType === "timeline" && (
            <TimelineDiagramSvg data={data} accent={accent} isDark={effectiveIsDark} />
          )}
        </div>
      </div>
    </div>
  );
  // Chat turns may create transformed/contained stacking contexts. Fullscreen
  // must escape them so the app header cannot cover its exit button.
  return isFullscreen ? createPortal(card, document.body) : card;
};

// =============================================================================
// 1. Architecture Diagram (分层系统架构与容器拓扑)
// =============================================================================
function ArchitectureDiagramSvg({
  data,
  accent,
  isDark = true,
  folding,
}: {
  data: Record<string, any>;
  accent: AccentColor;
  isDark?: boolean;
  folding: DiagramFolding;
}) {
  const accentStyles = ACCENT_MAP[accent] || ACCENT_MAP.emerald;
  const layers = Array.isArray(data.layers) ? data.layers : [];
  const connections = Array.isArray(data.connections) ? data.connections : [];

  const layerHeight = 94;
  const gap = 34;
  const topPad = 24;
  const layerX = 30;
  const layerWidth = 580;
  const layerCenterX = layerX + layerWidth / 2; // 严格居中于 320

  type Endpoint = {
    type: "node" | "layer";
    layerIdx: number;
    nodeIdx?: number;
    centerX: number;
    topY: number;
    bottomY: number;
    leftX: number;
    rightX: number;
    layerTopY: number;
    layerBottomY: number;
    name: string;
  };
  const endpointMap = new Map<string, Endpoint>();

  // 计算节点卡片的对称几何排布，杜绝不对称左偏，并在2节点时严格开辟中央走廊
  const getNodeGeometry = (count: number, index: number) => {
    if (count <= 1) {
      const w = 320;
      const x = layerCenterX - w / 2; // 160
      return { x, width: w, centerX: layerCenterX };
    }
    if (count === 2) {
      // 严格在中心保留 60px 的中央直行通道 [290, 350]，中轴垂线 x=320 拥有左右各 30px 的安全净空
      const cardWidth = 244;
      if (index === 0) {
        return { x: 46, width: cardWidth, centerX: 46 + cardWidth / 2 }; // [46, 290], center = 168
      } else {
        return { x: 350, width: cardWidth, centerX: 350 + cardWidth / 2 }; // [350, 594], center = 472
      }
    }
    if (count === 3) {
      // 3个节点：中央节点严格居中于 320，两侧节点对称
      const cardWidth = 172;
      const cardGap = 16;
      const x = 46 + index * (cardWidth + cardGap);
      return { x, width: cardWidth, centerX: x + cardWidth / 2 };
    }
    // 4个及以上节点：等宽对称排布
    const cardGap = 12;
    const cardWidth = Math.max(
      Math.floor((548 - (count - 1) * cardGap) / count),
      110
    );
    const x = 46 + index * (cardWidth + cardGap);
    return { x, width: cardWidth, centerX: x + cardWidth / 2 };
  };

  // 1. 预先构建所有分层与节点的几何坐标索引
  layers.forEach((layer: any, layerIdx: number) => {
    const ly = topPad + layerIdx * (layerHeight + gap);
    const lEndpoint: Endpoint = {
      type: "layer",
      layerIdx,
      centerX: layerCenterX,
      topY: ly,
      bottomY: ly + layerHeight,
      leftX: layerX,
      rightX: layerX + layerWidth,
      layerTopY: ly,
      layerBottomY: ly + layerHeight,
      name: String(layer.title || layer.name || layer.id || `Layer ${layerIdx + 1}`),
    };
    if (layer.id) endpointMap.set(String(layer.id).trim().toLowerCase(), lEndpoint);
    if (layer.title) endpointMap.set(String(layer.title).trim().toLowerCase(), lEndpoint);
    if (layer.name) endpointMap.set(String(layer.name).trim().toLowerCase(), lEndpoint);
    endpointMap.set(`layer-${layerIdx}`, lEndpoint);

    const nodes = Array.isArray(layer.nodes) ? layer.nodes : [];
    nodes.forEach((node: any, nodeIdx: number) => {
      const geo = getNodeGeometry(nodes.length, nodeIdx);
      const ny = ly + 28;
      const nEndpoint: Endpoint = {
        type: "node",
        layerIdx,
        nodeIdx,
        centerX: geo.centerX,
        topY: ny,
        bottomY: ny + 50,
        leftX: geo.x,
        rightX: geo.x + geo.width,
        layerTopY: ly,
        layerBottomY: ly + layerHeight,
        name: String(node.label || node.title || node.id || `Node ${nodeIdx + 1}`),
      };
      if (node.id) endpointMap.set(String(node.id).trim().toLowerCase(), nEndpoint);
      if (node.label) endpointMap.set(String(node.label).trim().toLowerCase(), nEndpoint);
      if (node.title) endpointMap.set(String(node.title).trim().toLowerCase(), nEndpoint);
      endpointMap.set(`node-${layerIdx}-${nodeIdx}`, nEndpoint);
    });
  });

  // 端点智能模糊匹配（Token & Substring Match），兼容自然语言/局部标题连线
  const resolveEndpoint = (rawKey: any): Endpoint | undefined => {
    if (rawKey === undefined || rawKey === null) return undefined;
    const key = String(rawKey).trim().toLowerCase();
    if (!key) return undefined;

    if (endpointMap.has(key)) return endpointMap.get(key);

    const cleanKey = key.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "");
    if (cleanKey && endpointMap.has(cleanKey)) return endpointMap.get(cleanKey);

    for (const [mapKey, ep] of endpointMap.entries()) {
      if (mapKey.length >= 2 && (mapKey.includes(key) || key.includes(mapKey))) {
        return ep;
      }
    }

    for (let lIdx = 0; lIdx < layers.length; lIdx++) {
      const l = layers[lIdx];
      const lTitle = String(l.title || l.name || l.id || "").toLowerCase();
      if (lTitle && (lTitle.includes(key) || key.includes(lTitle))) {
        return endpointMap.get(`layer-${lIdx}`);
      }
      const nodes = Array.isArray(l.nodes) ? l.nodes : [];
      for (let nIdx = 0; nIdx < nodes.length; nIdx++) {
        const n = nodes[nIdx];
        const nLabel = String(n.label || n.title || n.id || "").toLowerCase();
        if (nLabel && (nLabel.includes(key) || key.includes(nLabel))) {
          return endpointMap.get(`node-${lIdx}-${nIdx}`);
        }
      }
    }
    return undefined;
  };

  // 2. 解析与分类所有有效连线
  const parsedConnections = connections
    .map((conn: any, idx: number) => {
      const fromEp = resolveEndpoint(conn.from);
      const toEp = resolveEndpoint(conn.to);
      return { conn, idx, fromEp, toEp };
    })
    .filter(
      (
        item
      ): item is {
        conn: any;
        idx: number;
        fromEp: Endpoint;
        toEp: Endpoint;
      } => Boolean(item.fromEp && item.toEp)
    );

  const crossLayerConnections = parsedConnections.filter(
    (item) => Math.abs(item.toEp.layerIdx - item.fromEp.layerIdx) > 1
  );

  const hasCrossConnections = crossLayerConnections.length > 0;
  const bypassRailWidth = hasCrossConnections
    ? Math.min(crossLayerConnections.length * 36 + 60, 140)
    : 0;
  const width = 640 + bypassRailWidth;
  const totalHeight = Math.max(
    layers.length * (layerHeight + gap) + topPad + 30,
    280
  );

  // 统计相邻层对之间的层级间连线数，杜绝连线堆叠
  const adjacentTierCounts = new Map<string, number>();
  const adjacentTierIndices = new Map<number, number>();

  parsedConnections.forEach((item) => {
    if (
      Math.abs(item.toEp.layerIdx - item.fromEp.layerIdx) === 1 &&
      item.fromEp.type === "layer" &&
      item.toEp.type === "layer"
    ) {
      const key = `${Math.min(item.fromEp.layerIdx, item.toEp.layerIdx)}->${Math.max(
        item.fromEp.layerIdx,
        item.toEp.layerIdx
      )}`;
      const currentCount = adjacentTierCounts.get(key) || 0;
      adjacentTierIndices.set(item.idx, currentCount);
      adjacentTierCounts.set(key, currentCount + 1);
    }
  });

  return (
    <svg
      viewBox={`0 0 ${width} ${totalHeight}`}
      style={{ maxWidth: `${width}px` }}
      className="w-full h-auto font-sans"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <marker
          id={`arrow-${accent}`}
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 8 5 L 0 9 z" fill={accentStyles.fill} />
        </marker>
        <marker
          id="arrow-neutral"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 8 5 L 0 9 z" fill={isDark ? "#64748b" : "#94a3b8"} />
        </marker>
      </defs>

      {/* 渲染各层容器底框与内部节点卡片 */}
      {layers.map((layer: any, layerIdx: number) => {
        const y = topPad + layerIdx * (layerHeight + gap);
        const nodes = Array.isArray(layer.nodes) ? layer.nodes : [];

        return (
          <g key={layer.id || layerIdx} transform={`translate(0, ${y})`}>
            {/* 分层容器底框 */}
            <rect
              x={layerX}
              y="0"
              width={layerWidth}
              height={layerHeight}
              rx="10"
              fill={isDark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.02)"}
              stroke={isDark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.12)"}
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            {/* 层级名称 */}
            <text
              x={layerX + 14}
              y="20"
              fill={isDark ? "#94a3b8" : "#475569"}
              className="text-[11px] font-mono font-semibold uppercase tracking-wider select-none"
            >
              {layer.title || layer.name || `Layer ${layerIdx + 1}`}
            </text>

            {/* 容器内的节点卡片 */}
            {nodes.length > 0 && <g {...branchControls(`layer:${layerIdx}`, String(layer.title || layer.name || `Layer ${layerIdx + 1}`), folding)}>
              <rect x="490" y="3" width="110" height="24" rx="5" fill={isDark ? "#181e28" : "#ffffff"} stroke={accentStyles.stroke} />
              <text x="545" y="19" textAnchor="middle" fontSize="11" fill={isDark ? "#f8fafc" : "#0f172a"}>{folding.collapsed.has(`layer:${layerIdx}`) ? `＋ 展开 ${nodes.length} 个节点` : "− 折叠节点"}</text>
            </g>}
            {!folding.collapsed.has(`layer:${layerIdx}`) && nodes.map((node: any, nodeIdx: number) => {
              const geo = getNodeGeometry(nodes.length, nodeIdx);
              const ny = 28;
              const isHighlighted = Boolean(node.highlighted || node.focus);

              return (
                <g key={node.id || nodeIdx} transform={`translate(${geo.x}, ${ny})`}>
                  <rect
                    x="0"
                    y="0"
                    width={geo.width}
                    height="50"
                    rx="7"
                    fill={isDark ? "#181e28" : "#ffffff"}
                    stroke={
                      isHighlighted
                        ? accentStyles.stroke
                        : isDark
                          ? "rgba(255, 255, 255, 0.12)"
                          : "#cbd5e1"
                    }
                    strokeWidth={isHighlighted ? 1.5 : 1}
                  />
                  {/* 使用 foreignObject 承载自适应排版，带 ellipsis 截断与悬停气泡 */}
                  <foreignObject x="0" y="0" width={geo.width} height="50">
                    <div
                      className="w-full h-full px-3 py-1 flex flex-col justify-center select-none overflow-hidden"
                      title={`${node.label || node.title || ""}${node.subtext ? ` — ${node.subtext}` : ""}`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span
                          className={cn(
                            "text-[12px] font-semibold truncate leading-snug",
                            isDark ? "text-slate-100" : "text-slate-900"
                          )}
                        >
                          {node.label || node.title}
                        </span>
                        {isHighlighted && (
                          <span
                            className="w-1.5 h-1.5 rounded-full shrink-0"
                            style={{ backgroundColor: accentStyles.fill }}
                          />
                        )}
                      </div>
                      {(node.subtext || node.type || node.badge) && (
                        <div
                          className={cn(
                            "text-[10px] font-mono truncate leading-snug mt-0.5",
                            isDark ? "text-slate-400" : "text-slate-500"
                          )}
                        >
                          {node.subtext || node.type || node.badge}
                        </div>
                      )}
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </g>
        );
      })}

      {/* 精准层间 / 节点间连接线：支持居中对齐中轴、外侧旁路防穿透轨道以及标签气泡衬底 */}
      {parsedConnections.map(({ conn, idx, fromEp, toEp }) => {
        if ((fromEp.type === "node" && folding.collapsed.has(`layer:${fromEp.layerIdx}`)) ||
            (toEp.type === "node" && folding.collapsed.has(`layer:${toEp.layerIdx}`))) return null;
        const isSameLayer = fromEp.layerIdx === toEp.layerIdx;
        const isCrossLayer = Math.abs(toEp.layerIdx - fromEp.layerIdx) > 1;
        const isDownward = toEp.layerIdx >= fromEp.layerIdx;

        let pathD = "";
        let midX = 0;
        let midY = 0;

        if (isSameLayer) {
          if (fromEp.type === "node" && toEp.type === "node") {
            const isLeftToRight = fromEp.centerX < toEp.centerX;
            const startX = isLeftToRight ? fromEp.rightX : fromEp.leftX;
            const endX = isLeftToRight ? toEp.leftX : toEp.rightX;
            const y = (fromEp.topY + fromEp.bottomY) / 2;
            pathD = `M ${startX} ${y} L ${endX} ${y}`;
            midX = (startX + endX) / 2;
            midY = y;
          } else {
            return null;
          }
        } else if (isCrossLayer) {
          // 跨层连线：沿外侧专用旁路轨道（Bypass Rail）平滑引出与接入，绝不穿透中间层！
          const crossIdx = crossLayerConnections.findIndex((c) => c.idx === idx);
          const bypassRailX = layerX + layerWidth + 24 + crossIdx * 36;
          const startX = layerX + layerWidth;
          const startY = isDownward
            ? fromEp.layerBottomY - 18
            : fromEp.layerTopY + 18;
          const endX = layerX + layerWidth;
          const endY = isDownward
            ? toEp.layerTopY + 18
            : toEp.layerBottomY - 18;

          pathD = `M ${startX} ${startY} C ${startX + 20} ${startY}, ${bypassRailX} ${
            startY + (isDownward ? 14 : -14)
          }, ${bypassRailX} ${startY + (isDownward ? 26 : -26)} L ${bypassRailX} ${
            endY - (isDownward ? 26 : -26)
          } C ${bypassRailX} ${endY - (isDownward ? 14 : -14)}, ${endX + 20} ${endY}, ${endX} ${endY}`;

          midX = bypassRailX;
          midY = (startY + endY) / 2;
        } else {
          // 相邻层连线：严格使用中央通廊与层间 gap 渲染
          if (fromEp.type === "layer" && toEp.type === "layer") {
            const key = `${Math.min(fromEp.layerIdx, toEp.layerIdx)}->${Math.max(
              fromEp.layerIdx,
              toEp.layerIdx
            )}`;
            const count = adjacentTierCounts.get(key) || 1;
            const localIdx = adjacentTierIndices.get(idx) || 0;
            const offset = count > 1 ? (localIdx - (count - 1) / 2) * 56 : 0;

            const startX = layerCenterX + offset;
            const endX = layerCenterX + offset;
            const startY = isDownward ? fromEp.layerBottomY : fromEp.layerTopY;
            const endY = isDownward ? toEp.layerTopY : toEp.layerBottomY;

            pathD = `M ${startX} ${startY} L ${endX} ${endY}`;
            midX = startX;
            midY = (startY + endY) / 2;
          } else {
            const startX = fromEp.centerX;
            const startY = isDownward ? fromEp.bottomY : fromEp.topY;
            const endX = toEp.centerX;
            const endY = isDownward ? toEp.topY : toEp.bottomY;

            midX = (startX + endX) / 2;
            midY = isDownward
              ? (fromEp.layerBottomY + toEp.layerTopY) / 2
              : (fromEp.layerTopY + toEp.layerBottomY) / 2;

            const isStraight = Math.abs(startX - endX) < 4;
            pathD = isStraight
              ? `M ${startX} ${startY} L ${endX} ${endY}`
              : `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
          }
        }

        const isHighlighted = Boolean(conn.highlighted);
        const strokeColor = isHighlighted
          ? accentStyles.stroke
          : isDark
            ? "#64748b"
            : "#94a3b8";
        const labelText = typeof conn.label === "string" ? conn.label.trim() : "";
        const labelWidth = labelText ? Math.max(labelText.length * 11 + 16, 28) : 0;

        return (
          <g key={idx}>
            <path
              d={pathD}
              fill="none"
              stroke={strokeColor}
              strokeWidth={isHighlighted ? 1.5 : 1}
              strokeDasharray={conn.dashed ? "3 3" : undefined}
              markerEnd={
                isHighlighted ? `url(#arrow-${accent})` : "url(#arrow-neutral)"
              }
            />
            {labelText && (
              <g transform={`translate(${midX}, ${midY})`}>
                <rect
                  x={-labelWidth / 2}
                  y={-9}
                  width={labelWidth}
                  height={18}
                  rx="4"
                  fill={isDark ? "#1e293b" : "#ffffff"}
                  stroke={
                    isHighlighted
                      ? accentStyles.stroke
                      : isDark
                        ? "rgba(255, 255, 255, 0.18)"
                        : "#cbd5e1"
                  }
                  strokeWidth="0.8"
                />
                <text
                  x="0"
                  y="3.5"
                  textAnchor="middle"
                  fill={
                    isHighlighted
                      ? accentStyles.stroke
                      : isDark
                        ? "#e2e8f0"
                        : "#334155"
                  }
                  className="text-[10px] font-mono select-none"
                >
                  {labelText}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// =============================================================================
// 2. Sequence Diagram (交互时序图)
// =============================================================================
function SequenceDiagramSvg({
  data,
  accent,
  isDark = true,
}: {
  data: Record<string, any>;
  accent: AccentColor;
  isDark?: boolean;
}) {
  const accentStyles = ACCENT_MAP[accent] || ACCENT_MAP.emerald;
  const messages: any[] = Array.isArray(data.messages)
    ? data.messages
    : Array.isArray(data.steps)
      ? data.steps
      : [];

  const participants: any[] = useMemo(() => {
    if (Array.isArray(data.participants) && data.participants.length > 0) {
      return data.participants;
    }
    const set = new Set<string>();
    for (const m of messages) {
      const src = m.from ?? m.source ?? m.fromParticipant;
      const tgt = m.to ?? m.target ?? m.toParticipant;
      if (src) set.add(String(src));
      if (tgt) set.add(String(tgt));
    }
    if (set.size > 0) {
      return Array.from(set).map((name) => ({ id: name, label: name }));
    }
    return [
      { id: "Client", label: "Client" },
      { id: "Server", label: "Server" },
    ];
  }, [data.participants, messages]);

  const pCount = Math.max(participants.length, 2);
  // 根据参与者名称长度自适应列宽与卡片宽度，避免固定 120px 导致较长角色文本溢出
  const maxLabelLen = Math.max(
    ...participants.map((p: any) => String(p.label || p.name || p.id || "").length),
    6
  );
  const neededBoxWidth = Math.max(maxLabelLen * 8.5 + 24, 110);
  const colWidth = Math.max(neededBoxWidth + 24, 160);
  const width = Math.max(pCount * colWidth + 80, 640);
  const rowHeight = 44;
  const headerHeight = 46;
  const totalHeight = headerHeight + Math.max(messages.length, 1) * rowHeight + 40;

  const getColX = (idOrIndex: string | number) => {
    let idx = typeof idOrIndex === "number" ? idOrIndex : -1;
    if (idx === -1) {
      const str = String(idOrIndex || "").trim().toLowerCase();
      idx = participants.findIndex(
        (p: any) =>
          p.id === idOrIndex ||
          p.name === idOrIndex ||
          p.label === idOrIndex ||
          String(p.id || "").toLowerCase() === str ||
          String(p.label || "").toLowerCase() === str ||
          String(p.name || "").toLowerCase() === str
      );
    }
    if (idx === -1) idx = 0;
    return 40 + idx * colWidth + colWidth / 2;
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${totalHeight}`}
      style={{ maxWidth: `${width}px` }}
      className="w-full h-auto font-sans"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <marker
          id={`seq-arrow-${accent}`}
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 8 5 L 0 9 z" fill={accentStyles.fill} />
        </marker>
        <marker
          id="seq-arrow-default"
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 8 5 L 0 9 z" fill={isDark ? "#64748b" : "#94a3b8"} />
        </marker>
      </defs>

      {/* 参与者顶栏及垂直虚线生命线 */}
      {participants.map((p: any, idx: number) => {
        const x = getColX(idx);
        const labelStr = String(p.label || p.name || `Actor ${idx + 1}`);
        const itemBoxWidth = Math.min(colWidth - 16, Math.max(labelStr.length * 8.5 + 24, 100));

        return (
          <g key={p.id || idx}>
            {/* 垂直生命线 */}
            <line
              x1={x}
              y1={headerHeight}
              x2={x}
              y2={totalHeight - 20}
              stroke={isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.15)"}
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            {/* 顶栏卡片 */}
            <rect
              x={x - itemBoxWidth / 2}
              y="8"
              width={itemBoxWidth}
              height="30"
              rx="6"
              fill={isDark ? "#181e28" : "#ffffff"}
              stroke={isDark ? "rgba(255, 255, 255, 0.15)" : "#cbd5e1"}
              strokeWidth="1"
            />
            <text
              x={x}
              y="27"
              textAnchor="middle"
              fill={isDark ? "#f8fafc" : "#0f172a"}
              className="text-[12px] font-semibold select-none"
            >
              {labelStr}
            </text>
          </g>
        );
      })}

      {/* 时序交互消息箭头 */}
      {messages.map((m: any, mIdx: number) => {
        const y = headerHeight + (mIdx + 1) * rowHeight - 8;
        const fromId = m.from ?? m.source ?? m.fromParticipant ?? 0;
        const toId = m.to ?? m.target ?? m.toParticipant ?? Math.min(1, participants.length - 1);
        const x1 = getColX(fromId);
        const x2 = getColX(toId);
        const isSelf = Math.abs(x1 - x2) < 4;
        const isReply = m.type === "reply" || m.dashed;
        const isHighlighted = Boolean(m.highlighted);

        return (
          <g key={mIdx}>
            {isSelf ? (
              <path
                d={`M ${x1} ${y - 6} C ${x1 + 40} ${y - 12}, ${x1 + 40} ${y + 12}, ${x1 + 4} ${y + 6}`}
                fill="none"
                stroke={isHighlighted ? accentStyles.stroke : isDark ? "#64748b" : "#94a3b8"}
                strokeWidth={isHighlighted ? 1.5 : 1}
                markerEnd={
                  isHighlighted
                    ? `url(#seq-arrow-${accent})`
                    : "url(#seq-arrow-default)"
                }
              />
            ) : (
              <line
                x1={x1}
                y1={y}
                x2={x2}
                y2={y}
                stroke={isHighlighted ? accentStyles.stroke : isDark ? "#64748b" : "#94a3b8"}
                strokeWidth={isHighlighted ? 1.5 : 1}
                strokeDasharray={isReply ? "3 3" : undefined}
                markerEnd={
                  isHighlighted
                    ? `url(#seq-arrow-${accent})`
                    : "url(#seq-arrow-default)"
                }
              />
            )}
            {/* 消息文字说明 */}
            <text
              x={(x1 + x2) / 2 + (isSelf ? 28 : 0)}
              y={y - 6}
              textAnchor="middle"
              fill={isHighlighted ? accentStyles.stroke : isDark ? "#e2e8f0" : "#1e293b"}
              className={`text-[11px] font-mono ${isHighlighted ? "font-semibold" : ""}`}
            >
              {m.label || m.text || m.name || m.title || `Step ${mIdx + 1}`}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// =============================================================================
// 3. Flowchart & State Machine (流程与状态机)
// =============================================================================
function FlowchartDiagramSvg({
  data,
  accent,
  isDark = true,
  folding,
}: {
  data: Record<string, any>;
  accent: AccentColor;
  isDark?: boolean;
  folding: DiagramFolding;
}) {
  const accentStyles = ACCENT_MAP[accent] || ACCENT_MAP.emerald;
  const steps: any[] = Array.isArray(data.steps)
    ? data.steps
    : Array.isArray(data.nodes)
      ? data.nodes
      : [];
  const rawConns: any[] = Array.isArray(data.connections)
    ? data.connections
    : Array.isArray(data.edges)
      ? data.edges
      : [];

  const connections = useMemo(() => {
    if (rawConns.length > 0) return rawConns;
    if (steps.length > 1) {
      return steps.slice(0, -1).map((s, i) => ({
        from: s.id ?? i,
        to: steps[i + 1].id ?? i + 1,
      }));
    }
    return [];
  }, [rawConns, steps]);

  const indexOf = (id: unknown) => steps.findIndex((step, i) => step.id === id || i === id);
  const edges: Array<[number, number]> = connections.map(conn => [indexOf(conn.from ?? conn.source), indexOf(conn.to ?? conn.target)] as [number, number])
    .filter(([from, to]) => from >= 0 && to >= 0);
  const visible = visibleFlowNodes(steps.length, edges, folding.collapsed);

  const width = 640;
  const cardWidth = 140;
  const cardHeight = 56;
  const cols = Math.min(Math.max(steps.length, 1), 3);
  const rows = Math.max(Math.ceil(steps.length / 3), 1);
  const totalHeight = Math.max(rows * 110 + 40, 240);

  const getStepCoord = (idx: number) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const colGap = (width - 60 - cols * cardWidth) / (cols > 1 ? cols - 1 : 1);
    const x = 30 + col * (cardWidth + colGap);
    const y = 30 + row * 110;
    return { x, y };
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${totalHeight}`}
      className="w-full max-w-[640px] h-auto font-sans"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <marker
          id={`flow-arrow-${accent}`}
          viewBox="0 0 10 10"
          refX="6"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 8 5 L 0 9 z" fill={accentStyles.fill} />
        </marker>
      </defs>

      {/* 渲染步骤连线 */}
      {connections.map((conn: any, idx: number) => {
        const fromId = conn.from ?? conn.source;
        const toId = conn.to ?? conn.target;
        const fromIdx = steps.findIndex((s: any, i: number) => s.id === fromId || i === fromId);
        const toIdx = steps.findIndex((s: any, i: number) => s.id === toId || i === toId);
        if (!visible.has(fromIdx) || !visible.has(toIdx) || folding.collapsed.has(`step:${fromIdx}`)) return null;
        if (fromIdx >= 0 && toIdx >= 0) {
          const s1 = getStepCoord(fromIdx);
          const s2 = getStepCoord(toIdx);
          const x1 = s1.x + cardWidth / 2;
          const y1 = s1.y + cardHeight / 2;
          const x2 = s2.x + cardWidth / 2;
          const y2 = s2.y + cardHeight / 2;

          return (
            <line
              key={idx}
              data-flow-edge={`${fromIdx}:${toIdx}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={isDark ? "#64748b" : "#94a3b8"}
              strokeWidth="1"
              markerEnd={`url(#flow-arrow-${accent})`}
            />
          );
        }
        return null;
      })}

      {/* 渲染各步骤卡片 */}
      {steps.map((step: any, idx: number) => {
        if (!visible.has(idx)) return null;
        const { x, y } = getStepCoord(idx);
        const isCurrent = Boolean(step.isCurrent || step.active || step.highlighted);

        return (
          <g key={step.id || idx} transform={`translate(${x}, ${y})`}
            data-flow-node={String(step.id ?? idx)}
            {...(edges.some(([from]) => from === idx) ? branchControls(`step:${idx}`, String(step.label || step.name || `Step ${idx + 1}`), folding) : {})}>
            <rect
              x="0"
              y="0"
              width={cardWidth}
              height={cardHeight}
              rx="8"
              fill={
                isCurrent
                  ? isDark
                    ? "rgba(16, 185, 129, 0.15)"
                    : "rgba(16, 185, 129, 0.1)"
                  : isDark
                    ? "#181e28"
                    : "#ffffff"
              }
              stroke={isCurrent ? accentStyles.stroke : isDark ? "rgba(255, 255, 255, 0.15)" : "#cbd5e1"}
              strokeWidth={isCurrent ? 1.5 : 1}
            />
            <text
              x="12"
              y="22"
              fill={isDark ? "#f8fafc" : "#0f172a"}
              className="text-[12px] font-semibold"
            >
              {step.label || step.name || `Step ${idx + 1}`}
            </text>
            <text
              x="12"
              y="40"
              fill={isDark ? "#94a3b8" : "#64748b"}
              className="text-[10px] font-mono truncate"
            >
              {step.description || step.status || ""}
            </text>
            {isCurrent && (
              <circle
                cx={cardWidth - 12}
                cy="12"
                r="3.5"
                fill={accentStyles.fill}
              />
            )}
            {edges.some(([from]) => from === idx) && <text aria-hidden="true" x={cardWidth - 13} y="45" fill={accentStyles.fill} fontSize="16">{folding.collapsed.has(`step:${idx}`) ? "+" : "−"}</text>}
          </g>
        );
      })}
    </svg>
  );
}

// =============================================================================
// 4. Quadrant Matrix (四象限决策与技术选型矩阵)
// =============================================================================
function QuadrantDiagramSvg({
  data,
  accent,
  isDark = true,
}: {
  data: Record<string, any>;
  accent: AccentColor;
  isDark?: boolean;
}) {
  const accentStyles = ACCENT_MAP[accent] || ACCENT_MAP.emerald;
  const xAxis = data.xAxis || { label: "Effort", low: "Low Effort", high: "High Effort" };
  const yAxis = data.yAxis || { label: "Impact", low: "Low Impact", high: "High Impact" };
  const items = Array.isArray(data.items) ? data.items : [];

  const width = 640;
  const height = 360;
  const midX = width / 2;
  const midY = height / 2;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full max-w-[640px] h-auto font-sans"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 四象限底色分区 */}
      {/* Q1: 右上 (High X, High Y) */}
      <rect
        x={midX}
        y="20"
        width={midX - 20}
        height={midY - 20}
        fill={isDark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.02)"}
      />
      {/* Q2: 左上 (Low X, High Y) -> 重点推荐聚焦象限 */}
      <rect
        x="20"
        y="20"
        width={midX - 20}
        height={midY - 20}
        fill={isDark ? "rgba(16, 185, 129, 0.1)" : "rgba(16, 185, 129, 0.06)"}
      />
      {/* Q3: 左下 (Low X, Low Y) */}
      <rect
        x="20"
        y={midY}
        width={midX - 20}
        height={midY - 20}
        fill={isDark ? "rgba(255, 255, 255, 0.01)" : "rgba(0, 0, 0, 0.01)"}
      />
      {/* Q4: 右下 (High X, Low Y) */}
      <rect
        x={midX}
        y={midY}
        width={midX - 20}
        height={midY - 20}
        fill={isDark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.02)"}
      />

      {/* 十字坐标轴 */}
      <line
        x1="20"
        y1={midY}
        x2={width - 20}
        y2={midY}
        stroke={isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.15)"}
        strokeWidth="1.5"
      />
      <line
        x1={midX}
        y1="20"
        x2={midX}
        y2={height - 20}
        stroke={isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.15)"}
        strokeWidth="1.5"
      />

      {/* 轴标签 */}
      <text
        x="30"
        y={midY - 6}
        fill={isDark ? "#94a3b8" : "#64748b"}
        className="text-[10px] font-mono uppercase"
      >
        ← {xAxis.low || "Low"}
      </text>
      <text
        x={width - 30}
        y={midY - 6}
        textAnchor="end"
        fill={isDark ? "#94a3b8" : "#64748b"}
        className="text-[10px] font-mono uppercase"
      >
        {xAxis.high || "High"} →
      </text>
      <text
        x={midX + 6}
        y="32"
        fill={isDark ? "#94a3b8" : "#64748b"}
        className="text-[10px] font-mono uppercase"
      >
        ↑ {yAxis.high || "High"}
      </text>
      <text
        x={midX + 6}
        y={height - 26}
        fill={isDark ? "#94a3b8" : "#64748b"}
        className="text-[10px] font-mono uppercase"
      >
        ↓ {yAxis.low || "Low"}
      </text>

      {/* 象限内卡片元素 */}
      {items.map((item: any, idx: number) => {
        // quadrant 1: top-right, 2: top-left (quick wins), 3: bottom-left, 4: bottom-right
        const q = Number(item.quadrant || (item.x > 0.5 ? (item.y > 0.5 ? 1 : 4) : item.y > 0.5 ? 2 : 3));
        const baseX = q === 1 || q === 4 ? midX + 30 : 40;
        const baseY = q === 1 || q === 2 ? 40 : midY + 20;
        const isHighlighted = Boolean(item.highlighted || q === 2);

        const cardX = baseX + (idx % 2) * 120;
        const cardY = baseY + Math.floor(idx / 2) * 50;

        return (
          <g key={idx} transform={`translate(${cardX}, ${cardY})`}>
            <rect
              x="0"
              y="0"
              width="110"
              height="38"
              rx="6"
              fill={
                isHighlighted
                  ? isDark
                    ? "rgba(16, 185, 129, 0.15)"
                    : "rgba(16, 185, 129, 0.1)"
                  : isDark
                    ? "#181e28"
                    : "#ffffff"
              }
              stroke={isHighlighted ? accentStyles.stroke : isDark ? "rgba(255, 255, 255, 0.15)" : "#cbd5e1"}
              strokeWidth={isHighlighted ? 1.5 : 1}
            />
            <text
              x="8"
              y="18"
              fill={isDark ? "#f8fafc" : "#0f172a"}
              className="text-[11px] font-semibold"
            >
              {item.label}
            </text>
            <text
              x="8"
              y="30"
              fill={isDark ? "#94a3b8" : "#64748b"}
              className="text-[9px] font-mono"
            >
              {item.subtext || (isHighlighted ? "推荐重点" : "")}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// =============================================================================
// 5. Timeline & Milestones (演进里程碑)
// =============================================================================
function TimelineDiagramSvg({
  data,
  accent,
  isDark = true,
}: {
  data: Record<string, any>;
  accent: AccentColor;
  isDark?: boolean;
}) {
  const accentStyles = ACCENT_MAP[accent] || ACCENT_MAP.emerald;
  const milestones = Array.isArray(data.milestones) ? data.milestones : [];

  const width = 640;
  const count = Math.max(milestones.length, 2);
  const stepWidth = (width - 80) / count;
  const height = 240;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full max-w-[640px] h-auto font-sans"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* 水平时间线轴 */}
      <line
        x1="40"
        y1="90"
        x2={width - 40}
        y2="90"
        stroke={isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.15)"}
        strokeWidth="2"
      />

      {milestones.map((m: any, idx: number) => {
        const x = 40 + idx * stepWidth + stepWidth / 2;
        const isCompleted = m.status === "completed" || m.status === "done";
        const isCurrent = m.status === "in_progress" || m.status === "current" || m.highlighted;

        return (
          <g key={idx}>
            {/* 节点圆点 */}
            <circle
              cx={x}
              cy="90"
              r={isCurrent ? "7" : "5"}
              fill={isCurrent ? accentStyles.fill : isCompleted ? (isDark ? "#64748b" : "#94a3b8") : isDark ? "#334155" : "#cbd5e1"}
              stroke={isCurrent ? (isDark ? "#ffffff" : "#0f172a") : undefined}
              strokeWidth={isCurrent ? 2 : 0}
            />

            {/* 上方阶段 / 日期 */}
            <text
              x={x}
              y="70"
              textAnchor="middle"
              fill={isCurrent ? accentStyles.stroke : isDark ? "#94a3b8" : "#64748b"}
              className={`text-[10px] font-mono ${isCurrent ? "font-semibold" : ""}`}
            >
              {m.date || m.phase || `P${idx + 1}`}
            </text>

            {/* 下方里程碑标题与描述 */}
            <rect
              x={x - stepWidth / 2 + 8}
              y="112"
              width={stepWidth - 16}
              height="80"
              rx="6"
              fill={
                isCurrent
                  ? isDark
                    ? "rgba(16, 185, 129, 0.15)"
                    : "rgba(16, 185, 129, 0.1)"
                  : isDark
                    ? "#181e28"
                    : "#ffffff"
              }
              stroke={isCurrent ? accentStyles.stroke : isDark ? "rgba(255, 255, 255, 0.15)" : "#cbd5e1"}
              strokeWidth={isCurrent ? 1.5 : 1}
            />
            <text
              x={x}
              y="132"
              textAnchor="middle"
              fill={isDark ? "#f8fafc" : "#0f172a"}
              className="text-[12px] font-semibold"
            >
              {m.title}
            </text>
            <text
              x={x}
              y="150"
              textAnchor="middle"
              fill={isDark ? "#94a3b8" : "#64748b"}
              className="text-[10px] font-mono"
            >
              {m.description || m.status || ""}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
