/** Discovery guidance shared by MCP handshakes and ACP compatibility context. */
export const STUDIO_MCP_DISCOVERY_HINT = [
  "studio-ui 工具可能直接暴露，也可能由运行时放入延迟加载的工具目录。顶层工具列表没有这些名称，不代表 MCP 未连接或工具不可用。",
  "如果运行时提供 execute、search 或工具目录检索入口，先按该入口的说明检索 studio-ui、render_editorial_diagram、show_interactive_card 等名称，读取发现的真实路径与参数后调用。",
  "OpenCode 2 的 MCP 工具通常通过 execute 下的 tools[\"studio-ui\"] 命名空间调用；仍须先从运行时工具目录或 search 返回值确认准确签名，不要猜测。",
  "只有目录检索失败、权限拒绝或实际调用失败时，才说明具体限制；不要仅凭顶层列表没有独立 MCP 工具就断言没有注入。",
].join("\n");

export const STUDIO_MCP_INSTRUCTIONS = [
  "studio-ui provides AutumnFlow's interactive cards, diagrams, forms, sandboxes and design skills.",
  "Available tools: show_interactive_card, render_editorial_diagram, render_react_sandbox, prompt_form, list_studio_skills, get_studio_skill.",
  STUDIO_MCP_DISCOVERY_HINT,
  "Use list_studio_skills to discover skill names, then get_studio_skill({name}) to read the relevant design guidance. Discover the actual tool schemas before calling rendering tools.",
].join("\n");
