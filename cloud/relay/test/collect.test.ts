import { test, expect, beforeEach, afterAll, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/app";
import type { Config } from "../src/config";
import { CollectDb } from "../src/db";
import { loadPromptSet } from "../src/prompts";
import type { Presigner } from "../src/r2";

const TOKEN = "test-bearer-token";
const promptSet = loadPromptSet();

function mockPresigner(): Presigner & {
  puts: string[];
  gets: string[];
  deletes: string[];
} {
  const puts: string[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  return {
    puts,
    gets,
    deletes,
    async presignPut(key) {
      puts.push(key);
      return `https://r2.local/put/${encodeURIComponent(key)}?sig=put`;
    },
    async presignGet(key) {
      gets.push(key);
      return `https://r2.local/get/${encodeURIComponent(key)}?sig=get`;
    },
    async deleteObject(key) {
      deletes.push(key);
    },
  };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    hostname: "127.0.0.1",
    relayToken: TOKEN,
    consentRequiredRev: "consent-2026-07-01",
    splitMap: { s01: "train", s02: "val", s03: "test" },
    r2: { bucket: "b", endpoint: "https://r2.local", region: "auto", accessKeyId: "a", secretAccessKey: "s" },
    dbPath: join(tmpdir(), "collect.db"),
    putTtlSec: 900,
    getTtlSec: 3600,
    ...overrides,
  };
}

let tmpDir: string;
let deps: AppDeps;
let presigner: ReturnType<typeof mockPresigner>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "alterego-collect-"));
  const config = baseConfig({ dbPath: join(tmpDir, "collect.db") });
  const db = new CollectDb(config.dbPath);
  presigner = mockPresigner();
  deps = { config, db, presigner, promptSet };
  (deps as any).app = makeApp(deps);
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const app = () => (deps as any).app;

