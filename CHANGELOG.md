# Changelog

本文件由 `bun run release:patch`（及 minor/major 变体）自动维护：
发版时把 `Unreleased` 小节归档为新版本，手工只管往 `Unreleased` 里加条目。
版本号规则见 `.agents/rules/version_control.md`，事实源为 `package.json`。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
日期为发版当日（UTC+8）。

## [Unreleased]

### Fixed
- 修复 Codex 明明已在本地登录、界面却提示「本地暂无可用登录态」的问题：应用独占的 `CODEX_HOME` 之前只在副本缺失时从 `~/.codex` 复制一次登录态，用户之后在 Codex 里重新登录（或令牌刷新）就不会同步到副本，Codex 一直拿着过期令牌。现在源文件更新时按 mtime 原子刷新副本；应用内自己登录产生的副本更新则不会被旧的用户文件覆盖。用户的 `~/.codex` 依旧只读。
- 修复启动预热与首次发送并发时重复创建会话的问题：Agent 冷启动期间两条路径会同时发起 `session/new`，导致 Agent 侧留下一个孤儿会话。现在同一智能体共享同一个在途创建请求，强制新建（`force`）仍然独立发起。
- 修复聊天右侧预览栏在长对话下重复扫描导致的卡顿：消息文本改为单遍提取、纯函数派生条目（原实现用 `indexOf` 在 `map` 内查下标并把每条正文读两遍），结构变更与字符流式分别按 150ms / 600ms 节流。
- 修复待处理授权在空闲时仍以 1.5 秒频率轮询网关的问题：改为有待处理请求时 1.5 秒、空闲时 6 秒（SSE 已经是实时通道，轮询只负责重连后的兜底）。
- 修复会话日志清理后仍保留文件标记、导致常驻 Host 下集合持续增长的问题：删除文件时一并移除标记。
- 修复结束响应的本轮累计 tokens 覆盖上下文占用的问题：独立保存 usage_update 的窗口/会话费用与 prompt 响应的累计用量，普通发送和断线恢复采用相同逻辑；缺少上下文数据时明确显示未提供。
- 修复工具调用插入或思考块出现时正文运行时位置变化、导致已输出阶段文本重新播放打字机的问题：按消息与文本块身份保留流式游标，文本不变保持显示，前缀相同仅追加新增后缀。
- 修复 OpenCode 2 延迟工具目录下 studio-ui 已挂载但模型误报不可用的问题：MCP 握手提供工具发现说明，OpenCode 首轮兼容上下文引导通过 execute/search 查找真实工具签名；不覆盖用户已有配置。

### Added
- 新增「MCP 与技能」面板（智能体菜单 → MCP 与技能）：列出当前内置 MCP 服务、它暴露的 6 个工具与内置技能，显示服务地址、Agent 声明的 MCP 能力（HTTP / stdio）以及每一项的开关状态，并可逐项开关。工具开关立即生效：被关闭的工具会从 MCP 的 `tools/list` 中移除，智能体无法再调用；技能开关对技能目录立即生效，并在智能体下次连接时不再进入它的资源快照。
- 新增 `/api/universal/capabilities` 接口：读取当前 MCP 工具 / 技能清单与开关状态，以及切换单个工具或技能的开关。
- 新增「同步本机登录态并重连」：Codex 的认证弹窗里可以直接把本机 `~/.codex` 的登录态同步进应用独占的 CODEX_HOME 并重连，不必再走一次 authenticate。

### Changed
- CI 与 Release 门禁改用 `bun run typecheck`：此前只跑 `tsc --noEmit`，`desktop/` 与 `shared/` 目录从未进入类型检查。单测门禁也从只跑 `tests/universal` 扩到整个 `tests/`（补上 acp-client 集成、代理与桌面策略套件）。CI 新增独立的 Electron E2E 作业（桌面壳此前没有任何流水线覆盖）。
- 内置 studio-ui 工具的名称、说明与简介收敛到单一来源（`server/universal/studio-tools.ts`），MCP 服务与能力面板共用同一份描述，避免两处漂移。
- 移除内联审批下线后已无调用方的 `matchPermToToolCalls` 及其断言；所有授权统一由交互坞处理。
- 修复导入的外部会话因本地线程为空而从侧栏消失的问题：导入引用指向的是 Agent 侧尚未加载的历史，空线程不能作为隐藏它的依据（此前被更早的断言失败掩盖）。
- 修复能力面板开关缺少无障碍名称的问题：开关改用 beUI 的 Switch 组件（`ariaLabel` 属性），此前 `aria-label` 会被组件丢弃，屏幕阅读器读不到开关名称。
- 修复两处发布门禁 flaky：mermaid 图表用例在并行负载下超时、离线 registry 用例在子进程启动稍慢时误判失败；两者都改为等待真实条件而不是假设时序。修复后单测连续三轮 783/783 全绿。

## [0.1.13] - 2026-10-19

### Fixed
- 修复 Linux/macOS 上解析 Windows shell 路径时误判 PowerShell 类型的问题，统一支持两种路径分隔符；补充跨平台回归测试。

### Changed
- 包含下方 v0.1.12 的全部更新。v0.1.12 因跨平台测试失败已停止发布，用户可直接从 v0.1.11 升级到本版本。
### Added

## [0.1.12] - 2026-10-19

