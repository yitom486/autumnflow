import React, { useMemo, useState } from "react";
import { ExternalLink, Code2 } from "lucide-react";
import { Button } from "@/components/atoms/Button";
import ApprovalCard, { type ApprovalQuestion, type ApprovalOptionItem } from "@/components/primitives/ApprovalCard";
import type { PendingElicitation } from "@/lib/universal-api";

export interface ElicitationCardProps {
  e: PendingElicitation;
  onRespond: (e: PendingElicitation, accept: boolean, payload?: unknown) => void;
  busy: boolean;
  className?: string;
}

interface FieldDef {
  key: string;
  title: string;
  description?: string;
  type: string;
  options: ApprovalOptionItem[];
  rawOptions: any[];
  required: boolean;
}

function coerce(type: string, v: string): unknown {
  if (type === "boolean") return v === "true" || v === "on" || v === "1";
  if (type === "integer") {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? v : n;
  }
  if (type === "number") {
    const n = parseFloat(v);
    return Number.isNaN(n) ? v : n;
  }
  return v;
}

export const ElicitationCard: React.FC<ElicitationCardProps> = ({ e, onRespond, busy, className }) => {
  const [showRaw, setShowRaw] = useState(false);
  const [rawJson, setRawJson] = useState("");

  const parsed = useMemo(() => {
    const s = e.schema || {};
    if (s.mode === "url" && s.url) {
      return { mode: "url" as const, url: s.url as string, title: e.message || "需要前往浏览器确认" };
    }

    // 1. OpenCode format / questions list:
    // Check multiple possible paths where OpenCode, plugins, or ACP agents place the questions list
    const rawQuestionsList: any[] | null =
      (Array.isArray(s.questions) && s.questions) ||
      (Array.isArray(s.requestedSchema?.questions) && s.requestedSchema.questions) ||
      (Array.isArray(s.schema?.questions) && s.schema.questions) ||
      (Array.isArray(s.params?.questions) && s.params.questions) ||
      (Array.isArray(s.payload?.questions) && s.payload.questions) ||
      (Array.isArray(s.requestedSchema?.properties?.questions) && s.requestedSchema.properties.questions) ||
      (Array.isArray(s) && s) ||
      null;

    if (rawQuestionsList && rawQuestionsList.length > 0) {
      const questions: ApprovalQuestion[] = rawQuestionsList.map((q: any) => {
        const rawOpts = q.options ?? q.choices ?? q.items ?? q.oneOf ?? q.anyOf ?? [];
        const options: ApprovalOptionItem[] = (Array.isArray(rawOpts) ? rawOpts : []).map((o: any) => {
          if (typeof o === "string" || typeof o === "number") {
            return String(o);
          }
          const label = o?.label ?? o?.title ?? o?.name ?? o?.text ?? o?.const ?? String(o?.value ?? "");
          const desc = o?.description ?? o?.desc ?? undefined;
          const val = o?.value ?? o?.const ?? label;
          return {
            label: label || String(val),
            description: desc,
            value: String(val),
          };
        });

        // In OpenCode, header is a concise tag (e.g. "Database") and question is the prompt
        const promptTitle = q.header && q.question && q.header !== q.question
          ? `[${q.header}] ${q.question}`
          : (q.question || q.header || q.title || e.message || "请选择或确认：");

        return {
          q: promptTitle,
          description: q.header && q.question && q.header !== q.question ? undefined : (q.description || undefined),
          type: q.multiple ? "check" : "radio",
          options,
        };
      });

      return { mode: "opencode" as const, questions, rawQuestions: rawQuestionsList };
    }

    // 2. Standard JSON-Schema form fields
    const rs = s.requestedSchema || s.schema || s.params?.requestedSchema || {};
    const props = rs.properties || {};
    const required: string[] = rs.required || [];
    const fields: FieldDef[] = Object.entries(props).map(([key, def]: [string, any]) => {
      const t = Array.isArray(def?.type)
        ? def.type.find((x: string) => x !== "null") || "string"
        : def?.type || "string";

      // Parse options from enum, oneOf, anyOf, options, choices, or items (for arrays)
      let rawOptions: any[] = [];
      if (Array.isArray(def?.enum)) {
        rawOptions = def.enum;
      } else if (Array.isArray(def?.oneOf)) {
        rawOptions = def.oneOf;
      } else if (Array.isArray(def?.anyOf)) {
        rawOptions = def.anyOf;
      } else if (Array.isArray(def?.options)) {
        rawOptions = def.options;
      } else if (Array.isArray(def?.choices)) {
        rawOptions = def.choices;
      } else if (t === "array" && def?.items) {
        if (Array.isArray(def.items.enum)) {
          rawOptions = def.items.enum;
        } else if (Array.isArray(def.items.anyOf)) {
          rawOptions = def.items.anyOf;
        } else if (Array.isArray(def.items.oneOf)) {
          rawOptions = def.items.oneOf;
        }
      }

      const options: ApprovalOptionItem[] = rawOptions.map((o: any) => {
        if (typeof o === "string" || typeof o === "number") {
          return String(o);
        }
        const label = o?.title ?? o?.label ?? o?.name ?? o?.text ?? String(o?.const ?? o?.value ?? "");
        const desc = o?.description ?? undefined;
        const val = o?.const ?? o?.value ?? label;
        return {
          label: label || String(val),
          description: desc,
          value: String(val),
        };
      });

      if (options.length === 0 && t === "boolean") {
        options.push(
          { label: "是 (true)", value: "true" },
          { label: "否 (false)", value: "false" }
        );
      }

      return {
        key,
        title: def?.title || key,
        description: def?.description,
        type: t,
        options,
        rawOptions,
        required: required.includes(key),
      };
    });

    if (fields.length > 0) {
      const questions: ApprovalQuestion[] = fields.map((f) => {
        return {
          q: f.title || f.key,
          description: f.description,
          type: f.type === "array" ? "check" : "radio",
          options: f.options,
        };
      });
      return { mode: "schema" as const, questions, fields, title: rs.title || e.message };
    }

    // 3. Fallback: general question or confirmation
    const fallbackQuestion: ApprovalQuestion = {
      q: e.message || "智能体需要您的确认与输入：",
      type: "radio",
      options: [
        { label: "确认继续 (Continue)", value: "continue" },
        { label: "取消 / 拒绝 (Decline)", value: "cancel" },
      ],
    };
    return { mode: "fallback" as const, questions: [fallbackQuestion] };
  }, [e]);

  if (parsed.mode === "url") {
    return (
      <div className={`rounded-card bg-surface shadow-card border border-line p-3.5 space-y-2.5 ${className || ""}`}>
        <div className="font-semibold text-[13.5px] text-ink leading-snug">{parsed.title}</div>
        <div className="text-[12px] text-ink-2 break-all">{parsed.url}</div>
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => window.open(parsed.url, "_blank")}
            className="gap-1.5 h-8 text-[12px]"
          >
            <ExternalLink className="w-3.5 h-3.5" /> 在浏览器中打开
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onRespond(e, false)}
            className="h-8 text-[12px] text-ink-3 hover:text-ink"
          >
            跳过
          </Button>
        </div>
      </div>
    );
  }

  const handleSubmitted = (answers: Record<number, number[]>, customAnswers: Record<number, string>) => {
    if (showRaw) {
      let payload: unknown = {};
      if (rawJson.trim()) {
        try {
          payload = JSON.parse(rawJson);
        } catch {
          alert("不是合法的 JSON 格式");
          return;
        }
      }
      onRespond(e, true, payload);
      return;
    }

    if (parsed.mode === "opencode") {
      const resultAnswers: string[][] = [];
      const contentAnswers: Record<string, any> = {};

      parsed.questions.forEach((q, idx) => {
        const custom = customAnswers[idx]?.trim();
        const selectedIndices = answers[idx] ?? [];
        const rawQ = parsed.rawQuestions?.[idx];
        const rawOpts = rawQ?.options ?? rawQ?.choices ?? rawQ?.items ?? rawQ?.oneOf ?? rawQ?.anyOf ?? [];

        let chosenStrings: string[] = [];
        if (custom) {
          chosenStrings = [custom];
        } else if (selectedIndices.length > 0) {
          chosenStrings = selectedIndices.map((i) => {
            const rawOpt = rawOpts[i];
            if (rawOpt == null) {
              const opt = q.options[i];
              return typeof opt === "string" ? opt : opt?.label || opt?.value || "";
            }
            if (typeof rawOpt === "string" || typeof rawOpt === "number") return String(rawOpt);
            // OpenCode expects the label of the selected option, or value
            return String(rawOpt.label ?? rawOpt.value ?? rawOpt.title ?? rawOpt.name ?? rawOpt.const ?? "");
          });
        }

        // OpenCode QuestionV2.Answer[] expects string[] for each question
        resultAnswers.push(chosenStrings);

        const key = rawQ?.header || rawQ?.question || `q${idx}`;
        contentAnswers[key] = q.type === "check" ? chosenStrings : (chosenStrings[0] ?? "");
      });

      // Submit both standard OpenCode format { answers: string[][] } and key-value mapping
      onRespond(e, true, { answers: resultAnswers, ...contentAnswers });
      return;
    }

    if (parsed.mode === "schema" && parsed.fields) {
      const content: Record<string, unknown> = {};
      parsed.fields.forEach((f, idx) => {
        const custom = customAnswers[idx]?.trim();
        const selectedIndices = answers[idx] ?? [];
        const q = parsed.questions[idx];

        if (custom) {
          content[f.key] = coerce(f.type, custom);
          return;
        }

        if (q.type === "check") {
          content[f.key] = selectedIndices.map((i) => {
            const rawOpt = f.rawOptions?.[i];
            if (rawOpt != null && typeof rawOpt === "object") {
              return rawOpt.const ?? rawOpt.value ?? rawOpt.label ?? rawOpt.title;
            }
            const opt = q.options[i];
            return typeof opt === "string" ? opt : opt.value ?? opt.label;
          });
          return;
        }

        if (selectedIndices.length > 0) {
          const i = selectedIndices[0];
          const rawOpt = f.rawOptions?.[i];
          let chosenVal: unknown = "";
          if (rawOpt != null && typeof rawOpt === "object") {
            chosenVal = rawOpt.const ?? rawOpt.value ?? rawOpt.label ?? rawOpt.title ?? "";
          } else {
            const opt = q.options[i];
            chosenVal = typeof opt === "string" ? opt : opt.value ?? opt.label;
          }

          if (f.type === "boolean") {
            const strVal = String(chosenVal);
            chosenVal = strVal.includes("true") || strVal === "是 (true)";
          } else if (f.type === "number" || f.type === "integer") {
            chosenVal = coerce(f.type, String(chosenVal));
          }

          content[f.key] = chosenVal;
        }
      });

      onRespond(e, true, content);
      return;
    }

    // Fallback mode
    const custom = customAnswers[0]?.trim();
    const selectedIdx = answers[0]?.[0] ?? 0;
    const isConfirm = selectedIdx === 0 && !custom;
    const opt = parsed.questions[0].options[selectedIdx];
    const chosenAnswer = custom || (typeof opt === "string" ? opt : opt?.label || opt?.value || "");
    onRespond(e, true, { accepted: isConfirm, answer: chosenAnswer });
  };

  return (
    <div className={`space-y-1.5 ${className || ""}`}>
      {showRaw ? (
        <div className="rounded-card bg-surface shadow-card border border-line p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-[13px] text-ink">{e.message || "原始 Elicitation 交互"}</span>
            <button
              type="button"
              onClick={() => setShowRaw(false)}
              className="text-[11px] text-primary hover:underline"
            >
              返回问答卡片
            </button>
          </div>
          <textarea
            value={rawJson}
            onChange={(ev) => setRawJson(ev.target.value)}
            placeholder="accept 时提交的 JSON content（如 {}）"
            rows={3}
            spellCheck={false}
            className="w-full rounded-control bg-inset/40 border border-line px-2.5 py-1.5 font-mono text-[11px] text-ink outline-none"
          />
          <div className="flex items-center justify-end gap-2">
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => onRespond(e, false)}>
              跳过
            </Button>
            <Button size="xs" variant="primary" disabled={busy} onClick={() => handleSubmitted({}, {})}>
              提交 JSON
            </Button>
          </div>
        </div>
      ) : (
        <ApprovalCard
          questions={parsed.questions}
          labels={{
            skip: "跳过",
            continue: "继续",
            send: busy ? "提交中…" : "确认提交",
            customPlaceholder: "自定义补充或输入…",
            sentMessage: "已提交回答",
          }}
          onSubmitted={handleSubmitted}
          onDismiss={() => onRespond(e, false)}
          className="w-full max-w-full"
        />
      )}

      {/* 底部微型调试开关 */}
      <div className="flex items-center justify-end pr-1">
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="inline-flex items-center gap-1 text-[10px] font-mono text-ink-3 hover:text-ink transition-colors cursor-pointer"
        >
          <Code2 className="w-2.5 h-2.5" />
          <span>{showRaw ? "卡片视图" : "原始 Schema"}</span>
        </button>
      </div>
    </div>
  );
};
