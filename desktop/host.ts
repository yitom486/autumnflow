/**
 * Production gateway host.
 *
 * Runs under `ELECTRON_RUN_AS_NODE=1` as a child of the Electron main process,
 * so HTTP/SSE/PTY and agent subprocesses are isolated from the UI shell. The
 * parent only owns windows, native dialogs, updates and lifecycle; this process
 * owns the gateway, MCP UI server, PTY WebSocket upgrades and agent bridges.
 */
import { serve } from "@hono/node-server";
import {
  PORT,
  MCP_PORT,
  buildApp,
  setupEnv,
  shutdownBridges,
} from "../server/gateway";
import { assertPortAvailable } from "../server/port-availability";
import { attachPtyUpgrade } from "../server/universal/pty";
import { setTrashImpl } from "../server/universal/http/files";
import { flushSessionJournal, getSessionJournal } from "../server/universal/session-journal";
import { startMcpUiServer, stopMcpUiServer } from "../server/universal/mcp-ui-server";

type HostMessage =
  | { type: "ready"; port: number }
  | { type: "fatal"; error: string }
  | { type: "shutdown-ack" }
  | { type: "trash"; id: string; path: string };

function send(message: HostMessage): void {
  try {
    process.send?.(message);
  } catch {
    // Parent already gone; stderr still carries the diagnostic.
  }
}

let shuttingDown = false;
let netServer: ReturnType<typeof serve> | null = null;

const pendingTrash = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let trashSeq = 0;

// The UI process owns Electron's shell.trashItem; ask it so deleting a file
// still goes to the OS recycle bin after the gateway moved out of process.
setTrashImpl(
  (abs) =>
    new Promise<void>((resolve, reject) => {
      const id = `trash-${Date.now().toString(36)}-${++trashSeq}`;
      const timer = setTimeout(() => {
        pendingTrash.delete(id);
        reject(new Error("trash request timed out (UI process did not reply)"));
      }, 5000);
      pendingTrash.set(id, { resolve, reject, timer });
      try {
        send({ type: "trash", id, path: abs });
      } catch (err) {
        clearTimeout(timer);
        pendingTrash.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })
);

async function shutdown(reason = "shutdown"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Host] shutting down (${reason})`);
  try {
    netServer?.close();
  } catch (err) {
    console.warn("[Host] gateway close failed:", err);
  }
  await shutdownBridges().catch((err) => {
    console.warn("[Host] bridge shutdown failed:", err);
  });
  await flushSessionJournal().catch((err) => {
    console.warn("[Host] session journal flush failed:", err);
  });
  await stopMcpUiServer().catch((err) => {
    console.warn("[Host] MCP UI shutdown failed:", err);
  });
  send({ type: "shutdown-ack" });
  // Let the parent receive the ack before the process disappears.
  setTimeout(() => process.exit(0), 30);
}

async function main(): Promise<void> {
  setupEnv();
  void getSessionJournal()?.prune().catch((err) => {
    console.warn("[Host] session journal prune failed:", err);
  });
  await assertPortAvailable(PORT, "127.0.0.1");
  await startMcpUiServer(MCP_PORT).catch((err) => {
    console.warn(`[Host] MCP UI server failed to start: ${(err as Error)?.message || err}`);
  });

  const app = buildApp();
  netServer = serve(
    { fetch: app.fetch, port: PORT, hostname: "127.0.0.1" },
    (info) => {
      console.log(`[Host] gateway listening at http://127.0.0.1:${info.port}`);
    }
  );
  // Never cut long-lived SSE streams.
  netServer.requestTimeout = 0;
  netServer.headersTimeout = 0;
  // PTY WebSocket upgrade belongs to the host, never the Electron UI process.
  await attachPtyUpgrade(netServer as never);
  send({ type: "ready", port: PORT });
}

process.on("message", (message: any) => {
  if (message?.type === "shutdown") void shutdown("parent request");
  if (message?.type === "trash-result") {
    const pending = pendingTrash.get(String(message.id || ""));
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingTrash.delete(String(message.id || ""));
    if (message.ok) pending.resolve();
    else pending.reject(new Error(String(message.error || "trash failed")));
  }
});
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("[Host] uncaught exception:", error);
  send({ type: "fatal", error: error instanceof Error ? (error.stack || error.message) : String(error) });
  void shutdown("uncaught exception");
});
process.on("unhandledRejection", (reason) => {
  console.error("[Host] unhandled rejection:", reason);
  send({ type: "fatal", error: reason instanceof Error ? (reason.stack || reason.message) : String(reason) });
});

main().catch((error) => {
  console.error("[Host] startup failed:", error);
  send({ type: "fatal", error: error instanceof Error ? (error.stack || error.message) : String(error) });
  void shutdown("startup failure");
});
