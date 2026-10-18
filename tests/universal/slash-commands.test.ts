// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  matchSlashToken, replaceSlashToken, normalizeAgentCommands, mergeCommands,
  filterCommands, parseLocalCommand, resolveMode, LOCAL_COMMANDS,
} from "../../src/lib/slash-commands";
import { useStudioStore } from "../../src/stores/useStudioStore";
import { UniversalAgentConnection as AgentConnection } from "../../server/universal/AgentConnection";

describe("slash token", () => {
  it("accepts broad command chars (: . etc.)", () => {
    expect(matchSlashToken("/")).toBe("/");
    expect(matchSlashToken("hi /review:pr")).toBe("/review:pr");
    expect(matchSlashToken("/speckit.plan")).toBe("/speckit.plan");
    expect(matchSlashToken("/init ")).toBeNull();
    expect(matchSlashToken("a/b")).toBeNull();
    expect(matchSlashToken("/usr/bin")).toBeNull();
  });
  it("replaces the trailing token", () => {
    expect(replaceSlashToken("fix this /rev", "review:pr")).toBe("fix this /review:pr ");
  });
});

describe("normalize / merge / filter", () => {
  const raw = [
    { name: "review", description: "Review code", input: { hint: "branch or PR" } },
    { name: "/init", description: "Init" },
    { name: "review" },
    { name: "bad name" },
    null,
    { name: "clear", description: "agent clear" },
  ];
  it("keeps name, description and input.hint; drops junk/dupes", () => {
    expect(normalizeAgentCommands(raw)).toEqual([
      { name: "review", description: "Review code", hint: "branch or PR" },
      { name: "init", description: "Init" },
      { name: "clear", description: "agent clear" },
    ]);
    expect(normalizeAgentCommands(undefined)).toEqual([]);
  });
  it("merges local commands after agent ones, agent wins on name clash", () => {
    const merged = mergeCommands(normalizeAgentCommands(raw));
    expect(merged.filter((c) => c.name === "clear")).toEqual([{ name: "clear", description: "agent clear" }]);
    expect(merged.find((c) => c.name === "mode")?.local).toBe(true);
    expect(mergeCommands([]).every((c) => c.local)).toBe(true);
  });
  it("filters by prefix then substring", () => {
    const list = mergeCommands(normalizeAgentCommands(raw));
    expect(filterCommands(list, "/").length).toBe(list.length);
    expect(filterCommands(list, "/i").map((c) => c.name)).toEqual(["init", "review"]);
    expect(filterCommands(list, null)).toEqual([]);
  });
});

describe("local commands", () => {
  it("parses only unshadowed local commands", () => {
    expect(parseLocalCommand("/clear", [])).toEqual({ name: "clear", arg: "" });
    expect(parseLocalCommand(" /mode  plan ", [])).toEqual({ name: "mode", arg: "plan" });
    expect(parseLocalCommand("/clear", [{ name: "clear" }])).toBeNull();
    expect(parseLocalCommand("/review x", [])).toBeNull();
    expect(parseLocalCommand("please /clear", [])).toBeNull();
    expect(LOCAL_COMMANDS.every((c) => c.local)).toBe(true);
  });
  it("resolves modes by id or name", () => {
    const modes = [{ id: "default", name: "Default" }, { id: "plan", name: "Plan Mode" }];
    expect(resolveMode("PLAN", modes)?.id).toBe("plan");
    expect(resolveMode("plan mode", modes)?.id).toBe("plan");
    expect(resolveMode("def", modes)?.id).toBe("default");
    expect(resolveMode("x", modes)).toBeNull();
  });
});

describe("store: commands per session", () => {
  beforeEach(() => useStudioStore.getState().resetStudio());
  it("keeps commands per session across switches", () => {
    const s = useStudioStore.getState();
    s.setActiveAgentId("codex");
    s.applySessionResult({ sessionId: "A", availableCommands: [{ name: "a1", input: { hint: "h" } }] });
    expect(useStudioStore.getState().availableCommands).toEqual([{ name: "a1", hint: "h" }]);
    useStudioStore.getState().setSessionId("B");
    expect(useStudioStore.getState().availableCommands).toEqual([]);
    // late update for A while B is current: stored, view untouched
    useStudioStore.getState().setAvailableCommands([{ name: "a2" }], "A");
    expect(useStudioStore.getState().availableCommands).toEqual([]);
    useStudioStore.getState().setAvailableCommands([{ name: "b1" }]);
    expect(useStudioStore.getState().availableCommands.map((c) => c.name)).toEqual(["b1"]);
    useStudioStore.getState().setSessionId("A");
    expect(useStudioStore.getState().availableCommands.map((c) => c.name)).toEqual(["a2"]);
  });
  it("does not leak the previous session's commands into a new session result", () => {
    const s = useStudioStore.getState();
    s.applySessionResult({ sessionId: "A", availableCommands: [{ name: "a1" }] });
    useStudioStore.getState().applySessionResult({ sessionId: "C" });
    expect(useStudioStore.getState().availableCommands).toEqual([]);
  });
});

describe("gateway: available_commands_update cache", () => {
  it("caches commands that arrive before anyone subscribes", async () => {
    const conn = new AgentConnection({ id: "mock", name: "mock", title: "Mock", command: "true", args: [] } as never);
    expect(conn.getAvailableCommands("s1")).toBeUndefined();
    setTimeout(() => (conn as any).state.commands.set("s1", [{ name: "x", input: { hint: "h" } }]), 40);
    expect(await conn.awaitAvailableCommands("s1", 200)).toEqual([{ name: "x", input: { hint: "h" } }]);
    expect(await conn.awaitAvailableCommands("none", 50)).toBeUndefined();
  });
});

import { isBenignWindowError } from "../../src/lib/error-bus";
describe("error bus", () => {
  it("treats ResizeObserver loop notices as benign", () => {
    expect(isBenignWindowError("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isBenignWindowError("ResizeObserver loop limit exceeded")).toBe(true);
    expect(isBenignWindowError("TypeError: x is undefined")).toBe(false);
  });
});
