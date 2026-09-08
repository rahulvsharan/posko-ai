import type { MiddlewareHandler } from "hono";
import { config } from "../config.js";
import { openAIError } from "../core/errors.js";

export const auth: MiddlewareHandler = async (c, next) => {
  const path = c.req.path;
  if (path === "/" || path === "/health") return next();
  // /v1/admin/* also requires auth (same dummy key)
  const header = c.req.header("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== config.apiKey) {
    return c.json(
      { error: { message: "invalid api key", type: "authentication_error", code: "invalid_api_key" } },
      401,
    );
  }
  await next();
};
void openAIError;
