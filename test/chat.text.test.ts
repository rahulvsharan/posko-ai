import { describe, test, expect } from "bun:test";
import { createApp } from "../src/index.js";
import { config } from "../src/config.js";
import { resetRateLimits } from "../src/core/rate-limit.js";
import { setAliveIds } from "../src/core/model-registry.js";

const KEY = config.apiKey;

function req(path: string, body: unknown, key = KEY) {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

describe("chat text validation (no upstream network)", () => {
  test("unknown model → 404 model_not_found", async () => {
    setAliveIds(null);
    resetRateLimits();
    const app = createApp();
    const res = await app.fetch(req("/v1/chat/completions", { model: "nope", messages: [{ role: "user", content: "hi" }] }));
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("model_not_found");
  });

  test("missing messages → 400", async () => {
    const app = createApp();
    const res = await app.fetch(req("/v1/chat/completions", { model: "mimo-v2.5-free" }));
    expect(res.status).toBe(400);
  });

  test("text-only model + image → 400 vision_not_supported (no upstream call)", async () => {
    const app = createApp();
    const res = await app.fetch(
      req("/v1/chat/completions", {
        model: "big-pickle",
        messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "https://example.com/a.png" } }] }],
      }),
    );
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("vision_not_supported");
  });
});
