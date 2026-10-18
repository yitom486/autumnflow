/// <reference types="vite/client" />

interface Window {
  acpStudio?: {
    platform: string;
    authMode?: "token" | "cookie";
    versions: Record<string, string | undefined>;
    getGatewayToken?: () => Promise<string>;
    openDirectory?: (opts?: { defaultPath?: string }) => Promise<string | null>;
    openPath?: (p: string) => Promise<void>;
    setTitleBarOverlay?: (opts: { color?: string; symbolColor?: string; height?: number }) => Promise<void>;
    minimize?: () => Promise<void>;
    maximize?: () => Promise<void>;
    close?: () => Promise<void>;
    isMaximized?: () => Promise<boolean>;
    updates?: {
      getInfo: () => Promise<AcpUpdateInfo>;
      check: () => Promise<void>;
      setAutoCheck: (v: boolean) => Promise<AcpUpdateInfo>;
      download: () => Promise<void>;
      install: () => Promise<void>;
      openReleases: () => Promise<void>;
      onEvent: (cb: (e: unknown) => void) => () => void;
    };
    workbench?: {
      newWindow: (cwd?: string) => Promise<void>;
      recentList: () => Promise<string[]>;
      recentAdd: (p: string) => Promise<string[]>;
      reveal: (p: string) => Promise<void>;
      copyText: (t: string) => Promise<void>;
      pathForFile?: (f: File) => string;
      onCommand: (cb: (id: string, payload?: unknown) => void) => () => void;
    };
  };
}

interface AcpUpdateInfo {
  version: string;
  enabled: boolean;
  isDev: boolean;
  canAutoInstall: boolean;
  autoCheck: boolean;
  lastChecked: number | null;
  platform: string;
}
