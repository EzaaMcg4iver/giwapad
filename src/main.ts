/**
 * GiwaPad — token launchpad on GIWA Sepolia (chain 91342), built with the
 * Ammora SDK 0.3.9. Static frontend, no backend.
 *
 * Every number on screen comes from a real chain read. Writes are sent only
 * through the user's own connected wallet (any injected EIP-1193 wallet). This app never
 * asks for, stores, or uses a seed phrase or private key.
 */
import {
  formatUnits,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  CHAIN_ID,
  EXPLORER_URL,
  FACTORY,
  REGISTRY,
  WETH,
  DEPLOYMENT_START_BLOCK,
  getPublicClient,
  getWalletClient,
  requestAccounts,
  ensureGiwaChain,
  verifyCore,
  listConfigs,
  getConfig,
  scanLaunches,
  getTokenMeta,
  getTokenBalance,
  getEthBalance,
  getAllowance,
  curveClient,
  getCurveFull,
  priceFromSqrtPrice,
  scanCurveChart,
  getBlockTimeSeconds,
  scanRecentSwaps,
  scanLaunchEvents,
  scanTokenTransfers,
  summarizeDayStats,
  quoteCurve,
  planCurveSwap,
  buildApproveTx,
  buildCreateLaunchTx,
  waitForLaunchCreated,
  waitForSwapReceipt,
  getPoolState,
  quotePool,
  planPoolSwap,
  buildNativePoolBuy,
  minOut,
  buildWrapTx,
  buildUnwrapTx,
  curveStatusLabel,
  type Launch,
  type LaunchConfig,
  type TokenMeta,
  type CurveFull,
  type ChartData,
  type TradeEvent,
  type TokenDayStats,
  type TransferEvent,
} from "./ammora";
import { friendlyErrorMessage } from "./errors";
import { formatDisplayNumber } from "./format";
import { ICON_COPY, ICON_EXTERNAL_LINK, ICON_SEARCH } from "./icons";
import { initTheme, toggleTheme } from "./theme";
import {
  buildChartSvg,
  buildCandles,
  buildCandleSvg,
  CANDLE_TIMEFRAMES,
  CHART_CACHE_TTL_MS,
  CHART_HEIGHT,
  filterPointsByRange,
  formatPercentChange,
  formatPriceShort,
  type CandleTimeframe,
} from "./chart";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

