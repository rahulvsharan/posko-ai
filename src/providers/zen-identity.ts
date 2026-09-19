// Zen free-tier identity: makes gateway requests look like they come from
// within OpenCode. Upstream (opencode.ai Console) rejects free-tier inference
// with 403 FreeTierError unless the request carries:
//   - current opencode UA + x-opencode-* headers with fresh time-ordered ids
//     (port of opencode packages/schema/src/identifier.ts)
//   - stream:true
//   - the exact opencode system/developer prompt + exact tool definitions
//     (see zen-fingerprint.ts); user messages and sampling params stay free.
import { ZEN_CHAT_SYSTEM, ZEN_CHAT_TOOLS, ZEN_RESP_DEVELOPER, ZEN_RESP_TOOLS } from "./zen-fingerprint.js";

const ID_LEN = 26;
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTs = 0;
let counter = 0;

function createId(descending: boolean, timestamp = Date.now()): string {
  if (timestamp !== lastTs) {
    lastTs = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = descending ? ~current : current;
  let time = "";
  for (let i = 0; i < 6; i++) {
    time += Number((value >> BigInt(40 - 8 * i)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  const rand = crypto.getRandomValues(new Uint8Array(ID_LEN - 12));
  return time + Array.from(rand, (b) => ID_CHARS[b % 62]).join("");
}

/** ses_* ids use descending order, msg_* ascending — mirrors opencode. */
export function mintSessionId(): string {
  return "ses_" + createId(true);
}

export function mintMessageId(): string {
  return "msg_" + createId(false);
}

const FALLBACK_OPENCODE_VERSION = "1.18.31";
let cachedVersion: string | null = null;

/** Installed opencode version for the UA gate (426 on stale versions). */
export function opencodeVersion(): string {
  if (cachedVersion) return cachedVersion;
  const fromEnv = (Bun.env.OPENCODE_VERSION ?? "").trim();
  if (fromEnv) {
    cachedVersion = fromEnv;
    return cachedVersion;
  }
  try {
    const proc = Bun.spawnSync(["opencode", "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = proc.stdout?.toString().trim() ?? "";
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    if (m) {
      cachedVersion = m[1];
      return cachedVersion;
    }
  } catch {
    // fall through to bundled fallback
  }
  cachedVersion = FALLBACK_OPENCODE_VERSION;
  return cachedVersion;
}

export function zenUserAgent(): string {
  return `opencode/${opencodeVersion()} ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`;
}

export function zenHeaders(sessionId: string, requestId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": zenUserAgent(),
    "x-opencode-client": "cli",
    "x-opencode-project": "global",
    "x-opencode-session": sessionId,
    "x-opencode-request": requestId,
  };
}

function isFingerprintSystem(msg: unknown): boolean {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as Record<string, unknown>).role === "system" &&
    (msg as Record<string, unknown>).content === ZEN_CHAT_SYSTEM
  );
}

/**
 * Wrap a chat-completions body for Zen: force streaming, prepend the exact
 * opencode system prompt (unless already present), pin the exact tool set
 * with tool_choice "none" so models answer in text. Client messages and
 * sampling params (temperature, max_tokens, …) pass through untouched.
 */
export function wrapChatForZen(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? [...(body.messages as unknown[])] : [];
  if (!messages.some(isFingerprintSystem)) {
    messages.unshift({ role: "system", content: ZEN_CHAT_SYSTEM });
  }
  // Drop the non-standard flat alias (some clients send both this and the
  // nested `reasoning` object with conflicting values); keep `reasoning`.
  const { reasoning_effort: _drop, ...rest } = body;
  void _drop;
  return {
    ...rest,
    stream: true,
    messages,
    tools: ZEN_CHAT_TOOLS,
    tool_choice: "none",
  };
}

function isFingerprintDeveloper(item: unknown): boolean {
  return (
    typeof item === "object" &&
    item !== null &&
    (item as Record<string, unknown>).role === "developer" &&
    (item as Record<string, unknown>).content === ZEN_RESP_DEVELOPER
  );
}

function toResponsesItems(input: unknown): unknown[] {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "input_text", text: input }] }];
  }
  if (Array.isArray(input)) return [...input];
  return [{ role: "user", content: [{ type: "input_text", text: "" }] }];
}

/**
 * Wrap a responses body for Zen: prepend the exact developer instructions,
 * pin tools + tool_choice auto (the endpoint rejects "none"), force
 * streaming, key the prompt cache to this session.
 */
