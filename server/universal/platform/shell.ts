import * as fs from "node:fs";
import * as path from "node:path";
import { whichCommand } from "./spawn";

export type ShellKind = "pwsh" | "powershell" | "cmd" | "posix" | "custom";

export interface ResolvedShell {
  shell: string;
  args: string[];
  kind: ShellKind;
  label: string;
}

export interface ResolveShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: (command: string) => string | null;
  exists?: (file: string) => boolean;
}

/** PowerShell switches must not load -NoProfile: the user's own profile is the point. */
export function shellArgsFor(shell: string): string[] {
  const base = path.basename(shell).toLowerCase();
  return base === "pwsh" || base === "pwsh.exe" || base === "powershell" || base === "powershell.exe"
    ? ["-NoLogo"]
    : [];
}

export function shellKindFor(shell: string): ShellKind {
  const base = path.basename(shell).toLowerCase();
  if (base === "pwsh" || base === "pwsh.exe") return "pwsh";
  if (base === "powershell" || base === "powershell.exe") return "powershell";
  if (base === "cmd" || base === "cmd.exe") return "cmd";
  return base.includes("sh") ? "posix" : "custom";
}

function labelFor(shell: string, kind: ShellKind): string {
  if (kind === "pwsh") return "PowerShell 7+";
  if (kind === "powershell") return "Windows PowerShell";
  if (kind === "cmd") return "Command Prompt";
  const base = path.basename(shell).replace(/\.(exe|cmd|bat)$/i, "");
  return base || shell;
}

/**
 * Pick the interactive shell the same way a normal terminal would:
 * explicit ACP_TERMINAL_SHELL override > PowerShell 7 (pwsh) > Windows
 * PowerShell > COMSPEC/cmd > $SHELL > common POSIX shells.
 *
 * `which`/`exists` are injectable so tests stay deterministic and do not
 * depend on whether the CI machine happens to have PowerShell 7 installed.
 */
export function resolveInteractiveShell(opts: ResolveShellOptions = {}): ResolvedShell {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const which = opts.which ?? whichCommand;
  const exists = opts.exists ?? fs.existsSync;

  const override = String(env.ACP_TERMINAL_SHELL || "").trim();
  if (override) {
    const shell = path.isAbsolute(override) ? override : (which(override) || override);
    const kind = shellKindFor(shell);
    return { shell, args: shellArgsFor(shell), kind, label: labelFor(shell, kind) };
  }

  if (platform === "win32") {
    for (const candidate of ["pwsh.exe", "pwsh", "powershell.exe", "powershell"]) {
      const shell = which(candidate);
      if (shell) {
        const kind = shellKindFor(shell);
        return { shell, args: shellArgsFor(shell), kind, label: labelFor(shell, kind) };
      }
    }
    // GUI launches sometimes miss a freshly-installed PowerShell 7 on PATH.
    const programFiles = String(env.ProgramFiles || env.PROGRAMFILES || "C:\\Program Files").trim();
    const localAppData = String(env.LOCALAPPDATA || "").trim();
    for (const shell of [
      path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
      path.join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
      localAppData ? path.join(localAppData, "Microsoft", "WindowsApps", "pwsh.exe") : "",
    ]) {
      if (shell && exists(shell)) {
        return { shell, args: ["-NoLogo"], kind: "pwsh", label: labelFor(shell, "pwsh") };
      }
    }
    const comspec = String(env.COMSPEC || env.ComSpec || "").trim();
    if (comspec && exists(comspec)) {
      const kind = shellKindFor(comspec);
      return { shell: comspec, args: [], kind, label: labelFor(comspec, kind) };
    }
    const cmd = which("cmd.exe") || which("cmd");
    if (cmd) {
      const kind = shellKindFor(cmd);
      return { shell: cmd, args: [], kind, label: labelFor(cmd, kind) };
    }
    return { shell: "cmd.exe", args: [], kind: "cmd", label: "Command Prompt" };
  }

  for (const candidate of [String(env.SHELL || "").trim(), "/bin/bash", "/bin/zsh", "/bin/sh"]) {
    if (candidate && exists(candidate)) {
      const kind = shellKindFor(candidate);
      return { shell: candidate, args: [], kind, label: labelFor(candidate, kind) };
    }
  }
  return { shell: "/bin/sh", args: [], kind: "posix", label: "sh" };
}

/** One-shot command arguments for the resolved shell (terminal/exec fallback). */
export function execArgsFor(shell: ResolvedShell, command: string): string[] {
  if (shell.kind === "pwsh" || shell.kind === "powershell") return ["-NoProfile", "-Command", command];
  if (shell.kind === "cmd") return ["/d", "/s", "/c", command];
  return ["-c", command];
}
