import { Children, Fragment, useRef, useState, type ReactNode, type CSSProperties } from "react";

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

  // "w0fr 12px w1fr 12px w2fr ..." for grid-template-columns.
  const cols = weights
    .map((w) => `minmax(${minPx}px, ${w.toFixed(4)}fr)`)
    .join(` ${SPLITTER_W}px `);

  const startDrag = (idx: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWeights = weights.slice();
    const total = startWeights.reduce((a, b) => a + b, 0);
    const containerWidth = containerRef.current?.offsetWidth ?? 0;
    const usable = Math.max(1, containerWidth - SPLITTER_W * (items.length - 1));
    const minWeight = (minPx / usable) * total;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dWeight = (dx / usable) * total;
      const next = startWeights.slice();
      const nl = next[idx]! + dWeight;
      const nr = next[idx + 1]! - dWeight;
      if (nl < minWeight || nr < minWeight) return;
      next[idx] = nl;
      next[idx + 1] = nr;
      setWeights(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
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
              onPointerDown={startDrag(i)}
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
