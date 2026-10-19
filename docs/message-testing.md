# AutumnFlow 消息流与测试规范文档 (Message Testing & Protocol Guide)

本文档定义了 **AutumnFlow** 内部的消息流转机制、核心数据模型、SSE 事件载荷规范，以及用于调试与自动化测试的标准用例。

---

## 1. 消息流转全链路架构 (Architecture)

在 AutumnFlow 中，消息在以下三层之间进行流式传递与转换：

```text
┌────────────────────────┐         SSE (Server-Sent Events)        ┌────────────────────────┐
│  ACP Agent (agy/codex) │ ──[JSON-RPC 2.0 / stdio]──> 后端网关 ──> │ Web / Electron 前端   │
│  session/update 帧广播  │                                        │ 写入 Zustand 消息状态  │
└────────────────────────┘                                         └────────────────────────┘
```

1. **协议层 (ACP)**：Agent 产生 `session/update` 通知（包含文字块、思考流、工具调用状态等）。
2. **网关层 (Hono / SSE)**：后端网关将 ACP 原始通知转为标准的 SSE 事件，推送到前端连接。
3. **视图层 (React / Zustand)**：前端通过 `sse-client.ts` 捕获分块，按 `messageId` 对局部状态进行精准 Patch，避免整树重绘。

---

## 2. 核心消息数据结构 (Data Models)

前端所持有的统一消息模型定义（详见 `src/lib/message-types.ts`）：

```typescript
export interface Message {
  id: string;                      // 唯一消息 ID
  role: "user" | "agent" | "system"; // 发送方角色
  text: string;                    // 正文内容（支持 Markdown & 代码高亮）
  thought?: string;               // 深度推理/思考链内容（独立折叠卡片展示）
  thoughtStreaming?: boolean;      // 思考流是否正在生成中
  streaming?: boolean;             // 正文内容是否正在推流中
  timestamp?: string;              // 消息时间戳 (HH:mm)
  toolCalls?: ToolCall[];          // 工具调用状态列表
  attachments?: Attachment[];      // 附件列表（图片、文本资源、文件链接）
}

export interface ToolCall {
  id: string;                      // 工具调用 ID
  name: string;                    // 工具名称（例如: run_command, view_file）
  args?: Record<string, any>;      // 输入参数
  status: "in_progress" | "completed" | "failed"; // 状态机
  output?: string;                 // 工具执行输出结果
}
```

---

## 3. 标准测试用例与模拟载荷 (Mock Payloads)

### 用例 1：标准文本流式回复 (Plain Text Streaming)

**模拟场景**：大模型逐步吐字回复。

```json
// SSE 帧 1: 建立会话
data: {"type":"session_info","sessionId":"sess_test_001"}

// SSE 帧 2: 文字块追加
data: {"type":"agent_text_chunk","delta":"你好！我是 "}

// SSE 帧 3: 文字块追加
data: {"type":"agent_text_chunk","delta":"AutumnFlow 智能助手。"}

// SSE 帧 4: 结束推流
data: {"type":"done"}
```

---

### 用例 2：深度推理与思考流抽取 (Thinking Chunks)

**模拟场景**：Gemini 3.8 / Pro 等具备思维链的模型，先输出思考流，再输出最终解答。

```json
// SSE 帧 1: 思考流开始与推流
data: {"type":"agent_thought_chunk","delta":"用户询问了项目结构。\n需要检查根目录与包配置文件..."}

// SSE 帧 2: 思考流追加
data: {"type":"agent_thought_chunk","delta":"\n已确认包含 server 与 src 目录。准备生成回答。"}

// SSE 帧 3: 思考结束，正文输出
data: {"type":"agent_text_chunk","delta":"根据架构分析，本项目由后端 Hono 网关与前端 React 组成。"}

// SSE 帧 4: 完成
data: {"type":"done"}
```

---

### 用例 3：工具调用生命周期 (Tool Call Lifecycle)

**模拟场景**：Agent 调用命令执行或文件读取工具。

```json
// 1. 工具调用被触发 (进行中状态)
data: {
  "type": "tool_call",
  "toolCallId": "call_exec_101",
  "name": "run_command",
  "arguments": {
    "command": "git status --short"
  },
  "status": "in_progress"
}

// 2. 工具执行完成并返回结果
data: {
  "type": "tool_call_update",
  "toolCallId": "call_exec_101",
  "status": "completed",
  "output": " M package.json\n?? docs/message-testing.md"
}

// 3. 基于工具结果的最终解释
data: {
  "type": "agent_text_chunk",
  "delta":"检测到有未提交的文件修改。"
}
```

---

## 4. 本地测试与验证方法 (How to Verify)

### 1. 运行自动化集成测试套件
项目内部已具备完善的离线仿真测试，无需连接真实云端即可验证消息管道：
```bash
bun run test
```
该命令会触发 `vitest`，运行 `tests/client/` 与 `tests/integration/` 下关于 SSE 解析、状态自愈与多轮消息流的测试用例。

### 2. 通过 cURL 手动发起测试请求
当本地服务启动后（`bun run dev`），可直接通过终端向网关投递测试消息：
```bash
curl -N -X POST http://localhost:3004/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"你好，请做个自我介绍\",\"model\":\"gemini-3.8-flash-high\"}"
```
终端将实时输出上述规范格式的 SSE 数据流。
