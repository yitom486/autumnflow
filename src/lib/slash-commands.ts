/**
 * Slash-command helpers (pure, unit-tested).
 *
 * ACP: agents advertise commands via `available_commands_update`
 * ({ name, description, input?: { hint } }); invoking one is just sending
 * `/name args` as ordinary prompt text. Local commands are handled entirely
 * client-side and never reach the agent.
 */

export interface SlashCommand {
  name: string;
  description?: string;
  /** ACP AvailableCommand.input.hint — placeholder for the argument. */
  hint?: string;
  /** Handled by AutumnFlow itself (not sent to the agent). */
  local?: boolean;
}

/** `/` token at the end of the text: any non-space chars (`/review:pr`, `/a.b`). */
const SLASH_TOKEN_RE = /(^|\s)(\/[^\s/]*)$/;

export function matchSlashToken(text: string): string | null {
  const m = text.match(SLASH_TOKEN_RE);
  return m ? m[2] : null;
}

export function replaceSlashToken(text: string, name: string): string {
  const full = name.startsWith("/") ? name : `/${name}`;
  return text.replace(SLASH_TOKEN_RE, `$1${full} `);
}

/** Normalize the raw ACP list, keeping name / description / input.hint. */
export function normalizeAgentCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim().replace(/^\//, "") : "";
    if (!name || /\s/.test(name) || seen.has(name)) continue;
    seen.add(name);
    const input = r.input as Record<string, unknown> | null | undefined;
    const hint = input && typeof input.hint === "string" && input.hint.trim() ? input.hint.trim() : undefined;
    out.push({
      name,
      ...(typeof r.description === "string" && r.description ? { description: r.description } : {}),
      ...(hint ? { hint } : {}),
    });
  }
  return out;
}

export const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "清空当前对话视图", local: true },
  { name: "mode", description: "切换会话模式", hint: "模式 ID 或名称", local: true },
  { name: "help", description: "列出可用命令", local: true },
];

/** Agent commands first; a local command is hidden when the agent defines the same name. */
export function mergeCommands(agent: SlashCommand[], local: SlashCommand[] = LOCAL_COMMANDS): SlashCommand[] {
  const names = new Set(agent.map((c) => c.name));
  return [...agent, ...local.filter((c) => !names.has(c.name))];
}

export function filterCommands(list: SlashCommand[], token: string | null): SlashCommand[] {
  if (token == null) return [];
  const q = token.replace(/^\//, "").toLowerCase();
  if (!q) return list;
  const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = list.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/** If `text` invokes a local command (not shadowed by the agent), return it. */
export function parseLocalCommand(text: string, agent: SlashCommand[]): { name: string; arg: string } | null {
  const m = text.trim().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const name = m[1];
  if (agent.some((c) => c.name === name)) return null;
  if (!LOCAL_COMMANDS.some((c) => c.name === name)) return null;
  return { name, arg: (m[2] || "").trim() };
}

/** Resolve a /mode argument against the session's available modes (id or name, case-insensitive). */
export function resolveMode(
  arg: string,
  modes: Array<{ id: string; name?: string }> | undefined | null,
): { id: string; name?: string } | null {
  if (!arg || !modes?.length) return null;
  const q = arg.toLowerCase();
  return (
    modes.find((m) => m.id.toLowerCase() === q) ||
    modes.find((m) => (m.name || "").toLowerCase() === q) ||
    modes.find((m) => m.id.toLowerCase().startsWith(q) || (m.name || "").toLowerCase().startsWith(q)) ||
    null
  );
}
