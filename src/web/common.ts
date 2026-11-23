/** Shared formatting + focus/live-refresh helpers for the workbench. */

export function fmtDual(isoUtc: string | null | undefined, zone: string | null | undefined): string {
  if (!isoUtc) return "unknown";
  const d = new Date(isoUtc);
  const utc = `${d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z")}`;
  if (!zone) return `${utc} UTC`;
  const local = d.toLocaleString("en-CA", { timeZone: zone, hour12: false });
  return `${local} ${zone} / ${utc}`;
}

export function fmtRemaining(ms: number): string {
  if (ms <= 0) return "cutoff passed";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h remaining` : `${h}h ${m}m remaining`;
}

export function wordDiff(a: string, b: string): { type: "same" | "del" | "ins"; text: string }[] {
  const wa = a.split(/(\s+)/), wb = b.split(/(\s+)/);
  const out: { type: "same" | "del" | "ins"; text: string }[] = [];
  const n = Math.max(wa.length, wb.length);
  for (let i = 0; i < n; i++) {
    const x = wa[i], y = wb[i];
    if (x === y) { if (x !== undefined) out.push({ type: "same", text: x }); }
    else {
      if (x !== undefined) out.push({ type: "del", text: x });
      if (y !== undefined) out.push({ type: "ins", text: y });
    }
  }
  return out;
}

export const FOCUS_KEY = "sw.focus";

export function rememberFocus(key: string) {
  try { sessionStorage.setItem(FOCUS_KEY, key); } catch { /* private mode */ }
}

/** After a re-render/refresh, put focus back on the row the analyst was using. */
export function restoreFocus(root: ParentNode | Document = document) {
  try {
    const key = sessionStorage.getItem(FOCUS_KEY);
    if (!key) return;
    const el = root.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(key)}"]`);
    el?.focus();
  } catch { /* ignore */ }
}

export function loadFilter(name: string): string {
  try { return sessionStorage.getItem(`sw.filter.${name}`) ?? ""; } catch { return ""; }
}
export function saveFilter(name: string, v: string) {
  try { sessionStorage.setItem(`sw.filter.${name}`, v); } catch { /* ignore */ }
}
