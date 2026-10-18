import React, { useId, useRef, useState } from "react";
import { CreateElicitationRequest, ElicitationPropertySchema, type CreateElicitationResponse, type ElicitationSchema } from "@agentclientprotocol/sdk";
import { Button } from "@/components/atoms/Button";
import type { PendingElicitation } from "@/lib/universal-api";
import { elicitationUrl, enumOptions, supportedElicitation, validateElicitationContent, type ElicitationContent } from "../../../shared/elicitation";

export interface ElicitationCardProps {
  e: PendingElicitation;
  onRespond: (e: PendingElicitation, result: CreateElicitationResponse) => void | Promise<void>;
  busy: boolean;
  className?: string;
}
type Draft = Record<string, string | string[] | boolean>;

function defaults(schema: ElicitationSchema): Draft {
  const draft: Draft = Object.create(null);
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if (ElicitationPropertySchema.isArray(field)) draft[key] = field.default ?? [];
    else if (ElicitationPropertySchema.isBoolean(field)) { if (field.default != null) draft[key] = field.default; }
    else if (ElicitationPropertySchema.isString(field)) { if (field.default != null) draft[key] = field.default; }
    else if (ElicitationPropertySchema.isInteger(field) || ElicitationPropertySchema.isNumber(field)) { if (field.default != null) draft[key] = String(field.default); }
  }
  return draft;
}
function formContent(schema: ElicitationSchema, draft: Draft): ElicitationContent {
  const content: ElicitationContent = Object.create(null);
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(draft, key)) continue;
    const value = draft[key];
    if (ElicitationPropertySchema.isNumber(field) || ElicitationPropertySchema.isInteger(field)) {
      if (typeof value === "string" && value.trim() !== "") content[key] = Number(value);
    } else content[key] = value;
  }
  return content;
}

