/** Turns currently owned by a live send in this renderer (not persisted). */
const liveTurns = new Set<string>();

export function markTurnLive(turnId: string): void {
  liveTurns.add(turnId);
}

export function clearTurnLive(turnId: string): void {
  liveTurns.delete(turnId);
}

export function isTurnLive(turnId: string): boolean {
  return liveTurns.has(turnId);
}
