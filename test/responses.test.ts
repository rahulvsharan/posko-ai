import { describe, test, expect } from "bun:test";
import { createApp } from "../src/index.js";
import { config } from "../src/config.js";
import { setAliveIds } from "../src/core/model-registry.js";
import { resetRateLimits } from "../src/core/rate-limit.js";

describe("responses routing (no upstream network)", () => {
  test("kilo model via /v1/responses → 400 with chat hint", async () => {
    setAliveIds(null);
    resetRateLimits();
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: "kilo-auto/free", input: "hi" }),
      }),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { message: string } };
    expect(j.error.message).toMatch(/chat\/completions/);
  });

  test("chat-only opencode model via /v1/responses → 400", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: "big-pickle", input: "hi" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("unknown model → 404", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: "nope", input: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
