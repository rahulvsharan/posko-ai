import { describe, test, expect } from "bun:test";
import { passthroughSSE } from "../src/core/stream.js";

function mockUpstream(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "r1" } });
}

describe("§12.1 SSE passthrough", () => {
  test("preserves body stream + headers, no content-length", async () => {
    const up = mockUpstream(['data: {"a":1}\n\n', "data: [DONE]\n\n"]);
    const out = passthroughSSE(up);
    expect(out.status).toBe(200);
    expect(out.headers.get("content-type")).toBe("text/event-stream");
    expect(out.headers.get("cache-control")).toBe("no-cache");
    expect(out.headers.get("x-accel-buffering")).toBe("no");
    expect(out.headers.get("content-length")).toBeNull();
    expect(out.headers.get("x-request-id")).toBe("r1");
    const text = await out.text();
    expect(text).toContain("[DONE]");
  });

  test("first chunk available without waiting for full body (no buffering)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const stream = new ReadableStream({
      async start(c) {
        c.enqueue(new TextEncoder().encode("data: first\n\n"));
        // hold open; reader should already see first chunk
        await gate;
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    const up = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const out = passthroughSSE(up);
    const reader = out.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    release();
    await reader.cancel().catch(() => {});
  });
});
