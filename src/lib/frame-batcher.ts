/** Coalesce high-frequency text into at most one UI commit per animation frame. */
export interface FrameScheduler {
  request: (cb: () => void) => number;
  cancel: (id: number) => void;
}

function defaultScheduler(): FrameScheduler {
  if (typeof requestAnimationFrame === "function") {
    return {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id),
    };
  }
  return {
    request: (cb) => setTimeout(cb, 16) as unknown as number,
    cancel: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  };
}

export class FrameBatcher {
  private buffer = "";
  private handle: number | null = null;
  private readonly scheduler: FrameScheduler;

  constructor(
    private readonly deliver: (text: string) => void,
    scheduler?: FrameScheduler
  ) {
    this.scheduler = scheduler ?? defaultScheduler();
  }

  push(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    if (this.handle !== null) return;
    this.handle = this.scheduler.request(() => {
      this.handle = null;
      this.flush();
    });
  }

  flush(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = "";
    this.deliver(text);
  }

  get pending(): number {
    return this.buffer.length;
  }

  dispose(): void {
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
    this.buffer = "";
  }
}
