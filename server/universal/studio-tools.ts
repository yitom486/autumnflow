/**
 * The studio-ui MCP tool catalogue.
 *
 * Single source of truth for the tool names, the MCP descriptions and the
 * short labels shown in the capabilities panel. The MCP server registers the
 * tools from this list, and the HTTP layer reports the same list, so the UI
 * can never drift from what the agent actually sees.
 */

export interface StudioToolDescriptor {
  /** MCP tool name, as the agent calls it. */
  name: string;
  /** Short human label for the UI. */
  title: string;
  /** One-line summary of what the tool is for. */
  summary: string;
  /** The full description handed to the agent through tools/list. */
  description: string;
}

export const STUDIO_UI_TOOLS: StudioToolDescriptor[] = [
  {
    name: "show_interactive_card",
    title: "富交互卡片",
    summary: "决策 / 清单 / 指标 / 表单四类结构化卡片",
    description:
      "【富交互卡片 - 推荐】当向用户提供方案对比与决策(decision)、任务排查或门禁核对清单(checklist)、系统核心性能或监控指标看板(metrics)或配置填报(form)时，鼓励优先调用本工具直接渲染富交互卡片，呈现清晰直观的结构化视觉交互。",
  },
  {
    name: "render_editorial_diagram",
    title: "出版级图表",
    summary: "架构 / 时序 / 流程 / 四象限 / 里程碑矢量图",
    description:
      "【出版级高阶图表 - 推荐】当需要向用户展示系统架构拓扑、调用交互时序、流程业务状态机、技术选型四象限或项目演进里程碑时，强烈鼓励优先调用此工具直接生成出版级矢量图表，代替原始简陋的 Mermaid 文本或生硬描述，带来卓越的视觉阅读体验。",
  },
  {
    name: "render_react_sandbox",
    title: "组件沙箱",
    summary: "React / HTML 交互原型隔离预览",
    description:
      "【动态组件沙箱原型】当设计或展示前端交互式 UI 组件、动态原型、仪表盘或交互小工具时，鼓励调用本工具渲染包含实时状态与响应式的隔离预览沙箱。",
  },
  {
    name: "prompt_form",
    title: "交互表单",
    summary: "在会话中收集结构化用户输入",
    description:
      "【人机协同交互表单】当需要用户提供多个参数配置、数据库凭据、多项筛选条件或填写表单时，推荐调用本工具在聊天流下发表单控件收集用户输入并等待用户填写提交。",
  },
  {
    name: "list_studio_skills",
    title: "技能清单",
    summary: "列出内置技能与设计规范",
    description:
      "【Studio 技能清单】列出当前 AutumnFlow 客户端内置提供的专业能力与设计规范清单（例如 diagram-design 出版级矢量图表设计、generative-ui 生成式交互卡片规范）。",
  },
  {
    name: "get_studio_skill",
    title: "技能正文",
    summary: "按需读取指定技能的完整指导",
    description:
      "【Studio 技能按需调取】按需获取特定 Studio 技能的完整指导文档、设计原则与结构化调用示例（如 diagram-design 或 generative-ui）。零 Token 浪费，仅在需要时按需查阅。",
  },
];

const BY_NAME = new Map(STUDIO_UI_TOOLS.map((tool) => [tool.name, tool]));

export function getStudioToolDescriptor(name: string): StudioToolDescriptor | undefined {
  return BY_NAME.get(name);
}

export const STUDIO_UI_TOOL_NAMES = STUDIO_UI_TOOLS.map((tool) => tool.name);
