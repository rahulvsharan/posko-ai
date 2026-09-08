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

export async function runHealthCheck(): Promise<{ opencode: number; kilo: number; total: number }> {
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
  if (oc === null && kilo === null) {
    setAliveIds(null); // total outage → serve static
    log("warn", "health-check: both upstreams unreachable, serving static catalog");
  } else {
    setAliveIds(alive);
  }
  const ocN = ALL_MODELS.filter((m) => m.upstream === "opencode" && alive.has(m.id)).length;
  const kiloN = ALL_MODELS.filter((m) => m.upstream === "kilo" && alive.has(m.id)).length;
  log("info", `health-check: opencode=${ocN} kilo=${kiloN}`);
  return { opencode: ocN, kilo: kiloN, total: alive.size };
}
