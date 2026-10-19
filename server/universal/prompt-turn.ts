/**
 * One prompt turn: take the session lease, stream the prompt, settle it.
 *
 * ACP allows one prompt per session, and a turn outlives the HTTP stream that
 * started it (a closed window or dropped SSE must not cancel it). The turn
 * lifecycle therefore lives here: the lease table (`PromptLock`), the
 * cancel-on-abort wiring, and the first-turn compatibility blocks.
 *
 * Release is token-checked, so a cancelled turn can never free the lease of the
 * turn that replaced it.
 */
import * as acp from "@agentclientprotocol/sdk";
import { requestAgent, requireAgentCapability, sdkRequest } from "./acp-sdk";
import { PromptLock } from "./prompt-lock";
import { STUDIO_MCP_DISCOVERY_HINT } from "./studio-tool-guidance";
import type { SessionState } from "./session-state";
import type { StudioAgentResources } from "./studio-agent-resources";
import { studioSessions } from "./session-index";

/** SSE sink for one chat stream. */
export type PromptSink = (evt: Record<string, unknown>) => void;

export interface PromptTurnDeps {
  agentId: () => string;
  ensureConnection: () => acp.ClientConnection;
  init: () => acp.InitializeResponse | null;
  state: SessionState;
  subscribe: (sessionId: string, send: PromptSink) => () => void;
  resources: StudioAgentResources;
  /** Fail pending permissions/elicitations when a turn is cancelled. */
  onCancelPending: (sessionId: string) => void;
}

export class PromptTurn {
  /** The lease table is the turn lifecycle; nothing outside should mutate it. */
  private readonly lock = new PromptLock();

  constructor(private readonly deps: PromptTurnDeps) {}

  private get agentId(): string {
    return this.deps.agentId();
  }

  /** Sessions with a running turn; used by the active-work quit guard. */
  busySessions(): string[] {
    return this.lock.busySessions();
  }

  /** Agent process gone or disconnected: nothing on the wire can still be running. */
  reset(): void {
    this.lock.reset();
  }

  async cancel(sessionId: string): Promise<void> {
    const conn = this.deps.ensureConnection();
    if (!this.canCancel(sessionId)) throw acp.RequestError.invalidParams(undefined, "This child session did not permit cancellation");
    try {
      await conn.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    } catch (err) {
      console.error(`[UniversalACP:${this.agentId}] cancel notify failed session=${sessionId}: ${(err as Error).message}`);
      throw err;
    } finally {
      // Pre-empt rather than release: session/cancel is only a notification, so
      // the cancelled request is still pending. The UI may retry immediately;
      // the old turn's own release() is token-checked and becomes a no-op.
      if (sessionId) this.lock.preempt(sessionId);
    }
    // Unblock any pending permission for this session as cancelled
    this.deps.onCancelPending(sessionId);
  }

  canCancel(sessionId: string): boolean {
    return studioSessions.get(this.agentId, sessionId)?.kind !== "subagent" || this.deps.state.childStates.get(sessionId)?.capabilities?.cancel != null;
  }

  /**
   * Send session/prompt. Streams session/update via onEvent callback until stop.
   * Permission/elicitation requests are surfaced via onEvent as well; the
   * underlying agent request stays pending until UI responds.
   * Mutex: same sessionId concurrent prompt() throws 409.
   */
  async prompt(
    sessionId: string,
    prompt: acp.ContentBlock[],
    onEvent: PromptSink,
    opts?: { signal?: AbortSignal }
  ): Promise<unknown> {
    const conn = this.deps.ensureConnection();
    const supported = this.deps.init()?.agentCapabilities?.promptCapabilities;
    for (const block of prompt) {
      if (block.type === "image") requireAgentCapability("prompt.image", supported?.image);
      if (block.type === "audio") requireAgentCapability("prompt.audio", supported?.audio);
      if (block.type === "resource") requireAgentCapability("prompt.embeddedContext", supported?.embeddedContext);
    }
    if (!sessionId) throw new Error("sessionId is required");
    if (studioSessions.get(this.agentId, sessionId)?.kind === "subagent") throw new Error("子智能体会话仅供查看，请在主会话中发送消息");
    studioSessions.update(this.agentId, sessionId, { updatedAt: new Date().toISOString() });
    // Throws `session busy ... (409)` before any subscription is created.
    const lease = this.lock.acquire(sessionId);
    const unsub = this.deps.subscribe(sessionId, onEvent);
    let onAbort: (() => void) | undefined;
    try {
      if (opts?.signal) {
        onAbort = () => {
          this.cancel(sessionId).catch((err) => {
            console.error(`[UniversalACP:${this.agentId}] abort-cancel failed session=${sessionId}: ${(err as Error).message}`);
          });
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Verified native delivery keeps application rules out of user messages.
      // Unverified runtimes receive one explicitly marked compatibility block.
      const turnCount = this.deps.state.turnCounts.get(sessionId) ?? 0;
      this.deps.state.turnCounts.set(sessionId, turnCount + 1);

      let effectivePrompt = prompt;
      const compatibilityContext = this.deps.resources.compatibilityText(sessionId);
      const isOpencode = this.agentId === "opencode";
      const opencodeCompatibility = (isOpencode && turnCount === 0)
        ? "【OpenCode 交互指引】：客户端已通过官方 ACP SDK 声明并处理标准 elicitation 的 form 和 url 模式。只有运行时实际转发 elicitation/create，原生提问才能显示；若当前版本未转发或原生 question 已被禁用，请使用 show_interactive_card(cardType='decision') 或正文编号选项等待用户选择，不要重复调用失败的原生 question。\n" + STUDIO_MCP_DISCOVERY_HINT
        : null;

      const prefixBlocks: acp.ContentBlock[] = [];
      if (compatibilityContext) {
        prefixBlocks.push({ type: "text", text: compatibilityContext });
      }
      if (opencodeCompatibility) {
        prefixBlocks.push({ type: "text", text: opencodeCompatibility });
      }

      if (prefixBlocks.length > 0 && Array.isArray(prompt)) {
        effectivePrompt = [...prefixBlocks, ...prompt];
      }

      const res = await requestAgent(conn, acp.methods.agent.session.prompt, sdkRequest(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: effectivePrompt,
      }));
      return res;
    } finally {
      try {
        if (opts?.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
      } catch (err) {
        console.error(`[UniversalACP:${this.agentId}] abort listener cleanup failed: ${(err as Error).message}`);
      }
      this.lock.release(sessionId, lease);
      await new Promise((r) => setTimeout(r, 50));
      unsub();
    }
  }
}
