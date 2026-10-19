import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAppHome } from "./app-paths";

/**
 * On-demand agent runtimes (fail-fast, no silent fallbacks).
 *
 * Runner-era note: stdio agents (codex, antigravity, claude, …) all launch
 * via package runners (`bunx <pkg>@latest`, npx fallback) straight into the
 * vendor CLI adapter — no managed installs, no big exes. The runner cache
 * owns the bytes; first connect downloads, later connects reuse the cache.
 *
 * The table + job machinery below is generic and dormant: MANAGED_AGENTS is
 * intentionally empty. If a future runtime ever needs an explicit install
 * again, add a spec here and the install-state/install endpoints + UI badges
 * pattern can be revived. Nothing auto-installs behind the user's back.
 */

export interface ManagedAgentSpec {
  /** Preset id, e.g. 'some-future-exe-agent'. */
  id: string;
  /** npm package providing the runtime, e.g. '@vendor/agent-acp'. */
  pkg: string;
  /** Runtime entry relative to the installed package dir. */
  exeRel: string;
  /** Headless launcher relative to the installed package dir. */
  headlessRel: string;
}

// Runner era: empty on purpose. antigravity-stdio used to live here
// (managed 86MB agy-acp-win-x64.exe); it now runs codex-style via
// `bunx @yitom/agy-acp-map@latest` (thin JS bin, see presets.ts).
export const MANAGED_AGENTS: ManagedAgentSpec[] = [];

export function specFor(id: string): ManagedAgentSpec | undefined {
  return MANAGED_AGENTS.find((s) => s.id === id);
}

/** Override with ACP_AGENTS_HOME. */
export function agentsHome(): string {
  return process.env.ACP_AGENTS_HOME || path.join(resolveAppHome(), "agents");
}

export function managedDir(id: string): string {
  return path.join(agentsHome(), id);
}

export function managedPkgDir(spec: ManagedAgentSpec): string {
  return path.join(managedDir(spec.id), "node_modules", spec.pkg);
}

function readPkgVersion(pkgDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(pkgDir, "package.json"), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

export function managedExe(spec: ManagedAgentSpec): string | null {
  const p = path.join(managedPkgDir(spec), spec.exeRel);
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return p;
  } catch {
    return null;
  }
}

export function managedHeadless(spec: ManagedAgentSpec): string | null {
  const p = path.join(managedPkgDir(spec), spec.headlessRel);
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return p;
  } catch {
    return null;
  }
}

/** Numeric semver-ish compare: 1 => a newer, -1 => b newer, 0 => equal/unknown. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (Number.isNaN(na) || Number.isNaN(nb)) continue;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

function npmBin(): string | null {
  // Test hook: ACP_NPM_BIN overrides PATH lookup so tests can point at a
  // fake script without network (offline, deterministic).
  const override = (process.env.ACP_NPM_BIN || "").trim();
  if (override) {
    try {
      fs.accessSync(override, fs.constants.F_OK);
      return override;
    } catch (err) {
      console.error(`[UniversalACP] ACP_NPM_BIN override not found: ${override}: ${(err as Error).message}`);
      return null;
    }
  }
  return whichCommand(process.platform === "win32" ? "npm.cmd" : "npm");
}

/** Minimal PATH scan (local copy so this module never imports AgentConnection). */
function whichCommand(command: string): string | null {
  if (!command) return null;
  const isAbs = path.isAbsolute(command);
  const dirs = isAbs
    ? [path.dirname(command)]
    : (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const base = isAbs ? path.basename(command) : command;
  const exts =
    process.platform === "win32" && !path.extname(base)
      ? ["", ".exe", ".cmd", ".bat"]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, base + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        // try next
      }
    }
  }
  if (isAbs) {
    try {
      fs.accessSync(command, fs.constants.F_OK);
      return command;
    } catch {
      // miss
    }
  }
  return null;
}

