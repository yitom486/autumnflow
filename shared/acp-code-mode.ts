/**
 * Session-level code mode (PTC) capability, shared by the gateway and the
 * renderer.
 *
 * An agent declares the presentations it offers in `initialize`:
 *
 *   agentCapabilities._meta.toolsMode.values = ['native', 'ptc']
 *
 * A client then selects one per session through `_meta.toolsMode` on
 * session/new and session/resume. Support is read from that declaration and
 * nothing else: a runtime id is not evidence of a code mode, and guessing one
 * would show a switch that silently does nothing.
 *
 * This mirrors `@yitom/acp-client`'s `session/code-mode` helper. It lives here
 * as well because the renderer must not import the SDK (its runtime adapters
 * pull Node built-ins that Rollup cannot bundle for the browser).
 */

export type AcpCodeMode = 'on' | 'off'

/** The presentations an agent declares, or null when it declares nothing. */
export function parseCodeModeModes(
  caps: Record<string, unknown> | null | undefined,
): string[] | null {
  const meta = caps?._meta;
  if (!meta || typeof meta !== 'object') return null;
  const toolsMode = (meta as Record<string, unknown>).toolsMode;
  if (!toolsMode || typeof toolsMode !== 'object') return null;
  const values = (toolsMode as { values?: unknown }).values;
  if (!Array.isArray(values)) return null;
  const modes = values.filter((value): value is string => typeof value === 'string');
  return modes.length > 0 ? modes : null;
}

/** Whether this agent declares a code-mode presentation. */
export function supportsCodeMode(
  caps: Record<string, unknown> | null | undefined,
): boolean {
  return parseCodeModeModes(caps)?.includes('ptc') === true;
}
