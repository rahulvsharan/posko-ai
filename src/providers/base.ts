import type { ProviderCtx } from "../core/types.js";
import type { Upstream } from "../core/types.js";

export interface GatewayProvider {
  readonly id: Upstream;
  owns(modelId: string): boolean;
  chat(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response>;
  responses?(body: Record<string, unknown>, ctx: ProviderCtx): Promise<Response>;
}
