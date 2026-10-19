/**
 * Standalone process and port cleaner for AutumnFlow.
 * Run: bun run clean
 */
import { spawn, execSync } from "node:child_process";

const isWin = process.platform === "win32";
const gatewayPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 13005;
const wslPort = process.env.ACP_WSL_PORT ? parseInt(process.env.ACP_WSL_PORT, 10) : 13006;
const vitePort = process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 5188;

const PORTS_TO_CLEAN = [
  { port: vitePort, name: "Vite Dev Server" },
  { port: gatewayPort, name: "Gateway Server (Host)" },
  { port: wslPort, name: "WSL Gateway Server" },
];

console.log("[clean] 正在检查并清理残留的 Electron 进程与占用端口...");

function cleanPort(port: number, name: string) {
  if (!isWin) {
    try {
      execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" });
    } catch {}
    return;
  }
  try {
    const stdout = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
      encoding: "utf8",
      windowsHide: true,
    });
    const pids = new Set<number>();
    for (const line of stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid && !isNaN(pid) && pid !== process.pid) {
        pids.add(pid);
      }
    }
    for (const pid of pids) {
      console.log(`[clean] 回收端口 ${port} (${name}) 残留进程 PID ${pid}...`);
      try {
        execSync(`taskkill /F /T /PID ${pid}`, { windowsHide: true, stdio: "ignore" });
      } catch {}
    }
    if (pids.size === 0) {
      console.log(`[clean] 端口 ${port} (${name}) 当前空闲。`);
    }
  } catch {
    console.log(`[clean] 端口 ${port} (${name}) 当前空闲。`);
  }
}

for (const item of PORTS_TO_CLEAN) {
  cleanPort(item.port, item.name);
}

if (isWin) {
  try {
    const p = spawn("taskkill", ["/F", "/IM", "electron.exe"], {
      stdio: "inherit",
      shell: true,
    });
    p.on("close", (code) => {
      if (code === 0) {
        console.log("[clean] 已清理残留的 electron.exe 进程。");
      } else {
        console.log("[clean] 没有发现运行中的 electron.exe 进程。");
      }
    });
  } catch (err) {
    console.warn("[clean] 执行 taskkill 异常:", err);
  }
} else {
  try {
    spawn("pkill", ["-f", "electron.*main.cjs"], { stdio: "inherit" });
    console.log("[clean] 已发送退出信号给残留进程。");
  } catch {}
}
