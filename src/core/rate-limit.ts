// In-memory per-upstream rate limiter. Port of pi-bansos checkRateLimit().
import type { Upstream } from "./types.js";
import { config } from "../config.js";

interface Entry {
  count: number;
  resetAt: number;
}

const store = new Map<string, Entry>();

export function rateLimitResetAt(upstream: Upstream, now: number): number {
  if (upstream === "kilo") return now + 60 * 60_000;
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function key(upstream: Upstream, ip: string, now: number): string {
  if (upstream === "kilo") return `${upstream}:${ip}`;
  return `${upstream}:${new Date(now).toISOString().slice(0, 10)}:${ip}`;
}

export function checkRateLimit(ip: string, upstream: Upstream, now = Date.now()): boolean {
  const max = upstream === "kilo" ? config.rateKiloHour : config.rateOpencodeDay;
  const k = key(upstream, ip, now);
  const e = store.get(k);
  if (!e || e.resetAt <= now) {
    store.set(k, { count: 1, resetAt: rateLimitResetAt(upstream, now) });
    return true;
  }
  if (e.count >= max) return false;
  e.count++;
  return true;
}

export function resetRateLimits(): void {
  store.clear();
}
