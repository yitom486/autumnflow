# AutumnFlow Desktop (Electron)

桌面客户端：Electron 窗口 + 独立 Gateway Host 子进程（Hono），前端 `dist` 由 Host 同源 served，
无需浏览器、无需常驻终端。

## 架构

```text
Electron main (Node, electron-dist/main.cjs)
 ├─ 窗口 / 菜单 / 更新 / 原生对话框 / IPC 边界
 └─ Gateway Host child (ELECTRON_RUN_AS_NODE, electron-dist/host.cjs)
     ├─ /api/universal/*  → 通用 Agent stdio 适配器（codex / antigravity / opencode / …）
     ├─ /*                → dist/ 前端静态文件（ACP_PUBLIC_DIR 覆盖，见下）
     ├─ MCP UI server     → studio-ui（13920+ 层叠端口）
     └─ PTY WebSocket     → node-pty（真交互终端）
```

主进程只等待 Host 的 `ready`，不直接持有 HTTP/PTY 或 Agent 子进程；Host 崩溃不会带走窗口，
退出时主进程先发 `shutdown`、等待 Host 关闭 agent 桥接后再退出。开发模式仍由外部
`bun run dev` 同时起 Vite + 网关，`dev:desktop` 不启动 Host。

`server/index.ts`（Bun）与 `server/node.ts`（Node）是同一 Hono app 的两种独立入口；
生产桌面端改由 `desktop/host.ts` 启动同一个 app。

## Turn journal 与重连

每个 prompt turn 除了内存 ledger 外，还会写入：

```text
~/.autumnflow/journal/<agent>/<turnId>.jsonl
```

文件由 meta、带 `seq` 的事件和 finish 三部分组成。SSE 断线时客户端用
`turnId + afterSeq` 先读内存，再读 journal；Host 重启后也能重放已完成的
turn。没有 finish 的 turn 视为中断，恢复时只追加一次 terminal error，
**不会把 prompt 再发给 Agent**。写盘按 50ms 合并，turn 结束和 Host 退出时
强制 flush；默认保留 7 天或最近 500 个 turn。

前端 thread 还保存一个 `activeTurn` 指针（`turnId`、`lastSeq`、
`persistedSeq`、状态、assistantId）。流式期间每 1.5 秒冻结一次消息；页面
刷新或新窗口恢复 thread 时会自动 `GET /chat/:turnId/follow`，从已经持久化
的 seq 继续，不重新发送 prompt。服务端在事件被裁剪或客户端 seq 超前时发送
`reset` 帧并重建气泡；SSE 干净 EOF 但没有 `done` 会作为 interrupted 重试，
不会静默当成正常结束。

## 退出/更新保护

主进程在关闭最后一个窗口、普通退出和安装更新前请求
`GET /api/universal/active-work`，检查运行中的 turn、PTY、待确认
permission/elicitation 和子任务。有任务时弹原生确认框：取消会保留窗口并
取消安装，继续才关闭 Host/进入更新。Host 不可达时普通退出不阻塞，但更新
会被取消并报错，避免在未知状态下重启。

## 页面认证

生产 Host 在 HTML 响应上设置 `acp_gateway_session` Cookie
（HttpOnly、SameSite=Strict、Path=/）。渲染端在 `authMode=cookie` 时不再读取
preload token；同源 HTTP 与 PTY WebSocket 自动携带 Cookie。服务端对 Cookie
请求额外要求同源 Origin（或 `Sec-Fetch-Site: same-origin`），其他回环端口
页面不能借用该会话。

开发模式（外部 Vite + 网关）和远端网关仍使用 Bearer token：前者由 preload
提供，后者在设置页手动保存。生产环境的 `gateway:getToken` 返回空字符串，
避免 renderer JS 直接拿到 token。

## SSE 事件边界

`src/lib/app-events.ts` 定义闭合的 `AppEvent`（start/update/done/error/
permission/elicitation/activity）。`consumeUniversalChat` 先归一化再分派；
ACP 新增的未知 update kind 仍会进入 activity 转发，未知顶层事件保留 raw 并
记录 debug，不会被静默丢弃。

