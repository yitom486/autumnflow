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

import { homedir } from "node:os";
import { join } from "node:path";
import {
  provisionCodexCodeModeHome as provisionWithSdk,
  type CodexCodeModeHomeResult,
} from "@yitom/acp-client";

export { withCodeModeEnabled } from "@yitom/acp-client";
export type { CodexCodeModeHomeResult } from "@yitom/acp-client";

/** Directory name under the user's home for this application's data. */
const APP_HOME_DIR = ".acp-studio";
/** Subdirectory that holds the isolated Codex home. */
const APP_CODEX_HOME_DIR = "codex-home";

/**
 * The app-owned Codex home.
 *
 * Resolution order (no machine-specific path is ever hardcoded):
 * 1. `ACP_CODEX_HOME` — a full target directory;
 * 2. `<base>/codex-home`, where base is the argument or `ACP_STUDIO_HOME`;
 * 3. `<user home>/.acp-studio/codex-home`.
 */
export function resolveAppCodexHome(
  baseDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.ACP_CODEX_HOME?.trim();
  if (explicit) return explicit;
  const base = baseDir?.trim() || env.ACP_STUDIO_HOME?.trim();
  if (base) return join(base, APP_CODEX_HOME_DIR);
  return join(homedir(), APP_HOME_DIR, APP_CODEX_HOME_DIR);
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
