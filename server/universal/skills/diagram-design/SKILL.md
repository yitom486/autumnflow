---
name: diagram-design
title: 出版级矢量图表设计与生成规范 (Editorial Diagram Design)
description: 指导智能体在呈现系统架构、调用时序、业务状态机、技术选型四象限与里程碑时，调用 studio-ui 的 render_editorial_diagram 工具生成出版级高质量矢量图表。
---

# 出版级矢量图表设计指南 (Editorial Diagram Design)

## 核心设计哲学
1. **单一聚焦色 (1-Accent Principle)**:
   - 避免使用繁杂刺眼的彩虹配色。图表整体采用高雅的黑曜石深色或纯净纸面浅色底色；
   - 仅使用单一强调色（emerald, blue, indigo, violet, amber, rose, cyan）高亮核心路径、关键交互消息或焦点节点。
2. **严禁原始 Mermaid 纯文本**:
   - 原始 Mermaid（如 \`\`\`mermaid ...\`\`\`）在客户端中排版简陋生硬；
   - 强烈鼓励优先调用 \`render_editorial_diagram\` 生成现代矢量图表，自带缩放控制器、SVG 导出与深浅色自适应能力。

## 图表原型与调用数据结构

### 1. 架构拓扑图 (architecture)
- **适用场景**: 微服务调用拓扑、分层系统架构、云原生容器分布。
- **调用示例**:
\`\`\`json
{
  "title": "系统分层架构拓扑",
  "diagramType": "architecture",
  "accent": "emerald",
  "data": {
    "layers": [
      {
        "id": "gateway",
        "title": "接入网关层",
        "nodes": [
          { "id": "traefik", "label": "API Gateway", "subtext": "Port 443", "highlighted": true },
          { "id": "auth", "label": "Auth Proxy", "subtext": "OAuth 2.0" }
        ]
      },
      {
        "id": "services",
        "title": "核心服务层",
        "nodes": [
          { "id": "user", "label": "User Service", "subtext": "Node.js" },
          { "id": "payment", "label": "Payment Service", "subtext": "Go" }
        ]
      }
    ],
    "connections": [
      { "from": "gateway", "to": "services", "label": "gRPC / mTLS" }
    ]
  }
}
\`\`\`

### 2. 交互时序图 (sequence)
- **适用场景**: 鉴权认证握手、跨模块调用链路、异步事件通知。
- **调用示例**:
\`\`\`json
{
  "title": "OAuth 2.0 PKCE 认证时序",
  "diagramType": "sequence",
  "accent": "blue",
  "data": {
    "participants": [
      { "id": "client", "label": "Client App" },
      { "id": "auth", "label": "Auth Server" },
      { "id": "api", "label": "Resource API" }
    ],
    "messages": [
      { "from": "client", "to": "auth", "label": "1. GET /authorize (code_challenge)", "highlighted": true },
      { "from": "auth", "to": "client", "label": "2. Redirect 302 with code", "dashed": true },
      { "from": "client", "to": "auth", "label": "3. POST /token (code_verifier)" },
      { "from": "auth", "to": "client", "label": "4. 200 OK (access_token + JWT)", "dashed": true }
    ]
  }
}
\`\`\`

### 3. 流程与状态机 (flowchart)
- **适用场景**: 任务流水线执行、订单生命周期状态机、异常决策流。
- **调用示例**:
\`\`\`json
{
  "title": "构建与发布流水线状态流转",
  "diagramType": "flowchart",
  "accent": "indigo",
  "data": {
    "steps": [
      { "id": "lint", "label": "代码检查", "status": "completed" },
      { "id": "test", "label": "单元测试", "status": "completed" },
      { "id": "build", "label": "容器构建", "status": "active" },
      { "id": "deploy", "label": "金丝雀发布", "status": "pending" }
    ],
    "connections": [
      { "from": "lint", "to": "test" },
      { "from": "test", "to": "build" },
      { "from": "build", "to": "deploy" }
    ]
  }
}
\`\`\`

### 4. 四象限决策矩阵 (quadrant)
- **适用场景**: 技术选型评估 (ROI vs 复杂度)、功能优先级分配。
- **调用示例**:
\`\`\`json
{
  "title": "技术选型评估矩阵 (收益 vs 迁移成本)",
  "diagramType": "quadrant",
  "accent": "amber",
  "data": {
    "xAxis": { "left": "低迁移成本", "right": "高迁移成本" },
    "yAxis": { "bottom": "低业务收益", "top": "高业务收益" },
    "items": [
      { "label": "Vite 迁移", "x": 0.25, "y": 0.85, "quadrant": "top-left", "highlighted": true },
      { "label": "微前端重构", "x": 0.8, "y": 0.7, "quadrant": "top-right" },
      { "label": "旧依赖升级", "x": 0.3, "y": 0.3, "quadrant": "bottom-left" }
    ]
  }
}
\`\`\`

### 5. 演进里程碑时间线 (timeline)
- **适用场景**: 项目版本发布路线图、架构重构演进计划。
- **调用示例**:
\`\`\`json
{
  "title": "ACP Studio 演进里程碑",
  "diagramType": "timeline",
  "accent": "violet",
  "data": {
    "milestones": [
      { "period": "Phase 1", "title": "MCP 通信协议基础", "description": "统一 Streamable HTTP 端口", "status": "completed" },
      { "period": "Phase 2", "title": "出版级矢量图表", "description": "集成 diagram-design 矢量渲染器", "status": "completed" },
      { "period": "Phase 3", "title": "Studio Skills 按需检索", "description": "实现零环境污染跨 Agent 协议共享", "status": "active" }
    ]
  }
}
\`\`\`

## 交互式思维导图 (mindmap)

调用 render_editorial_diagram，diagramType 为 mindmap。data.root 使用递归树：

```json
{"root":{"label":"项目规划","children":[{"label":"界面层","children":[{"label":"表单交互"}]},{"label":"服务层"}]}}
```

节点可附带 description，children 非空的分支可点击折叠、展开；叶子只展示内容。
架构图支持按层折叠内部节点；流程图支持收起后续路径，其他分支仍能到达的汇合节点继续显示。
时序、四象限和时间线保留其语义，不把顺序或坐标数据错误解释为树形父子关系。
