import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionPanel } from "../../src/components/universal/InteractionPanel";
import type { PendingPermission } from "../../src/lib/universal-api";

function permission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    agentId: "codex",
    sessionId: "s1",
    permissionId: "perm-1",
    toolCall: { title: "写入文件", kind: "edit" },
    options: [
      { optionId: "allow_once", name: "仅允许本次" },
      { optionId: "reject_once", name: "拒绝执行" },
    ],
    ...overrides,
  } as PendingPermission;
}

async function render(props: Partial<React.ComponentProps<typeof InteractionPanel>> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const onRespondPermission = vi.fn();
  const onRespondElicitation = vi.fn();
  await act(async () =>
    root.render(
      <InteractionPanel
        permissions={[]}
        elicitations={[]}
        onRespondPermission={onRespondPermission}
        onRespondElicitation={onRespondElicitation}
        respondingId={null}
        {...props}
      />
    )
  );
  return { host, root, onRespondPermission, onRespondElicitation };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("interaction panel", () => {
  it("pops the pending approval up as its own dialog", async () => {
    const view = await render({ permissions: [permission()] });
    try {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog?.textContent).toContain("等待你的选择");
      // The card is portaled out of the composer, so look at the document.
      expect(document.body.textContent).toContain("写入文件");
    } finally {
      await act(async () => view.root.unmount());
      view.host.remove();
    }
  });

  it("renders nothing when the agent is not waiting for anything", async () => {
    const view = await render();
    try {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await act(async () => view.root.unmount());
      view.host.remove();
    }
  });

  it("answers the request with the chosen option", async () => {
    const view = await render({ permissions: [permission()] });
    try {
      const option = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").includes("仅允许本次")
      );
      expect(option).toBeTruthy();
      await act(async () => (option as HTMLButtonElement).click());
      const submit = Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent || "").trim() === "批准执行"
      );
      expect(submit).toBeTruthy();
      await act(async () => (submit as HTMLButtonElement).click());
      expect(view.onRespondPermission).toHaveBeenCalledWith(expect.objectContaining({ permissionId: "perm-1" }), "allow_once");
    } finally {
      await act(async () => view.root.unmount());
      view.host.remove();
    }
  });

  it("refuses the request when the card is dismissed", async () => {
    const view = await render({ permissions: [permission()] });
    try {
      const skip = Array.from(document.querySelectorAll("button")).find((b) => (b.textContent || "").trim() === "拒绝");
      expect(skip).toBeTruthy();
      await act(async () => (skip as HTMLButtonElement).click());
      expect(view.onRespondPermission).toHaveBeenCalledWith(expect.objectContaining({ permissionId: "perm-1" }), null);
    } finally {
      await act(async () => view.root.unmount());
      view.host.remove();
    }
  });
});
