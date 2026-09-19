import type { GatewayProvider } from "./base.js";
import type { ProviderCtx } from "../core/types.js";
import { config } from "../config.js";
import { MODEL_MAP, upstreamOf } from "../core/model-registry.js";
import {
  assembleChatCompletion,
  assembleResponses,
  mintMessageId,
  mintSessionId,
  responsesJsonToChatCompletion,
  responsesSseToChatSse,
  wrapChatForZen,
  wrapResponsesForZen,
  zenHeaders,
} from "./zen-identity.js";
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

/** Convert a chat-completions body to a Responses API body. Exported for tests. */
export function chatToResponses(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as Record<string, unknown>[] | undefined;
  if (!messages?.length) return body;

  let input: unknown;
  // Fast path: single user message with string content → plain string input
  if (messages.length === 1) {
    const m = messages[0];
    if (m.role === "user" && typeof m.content === "string") {
      input = m.content;
    }
  }
  // General path: convert all messages
  if (input === undefined) {
    input = messages.map(chatMsgToResponses);
  }
  const out: Record<string, unknown> = { ...body, input };
  delete out.messages;
  // Map max_tokens → max_output_tokens for Responses API
  if (typeof out.max_tokens === "number") {
    out.max_output_tokens = out.max_tokens;
    delete out.max_tokens;
  }
  return out;
}

/** Wrap + POST to the Zen responses endpoint; returns the raw upstream. */
async function postResponsesApi(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
  const sessionId = mintSessionId();
  const payload = { ...clampForRelay(wrapResponsesForZen(body, sessionId)) };
  // pi-bansos note: suppress unsupported reasoning.effort:"none" for Muse when reasoning off
  const reasoning = payload.reasoning as Record<string, unknown> | undefined;
  if (reasoning && reasoning.effort === "none") {
    const { effort: _drop, ...rest } = reasoning;
    void _drop;
    payload.reasoning = rest;
  }
  const url = `${config.upstreamOpencode.replace(/\/$/, "")}/v1/responses`;
  return relayFetch(url, {
    method: "POST",
    headers: zenHeaders(sessionId, mintMessageId()),
    body: JSON.stringify(payload),
    signal: cappedSignal(ctx),
  });
}

/** Cap every upstream call: silent-forever streams must fail, not hang. */
function cappedSignal(ctx: ProviderCtx, ms = 300_000): AbortSignal {
  const cap = AbortSignal.timeout(ms);
  return ctx.signal ? AbortSignal.any([ctx.signal, cap]) : cap;
}

/**
 * Chat-protocol client talking to a responses-only model: convert outbound
 * (chatToResponses) and translate the responses SSE/JSON back to chat shapes.
 */
async function chatViaResponses(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
  const modelId = body.model as string;
  const clientWantsStream = body.stream === true;
  const attempt = () => postResponsesApi(chatToResponses(body), ctx);
  const upstream = await attempt();
  if (!upstream.ok) {
    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") ?? "application/json";
    return new Response(text, { status: upstream.status, headers: { "content-type": ct } });
  }
  if (clientWantsStream && upstream.body) {
    // Stalled generations are per-request upstream flakiness: swap in a
    // fresh attempt transparently instead of hanging the client stream.
    // 30s silence (no deltas — keepalives don't count) × 3 attempts keeps
    // worst case ~90s, inside Hermes' patience window.
    return responsesSseToChatSse(upstream, modelId, {
      stallTimeoutMs: 30_000,
      maxStallRetries: 2,
      onStallRetry: attempt,
    });
  }
  const text = await upstream.text();
  const assembled = assembleResponses(text);
  if (assembled) return Response.json(responsesJsonToChatCompletion(assembled, modelId), { status: 200 });
  return new Response(text, { status: upstream.status, headers: { "content-type": "text/event-stream" } });
}

export const opencodeProvider: GatewayProvider = {  id: "opencode",
  owns(modelId: string): boolean {
    return upstreamOf(modelId) === "opencode";
  },
  async chat(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
    const modelId = body.model as string;

    // Bridge: Responses API models speak the responses endpoint upstream, but
    // the client speaks chat — translate the protocol back on the way out.
    if (isResponsesModel(modelId)) {
      return chatViaResponses(body, ctx);
    }

    // Zen free tier only answers stream:true requests that carry the exact
    // opencode system prompt + tools (see zen-identity.ts). Always request
    // SSE upstream; assemble a single JSON object when the client asked for
    // non-streaming.
    const clientWantsStream = body.stream === true;
    const payload = clampForRelay(wrapChatForZen(body));
    const url = `${config.upstreamOpencode.replace(/\/$/, "")}/v1/chat/completions`;
    const upstream = await relayFetch(url, {
      method: "POST",
      headers: zenHeaders(mintSessionId(), mintMessageId()),
      body: JSON.stringify(payload),
      signal: cappedSignal(ctx),
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      const ct = upstream.headers.get("content-type") ?? "application/json";
      return new Response(text, { status: upstream.status, headers: { "content-type": ct } });
    }
    if (clientWantsStream && upstream.body) return passthroughSSE(upstream);
    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      try {
        const maybe = JSON.parse(text) as Record<string, unknown>;
        if (maybe.object === "chat.completion") {
          return new Response(text, { status: upstream.status, headers: { "content-type": "application/json" } });
        }
      } catch {
        // fall through to SSE assembly
      }
    }
    const assembled = assembleChatCompletion(text, modelId);
    return Response.json(assembled, { status: 200 });
  },
  async responses(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response> {
    const upstream = await postResponsesApi(body, ctx);
    const clientWantsStream = body.stream === true;
    if (!upstream.ok) {
      const text = await upstream.text();
      const ct = upstream.headers.get("content-type") ?? "application/json";
      return new Response(text, { status: upstream.status, headers: { "content-type": ct } });
    }
    if (clientWantsStream && upstream.body) return passthroughSSE(upstream);
    const text = await upstream.text();
    const assembled = assembleResponses(text);
    if (assembled) return Response.json(assembled, { status: 200 });
    return new Response(text, { status: upstream.status, headers: { "content-type": "text/event-stream" } });
  },
};
