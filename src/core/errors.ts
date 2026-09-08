// OpenAI error envelope: {error:{message,type,code}}
export type OpenAIErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "api_error";

export function openAIError(
  status: number,
  message: string,
  type: OpenAIErrorType = "invalid_request_error",
  code: string | null = null,
): Response {
  return Response.json({ error: { message, type, code } }, { status });
}

export const errModelNotFound = (model: string) =>
  openAIError(404, `model '${model}' not found`, "invalid_request_error", "model_not_found");

export const errVisionNotSupported = (model: string) =>
  openAIError(
    400,
    `model '${model}' does not support image input`,
    "invalid_request_error",
    "vision_not_supported",
  );

export const errImageTooLarge = (mb: number, limitMb: number) =>
  openAIError(
    400,
    `image ${mb.toFixed(1)}MB exceeds ${limitMb}MB limit`,
    "invalid_request_error",
    "image_too_large",
  );

export const errRateLimited = (upstream: string) =>
  openAIError(429, `${upstream} rate limit exceeded`, "rate_limit_error", "rate_limit_exceeded");
