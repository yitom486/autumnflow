import React, { memo, type PropsWithChildren } from "react";
import { TextMessagePartProvider, useAuiState, useMessagePartText } from "@assistant-ui/react";

/** Keep the smoothing cursor attached to logical text, not its changing array index. */
export const StableTextPart = ({ children }: PropsWithChildren) => {
  const messageId = useAuiState((s) => s.message.id);
  const part = useMessagePartText();
  const partId = (part as { id?: string }).id ?? "body-0";
  return (
    <StableTextScope key={`${messageId}:${partId}`} text={part.text} running={part.status.type === "running"}>
      {children}
    </StableTextScope>
  );
};

const StableTextScope = memo(({ text, running, children }: PropsWithChildren<{ text: string; running: boolean }>) => (
  <TextMessagePartProvider text={text} isRunning={running}>
    {children}
  </TextMessagePartProvider>
));
