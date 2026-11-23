import { createHash, randomUUID } from "node:crypto";

export const uuid = (): string => randomUUID();

export const sha256 = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");

/** Stable JSON: recursively sorts object keys so equivalent payloads hash identically. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export const contentDigest = (value: unknown): string => sha256(stableJson(value));
