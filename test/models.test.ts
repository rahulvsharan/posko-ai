import { describe, test, expect } from "bun:test";
import { ALL_MODELS, listModels, supportsImage, setAliveIds } from "../src/core/model-registry.js";

describe("models registry", () => {
  test("static catalog has 22 models (7 opencode + 15 kilo)", () => {
    setAliveIds(null);
    expect(ALL_MODELS.length).toBe(22);
    expect(ALL_MODELS.filter((m) => m.upstream === "opencode").length).toBe(7);
    expect(ALL_MODELS.filter((m) => m.upstream === "kilo").length).toBe(15);
  });

  test("owned_by mapping + no paid leak (all ids are known free ids)", () => {
    const models = listModels();
    const ids = new Set(models.map((m) => m.id));
    expect(ids.has("muse-spark-1.3-contributor-free")).toBe(true);
    expect(ids.has("kilo-auto/free")).toBe(true);
    // spot-check paid ids never appear
    expect(ids.has("gpt-4")).toBe(false);
  });

  test("vision matrix: 8 vision models", () => {
    const vision = ALL_MODELS.filter((m) => m.input.includes("image")).map((m) => m.id);
    expect(vision.length).toBe(8);
    expect(supportsImage("mimo-v2.5-free")).toBe(true);
    expect(supportsImage("big-pickle")).toBe(false);
    expect(supportsImage("openrouter/free")).toBe(true);
  });
});
