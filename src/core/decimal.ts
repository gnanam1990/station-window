/**
 * Exact decimal comparison without binary float error.
 * Values are stored/compared as exact decimal strings parsed into (sign, digits, scale).
 * Comparison of arbitrary-precision decimals done via scaled BigInt on a common scale.
 */

export interface Decimal {
  neg: boolean;
  int: string;
  frac: string;
}

export function parseDecimal(s: string): Decimal | null {
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  return { neg: m[1] === "-", int: m[2]!.replace(/^0+(?=\d)/, ""), frac: m[3] ?? "" };
}

function toBigIntScaled(d: Decimal, scale: number): bigint {
  const frac = (d.frac + "0".repeat(scale)).slice(0, scale);
  const v = BigInt(d.int + (frac || ""));
  return d.neg && v !== 0n ? -v : v;
}

/** Compare two exact decimal strings. Returns -1 | 0 | 1, or null if unparseable. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 | null {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  if (!da || !db) return null;
  const scale = Math.max(da.frac.length, db.frac.length);
  const va = toBigIntScaled(da, scale);
  const vb = toBigIntScaled(db, scale);
  return va < vb ? -1 : va > vb ? 1 : 0;
}

export type Operator = "lt" | "lte" | "gt" | "gte" | "eq" | "neq";

export function applyOperator(op: Operator, value: string, threshold: string): boolean | null {
  const c = compareDecimal(value, threshold);
  if (c === null) return null;
  switch (op) {
    case "lt": return c < 0;
    case "lte": return c <= 0;
    case "gt": return c > 0;
    case "gte": return c >= 0;
    case "eq": return c === 0;
    case "neq": return c !== 0;
  }
}

/** Decimal-string addition with exactness via common scale. */
export function addDecimal(a: string, b: string): string {
  const da = parseDecimal(a)!;
  const db = parseDecimal(b)!;
  const scale = Math.max(da.frac.length, db.frac.length, 1);
  const v = toBigIntScaled(da, scale) + toBigIntScaled(db, scale);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(scale + 1, "0");
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** a/b rounded half-away-from-zero to `places` decimals; null when unparseable or b=0. */
export function divDecimal(a: string, b: string, places = 10): string | null {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  if (!da || !db) return null;
  const va = toBigIntScaled(da, da.frac.length);
  const vb = toBigIntScaled(db, db.frac.length);
  if (vb === 0n) return null;
  const neg = (va < 0n) !== (vb < 0n);
  const absA = va < 0n ? -va : va;
  const absB = vb < 0n ? -vb : vb;
  const num = absA * 10n ** BigInt(places + db.frac.length);
  const den = absB * 10n ** BigInt(da.frac.length);
  let q = num / den;
  if ((num % den) * 2n >= den) q += 1n;
  const s = q.toString().padStart(places + 1, "0");
  const int = s.slice(0, s.length - places);
  const frac = s.slice(s.length - places).replace(/0+$/, "");
  return `${neg && q !== 0n ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** Exact max/min over decimal strings. */
export function maxDecimal(vals: string[]): string | null {
  let best: string | null = null;
  for (const v of vals) if (best === null || compareDecimal(v, best) === 1) best = v;
  return best;
}
export function minDecimal(vals: string[]): string | null {
  let best: string | null = null;
  for (const v of vals) if (best === null || compareDecimal(v, best) === -1) best = v;
  return best;
}
export function meanDecimal(vals: string[]): string | null {
  if (vals.length === 0) return null;
  const sum = vals.reduce((a, v) => addDecimal(a, v), "0");
  return divDecimal(sum, String(vals.length), 10);
}

/** Decimal-string subtraction with exactness via common scale. */
export function subDecimal(a: string, b: string): string {
  const da = parseDecimal(a)!;
  const db = parseDecimal(b)!;
  const scale = Math.max(da.frac.length, db.frac.length, 1);
  const v = toBigIntScaled(da, scale) - toBigIntScaled(db, scale);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = abs.toString().padStart(scale + 1, "0");
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}
