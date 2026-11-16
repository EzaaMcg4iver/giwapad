/**
 * Price chart for the token detail view — custom SVG, no chart library.
 * The data itself (real on-chain Swap events) is fetched in ammora.ts
 * (scanCurveChart); this module only turns points into a chart.
 */
import type { ChartData, ChartPoint, TradeEvent } from "./ammora";
import { formatDisplayNumber } from "./format";

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

/** Compact price label — the shared display formatter (never e-notation). */
export function formatPriceShort(price: number): string {
  return formatDisplayNumber(price);
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
  // TradingView convention: the line takes the period's direction — green
  // when the last price is at or above the first, red when below.
  svg.classList.add(points[points.length - 1].price >= points[0].price ? "chart-trend-up" : "chart-trend-down");
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

// ---------------------------------------------------------------------------
// Candlestick chart (detail view main chart)
// ---------------------------------------------------------------------------

/** One OHLC candle. volumeWeth is the summed WETH volume in the bucket. */
export interface Candle {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeWeth: number;
  trades: number;
}

export type CandleTimeframe = "auto" | "1m" | "5m" | "15m" | "1h" | "4h" | "24h";

const MS_PER_MINUTE = 60_000;

/** Timeframe selector options, in display order. Auto picks a bucket so the chart holds at most ~48 candles. */
export const CANDLE_TIMEFRAMES: ReadonlyArray<{ timeframe: CandleTimeframe; label: string; ms: number }> = [
  { timeframe: "auto", label: "Auto", ms: 0 },
  { timeframe: "1m", label: "1m", ms: MS_PER_MINUTE },
  { timeframe: "5m", label: "5m", ms: 5 * MS_PER_MINUTE },
  { timeframe: "15m", label: "15m", ms: 15 * MS_PER_MINUTE },
  { timeframe: "1h", label: "1h", ms: 60 * MS_PER_MINUTE },
  { timeframe: "4h", label: "4h", ms: 4 * 60 * MS_PER_MINUTE },
  { timeframe: "24h", label: "24h", ms: 24 * 60 * MS_PER_MINUTE },
];

/** Largest number of candles the Auto timeframe aims for. */
const CANDLE_AUTO_TARGET = 48;

const CANDLE_AUTO_STEPS_MS = [
  MS_PER_MINUTE,
  5 * MS_PER_MINUTE,
  15 * MS_PER_MINUTE,
  60 * MS_PER_MINUTE,
  4 * 60 * MS_PER_MINUTE,
  24 * 60 * MS_PER_MINUTE,
] as const;

function resolveBucketMs(trades: TradeEvent[], timeframe: CandleTimeframe): number {
  if (timeframe !== "auto") {
    return CANDLE_TIMEFRAMES.find((t) => t.timeframe === timeframe)?.ms ?? MS_PER_MINUTE;
  }
  if (trades.length === 0) return MS_PER_MINUTE;
  const span = trades[trades.length - 1].timeMs - trades[0].timeMs;
  for (const step of CANDLE_AUTO_STEPS_MS) {
    if (span / step <= CANDLE_AUTO_TARGET) return step;
  }
  return CANDLE_AUTO_STEPS_MS[CANDLE_AUTO_STEPS_MS.length - 1];
}

/**
 * OHLC candles from decoded Swap events. The first trade of a bucket opens
 * it, the last closes it. Volume is WETH (buys pay WETH, sells receive WETH).
 * A bucket with no trades is skipped — empty buckets are never invented.
 */
export function buildCandles(trades: TradeEvent[], timeframe: CandleTimeframe): Candle[] {
  if (trades.length === 0) return [];
  const bucketMs = resolveBucketMs(trades, timeframe);
  const byBucket = new Map<number, TradeEvent[]>();
  for (const t of trades) {
    const bucket = Math.floor(t.timeMs / bucketMs);
    const list = byBucket.get(bucket);
    if (list) list.push(t);
    else byBucket.set(bucket, [t]);
  }
  const candles: Candle[] = [];
  for (const [bucket, list] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    const prices = list.map((t) => t.price);
    let volumeRaw = 0n;
    for (const t of list) volumeRaw += t.baseForQuote ? t.amountOut : t.amountIn;
    candles.push({
      timeMs: bucket * bucketMs,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      volumeWeth: Number(volumeRaw) / 1e18,
      trades: list.length,
    });
  }
  return candles;
}

/** Candlestick SVG: green body when close >= open, red otherwise, with wicks. Log scale optional. */
export function buildCandleSvg(
  candles: Candle[],
  opts: { log?: boolean; width?: number; height?: number } = {},
): Element {
  const width = opts.width ?? CHART_WIDTH;
  const height = opts.height ?? CHART_HEIGHT;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "chart-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Candlestick price chart");
  if (candles.length === 0) return svg;
  const { left: padL, right: padR, top: padT, bottom: padB } = CHART_PADDING;
  const mk = (tag: string): Element => document.createElementNS(NS, tag);
  const xs = candles.map((c) => c.timeMs);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x1 === x0) x1 = x0 + 1;
  const allPrices = candles.flatMap((c) => [c.high, c.low]);
  let yMin = Math.min(...allPrices);
  let yMax = Math.max(...allPrices);
  if (yMax === yMin) {
    const d = Math.abs(yMax) * 0.05 || 1;
    yMin -= d;
    yMax += d;
  }
  const log = opts.log === true && yMin > 0;
  const toY = (v: number): number => (log ? Math.log10(v) : v);
  let ly0 = toY(yMin);
  let ly1 = toY(yMax);
  const yPad = (ly1 - ly0) * 0.08;
  ly0 -= yPad;
  ly1 += yPad;
  const X = (t: number): number => padL + ((t - x0) / (x1 - x0)) * (width - padL - padR);
  const Y = (v: number): number => padT + (1 - (toY(v) - ly0) / (ly1 - ly0)) * (height - padT - padB);
  const fromY = (y: number): number => {
    const ly = ly0 + (1 - (y - padT) / (height - padT - padB)) * (ly1 - ly0);
    return log ? 10 ** ly : ly;
  };
  for (let i = 0; i < CHART_GRID_LINES; i++) {
    const v = ly0 + ((ly1 - ly0) * i) / (CHART_GRID_LINES - 1);
    const y = padT + (1 - (v - ly0) / (ly1 - ly0)) * (height - padT - padB);
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
    t.textContent = formatPriceShort(fromY(y));
    svg.appendChild(t);
  }
  for (let i = 0; i < CHART_GRID_LINES; i++) {
    const t = x0 + ((x1 - x0) * i) / (CHART_GRID_LINES - 1);
    const label = mk("text");
    label.setAttribute("x", String(X(t)));
    label.setAttribute("y", String(height - 8));
    label.setAttribute("text-anchor", i === 0 ? "start" : i === CHART_GRID_LINES - 1 ? "end" : "middle");
    label.setAttribute("class", "chart-label");
    label.textContent = formatChartTime(t);
    svg.appendChild(label);
  }
  const slot = (width - padL - padR) / candles.length;
  const bodyW = Math.max(2, Math.min(14, slot * 0.6));
  for (const c of candles) {
    const x = X(c.timeMs);
    const up = c.close >= c.open;
    const cls = up ? "candle-up" : "candle-down";
    const wick = mk("line");
    wick.setAttribute("x1", String(x));
    wick.setAttribute("x2", String(x));
    wick.setAttribute("y1", String(Y(c.high)));
    wick.setAttribute("y2", String(Y(c.low)));
    wick.setAttribute("class", `candle-wick ${cls}`);
    svg.appendChild(wick);
    const body = mk("rect");
    body.setAttribute("x", String(x - bodyW / 2));
    body.setAttribute("y", String(Math.min(Y(c.open), Y(c.close))));
    body.setAttribute("width", String(bodyW));
    body.setAttribute("height", String(Math.max(1, Math.abs(Y(c.open) - Y(c.close)))));
    body.setAttribute("class", `candle-body ${cls}`);
    svg.appendChild(body);
  }
  const last = candles[candles.length - 1];
  // Last-price line follows the last candle's direction (TradingView style).
  const lastCls = last.close >= last.open ? "candle-up" : "candle-down";
  const lastLine = mk("line");
  lastLine.setAttribute("x1", String(padL));
  lastLine.setAttribute("x2", String(width - padR));
  lastLine.setAttribute("y1", String(Y(last.close)));
  lastLine.setAttribute("y2", String(Y(last.close)));
  lastLine.setAttribute("class", `chart-lastline ${lastCls}`);
  svg.appendChild(lastLine);
  const lastLabel = mk("text");
  lastLabel.setAttribute("x", String(width - padR - 4));
  lastLabel.setAttribute("y", String(Y(last.close) - 5));
  lastLabel.setAttribute("text-anchor", "end");
  lastLabel.setAttribute("class", `chart-lastlabel ${lastCls}`);
  lastLabel.textContent = formatPriceShort(last.close);
  svg.appendChild(lastLabel);
  return svg;
}
