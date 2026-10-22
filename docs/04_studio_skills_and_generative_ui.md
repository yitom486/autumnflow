# 04 - AutumnFlow 技能系统与生成式 UI 架构技术白皮书

> 本文系统阐述 AutumnFlow 如何在**完全不污染各智能体私有环境、不污染用户工作区 Git 仓库、且不浪费每一轮会话 Token** 的前提下，实现跨模型生态（Claude、Gemini/Antigravity、Codex、Cursor 等）的出版级矢量图表与生成式 UI 交互规范的统一分发与按需加载。

---

## 一、 背景痛点与架构挑战

在将多种生态的智能体接入 AutumnFlow 时，传统做法通常面临三个两难工程困境：

1. **每轮 Turn 硬塞大段提示词（Prompt Bloat）**：
   - 传统做法是在每个会话或每一轮提问的前后拼接长篇大论的“格式说明书”和“Schema 规范”；
   - 这不仅极大浪费宝贵的输入 Token 与计费成本，而且会稀释模型的有限注意力窗口（Attention Span），导致智能体在处理核心业务逻辑时产生记忆断层。
2. **各智能体寻找配置的机制各自割裂（Fragmentation）**：
   - Gemini / Antigravity 默认查找 `~/.gemini/config/skills`、内置目录或工作区的 `.agents/skills/`；
   - Claude Code 查找 `~/.claude/rules`、`CLAUDE.md` 或自身 MCP；
   - Cursor 查找 `.cursorrules` / `.cursor/rules`；
   - 各生态私有目录互不兼容，无法统一维护。
3. **环境污染的致命隐患（Pollution Hazard）**：
   - **全局配置污染**：若将 Studio 专属组件规则直接写入用户本机的 `~/.gemini/` 或 `~/.claude/`，当用户离开 Studio 在纯终端环境使用这些命令行工具时，智能体依然会尝试调用 `studio-ui` 工具，导致脱机报错；
   - **工作区代码污染**：若写入被打开项目的根目录，会给用户的 Git 仓库强加非项目本身的私有配置文件。

---

## 二、 复合零污染分发架构设计（Hybrid Architecture）

AutumnFlow 创造性地采用 **“以 MCP 原生按需检索为骨干，以 ACP 会话级附加目录为底层辅助”** 的无污染复合架构：

```mermaid
flowchart TD
    subgraph AutumnFlow 本地专属数据层
        SkillStorage["server/universal/skills/\n├── diagram-design/SKILL.md\n└── generative-ui/SKILL.md"]
    end

    subgraph studio-ui MCP 服务（端口 >= 10000）
        McpServer["McpServer (Streamable HTTP)\n• list_studio_skills\n• get_studio_skill(name)\n• render_editorial_diagram\n• show_interactive_card\n• render_react_sandbox\n• prompt_form"]
    end

    SkillStorage -->|本地发现与解析| McpServer

    subgraph 多生态智能体会话（Universal Agent Sessions）
        Claude["Claude Code / Codex\n(MCP Tool 按需拉取文档)"]
        Antigravity["Antigravity / Gemini\n(MCP 调取 + 目录自动发现)"]
    end

    McpServer ==>|JSON-RPC Tools Call| Claude
    McpServer ==>|JSON-RPC Tools Call| Antigravity
    SkillStorage -.->|additionalDirectories 授权注入| Antigravity
```

### 1. 核心骨干：MCP 原生按需调取（On-Demand Retrieval）
* **免环境限制与网络穿透**：通过本地 5 位数端口（默认 25920+）运行的 `studio-ui` MCP 服务进行标准通信。无论 Agent 运行在宿主机、WSL2、Docker 容器还是远程环境，只要网络 RPC 连通，即可通过统一协议调用；
* **极低基准开销**：上下文仅暴露极简的工具元数据（约 40 个 Token）；
* **自驱按需激活**：平时对话不发送任何冗余说明；当用户发起“绘制微服务架构拓扑”或“方案对比”时，智能体自主调用 `get_studio_skill({ name: "diagram-design" })` 或 `list_studio_skills()`，即时拉取规范与示例，用完即走。

