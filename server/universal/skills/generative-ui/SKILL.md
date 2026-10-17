---
name: generative-ui
title: 生成式富交互卡片与沙箱规范 (Generative UI Guidelines)
description: 指导智能体在提供方案对比、任务排查、指标监控、人机协同表单以及前端原型演示时，调用 studio-ui 的生成式 UI 工具进行高质量交互呈现。
---

# 生成式富交互卡片与沙箱规范 (Generative UI Guidelines)

## 核心目标
将传统冗长枯燥的纯 Markdown 文本，转化为直观、可交互、可操作的结构化前端卡片。

## 可用工具与推荐场景

### 1. 结构化卡片 `show_interactive_card`
- **cardType = "decision"**: 架构方案对比、操作授权选择，给出具体选项与推荐方案；
  - `data: { options: [{ id: "opt1", label: "方案A / 批准执行", description: "说明", recommended: true, badge: "推荐" }] }`
- **cardType = "checklist"**: 故障排查清单、发布前安全门禁，提供可勾选状态；
  - `data: { items: [{ id: "t1", title: "安全检查", checked: false, description: "详情" }] }`
- **cardType = "metrics"**: 关键系统指标、性能延迟看板；
  - `data: { metrics: [{ label: "延时 P99", value: "28ms", change: "-12%", status: "good" }] }`
- **cardType = "form"**: 轻量级表单展示；
  - `data: { fields: [{ id: "target", label: "目标路径", type: "text", placeholder: "/app/release" }] }`

### 2. 人机协同交互表单 `prompt_form`
- **适用场景**: 当智能体需要用户输入数据库凭证、多字段配置、或在多选参数中做确认时；
- **规范入参**:
  - `fields: [{ id: "db_host", label: "数据库地址", type: "text", required: true }, { id: "env", label: "环境", type: "select", options: ["dev", "prod"] }]`
- 避免让用户在输入框打字回复多个字段，直接下发交互式表单让用户在聊天界面内填写并一键提交。

### 3. 动态组件沙箱 `render_react_sandbox`
- **适用场景**: 设计或演示交互式前端组件（如计数器、动态仪表盘、数据表格等）；
- 内置 React 运行时和 Tailwind CSS，自动在 iframe 安全沙箱中渲染可实时点击的组件。
