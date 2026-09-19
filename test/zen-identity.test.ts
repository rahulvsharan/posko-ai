import { describe, expect, test } from "bun:test";
import {
  assembleChatCompletion,
  assembleResponses,
  mintMessageId,
  mintSessionId,
  responsesJsonToChatCompletion,
  responsesSseToChatSse,
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

  test("responsesJsonToChatCompletion extracts message text", () => {
    const resp = {
      id: "r1",
      object: "response",
      status: "completed",
      model: "muse-x",
      created_at: 100,
      output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    };
    const out = responsesJsonToChatCompletion(resp, "muse-x") as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message.content).toBe("OK");
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  test("responsesSseToChatSse translates deltas to chat chunks", async () => {
    const sse = [
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"r1","model":"muse-x","created_at":100}}',
      "",
    ].join("\n");
    const up = new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const out = responsesSseToChatSse(up, "muse-x");
    expect(out.headers.get("content-type")).toBe("text/event-stream");
    const text = await out.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"content":"OK"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("responsesSseToChatSse forwards keepalives for slow streams", async () => {    const sse = [
      ": keep-alive",
      "",
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"r1"}}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"r1","model":"m","created_at":100}}',
      "",
    ].join("\n");
    const up = new Response(sse, { headers: { "content-type": "text/event-stream" } });
    const text = await responsesSseToChatSse(up, "m").text();
    expect(text).toContain(": keep-alive");
    expect(text).toContain(": ping");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  test("responsesSseToChatSse errors on silent-forever streams", async () => {
    const up = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
          // then silence forever — never close
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    await expect(responsesSseToChatSse(up, "m", { stallTimeoutMs: 30 }).text()).rejects.toThrow(
      /upstream stall/,
    );
  });

  test("responsesSseToChatSse swaps in a fresh attempt on stall", async () => {
    const stalled = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const freshBody = [      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
      'data: {"type":"response.completed","response":{"id":"r9","model":"m","created_at":100}}',
      "",
    ].join("\n");
    const fresh = () =>
      Promise.resolve(
        new Response(freshBody, { headers: { "content-type": "text/event-stream" } }),
      );
    const text = await responsesSseToChatSse(stalled, "m", {
      stallTimeoutMs: 30,
      onStallRetry: fresh,
    }).text();
    expect(text).toContain('"content":"OK"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });
});
