import { test, expect } from "@playwright/test";
import { launchElectronApp } from "./helpers/launch-electron";
import { authedRequest } from "../tests/helpers/gateway-auth";

// The capabilities panel is the only place where the user can see which MCP
// tools and studio skills the agent may use, and switch them off.
test("capability panel lists the MCP tools and skills and switches a tool off", async ({}, info) => {
  const launched = await launchElectronApp();
  const { page, port } = launched;
  const base = `http://127.0.0.1:${port}/api/universal`;
  try {
    // The agent chip in the header opens the agent popover.
    const chip = page.locator('[data-testid="agent-chip"]').first();
    await expect(chip).toBeVisible({ timeout: 15000 });
    await chip.click();

    const entry = page.getByRole("button", { name: "MCP 与技能", exact: false }).first();
    await expect(entry).toBeVisible();
    await entry.click();

    const panel = page.getByRole("dialog", { name: "MCP 与技能" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("studio-ui", { exact: true })).toBeVisible();
    await expect(panel.getByText("富交互卡片", { exact: true })).toBeVisible();
    await expect(panel.getByText("技能", { exact: true })).toBeVisible();
    // The skills land in the resources directory when the agent connects, so
    // allow for the first connect to still be running.
    await expect(panel.getByText("diagram-design", { exact: true })).toBeVisible({ timeout: 20000 });

    // Switching a tool off must reach the gateway and be reflected back.
    const diagramSwitch = panel.getByRole("switch", { name: "出版级图表 开关" });
    await expect(diagramSwitch).toHaveAttribute("aria-checked", "true");
    await diagramSwitch.click();
    await expect(diagramSwitch).toHaveAttribute("aria-checked", "false");

    const state = await (await fetch(authedRequest(`${base}/capabilities?agentId=e2e-agent`))).json();
    const tools = state.mcp.tools as Array<{ name: string; enabled: boolean }>;
    expect(tools.find(tool => tool.name === "render_editorial_diagram")?.enabled).toBe(false);
    expect(tools.find(tool => tool.name === "show_interactive_card")?.enabled).toBe(true);

    // Put it back so the fixture state stays clean for other specs.
    await diagramSwitch.click();
    await expect(diagramSwitch).toHaveAttribute("aria-checked", "true");
  } finally {
    await launched.cleanup();
  }
});