### Fixed
- 修复安装版首次启动时 token 提前创建新配置目录、导致旧 agents 等配置未被迁移的问题；读取磁盘 token 前先迁移应用目录。
- 增强断线恢复能力：SSE 断流后的自动重试从 2 次（约 3 秒）提高到 4 次（1/2/4/8 秒，约 15 秒），足以跨过 Host/网关重启；服务端已接受该轮时重试走 `GET /chat/:turnId/follow` 续流，仍在运行的一轮会被接回而不是重发 prompt。若重启确实打断了这一轮，会明确显示「本轮被网关重启中断（prompt 未重发，请重试）」，不再是笼统的 `network error`；`unknown or expired turn` 也会给出「服务端已没有这一轮」的提示。
- 修复恢复的线程指向已失效会话时首条消息直接失败 `Invalid params: unknown session`：chat 路由现在识别 ACP -32602 的会话失效，先用 `session/resume` 接回（保住上下文），不行再新建会话并在同一轮重试一次；客户端从第二个 `start` 帧拿到新 session id，用户消息不丢、也不会重复计费。
- 修复只有余额、没有限额窗口的配额（DeepSeek 账户）在顶部智能体 chip 上完全不显示：现在显示 `¥12.34` 形式的余额徽标；限额环和短计划名仍优先展示。配额数据本身一直存在（面板里的卡片能显示），只是 chip 之前只认窗口/计划名。
- 修复 Agent 冷启动时首轮只显示「等待响应…」：未连接时首轮提示改为「正在启动 Agent…（首次或升级后可能较慢）」，对应 `bunx @deepseek-ai/dsh@latest` 首次解析与启动的实际耗时。
- 修复 DeepSeek 轮次因缺少 API Key 失败时只抛原始英文错误：现在识别 `no API key for provider route`，在错误气泡里直接给出两条可操作路径（切到 **DeepSeek Account** 模型分组，或配置 `DEEPSEEK_API_KEY`），并说明这是 DSH 的 `deepseek-official` 路由缺凭据，而不是客户端没有读取本地配置。
- 修复取消后立刻重发导致 prompt 互斥锁失效：`session/cancel` 只是通知，被取消 turn 的 `finally` 会释放**下一个** turn 刚拿到的锁，使同一会话出现并发 prompt（409 保护形同虚设）。改为带租约令牌的 `PromptLock`：旧 turn 只能释放自己的租约，取消时按抢占处理；Agent 进程退出时重置全部租约，崩溃后不会留下永久 409 的会话。
- 修复 per-session 内存只增不减：`sessionCommands` / `childUpdates`（每子会话最多 200 条 update）/ `childStates` / `childParents` / `releasedTerminals` 原先只在进程断开时清理，长跑 Host 下随会话数持续增长。现由 `SessionState` 单一所有者持有，`session/close`、`session/delete` 时连同子智能体会话一起回收。
- 修复关闭窗口时仍弹「仍有任务在运行」阻断框：常驻模式下关窗不再等于退出，改为由 `window-all-closed` 的 active-work 巡检决定缩到托盘还是正常退出；显式「退出」与安装更新仍保留原确认。
- 修复渲染端 console 事件在 Electron ≥35 下取不到内容：`console-message` 第二参数已从 `level` 变为 `details` 对象，崩溃报告里的 error 级日志因此一直为空；两种签名都兼容。
- 修复 `desktop/host.ts` 与 `desktop/main.ts` 在 Electron 44 类型下的两处编译错误，桌面端自此纳入类型检查。
- 修复发行版点击「新会话」/「点击加载模型」时 `e.trim is not a function` 崩溃：新会话按钮把 React 点击事件当作 `targetCwd` 传入 `setWorkspace`，现已在 UI 接线、hook 入口与路径工具三层做类型收口。
- 修复跨智能体会话串绑：切换 Agent 时清空上一 Agent 的 live session/messages，并丢弃 `session/new`、`resume`、`fork`、模型发现等迟到结果；历史线程按 Agent 隔离恢复。
- 修复失效会话把 UI 卡在历史视图：resume 失败后清除 live `sessionId`（历史记录仍保留），「点击加载模型」会强制新建会话并载入模型；无效/过期 session id 不再被裸绑定，重复失败会保留 stale 标记。
### Changed
- 补齐 AutumnFlow 更名：Electron preload 桥接与前端调用统一为 `window.autumnflow`，同步更新安装/卸载侧边栏位图、安装脚本注释和仓库规则中的旧品牌、配置路径。
- 内部拆分（对外行为不变）：`UniversalAgentConnection` 拆成四个单一职责模块——`AcpTransport`（进程 / NDJSON 流 / initialize / 退出）、`SessionService`（new/load/resume/fork/list/close/delete 与会话元数据回收）、`PromptTurn`（prompt 租约、取消、首轮兼容块）、`SessionState`（per-session 内存的唯一回收点），facade 从 1005 行降到约 620 行，只保留 permission / fs / terminal / subagent / quota 语义与广播，HTTP 路由与对外 API 完全不变。桌面端同时纳入类型检查：新增 `tsconfig.desktop.json` 与 `bun run typecheck`，Electron 主进程/preload/host 与 server/shared 一起过 `tsc`。
- 全面更名：应用目录改为 `~/.autumnflow`。首次启动会把旧 `~/.acp-studio`（agents、`.gateway-token`、journal、trash、codex-home）复制到新目录，并把旧 `~/.acp-client/`（AGENTS.md、skills、mcp.json）复制到 `~/.autumnflow/resources`；旧目录只读保留、不再写入；Electron userData 同步迁移到 `%APPDATA%\autumnflow`，主题的 localStorage key 迁移到 `autumnflow_theme_v1`。`appId` 改为 `com.autumnflow.app`（注意：已有安装会被视为新应用，自动更新不会从旧安装接续）。GitHub 链接、菜单、日志与 ACP `clientInfo` 统一为 AutumnFlow；路径类环境变量统一为 `AUTUMNFLOW_HOME` / `AUTUMNFLOW_CODEX_HOME` / `AUTUMNFLOW_RESOURCES_DIR` / `AUTUMNFLOW_SKILLS_DIR`（旧名不再读取）。
- Codex 默认使用应用独占的 `CODEX_HOME`（默认 `~/.autumnflow/codex-home`，可用 `AUTUMNFLOW_CODEX_HOME` 或 `AUTUMNFLOW_HOME` 覆盖，不写死机器路径）：首次连接从用户 `~/.codex` 复制 `auth.json` 与 `config.toml`，并合并 `[features] code_mode = true` 后启动；不再写入全局 `~/.codex`。复制或创建失败时自动回退用户目录并告警，不影响 Codex 可用性。
- 升级 `@yitom/acp-client` 到 0.1.14：Codex 隔离 home 改为复用 SDK 的 `provisionCodexCodeModeHome`，并新增会话级 code mode 的 wire 测试（mock Agent 声明 `_meta.toolsMode` 时收到 `ptc`，未声明时不发）。注意 0.1.14 的 `preserveMcpOnRetry`：agent 拒绝 `mcpServers`（例如 stdio 条目缺 `env`）时不再静默降级为无 MCP 会话，而是让 `session/new` 直接失败（`ACP_PROTOCOL_ERROR`）。
### Added
- 会话级 Code mode（PTC）：智能体面板新增 `Code mode` 开关，仅在 Agent 的 `initialize` 声明 `agentCapabilities._meta.toolsMode` 时显示；开关按线程持久化。开启后新建/恢复会话会带上 `_meta.toolsMode = 'ptc'`，Agent 只下发 `run_code`，并把该会话的全部工具（含 studio-ui MCP）渲染成 `tools.<name>()`。未声明的运行时（codex/claude/opencode/agy）忽略该请求——OpenCode 的 code mode 本来就由 MCP 目录驱动，无需开关。
- DeepSeek 凭据面板：智能体面板新增「DeepSeek 凭据」入口。可在应用内把 `DEEPSEEK_API_KEY` 写入 DSH 的 user-env（`$DSH_HOME/.env`，原子写入、保留其它变量与注释、写前备份 `.env.bak`、不回显密钥），保存后点「重连」让新的 `dsh` 进程读取；重连在有运行中对话时拒绝（409）。面板同时给出「改用 DeepSeek Account 模型分组」和 `dsh --profile web` 设置页两条替代路径。
- DeepSeek 账户额度：配额卡片可以显示 DSH 登录账户的余额与身份（邮箱/昵称）。优先读取 `dsh` 自己维护的平台登录凭据（`$DSH_HOME/.credentials.yaml`，只读、不写、不记日志）查询平台钱包，其次用 `DEEPSEEK_API_KEY` 查官方 `/user/balance`；DeepSeek 没有公开的速率窗口，因此只展示余额，不伪造 5h/周额度。
- 后台常驻（混合策略）：关闭最后一个窗口时，若仍有运行中的 turn / 终端 / 待确认权限 / 子任务，则缩到托盘继续跑（首个窗口关闭时提示一次）；任务全部结束发系统通知；空闲 30 分钟自动退出（托盘菜单可改 5/15/60 分钟或永不）；双击托盘、托盘菜单、第二实例启动都会重新创建窗口并自动 `GET /chat/:turnId/follow` 接回仍在跑的那一轮。
- 后端崩溃自动恢复：Host 异常退出时按 1s/3s/8s 退避重启（最多 3 次），成功后重载窗口，稳定 1 分钟后重置预算；托盘常驻期间恢复失败会结束常驻并报错，不再出现「图标还在、后端已死」。
- 会话列表与顶栏显示人类可读的会话名称：优先使用 Agent `session/list` / `session_info_update` 提供的标题，回退到首条用户消息生成的标题；不再把裸 session id 当作会话名展示（id 仅保留在悬停提示与检索中）。
- 空会话自动收敛：已知无用户/助手内容的空会话立即从列表隐藏，并在闲置后 best-effort 删除；另每分钟对 Agent 侧默认标题且超过 5 分钟未活动的空会话做一次保守清理，保留当前会话、已有内容和自定义标题。
- 多终端浮动窗口：每个窗口独立 xterm + PTY/WebSocket，可同时开多个 shell；标题栏「+」新建窗口、点击置顶、窗口位置分别持久化，关闭单个窗口不影响其他终端。
- 终端 shell 自动探测：优先用户本机的 PowerShell 7 (`pwsh.exe`)，再回落 Windows PowerShell、`%COMSPEC%`/cmd、`$SHELL`/常见 POSIX shell；支持 `ACP_TERMINAL_SHELL` 显式覆盖，状态接口与终端标题显示实际 shell（例如 PowerShell 7+），不再硬编码 PowerShell 5。
- 模型目录冷启动缓存：按 Agent 持久化上一次 `models` / `configOptions`（含 OpenCode 的 100+ 模型选项），启动或切换 Agent 时先立即恢复模型选择器，再由新的 `session/new` 后台刷新；避免每次重启都要等 OpenCode 冷启动数秒才看到 OpenCode Go 模型。
- Turn 幂等与断线续传：客户端为每次发送生成 `turnId`，服务端 turn ledger 只接受一次 prompt；SSE 断线后客户端带同一 `turnId` 与 `afterSeq` 续流，服务端按序号补发缺失事件，不再重复工具调用/计费/副作用；新增 `GET /chat/:turnId/follow`。
- 流式 UI 按动画帧合并：文本与思考 chunk 先进入 `FrameBatcher`，每帧最多提交一次 store patch；工具卡/图片/终态前强制 flush，保持内容与事件顺序。
- Electron IPC 边界加厚：所有 native IPC 都校验发送窗口、主 frame 与 `senderFrame.url` 的 origin，只允许应用自己的页面调用。
- 有界崩溃诊断：主进程/渲染进程/子进程异常与启动失败写入 `userData/logs/crashes/crash-*.log`，包含版本、平台、错误与最近 error 级渲染日志，最多保留 10 份；不阻塞启动或退出。
- 独立 Gateway Host 进程：Electron 主进程只保留窗口、协议、更新和生命周期，网关、MCP UI、PTY WebSocket 与 Agent 桥接移到 `ELECTRON_RUN_AS_NODE` 的 `host.cjs` 子进程；主进程等待 ready、收集 stderr、异常退出写崩溃报告；退出时先向 Host 发 shutdown 再退出，文件删除通过 IPC 回到 Electron `shell.trashItem` 以保留系统回收站。
- 持久化 Turn Journal：每个 turn 写入 `~/.acp-studio/journal/<agent>/<turn>.jsonl`（meta + seq 事件 + finish），Host 重启后按 turnId 恢复；未写完的 turn 恢复为一次明确的 interrupted 错误，绝不重新发 prompt；完成/错误 turn 可直接重放，最多保留 7 天/500 个 turn，退出前强制 flush。
- 退出/更新保护：新增 `GET /api/universal/active-work`，汇总运行中的 turn、PTY、待确认 permission/elicitation 和子任务；关闭最后一个窗口、普通退出和安装更新前弹原生确认，取消则保留窗口/取消安装；Host 不可达时退出不阻塞、更新则取消并报错。
- 桌面 HttpOnly 会话：Gateway Host 在 HTML 响应上设置 `acp_gateway_session`（HttpOnly、SameSite=Strict），生产渲染端不再向 preload 索取 token，HTTP 与 PTY WebSocket 均使用 Cookie；Cookie 请求额外校验同源 Origin/Sec-Fetch-Site，跨回环端口页面不能借用会话。开发外部网关与远端网关仍走 Bearer token。
- 类型化 SSE 边界：新增闭合 `AppEvent` 联合与 `normalizeAppEvent`；`start/update/done/error/permission/elicitation/activity` 走显式分支，未知事件保留 raw 并记录日志，不再静默落入字符串分支；补充快照/重放消费者测试。
- 刷新/多窗口续传：thread 持久化 `activeTurn {turnId,lastSeq,persistedSeq,status,assistantId}`，流式期间每 1.5 秒冻结消息；启动时自动 `GET /chat/:turnId/follow` 从已持久化 seq 续接，不重新 prompt。SSE 重连在服务端已接受 turn 后改用 GET follow；snapshot/follow 增加 `firstSeq/lastSeq/fromSeq/resetRequired/resetReason`，gap/ahead 发送 reset 并重建气泡；干净 EOF 无 `done` 视为 interrupted/重试，不再静默当成功。

