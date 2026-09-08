import { Hono } from "hono";
import { config } from "../config.js";
import { listModels, ALL_MODELS } from "../core/model-registry.js";
import { getRelayState } from "../relay/state.js";

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
  const models = listModels();
  const oc = models.filter((m) => m.upstream === "opencode").length;
  const kilo = models.filter((m) => m.upstream === "kilo").length;
  const relay = getRelayState();
  return c.json({
    ok: true,
    upstreams: { opencode: { alive: oc }, kilo: { alive: kilo } },
    relay: { enabled: relay.enabled, url: relay.url || null },
  });
});

export const rootRoute = new Hono();
rootRoute.get("/", (c) =>
  c.json({
    name: "posko-ai",
    version: "0.1.0",
    baseUrl: `http://${config.host}:${config.port}/v1`,
    models: ALL_MODELS.length,
    upstreams: ["opencode", "kilo"],
    docs: "/health",
  }),
);
