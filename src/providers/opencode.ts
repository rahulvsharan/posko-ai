import type { GatewayProvider } from "./base.js";
import type { ProviderCtx } from "../core/types.js";
import { config } from "../config.js";
import { upstreamOf } from "../core/model-registry.js";
import { opencodeHeaders } from "../utils/headers.js";
import { relayFetch, clampForRelay } from "../relay/client.js";
import { passthroughSSE } from "../core/stream.js";

export const opencodeProvider: GatewayProvider = {
  id: "opencode",
  owns(modelId: string): boolean {
    return upstreamOf(modelId) === "opencode";
  },
  async chat(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
    const payload = clampForRelay(body);
    const isStream = payload.stream === true;
    const url = `${config.upstreamOpencode.replace(/\/$/, "")}/v1/chat/completions`;
    const upstream = await relayFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opencodeHeaders() },
      body: JSON.stringify(payload),
      signal: ctx.signal ?? AbortSignal.timeout(300_000),
    });
    if (isStream && upstream.body) return passthroughSSE(upstream);
    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") ?? "application/json";
    return new Response(text, { status: upstream.status, headers: { "content-type": ct } });
  },
  async responses(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
    const payload = { ...clampForRelay(body) };
    // pi-bansos note: suppress unsupported reasoning.effort:"none" for Muse when reasoning off
    const reasoning = payload.reasoning as Record<string, unknown> | undefined;
    if (reasoning && reasoning.effort === "none") {
      const { effort: _drop, ...rest } = reasoning;
      void _drop;
      payload.reasoning = rest;
    }
    const isStream = payload.stream === true;
    const url = `${config.upstreamOpencode.replace(/\/$/, "")}/v1/responses`;
    const upstream = await relayFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...opencodeHeaders() },
      body: JSON.stringify(payload),
      signal: ctx.signal ?? AbortSignal.timeout(300_000),
    });
    if (isStream && upstream.body) return passthroughSSE(upstream);
    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") ?? "application/json";
    return new Response(text, { status: upstream.status, headers: { "content-type": ct } });
  },
};
