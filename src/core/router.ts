// Router: modelId -> provider id. No if/else in routes.
import type { Upstream } from "./types.js";
import { upstreamOf } from "./model-registry.js";

export function resolveUpstream(modelId: string): Upstream | undefined {
  return upstreamOf(modelId);
}
