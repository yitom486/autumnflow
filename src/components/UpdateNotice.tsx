import React, { useEffect } from "react";
import { Download, RotateCw, X, ExternalLink, CheckCircle2, Info } from "lucide-react";
import { useUpdateStore, startUpdateBridge } from "@/stores/useUpdateStore";
import { useWorkbenchStore } from "@/stores/useWorkbenchStore";

/**
 * 右下角更新 toast（前台）。窗口在后台时主进程另发系统通知。
 * 发现新版 → [更新] 后台下载 → [重启并更新]；手动检查无新版 → “已是最新版本”，几秒后自动消失。
 */
export const UpdateNotice: React.FC = () => {
  const state = useUpdateStore((s) => s.state);
  const dispatch = useUpdateStore((s) => s.dispatch);
  const check = useUpdateStore((s) => s.check);
  const api = typeof window !== "undefined" ? window.autumnflow?.updates : undefined;

  useEffect(() => startUpdateBridge(), []);
  useEffect(() => {
    if ((state.phase === "up-to-date" && state.manual) || state.phase === "disabled") {
      const t = setTimeout(() => dispatch({ type: "dismiss" }), 4000);
      return () => clearTimeout(t);
    }
  }, [state, dispatch]);

  const card = (children: React.ReactNode) => (
    <div role="status" className="fixed bottom-4 right-4 z-[90] w-80 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
      {children}
    </div>
  );
  const close = (
    <button aria-label="关闭" className="text-muted-foreground hover:text-foreground" onClick={() => dispatch({ type: "dismiss" })}>
      <X className="h-3.5 w-3.5" />
    </button>
  );
  const btn = "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-accent transition-colors";
  const primary = "inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-primary-foreground hover:opacity-90";
  const openAbout = () => useWorkbenchStore.getState().openSettings("about");

  switch (state.phase) {
    case "up-to-date":
      if (!state.manual) return null;
      return card(
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <div className="flex-1">
            <div className="font-medium">已是最新版本</div>
            <div className="text-muted-foreground">AutumnFlow {state.version} 是当前最新的正式版。</div>
          </div>
          {close}
        </div>,
      );
    case "disabled":
      return card(
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="flex-1">
            <div className="font-medium">开发版不检查更新</div>
            <div className="text-muted-foreground">只有安装包版本会从 GitHub Releases 自动更新。</div>
          </div>
          {close}
        </div>,
      );
    case "available":
      if (state.dismissed) return null;
      return card(
        <>
          <div className="mb-2 flex items-start justify-between">
            <span className="font-medium">有新版本 {state.version}</span>
            {close}
          </div>
          <div className="flex gap-2">
            {state.canAutoInstall ? (
              <button className={primary} onClick={() => { dispatch({ type: "download-requested" }); void api?.download(); }}>
                <Download className="h-3.5 w-3.5" /> 更新
              </button>
            ) : (
              <button className={primary} onClick={() => void api?.openReleases()}>
                <ExternalLink className="h-3.5 w-3.5" /> 前往下载
              </button>
            )}
            <button className={btn} onClick={openAbout}>详情</button>
          </div>
        </>,
      );
    case "downloading":
      return card(
        <>
          <div className="mb-2">正在下载 {state.version}… {state.percent}%</div>
          <div className="h-1 w-full overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-[width]" style={{ width: `${state.percent}%` }} />
          </div>
        </>,
      );
    case "ready":
      if (state.dismissed) return null;
      return card(
        <>
          <div className="mb-1 flex items-start justify-between">
            <span className="font-medium">{state.version} 已就绪</span>
            {close}
          </div>
          <div className="mb-2 text-muted-foreground">重启即可完成更新；不重启也会在下次打开时自动安装。</div>
          <button className={primary} onClick={() => void api?.install()}>
            <RotateCw className="h-3.5 w-3.5" /> 重启并更新
          </button>
        </>,
      );
    case "error":
      return card(
        <>
          <div className="mb-1 flex items-start justify-between">
            <span className="font-medium">检查更新失败</span>
            {close}
          </div>
          <div className="mb-2 break-words text-muted-foreground">{state.message}</div>
          <div className="flex gap-2">
            <button className={btn} onClick={() => void check()}>重试</button>
            <button className={btn} onClick={() => void api?.openReleases()}>手动下载</button>
          </div>
        </>,
      );
    default:
      return null;
  }
};