function el(tag: string, cls = "", text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function explorerLink(address: string, label?: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = `${EXPLORER_URL}/address/${address}`;
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = label ?? shortAddr(address);
  return a;
}

/** Token/ETH amount for display: exact bigint in, shared formatter out —
 * thousands separators, no e-notation, subscript zeros when tiny. */
function fmtAmount(raw: bigint, decimals: number): string {
  return formatDisplayNumber(Number(formatUnits(raw, decimals)));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function showError(box: HTMLElement, err: unknown): void {
  box.innerHTML = "";
  const d = el("div", "error", friendlyErrorMessage(err));
  box.appendChild(d);
}

/** Real Lambda256 GIWA Sepolia test-ETH faucet (verified HTTP 200 on 2026-11-16). */
const FAUCET_URL = "https://faucet.lambda256.io/giwa-sepolia";

/** How many flight-log entries to show, and how often it polls for new ones. */
const FLIGHT_LOG_MAX_ENTRIES = 30;
const FLIGHT_LOG_POLL_MS = 30_000;
/** 24h stats are re-scanned at most this often. */
const DAY_STATS_TTL_MS = 60_000;
const DAY_MS = 86_400_000;
/** Trades table page size on the detail view. */
const TRADES_PAGE_SIZE = 25;
/** Recently-viewed tokens kept in localStorage (curve addresses, newest first). */
const RECENT_KEY = "giwapad.recent.v1";
const RECENT_MAX = 8;

/** Relative age from a wall-clock time, e.g. "15m", "3h", "2d". */
function formatAge(timeMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - timeMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Deterministic hue (0–359) from a token address — monogram fallback color. */
function hueForAddress(address: string): number {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

/** Token monogram tile: first symbol letter on a deterministic hue. No image invented. */
function tokenMonogram(l: EnrichedLaunch, size: "sm" | "lg" = "sm"): HTMLElement {
  const letter = (l.meta?.symbol ?? "?").slice(0, 1).toUpperCase();
  const tile = el("div", `monogram monogram-${size}`, letter);
  tile.style.background = `hsl(${hueForAddress(l.token)} 45% 45%)`;
  return tile;
}

/** Resolve a launch's metadata image (if its metadataURI points at one); null otherwise. */
const imageCache = new Map<string, string | null>();

async function fetchTokenImage(l: EnrichedLaunch): Promise<string | null> {
  const key = l.token.toLowerCase();
  if (imageCache.has(key)) return imageCache.get(key) ?? null;
  let url: string | null = null;
  try {
    const uri = (l.metadataURI || "").trim();
    if (uri) {
      const jsonUrl = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
      const res = await fetch(jsonUrl);
      if (res.ok) {
        const meta = (await res.json()) as { image?: unknown };
        if (typeof meta.image === "string" && meta.image) {
          url = meta.image.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${meta.image.slice(7)}` : meta.image;
        }
      }
    }
  } catch { /* no image — monogram fallback */ }
  imageCache.set(key, url);
  return url;
}

/** Token tile: metadata image when one exists, monogram otherwise. */
function tokenTile(l: EnrichedLaunch, size: "sm" | "lg" = "sm"): HTMLElement {
  const wrap = el("div", `token-tile token-tile-${size}`);
  wrap.appendChild(tokenMonogram(l, size));
  void fetchTokenImage(l).then((url) => {
    if (!url) return;
    const img = document.createElement("img");
    img.src = url;
    img.alt = l.meta?.symbol ?? "";
    img.className = "token-img";
    img.onerror = () => img.remove();
    wrap.innerHTML = "";
    wrap.appendChild(img);
  });
  return wrap;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface EnrichedLaunch extends Launch {
  meta?: TokenMeta;
  curveData?: CurveFull;
  price?: string;
  loadError?: string;
}

const state = {
  account: null as Address | null,
  ethBalance: 0n,
  wethBalance: 0n,
  verifiedBlock: 0n,
  configs: [] as LaunchConfig[],
  launches: [] as EnrichedLaunch[],
  scanStatus: "idle",
  /** Missions-table tab: Trending (24h volume) / New / Near graduation / Graduated. */
  missionsTab: "trending" as "trending" | "new" | "near" | "graduated",
  /** "My launches" toggle on the Missions table. */
  mineOnly: false,
  search: "",
  detailCurve: null as string | null,
  /** Selected token for the standalone Swap page (curve address). */
  swapCurve: null as string | null,
  /** Swap page in wrap mode: ETH <-> WETH (1:1, no launch). Null = launch pair. */
  swapWrap: null as "wrap" | "unwrap" | null,
  slippageBps: 100,
  view: "discover" as "discover" | "create" | "detail" | "profile" | "swap",
  // Cached non-zero token holdings, keyed by token address (lowercase).
  holdings: new Map<string, { balance: bigint; decimals: number; symbol: string }>(),
  holdingsFor: null as Address | null,
  /** 24h per-curve stats (volume, trades, first/last price), keyed by curve (lowercase). */
  dayStats: new Map<string, TokenDayStats>(),
  dayStatsAt: 0,
  /** Raw 24h Swap events (feeds the flight log). */
  dayTrades: [] as TradeEvent[],
  /** Latest known chain head (block + wall time) for honest relative ages. */
  chainHead: null as { block: bigint; timeMs: number } | null,
  blockTimeSeconds: null as number | null,
};

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function recordRecent(curve: string): void {
  try {
    const list = loadRecent().filter((c) => c.toLowerCase() !== curve.toLowerCase());
    list.unshift(curve);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch { /* non-fatal */ }
}

/** "Recently viewed" chips under the header — only tokens the user actually opened. */
function renderRecent(): void {
  const row = $("#recent-row");
  row.innerHTML = "";
  const recent = loadRecent()
    .map((c) => state.launches.find((l) => l.curve.toLowerCase() === c.toLowerCase()))
    .filter((l): l is EnrichedLaunch => !!l);
  if (recent.length === 0) {
    row.classList.add("hidden");
    return;
  }
  row.classList.remove("hidden");
  row.appendChild(el("span", "muted", "Recently viewed"));
  for (const l of recent) {
    const chip = el("button", "btn chip text recent-chip", `$${l.meta?.symbol ?? shortAddr(l.token)}`) as HTMLButtonElement;
    chip.onclick = () => { state.detailCurve = l.curve; showView("detail"); void renderDetail(l.curve); };
    row.appendChild(chip);
  }
}

const LAUNCH_CACHE_KEY = "giwapad.launches.v1";

function loadLaunchCache(): { launches: Launch[]; scannedTo: bigint } {
  try {
    const raw = localStorage.getItem(LAUNCH_CACHE_KEY);
    if (!raw) return { launches: [], scannedTo: DEPLOYMENT_START_BLOCK };
    const parsed = JSON.parse(raw) as { launches: Launch[]; scannedTo: string };
    return {
      launches: parsed.launches.map((l) => ({ ...l, configId: BigInt(l.configId), blockNumber: BigInt(l.blockNumber) })),
      scannedTo: BigInt(parsed.scannedTo),
    };
  } catch {
    return { launches: [], scannedTo: DEPLOYMENT_START_BLOCK };
  }
}

function saveLaunchCache(launches: Launch[], scannedTo: bigint): void {
  try {
    localStorage.setItem(LAUNCH_CACHE_KEY, JSON.stringify({
      launches: launches.map((l) => ({ ...l, configId: l.configId.toString(), blockNumber: l.blockNumber.toString() })),
      scannedTo: scannedTo.toString(),
    }));
  } catch { /* storage full or unavailable — non-fatal */ }
}

/**
 * Shipped launch seed (public/seed.json): a full-scan snapshot taken at
 * build time. Used ONLY as the starting cache on a cold load (empty cache)
 * or when the local cache predates the seed — the bulk scan still covers
 * the delta from the seed's scannedTo to head, so launches created after
 * the seed are discovered normally. The seed covers every launch up to
 * its scannedTo, so merging it with a stale cache cannot skip a launch.
 * A missing/unreadable seed (or a fetch failure) is a silent no-op.
 */
let seedLoadAttempted = false;
async function loadSeededLaunchCache(): Promise<{ launches: Launch[]; scannedTo: bigint }> {
  const cache = loadLaunchCache();
  if (seedLoadAttempted) return cache;
  seedLoadAttempted = true;
  try {
    const res = await fetch("seed.json");
    if (!res.ok) return cache;
    const seed = (await res.json()) as {
      launches: Array<Record<string, unknown>>;
      scannedTo: string | number;
    };
    if (!Array.isArray(seed.launches) || seed.launches.length === 0) return cache;
    const seedScannedTo = BigInt(seed.scannedTo);
    if (cache.launches.length > 0 && cache.scannedTo >= seedScannedTo) return cache;
    const seenCurves = new Set<string>();
    const seenTokens = new Set<string>();
    const merged: Launch[] = [];
    for (const raw of [...cache.launches, ...seed.launches] as Array<Launch & { configId: bigint | string; blockNumber: bigint | string }>) {
      const curveKey = String(raw.curve).toLowerCase();
      const tokenKey = String(raw.token).toLowerCase();
      if (seenCurves.has(curveKey) || seenTokens.has(tokenKey)) continue;
      seenCurves.add(curveKey);
      seenTokens.add(tokenKey);
      merged.push({ ...raw, configId: BigInt(raw.configId), blockNumber: BigInt(raw.blockNumber) });
    }
    const scannedTo = cache.scannedTo > seedScannedTo ? cache.scannedTo : seedScannedTo;
    saveLaunchCache(merged, scannedTo);
    return { launches: merged, scannedTo };
  } catch {
    return cache;
  }
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

async function connectWallet(): Promise<void> {
  const box = $("#wallet-status");
  try {
    box.textContent = "Requesting wallet…";
    const accounts = await requestAccounts();
    if (accounts.length === 0) throw new Error("No account returned by the wallet.");
    await ensureGiwaChain();
    state.account = accounts[0];
    state.holdings.clear();
    state.holdingsFor = null;
    await refreshBalances();
    renderWallet();
    swapFormHandle?.refreshExecState();
    renderDiscover();
    if (state.view === "profile") void renderProfile();
    if (state.detailCurve) renderDetail(state.detailCurve);
  } catch (err) {
    // A failed connect must never leave the user with only an error and no
    // way back: re-render the normal Connect button, then show the short
    // error above it so the user can retry immediately.
    renderWallet();
    box.prepend(el("div", "error", friendlyErrorMessage(err)));
  }
}

async function refreshBalances(): Promise<void> {
  if (!state.account) return;
  const [eth, weth] = await Promise.all([
    getEthBalance(state.account),
    getTokenBalance(WETH, state.account),
  ]);
  state.ethBalance = eth;
  state.wethBalance = weth;
}

function disconnectWallet(): void {
  state.account = null;
  state.ethBalance = 0n;
  state.wethBalance = 0n;
  state.holdings.clear();
  state.holdingsFor = null;
  renderWallet();
  swapFormHandle?.refreshExecState();
  renderDiscover();
  if (state.view === "profile") void renderProfile();
}

/** Close the wallet dropdown menu, if it is open. Safe to call anytime. */
function closeWalletMenu(): void {
  const menu = document.querySelector(".wallet-menu");
  if (menu) menu.classList.add("hidden");
  const btn = document.querySelector<HTMLButtonElement>(".wallet-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

/** Close the mobile hamburger nav, if it is open. Safe to call anytime. */
function closeMobileNav(): void {
  const nav = document.querySelector("#mobile-nav");
  if (nav) nav.classList.add("hidden");
  const btn = document.querySelector<HTMLButtonElement>("#nav-toggle");
  if (btn) {
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Open menu");
    btn.classList.remove("open");
  }
}

/** Open the mobile hamburger nav (closes the wallet menu — only one open). */
function openMobileNav(): void {
  closeWalletMenu();
  const nav = $("#mobile-nav");
  nav.classList.remove("hidden");
  const btn = $("#nav-toggle") as HTMLButtonElement;
  btn.setAttribute("aria-expanded", "true");
  btn.setAttribute("aria-label", "Close menu");
  btn.classList.add("open");
  nav.querySelector<HTMLElement>(".wallet-menu-item")?.focus();
}

function renderWallet(): void {
  const box = $("#wallet-status");
  box.innerHTML = "";
  if (!state.account) {
    // Short "Connect" label on mobile (the full label does not fit the
    // single mobile header row); CSS swaps the visible span at <=900px.
    const b = el("button", "btn primary") as HTMLButtonElement;
    b.append(el("span", "wallet-label-full", "Connect wallet"), el("span", "wallet-label-short", "Connect"));
    b.onclick = () => { closeMobileNav(); void connectWallet(); };
    box.appendChild(b);
    return;
  }
  // Connected: one button with the short address only. Clicking it opens a
  // dropdown with Profile and Disconnect — no wallet-brand or chain label.
  const wrap = el("div", "wallet-menu-wrap");
  const b = el("button", "btn primary wallet-btn", shortAddr(state.account)) as HTMLButtonElement;
  b.setAttribute("aria-haspopup", "menu");
  b.setAttribute("aria-expanded", "false");
  b.title = state.account;
  const menu = el("div", "wallet-menu hidden");
  menu.setAttribute("role", "menu");
  const profileItem = el("button", "wallet-menu-item", "Profile") as HTMLButtonElement;
  profileItem.setAttribute("role", "menuitem");
  profileItem.onclick = () => {
    closeWalletMenu();
    try { history.replaceState(null, "", "#profile"); } catch { /* non-fatal */ }
    showView("profile");
    void renderProfile();
  };
  const dcItem = el("button", "wallet-menu-item danger", "Disconnect wallet") as HTMLButtonElement;
  dcItem.setAttribute("role", "menuitem");
  dcItem.onclick = () => {
    closeWalletMenu();
    disconnectWallet();
  };
  menu.appendChild(profileItem);
  menu.appendChild(dcItem);
  b.onclick = () => {
    if (menu.classList.contains("hidden")) {
      closeMobileNav();
      menu.classList.remove("hidden");
      b.setAttribute("aria-expanded", "true");
      profileItem.focus();
    } else {
      closeWalletMenu();
    }
  };
  wrap.appendChild(b);
  wrap.appendChild(menu);
  box.appendChild(wrap);
}

async function sendTx(tx: { to: Address; data?: Hex; value?: bigint }): Promise<Hash> {
  if (!state.account) throw new Error("Connect a wallet first.");
  const wallet = getWalletClient();
  const hash = await wallet.sendTransaction({
    account: state.account,
    chain: undefined,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  return hash;
}

async function waitReceipt(hash: Hash) {
  return getPublicClient().waitForTransactionReceipt({ hash });
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

/** Market cap in WETH: current price × CIRCULATING supply. Null until price/supply are known. */
function launchMcap(l: EnrichedLaunch): number | null {
  if (!l.meta || !l.price) return null;
  const price = Number.parseFloat(l.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  // Circulating supply = totalSupply minus what the curve still holds.
  // Price × totalSupply is the fully-diluted value — on a fresh launch the
  // curve holds nearly the whole supply, so FDV is a joke headline (a
  // 750,000 ETH "mcap" on 0.07 WETH of liquidity). Fall back to total
  // supply only while the curve state is not loaded yet.
  let supplyRaw = l.meta.totalSupply;
  if (l.curveData) {
    const circ = l.meta.totalSupply - l.curveData.state.baseReserve;
    supplyRaw = circ > 0n ? circ : 0n;
  }
  const supply = Number(supplyRaw) / 10 ** l.meta.decimals;
  if (!Number.isFinite(supply)) return null;
  return price * supply;
}

function launchDayStats(l: EnrichedLaunch): TokenDayStats | undefined {
  return state.dayStats.get(l.curve.toLowerCase());
}

/**
 * 24h % change: current price vs the earliest trade price inside the 24h
 * window. Null when there was no trade in 24h — the table shows "—".
 */
function launchChange24h(l: EnrichedLaunch): number | null {
  const s = launchDayStats(l);
  if (!s || s.firstPrice === null || !l.price) return null;
  const now = Number.parseFloat(l.price);
  if (s.firstPrice <= 0 || !Number.isFinite(now)) return null;
  return ((now - s.firstPrice) / s.firstPrice) * 100;
}

/** Fuel state label shared by the table, cards, and hero. */
function fuelLabel(l: EnrichedLaunch): string {
  if (!l.curveData) return "Loading…";
  if (l.curveData.state.status === 3) return "Graduated";
  if (l.curveData.progress.progressBps >= 8000) return "Near graduation";
  return "Active";
}

/** Interpolated launch wall time from the chain head + measured block time. */
function launchTimeMs(l: EnrichedLaunch): number | null {
  const head = state.chainHead;
  if (!head) return null;
  const blockTimeMs = (state.blockTimeSeconds ?? 1) * 1000;
  return head.timeMs - Number(head.block - l.blockNumber) * blockTimeMs;
}

/** Launch age ("3h") — "—" until the chain head is known, never a fake "0s". */
function formatLaunchAge(l: EnrichedLaunch, nowMs: number): string {
  const t = launchTimeMs(l);
  return t === null ? "—" : formatAge(t, nowMs);
}

function filteredLaunches(): EnrichedLaunch[] {
  const q = state.search.trim().toLowerCase();
  const items = state.launches.filter((l) => {
    if (state.mineOnly && (!state.account || l.creator.toLowerCase() !== state.account.toLowerCase())) return false;
    if (state.missionsTab === "near" && fuelLabel(l) !== "Near graduation") return false;
    if (state.missionsTab === "graduated" && fuelLabel(l) !== "Graduated") return false;
    if (q) {
      const hay = `${l.meta?.name ?? ""} ${l.meta?.symbol ?? ""} ${l.token} ${l.curve} ${l.creator}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const byMcap = (a: EnrichedLaunch, b: EnrichedLaunch): number =>
    (launchMcap(b) ?? -1) - (launchMcap(a) ?? -1) || Number(b.blockNumber - a.blockNumber);
  if (state.missionsTab === "trending") {
    items.sort((a, b) =>
      (launchDayStats(b)?.volumeWeth ?? 0) - (launchDayStats(a)?.volumeWeth ?? 0) || byMcap(a, b));
  } else if (state.missionsTab === "new") {
    items.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  } else if (state.missionsTab === "near") {
    items.sort((a, b) =>
      (b.curveData?.progress.progressBps ?? 0) - (a.curveData?.progress.progressBps ?? 0));
  } else {
    items.sort(byMcap);
  }
  return items;
}

function topByMcap(): EnrichedLaunch | null {
  let best: EnrichedLaunch | null = null;
  let bestMcap = -1;
  for (const l of state.launches) {
    const m = launchMcap(l);
    if (m !== null && m > bestMcap) { bestMcap = m; best = l; }
  }
  return best;
}

function openDetail(l: EnrichedLaunch): void {
  state.detailCurve = l.curve;
  showView("detail");
  void renderDetail(l.curve);
}

/** Segmented fuel bar (20 segments, like a progress gauge). */
function fuelSegments(pct: number, segments = 20): HTMLElement {
  const bar = el("div", "fuel-seg");
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * segments);
  for (let i = 0; i < segments; i++) {
    bar.appendChild(el("div", `fuel-seg-cell${i < filled ? " on" : ""}`));
  }
  return bar;
}

function renderHero(): void {
  const box = $("#home-hero");
  box.innerHTML = "";
  const top = topByMcap();
  if (!top) {
    if (state.launches.length === 0) {
      box.appendChild(el("div", "empty", "No launches found yet on this deployment. Be the first — create a launch."));
    } else {
      box.appendChild(el("div", "empty", "Loading top token…"));
    }
    return;
  }
  const hero = el("div", "hero card");
  hero.tabIndex = 0;
  hero.setAttribute("role", "button");
  hero.onclick = () => openDetail(top);
  hero.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(top); }
  };
  const left = el("div", "hero-left");
  const titleRow = el("div", "hero-title-row");
  titleRow.appendChild(tokenTile(top, "lg"));
  const titleBox = el("div", "");
  titleBox.appendChild(el("div", "hero-symbol", `$${top.meta?.symbol ?? shortAddr(top.token)}`));
  titleBox.appendChild(el("div", "muted", top.meta?.name ?? ""));
  const heroAge = launchTimeMs(top);
  titleBox.appendChild(el("div", "muted", heroAge === null ? "launch time loading…" : `launched ${formatAge(heroAge, state.chainHead?.timeMs ?? Date.now())} ago`));
  titleRow.appendChild(titleBox);
  left.appendChild(titleRow);
  const tradeBtn = el("button", "btn primary hero-trade", `Trade $${top.meta?.symbol ?? ""}`) as HTMLButtonElement;
  tradeBtn.onclick = (e) => { e.stopPropagation(); openDetail(top); };
  left.appendChild(tradeBtn);
  hero.appendChild(left);
  const right = el("div", "hero-right");
  const fuelPct = top.curveData ? top.curveData.progress.progressBps / 100 : 0;
  const fuelRow = el("div", "hero-fuel-row");
  fuelRow.appendChild(el("span", "muted", "Fuel"));
  fuelRow.appendChild(el("span", "hero-fuel-pct", `${fuelPct.toFixed(1)}%`));
  right.appendChild(fuelRow);
  right.appendChild(fuelSegments(fuelPct));
  const mini = el("div", "hero-chart");
  const curveTrades = state.dayTrades.filter((t) => t.curve.toLowerCase() === top.curve.toLowerCase());
  const nowMs = state.chainHead?.timeMs ?? Date.now();
  const price = Number.parseFloat(top.price ?? "0");
  const pts = curveTrades.length > 0
    ? curveTrades.map((t) => ({ block: t.block, timeMs: t.timeMs, price: t.price }))
    : [
        { block: top.blockNumber, timeMs: nowMs - 3600_000, price },
        { block: top.blockNumber, timeMs: nowMs, price },
      ];
  if (curveTrades.length > 0) pts.push({ block: top.blockNumber, timeMs: nowMs, price });
  mini.appendChild(buildChartSvg(pts, 560, 120));
  right.appendChild(mini);
  hero.appendChild(right);
  box.appendChild(hero);
}

function renderTopCards(): void {
  const box = $("#home-top");
  box.innerHTML = "";
  const ranked = [...state.launches]
    .map((l) => ({ l, mcap: launchMcap(l) }))
    .filter((x): x is { l: EnrichedLaunch; mcap: number } => x.mcap !== null)
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, 4);
  if (ranked.length === 0) return;
  box.appendChild(el("h2", "", "Top by market cap"));
  const grid = el("div", "top-grid");
  for (const { l, mcap } of ranked) {
    const card = el("div", "card top-card");
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.onclick = () => openDetail(l);
    card.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(l); }
    };
    const media = el("div", "top-card-media");
    media.appendChild(tokenTile(l, "lg"));
    media.appendChild(el("span", `badge status-${l.curveData?.state.status ?? -1}`, fuelLabel(l)));
    card.appendChild(media);
    const head = el("div", "card-head");
    head.appendChild(el("div", "card-title", `$${l.meta?.symbol ?? shortAddr(l.token)}`));
    const chg = launchChange24h(l);
    head.appendChild(el("span", chg === null ? "muted" : chg >= 0 ? "chart-up" : "chart-down", chg === null ? "—" : formatPercentChange(chg)));
    card.appendChild(head);
    card.appendChild(el("div", "muted", l.meta?.name ?? ""));
    const mcapRow = el("div", "row");
    mcapRow.appendChild(el("span", "k", "Market cap"));
    mcapRow.appendChild(el("span", "v", `${formatDisplayNumber(mcap)} ETH`));
    card.appendChild(mcapRow);
    const poolRow = el("div", "row");
    poolRow.appendChild(el("span", "k", "Pool"));
    poolRow.appendChild(el("span", "v", l.curveData ? `${formatDisplayNumber(Number(formatUnits(l.curveData.state.quoteReserve, 18)))} ETH` : "…"));
    card.appendChild(poolRow);
    grid.appendChild(card);
  }
  box.appendChild(grid);
}

function renderMissionsTable(): void {
  const box = $("#missions-table");
  box.innerHTML = "";
  const items = filteredLaunches();
  if (items.length === 0) {
    box.appendChild(el("div", "empty", state.launches.length === 0
      ? "No launches found yet on this deployment. Be the first — create a launch."
      : "No launches match this filter."));
    return;
  }
  const nowMs = state.chainHead?.timeMs ?? Date.now();
  const scroll = el("div", "table-scroll");
  const table = document.createElement("table");
  table.className = "missions-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Token", "Mcap", "24h", "Fuel", "Vol 24h", "Trades 24h", "Price", "Age", ""]) {
    headRow.appendChild(el("th", "", h));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const l of items) {
    const tr = document.createElement("tr");
    tr.className = "missions-row";
    tr.onclick = () => openDetail(l);
    const tokenCell = document.createElement("td");
    const tokenWrap = el("div", "table-token");
    tokenWrap.appendChild(tokenTile(l, "sm"));
    const names = el("div", "");
    names.appendChild(el("div", "table-symbol", `$${l.meta?.symbol ?? shortAddr(l.token)}`));
    names.appendChild(el("div", "muted table-name", l.meta?.name ?? ""));
    tokenWrap.appendChild(names);
    tokenCell.appendChild(tokenWrap);
    tr.appendChild(tokenCell);
    const mcap = launchMcap(l);
    tr.appendChild(el("td", "", mcap === null ? "…" : `${formatDisplayNumber(mcap)} ETH`));
    const chg = launchChange24h(l);
    const chgCell = el("td", "", chg === null ? "—" : formatPercentChange(chg));
    if (chg !== null) chgCell.className = chg >= 0 ? "chart-up" : "chart-down";
    tr.appendChild(chgCell);
    const fuelCell = document.createElement("td");
    if (l.curveData) {
      const pct = l.curveData.progress.progressBps / 100;
      fuelCell.appendChild(fuelSegments(pct));
      fuelCell.appendChild(el("div", "muted fuel-pct", `${pct.toFixed(1)}%`));
    } else {
      fuelCell.textContent = "…";
    }
    tr.appendChild(fuelCell);
    const s = launchDayStats(l);
    // A missing entry means zero 24h trades once a scan has landed — show
    // "0", not a loading "…". ("…" only until the first scan lands.)
    const dayStatsLanded = state.dayStatsAt > 0;
    tr.appendChild(el("td", "", s ? formatDisplayNumber(s.volumeWeth) : dayStatsLanded ? "0" : "…"));
    tr.appendChild(el("td", "", s ? String(s.trades) : dayStatsLanded ? "0" : "…"));
    tr.appendChild(el("td", "", l.price ? `${formatPriceShort(Number.parseFloat(l.price))} WETH` : "…"));
    tr.appendChild(el("td", "", formatLaunchAge(l, nowMs)));
    const tradeCell = document.createElement("td");
    const tradeBtn = el("button", "btn primary table-trade", "Trade") as HTMLButtonElement;
    tradeBtn.onclick = (e) => { e.stopPropagation(); openDetail(l); };
    tradeCell.appendChild(tradeBtn);
    tr.appendChild(tradeCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  box.appendChild(scroll);
}

interface FlightEntry {
  kind: "buy" | "sell" | "launch";
  timeMs: number | null;
  symbol: string;
  amountWeth: number;
  curve: string;
  creator?: string;
}

function buildFlightEntries(): FlightEntry[] {
  const entries: FlightEntry[] = [];
  const nowMs = state.chainHead?.timeMs ?? Date.now();
  for (const t of state.dayTrades) {
    const l = state.launches.find((x) => x.curve.toLowerCase() === t.curve.toLowerCase());
    entries.push({
      kind: t.baseForQuote ? "sell" : "buy",
      timeMs: t.timeMs,
      symbol: l?.meta?.symbol ?? shortAddr(t.curve),
      amountWeth: Number(t.baseForQuote ? t.amountOut : t.amountIn) / 1e18,
      curve: t.curve,
    });
  }
  for (const l of state.launches) {
    entries.push({
      kind: "launch",
      timeMs: launchTimeMs(l),
      symbol: l.meta?.symbol ?? shortAddr(l.token),
      amountWeth: 0,
      curve: l.curve,
      creator: l.creator,
    });
  }
  entries.sort((a, b) => (b.timeMs ?? -1) - (a.timeMs ?? -1));
  return entries.slice(0, FLIGHT_LOG_MAX_ENTRIES);
}

function renderFlightLog(): void {
  const box = $("#home-flight");
  box.innerHTML = "";
  const head = el("div", "flight-head");
  head.appendChild(el("h3", "", "Flight log"));
  head.appendChild(el("span", "live-dot", ""));
  box.appendChild(head);
  const entries = buildFlightEntries();
  const nowMs = state.chainHead?.timeMs ?? Date.now();
  if (entries.length === 0) {
    box.appendChild(el("div", "muted", "No trades or launches yet — the feed fills in as activity happens on-chain."));
    return;
  }
  const list = el("div", "flight-list");
  for (const e of entries) {
    const row = el("div", "flight-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    const open = () => {
      const l = state.launches.find((x) => x.curve.toLowerCase() === e.curve.toLowerCase());
      if (l) openDetail(l);
    };
    row.onclick = open;
    row.onkeydown = (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
    };
    row.appendChild(el("span", `badge flight-${e.kind}`, e.kind === "buy" ? "Buy" : e.kind === "sell" ? "Sell" : "Launch"));
    row.appendChild(el("span", "flight-symbol", `$${e.symbol}`));
    row.appendChild(el("span", "flight-amount", e.kind === "launch"
      ? (e.creator ? shortAddr(e.creator) : "")
      : `${formatDisplayNumber(e.amountWeth)} ETH`));
    row.appendChild(el("span", "muted flight-age", e.timeMs === null ? "—" : formatAge(e.timeMs, nowMs)));
    list.appendChild(row);
  }
  box.appendChild(list);
}

function renderDiscover(): void {
  // "Near graduation" + "My launches" tabs are temporarily hidden
  // (2026-11-17, user order) — never leave the table stuck on them.
  if (state.missionsTab === "near") state.missionsTab = "trending";
  if (state.mineOnly) state.mineOnly = false;
  const count = state.launches.length;
  $("#launch-count").textContent =
    `${filteredLaunches().length} of ${count} launches · ${state.scanStatus}`;
  renderHero();
  renderTopCards();
  renderMissionsTable();
  renderFlightLog();
}

/** "Launch saya" list (Profile) — the same table as the Discover Missions
 * table, one row per launch instead of a card grid. Same data the cards
 * showed: token, addresses, creator, config, price, raised, graduation,
 * status. Row click (or Trade) opens the detail page. */
function myLaunchesTable(mine: EnrichedLaunch[]): HTMLElement {
  const scroll = el("div", "table-scroll");
  const table = document.createElement("table");
  table.className = "missions-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const h of ["Token", "Token address", "Curve address", "Creator", "Config", "Price", "Raised", "Graduation", "Status", ""]) {
    headRow.appendChild(el("th", "", h));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const l of mine) {
    const tr = document.createElement("tr");
    tr.className = "missions-row";
    tr.tabIndex = 0;
    tr.setAttribute("role", "button");
    const open = () => openDetail(l);
    tr.onclick = open;
    tr.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    };
    const tokenCell = document.createElement("td");
    const tokenWrap = el("div", "table-token");
    tokenWrap.appendChild(tokenTile(l, "sm"));
    const names = el("div", "");
    names.appendChild(el("div", "table-symbol", `$${l.meta?.symbol ?? shortAddr(l.token)}`));
    names.appendChild(el("div", "muted table-name", l.meta?.name ?? ""));
    tokenWrap.appendChild(names);
    tokenCell.appendChild(tokenWrap);
    tr.appendChild(tokenCell);
    tr.appendChild(el("td", "addr", shortAddr(l.token)));
    tr.appendChild(el("td", "addr", shortAddr(l.curve)));
    tr.appendChild(el("td", "addr", shortAddr(l.creator)));
    tr.appendChild(el("td", "", `#${l.configId.toString()}`));
    tr.appendChild(el("td", "", l.price && l.meta ? `${formatPriceShort(Number.parseFloat(l.price))} WETH` : "…"));
    tr.appendChild(el("td", "", l.curveData ? `${fmtAmount(l.curveData.state.quoteReserve, 18)} WETH` : "…"));
    const gradCell = document.createElement("td");
    if (l.curveData) {
      const pct = l.curveData.progress.progressBps / 100;
      gradCell.appendChild(fuelSegments(pct));
      gradCell.appendChild(el("div", "muted fuel-pct", `${pct.toFixed(1)}%`));
    } else {
      gradCell.textContent = "…";
    }
    tr.appendChild(gradCell);
    const statusCell = document.createElement("td");
    if (l.curveData) {
      statusCell.appendChild(el("span", `badge status-${l.curveData.state.status}`, curveStatusLabel(l.curveData.state.status)));
    } else if (l.loadError) {
      const err = el("span", "muted", "Error");
      err.title = l.loadError;
      statusCell.appendChild(err);
    } else {
      statusCell.appendChild(el("span", "badge status--1", "Loading…"));
    }
    tr.appendChild(statusCell);
    const tradeCell = document.createElement("td");
    const tradeBtn = el("button", "btn primary table-trade", "Trade") as HTMLButtonElement;
    tradeBtn.onclick = (e) => { e.stopPropagation(); openDetail(l); };
    tradeCell.appendChild(tradeBtn);
    tr.appendChild(tradeCell);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  return scroll;
}

let dayStatsRun = 0;
/** How many curves the last day-stats scan covered — a partial scan must not poison the 60s TTL. */
let dayStatsCoveredCurves = 0;
/** A scan is already in flight — overlapping scans invalidated each other (run guard) and none ever landed. */
let dayStatsRunning = false;
/** How many enriched launches the last scan covered — re-scan only when enrichment added more. */
let dayStatsScannedEnriched = 0;

/**
 * Seed the chain head + block time at boot (3 fast calls) so launch ages
 * and the flight log show real relative times immediately — they used to
 * wait for the full day-stats scan and showed a fake "0s" meanwhile.
 */
async function seedChainHead(): Promise<void> {
  try {
    const client = getPublicClient();
    const latest = await client.getBlockNumber();
    const [head, blockTime] = await Promise.all([
      client.getBlock({ blockNumber: latest }),
      getBlockTimeSeconds(),
    ]);
    state.chainHead = { block: latest, timeMs: Number(head.timestamp) * 1000 };
    state.blockTimeSeconds = blockTime;
    renderDiscover();
    renderFlightLog();
  } catch { /* ages stay "—" until the day-stats scan seeds the head */ }
}

/**
 * 24h stats for every known curve, from ONE multi-address Swap scan over
 * the last 24h (block time measured from real headers). Best effort and
 * cached for 60s once a scan covered every known launch — the table shows
 * "…" until the first scan lands.
 */
async function loadDayStats(): Promise<void> {
  if (state.launches.length === 0) return;
  if (Date.now() - state.dayStatsAt < DAY_STATS_TTL_MS && dayStatsCoveredCurves >= state.launches.length) return;
  if (dayStatsRunning) return;
  const enriched = state.launches.filter((l) => l.meta);
  if (enriched.length === 0) return;
  const run = ++dayStatsRun;
  dayStatsRunning = true;
  try {
    const client = getPublicClient();
    const latest = await client.getBlockNumber();
    if (state.blockTimeSeconds === null) state.blockTimeSeconds = await getBlockTimeSeconds();
    const blocksPerDay = Math.max(1, Math.floor(86400 / state.blockTimeSeconds));
    const fromBlock = latest > BigInt(blocksPerDay) ? latest - BigInt(blocksPerDay) : 0n;
    const curves = enriched.map((l) => l.curve);
    const decimals = new Map(enriched.map((l) => [l.curve.toLowerCase(), l.meta!.decimals]));
    const trades = await scanRecentSwaps(curves, fromBlock, latest, decimals);
    if (run !== dayStatsRun) return;
    state.dayStats = summarizeDayStats(trades);
    state.dayTrades = trades;
    state.dayStatsAt = Date.now();
    dayStatsCoveredCurves = enriched.length;
    dayStatsScannedEnriched = enriched.length;
    const head = await client.getBlock({ blockNumber: latest });
    state.chainHead = { block: latest, timeMs: Number(head.timestamp) * 1000 };
    renderDiscover();
    // Enrichment may still be adding tokens — scan again once more land,
    // so the table fills up instead of freezing at the first partial scan.
    if (state.launches.filter((l) => l.meta).length > dayStatsScannedEnriched) {
      setTimeout(() => void loadDayStats(), 2000);
    }
  } catch { /* stats are best-effort; the table shows "—" until they load */ }
  finally { dayStatsRunning = false; }
}

/** Flight-log poll: catch launches created since the last refresh, then refresh 24h stats. */
async function pollFlightLog(): Promise<void> {
  if (state.view !== "discover") return;
  try {
    const client = getPublicClient();
    const latest = await client.getBlockNumber();
    const from = state.chainHead ? state.chainHead.block + 1n : latest;
    if (latest >= from) {
      const fresh = await scanLaunchEvents(from, latest);
      if (fresh.length > 0) {
        const known = new Set(state.launches.map((l) => l.curve.toLowerCase()));
        const added = fresh.filter((l) => !known.has(l.curve.toLowerCase()));
        if (added.length > 0) {
          state.launches = [...state.launches, ...added].sort((a, b) => Number(b.blockNumber - a.blockNumber));
          // Persist the launches but keep the bulk scan's own progress
          // marker, so the scan does not skip blocks it has not reached yet.
          const cache = loadLaunchCache();
          saveLaunchCache(state.launches, cache.scannedTo);
          void enrichLaunches();
        }
      }
    }
    await loadDayStats();
    renderFlightLog();
  } catch { /* best effort — the next poll retries */ }
}

async function enrichLaunches(): Promise<void> {
  // Sequential, paced — the public RPC rate-limits bursts. While the user
  // is on a detail view the enrichment pauses, so the detail's own reads
  // (meta, curve state, chart scan) never queue behind this loop — that
  // queue was the ~40–50 s cold detail load.
  for (const l of state.launches) {
    while (state.view === "detail") {
      await new Promise((r) => setTimeout(r, 400));
    }
    if (l.meta && l.curveData) continue;
    try {
      const [meta, curveData] = await Promise.all([
        getTokenMeta(l.token),
        getCurveFull(l.curve),
      ]);
      l.meta = meta;
      l.curveData = curveData;
      l.price = priceFromSqrtPrice(l.curveData.state.sqrtPrice, l.meta.decimals, 18);
    } catch (err) {
      l.loadError = friendlyErrorMessage(err);
    }
    renderDiscover();
    refreshSwapLive();
    await new Promise((r) => setTimeout(r, 150));
  }
  void loadDayStats();
}

/**
 * Insert a freshly created launch into the local list right away, so it
 * shows in Discover / "My launches" / Profile without waiting for the bulk
 * scan to reach its block (~25 min). Deduplicated by token address when the
 * scan later finds the same launch.
 */
function insertOptimisticLaunch(l: {
  token: Address; curve: Address; creator: Address; configId: bigint;
  configHash: Hex; protocolVersion: number; metadataURI: string;
  blockNumber: bigint; txHash: Hash; name: string; symbol: string; decimals: number;
  totalSupply: bigint;
}): void {
  const tokenKey = l.token.toLowerCase();
  const curveKey = l.curve.toLowerCase();
  if (state.launches.some((x) => x.token.toLowerCase() === tokenKey || x.curve.toLowerCase() === curveKey)) return;
  const launch: EnrichedLaunch = {
    token: l.token,
    curve: l.curve,
    creator: l.creator,
    configId: l.configId,
    configHash: l.configHash,
    protocolVersion: l.protocolVersion,
    metadataURI: l.metadataURI,
    blockNumber: l.blockNumber,
    txHash: l.txHash,
    meta: { address: l.token, name: l.name, symbol: l.symbol, decimals: l.decimals, totalSupply: l.totalSupply },
  };
  state.launches = [...state.launches, launch].sort((a, b) => Number(b.blockNumber - a.blockNumber));
  // Persist the launch but keep the scan's own progress marker, so the scan
  // does not skip blocks it has not reached yet.
  const cache = loadLaunchCache();
  saveLaunchCache(state.launches, cache.scannedTo);
  renderDiscover();
}

async function refreshLaunches(): Promise<void> {
  try {
    state.scanStatus = "scanning…";
    renderDiscover();
    const client = getPublicClient();
    const latest = await client.getBlockNumber();
    const cache = loadLaunchCache();
    const from = cache.scannedTo > latest ? latest : cache.scannedTo;
    const found = await scanLaunches(from, latest, (to) => {
      state.scanStatus = `scanning blocks… ${to.toString()}`;
      $("#launch-count").textContent = `${state.launches.length} launches · ${state.scanStatus}`;
    });
    const byCurve = new Map(state.launches.map((l) => [l.curve.toLowerCase(), l]));
    const byToken = new Set(state.launches.map((l) => l.token.toLowerCase()));
    for (const l of [...cache.launches, ...found]) {
      // Dedupe by curve AND by token: an optimistically inserted launch
      // must not appear twice once the scan rediscovers it.
      if (byCurve.has(l.curve.toLowerCase()) || byToken.has(l.token.toLowerCase())) continue;
      byCurve.set(l.curve.toLowerCase(), l);
      byToken.add(l.token.toLowerCase());
    }
    state.launches = [...byCurve.values()].sort((a, b) => Number(b.blockNumber - a.blockNumber));
    saveLaunchCache(state.launches, latest);
    state.scanStatus = `scanned to block ${latest.toString()}`;
    renderDiscover();
    refreshSwapLive();
    void enrichLaunches();
  } catch (err) {
    state.scanStatus = "scan failed";
    renderDiscover();
    showError($("#launch-count"), err);
  }
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

let profileRun = 0;

function myLaunches(): EnrichedLaunch[] {
  if (!state.account) return [];
  const me = state.account.toLowerCase();
  return state.launches.filter((l) => l.creator.toLowerCase() === me);
}

/** Read balanceOf for every known launch token (small batches); keep non-zero. */
async function loadHoldings(account: Address): Promise<void> {
  const tokens = state.launches.map((l) => l.token);
  const fresh = new Map<string, { balance: bigint; decimals: number; symbol: string }>();
  const BATCH = 5;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (token) => {
      try {
        return { token, bal: await getTokenBalance(token, account) };
      } catch {
        return { token, bal: null as bigint | null };
      }
    }));
    for (const { token, bal } of results) {
      if (bal !== null && bal > 0n) {
        fresh.set(token.toLowerCase(), { balance: bal, decimals: 18, symbol: shortAddr(token) });
      }
    }
  }
  // Resolve real symbol/decimals for the (usually few) tokens actually held.
  for (const [key, h] of fresh) {
    try {
      const meta = await getTokenMeta(key as Address);
      h.decimals = meta.decimals;
      h.symbol = meta.symbol;
    } catch { /* keep the fallback */ }
  }
  state.holdings = fresh;
  state.holdingsFor = account;
}

