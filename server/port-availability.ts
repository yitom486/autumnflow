import { createServer } from "node:net";

/** 端口不可用：带着错误码，调用方据此决定是换端口还是直接报错。 */
export class PortUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly port: number,
    readonly host: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PortUnavailableError";
  }
}

/**
 * 端口不可用时的说法，要让人知道下一步做什么。
 *
 * Windows 的动态端口范围默认是 1024–15000，出站连接会从里面随机挑本地端口。
 * 端口落在那个范围里又被占着时，绑定监听报的是 EACCES（"permission denied"），
 * 而不是通常的 EADDRINUSE——看着像权限/防火墙问题，其实只是撞了临时端口。
 */
function describeBindFailure(service: string, host: string, port: number, error: NodeJS.ErrnoException): string {
  if (error.code === "EADDRINUSE") {
    return `${service} 端口 ${host}:${port} 已被占用。请关闭占用该端口的实例，或设置其他端口后重试；不会自动结束已有进程。`;
  }
  if (error.code === "EACCES") {
    return `${service} 无法监听 ${host}:${port}：这个端口此刻被别的程序当成"临时端口"占着（Windows 动态端口范围 1024–15000，出站连接会随机占用里面的端口），系统因此拒绝在这里监听。不是权限问题，不用改防火墙；换一个端口即可。`;
  }
  return `${service} 无法监听 ${host}:${port}: ${error.message}`;
}

/** Check availability without terminating any process, including another Studio. */
export function assertPortAvailable(port: number, host = "127.0.0.1", service = "Gateway"): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(new PortUnavailableError(
        describeBindFailure(service, host, port, error),
        error.code ?? "UNKNOWN",
        port,
        host,
        { cause: error },
      ));
    });
    probe.listen({ port, host, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

export interface ResolvePortOptions {
  host?: string;
  service?: string;
  /** 从 start 起最多试几个端口。 */
  attempts?: number;
  /** 探测用哪套实现（测试注入）。 */
  probe?: (port: number, host: string) => Promise<void>;
}

/**
 * 找一个能用的端口：从 start 起往后找。
 *
 * 只在"被临时端口占用"（EACCES）时顺延——那说明撞的是系统动态端口，换个号就行。
 * 真有人监听（EADDRINUSE）照旧报错，免得悄悄开出第二个实例。
 */
export async function resolveAvailablePort(start: number, options: ResolvePortOptions = {}): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const service = options.service ?? "Gateway";
  const attempts = Math.max(1, options.attempts ?? 20);
  const probe = options.probe ?? ((port: number, probeHost: string) => assertPortAvailable(port, probeHost, service));
  let lastError: unknown;
  for (let offset = 0; offset < attempts; offset++) {
    const port = start + offset;
    try {
      await probe(port, host);
      return port;
    } catch (error) {
      lastError = error;
      if (!(error instanceof PortUnavailableError) || error.code !== "EACCES") throw error;
    }
  }
  throw lastError;
}
