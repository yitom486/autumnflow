/**
 * Which studio-ui tools and skills the agent is allowed to use.
 *
 * The toggles live in a small file next to the other application state so
 * they survive restarts. Tool switches take effect immediately (the MCP server
 * hides the tool from tools/list); skill switches take effect for the
 * catalogue immediately and for the agent's resource snapshot on the next
 * connect, because the snapshot is written once per agent process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAppHome } from "./app-paths";

export interface CapabilityState {
  /** Tool names the agent may not call. */
  disabledTools: string[];
  /** Skill names that are hidden from the catalogue and the agent. */
  disabledSkills: string[];
}

const EMPTY: CapabilityState = { disabledTools: [], disabledSkills: [] };

function stateFile(): string {
  return path.join(resolveAppHome(), "capabilities.json");
}

function sanitizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function readCapabilityState(): CapabilityState {
  try {
    const raw = fs.readFileSync(stateFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...EMPTY };
    return {
      disabledTools: sanitizeList(parsed.disabledTools),
      disabledSkills: sanitizeList(parsed.disabledSkills),
    };
  } catch {
    // A missing or corrupt file must never block startup: no switches set.
    return { ...EMPTY };
  }
}

/** Atomic write so a crash cannot leave a half-written switch file. */
export function writeCapabilityState(state: CapabilityState): void {
  const file = stateFile();
  const payload = JSON.stringify(
    {
      disabledTools: sanitizeList(state.disabledTools),
      disabledSkills: sanitizeList(state.disabledSkills),
    },
    null,
    2
  ) + "\n";
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, payload, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

export function isToolEnabled(name: string): boolean {
  return !readCapabilityState().disabledTools.includes(name);
}

export function isSkillEnabled(name: string): boolean {
  return !readCapabilityState().disabledSkills.includes(name);
}

/** Turn a tool on or off. Returns the resulting state. */
export function setToolEnabled(name: string, enabled: boolean): CapabilityState {
  const state = readCapabilityState();
  const disabled = new Set(state.disabledTools);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  const next = { ...state, disabledTools: [...disabled] };
  writeCapabilityState(next);
  return next;
}

/** Turn a skill on or off. Returns the resulting state. */
export function setSkillEnabled(name: string, enabled: boolean): CapabilityState {
  const state = readCapabilityState();
  const disabled = new Set(state.disabledSkills);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  const next = { ...state, disabledSkills: [...disabled] };
  writeCapabilityState(next);
  return next;
}
