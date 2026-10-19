import { describe, expect, it } from "vitest";
import { execArgsFor, resolveInteractiveShell, shellArgsFor, shellKindFor } from "../../server/universal/platform/shell";

describe("interactive shell resolution", () => {
  it.each([
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "pwsh", ["-NoLogo"]],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "powershell", ["-NoLogo"]],
    ["C:\\Windows\\System32\\cmd.exe", "cmd", []],
    ["/usr/local/bin/pwsh", "pwsh", ["-NoLogo"]],
    ["/bin/bash", "posix", []],
  ])("recognizes shell path %s on every host", (shell, kind, args) => {
    expect(shellKindFor(shell)).toBe(kind);
    expect(shellArgsFor(shell)).toEqual(args);
  });
  it("prefers PowerShell 7 (pwsh) over Windows PowerShell 5.1", () => {
    const calls: string[] = [];
    const resolved = resolveInteractiveShell({
      platform: "win32",
      env: {},
      exists: () => false,
      which: (command) => {
        calls.push(command);
        return command === "pwsh.exe" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null;
      },
    });
    expect(resolved.kind).toBe("pwsh");
    expect(resolved.shell).toContain("pwsh.exe");
    expect(resolved.args).toEqual(["-NoLogo"]);
    expect(calls[0]).toBe("pwsh.exe");
  });

  it("falls back to Windows PowerShell, then COMSPEC, then cmd", () => {
    const ps = resolveInteractiveShell({
      platform: "win32",
      env: {},
      exists: () => false,
      which: (command) => (command === "powershell.exe" ? "C:\\Windows\\powershell.exe" : null),
    });
    expect(ps.kind).toBe("powershell");

    const cmd = resolveInteractiveShell({
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      exists: (file) => file === "C:\\Windows\\System32\\cmd.exe",
      which: () => null,
    });
    expect(cmd.kind).toBe("cmd");
    expect(cmd.shell).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("honors an explicit user override", () => {
    const resolved = resolveInteractiveShell({
      platform: "win32",
      env: { ACP_TERMINAL_SHELL: "D:\\tools\\nu.exe" },
      exists: () => false,
      which: () => "D:\\tools\\nu.exe",
    });
    expect(resolved.shell).toBe("D:\\tools\\nu.exe");
    expect(resolved.kind).toBe("custom");
  });

  it("uses $SHELL on POSIX and builds shell-specific one-shot args", () => {
    const resolved = resolveInteractiveShell({
      platform: "linux",
      env: { SHELL: "/usr/bin/zsh" },
      exists: (file) => file === "/usr/bin/zsh",
      which: () => null,
    });
    expect(resolved.shell).toBe("/usr/bin/zsh");
    expect(resolved.kind).toBe("posix");
    expect(execArgsFor(resolved, "echo hi")).toEqual(["-c", "echo hi"]);
    expect(shellArgsFor("pwsh.exe")).toEqual(["-NoLogo"]);
    expect(execArgsFor({ shell: "pwsh.exe", args: ["-NoLogo"], kind: "pwsh", label: "PowerShell 7+" }, "Get-Date")).toEqual([
      "-NoProfile",
      "-Command",
      "Get-Date",
    ]);
  });
});
