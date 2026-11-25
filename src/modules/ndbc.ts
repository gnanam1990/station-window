/**
 * NDBC realtime2 parser (parser version ndbc-realtime2/1).
 * Header-driven: field names come from the first '#' line and units from the
 * second, so column order and extra variables (WDIR, PTDY, ...) are honored.
 *   #YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
 *   #yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa    ft
 * Documented missing token: literal "MM". Nothing else is treated as missing,
 * and no sentinel is ever coerced to numeric zero.
 */

export const NDBC_PARSER_VERSION = "ndbc-realtime2/1";

export const NDBC_VARIABLES: Record<string, { unit: string; canonical: string; label: string }> = {
  WDIR: { unit: "degT", canonical: "degT", label: "wind direction" },
  WSPD: { unit: "m/s", canonical: "m/s", label: "wind speed" },
  GST: { unit: "m/s", canonical: "m/s", label: "wind gust" },
  WVHT: { unit: "m", canonical: "m", label: "significant wave height" },
  DPD: { unit: "sec", canonical: "sec", label: "dominant wave period" },
  APD: { unit: "sec", canonical: "sec", label: "average wave period" },
  MWD: { unit: "degT", canonical: "degT", label: "mean wave direction" },
  PRES: { unit: "hPa", canonical: "hPa", label: "barometric pressure" },
  ATMP: { unit: "degC", canonical: "degC", label: "air temperature" },
  WTMP: { unit: "degC", canonical: "degC", label: "sea surface temperature" },
  DEWP: { unit: "degC", canonical: "degC", label: "dewpoint" },
  VIS: { unit: "nmi", canonical: "nmi", label: "visibility" },
  PTDY: { unit: "hPa", canonical: "hPa", label: "pressure tendency" },
  TIDE: { unit: "ft", canonical: "ft", label: "tide" },
};

export interface NdbcRow {
  observedAt: Date; // UTC, precision minute
  fields: Record<string, string>; // header-named values
  lineLocator: string;
}

export interface ParsedFeed {
  rows: NdbcRow[];
  fieldNames: string[];
  units: Record<string, string>;
  stationHeader?: string;
  skippedLines: number;
}

function headerTokens(line: string): string[] {
  return line.replace(/^#+\s*/, "").trim().split(/\s+/);
}

export function parseNdbcRealtime2(body: string): ParsedFeed {
  const lines = body.split(/\r?\n/);
  let fieldNames: string[] = [];
  let units: Record<string, string> = {};
  let stationHeader: string | undefined;
  let headerCount = 0;
  const rows: NdbcRow[] = [];
  let skippedLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (line.startsWith("#")) {
      headerCount++;
      if (headerCount === 1) {
        stationHeader = line.trim();
        fieldNames = headerTokens(line);
      } else if (headerCount === 2) {
        const u = headerTokens(line);
        fieldNames.forEach((name, idx) => {
          units[name] = u[idx] ?? "";
        });
      }
      continue;
    }
    const tok = line.trim().split(/\s+/);
    if (tok.length < 5 || fieldNames.length < 5) {
      if (tok.length > 0) skippedLines++;
      continue;
    }
    // calendar components are validated before Date.UTC can roll them over
    const [yTok, moTok, dTok, hTok, miTok] = tok;
    if (!/^\d{4}$|^\d{2}$/.test(yTok!) || !/^\d{1,2}$/.test(moTok!) || !/^\d{1,2}$/.test(dTok!)
      || !/^\d{1,2}$/.test(hTok!) || !/^\d{1,2}$/.test(miTok!)) {
      skippedLines++;
      continue;
    }
    const year = yTok!.length === 4 ? Number(yTok) : Number(yTok) >= 70 ? 1900 + Number(yTok) : 2000 + Number(yTok);
    const mo = Number(moTok);
    const dd = Number(dTok);
    const hh = Number(hTok);
    const mn = Number(miTok);
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mn > 59) {
      skippedLines++;
      continue;
    }
    const observedAt = new Date(Date.UTC(year, mo - 1, dd, hh, mn));
    // round-trip check catches 31 Feb etc. rolling into another month
    if (
      observedAt.getUTCFullYear() !== year ||
      observedAt.getUTCMonth() !== mo - 1 ||
      observedAt.getUTCDate() !== dd ||
      observedAt.getUTCHours() !== hh ||
      observedAt.getUTCMinutes() !== mn
    ) {
      skippedLines++;
      continue;
    }
    const fields: Record<string, string> = {};
    for (let c = 5; c < fieldNames.length; c++) fields[fieldNames[c]!] = tok[c] ?? "MM";
    rows.push({ observedAt, fields, lineLocator: `line:${i + 1}` });
  }
  return { rows, fieldNames, units, stationHeader, skippedLines };
}

export interface ExtractedValue {
  valueText: string;
  valueNum: string | null; // exact decimal string; null = missing/invalid, never zero
  unit: string;
  canonicalUnit: string;
  quality: "good" | "suspect" | "missing" | "bad";
  qcFlag: string | null;
}

/** Documented realtime2 missing token. Other sentinels are not invented. */
const MISSING = "MM";

/** Per-variable numeric sanity from NDBC measurement definitions (physical domain). */
const VARIABLE_RANGES: Record<string, [number, number]> = {
  WDIR: [0, 360],
  MWD: [0, 360],
  WVHT: [0, 60],
  WSPD: [0, 200],
  GST: [0, 200],
  DPD: [0, 60],
  APD: [0, 60],
  PRES: [800, 1100],
  ATMP: [-60, 60],
  WTMP: [-5, 45],
  DEWP: [-60, 60],
};

export function extractVariable(row: NdbcRow, variable: string, units?: Record<string, string>): ExtractedValue | null {
  const meta = NDBC_VARIABLES[variable];
  if (!meta) return null;
  const raw = row.fields[variable] ?? MISSING;
  const unit = units?.[variable] || meta.unit;
  if (raw === MISSING || raw === "")
    return { valueText: raw, valueNum: null, unit, canonicalUnit: meta.canonical, quality: "missing", qcFlag: null };
  if (!/^[+-]?\d+(\.\d+)?$/.test(raw))
    return { valueText: raw, valueNum: null, unit, canonicalUnit: meta.canonical, quality: "bad", qcFlag: "non_numeric" };
  const range = VARIABLE_RANGES[variable];
  if (range) {
    const n = Number(raw);
    if (n < range[0] || n > range[1])
      return { valueText: raw, valueNum: null, unit, canonicalUnit: meta.canonical, quality: "suspect", qcFlag: "out_of_range" };
  }
  return { valueText: raw, valueNum: raw, unit, canonicalUnit: meta.canonical, quality: "good", qcFlag: null };
}
