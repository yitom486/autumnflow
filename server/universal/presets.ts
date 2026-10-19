import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProfile } from "./types";

/**
 * Built-in agent presets (ACP v1 stdio) — shell principle:
 * every preset shells out to the vendor's OFFICIAL CLI entry point and
 * reuses the CLI's own local credentials (env passthrough + same HOME).
 * We never store secrets; log in once with the official CLI and the
 * gateway picks it up. See `authHint` per preset.
 *
 * Users can override / extend via ACP_AGENTS_JSON env, POST
 * /api/universal/agents, or ~/.autumnflow/agents.json (all persisted).
 */
/**
 * Antigravity bridge, codex-style: `bunx @yitom/agy-acp-map@latest` runs the
 * thin JS stdio adapter (dist/bin.js) against the local `agy` CLI — no
 * managed installs, no big exes. The runner cache owns the bytes: first
 * connect downloads, later connects reuse the cache. Missing runner/binary
 * fails fast at connect time via whichCommand + installHint.
 */
export const ANTIGRAVITY_EXE_MISSING_HINT =
  "Antigravity 桥需要 bun（bunx）或 Node.js（npx）二选一：都没装就连不上。首次连接会下载最新版桥（thin 包，约数 MB），之后走 runner 缓存。另需本地装好 Antigravity CLI（agy）并完成登录。";
function resolveAntigravity(): { command: string; args: string[] } {
  // Same as codex: bunx first, npx fallback, pinned @latest (see runnerArgs).
  // No managed-install gate — the runner cache owns the bytes now.
  return runnerArgs("@yitom/agy-acp-map");
}

