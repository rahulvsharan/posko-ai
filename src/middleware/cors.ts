import type { MiddlewareHandler } from "hono";

export const cors: MiddlewareHandler = async (c, next) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-methods", "GET, POST, OPTIONS");
  c.header("access-control-allow-headers", "authorization, content-type, x-request-id");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
};
