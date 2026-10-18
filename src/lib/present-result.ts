/**
 * Universal Presentation Result Protocol (PresentResult Contract)
 *
 * Defines versioned, strictly typed schemas and deterministic validation
 * for all Generative UI artifacts (cards, forms, diagrams, sandboxes).
 */

export const PRESENT_SCHEMA_VERSION = 1;
export const PRESENT_MAX_TITLE_CHARS = 160;
export const PRESENT_MAX_TEXT_CHARS = 4000;
export const PRESENT_MAX_BYTES = 512 * 1024; // 512 KiB envelope cap

export type PresentResultKind =
  | "decision"
  | "checklist"
  | "metrics"
  | "form"
  | "diagram"
  | "react-artifact";

export interface PresentResultBase {
  schemaVersion: 1;
  id: string;
  title: string;
  description?: string;
  summary?: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
  badge?: string;
  recommended?: boolean;
}

export interface PresentDecision extends PresentResultBase {
  kind: "decision";
  options: DecisionOption[];
}

export interface ChecklistItem {
  id: string;
  label: string;
  checked?: boolean;
  description?: string;
}

export interface PresentChecklist extends PresentResultBase {
  kind: "checklist";
  items: ChecklistItem[];
}

export interface MetricItem {
  label: string;
  value: string | number;
  delta?: string;
  unit?: string;
  trend?: "up" | "down" | "neutral";
  progress?: number;
}

export interface PresentMetrics extends PresentResultBase {
  kind: "metrics";
  metrics: MetricItem[];
}

export interface FormField {
  id: string;
  label: string;
  type: "text" | "number" | "select" | "checkbox" | "textarea";
  placeholder?: string;
  options?: string[];
  defaultValue?: unknown;
  required?: boolean;
}

export interface PresentForm extends PresentResultBase {
  kind: "form";
  submitLabel?: string;
  fields: FormField[];
}

export type DiagramType =
  | "mindmap"
  | "architecture"
  | "sequence"
  | "flowchart"
  | "quadrant"
  | "timeline";

export type AccentColor =
  | "emerald"
  | "blue"
  | "indigo"
  | "violet"
  | "amber"
  | "rose"
  | "cyan";

export interface PresentDiagram extends PresentResultBase {
  kind: "diagram";
  diagramType: DiagramType;
  theme?: "light" | "dark" | "system";
  accent?: AccentColor;
  data: Record<string, any>;
}

export interface PresentReactArtifact extends PresentResultBase {
  kind: "react-artifact";
  code: string;
  template?: "react" | "html";
}

export type PresentResult =
  | PresentDecision
  | PresentChecklist
  | PresentMetrics
  | PresentForm
  | PresentDiagram
  | PresentReactArtifact;

/**
 * FNV-1a 32-bit hash algorithm for stable, deterministic IDs.
 */
export function presentResultHash(canonical: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Creates a stable present result ID from kind and canonical representation.
 */
export function presentResultId(kind: PresentResultKind, canonical: string): string {
  return `present-${kind}-${presentResultHash(`${kind}:${canonical}`)}`;
}

export function presentUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asTrimmedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxChars) return null;
  return trimmed;
}

function asOptionalText(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxChars);
}

/**
 * Strictly parses and validates a PresentResult payload.
 * Returns null if schemaVersion !== 1 or if invalid/oversized.
 */
