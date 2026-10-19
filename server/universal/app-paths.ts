/**
 * The application's per-user home directory.
 *
 * This is the single source of truth for state that used to live under
 * `~/.acp-studio`: custom agents, the gateway token, the turn journal, the
 * trash and the isolated Codex home. The old directory is copied once when the
 * new one does not exist yet; it is never written again.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Current home directory name (under the user's home or XDG state home). */
export const APP_HOME_DIR = ".autumnflow";
/** Previous name, read only during the one-time migration. */
export const LEGACY_APP_HOME_DIR = ".acp-studio";
/** Previous resources directory (`AGENTS.md` + skills), migrated into `<home>/resources`. */
export const LEGACY_RESOURCES_DIR = ".acp-client";

/**
 * Resolve the app home.
 *
 * Order: `AUTUMNFLOW_HOME` (a full path), then `XDG_STATE_HOME` / `ACP_HOME`
 * as a base directory, then the user's home.
 */
export function resolveAppHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.AUTUMNFLOW_HOME?.trim();
  if (explicit) return explicit;
  const base = env.XDG_STATE_HOME?.trim() || env.ACP_HOME?.trim();
  if (base) return join(base, APP_HOME_DIR);
  return join(homedir(), APP_HOME_DIR);
}

/** The directory the previous name used; migration source only. */
export function resolveLegacyAppHome(env: NodeJS.ProcessEnv = process.env): string {
  // Derive the legacy sibling from the resolved target so a custom
  // AUTUMNFLOW_HOME never falls back to the real user home.
  return join(dirname(resolveAppHome(env)), LEGACY_APP_HOME_DIR);
}

/**
 * Copy the legacy home into the new one when the new one is absent.
 *
 * Copy, not move: a failed or partial migration must leave the old data
 * readable. The legacy directory is never modified by this process.
 *
 * @returns true when a copy happened.
 */
export function migrateLegacyAppHome(options: {
  target?: string;
  legacy?: string;
  env?: NodeJS.ProcessEnv;
} = {}): boolean {
  const env = options.env ?? process.env;
  const target = options.target ?? resolveAppHome(env);
  const legacy = options.legacy ?? resolveLegacyAppHome(env);
  if (existsSync(target) || !existsSync(legacy)) return false;
  try {
    mkdirSync(dirname(target), { recursive: true });
    cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
    return true;
  } catch (error) {
    console.warn(`[AutumnFlow] 迁移旧配置目录失败（保留 ${legacy}）:`, error);
    return false;
  }
}

/** Ensure the app home exists, migrating the legacy ones on first run. */
export function ensureAppHome(env: NodeJS.ProcessEnv = process.env): string {
  migrateLegacyAppHome({ env });
  const home = resolveAppHome(env);
  mkdirSync(home, { recursive: true });
  migrateLegacyResources(home);
  return home;
}

/**
 * Copy `~/.acp-client` (AGENTS.md + skills) into `<home>/resources` once.
 * The old directory is left untouched and is never written again.
 */
export function migrateLegacyResources(home: string): boolean {
  const legacy = join(dirname(home), LEGACY_RESOURCES_DIR);
  const target = join(home, "resources");
  if (existsSync(target) || !existsSync(legacy)) return false;
  try {
    cpSync(legacy, target, { recursive: true, force: false, errorOnExist: false });
    return true;
  } catch (error) {
    console.warn(`[AutumnFlow] 迁移旧资源目录失败（保留 ${legacy}）:`, error);
    return false;
  }
}
