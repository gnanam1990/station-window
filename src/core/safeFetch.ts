import { isIP } from "node:net";
import dns from "node:dns/promises";

export class FetchPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FetchPolicyError";
  }
}

/** Redacted reason only — never include the attempted host/IP beyond a coarse class. */
export function redactFetchReason(err: unknown): string {
  if (err instanceof FetchPolicyError) return `fetch_policy:${err.code}`;
  if (err instanceof Error && err.name === "AbortError") return "fetch_policy:timeout";
  return "fetch_policy:fetch_failed";
}

function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) {
    const p = ip.split(".").map(Number);
    return (
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 169 && p[1] === 254) || // link-local / cloud metadata
      p[0] === 0 ||
      p[0]! >= 224
    );
  }
  if (fam === 6) {
    const s = ip.toLowerCase();
    return (
      s === "::1" || s === "::" ||
      s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd") ||
      s.startsWith("::ffff:127.") || s.startsWith("::ffff:10.") ||
      s.startsWith("::ffff:192.168.") || s.startsWith("::ffff:169.254.") ||
      s.startsWith("::ffff:172.")
    );
  }
  return true; // unparsable → treat as private
}

/**
 * Guarded vendor fetch: HTTPS only, host must be allowlisted, resolved IPs checked
 * against private/link-local ranges, redirects refused (a redirect target is a new,
 * unverified authority), bounded bytes, bounded runtime. Body returned as text.
 */
export async function safeFetch(
  url: string,
  opts: {
    allowedHosts: string[];
    maxBytes: number;
    timeoutMs: number;
    resolve?: (host: string) => Promise<string[]>;
    fetchImpl?: typeof fetch;
    skipDnsCheck?: boolean; // unit tests inject loopback fixture servers explicitly
  },
): Promise<{ status: number; body: string; url: string; headers: Record<string, string> }> {
  const u = new URL(url);
  if (u.protocol !== "https:" && !opts.skipDnsCheck)
    throw new FetchPolicyError("scheme", "only https sources are permitted");
  const host = u.hostname.toLowerCase();
  if (!opts.allowedHosts.map((h) => h.toLowerCase()).includes(host))
    throw new FetchPolicyError("host_not_allowed", "source host is not in the registered allowlist");

  if (!opts.skipDnsCheck) {
    const ips = isIP(host)
      ? [host]
      : await (opts.resolve ?? ((h: string) => dns.resolve4(h).then((v4) => v4).catch(() => dns.resolve6(h))))(host).catch(
          () => [] as string[],
        );
    if (ips.length === 0) throw new FetchPolicyError("dns", "source host did not resolve");
    if (ips.some(isPrivateIp)) throw new FetchPolicyError("private_ip", "source resolves to a non-public address");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const res = await fetchImpl(url, { redirect: "manual", signal: ac.signal });
    if (res.status >= 300 && res.status < 400)
      throw new FetchPolicyError("redirect", "source issued a redirect; redirect targets are not auto-followed");
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > opts.maxBytes) throw new FetchPolicyError("too_large", "source body exceeds download bound");
    const body = await res.text();
    if (body.length > opts.maxBytes) throw new FetchPolicyError("too_large", "source body exceeds download bound");
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, body, url, headers };
  } finally {
    clearTimeout(timer);
  }
}
