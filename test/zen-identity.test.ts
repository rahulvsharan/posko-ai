import { describe, expect, test } from "bun:test";
import {
  assembleChatCompletion,
  assembleResponses,
  mintMessageId,
  mintSessionId,
  wrapChatForZen,
  wrapResponsesForZen,
} from "../src/providers/zen-identity.js";
import { ZEN_CHAT_SYSTEM, ZEN_CHAT_TOOLS, ZEN_RESP_DEVELOPER, ZEN_RESP_TOOLS } from "../src/providers/zen-fingerprint.js";

describe("zen identity (no upstream network)", () => {
  test("minted ids match opencode format", () => {
    const ses = mintSessionId();
    const msg = mintMessageId();
    expect(ses).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(msg).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(mintSessionId()).not.toBe(ses);
  });

  test("chat wrapper prepends fingerprint system, forces stream, pins tools", () => {
    const out = wrapChatForZen({ model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }], stream: false });
    expect(out.stream).toBe(true);
    const msgs = out.messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: "system", content: ZEN_CHAT_SYSTEM });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
    expect(out.tools).toEqual(ZEN_CHAT_TOOLS);
    expect(out.tool_choice).toBe("none");
  });

  test("chat wrapper does not double-prepend", () => {
    const once = wrapChatForZen({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const twice = wrapChatForZen(once);
    expect((twice.messages as unknown[]).length).toBe(2);
  });

  test("responses wrapper prepends developer, pins tools/type, keys cache", () => {
    const out = wrapResponsesForZen({ model: "muse-spark-1.3-contributor-free", input: "hi" }, "ses_test");
    expect(out.stream).toBe(true);
    const items = out.input as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ role: "developer", content: ZEN_RESP_DEVELOPER });
    expect(out.tools).toEqual(ZEN_RESP_TOOLS);
    expect(out.tool_choice).toBe("auto");
    expect(out.prompt_cache_key).toBe("ses_test");
  });

  test("assembleChatCompletion concatenates deltas", () => {
    const sse = [
      'data: {"id":"a","created":1,"model":"m","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
      'data: {"id":"a","created":1,"model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
      "data: [DONE]",
    ].join("\n");
    const out = assembleChatCompletion(sse, "m") as {
      object: string;
      choices: Array<{ message: { content: string } }>;
    };
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("Hello");
  });

  test("assembleResponses extracts completed response", () => {
    const resp = { id: "r1", object: "response", output: [] };
    const sse = [
      'data: {"type":"response.created","response":{"id":"r1"}}',
      `data: {"type":"response.completed","response":${JSON.stringify(resp)}}`,
    ].join("\n");
    expect(assembleResponses(sse)).toEqual(resp);
    expect(assembleResponses("data: [DONE]\n")).toBeNull();
  });

  test("assembleResponses accepts incomplete response", () => {
    const resp = { id: "r2", object: "response", status: "incomplete", output: [] };
    const sse = `data: {"type":"response.incomplete","response":${JSON.stringify(resp)}}`;
    expect(assembleResponses(sse)).toEqual(resp);
  });
});
