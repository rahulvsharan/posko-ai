// Central env config. All values overridable via environment.
export interface GatewayConfig {
  host: string;
  port: number;
  apiKey: string;
  upstreamOpencode: string;
  upstreamKilo: string;
  relayUrl: string;
  relayEnabled: boolean;
  rateOpencodeDay: number;
  rateKiloHour: number;
  maxImageMb: number;
  maxImagesPerMessage: number;
  logLevel: string;
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): GatewayConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: num(env.PORT, 47831),
    apiKey: env.GATEWAY_API_KEY ?? "sk-posko-local",
    upstreamOpencode: (env.UPSTREAM_OPENCODE ?? "https://opencode.ai/zen").replace(/\/$/, ""),
    upstreamKilo: (env.UPSTREAM_KILO ?? "https://api.kilo.ai/api/gateway").replace(/\/$/, ""),
    relayUrl: (env.RELAY_URL ?? "").trim(),
    relayEnabled: (env.RELAY_ENABLED ?? "false").toLowerCase() === "true",
    rateOpencodeDay: num(env.RATE_OPENCODE_DAY, 200),
    rateKiloHour: num(env.RATE_KILO_HOUR, 200),
    maxImageMb: num(env.MAX_IMAGE_MB, 20),
    maxImagesPerMessage: num(env.MAX_IMAGES_PER_MESSAGE, 8),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

export const config: GatewayConfig = loadConfig();
export const KILO_CHAT_PATH = "/chat/completions";
export const RELAY_MAX_TOKENS = 131_072;
