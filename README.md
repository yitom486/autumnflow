# AutumnFlow（秋水）

> **English summary** — AutumnFlow (秋水) is a modern, high-precision desktop (Electron) and web workbench for any coding agent that speaks the
> [Agent Client Protocol (ACP)](https://agentclientprotocol.com) over stdio. It ships presets for Codex, Claude Code,
> Gemini CLI, Cursor CLI, GitHub Copilot CLI, OpenCode, DeepSeek Harness and Google Antigravity, reuses each CLI's own
> local login (no API keys stored), and features beUI agent activity feeds, real-time thinking trace, permission-approval flow,
> publishing-grade editorial diagrams, an integrated PTY terminal, @-file mentions and git diff review/undo for each agent turn.
> Stack: React 19 + Vite + Tailwind v4 + beUI front end, Hono gateway (Bun or Node), Electron shell.

AutumnFlow（秋水）是一个**面向通用 ACP 编码智能体的全能桌面工作台**：把任何支持 ACP（Agent Client Protocol）的命令行编码智能体接进同一个高密度、高精度的现代图形界面，
在桌面端（Electron）或浏览器里与它们对话、审批操作、查看文件变更及交互式矢量图表。

---

## 功能

以下功能都已在代码中实现（括号内为主要实现位置）：

**多智能体接入**
- 内置 8 个预设，统一走各家官方 CLI，复用其本地登录态，Studio 不保存任何密钥（`server/universal/presets.ts`）
- 自定义智能体：界面里添加，或用 `ACP_AGENTS_JSON` 环境变量 / `~/.autumnflow/agents.json` 配置 `{id, command, args, env}`（`server/universal/registry.ts`、`src/components/universal/CustomAgentModal.tsx`）
- 连接时做 `initialize` 能力协商，按智能体实际能力开关界面功能（fork、providers、附加目录、图片输入等）

**会话**
- 新建 / 加载（历史回放）/ 恢复 / 列表 / 关闭 / 删除 / fork 会话；可设置 cwd、附加目录、MCP servers（`src/hooks/useSessionLifecycle.ts`、`src/components/universal/SessionSettingsModal.tsx`）
- 本地会话记录（按智能体隔离，存浏览器 localStorage，`src/lib/threads.ts`）
- 模式切换、模型 / 思考等级等配置项、Providers 面板（`ModelBrowserModal.tsx`、`ProvidersModal.tsx`）

**对话与可视化**
- 流式渲染正文、思考过程（可折叠）、工具调用状态、计划（plan）、slash 命令联想、token 用量与费用（`src/lib/universal-api.ts`、`src/components/assistant/`）
- Markdown + 代码高亮（Shiki）+ Mermaid 图（按需加载）
- 附件：文本、图片、文件拖拽 / 粘贴
- `@` 引用工作区文件（只读搜索，限定在 cwd 内，`/api/universal/workspace/files`）
- 生成中继续发送会进入队列；支持“插队”；传输类错误自动重试（默认 2 次）（`src/hooks/useChatSend.ts`）

**审批与表单**
- 智能体请求权限（`session/request_permission`）时弹出独立审批弹窗（`InteractionPanel.tsx`），阻塞当前这一轮
- 智能体请求结构化输入（`elicitation/create`）时按 JSON Schema 渲染表单（`ElicitationCard.tsx`）

**代码相关**
- 代替智能体读写文件（ACP `fs/read_text_file`、`fs/write_text_file`）、托管其终端命令（ACP `terminal/*`）（`server/universal/AgentConnection.ts`）
- 集成终端：Node 网关下为真 PTY（`node-pty` + WebSocket，可跑 vim / ssh），Bun 网关下回落为单次命令执行；浮动面板、搜索、导出日志（`server/universal/pty.ts`、`TerminalDrawer.tsx`）
- Git 改动查看：工作区状态、逐文件 diff（左右对照 / 统一 diff）、暂存、还原（`GitChangesModal.tsx`、`/api/universal/git/*`）
- 本轮改动撤销：每条回复下方显示“改动 N”，可逐个文件查看 diff 或 `git restore` 还原（`src/components/assistant/TurnChanges.tsx`）

**工作台**
- 文件树（react-arborist）：懒加载、虚拟滚动、键盘导航、拖拽移动、重命名、新建、删除进回收站、git 状态徽标，磁盘变化自动刷新（`src/components/workbench/FileTreePanel.tsx`）
- 代码编辑器（CodeMirror 6）：预览 / 固定标签、未保存圆点、Ctrl/⌘+S 保存、冲突检测；`@codemirror/merge` 并排 / 统一对比；智能体改了已打开的文件会自动重载并高亮改动行（`src/components/workbench/EditorPane.tsx`）
- 文件接口 `/api/universal/fs/*`（list / read / write / create / rename / delete / watch），全部限定在工作区内（`server/universal/http/files.ts`）
- 原生菜单 + 标题栏菜单 + 命令面板（Ctrl/⌘+Shift+P）共用命令注册表（`desktop/menu.ts`、`src/lib/commands.ts`、`src/hooks/useWorkbenchCommands.ts`）；多窗口，每个窗口各自的工作区
- 设置 → 关于与更新：版本、更新状态 / 进度、自动检查开关（`src/components/workbench/SettingsModal.tsx`）

| 快捷键（mac 上 Ctrl = ⌘） | 作用 |
| --- | --- |
| Ctrl+Shift+P | 命令面板 |
| Ctrl+O / Ctrl+Shift+N | 打开文件夹 / 新建窗口 |
| Ctrl+B / Ctrl+Shift+E / Ctrl+` | 切换侧栏 / 文件树 / 终端 |
| Ctrl+S / Ctrl+W | 保存 / 关闭标签页 |
| Ctrl+, | 设置 |

**外观**
- 4 套主题：dark / oled / dim / light，终端配色跟随主题（`src/stores/useThemeStore.ts`）

### 工作台增强

- **可调分栏**：侧栏、文件树、编辑器、聊天均可拖拽调整宽度，布局自动保存
- **拖拽引用**：从文件树或系统（桌面版）拖文件/文件夹到输入框，工作区内路径变成 @ 引用标签
- **Notebook 查看器**：只读预览 `.ipynb`（不运行内核），HTML 输出沙箱隔离
- **Markdown 所见即所得**：`.md` 可在源码 / 所见即所得间切换，避免仅格式变化的 diff
- **数学公式**：聊天消息支持 `$...$` / `$$...$$` KaTeX 渲染

## 支持的智能体

| 预设 ID | 名称 | 启动命令 | 登录方式 |
| --- | --- | --- | --- |
| `codex` | Codex | `bunx @agentclientprotocol/codex-acp@latest`（无 bun 时 `npx -y`） | 复用 `~/.codex/auth.json`，或 `OPENAI_API_KEY` / `CODEX_API_KEY` |
| `claude` | Claude Code | `bunx @agentclientprotocol/claude-agent-acp@latest` | 复用 Claude Code 本地登录 |
| `gemini` | Gemini CLI | `gemini --acp` | 复用 Gemini CLI 登录 |
| `cursor-cli` | Cursor CLI | `agent acp` | 复用 Cursor CLI 登录 |
| `copilot` | Copilot CLI | `copilot --acp --stdio` | 复用 Copilot CLI 登录 |
| `opencode` | OpenCode | `opencode acp` | 复用 OpenCode 配置 |
| `deepseek` | DeepSeek Harness | `bunx @deepseek-ai/dsh@latest --profile acp` | 见 dsh 文档 |
| `antigravity-stdio` | Antigravity | `bunx @yitom/agy-acp-map@latest` | 需先安装并登录 Google Antigravity CLI（`agy`） |

需要先自行安装对应的官方 CLI 并完成登录；未安装时连接会直接报错并给出安装提示。

## 架构

```mermaid
flowchart LR
  UI["前端 React 19 + Vite<br/>src/"] -- "HTTP + SSE<br/>/api/universal/*" --> GW["网关 Hono<br/>server/gateway.ts"]
  UI -- "WebSocket（PTY）" --> GW
  GW --> REG["智能体注册表<br/>registry.ts"]
  REG --> C1["AgentConnection<br/>（每个智能体一个）"]
  C1 -- "ACP JSON-RPC over stdio" --> A["Codex / Claude / Gemini / …<br/>官方 CLI 子进程"]
  C1 -- "fs/* · terminal/*" --> FS["本地文件与进程"]
  E["Electron 主进程<br/>desktop/main.ts"] -. "进程内启动网关并加载前端" .-> GW
```

- **前端**（`src/`）：React 19、assistant-ui、zustand（客户端状态）+ TanStack Query（服务端状态）、Tailwind CSS v4、xterm.js。
- **网关**（`server/`）：同一个 Hono 应用有两个入口——`server/index.ts`（Bun，开发默认）和 `server/node.ts`（Node，支持真 PTY）。只监听 `127.0.0.1:3004`。
- **ACP 客户端层**（`server/universal/AgentConnection.ts`）：基于 `@agentclientprotocol/sdk`，为每个智能体托管一个 stdio 子进程，并把权限请求、表单请求转给前端。
- **桌面端**（`desktop/`）：Electron 主进程内启动 Node 网关，同源加载打包好的前端。

## 快速开始

### 环境要求
- [Bun](https://bun.sh) 1.2+（构建、开发脚本都用 bun）
- 至少一个已安装并登录的 ACP 智能体 CLI（见上表）
- Linux 上首次安装需要 C/C++ 编译工具（`build-essential`），因为 `node-pty` 没有 Linux 预编译包

### 开发

```bash
git clone --recurse-submodules https://github.com/yitom486/autumnflow.git
cd autumnflow
bun install

bun run dev            # 网关 http://127.0.0.1:3004 + 前端 http://localhost:5188
bun run dev:desktop    # Electron 桌面开发模式（默认 Bun 网关，终端为单次执行）
ACP_GATEWAY=node bun run dev:desktop   # 改用 Node 网关，启用真 PTY 终端
```

网关启动时会在终端打印一条 `open the UI with: http://localhost:5188/?token=...` 链接，用它打开 → 选择智能体 → 连接 → 新建会话 → 发送。

网关的所有 `/api/universal/*` 接口（包括终端执行）都要求访问令牌：Electron 桌面版自动带上；浏览器模式第一次用上面的链接打开，前端会记住令牌并从地址栏抹掉，也可以在令牌页粘贴 `~/.autumnflow/.gateway-token` 的内容。

### 检查与构建

```bash
bunx tsc --noEmit               # 类型检查
bunx vitest run tests/universal # 单元/集成测试（CI 同款，离线，不调用任何真实模型）
bun run build                   # 前端构建到 dist/
bun run build:electron          # 打包 Electron 主进程到 electron-dist/
bun run package:win             # 或 package:mac / package:linux，产物在 release/
```

### 安装包

到 [Releases](https://github.com/yitom486/autumnflow/releases) 下载：Windows（NSIS `.exe`）、macOS（Apple Silicon `.dmg` / `.zip`）、Linux（`.AppImage` / `.deb`）。安装包目前未签名，Windows 可能出现 SmartScreen 提示，macOS 需要在“隐私与安全性”里允许打开。

## 配置

| 变量 / 文件 | 作用 | 默认值 |
| --- | --- | --- |
| `PORT` | 网关端口 | `3004` |
| `ACP_AGENTS_JSON` | 追加 / 覆盖智能体定义（JSON 数组） | 空 |
| `ACP_AGENTS_FILE` | 自定义智能体持久化文件 | `~/.autumnflow/agents.json` |
| `ACP_WORKSPACE_ROOTS` | 额外允许智能体写入的目录（`;` 或 `:` 分隔）；会话工作区本身始终允许 | 网关当前目录 |
| `ACP_GATEWAY_TOKEN` | 网关访问令牌 | 自动生成，存于 `~/.autumnflow/.gateway-token` |
| `ACP_PUBLIC_DIR` | 网关托管的前端目录 | `./dist` |
| `ACP_GATEWAY` | `dev:desktop` 使用的网关（`bun` / `node`） | `bun` |

## 在 Zed 等编辑器中使用 Antigravity

Antigravity 桥接（`@yitom/agy-acp-map`）本身就是标准 ACP stdio 服务，可以直接配置进 Zed：

```json
{
  "agent_servers": {
    "antigravity": { "command": "bunx", "args": ["@yitom/agy-acp-map@latest"] }
  }
}
```

没装 bun 时把 `command` 换成 `npx`，`args` 换成 `["-y", "@yitom/agy-acp-map@latest"]`。更多细节见 [`docs/02_zed_integration_guide.md`](./docs/02_zed_integration_guide.md)。

## 项目结构

```text
autumnflow/
├── server/
│   ├── index.ts / node.ts       # Bun / Node 网关入口
│   ├── gateway.ts               # Hono 应用：鉴权、/api/universal/*、静态文件
│   └── universal/
│       ├── routes.ts            # /api/universal/* 入口：鉴权 + 组装各子路由
│       ├── http/                # Hono 子路由（agents、sessions、interactions、chat、workspace、terminal、git）+ 请求校验
│       ├── AgentConnection.ts   # 单个智能体的 ACP stdio 连接
│       ├── registry.ts          # 智能体定义与活动连接
│       ├── presets.ts           # 内置预设
│       ├── pty.ts               # node-pty + WebSocket 终端
│       └── security.ts          # 令牌、CORS、工作区白名单
├── src/
│   ├── App.tsx                  # 主界面
│   ├── hooks/                   # 会话生命周期、发送、配置、启动
│   ├── stores/                  # zustand 状态
│   ├── lib/universal-api.ts     # 前端 API 与 SSE 解析
│   └── components/              # 聊天、侧边栏、终端、git、审批等组件
├── desktop/                     # Electron 主进程、preload、构建脚本
├── tests/                       # Vitest 测试（含离线 mock ACP agent）
└── docs/                        # 协议、Zed 集成、认证等文档
```

## 路线图

- [x] 网关令牌真正生效：前端和非浏览器调用都必须带令牌
- [x] 智能体写文件限制在会话工作区内
- [ ] 读文件、终端、git 也限制在工作区内；智能体进程沙箱
- [ ] 会话历史持久化到本地数据库（目前只存 localStorage，且不保存工具调用）
- [x] 文件树与代码查看 / 编辑器
- [ ] 基于检查点的撤销（不依赖 git）
- [ ] 提交、分支、PR 等 Git 操作
- [ ] 多个会话并行运行
- [ ] 跨会话的用量与费用统计

## 应用配置目录、长期指令与 Skills

通过 Studio 启动的 agent 默认读取应用自有的 `~/.autumnflow/resources/`（首次启动会从旧 `~/.acp-client/` 复制一次）。可用绝对路径环境变量 `AUTUMNFLOW_RESOURCES_DIR` 指向另一套配置；此入口不修改 agent 的全局配置、认证 HOME 或项目工作目录。

```text
~/.autumnflow/resources/
  AGENTS.md                 通用长期规则；首次生成后保留你的编辑
  SYSTEM.md                 附加指令，与 AGENTS.md 合并交付
  skills/<name>/SKILL.md     技能，可通过 studio-ui 按需读取
  mcp.json                  应用级 MCP 描述符：{"mcpServers":[]}
  sessions/studio-*/        每个连接独占的生成快照，正常断开后清理
```

`SYSTEM.md` 是应用约定的文件名，不代表所有 CLI 都有通用的 system-prompt 参数，也不会替换供应商内置提示词。Studio 复用 `@yitom/acp-client` 的运行时适配器：已验证的桥优先走原生配置入口；未知版本保留明确标记的首轮用户上下文兼容模式。agy 0.1.24 bridge 通过 `_meta.appResources.directory` 生成会话私有附加目录，确认后不再将规则粘贴到用户消息。agent 的上下文压缩、管理员策略及模型遵从仍由运行时控制，不能承诺永不遗忘。

修改规则后重新连接 agent，使新连接生成新快照；恢复、加载和派生会话同样传递当前连接的资源绑定。技能工具读取源目录中的文档，原生技能使用连接快照。默认内置技能只补充缺失文件，不覆盖已有正文。技能目录与文件不接受符号链接，只复制 Markdown 文档，不复制凭据或可执行脚本。独立连接互不删除对方的快照；强制结束应用可能留下快照目录。

`mcp.json` 使用 ACP 描述符数组，例如 HTTP 服务 `{ "type":"http", "name":"my-tool", "url":"http://127.0.0.1:12345/mcp", "headers":[] }`，stdio 服务 `{ "name":"my-tool", "command":"node", "args":["/absolute/server.cjs"], "env":[] }`。调用方同名配置优先；Studio 自带的 MCP 地址仍按实际监听端口注入，不固化到磁盘。agy 全局 MCP 注册模式会被拒绝。应用配置目录不会加入项目可写根。

连接状态的 `resources` 字段提供源目录、快照目录、配置摘要、桥版本、技能目录和各会话的交付方式。它反映配置交付事实；实际模型读取需另行验证。新增测试覆盖源文件保留、快照隔离、版本门、兼容引导、局部 MCP 与清理；本机真实 agy 已用仅存在于规则/技能文档中的随机标记验证读取。

## 参与贡献

真实 Electron 端到端测试：运行 `bun run test:e2e`。测试会先完成前端类型检查、构建与 Electron 主进程构建，再启动独立应用实例；需要本机已安装 Bun 和项目依赖。

测试仅脚本化模型输出，真实执行 ACP 通信、studio-ui MCP 工具、聊天渲染和卡片操作回传，验证决策与表单在原会话中继续回答。每例使用临时工作区、独立用户数据和动态网关端口。失败截图与 trace 保存在 `test-results/`，可用 `bunx playwright show-trace <trace.zip路径>` 查看。

1. Fork 并新建分支
2. 提交前运行 `bunx tsc --noEmit` 和 `bunx vitest run tests/universal`
3. 在 `CHANGELOG.md` 的 `Unreleased` 小节添加条目
4. 提交 PR

项目约定见 `.agents/rules/`（错误处理、禁止静默降级、状态管理、UI 设计、版本管理）。

## 自动更新与发版

- 打包版启动后自动检查 [GitHub Releases](https://github.com/yitom486/autumnflow/releases)（启动 10 秒后一次，之后每 4 小时）。发现新版时右下角提示（窗口在后台则发系统通知），点 **更新** 在后台差分下载，下载完点 **重启并更新** 即静默安装；不点也会在退出或下次打开时自动装好，不走安装向导。
- Windows：首次安装走向导，可选择安装目录；之后的更新在后台静默安装到同一目录（安装器从注册表 `InstallLocation` 读回原目录）。若把它装到需要管理员权限的目录（如 `C:\Program Files`），更新时会弹一次 UAC 确认。
- 平台支持：Windows ✅；Linux AppImage ✅；Linux deb 与 macOS（暂未签名）只提示新版并打开下载页。设置 `ACP_DISABLE_UPDATES=1` 可关闭检查，或在“设置 → 关于与更新”关掉自动检查；菜单“检查更新…”随时手动检查。
- 发版：先在 `CHANGELOG.md` 的 `[Unreleased]` 写条目，然后 `bun run release:patch`（默认只升 patch，minor/major 需显式放行）→ 提交 → `git tag vX.Y.Z && git push --tags`。Release 工作流打包三平台，并用 `bun run release:notes X.Y.Z` 截取的 CHANGELOG 小节作为 Release 说明。

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
