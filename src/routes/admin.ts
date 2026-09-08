import { Hono } from "hono";
import { z } from "zod";
import { ALL_MODELS } from "../core/model-registry.js";
import { getProbeStatus, runProbeAll, isProbeRunning } from "../core/probe.js";
import { log } from "../core/logger.js";

export const adminModelsRoute = new Hono();

/** Current per-model status. 200 always — `probe: null` means "not probed yet". */
adminModelsRoute.get("/status", (c) => c.json(getProbeStatus()));

const probeBody = z
  .object({ models: z.array(z.string().min(1)).min(1).max(50).optional() })
  .passthrough();

/**
 * Trigger a live inference probe (tiny `max_tokens` request per model).
 * Runs in background — poll GET /status. Costs ~1 upstream request/model.
 */
adminModelsRoute.post("/probe", async (c) => {
  let ids: string[] | undefined;
  try {
    const raw = await c.req.json();
    const parsed = probeBody.safeParse(raw ?? {});
    if (!parsed.success) {
      return c.json(
        { error: { message: "invalid body: optional {models: string[]}", type: "invalid_request_error", code: "invalid_request" } },
        400,
      );
    }
    ids = parsed.data.models;
  } catch {
    ids = undefined; // empty body = probe all
  }
  if (ids) {
    const unknown = ids.filter((id) => !ALL_MODELS.some((m) => m.id === id));
    if (unknown.length) {
      return c.json(
        { error: { message: `unknown model(s): ${unknown.join(", ")}`, type: "invalid_request_error", code: "model_not_found" } },
        404,
      );
    }
  }
  if (isProbeRunning()) {
    return c.json({ ok: true, started: false, running: true, message: "probe already running — poll GET /status" }, 409);
  }
  void runProbeAll({ models: ids }).catch((e) => log("warn", "background probe failed", { error: String(e) }));
  return c.json({ ok: true, started: true, running: true, targets: ids?.length ?? ALL_MODELS.length }, 202);
});
