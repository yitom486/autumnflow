"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown } from "lucide-react";
import {
  PreviewRail,
  type PreviewRailItem,
} from "@/components/primitives/PreviewRail";
import {
  buildPreviewRailItems,
  PREVIEW_DESCRIPTION_MAX,
  PREVIEW_LABEL_MAX,
} from "@/components/primitives/preview-items";
import { cn } from "@/lib/utils";

export interface MessageScrollerHandle {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToTop: (behavior?: ScrollBehavior) => void;
  scrollToMessage: (id: string, behavior?: ScrollBehavior) => void;
  getViewport: () => HTMLElement | null;
}

export interface MessageScrollerProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** Navigation style to present alongside the viewport */
  navigation?: "none" | "rail" | "dots" | "both";
  /** Optional explicit message items for the rail. If omitted, scans [data-slot="message"] */
  items?: PreviewRailItem[];
  /** Active message ID (controlled) */
  activeId?: string;
  /** Initial active message ID */
  defaultActiveId?: string;
  /** Callback when the active message changes from scrolling */
  onActiveChange?: (id: string) => void;
  /** Callback when an item is selected on the rail */
  onItemSelect?: (item: PreviewRailItem) => void;
  /** Enable auto-stick to bottom on new messages or content growth */
  autoScroll?: boolean;
  /** Distance in px from bottom within which live output is followed */
  followThreshold?: number;
  /** Default scrolling behavior */
  scrollBehavior?: ScrollBehavior;
  /** Placement side of the rail preview popover card relative to the ticks */
  railPreviewSide?: "before" | "after";
  /** Custom renderer for the floating preview card */
  renderRailPreview?: (item: PreviewRailItem) => ReactNode;
  /** Show floating "Scroll to bottom" button when user scrolls up */
  showScrollToBottom?: boolean;
  /** Use an external viewport element (e.g. ThreadPrimitive.Viewport) */
  externalViewportRef?: React.RefObject<HTMLElement | null>;
  /** Class name for internal viewport */
  viewportClassName?: string;
  /** Class name for inner content container */
  contentClassName?: string;
  /** Class name for preview rail container */
  railClassName?: string;
  /** Filter which messages to track on the navigation rail. Defaults to 'user' */
  targetRole?: "user" | "all";
}

function extractTextSnippet(el: Element, maxLen = PREVIEW_DESCRIPTION_MAX): string {
  const bubble = el.querySelector('[data-slot="message-bubble-content"]') ||
    el.querySelector('[data-slot="message-content"]') || el.querySelector("p") || el;
  // Prefer message content over rendered tool labels, usage counters and timestamps.
  const bodyParts = el.getAttribute("data-from") === "assistant" ? el.querySelectorAll(".acp-preview-body") : [];
  let raw = bodyParts.length ? Array.from(bodyParts, part => part.textContent || "").join(" ") :
    el.getAttribute("data-preview-text") ?? bubble.textContent ?? "";
  raw = raw.replace(/^(?:\s*<acp-compat-context\b[^>]*>[\s\S]*?<\/acp-compat-context>\s*)+/i, "");
  raw = raw.replace(/^\s*You are a subagent spawned by another session\.\s*/, "");
  raw = raw.replace(/\s+/g, " ").trim();
  return raw.length > maxLen ? raw.slice(0, maxLen) + "…" : raw;
}

