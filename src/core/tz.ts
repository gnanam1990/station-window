/** IANA-zone local-day window math via Intl. Half-open [startUtc, endUtc). */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(zone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    dtfCache.set(zone, f);
  }
  return f;
}

/** Offset (zone local minus UTC) in ms at instant `utc`. */
export function zoneOffsetMs(zone: string, utc: Date): number {
  const parts = dtf(zone).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(utc.getTime() / 1000) * 1000;
}

/** Convert a local wall time in `zone` to UTC. Two refinement passes handle DST edges. */
export function localToUtc(
  zone: string,
  y: number, mo: number, d: number, hh = 0, mm = 0, ss = 0,
): Date {
  let guess = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss));
  for (let i = 0; i < 3; i++) {
    const off = zoneOffsetMs(zone, guess);
    guess = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss) - off);
  }
  return guess;
}

export interface DayDefinition {
  type: "civil" | "climatological" | "utc_offset" | string;
  /** climatological: local end time "HH:MM" — window is [prev-day end, day end). */
  endTime?: string;
  /** utc_offset: fixed minutes east of UTC. */
  offsetMinutes?: number;
}

export interface DayWindow {
  startUtc: Date;
  endUtc: Date;
  kind: string;
}

function nextLocalDate(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return t.toISOString().slice(0, 10);
}

function parseDay(localDate: string): [number, number, number] {
  const [y, m, d] = localDate.split("-").map(Number);
  return [y!, m!, d!];
}

function parseHHMM(t: string | undefined, fallback: [number, number]): [number, number] {
  if (!t) return fallback;
  const [h, m] = t.split(":").map(Number);
  return [h ?? 0, m ?? 0];
}

/**
 * Resolve a rule's declared local-day definition to UTC bounds.
 * Returns null for unsupported definitions (caller maps to UNRESOLVED).
 * Never infers coverage by counting rows — this is a boundary only.
 */
export function localDayWindow(zone: string, localDate: string, def: DayDefinition): DayWindow | null {
  const [y, mo, d] = parseDay(localDate);
  if (def.type === "civil") {
    const start = localToUtc(zone, y, mo, d);
    const [y2, mo2, d2] = parseDay(nextLocalDate(localDate, 1));
    const end = localToUtc(zone, y2, mo2, d2);
    return { startUtc: start, endUtc: end, kind: "civil" };
  }
  if (def.type === "climatological") {
    const [eh, em] = parseHHMM(def.endTime, [7, 0]);
    const [py, pmo, pd] = parseDay(nextLocalDate(localDate, -1));
    const start = localToUtc(zone, py, pmo, pd, eh, em);
    const end = localToUtc(zone, y, mo, d, eh, em);
    return { startUtc: start, endUtc: end, kind: `climatological:${def.endTime ?? "07:00"}` };
  }
  if (def.type === "utc_offset" && typeof def.offsetMinutes === "number") {
    const off = def.offsetMinutes * 60_000;
    const start = new Date(Date.UTC(y, mo - 1, d) - off);
    const end = new Date(start.getTime() + 24 * 3600_000);
    return { startUtc: start, endUtc: end, kind: `utc_offset:${def.offsetMinutes}` };
  }
  return null;
}
