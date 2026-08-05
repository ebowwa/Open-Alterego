import { Database } from "bun:sqlite";
import type { Split } from "./ids";

export interface Example {
  clip_id: string;
  speaker: string;
  session: string;
  prompt_id: string;
  prompt_rev: string;
  text: string;
  split: Split;
  duration_ms: number | null;
  orientation: string | null;
  mirrored: number;
  capture_build: string | null;
  consent_rev: string;
  idempotency_key: string;
  r2_key: string;
  uploaded_at: number | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS examples (
  clip_id          TEXT PRIMARY KEY,
  speaker          TEXT NOT NULL,
  session          TEXT NOT NULL,
  prompt_id        TEXT NOT NULL,
  prompt_rev       TEXT NOT NULL,
  text             TEXT NOT NULL,
  split            TEXT NOT NULL CHECK (split IN ('train','val','test')),
  duration_ms      INTEGER,
  orientation      TEXT,
  mirrored         INTEGER NOT NULL DEFAULT 0,
  capture_build    TEXT,
  consent_rev      TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  r2_key           TEXT NOT NULL,
  uploaded_at      INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_examples_speaker ON examples(speaker);
CREATE INDEX IF NOT EXISTS idx_examples_idem ON examples(idempotency_key);
`;

export interface Status {
  speaker: string;
  total: number;
  uploaded: number;
  by_split: Record<string, number>;
  by_session: Record<string, number>;
  last_uploaded_at: number | null;
}

export class CollectDb {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getByIdem(idem: string): Example | null {
    return (this.db.prepare("SELECT * FROM examples WHERE idempotency_key = ? LIMIT 1").get(idem) as Example | null) ?? null;
  }

  getById(clipId: string): Example | null {
    return (this.db.prepare("SELECT * FROM examples WHERE clip_id = ? LIMIT 1").get(clipId) as Example | null) ?? null;
  }

  insert(e: Example): void {
    this.db
      .prepare(
        `INSERT INTO examples
         (clip_id, speaker, session, prompt_id, prompt_rev, text, split, duration_ms,
          orientation, mirrored, capture_build, consent_rev, idempotency_key, r2_key,
          uploaded_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.clip_id, e.speaker, e.session, e.prompt_id, e.prompt_rev, e.text, e.split,
        e.duration_ms, e.orientation, e.mirrored, e.capture_build, e.consent_rev,
        e.idempotency_key, e.r2_key, e.uploaded_at, e.created_at,
      );
  }

  markUploaded(clipId: string, at: number): boolean {
    const res = this.db.prepare("UPDATE examples SET uploaded_at = ? WHERE clip_id = ?").run(at, clipId);
    return res.changes > 0;
  }

  listUploaded(speaker: string): Example[] {
    return this.db
      .prepare("SELECT * FROM examples WHERE speaker = ? AND uploaded_at IS NOT NULL ORDER BY created_at")
      .all(speaker) as Example[];
  }

  listAll(speaker: string): Example[] {
    return this.db
      .prepare("SELECT * FROM examples WHERE speaker = ? ORDER BY created_at")
      .all(speaker) as Example[];
  }

  getManyByIds(speaker: string, clipIds: string[]): Example[] {
    if (clipIds.length === 0) return [];
    const placeholders = clipIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM examples WHERE speaker = ? AND clip_id IN (${placeholders})`)
      .all(speaker, ...clipIds) as Example[];
  }

  delete(clipId: string): boolean {
    const res = this.db.prepare("DELETE FROM examples WHERE clip_id = ?").run(clipId);
    return res.changes > 0;
  }

  status(speaker: string): Status {
    const rows = this.listAll(speaker);
    const by_split: Record<string, number> = { train: 0, val: 0, test: 0 };
    const by_session: Record<string, number> = {};
    let uploaded = 0;
    let last_uploaded_at: number | null = null;
    for (const r of rows) {
      by_split[r.split] = (by_split[r.split] ?? 0) + 1;
      by_session[r.session] = (by_session[r.session] ?? 0) + 1;
      if (r.uploaded_at != null) {
        uploaded++;
        if (last_uploaded_at == null || r.uploaded_at > last_uploaded_at) last_uploaded_at = r.uploaded_at;
      }
    }
    return { speaker, total: rows.length, uploaded, by_split, by_session, last_uploaded_at };
  }
}
