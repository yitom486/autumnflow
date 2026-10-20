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
 * adds AutumnFlow's app-specific directory default, the Codex profile test and
 * the login refresh.
 */

import { chmod, copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  provisionCodexCodeModeHome as provisionWithSdk,
  resolveCodexHome,
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
 * 1. `AUTUMNFLOW_CODEX_HOME` — a full target directory;
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

async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Copy a file atomically so a running Codex never reads a half-written copy. */
async function copyAtomic(source: string, target: string): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  await copyFile(source, temp);
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, target);
}

/**
 * Keep the app-owned copy in step with the user's home.
 *
 * The SDK seeds the app home only when the target file is missing, so a login
 * that the user refreshes in their own Codex home never reaches the app: the
 * app keeps using the stale token and reports "no local login" even though the
 * user is signed in.
 *
 * The source wins only when it is strictly newer, so a login performed
 * *inside* the app-owned home is never overwritten by an older user file.
 */
export async function refreshCodexLogin(
  home: string,
  sourceHome: string,
): Promise<{ authRefreshed: boolean; configRefreshed: boolean }> {
  const result = { authRefreshed: false, configRefreshed: false };
  for (const name of ["auth.json", "config.toml"] as const) {
    const source = join(sourceHome, name);
    const target = join(home, name);
    const sourceTime = await mtimeOf(source);
    if (sourceTime === null) continue;
    const targetTime = await mtimeOf(target);
    if (targetTime !== null && targetTime >= sourceTime) continue;
    try {
      await mkdir(home, { recursive: true });
      await copyAtomic(source, target);
      if (name === "auth.json") result.authRefreshed = true;
      else result.configRefreshed = true;
    } catch (err) {
      console.warn(`[CodexHome] 刷新 ${name} 失败（沿用应用内副本）: ${(err as Error).message}`);
      await unlink(`${target}.${process.pid}.tmp`).catch(() => {});
    }
  }
  return result;
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
  const home = options.home?.trim() || resolveAppCodexHome(undefined, env);
  const sourceHome = options.sourceHome?.trim() || resolveCodexHome(env);
  const refreshed = await refreshCodexLogin(home, sourceHome);
  const result = await provisionWithSdk({ ...options, home, sourceHome, env });
  return {
    ...result,
    authCopied: result.authCopied || refreshed.authRefreshed,
    configCopied: result.configCopied || refreshed.configRefreshed,
  };
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
