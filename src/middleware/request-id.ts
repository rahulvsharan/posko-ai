import type { MiddlewareHandler } from "hono";
import { randomUUID } from "node:crypto";

export const requestId: MiddlewareHandler = async (c, next) => {
  const id = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId" as never, id as never);
  c.header("x-request-id", id);
  await next();
};
