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
  return {
    ...body,
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
  return {
    ...body,
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
export function assembleResponses(sseText: string): Record<string, unknown> | null {
  let last: Record<string, unknown> | null = null;
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
