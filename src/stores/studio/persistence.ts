import type { ConfigOptionLike, ModelCatalog } from "@/lib/universal-api";
import type { AgentPrefs } from "./types";

/* localStorage-backed memory of the studio: per-agent prefs, last agent, model catalogs. */

const AGENT_PREFS_KEY = "acp_agent_prefs_v1";

export function loadAgentPrefs(): Record<string, AgentPrefs> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(AGENT_PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, AgentPrefs>;
    }
    return {};
  } catch {
    return {};
  }
}

export function persistAgentPrefs(prefs: Record<string, AgentPrefs>) {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(AGENT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // ignore storage errors (private mode / quota)
  }
}


const ACTIVE_AGENT_KEY = "acp_active_agent_id_v1";

export function loadInitialActiveAgentId(): string {
  try {
    if (typeof window !== "undefined" && window.location?.search) {
      const p = new URLSearchParams(window.location.search).get("agent");
      if (p && p.trim()) return p.trim();
    }
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(ACTIVE_AGENT_KEY);
      if (saved && typeof saved === "string" && saved.trim()) {
        return saved.trim();
      }
    }
    return "codex";
  } catch {
    return "codex";
  }
}

export function persistActiveAgentId(id: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ACTIVE_AGENT_KEY, id);
  } catch {
    // ignore storage errors
  }
}

/**
 * Last-known model catalog per agent. OpenCode builds its provider/model list
 * lazily on the first session/new after process start (measured ~6s on this
 * machine, ~0.4s once warm). Hydrating this cache makes the model picker
 * usable immediately; session/new still refreshes it in the background.
 */
const MODEL_CATALOG_KEY = "acp_model_catalog_v1";
export interface CachedModelCatalog {
  models: ModelCatalog | null;
  configOptions: ConfigOptionLike[] | null;
  at: number;
}

export function readCachedCatalog(agentId: string): CachedModelCatalog | null {
  try {
    if (typeof localStorage === "undefined" || !agentId) return null;
    const all = JSON.parse(localStorage.getItem(MODEL_CATALOG_KEY) || "{}") as Record<string, CachedModelCatalog>;
    const row = all?.[agentId];
    if (!row || typeof row !== "object") return null;
    if (row.models !== null && typeof row.models !== "object") return null;
    if (row.configOptions !== null && !Array.isArray(row.configOptions)) return null;
    return row;
  } catch (err) {
    console.debug("[Studio] 读取模型目录缓存失败 (已忽略):", err);
    return null;
  }
}

export function saveCachedCatalog(agentId: string, models: ModelCatalog | null, configOptions: ConfigOptionLike[] | null): void {
  try {
    if (typeof localStorage === "undefined" || !agentId) return;
    const all = JSON.parse(localStorage.getItem(MODEL_CATALOG_KEY) || "{}") as Record<string, CachedModelCatalog>;
    all[agentId] = { models, configOptions, at: Date.now() };
    // Bound the cache to the most recent agents so it cannot grow unbounded.
    const rows = Object.entries(all).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 8);
    localStorage.setItem(MODEL_CATALOG_KEY, JSON.stringify(Object.fromEntries(rows)));
  } catch (err) {
    console.debug("[Studio] 写入模型目录缓存失败 (已忽略):", err);
  }
}
