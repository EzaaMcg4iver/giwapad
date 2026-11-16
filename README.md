# GiwaPad — Token Launchpad on GIWA Sepolia

A token launchpad web app built with the **Ammora SDK 0.3.9** on **GIWA Sepolia
testnet (chain 91342)**. Discover launches, create tokens, trade on bonding
curves, graduate to pools — all from a static frontend with no backend.

Built for the **Ammora Season 2 builder mission** ("Ship an exchange or
launchpad with the Ammora SDK").

## Features

- **Discover** — lists every launch created on the reviewed V4 auto-route
  deployment (`v4-auto-route-20260917`), found by scanning `LaunchCreated`
  events from the factory. Each card shows token name/symbol, creator, config,
  status (Active / Ready to graduate / Graduated), live price, quote reserve,
  and graduation progress. Search + filters (All / Active / Near graduation /
  Graduated / My launches).
- **Token detail + trade** — live curve state (price, reserves, fees,
  migration progress), your ETH / WETH / token balances, and:
  - **Buy / Sell on the curve** (status Active) via the SDK's
    `AmmoraV4LaunchCurveClient` — live quote preview (expected out, fee, fill
    kind, minimum out at your slippage), approval handling, receipt parsing.
  - **Wrap ETH → WETH** one-click when your WETH balance is short for a buy.
  - **Graduate** (status Ready to migrate) via `planMigrate()`.
  - **Pool trading** (status Graduated) — buy with native ETH through the
    Ammora native router, and sell tokens for WETH via `DammV2Client`
    (quote preview, approval handling, receipt confirmation).
- **Create launch** — pick an enabled V4 config from the chain, enter token
  name/symbol, review the exact transaction (factory, config hash, pool
  creation fee) before signing, then create through your connected wallet.
  The receipt is parsed and verified against the selected config.
- **Wallet** — injected EVM wallet (MetaMask / Rabby) via `window.ethereum`,
  with automatic GIWA Sepolia network switch/add.
- **No fake data** — every number on screen comes from a live chain read. If
  a read fails, the UI shows the error instead of inventing a value.

## Safety

- **No seed phrase, mnemonic, or private key is ever requested, stored, or
  used.** All writes are unsigned transactions sent through the user's own
  connected wallet, which the user approves in their wallet.
- No hardcoded keys, secrets, or wallet addresses. Reads use the public GIWA
  RPC (`https://sepolia-rpc.giwa.io`); no API keys are needed.
- Testnet only. Nothing here touches real funds.

## Run locally

Requires Node 20+ (developed and verified on Node 24.22.1).

```bash
npm ci
npm run build    # bundles src/ -> dist/ (esbuild)
npm run serve    # serves dist/ at http://localhost:4173
```

Open http://localhost:4173 in a browser with MetaMask or Rabby installed.

## Deploy

`dist/` is a fully static site (`index.html` + `styles.css` + `bundle.js`).
Deploy it to any static host (GitHub Pages, Vercel, Netlify, IPFS, …) — no
server, no environment variables, no build step on the host.

## How it works

- **Deployment:** `giwaSepoliaAutoRouteDeployment` from `@ammora-protocol/sdk`
  — factory `0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA`, config registry
  `0x6d043014972b87406C4757a5f2d655A24e0b0aF9`, fee policy
  `0x17B44C14F640fD429740FA3220f47a567c62725C`, WETH
  `0x4200000000000000000000000000000000000006`.
- **Launch discovery:** `scanAmmoraLogs` (SDK adaptive log scanner) over
  `LaunchCreated` events from the factory, starting at the deployment's start
  block (36,220,000). Results are cached in `localStorage`, so repeat visits
  only scan new blocks.
- **Prices:** curve sqrt prices are X64 fixed point; conversion uses the
  official `@ammora-protocol/math` helper `priceX128FromSqrtPriceX64`.
- **Reads are paced** (~600 ms between RPC calls) to respect the public RPC.
- **Writes:** `buildCreateAmmoraV4Launch`, `planSwapExactInput`,
  `planMigrate`, `buildV3NativePoolExactInput` — all from the SDK; the app
  only assembles and previews them.

## Verified live (2026-11-16, GIWA Sepolia)

- Core contracts verified at block 41,459,035 (`verifyAmmoraV4CoreAtBlock`).
- 29 configs registered; configs #1–#3 checked: enabled, 9 decimals,
  1 segment, pool creation fee 0.
- Full log scan found **38 launches** (factory block 36,228,313 → 41,458,606).
- Live curve read + quote on launch #1 (`Ammora Isolated V4 Canary`, AIV4C):
  status Active, price 0.000000001000000145 WETH/AIV4C, quote for a 0.01 WETH
  buy → 9,874,998 AIV4C, fee 0.000125 WETH, fill `full`.
- Production build succeeds from a clean checkout; the served page renders
  (header, tabs, wallet connect, filters) in headless Firefox.

## Not yet tested (needs a real wallet)

- Create-launch, buy/sell, wrap, and graduate **transactions** were built and
  previewed in code but never signed — no wallet was connected during
  development. They must be tried once with a funded GIWA Sepolia test
  wallet before being presented as working end-to-end.
- Post-graduation pool buy/sell paths use the same SDK builders as the
  documented examples but are likewise untested on a live graduated pool
  (no graduated launch existed on this deployment at build time).

## Known limitations

- **First load is slow:** the initial launch scan covers ~5.2M blocks.
  The raw scan took ~7.5 minutes in Node; in a browser first load it took
  ~25 minutes (the app paces RPC calls at ~600 ms to respect the public
  RPC). A progress line is shown, and cached launches render instantly on
  repeat visits thanks to the `localStorage` cache.
- Migration thresholds on the live configs are large (1,000,000 WETH), so
  most testnet launches sit at 0% graduation progress — that is real chain
  state, not a display bug.

## License

MIT
