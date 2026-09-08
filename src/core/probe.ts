// Live inference probe: tests each model with a tiny real request and
// caches per-model status. Catalog health-check only proves membership;
// this proves the model actually answers.
// NOTE: one full run costs ~1 upstream request per model — trigger on
// demand, not on an interval (quotas: kilo 200/hr, opencode 200/day).
import { config } from "../config.js";
import { ALL_MODELS, getAliveIds } from "./model-registry.js";
import type { ModelDef } from "./types.js";
import { opencodeProvider } from "../providers/opencode.js";
import { kiloProvider } from "../providers/kilo.js";
import { log } from "./logger.js";

export const PROBE_TEXT = "Reply with exactly OK.";

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  checkedAt: string;
  statusCode: number | null;
  error?: string;
}

export interface ModelProbeStatus {
  id: string;
  upstream: ModelDef["upstream"];
  catalogAlive: boolean;
  vision: boolean;
  probe: ProbeResult | null;
}

/** Injectable upstream caller (tests pass a mock; default hits providers). */
export type ProbeCall = (model: ModelDef, signal: AbortSignal) => Promise<Response>;

const results = new Map<string, ProbeResult>();
let running: Promise<void> | null = null;
let lastRunAt: string | null = null;

async function defaultCall(model: ModelDef, signal: AbortSignal): Promise<Response> {
  const ctx = { signal, clientIp: "probe", requestId: `probe-${randomUUID8()}` };
  if (model.api === "openai-responses" && opencodeProvider.responses) {
    return opencodeProvider.responses(
      { model: model.id, input: PROBE_TEXT, stream: false, max_output_tokens: config.probeMaxTokens },
      ctx,
    );
  }
  const provider = model.upstream === "kilo" ? kiloProvider : opencodeProvider;
  return provider.chat(
    {
      model: model.id,
      messages: [{ role: "user", content: PROBE_TEXT }],
      max_tokens: config.probeMaxTokens,
      stream: false,
      temperature: 0,
    },
    ctx,
  );
}

function randomUUID8(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function probeOne(
  model: ModelDef,
  opts?: { call?: ProbeCall; timeoutMs?: number },
): Promise<ProbeResult> {
  const call = opts?.call ?? defaultCall;
  const timeoutMs = opts?.timeoutMs ?? config.probeTimeoutMs;
  const start = Date.now();
  try {
    const res = await call(model, AbortSignal.timeout(timeoutMs));
    // Consume the small non-stream body so sockets are reused.
    await res.text().catch(() => {});
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return { ok: true, latencyMs, checkedAt: new Date().toISOString(), statusCode: res.status };
    }
    return {
      ok: false,
      latencyMs,
      checkedAt: new Date().toISOString(),
      statusCode: res.status,
      error: `upstream HTTP ${res.status}`,
    };
  } catch (e) {
    const err = e as Error;
    return {
      ok: false,
      latencyMs: Date.now() - start,
      checkedAt: new Date().toISOString(),
      statusCode: null,
      error: err?.name === "TimeoutError" ? `probe timeout after ${timeoutMs}ms` : String(e),
    };
  }
}

export function isProbeRunning(): boolean {
  return running !== null;
}

export function getLastRunAt(): string | null {
  return lastRunAt;
}

function resolveTargets(ids?: string[]): ModelDef[] {
  if (!ids) return ALL_MODELS;
  return ids.map((id) => {
    const m = ALL_MODELS.find((x) => x.id === id);
    if (!m) throw new Error(`unknown model '${id}'`);
    return m;
  });
}

export async function runProbeAll(opts?: {
  models?: string[];
  call?: ProbeCall;
  concurrency?: number;
  timeoutMs?: number;
}): Promise<void> {
  if (running) return running;
  const targets = resolveTargets(opts?.models);
  const concurrency = Math.max(1, Math.min(opts?.concurrency ?? config.probeConcurrency, targets.length || 1));
  running = (async () => {
    let next = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (next < targets.length) {
        const m = targets[next++];
        const r = await probeOne(m, opts);
        results.set(m.id, r);
      }
    });
    await Promise.all(workers);
    lastRunAt = new Date().toISOString();
    const ok = targets.filter((m) => results.get(m.id)?.ok).length;
    log("info", `probe finished: ${ok}/${targets.length} ok`);
  })().finally(() => {
    running = null;
  });
  return running;
}

export function getProbeStatus(): {
  ok: boolean;
  running: boolean;
  lastRunAt: string | null;
  summary: { total: number; ok: number; failed: number; unknown: number };
  models: ModelProbeStatus[];
} {
  const aliveSet = getAliveIds();
  const models: ModelProbeStatus[] = ALL_MODELS.map((m) => ({
    id: m.id,
    upstream: m.upstream,
    catalogAlive: !aliveSet || aliveSet.has(m.id),
    vision: m.input.includes("image"),
    probe: results.get(m.id) ?? null,
  }));
  return {
    ok: true,
    running: isProbeRunning(),
    lastRunAt,
    summary: {
      total: models.length,
      ok: models.filter((m) => m.probe?.ok).length,
      failed: models.filter((m) => m.probe && !m.probe.ok).length,
      unknown: models.filter((m) => !m.probe).length,
    },
    models,
  };
}

/** Test-only reset. */
export function resetProbeStore(): void {
  results.clear();
  lastRunAt = null;
}
