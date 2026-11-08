import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * One SQLite file holds all Feroxes state on the owner's PC (WAL mode, so the apps can read
 * while the Core writes). Schema changes are numbered migrations tracked in `user_version`.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (session_id, seq));
  CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX runs_status ON runs (status);
  CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX steps_run ON steps (run_id, idx);

  CREATE TABLE memories (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX memories_status ON memories (status, updated_at);
  CREATE VIRTUAL TABLE memory_fts USING fts5 (id UNINDEXED, body, tokenize = 'porter unicode61');
  CREATE TABLE memory_events (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX memory_events_memory ON memory_events (memory_id);
  CREATE TABLE memory_sources (memory_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX memory_sources_memory ON memory_sources (memory_id);
  CREATE TABLE memory_links (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id, type));
  CREATE TABLE embeddings (memory_id TEXT NOT NULL, space_id TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (memory_id, space_id));
  CREATE TABLE entities (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE suppressions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE core_snapshots (id TEXT PRIMARY KEY, generated_at INTEGER NOT NULL, data TEXT NOT NULL);

  CREATE TABLE usage_events (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE INDEX usage_events_ts ON usage_events (ts);
  CREATE TABLE budgets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE budget_counters (budget_id TEXT NOT NULL, period_start INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (budget_id, period_start));
  CREATE TABLE reservations (id TEXT PRIMARY KEY, status TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE budget_alerts (budget_id TEXT NOT NULL, period_start INTEGER NOT NULL, threshold INTEGER NOT NULL, PRIMARY KEY (budget_id, period_start, threshold));

  CREATE TABLE audit (seq INTEGER PRIMARY KEY, data TEXT NOT NULL);
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TABLE approvals (id TEXT PRIMARY KEY, status TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE system_state (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
  CREATE TABLE tool_calls (idempotency_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX tool_calls_run ON tool_calls (run_id);
  CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, mime TEXT NOT NULL, content TEXT NOT NULL);
  `,
  `
  CREATE TABLE devices (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE docs (kind TEXT NOT NULL, id TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id));
  CREATE INDEX docs_kind ON docs (kind, updated_at);
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    const current = Number((this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  get version(): number {
    return Number((this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlValue[]) {
    return this.stmt(sql).run(...params);
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  /** Synchronous transaction: atomic within the process and, with IMMEDIATE, across processes. */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  /** Consistent copy of the live database (for backups); safe while Feroxes runs. */
  backupTo(path: string): void {
    this.raw.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export type SqlValue = string | number | bigint | null | Uint8Array;

export const toJson = (v: unknown) => JSON.stringify(v);
export const fromJson = <T>(s: unknown): T => JSON.parse(String(s)) as T;
