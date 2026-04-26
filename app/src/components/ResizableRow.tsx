import { Children, Fragment, useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";

interface ResizableRowProps {
  children: ReactNode;
  /** Initial weight per child cell. Length must match the rendered child count. */
  initialWeights?: number[];
  /** Minimum width per cell in CSS px. */
  minPx?: number;
  className?: string;
}

const SPLITTER_W = 12;

/**
 * Per-drag state held in a ref so pointermove updates don't trigger re-renders.
 * Captured at pointerdown; cleared on pointerup or pointercancel.
 */
interface DragState {
  idx: number;
  startX: number;
  startWeights: number[];
  total: number;
  usable: number;
  minWeight: number;
  pointerId: number;
}

/**
 * Generic horizontal grid with drag handles between children. Each handle
 * redistributes weight between its two neighbouring panels, respecting a
 * per-panel minimum width so nothing collapses past readable.
 */
export default function ResizableRow({
  children,
  initialWeights,
  minPx = 280,
  className = "",
}: ResizableRowProps) {
  const items = Children.toArray(children).filter(Boolean);
  const [weights, setWeights] = useState<number[]>(
    initialWeights && initialWeights.length === items.length
      ? initialWeights
      : items.map(() => 1),
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Per-drag state lives in a ref: every pointermove would otherwise re-render.
  // setPointerCapture on the divider routes all subsequent pointer events for
  // this pointerId back to the divider element regardless of where the pointer
  // physically is — so element-level handlers replace the old window-level
  // listeners and pointercancel cleans up if the OS preempts the gesture.
  const dragStateRef = useRef<DragState | null>(null);

  // Safety net: if the component unmounts mid-drag, the document-body styles
  // we set on pointerdown would leak and leave the page with a col-resize
  // cursor and no text selection. Reset them here.
  useEffect(() => {
    return () => {
      if (dragStateRef.current !== null) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        dragStateRef.current = null;
      }
    };
  }, []);

  // "w0fr 12px w1fr 12px w2fr ..." for grid-template-columns.
  const cols = weights
    .map((w) => `minmax(${minPx}px, ${w.toFixed(4)}fr)`)
    .join(` ${SPLITTER_W}px `);

  const onPointerDown = (idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // Multi-touch / multi-pointer guard: dragStateRef is shared across all
    // dividers in the row, so a second pointer-down (e.g., second finger
    // landing on an adjacent divider) would clobber the first pointer's
    // drag state — leaving its body styles set and its capture orphaned.
    // Bail until the first pointer releases.
    if (dragStateRef.current !== null) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWeights = weights.slice();
    const total = startWeights.reduce((a, b) => a + b, 0);
    const containerWidth = containerRef.current?.offsetWidth ?? 0;
    const usable = Math.max(1, containerWidth - SPLITTER_W * (items.length - 1));
    const minWeight = (minPx / usable) * total;

    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      idx,
      startX,
      startWeights,
      total,
      usable,
      minWeight,
      pointerId: e.pointerId,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    const dx = e.clientX - state.startX;
    const dWeight = (dx / state.usable) * state.total;
    const next = state.startWeights.slice();
    const nl = next[state.idx]! + dWeight;
    const nr = next[state.idx + 1]! - dWeight;
    if (nl < state.minWeight || nr < state.minWeight) return;
    next[state.idx] = nl;
    next[state.idx + 1] = nr;
    setWeights(next);
  };

  // Both pointerup and pointercancel commit the partial drag (the math has
  // already been running on every move — reverting would be jarring) and
  // release the pointer capture.
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = dragStateRef.current;
    if (!state || e.pointerId !== state.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragStateRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };

  const style: CSSProperties = {
    display: "grid",
    gridTemplateColumns: cols,
    gap: 0,
    minHeight: 0,
  };

  return (
    <div ref={containerRef} className={`resizable-row ${className}`} style={style}>
      {items.map((child, i) => (
        <Fragment key={i}>
          {child}
          {i < items.length - 1 && (
            <div
              className="col-resizer"
              onPointerDown={onPointerDown(i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize"
              tabIndex={-1}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}