## [0.1.11] - 2026-10-18

### Added
- 官方 ACP SDK 与协议深度对齐：引入 Ajv 强校验官方 @agentclientprotocol/sdk Schema，严格支持 Session Artifacts（Plan、Compaction、SessionMessage 等）
- 人机协同（Human-in-the-Loop）问询与授权生命周期：全面支持官方 Elicitation 协议（Form 与 URL 模式），加固 Permission 授权响应归一化
- 解决 OpenCode 在 ACP 模式下的问询中断：自动注入智能兼容指引与工作区配置，以无缝承接富交互决策卡
- 交互式 PTY 终端认证：实现基于官方 AuthMethodTerminal 规范的专用 PTY 认证终端组件 AcpAuthTerminal
- 主题感知图表与思维导图交互折叠：彻底清除图表硬编码颜色，增加 Mermaid/SVG 导图节点折叠/展开交互与键盘无障碍支持

## [0.1.10] - 2026-10-17

### Added
- 全面集成 beUI 智能体交互系统（Agent Activity & Motion）：引入成熟组件库的 `AgentActivity`、`ReasoningText`、`ThinkingShimmer` 与 ASCII/Braille 动态加载器，将思考链（Thinking Trace）、阶段推进记录（Progress Trace）与工具执行流合流为紧凑自适应高密度容器。
- 深度思考流式直出：思考过程模块默认展开，接入 `AcpStandaloneMarkdown` 实时流式渲染深度推理文本；视口高度自动贴合实际内容动态延展，彻底消除空白黑洞与高度截断。
- 动态模型目录与配额探针：支持通过本地 agy hub 真实动态探测语言服务配额，支持 Claude 3.5/3.7/Opus、Gemini 2.5/Gemini 4、OpenAI Codex 等真实模型并实时展示剩余比例及重置时间，告别硬编码。
- 品牌全新升级 AutumnFlow（秋水）：引入结合现代工业玻璃金属质感与东方水墨意境的流体光刃（Fluid Light Blades）全套高精桌面图标。
- 应用会话历史使用独立引用索引，只显示本应用创建或主动导入的主会话；支持手动导入外部历史，正文仍由原 Agent 保存。
- 已识别的子智能体会话收纳到顶部“子任务”入口，支持只读查看及快速返回主会话，保留主会话流式输出和未发送草稿。
- 补齐五种结构化图表的明暗主题、缩放、全屏、复制与 SVG 下载端到端矩阵；增加 Mermaid 流程图、时序图和状态图的真实渲染、预览交互、多图隔离及语法错误恢复验证。
### Fixed
- 根治流式输出气泡抖动：助手消息气泡容器解绑 Framer Motion `layout="size"` 弹簧物理位移干涉，交由浏览器原生 Blink 排版引擎单向自然展开，彻底消灭吐字时的高频微震与微卡顿。
- 根治文字闪烁与突变：彻底清除所有前端模拟伪造文案与定时器轮播循环，状态文案 100% 严格绑定 ACP 协议后端真实事件；修复 Shimmer 渐变色阶在暗黑模式下的遮罩断裂。
- 重构架构拓扑图连线：彻底重构 `EditorialDiagramCard` 架构图走线算法，改用中轴中线对齐与端点贝塞尔曲线精确定位，增加节点半透明背景衬底与高对比度边框，解决多层跨节点连线交叉与标签遮挡。
- 单轮上下文 Token 消耗与缓存命中率口径标准化：避免将历史累计生命周期 Token 误作单轮增量导致上下文占用虚高，真实展示提示词增量与缓存命中率。
- 修复侧栏项目图标容器宽度不足导致图标与项目名称重叠的问题。
- 开发与正式版隔离默认网关、MCP 端口及桌面实例目录；端口占用明确报错，避免误结束其他实例，并报告页面或网关加载失败。
- 修复 Windows 开发启动窗口被隐藏、退出后 Vite 遗留占用端口，以及后台服务额外弹出黑色控制台的问题。
- 修复结构化图表全屏被聊天区域层叠上下文限制、退出按钮遭顶栏遮挡的问题；全屏挂载到页面根部，支持 Esc 退出及焦点恢复。

