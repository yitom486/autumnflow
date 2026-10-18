import * as acp from "@agentclientprotocol/sdk";
import schema from "@agentclientprotocol/sdk/schema/schema.json";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Discover method payloads from SDK metadata rather than maintaining a second
// protocol schema or a hand-written table of required fields.
const validator = new Ajv2020({ strict: false, allErrors: true });
addFormats(validator);
for (const format of ["int64", "uint64", "uint32", "uint16", "int32", "double"]) {
  validator.addFormat(format, { type: "number", validate: Number.isFinite });
}
validator.addSchema(schema, "acp-sdk");
const definitions = schema.$defs;
const methodDefinitions = new Map<string, string>();
const references = new Map<string, { $ref: string }>();
for (const [name, definition] of Object.entries(definitions)) {
  if (name.endsWith("Request") && "x-method" in definition && "x-side" in definition) {
    methodDefinitions.set(`${definition["x-side"]}:${definition["x-method"]}`, name);
  }
}

export function sdkValue<T>(definition: keyof typeof definitions, value: unknown): T {
  let reference = references.get(definition);
  if (!reference) { reference = { $ref: `acp-sdk#/$defs/${definition}` }; references.set(definition, reference); }
  const check = validator.compile<T>(reference);
  if (!check(value)) throw acp.RequestError.invalidParams(check.errors, `Invalid ACP ${definition}: ${validator.errorsText(check.errors)}`);
  return value;
}

export function sdkRequest<M extends acp.AgentRequestMethod>(method: M, value: unknown): acp.AgentRequestParamsByMethod[M] {
  const definition = methodDefinitions.get(`agent:${method}`);
  if (!definition) throw acp.RequestError.methodNotFound(method);
  // Root extension data belongs in _meta. Keep only SDK-defined root fields;
  // discover union-variant fields from that same published schema.
  const name = definition as keyof typeof definitions;
  const fields = new Set<string>();
  const collect = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const object = node as { properties?: object; anyOf?: unknown[]; allOf?: unknown[]; oneOf?: unknown[] };
    Object.keys(object.properties ?? {}).forEach(key => fields.add(key));
    [...(object.anyOf ?? []), ...(object.allOf ?? []), ...(object.oneOf ?? [])].forEach(collect);
  };
  collect(definitions[name]);
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => fields.has(key))) : value;
  return sdkValue<acp.AgentRequestParamsByMethod[M]>(name, payload);
}

/** Preserve the SDK's method/params/response relation (its custom overload is intentionally broad). */
export function requestAgent<M extends acp.AgentRequestMethod>(
  connection: acp.ClientConnection, method: M, params: acp.AgentRequestParamsByMethod[M],
): Promise<acp.AgentRequestResponsesByMethod[M]> {
  return connection.agent.request(method, sdkRequest(method, params));
}

export function requireAgentCapability(name: string, supported: unknown): void {
  if (supported === undefined || supported === null || supported === false) {
    throw acp.RequestError.methodNotFound(`Agent did not advertise ${name}`);
  }
}

export const clientCapabilities = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  auth: { terminal: false }, // Overridden per connection after verifying a reproducible PTY invocation.
  elicitation: { form: {}, url: {} },
  session: { configOptions: { boolean: {} }, notices: {}, compaction: {} },
  plan: {},
  subagents: {},
} satisfies acp.ClientCapabilities;
