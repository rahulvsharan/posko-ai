import { describe, test, expect, beforeEach } from "bun:test";
import {
  probeOne,
  runProbeAll,
  getProbeStatus,
  resetProbeStore,
  type ProbeCall,
} from "../src/core/probe.js";
import { ALL_MODELS } from "../src/core/model-registry.js";
import { createApp } from "../src/index.js";
import { config } from "../src/config.js";

const okCall: ProbeCall = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });

beforeEach(() => resetProbeStore());

describe("probeOne", () => {
  test("200 → ok with latency + statusCode", async () => {
    const m = ALL_MODELS[0];
    const r = await probeOne(m, { call: okCall, timeoutMs: 5_000 });
    expect(r.ok).toBe(true);
    expect(r.statusCode).toBe(200);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.checkedAt).toBeTruthy();
  });

  test("500 → failed with error message", async () => {
    const m = ALL_MODELS[0];
    const r = await probeOne(m, {
      call: async () => new Response("bad", { status: 500 }),
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBe(500);
    expect(r.error).toMatch(/500/);
  });

  test("throwing caller → failed with null statusCode", async () => {
    const m = ALL_MODELS[0];
    const r = await probeOne(m, {
      call: async () => {
        throw new Error("boom");
      },
      timeoutMs: 5_000,
    });
    expect(r.ok).toBe(false);
    expect(r.statusCode).toBeNull();
    expect(r.error).toMatch(/boom/);
  });
});

describe("runProbeAll + getProbeStatus", () => {
  test("mixed results counted in summary", async () => {
    const ids = ["mimo-v2.5-free", "big-pickle", "kilo-auto/free"];
    const call: ProbeCall = async (model) =>
      model.id === "big-pickle" ? new Response("x", { status: 429 }) : new Response("x", { status: 200 });
    await runProbeAll({ models: ids, call, concurrency: 2, timeoutMs: 5_000 });
    const s = getProbeStatus();
    expect(s.summary.total).toBe(ALL_MODELS.length);
    expect(s.summary.ok).toBe(2);
    expect(s.summary.failed).toBe(1);
    expect(s.summary.unknown).toBe(ALL_MODELS.length - 3);
    expect(s.lastRunAt).toBeTruthy();
  });

  test("unknown model id throws", async () => {
    let threw = false;
    try {
      await runProbeAll({ models: ["nope"], call: okCall });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("admin API (no upstream network)", () => {
  test("GET /status shape before any probe", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/admin/models/status", {
        headers: { authorization: `Bearer ${config.apiKey}` },
      }),
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { summary: { unknown: number }; models: { id: string; probe: null }[] };
    expect(j.summary.unknown).toBe(ALL_MODELS.length);
    expect(j.models.length).toBe(ALL_MODELS.length);
  });

  test("POST /probe unknown model → 404 without probing", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/admin/models/probe", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ models: ["nope"] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("POST /probe requires auth", async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request("http://local/v1/admin/models/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models: ["nope"] }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
