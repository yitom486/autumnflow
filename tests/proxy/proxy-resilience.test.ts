import { describe, it, expect } from "vitest";
import viteConfig from "@/../vite.config";

describe("Vite Proxy Network Resilience Configuration", () => {
  it("configures /api proxy with correct upstream target and options", () => {
    const config = typeof viteConfig === "function" ? (viteConfig as any)({}) : viteConfig;
    const proxy = config.server?.proxy?.["/api"];

    expect(proxy).toBeDefined();
    expect(proxy.target).toBe("http://127.0.0.1:25015");
    expect(proxy.changeOrigin).toBe(true);
    // ws MUST be false to prevent http-proxy from treating SSE long-polling/streams as WebSocket upgrades
    expect(proxy.ws).toBe(false);
  });

  it("includes a proxy error configure hook to suppress benign ECONNRESET", () => {
    const config = typeof viteConfig === "function" ? (viteConfig as any)({}) : viteConfig;
    const proxy = config.server?.proxy?.["/api"];

    expect(typeof proxy.configure).toBe("function");

    // Test the configure error handler
    let registeredErrorHandler: ((err: any) => void) | null = null;
    const mockProxyInstance = {
      on: (event: string, handler: any) => {
        if (event === "error") {
          registeredErrorHandler = handler;
        }
      },
    };

    proxy.configure(mockProxyInstance);
    expect(registeredErrorHandler).toBeDefined();

    // Call with ECONNRESET - should be absorbed quietly
    expect(() => {
      registeredErrorHandler!({ code: "ECONNRESET", message: "read ECONNRESET" });
    }).not.toThrow();
  });
});
