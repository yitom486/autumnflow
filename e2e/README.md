# Electron 端到端验证

运行 `bun run test:e2e`。全局准备会重新构建前端和 Electron，测试使用隔离的用户目录、
本地脚本智能体和真实 ACP / studio-ui MCP 服务，不调用云端模型。

## 覆盖范围

| 测试文件 | 验证内容 |
| --- | --- |
| `mcp-graphics-reasoning-electron.spec.ts` | 原生 MCP 思维导图嵌套折叠与全屏同步、流程图汇合及循环、架构层折叠；实时推理在换行、分包 ID 变化和 230ms 间隔下保持一个思考块 |
| `acp-interactions-electron.spec.ts` | 标准 ACP 授权请求的允许一次、会话允许、拒绝及关闭；elicitation 扩展的 JSON Schema 表单填写、类型回传及跳过，验证原始反向请求恢复而非新增聊天轮次 |
| `generative-ui-electron.spec.ts` | 决策与表单回传原会话、清单、指标、React 沙箱、基本图表、流式占位及图文混排顺序 |
| `diagram-components-electron.spec.ts` | 六种原生结构化图表在明暗主题下的真实 SVG、缩放边界与重置、全屏、原生剪贴板复制、SVG 文件下载；Mermaid 流程图、时序图、状态图的流式 Markdown 渲染及预览交互、多图隔离、语法错误后的恢复 |
| `session-history-electron.spec.ts` | 应用主会话历史、外部历史导入、子会话只读查看、主会话继续输出与草稿保留 |
| `runtime-isolation-electron.spec.ts` | 开发与正式运行环境按两种顺序启动、各自连接正确网关、侧栏图标文字间距及关闭隔离 |
| `dev-window-electron.spec.ts` | Windows 下 Bun / Node 网关模式均显示原生桌面窗口，不新增可见控制台，退出后释放端口并可使用原端口重启 |

图表测试通过聊天输入触发脚本智能体，结构化图表调用真实 MCP 工具并消费其返回值。
Mermaid 使用真实渲染器和浏览器指针事件，覆盖滚轮缩放、拖拽平移、键盘重置、方向键、
焦点循环与 Esc 关闭。剪贴板内容在测试后恢复；下载文件写入测试实例目录。
思维导图另覆盖明暗主题下的节点折叠、后代与连线隐藏、嵌套折叠保留、键盘操作、
全屏与卡片状态同步、缩放后继续交互及多图隔离。
测试失败保留截图与 trace；明暗主题的结构化图表截图作为附件保存。
完整报告输出到 `playwright-report/index.html`，运行 `bunx playwright show-report` 可查看。

单独运行图表矩阵：`bun run test:e2e -- e2e/diagram-components-electron.spec.ts`。
单元与 Mock 链路检查：`bun run test`；类型与生产构建检查：`bun run build`。
Windows 单元测试限制为最多 4 个 worker，避免原生子进程及 WSL 目录探测并发过高。
命令在仓库根目录运行；文件隔离测试的 `TEMP` / `TMP` 应指向仓库外目录，
以免临时路径被视为仓库工作区或 Git 子目录。
