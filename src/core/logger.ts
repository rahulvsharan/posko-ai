import pino from "pino";
import { config } from "../config.js";

export const logger = pino({
  level: config.logLevel,
  base: { service: "posko-ai" },
});

export type LogMeta = Record<string, unknown>;
export function log(level: "info" | "warn" | "error", msg: string, meta?: LogMeta): void {
  logger[level](meta ?? {}, `[posko-ai] ${msg}`);
}
