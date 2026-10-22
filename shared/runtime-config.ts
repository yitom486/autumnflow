export type RuntimeMode = "development" | "production";

function port(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return Number(value);
}

/** Shared by the launcher, gateways and Vite so HTTP and terminal traffic agree. */
export function resolveRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
  args: string[] = process.argv,
  mode?: RuntimeMode,
) {
  const development = (mode ?? (env.ACP_RUNTIME_MODE === "development" || env.ELECTRON_DEV === "1" || args.includes("--development")
    ? "development" : "production")) === "development";
  const argument = (name: string) => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
    return args[index + 1];
  };
  return {
    mode: development ? "development" as const : "production" as const,
    // 端口一律挑 25000–30000：Windows 的动态（临时）端口范围是 1024–15000，
    // 任何程序的出站连接都会随机占用里面的端口，监听端口落在那里会被系统
    // 拒绝（EACCES，表现为"permission denied"）。这一段在动态范围之外。
    gatewayPort: port(env.PORT ?? argument("--port"), development ? 25015 : 25005, "PORT"),
    mcpPort: port(env.MCP_PORT, development ? 25930 : 25920, "MCP_PORT"),
    vitePort: port(env.ACP_DEV_VITE_PORT, 25188, "ACP_DEV_VITE_PORT"),
    host: env.HOST || argument("--host") || "127.0.0.1",
  };
}