## 开发

```bash
bun run dev:desktop      # 【推荐】一键启动桌面开发环境（自动编译主进程 + 启动网关与 Vite + 开启热更新桌面窗口）
ACP_GATEWAY=node bun run dev:desktop   # 要体验真 PTY 终端：改跑 Node 网关（默认 Bun 网关无 node-pty，终端回落单次模式）

# 亦可分步调试：
bun run build:electron   # 仅打包 main+preload 到 electron-dist/
bun run dev              # 启动开发网关 (13015) + Vite (5188)
bun run dev:electron     # 外接已启动的 vite(5188)+网关，只启动 Electron 窗口调试
```

开发版和正式版可以同时运行：开发 HTTP 网关默认 `13015`、MCP 默认 `13930`，
正式版分别为 `13005`、`13920`；开发页面仍使用 `5188`。`PORT`、`MCP_PORT`、
`ACP_DEV_VITE_PORT` 可显式覆盖，开发启动器会把同一配置传给网关、Vite 和桌面窗口。
开发与正式版分别使用 `autumnflow-dev`、`autumnflow` 的 Electron 数据目录和单实例锁。
端口被占用时会报错退出，不再强杀占用进程；退出开发环境只结束本次启动的子进程树。
Windows 下启动器直接管理 Vite 和网关，不为后台服务创建独立控制台窗口，
由启动器统一关闭并确认退出，避免脚本包装进程先退出后遗留 Vite 占用端口。
页面加载或网关启动失败会显示错误提示，不会留下空白窗口。

会话列表默认读取应用管理的引用索引，仅包含本应用创建或主动导入的主会话。
索引位于应用资源目录的 `history/development.json` / `history/production.json`，
也可通过 `ACP_SESSION_INDEX_FILE` 指定。索引不保存聊天正文、不修改 Agent 的原生历史目录；
前端仍有用于快速恢复的有限本地缓存。Agent 不支持历史持久化或回放时，引用本身不能恢复缺失的正文。
已有外部历史可通过侧栏“导入外部历史”按页选择添加，不会自动认定旧记录均由本应用创建。
已识别的子智能体不进入主列表，在顶部“子任务”菜单中只读查看，可一键返回主会话，
不会切换主会话 ID、清空输入或停止正在运行的任务。识别依赖明确的 ACP 子会话事件或
`opencode/child-session` 元数据，不以标题或普通 fork 的 parent 字段猜测。
近期子任务事件只缓存在网关内存，历史原文仍通过 Agent 的回放能力读取；界面注明记录来源。

## 生产运行（免安装验证）

```bash
bun run build && bun run build:electron
electron electron-dist/main.cjs   # main 启动 Gateway Host 子进程并打开窗口
```

## 打包

先执行 `bun run build && bun run build:electron`，再执行 `bun run package:win`
（macOS/Linux 分别用 `package:mac` / `package:linux`）。打包脚本先生成
`.acp-tmp/desktop-app`：完整复制 `dist` 与 `electron-dist`，发布 manifest 仅声明
外置原生依赖 `node-pty`，附当前平台/架构的原生运行文件及第三方许可证汇总。
Mermaid、Markdown、数学公式等前端依赖已编译进 `dist`，不再额外复制其 npm 原始包。
`bun run stage:desktop` 可以单独检查发布目录；不要跳过 staging 直接调用 builder。
发布构建压缩主进程与 preload，KaTeX CSS 只引用 WOFF2 字体（不打包重复的
WOFF/TTF）。`electron-dist/host.cjs` 会按 `asarUnpack` 解包到
`resources/app.asar.unpacked/electron-dist/host.cjs`；主进程从该路径 fork Host，
不要把 Host 留在 asar 内。界面和开发演示共用 `public/icon.png`；高清猫咪原图保存在
`build/icon.png`，不复制到前端发布目录。
原生终端使用系统 ConPTY（显式 `useConptyDll: false`），保留 WinPTY 回退文件；
发布目录不带实验版 `conpty.dll` / `OpenConsole.exe` 和仅用于编译的
`node-addon-api`。其许可证仍保留在第三方声明中，开发依赖不变。
注意两件事（均已踩坑）：

