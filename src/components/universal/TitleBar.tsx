import { AppMenuBar } from "@/components/workbench/AppMenuBar";
import React, { useState, useRef, useEffect } from "react";
import {
  Moon,
  MoonStar,
  CloudMoon,
  Sun,
  ChevronDown,
  Check,
  Minus,
  Square,
  Copy,
  X,
} from "lucide-react";
import { useThemeStore, THEMES, type ThemeId } from "@/stores/useThemeStore";

export const TitleBar: React.FC = () => {
  const { theme, setTheme } = useThemeStore();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  const isElectron = typeof window !== "undefined" && Boolean(window.autumnflow);
  const platform = typeof window !== "undefined" ? window.autumnflow?.platform : "web";
  const isMac = platform === "darwin";

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (isElectron && window.autumnflow?.isMaximized) {
      window.autumnflow.isMaximized().then(setIsMaximized).catch(() => {});
    }
  }, [isElectron]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    if (themeMenuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [themeMenuOpen]);

  const currentThemeMeta = THEMES[theme] || THEMES.dark;

  const getThemeIcon = (id: ThemeId) => {
    switch (id) {
      case "oled":
        return <MoonStar className="w-3.5 h-3.5 shrink-0" />;
      case "dark":
        return <Moon className="w-3.5 h-3.5 shrink-0" />;
      case "dim":
        return <CloudMoon className="w-3.5 h-3.5 shrink-0" />;
      case "light":
        return <Sun className="w-3.5 h-3.5 shrink-0" />;
    }
  };

  const handleMinimize = () => window.autumnflow?.minimize?.();
  const handleMaximize = async () => {
    await window.autumnflow?.maximize?.();
    if (window.autumnflow?.isMaximized) {
      const max = await window.autumnflow.isMaximized();
      setIsMaximized(max);
    }
  };
  const handleClose = () => window.autumnflow?.close?.();

  return (
    <div
      className={`h-[32px] border-b border-[hsl(var(--titlebar-border))] bg-[hsl(var(--titlebar-bg))] text-foreground flex items-center justify-between select-none app-drag shrink-0 z-30 transition-colors ${
        isMac ? "pl-[76px] pr-3" : isElectron ? "pl-3 pr-0" : "px-3"
      }`}
    >
      {/* LEFT: Window Icon + Brand Title */}
      <div className="flex items-center gap-2 app-no-drag shrink-0">
        <img
          src="/icons/icon-64.png"
          alt="AutumnFlow"
          className="w-4 h-4 object-contain shrink-0"
        />
        <span className="font-medium text-[12px] text-foreground/80">
          AutumnFlow
        </span>
        {!isMac && <AppMenuBar />}
      </div>

      {/* CENTER: Clean Draggable Window Area (Double Click to Maximize/Restore) */}
      <div
        className="flex-1 h-full app-drag cursor-default"
        onDoubleClick={isElectron ? handleMaximize : undefined}
      />

      {/* RIGHT: Theme & Window Controls */}
      <div className="flex items-center app-no-drag shrink-0 h-full">
        <div className="flex items-center gap-1 pr-2">
          <button
            type="button"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            title={`切换深色 / 浅色（当前：${currentThemeMeta.name}）`}
            className="h-6 w-6 rounded-md hover:bg-muted/80 text-muted-foreground hover:text-foreground flex items-center justify-center transition-colors"
          >
            {theme === "light" ? (
              <Sun className="w-3.5 h-3.5" />
            ) : (
              <Moon className="w-3.5 h-3.5" />
            )}
          </button>

          <div className="relative" ref={themeMenuRef}>
            <button
              type="button"
              onClick={() => setThemeMenuOpen(!themeMenuOpen)}
              title="选择主题"
              className="h-6 px-2 rounded-md hover:bg-muted/80 text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-[11px] font-medium transition-colors border border-transparent hover:border-border/60"
            >
              <span className="text-[11px] font-medium">{currentThemeMeta.name}</span>
              <ChevronDown className="w-3 h-3 text-muted-foreground/60" />
            </button>

            {themeMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-60 rounded-lg border border-border bg-popover p-1 shadow-lg text-xs z-50 space-y-0.5">
                <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground flex items-center justify-between">
                  <span>主题</span>
                </div>

                {(Object.keys(THEMES) as ThemeId[]).map((id) => {
                  const item = THEMES[id];
                  const active = theme === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setTheme(id);
                        setThemeMenuOpen(false);
                      }}
                      className={`w-full flex items-start gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer ${
                        active
                          ? "bg-accent text-foreground font-medium"
                          : "hover:bg-muted/70 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="mt-0.5 shrink-0">{getThemeIcon(id)}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold">{item.name}</span>
                          <span className="text-[10px] font-mono opacity-60">{item.badge}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
                          {item.description}
                        </p>
                      </div>
                      {active && <Check className="w-3.5 h-3.5 text-foreground shrink-0 mt-1" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Unified Pure-Frontend Window Controls (Windows & Linux Electron) */}
        {isElectron && !isMac && (
          <div className="flex items-center h-full border-l border-border/50">
            <button
              type="button"
              onClick={handleMinimize}
              title="最小化"
              className="h-[32px] w-[46px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/80 active:bg-muted transition-colors cursor-pointer"
            >
              <Minus className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleMaximize}
              title={isMaximized ? "向下还原" : "最大化"}
              className="h-[32px] w-[46px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/80 active:bg-muted transition-colors cursor-pointer"
            >
              {isMaximized ? <Copy className="w-3 h-3" /> : <Square className="w-3 h-3" />}
            </button>
            <button
              type="button"
              onClick={handleClose}
              title="关闭"
              className="h-[32px] w-[46px] flex items-center justify-center text-muted-foreground hover:text-white hover:bg-[#e81123] active:bg-[#c4101e] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
