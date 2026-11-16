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

function fmtAmount(raw: bigint, decimals: number, maxDp = 6): string {
  const s = formatUnits(raw, decimals);
  const [i, f = ""] = s.split(".");
  return f ? `${i}.${f.slice(0, maxDp)}` : i;
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

/** Compact ETH number: 698K, 2.19K, 27.48, 0.795. */
function fmtEthCompact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(2).replace(/\.?0+$/, "")}K`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  if (v > 0 && v < 0.001) return v.toExponential(1);
  return v.toFixed(3).replace(/\.?0+$/, "");
}

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
  slippageBps: 100,
  view: "discover" as "discover" | "create" | "detail" | "profile",
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
    const chip = el("button", "btn chip recent-chip", `$${l.meta?.symbol ?? shortAddr(l.token)}`) as HTMLButtonElement;
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

function renderWallet(): void {
  const box = $("#wallet-status");
  box.innerHTML = "";
  if (!state.account) {
    const b = el("button", "btn primary", "Connect wallet") as HTMLButtonElement;
    b.onclick = () => void connectWallet();
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

/** Market cap in WETH: current price × total supply. Null until price/supply are known. */
function launchMcap(l: EnrichedLaunch): number | null {
  if (!l.meta || !l.price) return null;
  const price = Number.parseFloat(l.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const supply = Number(l.meta.totalSupply) / 10 ** l.meta.decimals;
  if (!Number.isFinite(supply) || supply <= 0) return null;
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
    mcapRow.appendChild(el("span", "v", `${fmtEthCompact(mcap)} ETH`));
    card.appendChild(mcapRow);
    const poolRow = el("div", "row");
    poolRow.appendChild(el("span", "k", "Pool"));
    poolRow.appendChild(el("span", "v", l.curveData ? `${fmtEthCompact(Number(formatUnits(l.curveData.state.quoteReserve, 18)))} ETH` : "…"));
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
    tr.appendChild(el("td", "", mcap === null ? "…" : `${fmtEthCompact(mcap)} ETH`));
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
    tr.appendChild(el("td", "", s ? fmtEthCompact(s.volumeWeth) : dayStatsLanded ? "0" : "…"));
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
      : `${fmtEthCompact(e.amountWeth)} ETH`));
    row.appendChild(el("span", "muted flight-age", e.timeMs === null ? "—" : formatAge(e.timeMs, nowMs)));
    list.appendChild(row);
  }
  box.appendChild(list);
}

function renderDiscover(): void {
  const count = state.launches.length;
  $("#launch-count").textContent =
    `${filteredLaunches().length} of ${count} launches · ${state.scanStatus}`;
  renderHero();
  renderTopCards();
  renderMissionsTable();
  renderFlightLog();
}

/** Compact launch card (Profile "Launch saya" grid). */
function launchCard(l: EnrichedLaunch): HTMLElement {
  const card = el("div", "card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.onclick = () => openDetail(l);
  card.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(l); }
  };
  const head = el("div", "card-head");
  head.appendChild(el("div", "card-title", l.meta ? `${l.meta.name} (${l.meta.symbol})` : shortAddr(l.token)));
  head.appendChild(el("span", `badge status-${l.curveData?.state.status ?? -1}`, l.curveData ? curveStatusLabel(l.curveData.state.status) : "Loading…"));
  card.appendChild(head);
  const rows: Array<[string, string]> = [
    ["Token", shortAddr(l.token)],
    ["Curve", shortAddr(l.curve)],
    ["Creator", shortAddr(l.creator)],
    ["Config", `#${l.configId.toString()}`],
  ];
  if (l.curveData && l.meta) {
    rows.push(["Price", `${l.price ?? "…"} WETH / ${l.meta.symbol}`]);
    rows.push(["Raised", `${fmtAmount(l.curveData.state.quoteReserve, 18)} WETH`]);
    rows.push(["Graduation", `${(l.curveData.progress.progressBps / 100).toFixed(1)}%`]);
  } else if (l.loadError) {
    rows.push(["Note", `Could not load curve state: ${l.loadError}`]);
  }
  for (const [k, v] of rows) {
    const r = el("div", "row");
    r.appendChild(el("span", "k", k));
    r.appendChild(el("span", "v", v));
    card.appendChild(r);
  }
  if (l.curveData) {
    const bar = el("div", "bar");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.min(100, l.curveData.progress.progressBps / 100)}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
  }
  return card;
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
  const grid = el("div", "grid");
  launchSec.appendChild(grid);
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
  grid.innerHTML = "";
  if (mine.length === 0) {
    grid.appendChild(el("div", "empty", "Belum ada launch."));
  }
  for (const l of mine) {
    grid.appendChild(launchCard(l));
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

function tradePanel(l: EnrichedLaunch): HTMLElement {
  const wrap = el("div", "panel");
  wrap.appendChild(el("h3", "", "Trade"));
  if (!l.curveData || !l.meta) {
    wrap.appendChild(el("div", "muted", "Curve state is still loading."));
    return wrap;
  }
  const status = l.curveData.state.status;
  const quoteSymbol = "WETH";
  const baseSymbol = l.meta.symbol;

  if (status === 1) {
    const dirRow = el("div", "seg");
    const buyBtn = el("button", "btn seg-btn active", "Buy") as HTMLButtonElement;
    const sellBtn = el("button", "btn seg-btn", "Sell") as HTMLButtonElement;
    dirRow.append(buyBtn, sellBtn);
    wrap.appendChild(dirRow);
    let direction: "buy" | "sell" = "buy";
    // Token balance (sell side) loads lazily; WETH balance is cached in state.
    let tokenBalance: bigint | null = null;
    const amountLabel = el("label", "", `Amount (${quoteSymbol})`);
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
    buyBtn.onclick = () => { direction = "buy"; buyBtn.classList.add("active"); sellBtn.classList.remove("active"); amountLabel.textContent = `Amount (${quoteSymbol})`; void refreshBalRow(); updateQuote(); };
    sellBtn.onclick = () => { direction = "sell"; sellBtn.classList.add("active"); buyBtn.classList.remove("active"); amountLabel.textContent = `Amount (${baseSymbol})`; void refreshBalRow(); updateQuote(); };
    void refreshBalRow();

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
      updateQuote();
    };

    const quoteBox = el("div", "quote-box muted", "Enter an amount to see a live quote.");
    const execBtn = el("button", "btn primary", "Get quote") as HTMLButtonElement;
    const resultBox = el("div", "result");

    let lastPlan: Awaited<ReturnType<typeof planCurveSwap>> | null = null;
    let lastAmountIn = 0n;

    async function updateQuote(): Promise<void> {
      lastPlan = null;
      execBtn.textContent = "Get quote";
      const raw = amountInput.value.trim();
      if (!raw || Number(raw) <= 0) {
        quoteBox.textContent = "Enter an amount to see a live quote.";
        return;
      }
      try {
        const decimals = direction === "buy" ? 18 : l.meta!.decimals;
        const amountIn = parseUnits(raw, decimals);
        lastAmountIn = amountIn;
        const q = await quoteCurve(l.curve!, amountIn, direction === "sell");
        const outDec = direction === "buy" ? l.meta!.decimals : 18;
        const outSym = direction === "buy" ? baseSymbol : quoteSymbol;
        quoteBox.innerHTML = "";
        quoteBox.appendChild(el("div", "", `Expected out: ${fmtAmount(q.amountOut, outDec)} ${outSym}`));
        quoteBox.appendChild(el("div", "", `Fee: ${fmtAmount(q.fee, direction === "buy" ? 18 : l.meta!.decimals)} ${direction === "buy" ? quoteSymbol : baseSymbol}`));
        quoteBox.appendChild(el("div", "", `Fill: ${esc(q.fillKind)}${q.amountLeft > 0n ? ` · unfilled ${fmtAmount(q.amountLeft, decimals)}` : ""}`));
        execBtn.textContent = "Preview & execute";
      } catch (err) {
        quoteBox.textContent = `Quote failed: ${friendlyErrorMessage(err)}`;
      }
    }
    amountInput.oninput = () => void updateQuote();

    execBtn.onclick = async () => {
      resultBox.innerHTML = "";
      if (!state.account) { resultBox.appendChild(el("div", "error", "Connect a wallet first.")); return; }
      try {
        if (!lastPlan) {
          if (lastAmountIn === 0n) { resultBox.appendChild(el("div", "error", "Enter an amount and wait for the quote first.")); return; }
          execBtn.disabled = true;
          execBtn.textContent = "Building plan…";
          const isBuy = direction === "buy";
          const inToken = isBuy ? WETH : l.token;
          const needed = lastAmountIn;
          const bal = isBuy ? state.wethBalance : await getTokenBalance(l.token, state.account);
          if (bal < needed) {
            if (isBuy) {
              resultBox.innerHTML = "";
              const short = needed - bal;
              resultBox.appendChild(el("div", "warn", `Your WETH balance (${fmtAmount(bal, 18)}) is short by ${fmtAmount(short, 18)} WETH. Wrap ETH first:`));
              const wrapBtn = el("button", "btn", `Wrap ${fmtAmount(short, 18, 4)} ETH → WETH`) as HTMLButtonElement;
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
            return;
          }
          lastPlan = await planCurveSwap(l.curve!, lastAmountIn, direction === "sell", state.slippageBps, state.account);
          const p = lastPlan;
          const outDec = direction === "buy" ? l.meta!.decimals : 18;
          const outSym = direction === "buy" ? baseSymbol : quoteSymbol;
          const prev = el("div", "preview");
          prev.appendChild(el("div", "", "Review before signing in your wallet:"));
          prev.appendChild(el("div", "", `You pay: ${fmtAmount(lastAmountIn, direction === "buy" ? 18 : l.meta!.decimals)} ${direction === "buy" ? quoteSymbol : baseSymbol}`));
          prev.appendChild(el("div", "", `You receive (min): ${fmtAmount(p.quote.minimumAmountOut, outDec)} ${outSym}`));
          prev.appendChild(el("div", "", `Fee: ${fmtAmount(p.quote.fee, direction === "buy" ? 18 : l.meta!.decimals)}`));
          prev.appendChild(el("div", "", `Fill: ${esc(p.quote.fillKind)}`));
          prev.appendChild(el("div", "", `To (curve): ${shortAddr(l.curve!)}`));
          if (p.approvals.length > 0) {
            prev.appendChild(el("div", "", `Approvals needed: ${p.approvals.map((a) => `${shortAddr(a.token)} → ${shortAddr(a.spender)} (${fmtAmount(a.amount, direction === "buy" ? 18 : l.meta!.decimals)})`).join(", ")}`));
          }
          resultBox.appendChild(prev);
          execBtn.textContent = "Sign & execute in wallet";
          execBtn.disabled = false;
          return;
        }
        // Execute the prepared plan.
        execBtn.disabled = true;
        execBtn.textContent = "Executing…";
        const p = lastPlan;
        for (const ap of p.approvals) {
          const allowance = await getAllowance(ap.token, state.account, ap.spender);
          if (allowance < ap.amount) {
            resultBox.appendChild(el("div", "muted", `Approving ${shortAddr(ap.token)} for ${shortAddr(ap.spender)}…`));
            const ah = await sendTx(buildApproveTx(ap.token, ap.spender, ap.amount));
            await waitReceipt(ah);
          }
        }
        resultBox.appendChild(el("div", "muted", "Sending swap — confirm in your wallet…"));
        const hash = await sendTx(p.transaction);
        resultBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting for confirmation…`));
        const parsed = await waitForSwapReceipt(hash, l.curve!, state.account, state.account, direction === "sell", lastAmountIn, p.quote.minimumAmountOut);
        const outDec = direction === "buy" ? l.meta!.decimals : 18;
        const outSym = direction === "buy" ? baseSymbol : quoteSymbol;
        resultBox.appendChild(el("div", "ok", `Swap confirmed. Received ${fmtAmount(parsed.amountOut, outDec)} ${outSym}. Consumed ${fmtAmount(parsed.consumedAmountIn, direction === "buy" ? 18 : l.meta!.decimals)}.`));
        lastPlan = null;
        execBtn.textContent = "Get quote";
        execBtn.disabled = false;
        await refreshBalances();
        renderWallet();
        const fresh = await getCurveFull(l.curve);
        l.curveData = fresh;
        l.price = priceFromSqrtPrice(fresh.state.sqrtPrice, l.meta!.decimals, 18);
        renderDiscover();
        // The trade moved the price: drop the cached chart and rebuild just
        // the chart panel, so it shows the new point — without wiping the
        // "Swap confirmed" message and the trade form above.
        chartCache.delete(l.curve.toLowerCase());
        const oldChart = document.querySelector(".chart-panel");
        if (oldChart) oldChart.replaceWith(chartPanel(l));
      } catch (err) {
        showError(resultBox, err);
        execBtn.disabled = false;
        execBtn.textContent = "Get quote";
      }
    };

    wrap.append(amountLabel, amountInput, balRow, slipLabel, slipInput, quoteBox, execBtn, resultBox);
  } else if (status === 2) {
    wrap.appendChild(el("div", "warn", "This curve is ready to graduate. Graduation migrates liquidity to the pool and is permissionless."));
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

function poolTradePanel(l: EnrichedLaunch, pool: Address): HTMLElement {
  const wrap = el("div", "panel");
  wrap.appendChild(el("h4", "", "Pool trading"));
  const dirRow = el("div", "seg");
  const buyBtn = el("button", "btn seg-btn active", "Buy with ETH") as HTMLButtonElement;
  const sellBtn = el("button", "btn seg-btn", "Sell for WETH") as HTMLButtonElement;
  dirRow.append(buyBtn, sellBtn);
  wrap.appendChild(dirRow);
  let direction: "buy" | "sell" = "buy";
  const amountLabel = el("label", "", "Buy amount (ETH)");
  const amountInput = el("input") as HTMLInputElement;
  amountInput.type = "text";
  amountInput.inputMode = "decimal";
  amountInput.placeholder = "0.0";
  const balRow = el("div", "balance-row");
  balRow.appendChild(el("span", "muted", "Balance"));
  const balVal = el("span", "balance-val", "…");
  balRow.appendChild(balVal);
  let poolTokenBalance: bigint | null = null;
  const maxBtn = el("button", "btn text", "MAX") as HTMLButtonElement;
  maxBtn.onclick = () => {
    const bal = direction === "buy" ? state.ethBalance : poolTokenBalance;
    if (bal === null) return;
    amountInput.value = formatUnits(bal, direction === "buy" ? 18 : l.meta!.decimals);
    void updateQuote();
  };
  balRow.appendChild(maxBtn);
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
  void refreshPoolBalRow();
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
    updateQuote();
  };
  const quoteBox = el("div", "quote-box muted", "Enter an ETH amount to see a live pool quote.");
  const execBtn = el("button", "btn primary", "Get quote") as HTMLButtonElement;
  const resultBox = el("div", "result");
  let lastAmountIn = 0n;
  let lastMinOut = 0n;
  let lastPlan: Awaited<ReturnType<typeof planPoolSwap>> | null = null;

  buyBtn.onclick = () => {
    direction = "buy";
    buyBtn.classList.add("active");
    sellBtn.classList.remove("active");
    amountLabel.textContent = "Buy amount (ETH)";
    lastPlan = null;
    execBtn.textContent = "Get quote";
    void refreshPoolBalRow();
    void updateQuote();
  };
  sellBtn.onclick = () => {
    direction = "sell";
    sellBtn.classList.add("active");
    buyBtn.classList.remove("active");
    amountLabel.textContent = `Sell amount (${l.meta!.symbol})`;
    lastPlan = null;
    execBtn.textContent = "Get quote";
    void refreshPoolBalRow();
    void updateQuote();
  };

  async function updateQuote(): Promise<void> {
    lastPlan = null;
    execBtn.textContent = "Get quote";
    const raw = amountInput.value.trim();
    if (!raw || Number(raw) <= 0) {
      quoteBox.textContent = direction === "buy"
        ? "Enter an ETH amount to see a live pool quote."
        : "Enter a token amount to see a live pool quote.";
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
        const q = await quotePool(pool, WETH, amountIn);
        lastMinOut = minOut(q.amountOut, state.slippageBps);
        quoteBox.innerHTML = "";
        quoteBox.appendChild(el("div", "", `Expected out: ${fmtAmount(q.amountOut, outMeta.decimals)} ${outMeta.symbol}`));
        quoteBox.appendChild(el("div", "", `Minimum out (${(state.slippageBps / 100).toFixed(1)}% slippage): ${fmtAmount(lastMinOut, outMeta.decimals)} ${outMeta.symbol}`));
        execBtn.textContent = "Preview & execute";
      } else {
        const amountIn = parseUnits(raw, l.meta!.decimals);
        lastAmountIn = amountIn;
        const q = await quotePool(pool, l.token, amountIn);
        lastMinOut = minOut(q.amountOut, state.slippageBps);
        quoteBox.innerHTML = "";
        quoteBox.appendChild(el("div", "", `Expected out: ${fmtAmount(q.amountOut, 18)} WETH`));
        quoteBox.appendChild(el("div", "", `Minimum out (${(state.slippageBps / 100).toFixed(1)}% slippage): ${fmtAmount(lastMinOut, 18)} WETH`));
        execBtn.textContent = "Preview & execute";
      }
    } catch (err) {
      quoteBox.textContent = `Quote failed: ${friendlyErrorMessage(err)}`;
    }
  }
  amountInput.oninput = () => void updateQuote();

  execBtn.onclick = async () => {
    resultBox.innerHTML = "";
    if (!state.account) { resultBox.appendChild(el("div", "error", "Connect a wallet first.")); return; }
    if (lastAmountIn === 0n) { resultBox.appendChild(el("div", "error", "Enter an amount and wait for the quote first.")); return; }
    try {
      if (direction === "buy") {
        execBtn.disabled = true;
        execBtn.textContent = "Executing…";
        const tx = buildNativePoolBuy(pool, lastAmountIn, lastMinOut, state.account);
        resultBox.appendChild(el("div", "muted", `Buying with ${fmtAmount(lastAmountIn, 18)} ETH via the native router — confirm in your wallet…`));
        const hash = await sendTx(tx);
        resultBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting…`));
        await waitReceipt(hash);
        resultBox.appendChild(el("div", "ok", "Pool buy confirmed."));
        await refreshBalances();
        renderWallet();
        execBtn.disabled = false;
        execBtn.textContent = "Get quote";
        return;
      }
      // Sell: plan first (shows approvals), then execute.
      if (!lastPlan) {
        execBtn.disabled = true;
        execBtn.textContent = "Building plan…";
        const bal = await getTokenBalance(l.token, state.account);
        if (bal < lastAmountIn) {
          resultBox.appendChild(el("div", "error", `Your ${l.meta!.symbol} balance (${fmtAmount(bal, l.meta!.decimals)}) is less than the sell amount.`));
          execBtn.disabled = false;
          execBtn.textContent = "Get quote";
          return;
        }
        lastPlan = await planPoolSwap(pool, l.token, lastAmountIn, state.slippageBps, state.account);
        const p = lastPlan;
        const prev = el("div", "preview");
        prev.appendChild(el("div", "", "Review before signing in your wallet:"));
        prev.appendChild(el("div", "", `You pay: ${fmtAmount(lastAmountIn, l.meta!.decimals)} ${l.meta!.symbol}`));
        prev.appendChild(el("div", "", `You receive (min): ${fmtAmount(p.quote.minimumAmountOut, 18)} WETH`));
        if (p.approvals.length > 0) {
          prev.appendChild(el("div", "", `Approvals needed: ${p.approvals.map((a) => `${shortAddr(a.token)} → ${shortAddr(a.spender)}`).join(", ")}`));
        }
        resultBox.appendChild(prev);
        execBtn.textContent = "Sign & execute in wallet";
        execBtn.disabled = false;
        return;
      }
      execBtn.disabled = true;
      execBtn.textContent = "Executing…";
      const p = lastPlan;
      for (const ap of p.approvals) {
        const allowance = await getAllowance(ap.token, state.account, ap.spender);
        if (allowance < ap.amount) {
          resultBox.appendChild(el("div", "muted", `Approving ${shortAddr(ap.token)} for ${shortAddr(ap.spender)}…`));
          const ah = await sendTx(buildApproveTx(ap.token, ap.spender, ap.amount));
          await waitReceipt(ah);
        }
      }
      resultBox.appendChild(el("div", "muted", "Sending pool swap — confirm in your wallet…"));
      const hash = await sendTx(p.transaction);
      resultBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting…`));
      await waitReceipt(hash);
      resultBox.appendChild(el("div", "ok", `Pool sell confirmed. Received at least ${fmtAmount(p.quote.minimumAmountOut, 18)} WETH (see the receipt for the exact amount).`));
      lastPlan = null;
      await refreshBalances();
      renderWallet();
    } catch (err) { showError(resultBox, err); }
    execBtn.disabled = false;
    execBtn.textContent = "Get quote";
  };

  wrap.append(amountLabel, amountInput, balRow, slipLabel, slipInput, quoteBox, execBtn, resultBox);
  return wrap;
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
  const back = el("button", "btn", "← Back to Discover") as HTMLButtonElement;
  back.onclick = () => { try { history.replaceState(null, "", "#discover"); } catch { /* non-fatal */ } showView("discover"); ensureBackgroundStarted(); };
  view.appendChild(back);

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
    ["Market cap", mcap === null ? "…" : `${fmtEthCompact(mcap)} ETH`],
    ["24h", chg === null ? "—" : formatPercentChange(chg), chg === null ? undefined : chg >= 0 ? "chart-up" : "chart-down"],
    ["Vol 24h", day ? `${fmtEthCompact(day.volumeWeth)} ETH` : "…"],
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
        volValue.textContent = `${fmtEthCompact(vol)} ETH`;
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

  // Main grid: chart (left) + Status / Trade (right).
  const grid = el("div", "detail-grid");
  const leftCol = el("div", "detail-left");
  leftCol.appendChild(chartPanel(l));
  grid.appendChild(leftCol);
  const rightCol = el("div", "detail-right");
  rightCol.appendChild(statusPanel(l));
  rightCol.appendChild(tradePanel(l));
  grid.appendChild(rightCol);
  view.appendChild(grid);

  // Tabs: Trades / Holders / Tech sheet.
  view.appendChild(detailTabs(l, holdersLoad));
}

/** Status panel: fuel gauge, graduation state, pool link when graduated. */
function statusPanel(l: EnrichedLaunch): HTMLElement {
  const wrap = el("div", "panel");
  const head = el("div", "chart-head");
  head.appendChild(el("h3", "", "Status"));
  head.appendChild(el("span", `badge status-${l.curveData!.state.status}`, curveStatusLabel(l.curveData!.state.status)));
  wrap.appendChild(head);
  const fuelPct = l.curveData!.progress.progressBps / 100;
  const fuelRow = el("div", "hero-fuel-row");
  fuelRow.appendChild(el("span", "muted", "Fuel"));
  fuelRow.appendChild(el("span", "hero-fuel-pct", `${fuelPct.toFixed(1)}%`));
  wrap.appendChild(fuelRow);
  wrap.appendChild(fuelSegments(fuelPct));
  if (l.curveData!.state.status === 3) {
    wrap.appendChild(el("div", "muted", "Trading on the pool:"));
    const poolLine = el("div", "");
    poolLine.appendChild(explorerLink(l.curveData!.state.canonicalPool, shortAddr(l.curveData!.state.canonicalPool)));
    wrap.appendChild(poolLine);
  } else {
    wrap.appendChild(el("div", "muted", "Trading on the curve — graduation migrates liquidity to the pool."));
  }
  return wrap;
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
    const rows: Array<[string, HTMLElement | string]> = [
      ["Token", explorerLink(l.token)],
      ["Curve", explorerLink(l.curve)],
      ["Creator", explorerLink(l.creator)],
      ["Config", `#${l.configId.toString()}`],
      ["Launch block", l.blockNumber.toString()],
      ["Total supply", `${fmtAmount(l.meta!.totalSupply, l.meta!.decimals)} ${l.meta!.symbol}`],
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
  const supplyParts = fmtAmount(c.config.totalSupply, c.config.tokenDecimals).split(".");
  supply.textContent = supplyParts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (supplyParts[1] ? `.${supplyParts[1]}` : "");
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
 * Image state for the create form. A picked file lives ONLY in this browser
 * until a future upload step turns it into a public URL — it has no URL
 * and cannot go into the on-chain metadata yet. Only a pasted public link
 * (https:// or ipfs://) can. The upload step (decided by the user: no-key
 * anonymous host) hooks in here: it calls setCreateImageLink(url) after the
 * upload, and everything downstream — preview, metadata, launch warning —
 * follows from that one call.
 */
let createFile: { dataUrl: string; fileName: string } | null = null;
let createLinkUrl = "";
/** True once the user has typed/pasted their own metadata URI — auto-compose stops then. */
let metadataUserSet = false;
let lastAutoMetadata = "";

/** Effective image for preview/metadata: a public link wins, else the local file preview. */
function effectiveCreateImage(): { kind: "link" | "file"; src: string } | null {
  if (createLinkUrl) return { kind: "link", src: createLinkUrl };
  if (createFile) return { kind: "file", src: createFile.dataUrl };
  return null;
}

/** Future upload hook: an upload step calls this with the public image URL. */
function setCreateImageLink(url: string): void {
  createLinkUrl = url;
  const link = $("#create-image-link") as HTMLInputElement;
  link.value = url;
  $("#create-link-wrap").classList.remove("hidden");
  refreshCreateImage();
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
  const media = $("#create-preview-media");
  const rocket = document.querySelector("#dropzone-placeholder svg")?.cloneNode(true) as SVGSVGElement | undefined;
  media.innerHTML = "";
  if (!img) {
    dzImg.classList.add("hidden");
    dzImg.removeAttribute("src");
    dzPlaceholder.classList.remove("hidden");
    removeBtn.classList.add("hidden");
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
    status.textContent = "local only";
    note.textContent = "This image only lives in your browser for now — it has no public URL, so it cannot go into the token metadata yet. Paste a public image link below to include it.";
    note.className = "field-note warn-text";
  } else {
    status.textContent = "linked";
    note.textContent = "";
    note.className = "field-note muted";
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
    refreshCreateImage();
  };
  reader.onerror = () => {
    note.textContent = "Could not read that image — try another file.";
    note.className = "field-note error-text";
  };
  reader.readAsDataURL(file);
}

function clearCreateImage(): void {
  createFile = null;
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
  refreshCreatePreview();
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
    const prev = el("div", "preview");
    prev.appendChild(el("div", "", "Review before signing in your wallet:"));
    prev.appendChild(el("div", "", `Token: ${name} (${symbol}), ${c.config.tokenDecimals} decimals`));
    prev.appendChild(el("div", "", `Config: #${c.configId.toString()} — hash ${shortAddr(c.configHash)}`));
    prev.appendChild(el("div", "", `Factory: ${shortAddr(preview.factory)}`));
    prev.appendChild(el("div", "", `Pool creation fee (msg.value): ${fmtAmount(preview.poolCreationFee, 18)} ETH`));
    prev.appendChild(el("div", "", `Metadata URI: ${metadataURI || "(empty)"}`));
    if (createFile && !createLinkUrl) {
      // Honesty rule: a locally picked file has no public URL and cannot go
      // on-chain. Say so BEFORE the user confirms — never silently drop it.
      const w = el("div", "warn", "The image you picked only lives in this browser — it has no public URL, so this launch will NOT include it in the token metadata. Paste a public image link to include it, or launch without an image.");
      const fixBtn = el("button", "btn text", "Paste a public image link") as HTMLButtonElement;
      fixBtn.onclick = () => {
        $("#create-link-wrap").classList.remove("hidden");
        ($("#create-image-link") as HTMLInputElement).focus();
      };
      w.appendChild(fixBtn);
      prev.appendChild(w);
    }
    resultBox.appendChild(prev);
    const goBtn = el("button", "btn primary", "Sign & create launch") as HTMLButtonElement;
    resultBox.appendChild(goBtn);
    goBtn.onclick = async () => {
      try {
        goBtn.disabled = true;
        resultBox.appendChild(el("div", "muted", "Sending createLaunch — confirm in your wallet…"));
        const hash = await sendTx(preview.transaction);
        resultBox.appendChild(el("div", "muted", `Tx sent: ${shortAddr(hash)} — waiting for confirmation…`));
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
        resultBox.appendChild(el("div", "ok", `Launch created! Token ${shortAddr(created.token)} · Curve ${shortAddr(created.curve)}`));
        const openBtn = el("button", "btn", "Open launch") as HTMLButtonElement;
        openBtn.onclick = () => {
          // Navigate straight to the detail view from the known addresses —
          // the old code awaited the full ~25-min scan first, so the button
          // appeared to do nothing.
          state.detailCurve = created.curve;
          showView("detail");
          void renderDetail(created.curve);
        };
        resultBox.appendChild(openBtn);
      } catch (err) { showError(resultBox, err); }
      goBtn.disabled = false;
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

function showView(name: "discover" | "create" | "detail" | "profile"): void {
  state.view = name;
  for (const v of ["discover", "create", "detail", "profile"] as const) {
    $("#view-" + v).classList.toggle("hidden", v !== name);
  }
  // Only Discover and Create Launch live in the nav now; Profile is reached
  // from the wallet dropdown, and Detail never has an active tab.
  for (const t of ["discover", "create"] as const) {
    $(`#tab-${t}`).classList.toggle("active", t === name);
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
    statusEl.appendChild(el("span", "ok", `Core verified at block ${v.blockNumber.toString()}`));
    statusEl.appendChild(el("span", "muted", " · Factory "));
    statusEl.appendChild(explorerLink(v.factory));
    statusEl.appendChild(el("span", "muted", " · Registry "));
    statusEl.appendChild(explorerLink(v.registry));
  } catch (err) {
    // A failed verify must not blank the UI or block anything else:
    // configs and the launch list load independently. Short message plus a
    // retry — never a raw viem dump.
    statusEl.innerHTML = "";
    statusEl.appendChild(el("span", "error", friendlyErrorMessage(err)));
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
  renderWallet();
  showView("discover");
  initTheme();
  const themeBtn = $("#theme-toggle") as HTMLButtonElement;
  themeBtn.onclick = () => toggleTheme();

  $("#tab-discover").onclick = () => { try { history.replaceState(null, "", "#discover"); } catch { /* non-fatal */ } showView("discover"); renderDiscover(); ensureBackgroundStarted(); };
  $("#tab-create").onclick = () => { try { history.replaceState(null, "", "#create"); } catch { /* non-fatal */ } showView("create"); void loadConfigsForForm(); };
  // Wallet dropdown: close on outside click / Escape; arrow keys move between
  // the menu items. Registered once at boot; the menu itself is rendered by
  // renderWallet() whenever the account state changes.
  document.addEventListener("click", (e) => {
    const wrap = document.querySelector(".wallet-menu-wrap");
    if (!wrap) return;
    if (wrap.contains(e.target as Node)) return;
    closeWalletMenu();
  });
  document.addEventListener("keydown", (e) => {
    const menu = document.querySelector<HTMLElement>(".wallet-menu:not(.hidden)");
    if (e.key === "Escape") {
      if (menu) {
        closeWalletMenu();
        document.querySelector<HTMLButtonElement>(".wallet-btn")?.focus();
      }
      return;
    }
    if (!menu) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".wallet-menu-item")];
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
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
  // "/" focuses the header search (unless already typing in a field).
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/") return;
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
  renderRecent();

  // Restore cached launches FIRST so the list paints instantly, before any
  // network call (verifyCore takes tens of seconds on the public RPC).
  const cache = loadLaunchCache();
  state.launches = cache.launches;
  state.scanStatus = cache.launches.length > 0 ? `restored ${cache.launches.length} cached launches` : "idle";
  renderDiscover();
  void seedChainHead();

  // Deep link: #detail/<curve> opens a launch directly (shareable links).
  const openHashDetail = async (): Promise<void> => {
    const h = location.hash;
    if (!h.startsWith("#detail/")) return;
    const curve = h.slice("#detail/".length);
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
  window.addEventListener("hashchange", () => void openHashDetail());

  // Deep links: #discover (default), #create, #profile, #detail/<curve>.
  const hash = location.hash.replace("#", "");
  if (hash === "create") { showView("create"); void loadConfigsForForm(); ensureBackgroundStarted(); }
  else if (hash === "profile") { showView("profile"); void renderProfile(); ensureBackgroundStarted(); }
  else if (hash.startsWith("detail/")) {
    // Deep link: open the detail FIRST. The heavy background jobs share
    // the rate-limited client and used to queue the detail's own reads
    // behind ~200 calls, so the chart took 60–90 s. They start when the
    // user returns to Discover instead.
    await openHashDetail();
    if (state.view !== "detail") {
      ensureBackgroundStarted();
    } else {
      // The chain-status bar would otherwise stay on "Connecting…" forever
      // on a deep link (verify only runs with the background jobs). Run it
      // once the detail's own reads are already in flight.
      setTimeout(() => void verifyChainStatus(), DETAIL_VERIFY_DELAY_MS);
    }
  } else {
    ensureBackgroundStarted();
  }
}

document.addEventListener("DOMContentLoaded", () => void boot());
