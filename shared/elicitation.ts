import {
  CreateElicitationRequest, CreateElicitationResponse, ElicitationPropertySchema, MultiSelectItems,
  type ClientCapabilities, type ElicitationAcceptAction, type ElicitationSchema,
} from "@agentclientprotocol/sdk";

// Wire method names, variants and payload types are owned by the official SDK.
export const elicitationCapabilities = { form: {}, url: {} } satisfies NonNullable<ClientCapabilities["elicitation"]>;
export type ElicitationContent = NonNullable<ElicitationAcceptAction["content"]>;
export interface ElicitationItem {
  /** Local correlation ID; the agent's opaque URL ID remains in schema.elicitationId. */
  elicitationId: string;
  agentId: string;
  sessionId: string;
  message: string;
  schema: CreateElicitationRequest;
  status?: "pending" | "accepted";
}

export function elicitationUrl(value: string): URL {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password) {
    throw new Error("授权链接必须使用 HTTPS（本地开发可使用 HTTP），且不能包含登录凭据");
  }
  return url;
}

export function enumOptions(field: ElicitationPropertySchema): Array<{ value: string; title: string; description?: string }> {
  if (ElicitationPropertySchema.isString(field)) {
    return field.oneOf?.map(o => ({ value: o.const, title: o.title, description: o.description ?? undefined }))
      ?? field.enum?.map(value => ({ value, title: value })) ?? [];
  }
  if (ElicitationPropertySchema.isArray(field)) {
    if (MultiSelectItems.isTitled(field.items)) return field.items.anyOf.map(o => ({ value: o.const, title: o.title, description: o.description ?? undefined }));
    if (MultiSelectItems.isString(field.items)) return field.items.enum.map(value => ({ value, title: value }));
  }
  return [];
}

export function supportedElicitation(request: CreateElicitationRequest): boolean {
  if (CreateElicitationRequest.isUrl(request)) {
    try { elicitationUrl(request.url); return true; } catch { return false; }
  }
  if (!CreateElicitationRequest.isForm(request)) return false;
  const properties = request.requestedSchema.properties ?? {};
  if (request.requestedSchema.required?.some(key => !Object.hasOwn(properties, key))) return false;
  return Object.values(properties).every(field => {
    if (ElicitationPropertySchema.isString(field)) {
      try { if (field.pattern) new RegExp(field.pattern, "u"); return true; } catch { return false; }
    }
    return ElicitationPropertySchema.isNumber(field) || ElicitationPropertySchema.isInteger(field)
      || ElicitationPropertySchema.isBoolean(field)
      || (ElicitationPropertySchema.isArray(field) && (MultiSelectItems.isString(field.items) || MultiSelectItems.isTitled(field.items)));
  });
}

/** SDK guards validate wire shapes; form values also need the schema's value constraints. */
export function validateElicitationContent(schema: ElicitationSchema, content: ElicitationContent): Record<string, string> {
  const errors: Record<string, string> = Object.create(null);
  const properties = schema.properties ?? {};
  for (const key of Object.keys(content)) if (!Object.hasOwn(properties, key)) errors[key] = "未知字段";
  for (const [key, field] of Object.entries(properties)) {
    const present = Object.hasOwn(content, key);
    const value = content[key];
    if (!present) { if (schema.required?.includes(key)) errors[key] = "请填写此项"; continue; }
    let error = "";
    if (ElicitationPropertySchema.isString(field)) {
      if (typeof value !== "string") error = "请输入文字";
      else if (field.minLength != null && [...value].length < field.minLength) error = `至少 ${field.minLength} 个字符`;
      else if (field.maxLength != null && [...value].length > field.maxLength) error = `最多 ${field.maxLength} 个字符`;
      else if (field.pattern && !matchesPattern(field.pattern, value)) error = "格式不符合要求";
      else if (enumOptions(field).length && !enumOptions(field).some(o => o.value === value)) error = "请选择提供的选项";
      else if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) error = "请输入有效邮箱";
      else if (field.format === "uri") { try { new URL(value); } catch { error = "请输入有效地址"; } }
      else if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) error = "请输入有效日期";
      else if (field.format === "date-time" && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || Number.isNaN(Date.parse(value)))) error = "请输入带时区的日期和时间";
    } else if (ElicitationPropertySchema.isNumber(field) || ElicitationPropertySchema.isInteger(field)) {
      if (typeof value !== "number" || !Number.isFinite(value) || (ElicitationPropertySchema.isInteger(field) && !Number.isInteger(value))) error = "请输入有效数字";
      else if (field.minimum != null && value < field.minimum) error = `不得小于 ${field.minimum}`;
      else if (field.maximum != null && value > field.maximum) error = `不得大于 ${field.maximum}`;
    } else if (ElicitationPropertySchema.isBoolean(field)) {
      if (typeof value !== "boolean") error = "请选择是或否";
    } else if (ElicitationPropertySchema.isArray(field)) {
      if (!Array.isArray(value) || value.some(v => typeof v !== "string" || !enumOptions(field).some(o => o.value === v)) || new Set(value).size !== value.length) error = "请选择提供的选项";
      else if (field.minItems != null && value.length < field.minItems) error = `至少选择 ${field.minItems} 项`;
      else if (field.maxItems != null && value.length > field.maxItems) error = `最多选择 ${field.maxItems} 项`;
    } else error = "暂不支持此字段类型";
    if (error) errors[key] = error;
  }
  return errors;
}

function matchesPattern(pattern: string, value: string): boolean {
  try { return new RegExp(pattern, "u").test(value); } catch { return false; }
}

export function isElicitationResponse(value: unknown): value is CreateElicitationResponse {
  const response = value as CreateElicitationResponse;
  return CreateElicitationResponse.isAccept(response) || CreateElicitationResponse.isDecline(response) || CreateElicitationResponse.isCancel(response);
}
