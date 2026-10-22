import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import {
  assertPortAvailable,
  resolveAvailablePort,
  PortUnavailableError,
} from "../../server/port-availability";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

describe("gateway port", () => {
  it("keeps the port when it is free", async () => {
    const port = await freePort();
    expect(await resolveAvailablePort(port)).toBe(port);
  });

  it("does not silently move on when someone else holds the port", async () => {
    // 另一个实例在监听：静默换端口会开出第二个实例，得报错让人去关掉那个。
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>(resolve => holder.listen(port, "127.0.0.1", resolve));
    try {
      await expect(resolveAvailablePort(port)).rejects.toThrow(/已被占用/);
    } finally {
      await new Promise<void>(resolve => holder.close(() => resolve()));
    }
  });

  it("moves to the next port when the port was taken as a temporary one", async () => {
    // Windows 的动态端口范围是 1024–15000，出站连接会随机占里面的端口，这时
    // 绑定报的是 EACCES（"permission denied"）而不是 EADDRINUSE。换一个号就行。
    const start = await freePort();
    const probe = async (port: number, host: string) => {
      if (port === start) throw new PortUnavailableError("被临时端口占用", "EACCES", port, host);
      await assertPortAvailable(port, host);
    };
    expect(await resolveAvailablePort(start, { probe })).toBe(start + 1);
  });
});
