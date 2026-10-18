import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MermaidSvg, readMindmapBranch, type MindmapBranch } from "../../src/components/assistant/MermaidSvg";

const tree: MindmapBranch = { id: "0", children: [{ id: "1", children: [{ id: "2", children: [] }] }] };
// Badges already exist so this DOM test needs no simulated SVG geometry.
// Real browser tests cover badge positioning and rendering.
const svg = '<svg id="map"><g id="map-node_0"><g class="label">Root</g><g data-mindmap-badge><text/></g></g><g id="map-node_1"><g class="label">Parent</g><g data-mindmap-badge><text/></g></g><g id="map-node_2">Leaf</g><path id="map-edge_0_1"/><path id="map-edge_1_2"/></svg>';

function Harness({ zoom }: { zoom: number }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  return h(MermaidSvg, { svg, tree, collapsed, style: { transform: `scale(${zoom})` }, onToggle: id => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  } });
}

describe("Mermaid mindmap interaction", () => {
  it("retains nested folding and decorated SVG DOM through viewport rerenders", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(Harness, { zoom: 1 })));
      const parent = host.querySelector<SVGElement>('[id="map-node_1"]')!;
      const leaf = host.querySelector<SVGElement>('[id="map-node_2"]')!;
      const edge = host.querySelector<SVGElement>('[id="map-edge_1_2"]')!;
      expect(parent.getAttribute("aria-expanded")).toBe("true");
      expect(leaf.hasAttribute("role")).toBe(false);
      await act(async () => parent.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(parent.getAttribute("aria-expanded")).toBe("false");
      expect(leaf.style.display).toBe("none"); expect(edge.style.display).toBe("none");
      await act(async () => root.render(h(Harness, { zoom: 1.5 })));
      expect(host.querySelector('[id="map-node_1"]')).toBe(parent);
      expect(parent.getAttribute("aria-label")).toBe("展开：Parent");
      expect(leaf.style.display).toBe("none");
      await act(async () => parent.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
      expect(leaf.style.display).toBe(""); expect(edge.style.display).toBe("");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("copies hierarchy IDs independently of rendered labels and rejects other diagram data", () => {
    expect(readMindmapBranch({ id: 0, children: [{ id: 1, children: [] }] })).toEqual({ id: "0", children: [{ id: "1", children: [] }] });
    expect(readMindmapBranch({ id: "flowchart", children: [] })).toBeNull();
    expect(readMindmapBranch(null)).toBeNull();
  });
});
