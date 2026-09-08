// Header helpers. Port of pi-bansos sanitizeHeaders() + opencodeHeaders().
import { randomUUID } from "node:crypto";

const SESSION = randomUUID();
const STRIP = new Set([
  "authorization",
  "host",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-client-ip",
  "x-originate-ip",
  "cookie",
  "set-cookie",
  "proxy-connection",
  "proxy-authorization",
  "content-length",
]);

export function opencodeHeaders(): Record<string, string> {
  return {
    "User-Agent": "opencode/latest/1.14.50/cli",
    "x-opencode-client": "cli",
    "x-opencode-project": "default",
    "x-opencode-session": SESSION,
    "x-opencode-request": randomUUID(),
  };
}

/** Strip client secrets, retarget host, inject opencode identity. */
export function sanitizeHeaders(incoming: Headers, targetHost: string, extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  incoming.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIP.has(lower) || lower.startsWith(":")) return;
    out[lower] = value;
  });
  out.host = targetHost;
  Object.assign(out, opencodeHeaders());
  out["accept-encoding"] = "identity";
  if (extra) Object.assign(out, extra);
  return out;
}

export function clientIp(req: Request, fallback = "unknown"): string {
  // Bun/Hono: no direct socket ip on Request; use forwarded header if present, else fallback.
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || fallback;
}
