import { parseSplitMap } from "./splits";
import type { Split } from "./ids";

export interface R2Config {
  bucket: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export interface Config {
  port: number;
  hostname: string;
  relayToken: string;
  consentRequiredRev: string;
  splitMap: Record<string, Split>;
  r2: R2Config;
  dbPath: string;
  promptRev?: string;
  putTtlSec: number;
  getTtlSec: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3004),
    hostname: env.BIND_HOST ?? "127.0.0.1",
    relayToken: env.ALTEREGO_RELAY_TOKEN ?? "",
    consentRequiredRev: env.CONSENT_REQUIRED_REV ?? "consent-2026-07-01",
    splitMap: parseSplitMap(env.SPLIT_SESSION_MAP),
    r2: {
      // Prefer explicit R2_* names; fall back to generic S3_* names if an
      // existing Doppler scope already holds Cloudflare R2 (S3-*) credentials.
      bucket: env.R2_BUCKET ?? env.S3_BUCKET ?? "",
      endpoint: env.R2_ENDPOINT ?? env.S3_ENDPOINT ?? "",
      region: env.R2_REGION ?? env.S3_REGION ?? "auto",
      accessKeyId: env.R2_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY ?? "",
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? env.S3_SECRET_KEY ?? "",
      forcePathStyle: (env.R2_FORCE_PATH_STYLE ?? env.S3_FORCE_PATH_STYLE ?? "false").toLowerCase() === "true",
    },
    dbPath: env.COLLECT_DB_PATH ?? "./collect.db",
    promptRev: env.PROMPT_REV,
    putTtlSec: Number(env.PUT_TTL_SEC ?? 900),
    getTtlSec: Number(env.GET_TTL_SEC ?? 3600),
  };
}
