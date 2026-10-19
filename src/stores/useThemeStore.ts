import { create } from "zustand";

export type ThemeId = "dark" | "oled" | "dim" | "light";

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  description: string;
  badge: string;
  overlayColor: string;
  overlaySymbolColor: string;
  isDark: boolean;
}

export const THEMES: Record<ThemeId, ThemeMeta> = {
  dark: {
    id: "dark",
    name: "深色",
    description: "默认。中性深灰底色（vercel 配色，底色抬亮到 7%）",
    badge: "Dark",
    overlayColor: "#171717",
    overlaySymbolColor: "#a5a5a5",
    isDark: true,
  },
  oled: {
    id: "oled",
    name: "纯黑",
    description: "纯黑底色，适合 OLED 屏幕",
    badge: "OLED",
    overlayColor: "#080808",
    overlaySymbolColor: "#a5a5a5",
    isDark: true,
  },
  dim: {
    id: "dim",
    name: "暗灰",
    description: "中灰底色，对比更柔和，适合长时间使用",
    badge: "Dim",
    overlayColor: "#202020",
    overlaySymbolColor: "#b0b0b0",
    isDark: true,
  },
  light: {
    id: "light",
    name: "浅色",
    description: "近白底色，适合白天和投屏",
    badge: "Light",
    overlayColor: "#fcfcfc",
    overlaySymbolColor: "#525252",
    isDark: false,
  },
};

const THEME_STORAGE_KEY = "autumnflow_theme_v1";
const LEGACY_THEME_STORAGE_KEY = "acp_studio_theme_v1";

function getInitialTheme(): ThemeId {
  try {
    if (typeof localStorage !== "undefined") {
      const saved = (localStorage.getItem(THEME_STORAGE_KEY) ||
        localStorage.getItem(LEGACY_THEME_STORAGE_KEY)) as ThemeId | null;
      if (saved && saved in THEMES) {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, saved);
          localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
        } catch {
          // best effort
        }
        return saved;
      }
    }
  } catch {
    // fallback
  }
  return "dark";
}

function syncTitleBarOverlay(color: string, symbolColor: string) {
  if (typeof window === "undefined") return;
  const apply = () => {
    if (window.acpStudio?.setTitleBarOverlay) {
      window.acpStudio.setTitleBarOverlay({
        color,
        symbolColor,
        height: 32,
      }).catch(() => {});
    }
  };
  apply();
  // Retry on next tick in case bridge exposes just after script execution
  if (typeof setTimeout !== "undefined") {
    setTimeout(apply, 100);
  }
}

function setThemeAttributes(meta: ThemeMeta) {
  const root = document.documentElement;
  root.setAttribute("data-theme", meta.id);
  // Tailwind darkMode: "class"
  root.classList.toggle("dark", meta.isDark);
  root.classList.toggle("light", !meta.isDark);
  syncTitleBarOverlay(meta.overlayColor, meta.overlaySymbolColor);
}

/** 浏览器支持 View Transitions 且用户没开“减少动态效果”时才做交叉淡化。 */
export function canAnimateThemeSwitch(doc: Document = document, win: Window = window): boolean {
  if (typeof (doc as any).startViewTransition !== "function") return false;
  try {
    return !win.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/**
 * 应用主题。用户切换时：
 * - 根节点加 .theme-transitioning，关掉所有元素自身过渡（只在切换这一刻）；
 * - 支持 View Transitions 则整页交叉淡化一次（时长取 --theme-transition-duration）；
 * - 不支持 / 减少动态效果 → 直接瞬间切换。
 */
function applyThemeToDOM(themeId: ThemeId, isUserSwitch = false) {
  if (typeof document === "undefined") return;
  const meta = THEMES[themeId] || THEMES.dark;
  const root = document.documentElement;
  if (!isUserSwitch) {
    setThemeAttributes(meta);
    return;
  }
  root.classList.add("theme-transitioning");
  const cleanup = () => {
    // 等新样式落地一帧后再恢复过渡，避免恢复瞬间又触发颜色过渡
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-transitioning")));
  };
  if (canAnimateThemeSwitch()) {
    try {
      const vt = (document as any).startViewTransition(() => setThemeAttributes(meta));
      vt.finished.finally(cleanup);
      return;
    } catch {
      // 落到瞬间切换
    }
  }
  setThemeAttributes(meta);
  cleanup();
}

// Immediately apply theme on script load (cold boot: no animation to avoid flicker)
if (typeof document !== "undefined") {
  applyThemeToDOM(getInitialTheme(), false);
}

interface ThemeState {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  initTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: getInitialTheme(),
  setTheme: (newTheme: ThemeId) => {
    if (!THEMES[newTheme]) return;
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(THEME_STORAGE_KEY, newTheme);
      }
    } catch {}
    // User triggered theme toggle: trigger synchronized smooth transition
    applyThemeToDOM(newTheme, true);
    set({ theme: newTheme });
  },
  initTheme: () => {
    const current = get().theme;
    applyThemeToDOM(current, false);
  },
}));