## [0.1.9] - 2026-10-16

### Fixed
- 修复首次建会话导致当前消息丢失；真实 Electron E2E 使用实际 studio-ui MCP 返回验证决策与表单回传，并自动构建、隔离运行与保存失败 trace。
### Added
- 接入 acp-client 0.1.9 应用资源接口，支持 `~/.acp-client/` 的规则、附加指令、Skills 与局部 MCP 配置；按连接隔离快照，原生桥版本门与兼容交付可诊断，正常断开清理。
- 正文内嵌生成式 UI 与流式占位符：支持在 AI 回答正文中通过流式隐藏锚点无缝混排矢量图表（流程图/时序图/架构图）、交互卡片（决策/清单/指标）与 React 沙箱；流式期间呈现 BeUI 动效与骨架屏，后端 MCP 返回后原位无缝挂载。
- 真实 Electron 端到端闭环测试矩阵：全量覆盖 Flow 1–Flow 9，真实拉起 Electron 实例验证出版级矢量图表缩放与导出、交互卡片选择、表单参数回传、React 沙箱原型热更新、流式占位过渡与 DOM 纵向坐标混排顺序。

## [0.1.8] - 2026-10-14

### Added
- 过程与最终结论智能分离（Partition Turn Content）：智能体执行期间的中间进度、思考过程、工具调用与最终交付结论物理分离；单轮结束后中间过程自动收拢折叠进抽屉，卡片最底部直观呈现按时间序排列的最终结论。
- 精准复制最终结论：单轮卡片复制按钮精确提取最终成果结论，自动剔除冗长的过程流与调试日志。
- BeUI / Beautiful UI 动效思考加载器：引入全套现代 BeUI 动效加载器（ascii-braille / dot-matrix / morph / comet 等），取代单调静态思考指示。
- VSCode 风格代码变更审查面板（TurnDiffViewer）：全面替代零散的系统药丸，展示文件增删行数统计（+N -M）、语言类型徽标与就地展开代码 Diff，超出 3 个文件弹性折叠。
### Fixed
- 连续系统操作（System Activities）聚拢折叠：连续多个 [fs_write]、[terminal] 等系统事件自动合并为 28px 单行动态折叠胶囊（如“系统记录 · N 项操作 (最新: ...) ▾”），彻底消灭垂直堆叠十几行霸屏推挤正文的问题。
- 规范全仓换行符：增加根目录 `.gitattributes` 强制源码与计划文件保持 LF 换行，从源头杜绝 Windows CRLF 导致 AI 智能体行匹配失败进而中断会话的隐患。
- 智能体上下文失步诊断与自愈引导：捕获并识别由于工具异常遗漏回包导致的“No tool output found for function call”，提供直观诊断说明与新建会话恢复引导。

## [0.1.7] - 2026-10-14

