/**
 * 网关访问令牌（gateway token）的前端一侧。
 *
 * 网关对所有 /api/universal/* 强制 `Authorization: Bearer <token>`
 * （server/universal/security.ts），这里负责拿到 token 并在每个请求上带上：
 *
 * 1. Electron：preload 透出 `window.acpStudio.getGatewayToken()`（主进程直接给）。
 * 2. 浏览器：网关启动日志打印的 `/?token=...` 一次性链接 → 存 localStorage，
 *    并立刻从地址栏抹掉（不留在历史记录 / 截图里）。
 * 3. 浏览器：令牌页手动粘贴 `~/.autumnflow/.gateway-token` 的内容（GatewayTokenGate）。
 *
 * 传输层保持哑巴（state_management.md 第三条）：这里只持有 token 本身，
 * 不缓存任何业务数据。
 */

export const GATEWAY_TOKEN_STORAGE_KEY = "acp_gateway_token";
/** 自定义网关基址（远端/WSL 网关用；空 = 同源本地网关）。 */
export const GATEWAY_BASE_STORAGE_KEY = "acp_gateway_base";

export type GatewayBaseParse =
  | { kind: "local" }
  | { kind: "remote"; base: string }
  | { kind: "invalid"; error: string };

/**
 * 网关基址解析（纯函数，可测）：空 = 同源本地；`http(s)://host[:port]` = 远端；
 * 带路径/参数/其他协议一律拒绝（绝不拼出奇怪 URL，loud 报错）。
 */
export function parseGatewayBase(raw: string): GatewayBaseParse {
  const t = String(raw || "").trim().replace(/\/+$/, "");
  if (!t) return { kind: "local" };
  const m = /^(https?):\/\/([^/\s]+)$/i.exec(t);
  if (!m) return { kind: "invalid", error: "只接受空（本地）或 http(s)://host[:port]（不带路径/参数）" };
  return { kind: "remote", base: `${m[1].toLowerCase()}://${m[2]}` };
}

function readStoredBase(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    let val = localStorage.getItem(GATEWAY_BASE_STORAGE_KEY) || "";
    const isWsl = Boolean(localStorage.getItem("acp_wsl_native_distro"));
    // 只有在非 WSL 模式下（纯本地 Windows 环境），才将本地默认网关 13005 收敛为空（同源代理）
    // WSL 原生网关 (13006) 或 WSL 原生模式下的基址绝不清空，必须保留
    if (!isWsl) {
      if (
        val === "http://127.0.0.1:3004" ||
        val === "http://localhost:3004" ||
        val === "http://127.0.0.1:3005" ||
        val === "http://localhost:3005" ||
        val === "http://127.0.0.1:13005" ||
        val === "http://localhost:13005"
      ) {
        val = "";
        localStorage.removeItem(GATEWAY_BASE_STORAGE_KEY);
      }
    } else {
      // WSL 原生真环境模式下：若未设置基址，严格指向 WSL 网关专属端口 13006，绝不穿透回 Windows 宿主机
      if (!val) {
        val = "http://127.0.0.1:13006";
      }
    }
    return val;
  } catch {
    return "";
  }
}

/** 当前网关基址（"" = 同源本地网关；损坏值回落本地，不编造）。 */
export function getGatewayBase(): string {
  const p = parseGatewayBase(readStoredBase());
  return p.kind === "remote" ? p.base : "";
}

/** 设置基址（返回解析结果；local 清键）。调用方切 base 后应重载页面（状态归属网关）。 */
export function setGatewayBase(raw: string): GatewayBaseParse {
  const p = parseGatewayBase(raw);
  try {
    if (typeof localStorage === "undefined") return p;
    if (p.kind === "remote") localStorage.setItem(GATEWAY_BASE_STORAGE_KEY, p.base);
    else if (p.kind === "local") localStorage.removeItem(GATEWAY_BASE_STORAGE_KEY);
  } catch (err) {
    console.warn("[GatewayAuth] 写入网关基址失败:", err);
  }
  return p;
}

/** 回环基址？（http + 非回环 = 明文 token 出本机，设置页必须 loud 警告） */
export function isLoopbackBase(base: string): boolean {
  const m = /^https?:\/\/(\[[^\]]+\]|[^:/\s]+)/i.exec((base || "").trim());
  if (!m) return true; // 同源本地：不警告
  const h = m[1].toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** 基址取 host[:port] 展示用（纯函数，可测）：`http://127.0.0.1:4004` → `127.0.0.1:4004`。 */
