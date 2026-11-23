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
