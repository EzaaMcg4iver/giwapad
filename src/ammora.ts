/**
 * GiwaPad — Ammora SDK layer (GIWA Sepolia, chain 91342).
 *
 * All reads go to the public GIWA RPC. All writes are built as unsigned
 * transactions and returned to the caller; the caller sends them through the
 * user's own connected wallet. This module never asks for, stores, or uses
 * any private key, seed phrase, or mnemonic.
 *
 * SDK usage follows the public Ammora examples project
 * (@ammora-protocol/sdk 0.3.9, GIWA Sepolia auto-route deployment, V4):
 *  - src/quickstart/list-configs.ts  (config listing)
 *  - src/launch/get-config.ts       (config detail)
 *  - src/launch/create-launch.ts    (token issuance)
 *  - src/launch/quote-curve.ts      (curve state + quotes)
 *  - src/launch/final-fill-and-graduate.ts (graduation)
 *  - src/arl/swap-native.ts         (post-graduation native buy)
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  http,
  parseAbiItem,
  decodeEventLog,
  toEventSelector,
  formatUnits,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { priceX128FromSqrtPriceX64 } from "@ammora-protocol/math";
import { isRateLimitError, isUnknownChainError, providerErrorCode } from "./errors";

export { isRateLimitError } from "./errors";
import {
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRoute,
  getAmmoraV4ConfigAtBlock,
  getAmmoraV4NextConfigId,
  verifyAmmoraV4CoreAtBlock,
  resolveAmmoraFinalizedHead,
  buildCreateAmmoraV4Launch,
  parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4SwapReceipt,
  AmmoraV4LaunchCurveClient,
  classifyAmmoraV4ExactInputFill,
  scanAmmoraLogs,
  DammV2Client,
  buildV3NativePoolExactInput,
  minOutFromSlippage,
  AMMORA_FEE_POLICY_VERSION,
  ammoraLaunchFactoryV4Abi,
  type AmmoraTransaction,
  type ERC20ApprovalRequirement,
} from "@ammora-protocol/sdk";

export const RPC_URL = "https://sepolia-rpc.giwa.io";
export const CHAIN_ID = 91342;
export const EXPLORER_URL = "https://sepolia-explorer.giwa.io";

/** First block of the reviewed auto-route deployment (from its catalog). */
export const DEPLOYMENT_START_BLOCK = 36220000n;

export const deployment = giwaSepoliaAutoRouteDeployment;
export const LAUNCH = deployment.contracts.launch;
export const FACTORY: Address = LAUNCH.factory;
export const REGISTRY: Address = LAUNCH.configRegistry;
export const FEE_POLICY: Address = LAUNCH.feePolicy;
export const GRADUATION_ADAPTER: Address = LAUNCH.graduationAdapter;
export const WETH: Address = deployment.contracts.tokens.wrappedNative;
export const NATIVE_ROUTER: Address = deployment.contracts.routers.native;
export const CONCENTRATED_FACTORY: Address = LAUNCH.concentratedFactory;
export const CONCENTRATED_PM: Address = LAUNCH.concentratedPositionManager;

export const giwaSepolia = defineChain({
  id: deployment.chain.id,
  name: deployment.chain.name,
  nativeCurrency: deployment.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Sepolia Explorer", url: EXPLORER_URL } },
});

/** Live counters for RPC health (rate-limit retries etc.). Diagnostics only; never sent anywhere. */
export const rpcStats = { requests: 0, rateLimited: 0, retried: 0 };

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize public RPC calls, mirroring the examples' paced transport. */
export function pacedHttp(url: string, intervalMs = 600): Transport {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  return (parameters) => {
    const base = http(url, { retryCount: 0 })(parameters);
    return custom({
      request: (args) => {
        const result = tail.then(async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, nextStart - Date.now())),
          );
          try {
            // Retry a rate limit with backoff instead of killing the scan.
            for (let attempt = 0; ; attempt++) {
              rpcStats.requests++;
              try {
                return await base.request(args);
              } catch (err) {
                if (isRateLimitError(err) && attempt < 4) {
                  rpcStats.rateLimited++;
                  rpcStats.retried++;
                  await sleep(500 * 2 ** attempt);
                  continue;
                }
                throw err;
              }
            }
          } finally {
            nextStart = Date.now() + intervalMs;
          }
        });
        tail = result.catch(() => undefined);
        return result;
      },
    }, { retryCount: 0 })(parameters);
  };
}

