import { Hono } from "hono";
import { bearerAuth } from "./auth";
import type { Config } from "./config";
import { CollectDb, type Example, type Status } from "./db";
import { isValidName, makeClipId, makeR2Key, sanitizeComponent } from "./ids";
import type { Presigner } from "./r2";
import { splitForSession } from "./splits";
import { loadPromptSet, type PromptSet } from "./prompts";

export interface AppDeps {
  config: Config;
  db: CollectDb;
  presigner: Presigner;
  promptSet: PromptSet;
}

interface CreateExampleBody {
  speaker?: unknown;
  idempotency_key?: unknown;
  prompt_id?: unknown;
  prompt_rev?: unknown;
  text?: unknown;
  session?: unknown;
  duration_ms?: unknown;
  orientation?: unknown;
  mirrored?: unknown;
  capture_build?: unknown;
  consent_rev?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function uploadEnvelope(url: string, expiresIn: number) {
  return { method: "PUT" as const, url, headers: { "Content-Type": "video/mp4" }, expires_in: expiresIn };
}

function toExportRow(e: Example) {
  return {
    clip_id: e.clip_id,
    prompt_id: e.prompt_id,
    prompt_rev: e.prompt_rev,
    text: e.text,
    split: e.split,
    session: e.session,
    duration_ms: e.duration_ms,
    orientation: e.orientation,
    mirrored: e.mirrored === 1,
    capture_build: e.capture_build,
    consent_rev: e.consent_rev,
    uploaded_at: e.uploaded_at,
  };
}

export function makeApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ status: "ok", prompt_rev: deps.promptSet.prompt_rev }),
  );

  app.use("/v1/collect/*", bearerAuth(deps.config.relayToken));

  app.get("/v1/collect/prompts", (c) => c.json(deps.promptSet));

  app.post("/v1/collect/examples", async (c) => {
    const body = (await c.req.json().catch(() => null)) as CreateExampleBody | null;
    if (!body) return c.json({ error: "invalid json body" }, 400);

    if (!isValidName(body.speaker)) return c.json({ error: "invalid speaker" }, 400);
    if (!isValidName(body.session)) return c.json({ error: "invalid session" }, 400);
    if (!isNonEmptyString(body.idempotency_key)) return c.json({ error: "invalid idempotency_key" }, 400);
    if (!isNonEmptyString(body.prompt_id)) return c.json({ error: "invalid prompt_id" }, 400);
    if (!isNonEmptyString(body.text)) return c.json({ error: "invalid text" }, 400);
    if (!isNonEmptyString(body.prompt_rev)) return c.json({ error: "invalid prompt_rev" }, 400);
    if (!isNonEmptyString(body.consent_rev)) return c.json({ error: "invalid consent_rev" }, 400);

    if (body.consent_rev !== deps.config.consentRequiredRev) {
      return c.json(
        { error: "consent revision not accepted", required: deps.config.consentRequiredRev },
        403,
      );
    }

    // Idempotent replay: same key → same clip_id, fresh PUT URL.
    const existing = deps.db.getByIdem(body.idempotency_key as string);
    if (existing) {
      const url = await deps.presigner.presignPut(
        existing.r2_key,
        "video/mp4",
        deps.config.putTtlSec,
      );
      return c.json({
        clip_id: existing.clip_id,
        upload: uploadEnvelope(url, deps.config.putTtlSec),
        split: existing.split,
        already_uploaded: existing.uploaded_at != null,
      });
    }

    const split = splitForSession(body.session as string, deps.config.splitMap);
    const clipId = makeClipId(
      body.session as string,
      body.prompt_id as string,
      body.idempotency_key as string,
    );
    const r2Key = makeR2Key(body.speaker as string, body.session as string, clipId);
    const now = Date.now();

    // Presign before inserting so an R2/presign failure leaves no orphan row.
    const url = await deps.presigner.presignPut(r2Key, "video/mp4", deps.config.putTtlSec);

    deps.db.insert({
      clip_id: clipId,
      speaker: body.speaker as string,
      session: body.session as string,
      prompt_id: sanitizeComponent(body.prompt_id as string),
      prompt_rev: body.prompt_rev as string,
      text: (body.text as string).replace(/\s+/g, " ").trim(),
      split,
      duration_ms: typeof body.duration_ms === "number" ? body.duration_ms : null,
      orientation: typeof body.orientation === "string" ? body.orientation : null,
      mirrored: body.mirrored ? 1 : 0,
      capture_build: typeof body.capture_build === "string" ? body.capture_build : null,
      consent_rev: body.consent_rev as string,
      idempotency_key: body.idempotency_key as string,
      r2_key: r2Key,
      uploaded_at: null,
      created_at: now,
    });
    return c.json(
      {
        clip_id: clipId,
        upload: uploadEnvelope(url, deps.config.putTtlSec),
        split,
        already_uploaded: false,
      },
      201,
    );
  });

  app.post("/v1/collect/examples/complete", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { clip_id?: unknown } | null;
    if (!isNonEmptyString(body?.clip_id)) return c.json({ error: "invalid clip_id" }, 400);
    const ex = deps.db.getById(body!.clip_id as string);
    if (!ex) return c.json({ error: "not found" }, 404);
    deps.db.markUploaded(ex.clip_id, Date.now());
    return c.json({ ok: true, clip_id: ex.clip_id, uploaded: true });
  });

  app.get("/v1/collect/status", (c) => {
    const speaker = c.req.query("speaker") ?? "";
    if (!isValidName(speaker)) return c.json({ error: "invalid speaker" }, 400);
    const status: Status = deps.db.status(speaker);
    return c.json(status);
  });

  app.get("/v1/collect/export", (c) => {
    const speaker = c.req.query("speaker") ?? "";
    if (!isValidName(speaker)) return c.json({ error: "invalid speaker" }, 400);
    const examples = deps.db.listUploaded(speaker).map(toExportRow);
    return c.json({
      speaker,
      prompt_rev: deps.promptSet.prompt_rev,
      splits_policy: "by-session",
      exported_at: new Date().toISOString(),
      examples,
    });
  });

  app.post("/v1/collect/presign", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      speaker?: unknown;
      clip_ids?: unknown;
    } | null;
    const speaker = body?.speaker;
    const clipIds = body?.clip_ids;
    if (!isValidName(speaker) || !Array.isArray(clipIds) || !clipIds.every((id) => typeof id === "string")) {
      return c.json({ error: "invalid request; need speaker and clip_ids[]" }, 400);
    }
    const rows = deps.db
      .getManyByIds(speaker as string, clipIds as string[])
      .filter((r) => r.uploaded_at != null);
    const urls: Record<string, string> = {};
    for (const r of rows) {
      urls[r.clip_id] = await deps.presigner.presignGet(r.r2_key, deps.config.getTtlSec);
    }
    return c.json({ urls, expires_in: deps.config.getTtlSec });
  });

  app.delete("/v1/collect/examples/:clip_id", async (c) => {
    const clipId = c.req.param("clip_id");
    const ex = deps.db.getById(clipId);
    if (!ex) return c.json({ error: "not found" }, 404);
    await deps.presigner.deleteObject(ex.r2_key);
    deps.db.delete(ex.clip_id);
    return c.json({ ok: true, deleted: ex.clip_id });
  });

  return app;
}

export { loadPromptSet };
export type { PromptSet };
