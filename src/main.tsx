import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "@/App";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ErrorToast } from "@/components/ErrorToast";
import { UpdateNotice } from "@/components/UpdateNotice";
import { SettingsModal } from "@/components/workbench/SettingsModal";
import { CommandPalette } from "@/components/workbench/CommandPalette";
import { WorkspacePickerModal } from "@/components/universal/WorkspacePickerModal";
import { GatewayTokenGate } from "@/components/GatewayTokenGate";
import { installGlobalErrorCapture, reportError } from "@/lib/error-bus";
import { bootstrapGatewayToken, isCookieAuth, verifyGatewayToken } from "@/lib/gateway-auth";
import "@/index.css";

installGlobalErrorCapture();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root")!);

function renderApp() {
  if (import.meta.env.DEV) void maybeSeedDevFixture();
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
        <ErrorToast />
        <UpdateNotice />
        <SettingsModal />
        <CommandPalette />
        <WorkspacePickerModal />
      </QueryClientProvider>
    </React.StrictMode>
  );
}

/**
 * 开发专用：`?fixture=conversation`（或 `?fixture=approval`，额外带一条顶部
 * 全局授权卡）时用假数据填充对话界面，方便在没有装
 * 任何智能体 CLI 的机器上检查消息 / 工具卡 / 计划 / 授权 / 用量的样式。
 * 整个分支包在 import.meta.env.DEV 里，生产构建会被静态剔除。
 */
async function maybeSeedDevFixture() {
  if (!import.meta.env.DEV) return;
  const mode = new URLSearchParams(window.location.search).get("fixture");
  if (mode === "math") return seedMathFixture();
  if (mode === "slash" || mode === "slash-empty" || mode === "slash-streaming") return seedSlashFixture(mode);
  if (mode !== "conversation" && mode !== "approval" && mode !== "stream") return;
  const [{ buildConversationFixture }, { useStudioStore }] = await Promise.all([
    import("@/dev/conversation-fixture"),
    import("@/stores/useStudioStore"),
  ]);
  const fx = buildConversationFixture({ globalPermission: mode === "approval" });
  const st = useStudioStore.getState();
  st.setSessionId(fx.sessionId);
  st.setMessages(fx.messages);
  st.setUsage(fx.usage);
  st.setSessionRunning(st.activeThreadId ?? "", true);
  for (const p of fx.pendingPerms) st.addPermission(p);
  if (mode === "stream") simulateStream(useStudioStore);
  console.info("[dev] conversation fixture loaded");
}

/**
 * `?fixture=math`：带图片的用户消息（同历史回放的显示方式）、含公式的回答（KaTeX 懒加载）、
 * 以及一条停在代码块中间的流式回答（检查未闭合代码块的显示）。
 */
async function seedMathFixture() {
  const { useStudioStore } = await import("@/stores/useStudioStore");
  const img = await fetch("/icon.png").then((r) => r.blob()).then((b) => new Promise<string>((ok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result)); fr.readAsDataURL(b); }));
  const st = useStudioStore.getState();
  st.setSessionId("fixture-math");
  st.setMessages([
    { id: "m-u1", role: "user", content: "这张图标的配色和圆角半径的计算方式是什么？", timestamp: "14:02", images: [{ src: img, mimeType: "image/png" }] },
    {
      id: "m-a1", role: "assistant", timestamp: "14:02", toolCalls: [], plan: [],
      content:
        "圆角用的是“连续曲率”近似：半径 $r = 0.2237\\,w$，其中 $w$ 是图标边长。\n\n" +
        "超椭圆的方程为\n\n$$\n\\left|\\frac{x}{a}\\right|^{n} + \\left|\\frac{y}{b}\\right|^{n} = 1,\\quad n \\approx 5\n$$\n\n" +
        "对比度按 WCAG 公式 $\\frac{L_1 + 0.05}{L_2 + 0.05} \\ge 4.5$ 校验；价格类文本如 $5 到 $10 不会被当成公式。",
    },
    { id: "m-u2", role: "user", content: "给我一个计算对比度的函数。", timestamp: "14:03" },
    {
      id: "m-a2", role: "assistant", timestamp: "14:03", toolCalls: [], plan: [], isStreaming: true,
      content: "下面是实现（流式输出中，代码块尚未结束）：\n\n```ts\nexport function contrast(l1: number, l2: number): number {\n  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];\n  return (hi + 0.05) / (lo + 0.05);",
    },
  ] as any);
  st.setSessionRunning(st.activeThreadId ?? "", true);
  console.info("[dev] math fixture loaded");
}

