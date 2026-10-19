import React, { useEffect } from "react";
import { X, Settings2, Info, RefreshCw, Download, RotateCw, ExternalLink, CheckCircle2, AlertTriangle, FolderOpen, Copy, Server } from "lucide-react";
import { useWorkbenchStore, type SettingsTab } from "@/stores/useWorkbenchStore";
import { useUpdateStore } from "@/stores/useUpdateStore";
import { useThemeStore, THEMES, type ThemeId } from "@/stores/useThemeStore";
import { useStudioStore } from "@/stores/useStudioStore";
import { getGatewayBase, getGatewayToken, isCookieAuth, isLoopbackBase, setGatewayBase, setGatewayToken, verifyGatewayToken } from "@/lib/gateway-auth";
import { cn } from "@/lib/utils";

const CHANGELOG_URL = "https://github.com/yitom486/autumnflow/blob/master/CHANGELOG.md";

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "从未";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }> = ({ checked, onChange, disabled, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border transition-colors disabled:opacity-50",
      checked ? "bg-primary" : "bg-muted",
    )}
  >
    <span className={cn("inline-block h-3.5 w-3.5 rounded-full bg-background shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-[2px]")} />
  </button>
);

const Row: React.FC<{ title: string; desc?: React.ReactNode; children?: React.ReactNode }> = ({ title, desc, children }) => (
  <div className="flex items-center justify-between gap-6 py-3 border-b border-border/70 last:border-0">
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-foreground">{title}</div>
      {desc && <div className="mt-0.5 text-xs text-muted-foreground">{desc}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

const btn = "inline-flex items-center gap-1.5 h-8 px-3 rounded-md border border-border text-xs font-medium hover:bg-accent transition-colors disabled:opacity-50";
const primary = "inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-50";

const GeneralPanel: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const cwd = useStudioStore((s) => s.currentWorkspace);
  const wb = window.autumnflow?.workbench;
  const fileTreeOpen = useWorkbenchStore((s) => s.fileTreeOpen);
  const setFileTreeOpen = useWorkbenchStore((s) => s.setFileTreeOpen);
  return (
    <div>
      <h3 className="text-sm font-semibold mb-1">外观</h3>
      <Row title="主题" desc="深色 / 黑 / 柔和 / 浅色，切换时整页淡入淡出。">
        <select
          value={theme}
          onChange={(e) => setTheme(e.target.value as ThemeId)}
          className="h-8 rounded-md border border-border bg-background px-2 text-xs"
          aria-label="主题"
        >
          {(Object.keys(THEMES) as ThemeId[]).map((id) => (
            <option key={id} value={id}>{THEMES[id].name}</option>
          ))}
        </select>
      </Row>
      <Row title="显示文件树" desc="快捷键 Ctrl/⌘+Shift+E">
        <Switch checked={fileTreeOpen} onChange={setFileTreeOpen} label="显示文件树" />
      </Row>
      <h3 className="text-sm font-semibold mt-5 mb-1">工作区</h3>
      <Row title="当前窗口的工作区" desc={<span className="font-mono break-all">{cwd || "未选择"}</span>}>
        <div className="flex gap-2">
          <button className={btn} disabled={!cwd || !wb} onClick={() => cwd && wb?.reveal(cwd)} title="在文件管理器中显示">
            <FolderOpen className="h-3.5 w-3.5" /> 显示
          </button>
          <button className={btn} disabled={!cwd} onClick={() => cwd && (wb ? wb.copyText(cwd) : navigator.clipboard.writeText(cwd))} title="复制路径">
            <Copy className="h-3.5 w-3.5" /> 复制
          </button>
        </div>
      </Row>
    </div>
  );
};

const GatewayPanel: React.FC = () => {
  const [baseInput, setBaseInput] = React.useState(getGatewayBase());
  const [tokenInput, setTokenInput] = React.useState("");
  const [msg, setMsg] = React.useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const cur = getGatewayBase();
  const say = (kind: "ok" | "err", text: string) => setMsg({ kind, text });

  const saveBase = () => {
    const p = setGatewayBase(baseInput);
    if (p.kind === "invalid") {
      say("err", p.error);
      return;
    }
    const next = p.kind === "remote" ? p.base : "";
    if (next === cur) {
      say("ok", next ? "基址未变，已是该网关。" : "已是本地同源网关。");
      return;
    }
    // 会话/智能体状态归属网关，不跨网关迁移：切基址即重载，不悄悄混用。
    window.location.reload();
  };

  const saveToken = async () => {
    const t = tokenInput.trim();
    if (!t) {
      say("err", "先粘贴该网关的令牌（其本机 ~/.autumnflow/.gateway-token）。");
      return;
    }
    setBusy(true);
    setGatewayToken(t);
    setTokenInput("");
    const st = await verifyGatewayToken();
    setBusy(false);
    say(
      st === "ok" ? "ok" : "err",
      st === "ok"
        ? "令牌有效，已连上该网关。"
        : st === "unauthorized"
          ? "令牌被拒（401）：确认复制的是该网关自己的完整令牌。"
          : "连不上该网关：确认它已启动且地址可达。",
    );
  };

  const checkNow = async () => {
    setBusy(true);
    const st = await verifyGatewayToken();
    setBusy(false);
    say(
      st === "ok" ? "ok" : "err",
      st === "ok" ? "连接正常。" : st === "unauthorized" ? "已连通但令牌被拒，请重输令牌。" : "不可达：网关没起或地址不通。",
    );
  };

  return (
    <div>
      <h3 className="text-sm font-semibold mb-1">网关</h3>
      <Row
        title="当前网关"
        desc={
          <span className="font-mono break-all">
            {cur || "本地同源（Electron 内置 / 同源网关）"}
          </span>
        }
      >
        <div className="flex gap-2">
          <button className={btn} onClick={() => void checkNow()} disabled={busy}>
            <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} /> 验证连接
          </button>
          {cur ? (
            <button
              className={btn}
              onClick={() => {
                setGatewayBase("");
                window.location.reload();
              }}
            >
              回到本地
            </button>
          ) : null}
        </div>
      </Row>
      <Row
        title="自定义基址"
        desc="WSL/远端网关地址，如 http://127.0.0.1:4004。留空即本地。保存后自动重载页面。"
      >
        <div className="flex gap-2">
          <input
            value={baseInput}
            onChange={(e) => setBaseInput(e.target.value)}
            placeholder="http://127.0.0.1:4004（空=本地）"
            spellCheck={false}
            className="h-8 w-56 rounded-md border border-border bg-background px-2 font-mono text-xs"
            aria-label="网关基址"
          />
          <button className={primary} onClick={saveBase}>
            保存
          </button>
        </div>
      </Row>
      <Row
        title="该网关的令牌"
        desc={
          isCookieAuth()
            ? "桌面网关使用 HttpOnly SameSite=Strict 会话 Cookie，页面 JS 无需持有令牌。"
            : getGatewayToken()
              ? "已设置（按基址隔离保存，不回显）。"
              : "未设置：粘贴该网关本机 ~/.autumnflow/.gateway-token。"
        }
      >
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="粘贴 64 位令牌"
            spellCheck={false}
            className="h-8 w-56 rounded-md border border-border bg-background px-2 font-mono text-xs"
            aria-label="网关令牌"
          />
          <button className={btn} onClick={() => void saveToken()} disabled={busy || !tokenInput.trim()}>
            保存并验证
          </button>
        </div>
      </Row>
      {msg ? (
        <div className={cn("mt-3 text-xs", msg.kind === "ok" ? "text-foreground" : "text-destructive")}>{msg.text}</div>
      ) : null}
      {cur && !isLoopbackBase(cur) ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          非回环 http 网关：令牌明文出本机，局域网可嗅探。只在可信网络用，公网请走 https 或 SSH 转发。
        </div>
      ) : null}
      <h3 className="text-sm font-semibold mt-5 mb-1">网关跑进 WSL（原生 Linux agent/工具）</h3>
      <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
{`# 1. WSL 内（Ubuntu）：进仓库目录，装好 bun，起网关（高位端口 13005，避开常用端口）
PORT=13005 bun run dev:server:node
# 2. 拿 WSL 里 ~/.autumnflow/.gateway-token 的内容
# 3. 本页基址填 http://127.0.0.1:13005，保存（自动重载），再贴令牌
# 4. 工作区直接用 Linux 路径，如 /home/you/proj`}
      </pre>
    </div>
  );
};