/**
 * Rate-limited transport for interactive reads (configs, quotes, balances,
 * curve state). The public GIWA RPC answers bursts with HTTP 429 / -32016
 * "over rate limit", so interactive reads are capped at 2 in flight with a
 * ~200 ms gap between calls, and a rate limit is retried with exponential
 * backoff (500 ms → 1 s → 2 s → 4 s, up to 4 attempts) instead of surfacing
 * a raw error to the user.
 */
export function limitedHttp(
  url: string,
  opts: { maxConcurrent?: number; minGapMs?: number; maxRetries?: number } = {},
): Transport {
  const maxConcurrent = opts.maxConcurrent ?? 2;
  const minGapMs = opts.minGapMs ?? 200;
  const maxRetries = opts.maxRetries ?? 4;
  let inFlight = 0;
  let nextStart = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (inFlight < maxConcurrent) { inFlight++; return; }
    await new Promise<void>((resolve) => waiters.push(resolve));
    // Slot transferred by release(); inFlight unchanged.
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) { next(); return; }
    inFlight--;
  };
  return (parameters) => {
    const base = http(url, { retryCount: 0 })(parameters);
    return custom({
      request: async (args) => {
        let lastErr: unknown = new Error("RPC request failed");
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          await acquire();
          let rateLimited = false;
          try {
            const wait = nextStart - Date.now();
            if (wait > 0) await sleep(wait);
            nextStart = Date.now() + minGapMs;
            rpcStats.requests++;
            return await base.request(args);
          } catch (err) {
            lastErr = err;
            if (attempt < maxRetries - 1 && isRateLimitError(err)) {
              rpcStats.rateLimited++;
              rpcStats.retried++;
              rateLimited = true;
            } else {
              throw err;
            }
          } finally {
            release();
          }
          if (rateLimited) await sleep(500 * 2 ** attempt);
        }
        throw lastErr;
      },
    }, { retryCount: 0 })(parameters);
  };
}

let publicClient: PublicClient | null = null;
/**
 * Default client for interactive reads (configs, quotes, balances, curve
 * state). Rate-limited (2 in flight, ~200 ms gap, retry on 429) so a burst
 * of user-triggered reads never trips the public RPC — and so these reads
 * never wait behind the bulk launch scan.
 */
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: giwaSepolia,
      transport: limitedHttp(RPC_URL, { maxConcurrent: 2, minGapMs: 200, maxRetries: 4 }),
    }) as PublicClient;
  }
  return publicClient;
}

let scanClient: PublicClient | null = null;
/**
 * Paced, serialized client used ONLY by the bulk log scan (scanLaunches).
 * The scan issues thousands of RPC calls; the 600 ms pacing keeps it inside
 * the public RPC's limits. Nothing else may use this client, or interactive
 * reads would queue behind the scan for ~25 minutes on first load.
 */
export function getScanClient(): PublicClient {
  if (!scanClient) {
    scanClient = createPublicClient({
      chain: giwaSepolia,
      transport: pacedHttp(RPC_URL),
    }) as PublicClient;
  }
  return scanClient;
}

export function getWalletClient(): WalletClient {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("No injected wallet found (window.ethereum is missing). Install MetaMask or Rabby, or open this page in a wallet browser.");
  return createWalletClient({ chain: giwaSepolia, transport: custom(eth as never) }) as WalletClient;
}

export async function requestAccounts(): Promise<Address[]> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) throw new Error("No injected wallet found (window.ethereum is missing).");
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  return accounts as Address[];
}

/** Params for adding GIWA Sepolia to a wallet. chainId is computed from CHAIN_ID (91342 = 0x164ce). */
function giwaSepoliaAddParams(): Record<string, unknown> {
  return {
    chainId: `0x${CHAIN_ID.toString(16)}`,
    chainName: "GIWA Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [RPC_URL],
    blockExplorerUrls: [EXPLORER_URL],
  };
}

