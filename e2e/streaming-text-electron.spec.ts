import { test, expect } from "@playwright/test";
import { launchElectronApp } from "./helpers/launch-electron";

test("tool events keep revealed text and a matching prefix streams only its suffix", async () => {
  const launched = await launchElectronApp();
  const { page } = launched;
  try {
    const prefix = "阶段输出：已经定位消息更新路径，接下来核对工具事件。";
    const suffix = "新增结论：正文应当只追加。";
    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 15000 });
    await input.fill("E2E_STABLE_TEXT");
    await input.press("Enter");
    const body = page.locator(".acp-md").filter({ hasText: prefix }).first();
    await expect(body).toContainText(prefix, { timeout: 15000 });
    await body.evaluate((node, expected) => {
      const results = { regressions: [] as string[], frames: 0, active: true };
      (window as any).__textStability = results;
      const sample = () => {
        results.frames++;
        if (!node.isConnected || !(node.textContent || "").startsWith(expected)) {
          results.regressions.push(node.isConnected ? (node.textContent || "") : "unmounted");
        }
        if (results.active) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, prefix);
    await expect(body).toContainText(suffix, { timeout: 15000 });
    const result = await page.evaluate(() => {
      const result = (window as any).__textStability;
      result.active = false;
      return { frames: result.frames, regressions: result.regressions };
    });
    expect(result.frames).toBeGreaterThan(10);
    expect(result.regressions).toEqual([]);
  } finally {
    await launched.cleanup();
  }
});
