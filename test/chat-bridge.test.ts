import { describe, expect, test } from "bun:test";
import { chatToResponses } from "../src/providers/opencode.js";

describe("chat-to-responses bridge (no upstream network)", () => {
  test("single string message maps input + max tokens, drops chat fields", () => {
    const out = chatToResponses({
      model: "muse-spark-1.3-contributor-free",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 60,
      stream: false,
    });
    expect(out.input).toBe("hi");
    expect(out.max_output_tokens).toBe(60);
    expect("messages" in out).toBe(false);
    expect("max_tokens" in out).toBe(false);
  });

  test("multi-message converts parts, still drops chat fields", () => {
    const out = chatToResponses({
      model: "m",
      messages: [
        { role: "system", content: "be nice" },
        { role: "user", content: "hi" },
      ],
      max_tokens: 10,
    });
    expect(Array.isArray(out.input)).toBe(true);
    expect("messages" in out).toBe(false);
    expect("max_tokens" in out).toBe(false);
  });
});
