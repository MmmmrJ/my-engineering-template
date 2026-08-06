import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN = join(REPOSITORY, 'evals', 'golden', 'fixtures');

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function cli(root, ...args) {
  return spawnSync(process.execPath, ['scripts/harness/cli.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function cliWithEnv(root, env, ...args) {
  return spawnSync(process.execPath, ['scripts/harness/cli.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function json(result) {
  assert.ok(result.stdout.trim(), `expected JSON output; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

function readEmbeddedState(root) {
  const contents = readFileSync(join(root, 'STATE.md'), 'utf8');
  const match = contents.match(/<!-- loop-state-json:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- loop-state-json:end -->/);
  assert.ok(match, 'STATE.md must contain a machine projection');
  return JSON.parse(match[1]);
}

function git(root, ...args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function pattern(id, overrides = {}) {
  const base = {
    id,
    enabled: true,
    level: 'L1',
    mode: 'report-only',
    goal: `Evaluate ${id}`,
    nonGoals: ['Do not modify governed paths'],
    trigger: { type: 'manual' },
    scope: {
      watchPaths: ['**'],
      denyPaths: ['.env', '.env.*', '**/secrets/**', 'auth/**', 'payments/**'],
      maxChangedFiles: 10,
    },
    roles: {
      triageSkill: 'loop-triage',
      verifierRole: 'qa_engineer',
      independentVerifier: false,
    },
    state: {
      summaryFile: 'STATE.md',
      runLogFile: 'loop-run-log.md',
    },
    budget: {
      maxRunsPerDay: 10,
      maxTokensPerRun: 1000,
      maxTokensPerDay: 5000,
      maxAttempts: 3,
      maxActionsPerDay: 3,
    },
    isolation: {
      mode: 'none',
      lockPaths: [],
      lockTtlSeconds: 3600,
    },
    gates: {
      report: 'allow',
      proposal: 'human',
      write: 'never',
      push: 'never',
      merge: 'never',
    },
    checks: ['harness-tests'],
    escalation: {
      sameErrorCount: 3,
      noProgressCount: 3,
      maxIterations: 3,
    },
  };
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...(overrides.scope ?? {}) },
    roles: { ...base.roles, ...(overrides.roles ?? {}) },
    state: { ...base.state, ...(overrides.state ?? {}) },
    budget: { ...base.budget, ...(overrides.budget ?? {}) },
    isolation: { ...base.isolation, ...(overrides.isolation ?? {}) },
    gates: { ...base.gates, ...(overrides.gates ?? {}) },
    escalation: { ...base.escalation, ...(overrides.escalation ?? {}) },
  };
}

function loopConfig(overrides = {}) {
  const patterns = [
    pattern('harness-health', overrides.health),
    pattern('daily-triage'),
    pattern('ci-sweeper', {
      enabled: false,
      level: 'L2',
      mode: 'assisted',
      nonGoals: ['Do not push or merge'],
      roles: { independentVerifier: true },
      isolation: { mode: 'worktree', lockPaths: ['apps/**'] },
      gates: {
        report: 'allow',
        proposal: 'approved-task',
        write: 'approved-task',
        push: 'never',
        merge: 'never',
      },
    }),
  ];
  return { schemaVersion: 1, patterns };
}

function writeLoopAssets(root, config = loopConfig()) {
  writeFileSync(join(root, 'loop.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(root, 'loop-budget.md'), '# Loop Budget\n\nKill switch: enabled by controller state.\n');
  writeFileSync(join(root, 'loop-constraints.md'), '# Loop Constraints\n\nL1 is report-only.\n');
  writeFileSync(join(root, 'loop-run-log.md'), '# Loop Run Log\n\n<!-- Loop appends below this line -->\n');
  writeFileSync(join(root, 'gate.yaml'), 'version: 1\ndenylist:\n  - .env\n');
  writeFileSync(join(root, '.gitignore'), '.harness/runtime/\n');
  mkdirSync(join(root, 'patterns'), { recursive: true });
  writeFileSync(join(root, 'patterns', 'registry.json'), `${JSON.stringify({
    schemaVersion: 1,
    patterns: config.patterns.map(({ id }) => ({ id })),
  }, null, 2)}\n`);
  const sync = cli(root, 'loop', 'sync', '--write', '--json');
  assert.equal(sync.status, 0, output(sync));
}

function loopFixture(t, config = loopConfig()) {
  const root = mkdtempSync(join(tmpdir(), 'harness-loop-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(REPOSITORY, 'scripts'), join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'docs', 'plans', 'active'), { recursive: true });
  mkdirSync(join(root, 'apps'), { recursive: true });
  writeLoopAssets(root, config);
  assert.equal(git(root, 'init').status, 0);
  assert.equal(git(root, 'config', 'user.name', 'Loop QA').status, 0);
  assert.equal(git(root, 'config', 'user.email', 'loop-qa@example.test').status, 0);
  assert.equal(git(root, 'add', '-A').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'loop fixture').status, 0);
  return root;
}

function fullFixture(t) {
  const sandbox = mkdtempSync(join(tmpdir(), 'harness-loop-distribution-'));
  const root = join(sandbox, 'harness');
  t.after(() => rmSync(sandbox, { recursive: true, force: true }));
  cpSync(REPOSITORY, root, {
    recursive: true,
    filter(source) {
      const local = source.slice(REPOSITORY.length).replaceAll('\\', '/').replace(/^\//, '');
      return !local.split('/').some((part) => ['.git', 'node_modules', 'coverage', 'dist', '.harness'].includes(part));
    },
  });
  return root;
}

function writeApprovedTask(root, taskId = 'approved-task') {
  const directory = join(root, 'docs', 'plans', 'active', taskId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'governance.json'), `${JSON.stringify({
    schemaVersion: 1,
    taskId,
    phase: 'implementing',
    planVersion: 'V1',
    approvedVersion: 'V1',
    approval: { status: 'approved' },
    roles: [
      { role: 'backend_engineer', allowedPaths: ['apps/backend/**'], forbiddenPaths: [] },
    ],
    requiredChecks: [],
    acceptance: { results: [], remainingRisks: [] },
  }, null, 2)}\n`);
}

test('loop schema, init, validate, doctor and status expose the frozen JSON contract', (t) => {
  const root = loopFixture(t);

  const configBeforeInit = readFileSync(join(root, 'loop.config.json'), 'utf8');
  const init = cli(root, 'loop', 'init', 'new-triage', '--pattern', 'daily-triage', '--dry-run', '--json');
  assert.equal(init.status, 0, output(init));
  assert.equal(json(init).command, 'init');
  assert.equal(json(init).id, 'new-triage');
  assert.equal(readFileSync(join(root, 'loop.config.json'), 'utf8'), configBeforeInit);

  const validate = cli(root, 'loop', 'validate', '--strict', '--json');
  assert.equal(validate.status, 0, output(validate));
  assert.equal(json(validate).ok, true);

  const status = cli(root, 'loop', 'status', '--json');
  assert.equal(status.status, 0, output(status));
  const statusJson = json(status);
  assert.deepEqual(statusJson.patterns.map(({ id }) => id), ['harness-health', 'daily-triage', 'ci-sweeper']);
  assert.equal(statusJson.patterns.find(({ id }) => id === 'ci-sweeper').enabled, false);

  const invalid = readFileSync(join(GOLDEN, 'invalid-loop-config.json'), 'utf8');
  writeFileSync(join(root, 'loop.config.json'), invalid);
  const before = readFileSync(join(root, '.harness', 'runtime', 'state.json'), 'utf8');
  const rejected = cli(root, 'loop', 'validate', '--strict', '--json');
  assert.equal(rejected.status, 1, output(rejected));
  assert.equal(json(rejected).ok, false);
  assert.equal(readFileSync(join(root, '.harness', 'runtime', 'state.json'), 'utf8'), before);
});

test('loop schema rejects unknown keys, duplicate IDs, invalid levels, and incomplete budgets', (t) => {
  const root = loopFixture(t);
  const configPath = join(root, 'loop.config.json');
  const baseline = JSON.parse(readFileSync(configPath, 'utf8'));
  const stateBefore = readFileSync(join(root, '.harness', 'runtime', 'state.json'), 'utf8');
  const invalidConfigs = [
    { ...structuredClone(baseline), unexpectedRootField: true },
    (() => { const value = structuredClone(baseline); value.patterns[1].id = value.patterns[0].id; return value; })(),
    (() => { const value = structuredClone(baseline); value.patterns[0].level = 'L3'; return value; })(),
    (() => { const value = structuredClone(baseline); delete value.patterns[0].budget.maxTokensPerDay; return value; })(),
  ];
  for (const config of invalidConfigs) {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const result = cli(root, 'loop', 'validate', '--strict', '--json');
    assert.equal(result.status, 1, output(result));
    assert.equal(json(result).ok, false);
    assert.equal(readFileSync(join(root, '.harness', 'runtime', 'state.json'), 'utf8'), stateBefore);
  }
});

test('loop sync detects drift without writing and repairs only the state projection', (t) => {
  const root = loopFixture(t);
  const statePath = join(root, 'STATE.md');
  const drifted = readFileSync(statePath, 'utf8').replace('"level": "L1"', '"level": "L2"');
  writeFileSync(statePath, drifted);

  const check = cli(root, 'loop', 'sync', '--check', '--json');
  assert.equal(check.status, 1, output(check));
  assert.match(json(check).errors.join('\n'), /level drift/i);
  assert.equal(readFileSync(statePath, 'utf8'), drifted);

  const write = cli(root, 'loop', 'sync', '--write', '--json');
  assert.equal(write.status, 0, output(write));
  assert.equal(json(write).ok, true);
  const recheck = cli(root, 'loop', 'sync', '--check', '--json');
  assert.equal(recheck.status, 0, output(recheck));

  const configPath = join(root, 'loop.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.patterns[0].goal = 'Changed goal must invalidate the projection hash';
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const hashDrift = cli(root, 'loop', 'sync', '--check', '--json');
  assert.equal(hashDrift.status, 1, output(hashDrift));
  assert.match(json(hashDrift).errors.join('\n'), /config|hash|projection|drift/i);
});

test('L1 no-op prepare/finish is idempotent and metrics conserve runs and tokens', (t) => {
  const root = loopFixture(t);
  const prepare = cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'eval-noop', '--slot', 'slot-noop', '--actor', 'qa', '--json');
  assert.equal(prepare.status, 0, output(prepare));
  assert.equal(json(prepare).status, 'prepared');
  assert.equal(existsSync(join(root, '.harness', 'runtime', 'runs', 'eval-noop.json')), true);

  const finish = cli(root, 'loop', 'run', 'finish', 'eval-noop', '--outcome', 'no-op', '--tokens', '25', '--json');
  assert.equal(finish.status, 0, output(finish));
  const evidence = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'runs', 'eval-noop.json'), 'utf8'));
  for (const field of ['schemaVersion', 'runId', 'loopId', 'level', 'trigger', 'startedAt', 'finishedAt', 'status', 'checks', 'outcome', 'evidenceHash']) {
    assert.notEqual(evidence[field], undefined, `run evidence missing ${field}`);
  }
  assert.ok(Array.isArray(evidence.checks));
  assert.match(evidence.evidenceHash, /^[a-f0-9]{64}$/);
  const logPath = join(root, 'loop-run-log.md');
  const completedLog = readFileSync(logPath, 'utf8');

  const duplicateFinish = cli(root, 'loop', 'run', 'finish', 'eval-noop', '--outcome', 'no-op', '--tokens', '25', '--json');
  assert.equal(duplicateFinish.status, 0, output(duplicateFinish));
  assert.equal(json(duplicateFinish).status, 'duplicate');
  assert.equal(readFileSync(logPath, 'utf8'), completedLog);

  const duplicatePrepare = cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'ignored-new-id', '--slot', 'slot-noop', '--json');
  assert.equal(duplicatePrepare.status, 0, output(duplicatePrepare));
  assert.equal(json(duplicatePrepare).status, 'duplicate');
  assert.equal(json(duplicatePrepare).runId, 'eval-noop');

  const dailyPrepare = cli(root, 'loop', 'run', 'prepare', 'daily-triage', '--run-id', 'daily-noop', '--slot', 'daily-noop', '--json');
  assert.equal(dailyPrepare.status, 0, output(dailyPrepare));
  const dailyFinish = cli(root, 'loop', 'run', 'finish', 'daily-noop', '--outcome', 'no-op', '--json');
  assert.equal(dailyFinish.status, 0, output(dailyFinish));
  assert.equal(git(root, 'diff', '--name-only', '--', 'apps').stdout.trim(), '');

  const metrics = cli(root, 'loop', 'metrics', 'harness-health', '--json');
  assert.equal(metrics.status, 0, output(metrics));
  assert.equal(json(metrics).patterns[0].runs, 1);
  assert.equal(json(metrics).patterns[0].tokensToday, 25);
  assert.equal(json(metrics).patterns[0].outcomes['no-op'], 1);
});

test('pause, missing resume evidence, and daily budget all fail closed before run creation', (t) => {
  const config = loopConfig({ health: { budget: { maxRunsPerDay: 1 } } });
  const root = loopFixture(t, config);

  const pause = cli(root, 'loop', 'pause', 'harness-health', '--reason', 'kill-switch', '--actor', 'operator', '--json');
  assert.equal(pause.status, 0, output(pause));
  const blocked = cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'must-not-exist', '--slot', 'paused-slot', '--json');
  assert.equal(blocked.status, 2, output(blocked));
  assert.equal(json(blocked).trigger, 'paused');
  assert.equal(existsSync(join(root, '.harness', 'runtime', 'runs', 'must-not-exist.json')), false);

  const unsafeResume = cli(root, 'loop', 'resume', 'harness-health', '--by', 'operator', '--json');
  assert.equal(unsafeResume.status, 1, output(unsafeResume));
  const statusWhilePaused = json(cli(root, 'loop', 'status', 'harness-health', '--json'));
  assert.equal(statusWhilePaused.patterns[0].paused, true);

  const resume = cli(root, 'loop', 'resume', 'harness-health', '--by', 'operator', '--evidence', 'incident reviewed', '--json');
  assert.equal(resume.status, 0, output(resume));
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'budget-one', '--slot', 'budget-one', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'run', 'finish', 'budget-one', '--outcome', 'no-op', '--json').status, 0);
  const budgetBlocked = cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'budget-two', '--slot', 'budget-two', '--json');
  assert.equal(budgetBlocked.status, 2, output(budgetBlocked));
  assert.match(json(budgetBlocked).trigger, /budget/);
  assert.equal(existsSync(join(root, '.harness', 'runtime', 'runs', 'budget-two.json')), false);
});

test('gate blocks deny paths, all L1 writes, disabled patterns, push, and merge', (t) => {
  const root = loopFixture(t);
  for (const [patternId, action, paths, trigger] of [
    ['harness-health', 'write', '.env', 'denylist'],
    ['harness-health', 'write', 'apps/example.js', 'l1-report-only'],
    ['ci-sweeper', 'report', 'apps/example.js', 'disabled'],
    ['ci-sweeper', 'push', 'apps/example.js', 'disabled'],
    ['ci-sweeper', 'merge', 'apps/example.js', 'disabled'],
  ]) {
    const result = cli(root, 'loop', 'gate', patternId, '--action', action, '--paths', paths, '--json');
    assert.equal(result.status, 2, `${patternId}/${action}: ${output(result)}`);
    assert.equal(json(result).allowed, false);
    assert.equal(json(result).trigger, trigger);
  }

  const tooMany = Array.from({ length: 11 }, (_, index) => `docs/file-${index}.md`).join(',');
  const maxFiles = cli(root, 'loop', 'gate', 'harness-health', '--action', 'report', '--paths', tooMany, '--json');
  assert.equal(maxFiles.status, 2, output(maxFiles));
  assert.equal(json(maxFiles).trigger, 'file-count');
});

test('80% daily budget downgrades L2 to report-only before the next action', (t) => {
  const config = loopConfig();
  const sweeper = config.patterns.find(({ id }) => id === 'ci-sweeper');
  sweeper.enabled = true;
  sweeper.budget.maxTokensPerRun = 100;
  sweeper.budget.maxTokensPerDay = 100;
  const root = loopFixture(t, config);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'budget-eighty', '--slot', 'budget-eighty', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'run', 'finish', 'budget-eighty', '--outcome', 'report-only', '--tokens', '80', '--json').status, 0);
  const next = cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'after-eighty', '--slot', 'after-eighty', '--json');
  assert.equal(next.status, 0, output(next));
  const record = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'runs', 'after-eighty.json'), 'utf8'));
  assert.equal(record.level, 'L1');
  assert.equal(record.mode, 'report-only');
  assert.match(JSON.stringify(readEmbeddedState(root)), /budget|degrad/i);
});

test('inbox stable IDs deduplicate adds and resolving an item is idempotent', (t) => {
  const root = loopFixture(t);
  for (let index = 0; index < 2; index += 1) {
    const add = cli(root, 'loop', 'inbox', 'add', 'harness-health', '--id', 'stable-drift', '--message', 'State drift needs a human', '--json');
    assert.equal(add.status, 0, output(add));
  }
  let list = json(cli(root, 'loop', 'inbox', 'list', '--json'));
  assert.equal(list.items.filter(({ id, status }) => id === 'stable-drift' && status === 'open').length, 1);

  for (let index = 0; index < 2; index += 1) {
    const resolve = cli(root, 'loop', 'inbox', 'resolve', 'stable-drift', '--by', 'operator', '--evidence', 'fixed', '--json');
    assert.equal(resolve.status, 0, output(resolve));
  }
  list = json(cli(root, 'loop', 'inbox', 'list', '--json'));
  assert.equal(list.items.filter(({ id }) => id === 'stable-drift').length, 1);
  assert.equal(list.items.find(({ id }) => id === 'stable-drift').status, 'resolved');
});

test('promotion rejects L3 and preserves configuration on policy block', (t) => {
  const root = loopFixture(t);
  const configPath = join(root, 'loop.config.json');
  const before = readFileSync(configPath, 'utf8');
  const result = cli(root, 'loop', 'promote', 'harness-health', '--to', 'L3', '--by', 'operator', '--evidence', 'not allowed', '--json');
  assert.equal(result.status, 2, output(result));
  assert.equal(json(result).trigger, 'l3-out-of-scope');
  assert.equal(readFileSync(configPath, 'utf8'), before);
});

test('subagents cannot pause, resume, promote, or decide inbox items', (t) => {
  const root = loopFixture(t);
  assert.equal(cli(root, 'loop', 'inbox', 'add', 'harness-health', '--id', 'parent-only-item', '--message', 'Needs owner', '--json').status, 0);
  const beforeState = readFileSync(join(root, '.harness', 'runtime', 'state.json'), 'utf8');
  for (const args of [
    ['loop', 'pause', 'harness-health', '--reason', 'unauthorized', '--json'],
    ['loop', 'resume', 'harness-health', '--by', 'qa', '--evidence', 'unauthorized', '--json'],
    ['loop', 'promote', 'harness-health', '--to', 'L2', '--by', 'qa', '--evidence', 'unauthorized', '--json'],
    ['loop', 'inbox', 'decide', 'parent-only-item', '--decision', 'accept', '--by', 'qa', '--json'],
  ]) {
    const result = cliWithEnv(root, { HARNESS_AGENT_ROLE: 'qa_engineer' }, ...args);
    assert.equal(result.status, 2, output(result));
    assert.equal(readFileSync(join(root, '.harness', 'runtime', 'state.json'), 'utf8'), beforeState);
  }
});

test('L2 promotion is blocked until quantitative readiness evidence exists', (t) => {
  const root = loopFixture(t);
  const before = readFileSync(join(root, 'loop.config.json'), 'utf8');
  const result = cli(root, 'loop', 'promote', 'ci-sweeper', '--to', 'L2', '--by', 'operator', '--evidence', 'request without qualifying run window', '--json');
  assert.equal(result.status, 2, output(result));
  assert.match(json(result).trigger, /readiness|promotion|evidence|sample/i);
  assert.equal(readFileSync(join(root, 'loop.config.json'), 'utf8'), before);
});

test('L2 promotion enforces the five-day window and 20% false-positive boundary', (t) => {
  const root = loopFixture(t);
  assert.equal(cli(root, 'loop', 'pause', 'ci-sweeper', '--reason', 'kill-switch-drill', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'resume', 'ci-sweeper', '--by', 'operator', '--evidence', 'drill passed', '--json').status, 0);
  const logPath = join(root, 'loop-run-log.md');

  function promotionEntries(falsePositiveCount) {
    const lines = ['# Loop Run Log', '', '<!-- Loop appends below this line -->'];
    for (let index = 0; index < 10; index += 1) {
      const day = new Date(Date.now() - (index % 6) * 86_400_000).toISOString().slice(0, 10);
      lines.push(JSON.stringify({
        schemaVersion: 1,
        runId: `promotion-${index}`,
        loopId: 'ci-sweeper',
        level: 'L1',
        startedAt: `${day}T00:00:00.000Z`,
        finishedAt: `${day}T00:00:01.000Z`,
        outcome: 'report-only',
        findings: 1,
        falsePositives: index < falsePositiveCount ? 1 : 0,
        unauthorizedWrites: 0,
        evidenceComplete: true,
        killSwitchDrill: index === 0,
        evidenceHash: 'a'.repeat(64),
      }));
    }
    return `${lines.join('\n')}\n`;
  }

  writeFileSync(logPath, promotionEntries(3));
  let result = cli(root, 'loop', 'promote', 'ci-sweeper', '--to', 'L2', '--by', 'operator', '--evidence', '30 percent must fail', '--json');
  assert.equal(result.status, 2, output(result));
  assert.match(json(result).reason, /false-positive.*30\.0%.*20%/i);

  writeFileSync(logPath, promotionEntries(2));
  result = cli(root, 'loop', 'promote', 'ci-sweeper', '--to', 'L2', '--by', 'operator', '--evidence', 'ten runs across five days with complete evidence', '--json');
  assert.equal(result.status, 0, output(result));
  assert.equal(json(result).level, 'L2');
});

test('approved CLI aliases inbox decide, gate check, and run finish --result are supported', (t) => {
  const root = loopFixture(t);
  assert.equal(cli(root, 'loop', 'inbox', 'add', 'harness-health', '--id', 'decision-item', '--message', 'Choose a path', '--json').status, 0);
  const decide = cli(root, 'loop', 'inbox', 'decide', 'decision-item', '--decision', 'accept', '--by', 'operator', '--json');
  assert.equal(decide.status, 0, output(decide));
  assert.equal(json(decide).item.status, 'resolved');

  const gate = cli(root, 'loop', 'gate', 'check', 'harness-health', '--action', 'report', '--paths', 'README.md', '--json');
  assert.equal(gate.status, 0, output(gate));
  assert.equal(json(gate).allowed, true);

  assert.equal(cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'result-alias', '--slot', 'result-alias', '--json').status, 0);
  const finish = cli(root, 'loop', 'run', 'finish', 'result-alias', '--result', JSON.stringify({ outcome: 'no-op' }), '--json');
  assert.equal(finish.status, 0, output(finish));
  assert.equal(json(finish).outcome, 'no-op');
});

test('L2 finish and gate require independent maker/verifier evidence and approved path ownership', (t) => {
  const config = loopConfig();
  config.patterns.find(({ id }) => id === 'ci-sweeper').enabled = true;
  const root = loopFixture(t, config);
  writeApprovedTask(root);
  const prepare = cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'l2-eval', '--slot', 'l2-eval', '--json');
  assert.equal(prepare.status, 0, output(prepare));

  const selfVerified = cli(root, 'loop', 'run', 'finish', 'l2-eval', '--outcome', 'proposal', '--actions', '1', '--maker-session', 'same', '--verifier-session', 'same', '--verifier-status', 'pass', '--json');
  assert.equal(selfVerified.status, 2, output(selfVerified));
  assert.equal(json(selfVerified).trigger, 'independent-verifier');

  const outsideOwnership = cli(root, 'loop', 'gate', 'ci-sweeper', '--action', 'write', '--paths', 'apps/frontend/unsafe.js', '--task', 'approved-task', '--run-id', 'l2-eval', '--maker-session', 'maker', '--verifier-session', 'verifier', '--verifier-status', 'pass', '--json');
  assert.equal(outsideOwnership.status, 2, output(outsideOwnership));
  assert.match(json(outsideOwnership).trigger, /owner|scope|path/i);
});

test('L2 write gate requires the approved task, active worktree, matching lock, and verifier', (t) => {
  const config = loopConfig();
  config.patterns.find(({ id }) => id === 'ci-sweeper').enabled = true;
  const root = loopFixture(t, config);
  writeApprovedTask(root);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'gate-eval', '--slot', 'gate-eval', '--json').status, 0);

  const args = ['loop', 'gate', 'check', 'ci-sweeper', '--action', 'write', '--paths', 'apps/backend/fix.js', '--task', 'approved-task', '--run-id', 'gate-eval', '--maker-session', 'maker', '--verifier-session', 'verifier', '--verifier-status', 'pass', '--json'];
  const withoutIsolation = cli(root, ...args);
  assert.equal(withoutIsolation.status, 2, output(withoutIsolation));
  assert.match(json(withoutIsolation).trigger, /worktree|lock|isolation/i);

  const create = cli(root, 'loop', 'worktree', 'create', '--run-id', 'gate-eval', '--pattern', 'ci-sweeper', '--json');
  assert.equal(create.status, 0, output(create));
  const allowed = cli(root, ...args);
  assert.equal(allowed.status, 0, output(allowed));
  assert.equal(json(allowed).allowed, true);
});

test('attempt ledger trips the repeated-error circuit breaker on the third failure', (t) => {
  const config = loopConfig();
  const sweeper = config.patterns.find(({ id }) => id === 'ci-sweeper');
  sweeper.enabled = true;
  sweeper.escalation = { sameErrorCount: 3, noProgressCount: 4, maxIterations: 4 };
  const root = loopFixture(t, config);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'breaker-eval', '--slot', 'breaker-eval', '--json').status, 0);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = cli(root, 'loop', 'run', 'attempt', 'breaker-eval', '--action', 'run tests', '--outcome', 'failure', '--error', `ECONNREFUSED port ${5000 + attempt}`, '--tokens', '10', '--json');
    assert.equal(result.status, attempt < 3 ? 0 : 2, output(result));
    if (attempt === 3) assert.equal(json(result).breaker.trigger, 'same-error');
  }
});

test('attempt evidence redacts sensitive values before persistence and output', (t) => {
  const config = loopConfig();
  config.patterns.find(({ id }) => id === 'ci-sweeper').enabled = true;
  const root = loopFixture(t, config);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'redaction-eval', '--slot', 'redaction-eval', '--json').status, 0);
  const attempt = cli(root, 'loop', 'run', 'attempt', 'redaction-eval', '--action', 'read logs', '--outcome', 'failure', '--error', 'authorization=Bearer example-token-value apiKey=example-secret-value', '--json');
  assert.equal(attempt.status, 0, output(attempt));
  const ledger = readFileSync(join(root, '.harness', 'runtime', 'ledgers', 'redaction-eval.json'), 'utf8');
  assert.doesNotMatch(`${output(attempt)}\n${ledger}`, /example-token-value|example-secret-value/);
  assert.match(ledger, /\[REDACTED\]|redacted/i);
});

test('an incomplete run blocks a second slot and is diagnosed as incomplete or stale', (t) => {
  const root = loopFixture(t);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'incomplete-one', '--slot', 'incomplete-one', '--json').status, 0);
  const second = cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'incomplete-two', '--slot', 'incomplete-two', '--json');
  assert.equal(second.status, 2, output(second));
  assert.match(json(second).trigger, /active|incomplete|stale/i);
  assert.equal(existsSync(join(root, '.harness', 'runtime', 'runs', 'incomplete-two.json')), false);

  const doctor = cli(root, 'loop', 'doctor', '--strict', '--json');
  assert.equal(doctor.status, 1, output(doctor));
  assert.match(JSON.stringify(json(doctor)), /incomplete|stale/i);
});

test('worktree locks reject overlapping owners and unlock restores availability', (t) => {
  const root = loopFixture(t);
  const first = cli(root, 'loop', 'worktree', 'lock', '--owner', 'owner-one', '--paths', 'apps/**', '--json');
  assert.equal(first.status, 0, output(first));
  const conflict = cli(root, 'loop', 'worktree', 'lock', '--owner', 'owner-two', '--paths', 'apps/backend/**', '--json');
  assert.equal(conflict.status, 2, output(conflict));
  assert.equal(json(conflict).trigger, 'lock-conflict');
  const locks = json(cli(root, 'loop', 'worktree', 'locks', '--json'));
  assert.deepEqual(locks.locks.map(({ owner }) => owner), ['owner-one']);
  assert.equal(cli(root, 'loop', 'worktree', 'unlock', '--owner', 'owner-one', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'worktree', 'lock', '--owner', 'owner-two', '--paths', 'apps/backend/**', '--json').status, 0);
});

test('worktree create, reject, and cleanup keep the main worktree clean', (t) => {
  const config = loopConfig();
  config.patterns.find(({ id }) => id === 'ci-sweeper').enabled = true;
  const root = loopFixture(t, config);
  const baseline = git(root, 'status', '--short').stdout;
  const create = cli(root, 'loop', 'worktree', 'create', '--run-id', 'worktree-eval', '--pattern', 'ci-sweeper', '--json');
  assert.equal(create.status, 0, output(create));
  const worktree = json(create).worktree;
  assert.equal(existsSync(join(root, worktree.path)), true);
  assert.equal(cli(root, 'loop', 'worktree', 'mark', '--run-id', 'worktree-eval', '--status', 'rejected', '--json').status, 0);
  const cleanup = cli(root, 'loop', 'worktree', 'cleanup', '--run-id', 'worktree-eval', '--json');
  assert.equal(cleanup.status, 0, output(cleanup));
  assert.deepEqual(json(cleanup).removed, ['worktree-eval']);
  assert.equal(existsSync(join(root, worktree.path)), false);
  const after = git(root, 'status', '--short').stdout.replace(/^\?\? \.harness\/.*(?:\r?\n)?/gm, '');
  assert.equal(after, baseline);
});

test('metrics parses optional pattern and positive --days windows without treating the day count as an id', (t) => {
  const root = loopFixture(t);
  const recent = new Date(Date.now() - 86_400_000);
  const old = new Date(Date.now() - 10 * 86_400_000);
  const entries = [
    {
      schemaVersion: 1,
      runId: 'recent-health',
      loopId: 'harness-health',
      startedAt: recent.toISOString(),
      finishedAt: new Date(recent.getTime() + 1_000).toISOString(),
      outcome: 'no-op',
      tokens: 10,
    },
    {
      schemaVersion: 1,
      runId: 'recent-triage',
      loopId: 'daily-triage',
      startedAt: recent.toISOString(),
      finishedAt: new Date(recent.getTime() + 2_000).toISOString(),
      outcome: 'report-only',
      tokens: 20,
    },
    {
      schemaVersion: 1,
      runId: 'old-health',
      loopId: 'harness-health',
      startedAt: old.toISOString(),
      finishedAt: new Date(old.getTime() + 1_000).toISOString(),
      outcome: 'escalated',
      tokens: 30,
    },
  ];
  writeFileSync(join(root, 'loop-run-log.md'), `# Loop Run Log\n\n<!-- Loop appends below this line -->\n${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

  let metrics = cli(root, 'loop', 'metrics', '--json');
  assert.equal(metrics.status, 0, output(metrics));
  assert.equal(json(metrics).patterns.find(({ id }) => id === 'harness-health').runs, 2);

  metrics = cli(root, 'loop', 'metrics', '--days', '3', '--json');
  assert.equal(metrics.status, 0, output(metrics));
  const allMetrics = json(metrics);
  assert.equal(allMetrics.windowDays, 3);
  const allPatterns = allMetrics.patterns;
  assert.deepEqual(allPatterns.map(({ id }) => id), ['harness-health', 'daily-triage', 'ci-sweeper']);
  assert.equal(allPatterns.find(({ id }) => id === 'harness-health').runs, 1);
  assert.equal(allPatterns.find(({ id }) => id === 'harness-health').outcomes.escalated, 0);
  assert.equal(allPatterns.find(({ id }) => id === 'daily-triage').runs, 1);

  metrics = cli(root, 'loop', 'metrics', 'harness-health', '--days', '3', '--json');
  assert.equal(metrics.status, 0, output(metrics));
  assert.equal(json(metrics).windowDays, 3);
  assert.deepEqual(json(metrics).patterns.map(({ id }) => id), ['harness-health']);
  assert.equal(json(metrics).patterns[0].runs, 1);

  for (const invalidArgs of [
    ['--days', '0'],
    ['--days', '-1'],
    ['--days', '1.5'],
    ['--days', 'not-a-number'],
    ['--days'],
  ]) {
    const rejected = cli(root, 'loop', 'metrics', ...invalidArgs, '--json');
    assert.equal(rejected.status, 1, `${invalidArgs.join(' ')}\n${output(rejected)}`);
    assert.match(output(rejected), /--days.*(?:positive integer|requires a value)/i);
  }
});

test('metrics strictly reject malformed run logs and never echo sensitive fields', (t) => {
  const root = loopFixture(t);
  const today = new Date().toISOString().slice(0, 10);
  const validLog = readFileSync(join(GOLDEN, 'valid-run-log.md'), 'utf8').replaceAll('2026-08-06', today);
  writeFileSync(join(root, 'loop-run-log.md'), validLog);
  let metrics = cli(root, 'loop', 'metrics', 'harness-health', '--json');
  assert.equal(metrics.status, 0, output(metrics));
  let aggregate = json(metrics).patterns[0];
  assert.equal(aggregate.runs, 2);
  assert.equal(aggregate.tokensToday, 250);
  assert.equal(aggregate.outcomes['no-op'], 1);
  assert.equal(aggregate.outcomes.escalated, 1);

  writeFileSync(join(root, 'loop-run-log.md'), readFileSync(join(GOLDEN, 'malformed-run-log.md'), 'utf8'));
  metrics = cli(root, 'loop', 'metrics', '--json');
  assert.equal(metrics.status, 1, output(metrics));
  assert.match(output(metrics), /invalid|malformed|line/i);

  writeFileSync(join(root, 'loop-run-log.md'), readFileSync(join(GOLDEN, 'sensitive-run-log.md'), 'utf8'));
  metrics = cli(root, 'loop', 'metrics', '--json');
  assert.equal(metrics.status, 0, output(metrics));
  assert.doesNotMatch(output(metrics), /example-secret-value|Bearer example-token-value/);
});

test('install and upgrade preserve target-owned loop configuration', (t) => {
  const root = fullFixture(t);
  const target = join(root, 'loop-install-target');
  mkdirSync(target);
  const targetConfig = '{"schemaVersion":1,"targetOwned":true}\n';
  writeFileSync(join(target, 'loop.config.json'), targetConfig);

  let result = cli(root, 'install', '--merge', target);
  assert.equal(result.status, 0, output(result));
  assert.equal(readFileSync(join(target, 'loop.config.json'), 'utf8'), targetConfig);
  for (const path of [
    'LOOP.md',
    'loop-budget.md',
    'loop-constraints.md',
    'loop-run-log.md',
    'gate.yaml',
    'patterns/registry.json',
    'docs/loops/README.md',
    'tests/harness/loop-cli.test.mjs',
    'tests/harness/loop-golden.test.mjs',
    'evals/golden/loop-safety-v1.json',
    'evals/golden/pattern-scenarios-v1.json',
  ]) {
    assert.equal(existsSync(join(target, path)), true, `missing installed loop asset: ${path}`);
  }

  const beforeUpgrade = readFileSync(join(target, 'loop.config.json'), 'utf8');
  result = cli(root, 'upgrade', '--apply', target);
  assert.equal(readFileSync(join(target, 'loop.config.json'), 'utf8'), beforeUpgrade);
  assert.ok([0, 1].includes(result.status), output(result));
});
