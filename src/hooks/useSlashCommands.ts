import { useCallback, useEffect } from "react";
import { sessionOf, useStudioStore } from "@/stores/useStudioStore";
import { sessionRpc } from "@/lib/universal-api";
import { parseLocalCommand, resolveMode, mergeCommands } from "@/lib/slash-commands";

const sys = (content: string) =>
  useStudioStore.getState().appendMessage({ id: `sys-${Date.now()}-slash`, role: "system", content, timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) } as never);

/**
 * Slash commands:
 * - `runLocal(text)` handles built-in local commands client-side (never sent
 *   to the agent); returns true when consumed.
 * - When a session becomes active without commands, ask the gateway once for
 *   the cached available_commands_update (agents often push it right after
 *   session/new|load|resume, before any stream is subscribed).
 */
export function useSlashCommands() {
  const sessionId = useStudioStore((s) => s.sessionId);
  const agentId = useStudioStore((s) => s.activeAgentId);

  useEffect(() => {
    if (!sessionId || !agentId) return;
    let cancelled = false;
    const tryFetch = async () => {
      const st = useStudioStore.getState();
      if (cancelled || st.sessionId !== sessionId || st.availableCommands.length > 0) return;
      try {
        const r: any = await sessionRpc(agentId, "commands", { sessionId });
        if (!cancelled && Array.isArray(r?.availableCommands)) {
          useStudioStore.getState().setAvailableCommands(r.availableCommands, sessionId);
        }
      } catch {
        /* older gateway / agent not connected: ignore */
      }
    };
    const t1 = setTimeout(tryFetch, 400);
    const t2 = setTimeout(tryFetch, 2500);
    return () => {
      cancelled = true;
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [sessionId, agentId]);

  const runLocal = useCallback((text: string): boolean => {
    const st = useStudioStore.getState();
    const cmd = parseLocalCommand(text, st.availableCommands);
    if (!cmd) return false;
    if (cmd.name === "clear") {
      if (sessionOf(st).running) sys("生成中无法清空，请先停止。");
      else st.setMessages([]);
      return true;
    }
    if (cmd.name === "mode") {
      const modes = sessionOf(st).modes?.availableModes || [];
      if (!modes.length) {
        sys("/mode：该会话没有可切换的模式。");
        return true;
      }
      const target = resolveMode(cmd.arg, modes);
      if (!target) {
        const list = modes.map((m) => `\`${m.id}\`${m.name && m.name !== m.id ? `（${m.name}）` : ""}${m.id === sessionOf(st).modes?.currentModeId ? " ← 当前" : ""}`).join("、");
        sys(`${cmd.arg ? `未找到模式「${cmd.arg}」。` : ""}可用模式：${list}。用法：/mode <模式>`);
        return true;
      }
      const sid = st.sessionId;
      if (!sid) {
        sys("/mode：尚未建立会话。");
        return true;
      }
      void sessionRpc(st.activeAgentId, "set_mode", { sessionId: sid, modeId: target.id })
        .then(() => {
          const now = useStudioStore.getState();
          const modesNow = sessionOf(now).modes;
          if (modesNow) now.setModes({ ...modesNow, currentModeId: target.id });
          now.saveAgentPref(now.activeAgentId, { modeId: target.id });
          sys(`已切换到模式 ${target.name || target.id}。`);
        })
        .catch((e: Error) => sys(`切换模式失败：${e.message}`));
      return true;
    }
    if (cmd.name === "help") {
      const all = mergeCommands(st.availableCommands);
      sys(
        all.length
          ? all.map((c) => `- \`/${c.name}${c.hint ? ` <${c.hint}>` : ""}\`${c.local ? "（本地）" : ""} ${c.description || ""}`).join("\n")
          : "该智能体暂未提供命令。",
      );
      return true;
    }
    return false;
  }, []);

  return { runLocal };
}
