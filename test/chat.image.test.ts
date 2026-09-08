import { describe, test, expect } from "bun:test";
import { decodedBase64Bytes, checkImageUrl, collectChatImages } from "../src/core/validation.js";
import { createApp } from "../src/index.js";
import { config } from "../src/config.js";

describe("§12.2 base64 size math", () => {
  test("padding vectors exact", () => {
    expect(decodedBase64Bytes("TWFu")).toBe(3); // no pad
    expect(decodedBase64Bytes("TWE=")).toBe(2); // 1 pad
    expect(decodedBase64Bytes("TQ==")).toBe(1); // 2 pads
  });
  test("whitespace-wrapped accepted", () => {
    expect(decodedBase64Bytes("TW\nFu")).toBe(3);
  });
  test("%4==1 rejected", () => {
    expect(() => decodedBase64Bytes("ABCDE")).toThrow();
  });
  test("oversize detected by math (no big alloc in test)", () => {
    // 21MB decoded → b64 len ≈ 28M chars; build length without storing full image bytes
    const bytes = 21 * 1024 * 1024;
    const b64len = Math.ceil(bytes / 3) * 4;
    const fake = "T".repeat(b64len); // valid charset, no padding
    const got = decodedBase64Bytes(fake);
    expect(got).toBeGreaterThan(20 * 1024 * 1024);
  });
});

describe("image_url checks", () => {
  test("https accepted, file:// + http private rejected", () => {
    expect(checkImageUrl("https://example.com/a.png").ok).toBe(true);
    expect(checkImageUrl("file:///etc/passwd").ok).toBe(false);
    expect(checkImageUrl("http://127.0.0.1/a.png").ok).toBe(false);
  });
  test("svg/data without base64 rejected", () => {
    expect(checkImageUrl("data:image/svg+xml;base64,PHN2Zz4=").ok).toBe(false);
    expect(checkImageUrl("data:image/png,TWFu").ok).toBe(false);
  });
  test("tiny data URL accepted", () => {
    expect(checkImageUrl("data:image/png;base64,TWFu").ok).toBe(true);
  });
  test("too many images per message rejected", () => {
    const parts = Array.from({ length: 9 }, () => ({ type: "image_url", image_url: { url: "https://example.com/a.png" } }));
    const { error } = collectChatImages([{ role: "user", content: [{ type: "text", text: "x" }, ...parts] }]);
    expect(error).toBeDefined();
  });
});

describe("vision gate at route level", () => {
  test("non-vision model + data image → 400", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: "big-pickle",
          messages: [{ role: "user", content: [{ type: "text", text: "x" }, { type: "image_url", image_url: { url: "data:image/png;base64,TWFu" } }] }],
        }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
