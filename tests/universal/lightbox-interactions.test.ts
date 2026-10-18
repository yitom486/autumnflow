import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpImageView } from "../../src/components/assistant/AcpMedia";
import AcpMermaidDiagram from "../../src/components/assistant/AcpMermaidDiagram";

vi.mock("mermaid", () => ({ default: {
  initialize: vi.fn(),
  mermaidAPI: { getDiagramFromText: vi.fn(async () => ({ db: {} })) },
  render: vi.fn(async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>' })),
} }));

const mounted: Array<{ root: Root; host: HTMLDivElement }> = [];
const initialOverflow = document.body.style.overflow;
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  document.body.style.overflow = initialOverflow;
});

async function open(kind: "image" | "mermaid") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(kind === "image"
      ? h(AcpImageView, { src: "data:image/png;base64,aGVsbG8=", alt: "Test image" })
      : h(AcpMermaidDiagram, { code: "flowchart TD; A-->B" }));
  });
  const button = host.querySelector<HTMLButtonElement>(kind === "image" ? 'button[title="点击放大"]' : 'button[title="放大查看 / 全屏预览"]')!;
  await act(async () => button.click());
  const canvas = document.querySelector<HTMLDivElement>("[data-lightbox-canvas]")!;
  expect(canvas).toBeTruthy();
  const captured = new Set<number>();
  // happy-dom lacks native pointer capture; verify its contract here and in Chromium separately.
  canvas.setPointerCapture = vi.fn((id) => { captured.add(id); });
  canvas.hasPointerCapture = vi.fn((id) => captured.has(id));
  canvas.releasePointerCapture = vi.fn((id) => { captured.delete(id); });
  const transform = () => canvas.querySelector<HTMLElement>('[style*="translate("]')!.style.transform;
  const pointer = async (type: string, init: PointerEventInit = {}) => {
    await act(async () => {
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: 100, clientY: 100, ...init,
      }));
    });
  };
  const key = async (value: string, shiftKey = false) => {
    const event = new KeyboardEvent("keydown", { key: value, shiftKey, cancelable: true });
    await act(async () => { window.dispatchEvent(event); });
    return event;
  };
  return { root, host, canvas, captured, transform, pointer, key };
}

describe.each(["image", "mermaid"] as const)("%s lightbox interactions", (kind) => {
  it("places the modal outside clipped or transformed chat containers", async () => {
    const { host } = await open(kind);
    host.style.overflow = "hidden";
    host.style.transform = "translateZ(0)";
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    expect(host.contains(dialog)).toBe(false);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });
  it("cancels native wheel defaults and zooms once, without reacting to zero vertical delta", async () => {
    const { canvas, transform } = await open(kind);
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    await act(async () => { canvas.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
    expect(transform()).toContain("scale(1.15)");
    await act(async () => { canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 0 })); });
    expect(transform()).toContain("scale(1.15)");
  });

  it.each(["pointerup", "pointercancel", "lostpointercapture", "blur"])("ends dragging on %s and ignores subsequent movement", async (end) => {
    const { canvas, captured, transform, pointer } = await open(kind);
    await pointer("pointerdown");
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(7);
    await pointer("pointermove", { clientX: 2000, clientY: -100 });
    expect(transform()).toContain("translate(1900px, -200px)");
    if (end === "blur") await act(async () => { window.dispatchEvent(new Event("blur")); });
    else await pointer(end);
    const stopped = transform();
    await pointer("pointermove", { clientX: 2100 });
    expect(transform()).toBe(stopped);
    expect(captured.size).toBe(0);
  });

  it("supports primary touch dragging and rejects competing pointers", async () => {
    const { canvas, transform, pointer } = await open(kind);
    expect(canvas.classList.contains("touch-none")).toBe(true);
    await pointer("pointerdown", { pointerType: "touch" });
    await pointer("pointerdown", { pointerId: 8, pointerType: "touch", isPrimary: false });
    await pointer("pointermove", { pointerId: 8, clientX: 500 });
    expect(transform()).toContain("translate(0px, 0px)");
    await pointer("pointermove", { pointerType: "touch", clientX: 140, clientY: 160 });
    expect(transform()).toContain("translate(40px, 60px)");
    await pointer("pointerup", { pointerType: "touch" });
  });

  it("recovers from a lost mouse-up using the move event's buttons state", async () => {
    const { captured, transform, pointer } = await open(kind);
    await pointer("pointerdown");
    await pointer("pointermove", { clientX: 300, buttons: 0 });
    expect(captured.size).toBe(0);
    expect(transform()).toContain("translate(0px, 0px)");
  });

  it("keeps a drag captured when its parent rerenders", async () => {
    const { root, canvas, captured, transform, pointer } = await open(kind);
    await pointer("pointerdown");
    await act(async () => {
      root.render(kind === "image"
        ? h(AcpImageView, { src: "data:image/png;base64,aGVsbG8=", alt: "Updated title" })
        : h(AcpMermaidDiagram, { code: "flowchart TD; A-->B" }));
    });
    expect(captured.has(7)).toBe(true);
    expect(canvas.releasePointerCapture).not.toHaveBeenCalled();
    await pointer("pointermove", { clientX: 150 });
    expect(transform()).toContain("translate(50px, 0px)");
  });

  it("keeps keyboard zoom/reset/close, adds keyboard panning, and removes listeners on close", async () => {
    document.body.style.overflow = "scroll";
    const { host, canvas, transform, key } = await open(kind);
    expect(document.body.style.overflow).toBe("hidden");
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'));
    expect(document.activeElement).toBe(buttons[0]);
    buttons.at(-1)!.focus();
    await key("Tab");
    expect(document.activeElement).toBe(buttons[0]);
    await key("Tab", true);
    expect(document.activeElement).toBe(buttons.at(-1));
    await key("+");
    expect(transform()).toContain("scale(1.25)");
    expect((await key("ArrowRight")).defaultPrevented).toBe(true);
    await key("ArrowDown", true);
    expect(transform()).toContain("translate(20px, 80px)");
    await key("0");
    expect(transform()).toBe("translate(0px, 0px) scale(1)");
    await key("Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.style.overflow).toBe("scroll");
    const wheel = new WheelEvent("wheel", { cancelable: true, deltaY: -100 });
    canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
  });
});
