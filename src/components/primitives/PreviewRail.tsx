"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useId,
  useRef,
  useState,
} from "react";
import {
  EASE_OUT,
  SPRING_LAYOUT,
  useDismiss,
  useHoverGesture,
  useTapGesture,
} from "@/lib/motion-primitives";
import { cn } from "@/lib/utils";

export interface PreviewRailItem {
  id: string;
  label: string;
  ariaLabel?: string;
  description?: ReactNode;
  href?: string;
  target?: "_blank" | "_self" | "_parent" | "_top";
  rel?: string;
}

export interface PreviewRailProps {
  items: PreviewRailItem[];
  label?: string;
  orientation?: "vertical" | "horizontal";
  activeId?: string;
  defaultActiveId?: string;
  onActiveChange?: (id: string) => void;
  onItemSelect?: (item: PreviewRailItem) => void;
  renderPreview?: (item: PreviewRailItem) => ReactNode;
  showPreview?: boolean;
  previewSide?: "before" | "after";
  highlightActive?: boolean;
  itemSize?: number;
  children?: ReactNode;
  className?: string;
  railClassName?: string;
  previewContainerClassName?: string;
  previewClassName?: string;
}

function DefaultPreview({ item }: { item: PreviewRailItem }) {
  return (
    <div
      data-slot="preview-rail-card"
      className="rounded-xl border border-border/80 bg-card/95 backdrop-blur-md p-3 shadow-xl"
    >
      <p
        data-slot="preview-rail-title"
        className="text-xs font-semibold text-card-foreground leading-snug truncate"
      >
        {item.label}
      </p>
      {item.description ? (
        <div
          data-slot="preview-rail-description"
          className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground line-clamp-3"
        >
          {item.description}
        </div>
      ) : null}
    </div>
  );
}