async function renderProfile(): Promise<void> {
  const run = ++profileRun;
  const view = $("#view-profile");
  view.innerHTML = "";
  view.appendChild(el("h2", "", "Profile"));

  if (!state.account) {
    view.appendChild(el("div", "muted", "Connect your wallet to see your launches and token holdings on GIWA Sepolia."));
    const b = el("button", "btn primary", "Connect wallet") as HTMLButtonElement;
    b.onclick = () => void connectWallet();
    view.appendChild(b);
    return;
  }
  const account = state.account;

  // Wallet identity + balances.
  const idPanel = el("div", "panel");
  idPanel.appendChild(el("h3", "", "Wallet"));
  const addrRow = el("div", "row");
  addrRow.appendChild(el("span", "k", "Address"));
  const addrVal = el("span", "v");
  addrVal.appendChild(el("span", "addr", account));
  addrRow.appendChild(addrVal);
  idPanel.appendChild(addrRow);
  const actions = el("div", "seg");
  const copyBtn = el("button", "btn", "") as HTMLButtonElement;
  const resetCopyLabel = (): void => { copyBtn.innerHTML = `${ICON_COPY}<span>Salin alamat</span>`; };
  resetCopyLabel();
  copyBtn.onclick = async () => {
    const done = () => { copyBtn.textContent = "Disalin ✓"; setTimeout(resetCopyLabel, 2000); };
    try {
      await navigator.clipboard.writeText(account);
      done();
    } catch {
      const ta = document.createElement("textarea");
      ta.value = account;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch { copyBtn.textContent = "Gagal menyalin"; }
      document.body.removeChild(ta);
    }
  };
  actions.appendChild(copyBtn);
  const expLink = explorerLink(account, "Lihat di explorer");
  expLink.className = "btn";
  expLink.insertAdjacentHTML("afterbegin", ICON_EXTERNAL_LINK);
  actions.appendChild(expLink);
  idPanel.appendChild(actions);
  const balBox = el("div", "muted", "Loading balances…");
  idPanel.appendChild(balBox);
  view.appendChild(idPanel);

  const refreshBtn = el("button", "btn", "↻ Refresh") as HTMLButtonElement;
  refreshBtn.onclick = () => void renderProfile();
  view.appendChild(refreshBtn);

  // Launch saya.
  const mine = myLaunches();
  const launchSec = el("div", "");
  launchSec.appendChild(el("h3", "", "Launch saya"));
  const launchNote = el("div", "muted", mine.length === 0
    ? "Kamu belum membuat launch apa pun (dari launch yang sudah ditemukan sejauh ini)."
    : `${mine.length} launch dibuat oleh wallet ini.`);
  launchSec.appendChild(launchNote);
  const listBox = el("div", "");
  launchSec.appendChild(listBox);
  view.appendChild(launchSec);

  // Token yang saya pegang.
  const holdSec = el("div", "");
  holdSec.appendChild(el("h3", "", "Token yang saya pegang"));
  const holdBox = el("div", "muted", "Loading balances…");
  holdSec.appendChild(holdBox);
  view.appendChild(holdSec);

  // Live reads, then fill in. Abort quietly if the user navigated away.
  const stillHere = () => run === profileRun && state.view === "profile" && state.account === account;

  try {
    await refreshBalances();
    if (!stillHere()) return;
    renderWallet();
    balBox.innerHTML = "";
    for (const [k, v] of [["ETH", fmtAmount(state.ethBalance, 18)], ["WETH", fmtAmount(state.wethBalance, 18)]] as Array<[string, string]>) {
      const r = el("div", "row");
      r.appendChild(el("span", "k", k));
      r.appendChild(el("span", "v", v));
      balBox.appendChild(r);
    }
  } catch (err) {
    balBox.textContent = `Could not load balances: ${friendlyErrorMessage(err)}`;
  }

  // Enrich my launches (meta + curve state) if not loaded yet.
  for (const l of mine) {
    if (l.meta && l.curveData) continue;
    try {
      l.meta = await getTokenMeta(l.token);
      l.curveData = await getCurveFull(l.curve);
      l.price = priceFromSqrtPrice(l.curveData.state.sqrtPrice, l.meta.decimals, 18);
    } catch (err) {
      l.loadError = friendlyErrorMessage(err);
    }
    if (!stillHere()) return;
  }
  listBox.innerHTML = "";
  if (mine.length === 0) {
    listBox.appendChild(el("div", "empty", "Belum ada launch."));
  } else {
    listBox.appendChild(myLaunchesTable(mine));
  }

  // Holdings.
  try {
    await loadHoldings(account);
    if (!stillHere()) return;
    holdBox.innerHTML = "";
    if (state.holdings.size === 0) {
      holdBox.textContent = "Kamu belum memegang token apa pun dari launch yang dikenal di GiwaPad.";
    } else {
      for (const [token, h] of state.holdings) {
        const r = el("div", "row");
        r.style.cursor = "pointer";
        r.appendChild(el("span", "k", h.symbol));
        r.appendChild(el("span", "v", `${fmtAmount(h.balance, h.decimals)} ${h.symbol}`));
        r.onclick = () => {
          const launch = state.launches.find((x) => x.token.toLowerCase() === token);
          if (launch) { state.detailCurve = launch.curve; showView("detail"); void renderDetail(launch.curve); }
        };
        holdBox.appendChild(r);
      }
    }
  } catch (err) {
    holdBox.textContent = `Could not load holdings: ${friendlyErrorMessage(err)}`;
  }

  if (mine.length === 0 && state.holdings.size === 0) {
    view.appendChild(el("div", "empty", "Kamu belum punya launch dan belum memegang token apa pun dari launch yang dikenal di GiwaPad."));
  }
}

// ---------------------------------------------------------------------------
// Candlestick chart (detail view) — custom SVG, no chart library, no new deps.
// Data comes from real on-chain Swap events (see scanCurveChart): OHLC
// candles per timeframe + a Log-scale toggle. Drawing and bucketing live in
// ./chart.ts; this panel only wires it up.
// ---------------------------------------------------------------------------

let candleTimeframe: CandleTimeframe = "auto";
let candleLog = false;
const chartCache = new Map<string, { at: number; data: ChartData }>();
const chartInflight = new Map<string, Promise<ChartData>>();

/** Chart data for a launch, cached 120s. Shared by the chart panel and the Trades tab. */
async function getDetailChartData(l: EnrichedLaunch): Promise<ChartData> {
  const key = l.curve.toLowerCase();
  const cached = chartCache.get(key);
  if (cached && Date.now() - cached.at < CHART_CACHE_TTL_MS) return cached.data;
  const running = chartInflight.get(key);
  if (running) return running;
  const p = scanCurveChart(l.curve, l.blockNumber, l.meta!.decimals, l.price ?? "0")
    .then((data) => {
      chartCache.set(key, { at: Date.now(), data });
      chartInflight.delete(key);
      return data;
    })
    .catch((err: unknown) => {
      chartInflight.delete(key);
      throw err;
    });
  chartInflight.set(key, p);
  return p;
}

/**
 * Holders from Transfer events. The curve contract itself is excluded: it
 * holds the market's base reserve, it is not a wallet holding. Zero-address
 * (burn) moves are excluded too.
 */
function computeHolders(
  transfers: TransferEvent[],
  curve: Address,
): { count: number; top: Array<{ address: string; balance: bigint }> } {
  const zero = "0x0000000000000000000000000000000000000000";
  const balances = new Map<string, bigint>();
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from !== zero) balances.set(from, (balances.get(from) ?? 0n) - t.value);
    if (to !== zero) balances.set(to, (balances.get(to) ?? 0n) + t.value);
  }
  balances.delete(curve.toLowerCase());
  const holders = [...balances.entries()]
    .filter(([, b]) => b > 0n)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))
    .map(([address, balance]) => ({ address, balance }));
  return { count: holders.length, top: holders };
}

function chartPanel(l: EnrichedLaunch): HTMLElement {
  const wrap = el("div", "panel chart-panel");
  const headRow = el("div", "chart-head");
  headRow.appendChild(el("h3", "", `${l.meta!.symbol} / WETH`));
  const logBtn = el("button", `btn seg-btn${candleLog ? " active" : ""}`, "Log") as HTMLButtonElement;
  logBtn.title = "Toggle log scale";
  logBtn.onclick = () => {
    candleLog = !candleLog;
    logBtn.classList.toggle("active", candleLog);
    void loadChart();
  };
  headRow.appendChild(logBtn);
  wrap.appendChild(headRow);
  const segRow = el("div", "seg");
  const tfBtns = new Map<CandleTimeframe, HTMLButtonElement>();
  for (const { timeframe: tf, label } of CANDLE_TIMEFRAMES) {
    const b = el("button", `btn seg-btn${candleTimeframe === tf ? " active" : ""}`, label) as HTMLButtonElement;
    b.onclick = () => {
      candleTimeframe = tf;
      for (const [t, bb] of tfBtns) bb.classList.toggle("active", t === tf);
      void loadChart();
    };
    tfBtns.set(tf, b);
    segRow.appendChild(b);
  }
  wrap.appendChild(segRow);
  const statsBox = el("div", "chart-stats");
  wrap.appendChild(statsBox);
  const body = el("div", "chart-body");
  const chartSkeleton = el("div", "skeleton");
  chartSkeleton.style.height = `${CHART_HEIGHT}px`;
  body.appendChild(chartSkeleton);
  body.appendChild(el("div", "muted", "Memuat grafik…"));
  wrap.appendChild(body);

  async function loadChart(): Promise<void> {
    try {
      const data = await getDetailChartData(l);
      const candles = buildCandles(data.tradesList, candleTimeframe);
      statsBox.innerHTML = "";
      body.innerHTML = "";
      if (data.trades === 0) {
        body.appendChild(el("div", "muted", "Belum ada trade — harga masih harga awal."));
        // Flat starting-price line, so the panel is never blank.
        body.appendChild(buildChartSvg(filterPointsByRange(data, "all")));
        body.appendChild(el("div", "muted chart-note",
          `0 trade · dari blok ${data.launchBlock.toString()} · harga dari event Swap di chain`));
        return;
      }
      if (data.truncated) {
        body.appendChild(el("div", "muted", "Menampilkan 1,2 jt blok terakhir."));
      }
      if (candles.length === 0) {
        body.appendChild(el("div", "muted", "Tidak ada trade pada rentang ini."));
        return;
      }
      const first = candles[0].open;
      const last = candles[candles.length - 1].close;
      const low = Math.min(...candles.map((c) => c.low));
      const high = Math.max(...candles.map((c) => c.high));
      const change = first > 0 ? ((last - first) / first) * 100 : 0;
      const stats: Array<[string, string, string?]> = [
        ["Harga sekarang", `${formatPriceShort(last)} WETH`],
        ["Terendah", formatPriceShort(low)],
        ["Tertinggi", formatPriceShort(high)],
        ["Perubahan", formatPercentChange(change), change >= 0 ? "chart-up" : "chart-down"],
      ];
      for (const [k, v, cls] of stats) {
        const s = el("div", "chart-stat");
        s.appendChild(el("div", "chart-stat-k", k));
        s.appendChild(el("div", `chart-stat-v${cls ? " " + cls : ""}`, v));
        statsBox.appendChild(s);
      }
      body.appendChild(buildCandleSvg(candles, { log: candleLog }));
      body.appendChild(el("div", "muted chart-note",
        `${data.trades} trade · ${candles.length} candle · dari blok ${data.launchBlock.toString()} · harga dari event Swap di chain`));
    } catch (err) {
      statsBox.innerHTML = "";
      body.innerHTML = "";
      body.appendChild(el("div", "error", friendlyErrorMessage(err)));
      const retry = el("button", "btn", "↻ Retry") as HTMLButtonElement;
      retry.onclick = () => void loadChart();
      body.appendChild(retry);
    }
  }
  void loadChart();
  return wrap;
}

// ---------------------------------------------------------------------------
// Detail + trade
// ---------------------------------------------------------------------------

/** Shared swap-form options (curve + pool). */
interface SwapFormOpts {
  /** "You pay" prefix for the amount label (Swap page); default "Amount". */
  payLabel?: string;
  initialDirection?: "buy" | "sell";
  /** Idle exec-button label; default "Get quote". */
  idleExecLabel?: (dir: "buy" | "sell") => string;
  /** "trade" (Expected out / Fee / Fill) or "swap" (You receive / min / price). Default "trade". */
  quoteStyle?: "trade" | "swap";
  /** Disable the exec button until a wallet is connected AND a valid quote exists (Swap page). */
  disableUntilQuote?: boolean;
  /** "stacked" (detail Trade panel, default) or "uniswap" (Swap page: two
      stacked panels + overlapping flip + big full-width action). */
  layout?: "stacked" | "uniswap";
  /** After a successful swap (result already shown in the modal). */
  onExecuted?: () => Promise<void> | void;
}

interface SwapFormHandle {
  element: HTMLElement;
  setDirection(dir: "buy" | "sell"): void;
  getDirection(): "buy" | "sell";
  /** Re-evaluate the exec button's disabled state (wallet / quote). */
  refreshExecState(): void;
}

interface UniSwapShell {
  root: HTMLElement;
  receiveAmount: HTMLElement;
  payPillSlot: HTMLElement;
  receivePillSlot: HTMLElement;
  flipBtn: HTMLButtonElement;
}

/**
 * Uniswap-style shell for the Swap page: a "You pay" panel (big amount +
 * token pill + balance + MAX), an overlapping flip button, a "You receive"
 * panel (big live quote + token pill + quote details), a gear-toggled
 * slippage row, and a big full-width action button. The shell only builds
 * DOM — the engine (curve / pool / wrap) wires its logic to the elements.
 * The engine's own elements (amount input, balance row, slippage input,
 * exec button, result box, quote box) are re-parented into the shell; the
 * engine's quote box becomes the receive panel's details area.
 */
function uniSwapShell(args: {
  amountInput: HTMLInputElement;
  balRow: HTMLElement;
  slipInput: HTMLInputElement;
  execBtn: HTMLButtonElement;
  resultBox: HTMLElement;
  quoteBox: HTMLElement;
  showSlippage: boolean;
  disableUntilQuote: boolean;
}): UniSwapShell {
  const root = el("div", "uni-swap");
  // Settings row: gear toggles the slippage input (a wrap is 1:1, so it has none).
  if (args.showSlippage) {
    const toolbar = el("div", "uni-toolbar");
    const gear = el("button", "btn icon-btn uni-gear", "⚙") as HTMLButtonElement;
    gear.type = "button";
    gear.title = "Slippage settings";
    gear.setAttribute("aria-label", "Slippage settings");
    const slipRow = el("div", "uni-slip-row hidden");
    slipRow.appendChild(el("span", "", "Slippage tolerance"));
    slipRow.appendChild(args.slipInput);
    slipRow.appendChild(el("span", "", "%"));
    gear.onclick = () => slipRow.classList.toggle("hidden");
    toolbar.appendChild(gear);
    root.append(toolbar, slipRow);
  }
  // Pay panel.
  const payPanel = el("div", "uni-panel uni-pay");
  payPanel.appendChild(el("div", "uni-label", "You pay"));
  const payRow = el("div", "uni-row");
  args.amountInput.classList.add("uni-amount");
  const payPillSlot = el("div", "uni-pill-slot");
  payRow.append(args.amountInput, payPillSlot);
  payPanel.appendChild(payRow);
  payPanel.appendChild(args.balRow);
  root.appendChild(payPanel);
  // Token menu (one instance): drops down from the pay panel, over the
  // receive panel. Either pill toggles it.
  const menuWrap = el("div", "swap-selector");
  menuWrap.appendChild(swapMenuEl());
  root.appendChild(menuWrap);
  // Flip button straddling the two panels.
  const flipWrap = el("div", "uni-flip");
  const flipBtn = el("button", "btn icon-btn uni-flip-btn", "↓") as HTMLButtonElement;
  flipBtn.type = "button";
  flipBtn.title = "Flip direction";
  flipBtn.setAttribute("aria-label", "Flip swap direction");
  flipWrap.appendChild(flipBtn);
  root.appendChild(flipWrap);
  // Receive panel.
  const receivePanel = el("div", "uni-panel uni-receive-panel");
  receivePanel.appendChild(el("div", "uni-label", "You receive"));
  const receiveRow = el("div", "uni-row");
  const receiveAmount = el("div", "uni-receive uni-empty", "0.0");
  const receivePillSlot = el("div", "uni-pill-slot");
  receiveRow.append(receiveAmount, receivePillSlot);
  receivePanel.appendChild(receiveRow);
  args.quoteBox.classList.add("uni-details");
  receivePanel.appendChild(args.quoteBox);
  root.appendChild(receivePanel);
  // Big full-width action + result.
  args.execBtn.classList.add("uni-action");
  if (args.disableUntilQuote) args.execBtn.disabled = true;
  root.append(args.execBtn, args.resultBox);
  return { root, receiveAmount, payPillSlot, receivePillSlot, flipBtn };
}

/** Token menu (ETH / WETH / launches), filled by fillSwapMenu. */
function swapMenuEl(): HTMLElement {
  const menu = el("div", "swap-menu hidden");
  menu.setAttribute("role", "listbox");
  const search = el("input", "swap-menu-search") as HTMLInputElement;
  search.type = "search";
  search.placeholder = "Search by name, ticker or address";
  search.setAttribute("aria-label", "Search tokens");
  search.oninput = () => fillSwapMenu(search.value);
  const list = el("div", "swap-menu-list");
  menu.append(search, list);
  return menu;
}

/** Toggle the Swap page token menu (ETH / WETH / launches). Either pill opens it. */
function toggleSwapMenu(): void {
  const menu = document.querySelector(".swap-menu");
  if (!menu) return;
  if (menu.classList.contains("hidden")) {
    closeWalletMenu();
    closeMobileNav();
    const search = menu.querySelector<HTMLInputElement>(".swap-menu-search");
    if (search) search.value = "";
    fillSwapMenu("");
    menu.classList.remove("hidden");
    const btn = document.querySelector<HTMLButtonElement>(".swap-token-btn");
    if (btn) btn.setAttribute("aria-expanded", "true");
    search?.focus();
  } else {
    closeSwapMenu();
  }
}

/** Launch-token selector pill button. Filled by refreshSwapSelector
 * (compact inside .uni-swap, full above the form otherwise). */
function swapTokenBtnEl(): HTMLButtonElement {
  const btn = el("button", "btn swap-token-btn") as HTMLButtonElement;
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.onclick = () => toggleSwapMenu();
  return btn;
}

/** Launch-token selector (button + dropdown menu), for the Swap page's
 * non-tradeable states (empty / loading / ready-to-graduate). The tradeable
 * form builds the same pieces through the Uniswap shell instead. */
function swapSelectorEl(): { wrap: HTMLElement; btn: HTMLButtonElement } {
  const wrap = el("div", "swap-selector");
  const btn = swapTokenBtnEl();
  wrap.append(btn, swapMenuEl());
  return { wrap, btn };
}

/** Static token pill for the non-launch side of the pair (ETH / WETH).
 * Clicking it opens the same token menu as the launch pill. */
function fixedTokenPill(symbol: "ETH" | "WETH"): HTMLElement {
  const pill = el("button", "btn uni-pill") as HTMLButtonElement;
  pill.type = "button";
  pill.setAttribute("aria-haspopup", "listbox");
  const tile = el("div", "token-tile token-tile-sm");
  const mono = el("div", "monogram monogram-sm", symbol[0]);
  mono.style.background = symbol === "ETH" ? "hsl(220 45% 45%)" : "hsl(160 45% 45%)";
  tile.appendChild(mono);
  pill.appendChild(tile);
  pill.appendChild(el("span", "", symbol));
  pill.appendChild(el("span", "muted", "▾"));
  pill.onclick = () => toggleSwapMenu();
  return pill;
}

/**
 * Curve buy/sell form (the Trade panel's status-1 body), shared by the
 * detail Trade panel and the standalone Swap page. Quote via quoteCurve,
 * plan via planCurveSwap, execution behind the shared review modal.
 * The form itself never sends a transaction without a modal review.
 */
