"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/atoms/Button";
import GlideMenu from "@/components/primitives/GlideMenu";

/* ─────────────────────────────────────────────────────────
 * APPROVAL CARD (human-in-the-loop)
 * One question at a time. The stack slides vertically as you
 * move between questions (the card's height animates to fit),
 * the step counter rolls like an odometer, and the footer uses
 * pill actions — a quiet Skip and a dark Continue with a ⏎.
 * Single-choice answers auto-advance; multi-select waits.
 * ───────────────────────────────────────────────────────── */

export type ApprovalOptionItem =
  | string
  | {
      label: string;
      description?: string;
      value?: string;
    };

export type ApprovalQuestion = {
  q: string;
  description?: string;
  type: "radio" | "check";
  options: ApprovalOptionItem[];
};

export type ApprovalLabels = {
  skip: string;
  continue: string;
  send: string;
  customPlaceholder: string;
  sentMessage: string;
};

const DEFAULT_LABELS: ApprovalLabels = {
  skip: "跳过",
  continue: "继续",
  send: "确认提交",
  customPlaceholder: "自定义输入…",
  sentMessage: "已授权 / 已确认",
};

const ROLL_MS = 400;
const SLIDE = "360ms cubic-bezier(0.22, 1, 0.36, 1)";

/* odometer digits — each character that changes rolls up (or down) */
function RollingDigits({ value }: { value: string }) {
  const prevRef = useRef(value);
  const [oldVal, setOldVal] = useState(value);
  const [newVal, setNewVal] = useState(value);
  const [rolling, setRolling] = useState(false);
  const [shifted, setShifted] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");

  useEffect(() => {
    if (prevRef.current === value) return;
    const from = prevRef.current;
    prevRef.current = value;
    const fromN = parseInt(from, 10);
    const toN = parseInt(value, 10);
    setDir(Number.isFinite(fromN) && Number.isFinite(toN) && toN < fromN ? "down" : "up");
    setOldVal(from);
    setNewVal(value);
    setRolling(true);
    setShifted(false);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShifted(true));
    });
    const done = setTimeout(() => {
      setRolling(false);
      setOldVal(value);
      setShifted(false);
    }, ROLL_MS);

    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(done);
    };
  }, [value]);

  const chars = rolling ? newVal : oldVal;

  return (
    <>
      {Array.from({ length: chars.length }, (_, i) => {
        const o = oldVal[i] ?? "";
        const n = chars[i] ?? "";
        if (!rolling || o === n) {
          return <span key={`${i}-${n}`}>{n}</span>;
        }
        const top = dir === "down" ? n : o;
        const bottom = dir === "down" ? o : n;
        const restY = dir === "down" ? "0" : "-1em";
        const startY = dir === "down" ? "-1em" : "0";
        return (
          <span
            key={`${i}-${o}-${n}-${dir}`}
            style={{ display: "inline-block", position: "relative", overflow: "hidden", height: "1em", lineHeight: "1em", verticalAlign: "-0.05em" }}
          >
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                transition: "transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
                transform: `translateY(${shifted ? restY : startY})`,
              }}
            >
              <span style={{ height: "1em", lineHeight: "1em" }}>{top}</span>
              <span style={{ height: "1em", lineHeight: "1em" }}>{bottom}</span>
            </span>
          </span>
        );
      })}
    </>
  );
}

function Ico({ path, size = 14, sw = 2 }: { path: ReactNode; size?: number; sw?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {path}
    </svg>
  );
}