export function parsePresentResult(value: unknown): PresentResult | null {
  let input = value;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }

  if (!isRecord(input)) return null;
  if (input.schemaVersion !== PRESENT_SCHEMA_VERSION) return null;
  if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 160) return null;

  const title = asTrimmedString(input.title, PRESENT_MAX_TITLE_CHARS);
  if (!title) return null;

  const description = asOptionalText(input.description, PRESENT_MAX_TEXT_CHARS);
  const summary = asOptionalText(input.summary, PRESENT_MAX_TEXT_CHARS);
  const base = {
    schemaVersion: 1 as const,
    id: input.id.trim(),
    title,
    ...(description !== undefined ? { description } : {}),
    ...(summary !== undefined ? { summary } : {}),
  };

  if (input.kind === "decision") {
    if (!Array.isArray(input.options) || input.options.length === 0) return null;
    const options: DecisionOption[] = [];
    const seen = new Set<string>();
    for (const raw of input.options) {
      if (!isRecord(raw)) return null;
      const optId = asTrimmedString(raw.id, 80);
      const label = asTrimmedString(raw.label, PRESENT_MAX_TITLE_CHARS);
      if (!optId || !label || seen.has(optId)) return null;
      seen.add(optId);
      options.push({
        id: optId,
        label,
        description: asOptionalText(raw.description, PRESENT_MAX_TEXT_CHARS),
        badge: asOptionalText(raw.badge, 40),
        recommended: raw.recommended === true,
      });
    }
    return { ...base, kind: "decision", options };
  }

  if (input.kind === "checklist") {
    if (!Array.isArray(input.items) || input.items.length === 0) return null;
    const items: ChecklistItem[] = [];
    const seen = new Set<string>();
    for (const raw of input.items) {
      if (!isRecord(raw)) return null;
      const itemId = asTrimmedString(raw.id, 80);
      const label = asTrimmedString(raw.label, PRESENT_MAX_TITLE_CHARS);
      if (!itemId || !label || seen.has(itemId)) return null;
      seen.add(itemId);
      items.push({
        id: itemId,
        label,
        checked: raw.checked === true,
        description: asOptionalText(raw.description, PRESENT_MAX_TEXT_CHARS),
      });
    }
    return { ...base, kind: "checklist", items };
  }

  if (input.kind === "metrics") {
    if (!Array.isArray(input.metrics) || input.metrics.length === 0) return null;
    const metrics: MetricItem[] = [];
    for (const raw of input.metrics) {
      if (!isRecord(raw)) return null;
      const label = asTrimmedString(raw.label, PRESENT_MAX_TITLE_CHARS);
      if (!label || raw.value === undefined || raw.value === null) return null;
      metrics.push({
        label,
        value: typeof raw.value === "number" || typeof raw.value === "string" ? raw.value : String(raw.value),
        delta: asOptionalText(raw.delta, 40),
        unit: asOptionalText(raw.unit, 20),
        trend: raw.trend === "up" || raw.trend === "down" || raw.trend === "neutral" ? raw.trend : undefined,
        progress: typeof raw.progress === "number" ? Math.max(0, Math.min(100, raw.progress)) : undefined,
      });
    }
    return { ...base, kind: "metrics", metrics };
  }

  if (input.kind === "form") {
    if (!Array.isArray(input.fields) || input.fields.length === 0) return null;
    const fields: FormField[] = [];
    const seen = new Set<string>();
    for (const raw of input.fields) {
      if (!isRecord(raw)) return null;
      const fieldId = asTrimmedString(raw.id, 80);
      const label = asTrimmedString(raw.label, PRESENT_MAX_TITLE_CHARS);
      if (!fieldId || !label || seen.has(fieldId)) return null;
      seen.add(fieldId);
      const rawType = String(raw.type || "text").toLowerCase();
      const type: FormField["type"] =
        rawType === "number" || rawType === "select" || rawType === "checkbox" || rawType === "textarea"
          ? rawType
          : "text";

      fields.push({
        id: fieldId,
        label,
        type,
        placeholder: asOptionalText(raw.placeholder, 120),
        options: Array.isArray(raw.options) ? raw.options.map(String) : undefined,
        defaultValue: raw.defaultValue,
        required: raw.required === true,
      });
    }
    const submitLabel = asOptionalText(input.submitLabel, 40) || "提交并继续";
    return { ...base, kind: "form", submitLabel, fields };
  }

  if (input.kind === "diagram") {
    const rawType = String(input.diagramType || "architecture").toLowerCase();
    const diagramType: DiagramType =
      rawType === "mindmap" || rawType === "sequence" || rawType === "flowchart" || rawType === "quadrant" || rawType === "timeline"
        ? rawType
        : "architecture";

    const data = isRecord(input.data) ? input.data : {};
    return {
      ...base,
      kind: "diagram",
      diagramType,
      theme: input.theme === "light" || input.theme === "dark" || input.theme === "system" ? input.theme : "system",
      accent:
        input.accent === "blue" ||
        input.accent === "indigo" ||
        input.accent === "violet" ||
        input.accent === "amber" ||
        input.accent === "rose" ||
        input.accent === "cyan"
          ? input.accent
          : "emerald",
      data,
    };
  }

  if (input.kind === "react-artifact") {
    const code = asTrimmedString(input.code, 200_000);
    if (!code) return null;
    return {
      ...base,
      kind: "react-artifact",
      code,
      template: input.template === "html" ? "html" : "react",
    };
  }

  return null;
}

