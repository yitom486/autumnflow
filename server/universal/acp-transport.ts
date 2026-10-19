/**
 * One long-lived stdio connection to a generic ACP agent.
 *
 * This class owns *how to talk to the process*: spawn, the NDJSON stream, the
 * initialize handshake, stderr capture and teardown. It deliberately owns no
 * session, prompt or permission semantics — those handlers are injected by
 * `UniversalAgentConnection`, which keeps the facade free of process plumbing.
 *
 * The split is what makes the long-lived host tractable: a transport restart or
 * exit is a local concern here, while session/prompt state lives above.
 */
import { type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs";
import * as acp from "@agentclientprotocol/sdk";
import { clientCapabilities, requestAgent } from "./acp-sdk";
import type { AgentProfile } from "./types";
import { spawnCrossPlatform, whichCommand } from "./platform/spawn";

/** Client-side ACP surface the connection plugs into the transport stream. */
export interface AcpClientHandlers {
  requestPermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  createTerminal(params: acp.CreateTerminalRequest): Promise<acp.CreateTerminalResponse>;
  terminalOutput(params: acp.TerminalOutputRequest): acp.TerminalOutputResponse;
  terminalRelease(params: acp.ReleaseTerminalRequest): any;
  terminalWaitForExit(params: acp.WaitForTerminalExitRequest): Promise<acp.WaitForTerminalExitResponse>;
  terminalKill(params: acp.KillTerminalRequest): any;
  createElicitation(params: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse>;
  sessionUpdate(params: acp.SessionNotification): void | Promise<void>;
  elicitationComplete(params: acp.CompleteElicitationNotification): void;
}

export interface AcpTransportHooks {
  /** Extra env prepared per spawn (rules / skills / MCP snapshot). */
  prepareEnv?: (ctx: {
    cwd: string;
    resolvedCommand: string;
    env: Record<string, string>;
  }) =>
    | Promise<Record<string, string | undefined> | void>
    | Record<string, string | undefined>
    | void;
  /** Whether the client can offer terminal authentication for this command. */
  terminalAuthAvailable?: (resolvedCommand: string) => boolean;
  /** Process exited; the connection fails pending interactions here. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** initialize succeeded, before connect() resolves (resource handshake, quota probe). */
  onInitialized?: (init: acp.InitializeResponse) => void;
}

export class AcpTransport {
  /**
   * Resolved per call, not captured: the registry swaps a connection's profile
   * to keep custom env overrides live, and a respawn must see the new one.
   */
  private readonly profileOf: () => AgentProfile;
  private proc: ChildProcess | null = null;
  private stoppingProc: ChildProcess | null = null;
  private conn: acp.ClientConnection | null = null;
  private initResult: acp.InitializeResponse | null = null;
  private startedAtIso: string | null = null;
  private lastErrorText: string | null = null;
  private stderrTail: string[] = [];
  private connectInFlight: Promise<acp.InitializeResponse> | null = null;
  private readonly hooks: AcpTransportHooks;

  constructor(profile: () => AgentProfile, hooks: AcpTransportHooks = {}) {
    this.profileOf = profile;
    this.hooks = hooks;
  }

  get profile(): AgentProfile {
    return this.profileOf();
  }

  get connected(): boolean {
    return !!this.conn && !!this.proc && this.proc.exitCode === null && !(this.proc.killed ?? false);
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  get init(): acp.InitializeResponse | null {
    return this.initResult;
  }

  get startedAt(): string | null {
    return this.startedAtIso;
  }

  get lastError(): string | null {
    return this.lastErrorText;
  }

  /** Recent stderr lines, already trimmed and capped. */
  get stderrTailLines(): string[] {
    return this.stderrTail;
  }

  setError(message: string | null): void {
    this.lastErrorText = message;
  }

  connectionOrNull(): acp.ClientConnection | null {
    return this.conn;
  }

  ensureConnection(): acp.ClientConnection {
    if (!this.conn || !this.connected) {
      throw new Error(`Agent ${this.profile.id} is not connected`);
    }
    return this.conn;
  }

  /** Idempotent: concurrent callers share one spawn+initialize. */
  async connect(handlers: AcpClientHandlers): Promise<acp.InitializeResponse> {
    if (this.connected && this.initResult) return this.initResult;
    if (this.connectInFlight) return this.connectInFlight;

    this.connectInFlight = (async () => {
      try {
        return await this.start(handlers);
      } catch (err) {
        await this.stop().catch(() => undefined);
        throw err;
      } finally {
        this.connectInFlight = null;
      }
    })();

    return this.connectInFlight;
  }

  /**
   * Kill the process and wait for it to go. Returns true when it is definitely
   * gone, false when a resource snapshot must be retained for later cleanup.
   */
  async stop(): Promise<boolean> {
    const proc = this.proc || this.stoppingProc;
    this.stoppingProc = proc;
    this.proc = null;
    this.conn = null;
    this.initResult = null;
    this.startedAtIso = null;
    if (proc?.pid && proc.exitCode === null && proc.signalCode === null) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          proc.removeListener("close", done);
          resolve();
        }, 2000);
        proc.once("close", done);
        try {
          proc.kill();
        } catch {
          clearTimeout(timer);
          proc.removeListener("close", done);
          resolve();
        }
      });
    }
    const gone = !proc?.pid || proc.exitCode !== null || proc.signalCode !== null;
    if (gone) this.stoppingProc = null;
    return gone;
  }

  private async start(handlers: AcpClientHandlers): Promise<acp.InitializeResponse> {
    await this.stop();
    this.lastErrorText = null;
    this.stderrTail = [];

    const env = { ...process.env, ...(this.profile.env || {}) } as Record<string, string>;
    // Ensure NO_PROXY for localhost so local MCP/servers never go through proxy
    env.NO_PROXY = env.NO_PROXY || "localhost,127.0.0.1,::1";
    env.no_proxy = env.no_proxy || "localhost,127.0.0.1,::1";

    const cwd = this.profile.defaultCwd && fs.existsSync(this.profile.defaultCwd) ? this.profile.defaultCwd : process.cwd();
    // Shell principle: fail fast with install guidance when the vendor CLI
    // is missing, instead of a cryptic spawn ENOENT/EINVAL.
    const resolved = whichCommand(this.profile.command);
    if (!resolved) {
      const hint = this.profile.installHint ? ` ${this.profile.installHint}` : "";
      throw new Error(`命令 '${this.profile.command}' 不在 PATH 中。${hint}`.trim());
    }
    const prepared = await this.hooks.prepareEnv?.({ cwd, resolvedCommand: resolved, env });
    if (prepared) Object.assign(env, prepared);
    console.log(`[UniversalACP:${this.profile.id}] spawn: ${this.profile.command} ${(this.profile.args || []).join(" ")}`);

    const proc = spawnCrossPlatform(this.profile.command, this.profile.args || [], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    this.startedAtIso = new Date().toISOString();

    proc.on("error", (err) => {
      this.lastErrorText = `spawn error: ${(err as Error).message}`;
      console.error(`[UniversalACP:${this.profile.id}]`, this.lastErrorText);
    });
    proc.on("exit", (code, signal) => {
      console.warn(`[UniversalACP:${this.profile.id}] exited code=${code} signal=${signal} stderrTail=${this.stderrTail.slice(-3).join(" | ")}`);
      // Only clear the stream we own: a stale exit must not orphan a new process.
      if (this.proc === proc) this.conn = null;
      // Fail pending permission/elicitation so prompt turns don't hang forever
      this.hooks.onExit?.(code, signal);
      if (!this.lastErrorText && (code !== 0 || signal)) {
        const details = this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(" | ")}` : "";
        this.lastErrorText = `Agent process exited unexpectedly (code ${code}, signal ${signal})${details}`;
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        this.stderrTail.push(t);
        if (this.stderrTail.length > 50) this.stderrTail.shift();
      }
      process.stderr.write(`[ACP:${this.profile.id}] ${text}`);
    });

    if (!proc.stdin || !proc.stdout) {
      throw new Error(`Failed to open stdio pipes for ${this.profile.id}`);
    }

    const toWebWritable = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>;
    const toWebReadable = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toWebWritable, toWebReadable);

    const app = acp
      .client({ name: "autumnflow-universal" })
      .onRequest(acp.methods.client.session.requestPermission, ctx => handlers.requestPermission(ctx.params, ctx.signal))
      .onRequest(acp.methods.client.fs.readTextFile, ctx => handlers.readTextFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, ctx => handlers.writeTextFile(ctx.params))
      .onRequest(acp.methods.client.terminal.create, ctx => handlers.createTerminal(ctx.params))
      .onRequest(acp.methods.client.terminal.output, ctx => handlers.terminalOutput(ctx.params))
      .onRequest(acp.methods.client.terminal.release, ctx => handlers.terminalRelease(ctx.params))
      .onRequest(acp.methods.client.terminal.waitForExit, ctx => handlers.terminalWaitForExit(ctx.params))
      .onRequest(acp.methods.client.terminal.kill, ctx => handlers.terminalKill(ctx.params))
      .onRequest(acp.methods.client.elicitation.create, ctx => handlers.createElicitation(ctx.params, ctx.signal))
      .onNotification(acp.methods.client.session.update, ctx => handlers.sessionUpdate(ctx.params))
      .onNotification(acp.methods.client.elicitation.complete, ctx => handlers.elicitationComplete(ctx.params));

    this.conn = app.connect(stream);

    // initialize handshake with full client capabilities (ACP v1)
    try {
      const res = await requestAgent(this.conn, acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          ...clientCapabilities,
          auth: { terminal: this.hooks.terminalAuthAvailable?.(resolved) ?? false },
        },
        clientInfo: { name: "autumnflow-universal", title: "AutumnFlow Universal", version: "1.0.0" },
      });
      if (res.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(`Unsupported ACP protocol version: ${res.protocolVersion}`);
      this.initResult = res;
      this.hooks.onInitialized?.(res);
      console.log(`[UniversalACP:${this.profile.id}] initialize ok protocol=${this.initResult.protocolVersion}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? "ACP connection failed");
      const stderr = this.stderrTail.length ? `. stderr: ${this.stderrTail.slice(-5).join(" | ")}` : "";
      this.lastErrorText = `initialize failed: ${msg}${stderr}`;
      console.error(`[UniversalACP:${this.profile.id}]`, this.lastErrorText);
      await this.stop().catch(() => undefined);
      throw new Error(this.lastErrorText);
    }

    return this.initResult;
  }
}
