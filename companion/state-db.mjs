/**
 * SQLite-backed job state (the successor of the whole-file state.json rewrite).
 *
 * The JSON state object keeps its exact shape; this module is a persistence
 * adapter, not a new domain model:
 *
 *   - `jobs`                  one row per job record (full JSON per row, rowid
 *                             order == legacy array order), so a single job
 *                             event rewrites one row instead of the whole file
 *   - `conversations`         mode → conversation id
 *   - `conversation_configs`  conversation id → configuration record JSON
 *   - `meta`                  schema version, `last`, and any unrecognized
 *                             top-level keys (`extra:<key>`), which are kept
 *                             verbatim so the round trip never loses data
 *
 * WAL mode lets readers observe a stable snapshot while a writer commits, and
 * busy_timeout turns "another process is mid-transaction" into a short wait
 * instead of a read failure. Writes use BEGIN IMMEDIATE so a read-modify-write
 * cycle takes the write lock up front.
 *
 * `state.json` stays on disk as a one-way exported snapshot (written after
 * every state save). External readers — the DSH sidebar, humans, and older
 * companion builds — keep working from it; only this process family reads the
 * database, so there is no double-write divergence inside the companion.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const STATE_DB_FILENAME = 'state.sqlite';
export const STATE_BACKUP_FILENAME = 'state.json.migrated';
export const SCHEMA_VERSION = 1;

const KNOWN_TOP_LEVEL = new Set(['conversations', 'last', 'jobs', 'conversation_configs']);

let sqliteChecked = null;

/** Load `node:sqlite` once. Older Node (< 22.5, or < 23.4 without the
 *  experimental flag) cannot resolve it: callers then keep using the legacy
 *  JSON path, which remains fully functional. */
export function sqliteCtor() {
  if (sqliteChecked === null) {
    try {
      sqliteChecked = require('node:sqlite').DatabaseSync || false;
    } catch {
      sqliteChecked = false;
    }
  }
  return sqliteChecked || null;
}

export class StateStore {
  constructor(dbPath) {
    const DatabaseSync = sqliteCtor();
    if (!DatabaseSync) {
      throw new Error('node:sqlite is unavailable on this Node runtime (needs Node >= 23.4); set AGY_STAFF_LEGACY_JSON=1 to keep using state.json-only mode');
    }
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    // busy_timeout first: every later statement (including the journal_mode
    // upgrade for a fresh file) then waits out a concurrent writer instead of
    // failing instantly with "database is locked".
    this.db.exec('PRAGMA busy_timeout=10000');
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (mode TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_configs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!version) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(version.value) !== SCHEMA_VERSION) {
      throw new Error(`unsupported state schema version ${version.value} (this companion understands ${SCHEMA_VERSION})`);
    }
    this.snapshot = null;
  }

  close() {
    this.db.close();
  }

  #snapshotFrom(state) {
    const jobs = new Map();
    for (const job of Array.isArray(state.jobs) ? state.jobs : []) {
      if (job && typeof job === 'object' && job.id !== undefined) jobs.set(String(job.id), JSON.stringify(job));
    }
    const conversations = new Map(Object.entries(state.conversations || {}));
    const configs = new Map();
    for (const [id, config] of Object.entries(state.conversation_configs || {})) {
      configs.set(id, JSON.stringify(config));
    }
    const meta = new Map([['last', JSON.stringify(state.last ?? null)]]);
    for (const key of Object.keys(state)) {
      if (!KNOWN_TOP_LEVEL.has(key)) meta.set(`extra:${key}`, JSON.stringify(state[key]));
    }
    return { jobs, conversations, configs, meta };
  }

  loadState() {
    const db = this.db;
    const jobs = db.prepare('SELECT data FROM jobs ORDER BY seq').all().map((row) => JSON.parse(row.data));
    const conversations = Object.fromEntries(
      db.prepare('SELECT mode, conversation_id FROM conversations ORDER BY mode').all().map((r) => [r.mode, r.conversation_id])
    );
    const conversation_configs = {};
    for (const row of db.prepare('SELECT id, data FROM conversation_configs').all()) {
      conversation_configs[row.id] = JSON.parse(row.data);
    }
    let last = null;
    const extras = [];
    for (const row of db.prepare('SELECT key, value FROM meta').all()) {
      if (row.key === 'last') last = JSON.parse(row.value);
      else if (row.key.startsWith('extra:')) extras.push([row.key.slice('extra:'.length), JSON.parse(row.value)]);
    }
    const state = {};
    for (const [key, value] of extras) state[key] = value;
    state.conversations = conversations;
    state.last = last;
    state.jobs = jobs;
    state.conversation_configs = conversation_configs;
    this.snapshot = this.#snapshotFrom(state);
    return state;
  }

  /** Persist `state`. Diffs against the snapshot taken by the last loadState
   *  (or a full replace when there is none), inside one IMMEDIATE transaction. */
  saveState(state) {
    const db = this.db;
    const next = this.#snapshotFrom(state);
    const prev = this.snapshot;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!prev) db.exec('DELETE FROM jobs; DELETE FROM conversations; DELETE FROM conversation_configs;');
      const prevJobs = prev ? prev.jobs : new Map();
      const updateJob = db.prepare('UPDATE jobs SET data = ? WHERE id = ?');
      const insertJob = db.prepare('INSERT INTO jobs (id, data) VALUES (?, ?)');
      const deleteJob = db.prepare('DELETE FROM jobs WHERE id = ?');
      for (const [id, data] of next.jobs) {
        if (prevJobs.has(id)) {
          if (prevJobs.get(id) !== data) updateJob.run(data, id);
        } else insertJob.run(id, data);
      }
      for (const id of prevJobs.keys()) if (!next.jobs.has(id)) deleteJob.run(id);

      const prevConv = prev ? prev.conversations : new Map();
      const upConv = db.prepare('INSERT INTO conversations (mode, conversation_id) VALUES (?, ?) ON CONFLICT(mode) DO UPDATE SET conversation_id = excluded.conversation_id');
      const delConv = db.prepare('DELETE FROM conversations WHERE mode = ?');
      for (const [mode, id] of next.conversations) upConv.run(mode, String(id));
      for (const mode of prevConv.keys()) if (!next.conversations.has(mode)) delConv.run(mode);

      const prevCfg = prev ? prev.configs : new Map();
      const upCfg = db.prepare('INSERT INTO conversation_configs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data');
      const delCfg = db.prepare('DELETE FROM conversation_configs WHERE id = ?');
      for (const [id, data] of next.configs) {
        if (!prevCfg.has(id) || prevCfg.get(id) !== data) upCfg.run(id, data);
      }
      for (const id of prevCfg.keys()) if (!next.configs.has(id)) delCfg.run(id);

      const prevMeta = prev ? prev.meta : null;
      const upMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      const delMeta = db.prepare('DELETE FROM meta WHERE key = ?');
      for (const [key, value] of next.meta) {
        if (!prevMeta || prevMeta.get(key) !== value) upMeta.run(key, value);
      }
      if (prevMeta) {
        for (const key of prevMeta.keys()) if (!next.meta.has(key)) delMeta.run(key);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    this.snapshot = next;
  }

  /** One-shot full import (used by the state.json migration). */
  importState(state) {
    this.snapshot = null;
    this.saveState(state);
  }

  /** Integrity probe used by migration and tests. Throws on a malformed file. */
  integrityCheck() {
    const row = this.db.prepare('PRAGMA integrity_check').get();
    const verdict = row && Object.values(row)[0];
    if (verdict !== 'ok') throw new Error(`state database integrity check failed: ${JSON.stringify(row)}`);
  }
}