/**
 * Make sure the wallet is on GIWA Sepolia, adding the chain when it is
 * missing. Flow: read the current chain first (skip everything when already
 * correct) → try to switch → if the chain is unknown, add it, then switch
 * again (some wallets do not auto-switch after adding). A user rejection
 * (code 4001) at any step stops the flow with a readable Error — never a
 * raw provider object, never a retry loop.
 */
export async function ensureGiwaChain(): Promise<void> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) throw new Error("No injected wallet found.");
  const chainIdHex = `0x${CHAIN_ID.toString(16)}`;
  try {
    const current = (await eth.request({ method: "eth_chainId" })) as string;
    if (typeof current === "string" && Number.parseInt(current, 16) === CHAIN_ID) return;
  } catch (err) {
    // A failed chain read must not block the connect attempt; fall through
    // to the switch below. A rejection here is not a thing, so just continue.
    if (providerErrorCode(err) === 4001) throw new Error("Pindah chain ditolak di dompet, coba lagi.");
  }
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
    return;
  } catch (err) {
    if (providerErrorCode(err) === 4001) throw new Error("Pindah chain ditolak di dompet, coba lagi.");
    if (!isUnknownChainError(err)) throw err;
    // Chain is unknown to the wallet: add it, then switch to it.
    try {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [giwaSepoliaAddParams()],
      });
    } catch (addErr) {
      if (providerErrorCode(addErr) === 4001) throw new Error("Pindah chain ditolak di dompet, coba lagi.");
      throw addErr;
    }
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: chainIdHex }],
      });
    } catch (switchErr) {
      if (providerErrorCode(switchErr) === 4001) throw new Error("Pindah chain ditolak di dompet, coba lagi.");
      throw switchErr;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LaunchConfig = Awaited<ReturnType<typeof getAmmoraV4ConfigAtBlock>>;

export interface Launch {
  token: Address;
  curve: Address;
  creator: Address;
  configId: bigint;
  configHash: Hex;
  protocolVersion: number;
  metadataURI: string;
  blockNumber: bigint;
  txHash: Hash;
}

export interface TokenMeta {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
}

export interface CurveFull {
  state: Awaited<ReturnType<AmmoraV4LaunchCurveClient["getState"]>>;
  progress: Awaited<ReturnType<AmmoraV4LaunchCurveClient["getMigrationProgressAtBlock"]>>;
}

export const CURVE_STATUS_LABEL: Record<number, string> = {
  0: "Created",
  1: "Active",
  2: "Ready to graduate",
  3: "Graduated",
};

export function curveStatusLabel(status: number): string {
  return CURVE_STATUS_LABEL[status] ?? `Unknown (${status})`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function verifyCore(): Promise<{ blockNumber: bigint; factory: Address; registry: Address }> {
  const client = getPublicClient();
  const blockNumber = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
  await verifyAmmoraV4CoreAtBlock(client, {
    configRegistry: REGISTRY,
    launchFactory: FACTORY,
    graduationAdapter: GRADUATION_ADAPTER,
    feePolicy: FEE_POLICY,
  }, blockNumber);
  return { blockNumber, factory: FACTORY, registry: REGISTRY };
}

export async function listConfigs(limit = 10): Promise<{ nextConfigId: bigint; configs: LaunchConfig[]; blockNumber: bigint }> {
  const client = getPublicClient();
  const blockNumber = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
  const nextConfigId = await getAmmoraV4NextConfigId(client, REGISTRY, blockNumber);
  const total = nextConfigId > 1n ? nextConfigId - 1n : 0n;
  const count = Math.min(limit, Number(total));
  const configs: LaunchConfig[] = [];
  for (let i = 0; i < count; i++) {
    configs.push(await getAmmoraV4ConfigAtBlock(client, REGISTRY, BigInt(i + 1), blockNumber));
  }
  return { nextConfigId, configs, blockNumber };
}

export async function getConfig(configId: bigint): Promise<LaunchConfig> {
  const client = getPublicClient();
  const blockNumber = await resolveAmmoraFinalizedHead([client], giwaSepoliaAutoRoute.finality);
  return getAmmoraV4ConfigAtBlock(client, REGISTRY, configId, blockNumber);
}

const LAUNCH_CREATED_EVENT = parseAbiItem(
  "event LaunchCreated(address indexed token, address indexed curve, address indexed creator, uint256 configId, bytes32 configHash, uint16 protocolVersion, string metadataURI)",
);
const LAUNCH_CREATED_TOPIC = toEventSelector(LAUNCH_CREATED_EVENT);

export async function scanLaunches(
  fromBlock: bigint,
  toBlock: bigint,
  onCheckpoint?: (scannedTo: bigint) => void,
): Promise<Launch[]> {
  // Bulk scan: the ONLY reader on the paced client (see getScanClient).
  const client = getScanClient();
  const logs = await scanAmmoraLogs({
    clients: [client],
    fromBlock,
    toBlock,
    addresses: [FACTORY],
    initialWindow: 5000n,
    minimumWindow: 100n,
    maximumWindow: 50000n,
    retriesPerClient: 2,
    onCheckpoint: onCheckpoint
      ? (cp: { toBlock?: bigint }) => {
          if (cp.toBlock !== undefined) onCheckpoint(cp.toBlock);
        }
      : undefined,
  });
  const out: Launch[] = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== LAUNCH_CREATED_TOPIC.toLowerCase()) continue;
    if (log.blockNumber == null || log.transactionHash == null) continue;
    const decoded = decodeEventLog({ abi: [LAUNCH_CREATED_EVENT], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    out.push({
      token: decoded.args.token,
      curve: decoded.args.curve,
      creator: decoded.args.creator,
      configId: decoded.args.configId,
      configHash: decoded.args.configHash,
      protocolVersion: decoded.args.protocolVersion,
      metadataURI: decoded.args.metadataURI,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
    });
  }
  return out;
}

const ERC20_META_ABI = [
  parseAbiItem("function name() view returns (string)"),
  parseAbiItem("function symbol() view returns (string)"),
  parseAbiItem("function decimals() view returns (uint8)"),
  parseAbiItem("function balanceOf(address) view returns (uint256)"),
  parseAbiItem("function allowance(address,address) view returns (uint256)"),
] as const;

// ---------------------------------------------------------------------------
// Price history (chart)
// ---------------------------------------------------------------------------

const CURVE_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed trader, bool indexed baseForQuote, bool exactInput, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 amountLeft, uint128 nextSqrtPrice, address recipient)",
);
const CURVE_SWAP_TOPIC = toEventSelector(CURVE_SWAP_EVENT);