export function wrapResponsesForZen(body: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  const items = toResponsesItems(body.input);
  if (!items.some(isFingerprintDeveloper)) {
    items.unshift({ role: "developer", content: ZEN_RESP_DEVELOPER });
  }
  // Same flat-alias drop as chat: Zen rejects unknown parameters.
  // Also drop response_format: the responses endpoint rejects it and some
  // clients (Hermes title calls) attach it to every request.
  const { reasoning_effort: _drop, response_format: _dropFmt, ...rest } = body;
  void _drop;
  void _dropFmt;
  return {
    ...rest,
    stream: true,
    input: items,
    tools: ZEN_RESP_TOOLS,
    tool_choice: "auto",
    store: body.store ?? false,
    include: body.include ?? ["reasoning.encrypted_content"],
    prompt_cache_key: sessionId,
  };
}

interface ChatChunk {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
}

/** Assemble forced-stream SSE into a single chat.completion object. */
export function assembleChatCompletion(sseText: string, fallbackModel: string): Record<string, unknown> {
  let id = "";
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let finish = "stop";
  const parts: string[] = [];
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(payload) as ChatChunk;
    } catch {
      continue;
    }
    if (chunk.id) id = chunk.id;
    if (typeof chunk.created === "number") created = chunk.created;
    if (chunk.model) model = chunk.model;
    const choice = chunk.choices?.[0];
    if (typeof choice?.delta?.content === "string") parts.push(choice.delta.content);
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: parts.join("") }, finish_reason: finish }],
  };
}

/** Extract the completed response object from a responses event stream. */
export function assembleResponses(sseText: string): Record<string, unknown> | null {  let last: Record<string, unknown> | null = null;
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    last = evt;
    if (
      (evt.type === "response.completed" || evt.type === "response.incomplete") &&
      typeof evt.response === "object" &&
      evt.response !== null
    ) {
      return evt.response as Record<string, unknown>;
    }
  }
  // Fallback: a lone response object without envelope events.
  if (last && last.object === "response") return last;
  return null;
}

/** Pull plain text out of a responses output array (message items). */
export function responsesOutputText(resp: Record<string, unknown>): string {
  const out = resp.output;
  if (!Array.isArray(out)) return "";
  const parts: string[] = [];
  for (const item of out) {
    if (typeof item !== "object" || item === null) continue;
    const it = item as Record<string, unknown>;
    if (it.type !== "message" || !Array.isArray(it.content)) continue;
    for (const part of it.content as Array<Record<string, unknown>>) {
      if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("");
}

/** Convert an assembled responses object to a chat.completion object. */
export function responsesJsonToChatCompletion(resp: Record<string, unknown>, fallbackModel: string): Record<string, unknown> {
  const status = resp.status;
  return {
    id: (resp.id as string) ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(((resp.created_at as number) ?? Date.now() / 1000) / 1),
    model: (resp.model as string) ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: responsesOutputText(resp) },
        finish_reason: status === "incomplete" ? "length" : "stop",
      },
    ],
  };
}

function chatChunk(id: string, created: number, model: string, content: string | null, finish: string | null, role = false): string {
  const delta: Record<string, unknown> = {};
  if (role) delta.role = "assistant";
  if (content !== null) delta.content = content;
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n"
  );
}

/**
 * Translate a responses-protocol SSE stream into chat-completion chunks on
 * the fly (for clients that spoke /v1/chat/completions to a responses-only
 * model). Never buffers the whole body: transforms per line.
 */
