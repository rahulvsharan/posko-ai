import { Hono } from "hono";
import { z } from "zod";
import { getModel } from "../core/model-registry.js";
import { collectResponsesImages } from "../core/validation.js";
import { checkRateLimit } from "../core/rate-limit.js";
import { opencodeProvider } from "../providers/opencode.js";
import { clientIp } from "../utils/headers.js";
import { log } from "../core/logger.js";

export const responsesRoute = new Hono();

const responsesSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.any())]).optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

responsesRoute.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON", type: "invalid_request_error", code: "invalid_json" } }, 400);
  }
  const parsed = responsesSchema.safeParse(body);
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
  // Only openai-responses models speak /v1/responses
  if (model.api !== "openai-responses") {
    const hint = model.upstream === "kilo" ? "use POST /v1/chat/completions for Kilo models" : "use POST /v1/chat/completions for this model";
    return c.json(
      { error: { message: `model '${modelId}' does not support /v1/responses — ${hint}`, type: "invalid_request_error", code: "model_not_found" } },
      400,
    );
  }

  const { count, error } = collectResponsesImages(parsed.data.input);
  if (error) {
    return c.json({ error: { message: error.message, type: "invalid_request_error", code: error.code } }, 400);
  }
  if (count > 0 && !model.input.includes("image")) {
    return c.json(
      { error: { message: `model '${modelId}' does not support image input`, type: "invalid_request_error", code: "vision_not_supported" } },
      400,
    );
  }

  const ip = clientIp(c.req.raw);
  if (!checkRateLimit(ip, model.upstream)) {
    return c.json({ error: { message: `${model.upstream} rate limit exceeded`, type: "rate_limit_error", code: "rate_limit_exceeded" } }, 429);
  }
  if (!opencodeProvider.responses) {
    return c.json({ error: { message: "responses not implemented", type: "api_error", code: null } }, 501);
  }
  const requestId = (c.get("requestId" as never) as unknown as string) ?? "";
  try {
    return await opencodeProvider.responses(body, { signal: c.req.raw.signal, clientIp: ip, requestId });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") return c.body(null, 499 as never);
    log("error", "responses provider error", { error: String(e), model: modelId });
    return c.json({ error: { message: "upstream error", type: "api_error", code: null } }, 502);
  }
});