export const ElicitationCard: React.FC<ElicitationCardProps> = ({ e, onRespond, busy, className }) => {
  const baseId = useId();
  const request = e.schema;
  const schema = CreateElicitationRequest.isForm(request) ? request.requestedSchema : {};
  const [draft, setDraft] = useState<Draft>(() => defaults(schema));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState("");
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const disabled = busy || sending;
  const send = async (response: CreateElicitationResponse) => {
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setSending(true);
    setFailure("");
    try { await onRespond(e, response); }
    catch (err) { setFailure(err instanceof Error ? err.message : "提交失败，请重试"); }
    finally { inFlight.current = false; setSending(false); }
  };
  const update = (key: string, value: Draft[string]) => setDraft(prev => ({ ...prev, [key]: value }));
  const check = () => {
    const next = validateElicitationContent(schema, formContent(schema, draft));
    setErrors(next);
    return Object.keys(next).length === 0;
  };
  const controls = <div className="flex flex-wrap justify-end gap-2 pt-2">
    <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => void send({ action: "cancel" })}>取消</Button>
    <Button type="button" size="xs" variant="secondary" disabled={disabled} onClick={() => void send({ action: "decline" })}>拒绝</Button>
    <Button type="submit" size="xs" variant="primary" disabled={disabled}>{disabled ? "提交中…" : "确认提交"}</Button>
  </div>;
  const shell = "rounded-card bg-surface shadow-card border border-line p-3.5 space-y-3 text-[13px] text-ink";
  const inputClass = "w-full rounded-control border border-line bg-inset/40 px-3 py-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60";
  const heading = <div className="space-y-1"><div className="text-xs text-ink-2">{e.agentId} 请求你提供信息</div><div id={`${baseId}-title`} className="font-semibold whitespace-pre-wrap break-words">{request.message}</div></div>;
  if (!supportedElicitation(request)) return <div className={`${shell} ${className ?? ""}`}>
    {heading}<p role="alert">当前客户端无法处理此请求，请取消后重试。</p>
    <Button type="button" disabled={disabled} onClick={() => void send({ action: "cancel" })}>取消</Button>
  </div>;

  if (CreateElicitationRequest.isUrl(request)) {
    const url = elicitationUrl(request.url);
    return <section aria-labelledby={`${baseId}-title`} aria-busy={disabled} className={`${shell} ${className ?? ""}`}>
      {heading}
      <p className="text-ink-2">目标网站：<strong>{url.host}</strong></p>
      <p className="break-all select-text">{request.url}</p>
      {url.hostname.includes("xn--") && <p className="text-warning">此域名包含国际化编码，请仔细核对目标网站。</p>}
      {failure && <p role="alert" className="text-danger">{failure}</p>}
      {e.status === "accepted" ? <div className="flex items-center justify-between gap-3"><p role="status">已同意打开，等待外部流程完成…</p><Button type="button" size="xs" disabled={disabled} onClick={() => void send({ action: "cancel" })}>关闭提示</Button></div>
        : <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => void send({ action: "cancel" })}>取消</Button>
          <Button type="button" size="xs" variant="secondary" disabled={disabled} onClick={() => void send({ action: "decline" })}>拒绝</Button>
          <Button type="button" size="xs" variant="primary" disabled={disabled} onClick={() => {
            if (inFlight.current || busy) return;
            try { window.open(url.href, "_blank", "noopener,noreferrer"); void send({ action: "accept" }); }
            catch { setFailure("无法打开浏览器，请重试"); }
          }}>同意并在浏览器中打开</Button>
        </div>}
    </section>;
  }

  return <form noValidate aria-labelledby={`${baseId}-title`} aria-busy={disabled} className={`${shell} ${className ?? ""}`} onSubmit={event => {
    event.preventDefault();
    if (check()) void send({ action: "accept", content: formContent(schema, draft) });
  }}>
    {heading}
    {schema.title && <p className="font-medium">{schema.title}</p>}
    {schema.description && <p className="text-ink-2 whitespace-pre-wrap">{schema.description}</p>}
    <fieldset disabled={disabled} className="space-y-3">
      {Object.entries(schema.properties ?? {}).map(([key, field], index) => {
        const id = `${baseId}-${index}`;
        const label = typeof field.title === "string" ? field.title : key;
        const required = schema.required?.includes(key) ?? false;
        const options = enumOptions(field);
        const common = { id, "aria-describedby": `${id}-hint ${id}-error`, "aria-invalid": Boolean(errors[key]), required, onBlur: check, className: inputClass };
        const title = <>{label}{required && <span className="text-ink-2">（必填）</span>}</>;
        let input: React.ReactNode;
        if (ElicitationPropertySchema.isArray(field)) {
          const selected = Array.isArray(draft[key]) ? draft[key] as string[] : [];
          input = <fieldset id={id} aria-describedby={common["aria-describedby"]} aria-invalid={common["aria-invalid"]} onBlur={check} className="space-y-2"><legend className="mb-2 font-medium">{title}</legend>
            {options.map(option => <label key={option.value} className="flex items-start gap-2 rounded-control border border-line px-3 py-2 cursor-pointer">
              <input type="checkbox" className="mt-1 accent-primary" checked={selected.includes(option.value)} onChange={event => update(key, event.target.checked ? [...selected, option.value] : selected.filter(v => v !== option.value))} />
              <span>{option.title}{option.description && <span className="block text-xs text-ink-2">{option.description}</span>}</span>
            </label>)}
          </fieldset>;
        } else if (ElicitationPropertySchema.isBoolean(field)) {
          input = <select {...common} value={draft[key] === undefined ? "" : String(draft[key])} onChange={event => {
            if (event.target.value === "") setDraft(prev => { const next = { ...prev }; delete next[key]; return next; });
            else update(key, event.target.value === "true");
          }}><option value="">请选择</option><option value="true">是</option><option value="false">否</option></select>;
        } else if (options.length) {
          input = <select {...common} value={String(draft[key] ?? "")} onChange={event => update(key, event.target.value)}><option value="" disabled={required}>请选择</option>{options.map(option => <option key={option.value} value={option.value}>{option.title}{option.description ? ` — ${option.description}` : ""}</option>)}</select>;
        } else if (ElicitationPropertySchema.isNumber(field) || ElicitationPropertySchema.isInteger(field)) {
          input = <input {...common} type="number" step={ElicitationPropertySchema.isInteger(field) ? 1 : "any"} min={field.minimum ?? undefined} max={field.maximum ?? undefined} value={String(draft[key] ?? "")} onChange={event => update(key, event.target.value)} />;
        } else if (ElicitationPropertySchema.isString(field)) {
          input = <input {...common} type={field.format === "email" ? "email" : field.format === "date" ? "date" : "text"} minLength={field.minLength ?? undefined} maxLength={field.maxLength ?? undefined} value={String(draft[key] ?? "")} onChange={event => update(key, event.target.value)} />;
        }
        return <div key={key} className="space-y-1.5">
          {!ElicitationPropertySchema.isArray(field) && <label htmlFor={id} className="block font-medium">{title}</label>}
          <p id={`${id}-hint`} className="text-xs text-ink-2 whitespace-pre-wrap">{typeof field.description === "string" ? field.description : ""}</p>
          {input}<p id={`${id}-error`} role={errors[key] ? "alert" : undefined} className="text-xs text-danger">{errors[key]}</p>
        </div>;
      })}
    </fieldset>
    {failure && <p role="alert" className="text-danger">{failure}</p>}
    {controls}
  </form>;
};
