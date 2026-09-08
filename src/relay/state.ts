import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";

export interface RelayState {
  enabled: boolean;
  url: string;
}

let state: RelayState = {
  enabled: config.relayEnabled,
  url: config.relayUrl,
};

function statePath(): string {
  try {
    return path.join(os.homedir(), ".config", "posko-ai", "relay.json");
  } catch {
    return path.join(process.cwd(), ".relay-state.json");
  }
}

export function getRelayState(): RelayState {
  return state;
}

export function setRelayState(patch: Partial<RelayState>): RelayState {
  state = { ...state, ...patch };
  persist();
  return state;
}

function persist(): void {
  try {
    const p = statePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(state));
  } catch {
    // best-effort only
  }
}

export function loadRelayState(): RelayState {
  try {
    const raw = fs.readFileSync(statePath(), "utf8");
    const s = JSON.parse(raw) as Partial<RelayState>;
    state = {
      enabled: Boolean(s.enabled),
      url: typeof s.url === "string" ? s.url : "",
    };
  } catch {
    state = { enabled: config.relayEnabled, url: config.relayUrl };
  }
  return state;
}
