/** Canonical unit conversion. Unsupported pairs return null — never guess. */

// factors are "units per base unit" — inBase = n / factor[from]; out = inBase * factor[to]
const FACTORS: Record<string, Record<string, number>> = {
  temperature: { degC: 1, degF: NaN, K: NaN }, // F/K handled by formula below
  length: { m: 1, mm: 1000, cm: 100, km: 0.001, ft: 3.2808398950131, nmi: 1 / 1852 },
};

const DIMENSION: Record<string, keyof typeof FACTORS> = {
  degC: "temperature", degF: "temperature", K: "temperature",
  m: "length", mm: "length", cm: "length", ft: "length", km: "length", nmi: "length",
};

export function dimensionOf(unit: string): string | null {
  return DIMENSION[unit] ?? null;
}

/** Exact-ish conversion to canonical target; temperature uses affine formulas. */
export function convertUnit(value: string, from: string, to: string): string | null {
  if (from === to) return value;
  const dimFrom = DIMENSION[from];
  const dimTo = DIMENSION[to];
  if (!dimFrom || !dimTo || dimFrom !== dimTo) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (dimFrom === "temperature") {
    let c: number;
    if (from === "degC") c = n;
    else if (from === "degF") c = ((n - 32) * 5) / 9;
    else if (from === "K") c = n - 273.15;
    else return null;
    let out: number;
    if (to === "degC") out = c;
    else if (to === "degF") out = (c * 9) / 5 + 32;
    else if (to === "K") out = c + 273.15;
    else return null;
    return trimNum(out);
  }
  // ratio-based dimensions
  const fFrom = FACTORS[dimFrom]![from]!;
  const fTo = FACTORS[dimTo]![to]!;
  const inBase = n / fFrom; // to base unit
  const out = inBase * fTo;
  return trimNum(out);
}

function trimNum(n: number): string {
  // 10 significant decimals, trimmed — enough for meteorological precision without float noise
  const s = n.toPrecision(12);
  return String(Number(s));
}
