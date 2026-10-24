import { useCallback, useEffect, useRef } from "react";

/** 距底部小于该值视为“在底部”（与“回到底部”按钮隐藏的状态一致）。 */
export const STICK_THRESHOLD_PX = 80;

export function distanceFromBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

/**
 * 流式输出跟随：用户在底部时，内容变高（ResizeObserver）就贴住底部；
 * 用户往上滚了就绝不强制滚动，直到他自己回到底部（或点“回到底部”）。
 * - 向上滚轮 / 触摸 / 方向键立即解除跟随，避免与用户“抢”滚动；
 * - 跟随在 ResizeObserver 回调里同步写 scrollTop：RO 在布局之后、绘制之前触发，
 *   这一帧就能把底部贴住。若改成再排一个 rAF，内容已经长高但滚动还没跟上，
 *   必然出现一帧“底部被顶上去再弹回来”的抖动。
 * - 不用 smooth 行为：连续的平滑动画互相打断才是抖动的来源，平滑感来自内容本身逐步增长。
 */
export function useStickToBottom<T extends HTMLElement = HTMLDivElement>() {
  const viewportRef = useRef<T | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const lastTop = useRef(0);
  /** 要放回的位置：内容还没长到那么高时先记着，长高了再放（用户一动就作废）。 */
  const pendingTop = useRef<number | null>(null);

  const follow = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !pinned.current) return;
    // 写 scrollHeight 会被浏览器夹到最大可滚动值，回读得到真实位置。
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, []);

  const applyPending = useCallback(() => {
    const el = viewportRef.current;
    const top = pendingTop.current;
    if (!el || top === null) return;
    el.scrollTop = top;
    lastTop.current = el.scrollTop;
    if (Math.abs(el.scrollTop - top) < 1) pendingTop.current = null;
  }, []);

  /** 放回某个位置；null = 贴底。 */
  const restoreTo = useCallback(
    (top: number | null) => {
      pinned.current = top === null;
      pendingTop.current = top;
      if (top === null) follow();
      else applyPending();
    },
    [follow, applyPending]
  );

  /** 现在的位置（还没放到位的，按要放的位置算）。 */
  const position = useCallback(
    () => ({ top: pendingTop.current ?? lastTop.current, pinned: pinned.current }),
    []
  );

  useEffect(() => {
    const el = viewportRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    const onScroll = () => {
      const movedUp = el.scrollTop < lastTop.current - 1;
      lastTop.current = el.scrollTop;
      const near = distanceFromBottom(el) <= STICK_THRESHOLD_PX;
      // 滚轮 / 键盘向上已在各自监听里立即放手；这里兜住拖滚动条：向上且离开阈值才放手。
      // 内容变矮时浏览器会把 scrollTop 往回夹，那种“向上”仍贴着底，不算用户意图。
      if (movedUp && !near) pinned.current = false;
      else if (near && !movedUp) pinned.current = true;
    };
    const release = () => {
      pinned.current = false;
      pendingTop.current = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) release();
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(e.key)) release();
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchmove", release, { passive: true });
    el.addEventListener("keydown", onKey);
    // Dedupe on whole-pixel sizes: sub-pixel / no-op notifications (composer
    // growing, scrollbars, DPI rounding) must not trigger a scroll each time.
    const lastSize = new WeakMap<Element, string>();
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const e of entries) {
        const k = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
        if (lastSize.get(e.target) !== k) {
          lastSize.set(e.target, k);
          changed = true;
        }
      }
      if (changed) {
        applyPending();
        follow();
      }
    });
    ro.observe(content);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchmove", release);
      el.removeEventListener("keydown", onKey);
      ro.disconnect();
    };
  }, [follow, applyPending]);

  return { viewportRef, contentRef, pinned, restoreTo, position };
}
