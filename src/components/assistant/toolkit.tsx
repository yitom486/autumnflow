import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import {
  DecisionCard,
  ChecklistCard,
  MetricsCard,
  PromptFormCard,
} from "./GenerativeCards";
import { ReactArtifactCard } from "./ReactArtifactCard";
import { Loader } from "@/components/motion/loader";
import { Skeleton } from "@/components/ui/skeleton";
import {
  EditorialDiagramCard,
  DiagramType,
  AccentColor,
} from "./EditorialDiagramCard";
import { HelpCircle, SlidersHorizontal, ListChecks, BarChart3 } from "lucide-react";
import type { GenerativeCardAction } from "@/lib/present-result";

export type { GenerativeCardAction };

/**
 * 现代 assistant-ui 生成式 UI 组件白名单注册表（符合 GenerativeUIComponentRegistry 规范）
 * 供 MessagePrimitive.GenerativeUI 或 MessagePrimitive.Parts components.GenerativeUI 使用
 * @see https://www.assistant-ui.com/docs/tools/generative-ui
 */
export const studioGenerativeUIComponents = {
  DecisionCard,
  ChecklistCard,
  MetricsCard,
  PromptFormCard,
  ReactArtifactCard,
  EditorialDiagramCard,
};

/**
 * 现代 @assistant-ui/react 规范的 ToolCall 渲染器字典
 * 替代已废弃的 makeAssistantToolUI，直接挂载到 MessagePrimitive.Parts 的 tools.by_name
 * @see https://www.assistant-ui.com/docs/migrations/toolkit-tools
 */
export const studioToolRenderers: Record<string, ToolCallMessagePartComponent> = {
  show_interactive_card: ({ args, addResult }: any) => {
    const { title = "交互卡片", description, data = {} } = args || {};
    const cardType = args?.cardType || args?.kind || "decision";

    if (cardType === "decision") {
      const options = Array.isArray(data.options) ? data.options : [];
      return (
        <DecisionCard
          title={title}
          description={description}
          options={options}
          onSelect={(choiceId) => {
            addResult?.({ status: "selected", choiceId });
          }}
        />
      );
    }

    if (cardType === "checklist") {
      const items = Array.isArray(data.items) ? data.items : [];
      return (
        <ChecklistCard
          title={title}
          description={description}
          items={items}
        />
      );
    }

    if (cardType === "metrics") {
      const metrics = Array.isArray(data.metrics) ? data.metrics : [];
      return (
        <MetricsCard
          title={title}
          description={description}
          metrics={metrics}
        />
      );
    }

    if (cardType === "form") {
      const fields = Array.isArray(data.fields) ? data.fields : [];
      return (
        <PromptFormCard
          title={title}
          description={description}
          fields={fields}
          onSubmit={(formValues) => {
            addResult?.({ status: "submitted", values: formValues });
          }}
        />
      );
    }

    return null;
  },

  render_react_sandbox: ({ args }: any) => {
    if (!args || !args.code) return null;
    return (
      <ReactArtifactCard
        code={args.code}
        template={args.template || "react"}
        title={args.title || "React 原型预览"}
        description={args.description}
      />
    );
  },

  prompt_form: ({ args, addResult }: any) => {
    const { title = "输入表单", description, submitLabel, fields = [] } = args || {};
    return (
      <PromptFormCard
        title={title}
        description={description}
        submitLabel={submitLabel}
        fields={fields}
        onSubmit={(formValues) => {
          addResult?.({ status: "submitted", values: formValues });
        }}
      />
    );
  },

  render_editorial_diagram: ({ args }: any) => {
    if (!args || !args.title) return null;
    return (
      <EditorialDiagramCard
        title={args.title}
        diagramType={inferDiagramType(args)}
        description={args.description}
        theme={args.theme || "system"}
        accent={args.accent || "emerald"}
        data={args.data || {}}
      />
    );
  },
};

/**
 * 兼容性保留导出，避免废弃注册带来的 runtime context 警告
 */
export const StudioGenerativeToolUIs: React.FC = () => null;

/**
 * 规范化生成式工具名：支持多种代理客户端的调用和命名格式，包括：
 * - "render_editorial_diagram"
 * - "studio-ui_render_editorial_diagram"
 * - "studio-ui.render_editorial_diagram"
 * - "studio-ui/render_editorial_diagram"
 * - "tools[\"studio-ui\"].render_editorial_diagram"
 * - "await tools[\"studio-ui\"].render_editorial_diagram({ ... })"
 */
