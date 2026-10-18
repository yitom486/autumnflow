import React, { useLayoutEffect, useMemo, useRef } from "react";

export interface MindmapBranch {
  id: string;
  children: MindmapBranch[];
}

/** Read Mermaid's parsed hierarchy, rather than guessing parents from SVG positions or labels. */
export function readMindmapBranch(value: unknown): MindmapBranch | null {
  if (!value || typeof value !== "object") return null;
  const node = value as { id?: unknown; children?: unknown[] };
  if (typeof node.id !== "number" || !Number.isFinite(node.id) || !Array.isArray(node.children)) return null;
  return { id: String(node.id), children: node.children.map(readMindmapBranch).filter((n): n is MindmapBranch => !!n) };
}

export function MermaidSvg({ svg, tree, collapsed, onToggle, ...props }: {
  svg: string;
  tree: MindmapBranch | null;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "onToggle">) {
  const ref = useRef<HTMLDivElement>(null);
  // Viewport transforms rerender this wrapper; do not replace the decorated
  // SVG DOM (or its focus and node controls) when the SVG source is unchanged.
  const markup = useMemo(() => ({ __html: svg }), [svg]);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || !tree) return;
    const prefix = `${host.querySelector("svg")?.id}-`;
    const elements = new Map(Array.from(host.querySelectorAll<SVGElement>("[id]")).map(el => [
      el.id.startsWith(prefix) ? el.id.slice(prefix.length) : el.id, el,
    ]));
    const visit = (branch: MindmapBranch, hidden: boolean) => {
      const element = elements.get(`node_${branch.id}`);
      const folded = collapsed.has(branch.id);
      if (element) {
        if (branch.children.length) {
          const label = element.querySelector(".label")?.textContent?.trim() || element.textContent?.trim() || "节点";
          element.setAttribute("data-mindmap-toggle", branch.id);
          element.setAttribute("role", "button");
          element.setAttribute("tabindex", hidden ? "-1" : "0");
          element.setAttribute("aria-expanded", String(!folded));
          // Read the original label before adding the indicator.
          const savedLabel = element.getAttribute("data-mindmap-label") || label;
          element.setAttribute("data-mindmap-label", savedLabel);
          element.setAttribute("aria-label", `${folded ? "展开" : "折叠"}：${savedLabel}`);
          element.style.cursor = "pointer";
          let badge = element.querySelector<SVGGElement>("[data-mindmap-badge]");
          if (!badge) {
            const box = (element as SVGGraphicsElement).getBBox();
            const ns = "http://www.w3.org/2000/svg";
            badge = document.createElementNS(ns, "g");
            badge.setAttribute("data-mindmap-badge", "");
            badge.setAttribute("aria-hidden", "true");
            badge.setAttribute("transform", `translate(${box.x + box.width - 2}, ${box.y + 2})`);
            const circle = document.createElementNS(ns, "circle");
            circle.setAttribute("r", "9");
            circle.setAttribute("fill", "hsl(var(--background))");
            circle.setAttribute("stroke", "hsl(var(--foreground))");
            const mark = document.createElementNS(ns, "text");
            mark.setAttribute("text-anchor", "middle");
            mark.setAttribute("dy", "0.35em");
            mark.setAttribute("fill", "hsl(var(--foreground))");
            mark.setAttribute("font-size", "14");
            mark.setAttribute("font-family", "sans-serif");
            badge.append(circle, mark);
            element.append(badge);
          }
          badge.querySelector("text")!.textContent = folded ? "+" : "−";
        }
        element.style.display = hidden ? "none" : "";
      }
      for (const child of branch.children) {
        const childHidden = hidden || folded;
        const edge = elements.get(`edge_${branch.id}_${child.id}`);
        if (edge) edge.style.display = childHidden ? "none" : "";
        visit(child, childHidden);
      }
    };
    visit(tree, false);
  }, [svg, tree, collapsed]);

  const branchAt = (target: EventTarget | null) => target instanceof Element
    ? target.closest<SVGElement>("[data-mindmap-toggle]") : null;
  return <div {...props} ref={ref}
    className={`${props.className || ""} [&_[data-mindmap-toggle]:focus-visible]:outline-2 [&_[data-mindmap-toggle]:focus-visible]:outline-primary`}
    onPointerDown={event => {
      // Node actions must not be captured by the lightbox's drag gesture.
      if (branchAt(event.target)) event.stopPropagation();
      props.onPointerDown?.(event);
    }}
    onClick={event => {
      const branch = branchAt(event.target);
      if (branch) { event.stopPropagation(); onToggle(branch.getAttribute("data-mindmap-toggle")!); }
      else props.onClick?.(event);
    }}
    onKeyDown={event => {
      const branch = branchAt(event.target);
      if (branch && ["Enter", " ", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const id = branch.getAttribute("data-mindmap-toggle")!;
        if (event.key === "Enter" || event.key === " " ||
            (event.key === "ArrowLeft" && !collapsed.has(id)) ||
            (event.key === "ArrowRight" && collapsed.has(id))) onToggle(id);
      }
      props.onKeyDown?.(event);
    }}
    dangerouslySetInnerHTML={markup} />;
}
