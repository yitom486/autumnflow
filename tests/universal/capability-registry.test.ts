// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-caps-"));
process.env.AUTUMNFLOW_HOME = home;

const { readCapabilityState, setSkillEnabled, setToolEnabled, isToolEnabled, isSkillEnabled } = await import(
  "../../server/universal/capability-registry"
);
const { STUDIO_UI_TOOLS, getStudioToolDescriptor } = await import("../../server/universal/studio-tools");

afterEach(() => {
  const file = path.join(home, "capabilities.json");
  if (fs.existsSync(file)) fs.rmSync(file);
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("capability switches", () => {
  it("starts with everything enabled", () => {
    expect(readCapabilityState()).toEqual({ disabledTools: [], disabledSkills: [] });
    expect(isToolEnabled("show_interactive_card")).toBe(true);
    expect(isSkillEnabled("diagram-design")).toBe(true);
  });

  it("persists a disabled tool and restores it on the next read", () => {
    setToolEnabled("render_editorial_diagram", false);
    expect(isToolEnabled("render_editorial_diagram")).toBe(false);
    expect(isToolEnabled("show_interactive_card")).toBe(true);
    // The file is the source of truth, not the in-memory state.
    const raw = JSON.parse(fs.readFileSync(path.join(home, "capabilities.json"), "utf8"));
    expect(raw.disabledTools).toEqual(["render_editorial_diagram"]);
  });

  it("turns a tool back on without leaving a stale entry", () => {
    setToolEnabled("render_editorial_diagram", false);
    setToolEnabled("render_editorial_diagram", true);
    expect(readCapabilityState().disabledTools).toEqual([]);
  });

  it("keeps tool and skill switches apart", () => {
    setToolEnabled("show_interactive_card", false);
    setSkillEnabled("diagram-design", false);
    const state = readCapabilityState();
    expect(state.disabledTools).toEqual(["show_interactive_card"]);
    expect(state.disabledSkills).toEqual(["diagram-design"]);
  });

  it("survives a corrupt state file instead of blocking startup", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "capabilities.json"), "{not json");
    expect(readCapabilityState()).toEqual({ disabledTools: [], disabledSkills: [] });
  });

  it("drops unknown names instead of persisting them", () => {
    setToolEnabled("not-a-tool", false);
    setSkillEnabled("not-a-skill", false);
    const state = readCapabilityState();
    expect(state.disabledTools).toEqual(["not-a-tool"]);
    expect(state.disabledSkills).toEqual(["not-a-skill"]);
  });
});

describe("studio tool catalogue", () => {
  it("describes every tool the MCP server registers", () => {
    const names = STUDIO_UI_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      "show_interactive_card",
      "render_editorial_diagram",
      "render_react_sandbox",
      "prompt_form",
      "list_studio_skills",
      "get_studio_skill",
    ]);
    for (const tool of STUDIO_UI_TOOLS) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.summary.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(getStudioToolDescriptor(tool.name)).toBe(tool);
    }
  });
});
