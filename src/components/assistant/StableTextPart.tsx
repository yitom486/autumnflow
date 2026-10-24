import React, { memo, useEffect, useLayoutEffect, useRef, useState, type PropsWithChildren } from "react";
import { TextMessagePartProvider, useAuiState, useMessagePartText } from "@assistant-ui/react";
import { activeKey, sessionOf, useStudioStore } from "@/stores/useStudioStore";

/** Keep the smoothing cursor attached to logical text, not its changing array index. */
export const StableTextPart = ({ children }: PropsWithChildren) => {
  const messageId = useAuiState((s) => s.message.id);
  const part = useMessagePartText();
  const partId = (part as { id?: string }).id ?? "body-0";
  const revealKey = `${messageId}:${partId}`;
  return (
    <StableTextScope key={revealKey} revealKey={revealKey} text={part.text} running={part.status.type === "running"}>
      {children}
    </StableTextScope>
  );
};

/**
 * 打字机的进度跟着会话走，不跟着组件走。
 *
 * assistant-ui 的 smooth 在挂载时从空串开始打。切走再切回一个还在流式输出的会话，
 * 正文组件是重新挂载的，已经输出的内容会从头再打一遍。这里在卸载时把"已经揭示到
 * 哪"记进会话；重挂时先把那一段当成已完成的文本交给 smooth（它就从这里起步），
 * 下一帧再交回真实的运行状态，只有离开期间新到的部分才接着打。
 */
const StableTextScope = memo(
  ({ revealKey, text, running, children }: PropsWithChildren<{ revealKey: string; text: string; running: boolean }>) => {
    const [resumeAt, setResumeAt] = useState<number | null>(() => {
      if (!running) return null;
      const revealed = sessionOf(useStudioStore.getState()).ui.revealed[revealKey];
      return revealed ? Math.min(revealed, text.length) : null;
    });
    const sessionKey = useRef(activeKey(useStudioStore.getState()));
    const latestText = useRef(text);
    latestText.current = text;

    useLayoutEffect(() => {
      if (resumeAt !== null) setResumeAt(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(
      () => () => {
        useStudioStore.getState().setRevealed(sessionKey.current, revealKey, latestText.current.length);
      },
      [revealKey]
    );

    const resuming = resumeAt !== null;
    return (
      <TextMessagePartProvider text={resuming ? text.slice(0, resumeAt) : text} isRunning={resuming ? false : running}>
        {children}
      </TextMessagePartProvider>
    );
  }
);
