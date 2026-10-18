import { test, expect } from "@playwright/test";
import { launchElectronApp, type LaunchedApp } from "./helpers/launch-electron";

test.describe("MCP graphics and reasoning packet boundaries", () => {
  let launched: LaunchedApp;
  test.beforeEach(async () => { launched = await launchElectronApp(); });
  test.afterEach(async ({}, info) => {
    if (!launched) return;
    try {
      if (info.status !== info.expectedStatus) await info.attach("failure", { body: await launched.page.screenshot(), contentType: "image/png" });
    } finally { await launched.cleanup(); }
  });
  async function send(value: string) {
    const input = launched.page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 15000 });
    await input.fill(value); await input.press("Enter");
  }

  test("MCP native mindmap preserves nested folding through keyboard, zoom, theme and fullscreen", async () => {
    const { page } = launched;
    await send("E2E_DIAGRAM:mindmap");
    let card = page.locator('[data-editorial-diagram="mindmap"]');
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(page.locator("[data-mermaid-diagram]")).toHaveCount(0);
    await card.getByRole("button", { name: "折叠：表单交互", exact: true }).click();
    await expect(card.locator('[data-mindmap-node="mindmap:0.0.0.0"]')).toHaveCount(0);
    await expect(card.locator('[data-mindmap-edge="mindmap:0.0.0.0"]')).toHaveCount(0);
    await card.getByRole("button", { name: "折叠：界面层", exact: true }).click();
    await card.getByRole("button", { name: "展开：界面层", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(card.getByRole("button", { name: "展开：表单交互", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "放大", exact: true }).click();
    await card.getByRole("button", { name: "全屏放大", exact: true }).click();
    card = page.getByRole("dialog", { name: "E2E MCP 思维导图 全屏预览" });
    await card.getByRole("button", { name: "展开：表单交互", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(card.locator('[data-mindmap-node="mindmap:0.0.0.0"]')).toBeVisible();
    await card.getByRole("button", { name: "折叠：表单交互", exact: true }).click();
    await card.getByTitle(/切换为.*主题/).click();
    await expect(card.getByRole("button", { name: "展开：表单交互", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-editorial-diagram="mindmap"]').getByRole("button", { name: "展开：表单交互", exact: true })).toBeVisible();
  });

  test("MCP flowchart folds outgoing paths without hiding shared joins, and handles cycles", async () => {
    const { page } = launched;
    await send("E2E_DIAGRAM:flow-join");
    const card = page.locator('[data-editorial-diagram="flowchart"]');
    await expect(card).toBeVisible({ timeout: 20000 });
    await card.getByRole("button", { name: "折叠：路径 A", exact: true }).click();
    await expect(card.locator('[data-flow-node="join"]')).toBeVisible();
    await expect(card.locator('[data-flow-edge="1:3"]')).toHaveCount(0);
    await card.getByRole("button", { name: "折叠：共享汇合", exact: true }).click();
    await expect(card.locator('[data-flow-node="loop"]')).toHaveCount(0);
    await card.getByRole("button", { name: "折叠：开始", exact: true }).click();
    await expect(card.locator("[data-flow-node]")).toHaveCount(1);
    await card.getByRole("button", { name: "展开：开始", exact: true }).click();
    await expect(card.getByRole("button", { name: "展开：路径 A", exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "展开：共享汇合", exact: true })).toBeVisible();
  });

  test("MCP architecture collapses layer contents while preserving layer connections", async () => {
    await send("E2E_DIAGRAM:architecture");
    const card = launched.page.locator('[data-editorial-diagram="architecture"]');
    await card.getByRole("button", { name: "折叠：入口层", exact: true }).click();
    await expect(card.getByText("入口网关", { exact: true })).toHaveCount(0);
    await expect(card.getByText("业务服务", { exact: true })).toBeVisible();
    await expect(card.locator("path[marker-end]")).toHaveCount(1);
    await card.getByRole("button", { name: "展开：入口层", exact: true }).click();
    await expect(card.getByText("入口网关", { exact: true })).toBeVisible();
  });

  test("live newline-heavy reasoning with changing packet IDs and 230ms pauses stays one trace", async () => {
    const { page } = launched;
    await page.evaluate(() => {
      (window as any).__reasoningMax = 0;
      const observer = new MutationObserver(() => {
        (window as any).__reasoningMax = Math.max((window as any).__reasoningMax, document.querySelectorAll("[data-reasoning-trace]").length);
      });
      observer.observe(document.body, { childList: true, subtree: true });
      (window as any).__reasoningObserver = observer;
    });
    await send("E2E_REASONING_CHUNKS");
    await expect(page.locator("[data-reasoning-trace]")).toHaveCount(1);
    await expect(page.getByText("推理分包验证完成。", { exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /思考过程.*用时/ }).click();
    const trace = page.locator("[data-reasoning-trace]");
    await expect(trace).toHaveCount(1);
    await expect(trace).toContainText("推理段落 0");
    await expect(trace).toContainText("推理段落 39");
    expect(await page.evaluate(() => (window as any).__reasoningMax)).toBe(1);
    await page.evaluate(() => (window as any).__reasoningObserver.disconnect());
  });
});
