import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface Props {
  count: number;
  rowH: number;
  cols?: number;
  /** focused index; -1 = none */
  focus: number;
  render: (i: number, focused: boolean) => ComponentChildren;
  onRange?: (start: number, end: number) => void;
  class?: string;
  overscan?: number;
}

/** Fixed-height virtual list/grid: renders only visible rows, so 186k items cost the same as 20. */
export function VList({ count, rowH, cols = 1, focus, render, onRange, class: cls, overscan = 3 }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(800);
  const raf = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // keep focused row in view, with a one-row margin
  useEffect(() => {
    const el = ref.current;
    if (!el || focus < 0) return;
    const row = Math.floor(focus / cols);
    const y = row * rowH;
    if (y - rowH < el.scrollTop) el.scrollTop = Math.max(0, y - rowH);
    else if (y + 2 * rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + 2 * rowH - el.clientHeight;
  }, [focus, cols, rowH]);

  const rows = Math.ceil(count / cols);
  const r0 = Math.max(0, Math.floor(top / rowH) - overscan);
  const r1 = Math.min(rows, Math.ceil((top + h) / rowH) + overscan);

  useEffect(() => { onRange?.(r0 * cols, Math.min(count, r1 * cols)); }, [r0, r1, cols, count]);

  const out: ComponentChildren[] = [];
  const w = 100 / cols;
  for (let r = r0; r < r1; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i >= count) break;
      out.push(
        <div key={i} class="vrow" style={{ transform: `translateY(${r * rowH}px)`, height: rowH, left: `${c * w}%`, width: `${w}%` }}>
          {render(i, i === focus)}
        </div>,
      );
    }
  }
  return (
    <div ref={ref} class={`vlist ${cls ?? ''}`} onScroll={(e) => {
      const t = (e.currentTarget as HTMLDivElement).scrollTop;
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => setTop(t));
    }}>
      <div style={{ height: rows * rowH, position: 'relative' }}>{out}</div>
    </div>
  );
}
