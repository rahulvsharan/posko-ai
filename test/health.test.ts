import { describe, test, expect, afterEach } from "bun:test";
import { runHealthCheck } from "../src/core/health.js";
import { setAliveIds } from "../src/core/model-registry.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setAliveIds(null);
});

function mockCatalogs(opencodeIds: string[], kiloIds: string[]) {
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const ids = u.includes("opencode.ai") ? opencodeIds : kiloIds;
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
  }) as typeof fetch;
}

describe("boot health-check available list", () => {
  test("returns alive models with names + per-upstream counts", async () => {
    mockCatalogs(
      ["mimo-v2.5-free", "big-pickle"],
      ["kilo-auto/free", "openrouter/free"],
    );
    const r = await runHealthCheck();
    expect(r.opencode).toBe(2);
    expect(r.kilo).toBe(2);
    expect(r.total).toBe(4);
    expect(r.models.map((m) => m.id).sort()).toEqual(
      ["big-pickle", "kilo-auto/free", "mimo-v2.5-free", "openrouter/free"].sort(),
    );
    expect(r.models[0].name).toBeTruthy();
  });

  test("dead ids excluded from available list", async () => {
    mockCatalogs(["mimo-v2.5-free"], ["kilo-auto/free"]);
    const r = await runHealthCheck();
    expect(r.models.some((m) => m.id === "big-pickle")).toBe(false);
    expect(r.total).toBe(2);
  });
});