export const MessageScroller = forwardRef<MessageScrollerHandle, MessageScrollerProps>(
  function MessageScroller(
    {
      children,
      navigation = "rail",
      items: controlledItems,
      activeId: propActiveId,
      defaultActiveId,
      onActiveChange,
      onItemSelect,
      autoScroll = true,
      followThreshold = 80,
      scrollBehavior = "smooth",
      railPreviewSide = "before",
      renderRailPreview,
      showScrollToBottom = true,
      externalViewportRef,
      viewportClassName,
      contentClassName,
      railClassName,
      targetRole = "user",
      className,
      ...restProps
    },
    ref,
  ) {
    const internalViewportRef = useRef<HTMLDivElement | null>(null);
    const contentRef = useRef<HTMLDivElement | null>(null);

    const getViewport = useCallback((): HTMLElement | null => {
      return externalViewportRef?.current ?? internalViewportRef.current;
    }, [externalViewportRef]);

    const [scannedItems, setScannedItems] = useState<PreviewRailItem[]>([]);
    const [internalActiveId, setInternalActiveId] = useState<string>(
      defaultActiveId ?? "",
    );
    const [isAtBottom, setIsAtBottom] = useState(true);

    const activeId = propActiveId !== undefined ? propActiveId : internalActiveId;
    const railItems = controlledItems ?? scannedItems;

    // Scroll helpers
    const scrollToBottom = useCallback(
      (behavior: ScrollBehavior = scrollBehavior) => {
        const vp = getViewport();
        if (!vp) return;
        vp.scrollTo({
          top: vp.scrollHeight,
          behavior,
        });
      },
      [getViewport, scrollBehavior],
    );

    const scrollToTop = useCallback(
      (behavior: ScrollBehavior = scrollBehavior) => {
        const vp = getViewport();
        if (!vp) return;
        vp.scrollTo({
          top: 0,
          behavior,
        });
      },
      [getViewport, scrollBehavior],
    );

    const scrollToMessage = useCallback(
      (id: string, behavior: ScrollBehavior = scrollBehavior) => {
        const vp = getViewport();
        if (!vp) return;
        const target = vp.querySelector(
          `[data-slot="message"][data-message-id="${id}"], [data-slot="message"]#${CSS.escape(id)}`,
        ) as HTMLElement | null;

        if (target) {
          target.scrollIntoView({ behavior, block: "start" });
        }
      },
      [getViewport, scrollBehavior],
    );

    useImperativeHandle(
      ref,
      () => ({
        scrollToBottom,
        scrollToTop,
        scrollToMessage,
        getViewport,
      }),
      [scrollToBottom, scrollToTop, scrollToMessage, getViewport],
    );

    // Auto-scan DOM messages if controlled items are not passed
    useEffect(() => {
      if (controlledItems) return;

      const vp = getViewport();
      if (!vp) return;

      const scan = () => {
        const allMessages = Array.from(vp.querySelectorAll<HTMLElement>('[data-slot="message"]'));
        // Read every body exactly once; the pure builder reuses those texts
        // for the labels and the answers.
        const messages = allMessages.map((el, index) => ({
          id: el.dataset.messageId || el.id || `msg-${index}`,
          from: el.dataset.from || "unknown",
          text: extractTextSnippet(el, PREVIEW_DESCRIPTION_MAX),
        }));
        const found = buildPreviewRailItems(messages, targetRole).map((item) => {
          // Labels stay short: the rail renders one truncated line, and a full
          // transcript makes a screen-reader label unreadable.
          if (item.label.length <= PREVIEW_LABEL_MAX) return item;
          const label = `${item.label.slice(0, PREVIEW_LABEL_MAX)}…`;
          return { ...item, label, ariaLabel: label };
        });

        setScannedItems((prev) => {
          if (
            prev.length === found.length &&
            prev.every(
              (p, idx) =>
                p.id === found[idx]?.id &&
                p.label === found[idx]?.label &&
                p.description === found[idx]?.description,
            )
          ) {
            return prev;
          }
          return found;
        });
      };

      scan();

      // Structural changes (a message appears, or its explicit preview text
      // is rewritten) must show up quickly; raw streamed characters only
      // change the text nodes, and rescanning the whole conversation for
      // every chunk is what made long chats stutter.
      const STRUCTURAL_DELAY = 150;
      const TEXT_DELAY = 600;
      let timer: number | null = null;
      let dueAt = 0;
      const scheduleScan = (delay: number) => {
        const now = Date.now();
        if (timer !== null) {
          if (now >= dueAt) return;
          window.clearTimeout(timer);
          timer = null;
        }
        const wait = Math.max(0, Math.min(delay, dueAt - now));
        dueAt = now + wait;
        timer = window.setTimeout(() => {
          timer = null;
          dueAt = 0;
          scan();
        }, wait);
      };

      const observer = new MutationObserver((records) => {
        const structural = records.some((record) => record.type === "childList" || record.type === "attributes");
        scheduleScan(structural ? STRUCTURAL_DELAY : TEXT_DELAY);
      });

      observer.observe(vp, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-preview-text"] });
      return () => {
        observer.disconnect();
        if (timer !== null) window.clearTimeout(timer);
      };
    }, [controlledItems, getViewport, targetRole]);

    // Active message tracking and stick-to-bottom detection on scroll
    useEffect(() => {
      const vp = getViewport();
      if (!vp) return;

      let rafId: number | null = null;

      const handleScroll = () => {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;

          // Check if at bottom
          const distance = Math.max(
            0,
            vp.scrollHeight - vp.scrollTop - vp.clientHeight,
          );
          const atBottom = distance <= followThreshold;
          setIsAtBottom(atBottom);

          // Find message closest to top of viewport
          const selector =
            targetRole === "user"
              ? '[data-slot="message"][data-from="user"]'
              : '[data-slot="message"]';

          const messageEls = Array.from(
            vp.querySelectorAll<HTMLElement>(selector),
          );
          if (messageEls.length === 0) return;

          const vpRect = vp.getBoundingClientRect();
          let closestId = "";
          let minDiff = Infinity;

          for (const el of messageEls) {
            const elRect = el.getBoundingClientRect();
            // Message top relative to viewport top
            const diff = Math.abs(elRect.top - vpRect.top);
            if (diff < minDiff) {
              minDiff = diff;
              closestId = el.dataset.messageId || el.id || "";
            }
          }

          if (closestId && closestId !== activeId) {
            setInternalActiveId(closestId);
            onActiveChange?.(closestId);
          }
        });
      };

      vp.addEventListener("scroll", handleScroll, { passive: true });
      return () => {
        vp.removeEventListener("scroll", handleScroll);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }, [getViewport, followThreshold, activeId, onActiveChange, targetRole]);

    // Stick-to-bottom on resize if autoScroll is enabled
    useEffect(() => {
      if (!autoScroll) return;
      const vp = getViewport();
      if (!vp) return;

      const ro = new ResizeObserver(() => {
        if (isAtBottom) {
          vp.scrollTop = vp.scrollHeight;
        }
      });

      ro.observe(vp);
      const content = contentRef.current;
      if (content) ro.observe(content);

      return () => ro.disconnect();
    }, [autoScroll, isAtBottom, getViewport]);

    const handleItemSelect = useCallback(
      (item: PreviewRailItem) => {
        scrollToMessage(item.id, scrollBehavior);
        setInternalActiveId(item.id);
        onItemSelect?.(item);
        onActiveChange?.(item.id);
      },
      [scrollToMessage, scrollBehavior, onItemSelect, onActiveChange],
    );

    const showRail =
      (navigation === "rail" || navigation === "both") && railItems.length >= 1;

    const renderInternalViewport = !externalViewportRef;

    return (
      <div
        data-slot="message-scroller"
        className={cn("relative flex-1 flex flex-col min-h-0", className)}
        {...restProps}
      >
        {renderInternalViewport ? (
          <div
            ref={internalViewportRef}
            data-slot="message-scroller-viewport"
            className={cn(
              "flex-1 overflow-y-auto [scrollbar-gutter:stable] p-4 md:p-6",
              viewportClassName,
            )}
          >
            <div
              ref={contentRef}
              data-slot="message-scroller-content"
              className={cn("space-y-6", contentClassName)}
            >
              {children}
            </div>
          </div>
        ) : (
          children
        )}

        {/* Preview Rail Tick Navigation */}
        {showRail && (
          <aside
            data-slot="message-scroller-rail"
            className={cn(
              "pointer-events-auto absolute right-1.5 top-1/2 -translate-y-1/2 z-30 select-none",
              railClassName,
            )}
          >
            <PreviewRail
              items={railItems}
              activeId={activeId}
              onActiveChange={setInternalActiveId}
              onItemSelect={handleItemSelect}
              previewSide={railPreviewSide}
              renderPreview={renderRailPreview}
            />
          </aside>
        )}

        {/* Reader-Aware Floating Scroll to Bottom Button */}
        {showScrollToBottom && (
          <AnimatePresence>
            {!isAtBottom && (
              <motion.div
                initial={{ opacity: 0, scale: 0.85, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.85, y: 10 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto"
              >
                <button
                  type="button"
                  onClick={() => scrollToBottom("smooth")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border/80 bg-card/95 backdrop-blur-md text-xs font-medium text-foreground shadow-lg hover:bg-accent hover:border-primary/40 transition-colors"
                  title="回到底部"
                >
                  <ArrowDown className="w-3.5 h-3.5 text-primary animate-bounce" />
                  <span>回到底部</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
    );
  },
);

MessageScroller.displayName = "MessageScroller";