### Added
- 实时接入 Antigravity 本地语言服务配额探针：动态探测本地 `language_server` 监听端口与 CSRF 凭证，实时获取真实 Gemini 模型（5小时/周限额）与第三方 Claude/GPT 模型的剩余百分比及准确重置时间，彻底消除原先 100% 假数据。
- 完整接入 OpenAI Codex 配额显示：统一 `runtimeId` 映射规范，支持在顶栏状态面板实时查看 ChatGPT 账号、5小时限额、周限额以及余额 Credits。
- 本轮改动文件查看器（TurnDiffViewer）：会话每轮执行完毕后自动汇总改动文件胶囊（新增/修改/删除），支持点击直接展开内嵌逐行 Diff 视图或在编辑器中打开。
### Performance
- 极致流式渲染降载与去重：为消息滚动器（MessageScroller）增加 150ms 防抖合并与用户消息浅比较 bailout，在 AI 流式输出期间完全避免滚动轨与父级元素频繁重排重绘。
- 移除流式块 `filter: blur(3px)` 高开销 GPU 模糊滤镜，改用硬件加速透明度过渡；流式期间延迟全文 Citations 正则解析，彻底消除打字机输出卡顿与掉帧。
### Fixed
- 移除首包到达前思考状态胶囊（ThinkingStateCapsule）中硬编码的 4 条虚构模拟步骤，重构为真实经过时间计时的极简呼吸态。
- 桌面安装包构建与字体精简：KaTeX 样式表收敛至仅引用 WOFF2，避免重复携带旧版字体文件；优化原生终端依赖与发布目录结构。

## [0.1.6] - 2026-10-14

### Added
- 前端性能瘦身：无图聊天首屏 JS 原始体积从 6.81 MB 降到 1.38 MB（减少约 80%）；Mermaid 各类图表与布局引擎动态分包，弹窗和终端首次打开时才挂载，关闭后保留组件状态与终端实例。
- 智能体架构深度解耦：通用 Agent 终端管理、额度获取与进程生命周期收归上游 @yitom/acp-client（升级至 ^0.1.7），本地 AgentConnection.ts 从 1663 行精简至 600 余行，按职责抽离 fs-guard、interaction 与 platform/spawn 模块。
- 消除 Antigravity 智能体启动伪错误红字：上游桥接组件 @yitom/agy-acp-map（升级至 0.1.23）将 routine trace 日志默认静默，仅在真实致命异常时输出 stderr，彻底杜绝控制台全红误报。
- Mermaid 保留各类图表与布局引擎的动态分包，避免约 5 MB 的合并包进入无图聊天首屏；弹窗和终端首次打开时才挂载，随后保留组件状态与终端会话。
- 桌面安装包改用独立的精简发布目录：保留完整前端编译资源（含 Mermaid、Markdown、数学公式和代码高亮），避免重复携带前端 npm 原始包；原生终端只收当前平台/架构的运行文件，剔除 source map、PDB、测试文件，保留第三方许可证汇总；Electron locales 保留中英文。
### Fixed
- 静态带哈希资源使用长期 immutable 缓存，HTML 与普通资源保留更新验证，并支持 ETag / Last-Modified 的 304 响应；版本查询缓存未命中时改为后台异步刷新，同包并发查询合并，避免同步 npm 查询阻塞事件循环。
- 图片和 Mermaid 灯箱改用非 passive 滚轮监听与 Pointer Capture：阻止缩放时背景滚动，拖出画布松开、取消、失焦均正确收尾；支持单指触屏和方向键平移，补齐焦点循环与关闭后焦点恢复，并避免父组件刷新中断拖拽；灯箱通过 Portal 挂到 body，避免聊天容器裁剪或盖住全屏工具栏。
- 额度文本解析改用浏览器纯函数模块，避免聊天组件导入 Node SDK 的文件系统/子进程入口导致 Vite 生产构建失败；保持原 SDK 解析结果一致。

## [0.1.5] - 2026-10-13

### Added
- 底部状态栏 VSCode 式远程角标：左下 `>< 本机/WSL:xx/远端host`，点开切环境（本机/WSL 发行版 + 最近 WSL 目录/远端网关设置/回到本地）；WSL 发行版来自网关 `wsl -l -q`（5 分钟缓存）；distro 解析抽零依赖单模块，终端徽标同源
- WSL 原生真环境一键打通：支持一键在目标 WSL 发行版内拉起/直连原生 Headless 网关，默认端口升级为高位专属 13005（避开 3000~3999 常用端口冲突）；自动平滑迁移
- WSL 纯 Linux 原生工作区：新建会话与默认目录自动解析为纯 Linux 路径（如 `~`、`/home/...`），彻底杜绝 `/mnt/...` 跨系统挂载与性能惩罚
- WSL 进程环境隔离与加速：严格剔除 Windows PATH 挂载盘污染，优先调度 Linux 原生 `bunx`，解决 Codex Agent 会话建立慢与 npm 远程拉包卡死问题（会话初始化降至 450ms）
- 内置工作区目录选择器：支持在 WSL Linux 与 Windows 之间无缝浏览与选取目录，支持新建目录、面包屑跳转与键盘导航
- 工作台流畅 P0：目录悬停 250ms 后台预取一层（命中省一次 RTT）；git status 进行中再调只排队、跑完补一次（watch 风暴不叠请求）；保存加 saving 中态（并发保存合并，失败/冲突必清态）
- 工作台流畅 P1：`/api/universal/search` 内容搜索（rg --json 优先、无则 walk，`engine` 明示；WSL 经 wsl.exe），文件树搜索条（防抖/过期丢弃，点结果打开并跳行）；顶栏网关健康点（30s 轮询 + 切窗即查，点进网关设置）
- 终端抽屉藏而不杀：关闭只 `display:none` 隐藏，xterm/WS/shell 跨开关保留，重开零重建（兼修二次打开白屏）；右上 X 只隐藏，新增电源按钮才真正结束 PTY 会话
- 工具卡片“终端打开”携带执行 cwd：无则回落当前工作区；与现存活会话不同目录时仅提示、不悄悄杀 shell
- PTY 断线续接：WS 断后 shell 保留 3 分钟，同 id 重连即续接原会话（刷新/闪断不丢状态），到期无续接才杀；重影接管自动关旧端
- 远端网关：设置 → 网关可填自定义基址（WSL 内 / SSH 远端的网关），HTTP/WS 全链路跟随、令牌按基址隔离、切基址自动重载；非回环 http 明示嗅探风险

## [0.1.4] - 2026-10-12

### Added
- 输入框工具栏精简：只保留模型与思考等级，附件、/ 命令、权限（Auto review）、模式、Fast mode、模型库收进“更多”弹层；按容器宽度自适应收缩；聊天栏最小宽度 360px
- 顶栏精简：智能体、连接状态、pid、认证收进左上角状态胶囊（点开查看详情、切换智能体、连接 / 认证 / 退出）；顶栏单行不换行，窄宽度下变更 / 终端 / 通道 / 工作区收进“…”菜单
### Fixed
- 文件树悬停抖动与“ResizeObserver loop completed…”错误提示：文件树按内容区（不含内边距）取整测量、RAF 合并去重，容器隔离布局，滚动条槽位固定；该良性错误不再弹出提示（仍记录到控制台）
- 输入框打字时布局抖动：输入框 2–8 行内按整行增长、超出内部滚动；聊天区滚动条槽位固定；贴底跟随对尺寸变化去重
- Windows 桌面快捷方式与 exe 显示默认 Electron 图标：此前关闭了 signAndEditExecutable，导致图标未写入 exe；现在嵌入完整多尺寸 ico（16–256），并补齐 macOS icns、Linux 16–512 图标、网页 favicon/manifest

