import { timingSafeEqual } from "node:crypto";

export const SPLIT_VALUES = ["train", "val", "test"] as const;
export type Split = (typeof SPLIT_VALUES)[number];

/** Speaker / dataset / session names: must be valid as a Modal dataset_name
 *  (cloud/modal/app.py::_safe_name) and as a prepare_dataset id component
 *  (_safe_component). The stricter rule wins: start alphanumeric, then
 *  [A-Za-z0-9._-]*. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidName(s: unknown): s is string {
  return typeof s === "string" && NAME_RE.test(s);
}

/** Mirror training/prepare_dataset.py::_safe_component so clip ids the relay
 *  emits survive `prepare` unchanged (it would otherwise re-sanitize and could
 *  collide / drift). */
export function sanitizeComponent(s: string): string {
  let c = String(s)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (!/[A-Za-z0-9]/.test(c)) c = "x";
  return c;
}

/** Stable, short suffix derived from the client idempotency key so the same
 *  upload attempt always yields the same clip_id (and thus the same R2 key). */
export function idempotencySuffix(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(36).padStart(6, "0").slice(0, 8);
}

export function makeClipId(session: string, promptId: string, idemKey: string): string {
  return [
    sanitizeComponent(session),
    sanitizeComponent(promptId),
    idempotencySuffix(idemKey),
  ].join("-");
}

export function makeR2Key(speaker: string, session: string, clipId: string): string {
  return `raw/${sanitizeComponent(speaker)}/${sanitizeComponent(session)}/${sanitizeComponent(clipId)}.mp4`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
