import { Hono } from "hono";
import { config } from "./config.js";
import { auth } from "./middleware/auth.js";
import { cors } from "./middleware/cors.js";
import { requestId } from "./middleware/request-id.js";
import { modelsRoute } from "./routes/models.js";
import { chatRoute } from "./routes/chat.js";
import { responsesRoute } from "./routes/responses.js";
import { healthRoute, rootRoute } from "./routes/health.js";
import { adminModelsRoute } from "./routes/admin.js";
import { relayRoute } from "./relay/routes.js";
import { loadRelayState } from "./relay/state.js";
import { runHealthCheck } from "./core/health.js";
import { log } from "./core/logger.js";

export function createApp(): Hono {
  const app = new Hono();
  app.use("*", cors);
  app.use("*", requestId);
  app.use("*", auth);
  app.route("/", rootRoute);
  app.route("/health", healthRoute);
  app.route("/v1/models", modelsRoute);
  app.route("/v1/chat/completions", chatRoute);
  app.route("/v1/responses", responsesRoute);
  app.route("/v1/admin/relay", relayRoute);
  app.route("/v1/admin/models", adminModelsRoute);
  app.notFound((c) => c.json({ error: { message: "not found", type: "invalid_request_error", code: "not_found" } }, 404));
  return app;
}

const isMain = import.meta.main;
if (isMain) {
  loadRelayState();
  // Boot health-check in background (fail-open); don't block listen.
  runHealthCheck().catch((e) => log("warn", "boot health-check failed", { error: String(e) }));
  const app = createApp();
  // idleTimeout (seconds): SSE streams go quiet for tens of seconds while
  // reasoning models think. Bun's default (10s) would kill such streams
  // mid-flight; allow up to 255s of server-side silence (Bun's max) so
  // clients time out on their own terms instead.
  Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch, idleTimeout: 255 });
  log("info", `posko-ai listening on http://${config.host}:${config.port} (POST /v1/chat/completions, POST /v1/responses)`);
}
