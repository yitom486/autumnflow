# ACP 测试与 Mock 黑盒集成测试规范

所有在本项目中新增的功能、重构或协议变更，必须严格遵守**测试双轨制原则**：除了大量细粒度的单元测试（Unit Tests）之外，**必须包含基于 Mock 的全链路黑盒集成测试（Mock Black-box Integration Tests）**。

---

## 一、为什么必须坚持 Mock 黑盒集成测试

1. **守护全链路连通性**：
   - ACP（Agent Client Protocol）通过 stdio 的 NDJSON JSON-RPC 与子进程通信，并通过网关转换为 SSE（Server-Sent Events）推送至前端客户端。
   - 单元测试模拟单个函数无法发现跨进程 stdio 流断裂、并发争用（如 React StrictMode 双重挂载导致的 SIGTERM 互杀）、协议字段类型校验错误（如 ToolCallContent 嵌套结构）、生命周期信号等系统级问题。
2. **零成本与完全离线确定性**：
   - 严禁在自动化集成测试中硬编码或依赖外部云端大模型 API（避免网络波动、密钥泄露、API 欠费及不确定性）。
   - 使用可控的官方 ACP SDK Mock 子进程（`tests/fixtures/mock-acp-agent.ts`）在本地模拟真实 Agent 进程，测试速度在毫秒级完成，且 100% 可复现。

---

## 二、双轨测试覆盖矩阵

### 1. 单元测试（Unit Tests）
- 位于 `tests/universal/` 与 `tests/proxy/`。
- 覆盖：
  - 各纯函数、解析器（如 `parseModelId`、`configCurrentValue`）。
  - 前端 Zustand 状态管理（`store.test.ts`）。
  - 错误码映射与分类（`error-codes.test.ts`）。
  - Git 工作区路由与边界条件（`git-routes.test.ts`）。
  - 动效与错误总线边界（`ui-motion.test.ts`）。

### 2. Mock 黑盒集成测试（Mock Black-box Tests）
- 标准测试套件：`tests/universal/mock-blackbox-pipeline.test.ts`。
- 必须验证以下完整链路：
  1. **并发连接防重入（Thundering Herd Protection）**：
     - 同时发起多个并发 `POST /connect` 请求，验证网关具备在途锁（In-flight Mutex），保证只启动一个稳定进程，绝对不能互发 SIGTERM 或返回 `null` 错误。
  2. **思考流（Thought Stream）**：
     - 模拟 Agent 输出 `agent_thought_chunk`，验证能够通过网关 SSE 顺利被前端消费。
  3. **文本流与多模态（Text & Image Stream）**：
     - 验证发送包含文本与 `image/png` base64 数据的多模态 prompt 时，Agent 与网关能够正确解析并流式返回消息块 `agent_message_chunk`。
  4. **工具调用生命周期（Tool Call Lifecycle）**：
     - 验证 `tool_call`（从 pending 开始）到 `tool_call_update`（completed 且携带标准 ContentBlock 格式）的完整数据包流转。
  5. **任务规划与用量统计（Plan & Usage）**：
     - 验证 `plan`（带 `priority` 与 `status`）及 `usage_update`（Token/字符数消耗）能正常下发。
  6. **客户端交互能力（Permissions & Elicitations）**：
     - 验证 Agent 向客户端发起的敏感操作权限请求（`session/request_permission`）能够触发网关事件，并通过 `/api/universal/permission/respond` 成功解开并在 Agent 侧得到响应。
     - 验证用户参数收集（`elicitation/create`）能够被收集并响应。
  7. **优雅取消（Session Cancel）**：
     - 验证当用户调用 `session/cancel` 时，正在进行的 prompt turn 能够优雅终止且进程保持健康，不崩溃退出。

---

## 三、Mock Agent 编写规范

- Mock Agent 位于 `tests/fixtures/mock-acp-agent.ts`。
- 必须基于官方 `@agentclientprotocol/sdk` 标准标准编写，严格遵守 ACP v1 协议规范。
- 必须调用 `process.stdin.resume()` 维持事件循环，并在 `process.stdin.on("end")` 时退出。
- 输出给客户端的通知应根据接收到的 prompt 关键触发词动态调整，保持测试场景解耦。

---

## 五、禁止过度测试与过度工程化

测试的目的是**锁住真实风险**，不是堆数量。以下情况一律禁止：

1. **同一条行为写多个断言**：一个用例只锁一个行为。同一逻辑换了措辞再写一遍不算覆盖。
2. **为实现细节写测试**：断言私有函数名、内部状态字段、DOM 结构这类重构就会碎的细节。断言**用户可观察的结果**。
3. **一条路径铺三层测试**：纯函数 → hook → 组件 → e2e 四层重复测同一条逻辑时，只保留**最容易失败的那一层**（通常是最外层），其余删掉。
4. **为覆盖率而测**：没有对应真实缺陷场景的用例是负债，不是资产。
5. **一次性脚本**：排查用的临时 `.mjs` / `.py` 脚本不允许留在仓库里，结论落地成正式测试或直接删除。
6. **无界回退**：加一层抽象来解决"以后可能会用到"的问题，就是过度工程。抽象必须由**当前第二个真实调用点**驱动。

对应的要求：

- 新增一个功能时，先问「**它最可能怎么坏**」，只针对这个写测试。
- 修一个 bug 时，**必须**留一个能复现该 bug 的用例（这是测试的最低门槛）。
- 已有用例失败时，先判断是**实现错了**还是**用例写错了**，不要顺手加新用例去绕过。
- 跑验证时按需选择：改前端跑前端单测，改协议跑黑盒集成，改桌面壳才跑 e2e。**不要每次都跑全量。**

---

## 六、提交流程与验收门禁

任何功能合并前，必须本地执行并全部通过：
1. **类型检查**：
   ```bash
   bunx tsc --noEmit
   ```
2. **完整自动化测试**：
   ```bash
   bun run test
   ```
   测试结果必须为 0 失败、全量通过。
