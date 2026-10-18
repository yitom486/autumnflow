/**
 * WSL 路径与 spawn 映射（纯函数，可测）。
 *
 * 背景：Windows 网关要完整做 WSL 里的项目，`\\wsl$\<distro>\...` 经 9P 直通，
 * Node fs（workspace/files/git 的读盘）零改动可用；但子进程 cwd 不能是 UNC
 *（libuv/ConPTY 限制，PowerShell/原生 git 会直接起不来），所以 terminal/pty/git
 * 三处 spawn 必须改走 `wsl.exe -d <distro> --cd <linuxPath>`。
 * 前端无需改协议：服务端从 cwd 自动识别 WSL（`\\wsl$\` 或 `\\wsl.localhost\` 前缀）。
 */

import { execArgsFor, resolveInteractiveShell, type ResolvedShell } from "./platform/shell";

export interface WslLocation {
  distro: string;
  /** Linux 形态绝对路径（`/home/u/proj`，distro 根即 `/`）。 */
  linuxPath: string;
}

/** `\\wsl$\Ubuntu\home\u\proj`（或 wsl.localhost、前斜杠形态）→ distro + linux 路径；非 WSL → null。 */
export function parseWslCwd(raw: string): WslLocation | null {
  const m = /^(?:\\\\|\/\/)(wsl\$|wsl\.localhost)[\\\/]([^\\\/]+)([\\\/].*)?$/i.exec(
    String(raw || "").trim()
  );
  if (!m) return null;
  const distro = m[2];
  const rest = (m[3] || "").replace(/[\\\/]+/g, "/").replace(/\/+$/, "");
  return { distro, linuxPath: rest ? (rest.startsWith("/") ? rest : `/${rest}`) : "/" };
}

/** Linux 路径映回 UNC（供 git rev-parse 等吐出 Linux 路径后转回，供 Node fs 继续用）。 */
export function wslUncFromLinux(distro: string, linuxPath: string): string {
  const clean = String(linuxPath || "")
    .replace(/\//g, "\\")
    .replace(/^\\+|\\+$/g, "");
  return clean ? `\\\\wsl$\\${distro}\\${clean}` : `\\\\wsl$\\${distro}`;
}

export interface SpawnPlan {
  shell: string;
  args: string[];
  /** 子进程真正的 cwd：WSL 时 UNC 不合法，回落网关 cwd（shell 真目录由 --cd 保证）。 */
  spawnCwd: string;
}

/** 交互 PTY 用：WSL 走 `wsl.exe -d D --cd /path`（默认 shell），其余用用户默认 shell（pwsh 优先）。 */
export function ptySpawnForCwd(
  platform: string,
  cwd: string,
  fallbackCwd: string,
  shell: ResolvedShell = resolveInteractiveShell({ platform: platform as NodeJS.Platform }),
): SpawnPlan {
  if (platform === "win32") {
    const wsl = parseWslCwd(cwd);
    if (wsl) {
      return { shell: "wsl.exe", args: ["-d", wsl.distro, "--cd", wsl.linuxPath], spawnCwd: fallbackCwd };
    }
    return { shell: shell.shell, args: shell.args, spawnCwd: cwd };
  }
  return { shell: shell.shell, args: shell.args, spawnCwd: cwd };
}

/** 单次执行用：WSL 走 `wsl.exe -- sh -c`（与 Linux 端 `/bin/sh -c` 同语义）。 */
export function execSpawnForCwd(
  platform: string,
  cwd: string,
  cmd: string,
  fallbackCwd: string,
  shell: ResolvedShell = resolveInteractiveShell({ platform: platform as NodeJS.Platform }),
): SpawnPlan {
  if (platform === "win32") {
    const wsl = parseWslCwd(cwd);
    if (wsl) {
      return {
        shell: "wsl.exe",
        args: ["-d", wsl.distro, "--cd", wsl.linuxPath, "--", "sh", "-c", cmd],
        spawnCwd: fallbackCwd,
      };
    }
  }
  return { shell: shell.shell, args: execArgsFor(shell, cmd), spawnCwd: cwd };
}

/** git 用：WSL 走 `wsl.exe -- git …`（Windows git  spawn 不了 UNC cwd）。 */
export function gitSpawnForCwd(
  platform: string,
  cwd: string,
  gitArgs: string[],
  fallbackCwd: string
): SpawnPlan {
  if (platform === "win32") {
    const wsl = parseWslCwd(cwd);
    if (wsl) {
      return {
        shell: "wsl.exe",
        args: ["-d", wsl.distro, "--cd", wsl.linuxPath, "--", "git", ...gitArgs],
        spawnCwd: fallbackCwd,
      };
    }
  }
  return { shell: "git", args: [...gitArgs], spawnCwd: cwd };
}
