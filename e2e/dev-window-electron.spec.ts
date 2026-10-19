import { test, expect } from "@playwright/test";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TEST_GATEWAY_TOKEN } from "../tests/helpers/gateway-auth";

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function visibleConsoleWindows(): Promise<string[]> {
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command", `
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleWindows {
      public delegate bool Callback(IntPtr h, IntPtr p);
      [DllImport("user32.dll")] public static extern bool EnumWindows(Callback c, IntPtr p);
      [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    }';
    $handles = [Collections.Generic.List[string]]::new();
    $callback = [ConsoleWindows+Callback]{ param($handle, $unused)
      if ([ConsoleWindows]::IsWindowVisible($handle)) {
        $owner = [uint32]0; [void][ConsoleWindows]::GetWindowThreadProcessId($handle, [ref]$owner);
        $processName = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName;
        if ($processName -in 'WindowsTerminal','OpenConsole','conhost','bun','node') { $handles.Add($handle.ToInt64().ToString()) }
      }; return $true
    };
    [void][ConsoleWindows]::EnumWindows($callback, [IntPtr]::Zero);
    $handles | ConvertTo-Json -Compress
  `], { windowsHide: true });
  const result = stdout.trim() ? JSON.parse(stdout) : [];
  return Array.isArray(result) ? result : [result];
}

for (const gateway of ["bun", "node"]) test(`actual ${gateway} development launcher shows its window and releases ports on restart`, async ({}, info) => {
  test.setTimeout(120000);
  test.skip(process.platform !== "win32", "Checks the Windows GUI launch flags and visible native window");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "acp-visible-window-"));
  const env = { ...process.env, ACP_GATEWAY: gateway,
    PORT: String(await freePort()), ACP_DEV_VITE_PORT: String(await freePort()), MCP_PORT: String(await freePort()),
    ACP_GATEWAY_TOKEN: TEST_GATEWAY_TOKEN, ACP_DISABLE_UPDATES: "1",
    ACP_USER_DATA_DIR: path.join(state, "profile"), ACP_AGENTS_FILE: path.join(state, "agents.json"),
    AUTUMNFLOW_RESOURCES_DIR: path.join(state, "resources"), ACP_DEFAULT_AGENT_ID: "e2e-agent",
    ACP_AGENTS_JSON: JSON.stringify([{ id: "e2e-agent", name: "e2e-agent", title: "Window Test Agent",
      command: "bun.exe", args: ["run", path.join(root, "tests/fixtures/e2e-studio-agent.ts")], builtin: false }]),
  };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const consoleWindowsBefore = await visibleConsoleWindows();
      const launcher = spawn("bun.exe", ["-e", 'process.stdin.once("data",()=>process.emit("SIGINT")); await import("./desktop/dev.ts");'], {
        cwd: root, env, windowsHide: true, stdio: "pipe",
      });
      let logs = "";
      launcher.stdout.on("data", data => { logs += data.toString(); });
      launcher.stderr.on("data", data => { logs += data.toString(); });
      try {
        await expect.poll(() => logs.includes("窗口已显示 (visible=true)"), { timeout: 30000 }).toBe(true);
        const pid = Number(/Electron 已启动 \(PID (\d+)\)/.exec(logs)?.[1]);
        expect(pid).toBeGreaterThan(0);
        const inspect = async () => {
          const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-Command",
            `(Get-Process -Id ${pid}).MainWindowHandle.ToInt64()`], { windowsHide: true });
          return Number(stdout.trim());
        };
        await expect.poll(inspect, { timeout: 10000 }).toBeGreaterThan(0);
        const consoleWindowsAfter = await visibleConsoleWindows();
        expect(consoleWindowsAfter.filter(handle => !consoleWindowsBefore.includes(handle)), "No extra visible terminal window").toEqual([]);
      } finally {
        if (launcher.exitCode === null) {
          const stopped = once(launcher, "exit"); launcher.stdin.write("\n");
          await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error("Launcher did not shut down")), 15000).unref())]);
        }
        await info.attach(`launcher-log-${attempt}`, { body: logs.replace(/token=[^\s]+/g, "token=[redacted]"), contentType: "text/plain" });
      }
      expect(launcher.exitCode).toBe(0);
      for (const port of [env.PORT, env.ACP_DEV_VITE_PORT, env.MCP_PORT]) {
        const probe = createServer();
        await new Promise<void>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(Number(port), "0.0.0.0", resolve);
        });
        await new Promise<void>(resolve => probe.close(() => resolve()));
      }
    }
  } finally {
    const target = path.resolve(state);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("acp-visible-window-")) throw new Error("Unexpected fixture directory");
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
});