/** Registry latest via `npm view` (honors npm/proxy config). Null on any failure. */
export function latestVersion(pkg: string, timeoutMs = 20000): string | null {
  const npm = npmBin();
  if (!npm) return null;
  try {
    const r = spawnSync(npm, ["view", pkg, "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    const v = String(r.stdout || "").trim().split(/\s+/).pop() || "";
    return /^[0-9][0-9A-Za-z.\-+]*$/.test(v) ? v : null;
  } catch (err) {
    console.error(`[UniversalACP] latestVersion(${pkg}) spawn failed: ${(err as Error).message}`);
    return null;
  }
}

/** Non-blocking registry query, preserving npm's configured registry/proxy. */
export function latestVersionAsync(pkg: string, timeoutMs = 20000): Promise<string | null> {
  const npm = npmBin();
  if (!npm) return Promise.resolve(null);
  let command = npm;
  const args = ["view", pkg, "version"];
  // npm.cmd is a shell wrapper. Run its official CLI with the current JS
  // runtime instead, so package names/paths never pass through cmd quoting.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(npm)) {
    const cli = path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js");
    if (!fs.existsSync(cli)) {
      console.warn(`[UniversalACP] npm CLI missing: ${cli}. Repair the Node.js/npm installation.`);
      return Promise.resolve(null);
    }
    command = process.execPath;
    args.unshift(cli);
  }
  return new Promise((resolve) => {
    let output = "";
    let stderr = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(command, args, {
        windowsHide: true,
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env,
      });
      child.stdout?.on("data", (data) => { output = (output + data.toString()).slice(-8192); });
      child.stderr?.on("data", (data) => { stderr = (stderr + data.toString()).slice(-2048); });
      child.on("error", (error) => {
        console.warn(`[UniversalACP] latestVersion(${pkg}) failed: ${error.message}`);
        finish(null);
      });
      child.on("close", (code, signal) => {
        if (settled) return;
        const version = output.trim().split(/\s+/).pop() || "";
        if (code === 0 && /^[0-9][0-9A-Za-z.\-+]*$/.test(version)) finish(version);
        else {
          console.warn(`[UniversalACP] latestVersion(${pkg}) failed: ${signal || code}; ${stderr || "no valid version returned"}`);
          finish(null);
        }
      });
    } catch (error) {
      console.warn(`[UniversalACP] latestVersion(${pkg}) spawn failed: ${(error as Error).message}`);
      finish(null);
    }
  });
}

/** TTL cache with stale-while-revalidate reads and one query per package. */
const latestCache = new Map<string, { v: string | null; at: number }>();
const latestInFlight = new Map<string, Promise<string | null>>();

export function latestTtlMs(): number {
  const raw = (process.env.ACP_LATEST_TTL_MS || "").trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
    console.error(`[UniversalACP] Invalid ACP_LATEST_TTL_MS=${JSON.stringify(raw)}, using default 10min.`);
  }
  return 10 * 60 * 1000;
}

/** Clear TTL cache (tests only). */
export function clearLatestCache(): void {
  latestCache.clear();
  latestInFlight.clear();
}

/** Test-only priming: set cache entry directly to verify hit path offline. */
export function __setLatestCacheForTest(pkg: string, v: string | null, at = Date.now()): void {
  latestCache.set(pkg, { v, at });
}

export function latestVersionCached(pkg: string, timeoutMs = 20000): string | null {
  const hit = latestCache.get(pkg);
  if (!hit || Date.now() - hit.at >= latestTtlMs()) void refreshLatestVersion(pkg, timeoutMs);
  return hit?.v ?? null;
}

/** Await a fresh result when needed; status reads use the immediate variant. */
export function refreshLatestVersion(pkg: string, timeoutMs = 20000): Promise<string | null> {
  const pending = latestInFlight.get(pkg);
  if (pending) return pending;
  const task = latestVersionAsync(pkg, timeoutMs).then((version) => {
    // A cleared cache must not be repopulated by an obsolete request.
    if (latestInFlight.get(pkg) === task) {
      latestCache.set(pkg, { v: version, at: Date.now() });
    }
    return version;
  }).finally(() => {
    if (latestInFlight.get(pkg) === task) latestInFlight.delete(pkg);
  });
  latestInFlight.set(pkg, task);
  return task;
}

export interface InstallState {
  id: string;
  pkg: string;
  managed: boolean;
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  command: string | null;
  installHint: string;
}

