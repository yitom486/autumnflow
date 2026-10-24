/**
 * Refresh/window recovery for a turn that was already accepted by the Host.
 *
 * The live send path owns the normal stream. If the page reloads while the
 * assistant message was still streaming, the durable thread pointer
 * (`activeTurn`) lets this hook reconnect with GET /follow from the last seen
 * seq. It never re-sends the prompt.
 */
import { useEffect } from "react";
import { followUniversalTurn, mergePromptUsage } from "@/lib/universal-api";
import { activeKey, sessionOf, useStudioStore, type SessionKey } from "@/stores/useStudioStore";
import type { ActiveTurn } from "@/lib/threads";
import { isTurnLive } from "@/lib/live-turns";

const RECOVERY_ATTEMPTS = 3;
const started = new Set<string>();

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Follow `turn` of session `key` until it ends. Everything it receives goes
 * into that session, whichever session the user is looking at meanwhile.
 */
export async function recoverActiveTurn(
  turn: ActiveTurn,
  assistantId: string,
  key: SessionKey = activeKey(useStudioStore.getState())
): Promise<void> {
  const controller = new AbortController();
  let lastSeq = Math.max(0, Math.floor(Number(turn.persistedSeq ?? turn.lastSeq) || 0));
  let terminal = false;
  let terminalError = "";
  let gap = false;
  const store = () => useStudioStore.getState();
  const isCurrent = () => sessionOf(store(), key).activeTurn?.turnId === turn.turnId;
  const patchAsst = (patch: Parameters<ReturnType<typeof store>["patchMessage"]>[1]) =>
    store().patchMessage(assistantId, patch, key);
  if (!isCurrent()) return;

  store().setSessionRunning(key, true);
  patchAsst((m) => ({ ...m, isStreaming: true, completedAt: undefined }));
  const persistTimer = setInterval(() => {
    if (isCurrent()) store().snapshotThread(key);
  }, 2000);

  const finish = (status: "done" | "error" | "interrupted", note?: string) => {
    const st = store();
    if (!isCurrent()) return;
    patchAsst((m) => ({
      ...m,
      isStreaming: false,
      statusHint: undefined,
      completedAt: m.completedAt ?? Date.now(),
      content: note ? `${m.content}${m.content ? "\n\n" : ""}${note}` : m.content,
      thoughtTiming:
        m.thoughtTiming?.startedAt && !m.thoughtTiming.completedAt
          ? { ...m.thoughtTiming, completedAt: Date.now() }
          : m.thoughtTiming,
    }));
    st.patchActiveTurn({ status, lastSeq }, key);
    st.setSessionRunning(key, false);
    st.snapshotThread(key);
  };

  try {
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS && !terminal; attempt++) {
      try {
        await followUniversalTurn(
          turn.turnId,
          lastSeq,
          {
            onSessionId: (sid) => {
              if (isCurrent()) store().setThreadSessionId(key, sid);
            },
            onSequence: (seq) => {
              lastSeq = seq;
              if (isCurrent()) store().patchActiveTurn({ lastSeq: seq }, key);
            },
            onTextChunk: (text) => {
              if (isCurrent()) {
                patchAsst((m) => ({
                  ...m,
                  content: m.content + text,
                  statusHint: undefined,
                }));
              }
            },
            onThoughtChunk: (text) => {
              if (isCurrent()) {
                patchAsst((m) => ({
                  ...m,
                  thought: (m.thought || "") + text,
                  statusHint: "正在思考…",
                }));
              }
            },
            onToolCall: (call) => {
              if (!isCurrent()) return;
              patchAsst((m) => ({
                ...m,
                toolCalls: [...(m.toolCalls || []), { ...call, startedAt: Date.now() }],
              }));
            },
            onToolCallUpdate: (call) => {
              if (!isCurrent()) return;
              patchAsst((m) => {
                const calls = [...(m.toolCalls || [])];
                const index = calls.findIndex((item) => item.id === call.id);
                if (index < 0) calls.push({ ...call, startedAt: Date.now() } as any);
                else calls[index] = { ...calls[index], ...call } as any;
                return { ...m, toolCalls: calls };
              });
            },
            onPermissionClosed: (id) => useStudioStore.getState().removePermission(id),
            onPermissionRequest: (permission) => {
              if (isCurrent()) useStudioStore.getState().addPermission(permission);
            },
            onElicitationRequest: (elicitation) => {
              if (isCurrent()) useStudioStore.getState().addElicitation(elicitation);
            },
            onElicitationClosed: (id) => {
              if (isCurrent()) useStudioStore.getState().removeElicitation(id);
            },
            onPlan: (entries) => {
              if (isCurrent()) {
                patchAsst((m) => ({ ...m, plan: entries }));
              }
            },
            onUsage: (usage) => {
              if (!isCurrent()) return;
              store().setUsage(usage, key);
              patchAsst({ usage });
            },
            onAvailableCommands: (commands) => {
              const sid = store().threads[key]?.sessionId;
              if (isCurrent()) store().setAvailableCommands(commands, sid);
            },
            onConfigOptions: (options) => {
              if (isCurrent() && activeKey(store()) === key) store().setConfigOptions(options);
            },
            onConfigUpdate: (option) => {
              if (isCurrent() && activeKey(store()) === key) store().patchConfigOption(option);
            },
            onReset: (reset) => {
              gap = true;
              // The server lost the requested prefix; clear the partial view
              // before replaying everything it still retains.
              if (isCurrent() && (reset.reason === "gap" || reset.reason === "ahead")) {
                patchAsst((m) => ({
                  ...m,
                  content: "",
                  thought: "",
                  toolCalls: [],
                }));
                lastSeq = Math.max(0, reset.firstSeq - 1);
                store().patchActiveTurn({ lastSeq }, key);
              }
            },
            onDone: (_reason, response) => {
              if (isCurrent()) {
                const current = sessionOf(store(), key).messages.find(message => message.id === assistantId);
                const usage = mergePromptUsage(current?.usage, response);
                if (usage) {
                  store().setUsage(usage, key);
                  patchAsst({ usage });
                }
              }
              terminal = true;
              finish("done", gap ? "> ⚠️ 连接恢复时部分早期事件已被清理，以上为当前可恢复的内容。" : undefined);
            },
            onError: (err) => {
              if ((err as any)?.terminal) {
                terminal = true;
                terminalError = err.message;
              }
            },
          },
          controller.signal
        );
      } catch (err: any) {
        if (controller.signal.aborted) return;
        if (terminal) break;
        if (attempt === RECOVERY_ATTEMPTS - 1) throw err;
        await sleep(600 * (attempt + 1), controller.signal);
      }
    }
    if (terminalError) finish("error", `> ❌ [恢复失败] ${terminalError}`);
    else if (!terminal) throw new Error("恢复连接结束但未收到 done");
  } catch (err: any) {
    if (controller.signal.aborted) return;
    const terminalMessage =
      err?.message && /unknown or expired turn|404/i.test(String(err.message))
        ? "> ⚠️ 该 turn 已过期，未收到完成事件；请重新发送或开启新会话。"
        : `> ❌ [恢复失败] ${err?.message || err}`;
    finish("interrupted", terminalMessage);
  } finally {
    clearInterval(persistTimer);
    if (isCurrent() && !terminal) store().setSessionRunning(key, false);
  }
}

/**
 * 重新挂上"还在跑但本页没在看"的那一轮。
 *
 * 两个入口：启动时（刷新/重开窗口之后），以及切回一个后台还在跑的会话时。
 * 已经由本页的发送链路盯着的那一轮不重复挂（那条流还在写）。
 */
export function resumeTurnIfNeeded(): void {
  const st = useStudioStore.getState();
  const key = activeKey(st);
  const session = sessionOf(st, key);
  const current = session.activeTurn;
  if (!current || current.status !== "running") return;
  if (isTurnLive(current.turnId) || started.has(current.turnId)) return;
  const assistantId =
    current.assistantId ||
    [...session.messages].reverse().find((message) => message.role === "assistant")?.id;
  if (!assistantId) {
    st.patchActiveTurn({ status: "interrupted" }, key);
    st.snapshotThread(key);
    return;
  }
  started.add(current.turnId);
  void recoverActiveTurn(current, assistantId, key);
}

export function useTurnRecovery(): void {
  useEffect(() => {
    // Boot-only: a live send marks its turn in live-turns and owns the stream.
    const timer = setTimeout(resumeTurnIfNeeded, 300);
    return () => clearTimeout(timer);
  }, []);
}
