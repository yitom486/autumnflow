// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrateLegacyAppHome,
  migrateLegacyResources,
  resolveAppHome,
  resolveLegacyAppHome,
} from "../../server/universal/app-paths";

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "autumnflow-home-"));
}

describe("app home resolution", () => {
  it("honors AUTUMNFLOW_HOME and the XDG/ACP base override", () => {
    expect(resolveAppHome({ AUTUMNFLOW_HOME: "X:/custom" })).toBe("X:/custom");
    expect(resolveAppHome({ XDG_STATE_HOME: "X:/state" })).toBe(join("X:/state", ".autumnflow"));
    expect(resolveAppHome({ ACP_HOME: "X:/base" })).toBe(join("X:/base", ".autumnflow"));
  });

  it("derives the legacy home next to the new one", () => {
    expect(resolveLegacyAppHome({ XDG_STATE_HOME: "X:/state" })).toBe(join("X:/state", ".acp-studio"));
  });
});

describe("legacy home migration", () => {
  it("copies the old directory once and never overwrites the new one", async () => {
    const root = await tempHome();
    const legacy = join(root, ".acp-studio");
    const target = join(root, ".autumnflow");
    await mkdir(join(legacy, "journal"), { recursive: true });
    await writeFile(join(legacy, "agents.json"), "[{\"id\":\"x\"}]");
    await writeFile(join(legacy, ".gateway-token"), "a".repeat(64));
    await writeFile(join(legacy, "journal", "t.jsonl"), "{\"turn\":1}\n");

    expect(migrateLegacyAppHome({ target, legacy })).toBe(true);
    expect(await readFile(join(target, "agents.json"), "utf8")).toContain("\"x\"");
    expect(await readFile(join(target, ".gateway-token"), "utf8")).toHaveLength(64);
    expect(await readFile(join(target, "journal", "t.jsonl"), "utf8")).toContain("turn");

    // A second run is a no-op and app changes survive.
    await writeFile(join(target, "agents.json"), "[\"new\"]");
    expect(migrateLegacyAppHome({ target, legacy })).toBe(false);
    expect(await readFile(join(target, "agents.json"), "utf8")).toBe("[\"new\"]");
  });

  it("does nothing when the legacy directory is absent", async () => {
    const root = await tempHome();
    expect(
      migrateLegacyAppHome({ target: join(root, ".autumnflow"), legacy: join(root, "missing") }),
    ).toBe(false);
  });

  it("copies ~/.acp-client resources into <home>/resources once", async () => {
    const root = await tempHome();
    const home = join(root, ".autumnflow");
    const legacyResources = join(root, ".acp-client");
    await mkdir(join(legacyResources, "skills", "demo"), { recursive: true });
    await writeFile(join(legacyResources, "AGENTS.md"), "rules");
    expect(migrateLegacyResources(home)).toBe(true);
    expect(await readFile(join(home, "resources", "AGENTS.md"), "utf8")).toBe("rules");
    expect(migrateLegacyResources(home)).toBe(false);
  });
});
