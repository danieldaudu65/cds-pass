import { useMemo, useState } from 'react';

/**
 * Small single-series charts for Admin mode (no chart library: keeps the app light).
 * One series each, so no legend: the title names it. Marks use our green (brighter in dark mode),
 * grid and axes stay quiet, and hovering / tapping shows the exact value for that day.
 */

const W = 320;
const H = 140;
const PAD = { l: 34, r: 8, t: 10, b: 22 };

const shortDay = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export function TrendChart({
  title,
  days,
  values,
  kind = 'line',
  format = (n) => n.toLocaleString('en-NG'),
  total,
  label = shortDay,
  note,
}: {
  title: string;
  days: string[];
  values: number[];
  kind?: 'line' | 'bar';
  format?: (n: number) => string;
  total?: string;
  /** How to show an x position (default: "21 Nov"). */
  label?: (key: string) => string;
  note?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => niceMax(Math.max(0, ...values)), [values]);
  const n = values.length;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const step = iw / Math.max(1, n);
  const barW = Math.max(2, Math.min(14, step - 2)); // 2px surface gap between bars

  const path = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${path} L${x(n - 1)},${PAD.t + ih} L${x(0)},${PAD.t + ih} Z`;
  const barX = (i: number) => PAD.l + i * step + (step - barW) / 2;

  function pick(clientX: number, el: SVGSVGElement) {
    const r = el.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    const i = kind === 'bar' ? Math.floor((sx - PAD.l) / step) : Math.round(((sx - PAD.l) / iw) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  }

  const hx = hover === null ? 0 : kind === 'bar' ? barX(hover) + barW / 2 : x(hover);

  return (
    <figure className="card !p-4">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold">{title}</span>
        {total && <span className="font-display text-lg font-extrabold text-green">{total}</span>}
      </figcaption>
      <div className="relative mt-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full touch-none select-none"
          role="img"
          aria-label={`${title}, last ${n} days`}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget)}
          onPointerLeave={() => setHover(null)}
        >
          {/* quiet grid: 0, half, max */}
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} stroke="rgb(var(--line))" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(max * f) + 3} textAnchor="end" fontSize={9} fill="rgb(var(--muted))">
                {format(max * f)}
              </text>
            </g>
          ))}
          {/* x labels: first, middle, last */}
          {[0, Math.floor((n - 1) / 2), n - 1].map((i) => (
            <text key={i} x={kind === 'bar' ? barX(i) + barW / 2 : x(i)} y={H - 6} textAnchor="middle" fontSize={9} fill="rgb(var(--muted))">
              {label(days[i])}
            </text>
          ))}

          {kind === 'line' ? (
            <>
              <path d={area} fill="rgb(var(--green-text) / 0.12)" />
              <path d={path} fill="none" stroke="rgb(var(--green-text))" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </>
          ) : (
            values.map((v, i) => {
              const h = Math.max(0, PAD.t + ih - y(v));
              return (
                <rect
                  key={i}
                  x={barX(i)}
                  y={PAD.t + ih - h}
                  width={barW}
                  height={h}
                  rx={Math.min(3, barW / 2)}
                  fill="rgb(var(--green-text))"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              );
            })
          )}

          {hover !== null && (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={PAD.t} y2={PAD.t + ih} stroke="rgb(var(--muted))" strokeDasharray="3 3" strokeWidth={1} />
              {kind === 'line' && <circle cx={hx} cy={y(values[hover])} r={4.5} fill="rgb(var(--green-text))" stroke="rgb(var(--card))" strokeWidth={2} />}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-xl bg-ink px-2.5 py-1.5 text-xs font-semibold text-paper shadow-lift"
            style={{ left: `${Math.min(88, Math.max(12, (hx / W) * 100))}%` }}
          >
            {label(days[hover])}: <b>{format(values[hover])}</b>
          </div>
        )}
      </div>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </figure>
  );
}

/** Horizontal bars with labels: for small lists like batches or dues progress. */
export function BarList({ title, rows, format = (n) => String(n) }: { title: string; rows: { label: string; value: number; max?: number; hint?: string }[]; format?: (n: number) => string }) {
  const top = Math.max(1, ...rows.map((r) => r.max ?? r.value));
  return (
    <div className="card space-y-3 !p-4">
      <p className="text-sm font-bold">{title}</p>
      {rows.length === 0 && <p className="text-sm text-muted">Nothing yet.</p>}
      {rows.map((r) => {
        const of = r.max ?? top;
        return (
          <div key={r.label}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate font-semibold">{r.label}</span>
              <span className="shrink-0 font-bold">{format(r.value)}{r.max !== undefined ? ` / ${format(r.max)}` : ''}</span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (r.value / Math.max(1, of)) * 100)}%`, background: 'rgb(var(--green-text))' }} />
            </div>
            {r.hint && <p className="mt-0.5 text-xs text-muted">{r.hint}</p>}
          </div>
        );
      })}
    </div>
  );
}