## [0.1.3] - 2026-10-12

### Added
- 斜杠命令：无命令时显示“该智能体暂未提供命令”；命令名支持 `:` `.` 等字符；显示参数提示（ACP input.hint）；生成中可浏览（回车只填入不发送）；内置本地命令 /clear /mode /help（标注“本地”，不发给智能体）
- 工作台可拖拽分栏（侧栏/文件树/编辑器/聊天），布局自动持久化，Ctrl+B / Ctrl+Shift+E 折叠同步
- 文件树或系统文件拖入输入框：工作区内文件/文件夹转为 @ 引用（文件夹最多 20 个文件），外部文件按大小限制作为附件；@ 引用显示为可删除的标签
- 只读 Jupyter Notebook (.ipynb) 查看器：Shiki 高亮、Markdown 单元、文本/图片/错误输出，HTML 输出在沙箱 iframe 中渲染，大文件分批挂载
- Markdown 文件所见即所得模式（Milkdown，按需加载，默认源码），保存时保留未改动块的原始格式
- 聊天中的数学公式渲染（KaTeX，按需加载）、历史回放显示用户图片、流式输出中未闭合代码块正常渲染
- **检查更新入口**：应用菜单（macOS“ACP Studio”菜单 / Windows·Linux“帮助”菜单）与标题栏菜单都有“检查更新…”；新增“设置 → 关于与更新”，显示版本、平台、更新状态与下载进度、上次检查时间、“自动检查更新”开关，手动检查无新版时明确提示“已是最新版本”；窗口在后台时发现新版 / 下载完成会发系统通知（点通知打开关于页），前台则在右下角弹出提示；开发版 / 浏览器模式注明不检查更新。
- **原生菜单与命令**：文件（新建窗口、新会话、打开文件夹、最近打开、保存、关闭标签页、在文件管理器中显示、复制路径、设置）、编辑（撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选）、视图（命令面板、切换侧栏 / 文件树 / 终端 / 深浅色、缩放、全屏）、帮助（检查更新、更新日志、报告问题、关于）。原生菜单、标题栏菜单（Windows / Linux / 浏览器）、命令面板（Ctrl/⌘+Shift+P）与快捷键共用一套命令注册表。
- **多窗口**：“新建窗口”打开独立窗口，每个窗口记住自己的工作区；打开文件夹时用当前窗口；命令行再次启动并带目录参数（如 `acp-studio .`）会在新窗口打开该目录；最近打开的文件夹同步到系统“最近文档”。
- **工作区文件树**（react-arborist）：目录懒加载、虚拟滚动、完整键盘导航、拖拽移动、行内重命名、新建文件 / 文件夹、删除（进系统回收站）、右键“在文件管理器中显示 / 复制路径 / 查看改动对比”；git 状态徽标（M / A / D / U）且包含改动的目录显示圆点；磁盘变化（含智能体写文件）自动刷新。
- **代码编辑器**（CodeMirror 6）：标签页（单击预览为斜体、双击或开始编辑即固定）、未保存圆点、Ctrl/⌘+S 保存、关闭前确认；语法高亮按扩展名懒加载（TS/JS/JSON/Markdown/CSS/HTML/Python/Rust/YAML）；配色全部取自主题变量，切换主题时随整页一起淡入淡出。
- **改动对比**：`@codemirror/merge` 并排 / 统一两种视图（HEAD ↔ 工作区，未改动段落折叠）。
- **智能体修改已打开文件时自动刷新**：无本地改动就直接重载并短暂高亮新增 / 修改的行；有未保存改动则显示冲突条（用磁盘版本 / 覆盖保存 / 对比）。
- 后端文件接口 `/api/universal/fs/*`：`list`（单层）、`read`（含 mtime，2MB 上限、拒绝二进制）、`write`（mtime 乐观锁，冲突返回 409 与磁盘内容，原子替换）、`create`、`rename`、`delete`（回收站）、`watch`（SSE，100ms 合并）。
### Security
- 新文件接口与其余网关接口同样强制令牌；路径一律相对工作区解析并经 realpath 校验，`..`、绝对路径、指向工作区外的软链接都拒绝（列目录时这类软链接不可展开）；不能写 / 改 / 删 `.git` 内的文件，不能删除或重命名工作区根；工作区本身仍不能是文件系统根或系统目录。
- 应用内外链一律交给系统浏览器打开，不再在应用里新开窗口。
### Fixed
- 斜杠命令列表在 session/new、load、resume 之后到达时丢失、切换会话后串用：网关按会话缓存 available_commands_update 并随会话响应返回，前端按会话保存
- CI 中 fs watch SSE 测试偶发失败（读取循环会丢弃已到达的数据块）

## [0.1.2] - 2026-10-12

### Added
- 流式输出体验：在底部时自动跟随新内容（ResizeObserver，80px 阈值），往上翻看时绝不强制滚动，点“回到底部”重新跟随；生成中的回答气泡外有一圈缓慢旋转的细光环与柔光，结束后淡出；新段落轻微淡入，光标改为跟在文字末尾的细竖线；系统开启“减少动态效果”时关闭这些动画。
- 主题切换改为整页一次交叉淡化（View Transitions，统一 180ms / 同一缓动），切换期间关闭元素自身过渡，各部分同时完成、不再卡顿；去掉对所有元素常驻的全局颜色过渡，8 处 `transition-all` 改为只过渡需要的属性；不支持或开启“减少动态效果”时直接切换。
- 开发假数据 `?fixture=stream`：模拟逐字流式输出，便于检查上述效果。
### Fixed
- 自动更新：安装包文件名去掉空格（如 `ACP-Studio-Setup-<版本>.exe`），`latest*.yml` 里的文件名与 GitHub Release 附件一致，否则更新会下载 404。
### Changed
- Windows 安装改为向导：首次安装可选择安装目录（固定为当前用户安装，去掉“为谁安装”选择页；安装器侧边栏 / 页眉换成 ACP Studio 品牌图），创建桌面与开始菜单快捷方式；之后的自动更新仍后台静默安装（`/S`），沿用注册表里记录的安装目录，不再弹向导。
- CI / Release 工作流的 GitHub Actions 升级到 Node 24 版本（checkout v7、upload-artifact v7、download-artifact v8、action-gh-release v3）。

## [0.1.1] - 2026-10-12

