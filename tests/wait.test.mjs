/**
 * The job-wait contract: machine-readable exit codes on `status <id>` and the
 * blocking `wait` subcommand.
 *
 * Codes: 0 = done, 2 = running (for wait: its own timeout expired while the
 * job kept running — call it again), 3 = error/crashed, 4 = canceled, 1 =
 * generic companion error (unknown id). The point of the contract is that a
 * caller can loop on "exit code 2" with zero output parsing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StateStore } from '../companion/state-db.mjs';
import { sandbox, run, jobIdOf, jobLog, waitForJob } from './helpers.mjs';

describe('status <id> exit codes', () => {
  test('running → 2, done → 0', async () => {
    const sb = sandbox('waitc-status');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '3000' });
    const id = jobIdOf(started.stdout);

    const running = run(sb, ['status', id]);
    assert.equal(running.code, 2, `expected running exit code 2\n${running.stdout}${running.stderr}`);

    await waitForJob(sb, id);
    const done = run(sb, ['status', id]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /"status": "done"/);
  });

  test('error → 3, unknown id → 1, list form stays 0', async () => {
    const sb = sandbox('waitc-status-err');
    // an ERROR with a response would be delivered (done_with_warnings); a real
    // failure has no response
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '' });
    const id = jobIdOf(started.stdout);
    await waitForJob(sb, id);

    assert.equal(run(sb, ['status', id]).code, 3);
    assert.equal(run(sb, ['status', 'no-such-job']).code, 1);
    assert.equal(run(sb, ['status']).code, 0);
  });
});

describe('wait', () => {
  test('blocks until done, prints the result, exits 0', async () => {
    const sb = sandbox('wait-done');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`# Job ${id} \\(research, done\\)`));
    assert.match(r.stdout, /fake answer/);
  });

  test('the delivered result is the body only; telemetry stays in the job log', async () => {
    const sb = sandbox('wait-telemetry');
    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /fake answer/);
    assert.doesNotMatch(r.stdout, /\[agy-staff\]/);
    assert.doesNotMatch(r.stdout, /follow up with continue --job/);

    const log = jobLog(sb, id);
    assert.match(log, /\[agy-staff\] mode=research profile=unrestricted model=\S+ /);
    assert.match(log, new RegExp(`^conversation: conv-1 \\(follow up with continue --job ${id}\\)$`, 'm'));
  });

  test('own timeout while the job runs → exit 2, then a second wait succeeds', async () => {
    const sb = sandbox('wait-timeout');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '5000' });
    const id = jobIdOf(started.stdout);

    const first = run(sb, ['wait', id, '--timeout', '1s']);
    assert.equal(first.code, 2, `${first.stdout}${first.stderr}`);
    assert.equal(JSON.parse(first.stdout).status, 'running');
    assert.doesNotMatch(first.stdout, /fake answer/, 'a timed-out wait must not print a result');

    const second = run(sb, ['wait', id]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /fake answer/);
  });

  test('wait stays silent past the former 15s heartbeat and still delivers progress/result', () => {
    const sb = sandbox('wait-silent');
    const started = run(sb, ['staffer', '--prompt', 'a quiet task'], { FAKE_AGY_SLEEP_MS: '21000' });
    const id = jobIdOf(started.stdout);

    const first = run(sb, ['wait', id, '--timeout', '16s']);
    assert.equal(first.code, 2, first.stdout + first.stderr);
    assert.equal(first.stderr, '', 'soft waiting must not emit liveness heartbeats');
    assert.equal(JSON.parse(first.stdout).status, 'running', 'stdout contains only the expiry snapshot');

    const final = run(sb, ['wait', id]);
    assert.equal(final.code, 0, final.stdout + final.stderr);
    assert.equal(final.stderr, '');
    assert.match(final.stdout, /fake answer/);
  });

  test('failed job → exit 3 with the stored error', async () => {
    const sb = sandbox('wait-error');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_STATUS: 'ERROR', FAKE_AGY_RESPONSE: '' });
    const id = jobIdOf(started.stdout);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 3, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /Job failed:/);
  });

  test('canceled job → exit 4', async () => {
    const sb = sandbox('wait-cancel');
    const started = run(sb, ['research', '--prompt', 'a topic'], { FAKE_AGY_SLEEP_MS: '8000' });
    const id = jobIdOf(started.stdout);
    run(sb, ['cancel', id]);

    const r = run(sb, ['wait', id]);
    assert.equal(r.code, 4, `${r.stdout}${r.stderr}`);
  });

  test('no id defaults to the most recent job; unknown id → 1', async () => {
    const sb = sandbox('wait-default');
    assert.equal(run(sb, ['wait', 'no-such-job']).code, 1);

    const started = run(sb, ['research', '--prompt', 'a topic']);
    const id = jobIdOf(started.stdout);
    const r = run(sb, ['wait']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`# Job ${id} `));
  });

  test('bare wait keeps its initial job when a newer job is registered', () => {
    const sb = sandbox('wait-pinned');
    const statePath = path.join(sb.repo, '.agy-staff', 'state.json');
    fs.mkdirSync(path.dirname(statePath));
    const first = {
      id: 'research-first', mode: 'research', status: 'running', pid: process.pid,
      result_file: path.join(sb.repo, 'first.md'),
    };
    const second = { ...first, id: 'research-second', status: 'done', result_file: path.join(sb.repo, 'second.md') };
    const completedState = JSON.stringify({ jobs: [{ ...first, status: 'done' }, second] });
    fs.writeFileSync(statePath, JSON.stringify({ jobs: [first] }));
    fs.writeFileSync(first.result_file, 'First result\n');
    fs.writeFileSync(second.result_file, 'Second result\n');

    // Publish both completions just after the waiter checks its initial job's
    // sidecar. The next poll must still collect the first result.
    const hook = `
      import fs from 'node:fs';
      const read = fs.readFileSync;
      fs.readFileSync = (file, ...args) => {
        if (file === ${JSON.stringify(first.result_file + '.status.json')}) {
          fs.readFileSync = read;
          fs.writeFileSync(${JSON.stringify(statePath)}, ${JSON.stringify(completedState)});
        }
        return read(file, ...args);
      };
    `;
    const waiter = run(sb, ['wait', '--timeout', '5s'], {
      NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`,
    });
    assert.equal(waiter.code, 0, waiter.stdout + waiter.stderr);
    assert.equal(waiter.stdout, '# Job research-first (research, done)\n\nFirst result\n');
  });

  test('wait with an ID polls only its SQLite job and notices a legacy completion', (t) => {
    const sb = sandbox('wait-sqlite-by-id');
    t.after(() => fs.rmSync(sb.root, { recursive: true, force: true }));
    const dir = path.join(sb.repo, '.agy-staff');
    const mirror = path.join(dir, 'state.json');
    const log = path.join(sb.root, 'reads.log');
    fs.mkdirSync(dir);
    const job = { id: 'research-target', mode: 'research', status: 'running', pid: process.pid,
      result_file: path.join(dir, 'result.md'), log_file: path.join(dir, 'job.log') };
    const snapshot = { jobs: [job], _agy_staff_export_id: 'original' };
    const completed = { ...snapshot, jobs: [{ ...job, status: 'done', warnings: true, finished_at: '2026-11-14T00:00:00Z' }] };
    fs.writeFileSync(mirror, JSON.stringify(snapshot));
    fs.writeFileSync(job.result_file, 'Legacy result\n');
    fs.writeFileSync(job.log_file, 'LEGACY_WARNING\n');
    const store = new StateStore(path.join(dir, 'state.sqlite'));
    store.importState(snapshot, { previous: snapshot, next: snapshot });
    store.close();

    // Leave the first few polls unchanged, then publish a JSON-only update
    // while the SQLite row is still running. Trace real reads in the CLI.
    const hook = `
      import fs from 'node:fs';
      import { DatabaseSync } from 'node:sqlite';
      const mirror = ${JSON.stringify(mirror)};
      const log = ${JSON.stringify(log)};
      const read = fs.readFileSync;
      let polls = 0;
      fs.readFileSync = (file, ...args) => {
        if (file === mirror) fs.appendFileSync(log, 'mirror\\n');
        if (file === ${JSON.stringify(job.result_file + '.status.json')} && ++polls === 3) {
          fs.writeFileSync(mirror + '.next', ${JSON.stringify(JSON.stringify(completed))});
          fs.renameSync(mirror + '.next', mirror);
        }
        return read(file, ...args);
      };
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function (sql) {
        if (/FROM jobs\\b/i.test(sql)) fs.appendFileSync(log, sql + '\\n');
        return prepare.call(this, sql);
      };
    `;
    const waited = run(sb, ['wait', job.id, '--timeout', '5s'], {
      NODE_OPTIONS: `--import=data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`,
    });
    assert.equal(waited.code, 0, waited.stdout + waited.stderr);
    assert.equal(waited.stdout, `# Job ${job.id} (research, done)\n\nLegacy result\n`);
    assert.match(waited.stderr, /LEGACY_WARNING/);
    const reads = fs.readFileSync(log, 'utf8').trim().split('\n');
    const queries = reads.filter((line) => /FROM jobs\b/i.test(line));
    assert.ok(queries.length > 0, 'wait queried SQLite');
    assert.ok(queries.every((sql) => /\bWHERE id\s*=\s*\?/i.test(sql)), queries.join('\n'));
    assert.equal(reads.filter((line) => line === 'mirror').length, 2, 'unchanged snapshots are reused');
  });
});