/** One price point: WETH per whole token (JS number) at a block + wall time. */
export interface ChartPoint {
  block: bigint;
  timeMs: number;
  price: number;
}

export interface ChartData {
  curve: Address;
  points: ChartPoint[];
  trades: number;
  truncated: boolean;
  fromBlock: bigint;
  toBlock: bigint;
  launchBlock: bigint;
}

/**
 * Longest history the chart ever scans (1.2M blocks ≈ 3 weeks at ~1.5 s/block).
 * Older launches show the most recent 1.2M blocks and say so (truncated).
 */
const CHART_MAX_SPAN = 1_200_000n;

/**
 * Price history for a curve, from REAL on-chain Swap events (the SDK's
 * ammoraLaunchPoolV4Abi Swap event). Each Swap log carries nextSqrtPrice —
 * the price right after that trade — converted with the same helper the
 * detail view uses. The series starts with the true starting price (curve
 * state read at the launch block) and ends with the current price. Block
 * timestamps are interpolated between two real block headers (first and
 * last block of the range), so the time axis is honest without one RPC
 * call per point. Runs on the rate-limited interactive client (never the
 * bulk scan client) with 10,000-block windows (the public RPC's log cap).
 */
export async function scanCurveChart(
  curve: Address,
  launchBlock: bigint,
  baseDecimals: number,
  currentPrice: string,
): Promise<ChartData> {
  const client = getPublicClient();
  const latest = await client.getBlockNumber();
  const truncated = latest - launchBlock > CHART_MAX_SPAN;
  const fromBlock = truncated ? latest - CHART_MAX_SPAN : launchBlock;
  const logs = await scanAmmoraLogs({
    clients: [client],
    fromBlock,
    toBlock: latest,
    addresses: [curve],
    initialWindow: 5000n,
    minimumWindow: 100n,
    maximumWindow: 10000n,
    retriesPerClient: 2,
  });
  const trades: Array<{ block: bigint; price: number }> = [];
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== CURVE_SWAP_TOPIC.toLowerCase()) continue;
    if (log.blockNumber == null) continue;
    try {
      const decoded = decodeEventLog({ abi: [CURVE_SWAP_EVENT], data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      trades.push({ block: log.blockNumber, price: Number.parseFloat(priceFromSqrtPrice(decoded.args.nextSqrtPrice, baseDecimals, 18)) });
    } catch { /* not a Swap-shaped log — ignore */ }
  }
  trades.sort((a, b) => Number(a.block - b.block));

  // Two real block headers; everything between is linear interpolation.
  const [firstHeader, lastHeader] = await Promise.all([
    client.getBlock({ blockNumber: fromBlock }),
    client.getBlock({ blockNumber: latest }),
  ]);
  const t0 = Number(firstHeader.timestamp) * 1000;
  const t1 = Number(lastHeader.timestamp) * 1000;
  const spanBlocks = Number(latest - fromBlock);
  const timeAt = (block: bigint): number =>
    spanBlocks <= 0 ? t0 : t0 + (Number(block - fromBlock) / spanBlocks) * (t1 - t0);

  // True starting price: curve state at the launch block, before any trade
  // could move it. Falls back to the first trade's price, then the current
  // price — never invented.
  let startPrice = Number.parseFloat(currentPrice);
  try {
    const atLaunch = await curveClient(curve).getStateAtBlock(launchBlock);
    startPrice = Number.parseFloat(priceFromSqrtPrice(atLaunch.sqrtPrice, baseDecimals, 18));
  } catch {
    if (trades.length > 0) startPrice = trades[0].price;
  }

  const points: ChartPoint[] = [];
  points.push({ block: launchBlock, timeMs: timeAt(launchBlock), price: startPrice });
  for (const t of trades) points.push({ block: t.block, timeMs: timeAt(t.block), price: t.price });
  points.push({ block: latest, timeMs: t1, price: Number.parseFloat(currentPrice) });
  points.sort((a, b) => a.timeMs - b.timeMs || Number(a.block - b.block));
  const deduped = points.filter((p, i) => i === 0 || p.block !== points[i - 1].block || p.price !== points[i - 1].price);
  return { curve, points: deduped, trades: trades.length, truncated, fromBlock, toBlock: latest, launchBlock };
}

