import { test, expect } from "@playwright/test";
import { launchElectronApp } from "./helpers/launch-electron";

test("OpenCode prompt totals do not overwrite context or inherit an earlier turn's bill", async () => {
  const launched = await launchElectronApp();
  const { page } = launched;
  try {
    const input = page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 15000 });
    await input.fill("E2E_USAGE");
    await input.press("Enter");
    const header = page.getByRole("button", { name: /context 179,537\/1,048,576/ });
    await expect(header).toContainText("17.1%", { timeout: 15000 });
    await expect(header).toContainText("会话累计费用");
    await header.click();
    await expect(page.getByText("8,094,326", { exact: true })).toBeVisible();
    await expect(page.getByText("9,866", { exact: true })).toBeVisible();
    await input.fill("E2E_USAGE_ONLY");
    await input.press("Enter");
    const unknown = page.getByRole("button", { name: /上下文占用：agent 未提供/ });
    await expect(unknown).toBeVisible({ timeout: 15000 });
    await expect(unknown).not.toContainText("会话累计费用");
    await expect(unknown).not.toContainText("100.0%");
  } finally { await launched.cleanup(); }
});
