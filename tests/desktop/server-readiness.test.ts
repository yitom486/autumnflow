// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { waitForServer } from "../../desktop/server-readiness";

function ok(): Response {
  return new Response("ok", { status: 200 });
}

describe("dev server readiness", () => {
  it("returns as soon as one url answers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await expect(waitForServer({ urls: ["http://127.0.0.1:1/"], fetchImpl })).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting while the server is busy and reports progress", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      attempts += 1;
      // A server that is still pre-bundling: the request never lands in time.
      if (attempts < 3) throw new Error("aborted");
      return ok();
    });
    const hints: number[] = [];
    await expect(
      waitForServer({ urls: ["http://127.0.0.1:1/"], fetchImpl, hintEveryMs: 1, onHint: (s) => hints.push(s) })
    ).resolves.toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(hints.length).toBeGreaterThan(0);
  });

  it("gives up only after the whole budget, not after one slow request", async () => {
    // The launcher used to abort the child at 15s, which killed Vite in the
    // middle of its dependency pre-bundle and left the cache unwritten.
    const fetchImpl = vi.fn().mockRejectedValue(new Error("aborted"));
    const started = Date.now();
    await expect(
      waitForServer({ urls: ["http://127.0.0.1:1/"], fetchImpl, timeoutMs: 1500 })
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });

  it("treats a server error as not ready yet", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(
      waitForServer({ urls: ["http://127.0.0.1:1/"], fetchImpl, timeoutMs: 400 })
    ).resolves.toBe(false);
  });

  it("falls back to the next url when the first one is unreachable", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("localhost")) throw new Error("ECONNREFUSED");
      return ok();
    });
    await expect(
      waitForServer({ urls: ["http://localhost:1/", "http://127.0.0.1:1/"], fetchImpl })
    ).resolves.toBe(true);
  });
});
