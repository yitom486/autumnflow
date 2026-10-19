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
import { useStudioStore } from "@/stores/useStudioStore";
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

export async function recoverActiveTurn(turn: ActiveTurn, assistantId: string): Promise<void> {
  const controller = new AbortController();
  let lastSeq = Math.max(0, Math.floor(Number(turn.persistedSeq ?? turn.lastSeq) || 0));
  let terminal = false;
  let terminalError = "";
  let gap = false;
  const store = useStudioStore.getState();
  const isCurrent = () => useStudioStore.getState().activeTurn?.turnId === turn.turnId;
  if (!isCurrent()) return;

  store.setStreaming(true);
  store.setBusy(true);
  store.patchMessage(assistantId, (m) => ({ ...m, isStreaming: true, completedAt: undefined }));
  const persistTimer = setInterval(() => {
    if (isCurrent()) useStudioStore.getState().snapshotThread();
  }, 2000);

  const finish = (status: "done" | "error" | "interrupted", note?: string) => {
    const st = useStudioStore.getState();
    if (!isCurrent()) return;
    st.patchMessage(assistantId, (m) => ({
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
    st.patchActiveTurn({ status, lastSeq });
    st.setStreaming(false);
    st.setBusy(false);
    st.snapshotThread();
  };

  try {
    for (let attempt = 0; attempt < RECOVERY_ATTEMPTS && !terminal; attempt++) {
      try {
        await followUniversalTurn(
          turn.turnId,
          lastSeq,
          {
            onSessionId: (sid) => {
              if (isCurrent()) useStudioStore.getState().setSessionId(sid);
            },
            onSequence: (seq) => {
              lastSeq = seq;
              if (isCurrent()) useStudioStore.getState().patchActiveTurn({ lastSeq: seq });
            },
            onTextChunk: (text) => {
              if (isCurrent()) {
                useStudioStore.getState().patchMessage(assistantId, (m) => ({
                  ...m,
                  content: m.content + text,
                  statusHint: undefined,
                }));
              }
            },
            onThoughtChunk: (text) => {
              if (isCurrent()) {
                useStudioStore.getState().patchMessage(assistantId, (m) => ({
                  ...m,
                  thought: (m.thought || "") + text,
                  statusHint: "正在思考…",
                }));
              }
            },
            onToolCall: (call) => {
              if (!isCurrent()) return;
              useStudioStore.getState().patchMessage(assistantId, (m) => ({
                ...m,
                toolCalls: [...(m.toolCalls || []), { ...call, startedAt: Date.now() }],
              }));
            },
            onToolCallUpdate: (call) => {
              if (!isCurrent()) return;
              useStudioStore.getState().patchMessage(assistantId, (m) => {
                const calls = [...(m.toolCalls || [])];
                const index = calls.findIndex((item) => item.id === call.id);
                if (index < 0) calls.push({ ...call, startedAt: Date.now() } as any);
                else calls[index] = { ...calls[index], ...call } as any;
                return { ...m, toolCalls: calls };
              });
            },
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
                useStudioStore.getState().patchMessage(assistantId, (m) => ({ ...m, plan: entries }));
              }
            },
            onUsage: (usage) => {
              if (!isCurrent()) return;
              useStudioStore.getState().setUsage(usage);
              useStudioStore.getState().patchMessage(assistantId, { usage });
            },
            onAvailableCommands: (commands) => {
              if (isCurrent()) useStudioStore.getState().setAvailableCommands(commands);
            },
            onConfigOptions: (options) => {
              if (isCurrent()) useStudioStore.getState().setConfigOptions(options);
            },
            onConfigUpdate: (option) => {
              if (isCurrent()) useStudioStore.getState().patchConfigOption(option);
            },
            onReset: (reset) => {
              gap = true;
              // The server lost the requested prefix; clear the partial view
              // before replaying everything it still retains.
              if (isCurrent() && (reset.reason === "gap" || reset.reason === "ahead")) {
                useStudioStore.getState().patchMessage(assistantId, (m) => ({
                  ...m,
                  content: "",
                  thought: "",
                  toolCalls: [],
                }));
                lastSeq = Math.max(0, reset.firstSeq - 1);
                useStudioStore.getState().patchActiveTurn({ lastSeq });
              }
            },
            onDone: (_reason, response) => {
              if (isCurrent()) {
                const store = useStudioStore.getState();
                const usage = mergePromptUsage(store.messages.find(message => message.id === assistantId)?.usage, response);
                if (usage) {
                  store.setUsage(usage);
                  store.patchMessage(assistantId, { usage });
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
    if (isCurrent() && !terminal) {
      useStudioStore.getState().setStreaming(false);
      useStudioStore.getState().setBusy(false);
    }
  }
}

export function useTurnRecovery(): void {
  useEffect(() => {
    // Boot-only: a live send marks its turn in live-turns and owns the stream.
    const timer = setTimeout(() => {
      const st = useStudioStore.getState();
      const current = st.activeTurn;
      if (!current || current.status !== "running") return;
      if (isTurnLive(current.turnId) || started.has(current.turnId)) return;
      const assistantId =
        current.assistantId ||
        [...st.messages].reverse().find((message) => message.role === "assistant")?.id;
      if (!assistantId) {
        st.patchActiveTurn({ status: "interrupted" });
        st.snapshotThread();
        return;
      }
      started.add(current.turnId);
      void recoverActiveTurn(current, assistantId);
    }, 300);
    return () => clearTimeout(timer);
  }, []);
}
