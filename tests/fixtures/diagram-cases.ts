/** Deterministic agent outputs; exercised through ACP + the actual studio-ui MCP. */
export const editorialCases = [
  { kind: "mindmap", title: "E2E MCP 思维导图", labels: ["项目规划", "界面层", "表单交互", "字段校验", "服务层"], data: {
    root: { label: "项目规划", children: [
      { label: "界面层", children: [{ label: "表单交互", children: [{ label: "字段校验" }] }] },
      { label: "服务层", children: [{ label: "权限校验" }] },
    ] },
  } },
  { kind: "architecture", title: "E2E 分层架构", labels: ["入口网关", "业务服务", "数据库"], data: {
    layers: [
      { id: "edge", title: "入口层", nodes: [{ id: "gateway", label: "入口网关", highlighted: true }] },
      { id: "core", title: "服务层", nodes: [{ id: "service", label: "业务服务" }, { id: "db", label: "数据库" }] },
    ], connections: [{ from: "edge", to: "core", label: "请求路由", highlighted: true }],
  } },
  { kind: "sequence", title: "E2E 交互时序", labels: ["客户端", "服务端", "提交请求", "返回结果"], data: {
    participants: [{ id: "client", label: "客户端" }, { id: "server", label: "服务端" }],
    messages: [{ from: "client", to: "server", label: "提交请求" }, { from: "server", to: "client", label: "返回结果", dashed: true }],
  } },
  { kind: "flowchart", title: "E2E 分支流程", labels: ["接收订单", "验证支付", "安排发货", "取消订单"], data: {
    steps: [{ id: "start", label: "接收订单" }, { id: "verify", label: "验证支付", isCurrent: true },
      { id: "ship", label: "安排发货" }, { id: "cancel", label: "取消订单" }],
    connections: [{ from: "start", to: "verify" }, { from: "verify", to: "ship" }, { from: "verify", to: "cancel" }],
  } },
  { kind: "quadrant", title: "E2E 决策矩阵", labels: ["快速收益", "长期投入", "低成本", "高价值"], data: {
    xAxis: { low: "低成本", high: "高成本" }, yAxis: { low: "低价值", high: "高价值" },
    items: [{ label: "快速收益", quadrant: 2 }, { label: "长期投入", quadrant: 1 },
      { label: "候选计划", quadrant: 3 }, { label: "暂缓实施", quadrant: 4 }],
  } },
  { kind: "timeline", title: "E2E 演进时间线", labels: ["需求确认", "开发实现", "正式上线", "2026-10"], data: {
    milestones: [{ title: "需求确认", date: "2026-09", status: "completed" },
      { title: "开发实现", date: "2026-10", status: "in_progress" },
      { title: "正式上线", date: "2026-11", status: "planned" }],
  } },
] as const;

export const mermaidCases = [
  { kind: "flowchart", code: 'flowchart TD\n  A[接收请求] --> B{验证通过?}\n  B -->|是| C[执行任务]\n  B -->|否| D[返回错误]', labels: ["接收请求", "执行任务", "返回错误"] },
  { kind: "sequence", code: 'sequenceDiagram\n  participant C as 客户端\n  participant S as 服务端\n  C->>S: 提交请求\n  S-->>C: 返回结果', labels: ["客户端", "服务端", "返回结果"] },
  { kind: "state", code: 'stateDiagram-v2\n  [*] --> Pending\n  Pending --> Running: start\n  Running --> Complete: finish\n  Complete --> [*]', labels: ["Pending", "Running", "Complete"] },
] as const;

export const mindmapCode = `mindmap
  root((项目规划))
    ui[界面层]
      form[表单交互]
        validation[字段校验]
        feedback[提交反馈]
    server[服务层]
      auth[权限校验]`;

export const flowJoinCase = { kind: "flowchart", title: "E2E 汇合与循环流程", data: {
  nodes: [{ id: "start", label: "开始" }, { id: "left", label: "路径 A" }, { id: "right", label: "路径 B" },
    { id: "join", label: "共享汇合" }, { id: "loop", label: "循环处理" }],
  edges: [{ from: "start", to: "left" }, { from: "start", to: "right" }, { from: "left", to: "join" },
    { from: "right", to: "join" }, { from: "join", to: "loop" }, { from: "loop", to: "join" }],
} } as const;
