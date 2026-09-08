// Boot health-check: intersect static catalog with live upstream lists.
// Fail-open: null (network error) → serve all static models.
import { config } from "../config.js";
import { setAliveIds, ALL_MODELS } from "./model-registry.js";
import { opencodeHeaders } from "../utils/headers.js";
import { log } from "./logger.js";

async function fetchIds(url: string, headers: Record<string, string>): Promise<Set<string> | null> {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const d = (await r.json()) as { data?: { id: string }[] };
    return new Set((d?.data ?? []).map((m) => m.id));
  } catch {
    return null;
  }
}

export interface AliveModel {
  id: string;
  name: string;
  upstream: string;
}

export async function runHealthCheck(): Promise<{
  opencode: number;
  kilo: number;
  total: number;
  models: AliveModel[];
}> {
  const [oc, kilo] = await Promise.all([
    fetchIds(`${config.upstreamOpencode}/v1/models`, opencodeHeaders()),
    fetchIds(`${config.upstreamKilo.replace(/\/$/, "")}/models`, {
      Authorization: "Bearer kilo-free",
    }),
  ]);
  // null = upstream unreachable → fail open for that side
  const alive = new Set<string>();
  for (const m of ALL_MODELS) {
    if (m.upstream === "opencode") {
      if (!oc || oc.has(m.id)) alive.add(m.id);
    } else {
      if (!kilo || kilo.has(m.id)) alive.add(m.id);
    }
  }
  const bothDown = oc === null && kilo === null;
  if (bothDown) {
    setAliveIds(null); // total outage → serve static
    log("warn", "health-check: both upstreams unreachable, serving static catalog");
  } else {
    setAliveIds(alive);
  }
  const listed = bothDown ? ALL_MODELS : ALL_MODELS.filter((m) => alive.has(m.id));
  const models: AliveModel[] = listed.map((m) => ({
    id: m.id,
    name: m.name,
    upstream: m.upstream,
  }));
  const ocN = models.filter((m) => m.upstream === "opencode").length;
  const kiloN = models.filter((m) => m.upstream === "kilo").length;
  log("info", `health-check: opencode=${ocN} kilo=${kiloN} total=${models.length}`);
  log("info", `available models (${models.length}): ${models.map((m) => m.id).join(", ")}`);
  return { opencode: ocN, kilo: kiloN, total: models.length, models };
}
