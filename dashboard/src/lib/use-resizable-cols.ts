/**
 * Resizable-column hook. Each column starts at a CSS value (`'auto'`, `'1fr'`,
 * `'120px'`, …); on drag it flips to a px number so the user can shrink/expand
 * past the content's natural width. Builds a `gridTemplateColumns` string so
 * every row in the table reflows together via a single CSS variable.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ColSpec = number | string;

interface UseResizableColsOptions<K extends string> {
  /** Initial spec per column. */
  initial: Record<K, ColSpec>;
  /** Order in which columns appear left-to-right. */
  order: K[];
  /** Suffix appended after sized columns (e.g. "auto" for a non-resizable trailing button column). */
  tail?: string;
  /** Min px width per column once resized (default 50). */
  minWidth?: number;
}

function fmt(spec: ColSpec): string {
  return typeof spec === 'number' ? `${spec}px` : spec;
}

export function useResizableCols<K extends string>({
  initial, order, tail, minWidth = 50,
}: UseResizableColsOptions<K>) {
  const [widths, setWidths] = useState<Record<K, ColSpec>>(initial);
  const drag = useRef<{ key: K; startX: number; startW: number } | null>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const { key, startX, startW } = drag.current;
      const next = Math.max(minWidth, startW + (e.clientX - startX));
      setWidths(prev => prev[key] === next ? prev : { ...prev, [key]: next });
    };
    const onUp = () => {
      if (drag.current) {
        drag.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [minWidth]);

  /**
   * Mousedown on a resize handle. We measure the live rendered width from the
   * closest cell so the first drag tick lands on the correct number, even when
   * the column was previously sized as `auto` or `1fr`.
   */
  const startDrag = useCallback((key: K) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cellEl = (e.currentTarget as HTMLElement).closest<HTMLElement>('button, .scell, .stable-header > *')
      ?? (e.currentTarget as HTMLElement).parentElement;
    const startW = cellEl ? cellEl.getBoundingClientRect().width : 100;
    drag.current = { key, startX: e.clientX, startW };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const reset = useCallback(() => setWidths(initial), [initial]);

  const gridTemplate = order.map(k => fmt(widths[k])).join(' ') + (tail ? ' ' + tail : '');

  return { widths, gridTemplate, startDrag, reset };
}
