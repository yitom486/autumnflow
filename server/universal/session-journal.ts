/**
 * Persistent per-turn journal.
 *
 * TurnRegistry owns live execution; this module owns durability. Each turn is
 * one JSONL file (`journal/<agent>/<turn>.jsonl`) containing a meta line, one
 * line per sequenced event, and a finish line. Token-rate writes are coalesced
 * into short batches; finish() flushes immediately, and the host flushes all
 * pending batches before exiting.
 *
 * A file without a finish line means the host died mid-turn. It is restored as
 * an interrupted terminal turn, never replayed into a second prompt.
 */
import { appendFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import * as path from "node:path";
import type { TurnEvent, TurnRecord, TurnStatus } from "./turn-registry";
import { resolveAppHome } from "./app-paths";

export type JournalTurnStatus = Exclude<TurnStatus, "running"> | "interrupted";

export interface LoadedTurn {
  turnId: string;
  agentId: string;
  sessionId: string;
  status: JournalTurnStatus;
  events: TurnEvent[];
  startedAt: number;
}

const MAX_TURN_FILES = 500;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function safePart(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
  return safe || "unknown";
}

function resolveJournalRoot(): string {
  return process.env.ACP_SESSION_JOURNAL_DIR || path.join(resolveAppHome(), "journal");
}

export class SessionJournal {
  private readonly buffers = new Map<string, string[]>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seen = new Set<string>();

  constructor(private readonly root = resolveJournalRoot()) {}

  /** Journal files this instance still tracks; pruned files are forgotten. */
  get trackedFiles(): number {
    return this.seen.size;
  }

  private fileFor(agentId: string, turnId: string): string {
    return path.join(this.root, safePart(agentId), `${safePart(turnId)}.jsonl`);
  }

  private enqueue(file: string, lines: string[]): void {
    if (lines.length === 0) return;
    const buffer = this.buffers.get(file) || [];
    buffer.push(...lines);
    this.buffers.set(file, buffer);
    if (this.timers.has(file)) return;
    const timer = setTimeout(() => {
      this.timers.delete(file);
      void this.flushFile(file).catch((err) => {
        console.error(`[SessionJournal] flush failed ${file}:`, err);
      });
    }, 50);
    timer.unref?.();
    this.timers.set(file, timer);
  }

  append(record: TurnRecord, event: TurnEvent): void {
    const file = this.fileFor(record.agentId, record.id);
    const lines: string[] = [];
    if (!this.seen.has(file)) {
      this.seen.add(file);
      lines.push(
        JSON.stringify({
          type: "meta",
          turnId: record.id,
          agentId: record.agentId,
          sessionId: record.sessionId,
          startedAt: record.createdAt,
        }) + "\n"
      );
    }
    lines.push(
      JSON.stringify({
        type: "event",
        seq: event.seq,
        ts: Date.now(),
        data: event.data,
      }) + "\n"
    );
    this.enqueue(file, lines);
  }

  finish(record: TurnRecord, status: Exclude<TurnStatus, "running">): void {
    const file = this.fileFor(record.agentId, record.id);
    this.enqueue(file, [JSON.stringify({ type: "finish", status, ts: Date.now() }) + "\n"]);
    void this.flushFile(file).catch((err) => {
      console.error(`[SessionJournal] final flush failed ${file}:`, err);
    });
  }

  private async flushFile(file: string): Promise<void> {
    const timer = this.timers.get(file);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(file);
    }
    const lines = this.buffers.get(file);
    if (!lines || lines.length === 0) return;
    this.buffers.delete(file);
    const payload = lines.join("");
    const previous = this.queues.get(file) || Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await appendFile(file, payload, { encoding: "utf8", mode: 0o600 });
      })
      .catch((err) => {
        console.error(`[SessionJournal] append failed ${file}:`, err);
      });
    this.queues.set(file, next);
    await next;
  }

  private async readFileTurn(file: string): Promise<LoadedTurn | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let meta: { turnId?: string; agentId?: string; sessionId?: string; startedAt?: number } | null = null;
    const events = new Map<number, TurnEvent>();
    let status: JournalTurnStatus = "interrupted";
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A process kill can leave a partial last line; keep the intact prefix.
        continue;
      }
      if (parsed.type === "meta") meta = parsed;
      else if (parsed.type === "event" && Number.isFinite(parsed.seq) && parsed.data) {
        events.set(Math.floor(parsed.seq), { seq: Math.floor(parsed.seq), data: parsed.data });
      } else if (parsed.type === "finish" && (parsed.status === "done" || parsed.status === "error")) {
        status = parsed.status;
      }
    }
    if (!meta?.turnId || !meta.agentId) return null;
    return {
      turnId: String(meta.turnId),
      agentId: String(meta.agentId),
      sessionId: String(meta.sessionId || ""),
      status,
      events: [...events.values()].sort((a, b) => a.seq - b.seq),
      startedAt: Number(meta.startedAt) || 0,
    };
  }

  async loadTurn(agentId: string, turnId: string): Promise<LoadedTurn | null> {
    const file = this.fileFor(agentId, turnId);
    const loaded = await this.readFileTurn(file);
    if (loaded) this.seen.add(file);
    return loaded;
  }

  /** Find a turn without knowing its agent (used by GET /chat/:turnId/follow). */
  async loadTurnById(turnId: string): Promise<LoadedTurn | null> {
    let agents: string[];
    try {
      agents = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const wanted = `${safePart(turnId)}.jsonl`;
    for (const agent of agents) {
      const file = path.join(this.root, agent, wanted);
      const loaded = await this.readFileTurn(file);
      if (loaded) {
        this.seen.add(file);
        return loaded;
      }
    }
    return null;
  }

  async flushAll(): Promise<void> {
    const files = new Set([...this.buffers.keys(), ...this.queues.keys()]);
    for (const [file, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(file);
      files.add(file);
    }
    await Promise.all([...files].map((file) => this.flushFile(file)));
    await Promise.all([...this.queues.values()]);
  }

  /** Keep the journal bounded; only generated `.jsonl` files are touched. */
  async prune(now = Date.now()): Promise<void> {
    let agents: string[];
    try {
      agents = await readdir(this.root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const files: Array<{ file: string; mtime: number }> = [];
    for (const agent of agents) {
      const dir = path.join(this.root, agent);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        try {
          const info = await stat(file);
          if (now - info.mtimeMs > RETENTION_MS) await this.removeFile(file);
          else files.push({ file, mtime: info.mtimeMs });
        } catch {
          // concurrently pruned
        }
      }
    }
    files.sort((a, b) => a.mtime - b.mtime);
    for (const { file } of files.slice(0, Math.max(0, files.length - MAX_TURN_FILES))) {
      await this.removeFile(file);
    }
  }

  /**
   * Delete a journal file and forget it. The `seen` set is the only unbounded
   * structure here: a long-lived host writes one file per turn, so dropping
   * the file without dropping the marker would grow the set forever.
   */
  private async removeFile(file: string): Promise<void> {
    this.seen.delete(file);
    await unlink(file).catch(() => {});
  }
}

let singleton: SessionJournal | null | undefined;

/** Journal is disabled in unit tests unless a directory is explicitly set. */
export function getSessionJournal(): SessionJournal | null {
  if (singleton !== undefined) return singleton;
  if (process.env.NODE_ENV === "test" && !process.env.ACP_SESSION_JOURNAL_DIR) {
    singleton = null;
  } else {
    singleton = new SessionJournal();
  }
  return singleton;
}

export async function flushSessionJournal(): Promise<void> {
  await getSessionJournal()?.flushAll();
}

/** Test-only reset for the process-wide journal. */
export function resetSessionJournalForTest(root?: string): void {
  singleton = root ? new SessionJournal(root) : undefined;
}
