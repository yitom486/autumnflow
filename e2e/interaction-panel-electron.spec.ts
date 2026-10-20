import { test, expect } from "@playwright/test";
import { launchElectronApp } from "./helpers/launch-electron";

// A permission request blocks the current turn, so it has to show up as its
// own popup instead of hiding inside the tool list. Cancelling it must take
// the card away at once and let the turn carry on.
test.describe("interaction panel", () => {
  test("a pending approval pops up as its own dialog and can be refused", async ({}, info) => {
    const launched = await launchElectronApp();
    const { page } = launched;
    try {
      const input = page.locator("textarea").first();
      await expect(input).toBeVisible({ timeout: 15000 });
      await input.fill("E2E_PERMISSION");
      await input.press("Enter");

      const panel = page.getByRole("dialog", { name: "等待你的选择" });
      await expect(panel).toBeVisible({ timeout: 20000 });
      await expect(panel.getByText("E2E 安全操作", { exact: false })).toBeVisible();
      // It is not the inline approval strip of the tool card any more.
      await expect(page.locator('[aria-label="待处理授权与提问"]')).toHaveCount(0);

      await panel.getByRole("button", { name: "拒绝", exact: true }).click();
      // The card is gone right away and the turn continues.
      await expect(panel).toHaveCount(0, { timeout: 5000 });
      await expect(page.getByText("ACP_PERMISSION_RESULT", { exact: false }).first()).toContainText("cancelled");
    } finally {
      await launched.cleanup();
    }
  });

  test("typing while the agent waits for an approval queues the prompt and unblocks the turn", async ({}, info) => {
    const launched = await launchElectronApp();
    const { page } = launched;
    try {
      const input = page.locator("textarea").first();
      await expect(input).toBeVisible({ timeout: 15000 });
      await input.fill("E2E_PERMISSION");
      await input.press("Enter");
      const panel = page.getByRole("dialog", { name: "等待你的选择" });
      await expect(panel).toBeVisible({ timeout: 20000 });

      // The turn is blocked, so this message has to queue.
      await input.fill("排队等着");
      await input.press("Enter");
      const queue = page.locator('[data-testid="composer-queue"]');
      await expect(queue).toBeVisible({ timeout: 10000 });
      await expect(queue.getByText("排队等着", { exact: true })).toBeVisible();
      // Typing a new message is also a way out: the request is refused so the
      // agent is not left waiting.
      await expect(panel).toHaveCount(0, { timeout: 5000 });
      // The queued prompt runs once the unblocked turn is done.
      await expect(page.getByText("排队等着", { exact: true })).toBeVisible({ timeout: 20000 });
    } finally {
      await launched.cleanup();
    }
  });

  test("a queued prompt can be withdrawn before it is sent", async ({}, info) => {
    const launched = await launchElectronApp();
    const { page } = launched;
    try {
      const input = page.locator("textarea").first();
      await expect(input).toBeVisible({ timeout: 15000 });
      // The fixture takes 3.5s before its first token: the agent is busy long
      // enough to type a second prompt.
      await input.fill("E2E_WAIT_FOR_FIRST_TOKEN");
      await input.press("Enter");

      await input.fill("这条要撤回");
      await input.press("Enter");
      const queue = page.locator('[data-testid="composer-queue"]');
      await expect(queue).toBeVisible({ timeout: 10000 });
      await expect(queue.getByText("这条要撤回", { exact: true })).toBeVisible();

      await queue.getByRole("button", { name: /撤回排队消息/ }).click();
      await expect(queue).toHaveCount(0, { timeout: 5000 });
      // The prompt never reached the agent.
      await expect(page.getByText("这条要撤回", { exact: true })).toHaveCount(0, { timeout: 8000 });
    } finally {
      await launched.cleanup();
    }
  });
});