export default function ApprovalCard({
  questions = [],
  labels,
  onSubmitted,
  onAnswerChange,
  onDismiss,
  resettable = true,
  className,
}: {
  questions: ApprovalQuestion[];
  labels?: Partial<ApprovalLabels>;
  onSubmitted?: (answers: Record<number, number[]>, customAnswers: Record<number, string>) => void;
  onAnswerChange?: (questionIndex: number, answer: number[]) => void;
  onDismiss?: () => void;
  resettable?: boolean;
  className?: string;
}) {
  const t = { ...DEFAULT_LABELS, ...labels };
  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number[]>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [open, setOpen] = useState(true);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const questionRefs = useRef<(HTMLDivElement | null)[]>([]);
  const measured = useRef(false);
  const [viewportH, setViewportH] = useState<number | undefined>(undefined);
  const [trackY, setTrackY] = useState(0);
  const [animate, setAnimate] = useState(false);
  const [ready, setReady] = useState(false);

  const totalQuestions = questions.length;
  const last = qi >= totalQuestions - 1;
  const selected = answers[qi] ?? [];
  const hasAnswer = selected.length > 0 || Boolean(custom[qi]?.trim());

  const sync = (withAnim: boolean) => {
    const item = questionRefs.current[qi];
    if (!item) return;
    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setViewportH(item.offsetHeight);
    setTrackY(item.offsetTop);
    setAnimate(withAnim && !reduce);
  };

  useLayoutEffect(() => {
    const withAnim = measured.current;
    measured.current = true;
    sync(withAnim);
    setReady(true);
  }, [qi, answers, custom, open, sent]);

  useEffect(() => {
    const id = requestAnimationFrame(() => sync(measured.current));
    return () => cancelAnimationFrame(id);
  }, [qi]);

  useEffect(() => () => { if (advanceTimer.current) clearTimeout(advanceTimer.current); }, []);

  if (totalQuestions === 0) return null;

  const answersRef = useRef(answers);
  answersRef.current = answers;
  const customRef = useRef(custom);
  customRef.current = custom;

  const goTo = (next: number) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setQi(Math.min(Math.max(next, 0), totalQuestions - 1));
  };

  const send = (overrideAnswers?: Record<number, number[]>, overrideCustom?: Record<number, string>) => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current);
    setSent(true);
    onSubmitted?.(overrideAnswers ?? answersRef.current, overrideCustom ?? customRef.current);
  };

  const advance = () => {
    if (last) send();
    else goTo(qi + 1);
  };

  const toggle = (index: number) => {
    const type = questions[qi]?.type || "radio";
    let nextAnswers: Record<number, number[]> = {};
    setAnswers((current) => {
      const picked = current[qi] ?? [];
      const next = type === "radio"
        ? [index]
        : picked.includes(index)
          ? picked.filter((item) => item !== index)
          : [...picked, index];
      onAnswerChange?.(qi, next);
      nextAnswers = { ...current, [qi]: next };
      answersRef.current = nextAnswers;
      return nextAnswers;
    });
    if (type === "radio") {
      setCustom((current) => {
        const nextCustom = { ...current, [qi]: "" };
        customRef.current = nextCustom;
        return nextCustom;
      });
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => {
        if (last) send(nextAnswers);
        else setQi((current) => Math.min(totalQuestions - 1, current + 1));
      }, 480);
    }
  };

  const reset = () => {
    setQi(0);
    setAnswers({});
    setCustom({});
    setSent(false);
    setOpen(true);
    measured.current = false;
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-control bg-surface px-3 py-2 text-[12.5px] font-medium text-ink shadow-btn transition-colors duration-150 hover:bg-hover cursor-pointer"
      >
        查看授权请求
      </button>
    );
  }

  if (sent) {
    return (
      <div className={`flex w-full items-center gap-3 ${className || "max-w-90"}`} style={{ animation: "pop-in 260ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-green-tint py-1 pr-3 pl-1.5 text-[12.5px] font-medium text-green">
          <span className="flex size-4.5 items-center justify-center rounded-full bg-green text-white">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          </span>
          {t.sentMessage}
        </span>
        {resettable && (
          <button type="button" onClick={reset} className="text-[12px] font-medium text-ink-3 transition-colors duration-150 hover:text-ink cursor-pointer">
            重新处理
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`w-full ${className || "max-w-95"}`}>
      <div className="relative overflow-hidden rounded-card bg-surface shadow-card border border-line" style={{ animation: "fade-up 380ms cubic-bezier(0.23,1,0.32,1) both" }}>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setOpen(false);
            onDismiss?.();
          }}
          className="primitive-icon-button absolute right-2.5 top-2.5 z-10 text-ink-3 transition-colors duration-100 hover:bg-hover hover:text-ink cursor-pointer"
        >
          <Ico size={14} sw={2.2} path={<path d="M18 6L6 18M6 6l12 12" />} />
        </button>
        <div className="p-3.5">
          <div
            className="overflow-hidden"
            style={{ height: viewportH, transition: animate ? `height ${SLIDE}` : undefined }}
            aria-live="polite"
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 26,
                transform: `translate3d(0, ${-trackY}px, 0)`,
                transition: animate ? `transform ${SLIDE}` : undefined,
                willChange: "transform",
              }}
            >
              {questions.map((question, qIdx) => {
                const active = qIdx === qi;
                if (!ready && !active) return null;
                const picked = answers[qIdx] ?? [];
                const questionStyle: CSSProperties = {
                  opacity: active ? 1 : 0,
                  transition: animate ? `opacity ${SLIDE}` : undefined,
                  pointerEvents: active ? undefined : "none",
                };
                return (
                  <div
                    key={qIdx}
                    ref={(el) => { questionRefs.current[qIdx] = el; }}
                    aria-hidden={active ? undefined : true}
                    style={questionStyle}
                  >
                    <div className="pr-7">
                      <div className="text-[13.5px] font-semibold text-ink leading-snug">{question.q}</div>
                      {question.description && (
                        <div className="text-[12px] text-ink-2 mt-1 leading-normal">{question.description}</div>
                      )}
                    </div>
                    <GlideMenu className="mt-2.5 flex flex-col gap-1" highlightClassName="inset-x-0 rounded-control bg-hover">
                      {question.options.map((option, i) => {
                        const on = picked.includes(i);
                        const optLabel = typeof option === "string" ? option : option.label || option.value || "";
                        const optDesc = typeof option === "object" && option ? option.description : undefined;
                        const optKey = typeof option === "string" ? `${i}-${option}` : `${i}-${option.value || option.label}`;
                        return (
                          <button
                            key={optKey}
                            type="button"
                            data-menu-row
                            aria-pressed={on}
                            tabIndex={active ? 0 : -1}
                            onClick={() => { if (active) toggle(i); }}
                            className="relative z-10 flex items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors duration-100 cursor-pointer"
                          >
                            <span
                              className={`flex size-4 shrink-0 mt-0.5 items-center justify-center transition-colors duration-200
                                ${question.type === "radio" ? "rounded-full" : "rounded-[5px]"}
                                ${on ? "bg-ink text-canvas" : "shadow-[inset_0_0_0_1.5px_var(--line-strong)] text-transparent"}`}
                            >
                              {question.type === "radio" ? (
                                <span className="size-1.5 rounded-full bg-canvas transition-transform duration-200" style={{ transform: on ? "scale(1)" : "scale(0)" }} />
                              ) : (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                              )}
                            </span>
                            <div className="flex flex-col min-w-0 flex-1">
                              <span className={`text-[12.5px] leading-snug transition-colors duration-200 ${on ? "text-ink font-medium" : "text-ink-2"}`}>
                                {optLabel}
                              </span>
                              {optDesc && (
                                <span className="text-[11.5px] leading-normal text-ink-3 mt-0.5">
                                  {optDesc}
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                      <label data-menu-row className="relative z-10 flex items-center gap-1.5 rounded-control px-2 py-1 transition-colors duration-100">
                        <input
                          value={custom[qIdx] ?? ""}
                          tabIndex={active ? 0 : -1}
                          onChange={(event) => {
                            if (!active) return;
                            setCustom((current) => ({ ...current, [qIdx]: event.target.value }));
                            if (question.type === "radio") setAnswers((current) => ({ ...current, [qIdx]: [] }));
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && hasAnswer) {
                              event.preventDefault();
                              advance();
                            }
                          }}
                          placeholder={t.customPlaceholder}
                          aria-label="自定义补充"
                          className="min-w-0 flex-1 bg-transparent pl-1 text-[12.5px] text-ink outline-none placeholder:text-ink-3"
                        />
                      </label>
                    </GlideMenu>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* footer — step nav (rolling counter) + pill actions */}
        <div className="flex items-center justify-between gap-3 border-t border-line/70 px-3.5 py-2.5 bg-inset/50">
          <div className="flex items-center gap-1.5 text-ink-3">
            {totalQuestions > 1 && (
              <>
                <button
                  type="button"
                  aria-label="上一题"
                  disabled={qi <= 0}
                  onClick={() => goTo(qi - 1)}
                  className="flex size-5 items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30 cursor-pointer"
                >
                  <Ico size={13} path={<path d="M18 15l-6-6-6 6" />} />
                </button>
                <span className="inline-flex items-center text-[11.5px] font-mono tabular-nums text-ink-3" style={{ letterSpacing: "-0.1px", lineHeight: 1 }}>
                  <RollingDigits value={`${qi + 1} / ${totalQuestions}`} />
                </span>
                <button
                  type="button"
                  aria-label="下一题"
                  disabled={last}
                  onClick={() => goTo(qi + 1)}
                  className="flex size-5 items-center justify-center rounded-[5px] transition-colors duration-100 enabled:hover:text-ink disabled:opacity-30 cursor-pointer"
                >
                  <Ico size={13} path={<path d="M6 9l6 6 6-6" />} />
                </button>
              </>
            )}
          </div>

          <div className="-mr-0.5 flex items-center gap-2">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                if (last) {
                  setOpen(false);
                  onDismiss?.();
                } else {
                  goTo(qi + 1);
                }
              }}
            >
              {t.skip}
            </Button>
            <Button
              variant="primary"
              size="xs"
              disabled={!hasAnswer}
              onClick={advance}
            >
              {last ? t.send : t.continue}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
