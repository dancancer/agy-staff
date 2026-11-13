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
 * Older companions can still write the paged `state.json`. The export ID
 * survives their writes, so we can merge their changes against the right page.
 */
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(import.meta.url);

export const STATE_DB_FILENAME = 'state.sqlite';
export const STATE_BACKUP_FILENAME = 'state.json.migrated';
export const STATE_EXPORT_ID = '_agy_staff_export_id';
export const SCHEMA_VERSION = 1;

const KNOWN_TOP_LEVEL = new Set(['conversations', 'last', 'jobs', 'conversation_configs', STATE_EXPORT_ID]);

let sqliteChecked = null;

function mergeEntries(current, legacy, baseline = {}) {
  for (const [key, value] of Object.entries(legacy)) {
    // A failed export can leave stale fields on disk. Keep SQLite's value
    // when it has also changed since this page was read or published.
    if (Object.hasOwn(current, key) !== Object.hasOwn(baseline, key)) continue;
    if (!isDeepStrictEqual(current[key], baseline[key]) || isDeepStrictEqual(current[key], value)) continue;
    Object.defineProperty(current, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  for (const [key, value] of Object.entries(baseline)) {
    if (!Object.hasOwn(legacy, key) && isDeepStrictEqual(current[key], value)) delete current[key];
  }
}

function mergeLegacyJob(current, legacy, exported, hasBaseline) {
  if (exported && current.status === exported.status) {
    // Keep terminal status and its metadata together if SQLite has already
    // finished a job that the old snapshot still considered running.
    mergeEntries(current, legacy, exported);
  } else if (!hasBaseline && current.status === 'running' && legacy.finished_at &&
      ['done', 'error', 'canceled', 'attention'].includes(legacy.status)) {
    // Databases made before export tracking can still recover legacy completions.
    Object.assign(current, { status: legacy.status, finished_at: legacy.finished_at });
    mergeEntries(current, legacy, {});
  }
}

function mergeLegacyState(state, legacy, baseline) {
  if (!Array.isArray(legacy?.jobs) || isDeepStrictEqual(legacy, baseline)) return state;
  const currentJobs = new Map(state.jobs.map((job) => [job.id, job]));
  const exportedJobs = new Map((baseline?.jobs || []).map((job) => [job.id, job]));
  for (const job of legacy.jobs) {
    if (typeof job?.id !== 'string') continue;
    const current = currentJobs.get(job.id);
    const exported = exportedJobs.get(job.id);
    if (!current) {
      const imported = structuredClone(job);
      state.jobs.push(imported);
      currentJobs.set(job.id, imported);
    } else {
      mergeLegacyJob(current, job, exported, Boolean(baseline));
    }
  }
  for (const key of ['conversations', 'conversation_configs']) {
    mergeEntries(state[key], legacy[key] || {}, baseline?.[key]);
  }
  if (Object.hasOwn(legacy, 'last') && isDeepStrictEqual(state.last, baseline ? baseline.last : null)) {
    state.last = structuredClone(legacy.last);
  }
  for (const [key, value] of Object.entries(legacy)) {
    if (KNOWN_TOP_LEVEL.has(key) || Object.hasOwn(state, key)) continue;
    Object.defineProperty(state, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
  }
  return state;
}

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
  #stateExport = null;
  #selectJob;
  #readJobBaseline;

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

  /** Read one job, reconciling only that row with the JSON export. */
  loadJob(id, legacy, exportId) {
    this.#selectJob ||= this.db.prepare('SELECT data FROM jobs WHERE id = ?');
    if (!legacy) {
      const row = this.#selectJob.get(id);
      return row ? JSON.parse(row.data) : null;
    }

    this.db.exec('BEGIN');
    try {
      const row = this.#selectJob.get(id);
      const current = row ? JSON.parse(row.data) : structuredClone(legacy);
      if (row && !isDeepStrictEqual(current, legacy)) {
        // Select the matching page inside SQLite and return only its job row.
        // A matching page with no such row is distinct from an unknown page.
        this.#readJobBaseline ||= this.db.prepare(`
          WITH baseline AS (
            SELECT CASE
              WHEN json_type(value, '$.next') = 'object' AND json_extract(value, '$.next.${STATE_EXPORT_ID}') IS ?
                THEN '$.next'
              WHEN json_type(value, '$.previous') = 'object' AND json_extract(value, '$.previous.${STATE_EXPORT_ID}') IS ?
                THEN '$.previous'
            END AS page, value
            FROM meta WHERE key = 'state_export'
          )
          SELECT page, (
            SELECT job.value FROM json_each(baseline.value, page || '.jobs') AS job
            WHERE json_extract(job.value, '$.id') = ? LIMIT 1
          ) AS job FROM baseline
        `);
        const baseline = this.#readJobBaseline.get(exportId, exportId, id);
        const exported = baseline?.job ? JSON.parse(baseline.job) : null;
        mergeLegacyJob(current, legacy, exported, Boolean(baseline?.page));
      }
      this.db.exec('COMMIT');
      return current;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
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

  loadState(legacy = null) {
    this.db.exec('BEGIN');
    try {
      const state = this.#readState();
      // saveState must diff against the database rows, including legacy changes.
      this.snapshot = this.#snapshotFrom(state);
      this.#stateExport = null;
      const row = this.db.prepare("SELECT value FROM meta WHERE key = 'state_export'").get();
      if (row) this.#stateExport = JSON.parse(row.value);
      if (legacy) {
        const { previous, next } = this.#stateExport || {};
        const baseline = [next, previous].find((page) => page && page[STATE_EXPORT_ID] === legacy[STATE_EXPORT_ID]);
        mergeLegacyState(state, legacy, baseline);
      }
      this.db.exec('COMMIT');
      return state;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  confirmExport() {
    this.#stateExport.previous = this.#stateExport.next;
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'state_export'").run(JSON.stringify(this.#stateExport));
  }

  #readState() {
    const db = this.db;
    const jobs = db.prepare('SELECT data FROM jobs ORDER BY seq').all().map((row) => JSON.parse(row.data));
    const conversations = Object.fromEntries(
      db.prepare('SELECT mode, conversation_id FROM conversations ORDER BY mode').all().map((r) => [r.mode, r.conversation_id])
    );
    const conversation_configs = Object.fromEntries(
      db.prepare('SELECT id, data FROM conversation_configs').all().map((row) => [row.id, JSON.parse(row.data)])
    );
    let last = null;
    const extras = [];
    for (const row of db.prepare('SELECT key, value FROM meta').all()) {
      if (row.key === 'last') last = JSON.parse(row.value);
      else if (row.key.startsWith('extra:')) extras.push([row.key.slice('extra:'.length), JSON.parse(row.value)]);
    }
    return { ...Object.fromEntries(extras), conversations, last, jobs, conversation_configs };
  }

  /** Persist `state`. Diffs against the snapshot taken by the last loadState
   *  (or a full replace when there is none), inside one IMMEDIATE transaction. */
  saveState(state, stateExport) {
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
      if (stateExport) {
        // The last readable page still matters while the JSON file is missing
        // or unreadable. A successful rename advances it via confirmExport().
        stateExport.previous ??= this.#stateExport?.previous ?? null;
        upMeta.run('state_export', JSON.stringify(stateExport));
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    this.snapshot = next;
    if (stateExport) this.#stateExport = stateExport;
  }

  /** One-shot full import (used by the state.json migration). */
  importState(state, stateExport) {
    this.snapshot = null;
    this.saveState(state, stateExport);
  }

  /** Integrity probe used by migration and tests. Throws on a malformed file. */
  integrityCheck() {
    const row = this.db.prepare('PRAGMA integrity_check').get();
    const verdict = row && Object.values(row)[0];
    if (verdict !== 'ok') throw new Error(`state database integrity check failed: ${JSON.stringify(row)}`);
  }
}
