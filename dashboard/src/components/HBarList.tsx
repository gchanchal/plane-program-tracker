/**
 * Horizontal bar list — fixed-row breakdown chart with per-row colors.
 *
 * Two modes:
 *   - Single-color: pass `value` + `color` per row.
 *   - Stacked:      pass `segments: [{ value, color, key? }]` per row. The bar
 *                   length still scales by row.value (= sum of segments) against
 *                   the chart's max, but the bar is split into colored segments
 *                   proportional to each segment's value.
 *
 * Used wherever bklit's BarChart can't apply per-bar fill (priority, type,
 * per-person, per-type) or where we want comfortable row-per-item layout.
 */
export interface HBarSegment {
  value: number;
  color: string;
  key?: string;
}

export interface HBarRow {
  label: string;
  value: number;
  color?: string;
  segments?: HBarSegment[];
  sub?: string;
}

interface HBarListProps {
  rows: HBarRow[];
  /** Optional max for scaling (defaults to max(value)). */
  max?: number;
  /** Render value with a custom formatter. */
  fmtValue?: (n: number) => string;
  /** Optional unit suffix (e.g. "d") shown after the value. */
  valueSuffix?: string;
  /** Extra class for the wrapper. */
  className?: string;
  /** Maximum rows to show (default unlimited). */
  limit?: number;
  /** Empty-state message. */
  empty?: string;
  /** Width (px) of the label column. Default 110. */
  labelWidth?: number;
}

export function HBarList({
  rows, max, fmtValue, valueSuffix, className, limit, empty, labelWidth = 140,
}: HBarListProps) {
  const visible = limit ? rows.slice(0, limit) : rows;
  if (visible.length === 0) {
    return <div className="chart-empty">{empty || 'No data.'}</div>;
  }
  const computedMax = max ?? Math.max(1, ...visible.map(r => r.value));
  const fmt = fmtValue || ((n: number) => String(n));

  return (
    <div className={'flex flex-col gap-2.5 py-1 ' + (className || '')}>
      {visible.map((r, i) => {
        const pct = (100 * r.value) / computedMax;
        return (
          <div key={i} className="grid items-center gap-3" style={{ gridTemplateColumns: `${labelWidth}px 1fr 60px` }}>
            <div className="text-xs text-foreground truncate" title={r.label}>{r.label}</div>
            <div className="relative h-6 rounded bg-muted/60 overflow-hidden">
              <div
                className="h-full rounded transition-[width] duration-500 flex"
                style={{ width: `${pct}%` }}
              >
                {r.segments
                  ? r.segments.map((s, si) => {
                      const segPct = r.value > 0 ? (100 * s.value / r.value) : 0;
                      if (s.value === 0) return null;
                      return (
                        <div
                          key={s.key ?? si}
                          style={{ width: `${segPct}%`, background: s.color, opacity: 0.9 }}
                          title={s.key ? `${s.key}: ${s.value}` : String(s.value)}
                        />
                      );
                    })
                  : (
                    <div
                      className="w-full h-full rounded"
                      style={{ background: r.color || 'var(--chart-1)', opacity: 0.85 }}
                    />
                  )}
              </div>
            </div>
            <div className="text-xs font-medium text-foreground text-right tabular-nums">
              {fmt(r.value)}{valueSuffix || ''}
              {r.sub && <span className="text-muted-foreground ml-1 font-normal">{r.sub}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
