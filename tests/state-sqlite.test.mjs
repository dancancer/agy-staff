/** SQLite state-store tests (successor of the whole-file state.json rewrite).
 *
 *  Covers the promised behavior surface:
 *   - read-side compatibility: no state.sqlite → state.json keeps being read,
 *     and read-only commands never create a database;
 *   - one-shot import on the first write, with the original preserved as
 *     state.json.migrated and state.json republished as the export mirror;
 *   - exact round trip of conversations/last/conversation_configs and any
 *     unrecognized top-level keys;
 *   - corrupt-database loud failure plus the documented `move it aside`
 *     fallback to the exported snapshot;
 *   - AGY_STAFF_LEGACY_JSON=1 staying on the JSON-only path;
 *   - multi-process read-modify-write under the state lock losing nothing,
 *     with concurrent readers never failing;
 *   - migration racing live background jobs without losing registry entries.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StateStore } from '../companion/state-db.mjs';
import { sandbox, run, jobIdOf, waitForJob, COMPANION } from './helpers.mjs';

const stateDirOf = (sb) => path.join(sb.repo, '.agy-staff');
const mirrorOf = (sb) => path.join(stateDirOf(sb), 'state.json');
const dbOf = (sb) => path.join(stateDirOf(sb), 'state.sqlite');
const backupOf = (sb) => path.join(stateDirOf(sb), 'state.json.migrated');

function seedJson(sb, state) {
  const dir = stateDirOf(sb);
  fs.mkdirSync(dir, { recursive: true });
  const raw = JSON.stringify(state, null, 2) + '\n';
  fs.writeFileSync(mirrorOf(sb), raw);
  return raw;
}

function seedJob(id, status = 'done') {
  return { id, mode: 'research', status, pid: 99999999, started_at: '2026-09-07T00:00:00Z', finished_at: '2026-09-07T00:01:00Z' };
}

function fullSeed() {
  return {
    conversations: { research: 'conv-1', implement: 'conv-2' },
    last: { mode: 'research', id: 'conv-1', model: 'gemini-test', profile: 'restricted' },
    jobs: [seedJob('research-seed-done'), seedJob('research-seed-error', 'error')],
    conversation_configs: { 'conv-1': { mode: 'research', model: 'gemini-test', profile: 'restricted', cwd: '/tmp/seed' } },
    future_field: { nested: [1, 2, 3] },
  };
}

test('read-only commands fall back to state.json and never create a database', () => {
  const sb = sandbox('sqlite-readonly');
  const raw = seedJson(sb, fullSeed());
  const status = run(sb, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /research-seed-done/);
  assert.ok(!fs.existsSync(dbOf(sb)), 'status must not migrate to SQLite');
  assert.equal(fs.readFileSync(mirrorOf(sb), 'utf8'), raw, 'read-only runs leave the JSON file untouched');
});

test('first write imports state.json once, keeps the backup, and republishes the mirror', () => {
  const sb = sandbox('sqlite-migrate');
  const raw = seedJson(sb, fullSeed());
  const cancel = run(sb, ['cancel', 'research-seed-done']);
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.match(cancel.stdout, /not running \(status: done\)/);
  assert.ok(fs.existsSync(dbOf(sb)), 'state.sqlite created by the first write');
  assert.ok(fs.existsSync(backupOf(sb)), 'original preserved as state.json.migrated');
  assert.equal(fs.readFileSync(backupOf(sb), 'utf8'), raw, 'backup is byte-identical to the imported original');

  // The database is the truth and must round-trip the legacy shape exactly.
  const store = new StateStore(dbOf(sb));
  const state = store.loadState();
  store.close();
  const seed = fullSeed();
  assert.deepEqual(state.conversations, seed.conversations);
  assert.deepEqual(state.last, seed.last);
  assert.deepEqual(state.conversation_configs, seed.conversation_configs);
  assert.deepEqual(state.future_field, seed.future_field, 'unknown top-level keys survive the import');
  assert.deepEqual(state.jobs.map((j) => j.id), seed.jobs.map((j) => j.id), 'job order is preserved');

  // state.json is republished as the exported snapshot; a second write must
  // not re-import or replace the backup.
  const mirror = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  assert.deepEqual(mirror.jobs.map((j) => j.id), seed.jobs.map((j) => j.id));
  assert.deepEqual(mirror.future_field, seed.future_field, 'the mirror keeps unknown keys too');
  const again = run(sb, ['cancel', 'research-seed-error']);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(fs.readFileSync(backupOf(sb), 'utf8'), raw, 'second write must not touch the backup');
  assert.equal(fs.readdirSync(stateDirOf(sb)).filter((n) => n.startsWith('state.json.migrated')).length, 1);
});

test('corrupt state.json still dies loudly during migration', () => {
  const sb = sandbox('sqlite-corrupt-json');
  seedJson(sb, { jobs: [seedJob('x')] });
  fs.writeFileSync(mirrorOf(sb), '{"conversations":{"research":"conv-9"},"jobs":[{"id":"resea');
  const cancel = run(sb, ['cancel', 'x']);
  assert.notEqual(cancel.code, 0);
  assert.match(cancel.stderr, /state file is corrupt/);
  assert.ok(!fs.existsSync(dbOf(sb)), 'a failed import must not leave a half-built database behind');
});

test('corrupt state.sqlite fails loudly; moving it aside falls back to the snapshot', () => {
  const sb = sandbox('sqlite-corrupt-db');
  seedJson(sb, fullSeed());
  assert.equal(run(sb, ['cancel', 'research-seed-done']).code, 0);
  fs.writeFileSync(dbOf(sb), 'this is definitely not a sqlite database');
  const broken = run(sb, ['status']);
  assert.notEqual(broken.code, 0);
  assert.match(broken.stderr, /cannot read state database/);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbOf(sb) + suffix, { force: true });
  const fallback = run(sb, ['status']);
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.match(fallback.stdout, /research-seed-done/, 'the exported snapshot answers reads once the DB is moved aside');
});

test('AGY_STAFF_LEGACY_JSON=1 keeps the JSON-only path and can switch later', () => {
  const sb = sandbox('sqlite-legacy-env');
  seedJson(sb, fullSeed());
  const cancel = run(sb, ['cancel', 'research-seed-done'], { AGY_STAFF_LEGACY_JSON: '1' });
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.ok(!fs.existsSync(dbOf(sb)), 'legacy mode never creates state.sqlite');
  assert.ok(!fs.existsSync(backupOf(sb)), 'legacy mode never renames state.json');
  const modern = run(sb, ['cancel', 'research-seed-error']);
  assert.equal(modern.code, 0, modern.stderr);
  assert.ok(fs.existsSync(dbOf(sb)), 'dropping the env var migrates on the next write');
});

test('concurrent writers under the state lock lose nothing; readers never fail', async () => {
  const sb = sandbox('sqlite-concurrent');
  seedJson(sb, { jobs: [{ ...seedJob('counter', 'done'), n: 0 }] });
  assert.equal(run(sb, ['cancel', 'counter']).code, 0); // migrate first

  const dir = stateDirOf(sb);
  const moduleUrl = new URL('../companion/state-db.mjs', import.meta.url).href;
  const lockUrl = new URL('../companion/state-lock.mjs', import.meta.url).href;
  const cycles = 60;
  const writerScript = `
    import { StateStore } from ${JSON.stringify(moduleUrl)};
    import { withStateLock } from ${JSON.stringify(lockUrl)};
    for (let i = 0; i < ${cycles}; i++) {
      withStateLock(${JSON.stringify(path.join(dir, 'state.json.lock'))}, () => {
        const store = new StateStore(${JSON.stringify(dbOf(sb))});
        const state = store.loadState();
        const job = state.jobs.find((j) => j.id === 'counter');
        job.n = (job.n || 0) + 1;
        store.saveState(state);
        store.close();
      });
    }`;
  const readerScript = `
    import fs from 'node:fs';
    import { StateStore } from ${JSON.stringify(moduleUrl)};
    let reads = 0;
    while (fs.existsSync(${JSON.stringify(path.join(dir, 'done.flag'))}) === false) {
      const store = new StateStore(${JSON.stringify(dbOf(sb))});
      const state = store.loadState();
      if (!Array.isArray(state.jobs)) throw new Error('torn registry read');
      store.close();
      reads++;
    }
    if (reads < 1) throw new Error('reader observed nothing');`;

  const spawnChild = (script) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${stderr}`)));
  });

  try {
    const writers = [spawnChild(writerScript), spawnChild(writerScript), spawnChild(writerScript)];
    const readers = [spawnChild(readerScript), spawnChild(readerScript)];
    await Promise.all(writers);
    fs.writeFileSync(path.join(dir, 'done.flag'), '1');
    await Promise.all(readers);
    const store = new StateStore(dbOf(sb));
    const state = store.loadState();
    store.close();
    assert.equal(state.jobs.find((j) => j.id === 'counter').n, cycles * 3, 'every increment survived 3-way contention');
    const mirror = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
    assert.ok(Array.isArray(mirror.jobs), 'mirror remains parseable');
  } finally {
    fs.rmSync(path.join(dir, 'done.flag'), { force: true });
  }
});

test('migration racing live background jobs keeps every registry entry', async () => {
  const sb = sandbox('sqlite-migrate-race');
  seedJson(sb, { conversations: {}, last: null, jobs: [seedJob('research-seed-done')] });
  const first = run(sb, ['research', '--prompt', 'first background task']);
  assert.equal(first.code, 0, first.stderr);
  const idA = jobIdOf(first.stdout);
  const second = run(sb, ['research', '--prompt', 'second background task']);
  assert.equal(second.code, 0, second.stderr);
  const idB = jobIdOf(second.stdout);
  assert.equal(await waitForJob(sb, idA), 'done');
  assert.equal(await waitForJob(sb, idB), 'done');

  const store = new StateStore(dbOf(sb));
  const state = store.loadState();
  store.close();
  const byId = new Map(state.jobs.map((j) => [j.id, j]));
  assert.ok(byId.has('research-seed-done'), 'the pre-migration job survives the import race');
  assert.equal(byId.get(idA)?.status, 'done');
  assert.equal(byId.get(idB)?.status, 'done');
  const mirror = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  assert.deepEqual(mirror.jobs.map((j) => j.id).sort(), state.jobs.map((j) => j.id).sort(), 'mirror and database agree');
});

test('database is created in WAL mode', () => {
  const sb = sandbox('sqlite-wal');
  seedJson(sb, fullSeed());
  assert.equal(run(sb, ['cancel', 'research-seed-done']).code, 0);
  const store = new StateStore(dbOf(sb));
  const mode = store.db.prepare('PRAGMA journal_mode').get();
  store.close();
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
});

test('the exported snapshot keeps live jobs plus the latest page', () => {
  const sb = sandbox('sqlite-export-page');
  const jobs = [];
  for (let i = 0; i < 40; i++) {
    jobs.push({
      id: `research-old-${String(i).padStart(2, '0')}`, mode: 'research', status: 'done', pid: 99999999,
      started_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      finished_at: new Date(Date.UTC(2026, 0, 1 + i, 1)).toISOString(),
    });
  }
  jobs[5].status = 'running'; // started early: live jobs survive regardless of recency
  jobs[17].status = 'queued';
  jobs[33].status = 'attention';
  const seed = {
    conversations: { research: 'conv-1' }, last: null, jobs,
    conversation_configs: { 'conv-1': { mode: 'research', model: 'gemini-test' } },
  };
  seedJson(sb, seed);
  const cancel = run(sb, ['cancel', 'research-old-00']);
  assert.equal(cancel.code, 0, cancel.stderr);

  const mirror = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  assert.equal(mirror.jobs.length, 32, 'the export fits one latest page');
  const ids = new Set(mirror.jobs.map((j) => j.id));
  for (const live of ['research-old-05', 'research-old-17', 'research-old-33']) {
    assert.ok(ids.has(live), `${live} (unfinished) must be exported even when outdated`);
  }
  const finishedDesc = jobs.filter((j) => !['running', 'queued', 'attention'].includes(j.status))
    .sort((a, b) => b.started_at.localeCompare(a.started_at));
  assert.ok(ids.has(finishedDesc[0].id), 'the newest finished record is exported');
  assert.ok(ids.has(finishedDesc[28].id), 'the page fills up to 32 with the newest finished records');
  assert.ok(!ids.has(finishedDesc[29].id), 'older finished records stay only in the database');
  assert.equal(finishedDesc.filter((j) => ids.has(j.id)).length, 29);
  assert.deepEqual(mirror.conversations, seed.conversations);
  assert.deepEqual(mirror.conversation_configs, seed.conversation_configs);

  const store = new StateStore(dbOf(sb));
  assert.equal(store.loadState().jobs.length, 40, 'the database keeps the full registry');
  store.close();
});