function curveSwapForm(l: EnrichedLaunch, opts: SwapFormOpts): SwapFormHandle {
  const form = el("div", "swap-form");
  const quoteSymbol = "WETH";
  const baseSymbol = l.meta!.symbol;
  const idleLabel = (dir: "buy" | "sell"): string => opts.idleExecLabel?.(dir) ?? "Get quote";
  const payLabel = (dir: "buy" | "sell"): string =>
    opts.payLabel
      ? `${opts.payLabel} (${dir === "buy" ? quoteSymbol : baseSymbol})`
      : `Amount (${dir === "buy" ? quoteSymbol : baseSymbol})`;
  let direction: "buy" | "sell" = opts.initialDirection ?? "buy";
  // Token balance (sell side) loads lazily; WETH balance is cached in state.
  let tokenBalance: bigint | null = null;
  let lastPlan: Awaited<ReturnType<typeof planCurveSwap>> | null = null;
  let lastAmountIn = 0n;
  let hasQuote = false;

  // Uniswap layout (Swap page only): the shell owns the panels; the pills
  // move between them when the direction flips. Stacked layout (detail
  // Trade panel) never touches these.
  let uniShell: UniSwapShell | null = null;
  let uniLaunchPill: HTMLButtonElement | null = null;
  let uniFixedPill: HTMLElement | null = null;
  let uniReceiveAmount: HTMLElement | null = null;
  function placeUniPills(dir: "buy" | "sell"): void {
    if (!uniShell || !uniLaunchPill || !uniFixedPill) return;
    if (dir === "buy") {
      uniShell.payPillSlot.appendChild(uniFixedPill);
      uniShell.receivePillSlot.appendChild(uniLaunchPill);
    } else {
      uniShell.payPillSlot.appendChild(uniLaunchPill);
      uniShell.receivePillSlot.appendChild(uniFixedPill);
    }
  }

  const dirRow = el("div", "seg");
  const buyBtn = el("button", "btn seg-btn active", "Buy") as HTMLButtonElement;
  const sellBtn = el("button", "btn seg-btn", "Sell") as HTMLButtonElement;
  dirRow.append(buyBtn, sellBtn);
  if (opts.layout !== "uniswap") form.appendChild(dirRow);
  const amountLabel = el("label", "", payLabel(direction));
  const amountInput = el("input") as HTMLInputElement;
  amountInput.type = "text";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "0.0";
  const balRow = el("div", "balance-row");
  balRow.appendChild(el("span", "muted", "Balance"));
  const balVal = el("span", "balance-val", "…");
  balRow.appendChild(balVal);
  const maxBtn = el("button", "btn text", "MAX") as HTMLButtonElement;
  maxBtn.onclick = () => {
    const bal = direction === "buy" ? state.wethBalance : tokenBalance;
    if (bal === null) return;
    amountInput.value = formatUnits(bal, direction === "buy" ? 18 : l.meta!.decimals);
    void updateQuote();
  };
  balRow.appendChild(maxBtn);
  // Slippage is real: it feeds planCurveSwap (minimumAmountOut) and the
  // pool min-out. The input is in %; state keeps basis points (1% = 100 bps).
  const slipLabel = el("label", "", "Slippage (%)");
  const slipInput = el("input") as HTMLInputElement;
  slipInput.type = "number";
  slipInput.value = String(state.slippageBps / 100);
  slipInput.min = "0.1";
  slipInput.max = "50";
  slipInput.step = "0.1";
  slipInput.onchange = () => {
    const pct = Number(slipInput.value) || 1;
    state.slippageBps = Math.max(10, Math.min(5000, Math.round(pct * 100)));
    slipInput.value = String(state.slippageBps / 100);
    void updateQuote();
  };
  const quoteBox = el("div", "quote-box muted", "Enter an amount to see a live quote.");
  const execBtn = el("button", "btn primary", idleLabel(direction)) as HTMLButtonElement;
  if (opts.disableUntilQuote) execBtn.disabled = true;
  const resultBox = el("div", "result");

  function refreshExecState(): void {
    if (!opts.disableUntilQuote) return;
    execBtn.disabled = !state.account || !hasQuote;
  }

  function resetExec(): void {
    execBtn.disabled = false;
    execBtn.textContent = idleLabel(direction);
    refreshExecState();
  }

  async function refreshBalRow(): Promise<void> {
    try {
      if (direction === "buy") {
        balVal.textContent = `${fmtAmount(state.wethBalance, 18)} WETH`;
      } else {
        if (!state.account) { balVal.textContent = "Connect a wallet to see your balance."; return; }
        if (tokenBalance === null) tokenBalance = await getTokenBalance(l.token, state.account);
        balVal.textContent = `${fmtAmount(tokenBalance, l.meta!.decimals)} ${l.meta!.symbol}`;
      }
    } catch { balVal.textContent = "Could not load balance."; }
  }

  function setDirection(dir: "buy" | "sell"): void {
    direction = dir;
    if (opts.layout === "uniswap") swapDirection = dir;
    placeUniPills(dir);
    buyBtn.classList.toggle("active", dir === "buy");
    sellBtn.classList.toggle("active", dir === "sell");
    amountLabel.textContent = payLabel(dir);
    lastPlan = null;
    execBtn.textContent = idleLabel(dir);
    void refreshBalRow();
    void updateQuote();
  }
  buyBtn.onclick = () => setDirection("buy");
  sellBtn.onclick = () => setDirection("sell");
  if (direction === "sell") {
    buyBtn.classList.remove("active");
    sellBtn.classList.add("active");
    amountLabel.textContent = payLabel("sell");
  }
  void refreshBalRow();

  async function updateQuote(): Promise<void> {
    lastPlan = null;
    hasQuote = false;
    execBtn.textContent = idleLabel(direction);
    const raw = amountInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      if (opts.layout === "uniswap" && uniReceiveAmount) {
        uniReceiveAmount.textContent = "0.0";
        uniReceiveAmount.classList.add("uni-empty");
      }
      quoteBox.textContent = "Enter an amount to see a live quote.";
      refreshExecState();
      return;
    }
    try {
      const decimals = direction === "buy" ? 18 : l.meta!.decimals;
      const amountIn = parseUnits(raw, decimals);
      lastAmountIn = amountIn;
      const q = await quoteCurve(l.curve!, amountIn, direction === "sell");
      const outDec = direction === "buy" ? l.meta!.decimals : 18;
      const outSym = direction === "buy" ? baseSymbol : quoteSymbol;
      const inSym = direction === "buy" ? quoteSymbol : baseSymbol;
      if (opts.quoteStyle === "swap") {
        const min = minOut(q.amountOut, state.slippageBps);
        // Per-token price: scale both raw amounts to whole tokens first —
        // a raw division is off by 10^(inDec - outDec) whenever the
        // decimals differ (e.g. WETH 18 vs a 9-decimal token: 1e9x wrong).
        const unit = (Number(q.amountOut) / 10 ** outDec) / (Number(amountIn) / 10 ** decimals);
        if (opts.layout === "uniswap" && uniReceiveAmount) {
          // Big receive amount in the panel; the "You receive ≈" line is
          // skipped below so it does not duplicate the big number.
          uniReceiveAmount.textContent = `${fmtAmount(q.amountOut, outDec)} ${outSym}`;
          uniReceiveAmount.classList.remove("uni-empty");
        }
        quoteBox.innerHTML = "";
        if (opts.layout !== "uniswap") {
          quoteBox.appendChild(el("div", "", `You receive ≈ ${fmtAmount(q.amountOut, outDec)} ${outSym}`));
        }
        quoteBox.appendChild(el("div", "", `Minimum received (${(state.slippageBps / 100).toFixed(1)}% slippage): ${fmtAmount(min, outDec)} ${outSym}`));
        if (q.fee > 0n) quoteBox.appendChild(el("div", "", `Fee: ${fmtAmount(q.fee, decimals)} ${inSym}`));
        quoteBox.appendChild(el("div", "", `Price: 1 ${inSym} ≈ ${formatDisplayNumber(unit)} ${outSym}`));
      } else {
        quoteBox.innerHTML = "";
        quoteBox.appendChild(el("div", "", `Expected out: ${fmtAmount(q.amountOut, outDec)} ${outSym}`));
        quoteBox.appendChild(el("div", "", `Fee: ${fmtAmount(q.fee, direction === "buy" ? 18 : l.meta!.decimals)} ${direction === "buy" ? quoteSymbol : baseSymbol}`));
        quoteBox.appendChild(el("div", "", `Fill: ${esc(q.fillKind)}${q.amountLeft > 0n ? ` · unfilled ${fmtAmount(q.amountLeft, decimals)}` : ""}`));
      }
      hasQuote = true;
      execBtn.textContent = "Preview & execute";
    } catch (err) {
      if (opts.layout === "uniswap" && uniReceiveAmount) {
        uniReceiveAmount.textContent = "—";
        uniReceiveAmount.classList.add("uni-empty");
      }
      quoteBox.textContent = `Quote failed: ${friendlyErrorMessage(err)}`;
    }
    refreshExecState();
  }
  amountInput.oninput = () => void updateQuote();

  execBtn.onclick = async () => {
    resultBox.innerHTML = "";
    if (!state.account) { resultBox.appendChild(el("div", "error", "Connect a wallet first.")); return; }
    try {
      if (lastAmountIn === 0n) { resultBox.appendChild(el("div", "error", "Enter an amount and wait for the quote first.")); return; }
      execBtn.disabled = true;
      execBtn.textContent = "Building plan…";
      const isBuy = direction === "buy";
      const needed = lastAmountIn;
      const bal = isBuy ? state.wethBalance : await getTokenBalance(l.token, state.account);
      if (bal < needed) {
        if (isBuy) {
          resultBox.innerHTML = "";
          const short = needed - bal;
          resultBox.appendChild(el("div", "warn", `Your WETH balance (${fmtAmount(bal, 18)}) is short by ${fmtAmount(short, 18)} WETH. Wrap ETH first:`));
          const wrapBtn = el("button", "btn", `Wrap ${fmtAmount(short, 18)} ETH → WETH`) as HTMLButtonElement;
          wrapBtn.onclick = async () => {
            try {
              wrapBtn.disabled = true;
              const hash = await sendTx(buildWrapTx(short));
              resultBox.appendChild(el("div", "muted", `Wrap tx sent: ${shortAddr(hash)} — waiting for confirmation…`));
              await waitReceipt(hash);
              await refreshBalances();
              renderWallet();
              resultBox.appendChild(el("div", "ok", "Wrapped. You can now get a fresh quote."));
            } catch (err) { showError(resultBox, err); }
          };
          resultBox.appendChild(wrapBtn);
        } else {
          resultBox.appendChild(el("div", "error", `Your ${baseSymbol} balance (${fmtAmount(bal, l.meta!.decimals)}) is less than the sell amount.`));
        }
        resetExec();
        return;
      }
      const plan = await planCurveSwap(l.curve!, lastAmountIn, direction === "sell", state.slippageBps, state.account);
      lastPlan = plan;
      const outDec = direction === "buy" ? l.meta!.decimals : 18;
      const outSym = direction === "buy" ? baseSymbol : quoteSymbol;
      const inSym = direction === "buy" ? quoteSymbol : baseSymbol;
      const inDec = direction === "buy" ? 18 : l.meta!.decimals;
      const m = openReviewModal({
        signLabel: "Sign & execute in wallet",
        onClose: () => {
          lastPlan = null;
          resetExec();
        },
      });
      m.body.appendChild(reviewRow("You pay", `${fmtAmount(lastAmountIn, inDec)} ${inSym}`));
      m.body.appendChild(reviewRow("You receive (min)", `${fmtAmount(plan.quote.minimumAmountOut, outDec)} ${outSym}`));
      m.body.appendChild(reviewRow("Fee", `${fmtAmount(plan.quote.fee, inDec)} ${inSym}`));
      m.body.appendChild(reviewRow("Fill", plan.quote.fillKind));
      m.body.appendChild(reviewRow("To (curve)", reviewAddrValue(l.curve!)));
      if (plan.approvals.length > 0) {
        m.body.appendChild(reviewRow("Approvals needed", plan.approvals.map((a) => `${shortAddr(a.token)} → ${shortAddr(a.spender)} (${fmtAmount(a.amount, inDec)})`).join(", ")));
      }
      resetExec();
      m.signBtn.onclick = async () => {
        try {
          reviewBeginSign();
          const p = lastPlan!;
          for (const ap of p.approvals) {
            const allowance = await getAllowance(ap.token, state.account!, ap.spender);
            if (allowance < ap.amount) {
              m.statusBox.appendChild(el("div", "muted", `Approving ${shortAddr(ap.token)} for ${shortAddr(ap.spender)}…`));
              const ah = await sendTx(buildApproveTx(ap.token, ap.spender, ap.amount));
              await waitReceipt(ah);
            }
          }
          m.statusBox.appendChild(el("div", "muted", "Sending swap — confirm in your wallet…"));
          const hash = await sendTx(p.transaction);
          m.statusBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting for confirmation…`));
          const parsed = await waitForSwapReceipt(hash, l.curve!, state.account!, state.account!, direction === "sell", lastAmountIn, p.quote.minimumAmountOut);
          m.statusBox.appendChild(el("div", "ok", `Swap confirmed. Received ${fmtAmount(parsed.amountOut, outDec)} ${outSym}. Consumed ${fmtAmount(parsed.consumedAmountIn, inDec)}.`));
          lastPlan = null;
          reviewFinish();
          await opts.onExecuted?.();
        } catch (err) {
          reviewResetSign("Sign & execute in wallet");
          showError(m.statusBox, err);
        }
      };
    } catch (err) {
      showError(resultBox, err);
      resetExec();
    }
  };

  if (opts.layout === "uniswap") {
    // Uniswap panels (Swap page): the shell re-parents the engine's own
    // elements; the launch pill + WETH pill move between the panels.
    uniShell = uniSwapShell({
      amountInput, balRow, slipInput, execBtn, resultBox, quoteBox,
      showSlippage: true, disableUntilQuote: !!opts.disableUntilQuote,
    });
    form.appendChild(uniShell.root);
    uniReceiveAmount = uniShell.receiveAmount;
    uniLaunchPill = swapTokenBtnEl();
    uniFixedPill = fixedTokenPill("WETH");
    placeUniPills(direction);
    uniShell.flipBtn.onclick = () => {
      closeSwapMenu();
      setDirection(direction === "buy" ? "sell" : "buy");
    };
    // The launch pill is filled by renderSwapSelector() in renderSwapForm
    // once this form is appended — the form is still detached here, so a
    // document query cannot see the pill yet.
  } else {
    form.append(amountLabel, amountInput, balRow, slipLabel, slipInput, quoteBox, execBtn, resultBox);
  }
  return {
    element: form,
    setDirection,
    getDirection: () => direction,
    refreshExecState,
  };
}

function tradePanel(l: EnrichedLaunch): HTMLElement {
  const wrap = el("div", "panel");
  wrap.appendChild(el("h3", "", "Trade"));
  if (!l.curveData || !l.meta) {
    wrap.appendChild(el("div", "muted", "Curve state is still loading."));
    return wrap;
  }
  const status = l.curveData.state.status;

  if (status === 1) {
    wrap.appendChild(curveSwapForm(l, {
      onExecuted: async () => {
        await refreshBalances();
        renderWallet();
        const fresh = await getCurveFull(l.curve);
        l.curveData = fresh;
        l.price = priceFromSqrtPrice(fresh.state.sqrtPrice, l.meta!.decimals, 18);
        renderDiscover();
        // The trade moved the price: drop the cached chart and rebuild just
        // the chart panel, so it shows the new point — the "Swap confirmed"
        // message lives in the modal, not on the page.
        chartCache.delete(l.curve.toLowerCase());
        const oldChart = document.querySelector(".chart-panel");
        if (oldChart) oldChart.replaceWith(chartPanel(l));
      },
    }).element);
  } else if (status === 2) {
    wrap.appendChild(el("div", "warn", "This curve is ready to graduate. Graduation migrates liquidity to the pool and is permissionless."));
    // Graduation is permissionless at the protocol level, but in this app
    // only the launch creator may press the button — anyone else just sees
    // the note. (connectWallet re-renders the detail view, so a creator
    // who connects after opening it gets the button then.)
    const isCreator = !!state.account && state.account.toLowerCase() === l.creator.toLowerCase();
    if (!isCreator) {
      wrap.appendChild(el("div", "muted", "This curve is ready to graduate — only its creator can do it from this app."));
    } else {
      const gBtn = el("button", "btn primary", "Graduate (migrate to pool)") as HTMLButtonElement;
      const gBox = el("div", "result");
      gBtn.onclick = async () => {
        gBox.innerHTML = "";
        if (!state.account) { gBox.appendChild(el("div", "error", "Connect a wallet first.")); return; }
        try {
          gBtn.disabled = true;
          const sdk = curveClient(l.curve!);
          const plan = await sdk.planMigrate();
          gBox.appendChild(el("div", "muted", `Migrate tx targets ${shortAddr(plan.transaction.to)}. Confirm in your wallet…`));
          const hash = await sendTx(plan.transaction);
          gBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting…`));
          await waitReceipt(hash);
          gBox.appendChild(el("div", "ok", "Migration submitted. Refresh the launch to see the graduated pool."));
          const fresh = await getCurveFull(l.curve);
          l.curveData = fresh;
          renderDiscover();
        } catch (err) { showError(gBox, err); }
        gBtn.disabled = false;
      };
      wrap.append(gBtn, gBox);
    }
  } else if (status === 3) {
    wrap.appendChild(el("div", "muted", "Graduated — trading now happens on the canonical pool:"));
    const poolAddr = l.curveData.state.canonicalPool;
    const poolLine = el("div", "");
    poolLine.appendChild(explorerLink(poolAddr, shortAddr(poolAddr)));
    wrap.appendChild(poolLine);
    wrap.appendChild(poolTradePanel(l, poolAddr));
  } else {
    wrap.appendChild(el("div", "muted", `Curve status ${status} — trading is not available in this state.`));
  }
  return wrap;
}


/**
 * Pool buy/sell form for graduated tokens, shared by the detail Pool
 * trading panel and the standalone Swap page. Buy goes through the native
 * router (ETH in); sell plans via planPoolSwap (approvals first). Both
 * behind the shared review modal.
 */
