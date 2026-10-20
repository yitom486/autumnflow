import { test, expect, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { launchElectronApp, type LaunchedApp } from "./helpers/launch-electron";
import { editorialCases, mermaidCases } from "../tests/fixtures/diagram-cases";

test.describe("Diagram components through real Electron, ACP and MCP", () => {
  let launched: LaunchedApp;
  let errors: string[];

  test.beforeEach(async () => {
    errors = [];
    launched = await launchElectronApp();
    launched.page.on("pageerror", error => errors.push(error.message));
    await launched.app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    // Exercise the native clipboard without leaving test SVG/code in the user's clipboard.
    await launched.app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const items = await clipboard.read();
      // An empty Windows clipboard can expose a read item with no MIME types.
      (globalThis as any).__diagramClipboard = await Promise.all(items.filter(item => item.types.length).map(async item =>
        new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))),
      ));
    });
  });

  test.afterEach(async ({}, info) => {
    if (!launched) return;
    try {
      if (info.status !== info.expectedStatus) {
        await info.attach("failure", { body: await launched.page.screenshot(), contentType: "image/png" });
        const trace = info.outputPath("trace.zip");
        await launched.app.context().tracing.stop({ path: trace });
        await info.attach("trace", { path: trace, contentType: "application/zip" });
      } else {
        await launched.app.context().tracing.stop();
      }
      await launched.app.evaluate(async ({ clipboard }) => {
        const original = (globalThis as any).__diagramClipboard;
        if (!Array.isArray(original)) return; // Setup failed before changing clipboard contents.
        if (original.length) await clipboard.write(original);
        else clipboard.clear();
      });
    } finally { await launched.cleanup(); }
  });

  async function prompt(value: string) {
    const composer = launched.page.locator("textarea").first();
    await expect(composer).toBeVisible({ timeout: 15000 });
    await composer.fill(value);
    await composer.press("Enter");
    // The user's own message is the first signal. If it never lands, the send
    // itself failed, which is a different problem than a missing diagram.
    await expect(launched.page.getByText(value, { exact: true })).toBeVisible({ timeout: 20000 });
  }

  async function assertSvg(svg: Locator, labels: readonly string[]) {
    await expect(svg).toBeVisible({ timeout: 45000 });
    for (const label of labels) await expect(svg).toContainText(label);
    const size = await svg.boundingBox();
    expect(size!.width).toBeGreaterThan(100);
    expect(size!.height).toBeGreaterThan(80);
    expect(await svg.getAttribute("viewBox")).toMatch(/\d/);
  }

  for (const theme of ["light", "dark"]) for (const scenario of editorialCases) {
    test(`${scenario.kind}: ${theme} rendering, zoom bounds, fullscreen, copy and SVG download`, async ({}, info) => {
      const { page, app } = launched;
      await page.evaluate(theme => localStorage.setItem("autumnflow_theme_v1", theme), theme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await prompt(`E2E_DIAGRAM:${scenario.kind}`);
      const title = page.getByText(scenario.title, { exact: true });
      // The heaviest diagrams (sequence, flowchart) need more headroom than a
      // developer machine gives them: a CI runner is several times slower.
      await expect(title).toBeVisible({ timeout: 45000 });
      const card = title.locator("xpath=../../..");
      const svg = card.locator('svg[viewBox]:not([viewBox="0 0 24 24"])');
      await assertSvg(svg, scenario.labels);
      if (["architecture", "flowchart", "sequence"].includes(scenario.kind)) {
        expect(await svg.locator("[marker-end]").count()).toBeGreaterThan(0);
      }

      const scaled = card.locator('[style*="scale("]');
      for (let i = 0; i < 9; i++) await card.getByRole("button", { name: "放大", exact: true }).click();
      await expect(scaled).toHaveCSS("transform", "matrix(2, 0, 0, 2, 0, 0)");
      for (let i = 0; i < 12; i++) await card.getByRole("button", { name: "缩小", exact: true }).click();
      await expect(scaled).toHaveCSS("transform", "matrix(0.6, 0, 0, 0.6, 0, 0)");
      await card.getByRole("button", { name: "重置缩放", exact: true }).click();
      await expect(scaled).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
      await card.getByRole("button", { name: "全屏放大", exact: true }).click();
      await expect(card).toHaveCSS("position", "fixed");
      expect(await card.evaluate(element => element.parentElement === document.body)).toBe(true);
      await card.getByRole("button", { name: "退出全屏", exact: true }).click();
      await expect(card).not.toHaveCSS("position", "fixed");
      await expect(card.getByRole("button", { name: "全屏放大", exact: true })).toBeFocused();
      await card.getByRole("button", { name: "全屏放大", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: `${scenario.title} 全屏预览` })).toHaveCount(0);

      await card.getByRole("button", { name: "复制 SVG 源码", exact: true }).click();
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain("<svg");
      const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
      expect(copied).toContain("<svg");
      for (const label of scenario.labels) expect(copied).toContain(label);

      const target = path.join(launched.userDataDir, `${scenario.kind}.svg`);
      await app.evaluate(({ session }, target) => {
        session.defaultSession.once("will-download", (_event, item) => item.setSavePath(target));
      }, target);
      await card.getByRole("button", { name: "下载 SVG", exact: true }).click();
      await expect.poll(() => fs.existsSync(target) && fs.readFileSync(target, "utf8").includes("</svg>")).toBe(true);
      const exported = fs.readFileSync(target, "utf8");
      expect(exported).toContain('xmlns="http://www.w3.org/2000/svg"');
      for (const label of scenario.labels) expect(exported).toContain(label);
      const screenshot = info.outputPath(`${scenario.kind}-${theme}.png`);
      await card.screenshot({ path: screenshot });
      await info.attach(`${scenario.kind}-${theme}`, { path: screenshot, contentType: "image/png" });
      expect(errors).toEqual([]);
    });
  }

  for (const scenario of mermaidCases) test(`Mermaid ${scenario.kind}: streamed Markdown, preview, wheel, drag, keyboard and focus`, async () => {
    const { page, app } = launched;
    await prompt(`E2E_MERMAID:${scenario.kind}`);
    const diagram = page.locator("[data-mermaid-diagram]");
    await expect(diagram).toHaveCount(1, { timeout: 45000 });
    await assertSvg(diagram.locator('svg[id^="aui-mmd-"]'), scenario.labels);
    await diagram.hover();
    const open = diagram.getByRole("button", { name: "放大查看 / 全屏预览", exact: true });
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Mermaid 图表放大预览" });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.parentElement === document.body)).toBe(true);
    const canvas = dialog.locator("[data-lightbox-canvas]");
    const content = canvas.locator(":scope > div");
    await dialog.getByRole("button", { name: "放大 (+)", exact: true }).click();
    await expect(dialog.getByText("125%", { exact: true })).toBeVisible();
    await canvas.hover();
    await page.mouse.wheel(0, -100);
    await expect(dialog.getByText("140%", { exact: true })).toBeVisible();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await expect(content).toHaveCSS("transform", "matrix(1.4, 0, 0, 1.4, 60, 30)");
    await page.keyboard.press("0");
    await expect(content).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    await page.keyboard.press("ArrowRight");
    await expect(content).toHaveCSS("transform", "matrix(1, 0, 0, 1, 20, 0)");
    await dialog.getByTitle("复制 Mermaid 源码", { exact: true }).click();
    await expect.poll(async () => (await app.evaluate(({ clipboard }) => clipboard.readText()))
      .replace(/\r\n/g, "\n").trimEnd()).toBe(scenario.code);
    const buttons = dialog.getByRole("button");
    await buttons.last().focus();
    await page.keyboard.press("Tab");
    await expect(buttons.first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(buttons.last()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    expect(errors).toEqual([]);
  });

  test("Mermaid multiple diagrams keep independent SVGs and preview contents", async () => {
    await prompt("E2E_MERMAID:multiple");
    const diagrams = launched.page.locator("[data-mermaid-diagram]");
    await expect(diagrams).toHaveCount(3, { timeout: 25000 });
    for (const [index, scenario] of mermaidCases.entries()) {
      await assertSvg(diagrams.nth(index).locator('svg[id^="aui-mmd-"]'), scenario.labels);
      await diagrams.nth(index).scrollIntoViewIfNeeded();
      await diagrams.nth(index).getByTitle("点击放大查看", { exact: true }).click();
      const dialog = launched.page.getByRole("dialog", { name: "Mermaid 图表放大预览" });
      await assertSvg(dialog.locator('svg[id^="aui-mmd-"]'), scenario.labels);
      await launched.page.keyboard.press("Escape");
    }
    const ids = await diagrams.locator('svg[id^="aui-mmd-"]').evaluateAll(elements => elements.map(element => element.id));
    expect(new Set(ids).size).toBe(3);
    expect(errors).toEqual([]);
  });

  test("Mermaid syntax failure preserves source and allows the next valid answer", async () => {
    await prompt("E2E_MERMAID:invalid");
    await expect(launched.page.getByText(/图表语法无法渲染，已回退为代码/)).toBeVisible({ timeout: 45000 });
    await expect(launched.page.locator("pre code").filter({ hasText: "A[broken --> B" })).toBeVisible();
    await expect(launched.page.locator("[data-mermaid-diagram]")).toHaveCount(0);
    await prompt("E2E_MERMAID:flowchart");
    await assertSvg(launched.page.locator('[data-mermaid-diagram] svg[id^="aui-mmd-"]'), mermaidCases[0].labels);
    expect(errors).toEqual([]);
  });

  for (const theme of ["light", "dark"]) test(`Mermaid mindmap: ${theme} nested collapse, keyboard and shared preview state`, async ({}, info) => {
    const { page } = launched;
    await page.evaluate(theme => localStorage.setItem("autumnflow_theme_v1", theme), theme);
    await page.reload();
    await prompt("E2E_MERMAID:mindmap");
    const diagram = page.locator("[data-mermaid-diagram]");
    const forms = () => diagram.getByRole("button", { name: "折叠：表单交互", exact: true });
    await expect(forms()).toBeVisible({ timeout: 45000 });
    await expect(diagram.locator('[id$="-node_3"]')).toBeVisible();
    await expect(diagram.locator('[id$="-edge_2_3"]')).toHaveCount(1);
    await expect(diagram.locator('[id$="-node_3"]')).not.toHaveAttribute("role", "button");
    await forms().click();
    await expect(diagram.getByRole("button", { name: "展开：表单交互", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(diagram.locator('[id$="-node_3"]')).toBeHidden();
    await expect(diagram.locator('[id$="-edge_2_3"]')).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await diagram.getByRole("button", { name: "折叠：界面层", exact: true }).click();
    await expect(diagram.locator('[id$="-node_2"]')).toBeHidden();
    await expect(diagram.locator('[id$="-node_6"]')).toBeVisible();
    const ui = diagram.getByRole("button", { name: "展开：界面层", exact: true });
    await ui.focus(); await page.keyboard.press("Enter");
    await expect(diagram.getByRole("button", { name: "展开：表单交互", exact: true })).toBeVisible();
    await expect(diagram.locator('[id$="-node_3"]')).toBeHidden();
    await diagram.hover();
    await diagram.getByTitle("放大查看 / 全屏预览", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Mermaid 图表放大预览" });
    await expect(dialog.locator('[id$="-node_3"]')).toBeHidden();
    await dialog.getByTitle("放大 (+)", { exact: true }).click();
    await expect(dialog.getByText("125%", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "展开：表单交互", exact: true }).click();
    await expect(dialog.locator('[id$="-node_3"]')).toBeVisible();
    await expect(diagram.locator('[id$="-node_3"]')).toBeVisible();
    const branch = dialog.getByRole("button", { name: "折叠：界面层", exact: true });
    await branch.focus(); await page.keyboard.press("ArrowLeft");
    await expect(dialog.locator('[id$="-node_2"]')).toBeHidden();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.locator('[id$="-node_2"]')).toBeVisible();
    await page.keyboard.press("Space");
    await expect(dialog.locator('[id$="-node_2"]')).toBeHidden();
    await page.keyboard.press("Escape");
    await diagram.hover();
    await diagram.getByTitle(/切换为.*主题/).click();
    await expect(diagram.getByRole("button", { name: "展开：界面层", exact: true })).toBeVisible();
    await expect(diagram.locator('[id$="-node_2"]')).toBeHidden();
    await info.attach(`mindmap-${theme}`, { body: await diagram.screenshot(), contentType: "image/png" });
    expect(errors).toEqual([]);
  });

  test("Mermaid mindmaps keep duplicate node IDs isolated between diagrams", async () => {
    const { page } = launched;
    await prompt("E2E_MERMAID:mindmap-multiple");
    const diagrams = page.locator("[data-mermaid-diagram]");
    await expect(diagrams).toHaveCount(2, { timeout: 25000 });
    await diagrams.first().getByRole("button", { name: "折叠：界面层", exact: true }).click();
    await expect(diagrams.first().locator('[id$="-node_2"]')).toBeHidden();
    await expect(diagrams.last().locator('[id$="-node_2"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