function resolveCursorCli(): { command: string; args: string[] } {
  const isWin = process.platform === "win32";
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\AppData\\Local` : "");
    const directCmd = localAppData ? `${localAppData}\\cursor-agent\\agent.cmd` : "";
    if (directCmd && fs.existsSync(directCmd)) {
      return { command: directCmd, args: ["acp"] };
    }
    return { command: "agent.cmd", args: ["acp"] };
  }
  const home = process.env.HOME || "";
  const directBin = home ? `${home}/.local/bin/agent` : "";
  if (directBin && fs.existsSync(directBin)) {
    return { command: directBin, args: ["acp"] };
  }
  return { command: "agent", args: ["acp"] };
}

/**
 * Package runner with pinned-latest: forces registry version resolution on
 * every launch so users always run the newest agent. `bunx` first (faster
 * installs, no prompt, shares Bun's cache), `npx` as fallback. No local
 * require.resolve shortcut — a stale bundled copy must never mask an
 * outdated install (fail-fast policy, see .agents/rules/no-silent-fallbacks.md).
 */
function pinLatest(pkg: string): string {
  // "@scope/name" (@ at index 0) has no version; "name@ver" (@ later) does.
  return pkg.lastIndexOf("@") > 0 ? pkg : `${pkg}@latest`;
}

/** Minimal PATH scan (local copy; keeps presets.ts dependency-free). */
function findRunnerBin(name: string): string | null {
  const isAbs = path.isAbsolute(name);
  let dirs = isAbs
    ? [path.dirname(name)]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean);

  // 在 Linux / WSL 环境下：
  // 1. 优先扫描 ~/.bun/bin、~/.local/bin、/usr/local/bin
  // 2. 严格剔除 Windows 挂载盘路径（/mnt/...），绝不把 Windows 的 node.exe / npx 当作 Linux runner
  if (process.platform === "linux") {
    const home = process.env.HOME || "";
    const priority = [
      home ? path.join(home, ".bun", "bin") : "",
      home ? path.join(home, ".local", "bin") : "",
      "/usr/local/bin",
    ].filter(Boolean);
    const linuxNativeDirs = dirs.filter((d) => !/^\/mnt\/[a-zA-Z](\/|$)/.test(d));
    dirs = [...new Set([...priority, ...linuxNativeDirs])];
  }

  const base = isAbs ? path.basename(name) : name;
  const exts =
    process.platform === "win32" && !path.extname(base)
      ? ["", ".exe", ".cmd", ".bat"]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, base + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // deterministically 无害: PATH 逐项试探，缺失即试下一项 (error_handling.md 允许的 ignore，
        // 不打日志以免每个未命中都刷屏；最终找不到由调用方 loud 报错)。
      }
    }
  }
  return null;
}

function packageRunner(): { command: string; autoYes: boolean } {
  // bunx never prompts, so no "-y" flag; npx needs "-y" for the same effect.
  const bunx = findRunnerBin(process.platform === "win32" ? "bunx.exe" : "bunx");
  if (bunx) return { command: bunx, autoYes: false };
  if (process.platform === "win32") return { command: "npx.cmd", autoYes: true };
  return { command: "npx", autoYes: true };
}

const runnerArgs = (pkg: string, extra: string[] = []): { command: string; args: string[] } => {
  const r = packageRunner();
  return {
    command: r.command,
    args: [...(r.autoYes ? ["-y"] : []), pinLatest(pkg), ...extra],
  };
};

export function resolveNpxOrLocal(pkg: string, extra: string[] = []): { command: string; args: string[] } {
  return runnerArgs(pkg, extra);
}

export const BUILTIN_AGENTS: AgentProfile[] = [
  {
    id: "codex",
    name: "codex-acp",
    title: "Codex",
    description: "OpenAI Codex via @agentclientprotocol/codex-acp (stdio). Supports modes, models, slash commands.",
    homepage: "https://github.com/agentclientprotocol/codex-acp",
    builtin: true,
    ...resolveNpxOrLocal("@agentclientprotocol/codex-acp"),
    env: {},
    authHint: "复用本地 ChatGPT 登录（~/.codex/auth.json）或 CODEX_API_KEY / OPENAI_API_KEY（环境透传）。",
    installHint: "npm i -g @agentclientprotocol/codex-acp，或先装 Codex CLI 并完成登录。",
  },
  {
    id: "antigravity-stdio",
    name: "agy-acp",
    title: "Antigravity (agy)",
    description: "Google Antigravity ACP bridge via @yitom/agy-acp-map (stdio).",
    homepage: "https://antigravity.google",
    builtin: true,
    ...resolveAntigravity(),
    env: {
      AGY_DYNAMIC_DISCOVERY: "true",
    },
    authHint: "复用 Antigravity CLI 本地登录态（~/.gemini/），零额外配置。",
    installHint: ANTIGRAVITY_EXE_MISSING_HINT,
  },
  {
    id: "opencode",
    name: "opencode-acp",
    title: "OpenCode",
    description: "OpenCode 原生 ACP 服务（opencode acp，stdio）。模型/会话与终端行为和 TUI 一致。",
    homepage: "https://opencode.ai/docs/acp/",
    builtin: true,
    command: process.platform === "win32" ? "opencode.exe" : "opencode",
    args: ["acp"],
    env: {},
    authHint: "复用 `opencode auth login` 存到 ~/.local/share/opencode/auth.json 的各 provider 凭证（环境变量优先透传）。",
    installHint: "npm i -g opencode-ai（或 bun add -g opencode-ai），然后跑一次 `opencode auth login`。",
  },
  {
    id: "cursor-cli",
    name: "cursor-agent",
    title: "Cursor CLI",
    description: "Cursor 官方 CLI 的原生 ACP 模式（agent acp，stdio）。",
    homepage: "https://cursor.com/docs/cli/acp",
    builtin: true,
    ...resolveCursorCli(),
    env: {},
    authHint: "已自动复用本地 Cursor 登录态（未登录可运行 `agent login`）。",
    installHint: "已自动安装在 %LOCALAPPDATA%\\cursor-agent。若需手动安装请在终端执行 `irm https://cursor.com/install?win32=true | iex`。",
  },
  {
    id: "deepseek",
    name: "dsh-acp",
    title: "DeepSeek Harness",
    description: "DeepSeek Harness 自动化 ACP 服务（dsh --profile acp，stdio）。authMethods 为空，靠 harness 自身凭证。",
    homepage: "https://deepseekdocs.com/en/docs/guides/acp-automation-server",
    builtin: true,
    ...runnerArgs("@deepseek-ai/dsh", ["--profile", "acp"]),
    env: {},
    authHint: "无 ACP 登录（authMethods 为空）：靠 harness 自身凭证（DEEPSEEK_API_KEY / harness 配置），全部留在官方位置。",
    installHint: "npm i -g @deepseek-ai/dsh（需 Node 22.19+ 或 24+），或 bunx/npx 即用。注意 preview 版变化快，启动时固定拉 latest。",
  },
  {
    id: "gemini",
    name: "gemini-acp",
    title: "Gemini CLI",
    description: "Google Gemini CLI ACP 模式。",
    builtin: true,
    command: process.platform === "win32" ? "gemini.cmd" : "gemini",
    args: ["--acp"],
    env: {},
    authHint: "复用 Gemini CLI 本地登录态。",
    installHint: "按 https://github.com/google-gemini/gemini-cli 装好并登录一次。",
  },
  {
    id: "claude",
    name: "claude-agent-acp",
    title: "Claude Code",
    description: "Claude Code via @agentclientprotocol/claude-agent-acp。",
    builtin: true,
    ...resolveNpxOrLocal("@agentclientprotocol/claude-agent-acp"),
    env: {},
    authHint: "复用本地 Claude Code 登录态或 ANTHROPIC_API_KEY（环境透传）。",
    installHint: "先装好 Claude Code 并完成一次登录。",
  },
  {
    id: "copilot",
    name: "copilot-acp",
    title: "Copilot CLI",
    description: "GitHub Copilot CLI ACP stdio mode.",
    builtin: true,
    command: process.platform === "win32" ? "copilot.cmd" : "copilot",
    args: ["--acp", "--stdio"],
    env: {},
    authHint: "复用 Copilot CLI 本地 GitHub 登录态。",
    installHint: "装好 Copilot CLI 并完成一次登录（需支持 ACP stdio 的新版本）。",
  },
];

