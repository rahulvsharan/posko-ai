import { describe, test, expect } from "bun:test";
import { createApp } from "../src/index.js";
import { config } from "../src/config.js";

describe("auth", () => {
  test("missing key → 401", async () => {
    const app = createApp();
    const res = await app.fetch(new Request("http://local/v1/models"));
    expect(res.status).toBe(401);
  });
  test("wrong key → 401", async () => {
    const app = createApp();
    const res = await app.fetch(new Request("http://local/v1/models", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
  });
  test("correct key → 200 models", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/models", { headers: { authorization: `Bearer ${config.apiKey}` } }),
    );
    expect(res.status).toBe(200);
  });
  test("/health public", async () => {
    const app = createApp();
    const res = await app.fetch(new Request("http://local/health"));
    expect(res.status).toBe(200);
  });
});