export function normalizeGenerativeToolName(name?: string): string {
  if (!name || typeof name !== "string") return "";
  const str = name.trim();

  // 1. 优先使用非字母数字前界匹配 4 大原生生成式工具名
  //    真 agent (OpenCode / Claude) 常发 studio-ui__render_editorial_diagram，
  //    \b 跨不过下划线 _，因此用 (?:^|[^a-zA-Z0-9]) 覆盖前缀下划线、双下划线或表达式。
  const match = str.match(
    /(?:^|[^a-zA-Z0-9])(render_editorial_diagram|show_interactive_card|render_react_sandbox|prompt_form)\b/i
  );
  if (match) {
    return match[1].toLowerCase();
  }

  // 2. 剥离可能的代理调用前缀与参数括号
  let clean = str.toLowerCase();
  clean = clean.replace(/^.*tools\s*\[\s*["']?studio[-_]ui["']?\s*\]\.?/i, "");
  clean = clean.replace(/^(?:mcp__)?(?:tools?__)?studio[-_]ui[:_./]+/i, "");
  clean = clean.split(/[({\s]/)[0];

  // 3. 兼容 MCP 命名空间分隔（studio-ui__xxx / mcp__studio-ui__xxx）
  let namespaced = clean.replace(/^mcp__/i, "");
  if (namespaced.includes("__")) {
    const segs = namespaced.split("__").filter(Boolean);
    namespaced = segs.length > 0 ? segs[segs.length - 1] : namespaced;
  }
  namespaced = namespaced.replace(/^_+|_+$/g, "");
  if (namespaced && isGenerativeToolName(namespaced)) {
    return namespaced;
  }
  return clean;
}

/**
 * 脚本类候选（code/script）必须是真实的 studio-ui 调用上下文，
 * 否则注释/字符串里顺带一提工具名也会误判成卡片（从工具组消失 + 渲染空卡）。
 * 真调用形如 tools["studio-ui"].xxx( 或 studio-ui.xxx(。
 */
function hasStudioUiCallContext(code: string): boolean {
  return /tools\s*\[\s*["']?studio-ui/i.test(code) || /studio-ui\s*[._]\s*\w+\s*\(/i.test(code);
}

export function resolveGenerativeToolName(tcOrName: any): string {
  if (!tcOrName) return "";
  if (typeof tcOrName === "string") {
    const clean = normalizeGenerativeToolName(tcOrName);
    return isGenerativeToolName(clean) ? clean : "";
  }
  const rawCode = typeof tcOrName.rawInput?.code === "string" ? tcOrName.rawInput.code : undefined;
  const rawScript =
    typeof tcOrName.rawInput?.script === "string" ? tcOrName.rawInput.script : undefined;
  let input = tcOrName.rawInput;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { input = undefined; }
  }
  const candidates: unknown[] = [
    tcOrName.name,
    input?.ToolName,
    tcOrName.title,
    tcOrName.id,
    tcOrName.kind,
    tcOrName.rawOutput?.metadata?.toolCalls?.[0]?.tool,
    tcOrName.rawOutput?.tool,
    rawCode && hasStudioUiCallContext(rawCode) ? rawCode : undefined,
    rawScript && hasStudioUiCallContext(rawScript) ? rawScript : undefined,
    tcOrName.rawInput?.command,
    tcOrName.rawInput?.CommandLine,
    typeof tcOrName.rawInput === "string" ? tcOrName.rawInput : undefined,
    typeof tcOrName.rawOutput === "string" ? tcOrName.rawOutput : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string") {
      const clean = normalizeGenerativeToolName(c);
      if (isGenerativeToolName(clean)) return clean;
    }
  }
  return "";
}

export function isGenerativeTool(tcOrName: any): boolean {
  if (!tcOrName) return false;
  return Boolean(resolveGenerativeToolName(tcOrName));
}

function isGenerativeToolName(clean: string): boolean {
  return (
    clean === "show_interactive_card" ||
    clean === "render_editorial_diagram" ||
    clean === "render_react_sandbox" ||
    clean === "prompt_form"
  );
}

/**
 * 图表类型推断（纯函数，可测）：显式 diagramType 优先；缺失时按 data 形状推断，
 * 避免“一律 architecture”把流程图画错。兜底仍是 architecture（保持旧行为）。
 * 优先级：milestones → timeline；xAxis/yAxis → quadrant；participants/messages →
 * sequence；layers → architecture；steps/nodes → flowchart。
 */
export function inferDiagramType(args: Record<string, any> | null | undefined): DiagramType {
  const t = String(args?.diagramType || "").toLowerCase().trim();
  if (
    t === "architecture" ||
    t === "sequence" ||
    t === "flowchart" ||
    t === "quadrant" ||
    t === "timeline"
  ) {
    return t as DiagramType;
  }
  const raw = args as Record<string, any> | null | undefined;
  const d =
    raw && raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : raw || {};
  if (Array.isArray(d.milestones)) return "timeline";
  if (d.xAxis || d.yAxis) return "quadrant";
  if (Array.isArray(d.participants) || Array.isArray(d.messages)) return "sequence";
  if (Array.isArray(d.layers)) return "architecture";
  if (Array.isArray(d.steps) || Array.isArray(d.nodes)) return "flowchart";
  return "architecture";
}

/**
 * 安全解析 JSON 或 JS 对象字面量（例如 { title: "OAuth2", ... }）
 */
export function safeEvalObject(str: unknown): Record<string, any> | null {
  if (!str) return null;
  if (typeof str === "object") return str as Record<string, any>;
  if (typeof str !== "string") return null;

  const trimmed = str.trim();
  if (!trimmed) return null;

  // 1. 尝试直接 JSON.parse
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}

  // 2. 尝试解析 JS 对象字面量 (如无引号 key 的 { title: "..." })
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const fn = new Function(`"use strict"; return (${trimmed});`);
      const evaluated = fn();
      if (evaluated && typeof evaluated === "object") return evaluated;
    } catch {}
  }

  return null;
}

/**
 * 健壮提取生成式工具的入参与数据：
 * 依次扫描 rawInput、input、args、parameters、rawOutput.data、content 与 title 调用表达式
 */
export function extractToolArgs(tool: any): Record<string, any> {
  if (!tool) return {};

  const result: Record<string, any> = {};

  // 1. 扫描 OpenCode / MCP output metadata（OpenCode 执行 sandbox 返回的标准结构）
  const metaInput = tool.rawOutput?.metadata?.toolCalls?.[0]?.input;
  if (metaInput && typeof metaInput === "object") {
    Object.assign(result, metaInput);
  }
  const metaData = tool.rawOutput?.metadata?.toolCalls?.[0]?.data;
  if (metaData && typeof metaData === "object") {
    Object.assign(result, metaData);
  }

  // 2. 扫描入参字段（rawInput / input / args / arguments / parameters / params）
  const candidateInputs = [
    tool.rawInput,
    tool.input,
    tool.args,
    tool.arguments,
    tool.parameters,
    tool.params,
  ];
  for (const c of candidateInputs) {
    const parsed = safeEvalObject(c);
    if (parsed) {
      // agy exposes MCP calls through call_mcp_tool({ServerName, ToolName, Arguments}).
      // Arguments contains the presentation payload, not the outer routing object.
      const args = typeof parsed.ToolName === "string" ? safeEvalObject(parsed.Arguments) ?? parsed : parsed;
      for (const [k, v] of Object.entries(args)) {
        if (result[k] === undefined) result[k] = v;
      }
      break;
    }
  }

  // 3. 扫描出参字段（MCP Server 返回的 data: { title, diagramType, data... }）
  const candidateOutputs = [
    tool.rawOutput,
    tool.output,
    tool.result,
    tool.data,
  ];
  for (const o of candidateOutputs) {
    if (o && typeof o === "object") {
      if (o.structuredContent && typeof o.structuredContent === "object") {
        Object.assign(result, o.structuredContent);
      } else if (o.data && typeof o.data === "object") {
        Object.assign(result, o.data);
      } else if (!o.metadata) {
        Object.assign(result, o);
      }
      break;
    }
    const parsed = safeEvalObject(o);
    if (parsed) {
      if (parsed.data && typeof parsed.data === "object") {
        Object.assign(result, parsed.data);
      } else if (!parsed.metadata) {
        Object.assign(result, parsed);
      }
      break;
    }
  }

  // 4. 扫描 ACP content 数组
  if (Array.isArray(tool.content)) {
    for (const chunk of tool.content) {
      if (chunk?.type === "text" && typeof chunk.text === "string") {
        const parsed = safeEvalObject(chunk.text);
        if (parsed) Object.assign(result, parsed);
      } else if (chunk?.data && typeof chunk.data === "object") {
        Object.assign(result, chunk.data);
      }
    }
  }

  // 5. 从 title、name、code、script、command 中的函数调用语句提取实参
  // 例如：await tools["studio-ui"].render_editorial_diagram({ title: "OAuth2", ... })
  const callStrings = [
    tool.title,
    tool.name,
    tool.rawInput?.code,
    tool.rawInput?.script,
    tool.rawInput?.command,
    typeof tool.rawInput === "string" ? tool.rawInput : undefined,
  ];
  for (const strCandidate of callStrings) {
    if (typeof strCandidate === "string" && strCandidate.includes("(")) {
      const startIdx = strCandidate.indexOf("(");
      const endIdx = strCandidate.lastIndexOf(")");
      if (startIdx !== -1 && endIdx > startIdx) {
        const callArgsStr = strCandidate.slice(startIdx + 1, endIdx).trim();
        const parsed = safeEvalObject(callArgsStr);
        if (parsed) {
          // 不覆盖已有字段，作为初始补全
          for (const [k, v] of Object.entries(parsed)) {
            if (result[k] === undefined) {
              result[k] = v;
            }
          }
        }
      }
    }
  }

  return result;
}

export function parseToolArgs(rawInput: unknown): Record<string, any> {
  if (rawInput && typeof rawInput === "object") {
    return extractToolArgs({ rawInput });
  }
  return extractToolArgs({ rawInput });
}

const GenerativeSkeleton: React.FC<{
  title: string;
  hint: string;
  kind?: "diagram" | "card" | "form" | "sandbox";
}> = ({ title, hint, kind = "card" }) => {
  return (
    <div
      data-testid="generative-inline-placeholder"
      data-placeholder-kind={kind}
      className="my-3 rounded-xl border border-line bg-surface/80 p-4 select-none shadow-xs"
    >
      <div className="flex items-center gap-2.5 text-xs font-medium text-ink">
        <Loader variant="ascii-braille" size={14} className="text-primary font-bold shrink-0" />
        <span className="font-semibold">{title}</span>
        <span className="text-[11px] text-ink-3">({hint})</span>
      </div>
      {kind === "diagram" ? (
        <div className="mt-3.5 flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-background/50 p-3">
          <Skeleton className="h-10 w-1/4 rounded-md" />
          <div className="h-px flex-1 bg-border/80" />
          <Skeleton className="h-10 w-1/4 rounded-md" />
          <div className="h-px flex-1 bg-border/80" />
          <Skeleton className="h-10 w-1/4 rounded-md" />
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-3.5 w-2/3 rounded" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      )}
    </div>
  );
};


function hasDiagramContent(type: DiagramType, data: Record<string, any>): boolean {
  const keys = {
    architecture: ["layers"], sequence: ["messages", "steps"], flowchart: ["steps", "nodes"],
    quadrant: ["items"], timeline: ["milestones"],
  }[type];
  return keys.some(key => Array.isArray(data[key]) && data[key].length > 0);
}

/**
 * 独立直接渲染组件：脱离 assistant-ui 内部深层 tool context 依赖，
 * 直接从 ACP 消息的 toolCalls 渲染富交互卡片。
 */
export const AcpGenerativeToolCard: React.FC<{
  tool: any;
  onAction?: (action: GenerativeCardAction) => void | Promise<void>;
}> = ({ tool, onAction }) => {
  const normName = resolveGenerativeToolName(tool);
  const args = extractToolArgs(tool);
  const isPending = tool?.status === "pending" || tool?.status === "running" || tool?.status === "in_progress";

  if (normName && (tool?.status === "failed" || tool?.status === "cancelled")) {
    const detail = typeof tool.rawError === "string" ? tool.rawError : typeof tool.rawOutput === "string" ? tool.rawOutput : "";
    return <div role="status" className="my-3 rounded-lg border border-line p-4 text-sm text-ink-3">
      <p>工具调用未成功，未生成可展示的内容。</p>
      {detail && <p className="mt-2 whitespace-pre-wrap break-words">{detail.slice(0, 2000)}</p>}
    </div>;
  }

  if (normName === "show_interactive_card") {
    const title = args.title || "方案对比与决策";
    const cardType = args.cardType || args.kind || "decision";
    const description = args.description;

    // 健壮拆包：支持 data 为对象、数组、或嵌套 JSON 字符串
    let rawData = args.data !== undefined ? args.data : args;
    if (typeof rawData === "string") {
      rawData = safeEvalObject(rawData) ?? rawData;
    }
    const data: Record<string, any> =
      rawData && typeof rawData === "object" && !Array.isArray(rawData) ? rawData : {};

    if (cardType === "decision") {
      let candidateOptions: any[] = [];
      if (Array.isArray(rawData)) candidateOptions = rawData;
      else if (Array.isArray(data.options)) candidateOptions = data.options;
      else if (Array.isArray(data.choices)) candidateOptions = data.choices;
      else if (Array.isArray(data.items)) candidateOptions = data.items;
      else if (Array.isArray(data.solutions)) candidateOptions = data.solutions;
      else if (Array.isArray(data.plans)) candidateOptions = data.plans;
      else if (Array.isArray(data.candidates)) candidateOptions = data.candidates;
      else if (Array.isArray(args.options)) candidateOptions = args.options;
      else if (Array.isArray(args.choices)) candidateOptions = args.choices;
      else if (Array.isArray(args.items)) candidateOptions = args.items;

      const options = candidateOptions
        .map((opt, idx) => {
          if (!opt) return null;
          if (typeof opt === "string") {
            return { id: `opt-${idx + 1}`, label: opt };
          }
          if (typeof opt === "object") {
            const id = String(opt.id ?? opt.key ?? opt.value ?? `opt-${idx + 1}`);
            const label = String(opt.label ?? opt.title ?? opt.name ?? opt.text ?? id);
            const desc = opt.description ?? opt.desc ?? opt.detail ?? opt.summary;
            const badge = opt.badge ?? opt.tag;
            const recommended = Boolean(opt.recommended ?? opt.isRecommended ?? opt.is_recommended);
            return { id, label, description: desc, badge, recommended };
          }
          return null;
        })
        .filter(Boolean) as Array<{
          id: string;
          label: string;
          description?: string;
          badge?: string;
          recommended?: boolean;
        }>;

      if (options.length === 0 && isPending) {
        return <GenerativeSkeleton title={title} hint="正在生成方案决策卡片…" />;
      }
      if (options.length === 0) {
        return (
          <div className="my-2.5 rounded-xl border border-border bg-card/70 p-4 text-xs text-foreground max-w-xl">
            <div className="flex items-center gap-2 font-medium mb-1">
              <HelpCircle className="w-4 h-4 text-primary shrink-0" />
              <span>{title}</span>
            </div>
            {description && <p className="text-muted-foreground mb-2 leading-relaxed">{description}</p>}
            <p className="text-muted-foreground/70 italic text-[11px]">（智能体暂未下发具体的选项列表数据）</p>
          </div>
        );
      }
      return (
        <div className="my-2.5">
          <DecisionCard
            title={title}
            description={description}
            options={options}
            onSelect={async (choiceId, opt) => {
              await onAction?.({
                type: "decision",
                resultId: args.id || tool?.id,
                title,
                choiceId,
                choiceLabel: opt?.label,
                toolCallId: tool?.id,
              });
            }}
          />
        </div>
      );
    }
    if (cardType === "checklist") {
      let candidateItems: any[] = [];
      if (Array.isArray(rawData)) candidateItems = rawData;
      else if (Array.isArray(data.items)) candidateItems = data.items;
      else if (Array.isArray(data.tasks)) candidateItems = data.tasks;
      else if (Array.isArray(data.steps)) candidateItems = data.steps;
      else if (Array.isArray(data.checklist)) candidateItems = data.checklist;
      else if (Array.isArray(args.items)) candidateItems = args.items;

      const items = candidateItems
        .map((it, idx) => {
          if (!it) return null;
          if (typeof it === "string") return { id: `item-${idx + 1}`, title: it, checked: false };
          if (typeof it === "object") {
            const id = String(it.id ?? it.key ?? `item-${idx + 1}`);
            const itemTitle = String(it.title ?? it.label ?? it.name ?? it.text ?? id);
            return {
              id,
              title: itemTitle,
              description: it.description ?? it.desc,
              checked: Boolean(it.checked ?? it.completed ?? it.done),
              tag: it.tag ?? it.badge,
            };
          }
          return null;
        })
        .filter(Boolean) as Array<{
          id: string;
          title: string;
          description?: string;
          checked?: boolean;
          tag?: string;
        }>;

      if (items.length === 0 && isPending) {
        return <GenerativeSkeleton title={title} hint="正在生成检查清单…" />;
      }
      if (items.length === 0) {
        return (
          <div className="my-2.5 rounded-xl border border-border bg-card/70 p-4 text-xs text-foreground max-w-xl">
            <div className="flex items-center gap-2 font-medium mb-1">
              <ListChecks className="w-4 h-4 text-primary shrink-0" />
              <span>{title}</span>
            </div>
            {description && <p className="text-muted-foreground mb-2 leading-relaxed">{description}</p>}
            <p className="text-muted-foreground/70 italic text-[11px]">（暂无检查清单项）</p>
          </div>
        );
      }
      return (
        <div className="my-2.5">
          <ChecklistCard title={title} description={description} items={items} />
        </div>
      );
    }
    if (cardType === "metrics") {
      let candidateMetrics: any[] = [];
      if (Array.isArray(rawData)) candidateMetrics = rawData;
      else if (Array.isArray(data.metrics)) candidateMetrics = data.metrics;
      else if (Array.isArray(data.stats)) candidateMetrics = data.stats;
      else if (Array.isArray(data.items)) candidateMetrics = data.items;
      else if (Array.isArray(args.metrics)) candidateMetrics = args.metrics;

      const metrics = candidateMetrics
        .map((m, idx) => {
          if (!m || typeof m !== "object") return null;
          return {
            label: String(m.label ?? m.name ?? m.title ?? `指标 ${idx + 1}`),
            value: String(m.value ?? m.val ?? "--"),
            change: m.change ?? m.delta,
            status: m.status,
            description: m.description ?? m.desc,
          };
        })
        .filter(Boolean) as Array<{
          label: string;
          value: string;
          change?: string;
          status?: "good" | "bad" | "neutral";
          description?: string;
        }>;

      if (metrics.length === 0 && isPending) {
        return <GenerativeSkeleton title={title} hint="正在生成指标看板…" />;
      }
      if (metrics.length === 0) {
        return (
          <div className="my-2.5 rounded-xl border border-border bg-card/70 p-4 text-xs text-foreground max-w-xl">
            <div className="flex items-center gap-2 font-medium mb-1">
              <BarChart3 className="w-4 h-4 text-primary shrink-0" />
              <span>{title}</span>
            </div>
            {description && <p className="text-muted-foreground mb-2 leading-relaxed">{description}</p>}
            <p className="text-muted-foreground/70 italic text-[11px]">（暂无统计指标数据）</p>
          </div>
        );
      }
      return (
        <div className="my-2.5">
          <MetricsCard title={title} description={description} metrics={metrics} />
        </div>
      );
    }
    if (cardType === "form") {
      let candidateFields: any[] = [];
      if (Array.isArray(rawData)) candidateFields = rawData;
      else if (Array.isArray(data.fields)) candidateFields = data.fields;
      else if (Array.isArray(data.inputs)) candidateFields = data.inputs;
      else if (Array.isArray(data.items)) candidateFields = data.items;
      else if (Array.isArray(data.questions)) candidateFields = data.questions;
      else if (Array.isArray(args.fields)) candidateFields = args.fields;
      else if (Array.isArray(args.inputs)) candidateFields = args.inputs;

      const fields = candidateFields
        .map((f, idx) => {
          if (!f) return null;
          if (typeof f === "string") {
            return { id: `field-${idx + 1}`, label: f, type: "text" };
          }
          if (typeof f === "object") {
            const id = String(f.id ?? f.name ?? f.key ?? `field-${idx + 1}`);
            const label = String(f.label ?? f.title ?? f.name ?? id);
            return {
              id,
              label,
              type: f.type || "text",
              placeholder: f.placeholder,
              options: Array.isArray(f.options) ? f.options.map(String) : undefined,
              defaultValue: f.defaultValue ?? f.default,
              required: Boolean(f.required),
            };
          }
          return null;
        })
        .filter(Boolean) as Array<{
          id: string;
          label: string;
          type?: string;
          placeholder?: string;
          options?: string[];
          defaultValue?: any;
          required?: boolean;
        }>;

      if (fields.length === 0 && isPending) {
        return <GenerativeSkeleton title={title} hint="正在构建交互表单…" />;
      }
      if (fields.length === 0) {
        return (
          <div className="my-2.5 rounded-xl border border-border bg-card/70 p-4 text-xs text-foreground max-w-xl">
            <div className="flex items-center gap-2 font-medium mb-1">
              <SlidersHorizontal className="w-4 h-4 text-primary shrink-0" />
              <span>{title}</span>
            </div>
            {description && <p className="text-muted-foreground mb-2 leading-relaxed">{description}</p>}
            <p className="text-muted-foreground/70 italic text-[11px]">（智能体暂未提供表单字段定义）</p>
          </div>
        );
      }
      return (
        <div className="my-2.5">
          <PromptFormCard
            title={title}
            description={description}
            fields={fields}
            onSubmit={async (formValues) => {
              await onAction?.({
                type: "form",
                resultId: args.id || tool?.id,
                title,
                values: formValues,
                toolCallId: tool?.id,
              });
            }}
          />
        </div>
      );
    }
  }

  if (normName === "render_editorial_diagram") {
    const title = args.title || "系统流程架构";
    const diagramType = inferDiagramType(args);
    const data =
      args.data && typeof args.data === "object" && Object.keys(args.data).length > 0
        ? args.data
        : args;

    if (!hasDiagramContent(diagramType, data) && isPending) {
      return <GenerativeSkeleton title="架构时序图表" hint="正在生成出版级矢量图表…" kind="diagram" />;
    }
    if (!hasDiagramContent(diagramType, data)) {
      return <div role="status" className="my-3 rounded-lg border border-line p-4 text-sm text-ink-3">图表数据缺失或格式不受支持，无法绘制。请检查工具参数与返回结果后重试。</div>;
    }

    return (
      <div className="my-3">
        <EditorialDiagramCard
          title={title}
          diagramType={diagramType}
          description={args.description}
          theme={args.theme || "system"}
          accent={args.accent || "emerald"}
          data={data}
        />
      </div>
    );
  }

  if (normName === "render_react_sandbox") {
    if (!args.code) {
      if (isPending) return <GenerativeSkeleton title={args.title || "动态组件原型"} hint="正在加载沙箱组件…" kind="sandbox" />;
      return null;
    }
    return (
      <div className="my-3">
        <ReactArtifactCard
          code={args.code}
          template={args.template || "react"}
          title={args.title || "动态组件原型"}
          description={args.description}
        />
      </div>
    );
  }

  if (normName === "prompt_form") {
    let rawFields = args.fields ?? args.data?.fields ?? args.data;
    if (typeof rawFields === "string") {
      rawFields = safeEvalObject(rawFields) ?? rawFields;
    }
    let candidateFields: any[] = [];
    if (Array.isArray(rawFields)) candidateFields = rawFields;
    else if (rawFields && typeof rawFields === "object") {
      candidateFields = Array.isArray(rawFields.fields)
        ? rawFields.fields
        : Array.isArray(rawFields.inputs)
          ? rawFields.inputs
          : Array.isArray(rawFields.items)
            ? rawFields.items
            : [];
    }

    const fields = candidateFields
      .map((f, idx) => {
        if (!f) return null;
        if (typeof f === "string") {
          return { id: `field-${idx + 1}`, label: f, type: "text" };
        }
        if (typeof f === "object") {
          const id = String(f.id ?? f.name ?? f.key ?? `field-${idx + 1}`);
          const label = String(f.label ?? f.title ?? f.name ?? id);
          return {
            id,
            label,
            type: f.type || "text",
            placeholder: f.placeholder,
            options: Array.isArray(f.options) ? f.options.map(String) : undefined,
            defaultValue: f.defaultValue ?? f.default,
            required: Boolean(f.required),
          };
        }
        return null;
      })
      .filter(Boolean) as Array<{
        id: string;
        label: string;
        type?: string;
        placeholder?: string;
        options?: string[];
        defaultValue?: any;
        required?: boolean;
      }>;

    if (fields.length === 0 && isPending) {
      return <GenerativeSkeleton title={args.title || "配置填报"} hint="正在准备人机表单…" kind="form" />;
    }
    if (fields.length === 0) {
      return (
        <div className="my-2.5 rounded-xl border border-border bg-card/70 p-4 text-xs text-foreground max-w-xl">
          <div className="flex items-center gap-2 font-medium mb-1">
            <SlidersHorizontal className="w-4 h-4 text-primary shrink-0" />
            <span>{args.title || "配置填报"}</span>
          </div>
          {args.description && <p className="text-muted-foreground mb-2 leading-relaxed">{args.description}</p>}
          <p className="text-muted-foreground/70 italic text-[11px]">（智能体暂未提供表单字段定义）</p>
        </div>
      );
    }
    return (
      <div className="my-2.5">
        <PromptFormCard
          title={args.title || "配置填报"}
          description={args.description}
          submitLabel={args.submitLabel}
          fields={fields}
          onSubmit={async (formValues) => {
            await onAction?.({
              type: "form",
              resultId: args.id || tool?.id,
              title: args.title || "配置填报",
              values: formValues,
              toolCallId: tool?.id,
            });
          }}
        />
      </div>
    );
  }

  return null;
};

export interface InterleavedTextSegment {
  type: "text";
  text: string;
}

export interface InterleavedToolSegment {
  type: "generative-tool";
  toolCallId: string;
  tool: any;
}

export type InterleavedContentSegment = InterleavedTextSegment | InterleavedToolSegment;

const GENERATIVE_PLACEHOLDER_REGEX = /<!--acp-tool:([^>]+)-->|::acp-tool\[([^\]]+)\]::/g;

export function makeGenerativeToolPlaceholder(toolCallId: string): string {
  return `<!--acp-tool:${toolCallId}-->`;
}

export function hasGenerativeToolPlaceholder(text: string | undefined, toolCallId?: string): boolean {
  if (!text) return false;
  if (!toolCallId) {
    return /<!--acp-tool:[^>]+-->|::acp-tool\[[^\]]+\]::/.test(text);
  }
  return text.includes(`<!--acp-tool:${toolCallId}-->`) || text.includes(`::acp-tool[${toolCallId}]::`);
}

export function appendGenerativeToolPlaceholder(text: string | undefined, toolCallId: string): string {
  const base = text ?? "";
  if (!toolCallId || hasGenerativeToolPlaceholder(base, toolCallId)) return base;
  const marker = makeGenerativeToolPlaceholder(toolCallId);
  if (!base.trim()) return `${marker}\n\n`;
  const sep = base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n";
  return `${base}${sep}${marker}\n\n`;
}

export function stripGenerativeToolPlaceholders(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/<!--acp-tool:[^>]+-->|::acp-tool\[[^\]]+\]::/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 将正文（含内联 `<!--acp-tool:ID-->` 占位符）与生成式工具卡片按流式出现顺序拆分为交错序列。
 * - 若正文内存在占位符，卡片精确挂载在对应段落之间；
 * - 若存在未匹配占位符的生成式工具（例如历史持久化消息或直接构造的测试消息），自动保序挂载在开头，保证 100% 向后兼容。
 */
export function splitInterleavedGenerativeContent(
  text: string | undefined,
  generativeTools: any[] | undefined
): InterleavedContentSegment[] {
  const tools = Array.isArray(generativeTools) ? generativeTools.filter((tc) => isGenerativeTool(tc)) : [];
  const rawText = text ?? "";

  if (tools.length === 0) {
    const cleaned = stripGenerativeToolPlaceholders(rawText);
    return cleaned ? [{ type: "text", text: cleaned }] : [];
  }

  const toolByKey = new Map<string, any>();
  for (const tc of tools) {
    if (tc?.id) toolByKey.set(String(tc.id), tc);
    const args = extractToolArgs(tc);
    if (args?.id) toolByKey.set(String(args.id), tc);
  }

  const placedToolIds = new Set<string>();
  const bodySegments: InterleavedContentSegment[] = [];
  let lastIndex = 0;

  GENERATIVE_PLACEHOLDER_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GENERATIVE_PLACEHOLDER_REGEX.exec(rawText)) !== null) {
    const before = rawText.slice(lastIndex, match.index).trim();
    if (before) {
      bodySegments.push({ type: "text", text: before });
    }
    const rawKey = (match[1] || match[2] || "").trim();
    const matchedTool = toolByKey.get(rawKey);
    if (matchedTool) {
      const canonicalId = String(matchedTool.id || rawKey);
      if (!placedToolIds.has(canonicalId)) {
        placedToolIds.add(canonicalId);
        bodySegments.push({
          type: "generative-tool",
          toolCallId: canonicalId,
          tool: matchedTool,
        });
      }
    }
    lastIndex = match.index + match[0].length;
  }

  const tail = rawText.slice(lastIndex).trim();
  if (tail) {
    bodySegments.push({ type: "text", text: tail });
  }

  const unplacedSegments: InterleavedToolSegment[] = [];
  for (const tc of tools) {
    const canonicalId = String(tc?.id || "");
    if (!placedToolIds.has(canonicalId)) {
      placedToolIds.add(canonicalId);
      unplacedSegments.push({
        type: "generative-tool",
        toolCallId: canonicalId,
        tool: tc,
      });
    }
  }

  return [...unplacedSegments, ...bodySegments];
}


