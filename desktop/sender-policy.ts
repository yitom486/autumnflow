/**
 * Pure IPC sender policy: the caller frame must be the app-owned main frame,
 * and its document URL must share the exact origin of the configured app URL.
 * Keeping this separate from Electron lets the rule be unit-tested.
 */
export function isTrustedSenderUrl(raw: string | undefined | null, appUrl: string): boolean {
  if (!raw) return false;
  try {
    return new URL(raw).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
