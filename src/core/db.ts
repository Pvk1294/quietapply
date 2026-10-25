import { DatabaseSync } from "node:sqlite";
import { ensureHome, type Paths, paths } from "./paths.js";

/**
 * One SQLite file holds the answer memory, applications, questions and runs.
 * node:sqlite ships with Node 22.13+, so there is no native module to compile on install.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE answers (
     id INTEGER PRIMARY KEY,
     key TEXT,
     question TEXT NOT NULL,
     aliases TEXT NOT NULL DEFAULT '[]',
     answer TEXT NOT NULL,
     type TEXT NOT NULL DEFAULT 'text',
     scope TEXT NOT NULL DEFAULT 'global',
     scope_value TEXT,
     sensitive INTEGER NOT NULL DEFAULT 0,
     source TEXT NOT NULL DEFAULT 'you',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     uses INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX answers_key ON answers(key);

   CREATE TABLE applications (
     id INTEGER PRIMARY KEY,
     company TEXT NOT NULL,
     title TEXT NOT NULL,
     url TEXT NOT NULL UNIQUE,
     ats TEXT NOT NULL DEFAULT 'unknown',
     location TEXT,
     source TEXT NOT NULL DEFAULT 'manual',
     description TEXT,
     status TEXT NOT NULL DEFAULT 'queued',
     reason TEXT,
     blocked_category TEXT,
     evidence TEXT,
     review_approved INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     submitted_at TEXT
   );
   CREATE INDEX applications_status ON applications(status);

   CREATE TABLE application_events (
     id INTEGER PRIMARY KEY,
     application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
     status TEXT NOT NULL,
     note TEXT,
     at TEXT NOT NULL
   );

   CREATE TABLE questions (
     id INTEGER PRIMARY KEY,
     application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
     question TEXT NOT NULL,
     context TEXT,
     options TEXT,
     field_type TEXT NOT NULL DEFAULT 'text',
     status TEXT NOT NULL DEFAULT 'open',
     answer TEXT,
     memory_id INTEGER REFERENCES answers(id) ON DELETE SET NULL,
     created_at TEXT NOT NULL,
     answered_at TEXT
   );
   CREATE INDEX questions_status ON questions(status);

   CREATE TABLE question_apps (
     question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
     application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
     PRIMARY KEY (question_id, application_id)
   );

   CREATE TABLE runs (
     id INTEGER PRIMARY KEY,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     status TEXT NOT NULL DEFAULT 'running',
     provider TEXT NOT NULL,
     dry_run INTEGER NOT NULL DEFAULT 1,
     trigger TEXT NOT NULL DEFAULT 'manual',
     summary TEXT,
     log_path TEXT
   );

   CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

export type DB = DatabaseSync;

export function openDb(p: Paths = paths()): DB {
  ensureHome(p);
  const db = new DatabaseSync(p.db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/** In-memory database for tests. */
export function openMemoryDb(): DB {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function kvGet(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}
