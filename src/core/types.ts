// Shared types. Providers depend only on this + config — never on routes.
export type Upstream = "opencode" | "kilo";
export type ProviderApi = "openai-completions" | "openai-responses";

export interface ModelDef {
  id: string;
  name: string;
  upstream: Upstream;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Which OpenAI API this model speaks. Undefined = chat completions. */
  api?: ProviderApi;
  /** Default ["text"]; vision models include "image". */
  input: ("text" | "image")[];
  thinkingFormat?: "openrouter";
}

export interface ChatRequest {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [k: string]: unknown;
}

export interface ResponsesRequest {
  model: string;
  input: unknown;
  stream?: boolean;
  [k: string]: unknown;
}

export interface ProviderCtx {
  signal?: AbortSignal;
  clientIp: string;
  requestId: string;
}
