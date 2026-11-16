/**
 * Price chart for the token detail view — custom SVG, no chart library.
 * The data itself (real on-chain Swap events) is fetched in ammora.ts
 * (scanCurveChart); this module only turns points into a chart.
 */
import type { ChartData, ChartPoint } from "./ammora";

export type ChartRange = "24h" | "7d" | "all";

/** Range selector options, in display order. */
export const CHART_RANGES: ReadonlyArray<{ range: ChartRange; label: string }> = [
  { range: "24h", label: "24H" },
  { range: "7d", label: "7D" },
  { range: "all", label: "All" },
];

/** How long a fetched chart stays cached before a re-scan. */
export const CHART_CACHE_TTL_MS = 120_000;

const MS_PER_HOUR = 3_600_000;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

/** Chart canvas size and padding (px, SVG viewBox units). */
export const CHART_WIDTH = 560;
export const CHART_HEIGHT = 220;
const CHART_PADDING = { left: 58, right: 10, top: 12, bottom: 26 } as const;
const CHART_GRID_LINES = 4;

/** Compact price label: 3 significant digits for tiny prices, trimmed otherwise. */
export function formatPriceShort(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return "0";
  if (price >= 1) return price.toFixed(4).replace(/\.?0+$/, "");
  return price.toPrecision(3);
}

/** Signed percent with two decimals, e.g. "+12.34%" or "-0.50%". */
export function formatPercentChange(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Time axis label: "HH:MM" for today, "D Mon HH:MM" otherwise. */
export function formatChartTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (d.toDateString() === new Date().toDateString()) return `${hh}:${mm}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${hh}:${mm}`;
}

/**
 * Points visible in the selected range. The last point before the cutoff is
 * clamped to the range boundary so the line starts at the left edge and the
 * % change is measured from the price at the range start. When nothing
 * traded in range, the line stays flat at the last known price.
 */
export function filterPointsByRange(data: ChartData, range: ChartRange): ChartPoint[] {
  if (range === "all") return data.points;
  const rangeHours = range === "24h" ? HOURS_PER_DAY : HOURS_PER_DAY * DAYS_PER_WEEK;
  const cutoff = Date.now() - rangeHours * MS_PER_HOUR;
  const visible = data.points.filter((p) => p.timeMs >= cutoff);
  const before = [...data.points].reverse().find((p) => p.timeMs < cutoff);
  if (visible.length === 0) {
    if (!before) return [];
    return [
      { ...before, timeMs: cutoff },
      { block: before.block, timeMs: Date.now(), price: before.price },
    ];
  }
  if (!before) return visible;
  return [{ ...before, timeMs: cutoff }, ...visible];
}

/** Line + area SVG for the given points; empty points give an empty canvas. */
export function buildChartSvg(
  points: ChartPoint[],
  width = CHART_WIDTH,
  height = CHART_HEIGHT,
): Element {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Price history chart");
  if (points.length === 0) return svg;
  const { left: padL, right: padR, top: padT, bottom: padB } = CHART_PADDING;
  const xs = points.map((p) => p.timeMs);
  const ys = points.map((p) => p.price);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (x1 === x0) x1 = x0 + 1;
  if (y1 === y0) {
    const d = Math.abs(y0) * 0.05 || 1;
    y0 -= d;
    y1 += d;
  }
  const yPad = (y1 - y0) * 0.08;
  y0 -= yPad;
  y1 += yPad;
  const X = (t: number): number => padL + ((t - x0) / (x1 - x0)) * (width - padL - padR);
  const Y = (v: number): number => padT + (1 - (v - y0) / (y1 - y0)) * (height - padT - padB);
  const mk = (tag: string): Element => document.createElementNS(NS, tag);
  for (let i = 0; i < CHART_GRID_LINES; i++) {
    const v = y0 + ((y1 - y0) * i) / (CHART_GRID_LINES - 1);
    const y = Y(v);
    const line = mk("line");
    line.setAttribute("x1", String(padL));
    line.setAttribute("x2", String(width - padR));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "chart-grid");
    svg.appendChild(line);
    const t = mk("text");
    t.setAttribute("x", String(padL - 6));
    t.setAttribute("y", String(y + 4));
    t.setAttribute("text-anchor", "end");
    t.setAttribute("class", "chart-label");
    t.textContent = formatPriceShort(v);
    svg.appendChild(t);
  }
  for (let i = 0; i < CHART_GRID_LINES; i++) {
    const t = x0 + ((x1 - x0) * i) / (CHART_GRID_LINES - 1);
    const label = mk("text");
    label.setAttribute("x", String(X(t)));
    label.setAttribute("y", String(height - 8));
    // Edge labels anchor inward so they never clip past the canvas.
    label.setAttribute("text-anchor", i === 0 ? "start" : i === CHART_GRID_LINES - 1 ? "end" : "middle");
    label.setAttribute("class", "chart-label");
    label.textContent = formatChartTime(t);
    svg.appendChild(label);
  }
  const linePts = points.map((p) => `${X(p.timeMs).toFixed(1)},${Y(p.price).toFixed(1)}`).join(" ");
  const area = mk("polygon");
  area.setAttribute(
    "points",
    `${X(points[0].timeMs).toFixed(1)},${height - padB} ${linePts} ${X(points[points.length - 1].timeMs).toFixed(1)},${height - padB}`,
  );
  area.setAttribute("class", "chart-area");
  svg.appendChild(area);
  const poly = mk("polyline");
  poly.setAttribute("points", linePts);
  poly.setAttribute("class", "chart-line");
  svg.appendChild(poly);
  const last = points[points.length - 1];
  const dot = mk("circle");
  dot.setAttribute("cx", String(X(last.timeMs)));
  dot.setAttribute("cy", String(Y(last.price)));
  dot.setAttribute("r", "4");
  dot.setAttribute("class", "chart-dot");
  svg.appendChild(dot);
  return svg;
}