### 2. 底层辅助：ACP 原生 `additionalDirectories` 授权注入
* 在 `UniversalAgentConnection.newSession` 创建会话时，系统自动将 Studio 内部 skills 路径追加至 ACP 协议规定的 `additionalDirectories` 列表中；
* **双重增益**：
  * 对于原生支持工作区技能扫描的智能体（如 Antigravity / Gemini 体系），可无缝识别该目录下的技能清单；
  * 对于其它智能体，自动将其加入客户端文件系统沙箱的信任白名单，杜绝文件访问越权拦截。

### 3. 会话生命周期轻量首轮引导（Encouraging Hint）
* 在会话第 1 轮（Turn 0），通过轻量级温和提示告知智能体当前客户端具备富交互与出版级图表工具，并提示其可随时通过 `get_studio_skill` 调取详细指南；
* **随后的第 2 轮及之后（Turn 1+）完全静默**，绝不进行重复注入。

---

## 三、 内置 Studio 技能规范定义

当前 Studio 内置两大核心技能，位于 `server/universal/skills/`：

### 1. `diagram-design`（出版级矢量图表设计指南）
基于出版级高品质设计理念，重点倡导：
* **单一聚焦主色原则（1-Accent Principle）**：图表底色采用极简黑曜石深色或纯净纸面浅色，严禁高饱和度彩虹配色；仅允许使用 1 个强调色（如 `emerald`、`blue`、`indigo` 等）高亮核心执行链路或焦点节点；
* **5 大核心图表原型**：
  1. `architecture`：分层容器、跨层网络与组件边界；
  2. `sequence`：时序参与者、递增编号消息、虚线异步返回；
  3. `flowchart`：流水线步骤、状态机流转与决策分支；
  4. `quadrant`：双轴 2x2 评估矩阵（如收益 vs 成本、重要性 vs 紧迫性）；
  5. `timeline`：项目演进里程碑阶段与进度状态。
* **淘汰原始 Mermaid**：引导智能体调用 `render_editorial_diagram` 直接生成带有缩放、居中重置与 SVG 导出功能的现代矢量交互组件。

### 2. `generative-ui`（生成式富交互卡片与沙箱规范）
* **`show_interactive_card`**：支持决策卡片（`decision`）、检查清单（`checklist`）、指标看板（`metrics`）与轻量表单（`form`）；
* **`prompt_form`**：人机协同多参数填报控件，在聊天流中收集结构化输入并直接回调；
* **`render_react_sandbox`**：为前端原型提供隔离的 React / HTML 实时交互沙箱。

---

## 四、 会话生命周期对称注入与多端共存隔离机制

