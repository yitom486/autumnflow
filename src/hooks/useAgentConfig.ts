import { reportError } from "@/lib/error-bus";
import { useCallback } from "react";
import { sessionOf, useStudioStore } from "@/stores/useStudioStore";
import {
  sessionRpc,
  sessionNew,
  connectAgent,
  findConfigOption,
  flattenConfigOptions,
  parseModelId,
  type AgentSummary,
} from "@/lib/universal-api";

export interface UseAgentConfigOptions {
  agentsRef: React.RefObject<AgentSummary[]>;
  ensureSession: (agentId?: string, force?: boolean) => Promise<string | null>;
}

/**
 * Agent configuration, model catalog & preferences controller hook.
 *
 * Responsibilities:
 * 1. applyDefaultConfigOptions: legacy key migration + model-first + options + mode/fallback restore.
 * 2. setSessionConfig: RPC session/set_config_option + rememberAgentConfig.
 * 3. handleFallbackModel: legacy set_model or config option delegation.
 * 4. handleApplyModel: apply catalog model + thinking effort level.
 * 5. handleDiscoverModels: throwaway session discovery.
 */
export function useAgentConfig({
  agentsRef,
  ensureSession,
}: UseAgentConfigOptions) {
  /** Auto-apply saved / default config options (zustand per-agent prefs, 兼容旧 key) */
  const applyDefaultConfigOptions = useCallback(
    async (agentId: string, sessionId: string) => {
      try {
        // 一次性迁移旧 key: acp_default_config_<agentId> -> zustand agentPrefs
        try {
          const legacyRaw = localStorage.getItem(`acp_default_config_${agentId}`);
          if (legacyRaw) {
            const legacy = JSON.parse(legacyRaw);
            if (legacy && typeof legacy === "object") {
              useStudioStore.getState().saveAgentPref(agentId, { configValues: legacy });
            }
            localStorage.removeItem(`acp_default_config_${agentId}`);
          }
        } catch (err) {
          // 最小 loud 化: 旧 key 迁移失败不阻断 (best-effort)，但留痕。
          console.debug("[App] 旧配置迁移失败 (已忽略):", err);
        }

        const pref = useStudioStore.getState().agentPrefs?.[agentId];
        const saved = pref?.configValues;
        if (!saved || typeof saved !== "object" || Object.keys(saved).length === 0) {
          // 无记忆时快照当前默认值，方便下次恢复
          try {
            const cur0 = useStudioStore.getState();
            const snap: Record<string, unknown> = {};
            for (const o of cur0.configOptions || []) {
              if (o?.id == null) continue;
              snap[o.id] = (o.currentValue as any)?.value ?? o.currentValue;
            }
            if (Object.keys(snap).length > 0) cur0.saveAgentPref(agentId, { configValues: snap });
            if (cur0.models?.currentModelId) cur0.saveAgentPref(agentId, { fallbackModelId: cur0.models.currentModelId });
            const modeId = sessionOf(cur0).modes?.currentModeId;
            if (modeId) cur0.saveAgentPref(agentId, { modeId });
          } catch (err) {
            // 最小 loud 化: 默认值快照失败不阻断，留痕即可。
            console.debug("[App] 配置默认值快照失败 (已忽略):", err);
          }
          return;
        }

        // First apply model if saved, so dynamic options (like effort/thinking) unlock in agent response
        const modelOptId =
          useStudioStore.getState().configOptions?.find((c) => c.id === "model")?.id || (saved.model !== undefined ? "model" : undefined);
        if (modelOptId && (saved as any).model !== undefined) {
          const opt = useStudioStore.getState().configOptions?.find((c) => c.id === modelOptId);
          const v = (saved as any).model;
          const flat = flattenConfigOptions(opt?.options);
          if (flat.length === 0 || flat.some((o) => o.value === String((v as any)?.value ?? v))) {
            const body = { sessionId, configId: modelOptId, value: (v as any)?.value ?? v };
            // best-effort 恢复单项: 失败返回 null 继续下一项，但留 debug 痕 (原逻辑不变)。
            const res: any = await sessionRpc(agentId, "set_config", body).catch((err) => {
              console.debug(`[App] 恢复 model 配置失败 (已忽略, ${String(modelOptId)}):`, err);
              return null;
            });
            if (res?.configOptions) useStudioStore.getState().setConfigOptions(res.configOptions);
            else if (Array.isArray(res)) useStudioStore.getState().setConfigOptions(res);
            else if (res) useStudioStore.getState().patchConfigOption({ ...(opt || { id: modelOptId }), currentValue: (v as any)?.value ?? v });
          }
        }

        // Then apply other options (e.g. effort, reasoning_effort, mode)
        for (const [k, v] of Object.entries(saved)) {
          if (k === "model") continue;
          const opt = useStudioStore.getState().configOptions?.find((c) => c.id === k);
          if (!opt) continue;
          const flat = flattenConfigOptions(opt.options);
          const vv = (v as any)?.value ?? v;
          if (flat.length > 0 && !flat.some((o) => o.value === String(vv))) continue;
          const curV = (opt.currentValue as any)?.value ?? opt.currentValue;
          const wantV = (v as any)?.value ?? v;
          if (String(curV ?? "") === String(wantV ?? "")) continue;
          const body =
            opt?.type === "boolean" || typeof wantV === "boolean"
              ? { sessionId, configId: k, type: "boolean", value: wantV }
              : { sessionId, configId: k, value: wantV };
          // 同上: 单项 best-effort，失败留痕后继续。
          const res: any = await sessionRpc(agentId, "set_config", body).catch((err) => {
            console.debug(`[App] 恢复配置项失败 (已忽略, ${String(k)}):`, err);
            return null;
          });
          if (res?.configOptions) useStudioStore.getState().setConfigOptions(res.configOptions);
          else if (Array.isArray(res)) useStudioStore.getState().setConfigOptions(res);
          else if (res) useStudioStore.getState().patchConfigOption({ ...(opt || { id: k }), currentValue: wantV });
        }

        // Restore fallback model highlight + mode (best-effort, loud-debug on failure)
        try {
          const stAfter = useStudioStore.getState();
          if (pref?.fallbackModelId && stAfter.models && stAfter.models.currentModelId !== pref.fallbackModelId) {
            const listed = (stAfter.models.availableModels || []).some((m) => m.modelId === pref.fallbackModelId);
            if (listed) stAfter.setModels({ ...stAfter.models, currentModelId: pref.fallbackModelId });
          }
          const modesAfter = sessionOf(stAfter).modes;
          if (pref?.modeId && modesAfter && modesAfter.currentModeId !== pref.modeId) {
            const avail = modesAfter.availableModes || [];
            if (avail.some((m) => m.id === pref.modeId)) {
              // best-effort mode 恢复: 失败留痕后继续 (原逻辑不变)。
              await sessionRpc(agentId, "set_mode", { sessionId, modeId: pref.modeId }).catch((err) => {
                console.debug(`[App] 恢复 mode 失败 (已忽略, ${String(pref.modeId)}):`, err);
                return null;
              });
              const sNow = useStudioStore.getState();
              const modesNow = sessionOf(sNow).modes;
              if (modesNow) sNow.setModes({ ...modesNow, currentModeId: pref.modeId });
            }
          }
        } catch (err) {
          console.debug("[App] 恢复 fallback model/mode 失败 (已忽略):", err);
        }
      } catch (err) {
        // 最小 loud 化: 整个自动恢复链失败不抛到上层 (保持原行为)，但留痕。
        console.debug("[App] applyDefaultConfigOptions 整体失败 (已忽略):", err);
      }
    },
    []
  );

  /** Shared session/set_config_option with correct select/boolean shapes. */
  const setSessionConfig = useCallback(
    async (configId: string, value: unknown) => {
      const st = useStudioStore.getState();
      const sid = st.sessionId || (await ensureSession());
      if (!sid) return false;
      try {
        const opt = useStudioStore.getState().configOptions?.find((c) => c.id === configId);
        const body: Record<string, unknown> =
          opt?.type === "boolean" || typeof value === "boolean"
            ? { sessionId: sid, configId, type: "boolean", value }
            : { sessionId: sid, configId, value };
        const res: any = await sessionRpc(st.activeAgentId, "set_config", body);
        const cur = useStudioStore.getState();
        if (res?.configOptions) cur.setConfigOptions(res.configOptions);
        else if (Array.isArray(res)) cur.setConfigOptions(res);
        else cur.patchConfigOption({ ...(opt || { id: configId }), currentValue: value });

        // Persist user preference for this agent (zustand per-agent prefs + localStorage)
        useStudioStore.getState().rememberAgentConfig(st.activeAgentId, configId, value);
        return true;
      } catch (e: any) {
        reportError("配置修改失败", e);
        return false;
      }
    },
    [ensureSession]
  );

  /** Fallback model switch for agents without a model config option. */
  const handleFallbackModel = useCallback(
    async (modelId: string) => {
      const st = useStudioStore.getState();
      const modelOpt = findConfigOption(st.configOptions, "model");
      if (modelOpt) {
        if (!await setSessionConfig(modelOpt.id, parseModelId(modelId).model)) return;
        useStudioStore.getState().saveAgentPref(st.activeAgentId, { fallbackModelId: modelId });
        return;
      }
      const sid = st.sessionId || (await ensureSession());
      if (!sid) return;
      try {
        // Legacy agy-style servers implement session/set_model directly.
        await sessionRpc(st.activeAgentId, "set_model", { sessionId: sid, modelId });
        const cur = useStudioStore.getState();
        if (cur.models) cur.setModels({ ...cur.models, currentModelId: modelId });
        cur.saveAgentPref(st.activeAgentId, { fallbackModelId: modelId });
      } catch (e: any) {
        reportError("切换模型失败", e);
      }
    },
    [ensureSession, setSessionConfig]
  );

  /** Apply a catalog modelId (e.g. "gpt-5.6-luna[xhigh]") + linked thinking level. */
  const handleApplyModel = useCallback(
    async (modelId: string) => {
      const st = useStudioStore.getState();
      const { model, effort } = parseModelId(modelId);
      const modelOpt = findConfigOption(st.configOptions, "model");
      if (!await setSessionConfig(modelOpt?.id || "model", model)) return;
      if (effort) {
        const cur = useStudioStore.getState();
        const thinkOpt = findConfigOption(cur.configOptions, "thinking");
        const flat = flattenConfigOptions(thinkOpt?.options);
        if (thinkOpt && flat.some((o) => o.value.toLowerCase() === effort.toLowerCase())) {
          if (!await setSessionConfig(thinkOpt.id, effort)) return;
        }
      }
      const cur2 = useStudioStore.getState();
      if (cur2.models) cur2.setModels({ ...cur2.models, currentModelId: modelId });
      cur2.saveAgentPref(st.activeAgentId, { fallbackModelId: modelId });
      cur2.setModelsOpen(false);
    },
    [setSessionConfig]
  );

  /** Re-discover the model catalog via a throwaway session (closed afterwards). */
  const handleDiscoverModels = useCallback(async () => {
    const st = useStudioStore.getState();
    if (st.discovering || sessionOf(st).running) return;
    const agentId = st.activeAgentId;
    st.setDiscovering(true);
    try {
      const known = agentsRef.current.find((a) => a.id === agentId)?.status?.connected;
      if (!known) await connectAgent(agentId);
      const res: any = await sessionNew(agentId, {});
      const cur = useStudioStore.getState();
      // Late discovery result after an agent switch: close the throwaway
      // session instead of leaking this agent's models into the new view.
      if (cur.activeAgentId !== agentId) {
        if (res?.sessionId) {
          await sessionRpc(agentId, "close", { sessionId: res.sessionId }).catch((err) =>
            console.debug("[App] 清理迟到的模型发现会话失败 (已忽略):", err)
          );
        }
        return;
      }
      if (res?.models) {
        cur.setModels(res.models);
        if (!cur.sessionId) cur.applySessionResult(res, agentId);
      }
      if (res?.sessionId && res.sessionId !== useStudioStore.getState().sessionId) {
        // 可预期清理失败 (一次性会话已关/已失效) 允许忽略，但留 debug 痕。
        await sessionRpc(agentId, "close", { sessionId: res.sessionId }).catch((err) =>
          console.debug("[App] 清理一次性发现会话失败 (已忽略):", err)
        );
      }
      cur.setAuthOk(agentId, true);
    } catch (e: any) {
      reportError("发现模型失败", e);
    } finally {
      useStudioStore.getState().setDiscovering(false);
    }
  }, [agentsRef]);

  return {
    applyDefaultConfigOptions,
    setSessionConfig,
    handleFallbackModel,
    handleApplyModel,
    handleDiscoverModels,
  };
}