export function responsesSseToChatSse(
  upstream: Response,
  fallbackModel: string,
  opts?: {
    stallTimeoutMs?: number;
    /** Mint a fresh upstream attempt when stalled; return null to give up. */
    onStallRetry?: () => Promise<Response | null>;
    maxStallRetries?: number;
  },
): Response {
  if (!upstream.body) throw new Error("upstream empty body");
  // Fail fast instead of hanging forever: some free-tier streams go silent
  // (keepalives only, no deltas) and never terminate. With onStallRetry the
  // translator swaps in a fresh attempt transparently — stalled generations
  // are per-request upstream flakiness, and the next attempt usually answers
  // in seconds. Without it, the client stream errors so it can retry.
  const stallTimeoutMs = opts?.stallTimeoutMs ?? 120_000;
  const maxStallRetries = opts?.maxStallRetries ?? 1;
  let reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let id = `chatcmpl-${Date.now()}`;
  let created = Math.floor(Date.now() / 1000);
  let model = fallbackModel;
  let first = true;
  let done = false;
  let lastProgress = Date.now();
  let stallRetries = 0;
  let retrying = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finish = () => {
    done = true;
    clearInterval(watchdog);
  };
  const fail = (err: Error) => {
    if (done) return;
    finish();
    reader.cancel().catch(() => {});
    try {
      ctrl?.error(err);
    } catch {
      // already closed/errored — ignore
    }
  };
  const watchdog = setInterval(() => {
    if (done || retrying) return;
    if (Date.now() - lastProgress <= stallTimeoutMs) return;
    const retry = stallRetries < maxStallRetries ? opts?.onStallRetry : undefined;
    if (!retry) {
      fail(new Error("upstream stall: no completion progress"));
      return;
    }
    retrying = true;
    void (async () => {
      try {
        const fresh = await retry();
        if (done || !fresh?.body) {
          await fresh?.body?.cancel().catch(() => {});
          fail(new Error("upstream stall: no completion progress"));
          return;
        }
        // Swap BEFORE cancelling the stale reader: any in-flight read on it
        // resolves done and must be ignored (generation guard in pull),
        // otherwise it would close the stream before the fresh body flows.
        const stale = reader;
        reader = fresh.body.getReader();
        buf = "";
        stallRetries++;
        lastProgress = Date.now();
        await stale.cancel().catch(() => {});
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)));
      } finally {
        retrying = false;
      }
    })();
  }, Math.min(5000, Math.max(10, stallTimeoutMs)));
  // Unref in runtimes that support it so tests/processes can exit.
  (watchdog as unknown as { unref?: () => void }).unref?.();
  const stream = new ReadableStream<Uint8Array>({
    // Eager pump (not pull-driven): Bun 1.4.0 stops scheduling pull() after a
    // pull that enqueues nothing (e.g. a chunk holding only a fragment of the
    // giant response.created line), silently killing the stream. A background
    // loop reading eagerly has no such dependency and delivers reliably.
    start(controller) {
      ctrl = controller;
      void (async () => {
        for (;;) {
          const active = reader;
          let value: Uint8Array | undefined;
          let readerDone = false;
          try {
            ({ value, done: readerDone } = await active.read());
          } catch {
            finish();
            try {
              controller.close();
            } catch {
              // already closed — ignore
            }
            return;
          }
          if (active !== reader) continue; // swapped by stall retry — reread
          if (done) {
            try {
              controller.close();
            } catch {
              // already closed — ignore
            }
            return;
          }
      if (value) buf += decoder.decode(value, { stream: true });
      if (readerDone) {
        if (buf.length > 0) buf += "\n";
        else {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          finish();
          controller.close();
          return;
        }
      }
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        // Forward keepalives as comments so clients with read timeouts don't
        // drop the connection during long reasoning gaps with no deltas.
        if (line === "" || line.startsWith(":")) {
          if (line !== "") controller.enqueue(encoder.encode(line + "\n\n"));
          continue;
        }
        if (line.startsWith("event:")) {
          controller.enqueue(encoder.encode(": ping\n\n"));
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
          lastProgress = Date.now();
          controller.enqueue(encoder.encode(chatChunk(id, created, model, evt.delta as string, null, first)));
          first = false;
        } else if (evt.type === "response.completed" || evt.type === "response.incomplete") {
          lastProgress = Date.now();
          const resp = evt.response as Record<string, unknown> | undefined;
          if (resp) {
            if (typeof resp.id === "string") id = resp.id;
            if (typeof resp.created_at === "number") created = resp.created_at;
            if (typeof resp.model === "string") model = resp.model;
          }
          const finishReason = evt.type === "response.incomplete" ? "length" : "stop";
          controller.enqueue(encoder.encode(chatChunk(id, created, model, null, finishReason)));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          finish();
          await reader.cancel().catch(() => {});
          try {
            controller.close();
          } catch {
            // already closed — ignore
          }
          return;
        }
      }
      if (readerDone) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        finish();
        try {
          controller.close();
        } catch {
          // already closed — ignore
        }
      }
        }
      })();
    },
    cancel() {
      finish();
      reader.cancel().catch(() => {});
    },
  });
  const h = new Headers();
  h.set("content-type", "text/event-stream");
  h.set("cache-control", "no-cache");
  h.set("connection", "keep-alive");
  h.set("x-accel-buffering", "no");
  return new Response(stream, { status: upstream.status, headers: h });
}
