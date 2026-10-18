import { randomUUID } from "node:crypto";
import { RequestError, type AuthMethodTerminal } from "@agentclientprotocol/sdk";
import { createPtySession, destroyPtySession, isPtyAvailable, resolvePtyCwd, type PtySession } from "./pty";
import type { AgentProfile } from "./types";

/** Terminal auth runs the host's configured executable, never a descriptor-supplied command. */
export function terminalAuthInvocation(profile: AgentProfile, executable: string, method: AuthMethodTerminal) {
  return { command: executable, args: [...(profile.args ?? []), ...(method.args ?? [])], env: { ...process.env, ...profile.env, ...method.env } };
}

export class TerminalAuthentication {
  private sessions = new Map<string, PtySession>();
  constructor(private profile: AgentProfile) {}
  available(executable: string): boolean {
    return isPtyAvailable() && !(process.platform === "win32" && /\.(cmd|bat)$/i.test(executable));
  }
  start(executable: string, method: AuthMethodTerminal): { ptyId: string; cwd: string } {
    if (!this.available(executable)) throw RequestError.methodNotFound("Interactive terminal authentication unavailable for this invocation");
    const directory = resolvePtyCwd(this.profile.defaultCwd || process.cwd());
    if (!directory.ok) throw RequestError.invalidParams(undefined, directory.error);
    const id = `acp-auth-${randomUUID()}`;
    const session = createPtySession(id, directory.cwd, { cols: 80, rows: 18 }, undefined, terminalAuthInvocation(this.profile, executable, method));
    let history = "";
    session.onData(data => { history = (history + data).slice(-65536); });
    session.initialOutput = () => history;
    session.onExit(() => {}); // Record the actual process status even before the UI attaches.
    this.sessions.set(id, session);
    return { ptyId: id, cwd: directory.cwd };
  }
  finish(id: string): void {
    const session = this.sessions.get(id);
    if (!session) throw RequestError.invalidParams(undefined, "Unknown authentication terminal");
    if (!session.exited) throw RequestError.invalidParams(undefined, "Authentication process is still running");
    const success = session.exitCode === 0;
    this.cancel(id);
    if (!success) throw new Error("Terminal authentication did not exit successfully");
  }
  cancel(id: string): void {
    if (!this.sessions.has(id)) return;
    destroyPtySession(id); this.sessions.delete(id);
  }
  dispose(): void { for (const id of [...this.sessions.keys()]) this.cancel(id); }
}