/**
 * Normalizes legacy, MCP, or loose agent payloads into a strictly valid PresentResult.
 */
export function normalizeToPresentResult(raw: unknown): PresentResult | null {
  if (!raw) return null;

  // Direct parse first if already compliant
  const direct = parsePresentResult(raw);
  if (direct) return direct;

  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!isRecord(obj)) return null;

  // If payload is wrapped under `data` or `structuredContent`
  if (isRecord(obj.structuredContent)) {
    const p = parsePresentResult(obj.structuredContent);
    if (p) return p;
  }
  if (isRecord(obj.data)) {
    const p = parsePresentResult(obj.data);
    if (p) return p;
  }

  const title = asTrimmedString(obj.title, PRESENT_MAX_TITLE_CHARS) || "交互卡片";
  const description = asOptionalText(obj.description, PRESENT_MAX_TEXT_CHARS);

  // Check decision / cardType
  const cardType = String(obj.cardType || "").toLowerCase();
  const innerData = isRecord(obj.data) ? (obj.data as Record<string, unknown>) : obj;

  if (cardType === "decision" || Array.isArray(innerData.options)) {
    const optionsRaw = Array.isArray(innerData.options) ? innerData.options : [];
    const options: DecisionOption[] = optionsRaw
      .map((o: any, idx: number) => ({
        id: String(o?.id || `opt-${idx}`),
        label: String(o?.label || o?.title || `Option ${idx + 1}`),
        description: o?.description ? String(o.description) : undefined,
        badge: o?.badge ? String(o.badge) : undefined,
        recommended: Boolean(o?.recommended),
      }))
      .filter((o: DecisionOption) => Boolean(o.id && o.label));

    if (options.length > 0) {
      const canonical = JSON.stringify({ title, options });
      return {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id: asTrimmedString(obj.id, 80) || presentResultId("decision", canonical),
        kind: "decision",
        title,
        description,
        options,
      };
    }
  }

  if (cardType === "checklist" || Array.isArray(innerData.items)) {
    const itemsRaw = Array.isArray(innerData.items) ? innerData.items : [];
    const items: ChecklistItem[] = itemsRaw
      .map((it: any, idx: number) => ({
        id: String(it?.id || `item-${idx}`),
        label: String(it?.label || it?.title || `Item ${idx + 1}`),
        checked: Boolean(it?.checked),
        description: it?.description ? String(it.description) : undefined,
      }))
      .filter((it: ChecklistItem) => Boolean(it.id && it.label));

    if (items.length > 0) {
      const canonical = JSON.stringify({ title, items });
      return {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id: asTrimmedString(obj.id, 80) || presentResultId("checklist", canonical),
        kind: "checklist",
        title,
        description,
        items,
      };
    }
  }

  if (cardType === "metrics" || Array.isArray(innerData.metrics)) {
    const metricsRaw = Array.isArray(innerData.metrics) ? innerData.metrics : [];
    const metrics: MetricItem[] = metricsRaw
      .map((m: any) => ({
        label: String(m?.label || "Metric"),
        value: m?.value !== undefined ? String(m.value) : "0",
        delta: m?.delta ? String(m.delta) : undefined,
        unit: m?.unit ? String(m.unit) : undefined,
        trend: m?.trend,
        progress: typeof m?.progress === "number" ? m.progress : undefined,
      }))
      .filter((m: MetricItem) => Boolean(m.label));

    if (metrics.length > 0) {
      const canonical = JSON.stringify({ title, metrics });
      return {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id: asTrimmedString(obj.id, 80) || presentResultId("metrics", canonical),
        kind: "metrics",
        title,
        description,
        metrics,
      };
    }
  }

  if (cardType === "form" || Array.isArray(innerData.fields)) {
    const fieldsRaw = Array.isArray(innerData.fields) ? innerData.fields : [];
    const fields: FormField[] = fieldsRaw
      .map((f: any, idx: number) => ({
        id: String(f?.id || `field-${idx}`),
        label: String(f?.label || `Field ${idx + 1}`),
        type: (f?.type === "number" || f?.type === "select" || f?.type === "checkbox" || f?.type === "textarea" ? f.type : "text") as FormField["type"],
        placeholder: f?.placeholder ? String(f.placeholder) : undefined,
        options: Array.isArray(f?.options) ? f.options.map(String) : undefined,
        defaultValue: f?.defaultValue,
        required: Boolean(f?.required),
      }))
      .filter((f: FormField) => Boolean(f.id && f.label));

    if (fields.length > 0) {
      const canonical = JSON.stringify({ title, fields });
      return {
        schemaVersion: PRESENT_SCHEMA_VERSION,
        id: asTrimmedString(obj.id, 80) || presentResultId("form", canonical),
        kind: "form",
        title,
        description,
        submitLabel: asOptionalText(obj.submitLabel, 40) || "提交并继续",
        fields,
      };
    }
  }

  // Diagram normalization
  if (obj.diagramType || obj.kind === "diagram") {
    const rawType = String(obj.diagramType || "architecture").toLowerCase();
    const diagramType: DiagramType =
      rawType === "mindmap" || rawType === "sequence" || rawType === "flowchart" || rawType === "quadrant" || rawType === "timeline"
        ? rawType
        : "architecture";

    const data = isRecord(obj.data) ? (obj.data as Record<string, any>) : {};
    const canonical = JSON.stringify({ title, diagramType, data });
    return {
      schemaVersion: PRESENT_SCHEMA_VERSION,
      id: asTrimmedString(obj.id, 80) || presentResultId("diagram", canonical),
      kind: "diagram",
      title,
      description,
      diagramType,
      theme: obj.theme === "light" || obj.theme === "dark" || obj.theme === "system" ? obj.theme : "system",
      accent:
        obj.accent === "blue" ||
        obj.accent === "indigo" ||
        obj.accent === "violet" ||
        obj.accent === "amber" ||
        obj.accent === "rose" ||
        obj.accent === "cyan"
          ? obj.accent
          : "emerald",
      data,
    };
  }

  // React artifact normalization
  if (typeof obj.code === "string" && obj.code.trim()) {
    const canonical = JSON.stringify({ title, code: obj.code });
    return {
      schemaVersion: PRESENT_SCHEMA_VERSION,
      id: asTrimmedString(obj.id, 80) || presentResultId("react-artifact", canonical),
      kind: "react-artifact",
      title,
      description,
      code: obj.code,
      template: obj.template === "html" ? "html" : "react",
    };
  }

  return null;
}

export type GenerativeCardAction =
  | {
      type: "decision";
      resultId?: string;
      title: string;
      choiceId: string;
      choiceLabel?: string;
      toolCallId?: string;
      messageId?: string;
    }
  | {
      type: "form";
      resultId?: string;
      title: string;
      values: Record<string, any>;
      toolCallId?: string;
      messageId?: string;
    }
  | {
      type: "checklist";
      resultId?: string;
      title: string;
      checkedIds: string[];
      toolCallId?: string;
      messageId?: string;
    };

export function formatGenerativeActionPrompt(action: GenerativeCardAction): string {
  if (action.type === "decision") {
    const choice = action.choiceLabel || action.choiceId;
    return `[方案决策: ${action.title}] 用户已选定方案：${choice} (ID: ${action.choiceId})`;
  }
  if (action.type === "form") {
    return `[表单提交: ${action.title}]\n\`\`\`json\n${JSON.stringify(action.values, null, 2)}\n\`\`\``;
  }
  if (action.type === "checklist") {
    return `[清单核对: ${action.title}]\n已确认勾选项: ${action.checkedIds.join(", ")}`;
  }
  return "";
}