export function checkAgent(id: string): InstallState {
  const spec = specFor(id);
  if (!spec) {
    return {
      id,
      pkg: "",
      managed: false,
      installed: false,
      installedVersion: null,
      latestVersion: null,
      updateAvailable: false,
      command: null,
      installHint: `Agent '${id}' 不是按需管理的 agent，无一键安装。`,
    };
  }
  const exe = managedExe(spec);
  const installedVersion = exe ? readPkgVersion(managedPkgDir(spec)) : null;
  // Cached latest: status queries must never block the event loop (SSE stalls).
  const latest = latestVersionCached(spec.pkg);
  return {
    id,
    pkg: spec.pkg,
    managed: true,
    installed: exe !== null,
    installedVersion,
    latestVersion: latest,
    updateAvailable:
      installedVersion !== null && latest !== null
        ? compareVersions(latest, installedVersion) > 0
        : false,
    command: exe,
    installHint: exe
      ? ""
      : `Agent '${id}' 尚未安装。请在界面点击「安装 ${spec.pkg}」一键拉取最新版。`,
  };
}

/** Alias for explicit cached variant (same impl; kept for API clarity). */
export function checkAgentCached(id: string): InstallState {
  return checkAgent(id);
}

export interface InstallResult {
  ok: boolean;
  version?: string;
  alreadyLatest?: boolean;
  error?: string;
  log?: string;
}

const installInFlight = new Set<string>();

/**
 * One-click install/update to the registry latest. Synchronous (may take
 * ~1min for ~100MB); concurrent calls for the same id get 409 busy.
 * Never falls back, never masks: failures return ok:false with the raw log.
 * @deprecated Use startInstall()/getInstallJob() async jobs instead; routes no
 * longer call this sync version (it blocks the event loop + SSE). Kept for
 * tests/compat only.
 */
