/**
 * Error formatting for GiwaPad — pure functions, no DOM, no chain access.
 *
 * Why this module exists: injected EIP-1193 wallet providers throw
 * PLAIN OBJECTS like `{ code: 4001, message: "User rejected the request." }`,
 * not Error instances. `String(err)` on such an object renders literally as
 * "[object Object]", which is what the user saw in the header after a failed
 * Connect. Every error shown anywhere in the app must go through
 * `friendlyErrorMessage()` here, which never returns "[object Object]".
 */

/** Walk an error's `cause` chain (up to 6 deep) and call `fn` on each level. */
function walkCauses(err: unknown, fn: (e: unknown) => boolean): void {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur != null; depth++) {
    if (fn(cur)) return;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/** First numeric EIP-1193 / JSON-RPC error code found on the error or its causes, if any. */
export function providerErrorCode(err: unknown): number | null {
  let found: number | null = null;
  walkCauses(err, (cur) => {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "number") {
      found = code;
      return true;
    }
    return false;
  });
  return found;
}

/**
 * Best usable text from any thrown value: an Error's message, a plain
 * object's `message`/`shortMessage`/`details`/`reason`, a string itself, or
 * "" when nothing readable exists. Never "[object Object]".
 */
export function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err == null) return "";
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") return String(err);
  let found = "";
  walkCauses(err, (cur) => {
    const e = cur as { message?: unknown; shortMessage?: unknown; details?: unknown; reason?: unknown };
    for (const field of [e.message, e.shortMessage, e.details, e.reason]) {
      if (typeof field === "string" && field.trim().length > 0) {
        found = field;
        return true;
      }
    }
    return false;
  });
  return found;
}

/** True when an error is the public RPC's rate limit (HTTP 429 / JSON-RPC -32016 "over rate limit"). */
export function isRateLimitError(err: unknown): boolean {
  let hit = false;
  walkCauses(err, (cur) => {
    const e = cur as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; details?: unknown; shortMessage?: unknown };
    if (e.code === -32016 || e.status === 429 || e.statusCode === 429) {
      hit = true;
      return true;
    }
    for (const field of [e.message, e.details, e.shortMessage]) {
      if (typeof field === "string" && (field.includes("over rate limit") || field.includes("429"))) {
        hit = true;
        return true;
      }
    }
    return false;
  });
  return hit;
}

/**
 * True when an error means the wallet does not know the requested chain.
 * Wallets use code 4902; some vary (e.g. -32603 with an
 * "Unrecognized chain ID" message), so the message is checked too.
 */
export function isUnknownChainError(err: unknown): boolean {
  if (providerErrorCode(err) === 4902) return true;
  const text = errorText(err);
  return /unrecognized chain|unknown chain|chain .*not (found|added|recognized|exist)|does not exist|no chain with id|chain id .*not/i.test(text);
}

/**
 * Short human message for an error, in Indonesian. Raw viem dumps (request
 * bodies, docs links, JSON) and "[object Object]" are never shown.
 */
export function friendlyErrorMessage(err: unknown): string {
  if (isRateLimitError(err)) return "RPC sedang sibuk, coba lagi.";
  const code = providerErrorCode(err);
  if (code === 4001) return "Permintaan ditolak di dompet, coba lagi.";
  if (code === -32002) return "Permintaan masih menunggu di dompet — cek dompetmu.";
  if (code === 4902 || isUnknownChainError(err)) return "Dompet belum mengenal jaringan GIWA Sepolia.";
  const raw = errorText(err);
  if (/no injected wallet|window\.ethereum/i.test(raw)) {
    return "Dompet tidak ditemukan. Pasang ekstensi dompet, atau buka halaman ini di browser dompet.";
  }
  if (/timed out|timeout/i.test(raw)) return "RPC lambat, coba lagi.";
  if (/wallet_switchEthereumChain|switch.*chain|pindah chain/i.test(raw)) {
    return "Gagal pindah jaringan ke GIWA Sepolia, coba lagi.";
  }
  if (raw.length === 0) return "Terjadi kesalahan, coba lagi.";
  const firstLine = raw.split("\n")[0];
  if (firstLine.length <= 140 && !/Request body|Docs:|Raw Call Arguments|Contract Call:|HTTP request failed/.test(firstLine)) {
    return firstLine;
  }
  if (/HTTP request failed/.test(firstLine)) return "Gagal menghubungi RPC, coba lagi.";
  const cut = firstLine.split("Request body:")[0].split("Docs:")[0].trim();
  return (cut.length > 0 ? cut : "Terjadi kesalahan, coba lagi.").slice(0, 140);
}
