import type { GatewayProvider } from "./base.js";
import type { ProviderCtx } from "../core/types.js";
import { config } from "../config.js";
import { MODEL_MAP, upstreamOf } from "../core/model-registry.js";
import { opencodeHeaders } from "../utils/headers.js";
import { relayFetch, clampForRelay } from "../relay/client.js";
import { passthroughSSE } from "../core/stream.js";

// ── Chat → Responses API bridge ──────────────────────────────────
// Models with api:"openai-responses" (e.g. muse-spark) only speak the
// Responses endpoint. Clients may send chat-completions format (dsh,
// OpenAI SDK default). This converter translates on the fly.

interface ChatContentPart {
  type: string;
  text?: string;
  image_url?: string | { url: string; detail?: string };
}

interface ResponsesContentPart {
  type: "input_text" | "input_image";
  text?: string;
  image_url?: string;
}

interface ResponsesMessage {
  type: "message";
  role: string;
  content: string | ResponsesContentPart[];
}

/** Check if a model id uses the Responses API. */
function isResponsesModel(modelId: string): boolean {
  return MODEL_MAP.get(modelId)?.api === "openai-responses";
}

/** Convert a single chat message to a Responses API message item. */
function chatMsgToResponses(msg: Record<string, unknown>): ResponsesMessage {
  const role = (msg.role as string) ?? "user";
  const content = msg.content;

  // Simple string content → string input
  if (typeof content === "string" || content == null) {
    return { type: "message", role, content: typeof content === "string" ? content : "" };
  }

  // Array of content parts → convert each
  if (Array.isArray(content)) {
    const parts: ResponsesContentPart[] = [];
    for (const part of content) {
      const p = part as ChatContentPart;
      if (p.type === "text" && typeof p.text === "string") {
        parts.push({ type: "input_text", text: p.text });
      } else if (p.type === "image_url") {
        const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
        if (url) parts.push({ type: "input_image", image_url: url });
      }
      // Skip unknown part types silently
    }
    return { type: "message", role, content: parts };
  }

  return { type: "message", role, content: "" };
}

/** Convert a chat-completions body to a Responses API body. */
function chatToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as Record<string, unknown>[] | undefined;
  if (!messages?.length) return body;

  // Fast path: single user message with string content → plain string input
  if (messages.length === 1) {
    const m = messages[0];
    if (m.role === "user" && typeof m.content === "string") {
      return { ...body, input: m.content };
    }
  }

  // General path: convert all messages
  const input: ResponsesMessage[] = messages.map(chatMsgToResponses);
  const out: Record<string, unknown> = { ...body, input };
  delete out.messages;
  // Map max_tokens → max_output_tokens for Responses API
  if (typeof out.max_tokens === "number") {
    out.max_output_tokens = out.max_tokens;
    delete out.max_tokens;
  }
  return out;
}

export const opencodeProvider: GatewayProvider = {
  id: "opencode",
  owns(modelId: string): boolean {
    return upstreamOf(modelId) === "opencode";
  },
  async chat(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
    const modelId = body.model as string;

    // Bridge: Responses API models → translate chat format to responses format
    if (isResponsesModel(modelId)) {
      const responsesBody = chatToResponses(body);
      return opencodeProvider.responses!(responsesBody, ctx);
    }

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
