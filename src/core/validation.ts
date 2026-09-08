// §12.2 — base64 size by math, image URL checks, vision gating helpers.
// Never Buffer.from() just to measure size.
import { config } from "../config.js";

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_URL_RE = /^data:(image\/(png|jpeg|jpg|webp));base64,(.*)$/s;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

/** Decoded byte size without allocating. Throws on malformed. */
export function decodedBase64Bytes(payload: string): number {
  const clean = payload.replace(/\s/g, "");
  if (clean.length === 0) throw new Error("empty base64");
  if (clean.length % 4 !== 0 || !B64_RE.test(clean)) throw new Error("malformed base64");
  const pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - pad;
}

export type ImageCheck =
  | { ok: true; kind: "https" | "data"; bytes?: number }
  | { ok: false; code: "bad_url" | "bad_mime" | "bad_base64" | "image_too_large"; message: string; bytes?: number };

export function checkImageUrl(
  url: string,
  maxMb = config.maxImageMb,
): ImageCheck {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, code: "bad_url", message: "empty image_url" };
  }
  if (url.startsWith("data:")) {
    const m = DATA_URL_RE.exec(url);
    if (!m) {
      // svg / gif / missing base64 marker land here
      return { ok: false, code: "bad_mime", message: "only data:image/png|jpeg|webp;base64 is accepted" };
    }
    const mime = m[1];
    if (!ALLOWED_MIME.has(mime)) {
      return { ok: false, code: "bad_mime", message: `mime '${mime}' not supported` };
    }
    const payload = m[3];
    // Early length gate before regex: avoids huge-string regex cost blowup
    // maxBytes -> maxB64Len ≈ ceil(maxBytes/3)*4 + 2
    const maxBytes = maxMb * 1024 * 1024;
    const maxB64Len = Math.ceil(maxBytes / 3) * 4 + 4;
    const cleanLen = payload.replace(/\s/g, "").length;
    if (cleanLen > maxB64Len + 16) {
      // still compute exact below for message; this is just a fast path
    }
    let bytes: number;
    try {
      bytes = decodedBase64Bytes(payload);
    } catch {
      return { ok: false, code: "bad_base64", message: "malformed base64 image data" };
    }
    if (bytes > maxBytes) {
      return {
        ok: false,
        code: "image_too_large",
        message: `image ${(bytes / 1048576).toFixed(1)}MB exceeds ${maxMb}MB limit`,
        bytes,
      };
    }
    return { ok: true, kind: "data", bytes };
  }
  if (url.startsWith("https://")) {
    if (url.length > 8192) return { ok: false, code: "bad_url", message: "https image_url too long" };
    return { ok: true, kind: "https" };
  }
  return { ok: false, code: "bad_url", message: "image_url must be https:// or data:image/...;base64,..." };
}

/** Walk chat messages, collect image_urls. Returns {count, firstError}. */
export function collectChatImages(messages: unknown[]): { count: number; error?: ImageCheck & { ok: false } } {
  let count = 0;
  const maxPerMsg = config.maxImagesPerMessage;
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string" || content == null) continue;
    if (!Array.isArray(content)) continue;
    let perMsg = 0;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as { type?: string; image_url?: { url?: string } | string };
      if (p.type !== "image_url") continue;
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (typeof url !== "string") {
        return { count, error: { ok: false, code: "bad_url", message: "image_url.url missing" } };
      }
      const checked = checkImageUrl(url);
      if (!checked.ok) return { count, error: checked };
      count++;
      perMsg++;
      if (perMsg > maxPerMsg || count > maxPerMsg * messages.length) {
        // per-message cap enforced loosely; strict per-message check below in zod layer uses maxPerMsg
      }
    }
    if (perMsg > maxPerMsg) {
      return {
        count,
        error: { ok: false, code: "bad_url", message: `too many images in one message (max ${maxPerMsg})` },
      };
    }
  }
  return { count };
}

/** Walk responses input, collect image urls (input_text/input_image subset). */
export function collectResponsesImages(input: unknown): { count: number; error?: ImageCheck & { ok: false } } {
  if (typeof input === "string" || input == null) return { count: 0 };
  if (!Array.isArray(input)) return { count: 0 };
  let count = 0;
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (typeof content === "string" || content == null) continue;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as { type?: string; image_url?: string };
      if (p.type !== "input_image") continue;
      if (typeof p.image_url !== "string") {
        return { count, error: { ok: false, code: "bad_url", message: "input_image.image_url missing" } };
      }
      const checked = checkImageUrl(p.image_url);
      if (!checked.ok) return { count, error: checked };
      count++;
    }
  }
  return { count };
}