export const AboutPanel: React.FC = () => {
  const { state, info, check, setAutoCheck, refreshInfo } = useUpdateStore();
  const api = window.autumnflow?.updates;
  useEffect(() => {
    void refreshInfo();
  }, [refreshInfo]);
  const dev = !info || info.isDev || !info.enabled;
  const checking = state.phase === "checking";

  let status: React.ReactNode;
  switch (state.phase) {
    case "checking":
      status = <span className="inline-flex items-center gap-1.5"><RefreshCw className="h-3.5 w-3.5 animate-spin" />正在检查更新…</span>;
      break;
    case "up-to-date":
      status = <span className="inline-flex items-center gap-1.5 text-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-success" />已是最新版本</span>;
      break;
    case "available":
      status = <span className="text-foreground">有新版本 <b>{state.version}</b> 可以更新</span>;
      break;
    case "downloading":
      status = (
        <div className="w-64">
          <div className="mb-1.5">正在下载 {state.version}… {state.percent}%</div>
          <div className="h-1 rounded bg-muted overflow-hidden"><div className="h-full bg-primary transition-[width]" style={{ width: `${state.percent}%` }} /></div>
        </div>
      );
      break;
    case "ready":
      status = <span className="text-foreground">{state.version} 已下载，重启即可完成更新</span>;
      break;
    case "error":
      status = <span className="inline-flex items-center gap-1.5 text-destructive"><AlertTriangle className="h-3.5 w-3.5" />{state.message}</span>;
      break;
    default:
      status = dev ? "开发版不检查更新" : "尚未检查";
  }

  return (
    <div>
      <div className="flex items-center gap-4 pb-5 border-b border-border/70">
        <img src="/icon.png" alt="" className="h-14 w-14 rounded-xl border border-border bg-muted p-2" />
        <div>
          <div className="text-lg font-semibold tracking-tight">AutumnFlow</div>
          <div className="text-xs text-muted-foreground font-mono">
            版本 {info?.version ?? "…"} · {info?.platform ?? ""}{dev ? " · 开发版" : ""}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">通用 ACP 智能体工作台 · 秋水时至，百川灌河</div>
        </div>
      </div>

      <h3 className="text-sm font-semibold mt-5 mb-1">更新</h3>
      <div className="rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <div className="flex items-center justify-between gap-4 min-h-8">
          <div>{status}</div>
          <div className="flex gap-2 shrink-0">
            {state.phase === "available" && (
              state.canAutoInstall ? (
                <button className={primary} onClick={() => { useUpdateStore.getState().dispatch({ type: "download-requested" }); void api?.download(); }}>
                  <Download className="h-3.5 w-3.5" /> 下载更新
                </button>
              ) : (
                <button className={primary} onClick={() => void api?.openReleases()}>
                  <ExternalLink className="h-3.5 w-3.5" /> 前往下载
                </button>
              )
            )}
            {state.phase === "ready" && (
              <button className={primary} onClick={() => void api?.install()}>
                <RotateCw className="h-3.5 w-3.5" /> 重启并更新
              </button>
            )}
            {state.phase !== "downloading" && state.phase !== "ready" && (
              <button className={btn} onClick={() => void check()} disabled={checking}>
                <RefreshCw className={cn("h-3.5 w-3.5", checking && "animate-spin")} /> 检查更新
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 text-[11px]">上次检查：{fmtTime(info?.lastChecked)}</div>
      </div>
      {dev && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          当前是开发版（或浏览器模式），不会检查更新。只有 GitHub Releases 下载的安装包会自动更新。
        </div>
      )}
      <Row title="自动检查更新" desc="启动 10 秒后检查一次，之后每 4 小时一次；发现新版会提示，不会自动下载。">
        <Switch checked={!!info?.autoCheck} onChange={(v) => void setAutoCheck(v)} disabled={dev} label="自动检查更新" />
      </Row>
      <Row title="安装方式" desc={info?.canAutoInstall ? "后台下载，重启或下次打开时静默安装。" : "当前平台只提示新版并打开下载页（macOS 未签名 / deb 包）。"} />
      <div className="mt-4 flex gap-2">
        <a className={btn} href={CHANGELOG_URL} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> 更新日志</a>
        <a className={btn} href="https://github.com/yitom486/autumnflow" target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> GitHub</a>
      </div>
      <div className="mt-6 text-[11px] text-muted-foreground">MIT License · © yitom486</div>
    </div>
  );
};

export const SettingsModal: React.FC = () => {
  const open = useWorkbenchStore((s) => s.settingsOpen);
  const tab = useWorkbenchStore((s) => s.settingsTab);
  const close = useWorkbenchStore((s) => s.closeSettings);
  const openSettings = useWorkbenchStore((s) => s.openSettings);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);
  if (!open) return null;
  const tabs: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
    { id: "general", label: "通用", icon: <Settings2 className="h-4 w-4" /> },
    { id: "gateway", label: "网关", icon: <Server className="h-4 w-4" /> },
    { id: "about", label: "关于与更新", icon: <Info className="h-4 w-4" /> },
  ];
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-6" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-label="设置" className="flex h-[560px] w-[760px] max-w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <nav className="w-48 shrink-0 border-r border-border bg-muted/40 p-2">
          <div className="px-2 py-2 text-xs font-semibold text-muted-foreground">设置</div>
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => openSettings(t.id)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                tab === t.id ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
        <div className="relative flex-1 overflow-y-auto p-6">
          <button aria-label="关闭设置" onClick={close} className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
          <h2 className="mb-4 text-base font-semibold">{tabs.find((t) => t.id === tab)?.label}</h2>
          {tab === "general" ? <GeneralPanel /> : tab === "gateway" ? <GatewayPanel /> : <AboutPanel />}
        </div>
      </div>
    </div>
  );
};
