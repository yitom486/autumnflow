// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

let root: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});

it("migrates existing agents and token when Electron requests a token before gateway setup", async () => {
  root = await mkdtemp(join(tmpdir(), "autumnflow-token-migration-"));
  const legacy = join(root, ".acp-studio");
  const target = join(root, ".autumnflow");
  const token = "a".repeat(64);
  await mkdir(legacy);
  await writeFile(join(legacy, ".gateway-token"), token + "\n");
  await writeFile(join(legacy, "agents.json"), '[{"id":"existing"}]');
  vi.stubEnv("AUTUMNFLOW_HOME", target);
  vi.stubEnv("ACP_GATEWAY_TOKEN", "");
  vi.stubEnv("ACP_GATEWAY_TOKEN_FILE", "");
  vi.resetModules();

  const { ensureGatewayToken } = await import("../../server/universal/security");
  expect(ensureGatewayToken()).toBe(token);
  expect(await readFile(join(target, "agents.json"), "utf8")).toContain("existing");
  expect(await readFile(join(target, ".gateway-token"), "utf8")).toBe(token + "\n");
  expect(await readFile(join(legacy, ".gateway-token"), "utf8")).toBe(token + "\n");
});
