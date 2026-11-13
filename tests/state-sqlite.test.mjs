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
import { sandbox, run, jobIdOf, waitForCalls, waitForJob, COMPANION } from './helpers.mjs';

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

function failSnapshotReplacement(sb) {
  const hook = `
    import fs from 'node:fs';
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (target === process.env.AGY_TEST_EXPORT_PATH) throw Object.assign(new Error('injected export failure'), { code: 'EIO' });
      return rename(source, target);
    };
  `;
  return {
    NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`,
    AGY_TEST_EXPORT_PATH: mirrorOf(sb),
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

test('a legacy writer can add a job to an existing unmarked JSON snapshot', () => {
  const sb = sandbox('sqlite-legacy-new-job');
  const original = fullSeed();
  seedJson(sb, original);
  const initialStore = new StateStore(dbOf(sb));
  initialStore.importState(original);
  initialStore.close();

  const legacy = run(sb, ['ask', '--prompt', 'Run this from the old client'], {
    AGY_STAFF_LEGACY_JSON: '1', FAKE_AGY_CONVERSATION_ID: 'conv-legacy-ask',
  });
  assert.equal(legacy.code, 0, legacy.stderr);
  const legacyId = jobIdOf(legacy.stderr);
  const status = run(sb, ['status', legacyId]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /conv-legacy-ask/);

  const modern = run(sb, ['ask', '--prompt', 'Run this from the new client'], {
    FAKE_AGY_CONVERSATION_ID: 'conv-modern-ask',
  });
  assert.equal(modern.code, 0, modern.stderr);
  const store = new StateStore(dbOf(sb));
  const state = store.loadState();
  store.close();
  assert.ok(state.jobs.some((job) => job.id === legacyId && job.status === 'done'));
  assert.ok(state.jobs.some((job) => job.id === jobIdOf(modern.stderr)));
  assert.ok(state.conversation_configs['conv-legacy-ask']);
  assert.ok(JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8')).jobs.some((job) => job.id === legacyId));
});

test('legacy writes can be imported from a marked export that omits older jobs', () => {
  const sb = sandbox('sqlite-legacy-paged');
  const seed = fullSeed();
  seed.jobs.push(...Array.from({ length: 32 }, (_, index) => ({
    ...seedJob(`research-later-${index}`), started_at: '2026-11-01T00:00:00Z',
  })));
  seedJson(sb, seed);
  const migrate = run(sb, ['cancel', seed.jobs[0].id]);
  assert.equal(migrate.code, 0, migrate.stderr);
  const before = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  assert.equal(before.jobs.length, 32);
  assert.ok(!before.jobs.some((job) => job.id === seed.jobs[0].id));

  const legacy = run(sb, ['ask', '--prompt', 'Add a job to the paged snapshot'], {
    AGY_STAFF_LEGACY_JSON: '1', FAKE_AGY_CONVERSATION_ID: 'conv-legacy-paged',
  });
  assert.equal(legacy.code, 0, legacy.stderr);
  const legacyId = jobIdOf(legacy.stderr);
  const synced = run(sb, ['cancel', legacyId]);
  assert.equal(synced.code, 0, synced.stderr);
  const store = new StateStore(dbOf(sb));
  const state = store.loadState();
  store.close();
  assert.equal(state.jobs.length, seed.jobs.length + 1, 'a missing job on the page is not a deletion');
  assert.ok(state.jobs.some((job) => job.id === legacyId));
  assert.equal(state.conversations.ask, 'conv-legacy-paged');
  assert.equal(state.last.id, 'conv-legacy-paged');
});

test('a legacy worker can finish a registered job after migration', async () => {
  const sb = sandbox('sqlite-legacy-worker');
  const seed = fullSeed();
  seedJson(sb, seed);
  const release = path.join(sb.root, 'release-agy');
  const legacyEnv = { AGY_STAFF_LEGACY_JSON: '1' };
  const started = run(sb, ['research', '--prompt', 'Finish after migration', '--timeout', '30s'], {
    ...legacyEnv, FAKE_AGY_RELEASE_FILE: release, FAKE_AGY_CONVERSATION_ID: 'conv-legacy-worker',
  });
  assert.equal(started.code, 0, started.stderr);
  const id = jobIdOf(started.stdout);

  try {
    await waitForCalls(sb, 1);
    const migrate = run(sb, ['cancel', seed.jobs[0].id]);
    assert.equal(migrate.code, 0, migrate.stderr);
    assert.ok(fs.existsSync(dbOf(sb)));
  } finally {
    fs.writeFileSync(release, '');
  }
  const waited = run(sb, ['wait', id, '--timeout', '30s'], legacyEnv);
  assert.equal(waited.code, 0, waited.stderr);
  await waitForJob(sb, id);
  const sync = run(sb, ['cancel', seed.jobs[0].id]);
  assert.equal(sync.code, 0, sync.stderr);

  const store = new StateStore(dbOf(sb));
  const job = store.loadState().jobs.find((entry) => entry.id === id);
  store.close();
  assert.equal(job.status, 'done', 'SQLite must record the terminal state, even without the result sidecar');
  const mirror = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  assert.equal(mirror.jobs.find((entry) => entry.id === id).status, 'done');
});

test('a failed snapshot replacement lets the job finish and the next write repairs the export', () => {
  const sb = sandbox('sqlite-export-failure');
  const seed = fullSeed();
  seedJson(sb, seed);
  const migrate = run(sb, ['cancel', seed.jobs[0].id]);
  assert.equal(migrate.code, 0, migrate.stderr);
  const before = fs.readFileSync(mirrorOf(sb), 'utf8');
  const failExport = {
    ...failSnapshotReplacement(sb),
    FAKE_AGY_CONVERSATION_ID: 'conv-with-failed-export',
  };
  const started = run(sb, ['research', '--prompt', 'Complete despite the failed export'], failExport);
  assert.equal(started.code, 0, started.stderr);
  assert.match(started.stderr, /warning: .*export .*state\.json.*injected export failure/i);
  const id = jobIdOf(started.stdout);
  const waited = run(sb, ['wait', id, '--timeout', '30s']);
  assert.equal(waited.code, 0, waited.stdout + waited.stderr);
  assert.match(waited.stdout, /fake answer/);
  assert.equal(fs.readFileSync(mirrorOf(sb), 'utf8'), before, 'the last good snapshot remains available');
  assert.equal(fs.readdirSync(stateDirOf(sb)).some((name) => name.startsWith('state.json.tmp-')), false);

  const legacy = run(sb, ['ask', '--prompt', 'Write to the last good snapshot'], {
    AGY_STAFF_LEGACY_JSON: '1', FAKE_AGY_CONVERSATION_ID: 'conv-during-export-failure',
  });
  assert.equal(legacy.code, 0, legacy.stderr);
  const legacyId = jobIdOf(legacy.stderr);
  const retry = run(sb, ['cancel', seed.jobs[0].id]);
  assert.equal(retry.code, 0, retry.stderr);
  const mirror = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  for (const jobId of [id, legacyId]) {
    assert.equal(mirror.jobs.find((job) => job.id === jobId)?.status, 'done');
  }
  assert.equal(mirror.conversations.research, 'conv-with-failed-export', 'a stale legacy snapshot must not reset a newer conversation');
});

test('a failed first export keeps the original JSON available to older workers', () => {
  const sb = sandbox('sqlite-initial-export-failure');
  const seed = fullSeed();
  const runningId = 'research-legacy-running';
  seed.jobs.push({ ...seedJob(runningId, 'running'), finished_at: null, conversation_id: null });
  const original = seedJson(sb, seed);
  const migrated = run(sb, ['cancel', seed.jobs[0].id], failSnapshotReplacement(sb));
  assert.equal(migrated.code, 0, migrated.stderr);
  assert.match(migrated.stderr, /could not export .*injected export failure/);
  assert.equal(fs.readFileSync(mirrorOf(sb), 'utf8'), original);
  assert.equal(fs.readFileSync(backupOf(sb), 'utf8'), original);

  Object.assign(seed.jobs.at(-1), { status: 'done', finished_at: '2026-11-13T00:00:00Z', conversation_id: 'conv-after-first-export' });
  seedJson(sb, seed);
  const synced = run(sb, ['cancel', runningId]);
  assert.equal(synced.code, 0, synced.stderr);
  const store = new StateStore(dbOf(sb));
  try {
    const job = store.loadState().jobs.find((entry) => entry.id === runningId);
    assert.equal(job.status, 'done');
    assert.equal(job.conversation_id, 'conv-after-first-export');
  } finally {
    store.close();
  }
});

test('a broken JSON export destination does not block SQLite jobs or revive stale state', () => {
  const sb = sandbox('sqlite-export-destination');
  const seed = fullSeed();
  const runningId = 'research-legacy-running';
  seed.jobs.push({ ...seedJob(runningId, 'running'), finished_at: null, conversation_id: null });
  seedJson(sb, seed);
  const migrate = run(sb, ['cancel', seed.jobs[0].id]);
  assert.equal(migrate.code, 0, migrate.stderr);
  const saved = `${mirrorOf(sb)}.saved`;
  fs.renameSync(mirrorOf(sb), saved);
  fs.mkdirSync(mirrorOf(sb));

  const done = run(sb, ['ask', '--prompt', 'Complete from SQLite'], {
    FAKE_AGY_CONVERSATION_ID: 'conv-with-missing-export',
  });
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stderr, /could not export .*state\.json/);
  const id = jobIdOf(done.stderr);
  assert.equal(run(sb, ['wait', id]).code, 0);

  fs.rmdirSync(mirrorOf(sb));
  fs.renameSync(saved, mirrorOf(sb));
  const legacy = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  Object.assign(legacy.jobs.find((job) => job.id === runningId), {
    status: 'done', finished_at: '2026-11-13T00:00:00Z', conversation_id: 'conv-after-restoring-export',
  });
  seedJson(sb, legacy);
  const retry = run(sb, ['cancel', seed.jobs[0].id]);
  assert.equal(retry.code, 0, retry.stderr);
  const snapshot = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  assert.equal(snapshot.jobs.find((job) => job.id === id)?.status, 'done');
  assert.equal(snapshot.last.id, 'conv-with-missing-export');
  assert.equal(snapshot.jobs.find((job) => job.id === runningId)?.conversation_id, 'conv-after-restoring-export');
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

test('stale running rows reconcile from the result file on read and export', () => {
  const sb = sandbox('sqlite-reconcile');
  const jobs = path.join(stateDirOf(sb), 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const row = (id, status, extra = {}) => ({
    id, mode: 'review', status, pid: 99999999, started_at: '2026-09-01T00:00:00Z',
    result_file: path.join(jobs, `${id}.result.md`), log_file: path.join(jobs, `${id}.log`), ...extra,
  });
  const staleDone = row('review-stale-done', 'running');
  const staleAtt = row('review-stale-att', 'running');
  const staleSidecar = row('review-stale-sidecar', 'running');
  const aliveNoResult = row('review-alive-noresult', 'running', { pid: process.pid });
  const aliveWithResult = row('review-alive-result', 'running', { pid: process.pid });
  const deadNoResult = row('review-dead-noresult', 'running');
  fs.writeFileSync(staleDone.result_file, 'Review report\n\ncontent\n');
  fs.writeFileSync(staleAtt.result_file, 'Job needs attention: conversation is resumable\n');
  fs.writeFileSync(aliveWithResult.result_file, 'Report mid-flight\n');
  fs.writeFileSync(staleSidecar.result_file, 'Abandoned run\n');
  fs.writeFileSync(staleSidecar.result_file + '.status.json',
    JSON.stringify({ status: 'canceled', reason: 'canceled', finished_at: '2026-09-09T00:00:00Z' }));
  seedJson(sb, {
    conversations: {}, last: null,
    jobs: [staleDone, staleAtt, staleSidecar, aliveNoResult, aliveWithResult, deadNoResult, seedJob('review-seed-done')],
  });

  const cancel = run(sb, ['cancel', 'review-seed-done']);
  assert.equal(cancel.code, 0, cancel.stderr);

  const mirror = JSON.parse(fs.readFileSync(mirrorOf(sb), 'utf8'));
  const byId = new Map(mirror.jobs.map((j) => [j.id, j]));
  assert.equal(byId.get('review-stale-done').status, 'done', 'result evidence overrides the stuck status in the export');
  assert.ok(byId.get('review-stale-done').finished_at, 'finished_at is backfilled from the result mtime');
  assert.equal(byId.get('review-stale-done').reconciled_by, 'companion-read-reconcile');
  assert.equal(byId.get('review-stale-att').status, 'attention', 'a needs-attention report reconciles to attention');
  assert.equal(byId.get('review-stale-sidecar').status, 'canceled', 'the final sidecar is the authoritative verdict');
  assert.equal(byId.get('review-stale-sidecar').finished_at, '2026-09-09T00:00:00Z', 'the sidecar stamp beats the file mtime');
  assert.equal(byId.get('review-stale-sidecar').reconciled_by, 'companion-read-reconcile');
  assert.equal(byId.get('review-alive-noresult').status, 'running', 'a live worker without a result is untouched');
  assert.equal(byId.get('review-alive-result').status, 'running', 'a live worker with a result is untouched');
  assert.ok(!byId.get('review-alive-result').reconciled_by);
  assert.equal(byId.get('review-dead-noresult').status, 'running', 'a dead pid alone is not evidence without a result');

  // The correction persists into the database through the same save.
  const store = new StateStore(dbOf(sb));
  const dbById = new Map(store.loadState().jobs.map((j) => [j.id, j]));
  store.close();
  assert.equal(dbById.get('review-stale-done').status, 'done');
  assert.equal(dbById.get('review-stale-att').status, 'attention');
  assert.equal(dbById.get('review-alive-result').status, 'running');

  // Reconciled zombies no longer claim a slot as unfinished.
  assert.deepEqual(
    mirror.jobs.filter((j) => ['running', 'queued', 'attention'].includes(j.status)).map((j) => j.id).sort(),
    ['review-alive-noresult', 'review-alive-result', 'review-dead-noresult', 'review-stale-att'].sort(),
    'only live workers, the result-less dead row, and the attention verdict count as unfinished');

  // Read-only commands keep displaying the truth without writing.
  const before = fs.readFileSync(mirrorOf(sb), 'utf8');
  const status = run(sb, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(fs.readFileSync(mirrorOf(sb), 'utf8'), before, 'status stays read-only');
});
