import React from "react";

export interface DiagramFolding {
  collapsed: ReadonlySet<string>;
  toggle: (id: string) => void;
}

export function branchControls(id: string, label: string, folding: DiagramFolding) {
  const expanded = !folding.collapsed.has(id);
  return {
    role: "button", tabIndex: 0, "aria-expanded": expanded,
    "aria-label": `${expanded ? "折叠" : "展开"}：${label}`,
    className: "cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-primary",
    onClick: () => folding.toggle(id),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!["Enter", " ", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Enter" || event.key === " " ||
          (event.key === "ArrowLeft" && expanded) || (event.key === "ArrowRight" && !expanded)) folding.toggle(id);
    },
  } as const;
}

/** Reachability after cutting folded outgoing edges preserves shared joins and handles cycles. */
export function visibleFlowNodes(count: number, edges: Array<[number, number]>, collapsed: ReadonlySet<string>): Set<number> {
  const incoming = new Set(edges.map(([, to]) => to));
  const roots = Array.from({ length: count }, (_, i) => i).filter(i => !incoming.has(i));
  const walk = (starts: number[], cut: boolean) => {
    const seen = new Set<number>(); const queue = [...starts];
    while (queue.length) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (cut && collapsed.has(`step:${id}`)) continue;
      for (const [from, to] of edges) if (from === id && !seen.has(to)) queue.push(to);
    }
    return seen;
  };
  // Components consisting only of cycles need one stable root as well.
  let covered = walk(roots, false);
  for (let i = 0; i < count; i++) if (!covered.has(i)) {
    roots.push(i); covered = walk(roots, false);
  }
  return walk(roots, true);
}

export function MindmapDiagramSvg({ data, isDark, color, folding }: {
  data: Record<string, any>; isDark: boolean; color: string; folding: DiagramFolding;
}) {
  type Node = { key: string; label: string; description: string; children: Node[]; depth: number; x: number; y: number };
  let budget = 500;
  const read = (raw: any, key: string, depth: number): Node | null => {
    if (!raw || typeof raw !== "object" || depth > 32 || budget-- <= 0) return null;
    return { key, label: String(raw.label ?? raw.title ?? raw.name ?? raw.id ?? "节点"),
      description: String(raw.description ?? ""), depth, x: depth * 190 + 24, y: 0,
      children: (Array.isArray(raw.children) ? raw.children : []).map((child: any, i: number) => read(child, `${key}.${i}`, depth + 1)).filter(Boolean) };
  };
  const root = read(data.root ?? data.tree, "mindmap:0", 0);
  const nodes: Node[] = []; const edges: Array<[Node, Node]> = [];
  let row = 0;
  const layout = (node: Node) => {
    nodes.push(node);
    const children = folding.collapsed.has(node.key) ? [] : node.children;
    if (children.length) {
      children.forEach(child => { layout(child); edges.push([node, child]); });
      node.y = (children[0].y + children[children.length - 1].y) / 2;
    } else node.y = 24 + row++ * 84;
  };
  if (root) layout(root);
  const width = Math.max(640, ...nodes.map(n => n.x + 196));
  const height = Math.max(240, row * 84 + 30);
  return <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto font-sans" style={{ maxWidth: width }} xmlns="http://www.w3.org/2000/svg" data-mcp-mindmap>
    {edges.map(([from, to]) => <path key={to.key} data-mindmap-edge={to.key}
      d={`M ${from.x + 160} ${from.y + 28} C ${from.x + 178} ${from.y + 28}, ${to.x - 18} ${to.y + 28}, ${to.x} ${to.y + 28}`}
      fill="none" stroke={color} strokeWidth="1.5" />)}
    {nodes.map(node => <g key={node.key} data-mindmap-node={node.key} transform={`translate(${node.x},${node.y})`}
      {...(node.children.length ? branchControls(node.key, node.label, folding) : {})}>
      <title>{node.label}{node.description ? ` — ${node.description}` : ""}</title>
      <rect width="160" height="56" rx="8" fill={isDark ? "#181e28" : "#ffffff"} stroke={color} />
      <text x="12" y={node.description ? 23 : 33} fill={isDark ? "#f8fafc" : "#0f172a"} fontSize="12">{node.label.length > 11 ? `${node.label.slice(0, 10)}…` : node.label}</text>
      {node.description && <text x="12" y="42" fill={isDark ? "#94a3b8" : "#64748b"} fontSize="10">{node.description.slice(0, 16)}</text>}
      {node.children.length > 0 && <g aria-hidden="true"><circle cx="149" cy="7" r="10" fill={isDark ? "#181e28" : "white"} stroke={color} /><text x="149" y="12" textAnchor="middle" fill={color} fontSize="16">{folding.collapsed.has(node.key) ? "+" : "−"}</text></g>}
    </g>)}
  </svg>;
}
