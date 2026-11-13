import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = fileURLToPath(new URL('../bench/scripts/', import.meta.url));
const judges = ['gemini-3.8-flash', 'deepseek-v4-pro'];

function runScript(name, ...args) {
  const result = spawnSync('python3', ['-B', join(scripts, name), ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function trialFixture(root, host, dataset, task) {
  const claude = host === 'claude';
  const job = `${host}-solo-${task}-${claude ? 'c55x' : 's61x'}-r1`;
  const trial = join(root, 'jobs', job, 'trial');
  writeJSON(join(trial, 'result.json'), {
    task_name: task,
    agent_execution: { started_at: '2026-11-13T00:00:00Z', finished_at: '2026-11-13T00:01:00Z' },
    verifier_result: { rewards: { reward: 1 } },
  });
  writeJSON(join(trial, 'config.json'), {
    task: { path: `${dataset}/${task}` },
    agent: { kwargs: claude ? { prompt_template_path: 'solo.j2', reasoning_effort: 'xhigh' } : { config: 'solo.toml' } },
  });
  const log = claude ? join(trial, 'agent', 'claude-code.txt') : join(trial, 'agent', 'sessions', 'rollout-test.jsonl');
  const events = claude ? [{ type: 'system', subtype: 'init', model: 'claude-opus-5-5' }] : [
    { type: 'session_meta', payload: { id: 'host', source: 'exec' } },
    { type: 'turn_context', payload: { turn_id: 'turn', model: 'gpt-6.1-sol', reasoning_effort: 'xhigh' } },
    { type: 'token_usage_record', payload: { thread_id: 'host', turn_id: 'turn', usage: {} } },
  ];
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(join(trial, 'agent', 'answer.txt'), 'A candidate answer.\n');
  return { job, trial, dataset, task };
}

function vote(trial, judge, repeat, pass, { fileRepeat = repeat, error } = {}) {
  const result = trial.dataset === 'swe-atlas-qna'
    ? { pass }
    : { fully_correct: Number(pass), f1_score: pass ? 1 : 0.8, grader_valid: 1 };
  if (error) Object.assign(result, { error, ...(trial.dataset === 'deepsearchqa' ? { grader_valid: 0, f1_score: 0 } : {}) });
  writeJSON(join(trial.trial, 'grading', judge, `r${fileRepeat}.json`), {
    judge, repeat, dataset: trial.dataset, task: trial.task, result, usage: { cost_usd: 0 },
  });
}

test('offline verdicts require three numbered votes from each judge and two passes per judge', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-bench-grading-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const qna = trialFixture(root, 'codex', 'swe-atlas-qna', 'qna-fixture');
  const deep = trialFixture(root, 'claude', 'deepsearchqa', 'deep-fixture');
  const swe = trialFixture(root, 'codex', 'swebench-verified', 'swe-fixture');
  const analyze = () => runScript('analyze.py', '--data', root, '--out', '-').trim().split('\n').map(JSON.parse);

  for (const trial of [qna, deep]) {
    [true, true, false].forEach((pass, index) => vote(trial, judges[0], index + 1, pass));
    vote(trial, judges[1], 1, true);
    vote(trial, judges[1], 1, true, { fileRepeat: 2 }); // The payload duplicates round 1.
    vote(trial, judges[1], 4, true);
    [true, true, true].forEach((pass, index) => vote(trial, 'other-judge', index + 1, pass));
  }

  const pending = analyze();
  const byJob = (records, trial) => records.find((record) => record.job === trial.job);
  for (const trial of [qna, deep]) {
    assert.equal(byJob(pending, trial).resolved, null, 'incomplete grades have no verdict');
    assert.equal(byJob(pending, trial).reward, null);
  }
  assert.equal(byJob(pending, swe).resolved, true, 'SWE-bench still uses the verifier');

  const records = join(root, 'records.jsonl');
  const published = join(root, 'data.json');
  writeFileSync(records, pending.map((record) => JSON.stringify(record)).join('\n'));
  const report = runScript('report.py', records);
  assert.match(report, /Pending grading/);
  assert.doesNotMatch(report, /\| `(?:qna|deep)-fixture` \|/);
  runScript('viz-data.py', records, '--out', published);
  assert.deepEqual(JSON.parse(readFileSync(published, 'utf8')).trials.map((trial) => trial.job), [swe.job]);

  vote(qna, judges[1], 2, true);
  vote(qna, judges[1], 3, false);
  [true, true, true].forEach((pass, index) => vote(deep, judges[0], index + 1, pass));
  vote(deep, judges[1], 2, false);
  vote(deep, judges[1], 3, false);
  const complete = analyze();
  assert.equal(byJob(complete, qna).resolved, true, 'two passes from both judges are sufficient');
  assert.equal(byJob(complete, qna).reward, 0.6667);
  assert.equal(byJob(complete, deep).resolved, false, 'four passing votes total do not outweigh one judge');
});

test('grader failures leave a round pending, while an empty answer receives failing votes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-bench-grading-errors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const qna = trialFixture(root, 'codex', 'swe-atlas-qna', 'qna-fixture');
  const deep = trialFixture(root, 'claude', 'deepsearchqa', 'deep-fixture');
  const cases = [[qna, 'no results written', 'no results written'],
    [deep, 'judge failed after 5 attempts', 'Agent answer file is empty.']];
  const analyze = () => runScript('analyze.py', '--data', root, '--out', '-').trim().split('\n').map(JSON.parse);
  for (const [trial, error] of cases) {
    for (const judge of judges) {
      vote(trial, judge, 1, true);
      vote(trial, judge, 2, true);
      vote(trial, judge, 3, false, { error });
    }
  }
  assert.deepEqual(analyze().map((record) => record.resolved), [null, null]);

  for (const [trial, , emptyError] of cases) {
    writeFileSync(join(trial.trial, 'agent', 'answer.txt'), '');
    for (const judge of judges) {
      for (const round of [1, 2, 3]) vote(trial, judge, round, false, { error: emptyError });
    }
  }
  assert.deepEqual(analyze().map(({ resolved, reward }) => [resolved, reward]), [[false, 0], [false, 0]]);
});