export async function getTokenMeta(token: Address): Promise<TokenMeta> {
  const client = getPublicClient();
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_META_ABI, functionName: "name" }).catch(() => "Unknown"),
    client.readContract({ address: token, abi: ERC20_META_ABI, functionName: "symbol" }).catch(() => "???"),
    client.readContract({ address: token, abi: ERC20_META_ABI, functionName: "decimals" }).catch(() => 18),
  ]);
  return { address: token, name: String(name), symbol: String(symbol), decimals: Number(decimals) };
}

export async function getTokenBalance(token: Address, owner: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({ address: token, abi: ERC20_META_ABI, functionName: "balanceOf", args: [owner] });
}

export async function getEthBalance(owner: Address): Promise<bigint> {
  return getPublicClient().getBalance({ address: owner });
}

export async function getAllowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({ address: token, abi: ERC20_META_ABI, functionName: "allowance", args: [owner, spender] });
}

export function curveClient(curve: Address): AmmoraV4LaunchCurveClient {
  return new AmmoraV4LaunchCurveClient(getPublicClient(), curve, {
    launchFactory: FACTORY,
    feePolicy: FEE_POLICY,
  });
}

export async function getCurveFull(curve: Address): Promise<CurveFull> {
  const sdk = curveClient(curve);
  const client = getPublicClient();
  const blockNumber = await client.getBlockNumber();
  const [state, progress] = await Promise.all([
    sdk.getStateAtBlock(blockNumber),
    sdk.getMigrationProgressAtBlock(blockNumber),
  ]);
  return { state, progress };
}

