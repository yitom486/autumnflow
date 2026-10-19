/**
 * App-owned CODEX_HOME for Codex code mode.
 *
 * Codex resolves configuration and login from `CODEX_HOME` (default
 * `~/.codex`). Pointing the spawned `codex-acp` at an app-owned directory lets
 * AutumnFlow enable `features.code_mode` without writing the user's global
 * config.
 *
 * Provisioning (seed auth/config from the user's home, merge
 * `[features] code_mode = true`) lives in `@yitom/acp-client`; this module only
 * adds AutumnFlow's app-specific directory default and the Codex profile test.
 */

import { join } from "node:path";
import {
  provisionCodexCodeModeHome as provisionWithSdk,
  type CodexCodeModeHomeResult,
} from "@yitom/acp-client";
import { resolveAppHome } from "./app-paths";

export { withCodeModeEnabled } from "@yitom/acp-client";
export type { CodexCodeModeHomeResult } from "@yitom/acp-client";

/** Subdirectory that holds the isolated Codex home. */
const APP_CODEX_HOME_DIR = "codex-home";

/**
 * The app-owned Codex home.
 *
 * Resolution order (no machine-specific path is ever hardcoded):
 * 1. `AUTUMNFLOW_CODEX_HOME` (legacy: `ACP_CODEX_HOME`) — a full target directory;
 * 2. `<AUTUMNFLOW_HOME>/codex-home`, or a base argument;
 * 3. `<app home>/codex-home` (`~/.autumnflow/codex-home` by default).
 */
export function resolveAppCodexHome(
  baseDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.AUTUMNFLOW_CODEX_HOME?.trim();
  if (explicit) return explicit;
  const base = baseDir?.trim() || env.AUTUMNFLOW_HOME?.trim();
  if (base) return join(base, APP_CODEX_HOME_DIR);
  return join(resolveAppHome(env), APP_CODEX_HOME_DIR);
}

/**
 * Seed the app-owned home from the user's Codex home and enable code mode.
 *
 * @param options - target directory, source home, force and env overrides.
 * @returns what was copied plus warnings worth logging.
 */
export async function provisionCodexCodeModeHome(options: {
  home?: string;
  sourceHome?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CodexCodeModeHomeResult> {
  const env = options.env ?? process.env;
  return provisionWithSdk({
    ...options,
    home: options.home?.trim() || resolveAppCodexHome(undefined, env),
    env,
  });
}

/** Whether this profile is the Codex ACP agent. */
export function isCodexProfile(profile: {
  id: string;
  command?: string;
  args?: string[];
}): boolean {
  if (profile.id === "codex") return true;
  const command = profile.command ?? "";
  return /codex-acp/i.test(command) || (profile.args ?? []).some((arg) => /codex-acp/i.test(arg));
}
