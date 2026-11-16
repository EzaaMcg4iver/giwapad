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
            return await base.request(args);
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

let publicClient: PublicClient | null = null;
/**
 * Default client for interactive reads (configs, quotes, balances, curve
 * state). Plain HTTP, no pacing: these are user-triggered and must not wait
 * behind the bulk launch scan.
 */
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: giwaSepolia,
      transport: http(RPC_URL, { retryCount: 1 }),
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

export async function ensureGiwaChain(): Promise<void> {
  const eth = (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum;
  if (!eth) throw new Error("No injected wallet found.");
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
    });
  } catch (err) {
    const e = err as { code?: number };
    if (e?.code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: `0x${CHAIN_ID.toString(16)}`,
          chainName: "GIWA Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER_URL],
        }],
      });
    } else {
      throw err;
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
): Promise<{ token: Address; curve: Address }> {
  const client = getPublicClient();
  const full = await client.getTransactionReceipt({ hash });
  const created = parseAmmoraV4LaunchCreatedReceipt(full, FACTORY);
  if (created.configId !== expectedConfigId || created.configHash.toLowerCase() !== expectedConfigHash.toLowerCase()) {
    throw new Error("Launch receipt does not match the selected Config — do not trust this result.");
  }
  return { token: created.token, curve: created.curve };
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