function poolSwapForm(l: EnrichedLaunch, pool: Address, opts: SwapFormOpts): SwapFormHandle {
  const form = el("div", "swap-form");
  const baseSymbol = l.meta!.symbol;
  const idleLabel = (dir: "buy" | "sell"): string => opts.idleExecLabel?.(dir) ?? "Get quote";
  const payLabel = (dir: "buy" | "sell"): string =>
    opts.payLabel
      ? `${opts.payLabel} (${dir === "buy" ? "ETH" : baseSymbol})`
      : dir === "buy" ? "Buy amount (ETH)" : `Sell amount (${baseSymbol})`;
  let direction: "buy" | "sell" = opts.initialDirection ?? "buy";
  let poolTokenBalance: bigint | null = null;
  let lastAmountIn = 0n;
  let lastMinOut = 0n;
  let lastPlan: Awaited<ReturnType<typeof planPoolSwap>> | null = null;
  let lastOutMeta: { symbol: string; decimals: number } | null = null;
  let hasQuote = false;

  // Uniswap layout (Swap page only): the shell owns the panels; the pills
  // move between them when the direction flips. Stacked layout (detail
  // Pool panel) never touches these.
  let uniShell: UniSwapShell | null = null;
  let uniLaunchPill: HTMLButtonElement | null = null;
  let uniFixedPill: HTMLElement | null = null;
  let uniReceiveAmount: HTMLElement | null = null;
  function placeUniPills(dir: "buy" | "sell"): void {
    if (!uniShell || !uniLaunchPill || !uniFixedPill) return;
    if (dir === "buy") {
      uniShell.payPillSlot.appendChild(uniFixedPill);
      uniShell.receivePillSlot.appendChild(uniLaunchPill);
    } else {
      uniShell.payPillSlot.appendChild(uniLaunchPill);
      uniShell.receivePillSlot.appendChild(uniFixedPill);
    }
  }

  const dirRow = el("div", "seg");
  const buyBtn = el("button", "btn seg-btn active", "Buy with ETH") as HTMLButtonElement;
  const sellBtn = el("button", "btn seg-btn", "Sell for WETH") as HTMLButtonElement;
  dirRow.append(buyBtn, sellBtn);
  if (opts.layout !== "uniswap") form.appendChild(dirRow);
  const amountLabel = el("label", "", payLabel(direction));
  const amountInput = el("input") as HTMLInputElement;
  amountInput.type = "text";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "0.0";
  const balRow = el("div", "balance-row");
  balRow.appendChild(el("span", "muted", "Balance"));
  const balVal = el("span", "balance-val", "…");
  balRow.appendChild(balVal);
  const maxBtn = el("button", "btn text", "MAX") as HTMLButtonElement;
  maxBtn.onclick = () => {
    const bal = direction === "buy" ? state.ethBalance : poolTokenBalance;
    if (bal === null) return;
    amountInput.value = formatUnits(bal, direction === "buy" ? 18 : l.meta!.decimals);
    void updateQuote();
  };
  balRow.appendChild(maxBtn);
  // Slippage is real here too: it feeds the pool minimum-out (minOut).
  const slipLabel = el("label", "", "Slippage (%)");
  const slipInput = el("input") as HTMLInputElement;
  slipInput.type = "number";
  slipInput.value = String(state.slippageBps / 100);
  slipInput.min = "0.1";
  slipInput.max = "50";
  slipInput.step = "0.1";
  slipInput.onchange = () => {
    const pct = Number(slipInput.value) || 1;
    state.slippageBps = Math.max(10, Math.min(5000, Math.round(pct * 100)));
    slipInput.value = String(state.slippageBps / 100);
    void updateQuote();
  };
  const quoteBox = el("div", "quote-box muted", "Enter an ETH amount to see a live pool quote.");
  const execBtn = el("button", "btn primary", idleLabel(direction)) as HTMLButtonElement;
  if (opts.disableUntilQuote) execBtn.disabled = true;
  const resultBox = el("div", "result");

  function refreshExecState(): void {
    if (!opts.disableUntilQuote) return;
    execBtn.disabled = !state.account || !hasQuote;
  }

  function resetExec(): void {
    execBtn.disabled = false;
    execBtn.textContent = idleLabel(direction);
    refreshExecState();
  }

  async function refreshPoolBalRow(): Promise<void> {
    try {
      if (direction === "buy") {
        balVal.textContent = `${fmtAmount(state.ethBalance, 18)} ETH`;
      } else {
        if (!state.account) { balVal.textContent = "Connect a wallet to see your balance."; return; }
        if (poolTokenBalance === null) poolTokenBalance = await getTokenBalance(l.token, state.account);
        balVal.textContent = `${fmtAmount(poolTokenBalance, l.meta!.decimals)} ${l.meta!.symbol}`;
      }
    } catch { balVal.textContent = "Could not load balance."; }
  }

  function setDirection(dir: "buy" | "sell"): void {
    direction = dir;
    if (opts.layout === "uniswap") swapDirection = dir;
    placeUniPills(dir);
    buyBtn.classList.toggle("active", dir === "buy");
    sellBtn.classList.toggle("active", dir === "sell");
    amountLabel.textContent = payLabel(dir);
    lastPlan = null;
    execBtn.textContent = idleLabel(dir);
    void refreshPoolBalRow();
    void updateQuote();
  }
  buyBtn.onclick = () => setDirection("buy");
  sellBtn.onclick = () => setDirection("sell");
  if (direction === "sell") {
    buyBtn.classList.remove("active");
    sellBtn.classList.add("active");
    amountLabel.textContent = payLabel("sell");
  }
  void refreshPoolBalRow();

  async function updateQuote(): Promise<void> {
    lastPlan = null;
    hasQuote = false;
    execBtn.textContent = idleLabel(direction);
    const raw = amountInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      if (opts.layout === "uniswap" && uniReceiveAmount) {
        uniReceiveAmount.textContent = "0.0";
        uniReceiveAmount.classList.add("uni-empty");
      }
      quoteBox.textContent = direction === "buy"
        ? "Enter an ETH amount to see a live pool quote."
        : "Enter a token amount to see a live pool quote.";
      refreshExecState();
      return;
    }
    try {
      if (direction === "buy") {
        const amountIn = parseUnits(raw, 18);
        lastAmountIn = amountIn;
        const st = await getPoolState(pool);
        const baseIsWeth = st.baseToken.toLowerCase() === WETH.toLowerCase();
        const outToken = baseIsWeth ? st.quoteToken : st.baseToken;
        const outMeta = await getTokenMeta(outToken);
        lastOutMeta = outMeta;
        const q = await quotePool(pool, WETH, amountIn);
        lastMinOut = minOut(q.amountOut, state.slippageBps);
        if (opts.quoteStyle === "swap") {
          // Per-token price: scale both raw amounts to whole tokens first.
          const unit = (Number(q.amountOut) / 10 ** outMeta.decimals) / (Number(amountIn) / 10 ** 18);
          if (opts.layout === "uniswap" && uniReceiveAmount) {
            uniReceiveAmount.textContent = `${fmtAmount(q.amountOut, outMeta.decimals)} ${outMeta.symbol}`;
            uniReceiveAmount.classList.remove("uni-empty");
          }
          quoteBox.innerHTML = "";
          if (opts.layout !== "uniswap") {
            quoteBox.appendChild(el("div", "", `You receive ≈ ${fmtAmount(q.amountOut, outMeta.decimals)} ${outMeta.symbol}`));
          }
          quoteBox.appendChild(el("div", "", `Minimum received (${(state.slippageBps / 100).toFixed(1)}% slippage): ${fmtAmount(lastMinOut, outMeta.decimals)} ${outMeta.symbol}`));
          quoteBox.appendChild(el("div", "", `Price: 1 ETH ≈ ${formatDisplayNumber(unit)} ${outMeta.symbol}`));
        } else {
          quoteBox.innerHTML = "";
          quoteBox.appendChild(el("div", "", `Expected out: ${fmtAmount(q.amountOut, outMeta.decimals)} ${outMeta.symbol}`));
          quoteBox.appendChild(el("div", "", `Minimum out (${(state.slippageBps / 100).toFixed(1)}% slippage): ${fmtAmount(lastMinOut, outMeta.decimals)} ${outMeta.symbol}`));
        }
        hasQuote = true;
        execBtn.textContent = "Preview & execute";
      } else {
        const amountIn = parseUnits(raw, l.meta!.decimals);
        lastAmountIn = amountIn;
        const q = await quotePool(pool, l.token, amountIn);
        lastMinOut = minOut(q.amountOut, state.slippageBps);
        lastOutMeta = { symbol: "WETH", decimals: 18 };
        if (opts.quoteStyle === "swap") {
          // Per-token price: scale both raw amounts to whole tokens first.
          const unit = (Number(q.amountOut) / 10 ** 18) / (Number(amountIn) / 10 ** l.meta!.decimals);
          if (opts.layout === "uniswap" && uniReceiveAmount) {
            uniReceiveAmount.textContent = `${fmtAmount(q.amountOut, 18)} WETH`;
            uniReceiveAmount.classList.remove("uni-empty");
          }
          quoteBox.innerHTML = "";
          if (opts.layout !== "uniswap") {
            quoteBox.appendChild(el("div", "", `You receive ≈ ${fmtAmount(q.amountOut, 18)} WETH`));
          }
          quoteBox.appendChild(el("div", "", `Minimum received (${(state.slippageBps / 100).toFixed(1)}% slippage): ${fmtAmount(lastMinOut, 18)} WETH`));
          quoteBox.appendChild(el("div", "", `Price: 1 ${baseSymbol} ≈ ${formatDisplayNumber(unit)} WETH`));
        } else {
          quoteBox.innerHTML = "";
          quoteBox.appendChild(el("div", "", `Expected out: ${fmtAmount(q.amountOut, 18)} WETH`));
          quoteBox.appendChild(el("div", "", `Minimum out (${(state.slippageBps / 100).toFixed(1)}% slippage): ${fmtAmount(lastMinOut, 18)} WETH`));
        }
        hasQuote = true;
        execBtn.textContent = "Preview & execute";
      }
    } catch (err) {
      if (opts.layout === "uniswap" && uniReceiveAmount) {
        uniReceiveAmount.textContent = "—";
        uniReceiveAmount.classList.add("uni-empty");
      }
      quoteBox.textContent = `Quote failed: ${friendlyErrorMessage(err)}`;
    }
    refreshExecState();
  }
  amountInput.oninput = () => void updateQuote();

  execBtn.onclick = async () => {
    resultBox.innerHTML = "";
    if (!state.account) { resultBox.appendChild(el("div", "error", "Connect a wallet first.")); return; }
    if (lastAmountIn === 0n) { resultBox.appendChild(el("div", "error", "Enter an amount and wait for the quote first.")); return; }
    try {
      if (direction === "buy") {
        // Pool buys used to execute with no review at all — now they get the
        // same review modal as every other signing flow.
        execBtn.disabled = true;
        execBtn.textContent = "Building plan…";
        if (state.ethBalance < lastAmountIn) {
          resultBox.appendChild(el("div", "error", `Your ETH balance (${fmtAmount(state.ethBalance, 18)}) is less than the buy amount.`));
          resetExec();
          return;
        }
        const outMeta = lastOutMeta ?? { symbol: baseSymbol, decimals: l.meta!.decimals };
        const tx = buildNativePoolBuy(pool, lastAmountIn, lastMinOut, state.account);
        const m = openReviewModal({
          signLabel: "Sign & execute in wallet",
          onClose: () => resetExec(),
        });
        m.body.appendChild(reviewRow("You pay", `${fmtAmount(lastAmountIn, 18)} ETH`));
        m.body.appendChild(reviewRow("You receive (min)", `${fmtAmount(lastMinOut, outMeta.decimals)} ${outMeta.symbol}`));
        m.body.appendChild(reviewRow("To (pool)", reviewAddrValue(pool)));
        resetExec();
        m.signBtn.onclick = async () => {
          try {
            reviewBeginSign();
            m.statusBox.appendChild(el("div", "muted", `Buying with ${fmtAmount(lastAmountIn, 18)} ETH via the native router — confirm in your wallet…`));
            const hash = await sendTx(tx);
            m.statusBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting…`));
            await waitReceipt(hash);
            m.statusBox.appendChild(el("div", "ok", "Pool buy confirmed."));
            reviewFinish();
            await opts.onExecuted?.();
          } catch (err) {
            reviewResetSign("Sign & execute in wallet");
            showError(m.statusBox, err);
          }
        };
        return;
      }
      // Sell: plan first (approvals show in the modal), then execute.
      execBtn.disabled = true;
      execBtn.textContent = "Building plan…";
      const bal = await getTokenBalance(l.token, state.account);
      if (bal < lastAmountIn) {
        resultBox.appendChild(el("div", "error", `Your ${l.meta!.symbol} balance (${fmtAmount(bal, l.meta!.decimals)}) is less than the sell amount.`));
        resetExec();
        return;
      }
      const plan = await planPoolSwap(pool, l.token, lastAmountIn, state.slippageBps, state.account);
      lastPlan = plan;
      const m = openReviewModal({
        signLabel: "Sign & execute in wallet",
        onClose: () => { lastPlan = null; resetExec(); },
      });
      m.body.appendChild(reviewRow("You pay", `${fmtAmount(lastAmountIn, l.meta!.decimals)} ${l.meta!.symbol}`));
      m.body.appendChild(reviewRow("You receive (min)", `${fmtAmount(plan.quote.minimumAmountOut, 18)} WETH`));
      m.body.appendChild(reviewRow("To (pool)", reviewAddrValue(pool)));
      if (plan.approvals.length > 0) {
        m.body.appendChild(reviewRow("Approvals needed", plan.approvals.map((a) => `${shortAddr(a.token)} → ${shortAddr(a.spender)}`).join(", ")));
      }
      resetExec();
      m.signBtn.onclick = async () => {
        try {
          reviewBeginSign();
          const p = lastPlan!;
          for (const ap of p.approvals) {
            const allowance = await getAllowance(ap.token, state.account!, ap.spender);
            if (allowance < ap.amount) {
              m.statusBox.appendChild(el("div", "muted", `Approving ${shortAddr(ap.token)} for ${shortAddr(ap.spender)}…`));
              const ah = await sendTx(buildApproveTx(ap.token, ap.spender, ap.amount));
              await waitReceipt(ah);
            }
          }
          m.statusBox.appendChild(el("div", "muted", "Sending pool swap — confirm in your wallet…"));
          const hash = await sendTx(p.transaction);
          m.statusBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting…`));
          await waitReceipt(hash);
          m.statusBox.appendChild(el("div", "ok", `Pool sell confirmed. Received at least ${fmtAmount(p.quote.minimumAmountOut, 18)} WETH (see the receipt for the exact amount).`));
          lastPlan = null;
          reviewFinish();
          await opts.onExecuted?.();
        } catch (err) {
          reviewResetSign("Sign & execute in wallet");
          showError(m.statusBox, err);
        }
      };
    } catch (err) {
      showError(resultBox, err);
      resetExec();
    }
  };

  if (opts.layout === "uniswap") {
    // Uniswap panels (Swap page): the shell re-parents the engine's own
    // elements; the launch pill + ETH pill move between the panels.
    uniShell = uniSwapShell({
      amountInput, balRow, slipInput, execBtn, resultBox, quoteBox,
      showSlippage: true, disableUntilQuote: !!opts.disableUntilQuote,
    });
    form.appendChild(uniShell.root);
    uniReceiveAmount = uniShell.receiveAmount;
    uniLaunchPill = swapTokenBtnEl();
    uniFixedPill = fixedTokenPill("ETH");
    placeUniPills(direction);
    uniShell.flipBtn.onclick = () => {
      closeSwapMenu();
      setDirection(direction === "buy" ? "sell" : "buy");
    };
    // The launch pill is filled by renderSwapSelector() in renderSwapForm
    // once this form is appended — the form is still detached here, so a
    // document query cannot see the pill yet.
  } else {
    form.append(amountLabel, amountInput, balRow, slipLabel, slipInput, quoteBox, execBtn, resultBox);
  }
  return {
    element: form,
    setDirection,
    getDirection: () => direction,
    refreshExecState,
  };
}

function poolTradePanel(l: EnrichedLaunch, pool: Address): HTMLElement {
  const wrap = el("div", "panel");
  wrap.appendChild(el("h4", "", "Pool trading"));
  wrap.appendChild(poolSwapForm(l, pool, {
    onExecuted: async () => {
      await refreshBalances();
      renderWallet();
    },
  }).element);
  return wrap;
}


/**
 * ETH <-> WETH wrap / unwrap form (Swap page only, Uniswap layout).
 * Exactly 1:1 — no curve/pool quote, no slippage, no fee besides gas.
 * "buy" = wrap (pay ETH, receive WETH); "sell" = unwrap (pay WETH,
 * receive ETH). Executes behind the shared review modal like every
 * other swap. Buying a launch still pays WETH — the user wraps first,
 * then buys; that is the standard flow.
 */
