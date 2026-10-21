import { test, expect } from "@playwright/test";
import { launchElectronApp } from "./helpers/launch-electron";

// 会话之间必须互不影响：一个会话在跑的时候，另一个会话发消息照发不误，
// 不能被塞进"排队中"。切换会话也不该杀掉正在跑的那一轮。
test.describe("session isolation", () => {
  test("a message typed while another session works is sent, not queued", async ({}, info) => {
    const launched = await launchElectronApp();
    const { page } = launched;
    try {
      const input = page.locator("textarea").first();
      await expect(input).toBeVisible({ timeout: 15000 });

      // 会话一：让它跑起来（fixture 会先等 3.5 秒）
      await input.fill("E2E_WAIT_FOR_FIRST_TOKEN");
      await input.press("Enter");
      await expect(page.getByLabel("正在运行").first()).toBeVisible({ timeout: 15000 });

      // 会话二：同一个项目里新开一个
      await page.getByRole("button", { name: "在 workspace 中新建会话" }).click();
      // 换会话不等于结束那一轮：会话一还在跑
      await expect(page.getByLabel("正在运行").first()).toBeVisible({ timeout: 10000 });

      // 在新会话里发消息：不该被塞进队列
      await input.fill("E2E_SECOND_SESSION");
      await input.press("Enter");
      await expect(page.locator('[data-testid="composer-queue"]')).toHaveCount(0);
      // 消息确实交出去了（输入框清空）
      await expect(input).toHaveValue("", { timeout: 10000 });
    } finally {
      await launched.cleanup();
    }
  });

  test("a message typed in the same session while it works is queued", async ({}, info) => {
    const launched = await launchElectronApp();
    const { page } = launched;
    try {
      const input = page.locator("textarea").first();
      await expect(input).toBeVisible({ timeout: 15000 });

      await input.fill("E2E_WAIT_FOR_FIRST_TOKEN");
      await input.press("Enter");
      await expect(page.getByLabel("正在运行").first()).toBeVisible({ timeout: 15000 });

      // 同一个会话里再发一条 → 进队列
      await input.fill("E2E_QUEUED_IN_SAME_SESSION");
      await input.press("Enter");
      const queue = page.locator('[data-testid="composer-queue"]');
      await expect(queue).toBeVisible({ timeout: 10000 });
      await expect(queue).toContainText("E2E_QUEUED_IN_SAME_SESSION");
    } finally {
      await launched.cleanup();
    }
  });
});