1. `electron/` 不能作为源码目录名——会与 npm `electron` 包撞名导致
   `Bun.build` 解析失败，本项目源码目录叫 `desktop/`。
2. `electron-builder` 在本机 Windows Defender 下解包官方 Electron 时会
   EBUSY，可先手动组装 `release/manual-unpacked` 验证（见 git 历史），
   或以管理员权限给输出目录加 Defender 排除后再跑 builder。

## 打包布局与路径铁律

- preload 路径必须经 `app.getAppPath()` 解析，**禁止 `__dirname`**
  （bun 打包时会把它内联成编译期绝对路径）。
- 前端静态目录必须经 `ACP_PUBLIC_DIR` 环境变量覆盖（main 内指向
  `<app>/dist`），**禁止依赖 `process.cwd()`**。
- `spawn` 跨运行时走 `spawnCrossPlatform`（`server/universal/AgentConnection.ts`）：
  Node 在 Windows 下直接 exec `.cmd` 会 `EINVAL`，须经 shell 中转。
- **真 PTY（node-pty）是 native 模块**（`server/universal/pty.ts`）：
  `package.json#build.asarUnpack` 含 `**/*.node`（asar 内 native 不可加载，
  必须解包）；打包机上 electron-builder 默认 `npmRebuild` 会按 Electron ABI
  重编（需配好编译工具链：Windows 要 VS Build Tools）。dev 下 Bun 网关无
  PTY（回落单次执行），要真 PTY 请用 `dev:server:node`（Node 网关）或
  Electron 内置 Host 进程。
  例外：`npmRebuild` 已关（`false`）——node-pty 是 N-API 模块，prebuild
  跨 Node/Electron ABI 通用，源码重编纯属浪费（且本机缺 Spectre 库会编
  失败，见 MSB8040）；只有换 node-pty 大版本或缺对应平台 prebuild 时才
  需要开重编（届时配好工具链再开）。

## 远端网关（WSL / SSH，UI 留本机）

前端默认连同源本地网关；设置 → 网关可填自定义基址（如
`http://127.0.0.1:4004`），HTTP/WS 全链路（`apiFetch` 前缀 + PTY 候选基址优先）
自动跟过去，令牌按基址隔离保存。切基址自动重载页面（会话状态归属网关）。

- **网关跑进 WSL（原生 Linux agent/工具）**：WSL 内进仓库目录，
  `PORT=4004 bun run dev:server:node`，基址填 `http://127.0.0.1:4004`，
  令牌贴 WSL 里 `~/.autumnflow/.gateway-token`，工作区直接用 Linux 路径。
- **SSH 远端**：远端起网关（只听 127.0.0.1 即可），本地
  `ssh -L 4004:127.0.0.1:3004 user@host -N`，基址填 `http://127.0.0.1:4004`。
- 非回环 http 基址设置页会 loud 警告（明文 token 出本机）；跨源能通是因为
  CORS 只回显可信本地 Origin（`server/universal/security.ts`，端口不限）。

## GitHub 运维流程

- `.github/workflows/ci.yml`：push/PR 跑类型检查 + universal 单测 + Web 构建 + Electron 打包校验。
- `.github/workflows/release.yml`：打 `v*` tag 即发版，产物为 NSIS 安装包 +
  绿色 dir 包，自动挂到 GitHub Release（未签名，SmartScreen 会提示；
  有证书后配 `CSC_LINK` / `CSC_KEY_PASSWORD` 即可消除）。
- legacy `tests/integration` 因依赖 live agy 流程、CI 里不跑（现状如此，
  与本次无关），门禁以 `tests/universal` 为准。
