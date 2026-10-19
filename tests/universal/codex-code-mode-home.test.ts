// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isCodexProfile,
  provisionCodexCodeModeHome,
  resolveAppCodexHome,
  withCodeModeEnabled,
} from "../../server/universal/codex-code-mode-home";

describe("withCodeModeEnabled", () => {
  it("appends a features table when the config has none", () => {
    const out = withCodeModeEnabled('model = "gpt-5"\n');
    expect(out).toContain('model = "gpt-5"');
    expect(out).toMatch(/\[features\]\r?\ncode_mode = true/);
  });

  it("keeps sibling keys and replaces an existing code_mode value", () => {
    const out = withCodeModeEnabled("[features]\ncode_mode = false\nmulti_agent = true\n");
    expect(out.match(/code_mode\s*=/g)).toHaveLength(1);
    expect(out).toContain("code_mode = true");
    expect(out).toContain("multi_agent = true");
  });

  it("is idempotent", () => {
    const once = withCodeModeEnabled("[features]\ncode_mode = true\n");
    expect(withCodeModeEnabled(once)).toBe(once);
  });
});

describe("provisionCodexCodeModeHome", () => {
  it("copies the user's auth/config once and enables code mode", async () => {
    const source = await mkdtemp(join(tmpdir(), "codex-src-"));
    const target = await mkdtemp(join(tmpdir(), "codex-dst-"));
    await writeFile(join(source, "auth.json"), '{"token":"secret"}');
    await writeFile(join(source, "config.toml"), 'model = "gpt-5"\n[features]\nmulti_agent = true\n');

    const result = await provisionCodexCodeModeHome({ home: target, sourceHome: source });
    expect(result.authCopied).toBe(true);
    expect(result.configCopied).toBe(true);
    expect(await readFile(join(target, "auth.json"), "utf8")).toBe('{"token":"secret"}');
    const config = await readFile(join(target, "config.toml"), "utf8");
    expect(config).toContain('model = "gpt-5"');
    expect(config).toContain("multi_agent = true");
    expect(config).toContain("code_mode = true");
    // User's home is never written.
    expect(await readFile(join(source, "config.toml"), "utf8")).not.toContain("code_mode");
  });

  it("keeps the app copy on later runs", async () => {
    const source = await mkdtemp(join(tmpdir(), "codex-src-"));
    const target = await mkdtemp(join(tmpdir(), "codex-dst-"));
    await writeFile(join(source, "auth.json"), '{"token":"old"}');
    await writeFile(join(source, "config.toml"), "[features]\ncode_mode = true\n");
    await writeFile(join(target, "auth.json"), '{"token":"app"}');
    await writeFile(join(target, "config.toml"), "[features]\ncode_mode = false\n");

    const result = await provisionCodexCodeModeHome({ home: target, sourceHome: source });
    expect(result.authCopied).toBe(false);
    expect(await readFile(join(target, "auth.json"), "utf8")).toBe('{"token":"app"}');
    expect(await readFile(join(target, "config.toml"), "utf8")).toContain("code_mode = true");
  });

  it("warns when the user home has no login", async () => {
    const source = await mkdtemp(join(tmpdir(), "codex-empty-"));
    const target = join(await mkdtemp(join(tmpdir(), "codex-dst-")), "home");
    const result = await provisionCodexCodeModeHome({ home: target, sourceHome: source });
    expect(result.authCopied).toBe(false);
    expect(result.warnings.join(" ")).toContain("codex login");
  });
});

describe("isCodexProfile", () => {
  it("matches the built-in id and codex-acp commands", () => {
    expect(isCodexProfile({ id: "codex" })).toBe(true);
    expect(isCodexProfile({ id: "custom", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] })).toBe(true);
    expect(isCodexProfile({ id: "opencode", command: "opencode", args: ["acp"] })).toBe(false);
  });
});

describe("home resolution", () => {
  it("honors env overrides instead of a fixed path", () => {
    expect(resolveAppCodexHome(undefined, { AUTUMNFLOW_CODEX_HOME: "X:/custom" })).toBe("X:/custom");
    expect(resolveAppCodexHome(undefined, { AUTUMNFLOW_HOME: "X:/base" })).toBe(join("X:/base", "codex-home"));
    expect(resolveAppCodexHome("X:/arg", { AUTUMNFLOW_HOME: "X:/env" })).toBe(join("X:/arg", "codex-home"));
  });
});