### 1. 全生命周期对称注入（Symmetric Session Lifecycle Enrichment）
在 [AgentConnection.ts](file:///d:/project/js/Electron/antigravity-acp/server/universal/AgentConnection.ts) 中，通过 `enrichSessionPayload` 统一管线，对以下所有会话切入点保持 100% 幂等对称注入：
* **`session/new`**：新建会话时注入 `studio-ui` MCP 服务与 Studio Skills 目录；
* **`session/resume`**：断点恢复会话时同样补齐专属 MCP 与技能路径，并重置首轮引导计数器；
* **`session/load`**：历史会话重新加载时无缝挂载 Studio 环境；
* **`session/fork`**：派生子会话继承完整的生成式交互与技能环境。

### 2. 与原生 CLI（Codex、OpenCode）共存的零污染隔离机制
* **内存/传输层临时注入（Zero Disk Pollution）**：
  Studio **绝不写入** 任何全局或宿主磁盘配置（不修改 `~/.codex/config.json`、`~/.config/opencode/` 或代码仓库 `.git`）。所有的 `mcpServers` 与 `additionalDirectories` 仅作为当前 ACP 子进程通道的内存 JSON-RPC 参数下发。
* **原生 CLI 访问该会话时的行为**：
  用户若在系统终端中运行原生 `codex resume <session-id>`，原生客户端只读取磁盘标准配置，由于没有 Studio 的 HTTP MCP 端口注册，原生客户端不会连接 Studio 服务，历史卡片数据仅作为文本展示，原生工具（`bash`、`edit` 等）完全正常执行，**不会报任何找不到 MCP 服务的错误**。
* **返回 Studio 时的无缝恢复**：
  当用户在 Studio 中重新 `load` 或 `resume` 该会话时，Studio 重新注入活跃的 `studio-ui` 端口与技能，富交互与出图能力立刻恢复。

---

## 五、 能力面板：可见可切的工具与技能

Studio 之前只把工具与技能「交给智能体」，用户看不到也切不了。能力面板
（智能体菜单 → MCP 与技能）补上这一层：

* **可见**：面板列出内置 MCP 服务（名称 / 端口 / 地址）、Agent 在 `initialize`
  阶段声明的 MCP 能力（HTTP / stdio）、该服务暴露的 6 个工具，以及内置技能目录。
* **可切**：
  * *工具开关*立即生效。被关闭的工具会从 MCP 的 `tools/list` 中消失，直接调用
    也会被拒绝（`Tool X disabled`），智能体感知不到它的存在。
  * *技能开关*对技能目录立即生效（`list_studio_skills` 不再列出它，
    `get_studio_skill` 取不到），并在智能体下次连接时不再进入它的资源快照。
* **单一事实源**：工具名称、说明与简介集中在 `studio-tools.ts`，MCP 服务与面板
  共用同一份描述，避免两处漂移。
* **持久化**：开关写在 `~/.autumnflow/capabilities.json`（原子写入），重启后保留。

对应的接口是 `/api/universal/capabilities`（读取）与
`/api/universal/capabilities/tool|skill`（切换）。

---

## 六、 核心代码清单与模块映射

| 模块文件 | 核心职责 |
| :--- | :--- |
| [studio-skills.ts](file:///d:/project/js/Electron/antigravity-acp/server/universal/studio-skills.ts) | 负责技能目录动态解析、Frontmatter 元数据提取与按需文档读取。 |
| [studio-tools.ts](file:///d:/project/js/Electron/antigravity-acp/server/universal/studio-tools.ts) | 内置工具的名称 / 说明 / 简介单一事实源，MCP 服务与能力面板共用。 |
| [capability-registry.ts](file:///d:/project/js/Electron/antigravity-acp/server/universal/capability-registry.ts) | 工具与技能开关的持久化状态（原子写入 `capabilities.json`）。 |
| [mcp-ui-server.ts](file:///d:/project/js/Electron/antigravity-acp/server/universal/mcp-ui-server.ts) | 5 位数专用端口 MCP 服务，注册 `list_studio_skills` 与 `get_studio_skill` 等标准工具，并按开关实时隐藏工具。 |
| [CapabilityPanel.tsx](file:///d:/project/js/Electron/antigravity-acp/src/components/universal/CapabilityPanel.tsx) | 能力面板：工具与技能的清单、状态与开关。 |
| [AgentConnection.ts](file:///d:/project/js/Electron/antigravity-acp/server/universal/AgentConnection.ts) | ACP 会话控制器，在 `new/resume/load/fork` 统一注入环境，并在首轮下发鼓励性引导。 |
| [EditorialDiagramCard.tsx](file:///d:/project/js/Electron/antigravity-acp/src/components/assistant/EditorialDiagramCard.tsx) | 前端出版级矢量图表渲染引擎，自适应系统暗黑/明亮主题与 SVG 无损缩放。 |

---

## 六、 测试与质量门禁保障

全链路经由三重自动化测试矩阵验证：
1. **单元测试与工具调用**（[mcp-generative-ui.test.ts](file:///d:/project/js/Electron/antigravity-acp/tests/universal/mcp-generative-ui.test.ts)）：
   - 验证 5 位数端口自增绑定与 Streamable HTTP 协议握手；
   - 验证 `list_studio_skills` 与 `get_studio_skill` 工具在 MCP 协议下的调用与文档回传。
2. **端到端黑盒智能体集成测试**（[mcp-integration-mock-agent.test.ts](file:///d:/project/js/Electron/antigravity-acp/tests/universal/mcp-integration-mock-agent.test.ts)）：
   - 模拟离线标准 ACP Agent，验证 `session/new`、`session/resume`、`session/load` 中 `additionalDirectories` 与 `mcpServers` 的自动对称注入；
   - 验证首轮 Turn 0 的提示下发与后续 Turn 1 的免重复保障。
3. **前端交互与渲染 E2E 测试**（[generative-ui-e2e.test.tsx](file:///d:/project/js/Electron/antigravity-acp/tests/universal/generative-ui-e2e.test.tsx)）：
   - 验证矢量图表缩放、复制 SVG、以及沙箱组件的 DOM 渲染安全。
