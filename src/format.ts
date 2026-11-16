/**
 * ONE shared display formatter for every number the UI shows — prices,
 * market caps, volumes, balances, quote amounts. Display only; the chain
 * math underneath stays exact (bigint / formatUnits).
 *
 * Rules:
 * - NEVER emits e-notation. Anywhere. (That was the bug: 2.00e-11 WETH,
 *   2.0e-5 ETH on the detail stats.)
 * - Normal numbers (>= ~0.001): thousands separators, sensible decimals
 *   (>= 1000: at most 2 decimals; 1–1000: at most 4; 0.001–1: at most 6),
 *   trailing zeros trimmed. ~4–6 significant digits.
 * - Small numbers: full decimal expansion while it stays short
 *   (2.0e-5 -> "0.00002"); Dexscreener-style subscript-zero notation once
 *   there are 5+ leading zeros (2e-11 -> "0.0₁₀2", 1.23e-8 -> "0.0₇123").
 *   The subscripts are plain Unicode digits, so the string works in DOM
 *   text, SVG chart labels, and titles alike.
 * - Units are added by the caller (WETH / ETH / token symbol).
 */

const SUB_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

function subDigits(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUB_DIGITS[Number(d)])
    .join("");
}

/** "1.2300" -> "1.23"; "100.0000" -> "100"; "0.00002" stays. */
function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

export function formatDisplayNumber(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const neg = v < 0;
  const a = Math.abs(v);
  let out: string;
  if (a >= 1000) {
    out = a.toLocaleString("en-US", { maximumFractionDigits: 2 });
  } else if (a >= 1) {
    const s = trimZeros(a.toFixed(4));
    // Rounding can push a value just under 1000 over it (999.99999 -> "1000").
    out = Number(s) >= 1000 ? Number(s).toLocaleString("en-US", { maximumFractionDigits: 2 }) : s;
  } else if (a >= 0.001) {
    out = trimZeros(a.toFixed(6));
  } else {
    // Tiny: toExponential gives mantissa + exponent (computation only — the
    // result never shows e-notation). zeros = leading zeros after "0.".
    const [mant, exp] = a.toExponential(3).split("e");
    const zeros = -Number(exp) - 1;
    const sig = mant.replace(".", "").replace(/0+$/, "") || "0";
    if (zeros <= 4) {
      // Short enough to spell out: 2.0e-5 -> "0.00002".
      out = trimZeros(a.toFixed(zeros + sig.length));
    } else {
      // Many leading zeros: subscript notation, 0.0₁₀2 = 0.00000000002.
      out = `0.0${subDigits(zeros)}${sig}`;
    }
  }
  return neg ? `-${out}` : out;
}
