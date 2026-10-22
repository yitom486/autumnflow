import { assertPortAvailable } from "./port-availability";
import { setupEnv, PORT, HOST, buildApp, MCP_PORT, shutdownBridges } from "./gateway";
import { gatewayBootstrapUrl, gatewayTokenPreview } from "./universal/security";
import { startMcpUiServer } from "./universal/mcp-ui-server";
import { resolveRuntimeConfig } from "../shared/runtime-config";

setupEnv();
await assertPortAvailable(PORT, HOST);

const app = buildApp();

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // Disable idle timeout so server never exits
  fetch: app.fetch,
});

// Start dedicated 5-digit MCP Server (auto-cascade starting from 25920)
await startMcpUiServer(MCP_PORT).catch((err) => {
  console.warn(`[Server] 启动 MCP UI 端口服务失败: ${(err as Error)?.message || err}`);
});

// Explicit keepalive timer to ensure Bun process never drains event loop when idle on Windows
const keepAliveTimer = setInterval(() => {}, 60_000);

const gracefulShutdown = async () => {
  console.log("\n[Server] Shutting down cleanly...");
  clearInterval(keepAliveTimer);
  server.stop(true);
  await shutdownBridges();
  process.exit(0);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

console.log(`[Server] AutumnFlow server running at http://127.0.0.1:${PORT}`);
console.log(`[Server] gateway token: ${gatewayTokenPreview()} (full token in ~/.autumnflow/.gateway-token)`);
// 所有 /api/universal/* 都要 token。浏览器模式用下面的一次性链接打开 UI（Jupyter 式，
// 前端读取后存 localStorage 并从地址栏抹掉）；只打到本机终端，不写入任何文件。
console.log(`[Server] open the UI with:  ${gatewayBootstrapUrl(`http://localhost:${resolveRuntimeConfig().vitePort}`)}  (vite dev)`);
console.log(`[Server]              or:  ${gatewayBootstrapUrl(`http://127.0.0.1:${PORT}`)}  (built dist)`);
// Antigravity quota live probe updated: language server port dynamic detection
