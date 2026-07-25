# alterego-collect relay

Personalization data-collection gateway for Open-Altergo. The iOS app never
holds Cloudflare R2 credentials; it asks this relay for short-lived, scoped
presigned PUT URLs and records each example's metadata. Modal never holds R2
credentials either; it pulls presigned GETs from the relay. R2 S3 creds live
**only** here (via Doppler).

```
iPhone ──► POST /v1/collect/examples ──► presigned PUT ──► R2
iPhone ──► POST /v1/collect/examples/complete
Modal  ──► GET  /v1/collect/export        (clip list + server-assigned splits)
Modal  ──► POST /v1/collect/presign       (batch presigned GETs)
```

## Stack

Bun + Hono + `bun:sqlite` (metadata) + `@aws-sdk/client-s3` (R2 presigning). No
video bytes ever pass through this service.

## Run (dev)

```bash
bun install
ALTEREGO_RELAY_TOKEN=dev-token bun run src/index.ts
# → http://127.0.0.1:3004
```

Without R2 creds the presign endpoints will still build URLs against a mock-like
client, but PUT/GET to R2 will only succeed once `R2_*` are set. Tests use an
injected mock presigner and need no R2.

## Tests

```bash
bun test          # 14 contract tests, no network/R2
bun x tsc --noEmit
```

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `ALTEREGO_RELAY_TOKEN` | yes | shared bearer (also in Modal secret + app Keychain) |
| `R2_BUCKET` | yes (prod) | R2 bucket name |
| `R2_ENDPOINT` | yes (prod) | `https://<account_id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | yes (prod) | R2 S3 token (scoped to the bucket) |
| `R2_REGION` | no | `auto` (default) |
| `COLLECT_DB_PATH` | no | SQLite path (default `./collect.db`) |
| `SPLIT_SESSION_MAP` | no | `s01:train,s02:val,s03:test` (default); unknown session → `train` |
| `CONSENT_REQUIRED_REV` | no | refuse uploads below this consent rev (default `consent-2026-07-01`) |
| `PROMPT_REV` | no | serve a specific prompt rev (default: newest in `prompts/`) |
| `PORT` / `HOSTNAME` | no | `3004` / `127.0.0.1` (Caddy terminates TLS in front) |
| `PUT_TTL_SEC` / `GET_TTL_SEC` | no | presign lifetimes (`900` / `3600`) |

## Endpoints (all under `/v1/collect/*` require `Authorization: Bearer <token>`)

- `GET /health` — public; `{status, prompt_rev}`
- `GET /v1/collect/prompts` — `{prompt_rev, prompts:[{prompt_id,text}]}`
- `POST /v1/collect/examples` — idempotent on `idempotency_key`; returns
  `{clip_id, upload:{method,url,headers,expires_in}, split, already_uploaded}`.
  Body: `speaker, idempotency_key, prompt_id, prompt_rev, text, session,
  duration_ms, orientation, mirrored, capture_build, consent_rev`.
- `POST /v1/collect/examples/complete` `{clip_id}` — marks the clip uploaded.
- `GET /v1/collect/status?speaker=` — totals / by-split / by-session.
- `GET /v1/collect/export?speaker=` — uploaded examples with splits (Modal reads this).
- `POST /v1/collect/presign` `{speaker, clip_ids[]}` — batch presigned GETs.
- `DELETE /v1/collect/examples/<clip_id>` — deletes R2 object + row.

R2 key layout: `raw/<speaker>/<session>/<clip_id>.mp4`. `clip_id` is sanitized to
the same rule as `training/prepare_dataset.py::_safe_component` so it survives
`prepare` unchanged. Split is assigned at insert by session and persisted, so it
never reshuffles.

## Prompts

```bash
bun run prompts/generate.ts            # → prompts/rev<rev>.json (300 ASCII prompts)
bun run prompts/generate.ts --count 20 --rev 2026-07-25
```

Prompts are letters + spaces only (digits spelled out) so they tokenize cleanly
after `prepare_dataset.py` uppercases them.

## Deploy (secondsee relay VPS)

Behind Caddy (HTTPS). Copy this dir, `bun install --production`, run under a
process manager with Doppler:

```bash
doppler run -- bun run src/index.ts
```

R2 metadata lives in SQLite on the VPS; back it up nightly to R2
(`meta/<speaker>/export-*.jsonl`). Clips themselves persist in R2 regardless.
