/**
 * Background residency policy (pure; no Electron imports so it can be tested).
 *
 * The desktop shell is a hybrid: closing the last window only keeps the app
 * alive while the host is actually doing work. This module owns the decision —
 * when to notify, when to auto-exit after idleness — and the shell only wires
 * the side effects (tray, notification, quit). See BackgroundKeeper.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface BackgroundSettings {
  /** Keep running in the tray when the last window closes with work in flight. */
  enabled: boolean;
  /** Auto-quit after this many idle minutes in the background; 0 = never. */
  idleExitMinutes: number;
}

export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  enabled: true,
  idleExitMinutes: 30,
};

export const IDLE_EXIT_CHOICES = [0, 5, 15, 30, 60] as const;

function clampIdleMinutes(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Tolerate a missing/corrupt file: residency must never block startup. */
export function readBackgroundSettings(dir: string): BackgroundSettings {
  try {
    const file = path.join(dir, "background.json");
    if (!fs.existsSync(file)) return { ...DEFAULT_BACKGROUND_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return {
      enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_BACKGROUND_SETTINGS.enabled,
      idleExitMinutes: clampIdleMinutes(raw?.idleExitMinutes, DEFAULT_BACKGROUND_SETTINGS.idleExitMinutes),
    };
  } catch {
    return { ...DEFAULT_BACKGROUND_SETTINGS };
  }
}

export function writeBackgroundSettings(dir: string, settings: BackgroundSettings): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "background.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  } catch (err) {
    console.warn("[Electron] background settings write failed:", err);
  }
}

/**
 * Tracks work while the app has no visible window.
 *
 * `markWork` is fed the active-work count on every poll. It fires
 * `onAllWorkDone` exactly once per background session (so the shell can raise a
 * "finished" notification) and `onIdleExit` once the idle window elapses.
 */
export class BackgroundKeeper {
  private idleSince: number | null = null;
  private hadWork = false;
  private doneNotified = false;
  private exited = false;
  private settings: BackgroundSettings;
  private readonly now: () => number;
  private readonly onAllWorkDone: () => void;
  private readonly onIdleExit: () => void;

  constructor(opts: {
    settings: BackgroundSettings;
    now?: () => number;
    onAllWorkDone?: () => void;
    onIdleExit?: () => void;
  }) {
    this.settings = { ...opts.settings };
    this.now = opts.now ?? (() => Date.now());
    this.onAllWorkDone = opts.onAllWorkDone ?? (() => {});
    this.onIdleExit = opts.onIdleExit ?? (() => {});
  }

  /** Window closed with work in flight; start a background session. */
  begin(): void {
    this.idleSince = null;
    this.hadWork = false;
    this.doneNotified = false;
    this.exited = false;
  }

  /** A window came back (or the app is quitting): stop tracking. */
  end(): void {
    this.idleSince = null;
    this.hadWork = false;
  }

  updateSettings(settings: BackgroundSettings): void {
    this.settings = { ...settings };
    if (this.idleSince !== null) this.idleSince = this.now();
  }

  get idleMiss(): number | null {
    if (this.idleSince === null) return null;
    return Math.max(0, this.now() - this.idleSince);
  }

  get notified(): boolean {
    return this.doneNotified;
  }

  /**
   * Feed one active-work sample. Returns true when the shell should keep
   * running in the background (work seen or recently seen); false when there is
   * nothing to protect any more and the caller may quit immediately.
   */
  markWork(count: number): boolean {
    const work = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (work > 0) {
      this.hadWork = true;
      this.doneNotified = false;
      this.idleSince = null;
      return true;
    }
    if (!this.hadWork && this.idleSince === null) {
      // Closed with nothing running: quitting right away is the documented
      // behaviour, and it must not be delayed by the idle window.
      return false;
    }
    if (!this.doneNotified) {
      this.doneNotified = true;
      this.onAllWorkDone();
    }
    if (this.idleSince === null) this.idleSince = this.now();
    const limit = this.settings.idleExitMinutes;
    if (limit > 0 && !this.exited && this.now() - this.idleSince >= limit * 60_000) {
      this.exited = true;
      this.onIdleExit();
    }
    return true;
  }
}