function wrapSwapForm(opts: { initialDirection?: "buy" | "sell" }): SwapFormHandle {
  const idleLabel = (dir: "buy" | "sell"): string => dir === "buy" ? "Wrap ETH → WETH" : "Unwrap WETH → ETH";
  let direction: "buy" | "sell" = opts.initialDirection ?? "buy";
  let lastAmount = 0n;
  let hasQuote = false;

  const amountInput = el("input") as HTMLInputElement;
  amountInput.type = "text";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "0.0";
  const balRow = el("div", "balance-row");
  balRow.appendChild(el("span", "muted", "Balance"));
  const balVal = el("span", "balance-val", "…");
  balRow.appendChild(balVal);
  const maxBtn = el("button", "btn text", "MAX") as HTMLButtonElement;
  maxBtn.onclick = () => {
    const bal = direction === "buy" ? state.ethBalance : state.wethBalance;
    amountInput.value = formatUnits(bal, 18);
    void updateQuote();
  };
  balRow.appendChild(maxBtn);
  const slipInput = el("input") as HTMLInputElement; // unused (1:1) — the shell hides the slippage row
  const quoteBox = el("div", "quote-box muted", "Enter an amount to wrap or unwrap (1:1).");
  const execBtn = el("button", "btn primary", idleLabel(direction)) as HTMLButtonElement;
  const resultBox = el("div", "result");

  const shell = uniSwapShell({
    amountInput, balRow, slipInput, execBtn, resultBox, quoteBox,
    showSlippage: false, disableUntilQuote: true,
  });
  const form = shell.root;
  const ethPill = fixedTokenPill("ETH");
  const wethPill = fixedTokenPill("WETH");
  function placePills(dir: "buy" | "sell"): void {
    if (dir === "buy") {
      shell.payPillSlot.appendChild(ethPill);
      shell.receivePillSlot.appendChild(wethPill);
    } else {
      shell.payPillSlot.appendChild(wethPill);
      shell.receivePillSlot.appendChild(ethPill);
    }
  }
  placePills(direction);

  function refreshExecState(): void {
    execBtn.disabled = !state.account || !hasQuote;
  }
  function resetExec(): void {
    execBtn.disabled = false;
    execBtn.textContent = idleLabel(direction);
    refreshExecState();
  }
  function refreshBal(): void {
    const isWrap = direction === "buy";
    balVal.textContent = `${fmtAmount(isWrap ? state.ethBalance : state.wethBalance, 18)} ${isWrap ? "ETH" : "WETH"}`;
  }
  function setDirection(dir: "buy" | "sell"): void {
    direction = dir;
    swapDirection = dir;
    placePills(dir);
    lastAmount = 0n;
    execBtn.textContent = idleLabel(dir);
    refreshBal();
    void updateQuote();
  }
  shell.flipBtn.onclick = () => {
    closeSwapMenu();
    setDirection(direction === "buy" ? "sell" : "buy");
  };

  function updateQuote(): void {
    lastAmount = 0n;
    hasQuote = false;
    execBtn.textContent = idleLabel(direction);
    const raw = amountInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      shell.receiveAmount.textContent = "0.0";
      shell.receiveAmount.classList.add("uni-empty");
      quoteBox.textContent = "Enter an amount to wrap or unwrap (1:1).";
      refreshExecState();
      return;
    }
    try {
      const amount = parseUnits(raw, 18);
      lastAmount = amount;
      const isWrap = direction === "buy";
      shell.receiveAmount.textContent = `${fmtAmount(amount, 18)} ${isWrap ? "WETH" : "ETH"}`;
      shell.receiveAmount.classList.remove("uni-empty");
      quoteBox.innerHTML = "";
      quoteBox.appendChild(el("div", "", "Rate: 1 ETH = 1 WETH"));
      quoteBox.appendChild(el("div", "", "No slippage — 1:1 wrap. Fee: none besides gas."));
      hasQuote = true;
      execBtn.textContent = "Preview & execute";
    } catch (err) {
      shell.receiveAmount.textContent = "—";
      shell.receiveAmount.classList.add("uni-empty");
      quoteBox.textContent = `Invalid amount: ${friendlyErrorMessage(err)}`;
    }
    refreshExecState();
  }
  amountInput.oninput = () => void updateQuote();

  execBtn.onclick = async () => {
    resultBox.innerHTML = "";
    if (!state.account) { resultBox.appendChild(el("div", "error", "Connect a wallet first.")); return; }
    if (lastAmount === 0n) { resultBox.appendChild(el("div", "error", "Enter an amount and wait for the quote first.")); return; }
    try {
      const isWrap = direction === "buy";
      const bal = isWrap ? state.ethBalance : state.wethBalance;
      if (bal < lastAmount) {
        resultBox.appendChild(el("div", "error", `Your ${isWrap ? "ETH" : "WETH"} balance (${fmtAmount(bal, 18)}) is less than the amount.`));
        return;
      }
      execBtn.disabled = true;
      execBtn.textContent = "Building plan…";
      const tx = isWrap ? buildWrapTx(lastAmount) : buildUnwrapTx(lastAmount);
      const m = openReviewModal({
        signLabel: "Sign & execute in wallet",
        onClose: () => resetExec(),
      });
      m.body.appendChild(reviewRow("You pay", `${fmtAmount(lastAmount, 18)} ${isWrap ? "ETH" : "WETH"}`));
      m.body.appendChild(reviewRow("You receive", `${fmtAmount(lastAmount, 18)} ${isWrap ? "WETH" : "ETH"}`));
      m.body.appendChild(reviewRow("Rate", "1 ETH = 1 WETH"));
      m.body.appendChild(reviewRow("To (WETH)", reviewAddrValue(WETH)));
      resetExec();
      m.signBtn.onclick = async () => {
        try {
          reviewBeginSign();
          m.statusBox.appendChild(el("div", "muted", "Sending — confirm in your wallet…"));
          const hash = await sendTx(tx);
          m.statusBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting for confirmation…`));
          await waitReceipt(hash);
          m.statusBox.appendChild(el("div", "ok", isWrap
            ? `Wrapped ${fmtAmount(lastAmount, 18)} ETH → WETH.`
            : `Unwrapped ${fmtAmount(lastAmount, 18)} WETH → ETH.`));
          reviewFinish();
          await refreshBalances();
          renderWallet();
          refreshBal();
        } catch (err) {
          reviewResetSign("Sign & execute in wallet");
          showError(m.statusBox, err);
        }
      };
    } catch (err) {
      showError(resultBox, err);
      resetExec();
    }
  };

  refreshBal();
  void updateQuote();
  return {
    element: form,
    setDirection,
    getDirection: () => direction,
    refreshExecState,
  };
}


// ---------------------------------------------------------------------------
// Swap page (standalone, Uniswap-style): token selector, flip, and the
// shared swap form. The form is the same curveSwapForm / poolSwapForm the
// detail Trade panel uses — no second copy of the swap execution code.
// ---------------------------------------------------------------------------

let swapSlotEl: HTMLElement | null = null;
let swapFormHandle: SwapFormHandle | null = null;
/** Direction persists across token changes (Uniswap keeps it too). */
let swapDirection: "buy" | "sell" = "buy";

function swapSelectedLaunch(): EnrichedLaunch | null {
  if (!state.swapCurve) return null;
  return state.launches.find((l) => l.curve.toLowerCase() === state.swapCurve!.toLowerCase()) ?? null;
}

/** Open the Swap page with a token preselected (detail / Discover entry points). */
function openSwap(l: EnrichedLaunch): void {
  state.swapCurve = l.curve;
  state.swapWrap = null;
  try { history.replaceState(null, "", `#swap/${l.token}`); } catch { /* non-fatal */ }
  showView("swap");
  renderSwap();
}

function closeSwapMenu(): void {
  const menu = document.querySelector(".swap-menu");
  if (menu) menu.classList.add("hidden");
  const btn = document.querySelector<HTMLButtonElement>(".swap-token-btn");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

/** Refresh the selector button in place (price/mcap as enrichment lands). */
function refreshSwapSelector(): void {
  const btn = document.querySelector<HTMLButtonElement>(".swap-token-btn");
  if (!btn) return;
  const l = swapSelectedLaunch();
  btn.innerHTML = "";
  if (!l) {
    btn.appendChild(el("span", "", "Select a token"));
    btn.appendChild(el("span", "muted", "▾"));
    return;
  }
  btn.appendChild(tokenTile(l, "sm"));
  if (btn.closest(".uni-swap")) {
    // Compact pill inside the Uniswap panels: tile + $SYMBOL + chevron.
    btn.appendChild(el("span", "swap-token-sym", `$${l.meta?.symbol ?? shortAddr(l.token)}`));
    btn.appendChild(el("span", "muted", "▾"));
    return;
  }
  const mid = el("div", "swap-token-mid");
  mid.appendChild(el("div", "swap-token-sym", `$${l.meta?.symbol ?? shortAddr(l.token)}`));
  mid.appendChild(el("div", "muted swap-token-name", l.meta?.name ?? shortAddr(l.token)));
  btn.appendChild(mid);
  btn.appendChild(el("span", "swap-token-price", l.price ? `${formatDisplayNumber(Number.parseFloat(l.price))} WETH` : "…"));
  btn.appendChild(el("span", "muted", "▾"));
}

/** Fill the selector dropdown rows for the current search query. */
function fillSwapMenu(q: string): void {
  const menu = document.querySelector(".swap-menu");
  const list = menu?.querySelector<HTMLElement>(".swap-menu-list");
  if (!menu || !list) return;
  list.innerHTML = "";
  const query = q.trim().toLowerCase();
  // Native ETH + WETH first: the wrap pair (1:1, no curve/pool). Picking
  // ETH wraps (pay ETH), picking WETH unwraps (pay WETH).
  const wrapRows: Array<{ key: "wrap" | "unwrap"; symbol: "ETH" | "WETH"; name: string }> = [
    { key: "wrap", symbol: "ETH", name: "Ethereum (native) — wrap to WETH" },
    { key: "unwrap", symbol: "WETH", name: "Wrapped ETH — unwrap to ETH" },
  ];
  for (const w of wrapRows) {
    if (query && !`${w.symbol} ${w.name} wrap unwrap`.toLowerCase().includes(query)) continue;
    const row = el("button", "swap-token-row") as HTMLButtonElement;
    row.type = "button";
    row.setAttribute("role", "option");
    const tile = el("div", "token-tile token-tile-sm");
    const mono = el("div", "monogram monogram-sm", w.symbol[0]);
    mono.style.background = w.symbol === "ETH" ? "hsl(220 45% 45%)" : "hsl(160 45% 45%)";
    tile.appendChild(mono);
    row.appendChild(tile);
    const mid = el("div", "swap-token-mid");
    mid.appendChild(el("div", "swap-token-sym", w.symbol));
    mid.appendChild(el("div", "muted swap-token-name", w.name));
    row.appendChild(mid);
    row.appendChild(el("span", "swap-token-price", "1:1"));
    row.onclick = () => {
      state.swapWrap = w.key;
      swapDirection = w.key === "wrap" ? "buy" : "sell";
      closeSwapMenu();
      renderSwapForm();
      try { history.replaceState(null, "", "#swap"); } catch { /* non-fatal */ }
    };
    list.appendChild(row);
  }
  const items = state.launches.filter((l) => {
    if (!query) return true;
    const hay = `${l.meta?.name ?? ""} ${l.meta?.symbol ?? ""} ${l.token} ${l.curve} ${l.creator}`.toLowerCase();
    return hay.includes(query);
  });
  if (state.launches.length === 0) {
    list.appendChild(el("div", "empty", "Loading launches…"));
    return;
  }
  if (items.length === 0) {
    list.appendChild(el("div", "empty", "No launches match this search."));
    return;
  }
  for (const l of items) {
    const row = el("button", "swap-token-row") as HTMLButtonElement;
    row.type = "button";
    row.setAttribute("role", "option");
    row.appendChild(tokenTile(l, "sm"));
    const mid = el("div", "swap-token-mid");
    mid.appendChild(el("div", "swap-token-sym", `$${l.meta?.symbol ?? shortAddr(l.token)}`));
    mid.appendChild(el("div", "muted swap-token-name", l.meta?.name ?? shortAddr(l.token)));
    row.appendChild(mid);
    const mcap = launchMcap(l);
    row.appendChild(el("span", "swap-token-price", mcap === null
      ? (l.price ? `${formatDisplayNumber(Number.parseFloat(l.price))} WETH` : "…")
      : `${formatDisplayNumber(mcap)} ETH`));
    row.onclick = () => {
      state.swapCurve = l.curve;
      state.swapWrap = null;
      closeSwapMenu();
      refreshSwapSelector();
      renderSwapForm();
      try { history.replaceState(null, "", `#swap/${l.token}`); } catch { /* non-fatal */ }
    };
    list.appendChild(row);
  }
}

/** Render the swap form for the currently selected token into the slot. */
function renderSwapForm(): void {
  const slot = swapSlotEl;
  if (!slot) return;
  slot.innerHTML = "";
  swapFormHandle = null;
  // ETH <-> WETH wrap pair (no launch): 1:1, no curve/pool.
  if (state.swapWrap) {
    slot.dataset.state = "ready";
    swapFormHandle = wrapSwapForm({ initialDirection: swapDirection });
    slot.appendChild(swapFormHandle.element);
    return;
  }
  const l = swapSelectedLaunch();
  if (!l) {
    slot.dataset.state = "empty";
    slot.appendChild(swapSelectorEl().wrap);
    refreshSwapSelector();
    slot.appendChild(el("div", "empty", "Pick a token above to swap."));
    return;
  }
  if (!l.meta || !l.curveData) {
    slot.dataset.state = "loading";
    slot.appendChild(swapSelectorEl().wrap);
    refreshSwapSelector();
    const sk = el("div", "skeleton");
    sk.style.height = "220px";
    slot.appendChild(sk);
    slot.appendChild(el("div", "muted", "Loading launch data from chain…"));
    return;
  }
  const status = l.curveData.state.status;
  const opts: SwapFormOpts = {
    payLabel: "You pay",
    initialDirection: swapDirection,
    quoteStyle: "swap",
    disableUntilQuote: true,
    layout: "uniswap",
    idleExecLabel: (dir) => dir === "buy" ? `Buy $${l.meta!.symbol}` : `Sell $${l.meta!.symbol}`,
    onExecuted: async () => {
      await refreshBalances();
      renderWallet();
      const fresh = await getCurveFull(l.curve);
      l.curveData = fresh;
      l.price = priceFromSqrtPrice(fresh.state.sqrtPrice, l.meta!.decimals, 18);
      renderDiscover();
      refreshSwapSelector();
    },
  };
  if (status === 1) {
    slot.dataset.state = "ready";
    swapFormHandle = curveSwapForm(l, opts);
    slot.appendChild(swapFormHandle.element);
    // The form is built detached — the launch pill only exists in the
    // document once appended, so fill it now (the in-form call cannot).
    refreshSwapSelector();
  } else if (status === 3) {
    slot.dataset.state = "ready";
    swapFormHandle = poolSwapForm(l, l.curveData.state.canonicalPool, opts);
    slot.appendChild(swapFormHandle.element);
    refreshSwapSelector();
  } else if (status === 2) {
    slot.dataset.state = "ready";
    slot.appendChild(swapSelectorEl().wrap);
    refreshSwapSelector();
    slot.appendChild(el("div", "warn", "This curve is ready to graduate. Graduation migrates liquidity to the pool and is permissionless."));
    const openBtn = el("button", "btn primary", "Open launch") as HTMLButtonElement;
    openBtn.onclick = () => openDetail(l);
    slot.appendChild(openBtn);
  } else {
    slot.dataset.state = "ready";
    slot.appendChild(swapSelectorEl().wrap);
    refreshSwapSelector();
    slot.appendChild(el("div", "muted", `Curve status ${status} — trading is not available in this state.`));
  }
}

/**
 * Called when launch data lands while the user is on Swap: refresh the
 * selector in place, auto-select the top token if none is picked yet, and
 * render the form if it was waiting on data. Never wipes a typed amount —
 * the form only re-renders from its loading or empty state, never once it
 * is ready. (The empty case matters: on a fresh load the slot starts empty
 * because topByMcap has no prices yet, so the auto-select below is the
 * first moment a token exists — without this the selector would show the
 * token but no trade form would ever appear.)
 */
function refreshSwapLive(): void {
  if (state.view !== "swap") return;
  refreshSwapSelector();
  if (!swapSelectedLaunch() && !state.swapWrap && state.launches.length > 0) {
    const top = topByMcap();
    if (top) {
      state.swapCurve = top.curve;
      refreshSwapSelector();
    }
  }
  const slot = swapSlotEl;
  if (slot && (slot.dataset.state === "loading" || slot.dataset.state === "empty")) {
    const l = swapSelectedLaunch();
    if (l) renderSwapForm();
  }
}

function renderSwap(): void {
  const view = $("#view-swap");
  view.innerHTML = "";
  swapFormHandle = null;
  const head = el("div", "swap-head");
  head.appendChild(el("h1", "swap-title", "Swap"));
  head.appendChild(el("p", "muted swap-sub", "Trade any launch on the curve or the pool — live quotes from the chain, no fake numbers."));
  view.appendChild(head);
  // The card holds only the form slot now: the Uniswap shell (selector
  // pills, flip, panels, slippage gear) is built by the form itself.
  const card = el("div", "panel swap-card");
  const slot = el("div", "swap-form-slot");
  swapSlotEl = slot;
  card.appendChild(slot);
  view.appendChild(card);
  if (!state.swapCurve && state.launches.length > 0) {
    const top = topByMcap();
    if (top) state.swapCurve = top.curve;
  }
  refreshSwapSelector();
  renderSwapForm();
}

// Placeholder height (px) for the loading skeleton on the detail view.
const DETAIL_SKELETON_HEIGHT_PX = 160;

async function renderDetail(curve: string): Promise<void> {
  const view = $("#view-detail");
  view.innerHTML = "";
  const launch = state.launches.find((x) => x.curve.toLowerCase() === curve.toLowerCase());
  if (!launch) {
    view.appendChild(el("div", "error", "Launch not found."));
    return;
  }
  try { history.replaceState(null, "", `#detail/${curve}`); } catch { /* non-fatal */ }
  recordRecent(curve);
  renderRecent();

  // Meta + curve state load in parallel (they were sequential). The chart
  // scan and the holders scan start right after, in parallel with each other.
  if (!launch.meta || !launch.curveData) {
    const loadingBox = el("div", "");
    const loadingSkeleton = el("div", "skeleton");
    loadingSkeleton.style.height = `${DETAIL_SKELETON_HEIGHT_PX}px`;
    loadingBox.appendChild(loadingSkeleton);
    loadingBox.appendChild(el("div", "muted", "Loading launch data from chain…"));
    view.appendChild(loadingBox);
    try {
      const [meta, curveData] = await Promise.all([
        getTokenMeta(launch.token),
        getCurveFull(launch.curve),
      ]);
      launch.meta = meta;
      launch.curveData = curveData;
      launch.price = priceFromSqrtPrice(launch.curveData.state.sqrtPrice, launch.meta.decimals, 18);
      // The "Recently viewed" chip rendered above showed the raw address
      // (no symbol yet) — re-render now that the symbol is known.
      renderRecent();
    } catch (err) {
      loadingBox.remove();
      view.appendChild(el("div", "error", `Failed to load: ${friendlyErrorMessage(err)}`));
      return;
    }
    loadingBox.remove();
  }
  const l = launch;
  const meta = l.meta!;
  const cf = l.curveData!;
  const st = cf.state;

  // Holders scan starts now, in parallel with the chart — both fill in
  // their panels when they land (stats header + Holders tab).
  const holdersLoad: Promise<{ count: number; top: Array<{ address: string; balance: bigint }>; truncated: boolean; scannedTo: bigint } | { error: string }> =
    scanTokenTransfers(l.token, l.blockNumber)
      .then((res) => ({ ...computeHolders(res.transfers, l.curve), truncated: res.truncated, scannedTo: res.scannedTo }))
      .catch((err: unknown) => ({ error: friendlyErrorMessage(err) }));

  // Stats header.
  const header = el("div", "panel detail-header");
  const idBox = el("div", "detail-id");
  idBox.appendChild(tokenTile(l, "lg"));
  const names = el("div", "");
  const titleRow = el("div", "detail-title-row");
  titleRow.appendChild(el("div", "detail-symbol", `$${meta.symbol}`));
  titleRow.appendChild(el("span", `badge status-${st.status}`, curveStatusLabel(st.status)));
  names.appendChild(titleRow);
  names.appendChild(el("div", "muted", meta.name));
  const addrRow = el("div", "detail-addr-row");
  addrRow.appendChild(el("span", "addr", shortAddr(l.token)));
  const copyBtn = el("button", "btn text", "Copy") as HTMLButtonElement;
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(l.token);
      copyBtn.textContent = "Disalin ✓";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    } catch { copyBtn.textContent = "Gagal menyalin"; }
  };
  addrRow.appendChild(copyBtn);
  const expLink = explorerLink(l.token, "Explorer");
  expLink.className = "btn text";
  expLink.insertAdjacentHTML("afterbegin", ICON_EXTERNAL_LINK);
  addrRow.appendChild(expLink);
  const swapBtn = el("button", "btn text", "Swap") as HTMLButtonElement;
  swapBtn.onclick = () => openSwap(l);
  addrRow.appendChild(swapBtn);
  names.appendChild(addrRow);
  idBox.appendChild(names);
  header.appendChild(idBox);
  const stats = el("div", "detail-stats");
  const mcap = launchMcap(l);
  const chg = launchChange24h(l);
  const day = launchDayStats(l);
  const fuelPct = cf.progress.progressBps / 100;
  const statDefs: Array<[string, string, string?]> = [
    ["Price", l.price ? `${formatPriceShort(Number.parseFloat(l.price))} WETH` : "…"],
    ["Market cap", mcap === null ? "…" : `${formatDisplayNumber(mcap)} ETH`],
    ["24h", chg === null ? "—" : formatPercentChange(chg), chg === null ? undefined : chg >= 0 ? "chart-up" : "chart-down"],
    ["Vol 24h", day ? `${formatDisplayNumber(day.volumeWeth)} ETH` : "…"],
    ["Holders", "…"],
    ["Fuel", `${fuelPct.toFixed(1)}%`],
  ];
  let holdersValue: HTMLElement | null = null;
  let volValue: HTMLElement | null = null;
  for (const [k, v, cls] of statDefs) {
    const cell = el("div", "detail-stat");
    cell.appendChild(el("div", "chart-stat-k", k));
    const val = el("div", `chart-stat-v${cls ? " " + cls : ""}`, v);
    cell.appendChild(val);
    if (k === "Holders") holdersValue = val;
    if (k === "Vol 24h") volValue = val;
    stats.appendChild(cell);
  }
  header.appendChild(stats);
  view.appendChild(header);
  // Vol 24h comes from the home day-stats scan when it has landed; until
  // then use this token's own trade history (same 24h window, real swaps).
  if (!day && volValue) {
    void getDetailChartData(l)
      .then((data) => {
        if (!volValue) return;
        const cutoff = Date.now() - DAY_MS;
        const vol = data.tradesList
          .filter((t) => t.timeMs >= cutoff)
          .reduce((s, t) => s + (t.baseForQuote ? Number(t.amountOut) : Number(t.amountIn)) / 1e18, 0);
        volValue.textContent = `${formatDisplayNumber(vol)} ETH`;
      })
      .catch(() => { /* keep "…" */ });
  }
  void holdersLoad.then((res) => {
    if (!holdersValue) return;
    if ("error" in res) {
      holdersValue.textContent = "—";
      return;
    }
    holdersValue.textContent = res.truncated ? `${res.count}+` : String(res.count);
    holdersValue.title = res.truncated
      ? `Partial count — transfers scanned back to block ${res.scannedTo.toString()} only`
      : "Holders with a non-zero balance (curve contract excluded)";
  });

  // Main grid: chart (left) + Trade (right).
  const grid = el("div", "detail-grid");
  const leftCol = el("div", "detail-left");
  leftCol.appendChild(chartPanel(l));
  grid.appendChild(leftCol);
  const rightCol = el("div", "detail-right");
  rightCol.appendChild(tradePanel(l));
  grid.appendChild(rightCol);
  view.appendChild(grid);

  // Tabs: Trades / Holders / Tech sheet.
  view.appendChild(detailTabs(l, holdersLoad));
}

type HoldersResult =
  | { count: number; top: Array<{ address: string; balance: bigint }>; truncated: boolean; scannedTo: bigint }
  | { error: string };

function detailTabs(
  l: EnrichedLaunch,
  holdersLoad: Promise<HoldersResult>,
): HTMLElement {
  const wrap = el("div", "panel detail-tabs");
  const tabRow = el("div", "seg");
  const body = el("div", "detail-tab-body");
  const tabs = [
    { id: "trades", label: "Trades" },
    { id: "holders", label: "Holders" },
    { id: "tech", label: "Tech sheet" },
  ] as const;
  let active: (typeof tabs)[number]["id"] = "trades";
  const btns = new Map<string, HTMLButtonElement>();
  for (const t of tabs) {
    const b = el("button", `btn seg-btn${t.id === active ? " active" : ""}`, t.label) as HTMLButtonElement;
    b.onclick = () => {
      active = t.id;
      for (const [id, bb] of btns) bb.classList.toggle("active", id === t.id);
      void loadTab();
    };
    btns.set(t.id, b);
    tabRow.appendChild(b);
  }
  wrap.appendChild(tabRow);
  wrap.appendChild(body);

  async function loadTab(): Promise<void> {
    if (active === "trades") {
      body.innerHTML = "";
      body.appendChild(el("div", "muted", "Loading trades…"));
      try {
        const data = await getDetailChartData(l);
        const trades = [...data.tradesList].sort((a, b) => Number(b.block - a.block) || b.logIndex - a.logIndex);
        body.innerHTML = "";
        if (trades.length === 0) {
          body.appendChild(el("div", "muted", "Belum ada trade."));
          return;
        }
        body.appendChild(el("div", "muted", `${trades.length} trade`));
        const scroll = el("div", "table-scroll");
        const table = document.createElement("table");
        table.className = "trades-table";
        const thead = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const h of ["Age", "Side", "Trader", "ETH", "Tokens", "Price"]) {
          headRow.appendChild(el("th", "", h));
        }
        thead.appendChild(headRow);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        table.appendChild(tbody);
        scroll.appendChild(table);
        body.appendChild(scroll);
        const nowMs = state.chainHead?.timeMs ?? Date.now();
        let shown = 0;
        const moreBtn = el("button", "btn", "Load more trades") as HTMLButtonElement;
        const renderPage = (): void => {
          const page = trades.slice(shown, shown + TRADES_PAGE_SIZE);
          for (const t of page) {
            const tr = document.createElement("tr");
            tr.appendChild(el("td", "", formatAge(t.timeMs, nowMs)));
            const sideCell = el("td", "", t.baseForQuote ? "Sell" : "Buy");
            sideCell.className = t.baseForQuote ? "chart-down" : "chart-up";
            tr.appendChild(sideCell);
            const traderCell = document.createElement("td");
            traderCell.appendChild(explorerLink(t.trader));
            tr.appendChild(traderCell);
            const ethAmount = t.baseForQuote ? t.amountOut : t.amountIn;
            tr.appendChild(el("td", "", fmtAmount(ethAmount, 18)));
            const tokAmount = t.baseForQuote ? t.amountIn : t.amountOut;
            tr.appendChild(el("td", "", fmtAmount(tokAmount, l.meta!.decimals)));
            tr.appendChild(el("td", "", formatPriceShort(t.price)));
            tbody.appendChild(tr);
          }
          shown += page.length;
          moreBtn.classList.toggle("hidden", shown >= trades.length);
        };
        moreBtn.onclick = renderPage;
        renderPage();
        body.appendChild(moreBtn);
      } catch (err) {
        body.innerHTML = "";
        showError(body, err);
      }
      return;
    }
    if (active === "holders") {
      body.innerHTML = "";
      body.appendChild(el("div", "muted", "Loading holders…"));
      const res = await holdersLoad;
      body.innerHTML = "";
      if ("error" in res) {
        showError(body, new Error(res.error));
        return;
      }
      if (res.count === 0) {
        body.appendChild(el("div", "muted", "No holders yet."));
        return;
      }
      if (res.truncated) {
        body.appendChild(el("div", "muted",
          `Partial list — transfers scanned back to block ${res.scannedTo.toString()} only; older holders are not counted.`));
      }
      body.appendChild(el("div", "muted", `${res.count} holder${res.count === 1 ? "" : "s"} (curve contract excluded)`));
      const scroll = el("div", "table-scroll");
      const table = document.createElement("table");
      table.className = "trades-table";
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const h of ["Holder", "Balance"]) {
        headRow.appendChild(el("th", "", h));
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (const h of res.top.slice(0, 50)) {
        const tr = document.createElement("tr");
        const addrCell = document.createElement("td");
        addrCell.appendChild(explorerLink(h.address as Address));
        tr.appendChild(addrCell);
        tr.appendChild(el("td", "", `${fmtAmount(h.balance, l.meta!.decimals)} ${l.meta!.symbol}`));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      scroll.appendChild(table);
      body.appendChild(scroll);
      return;
    }
    // Tech sheet.
    body.innerHTML = "";
    const cf = l.curveData!;
    const st = cf.state;
    // Fully-diluted value (price × total supply) — shown here for honesty,
    // while the headline Market cap uses circulating supply instead.
    const priceNum = l.price ? Number.parseFloat(l.price) : NaN;
    const fdv = Number.isFinite(priceNum)
      ? priceNum * (Number(l.meta!.totalSupply) / 10 ** l.meta!.decimals)
      : null;
    const rows: Array<[string, HTMLElement | string]> = [
      ["Token", explorerLink(l.token)],
      ["Curve", explorerLink(l.curve)],
      ["Creator", explorerLink(l.creator)],
      ["Config", `#${l.configId.toString()}`],
      ["Launch block", l.blockNumber.toString()],
      ["Total supply", `${fmtAmount(l.meta!.totalSupply, l.meta!.decimals)} ${l.meta!.symbol}`],
      ["Fully diluted value", fdv === null ? "…" : `${formatDisplayNumber(fdv)} ETH`],
      ["Decimals", String(l.meta!.decimals)],
      ["Current fee", `${st.currentFeeBps} bps (dynamic ${st.currentDynamicFeeBps} bps)`],
      ["Base reserve", `${fmtAmount(st.baseReserve, l.meta!.decimals)} ${l.meta!.symbol}`],
      ["Quote reserve", `${fmtAmount(st.quoteReserve, 18)} WETH`],
      ["Migration target", `${fmtAmount(cf.progress.target, 18)} WETH raised`],
      ["Fee vault", explorerLink(st.feeVault)],
      ["Metadata URI", l.metadataURI || "(empty)"],
    ];
    if (st.status === 3) rows.push(["Canonical pool", explorerLink(st.canonicalPool)]);
    for (const [k, v] of rows) {
      const r = el("div", "row");
      r.appendChild(el("span", "k", k));
      const val = el("span", "v");
      if (typeof v === "string") val.textContent = v; else val.appendChild(v);
      r.appendChild(val);
      body.appendChild(r);
    }
  }
  void loadTab();
  return wrap;
}

// ---------------------------------------------------------------------------
// Create launch
// ---------------------------------------------------------------------------

let configsLoading = false;

function renderConfigOptions(): boolean {
  const sel = $("#create-config") as HTMLSelectElement;
  const enabled = state.configs.filter((c) => c.enabled);
  sel.innerHTML = "";
  for (const c of enabled) {
    const opt = document.createElement("option");
    opt.value = c.configId.toString();
    opt.textContent = `Config #${c.configId.toString()} — ${c.segments.length} segment(s), ${c.config.tokenDecimals} decimals, migration ${fmtAmount(c.config.migrationQuoteThreshold, 18)} WETH`;
    sel.appendChild(opt);
  }
  sel.onchange = () => renderConfigInfo();
  renderConfigInfo();
  $("#config-status").textContent = enabled.length > 0 ? "" : "No enabled configs found on this deployment.";
  return enabled.length > 0;
}

async function loadConfigsForForm(): Promise<void> {
  const sel = $("#create-config") as HTMLSelectElement;
  const info = $("#config-status");
  if (configsLoading) return;
  if (state.configs.length > 0) {
    // Already loaded (e.g. preloaded at boot) — just render the dropdown.
    if (!renderConfigOptions()) info.textContent = "No enabled configs found on this deployment.";
    return;
  }
  configsLoading = true;
  sel.innerHTML = "";
  info.textContent = "Loading configs from chain…";
  try {
    const res = await Promise.race([
      listConfigs(10),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out after 60s — the RPC is slow or unreachable.")), 60_000)),
    ]);
    state.configs = res.configs;
    if (!renderConfigOptions()) {
      info.textContent = "No enabled configs found on this deployment.";
    }
  } catch (err) {
    showError(info, err);
    const retry = el("button", "btn", "↻ Retry") as HTMLButtonElement;
    retry.onclick = () => void loadConfigsForForm();
    info.appendChild(retry);
  } finally {
    configsLoading = false;
  }
}

function selectedConfig(): LaunchConfig | undefined {
  const sel = $("#create-config") as HTMLSelectElement;
  return state.configs.find((c) => c.configId.toString() === sel.value);
}

function renderConfigInfo(): void {
  const c = selectedConfig();
  const supply = $("#info-supply");
  const fee = $("#info-fee");
  const grad = $("#info-grad");
  const gradSub = $("#info-grad-sub");
  const dec = $("#create-decimals") as HTMLInputElement;
  if (!c) {
    supply.textContent = "—";
    fee.textContent = "—";
    grad.textContent = "—";
    gradSub.textContent = "";
    dec.value = "";
    refreshCreateSummary();
    return;
  }
  // Real values from the selected on-chain config — never copied from Tzero.
  // Supply is comma-grouped for readability (750,000,000,000,000, not 7.5e14).
  supply.textContent = fmtAmount(c.config.totalSupply, c.config.tokenDecimals);
  fee.textContent = `${fmtAmount(c.config.poolCreationFee, 18)} ETH`;
  grad.textContent = "Graduates to pool";
  gradSub.textContent = c.config.migrationQuoteThreshold > 0n
    ? `at ${fmtAmount(c.config.migrationQuoteThreshold, 18)} WETH`
    : `at ${fmtAmount(c.config.migrationBaseThreshold, c.config.tokenDecimals)} tokens`;
  dec.value = String(c.config.tokenDecimals);
  refreshCreateSummary();
}

// ---------------------------------------------------------------------------
// Create form — mission briefing (Tzero-style layout, GiwaPad data)
// ---------------------------------------------------------------------------

/** App's own name/symbol caps. The SDK validator (assertLaunch) and the
 *  factory ABI place NO length limit on name/symbol — only tokenDecimals
 *  (6–9) and the metadata URI (2048 UTF-8 bytes) are enforced on-chain —
 *  so these caps are ours, enforced here and in the inputs' maxlength. */
const CREATE_NAME_MAX_BYTES = 64;
const CREATE_SYMBOL_MAX_BYTES = 10;
const CREATE_DESC_MAX_CHARS = 200;
/** SDK hard cap: assertMetadataURI rejects a metadataURI over this. */
const MAX_METADATA_URI_BYTES = 2048;
/** Image types the drop zone accepts for a local preview. */
const CREATE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const CREATE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Image state for the create form. A picked file is auto-uploaded to a
 * no-key anonymous host (catbox.moe first, uguu.se fallback) through the
 * site's own /api/upload-* proxy — the hosts send no CORS headers, so a
 * direct browser call to them is blocked even though the upload works.
 * metadata, and the launch warning all follow from that one call. Until
 * the upload succeeds (or if it fails), the file lives ONLY in this
 * browser and cannot go into the on-chain metadata. Only the picked
 * image file is ever uploaded — nothing else leaves the browser.
 */
let createFile: { dataUrl: string; fileName: string } | null = null;
let createLinkUrl = "";
/** The picked File itself, kept so a failed auto-upload can be retried. */
let createImageFile: File | null = null;
/** Upload progress for the picked image ("error" carries the message). */
let createImageUpload: { state: "idle" | "uploading" | "error"; error?: string } = { state: "idle" };
/** Monotonic guard: only the newest pick's upload result applies. */
let createImageUploadSeq = 0;
/** True once the user has typed/pasted their own metadata URI — auto-compose stops then. */
let metadataUserSet = false;
let lastAutoMetadata = "";

/** Effective image for preview/metadata: a public link wins, else the local file preview. */
function effectiveCreateImage(): { kind: "link" | "file"; src: string } | null {
  if (createLinkUrl) return { kind: "link", src: createLinkUrl };
  if (createFile) return { kind: "file", src: createFile.dataUrl };
  return null;
}

/** Upload hook: called with the public image URL after a successful
 *  upload (or by a future upload step). The metadata field is refreshed
 *  here too, so the image URL lands in the metadata immediately —
 *  refreshMetadataURI respects a user-set custom URI and leaves it alone. */
function setCreateImageLink(url: string): void {
  createLinkUrl = url;
  const link = $("#create-image-link") as HTMLInputElement;
  link.value = url;
  $("#create-link-wrap").classList.remove("hidden");
  refreshCreateImage();
  refreshMetadataURI();
}

/** fetch with a hard timeout (AbortController) — an anonymous host that
 *  never answers must not hang the form forever. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * Upload one image file to a no-key anonymous host; returns the public
 * direct URL. catbox.moe first (POST user/api.php, reqtype=fileupload,
 * fileToUpload — success is the plain-text https://files.catbox.moe/…
 * link; files persist), uguu.se fallback (POST /upload.php, files[] —
 * JSON { success, files: [{ url }]}, direct https://d.uguu.se/… link,
 * ~24h retention). No API key anywhere; ONLY this image file is sent.
 *
 * Both hosts are called through the site's own same-origin Vercel
 * rewrite proxy (/api/upload-catbox, /api/upload-uguu) — the hosts send
 * no Access-Control-Allow-Origin header, so a browser fetch straight to
 * them is blocked by CORS even though the upload itself works. The
 * proxy forwards the multipart POST unchanged.
 * Throws when both hosts fail, so the caller can show the fallback.
 */
async function uploadImageFile(file: File): Promise<string> {
  try {
    const form = new FormData();
    form.append("reqtype", "fileupload");
    form.append("fileToUpload", file);
    const res = await fetchWithTimeout("/api/upload-catbox", { method: "POST", body: form }, 30_000);
    const text = (await res.text()).trim();
    if (res.ok && text.startsWith("https://files.catbox.moe/")) return text;
  } catch { /* fall through to uguu.se */ }
  const form = new FormData();
  form.append("files[]", file);
  try {
    const res = await fetchWithTimeout("/api/upload-uguu", { method: "POST", body: form }, 90_000);
    const json = (await res.json()) as { success?: boolean; files?: Array<{ url?: string }> };
    const url = json?.files?.[0]?.url;
    if (res.ok && json?.success && typeof url === "string" && url.startsWith("https://")) return url;
  } catch { /* fall through to the friendly error below */ }
  throw new Error("Upload failed — paste a public image link instead.");
}

/**
 * Auto-upload the picked image. On success the public URL flows through
 * setCreateImageLink (preview + metadata follow). Only the newest pick's
 * result applies — an older upload finishing late is ignored. A link the
 * user pasted while the upload was in flight wins and is not clobbered.
 */
async function autoUploadCreateImage(file: File): Promise<void> {
  const seq = ++createImageUploadSeq;
  createImageUpload = { state: "uploading" };
  refreshCreateImage();
  try {
    const url = await uploadImageFile(file);
    if (seq !== createImageUploadSeq) return; // superseded by a newer pick
    createImageUpload = { state: "idle" };
    if (!createLinkUrl) setCreateImageLink(url);
    else refreshCreateImage();
  } catch (err) {
    if (seq !== createImageUploadSeq) return; // superseded by a newer pick
    createImageUpload = { state: "error", error: err instanceof Error ? err.message : "Upload failed — paste a public image link instead." };
    refreshCreateImage();
  }
}

/** The form fields that go into the metadata JSON (image only when public). */
function createMetadataObject(): Record<string, string> {
  const name = ($("#create-name") as HTMLInputElement).value.trim();
  const symbol = ($("#create-symbol") as HTMLInputElement).value.trim().toUpperCase();
  const desc = ($("#create-desc") as HTMLTextAreaElement).value.trim();
  const web = ($("#create-link-web") as HTMLInputElement).value.trim();
  const x = ($("#create-link-x") as HTMLInputElement).value.trim();
  const tg = ($("#create-link-tg") as HTMLInputElement).value.trim();
  const meta: Record<string, string> = {};
  if (name) meta.name = name;
  if (symbol) meta.symbol = symbol;
  if (desc) meta.description = desc;
  if (createLinkUrl) meta.image = createLinkUrl;
  if (web) meta.website = web;
  if (x) meta.twitter = x;
  if (tg) meta.telegram = tg;
  return meta;
}

/** Auto-compose a data: metadata URI from the form. Empty when nothing is filled. */
function composeMetadataURI(): string {
  const meta = createMetadataObject();
  if (Object.keys(meta).length === 0) return "";
  return `data:application/json;base64,${base64Utf8(JSON.stringify(meta))}`;
}

/** Rewrite the metadata field from the form, unless the user set their own URI. */
function refreshMetadataURI(): void {
  const field = $("#create-metadata") as HTMLInputElement;
  const note = $("#metadata-note");
  const mode = $("#metadata-mode");
  if (metadataUserSet) {
    mode.textContent = "custom";
    note.textContent = "";
    note.className = "field-note";
    return;
  }
  mode.textContent = "auto";
  const composed = composeMetadataURI();
  if (!composed) {
    field.value = "";
    lastAutoMetadata = "";
    note.textContent = "";
    note.className = "field-note";
    return;
  }
  if (utf8Bytes(composed) > MAX_METADATA_URI_BYTES) {
    note.textContent = `Metadata too long (${utf8Bytes(composed)}/${MAX_METADATA_URI_BYTES} bytes) — shorten the description or links, or paste a hosted metadata URI.`;
    note.className = "field-note error-text";
    return;
  }
  note.textContent = "";
  note.className = "field-note";
  field.value = composed;
  lastAutoMetadata = composed;
}

/** Live preview card + counters + image note. Runs on every form input. */
function refreshCreatePreview(): void {
  const name = ($("#create-name") as HTMLInputElement).value.trim();
  const symbol = ($("#create-symbol") as HTMLInputElement).value.trim().toUpperCase();
  const desc = ($("#create-desc") as HTMLTextAreaElement).value;
  const nameBytes = utf8Bytes(($("#create-name") as HTMLInputElement).value);
  const symBytes = utf8Bytes(($("#create-symbol") as HTMLInputElement).value);
  const nameCount = $("#name-count");
  nameCount.textContent = `${nameBytes}/${CREATE_NAME_MAX_BYTES} bytes`;
  nameCount.classList.toggle("over", nameBytes > CREATE_NAME_MAX_BYTES);
  const symCount = $("#symbol-count");
  symCount.textContent = `${symBytes}/${CREATE_SYMBOL_MAX_BYTES} bytes`;
  symCount.classList.toggle("over", symBytes > CREATE_SYMBOL_MAX_BYTES);
  $("#desc-count").textContent = `${desc.length}/${CREATE_DESC_MAX_CHARS}`;
  $("#preview-symbol").textContent = symbol ? `$${symbol}` : "$TICKER";
  $("#preview-name").textContent = name || "Mission name";
  $("#preview-by").textContent = state.account ? `by ${shortAddr(state.account)}` : "by —";
  $("#sum-ticker").textContent = symbol ? `$${symbol}` : "—";
  refreshCreateImage();
  refreshMetadataURI();
}

/** Drop-zone + preview-card image area. A local file previews here and in the
 *  preview card, but the note under the zone says plainly it has no public
 *  URL yet — only a pasted link makes it into the metadata. */
function refreshCreateImage(): void {
  const img = effectiveCreateImage();
  const dzImg = $("#dropzone-img") as HTMLImageElement;
  const dzPlaceholder = $("#dropzone-placeholder");
  const removeBtn = $("#dropzone-remove");
  const status = $("#image-status");
  const note = $("#create-image-note");
  const uploadBtn = $("#create-image-upload") as HTMLButtonElement;
  const spinner = $("#image-upload-spinner");
  const media = $("#create-preview-media");
  const rocket = document.querySelector("#dropzone-placeholder svg")?.cloneNode(true) as SVGSVGElement | undefined;
  media.innerHTML = "";
  if (!img) {
    dzImg.classList.add("hidden");
    dzImg.removeAttribute("src");
    dzPlaceholder.classList.remove("hidden");
    removeBtn.classList.add("hidden");
    uploadBtn.classList.add("hidden");
    spinner.classList.add("hidden");
    status.textContent = "";
    note.textContent = "";
    note.className = "field-note muted";
    if (rocket) media.appendChild(rocket);
    return;
  }
  dzPlaceholder.classList.add("hidden");
  dzImg.src = img.src;
  dzImg.classList.remove("hidden");
  removeBtn.classList.remove("hidden");
  const mediaImg = document.createElement("img");
  mediaImg.src = img.src;
  mediaImg.alt = "Token image preview";
  mediaImg.className = "preview-media-img";
  mediaImg.onerror = () => { mediaImg.remove(); if (rocket) media.appendChild(rocket); };
  media.appendChild(mediaImg);
  if (img.kind === "file") {
    if (createImageUpload.state === "uploading") {
      status.textContent = "Uploading image…";
      note.textContent = "Uploading to a public host so it can go into the token metadata…";
      note.className = "field-note muted";
      spinner.classList.remove("hidden");
      uploadBtn.classList.add("hidden");
    } else if (createImageUpload.state === "error") {
      status.textContent = "upload failed";
      note.textContent = `${createImageUpload.error ?? "Upload failed."} You can retry the upload or paste a public image link below.`;
      note.className = "field-note error-text";
      spinner.classList.add("hidden");
      uploadBtn.classList.remove("hidden");
    } else {
      status.textContent = "local only";
      note.textContent = "This image only lives in your browser for now — it has no public URL, so it cannot go into the token metadata yet. Paste a public image link below to include it.";
      note.className = "field-note warn-text";
      spinner.classList.add("hidden");
      // A local file with no link and no upload in flight (e.g. picked
      // before this code deployed): offer the explicit upload action.
      uploadBtn.classList.remove("hidden");
    }
  } else {
    status.textContent = "linked";
    note.textContent = "";
    note.className = "field-note muted";
    spinner.classList.add("hidden");
    uploadBtn.classList.add("hidden");
  }
}

/** Summary card: creation fee + total to send are real config math. There is
 *  no initial buy in this flow (the SDK's plain createLaunch does not
 *  combine creation with a first buy), so those rows stay "—". */
function refreshCreateSummary(): void {
  const c = selectedConfig();
  const fee = c ? `${fmtAmount(c.config.poolCreationFee, 18)} ETH` : "—";
  $("#sum-fee").textContent = fee;
  $("#sum-total").textContent = fee;
}

function validPublicImageLink(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("ipfs://");
}

function handleCreateImageFile(file: File | undefined | null): void {
  const note = $("#create-image-note");
  if (!file) return;
  if (!CREATE_IMAGE_TYPES.includes(file.type)) {
    note.textContent = "That file is not an image — use PNG, JPG, GIF or WebP.";
    note.className = "field-note error-text";
    return;
  }
  if (file.size > CREATE_IMAGE_MAX_BYTES) {
    note.textContent = `That image is too big (${(file.size / 1024 / 1024).toFixed(1)} MB) — max 2 MB for a preview.`;
    note.className = "field-note error-text";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    createFile = { dataUrl: String(reader.result), fileName: file.name };
    createImageFile = file;
    createImageUpload = { state: "idle" };
    refreshCreateImage();
    // Auto-upload: the preview shows immediately; the public URL lands
    // in the link field + metadata as soon as the host answers.
    void autoUploadCreateImage(file);
  };
  reader.onerror = () => {
    note.textContent = "Could not read that image — try another file.";
    note.className = "field-note error-text";
  };
  reader.readAsDataURL(file);
}

function clearCreateImage(): void {
  createFile = null;
  createImageFile = null;
  createImageUpload = { state: "idle" };
  createImageUploadSeq++; // an in-flight upload for the removed file is ignored
  createLinkUrl = "";
  ($("#create-image-link") as HTMLInputElement).value = "";
  ($("#create-image-file") as HTMLInputElement).value = "";
  refreshCreateImage();
  refreshMetadataURI();
}

function initCreateForm(): void {
  // Fuel bar: 20 empty segments (a fresh token has 0% fuel).
  const fuel = $("#preview-fuel");
  for (let i = 0; i < 20; i++) fuel.appendChild(el("span", "fuel-seg-cell"));
  const nameEl = $("#create-name") as HTMLInputElement;
  const symEl = $("#create-symbol") as HTMLInputElement;
  const descEl = $("#create-desc") as HTMLTextAreaElement;
  nameEl.addEventListener("input", refreshCreatePreview);
  symEl.addEventListener("input", refreshCreatePreview);
  descEl.addEventListener("input", refreshCreatePreview);
  for (const id of ["create-link-web", "create-link-x", "create-link-tg"]) {
    $(`#${id}`).addEventListener("input", () => {
      const note = $("#create-links-note");
      const bad = ["create-link-web", "create-link-x", "create-link-tg"]
        .map((x) => ($(`#${x}`) as HTMLInputElement).value.trim())
        .filter((v) => v && !v.startsWith("https://"));
      note.textContent = bad.length > 0 ? "Links must start with https:// — empty is fine." : "";
      note.className = bad.length > 0 ? "field-note error-text" : "field-note muted";
      refreshMetadataURI();
    });
  }
  const metaField = $("#create-metadata") as HTMLInputElement;
  metaField.addEventListener("input", () => {
    const v = metaField.value.trim();
    metadataUserSet = v !== "" && v !== lastAutoMetadata;
    refreshMetadataURI();
  });
  // Image drop zone: click opens the picker, drag-and-drop works, keyboard works.
  const dz = $("#create-dropzone");
  const fileInput = $("#create-image-file") as HTMLInputElement;
  dz.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#dropzone-remove")) return;
    fileInput.click();
  });
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("drag");
    handleCreateImageFile(e.dataTransfer?.files?.[0]);
  });
  fileInput.addEventListener("change", () => {
    handleCreateImageFile(fileInput.files?.[0]);
    fileInput.value = "";
  });
  $("#dropzone-remove").addEventListener("click", (e) => { e.stopPropagation(); clearCreateImage(); });
  // Explicit upload action: retry after a failed auto-upload, or upload a
  // local file that was picked before this code deployed.
  $("#create-image-upload").addEventListener("click", (e) => {
    e.stopPropagation();
    if (createImageFile && !createLinkUrl) void autoUploadCreateImage(createImageFile);
  });
  $("#create-paste-link-toggle").addEventListener("click", () => {
    const wrap = $("#create-link-wrap");
    wrap.classList.toggle("hidden");
    if (!wrap.classList.contains("hidden")) ($("#create-image-link") as HTMLInputElement).focus();
  });
  ($("#create-image-link") as HTMLInputElement).addEventListener("input", () => {
    const v = ($("#create-image-link") as HTMLInputElement).value.trim();
    const note = $("#create-image-note");
    if (!v) {
      createLinkUrl = "";
      refreshCreateImage();
      refreshMetadataURI();
      return;
    }
    if (!validPublicImageLink(v)) {
      note.textContent = "That link must start with https:// or ipfs://.";
      note.className = "field-note error-text";
      return;
    }
    createLinkUrl = v;
    refreshCreateImage();
    refreshMetadataURI();
  });
  // Review modal close paths: X, Cancel, backdrop click. (Escape + focus
  // trap live in openReviewModal's keydown handler.)
  const reviewOverlay = $("#launch-review-modal");
  reviewOverlay.addEventListener("click", (e) => {
    if (e.target === reviewOverlay) closeReviewModal();
  });
  $("#launch-review-x").addEventListener("click", () => closeReviewModal());
  $("#launch-review-cancel").addEventListener("click", () => closeReviewModal());
  refreshCreatePreview();
}

