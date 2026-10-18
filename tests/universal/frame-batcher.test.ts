import { describe, expect, it, vi } from "vitest";
import { FrameBatcher } from "../../src/lib/frame-batcher";

describe("FrameBatcher", () => {
  it("coalesces pushes into one delivery per scheduled frame", () => {
    let frame: (() => void) | null = null;
    const cancelled: number[] = [];
    const delivery = vi.fn();
    const batcher = new FrameBatcher(delivery, {
      request: (cb) => {
        frame = cb;
        return 7;
      },
      cancel: (id) => cancelled.push(id),
    });

    batcher.push("a");
    batcher.push("b");
    expect(delivery).not.toHaveBeenCalled();
    frame!();
    expect(delivery).toHaveBeenCalledWith("ab");
    expect(batcher.pending).toBe(0);
  });

  it("flushes synchronously and cancels the pending frame", () => {
    const cancelled: number[] = [];
    const delivery = vi.fn();
    const batcher = new FrameBatcher(delivery, {
      request: () => 3,
      cancel: (id) => cancelled.push(id),
    });
    batcher.push("hello");
    batcher.flush();
    expect(cancelled).toEqual([3]);
    expect(delivery).toHaveBeenCalledWith("hello");
    batcher.flush();
    expect(delivery).toHaveBeenCalledTimes(1);
  });

  it("dispose drops buffered text without delivering", () => {
    const delivery = vi.fn();
    const batcher = new FrameBatcher(delivery, { request: () => 1, cancel: () => {} });
    batcher.push("lost");
    batcher.dispose();
    expect(delivery).not.toHaveBeenCalled();
    expect(batcher.pending).toBe(0);
  });
});
