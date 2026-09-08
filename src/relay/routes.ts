import { Hono } from "hono";
import { z } from "zod";
import { getRelayState, setRelayState } from "./state.js";

export const relayRoute = new Hono();

relayRoute.get("/status", (c) => c.json({ ok: true, relay: getRelayState() }));

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().optional(),
});

relayRoute.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON", type: "invalid_request_error", code: "invalid_json" } }, 400);
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: { message: "invalid relay patch", type: "invalid_request_error", code: "invalid_request" } }, 400);
  }
  const next = setRelayState({
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(parsed.data.url !== undefined ? { url: parsed.data.url.trim() } : {}),
  });
  return c.json({ ok: true, relay: next });
});