/* ------------------------------------------------------------------------- */
/* Shared review modal: the "Review before signing" step for EVERY signing  */
/* flow — Create, curve Trade, pool Trade, and the standalone Swap page.    */
/* One modal, one pattern: the Sign action lives only in the dialog, never  */
/* inline on the page. Closes on Escape / backdrop click / Cancel / X;      */
/* focus moves in on open, is trapped while open, and returns on close.     */
/* While a sign is in flight the modal locks so the result can't be lost.   */
/* ------------------------------------------------------------------------- */

let reviewReturnFocus: HTMLElement | null = null;
let reviewKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let reviewBusy = false;
/** Fired when the modal closes (Cancel / X / Escape / backdrop) — lets a
 * caller discard a prepared plan. Not fired when the modal was never open. */
let reviewOnClose: (() => void) | null = null;

interface ReviewModalParts {
  body: HTMLElement;
  warnBox: HTMLElement;
  statusBox: HTMLElement;
  signBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  xBtn: HTMLButtonElement;
}

/**
 * Open the shared review modal. Clears the body/warn/status boxes and the
 * sign button state, focuses Sign, and installs the Escape + Tab-trap
 * handler. Callers fill the body (review rows) and wire signBtn.onclick.
 */
function openReviewModal(opts: { signLabel: string; onClose?: () => void }): ReviewModalParts {
  const overlay = $("#launch-review-modal");
  reviewReturnFocus = document.activeElement as HTMLElement | null;
  reviewOnClose = opts.onClose ?? null;
  overlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  const body = $("#launch-review-body");
  const warnBox = $("#launch-review-warn");
  const statusBox = $("#launch-review-status");
  body.innerHTML = "";
  warnBox.innerHTML = "";
  statusBox.innerHTML = "";
  const signBtn = $("#launch-review-sign") as HTMLButtonElement;
  const cancelBtn = $("#launch-review-cancel") as HTMLButtonElement;
  const xBtn = $("#launch-review-x") as HTMLButtonElement;
  signBtn.disabled = false;
  signBtn.textContent = opts.signLabel;
  signBtn.classList.remove("hidden");
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Cancel";
  xBtn.disabled = false;
  signBtn.focus();
  reviewKeyHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); closeReviewModal(); return; }
    if (e.key !== "Tab") return;
    const dlg = $("#launch-review-modal .modal") as HTMLElement;
    const items = [...dlg.querySelectorAll<HTMLElement>("button, summary, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")]
      .filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener("keydown", reviewKeyHandler);
  return { body, warnBox, statusBox, signBtn, cancelBtn, xBtn };
}

