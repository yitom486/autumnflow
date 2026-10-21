import { describe, it, expect } from "vitest";
import {
  parseWslCwd,
  wslUncFromLinux,
  ptySpawnForCwd,
  execSpawnForCwd,
  gitSpawnForCwd,
} from "../../server/universal/wsl";
import type { ResolvedShell } from "../../server/universal/platform/shell";
import { parseWslDistros, getSystemDirectoryRoots } from "../../server/universal/http/workspace";
import { parseWslDistro } from "@/components/universal/TerminalDrawer";

const UNC = "\\\\wsl$\\Ubuntu\\home\\u\\proj";

describe("wsl paths", () => {
  it("parses \\\\wsl$\\ and \\\\wsl.localhost\\ prefixes (either slash)", () => {
    expect(parseWslCwd(UNC)).toEqual({ distro: "Ubuntu", linuxPath: "/home/u/proj" });
    expect(parseWslCwd("//wsl$/Ubuntu/home/u/proj")).toEqual({ distro: "Ubuntu", linuxPath: "/home/u/proj" });
    expect(parseWslCwd("\\\\wsl.localhost\\Debian\\root\\app")).toEqual({ distro: "Debian", linuxPath: "/root/app" });
    // 大小写不敏感 + distro 根
    expect(parseWslCwd("\\\\WSL$\\Ubuntu")).toEqual({ distro: "Ubuntu", linuxPath: "/" });
    expect(parseWslCwd("\\\\wsl$\\Ubuntu\\")).toEqual({ distro: "Ubuntu", linuxPath: "/" });
  });

  it("rejects non-wsl paths", () => {
    expect(parseWslCwd("D:\\repo\\proj")).toBeNull();
    expect(parseWslCwd("/home/u/proj")).toBeNull();
    expect(parseWslCwd("")).toBeNull();
    expect(parseWslCwd("\\\\server\\share\\x")).toBeNull();
  });

  it("round-trips linux paths back to UNC", () => {
    expect(wslUncFromLinux("Ubuntu", "/home/u/proj")).toBe(UNC);
    expect(wslUncFromLinux("Ubuntu", "/")).toBe("\\\\wsl$\\Ubuntu");
  });

  it("routes PTY through wsl.exe on win32, keeps platform shells otherwise", () => {
    const winShell: ResolvedShell = {
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo"],
      kind: "powershell",
      label: "Windows PowerShell",
    };
    expect(ptySpawnForCwd("win32", UNC, "C:\\gw")).toEqual({
      shell: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/u/proj"],
      spawnCwd: "C:\\gw",
    });
    expect(ptySpawnForCwd("win32", "D:\\repo", "C:\\gw", winShell)).toMatchObject({ shell: winShell.shell });
    expect(ptySpawnForCwd("linux", "/home/u", "/srv", { ...winShell, shell: "/bin/bash", kind: "posix" }).spawnCwd).toBe("/home/u");
  });

  it("routes one-shot exec through wsl sh -c (linux parity)", () => {
    const winShell: ResolvedShell = {
      shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: ["-NoLogo"],
      kind: "powershell",
      label: "Windows PowerShell",
    };
    expect(execSpawnForCwd("win32", UNC, "go build ./...", "C:\\gw")).toEqual({
      shell: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/u/proj", "--", "sh", "-c", "go build ./..."],
      spawnCwd: "C:\\gw",
    });
    expect(execSpawnForCwd("win32", "D:\\r", "dir", "C:\\gw", winShell)).toEqual({
      shell: winShell.shell,
      args: ["-NoProfile", "-Command", "dir"],
      spawnCwd: "D:\\r",
    });
  });

  it("routes git through wsl git (UNC cannot be a child cwd)", () => {
    expect(gitSpawnForCwd("win32", UNC, ["status"], "C:\\gw")).toEqual({
      shell: "wsl.exe",
      args: ["-d", "Ubuntu", "--cd", "/home/u/proj", "--", "git", "status"],
      spawnCwd: "C:\\gw",
    });
    expect(gitSpawnForCwd("linux", "/r", ["status"], "/srv")).toEqual({
      shell: "git",
      args: ["status"],
      spawnCwd: "/r",
    });
  });

  it("frontend badge parses the same distro (drift guard)", () => {
    expect(parseWslDistro(UNC)).toBe("Ubuntu");
    expect(parseWslDistro("D:\\repo")).toBeNull();
  });

  it("parses wsl -l -q output (utf16 decoded, default marker, header skip)", () => {
    expect(parseWslDistros("Ubuntu\r\nDebian\r\n")).toEqual(["Ubuntu", "Debian"]);
    expect(parseWslDistros("Ubuntu*\r\ndocker-desktop\r\n")).toEqual(["Ubuntu", "docker-desktop"]);
    expect(parseWslDistros("Ubuntu (Default)\r\n")).toEqual(["Ubuntu"]);
    expect(parseWslDistros("Windows Subsystem for Linux Distributions:\r\nUbuntu\r\n")).toEqual(["Ubuntu"]);
    expect(parseWslDistros("")).toEqual([]);
  });

  it("never mistakes the no-distributions help text for distros", () => {
    const help = [
      "Windows Subsystem for Linux has no installed distributions.",
      "Distributions can be installed by visiting the Microsoft Store:",
      "https://aka.ms/wslstore",
    ].join("\r\n");
    expect(parseWslDistros(help)).toEqual([]);
  });

  it("getSystemDirectoryRoots returns home and roots", async () => {
    const roots = await getSystemDirectoryRoots();
    expect(roots.length).toBeGreaterThan(0);
    expect(roots[0].label).toContain("用户目录");
  });
});