/**
 * Human price: quote-token units per 1 whole base token, from the curve's
 * sqrt price. Ammora V4 curve sqrt prices are X64 fixed point, so the
 * conversion uses the official @ammora-protocol/math helper
 * priceX128FromSqrtPriceX64 (priceX128 = price * 2^128). Verified against
 * the live chain: curve 0x2C4e…BD7B gives 0.000000001000000145 WETH per
 * AIV4C, matching its live quote (0.01 WETH -> ~9,874,998 AIV4C).
 */
export function priceFromSqrtPrice(sqrtPrice: bigint, baseDecimals: number, quoteDecimals: number): string {
  const priceX128 = priceX128FromSqrtPriceX64(sqrtPrice);
  const displayScaled =
    (priceX128 * 10n ** BigInt(baseDecimals) * 10n ** 18n) /
    ((1n << 128n) * 10n ** BigInt(quoteDecimals));
  return formatUnits(displayScaled, 18);
}

export async function quoteCurve(
  curve: Address,
  amountIn: bigint,
  baseForQuote: boolean,
): Promise<{ amountOut: bigint; fee: bigint; amountLeft: bigint; fillKind: string }> {
  const sdk = curveClient(curve);
  const quote = await sdk.quoteExactInput(amountIn, baseForQuote);
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  return { amountOut: quote.amountOut, fee: quote.fee, amountLeft: quote.amountLeft, fillKind: fill.kind };
}

// ---------------------------------------------------------------------------
// Write builders (return unsigned transactions; the UI sends them via wallet)
// ---------------------------------------------------------------------------

export interface SwapPlan {
  quote: { amountOut: bigint; fee: bigint; amountLeft: bigint; minimumAmountOut: bigint; fillKind: string };
  transaction: AmmoraTransaction;
  approvals: readonly ERC20ApprovalRequirement[];
}

export async function planCurveSwap(
  curve: Address,
  amountIn: bigint,
  baseForQuote: boolean,
  slippageBps: number,
  recipient: Address,
): Promise<SwapPlan> {
  const sdk = curveClient(curve);
  const quote = await sdk.quoteExactInput(amountIn, baseForQuote);
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  const plan = await sdk.planSwapExactInput({
    includedAmountIn: amountIn,
    baseForQuote,
    allowPartialFill: fill.kind === "graduation-boundary",
    slippageBps,
    recipient,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
  });
  return {
    quote: { ...plan.quote, fillKind: fill.kind },
    transaction: plan.transaction,
    approvals: plan.approvalRequirements,
  };
}

export function buildApproveTx(token: Address, spender: Address, amount: bigint): AmmoraTransaction {
  return {
    to: token,
    data: ("0x095ea7b3" + spender.slice(2).padStart(64, "0") + amount.toString(16).padStart(64, "0")) as Hex,
  };
}

export interface CreateLaunchPreview {
  transaction: AmmoraTransaction;
  factory: Address;
  configId: bigint;
  poolCreationFee: bigint;
}

export function buildCreateLaunchTx(
  name: string,
  symbol: string,
  metadataURI: string,
  tokenDecimals: number,
  configId: bigint,
  poolCreationFee: bigint,
): CreateLaunchPreview {
  const transaction = buildCreateAmmoraV4Launch(
    { name, symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals },
    configId,
    poolCreationFee,
  );
  return { transaction: { to: FACTORY, ...transaction }, factory: FACTORY, configId, poolCreationFee };
}

export async function waitForLaunchCreated(
  hash: Hash,
  expectedConfigId: bigint,
  expectedConfigHash: Hex,
): Promise<{ token: Address; curve: Address; creator: Address; configId: bigint; configHash: Hex; protocolVersion: number; metadataURI: string; blockNumber: bigint }> {
  const client = getPublicClient();
  const full = await client.getTransactionReceipt({ hash });
  const created = parseAmmoraV4LaunchCreatedReceipt(full, FACTORY);
  if (created.configId !== expectedConfigId || created.configHash.toLowerCase() !== expectedConfigHash.toLowerCase()) {
    throw new Error("Launch receipt does not match the selected Config — do not trust this result.");
  }
  return {
    token: created.token,
    curve: created.curve,
    creator: created.creator,
    configId: created.configId,
    configHash: created.configHash,
    protocolVersion: created.protocolVersion,
    metadataURI: created.metadataURI,
    blockNumber: created.receiptBlockNumber,
  };
}

