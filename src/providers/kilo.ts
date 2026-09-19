import type { GatewayProvider } from "./base.js";
import type { ProviderCtx } from "../core/types.js";
import { config } from "../config.js";
import { upstreamOf } from "../core/model-registry.js";
import { relayFetch, clampForRelay } from "../relay/client.js";
import { passthroughSSE } from "../core/stream.js";

export function kiloChatUrl(): string {
  return `${config.upstreamKilo.replace(/\/$/, "")}/chat/completions`;
}

export const kiloProvider: GatewayProvider = {
  id: "kilo",
  owns(modelId: string): boolean {
    return upstreamOf(modelId) === "kilo";
  },
  async chat(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
    const payload = { ...clampForRelay(body) };
    // Kilo rejects the non-standard flat alias when it conflicts with the
    // nested object (Hermes sends both). The nested `reasoning` stays.
    delete payload.reasoning_effort;
    const isStream = payload.stream === true;
    const upstream = await relayFetch(kiloChatUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer kilo-free" },
      body: JSON.stringify(payload),
      signal: ctx.signal ?? AbortSignal.timeout(300_000),
    });
    // §12.1: stream → passthrough body directly, never text()
    if (isStream && upstream.body) return passthroughSSE(upstream);
    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") ?? "application/json";
    return new Response(text, { status: upstream.status, headers: { "content-type": ct } });
  },
};
