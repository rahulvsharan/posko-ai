// §12.1 — SSE passthrough without buffering.
// Stream path must never await body text. Return upstream.body directly.
export function passthroughSSE(upstream: Response): Response {
  if (!upstream.body) throw new Error("upstream empty body");
  const h = new Headers();
  h.set("content-type", "text/event-stream");
  h.set("cache-control", "no-cache");
  h.set("connection", "keep-alive");
  h.set("x-accel-buffering", "no");
  const rid = upstream.headers.get("x-request-id");
  if (rid) h.set("x-request-id", rid);
  // NB: no content-length, no text() call — chunks flush as they arrive
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

export function sseHeaders(extra?: Record<string, string>): Headers {
  const h = new Headers();
  h.set("content-type", "text/event-stream");
  h.set("cache-control", "no-cache");
  h.set("connection", "keep-alive");
  h.set("x-accel-buffering", "no");
  if (extra) for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}
