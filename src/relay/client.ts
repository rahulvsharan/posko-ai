// Relay-aware fetch. Direct when disabled; else POST to relay with
// x-relay-target / x-relay-path. Body untouched → SSE passes through.
import { config, RELAY_MAX_TOKENS } from "../config.js";
import { log } from "../core/logger.js";
import { getRelayState } from "./state.js";

export async function relayFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const s = getRelayState();
  if (!s.enabled || !s.url) return fetch(url, opts);
  try {
    const u = new URL(url);
    const headers = new Headers(opts.headers);
    headers.set("x-relay-target", `${u.protocol}//${u.host}`);
    headers.set("x-relay-path", `${u.pathname}${u.search}`);
    return await fetch(s.url, { ...opts, headers });
  } catch (e) {
    log("warn", "relay fetch failed, falling back to direct", { url, error: String(e) });
    return fetch(url, opts);
  }
}

/** Clamp max_tokens/maxTokens for relay mode only (Vercel size limits). Mutates a copy. */
export function clampForRelay(body: Record<string, unknown>): Record<string, unknown> {
  const s = getRelayState();
  if (!s.enabled || !s.url) return body;
  const mt = (body.max_tokens ?? body.maxTokens) as number | undefined;
  if (typeof mt === "number" && mt > RELAY_MAX_TOKENS) {
    log("info", `clamped max_tokens ${mt} → ${RELAY_MAX_TOKENS} for relay`);
    return { ...body, max_tokens: RELAY_MAX_TOKENS };
  }
  return body;
}
