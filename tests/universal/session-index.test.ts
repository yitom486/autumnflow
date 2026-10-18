// @vitest-environment node
import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionIndex, childAssociation } from "../../server/universal/session-index";

const folders: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-session-index-"));
  folders.push(root);
  const file = path.join(root, "index.json");
  return { file, index: new SessionIndex(() => file) };
}
afterEach(() => {
  for (const root of folders.splice(0)) {
    const target = path.resolve(root);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("studio-session-index-")) {
      throw new Error("Refusing to remove a directory outside the test fixture location");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("application session references", () => {
  it("survives cache eviction/restart, isolates agents and stores no messages", () => {
    const { file, index } = fixture();
    for (let n = 0; n < 60; n++) index.remember("opencode", `s${n}`, "created", { cwd: "D:/app" });
    index.remember("codex", "s0", "imported");
    expect(new SessionIndex(() => file).list("opencode")).toHaveLength(60);
    expect(index.get("codex", "s0")?.origin).toBe("imported");
    expect(fs.readFileSync(file, "utf8")).not.toContain('"messages"');
    expect(index.get("opencode", "external-session")).toBeUndefined();
  });
  it("keeps nested subagents out of root history and never promotes them on import", () => {
    const { index } = fixture();
    index.remember("a", "root", "created", { cwd: "D:/app" });
    index.linkChild("a", "root", "child", "Explore");
    index.linkChild("a", "child", "grandchild", "Review");
    index.remember("a", "child", "imported");
    expect(index.list("a").filter(row => row.kind === "main").map(row => row.sessionId)).toEqual(["root"]);
    expect(index.children("a", "root").map(row => row.sessionId).sort()).toEqual(["child", "grandchild"]);
    expect(index.get("a", "grandchild")?.cwd).toBe("D:/app");
    expect(() => index.linkChild("a", "grandchild", "root")).toThrow("Cyclic");
    expect(() => index.linkChild("a", "other-root", "child")).toThrow("ownership");
    index.forget("a", "root");
    expect(index.list("a")).toEqual([]);
  });
  it("uses explicit delegation evidence, not titles, IDs or fork parent fields", () => {
    expect(childAssociation("root", { parentID: "root", sessionId: "fork", title: "subagent" })).toBeNull();
    expect(childAssociation("root", { sessionUpdate: "subagent_update", sessionId: "child", title: "Review" }))
      .toEqual({ sessionId: "child", parentSessionId: "root", title: "Review" });
    expect(childAssociation("root", { _meta: { "opencode/child-session": { id: "child", parentID: "root", depth: 1 } } }))
      .toEqual({ sessionId: "child", parentSessionId: "root", title: undefined });
  });
  it("reports corrupt indexes instead of replacing them with an empty history", () => {
    const { file, index } = fixture();
    fs.writeFileSync(file, "broken");
    expect(() => index.list("a")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("broken");
  });
  it("merges Agent titles into existing references without auto-importing rows", () => {
    const { index } = fixture();
    index.remember("a", "s1", "created", { cwd: "D:/app" });
    index.updateMany("a", [
      { sessionId: "s1", title: "  PyQt 看板选型  ", updatedAt: "2026-10-18T00:00:00.000Z" },
      { sessionId: "external", title: "不应导入", updatedAt: "2026-10-18T00:00:00.000Z" },
    ]);
    expect(index.get("a", "s1")).toMatchObject({
      title: "PyQt 看板选型",
      updatedAt: "2026-10-18T00:00:00.000Z",
    });
    expect(index.get("a", "external")).toBeUndefined();
  });
});
