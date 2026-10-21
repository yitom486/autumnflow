/** 工作台文件接口（/api/universal/fs/*），与网关其余接口一样走令牌鉴权。 */
import { apiFetch } from "@/lib/gateway-auth";

const BASE = "/api/universal/fs";

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "other";
  symlink?: boolean;
}
export interface FsFile {
  path: string;
  text: string;
  size: number;
  mtimeMs: number;
}
export class FsApiError extends Error {
  constructor(public status: number, message: string, public data: any = {}) {
    super(message);
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(url, init);
  let data: any = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok || data.ok === false) throw new FsApiError(res.status, data.error || `HTTP ${res.status}`, data);
  return data as T;
}
const post = <T,>(p: string, body: unknown) =>
  call<T>(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export interface FsListResult {
  entries: FsEntry[];
  /** 该目录实际有多少条目（可能被截断）。 */
  total?: number;
  truncated?: boolean;
}

/** 列一层目录。hidden=true 时连被 .gitignore 忽略的条目一起返回（VS Code 的开关）。 */
export const fsList = (cwd: string, dir = "", opts: { hidden?: boolean } = {}) =>
  call<FsListResult>(
    `${BASE}/list?${new URLSearchParams({ cwd, dir, ...(opts.hidden ? { hidden: "1" } : {}) })}`
  );
export const fsRead = (cwd: string, path: string) => call<FsFile>(`${BASE}/read?${new URLSearchParams({ cwd, path })}`);
export const fsWrite = (cwd: string, path: string, text: string, baseMtimeMs: number | null, force = false) =>
  post<{ path: string; size: number; mtimeMs: number }>("/write", { cwd, path, text, baseMtimeMs, force });
export const fsCreate = (cwd: string, path: string, type: "file" | "dir") => post("/create", { cwd, path, type });
export const fsRename = (cwd: string, from: string, to: string) => post("/rename", { cwd, from, to });
export const fsDelete = (cwd: string, path: string) => post<{ trashed: string }>("/delete", { cwd, path });

export type FsWatchEvent = { type: string; path: string };

/** SSE 监听；返回取消函数。断线 2s 后自动重连。 */
export function fsWatch(cwd: string, onBatch: (events: FsWatchEvent[]) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await apiFetch(`${BASE}/watch?${new URLSearchParams({ cwd })}`, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`watch HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            try {
              const msg = JSON.parse(line.slice(6));
              if (msg.type === "batch") onBatch(msg.events);
            } catch {}
          }
        }
      } catch (err) {
        if (stopped) return;
        console.debug("[fsWatch] 断开，稍后重连:", (err as Error)?.message);
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void run();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

/** 两段文本的“新增/修改行”（新文本的 1-based 行号），用于 AI 改动高亮。简单 LCS，超大文件退化为整段比较。 */
export function changedLines(oldText: string, newText: string): number[] {
  const a = oldText.replace(/\r\n/g, "\n").split("\n");
  const b = newText.replace(/\r\n/g, "\n").split("\n");
  if (a.length * b.length > 4_000_000) {
    const out: number[] = [];
    for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) out.push(i + 1);
    return out;
  }
  // 去掉公共前后缀后做 LCS
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const A = a.slice(start, endA + 1), B = b.slice(start, endB + 1);
  const dp: Uint32Array[] = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: number[] = [];
  let i = 0, j = 0;
  while (j < B.length) {
    if (i < A.length && A[i] === B[j]) { i++; j++; }
    else if (i < A.length && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else { out.push(start + j + 1); j++; }
  }
  return out;
}
