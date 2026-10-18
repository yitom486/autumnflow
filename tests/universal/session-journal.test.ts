// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionJournal } from "../../server/universal/session-journal";
import { TurnRegistry } from "../../server/universal/turn-registry";

const dirs: string[] = [];
const registries: TurnRegistry[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autumnflow-journal-"));
  dirs.push(dir);
  return dir;
}
function journalRegistry(journal: SessionJournal) {
  const registry = new TurnRegistry({
    append: (record, event) => journal.append(record, event),
    finish: (record, status) => journal.finish(record, status),
  });
  registries.push(registry);
  return registry;
}
afterEach(() => {
  for (const registry of registries.splice(0)) registry.resetForTest();
  for (const dir of dirs.splice(0)) {
    if (path.basename(dir).startsWith("autumnflow-journal-")) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("SessionJournal", () => {
  it("persists sequenced events and restores a completed turn", async () => {
    const dir = tempDir();
    const journal = new SessionJournal(dir);
    const registry = journalRegistry(journal);
    registry.create("turn-1", { agentId: "opencode", sessionId: "ses_1" });
    registry.append("turn-1", { type: "start" });
    registry.append("turn-1", { type: "update", update: { sessionUpdate: "agent_message_chunk" } });
    registry.finish("turn-1", "done");
    await journal.flushAll();

    const loaded = await journal.loadTurn("opencode", "turn-1");
    expect(loaded?.status).toBe("done");
    expect(loaded?.sessionId).toBe("ses_1");
    expect(loaded?.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(loaded?.events[1].data.type).toBe("update");

    const restored = new TurnRegistry().restore(loaded!);
    expect(restored.status).toBe("done");
    expect(restored.events).toHaveLength(2);
    expect(restored.nextSeq).toBe(3);
  });

  it("turns an unfinished file into one terminal interruption, never a re-prompt", async () => {
    const dir = tempDir();
    const journal = new SessionJournal(dir);
    const registry = journalRegistry(journal);
    registry.create("turn-2", { agentId: "codex", sessionId: "ses_2" });
    registry.append("turn-2", { type: "start" });
    await journal.flushAll();

    const loaded = await journal.loadTurn("codex", "turn-2");
    expect(loaded?.status).toBe("interrupted");

    const restoredRegistry = journalRegistry(journal);
    const restored = restoredRegistry.restore(loaded!);
    expect(restored.status).toBe("error");
    const last = restored.events.at(-1)!;
    expect(last.data.type).toBe("error");
    expect(String(last.data.message)).toContain("restarted");
    // Re-restoring from the new finish line is stable.
    await journal.flushAll();
    expect((await journal.loadTurn("codex", "turn-2"))?.status).toBe("error");
    const lines = fs.readFileSync(path.join(dir, "codex", "turn-2.jsonl"), "utf8").split(/\r?\n/);
    expect(lines.filter((line) => line.includes('"type":"meta"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"type":"finish"'))).toHaveLength(1);
  });

  it("can find a turn by id without its agent and ignores partial lines", async () => {
    const dir = tempDir();
    const journal = new SessionJournal(dir);
    const registry = journalRegistry(journal);
    registry.create("turn-3", { agentId: "antigravity", sessionId: "ses_3" });
    registry.append("turn-3", { type: "start" });
    registry.finish("turn-3", "done");
    await journal.flushAll();
    const file = path.join(dir, "antigravity", "turn-3.jsonl");
    fs.appendFileSync(file, '{"type":"event","seq":99');

    const loaded = await journal.loadTurnById("turn-3");
    expect(loaded?.turnId).toBe("turn-3");
    expect(loaded?.status).toBe("done");
    expect(loaded?.events.map((event) => event.seq)).toEqual([1]);
    expect(await journal.loadTurnById("nope")).toBeNull();
  });
});