export async function waitForSwapReceipt(
  hash: Hash,
  curve: Address,
  trader: Address,
  recipient: Address,
  baseForQuote: boolean,
  requestedAmountIn: bigint,
  minimumAmountOut: bigint,
): Promise<{ consumedAmountIn: bigint; amountLeft: bigint; amountOut: bigint }> {
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash });
  const parsed = parseAmmoraV4SwapReceipt(receipt, curve, {
    trader,
    recipient,
    baseForQuote,
    requestedAmountIn,
    minimumAmountOut,
  });
  return { consumedAmountIn: parsed.consumedAmountIn, amountLeft: parsed.amountLeft, amountOut: parsed.amountOut };
}

// ---------------------------------------------------------------------------
// Post-graduation pool (ARL / DammV2 concentrated pool)
// ---------------------------------------------------------------------------

export function poolClient(pool: Address): DammV2Client {
  return new DammV2Client(
    getPublicClient(),
    pool,
    "concentrated",
    CONCENTRATED_FACTORY,
    CONCENTRATED_PM,
  );
}

export async function getPoolState(pool: Address): Promise<{
  baseToken: Address;
  quoteToken: Address;
  sqrtPrice: bigint;
  reserveBase: bigint;
  reserveQuote: bigint;
  totalLiquidity: bigint;
}> {
  const sdk = poolClient(pool);
  const state = await sdk.getPoolState();
  return {
    baseToken: state.baseToken,
    quoteToken: state.quoteToken,
    sqrtPrice: state.sqrtPrice,
    reserveBase: state.reserveBase,
    reserveQuote: state.reserveQuote,
    totalLiquidity: state.totalLiquidity,
  };
}

export async function quotePool(
  pool: Address,
  tokenIn: Address,
  amountIn: bigint,
): Promise<{ amountOut: bigint }> {
  const sdk = poolClient(pool);
  const q = await sdk.quoteExactInput(tokenIn, amountIn);
  return { amountOut: q.amountOut };
}

export async function planPoolSwap(
  pool: Address,
  tokenIn: Address,
  amountIn: bigint,
  slippageBps: number,
  recipient: Address,
): Promise<SwapPlan> {
  const sdk = poolClient(pool);
  const plan = await sdk.planSwapExactInput({
    tokenIn,
    amountIn,
    slippageBps,
    recipient,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
  });
  return {
    quote: {
      amountOut: plan.quote.amountOut,
      fee: 0n,
      amountLeft: 0n,
      minimumAmountOut: plan.quote.minimumAmountOut,
      fillKind: "exact-input",
    },
    transaction: plan.transaction,
    approvals: plan.approvalRequirements,
  };
}

/** Buy a graduated pool's token with native ETH (one tx, no approval). */
export function buildNativePoolBuy(
  pool: Address,
  ethAmountIn: bigint,
  minimumAmountOut: bigint,
  recipient: Address,
): AmmoraTransaction {
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  return {
    to: NATIVE_ROUTER,
    ...buildV3NativePoolExactInput(
      pool,
      ethAmountIn,
      minimumAmountOut,
      recipient,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      zero,
    ),
  };
}

export function minOut(amountOut: bigint, slippageBps: number): bigint {
  return minOutFromSlippage(amountOut, BigInt(slippageBps));
}

// ---------------------------------------------------------------------------
// WETH wrap / unwrap (standard WETH9 deposit/withdraw)
// ---------------------------------------------------------------------------

const WETH_ABI = [
  parseAbiItem("function deposit() payable"),
  parseAbiItem("function withdraw(uint256)"),
] as const;

export function buildWrapTx(amountEth: bigint): AmmoraTransaction {
  return { to: WETH, data: "0xd0e30db0" as Hex, value: amountEth };
}

export function buildUnwrapTx(amountWeth: bigint): AmmoraTransaction {
  return {
    to: WETH,
    data: ("0x2e1a7d4d" + amountWeth.toString(16).padStart(64, "0")) as Hex,
  };
}

export { AMMORA_FEE_POLICY_VERSION, ammoraLaunchFactoryV4Abi };
export type { AmmoraTransaction };
