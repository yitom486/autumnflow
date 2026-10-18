import { describe, expect, test } from "vitest";
import {
  deriveSessionTitle,
  findThreadBySessionId,
  freezeMessage,
  isDefaultSessionTitle,
  isThreadEmpty,
  partitionTurnContent,
  pruneThreads,
  threadForAgent,
  titleForThread,
  toEnvironmentNativeCwd,
  type ChatThread,
} from "../../src/lib/threads";

function msg(role: "user" | "assistant", content: string, extra: object = {}) {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  } as any;
}

function thread(partial: Partial<ChatThread> & { id: string; agentId: string }): ChatThread {
  return {
    sessionId: null,
    messages: [],
    updatedAt: Date.now(),
    ...partial,
  };
}

describe("threads (per-agent persisted records)", () => {
  test("threadForAgent isolates agents and picks the latest", () => {
    const aOld = thread({ id: "a-old", agentId: "codex", updatedAt: 10 });
    const aNew = thread({ id: "a-new", agentId: "codex", updatedAt: 20 });
    const b = thread({ id: "b", agentId: "antigravity-stdio", updatedAt: 99 });
    const all = { "a-old": aOld, "a-new": aNew, b };
    expect(threadForAgent(all, "codex")?.id).toBe("a-new");
    // Session ids must never leak across agents: lookup is strictly filtered.
    expect(threadForAgent(all, "antigravity-stdio")?.id).toBe("b");
    expect(threadForAgent(all, "unknown-agent")).toBeNull();
  });

  test("pruneThreads drops blank threads but preserves the live draft", () => {
    const blank = thread({ id: "blank", agentId: "codex", messages: [] });
    const live = thread({ id: "live", agentId: "codex", messages: [] });
    const full = thread({
      id: "full",
      agentId: "codex",
      messages: [msg("user", "hi"), msg("assistant", "hello")],
    });
    const out = pruneThreads({ blank, live, full }, ["live"]);
    expect(out.blank).toBeUndefined();
    expect(out.live).toBeDefined();
    expect(out.full.messages).toHaveLength(2);
  });

  test("freezeMessage strips streaming flags, tool calls, and truncates", () => {
    const m = msg("assistant", "x".repeat(25000), {
      isStreaming: true,
      thought: "reasoning here",
      toolCalls: [{ id: "t", title: "t", status: "running" }],
    });
    const f = freezeMessage(m);
    expect(f.isStreaming).toBe(false);
    expect(f.content.length).toBeLessThanOrEqual(20000 + 100);
    // Persist policy: history keeps the final answer (+thought), and compact
    // tool calls/results for generative cards rendering.
    expect(f.toolCalls).toBeDefined();
    expect(f.toolCalls?.[0].id).toBe("t");
    expect(f.thought).toBe("reasoning here");
  });

  test("pruneThreads preserves mcpServers on threads", () => {
    const servers = [{ name: "inkdown", command: "node", args: [], env: [] }];
    const t = thread({
      id: "m",
      agentId: "antigravity-stdio",
      messages: [msg("user", "hi")],
      mcpServers: servers,
    });
    const out = pruneThreads({ m: t });
    expect(out.m.messages).toHaveLength(1);
    expect(out.m.mcpServers).toEqual(servers);
    // Isolation still holds: lookup never crosses agents.
    expect(threadForAgent(out, "codex")).toBeNull();
    expect(threadForAgent(out, "antigravity-stdio")?.mcpServers).toEqual(servers);
  });

  test("pruneThreads caps thread and message counts", () => {    const many: Record<string, ChatThread> = {};
    for (let i = 0; i < 50; i++) {
      many[`t${i}`] = thread({
        id: `t${i}`,
        agentId: "codex",
        updatedAt: i,
        messages: [msg("user", `q${i}`)],
      });
    }
    const big = thread({
      id: "big",
      agentId: "codex",
      updatedAt: 1000,
      messages: Array.from({ length: 300 }, (_, i) => msg("user", `m${i}`)),
    });
    const out = pruneThreads({ ...many, big });
    expect(Object.keys(out).length).toBeLessThanOrEqual(40);
    expect(out.big.messages).toHaveLength(200);
  });

  test("findThreadBySessionId locates matching agent thread for optimistic switch", () => {
    const t1 = thread({ id: "t1", agentId: "codex", sessionId: "sess-123" });
    const t2 = thread({ id: "t2", agentId: "codex", sessionId: "sess-456" });
    const tOther = thread({ id: "t3", agentId: "gemini", sessionId: "sess-123" });
    const dict = { t1, t2, tOther };

    expect(findThreadBySessionId(dict, "codex", "sess-123")?.id).toBe("t1");
    expect(findThreadBySessionId(dict, "codex", "sess-456")?.id).toBe("t2");
    expect(findThreadBySessionId(dict, "gemini", "sess-123")?.id).toBe("t3");
    expect(findThreadBySessionId(dict, "codex", "sess-unknown")).toBeNull();
    expect(findThreadBySessionId(dict, "codex", "")).toBeNull();
  });

  test("partitionTurnContent separates intermediate progress and final conclusion", () => {
    // 1. Explicit progressContent
    const res1 = partitionTurnContent("最终完成，所有测试通过。", "排查代码中...\n核对配置...");
    expect(res1.progress).toBe("排查代码中...\n核对配置...");
    expect(res1.conclusion).toBe("最终完成，所有测试通过。");

    // 2. Auto-detection of concluding section headers from legacy long stream text
    const combined =
      "收到，按计划排查问题。核查渲染端与主进程核心链路。确认包导出存在。\n\n**接线（非 demo）**\n- 官方引擎已对齐\n- 协议层已升级\n\n**验证**\n- 96 项测试通过";
    const res2 = partitionTurnContent(combined, undefined, true);
    expect(res2.progress).toBe("收到，按计划排查问题。核查渲染端与主进程核心链路。确认包导出存在。");
    expect(res2.conclusion).toContain("**接线（非 demo）**");
    expect(res2.conclusion).toContain("**验证**");

    // 3. Short plain content without markers
    const res3 = partitionTurnContent("你好，有什么我可以帮你的？");
    expect(res3.progress).toBeUndefined();
    expect(res3.conclusion).toBe("你好，有什么我可以帮你的？");

    // 4. Long conversational answer with "总结" / "Summary" but NO tools (hasTools=false / undefined)
    // CRITICAL: pure chat / tutorials / explanations must NEVER have their body folded into an accordion!
    const longTutorial = `### 1. requestAnimationFrame 原理\nrAF 会把动画回调注册到浏览器的下一次重绘生命周期。\n\n### 2. 与 CSS 动画的对比\nCSS 动画可以直接在合成线程运行。\n\n## 总结\n- 简单过渡优先使用 CSS\n- 复杂物理动画使用 rAF`;
    const res4 = partitionTurnContent(longTutorial, undefined, false);
    expect(res4.progress).toBeUndefined();
    expect(res4.conclusion).toBe(longTutorial);
    expect(res4.conclusion).toContain("requestAnimationFrame 原理");
    expect(res4.conclusion).toContain("## 总结");

    // 5. Message with only progressContent and empty content (e.g. streaming finished before post-tool text)
    const res5 = partitionTurnContent("", "正在执行代码核查...\n已确认无误。");
    expect(res5.progress).toBeUndefined();
    expect(res5.conclusion).toBe("正在执行代码核查...\n已确认无误。");
  });

  test("toEnvironmentNativeCwd tolerates non-string runtime values", () => {
    // A React click event / recent-workspace record used to reach this helper
    // through setWorkspace and crash with `e.trim is not a function`.
    expect(toEnvironmentNativeCwd(undefined)).toBe("");
    expect(toEnvironmentNativeCwd(null)).toBe("");
    expect(toEnvironmentNativeCwd({} as any)).toBe("");
    expect(toEnvironmentNativeCwd(42 as any)).toBe("");
    expect(toEnvironmentNativeCwd({ path: "D:/x" } as any)).toBe("");
    expect(toEnvironmentNativeCwd("  D:\\pythonProject\\pyqt  ")).toBe("D:/pythonProject/pyqt");
  });

  test("derives a readable session title from the first user turn", () => {
    expect(deriveSessionTitle([msg("assistant", "hi"), msg("user", "  ## 帮我看看这个 PyQt 项目  ")])).toBe(
      "帮我看看这个 PyQt 项目"
    );
    expect(
      deriveSessionTitle([msg("user", "```python\nprint(1)\n```\n请解释 **这段** [代码](https://example.com)")])
    ).toBe("请解释 这段 代码");
    expect(deriveSessionTitle([msg("assistant", "only answer")], "Agent 标题")).toBe("Agent 标题");
    expect(deriveSessionTitle([msg("user", "2026 年 10 月计划")])).toBe("2026 年 10 月计划");
    expect(deriveSessionTitle([])).toBeNull();
    expect(deriveSessionTitle([msg("user", "a".repeat(80))])).toHaveLength(43); // 42 + ellipsis
    expect(titleForThread({ title: "已命名", messages: [] } as any)).toBe("已命名");
    expect(titleForThread({ title: null, messages: [msg("user", "回退标题")] } as any)).toBe("回退标题");
  });

  test("recognizes empty threads and placeholder agent titles", () => {
    expect(isThreadEmpty(thread({ id: "t", agentId: "opencode" }))).toBe(true);
    expect(isThreadEmpty(thread({ id: "t", agentId: "opencode", messages: [msg("system", "notice")] }))).toBe(true);
    expect(isThreadEmpty(thread({ id: "t", agentId: "opencode", messages: [msg("assistant", "answer")] }))).toBe(false);
    expect(isThreadEmpty(thread({ id: "t", agentId: "opencode", messages: [msg("user", "hello")] }))).toBe(false);
    expect(isDefaultSessionTitle("New session - 2026-10-18")).toBe(true);
    expect(isDefaultSessionTitle("新会话")).toBe(true);
    expect(isDefaultSessionTitle("PyQt 看板选型")).toBe(false);
  });
});

