import { test, expect } from "@playwright/test";
import { launchElectronApp } from "./helpers/launch-electron";

test("rail preview shows the question on one line and the answer on three lines", async ({}, info) => {
  const launched = await launchElectronApp();
  const { page } = launched;
  const question = "E2E_RAIL_PREVIEW 请说明如何清理问题前缀，并让右侧导航标题只显示用户的问题以及对应的人工智能回答，问题超过一行时应该显示省略号。";
  try {
    const input = page.locator("textarea").first();
    await expect(input).toBeVisible();
    await input.fill(question); await input.press("Enter");
    await expect(page.getByText(/这是当前问题对应的 AI 回答。/).first()).toBeVisible();
    const tick = page.locator('[data-slot="preview-rail-item"]').first();
    await expect(tick).toHaveAttribute("aria-label", question);
    await tick.hover();
    const card = page.locator('[data-slot="preview-rail-card"]');
    await expect(card).toBeVisible();
    const title = card.locator('[data-slot="preview-rail-title"]');
    const answer = card.locator('[data-slot="preview-rail-description"]');
    await expect(title).toHaveText(question);
    await expect(answer).toContainText("这是当前问题对应的 AI 回答。");
    const measurements = await card.evaluate(el => {
      const title = el.querySelector('[data-slot="preview-rail-title"]')!;
      const answer = el.querySelector('[data-slot="preview-rail-description"]')!;
      return { titleHeight: title.clientHeight, titleLine: parseFloat(getComputedStyle(title).lineHeight),
        titleOverflow: title.scrollWidth > title.clientWidth, answerHeight: answer.clientHeight,
        answerLine: parseFloat(getComputedStyle(answer).lineHeight), answerOverflow: answer.scrollHeight > answer.clientHeight };
    });
    expect(measurements.titleHeight).toBeLessThanOrEqual(measurements.titleLine + 1);
    expect(measurements.titleOverflow).toBe(true);
    expect(measurements.answerHeight).toBeLessThanOrEqual(measurements.answerLine * 3 + 1);
    expect(measurements.answerOverflow).toBe(true);
    await page.screenshot({ path: info.outputPath("question-answer-preview.png") });
  } finally { await launched.cleanup(); }
});
