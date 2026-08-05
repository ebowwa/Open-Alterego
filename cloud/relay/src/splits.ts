import type { Split } from "./ids";

/**
 * Split assignment is owned by the relay (apps/apple/API.md §5: "The server,
 * not the app, owns train/val/test assignment. Split by recording session").
 *
 * Policy: an explicit operator-configured session→split map. Sessions not in
 * the map default to "train". The assigned split is persisted on the example at
 * insert time, so it never changes as new sessions arrive.
 */
export const DEFAULT_SPLIT_MAP: Record<string, Split> = {
  s01: "train",
  s02: "val",
  s03: "test",
};

export function splitForSession(session: string, map: Record<string, Split>): Split {
  return map[session] ?? "train";
}

export function parseSplitMap(raw: string | undefined): Record<string, Split> {
  if (!raw || !raw.trim()) return { ...DEFAULT_SPLIT_MAP };
  const out: Record<string, Split> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split(":").map((x) => (x ? x.trim() : ""));
    if (k && (v === "train" || v === "val" || v === "test")) out[k] = v;
  }
  return out;
}