export function PreviewRail({
  items,
  label = "Message navigation",
  orientation = "vertical",
  activeId,
  defaultActiveId,
  onActiveChange,
  onItemSelect,
  renderPreview,
  showPreview = true,
  previewSide = "before",
  highlightActive = false,
  itemSize = 16,
  children,
  className,
  railClassName,
  previewContainerClassName,
  previewClassName,
}: PreviewRailProps) {
  const uid = useId();
  const reduce = useReducedMotion() ?? false;
  const rootRef = useRef<HTMLDivElement>(null);
  const [internalActiveId, setInternalActiveId] = useState(
    defaultActiveId ?? items[0]?.id ?? "",
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const tap = useTapGesture<boolean>();
  const hover = useHoverGesture();

  const clearPinned = useCallback(() => setPinnedId(null), []);
  useDismiss(pinnedId !== null, clearPinned, rootRef);

  const requestedActiveId = activeId ?? internalActiveId;
  const selectedId = items.some((item) => item.id === requestedActiveId)
    ? requestedActiveId
    : (items[0]?.id ?? "");
  const displayedId = hoveredId ?? pinnedId ?? focusedId ?? "";
  const highlightedId = displayedId || (highlightActive ? selectedId : "");
  const displayedIndex = items.findIndex((item) => item.id === highlightedId);
  const rowTemplate = items.length
    ? `repeat(${items.length}, ${itemSize}px)`
    : undefined;
  const isHorizontal = orientation === "horizontal";

  const selectItem = (id: string) => {
    if (activeId === undefined) setInternalActiveId(id);
    onActiveChange?.(id);
  };

  return (
    <div
      ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedId(null);
          setPinnedId(null);
        }
      }}
      className={cn(
        "isolate relative flex w-full overflow-visible",
        isHorizontal
          ? "min-h-64 flex-col items-center justify-center"
          : "min-h-80",
        className,
      )}
    >
      {/* Scrollable Children view */}
      {children ? (
        <div className="min-h-0 min-w-0 flex-1">{children}</div>
      ) : null}

      {/* Floating Preview Card Container */}
      {showPreview && displayedId ? (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute z-50",
            previewSide === "before"
              ? "right-10 top-1/2 -translate-y-1/2"
              : "left-10 top-1/2 -translate-y-1/2",
            previewContainerClassName,
          )}
        >
          {items.map((item) => {
            if (item.id !== displayedId) return null;
            return (
              <motion.div
                key={item.id}
                layoutId={`preview-rail-card-${uid}`}
                transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                className={cn("w-64 max-w-sm", previewClassName)}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={item.id}
                    initial={
                      reduce
                        ? { opacity: 0 }
                        : { opacity: 0, y: 4, filter: "blur(6px)" }
                    }
                    animate={
                      reduce
                        ? { opacity: 1 }
                        : { opacity: 1, y: 0, filter: "blur(0px)" }
                    }
                    exit={
                      reduce
                        ? { opacity: 0 }
                        : {
                            opacity: 0,
                            y: -2,
                            filter: "blur(4px)",
                            transition: { duration: 0.12, ease: EASE_OUT },
                          }
                    }
                    transition={{
                      duration: reduce ? 0 : 0.18,
                      ease: EASE_OUT,
                    }}
                  >
                    {renderPreview ? (
                      renderPreview(item)
                    ) : (
                      <DefaultPreview item={item} />
                    )}
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      ) : null}

      {/* Rail with Pyramid Tick Animations */}
      <nav
        data-slot="preview-rail"
        role="navigation"
        aria-label={label}
        onPointerLeave={(event) => {
          if (hover.leave(event)) setHoveredId(null);
        }}
        style={
          isHorizontal
            ? { gridTemplateColumns: rowTemplate }
            : { gridTemplateRows: rowTemplate }
        }
        className={cn(
          "relative z-10 grid shrink-0",
          isHorizontal
            ? "h-12 w-fit max-w-full self-center justify-center"
            : "w-8 content-center",
          railClassName,
        )}
      >
        {items.map((item, index) => {
          const selected = item.id === selectedId;
          const highlighted = item.id === highlightedId;
          const distance =
            displayedIndex < 0 ? Number.POSITIVE_INFINITY : Math.abs(index - displayedIndex);
          // Codex pyramid formula: active = 1, adjacent = 0.68, next = 0.44, rest = 0.22
          const scale = highlighted
            ? 1
            : distance === 1
              ? 0.68
              : distance === 2
                ? 0.44
                : 0.22;

          const itemContent = (
            <motion.span
              data-slot="preview-rail-tick"
              aria-hidden="true"
              animate={isHorizontal ? { scaleY: scale } : { scaleX: scale }}
              transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
              className={cn(
                "block rounded-full bg-current transition-colors",
                isHorizontal
                  ? "h-6 w-0.5 origin-bottom"
                  : "h-0.5 w-4 origin-right",
                highlighted
                  ? "text-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]"
                  : selected
                    ? "text-foreground"
                    : "text-muted-foreground/35 hover:text-muted-foreground/80",
              )}
            />
          );

          const sharedClassName = cn(
            "relative flex items-center justify-end text-muted-foreground outline-none transition-opacity focus-visible:ring-1 focus-visible:ring-ring",
            isHorizontal ? "h-8 w-4" : "h-4 w-7",
          );
          const sharedStyle = isHorizontal
            ? { width: itemSize }
            : { height: itemSize };

          const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
            if (hover.enter(event)) setHoveredId(item.id);
          };
          const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
            tap.start(event, pinnedId === item.id);
            setFocusedId(null);
          };
          const dropGesture = () => tap.drop();
          const handleFocus = (currentTarget: HTMLElement) => {
            if (currentTarget.matches(":focus-visible")) {
              setFocusedId(item.id);
            }
          };
          const handleSelect = (event: MouseEvent<HTMLElement>) => {
            const gesture = tap.take();
            const tapped = gesture !== null && gesture.pointerType !== "mouse";

            if (tapped) {
              setPinnedId(item.id);
            }
            selectItem(item.id);
            onItemSelect?.(item);
          };

          return (
            <button
              key={item.id}
              data-slot="preview-rail-item"
              type="button"
              aria-label={item.ariaLabel ?? item.label}
              aria-current={selected ? "true" : "false"}
              onPointerEnter={handlePointerEnter}
              onPointerDown={handlePointerDown}
              onPointerCancel={dropGesture}
              onKeyDown={dropGesture}
              onFocus={(event) => handleFocus(event.currentTarget)}
              onClick={handleSelect}
              style={sharedStyle}
              className={sharedClassName}
            >
              {itemContent}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