export function resolveBuiltin(id: string): AgentProfile | undefined {
  return BUILTIN_AGENTS.find((a) => a.id === id);
}

function toProfile(x: any): AgentProfile | null {
  if (!x || !x.id || !x.command) return null;
  return {
    id: String(x.id),
    name: String(x.name || x.id),
    title: String(x.title || x.id),
    description: x.description,
    homepage: x.homepage,
    command: String(x.command),
    args: Array.isArray(x.args) ? x.args.map(String) : [],
    env: x.env && typeof x.env === "object" ? x.env : {},
    defaultCwd: x.defaultCwd,
    authHint: x.authHint,
    installHint: x.installHint,
    builtin: false,
  };
}

/** Parse ACP_AGENTS_JSON env: [{id,command,args,env,...}] merged over builtins. */
export function loadExtraProfilesFromEnv(): AgentProfile[] {
  const raw = process.env.ACP_AGENTS_JSON;
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      // Loud empty: env 配置损坏必须可见，但返回 [] 保活网关 (调用方展示)。
      console.warn("[presets] ACP_AGENTS_JSON 不是数组，已按空配置继续 (期望 [{id,command,...}])。");
      return [];
    }
    return arr.map(toProfile).filter((p): p is AgentProfile => !!p);
  } catch (err) {
    // Loud empty: JSON 损坏必须可见，同上返回 [] 保活。
    console.warn("[presets] ACP_AGENTS_JSON 解析失败，已按空配置继续:", err);
    return [];
  }
}

export function parseProfilesJson(raw: unknown): AgentProfile[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).map(toProfile).filter((p): p is AgentProfile => !!p);
}