/**
 * `?fixture=slash`：模拟智能体推送的 available_commands_update（含 input.hint、带 : . 的命令名）；
 * `?fixture=slash-empty`：智能体未提供命令（空状态提示 + 本地命令）；
 * `?fixture=slash-streaming`：生成中浏览命令（回车只填入不发送）。
 */
async function seedSlashFixture(mode: string) {
  const [{ buildConversationFixture }, { useStudioStore }] = await Promise.all([
    import("@/dev/conversation-fixture"),
    import("@/stores/useStudioStore"),
  ]);
  const fx = buildConversationFixture({ globalPermission: false });
  const st = useStudioStore.getState();
  st.setSessionId(`fixture-${mode}`);
  st.setMessages(fx.messages);
  st.setModes({ currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }, { id: "acceptEdits", name: "Accept Edits" }] } as never);
  if (mode !== "slash-empty") {
    st.setAvailableCommands([
      { name: "review", description: "审查当前分支的改动", input: { hint: "分支名或 PR 号" } },
      { name: "review:security", description: "只做安全相关审查" },
      { name: "init", description: "生成 AGENTS.md 项目说明" },
      { name: "speckit.plan", description: "按规格生成实施计划", input: { hint: "功能描述" } },
      { name: "compact", description: "压缩上下文" },
      { name: "test", description: "运行测试并修复失败", input: { hint: "测试过滤条件" } },
    ]);
  } else {
    st.setAvailableCommands([]);
  }
  st.setSessionRunning(st.activeThreadId ?? "", mode === "slash-streaming");
  console.info("[dev] slash fixture loaded");
}

/** `?fixture=stream`：把最后一条助手消息逐字“流”出来，用于检查跟随滚动 / 光环 / 淡入。 */
function simulateStream(store: { getState: () => any }) {
  const text =
    "README 的示例已经改好。接下来提交这两个文件的改动，然后跑一遍测试确认没有回归。\n\n" +
    "## 本轮改动\n\n" +
    "- `src/greet.ts`：空名字回退为 \"there\"，补上参数类型。\n" +
    "- `tests/greet.test.ts`：覆盖空字符串、纯空格和普通名字三种情况。\n" +
    "- `README.md`：用法示例的输出改成 `Hello, Ada!`。\n\n" +
    "测试结果：3 个用例全部通过，类型检查无报错。\n\n" +
    "## 后续建议\n\n" +
    "1. 给 `greet` 加一个可选的语言参数，方便以后做本地化。\n" +
    "2. 在 CI 里加上 `vitest --coverage`，把覆盖率门槛设在 80%。\n" +
    "3. README 里补一段“常见问题”，说明空名字的行为。\n\n" +
    "提交信息：`fix(greet): handle empty names`。如果还需要我顺便发一个补丁版本，告诉我即可。";
  const setText = (content: string, done: boolean) => {
    const st = store.getState();
    st.setMessages(
      st.sessions[st.activeThreadId ?? ""].messages.map((m: any) =>
        m.id === "fx-a2"
          ? { ...m, content, isStreaming: !done, completedAt: done ? Date.now() : undefined, toolCalls: (m.toolCalls || []).map((t: any) => ({ ...t, status: "completed" })) }
          : m,
      ),
    );
    if (done) st.setSessionRunning(st.activeThreadId ?? "", false);
  };
  let i = 0;
  setText("", false);
  const timer = setInterval(() => {
    i = Math.min(text.length, i + 3);
    setText(text.slice(0, i), false);
    if (i >= text.length) {
      clearInterval(timer);
      setTimeout(() => setText(text, true), 600);
    }
  }, 60);
}

function renderGate(reason: "missing" | "rejected" | "error", detail?: string) {
  root.render(
    <React.StrictMode>
      <GatewayTokenGate reason={reason} detail={detail} onAuthorized={renderApp} />
      <ErrorToast />
    </React.StrictMode>
  );
}

/**
 * 启动顺序：先拿网关令牌（Electron preload / 地址栏 ?token= / localStorage），
 * 校验通过才渲染应用；没有或被拒 → 令牌页。网关不可达时照常进应用，
 * 由各处请求就近报错（与原有行为一致）。
 */
async function boot() {
  let token: string | null;
  try {
    token = await bootstrapGatewayToken();
  } catch (err) {
    reportError("GatewayAuth", err);
    renderGate("error", `读取网关令牌失败：${(err as Error)?.message || err}`);
    return;
  }
  if (!token && !isCookieAuth()) {
    renderGate("missing");
    return;
  }
  const state = await verifyGatewayToken();
  if (state === "unauthorized") {
    renderGate("rejected");
    return;
  }
  renderApp();
}

void boot();
