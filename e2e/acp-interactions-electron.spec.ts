import { test, expect } from "@playwright/test";
import { launchElectronApp, type LaunchedApp } from "./helpers/launch-electron";

// Real Electron -> HTTP/SSE -> stdio ACP -> reverse request -> UI response.
// Elicitation uses official SDK v1 methods, independently of security permissions.
test.describe("ACP reverse interactions", () => {
  let launched: LaunchedApp;
  let requests: Array<{ path: string; body: any }>;

  test.beforeEach(async () => {
    requests = [];
    launched = await launchElectronApp();
    await launched.app.context().tracing.start({ screenshots: true, snapshots: true });
    launched.page.on("request", request => {
      if (request.method() === "POST") requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
  });
  test.afterEach(async ({}, info) => {
    if (!launched) return;
    try {
      if (info.status !== info.expectedStatus) {
        await info.attach("failure", { body: await launched.page.screenshot(), contentType: "image/png" });
        await launched.app.context().tracing.stop({ path: info.outputPath("trace.zip") });
      } else await launched.app.context().tracing.stop();
    } finally { await launched.cleanup(); }
  });

  async function send(prompt: string) {
    const input = launched.page.locator("textarea").first();
    await expect(input).toBeVisible({ timeout: 15000 });
    await input.fill(prompt);
    await input.press("Enter");
  }

  for (const [label, optionId] of [["仅允许本次", "once"], ["本会话始终允许", "always"], ["拒绝本次操作", "reject"]]) {
    test(`permission returns ${optionId} to the waiting ACP request`, async () => {
      const { page } = launched;
      await send("E2E_PERMISSION");
      await expect(page.getByText("【安全授权】执行 [execute] E2E 安全操作", { exact: true })).toBeVisible();
      await expect(page.getByText("ACP_PERMISSION_RESULT", { exact: false })).toHaveCount(0);
      await page.getByRole("button", { name: label, exact: false }).click();
      await expect(page.getByText("ACP_PERMISSION_RESULT", { exact: false })).toContainText(`"optionId":"${optionId}"`);
      const responses = requests.filter(r => r.path.endsWith("/permission/respond"));
      expect(responses).toHaveLength(1);
      expect(responses[0].body.outcome).toEqual({ outcome: "selected", optionId });
      expect(requests.filter(r => r.path.endsWith("/chat"))).toHaveLength(1);
    });
  }

  test("dismissing permission cancels the request without granting access", async () => {
    const { page } = launched;
    await send("E2E_PERMISSION");
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(page.getByText("ACP_PERMISSION_RESULT", { exact: false })).toContainText('"outcome":"cancelled"');
    expect(requests.filter(r => r.path.endsWith("/permission/respond"))).toHaveLength(1);
  });

  test("schema form returns selected string and typed integer to the original request", async () => {
    const { page } = launched;
    await send("E2E_ELICITATION");
    await expect(page.getByLabel("部署环境", { exact: false })).toBeVisible();
    await expect(page.getByText("ACP_ELICITATION_RESULT", { exact: false })).toHaveCount(0);
    await page.getByLabel("部署环境", { exact: false }).selectOption("staging");
    await page.getByLabel("副本数量", { exact: false }).fill("3");
    await expect(page.getByText("ACP_ELICITATION_RESULT", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "确认提交", exact: false }).click();
    await expect(page.getByText("ACP_ELICITATION_RESULT", { exact: false })).toContainText('"replicas":3');
    const responses = requests.filter(r => r.path.endsWith("/elicitation/respond"));
    expect(responses).toHaveLength(1);
    expect(responses[0].body.result).toEqual({ action: "accept", content: { environment: "staging", replicas: 3 } });
    expect(requests.filter(r => r.path.endsWith("/chat"))).toHaveLength(1);
    await expect(page.getByRole("button", { name: "确认提交", exact: false })).toHaveCount(0);
  });

  for (const [label, action] of [["拒绝", "decline"], ["取消", "cancel"]]) test(`form ${label} returns ${action}`, async () => {
    const { page } = launched;
    await send("E2E_ELICITATION");
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.getByText("ACP_ELICITATION_RESULT", { exact: false })).toContainText(`"action":"${action}"`);
    expect(requests.filter(r => r.path.endsWith("/elicitation/respond"))).toHaveLength(1);
  });

  test("URL consent returns accept and completion after chat closes clears the waiting card", async ({}, info) => {
    const { page } = launched;
    await page.evaluate(() => { (window as any).__openedUrls = []; window.open = ((url: string) => { (window as any).__openedUrls.push(url); return null; }) as typeof window.open; });
    await send("E2E_URL_ELICITATION");
    await expect(page.getByText("https://accounts.example.org/connect", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__openedUrls)).toEqual([]);
    await info.attach("url-consent", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "同意并在浏览器中打开", exact: true }).click();
    await expect(page.getByText("ACP_URL_RESULT", { exact: false })).toContainText('"action":"accept"');
    await expect(page.getByText("已同意打开，等待外部流程完成…", { exact: true })).toBeVisible();
    await expect(page.getByText("已同意打开，等待外部流程完成…", { exact: true })).toHaveCount(0, { timeout: 10000 });
    expect(await page.evaluate(() => (window as any).__openedUrls)).toEqual(["https://accounts.example.org/connect"]);
    expect(requests.filter(r => r.path.endsWith("/elicitation/respond")).map(r => r.body.result)).toEqual([{ action: "accept" }]);
    expect(requests.filter(r => r.path.endsWith("/chat"))).toHaveLength(1);
  });
});