### Added
- **自动更新**（类似 VS Code / Zed）：打包版启动 10 秒后及每 4 小时检查 GitHub Releases；发现新版在左下角提示，点“更新”后台差分下载并显示进度，下载完点“重启并更新”静默安装，不点则退出或下次打开时自动装好，不再走安装向导。Windows（NSIS 一键安装）与 Linux AppImage 支持自动安装；macOS（未签名）与 deb 只提示并跳转下载页。
- 界面采用 tweakcn **vercel** 主题，浅色 / 深色 / 黑 / 白四档；对话区单色化（审批提示、徽标去彩色），“未跟踪”徽标改为中性虚线样式。
- 开发模式假数据路由 `?fixture=conversation` / `?fixture=approval`，方便截图与调样式，不进生产构建。
- 发版说明由 CHANGELOG 生成：`bun run release:notes <版本>` 截取对应小节，Release 工作流用它作为 GitHub Release 正文。
- 浏览器模式的网关令牌页与一次性登录链接（`/?token=...`，网关启动时打印）；Electron 经 preload 自动注入令牌。
### Security
- 网关对所有 `/api/universal/*`（含 `terminal/exec`）与 PTY WebSocket 强制访问令牌：不带或带错令牌一律 401，不再因为“没有 Origin 头”放行；Origin / Host 校验保留。
- 删除 `routes.ts` 里“安全模块导入失败就放行”的可选鉴权代码，改为静态导入、失败即拒绝；路由响应不再返回 `Access-Control-Allow-Origin: *`。
- 工作区白名单从“只告警”改为强制：智能体经 ACP `fs/write_text_file` 只能写会话工作区（session cwd + additionalDirectories + `ACP_WORKSPACE_ROOTS`）之内，`..` 与软链接逃逸同样拒绝；文件系统根 / 系统目录不能作为工作区（`workspace/validate` 返回 403，`session/new` 拒绝）。
### Fixed
- Windows CI：测试钩子（关闭桥接、删临时目录）超时从 10s 放宽到 30s，避免发版时偶发超时。
- 浅色主题下 diff 注释颜色对比度不足（改为 `#4b535d`，满足 WCAG AA）。
- 终端工作目录不存在时不再悄悄换成网关当前目录：`terminal/exec` 返回 400 并写明路径（cwd 也必须显式给出），ACP `terminal/create` 把错误回给智能体；终端抽屉显示网关返回的具体原因。
- 打开集成终端时整个界面崩溃进错误页（`You must set the allowProposedApi option`）：xterm 6 下 Unicode11Addon 用到的 `term.unicode` 属于 proposed API，Terminal 补上 `allowProposedApi: true`。
- `bun run test` 全绿：`@yitom/acp-client` 集成测试改为等 `session/update` 通知落地再断言（原先与 prompt 响应赛跑）。
- 测试不再写真实 `~/.acp-studio/agents.json`：全局 setup 把 `ACP_AGENTS_FILE` / `ACP_AGENTS_HOME` / `ACP_GATEWAY_TOKEN` 指向临时目录。
### Changed
- `server/universal/routes.ts`（1000+ 行 if 链）拆成按功能划分的 Hono 子路由 `server/universal/http/*`，请求体用 zod 校验；坏 JSON 或字段类型不对返回 400，不再静默当成 `{}` 继续。其余接口行为不变。
- `@agentclientprotocol/sdk` 升级到 1.8（`^1.8.0`），类型检查与全部测试通过。
### Removed
- 去掉对话区入场（BlurFade）与闪光文字动画；删除未使用的 `ChatArea.tsx`、`UniversalComposer.tsx`。
- 遗留文件 `scripts/stage-my-changes.py`（写死 `D:\` 路径）、空的 `scratch/out.json`、`run-zed-acp.cmd`。
- 未使用的依赖 `@bufbuild/protobuf`；`@yitom/acp-client` 只被测试使用，移到 devDependencies 并锁定 `0.1.2`（不再用 `latest`）。

## [0.1.0] - 2026-10-12

首个公开发版（此前 `package.json` 误标 1.0.0，回正为 0.1.0 起步）。

### Added
- 通用 ACP v1 网关（`server/universal`）：多 agent stdio 管理、
  permission/fs/terminal/elicitation 客户端能力、authStatus 透出、
  fork/providers 透传、load 回放收集、HTTP/SSE 接口。
- ACP Studio Web 工作台：Agents/Sessions 侧边栏、模型库浏览器
  （模型/思考等级/权限选择与发现）、slash 联想、附件（拖拽/粘贴/预览）、
  Markdown 富文本、git 变更查看（前后对照 + 统一 diff）、
  providers 面板、elicitation 表单、权限审批流。
- Hono 网关（Bun/Node 双入口）与 Electron 桌面壳（进程内网关、
  打包配置、GitHub CI/Release 工作流）。
- 前端工程化：zustand 客户端状态、TanStack Query 服务端状态、
  shadcn + Magic UI 组件体系、蓝灰变量主题、集中错误处理
  （error-bus/ErrorBoundary/ErrorToast）。
- 文档：`docs/sdk`（客户端/服务端写法，TS+Rust）、agent 规则
  （版本/ UI 设计/错误处理/状态管理）。
- **真 PTY 交互终端**（`node-pty` + WebSocket）：抽屉打开即探活，可用走
  WS 全双工真 shell（原生回显、`Ctrl+C` 即 SIGINT、job control、vim/ssh
  可用），不可用（Bun dev 网关）回落单次执行并明示；标题栏 `PTY`/`单次`
  徽标、fit 列数同步、预填只打字不回车、断线显式重连；`ACP_GATEWAY=node`
  一键切 Node 网关体验（`dev:desktop` 默认仍是 Bun 网关）。
- **终端 xterm addons**：链接可点、回滚搜索（`Ctrl+F`）、一键导出 `.log`、
  Unicode11 CJK 列宽对齐；`Ctrl+L` 清屏。
- **终端浮动面板**：右下浮动替代整条占底，标题栏拖动、八向缩放、几何
  持久化；xterm 配色跟随 4 套主题（浅色 ANSI 压暗、black/white 对调），
  切换热更新不重建。
- **排队/插队**：流转中发送进队列按序排出（edit/reload 先清队列）；
  插队按钮先停当前轮再发送；`TerminalCard` 加“终端打开”（预填不执行）。
- **@-mention 文件引用**：`@` 触发工作区文件防抖搜索（网关只读端点，
  cwd 禁闭/数量字节封顶/拒二进制），选中拼 `resource` 附件进发送管线。
- **本轮改动撤销**：助手 footer“改动 N”进 TurnChanges 面板，逐文件
  Diff（复用 Git 审查）/还原（confirm + git restore）；非 git 只读。
- **发送失败自动重试**：传输类错误重发（默认 2 次 backoff），注脚成功即
  清；abort/auth/语义错误永不重试。
- Studio store 新增 `useStudioShallow` / `useStudioMessages`：选择性订阅
  视图状态，刻意排除 `messages`（流式热路径字段）。
- README 新增“桥接库三源版本对齐”小节：根 `package.json ^x.y.z` /
  `scratch` 子模组 commit pin / runner 缓存 `@latest` 三源语义与对齐策略
  （发版前 `bun update` + 锁定；实际运行版本以 `initialize` 的
  `agentInfo.version` 为准）。
- 新增 `tests/universal/presets-runner.test.ts`：断言
  `antigravity-stdio` 解析为 runner 命令（含 `@yitom/agy-acp-map@latest`、
  不含 `.exe`），codex 回归守卫同在。

### Changed
- **正式包可用 PTY**：`node-pty` 改 external（native 不可打进 cjs），
  `files` 收运行子集（去 pdb/map/单测），整包 `asarUnpack`；加载双路径
  （包内 CJS 走裸 require，Node ESM 走 createRequire）。
- **Studio 外壳重渲染修复**：`App.tsx` 原先用无选择器
  `useStudioStore()` 订阅整个 store，导致每个流式分片都重渲染整个布局。
  现改为 `useStudioShallow` 选择性订阅，`messages` 下移到真正渲染它的
  `ChatArea`（经 `useStudioMessages`）；持久化 effect 改为按需
  `getState()` 读取，不再订阅热路径。符合
  `.agents/rules/state_management.md` 的选择器订阅约定。
- **tsconfig 渐进严格化第一步**：保持 `strict:false`，新增
  `"strictNullChecks": true`（基线 `bunx tsc --noEmit` 0 错误，试开增量
  0 错误 <20 阈值）；全量 `strict:true` 暂缓（残留 4 个 TS7022
  于 `src/lib/universal-api.ts` 回放聚合），渐进路线
  （session→SSE→安装→权限/elicitation→文件终端）已写进 `tsconfig.json` 注释。
- **README 过期引用修正**：`server/acp-stdio.ts`（不存在）改为
  `server/universal/` + `server/index.ts` / `server/node.ts` 与桥自带
  `sdk-server.ts`（`bun run acp:stdio` 真入口）；`src/lib/sse-client.ts`
  改为 `src/lib/universal-api.ts`；`server/bridge/agyBridge.ts` 改为
  `server/universal/*`；核心库徽章 `v0.1.3` 改为 `v0.1.6`
  （以根 `package.json` 为准）；测试徽章改为“74 Vitest (universal)”
  并注明黑盒需本地 `bun`；目录结构小节与真实布局对齐
  （`server/universal`、`desktop`、`tests/universal`）。
- **agy 切 codex 式 runner**：`antigravity-stdio` 不再 spawn 86MB
  managed exe，改为 `bunx @yitom/agy-acp-map@latest` 直起 thin JS
  `bin.js`（与 codex 预设同构）；`registry.ts` 删除 exe override
  分支；`agent-installer.ts` 的 `MANAGED_AGENTS` 清空为通用空表，
  bridge/exe 解析（`bridgeSource` / `resolveBridgeExe` /
  dev-checkout）与 `resetHeadlessLauncherCache` 一并退役；
  `routes.ts` 删除 `/bridge-source`、`/install-state`、`/install`、
  `/install/:jobId` 端点；前端删除安装徽标/安装按钮/bridge 切换/
  自动更新开关整条线（`App`、`Sidebar`、`universal-api`）；
  `desktop/main.ts` 删除 `agy-headless.exe` 打包挂载；
  `acp:stdio` 脚本改为 `bunx @yitom/agy-acp-map@latest`；
  依赖升 `@yitom/agy-acp-map ^0.1.13`（thin npm，无大 exe）；
  `no-silent-fallbacks` 规则同步到 runner 语义（本地桥联调改走
  自定义 profile 覆盖）。
- **历史恢复丢回答修复**：`handleSend` 全程不调 `snapshotThread`，
  trailing 自动快照只在会话/线程切换后触发，流式完成后再无落盘，
  reload 回来只剩用户问。现改为每轮结束（成功/失败/abort）立即
  `snapshotThread`；`freezeMessage` 落盘只保留最终答案（+thought），
  tool 调用与结果展示层可见、永不落盘。
- **连接即 resume**：`handleConnect` 的 resume 分支之前丢弃
  `session/resume` 返回的 modes/models/config，模型选择器空到首问；
  现回应用 + `applyDefaultConfigOptions`；`handleOpenSession` 在
  load 回放成功后显式 `resume` 绑定（失败只 warn，不阻断已绑定的历史）。
  编排归 Studio，桥只负责 ACP 协议动作。
- **标题**：`index.html` 改为自有标题 `ACP Studio`。
- **桥 0.1.14（reload 对等）**：取消/失败轮也落半截文本（`partial` 标记），
  `session/load` 照常回放；子模组 pin 到桥 `9d270f4`（`v0.1.15`），CI 新增桥历史测试门禁
  （`history-partial-persist` + `session-history`）；npm 线上为 `0.1.16`
  （含本轮 MCP+partial 全部修复，已验 tarball：旧硬错无残留），
  本地基线跟进到 `^0.1.16`（`bun.lock` 同步，代码内无直接引用）。

### Fixed
- **静默错误 loud 化**（`no-silent-fallbacks` / `error_handling`）：
  `server/universal/registry.ts` 自定义 agents 文件解析/持久化失败由静默
  `return []` 改为 `console.warn` 带文件路径 + 原因（仍返回 `[]` 保活网关）；
  `server/universal/presets.ts` 的 `ACP_AGENTS_JSON` 损坏同样 `console.warn`
  保活；`src/App.tsx` 工作区默认值、配置恢复链、一次性会话清理的裸
  `.catch(()=>{})` / 空 `catch` 改为 `console.warn` / `console.debug`
  （逻辑不变）；剪贴板复制失败改 `console.debug`；
  `findRunnerBin` 逐项试探补 deterministically 无害注释。
  可预期清理失败（disconnect/close）允许忽略但均已留痕；
  本轮横切另含安全加固、agent 异步按需安装、SSE 发送互斥、前端懒加载拆分，
  细节见各专项条目（此处仅汇总，不编造版本号）。

[Unreleased]: https://github.com/yitom486/autumnflow/compare/v0.1.13...HEAD
[0.1.0]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.0
[0.1.1]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.1
[0.1.2]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.2
[0.1.3]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.3
[0.1.4]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.4
[0.1.5]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.5
[0.1.6]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.6
[0.1.7]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.7
[0.1.8]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.8
[0.1.9]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.9
[0.1.10]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.10
[0.1.11]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.11
[0.1.12]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.12
[0.1.13]: https://github.com/yitom486/autumnflow/releases/tag/v0.1.13