function closeReviewModal(): void {
  const overlay = $("#launch-review-modal");
  if (overlay.classList.contains("hidden")) return;
  // While a sign is in flight the outcome lives in this dialog — do not let
  // the user dismiss it mid-flight and lose the result.
  if (reviewBusy) return;
  overlay.classList.add("hidden");
  document.body.style.overflow = "";
  if (reviewKeyHandler) {
    document.removeEventListener("keydown", reviewKeyHandler);
    reviewKeyHandler = null;
  }
  if (reviewReturnFocus && document.contains(reviewReturnFocus)) {
    reviewReturnFocus.focus();
  }
  const cb = reviewOnClose;
  reviewOnClose = null;
  if (cb) cb();
}

/** Sign started: lock the dialog (no dismiss) and show the waiting state. */
function reviewBeginSign(): void {
  reviewBusy = true;
  const signBtn = $("#launch-review-sign") as HTMLButtonElement;
  const cancelBtn = $("#launch-review-cancel") as HTMLButtonElement;
  const xBtn = $("#launch-review-x") as HTMLButtonElement;
  signBtn.disabled = true;
  cancelBtn.disabled = true;
  xBtn.disabled = true;
  signBtn.textContent = "Waiting for wallet…";
}

/** Sign succeeded: hide Sign, turn Cancel into Close, focus it. */
function reviewFinish(): void {
  reviewBusy = false;
  const signBtn = $("#launch-review-sign") as HTMLButtonElement;
  const cancelBtn = $("#launch-review-cancel") as HTMLButtonElement;
  signBtn.classList.add("hidden");
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Close";
  cancelBtn.focus();
}

/** Sign failed: unlock the dialog and restore the Sign button label. */
function reviewResetSign(signLabel: string): void {
  reviewBusy = false;
  const signBtn = $("#launch-review-sign") as HTMLButtonElement;
  const cancelBtn = $("#launch-review-cancel") as HTMLButtonElement;
  const xBtn = $("#launch-review-x") as HTMLButtonElement;
  signBtn.disabled = false;
  signBtn.textContent = signLabel;
  cancelBtn.disabled = false;
  xBtn.disabled = false;
}

/** One review row (label + value), the same shape in every signing modal. */
function reviewRow(k: string, v: string | HTMLElement): HTMLElement {
  const row = el("div", "row");
  row.appendChild(el("span", "k", k));
  if (typeof v === "string") row.appendChild(el("span", "v", v));
  else row.appendChild(v);
  return row;
}

/** Short address + Copy button for a "To" review row. */
function reviewAddrValue(address: string): HTMLElement {
  const wrap = el("span", "uri-wrap");
  const line = el("div", "uri-line");
  line.appendChild(el("span", "uri-text", shortAddr(address)));
  const copy = el("button", "btn copy-btn", "Copy") as HTMLButtonElement;
  copy.type = "button";
  copy.onclick = () => void copyText(address, copy);
  line.appendChild(copy);
  wrap.appendChild(line);
  return wrap;
}

/** Truncate a long URI for display: start…end. */
function truncateUri(uri: string): string {
  if (uri.length <= 40) return uri;
  return `${uri.slice(0, 24)}…${uri.slice(-12)}`;
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  const done = () => {
    const old = btn.textContent;
    btn.textContent = "Copied ✓";
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1500);
  };
  try {
    await navigator.clipboard.writeText(text);
    done();
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    } catch {
      btn.textContent = "Copy failed";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    }
  }
}

/**
 * Readable metadata-URI widget: never dump a long base64 data URI as plain
 * text. Auto-built data: URIs show a byte count + Copy + a collapsible full
 * text; hosted URIs show truncated with Copy.
 */
function metadataUriWidget(uri: string): HTMLElement {
  const wrap = el("div", "uri-wrap");
  if (!uri) { wrap.textContent = "(empty)"; return wrap; }
  const copy = el("button", "btn copy-btn", "Copy") as HTMLButtonElement;
  copy.type = "button";
  copy.onclick = () => void copyText(uri, copy);
  if (uri.startsWith("data:")) {
    const line = el("div", "uri-line");
    line.appendChild(el("span", "uri-label", `Auto-built metadata (${utf8Bytes(uri)} bytes)`));
    line.appendChild(copy);
    wrap.appendChild(line);
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Show full metadata URI";
    const pre = document.createElement("pre");
    pre.className = "uri-full";
    pre.textContent = uri;
    det.append(sum, pre);
    wrap.appendChild(det);
    return wrap;
  }
  const line = el("div", "uri-line");
  const txt = el("span", "uri-text", truncateUri(uri));
  txt.title = uri;
  line.append(txt, copy);
  wrap.appendChild(line);
  return wrap;
}

async function handleCreate(): Promise<void> {
  const resultBox = $("#create-result");
  resultBox.innerHTML = "";
  if (!state.account) { resultBox.appendChild(el("div", "error", "Connect a wallet first.")); return; }
  const account = state.account;
  const c = selectedConfig();
  if (!c) { resultBox.appendChild(el("div", "error", "Pick a config first.")); return; }
  const name = ($("#create-name") as HTMLInputElement).value.trim();
  const symbol = ($("#create-symbol") as HTMLInputElement).value.trim().toUpperCase();
  const metadataURI = ($("#create-metadata") as HTMLInputElement).value.trim();
  if (!name || !symbol) { resultBox.appendChild(el("div", "error", "Token name and symbol are required.")); return; }
  if (!/^[A-Z0-9]{1,10}$/.test(symbol)) { resultBox.appendChild(el("div", "error", "Symbol must be 1–10 letters/digits.")); return; }
  if (utf8Bytes(name) > CREATE_NAME_MAX_BYTES) { resultBox.appendChild(el("div", "error", `Token name must be at most ${CREATE_NAME_MAX_BYTES} bytes.`)); return; }
  if (utf8Bytes(metadataURI) > MAX_METADATA_URI_BYTES) { resultBox.appendChild(el("div", "error", `Metadata URI is too long (${utf8Bytes(metadataURI)}/${MAX_METADATA_URI_BYTES} bytes) — shorten the description or paste a hosted metadata URI.`)); return; }
  for (const [id, label] of [["create-link-web", "Website"], ["create-link-x", "X"], ["create-link-tg", "Telegram"]] as const) {
    const v = ($(`#${id}`) as HTMLInputElement).value.trim();
    if (v && !v.startsWith("https://")) { resultBox.appendChild(el("div", "error", `${label} link must start with https://.`)); return; }
  }
  try {
    const preview = buildCreateLaunchTx(name, symbol, metadataURI, c.config.tokenDecimals, c.configId, c.config.poolCreationFee);
    // Fill the shared review modal (the Sign action lives only in the dialog).
    const m = openReviewModal({ signLabel: "Sign & create launch" });
    for (const [k, v] of [
      ["Token", `${name} (${symbol}), ${c.config.tokenDecimals} decimals`],
      ["Config", `#${c.configId.toString()} — hash ${shortAddr(c.configHash)}`],
      ["Factory", shortAddr(preview.factory)],
      ["Pool creation fee (msg.value)", `${fmtAmount(preview.poolCreationFee, 18)} ETH`],
    ] as const) {
      m.body.appendChild(reviewRow(k, v));
    }
    const uriRow = el("div", "row");
    uriRow.appendChild(el("span", "k", "Metadata URI"));
    uriRow.appendChild(metadataUriWidget(metadataURI));
    m.body.appendChild(uriRow);
    // Local-image warning, also inside the modal before Sign.
    if (createFile && !createLinkUrl) {
      // Honesty rule: a locally picked file has no public URL and cannot go
      // on-chain. Say so BEFORE the user confirms — never silently drop it.
      const w = el("div", "warn", "The image you picked only lives in this browser — it has no public URL, so this launch will NOT include it in the token metadata. Paste a public image link to include it, or launch without an image.");
      const fixBtn = el("button", "btn text", "Paste a public image link") as HTMLButtonElement;
      fixBtn.onclick = () => {
        closeReviewModal();
        $("#create-link-wrap").classList.remove("hidden");
        ($("#create-image-link") as HTMLInputElement).focus();
      };
      w.appendChild(fixBtn);
      m.warnBox.appendChild(w);
    }
    m.signBtn.onclick = async () => {
      try {
        reviewBeginSign();
        m.statusBox.appendChild(el("div", "muted", "Sending createLaunch — confirm in your wallet…"));
        const hash = await sendTx(preview.transaction);
        m.statusBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting for confirmation…`));
        const created = await waitForLaunchCreated(hash, c.configId, c.configHash);
        // Show the new launch immediately — do NOT wait for the bulk scan
        // to reach its block before it becomes visible.
        insertOptimisticLaunch({
          token: created.token,
          curve: created.curve,
          creator: account,
          configId: created.configId,
          configHash: created.configHash,
          protocolVersion: created.protocolVersion,
          metadataURI: created.metadataURI,
          blockNumber: created.blockNumber,
          txHash: hash,
          name,
          symbol,
          decimals: c.config.tokenDecimals,
          totalSupply: c.config.totalSupply,
        });
        m.statusBox.appendChild(el("div", "ok", `Launch created! Token ${shortAddr(created.token)} · Curve ${shortAddr(created.curve)}`));
        const openBtn = el("button", "btn", "Open launch") as HTMLButtonElement;
        openBtn.onclick = () => {
          // Navigate straight to the detail view from the known addresses —
          // the old code awaited the full ~25-min scan first, so the button
          // appeared to do nothing.
          state.detailCurve = created.curve;
          showView("detail");
          void renderDetail(created.curve);
        };
        m.statusBox.appendChild(openBtn);
        reviewFinish();
      } catch (err) {
        reviewResetSign("Sign & create launch");
        showError(m.statusBox, err);
      }
    };
  } catch (err) {
    showError(resultBox, err);
  }
}

// ---------------------------------------------------------------------------
// Views / boot
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Theme (light/dark) + deep links
// ---------------------------------------------------------------------------

function showView(name: "discover" | "create" | "detail" | "profile" | "swap"): void {
  // A view change dismisses the review modal (e.g. "Open launch" after a
  // successful create) — its result lives in the new view, not behind it.
  closeReviewModal();
  state.view = name;
  for (const v of ["discover", "create", "detail", "profile", "swap"] as const) {
    $("#view-" + v).classList.toggle("hidden", v !== name);
  }
  // Discover, Create Launch, and Swap live in the nav; Profile is reached
  // from the wallet dropdown, and Detail never has an active tab. The mobile
  // hamburger items mirror the desktop tabs' active state.
  for (const t of ["discover", "create", "swap"] as const) {
    $(`#tab-${t}`).classList.toggle("active", t === name);
    $(`#mnav-${t}`).classList.toggle("active", t === name);
  }
  // "Recently viewed" is a discovery aid — it does not belong on Profile or Swap.
  if (name === "profile" || name === "swap") {
    $("#recent-row").classList.add("hidden");
  } else {
    renderRecent();
  }
  if (name === "create") refreshCreatePreview();
}

async function verifyChainStatus(): Promise<void> {
  const statusEl = $("#chain-status");
  statusEl.innerHTML = "";
  statusEl.textContent = "Memuat data chain…";
  try {
    const v = await verifyCore();
    state.verifiedBlock = v.blockNumber;
    statusEl.innerHTML = "";
    statusEl.appendChild(el("span", "ok-text", `Core verified at block ${v.blockNumber.toString()}`));
    statusEl.appendChild(el("span", "muted", " · Factory "));
    statusEl.appendChild(explorerLink(v.factory));
    statusEl.appendChild(el("span", "muted", " · Registry "));
    statusEl.appendChild(explorerLink(v.registry));
  } catch (err) {
    // A failed verify must not blank the UI or block anything else:
    // configs and the launch list load independently. Short message plus a
    // retry — never a raw viem dump.
    statusEl.innerHTML = "";
    statusEl.appendChild(el("span", "err-text", friendlyErrorMessage(err)));
    const retry = el("button", "btn", "↻ Retry") as HTMLButtonElement;
    retry.onclick = () => void verifyChainStatus();
    statusEl.appendChild(retry);
  }
}

/** Delay before verifying the chain on a deep-linked detail (ms) — long enough for the detail's own reads to go first. */
const DETAIL_VERIFY_DELAY_MS = 5000;

let backgroundStarted = false;
/**
 * Heavy background jobs (launch enrichment, config preload, core verify,
 * flight-log polling, bulk scan). Started once — at boot, or when the user
 * returns to Discover after opening a deep-linked detail view. A shared
 * detail link must load in seconds, not queue behind ~200 background calls
 * on the rate-limited client (the chart used to take 60–90 s).
 */
function ensureBackgroundStarted(): void {
  if (backgroundStarted) return;
  backgroundStarted = true;
  void pollFlightLog();
  setInterval(() => void pollFlightLog(), FLIGHT_LOG_POLL_MS);
  void enrichLaunches();
  void loadConfigsForForm();
  void verifyChainStatus();
  void refreshLaunches();
}

async function boot(): Promise<void> {
  // Uniswap-style background blobs (all pages — body.bg-blobs is set once
  // here and never toggled). Decorative layer, created once, never
  // intercepts clicks.
  const blobs = document.createElement("div");
  blobs.id = "bg-blobs";
  for (const c of ["blob-green", "blob-purple", "blob-blue", "blob-rose"]) {
    blobs.appendChild(el("div", `blob ${c}`));
  }
  document.body.prepend(blobs);
  document.body.classList.add("bg-blobs");
  renderWallet();
  showView("discover");
  initTheme();
  const themeBtn = $("#theme-toggle") as HTMLButtonElement;
  themeBtn.onclick = () => toggleTheme();

  $("#tab-discover").onclick = () => { try { history.replaceState(null, "", "#discover"); } catch { /* non-fatal */ } showView("discover"); renderDiscover(); ensureBackgroundStarted(); };
  $("#tab-create").onclick = () => { try { history.replaceState(null, "", "#create"); } catch { /* non-fatal */ } showView("create"); void loadConfigsForForm(); };
  $("#tab-swap").onclick = () => { try { history.replaceState(null, "", "#swap"); } catch { /* non-fatal */ } showView("swap"); renderSwap(); ensureBackgroundStarted(); };
  // Mobile hamburger nav: the same Discover / Create Launch actions as the
  // desktop tabs (which are hidden on mobile), plus the Faucet link. An item
  // tap navigates and closes the menu.
  const navToggle = $("#nav-toggle") as HTMLButtonElement;
  navToggle.onclick = () => {
    const nav = $("#mobile-nav");
    if (nav.classList.contains("hidden")) openMobileNav();
    else closeMobileNav();
  };
  $("#mnav-discover").onclick = () => { closeMobileNav(); $("#tab-discover").click(); };
  $("#mnav-create").onclick = () => { closeMobileNav(); $("#tab-create").click(); };
  $("#mnav-swap").onclick = () => { closeMobileNav(); $("#tab-swap").click(); };
  $("#mnav-faucet").onclick = () => closeMobileNav();
  // Mobile nav: close on outside click.
  document.addEventListener("click", (e) => {
    const nav = document.querySelector("#mobile-nav");
    if (!nav || nav.classList.contains("hidden")) return;
    const target = e.target as Node;
    if (navToggle.contains(target)) return;
    if (nav.contains(target)) return;
    closeMobileNav();
  });
  // Token selector dropdown on the Swap page: close on outside click.
  // Clicks on either pill toggle the menu themselves, so they are not
  // "outside" — without this the document handler would close the menu
  // right before the pill's toggle re-opens it.
  document.addEventListener("click", (e) => {
    const menu = document.querySelector(".swap-menu:not(.hidden)");
    if (!menu) return;
    const target = e.target as Element;
    if (target.closest?.(".swap-selector, .swap-token-btn, .uni-pill")) return;
    closeSwapMenu();
  });
  // Wallet dropdown: close on outside click / Escape; arrow keys move between
  // the menu items. Registered once at boot; the menu itself is rendered by
  // renderWallet() whenever the account state changes.
  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".wallet-menu-wrap");
    if (!wrap) return;
    if (wrap.contains(e.target as Node)) return;
    closeWalletMenu();
  });
  // Wallet dropdown + mobile nav + Swap token menu: close on Escape; arrow
  // keys move between the open menu's items. Only one menu can be open at a time.
  document.addEventListener("keydown", (e) => {
    const walletMenu = document.querySelector<HTMLElement>(".wallet-menu:not(.hidden)");
    const mobileNav = document.querySelector<HTMLElement>("#mobile-nav:not(.hidden)");
    const swapMenu = document.querySelector<HTMLElement>(".swap-menu:not(.hidden)");
    if (e.key === "Escape") {
      if (walletMenu) {
        closeWalletMenu();
        document.querySelector<HTMLButtonElement>(".wallet-btn")?.focus();
      }
      if (mobileNav) {
        closeMobileNav();
        (document.querySelector("#nav-toggle") as HTMLButtonElement | null)?.focus();
      }
      if (swapMenu) {
        closeSwapMenu();
        document.querySelector<HTMLButtonElement>(".swap-token-btn")?.focus();
      }
      return;
    }
    const menu = walletMenu ?? mobileNav ?? swapMenu;
    if (!menu) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...menu.querySelectorAll<HTMLElement>(".wallet-menu-item, .swap-token-row")];
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  });
  $("#refresh-btn").onclick = () => void refreshLaunches();
  // Header search: filters the Missions table live; Enter opens the first match.
  const headerSearch = $("#header-search") as HTMLInputElement;
  headerSearch.oninput = () => { state.search = headerSearch.value; renderDiscover(); };
  headerSearch.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = filteredLaunches()[0];
      if (first) openDetail(first);
    }
  });
  // "/" focuses the header search (unless already typing in a field, or the
  // review modal is open — focus stays trapped in the dialog then).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/") return;
    if (!$("#launch-review-modal").classList.contains("hidden")) return;
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
    e.preventDefault();
    headerSearch.focus();
  });
  for (const t of ["trending", "new", "near", "graduated"] as const) {
    $(`#mtab-${t}`).onclick = () => {
      state.missionsTab = t;
      for (const g of ["trending", "new", "near", "graduated"] as const) {
        $(`#mtab-${g}`).classList.toggle("active", g === t);
      }
      renderDiscover();
    };
  }
  $("#mine-toggle").onclick = () => {
    state.mineOnly = !state.mineOnly;
    $("#mine-toggle").classList.toggle("active", state.mineOnly);
    renderDiscover();
  };
  $("#create-submit").onclick = () => void handleCreate();
  initCreateForm();

  // Restore cached launches FIRST so the list paints instantly, before any
  // network call (verifyCore takes tens of seconds on the public RPC).
  // On a cold load the shipped seed.json is the starting cache, so
  // Discover paints from the seed immediately and the bulk scan only has
  // to cover the small delta from the seed's scannedTo to head.
  const cache = await loadSeededLaunchCache();
  state.launches = cache.launches;
  state.scanStatus = cache.launches.length > 0 ? `restored ${cache.launches.length} cached launches` : "idle";
  renderDiscover();
  // Recently viewed needs the launches in state to resolve curves to chips
  // — render it after the cache restore, not before (it used to run above
  // and hide the row on every fresh load until the next detail visit).
  renderRecent();
  void seedChainHead();

  // Deep link: #detail/<curve> opens a launch directly (shareable links).
  const openHashDetail = async (): Promise<void> => {
    // Tolerate "#/detail/…" as well as "#detail/…" — the "#/" hash-router
    // form shows up in shared links, and the old code silently ignored it.
    const h = location.hash.replace(/^#\/?/, "");
    if (!h.startsWith("detail/")) return;
    const curve = h.slice("detail/".length);
    let launch = state.launches.find((x) => x.curve.toLowerCase() === curve.toLowerCase());
    if (!launch) {
      // Not in the cache (fresh browser): one bulk scan on the separate
      // scan client finds it without touching the interactive client.
      await refreshLaunches();
      launch = state.launches.find((x) => x.curve.toLowerCase() === curve.toLowerCase());
    }
    if (launch) {
      state.detailCurve = launch.curve;
      showView("detail");
      void renderDetail(launch.curve);
    }
  };
  // Deep link: #swap/<token-or-curve> opens Swap with that token preselected.
  const openHashSwap = async (): Promise<void> => {
    const h = location.hash.replace(/^#\/?/, "");
    if (!h.startsWith("swap")) return;
    let target: string | null = null;
    if (h.startsWith("swap/")) target = h.slice("swap/".length);
    let launch: EnrichedLaunch | undefined;
    if (target) {
      launch = state.launches.find((x) => x.token.toLowerCase() === target!.toLowerCase() || x.curve.toLowerCase() === target!.toLowerCase());
      if (!launch) {
        // Not in the cache (fresh browser): one bulk scan on the separate
        // scan client finds it without touching the interactive client.
        await refreshLaunches();
        launch = state.launches.find((x) => x.token.toLowerCase() === target!.toLowerCase() || x.curve.toLowerCase() === target!.toLowerCase());
      }
    }
    state.swapCurve = launch ? launch.curve : null;
    showView("swap");
    renderSwap();
  };
  window.addEventListener("hashchange", () => {
    const h = location.hash.replace(/^#\/?/, "");
    if (h.startsWith("detail/")) void openHashDetail();
    else if (h === "swap" || h.startsWith("swap/")) void openHashSwap();
  });

  // Deep links: #discover (default), #create, #profile, #detail/<curve>.
  // A leading "/" after "#" is tolerated ("#/detail/…" shared links).
  const hash = location.hash.replace(/^#\/?/, "");
  if (hash === "create") { showView("create"); void loadConfigsForForm(); ensureBackgroundStarted(); }
  else if (hash === "profile") { showView("profile"); void renderProfile(); ensureBackgroundStarted(); }
  else if (hash === "swap" || hash.startsWith("swap/")) { await openHashSwap(); ensureBackgroundStarted(); }
  else if (hash.startsWith("detail/")) {
    // Deep link: open the detail FIRST. The heavy background jobs share
    // the rate-limited client and used to queue the detail's own reads
    // behind ~200 calls, so the chart took 60–90 s. They start when the
    // user returns to Discover instead.
    await openHashDetail();
    if (state.view !== "detail") {
      ensureBackgroundStarted();
    } else {
      // The footer status would otherwise stay on "Connecting…" forever
      // on a deep link (verify only runs with the background jobs). Run it
      // once the detail's own reads are already in flight.
      setTimeout(() => void verifyChainStatus(), DETAIL_VERIFY_DELAY_MS);
    }
  } else {
    ensureBackgroundStarted();
  }
}

document.addEventListener("DOMContentLoaded", () => void boot());
