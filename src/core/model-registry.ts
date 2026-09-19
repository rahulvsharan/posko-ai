// Single source of truth — 22 models: OpenCode Zen (7) + KiloCode gateway (15).
// Removed (upstream 404, models deleted): minimax-m3, minimax-m2.7,
// thinkingmachines/inkling. Removed (no tool-supporting endpoints upstream,
// cannot drive an agent): nvidia/nemotron-3.5-content-safety:free.
// Boot health-check intersects with live catalogs.
import type { ModelDef, Upstream } from "./types.js";

export const ALL_MODELS: ModelDef[] = [
  // ── OpenCode Zen (7) ──
  { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Free", upstream: "opencode", reasoning: true, contextWindow: 1_048_576, maxTokens: 131_072, api: "openai-responses", input: ["text", "image"] },
  { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Free", upstream: "opencode", reasoning: true, contextWindow: 1_048_576, maxTokens: 131_072, api: "openai-responses", input: ["text", "image"] },
  { id: "mimo-v2.5-free", name: "MiMo V2.5 Free", upstream: "opencode", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, input: ["text", "image"] },
  { id: "ling-3.0-flash-fin-free", name: "Ling 3.0 Flash Fin Free", upstream: "opencode", reasoning: true, contextWindow: 262_144, maxTokens: 32_768, input: ["text"] },
  { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", upstream: "opencode", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text"] },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", upstream: "opencode", reasoning: true, contextWindow: 262_144, maxTokens: 262_144, input: ["text"] },
  { id: "big-pickle", name: "Big Pickle", upstream: "opencode", reasoning: true, contextWindow: 200_000, maxTokens: 32_000, input: ["text"] },
  // ── KiloCode gateway (15) ──
  { id: "kilo-auto/free", name: "Kilo Auto Free", upstream: "kilo", reasoning: false, contextWindow: 256_000, maxTokens: 10_000, input: ["text"] },
  { id: "stepfun/step-3.7-flash:free", name: "Step 3.7 Flash Free", upstream: "kilo", reasoning: true, contextWindow: 262_144, maxTokens: 262_144, input: ["text", "image"], thinkingFormat: "openrouter" },
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra Free", upstream: "kilo", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, input: ["text"], thinkingFormat: "openrouter" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super Free", upstream: "kilo", reasoning: true, contextWindow: 262_144, maxTokens: 235_929, input: ["text"], thinkingFormat: "openrouter" },
  { id: "dots-studio/dots-3-note-preview:free", name: "Dots3-Note Preview Free", upstream: "kilo", reasoning: true, contextWindow: 512_000, maxTokens: 460_800, input: ["text", "image"], thinkingFormat: "openrouter" },
  { id: "cohere/north-mini-code:free", name: "North Mini Code Free", upstream: "kilo", reasoning: false, contextWindow: 256_000, maxTokens: 64_000, input: ["text"] },
  { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 Free", upstream: "kilo", reasoning: true, contextWindow: 262_144, maxTokens: 32_768, input: ["text"], thinkingFormat: "openrouter" },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni Free", upstream: "kilo", reasoning: true, contextWindow: 256_000, maxTokens: 65_536, input: ["text", "image"], thinkingFormat: "openrouter" },
  { id: "openrouter/free", name: "OpenRouter Free (auto)", upstream: "kilo", reasoning: false, contextWindow: 200_000, maxTokens: 65_536, input: ["text", "image"] },
  { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning Free", upstream: "kilo", reasoning: true, contextWindow: 1_000_000, maxTokens: 65_536, input: ["text"], thinkingFormat: "openrouter" },
  { id: "inclusionai/ling-3.0-flash-sante:free", name: "Ling 3.0 Flash Sante Free", upstream: "kilo", reasoning: true, contextWindow: 262_144, maxTokens: 32_768, input: ["text"], thinkingFormat: "openrouter" },
  { id: "inclusionai/ling-3.0-flash-fin:free", name: "Ling 3.0 Flash Fin Free", upstream: "kilo", reasoning: true, contextWindow: 262_144, maxTokens: 32_768, input: ["text"], thinkingFormat: "openrouter" },
  { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid LFM 2.5 2.6B Free", upstream: "kilo", reasoning: true, contextWindow: 65_536, maxTokens: 8_192, input: ["text"], thinkingFormat: "openrouter" },
  { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 Free", upstream: "kilo", reasoning: true, contextWindow: 262_144, maxTokens: 32_768, input: ["text"], thinkingFormat: "openrouter" },
  { id: "thinkingmachines/inkling-small:free", name: "Inkling Small Free", upstream: "kilo", reasoning: true, contextWindow: 1_048_576, maxTokens: 262_144, input: ["text", "image"], thinkingFormat: "openrouter" },
];

export const MODEL_MAP = new Map<string, ModelDef>(ALL_MODELS.map((m) => [m.id, m]));

/** Alive-filtered view. Empty set = not yet health-checked → serve all (fail-open at boot). */
let aliveIds: Set<string> | null = null;

export function setAliveIds(ids: Set<string> | null): void {
  aliveIds = ids;
}
export function getAliveIds(): Set<string> | null {
  return aliveIds;
}
export function getModel(id: string): ModelDef | undefined {
  const m = MODEL_MAP.get(id);
  if (!m) return undefined;
  if (aliveIds && !aliveIds.has(id)) return undefined;
  return m;
}
export function listModels(): ModelDef[] {
  if (!aliveIds) return ALL_MODELS;
  return ALL_MODELS.filter((m) => aliveIds!.has(m.id));
}
export function upstreamOf(modelId: string): Upstream | undefined {
  return MODEL_MAP.get(modelId)?.upstream;
}
export function supportsImage(modelId: string): boolean {
  return MODEL_MAP.get(modelId)?.input.includes("image") ?? false;
}
