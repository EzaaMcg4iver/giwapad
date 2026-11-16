/**
 * GiwaPad — token launchpad on GIWA Sepolia (chain 91342), built with the
 * Ammora SDK 0.3.9. Static frontend, no backend.
 *
 * Every number on screen comes from a real chain read. Writes are sent only
 * through the user's own connected wallet (MetaMask/Rabby). This app never
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
} from "./ammora";
import { friendlyErrorMessage } from "./errors";
import { ICON_COPY, ICON_EXTERNAL_LINK } from "./icons";
import { initTheme, toggleTheme } from "./theme";
import {
  buildChartSvg,
  CHART_CACHE_TTL_MS,
  CHART_HEIGHT,
  CHART_RANGES,
  filterPointsByRange,
  formatPercentChange,
  formatPriceShort,
  type ChartRange,
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
  filter: "all" as "all" | "active" | "near" | "graduated" | "mine",
  search: "",
  detailCurve: null as string | null,
  slippageBps: 100,
  view: "discover" as "discover" | "create" | "detail" | "profile",
  // Cached non-zero token holdings, keyed by token address (lowercase).
  holdings: new Map<string, { balance: bigint; decimals: number; symbol: string }>(),
  holdingsFor: null as Address | null,
};

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

function renderWallet(): void {
  const box = $("#wallet-status");
  box.innerHTML = "";
  if (!state.account) {
    const b = el("button", "btn primary", "Connect wallet") as HTMLButtonElement;
    b.onclick = () => void connectWallet();
    box.appendChild(b);
    const hint = el("span", "muted", "MetaMask / Rabby · GIWA Sepolia");
    box.appendChild(hint);
    return;
  }
  const addr = el("span", "addr", shortAddr(state.account));
  box.appendChild(addr);
  box.appendChild(el("span", "muted", `ETH ${fmtAmount(state.ethBalance, 18, 4)}`));
  box.appendChild(el("span", "muted", `WETH ${fmtAmount(state.wethBalance, 18, 4)}`));
  const dc = el("button", "btn text", "Disconnect") as HTMLButtonElement;
  dc.onclick = () => {
    state.account = null;
    state.ethBalance = 0n;
    state.wethBalance = 0n;
    state.holdings.clear();
    state.holdingsFor = null;
    renderWallet();
    renderDiscover();
    if (state.view === "profile") void renderProfile();
  };
  box.appendChild(dc);
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

function filteredLaunches(): EnrichedLaunch[] {
  const q = state.search.trim().toLowerCase();
  return state.launches.filter((l) => {
    if (state.filter === "active" && l.curveData?.state.status !== 1) return false;
    if (state.filter === "near" && !(l.curveData && l.curveData.progress.progressBps >= 8000 && l.curveData.state.status === 1)) return false;
    if (state.filter === "graduated" && l.curveData?.state.status !== 3) return false;
    if (state.filter === "mine" && (!state.account || l.creator.toLowerCase() !== state.account.toLowerCase())) return false;
    if (q) {
      const hay = `${l.meta?.name ?? ""} ${l.meta?.symbol ?? ""} ${l.token} ${l.curve} ${l.creator}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function launchCard(l: EnrichedLaunch): HTMLElement {
  const card = el("div", "card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const openDetail = () => { state.detailCurve = l.curve; showView("detail"); void renderDetail(l.curve); };
  card.onclick = openDetail;
  card.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); }
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

function renderDiscover(): void {
  const grid = $("#launch-grid");
  grid.innerHTML = "";
  const items = filteredLaunches();
  $("#launch-count").textContent =
    `${items.length} of ${state.launches.length} launches · ${state.scanStatus}`;
  if (items.length === 0) {
    grid.appendChild(el("div", "empty", state.launches.length === 0
      ? "No launches found yet on this deployment. Be the first — create a launch."
      : "No launches match this filter."));
    return;
  }
  for (const l of items) {
    grid.appendChild(launchCard(l));
  }
}

async function enrichLaunches(): Promise<void> {
  // Sequential, paced — the public RPC rate-limits bursts.
  for (const l of state.launches) {
    if (l.meta && l.curveData) continue;
    try {
      l.meta = await getTokenMeta(l.token);
      l.curveData = await getCurveFull(l.curve);
      l.price = priceFromSqrtPrice(l.curveData.state.sqrtPrice, l.meta.decimals, 18);
    } catch (err) {
      l.loadError = friendlyErrorMessage(err);
    }
    renderDiscover();
    await new Promise((r) => setTimeout(r, 400));
  }
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
    meta: { address: l.token, name: l.name, symbol: l.symbol, decimals: l.decimals },
  };
  state.launches = [...state.launches, launch].sort((a, b) => Number(b.blockNumber - a.blockNumber));
  // Persist the launch but keep the scan's own progress marker, so the scan
  // does not skip blocks it has not reached yet.
  const cache = loadLaunchCache();
  saveLaunchCache(state.launches, cache.scannedTo);
  renderDiscover();
}

async function refreshLaunches(): Promise<void> {
  const statusEl = $("#scan-status");
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
    if (statusEl) statusEl.textContent = state.scanStatus;
    renderDiscover();
    void enrichLaunches();
  } catch (err) {
    state.scanStatus = "scan failed";
    renderDiscover();
    if (statusEl) showError(statusEl, err);
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
// Price chart (detail view) — custom SVG, no chart library, no new deps.
// Data comes from real on-chain Swap events (see scanCurveChart).
// Drawing and range logic live in ./chart.ts; this panel only wires it up.
// ---------------------------------------------------------------------------

let chartRange: ChartRange = "all";
const chartCache = new Map<string, { at: number; data: ChartData }>();

function chartPanel(l: EnrichedLaunch): HTMLElement {
  const wrap = el("div", "panel chart-panel");
  wrap.appendChild(el("h3", "", "Price chart"));
  const segRow = el("div", "seg");
  const rangeBtns = new Map<ChartRange, HTMLButtonElement>();
  for (const { range: r, label } of CHART_RANGES) {
    const b = el("button", `btn seg-btn${chartRange === r ? " active" : ""}`, label) as HTMLButtonElement;
    b.onclick = () => {
      chartRange = r;
      for (const [rr, bb] of rangeBtns) bb.classList.toggle("active", rr === r);
      void loadChart();
    };
    rangeBtns.set(r, b);
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
    const key = l.curve.toLowerCase();
    try {
      const cached = chartCache.get(key);
      let data = cached && Date.now() - cached.at < CHART_CACHE_TTL_MS ? cached.data : null;
      if (!data) {
        data = await scanCurveChart(l.curve, l.blockNumber, l.meta!.decimals, l.price ?? "0");
        chartCache.set(key, { at: Date.now(), data });
      }
      const pts = filterPointsByRange(data, chartRange);
      statsBox.innerHTML = "";
      body.innerHTML = "";
      if (data.trades === 0) {
        body.appendChild(el("div", "muted", "Belum ada trade — harga masih harga awal."));
      } else if (data.truncated) {
        body.appendChild(el("div", "muted", "Menampilkan 1,2 jt blok terakhir."));
      }
      if (pts.length === 0) {
        body.appendChild(el("div", "muted", "Tidak ada trade pada rentang ini."));
        return;
      }
      const prices = pts.map((p) => p.price);
      const first = prices[0];
      const last = prices[prices.length - 1];
      const low = Math.min(...prices);
      const high = Math.max(...prices);
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
      body.appendChild(buildChartSvg(pts));
      body.appendChild(el("div", "muted chart-note",
        `${data.trades} trade · dari blok ${data.launchBlock.toString()} · harga dari event Swap di chain`));
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
    buyBtn.onclick = () => { direction = "buy"; buyBtn.classList.add("active"); sellBtn.classList.remove("active"); amountLabel.textContent = `Amount (${quoteSymbol})`; updateQuote(); };
    sellBtn.onclick = () => { direction = "sell"; sellBtn.classList.add("active"); buyBtn.classList.remove("active"); amountLabel.textContent = `Amount (${baseSymbol})`; updateQuote(); };

    const amountLabel = el("label", "", `Amount (${quoteSymbol})`);
    const amountInput = el("input") as HTMLInputElement;
    amountInput.type = "text";
    amountInput.inputMode = "decimal";
    amountInput.placeholder = "0.0";
    const slipLabel = el("label", "", "Slippage (bps, 100 = 1%)");
    const slipInput = el("input") as HTMLInputElement;
    slipInput.type = "number";
    slipInput.value = String(state.slippageBps);
    slipInput.min = "1";
    slipInput.max = "5000";
    slipInput.onchange = () => { state.slippageBps = Math.max(1, Math.min(5000, Number(slipInput.value) || 100)); updateQuote(); };

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

    wrap.append(amountLabel, amountInput, slipLabel, slipInput, quoteBox, execBtn, resultBox);
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
    void updateQuote();
  };
  sellBtn.onclick = () => {
    direction = "sell";
    sellBtn.classList.add("active");
    buyBtn.classList.remove("active");
    amountLabel.textContent = `Sell amount (${l.meta!.symbol})`;
    lastPlan = null;
    execBtn.textContent = "Get quote";
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
        quoteBox.appendChild(el("div", "", `Minimum out (${state.slippageBps} bps slippage): ${fmtAmount(lastMinOut, outMeta.decimals)} ${outMeta.symbol}`));
        execBtn.textContent = "Preview & execute";
      } else {
        const amountIn = parseUnits(raw, l.meta!.decimals);
        lastAmountIn = amountIn;
        const q = await quotePool(pool, l.token, amountIn);
        lastMinOut = minOut(q.amountOut, state.slippageBps);
        quoteBox.innerHTML = "";
        quoteBox.appendChild(el("div", "", `Expected out: ${fmtAmount(q.amountOut, 18)} WETH`));
        quoteBox.appendChild(el("div", "", `Minimum out (${state.slippageBps} bps slippage): ${fmtAmount(lastMinOut, 18)} WETH`));
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

  wrap.append(amountLabel, amountInput, quoteBox, execBtn, resultBox);
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
  const back = el("button", "btn", "← Back to Discover") as HTMLButtonElement;
  back.onclick = () => { try { history.replaceState(null, "", "#discover"); } catch { /* non-fatal */ } showView("discover"); };
  view.appendChild(back);

  if (!launch.meta || !launch.curveData) {
    const loadingBox = el("div", "");
    const loadingSkeleton = el("div", "skeleton");
    loadingSkeleton.style.height = `${DETAIL_SKELETON_HEIGHT_PX}px`;
    loadingBox.appendChild(loadingSkeleton);
    loadingBox.appendChild(el("div", "muted", "Loading launch data from chain…"));
    view.appendChild(loadingBox);
    try {
      launch.meta = await getTokenMeta(launch.token);
      launch.curveData = await getCurveFull(launch.curve);
      launch.price = priceFromSqrtPrice(launch.curveData.state.sqrtPrice, launch.meta.decimals, 18);
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

  const title = el("h2", "", `${meta.name} (${meta.symbol})`);
  view.appendChild(title);
  const badge = el("span", `badge status-${st.status}`, curveStatusLabel(st.status));
  view.appendChild(badge);

  const info = el("div", "panel");
  const rows: Array<[string, HTMLElement | string]> = [
    ["Token", explorerLink(l.token)],
    ["Curve", explorerLink(l.curve)],
    ["Creator", explorerLink(l.creator)],
    ["Config", `#${l.configId.toString()}`],
    ["Created", `block ${l.blockNumber.toString()}`],
    ["Price", `${l.price ?? "…"} WETH per ${meta.symbol}`],
    ["Base reserve", `${fmtAmount(st.baseReserve, meta.decimals)} ${meta.symbol}`],
    ["Quote reserve", `${fmtAmount(st.quoteReserve, 18)} WETH`],
    ["Current fee", `${st.currentFeeBps} bps (dynamic ${st.currentDynamicFeeBps} bps)`],
    ["Migration target", `${fmtAmount(cf.progress.target, 18)} WETH raised`],
    ["Migration progress", `${(cf.progress.progressBps / 100).toFixed(1)}%`],
    ["Fee vault", explorerLink(st.feeVault)],
  ];
  if (st.status === 3) rows.push(["Canonical pool", explorerLink(st.canonicalPool)]);
  for (const [k, v] of rows) {
    const r = el("div", "row");
    r.appendChild(el("span", "k", k));
    const val = el("span", "v");
    if (typeof v === "string") val.textContent = v; else val.appendChild(v);
    r.appendChild(val);
    info.appendChild(r);
  }
  const bar = el("div", "bar");
  const fill = el("div", "bar-fill");
  fill.style.width = `${Math.min(100, cf.progress.progressBps / 100)}%`;
  bar.appendChild(fill);
  info.appendChild(bar);
  view.appendChild(info);

  view.appendChild(chartPanel(l));

  if (state.account) {
    const balBox = el("div", "panel");
    balBox.appendChild(el("h3", "", "Your balances"));
    try {
      const [tokBal, ethBal, wethBal] = await Promise.all([
        getTokenBalance(l.token, state.account),
        getEthBalance(state.account),
        getTokenBalance(WETH, state.account),
      ]);
      const rows2: Array<[string, string]> = [
        ["ETH", fmtAmount(ethBal, 18)],
        ["WETH", fmtAmount(wethBal, 18)],
        [meta.symbol, fmtAmount(tokBal, meta.decimals)],
      ];
      for (const [k, v] of rows2) {
        const r = el("div", "row");
        r.appendChild(el("span", "k", k));
        r.appendChild(el("span", "v", v));
        balBox.appendChild(r);
      }
    } catch (err) {
      balBox.appendChild(el("div", "error", `Could not load balances: ${friendlyErrorMessage(err)}`));
    }
    view.appendChild(balBox);
  }

  view.appendChild(tradePanel(l));
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
  return enabled.length > 0;
}

async function loadConfigsForForm(): Promise<void> {
  const sel = $("#create-config") as HTMLSelectElement;
  const info = $("#config-info");
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
  const info = $("#config-info");
  if (!c) { info.textContent = ""; return; }
  info.innerHTML = "";
  const rows: Array<[string, string]> = [
    ["Config", `#${c.configId.toString()} (${c.enabled ? "enabled" : "disabled"})`],
    ["Hash", shortAddr(c.configHash)],
    ["Owner", shortAddr(c.identity.owner)],
    ["Token decimals", String(c.config.tokenDecimals)],
    ["Total supply", fmtAmount(c.config.totalSupply, c.config.tokenDecimals)],
    ["Migration quote threshold", `${fmtAmount(c.config.migrationQuoteThreshold, 18)} WETH`],
    ["Migration base threshold", fmtAmount(c.config.migrationBaseThreshold, c.config.tokenDecimals)],
    ["Cliff fee", `${c.config.cliffFeeBps} bps`],
    ["Migration mode", String(c.config.migrationMode)],
    ["Pool creation fee", `${fmtAmount(c.config.poolCreationFee, 18)} ETH`],
    ["Segments", String(c.segments.length)],
  ];
  for (const [k, v] of rows) {
    const r = el("div", "row");
    r.appendChild(el("span", "k", k));
    r.appendChild(el("span", "v", v));
    info.appendChild(r);
  }
  const dec = $("#create-decimals") as HTMLInputElement;
  dec.value = String(c.config.tokenDecimals);
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
  try {
    const preview = buildCreateLaunchTx(name, symbol, metadataURI, c.config.tokenDecimals, c.configId, c.config.poolCreationFee);
    const prev = el("div", "preview");
    prev.appendChild(el("div", "", "Review before signing in your wallet:"));
    prev.appendChild(el("div", "", `Token: ${name} (${symbol}), ${c.config.tokenDecimals} decimals`));
    prev.appendChild(el("div", "", `Config: #${c.configId.toString()} — hash ${shortAddr(c.configHash)}`));
    prev.appendChild(el("div", "", `Factory: ${shortAddr(preview.factory)}`));
    prev.appendChild(el("div", "", `Pool creation fee (msg.value): ${fmtAmount(preview.poolCreationFee, 18)} ETH`));
    prev.appendChild(el("div", "", `Metadata URI: ${metadataURI || "(empty)"}`));
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
  for (const t of ["discover", "create", "profile"] as const) {
    $(`#tab-${t}`).classList.toggle("active", t === name);
  }
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

async function boot(): Promise<void> {
  renderWallet();
  showView("discover");
  initTheme();
  const themeBtn = $("#theme-toggle") as HTMLButtonElement;
  themeBtn.onclick = () => toggleTheme();

  $("#tab-discover").onclick = () => { try { history.replaceState(null, "", "#discover"); } catch { /* non-fatal */ } showView("discover"); renderDiscover(); };
  $("#tab-create").onclick = () => { try { history.replaceState(null, "", "#create"); } catch { /* non-fatal */ } showView("create"); void loadConfigsForForm(); };
  $("#tab-profile").onclick = () => { try { history.replaceState(null, "", "#profile"); } catch { /* non-fatal */ } showView("profile"); void renderProfile(); };
  $("#refresh-btn").onclick = () => void refreshLaunches();
  $("#search-input").oninput = (e) => { state.search = (e.target as HTMLInputElement).value; renderDiscover(); };
  for (const f of ["all", "active", "near", "graduated", "mine"] as const) {
    $(`#filter-${f}`).onclick = () => {
      state.filter = f;
      for (const g of ["all", "active", "near", "graduated", "mine"] as const) {
        $(`#filter-${g}`).classList.toggle("active", g === f);
      }
      renderDiscover();
    };
  }
  $("#create-submit").onclick = () => void handleCreate();

  // Restore cached launches FIRST so the list paints instantly, before any
  // network call (verifyCore takes tens of seconds on the public RPC).
  const cache = loadLaunchCache();
  state.launches = cache.launches;
  state.scanStatus = cache.launches.length > 0 ? `restored ${cache.launches.length} cached launches` : "idle";
  renderDiscover();
  void enrichLaunches();

  // Preload the launch configs on the fast client so the Create form's
  // dropdown is already populated when the user opens it (it used to wait
  // behind the bulk launch scan).
  void loadConfigsForForm();

  // Deep links: #discover (default), #create, #profile.
  const hash = location.hash.replace("#", "");
  if (hash === "create") { showView("create"); void loadConfigsForForm(); }
  else if (hash === "profile") { showView("profile"); void renderProfile(); }

  // Chain status — fire and forget: a slow or failed verify must never
  // delay or block the configs and the launch scan.
  void verifyChainStatus();

  // Then refresh from chain.
  await refreshLaunches();

  // Deep link: #detail/<curve> opens a launch directly (shareable links).
  const openHashDetail = (): void => {
    const h = location.hash;
    if (!h.startsWith("#detail/")) return;
    const curve = h.slice("#detail/".length);
    const launch = state.launches.find((x) => x.curve.toLowerCase() === curve.toLowerCase());
    if (launch) {
      state.detailCurve = launch.curve;
      showView("detail");
      void renderDetail(launch.curve);
    }
  };
  openHashDetail();
  window.addEventListener("hashchange", openHashDetail);
}

document.addEventListener("DOMContentLoaded", () => void boot());