export function installAgent(id: string): InstallResult {
  const spec = specFor(id);
  if (!spec) return { ok: false, error: `Agent '${id}' 不是按需管理的 agent。` };
  if (installInFlight.has(id)) {
    return { ok: false, error: `'${id}' 正在安装中，请稍候再试。` };
  }
  const npm = npmBin();
  if (!npm) {
    return {
      ok: false,
      error: "找不到 npm（不在 PATH 中）。请先安装 Node.js 20+ 再一键安装。",
    };
  }
  installInFlight.add(id);
  try {
    const dir = managedDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(
      npm,
      ["install", "--prefix", dir, "--no-audit", "--no-fund", `${spec.pkg}@latest`],
      { encoding: "utf8", timeout: 600_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    const log = `${r.stdout || ""}\n${r.stderr || ""}`.slice(-4000);
    if (r.error) {
      return { ok: false, error: `安装进程失败：${r.error.message}`, log };
    }
    if (r.status !== 0) {
      return { ok: false, error: `npm install 退出码 ${r.status}`, log };
    }
    const version = readPkgVersion(managedPkgDir(spec));
    const exe = managedExe(spec);
    if (!exe) {
      return {
        ok: false,
        error: `安装完成但找不到入口 ${spec.exeRel}，包内容异常。`,
        log,
      };
    }
    return { ok: true, version: version ?? undefined, log };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    installInFlight.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Async install jobs (non-blocking; routes poll via GET install/:jobId).
// ---------------------------------------------------------------------------

/**
 * Async install job record. Frontend flow:
 *   POST /api/universal/agents/:id/install -> {ok:true, jobId, state:'running'}
 *   GET  /api/universal/agents/:id/install/:jobId (poll ~2s):
 *     running -> {ok:true, state:'running', jobId}
 *     done    -> {ok:true, state:'done', version}
 *     error   -> {ok:false, state:'error', error, log} (500)
 */
export interface InstallJob {
  id: string;
  jobId: string;
  state: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  version?: string;
  error?: string;
  log?: string;
}

const installJobs = new Map<string, InstallJob>();
const installAgentLatest = new Map<string, string>();

function isLockError(msg: string): boolean {
  return /EBUSY|busy|locked|EPERM/i.test(msg);
}

function tail4k(s: string): string {
  return s.slice(-4000);
}

/** Query by jobId OR agentId (latest job for that agent). */
export function getInstallJob(key: string): InstallJob | undefined {
  const direct = installJobs.get(key);
  if (direct) return direct;
  const latestId = installAgentLatest.get(key);
  if (latestId) {
    const j = installJobs.get(latestId);
    if (j) return j;
  }
  // Fallback: latest job whose id matches (covers restarted processes).
  let best: InstallJob | undefined;
  for (const j of installJobs.values()) {
    if (j.id === key && (!best || j.startedAt > best.startedAt)) best = j;
  }
  return best;
}

/** Test-only: drop all jobs + release in-flight guards. */
export function __clearInstallJobsForTest(): void {
  installJobs.clear();
  installAgentLatest.clear();
}

function runNpmInstallOnce(dir: string, pkg: string, npm: string): Promise<{ ok: boolean; error?: string; log: string }> {
  return new Promise((resolve) => {
    let out = "";
    let errOut = "";
    let settled = false;
    const finish = (result: { ok: boolean; error?: string; log: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(npm, ["install", "--prefix", dir, "--no-audit", "--no-fund", `${pkg}@latest`], {
        cwd: dir,
        windowsHide: true,
      });
    } catch (err) {
      console.error(`[UniversalACP] startInstall spawn threw: ${(err as Error).message}`);
      finish({ ok: false, error: `安装进程失败：${(err as Error).message}`, log: "" });
      return;
    }
    child.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.length > 8192) out = out.slice(-8192);
    });
    child.stderr?.on("data", (c: Buffer) => {
      errOut += c.toString("utf8");
      if (errOut.length > 8192) errOut = errOut.slice(-8192);
    });
    child.on("error", (err) => {
      console.error(`[UniversalACP] install child error: ${(err as Error).message}`);
      finish({ ok: false, error: `安装进程失败：${(err as Error).message}`, log: tail4k(`${out}\n${errOut}`) });
    });
    child.on("close", (code) => {
      const log = tail4k(`${out}\n${errOut}`);
      if (code !== 0) {
        finish({ ok: false, error: `npm install 退出码 ${code ?? "unknown"}`, log });
      } else {
        finish({ ok: true, log });
      }
    });
  });
}

async function driveInstallJob(job: InstallJob, spec: ManagedAgentSpec, npm: string): Promise<void> {
  try {
    const dir = managedDir(job.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`[UniversalACP] install mkdir failed ${dir}: ${(err as Error).message}`);
      job.state = "error";
      job.error = `创建目录失败：${(err as Error).message}`;
      job.finishedAt = Date.now();
      return;
    }
    let res = await runNpmInstallOnce(dir, spec.pkg, npm);
    // One retry for transient Windows file locks (EBUSY) — async, never blocks.
    if (!res.ok && isLockError(`${res.error || ""} ${res.log || ""}`)) {
      console.warn(`[UniversalACP] install ${job.id} hit file lock, retrying once after 8s…`);
      await new Promise((r) => setTimeout(r, 8000));
      res = await runNpmInstallOnce(dir, spec.pkg, npm);
    }
    if (!res.ok) {
      job.state = "error";
      job.error = res.error;
      job.log = res.log;
      job.finishedAt = Date.now();
      return;
    }
    let version: string | null = null;
    try {
      version = readPkgVersion(managedPkgDir(spec));
    } catch (err) {
      console.error(`[UniversalACP] readPkgVersion failed: ${(err as Error).message}`);
    }
    let exe: string | null = null;
    try {
      exe = managedExe(spec);
    } catch (err) {
      console.error(`[UniversalACP] managedExe check failed: ${(err as Error).message}`);
    }
    if (!exe) {
      job.state = "error";
      job.error = `安装完成但找不到入口 ${spec.exeRel}，包内容异常。`;
      job.log = res.log;
      job.finishedAt = Date.now();
      return;
    }
    job.state = "done";
    job.version = version ?? undefined;
    job.log = res.log;
    job.finishedAt = Date.now();
  } catch (err) {
    console.error(`[UniversalACP] install job ${job.jobId} crashed: ${(err as Error).message}`);
    job.state = "error";
    job.error = (err as Error).message;
    job.finishedAt = Date.now();
  } finally {
    installInFlight.delete(job.id);
  }
}

/**
 * Start a non-blocking `npm install` for a managed agent.
 * - Unknown id -> {busy:false, error} (routes map to 404).
 * - Same id already running (sync or async in-flight) -> {busy:true, error}
 *   (routes map to 409).
 * - Else creates a running InstallJob, spawns async, returns it immediately.
 */
export function startInstall(id: string): { job?: InstallJob; error?: string; busy: boolean } {
  const spec = specFor(id);
  if (!spec) return { error: `Agent '${id}' 不是按需管理的 agent。`, busy: false };
  const running = [...installJobs.values()].find((j) => j.id === id && j.state === "running");
  if (running || installInFlight.has(id)) {
    return { error: `'${id}' 正在安装中，请稍候再试。`, busy: true };
  }
  const npm = npmBin();
  if (!npm) {
    return { error: "找不到 npm（不在 PATH 中）。请先安装 Node.js 20+ 再一键安装。", busy: false };
  }
  const job: InstallJob = {
    id,
    jobId: `${id}-${Date.now()}-${randomUUID().slice(0, 8)}`,
    state: "running",
    startedAt: Date.now(),
  };
  installJobs.set(job.jobId, job);
  installAgentLatest.set(id, job.jobId);
  installInFlight.add(id);
  void driveInstallJob(job, spec, npm).catch((err) => {
    console.error(`[UniversalACP] driveInstallJob unhandled for ${id}: ${(err as Error).message}`);
    try {
      job.state = "error";
      job.error = (err as Error).message;
      job.finishedAt = Date.now();
    } catch (inner) {
      console.error(`[UniversalACP] failed to mark job error: ${(inner as Error).message}`);
    } finally {
      installInFlight.delete(id);
    }
  });
  return { job, busy: false };
}

/** Minimal session shape for empty-session detection (bridge listSessions). */
export interface ListedSession {
  sessionId: string;
  updatedAt?: string | null;
  conversationId?: string | null;
  [k: string]: unknown;
}

export interface EmptySessionPick {
  sessionId: string;
  reason: string;
}

export function isDefaultEmptySessionTitle(title?: string | null): boolean {
  if (!title) return true;
  const t = title.trim();
  if (!t) return true;
  return /^(New session|新会话)(\s*-\s*|\s*$)/i.test(t);
}

/**
 * Pick deletable empty sessions. Strict on purpose (fail-safe toward KEEP):
 * - sessionId missing/blank -> keep (never touch unidentifiable rows);
 * - listed in exceptIds (live-bound threads, current view) -> keep;
 * - has conversationId (a turn completed at least once, agy bridge) -> keep;
 * - has custom/agent-generated title (not default 'New session - ...' / '新会话') -> keep;
 * - updated within maxAgeMs -> keep (a fresh session awaiting first prompt
 *   looks exactly like an abandoned one);
 * - otherwise -> delete candidate ("no turns recorded").
 */
export function selectEmptySessions(
  sessions: ListedSession[],
  opts?: { exceptIds?: string[]; maxAgeMs?: number; now?: number },
): { deletable: EmptySessionPick[]; kept: number } {
  const except = new Set(opts?.exceptIds ?? []);
  const maxAgeMs = opts?.maxAgeMs ?? 60 * 60 * 1000;
  const now = opts?.now ?? Date.now();
  const deletable: EmptySessionPick[] = [];
  let kept = 0;
  for (const s of sessions) {
    const id = typeof s?.sessionId === "string" ? s.sessionId : "";
    if (!id || except.has(id)) {
      kept++;
      continue;
    }
    if (s.conversationId) {
      kept++;
      continue;
    }
    const title = typeof s?.title === "string" ? s.title : null;
    if (title && !isDefaultEmptySessionTitle(title)) {
      kept++;
      continue;
    }
    const updated = s.updatedAt ? new Date(s.updatedAt).getTime() : NaN;
    if (!Number.isFinite(updated) || now - updated < maxAgeMs) {
      kept++;
      continue;
    }
    deletable.push({ sessionId: id, reason: "no turns recorded" });
  }
  return { deletable, kept };
}
