import { Hono } from "hono";
import { z } from "zod";
import { getModel } from "../core/model-registry.js";
import { resolveUpstream } from "../core/router.js";
import { collectChatImages } from "../core/validation.js";
import { checkRateLimit } from "../core/rate-limit.js";
import { opencodeProvider } from "../providers/opencode.js";
import { kiloProvider } from "../providers/kilo.js";
import { clientIp } from "../utils/headers.js";
import { log } from "../core/logger.js";
import { config } from "../config.js";

export const chatRoute = new Hono();

const contentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.union([
      z.string(),
      z.object({ url: z.string(), detail: z.enum(["auto", "low", "high"]).optional() }),
    ]),
  }),
  z.object({ type: z.string() }).passthrough(),
]);
const message = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(contentPart), z.null()]).optional(),
  })
  .passthrough();
const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(message).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough();

chatRoute.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON", type: "invalid_request_error", code: "invalid_json" } }, 400);
  }
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: { message: "invalid request: " + parsed.error.issues[0]?.message, type: "invalid_request_error", code: "invalid_request" } },
      400,
    );
  }
  const modelId = parsed.data.model;
  const model = getModel(modelId);
  if (!model) {
    return c.json(
      { error: { message: `model '${modelId}' not found`, type: "invalid_request_error", code: "model_not_found" } },
      404,
    );
  }

  // Image checks (§12.2) — math-first, no decode
  const { count, error } = collectChatImages(parsed.data.messages as unknown[]);
  if (error) {
    if (error.code === "image_too_large") {
      return c.json({ error: { message: error.message, type: "invalid_request_error", code: "image_too_large" } }, 400);
    }
    return c.json({ error: { message: error.message, type: "invalid_request_error", code: error.code } }, 400);
  }
  if (count > 0 && !model.input.includes("image")) {
    return c.json(
      { error: { message: `model '${modelId}' does not support image input`, type: "invalid_request_error", code: "vision_not_supported" } },
      400,
    );
  }

  const upstream = resolveUpstream(modelId);
  if (!upstream) return c.json({ error: { message: "no provider", type: "api_error", code: null } }, 502);
  const ip = clientIp(c.req.raw);
  if (!checkRateLimit(ip, upstream)) {
    return c.json({ error: { message: `${upstream} rate limit exceeded`, type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429);
  }

  const provider = upstream === "kilo" ? kiloProvider : opencodeProvider;
  const requestId = (c.get("requestId" as never) as unknown as string) ?? "";
  void config;
  try {
    // §12.1: forward abort signal so client disconnect kills upstream
    return await provider.chat(body, { signal: c.req.raw.signal, clientIp: ip, requestId });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return c.body(null, 499 as never);
    log("error", "chat provider error", { error: String(e), model: modelId });
    return c.json({ error: { message: "upstream error", type: "api_error", code: null } }, 502);
  }
});