function req(path: string, init: RequestInit & { token?: string | null } = {}) {
  const { token = TOKEN, ...rest } = init;
  const headers = new Headers(rest.headers as HeadersInit);
  if (token !== null) headers.set("Authorization", `Bearer ${token}`);
  if (rest.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return app().request(path, { ...rest, headers });
}

function exampleBody(over: Record<string, unknown> = {}) {
  return {
    speaker: "elijah",
    idempotency_key: "key-0001",
    prompt_id: "p0001",
    prompt_rev: promptSet.prompt_rev,
    text: "hey how is everyone today",
    session: "s01",
    duration_ms: 3120,
    orientation: "portrait",
    mirrored: true,
    capture_build: "test",
    consent_rev: "consent-2026-07-01",
    ...over,
  };
}

describe("health & auth", () => {
  test("health is public", async () => {
    const res = await req("/health", { token: null });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.prompt_rev).toBe(promptSet.prompt_rev);
  });

  test("missing bearer → 401", async () => {
    const res = await req("/v1/collect/prompts", { token: null });
    expect(res.status).toBe(401);
  });

  test("wrong bearer → 401", async () => {
    const res = await req("/v1/collect/prompts", { token: "wrong" });
    expect(res.status).toBe(401);
  });

  test("valid bearer returns prompt set", async () => {
    const res = await req("/v1/collect/prompts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prompts.length).toBe(promptSet.prompts.length);
    expect(body.prompts[0].prompt_id).toMatch(/^p\d{4}$/);
  });
});

describe("create example", () => {
  test("consent mismatch → 403", async () => {
    const res = await req("/v1/collect/examples", {
      method: "POST",
      body: JSON.stringify(exampleBody({ consent_rev: "consent-old" })),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.required).toBe("consent-2026-07-01");
  });

  test("invalid speaker → 400", async () => {
    const res = await req("/v1/collect/examples", {
      method: "POST",
      body: JSON.stringify(exampleBody({ speaker: "bad name!" })),
    });
    expect(res.status).toBe(400);
  });

  test("valid create → 201, clip_id + PUT url + split", async () => {
    const res = await req("/v1/collect/examples", {
      method: "POST",
      body: JSON.stringify(exampleBody()),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.clip_id).toMatch(/^s01-p0001-/);
    expect(body.upload.method).toBe("PUT");
    expect(body.upload.url).toContain("r2.local/put/");
    expect(body.upload.headers["Content-Type"]).toBe("video/mp4");
    expect(body.split).toBe("train");
    expect(body.already_uploaded).toBe(false);
    expect(presigner.puts).toHaveLength(1);
    expect(presigner.puts[0]).toBe(`raw/elijah/s01/${body.clip_id}.mp4`);
  });

  test("split assigned by session (s02→val, s03→test)", async () => {
    for (const [session, expected] of [["s02", "val"], ["s03", "test"]] as const) {
      const res = await req("/v1/collect/examples", {
        method: "POST",
        body: JSON.stringify(exampleBody({ session, idempotency_key: `key-${session}` })),
      });
      const body = await res.json();
      expect(body.split).toBe(expected);
    }
  });

  test("unknown session defaults to train", async () => {
    const res = await req("/v1/collect/examples", {
      method: "POST",
      body: JSON.stringify(exampleBody({ session: "s09", idempotency_key: "key-s09" })),
    });
    expect((await res.json()).split).toBe("train");
  });

  test("idempotent replay → same clip_id, fresh url, already_uploaded=false", async () => {
    const first = await req("/v1/collect/examples", {
      method: "POST",
      body: JSON.stringify(exampleBody()),
    });
    const a = await first.json();
    const second = await req("/v1/collect/examples", {
      method: "POST",
      body: JSON.stringify(exampleBody()),
    });
    expect(second.status).toBe(200);
    const b = await second.json();
    expect(b.clip_id).toBe(a.clip_id);
    expect(b.already_uploaded).toBe(false);
  });
});

describe("complete / status / export", () => {
  test("complete flips uploaded_at; status + export reflect it", async () => {
    const created = await (
      await req("/v1/collect/examples", { method: "POST", body: JSON.stringify(exampleBody()) })
    ).json();

    // before complete
    let status = await (await req("/v1/collect/status?speaker=elijah")).json();
    expect(status.uploaded).toBe(0);
    let exportBody = await (await req("/v1/collect/export?speaker=elijah")).json();
    expect(exportBody.examples).toHaveLength(0);

    // complete
    const done = await req("/v1/collect/examples/complete", {
      method: "POST",
      body: JSON.stringify({ clip_id: created.clip_id }),
    });
    expect(done.status).toBe(200);

    status = await (await req("/v1/collect/status?speaker=elijah")).json();
    expect(status.uploaded).toBe(1);
    expect(status.by_split.train).toBe(1);

    exportBody = await (await req("/v1/collect/export?speaker=elijah")).json();
    expect(exportBody.examples).toHaveLength(1);
    expect(exportBody.examples[0]).toMatchObject({
      clip_id: created.clip_id,
      split: "train",
      text: "hey how is everyone today",
      mirrored: true,
    });
    expect(exportBody.examples[0].uploaded_at).toBeGreaterThan(0);
  });

  test("status invalid speaker → 400", async () => {
    const res = await req("/v1/collect/status?speaker=bad%20name");
    expect(res.status).toBe(400);
  });
});

describe("presign GETs", () => {
  test("only uploaded clips get GET urls", async () => {
    const a = await (
      await req("/v1/collect/examples", {
        method: "POST",
        body: JSON.stringify(exampleBody({ idempotency_key: "a" })),
      })
    ).json();
    const b = await (
      await req("/v1/collect/examples", {
        method: "POST",
        body: JSON.stringify(exampleBody({ idempotency_key: "b", session: "s02" })),
      })
    ).json();
    // complete only a
    await req("/v1/collect/examples/complete", { method: "POST", body: JSON.stringify({ clip_id: a.clip_id }) });

    const res = await req("/v1/collect/presign", {
      method: "POST",
      body: JSON.stringify({ speaker: "elijah", clip_ids: [a.clip_id, b.clip_id] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.urls)).toEqual([a.clip_id]);
    expect(body.urls[a.clip_id]).toContain("r2.local/get/");
    expect(body.expires_in).toBe(3600);
  });
});

describe("delete", () => {
  test("delete removes object + row; export excludes", async () => {
    const created = await (
      await req("/v1/collect/examples", { method: "POST", body: JSON.stringify(exampleBody()) })
    ).json();
    await req("/v1/collect/examples/complete", {
      method: "POST",
      body: JSON.stringify({ clip_id: created.clip_id }),
    });

    const del = await req(`/v1/collect/examples/${created.clip_id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(presigner.deletes).toEqual([`raw/elijah/s01/${created.clip_id}.mp4`]);

    const exportBody = await (await req("/v1/collect/export?speaker=elijah")).json();
    expect(exportBody.examples).toHaveLength(0);

    // second delete → 404
    const del2 = await req(`/v1/collect/examples/${created.clip_id}`, { method: "DELETE" });
    expect(del2.status).toBe(404);
  });
});
