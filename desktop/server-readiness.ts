/**
 * Readiness probe for the dev launcher.
 *
 * Vite reports "ready" in a few seconds but keeps requests pending while it
 * re-optimizes dependencies after a lockfile change. On this dependency graph
 * the full pre-bundle takes ~45s, and the first HTTP answer only arrives
 * after that. A launcher that gives up early kills the child mid-optimize:
 * the cache is never written, so every later start repeats the whole
 * pre-bundle and fails the same way.
 *
 * The budget therefore has to outlast a cold pre-bundle, and the caller has
 * to be able to report progress instead of sitting in silence.
 */

export interface ReadinessOptions {
  /** Ports/URLs to probe, in order. */
  urls: string[];
  /** How long to wait in total. */
  timeoutMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** How often to report that we are still waiting. */
  hintEveryMs?: number;
  /** Called with the elapsed seconds whenever a hint is due. */
  onHint?: (elapsedSeconds: number) => void;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Wait until one of the URLs answers with a status below 500.
 *
 * @returns true when a server answered, false when the budget ran out.
 */
export async function waitForServer(options: ReadinessOptions): Promise<boolean> {
  const {
    urls,
    timeoutMs = 120_000,
    requestTimeoutMs = 1000,
    hintEveryMs = 10_000,
    onHint,
    fetchImpl = fetch,
  } = options;
  const start = Date.now();
  let nextHint = hintEveryMs;

  while (Date.now() - start < timeoutMs) {
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(requestTimeoutMs) });
        await res.body?.cancel();
        if (res.status < 500) return true;
      } catch {
        // still starting up
      }
    }
    if (onHint && Date.now() - start >= nextHint) {
      nextHint += hintEveryMs;
      onHint(Math.round((Date.now() - start) / 1000));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