export function gatewayHost(base: string): string {
  return base.replace(/^https?:\/\//i, "");
}

/** 相对网关路径拼基址（纯函数，可测）：绝对 URL 原样放行。 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path;
  const b = getGatewayBase();
  return b ? `${b}${path}` : path;
}

function tokenKey(): string {
  const b = getGatewayBase();
  return b ? `${GATEWAY_TOKEN_STORAGE_KEY}::${b}` : GATEWAY_TOKEN_STORAGE_KEY;
}

let cached: { base: string; value: string | null } | null = null;

function readStored(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const t = (localStorage.getItem(tokenKey()) || "").trim();
    return t || null;
  } catch (err) {
    console.warn("[GatewayAuth] 读取 localStorage 失败，需重新输入令牌:", err);
    return null;
  }
}

/** True when the desktop host authenticates via its HttpOnly session cookie. */
export function isCookieAuth(): boolean {
  return (
    typeof window !== "undefined" &&
    window.acpStudio?.authMode === "cookie" &&
    getGatewayBase() === ""
  );
}

/** 当前 token（未拿到时为 null；按基址隔离，防串到别的网关）。 */
export function getGatewayToken(): string | null {
  const b = getGatewayBase();
  if (cached && cached.base === b) return cached.value;
  cached = { base: b, value: readStored() };
  return cached.value;
}

/** 记住 token（浏览器模式落 localStorage；Electron 每次启动由主进程给，不落盘）。 */
export function setGatewayToken(t: string, persist = true): void {
  const b = getGatewayBase();
  const v = t.trim() || null;
  cached = { base: b, value: v };
  if (!persist) return;
  try {
    if (typeof localStorage === "undefined") return;
    if (v) localStorage.setItem(tokenKey(), v);
    else localStorage.removeItem(tokenKey());
  } catch (err) {
    console.warn("[GatewayAuth] 写入 localStorage 失败，令牌只在本次页面有效:", err);
  }
}

export function clearGatewayToken(): void {
  setGatewayToken("", true);
}

/**
 * 启动时取 token：Electron preload > 地址栏 `?token=` > localStorage。
 * 地址栏里的 token 读完立刻用 history.replaceState 抹掉。
 */
export async function bootstrapGatewayToken(): Promise<string | null> {
  if (isCookieAuth()) return null;
  if (typeof window !== "undefined" && window.acpStudio?.getGatewayToken) {
    const t = await window.acpStudio.getGatewayToken();
    setGatewayToken(t, false);
    return getGatewayToken();
  }
  if (typeof window !== "undefined" && window.location) {
    const url = new URL(window.location.href);
    const fromUrl = (url.searchParams.get("token") || "").trim();
    if (fromUrl) {
      setGatewayToken(fromUrl);
      url.searchParams.delete("token");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
      return fromUrl;
    }
  }
  const b = getGatewayBase();
  cached = { base: b, value: readStored() };
  return cached.value;
}

/** 给 fetch init 补上 Authorization 头（调用方自带的头保留）。 */
export function withGatewayAuth(init?: RequestInit): RequestInit {
  if (isCookieAuth()) return init ?? {};
  const t = getGatewayToken();
  if (!t) return init ?? {};
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${t}`);
  return { ...(init ?? {}), headers };
}

/** 访问网关的 fetch：自动拼基址（远端网关）+ 带 token。所有 /api/universal/* 调用都必须走它。 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(input), withGatewayAuth(init));
}

/** WebSocket 发不了自定义头：把 token 拼进查询串（网关只在 PTY 升级路径接受）。 */
export function withTokenQuery(url: string): string {
  if (isCookieAuth()) return url;
  const t = getGatewayToken();
  if (!t) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}`;
}

export type GatewayAuthState = "ok" | "unauthorized" | "unreachable";

/**
 * 校验当前 token：401 且带 gatewayUnauthorized → "unauthorized"（显示令牌页）；
 * 网关没起 / 网络错 → "unreachable"（照常进应用，由各处请求自己报错）。
 */
export async function verifyGatewayToken(): Promise<GatewayAuthState> {
  const currentBase = getGatewayBase();
  let res: Response;
  try {
    res = await apiFetch("/api/universal/agents");
  } catch (err) {
    // 自动自愈保护：如果用户之前设置了自定义/WSL远端基址（例如 13005），但此时远端挂了，
    // 而同源本地网关（3004 / Vite 代理）正常存活，自动回落至本地网关，
    // 避免“上次切了 WSL，下次 Windows 启动直接卡死在不可达”
    if (currentBase) {
      try {
        const localCheck = await fetch("/api/universal/agents", {
          headers: withGatewayAuth().headers,
        });
        if (localCheck.ok || localCheck.status === 401) {
          console.warn(`[GatewayAuth] 远端网关 (${currentBase}) 不可达，但本地网关正常运行。自动回落至本地网关。`);
          setGatewayBase("");
          if (typeof localStorage !== "undefined") {
            localStorage.removeItem("acp_wsl_native_distro");
          }
          return verifyGatewayToken();
        }
      } catch {
        // 本地也没起，维持 unreachable
      }
    }
    console.warn("[GatewayAuth] 网关不可达，先进入应用（请求会各自报错）:", err);
    return "unreachable";
  }
  if (res.status !== 401) return "ok";
  const body = (await res.json().catch(() => null)) as { gatewayUnauthorized?: boolean } | null;
  return body?.gatewayUnauthorized ? "unauthorized" : "ok";
}
