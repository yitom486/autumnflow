/**
 * 开发专用：对话界面假数据（无需安装任何智能体 CLI）。
 *
 * 只在 `vite` 开发服务器里、地址带 `?fixture=conversation` 时由 main.tsx
 * 动态加载；生产构建里 `import.meta.env.DEV` 恒为 false，这个模块会被整个
 * tree-shake 掉，不会进打包产物。
 *
 * 覆盖：用户消息、已完成的一轮（思考 / 计划 / 工具卡 / 用量）、正在流式
 * 输出的一轮（思考中、计划进行中、工具运行中 + 内联授权）、以及一条未挂到
 * 工具卡上的全局授权请求（走 InteractionPanel）。
 */
import type { Message } from "@/lib/message-types";
import type { PendingPermission } from "@/lib/universal-api";
import type { UsageState } from "@/stores/useStudioStore";

export const FIXTURE_SESSION_ID = "fixture-0c7e4a1b-session";
export const FIXTURE_AGENT_ID = "codex";

export interface ConversationFixture {
  messages: Message[];
  pendingPerms: PendingPermission[];
  usage: UsageState;
  sessionId: string;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const GREET_DIFF = `--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,5 +1,9 @@
-export function greet(name) {
-  return "Hello " + name;
+/** 生成问候语；空名字回退为 "there"。 */
+export function greet(name: string): string {
+  const who = name.trim() || "there";
+  return \`Hello, \${who}!\`;
 }`;

export function buildConversationFixture(
  opts: { now?: number; globalPermission?: boolean } = {},
): ConversationFixture {
  const now = opts.now ?? Date.now();
  const t0 = now - 6 * 60_000;
  const usage: UsageState = {
    used: 48_312,
    size: 200_000,
    cost: { amount: 0.21, currency: "USD" },
    inputTokens: 41_870,
    outputTokens: 6_442,
  };

  const messages: Message[] = [
    {
      id: "fx-u1",
      role: "user",
      content: "`greet.ts` 对空名字会输出 \"Hello \"，帮我修一下并补上测试。",
      timestamp: hhmm(t0),
    },
    {
      id: "fx-a1",
      role: "assistant",
      model: "gpt-5-codex",
      mode: "auto",
      timestamp: hhmm(t0 + 52_000),
      startedAt: t0 + 1_000,
      completedAt: t0 + 52_000,
      thought:
        "先读 greet.ts 看现有实现，再搜一下调用方确认签名能不能改成 string。修复后用 vitest 跑一遍，确认空字符串和纯空格都覆盖到。",
      thoughtTiming: { startedAt: t0 + 1_000, completedAt: t0 + 7_400 },
      plan: [
        { content: "阅读 src/greet.ts 与调用方", status: "completed", priority: "high" },
        { content: "修复空名字并补类型", status: "completed", priority: "high" },
        { content: "新增 tests/greet.test.ts 并运行", status: "completed", priority: "medium" },
      ],
      usage: { used: 31_204, size: 200_000, cost: { amount: 0.13, currency: "USD" }, inputTokens: 27_311, outputTokens: 3_893 },
      toolCalls: [
        {
          id: "call_read_greet_01",
          title: "Read src/greet.ts",
          kind: "read",
          status: "completed",
          startedAt: t0 + 7_500,
          completedAt: t0 + 7_900,
          locations: [{ path: "src/greet.ts" }],
          rawOutput: 'export function greet(name) {\n  return "Hello " + name;\n}\n',
        },
        {
          id: "call_search_greet_02",
          title: "Search greet(",
          kind: "search",
          status: "completed",
          startedAt: t0 + 8_000,
          completedAt: t0 + 8_600,
          rawInput: { pattern: "greet(" },
          rawOutput: "src/index.ts:3: console.log(greet(process.argv[2] ?? \"\"));\nsrc/greet.ts:1: export function greet(name) {",
        },
        {
          id: "call_edit_greet_03",
          title: "Edit src/greet.ts",
          kind: "edit",
          status: "completed",
          startedAt: t0 + 20_000,
          completedAt: t0 + 21_200,
          locations: [{ path: "src/greet.ts" }],
          rawOutput: GREET_DIFF,
        },
        {
          id: "call_exec_test_04",
          title: "bun run test tests/greet.test.ts",
          kind: "execute",
          status: "completed",
          startedAt: t0 + 30_000,
          completedAt: t0 + 41_800,
          rawInput: { command: "bun run test tests/greet.test.ts" },
          rawOutput:
            " ✓ tests/greet.test.ts (3 tests) 4ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  412ms",
        },
      ],
      content: [
        "修好了。原来的实现直接拼接字符串，空名字会得到 `\"Hello \"`。",
        "",
        "- 参数加上 `string` 类型，先 `trim()`，为空时回退为 `there`",
        "- 新增 `tests/greet.test.ts`，覆盖正常名字、空字符串、纯空格 3 种情况",
        "",
        "```ts",
        "export function greet(name: string): string {",
        "  const who = name.trim() || \"there\";",
        "  return `Hello, ${who}!`;",
        "}",
        "```",
        "",
        "测试 3/3 通过。调用方 `src/index.ts` 本来就传字符串，不需要改。",
      ].join("\n"),
    },
    {
      id: "fx-u2",
      role: "user",
      content: "顺便把 README 的用法示例也更新一下，然后提交。",
      timestamp: hhmm(now - 40_000),
    },
    {
      id: "fx-a2",
      role: "assistant",
      model: "gpt-5-codex",
      mode: "auto",
      timestamp: hhmm(now - 38_000),
      isStreaming: true,
      startedAt: now - 38_000,
      thought:
        "README 里的示例还是旧输出 \"Hello Ada\"，要改成 \"Hello, Ada!\"。提交前需要 git commit，这一步会写仓库历史，按规则要先请求授权。",
      thoughtTiming: { startedAt: now - 37_000 },
      plan: [
        { content: "更新 README 用法示例", status: "completed", priority: "medium" },
        { content: "git commit 本轮改动", status: "in_progress", priority: "medium" },
        { content: "汇报提交结果", status: "pending", priority: "low" },
      ],
      usage,
      toolCalls: [
        {
          id: "call_edit_readme_05",
          title: "Edit README.md",
          kind: "edit",
          status: "completed",
          startedAt: now - 30_000,
          completedAt: now - 29_100,
          locations: [{ path: "README.md" }],
          rawOutput: "--- a/README.md\n+++ b/README.md\n@@ -8,1 +8,1 @@\n-greet(\"Ada\") // Hello Ada\n+greet(\"Ada\") // Hello, Ada!",
        },
        {
          id: "call_exec_commit_06",
          title: "git commit -am \"fix(greet): handle empty names\"",
          kind: "execute",
          status: "pending",
          startedAt: now - 12_000,
          rawInput: { command: 'git commit -am "fix(greet): handle empty names"' },
        },
      ],
      content: "README 的示例已经改好。接下来提交这两个文件的改动，",
    },
  ];

  const pendingPerms: PendingPermission[] = [
    {
      // 挂在工具卡上 → 内联授权条
      permissionId: "perm-inline-commit",
      agentId: FIXTURE_AGENT_ID,
      sessionId: FIXTURE_SESSION_ID,
      toolCall: { toolCallId: "call_exec_commit_06", title: 'git commit -am "fix(greet): handle empty names"', kind: "execute" },
      options: [
        { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
        { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
      ],
    },
    {
      // 找不到对应工具卡 → 顶部全局授权卡（InteractionPanel）
      permissionId: "perm-global-network",
      agentId: FIXTURE_AGENT_ID,
      sessionId: FIXTURE_SESSION_ID,
      toolCall: { toolCallId: "call_fetch_registry_07", title: "访问网络：registry.npmjs.org", kind: "fetch" },
      options: [
        { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
        { optionId: "allow_always", name: "总是允许", kind: "allow_always" },
        { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
      ],
    },
  ];

  return {
    messages,
    pendingPerms: opts.globalPermission ? pendingPerms : pendingPerms.slice(0, 1),
    usage,
    sessionId: FIXTURE_SESSION_ID,
  };
}
