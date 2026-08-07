import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
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

function collectChild(child, timeoutMs = 0) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ status, stdout, stderr, timedOut });
    });
  });
}

function cliAsync(root, ...args) {
  return collectChild(spawn(process.execPath, ['scripts/harness/cli.mjs', ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function cliWithDeadline(root, timeoutMs, ...args) {
  return collectChild(spawn(process.execPath, ['scripts/harness/cli.mjs', ...args], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  }), timeoutMs);
}

function loopAtAsync(root, startAt, ...args) {
  return loopAtWithEnvAsync(root, startAt, {}, ...args);
}

function loopAtWithEnvAsync(root, startAt, env, ...args) {
  const source = `
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [root, startAt, argsJson] = process.argv.slice(1);
    const runtime = await import(pathToFileURL(join(root, 'scripts', 'harness', 'lib', 'loop', 'runtime.mjs')).href);
    const delay = Number(startAt) - Date.now();
    if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    runtime.commandLoop(root, JSON.parse(argsJson));
  `;
  return collectChild(spawn(process.execPath, ['--input-type=module', '--eval', source, root, String(startAt), JSON.stringify(args)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }));
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

function writeEmbeddedState(root, state) {
  const path = join(root, 'STATE.md');
  const contents = readFileSync(path, 'utf8');
  const projection = `<!-- loop-state-json:start -->\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n<!-- loop-state-json:end -->`;
  assert.match(contents, /<!-- loop-state-json:start -->[\s\S]*<!-- loop-state-json:end -->/);
  writeFileSync(path, contents.replace(/<!-- loop-state-json:start -->[\s\S]*<!-- loop-state-json:end -->/, projection));
  rmSync(join(root, '.harness', 'runtime', 'state.json'), { force: true });
}

function instrumentMutexReclaimRace(root) {
  const path = join(root, 'scripts', 'harness', 'lib', 'loop', 'runtime.mjs');
  let contents = readFileSync(path, 'utf8');
  const replaceOnce = (from, to) => {
    assert.equal(contents.includes(from), true, `mutex instrumentation marker missing: ${from}`);
    contents = contents.replace(from, to);
  };
  replaceOnce(
    '  const owner = `${process.pid}-${randomUUID()}`;\n',
    `  const owner = \`\${process.pid}-\${randomUUID()}\`;
  const testReclaimerRole = process.env.HARNESS_TEST_RECLAIMER_ROLE ?? '';
  const testReclaimerDirectory = join(directory, 'test-reclaimer-barrier');
  if (testReclaimerRole) mkdirSync(testReclaimerDirectory, { recursive: true });
`,
  );
  replaceOnce(
    '              const tombstone = `${path}.stale-${randomUUID()}`;\n              try { renameSync(path, tombstone); }\n',
    `              if (testReclaimerRole) {
                writeFileSync(join(testReclaimerDirectory, \`\${testReclaimerRole}-observed\`), 'observed');
                while (!existsSync(join(testReclaimerDirectory, 'first-observed')) || !existsSync(join(testReclaimerDirectory, 'second-observed'))) sleep(5);
                if (testReclaimerRole === 'second') while (!existsSync(join(testReclaimerDirectory, 'first-acquired'))) sleep(5);
              }
              const tombstone = \`\${path}.stale-\${randomUUID()}\`;
              try { renameSync(path, tombstone); }
`,
  );
  replaceOnce(
    '      writeFileSync(join(path, \'owner.json\'), `${JSON.stringify({ owner, pid: process.pid, acquiredAt: now() })}\\n`);\n      break;\n',
    `      writeFileSync(join(path, 'owner.json'), \`\${JSON.stringify({ owner, pid: process.pid, acquiredAt: now() })}\\n\`);
      if (testReclaimerRole === 'first') writeFileSync(join(testReclaimerDirectory, 'first-acquired'), 'acquired');
      break;
`,
  );
  replaceOnce(
    '  try { return callback(); }\n  finally { release(); }\n',
    `  let testActivePath = null;
  if (testReclaimerRole) {
    testActivePath = join(testReclaimerDirectory, \`\${testReclaimerRole}-active\`);
    writeFileSync(testActivePath, 'active');
    const otherActive = join(testReclaimerDirectory, testReclaimerRole === 'first' ? 'second-active' : 'first-active');
    const waitUntil = Date.now() + 1500;
    while (!existsSync(otherActive) && Date.now() < waitUntil) sleep(5);
    if (existsSync(otherActive)) writeFileSync(join(testReclaimerDirectory, 'overlap'), 'overlap');
  }
  try { return callback(); }
  finally {
    if (testActivePath) rmSync(testActivePath, { force: true });
    release();
  }
`,
  );
  writeFileSync(path, contents);
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

function writeHarnessChecks(root, checks) {
  writeFileSync(join(root, 'harness.config.json'), `${JSON.stringify({
    schemaVersion: 2,
    mode: 'project',
    governedPaths: ['apps/**', 'packages/**'],
    checks: {
      fast: checks,
      full: checks,
      ci: checks,
    },
    boundaries: [],
    secretAllowlist: '.harness-secret-allowlist',
  }, null, 2)}\n`);
}

function checkCommand(id, source, cwd = '.') {
  return {
    id,
    program: process.execPath,
    args: ['-e', source],
    cwd,
    timeoutMs: 5000,
  };
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

function writeApprovedTask(root, taskId = 'approved-task', allowedPaths = ['apps/backend/**']) {
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
  const governance = JSON.parse(readFileSync(join(directory, 'governance.json'), 'utf8'));
  governance.roles[0].allowedPaths = allowedPaths;
  writeFileSync(join(directory, 'governance.json'), `${JSON.stringify(governance, null, 2)}\n`);
}

function l2EvidenceFixture(t, {
  runId = 'l2-evidence',
  checks = ['l2-check-one', 'l2-check-two'],
  maxChangedFiles = 4,
  lockPaths = ['apps/backend/**'],
  allowedPaths = ['apps/backend/**'],
  watchPaths = ['apps/backend/**'],
  denyPaths = null,
} = {}) {
  const config = loopConfig();
  const pattern = config.patterns.find(({ id }) => id === 'ci-sweeper');
  pattern.enabled = true;
  pattern.checks = checks;
  pattern.scope.watchPaths = watchPaths;
  if (denyPaths) pattern.scope.denyPaths = denyPaths;
  pattern.scope.maxChangedFiles = maxChangedFiles;
  pattern.isolation.lockPaths = lockPaths;
  const root = loopFixture(t, config);
  writeApprovedTask(root, 'approved-task', allowedPaths);
  writeHarnessChecks(root, checks.map((id) => checkCommand(id, 'process.exit(0)')));
  mkdirSync(join(root, 'apps', 'backend'), { recursive: true });
  writeFileSync(join(root, 'apps', 'backend', 'seed.txt'), 'baseline\n');
  assert.equal(git(root, 'add', 'harness.config.json', 'docs/plans/active/approved-task/governance.json', 'apps/backend/seed.txt').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'L2 evidence fixture').status, 0);
  const prepare = cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', runId, '--slot', runId, '--json');
  assert.equal(prepare.status, 0, output(prepare));
  const attempt = cli(root, 'loop', 'run', 'attempt', runId, '--action', 'implement approved patch', '--outcome', 'success', '--maker-session', 'maker-session', '--json');
  assert.equal(attempt.status, 0, output(attempt));
  const create = cli(root, 'loop', 'worktree', 'create', '--run-id', runId, '--pattern', 'ci-sweeper', '--json');
  assert.equal(create.status, 0, output(create));
  const worktree = json(create).worktree;
  return {
    root,
    runId,
    pattern,
    taskId: 'approved-task',
    makerSession: 'maker-session',
    worktree,
    worktreePath: join(root, worktree.path),
  };
}

function seedMakerGate(context, paths = ['apps/backend/fix.js']) {
  const { root, runId, taskId, makerSession } = context;
  const runRecordPath = join(root, '.harness', 'runtime', 'runs', `${runId}.json`);
  const record = JSON.parse(readFileSync(runRecordPath, 'utf8'));
  record.makerSession = makerSession;
  record.gateDecisions ??= [];
  record.gateDecisions.push({
    action: 'maker',
    allowed: true,
    at: new Date().toISOString(),
    paths,
    taskId,
    approvedVersion: 'V1',
    makerSession,
  });
  writeFileSync(runRecordPath, `${JSON.stringify(record, null, 2)}\n`);
}

function seedL2GateEvidence(context) {
  const { root, runId, taskId, makerSession, worktreePath } = context;
  const runRecordPath = join(root, '.harness', 'runtime', 'runs', `${runId}.json`);
  const record = JSON.parse(readFileSync(runRecordPath, 'utf8'));
  const baseSha = record.baseSha;
  const headSha = git(worktreePath, 'rev-parse', 'HEAD').stdout.trim();
  const diff = git(worktreePath, 'diff', '--binary', 'HEAD', '--').stdout;
  const changedFiles = git(worktreePath, 'diff', '--name-only', 'HEAD', '--').stdout.trim().split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll('\\', '/'));
  const diffHash = createHash('sha256').update(diff).digest('hex');
  record.makerSession = makerSession;
  record.gateDecisions ??= [];
  record.gateDecisions.push(
    {
      action: 'maker',
      allowed: true,
      at: new Date().toISOString(),
      paths: changedFiles,
      taskId,
      approvedVersion: 'V1',
      makerSession,
    },
    {
      action: 'scope',
      allowed: true,
      at: new Date().toISOString(),
      paths: changedFiles,
      changedFiles,
      taskId,
      approvedVersion: 'V1',
      baseSha,
      headSha,
      diffHash,
    },
  );
  writeFileSync(runRecordPath, `${JSON.stringify(record, null, 2)}\n`);
  return { baseSha, headSha, diffHash, changedFiles };
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

test('loop doctor reports configured capability and observed maturity per pattern', (t) => {
  const root = loopFixture(t);
  let doctor = json(cli(root, 'loop', 'doctor', '--json'));
  assert.ok(doctor.readiness.score < 100, 'a disabled L2 pattern must not make overall readiness 100');
  assert.deepEqual(doctor.readiness.patterns.map(({ id }) => id), ['harness-health', 'daily-triage', 'ci-sweeper']);
  for (const item of doctor.readiness.patterns) {
    assert.ok(item.configuredCapability);
    assert.equal(item.observedMaturity.level, 'L0');
    assert.equal(item.observedMaturity.validRuns, 0);
  }

  assert.equal(cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'observed-health', '--slot', 'observed-health', '--json').status, 0);
  const result = {
    outcome: 'report-only',
    evidenceComplete: true,
    unauthorizedWrites: 0,
    checks: [{ id: 'health-check', status: 'pass', evidence: 'real command passed' }],
    evidence: [{ id: 'health-evidence', type: 'command', subject: 'fixture health check' }],
  };
  assert.equal(cli(root, 'loop', 'run', 'finish', 'observed-health', '--result', JSON.stringify(result), '--json').status, 0);
  doctor = json(cli(root, 'loop', 'doctor', '--json'));
  assert.equal(doctor.readiness.patterns.find(({ id }) => id === 'harness-health').observedMaturity.level, 'L1');
  assert.equal(doctor.readiness.patterns.find(({ id }) => id === 'daily-triage').observedMaturity.level, 'L0');
  assert.equal(doctor.readiness.patterns.find(({ id }) => id === 'ci-sweeper').observedMaturity.level, 'L0');
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

test('loop validate --strict rejects a declared state projection path that cannot execute', (t) => {
  const root = loopFixture(t);
  const configPath = join(root, 'loop.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.patterns[0].state.summaryFile = 'patterns';
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const result = cli(root, 'loop', 'validate', '--strict', '--json');
  assert.equal(result.status, 1, output(result));
  assert.equal(json(result).ok, false);
  assert.match(json(result).errors.join('\n'), /state|summaryFile|patterns/i);
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

test('pattern registry projects complete operational metadata and strict validation rejects drift', (t) => {
  const root = loopFixture(t);
  const config = JSON.parse(readFileSync(join(root, 'loop.config.json'), 'utf8'));
  const registryPath = join(root, 'patterns', 'registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

  assert.equal(registry.schemaVersion, 2);
  assert.equal(registry.patterns.length, config.patterns.length);
  for (const pattern of config.patterns) {
    const entry = registry.patterns.find(({ id }) => id === pattern.id);
    assert.ok(entry, `missing registry entry for ${pattern.id}`);
    for (const field of ['owner', 'cadence', 'inputAdapters', 'skills', 'checks', 'cost', 'humanGates']) {
      assert.notEqual(entry[field], undefined, `${pattern.id} missing registry metadata ${field}`);
    }
    assert.deepEqual(entry.checks, pattern.checks);
    assert.equal(entry.cadence.trigger, pattern.trigger.type);
    assert.equal(entry.cadence.offHours, pattern.trigger.offHours);
    assert.equal(entry.cost.maxRunsPerDay, pattern.budget.maxRunsPerDay);
    assert.equal(entry.cost.maxTokensPerDay, pattern.budget.maxTokensPerDay);
    assert.equal(entry.humanGates.independentVerifier, pattern.roles.independentVerifier);
    assert.equal(entry.humanGates.push, pattern.gates.push);
    assert.equal(entry.humanGates.merge, pattern.gates.merge);
    assert.ok(entry.inputAdapters.length > 0);
    assert.ok(entry.skills.includes(pattern.roles.triageSkill));
  }

  registry.patterns[0].owner.role = 'unapproved-owner';
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const validate = cli(root, 'loop', 'validate', '--strict', '--json');
  assert.equal(validate.status, 1, output(validate));
  assert.match(json(validate).errors.join('\n'), /registry.*metadata drift.*harness-health/i);

  const sync = cli(root, 'loop', 'sync', '--write', '--json');
  assert.equal(sync.status, 0, output(sync));
  assert.equal(cli(root, 'loop', 'validate', '--strict', '--json').status, 0);
});

test('loop sync validates every configured summaryFile projection independently', (t) => {
  const config = loopConfig();
  config.patterns.find(({ id }) => id === 'daily-triage').state.summaryFile = 'state/daily-triage.md';
  const root = loopFixture(t, config);
  const secondary = join(root, 'state', 'daily-triage.md');
  assert.equal(existsSync(secondary), true);
  writeFileSync(secondary, readFileSync(secondary, 'utf8').replace('<!-- loop-state-json:start -->', '<!-- broken-loop-state-json:start -->'));

  const check = cli(root, 'loop', 'sync', '--check', '--json');
  assert.equal(check.status, 1, output(check));
  assert.equal(json(check).ok, false);
  assert.match(json(check).errors.join('\n'), /state\/daily-triage\.md.*(?:projection|machine|invalid)|(?:projection|machine|invalid).*state\/daily-triage\.md/i);
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

test('execute owns the full L1 lifecycle, emits real receipts, and deduplicates a slot', (t) => {
  const config = loopConfig({ health: { checks: ['health-pass', 'health-marker'] } });
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [
    checkCommand('health-pass', 'process.exit(0)'),
    checkCommand('health-marker', "require('node:fs').appendFileSync('.harness/health-check-invocations.log', 'run\\n')"),
  ]);
  const governedBefore = git(root, 'status', '--short', '--', 'apps', 'packages').stdout;

  const executed = cli(root, 'loop', 'run', 'execute', 'harness-health', '--run-id', 'execute-health', '--slot', 'execute-health-slot', '--trigger', 'manual', '--actor', 'qa-fixture', '--json');
  assert.equal(executed.status, 0, output(executed));
  const result = json(executed);
  assert.equal(result.runId, 'execute-health');
  assert.ok(['no-op', 'report-only'].includes(result.outcome));
  assert.equal(result.findings, 0);
  assert.equal(result.actions, 0);
  assert.equal(result.tokens, 0);
  assert.equal(result.checks.length, 2);
  assert.equal(typeof result.evidencePath, 'string');
  assert.equal(existsSync(join(root, result.evidencePath)), true);
  for (const id of config.patterns[0].checks) {
    const receipt = result.checks.find((entry) => entry.id === id);
    assert.ok(receipt, `missing receipt for ${id}`);
    assert.ok(Array.isArray(receipt.command) || (typeof receipt.program === 'string' && Array.isArray(receipt.args)));
    assert.equal(typeof receipt.cwd, 'string');
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.status, 'pass');
    assert.match(receipt.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(receipt.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof receipt.evidence, 'string');
    assert.ok(receipt.evidence.length > 0);
  }
  const record = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'runs', 'execute-health.json'), 'utf8'));
  assert.equal(record.status, 'finished');
  assert.equal(record.outcome, result.outcome);
  assert.deepEqual(record.checks, result.checks);
  const logEntries = readFileSync(join(root, 'loop-run-log.md'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('{')).map(JSON.parse);
  assert.equal(logEntries.filter(({ runId }) => runId === 'execute-health').length, 1);
  assert.deepEqual(logEntries.find(({ runId }) => runId === 'execute-health').checks, result.checks);
  assert.equal(readEmbeddedState(root).patterns['harness-health'].lastOutcome, result.outcome);
  assert.equal(git(root, 'status', '--short', '--', 'apps', 'packages').stdout, governedBefore);

  const duplicate = cli(root, 'loop', 'run', 'execute', 'harness-health', '--run-id', 'ignored-duplicate-run', '--slot', 'execute-health-slot', '--trigger', 'manual', '--actor', 'qa-fixture', '--json');
  assert.equal(duplicate.status, 0, output(duplicate));
  assert.equal(json(duplicate).runId, 'execute-health');
  assert.equal(json(duplicate).status, 'duplicate');
  assert.equal(readFileSync(join(root, '.harness', 'health-check-invocations.log'), 'utf8').trim().split(/\r?\n/).length, 1);
  const afterDuplicate = readFileSync(join(root, 'loop-run-log.md'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('{')).map(JSON.parse);
  assert.equal(afterDuplicate.filter(({ runId }) => runId === 'execute-health').length, 1);
});

test('harness-health execute records a failing command as evidence and never fabricates pass', (t) => {
  const config = loopConfig({ health: { checks: ['health-failure'] } });
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [checkCommand('health-failure', "process.stderr.write('deterministic failure\\n'); process.exit(7)")]);

  const executed = cli(root, 'loop', 'run', 'execute', 'harness-health', '--run-id', 'execute-failure', '--slot', 'execute-failure', '--json');
  assert.equal(executed.status, 0, output(executed));
  const result = json(executed);
  assert.equal(result.outcome, 'escalated');
  assert.ok(result.findings >= 1);
  assert.ok(result.escalations >= 1);
  const receipt = result.checks.find(({ id }) => id === 'health-failure');
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.exitCode, 7);
  assert.match(receipt.evidence, /deterministic failure|exit.?7/i);
  const record = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'runs', 'execute-failure.json'), 'utf8'));
  assert.equal(record.outcome, 'escalated');
  assert.equal(record.checks.find(({ id }) => id === 'health-failure').status, 'fail');
  assert.equal(readEmbeddedState(root).inbox.some((item) => item.loopId === 'harness-health' && item.status === 'open'), true);
});

test('daily-triage execute deduplicates stable local and CI findings then retires disappeared signals', (t) => {
  const config = loopConfig();
  const triage = config.patterns.find(({ id }) => id === 'daily-triage');
  triage.checks = ['triage-contract'];
  triage.state.retentionDays = 0;
  triage.budget.maxRunsPerDay = 10;
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [checkCommand('triage-contract', 'process.exit(0)')]);
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'triage-signal.md'), 'baseline\n');
  assert.equal(git(root, 'add', 'harness.config.json', 'docs/triage-signal.md').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'triage signal baseline').status, 0);
  writeFileSync(join(root, 'docs', 'triage-signal.md'), 'changed locally\n');
  const failedCi = { HARNESS_LOOP_CI_STATUS: 'failed', HARNESS_LOOP_CI_CHECK: 'fixture-ci' };

  let executed = cliWithEnv(root, failedCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'triage-first', '--slot', 'triage-first', '--json');
  assert.equal(executed.status, 0, output(executed));
  let state = readEmbeddedState(root);
  const ciFinding = state.highPriority.find((item) => /fixture-ci|ci/i.test(JSON.stringify(item)));
  const gitFinding = state.watch.find((item) => /docs\/triage-signal\.md/i.test(JSON.stringify(item)));
  assert.ok(ciFinding?.id);
  assert.ok(gitFinding?.id);
  assert.equal(typeof ciFinding.firstSeen, 'string');
  assert.equal(typeof ciFinding.lastSeen, 'string');

  executed = cliWithEnv(root, failedCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'triage-second', '--slot', 'triage-second', '--json');
  assert.equal(executed.status, 0, output(executed));
  state = readEmbeddedState(root);
  const repeated = [...state.highPriority, ...state.watch, ...state.noise, ...state.inbox].filter(({ id }) => id === ciFinding.id);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].firstSeen, ciFinding.firstSeen);
  assert.ok(Date.parse(repeated[0].lastSeen) >= Date.parse(ciFinding.lastSeen));

  writeFileSync(join(root, 'docs', 'triage-signal.md'), 'baseline\n');
  executed = cliWithEnv(root, { HARNESS_LOOP_CI_STATUS: 'passed', HARNESS_LOOP_CI_CHECK: 'fixture-ci' }, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'triage-cleaned', '--slot', 'triage-cleaned', '--json');
  assert.equal(executed.status, 0, output(executed));
  state = readEmbeddedState(root);
  const active = [...state.highPriority, ...state.watch, ...state.noise, ...state.inbox];
  assert.equal(active.some(({ id }) => id === ciFinding.id || id === gitFinding.id), false);
});

test('daily-triage retentionDays keeps recent disappeared findings and expires old ones', (t) => {
  const config = loopConfig();
  const triage = config.patterns.find(({ id }) => id === 'daily-triage');
  triage.checks = ['triage-contract'];
  triage.state.retentionDays = 90;
  triage.budget.maxRunsPerDay = 10;
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [checkCommand('triage-contract', 'process.exit(0)')]);
  assert.equal(git(root, 'add', 'harness.config.json').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'retention fixture').status, 0);
  const failedCi = { HARNESS_LOOP_CI_STATUS: 'failed', HARNESS_LOOP_CI_CHECK: 'retained-ci' };
  const cleanCi = { HARNESS_LOOP_CI_STATUS: 'passed', HARNESS_LOOP_CI_CHECK: 'retained-ci' };

  assert.equal(cliWithEnv(root, failedCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'retention-first', '--slot', 'retention-first', '--json').status, 0);
  let state = readEmbeddedState(root);
  const finding = state.highPriority.find((item) => item.subject === 'retained-ci');
  assert.ok(finding);

  assert.equal(cliWithEnv(root, cleanCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'retention-recent', '--slot', 'retention-recent', '--json').status, 0);
  state = readEmbeddedState(root);
  assert.equal(state.highPriority.some(({ id }) => id === finding.id), true);

  const retained = state.highPriority.find(({ id }) => id === finding.id);
  retained.firstSeen = '2020-01-01T00:00:00.000Z';
  retained.lastSeen = '2020-01-01T00:00:00.000Z';
  writeEmbeddedState(root, state);
  assert.equal(cliWithEnv(root, cleanCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'retention-expired', '--slot', 'retention-expired', '--json').status, 0);
  state = readEmbeddedState(root);
  assert.equal(state.highPriority.some(({ id }) => id === finding.id), false);
});

test('daily-triage execute exits with zero cost when local and CI inputs are clean', (t) => {
  const config = loopConfig();
  const triage = config.patterns.find(({ id }) => id === 'daily-triage');
  triage.checks = ['triage-contract'];
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [checkCommand('triage-contract', 'process.exit(0)')]);
  assert.equal(git(root, 'add', 'harness.config.json').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'clean triage fixture').status, 0);
  const governedBefore = git(root, 'status', '--short', '--', 'apps', 'packages').stdout;

  const executed = cliWithEnv(root, { HARNESS_LOOP_CI_STATUS: 'passed', HARNESS_LOOP_CI_CHECK: 'fixture-ci' }, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'triage-clean', '--slot', 'triage-clean', '--json');
  assert.equal(executed.status, 0, output(executed));
  const result = json(executed);
  assert.ok(['no-op', 'report-only'].includes(result.outcome));
  assert.equal(result.findings, 0);
  assert.equal(result.actions, 0);
  assert.equal(result.tokens, 0);
  assert.equal(git(root, 'status', '--short', '--', 'apps', 'packages').stdout, governedBefore);
});

test('execute rejects caller-supplied results and fails closed for disabled or non-L1 patterns', (t) => {
  const root = loopFixture(t);
  const selfReported = cli(root, 'loop', 'run', 'execute', 'harness-health', '--result', '{"outcome":"success"}', '--run-id', 'self-reported', '--slot', 'self-reported', '--json');
  assert.notEqual(selfReported.status, 0);
  assert.match(output(selfReported), /execute.*(?:does not accept|forbids).*result|unknown.*--result|self-reported/i);
  assert.equal(existsSync(join(root, '.harness', 'runtime', 'runs', 'self-reported.json')), false);

  const disabled = cli(root, 'loop', 'run', 'execute', 'ci-sweeper', '--run-id', 'disabled-execute', '--slot', 'disabled-execute', '--json');
  assert.equal(disabled.status, 2, output(disabled));
  assert.match(json(disabled).trigger, /disabled/i);

  const configPath = join(root, 'loop.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.patterns.find(({ id }) => id === 'ci-sweeper').enabled = true;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  const nonL1 = cli(root, 'loop', 'run', 'execute', 'ci-sweeper', '--run-id', 'l2-execute', '--slot', 'l2-execute', '--json');
  assert.equal(nonL1.status, 2, output(nonL1));
  assert.match(json(nonL1).trigger, /level|l1|unsupported/i);
});

test('default harness-health execute does not fail loop-doctor-strict on its own current run', (t) => {
  const config = JSON.parse(readFileSync(join(REPOSITORY, 'loop.config.json'), 'utf8'));
  const root = loopFixture(t, config);
  const health = config.patterns.find(({ id }) => id === 'harness-health');
  writeHarnessChecks(root, health.checks.map((id) => id === 'loop-doctor-strict'
    ? {
        id,
        program: process.execPath,
        args: ['scripts/harness/cli.mjs', 'loop', 'doctor', '--strict', '--json'],
        cwd: '.',
        timeoutMs: 5000,
      }
    : checkCommand(id, 'process.exit(0)')));
  const baselinePrepare = cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'proven-health-baseline', '--slot', 'proven-health-baseline', '--json');
  assert.equal(baselinePrepare.status, 0, output(baselinePrepare));
  const baselineFinish = cli(root, 'loop', 'run', 'finish', 'proven-health-baseline', '--result', JSON.stringify({
    outcome: 'no-op',
    tokens: 0,
    findings: 0,
    actions: 0,
    escalations: 0,
    evidenceComplete: true,
    checks: [{ id: 'fixture-baseline', status: 'pass', evidence: 'deterministic baseline' }],
    evidence: [{ id: 'fixture-baseline', type: 'test', subject: 'prior proven L1 run' }],
  }), '--json');
  assert.equal(baselineFinish.status, 0, output(baselineFinish));

  const executed = cli(root, 'loop', 'run', 'execute', 'harness-health', '--run-id', 'default-health-execute', '--slot', 'default-health-execute', '--json');
  assert.equal(executed.status, 0, output(executed));
  const result = json(executed);
  assert.deepEqual(result.checks.map(({ id }) => id), health.checks);
  assert.equal(result.checks.find(({ id }) => id === 'loop-doctor-strict').status, 'pass');
  assert.ok(['no-op', 'report-only'].includes(result.outcome));
  const record = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'runs', 'default-health-execute.json'), 'utf8'));
  assert.equal(record.status, 'finished');
  assert.equal(readEmbeddedState(root).patterns['harness-health'].currentRun, null);
});

test('daily-triage reads git status beyond 2000 characters without losing the final finding', (t) => {
  const config = loopConfig();
  const triage = config.patterns.find(({ id }) => id === 'daily-triage');
  triage.checks = ['triage-long-evidence'];
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [checkCommand('triage-long-evidence', "process.stdout.write('e'.repeat(5000))")]);
  assert.equal(git(root, 'add', 'harness.config.json').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'long status fixture').status, 0);
  const signalDirectory = join(root, 'signals');
  mkdirSync(signalDirectory, { recursive: true });
  for (let index = 0; index < 160; index += 1) writeFileSync(join(signalDirectory, `signal-${String(index).padStart(3, '0')}.txt`), 'baseline\n');
  writeFileSync(join(signalDirectory, 'zz-tail-signal.txt'), 'baseline\n');
  assert.equal(git(root, 'add', 'signals').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'tracked long status inputs').status, 0);
  for (let index = 0; index < 160; index += 1) writeFileSync(join(signalDirectory, `signal-${String(index).padStart(3, '0')}.txt`), `changed ${index}\n`);
  writeFileSync(join(signalDirectory, 'zz-tail-signal.txt'), 'must survive collection truncation\n');
  const porcelain = git(root, 'status', '--short').stdout;
  assert.ok(porcelain.length > 2000);
  assert.ok(porcelain.indexOf('signals/zz-tail-signal.txt') > 2000);

  const executed = cliWithEnv(root, { HARNESS_LOOP_CI_STATUS: 'passed', HARNESS_LOOP_CI_CHECK: 'fixture-ci' }, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'triage-long-status', '--slot', 'triage-long-status', '--json');
  assert.equal(executed.status, 0, output(executed));
  const result = json(executed);
  const receipt = result.checks.find(({ id }) => id === 'triage-long-evidence');
  assert.equal(receipt.status, 'pass');
  assert.ok(receipt.evidence.length > 0);
  const state = readEmbeddedState(root);
  assert.equal(
    [...state.highPriority, ...state.watch, ...state.noise, ...state.inbox]
      .some((item) => /signals\/zz-tail-signal\.txt/i.test(JSON.stringify(item))),
    true,
  );
});

test('daily-triage merge and cleanup scope colliding IDs by source adapter and pattern', (t) => {
  const config = loopConfig();
  const triage = config.patterns.find(({ id }) => id === 'daily-triage');
  triage.checks = ['triage-contract'];
  triage.state.retentionDays = 0;
  triage.budget.maxRunsPerDay = 10;
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [checkCommand('triage-contract', 'process.exit(0)')]);
  assert.equal(git(root, 'add', 'harness.config.json').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'collision fixture').status, 0);
  const failedCi = { HARNESS_LOOP_CI_STATUS: 'failed', HARNESS_LOOP_CI_CHECK: 'collision-ci' };
  let executed = cliWithEnv(root, failedCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'collision-first', '--slot', 'collision-first', '--json');
  assert.equal(executed.status, 0, output(executed));
  const state = readEmbeddedState(root);
  const target = state.highPriority.find((item) => /collision-ci/i.test(JSON.stringify(item)));
  assert.ok(target?.id);
  assert.equal(target.patternId, 'daily-triage');
  assert.equal(target.sourceAdapter, 'ci');
  const otherPattern = {
    ...structuredClone(target),
    patternId: 'harness-health',
    loopId: 'harness-health',
    message: 'same id owned by another pattern',
    lastSeen: '2026-01-01T00:00:00.000Z',
    humanOverride: { decision: 'keep-other-pattern', by: 'human' },
  };
  const otherSource = {
    ...structuredClone(target),
    sourceAdapter: 'manual-fixture',
    message: 'same id owned by another adapter',
    lastSeen: '2026-01-02T00:00:00.000Z',
    humanOverride: { decision: 'keep-other-source', by: 'human' },
  };
  const humanItem = {
    id: target.id,
    patternId: 'daily-triage',
    loopId: 'daily-triage',
    sourceAdapter: 'human',
    message: 'human-owned colliding item',
    firstSeen: '2026-01-03T00:00:00.000Z',
    lastSeen: '2026-01-03T00:00:00.000Z',
    status: 'open',
    humanOverride: { decision: 'defer', by: 'operator' },
  };
  state.watch.push(otherPattern);
  state.noise.push(otherSource);
  state.inbox.push(humanItem);
  writeEmbeddedState(root, state);

  executed = cliWithEnv(root, failedCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'collision-second', '--slot', 'collision-second', '--json');
  assert.equal(executed.status, 0, output(executed));
  let merged = readEmbeddedState(root);
  assert.deepEqual(merged.watch.find((item) => item.id === target.id && item.patternId === 'harness-health'), otherPattern);
  assert.deepEqual(merged.noise.find((item) => item.id === target.id && item.sourceAdapter === 'manual-fixture'), otherSource);
  assert.deepEqual(merged.inbox.find((item) => item.id === target.id && item.sourceAdapter === 'human'), humanItem);
  assert.equal(
    [...merged.highPriority, ...merged.watch, ...merged.noise, ...merged.inbox]
      .filter((item) => item.id === target.id && item.patternId === 'daily-triage' && item.sourceAdapter === 'ci').length,
    1,
  );

  executed = cliWithEnv(root, { HARNESS_LOOP_CI_STATUS: 'passed', HARNESS_LOOP_CI_CHECK: 'collision-ci' }, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'collision-cleanup', '--slot', 'collision-cleanup', '--json');
  assert.equal(executed.status, 0, output(executed));
  merged = readEmbeddedState(root);
  const allItems = [...merged.highPriority, ...merged.watch, ...merged.noise, ...merged.inbox];
  assert.equal(allItems.some((item) => item.id === target.id && item.patternId === 'daily-triage' && item.sourceAdapter === 'ci'), false);
  assert.deepEqual(merged.watch.find((item) => item.id === target.id && item.patternId === 'harness-health'), otherPattern);
  assert.deepEqual(merged.noise.find((item) => item.id === target.id && item.sourceAdapter === 'manual-fixture'), otherSource);
  assert.deepEqual(merged.inbox.find((item) => item.id === target.id && item.sourceAdapter === 'human'), humanItem);
});

test('daily-triage refreshes an active overridden finding and preserves it unchanged after disappearance', (t) => {
  const config = loopConfig();
  const triage = config.patterns.find(({ id }) => id === 'daily-triage');
  triage.checks = ['triage-contract'];
  triage.state.retentionDays = 0;
  triage.budget.maxRunsPerDay = 10;
  const root = loopFixture(t, config);
  writeHarnessChecks(root, [checkCommand('triage-contract', 'process.exit(0)')]);
  assert.equal(git(root, 'add', 'harness.config.json').status, 0);
  assert.equal(git(root, 'commit', '--no-gpg-sign', '-m', 'override lifecycle fixture').status, 0);
  const failedCi = { HARNESS_LOOP_CI_STATUS: 'failed', HARNESS_LOOP_CI_CHECK: 'override-ci' };

  let executed = cliWithEnv(root, failedCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'override-first', '--slot', 'override-first', '--json');
  assert.equal(executed.status, 0, output(executed));
  const state = readEmbeddedState(root);
  const target = state.highPriority.find((item) => /override-ci/i.test(JSON.stringify(item)));
  assert.ok(target?.id);
  const ownership = {
    id: target.id,
    patternId: target.patternId,
    sourceAdapter: target.sourceAdapter,
  };
  const humanOverride = {
    decision: 'defer',
    by: 'operator',
    at: '2026-08-07T00:00:00.000Z',
    evidence: 'reviewed and kept active',
  };
  const firstSeen = target.firstSeen;
  const staleLastSeen = '2026-01-01T00:00:00.000Z';
  target.humanOverride = humanOverride;
  target.lastSeen = staleLastSeen;
  writeEmbeddedState(root, state);

  executed = cliWithEnv(root, failedCi, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'override-active', '--slot', 'override-active', '--json');
  assert.equal(executed.status, 0, output(executed));
  let refreshedState = readEmbeddedState(root);
  const matchesOwnership = (item) => item.id === ownership.id
    && item.patternId === ownership.patternId
    && item.sourceAdapter === ownership.sourceAdapter;
  let matches = [...refreshedState.highPriority, ...refreshedState.watch, ...refreshedState.noise, ...refreshedState.inbox].filter(matchesOwnership);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].firstSeen, firstSeen);
  assert.deepEqual(matches[0].humanOverride, humanOverride);
  assert.ok(Date.parse(matches[0].lastSeen) > Date.parse(staleLastSeen));
  const refreshed = structuredClone(matches[0]);

  executed = cliWithEnv(root, { HARNESS_LOOP_CI_STATUS: 'passed', HARNESS_LOOP_CI_CHECK: 'override-ci' }, 'loop', 'run', 'execute', 'daily-triage', '--run-id', 'override-disappeared', '--slot', 'override-disappeared', '--json');
  assert.equal(executed.status, 0, output(executed));
  refreshedState = readEmbeddedState(root);
  matches = [...refreshedState.highPriority, ...refreshedState.watch, ...refreshedState.noise, ...refreshedState.inbox].filter(matchesOwnership);
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0], refreshed);
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

test('finish rejects a run that would exceed the cumulative daily token cap', (t) => {
  const config = loopConfig({ health: { budget: { maxTokensPerRun: 100, maxTokensPerDay: 100 } } });
  const root = loopFixture(t, config);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'token-first', '--slot', 'token-first', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'run', 'finish', 'token-first', '--outcome', 'report-only', '--tokens', '80', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'token-second', '--slot', 'token-second', '--json').status, 0);

  const blocked = cli(root, 'loop', 'run', 'finish', 'token-second', '--outcome', 'report-only', '--tokens', '30', '--json');
  assert.equal(blocked.status, 2, output(blocked));
  assert.match(json(blocked).trigger, /daily-token-budget/i);
});

test('finish rejects actions beyond maxActionsPerDay', (t) => {
  const config = loopConfig();
  const sweeper = config.patterns.find(({ id }) => id === 'ci-sweeper');
  sweeper.enabled = true;
  sweeper.budget.maxActionsPerDay = 1;
  const root = loopFixture(t, config);
  for (const runId of ['action-first', 'action-second']) {
    assert.equal(cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', runId, '--slot', runId, '--json').status, 0);
    const finish = cli(root, 'loop', 'run', 'finish', runId, '--outcome', 'report-only', '--actions', '1', '--maker-session', `${runId}-maker`, '--verifier-session', `${runId}-verifier`, '--verifier-status', 'pass', '--json');
    if (runId === 'action-first') assert.equal(finish.status, 0, output(finish));
    else {
      assert.equal(finish.status, 2, output(finish));
      assert.match(json(finish).trigger, /daily-action-budget|max-actions/i);
    }
  }
});

test('concurrent finish calls append one terminal record and cannot overspend the daily budget', async (t) => {
  const config = loopConfig({ health: { budget: { maxTokensPerRun: 100, maxTokensPerDay: 100 } } });
  const root = loopFixture(t, config);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'finish-race', '--slot', 'finish-race', '--json').status, 0);
  const startAt = Date.now() + 1000;
  const contenders = Array.from({ length: 8 }, () => loopAtAsync(
    root,
    startAt,
    'run', 'finish', 'finish-race', '--outcome', 'report-only', '--tokens', '60', '--json',
  ));
  const results = await Promise.all(contenders);
  const entries = readFileSync(join(root, 'loop-run-log.md'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('{'))
    .map(JSON.parse)
    .filter(({ runId }) => runId === 'finish-race');
  assert.equal(entries.length, 1, `terminal entries=${entries.length}\n${results.map(output).join('\n')}`);
  assert.ok(entries.reduce((sum, entry) => sum + entry.tokens, 0) <= 100);
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

test('STATE preserves and renders structured triage items across finish and inbox writes', (t) => {
  const root = loopFixture(t);
  const state = readEmbeddedState(root);
  state.highPriority = [{ id: 'high-drift', message: 'Harness drift', source: 'local-check', lastSeen: '2026-08-07T00:00:00.000Z', humanOverride: null }];
  state.watch = [{ id: 'watch-flake', message: 'Intermittent check', source: 'local-check', lastSeen: '2026-08-07T00:00:00.000Z', humanOverride: null }];
  state.noise = [{ id: 'noise-bot', message: 'Ignored bot update', source: 'git', lastSeen: '2026-08-07T00:00:00.000Z', humanOverride: null }];
  state.inbox = [{ id: 'needs-owner', loopId: 'daily-triage', message: 'Choose an owner', source: 'triage', firstSeen: '2026-08-07T00:00:00.000Z', lastSeen: '2026-08-07T00:00:00.000Z', status: 'open', humanOverride: null }];
  writeEmbeddedState(root, state);

  assert.equal(cli(root, 'loop', 'run', 'prepare', 'daily-triage', '--run-id', 'state-preserve', '--slot', 'state-preserve', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'run', 'finish', 'state-preserve', '--outcome', 'report-only', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'inbox', 'add', 'daily-triage', '--id', 'new-human-item', '--message', 'Review a new signal', '--json').status, 0);

  const projected = readEmbeddedState(root);
  assert.deepEqual(projected.highPriority, state.highPriority);
  assert.deepEqual(projected.watch, state.watch);
  assert.deepEqual(projected.noise, state.noise);
  assert.equal(projected.inbox.some(({ id }) => id === 'needs-owner'), true);
  assert.equal(projected.inbox.some(({ id }) => id === 'new-human-item'), true);
  const markdown = readFileSync(join(root, 'STATE.md'), 'utf8');
  assert.match(markdown, /## High Priority[\s\S]*Harness drift/i);
  assert.match(markdown, /## Watch(?: List)?[\s\S]*Intermittent check/i);
  assert.match(markdown, /## (?:Recent )?Noise[\s\S]*Ignored bot update/i);
});

test('adding the same stable finding updates lastSeen without duplicating it', (t) => {
  const root = loopFixture(t);
  const first = cli(root, 'loop', 'inbox', 'add', 'daily-triage', '--id', 'stable-finding', '--message', 'Needs a human decision', '--json');
  assert.equal(first.status, 0, output(first));
  const state = readEmbeddedState(root);
  const item = state.inbox.find(({ id }) => id === 'stable-finding');
  item.firstSeen = '2026-08-01T00:00:00.000Z';
  item.lastSeen = '2026-08-01T00:00:00.000Z';
  writeEmbeddedState(root, state);

  const duplicate = cli(root, 'loop', 'inbox', 'add', 'daily-triage', '--id', 'stable-finding', '--message', 'Needs a human decision', '--json');
  assert.equal(duplicate.status, 0, output(duplicate));
  const after = readEmbeddedState(root);
  assert.equal(after.inbox.filter(({ id }) => id === 'stable-finding').length, 1);
  assert.equal(after.inbox.find(({ id }) => id === 'stable-finding').firstSeen, '2026-08-01T00:00:00.000Z');
  assert.notEqual(after.inbox.find(({ id }) => id === 'stable-finding').lastSeen, '2026-08-01T00:00:00.000Z');
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

test('L2 finish does not accept caller-supplied verifier status in place of bound proposal evidence', (t) => {
  const { root, runId } = l2EvidenceFixture(t, { runId: 'l2-self-report' });
  const selfReported = cli(root, 'loop', 'run', 'finish', runId, '--outcome', 'proposal', '--actions', '1', '--maker-session', 'same', '--verifier-session', 'different', '--verifier-status', 'pass', '--json');
  assert.equal(selfReported.status, 2, output(selfReported));
  assert.match(json(selfReported).trigger, /maker|scope|proposal|receipt|verification/i);
});

test('L2 maker and scope gates bind the approved worktree diff without verifier preconditions', (t) => {
  const { root, runId, taskId, worktreePath } = l2EvidenceFixture(t, { runId: 'gate-eval' });
  const maker = cli(root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'maker', '--paths', 'apps/backend/fix.js', '--task', taskId, '--run-id', runId, '--json');
  assert.equal(maker.status, 0, output(maker));
  assert.equal(json(maker).allowed, true);
  assert.equal(json(maker).action, 'maker');
  assert.doesNotMatch(output(maker), /verifier|receipt/i);

  const legacyWrite = cli(root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'write', '--paths', 'apps/backend/fix.js', '--task', taskId, '--run-id', runId, '--json');
  assert.notEqual(legacyWrite.status, 0, output(legacyWrite));
  assert.match(output(legacyWrite), /maker/i);

  writeFileSync(join(worktreePath, 'apps', 'backend', 'fix.js'), 'export const fixed = true;\n');
  const scope = cli(root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'scope', '--paths-from', 'git', '--task', taskId, '--run-id', runId, '--json');
  assert.equal(scope.status, 0, output(scope));
  const scopeEvidence = json(scope);
  assert.equal(scopeEvidence.allowed, true);
  assert.equal(scopeEvidence.action, 'scope');
  assert.match(scopeEvidence.baseSha, /^[a-f0-9]{40}$/);
  assert.match(scopeEvidence.headSha, /^[a-f0-9]{40}$/);
  assert.match(scopeEvidence.diffHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(scopeEvidence.changedFiles, ['apps/backend/fix.js']);
  const record = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'runs', `${runId}.json`), 'utf8'));
  assert.equal(record.gateDecisions.some(({ action, allowed }) => action === 'maker' && allowed), true);
  assert.equal(record.gateDecisions.some(({ action, allowed }) => action === 'scope' && allowed), true);

  for (const action of ['push', 'merge']) {
    const blocked = cli(root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', action, '--task', taskId, '--run-id', runId, '--paths', 'apps/backend/fix.js', '--json');
    assert.equal(blocked.status, 2, output(blocked));
  }
});

test('L2 scope gate independently rejects denylist, file-count, ownership, and lock drift', (t) => {
  const cases = [
    {
      name: 'denylist',
      context: l2EvidenceFixture(t, {
        runId: 'scope-deny',
        lockPaths: ['**'],
        allowedPaths: ['**'],
        watchPaths: ['**'],
      }),
      files: [['auth/forbidden.js', 'export const forbidden = true;\n']],
      trigger: /deny/i,
    },
    {
      name: 'file-count',
      context: l2EvidenceFixture(t, { runId: 'scope-count', maxChangedFiles: 1 }),
      files: [
        ['apps/backend/one.js', 'export const one = 1;\n'],
        ['apps/backend/two.js', 'export const two = 2;\n'],
      ],
      trigger: /file-count|max.*file/i,
    },
    {
      name: 'ownership',
      context: l2EvidenceFixture(t, {
        runId: 'scope-owner',
        lockPaths: ['apps/**'],
        watchPaths: ['apps/**'],
      }),
      files: [['apps/frontend/outside.js', 'export const outside = true;\n']],
      trigger: /owner/i,
    },
    {
      name: 'lock',
      context: l2EvidenceFixture(t, {
        runId: 'scope-lock',
        allowedPaths: ['apps/backend/**', 'docs/**'],
        watchPaths: ['apps/backend/**', 'docs/**'],
      }),
      files: [['docs/unlocked.md', 'not covered by the run lock\n']],
      trigger: /lock/i,
    },
  ];
  const results = [];
  for (const entry of cases) {
    seedMakerGate(entry.context);
    for (const [path, contents] of entry.files) {
      mkdirSync(dirname(join(entry.context.worktreePath, path)), { recursive: true });
      writeFileSync(join(entry.context.worktreePath, path), contents);
    }
    const result = cli(entry.context.root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'scope', '--paths-from', 'git', '--task', entry.context.taskId, '--run-id', entry.context.runId, '--json');
    results.push({ entry, result });
  }
  for (const { entry, result } of results) {
    assert.equal(result.status, 2, `${entry.name}\n${output(result)}`);
    assert.match(json(result).trigger, entry.trigger);
  }
});

test('L2 verify rejects self-verification and caller-supplied pass status', (t) => {
  const context = l2EvidenceFixture(t, { runId: 'verify-reject' });
  writeFileSync(join(context.worktreePath, 'apps', 'backend', 'fix.js'), 'export const fixed = true;\n');
  seedL2GateEvidence(context);
  const selfVerified = cli(context.root, 'loop', 'run', 'verify', context.runId, '--session', context.makerSession, '--json');
  assert.equal(selfVerified.status, 2, output(selfVerified));
  assert.match(json(selfVerified).trigger, /independent|maker|same-session/i);
  const selfReported = cli(context.root, 'loop', 'run', 'verify', context.runId, '--session', 'verifier-session', '--status', 'pass', '--json');
  assert.notEqual(selfReported.status, 0, output(selfReported));
  assert.match(output(selfReported), /status|self-report|caller|unknown option/i);
});

test('L2 verify executes exact declared checks in the run worktree and persists a bound receipt', (t) => {
  const context = l2EvidenceFixture(t, { runId: 'verify-valid' });
  writeFileSync(join(context.worktreePath, 'apps', 'backend', 'fix.js'), 'export const fixed = true;\n');
  const binding = seedL2GateEvidence(context);
  const verified = cli(context.root, 'loop', 'run', 'verify', context.runId, '--session', 'verifier-session', '--json');
  assert.equal(verified.status, 0, output(verified));
  const receipt = json(verified);
  assert.equal(receipt.runId, context.runId);
  assert.equal(receipt.taskId, context.taskId);
  assert.equal(receipt.baseSha, binding.baseSha);
  assert.equal(receipt.headSha, binding.headSha);
  assert.equal(receipt.diffHash, binding.diffHash);
  assert.equal(receipt.verifierSession, 'verifier-session');
  assert.match(receipt.checksHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.checks.map(({ id }) => id), context.pattern.checks);
  for (const check of receipt.checks) {
    assert.equal(typeof check.program, 'string');
    assert.ok(Array.isArray(check.args));
    assert.equal(check.cwd, context.worktree.path);
    assert.equal(check.exitCode, 0);
    assert.equal(check.status, 'pass');
    assert.match(check.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(check.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(check.evidence.length > 0);
  }
  const persistedPath = join(context.root, '.harness', 'runtime', 'verifications', `${context.runId}.json`);
  assert.equal(existsSync(persistedPath), true);
  const persisted = JSON.parse(readFileSync(persistedPath, 'utf8'));
  for (const field of ['runId', 'taskId', 'baseSha', 'headSha', 'diffHash', 'checksHash', 'verifierSession']) {
    assert.equal(persisted[field], receipt[field]);
  }
  assert.deepEqual(persisted.checks, receipt.checks);
});

test('L2 proposal gate fails closed for missing or forged verification receipts', (t) => {
  const mutations = [
    ['missing-receipt', null, /receipt|verification/i],
    ['missing-check', (receipt) => { receipt.checks.pop(); }, /check|receipt/i],
    ['extra-check', (receipt) => { receipt.checks.push({ ...receipt.checks[0], id: 'undeclared-check' }); }, /check|receipt/i],
    ['wrong-cwd', (receipt) => { receipt.checks[0].cwd = '.'; }, /cwd|worktree|receipt/i],
    ['wrong-base', (receipt) => { receipt.baseSha = '0'.repeat(40); }, /sha|drift|receipt/i],
    ['wrong-diff', (receipt) => { receipt.diffHash = '0'.repeat(64); }, /diff|drift|receipt/i],
  ];
  const results = [];
  for (const [suffix, mutate, trigger] of mutations) {
    const context = l2EvidenceFixture(t, { runId: `proposal-${suffix}` });
    writeFileSync(join(context.worktreePath, 'apps', 'backend', 'fix.js'), 'export const fixed = true;\n');
    const binding = seedL2GateEvidence(context);
    if (mutate) {
      const timestamp = new Date().toISOString();
      const checks = context.pattern.checks.map((id) => ({
        id,
        program: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: context.worktree.path,
        exitCode: 0,
        startedAt: timestamp,
        finishedAt: timestamp,
        status: 'pass',
        evidence: 'fixture receipt',
      }));
      const receipt = {
        schemaVersion: 1,
        runId: context.runId,
        taskId: context.taskId,
        ...binding,
        checks,
        checksHash: createHash('sha256').update(JSON.stringify(checks)).digest('hex'),
        verifierSession: 'verifier-session',
      };
      mutate(receipt);
      const directory = join(context.root, '.harness', 'runtime', 'verifications');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${context.runId}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
    }
    const proposal = cli(context.root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'proposal', '--task', context.taskId, '--run-id', context.runId, '--json');
    results.push({ suffix, proposal, trigger });
  }
  for (const { suffix, proposal, trigger } of results) {
    assert.equal(proposal.status, 2, `${suffix}\n${output(proposal)}`);
    assert.match(json(proposal).trigger, trigger);
  }
});

test('L2 proposal main chain consumes maker, scope, and independent verifier evidence before finish', (t) => {
  const context = l2EvidenceFixture(t, { runId: 'proposal-main-chain' });
  const plannedPath = 'apps/backend/proposal.js';
  const maker = cli(context.root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'maker', '--paths', plannedPath, '--task', context.taskId, '--run-id', context.runId, '--json');
  assert.equal(maker.status, 0, output(maker));
  writeFileSync(join(context.worktreePath, plannedPath), 'export const proposal = true;\n');
  const scope = cli(context.root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'scope', '--paths-from', 'git', '--task', context.taskId, '--run-id', context.runId, '--json');
  assert.equal(scope.status, 0, output(scope));
  const verified = cli(context.root, 'loop', 'run', 'verify', context.runId, '--session', 'verifier-session', '--json');
  assert.equal(verified.status, 0, output(verified));
  const proposal = cli(context.root, 'loop', 'gate', 'check', 'ci-sweeper', '--action', 'proposal', '--task', context.taskId, '--run-id', context.runId, '--json');
  assert.equal(proposal.status, 0, output(proposal));
  const finished = cli(context.root, 'loop', 'run', 'finish', context.runId, '--outcome', 'proposal', '--actions', '1', '--json');
  assert.equal(finished.status, 0, output(finished));
  assert.equal(json(finished).outcome, 'proposal');
  assert.equal(readEmbeddedState(context.root).patterns['ci-sweeper'].currentRun, null);
  assert.equal(existsSync(join(context.root, '.harness', 'runtime', 'worktrees', 'locks', `${context.runId}.json`)), false);
  const manifest = JSON.parse(readFileSync(join(context.root, '.harness', 'runtime', 'worktrees', 'manifest.json'), 'utf8'));
  assert.notEqual(manifest.worktrees.find(({ runId }) => runId === context.runId).status, 'active');
  assert.equal(existsSync(join(context.worktreePath, plannedPath)), true);
});

test('L2 finish escalated clears controller state and lock while retaining a dirty worktree patch', (t) => {
  const context = l2EvidenceFixture(t, { runId: 'terminal-escalated' });
  const dirtyPath = join(context.worktreePath, 'apps', 'backend', 'unfinished.js');
  writeFileSync(dirtyPath, 'export const unfinished = true;\n');
  const finished = cli(context.root, 'loop', 'run', 'finish', context.runId, '--outcome', 'escalated', '--findings', '1', '--escalations', '1', '--json');
  assert.equal(finished.status, 0, output(finished));
  assert.equal(readEmbeddedState(context.root).patterns['ci-sweeper'].currentRun, null);
  assert.equal(existsSync(join(context.root, '.harness', 'runtime', 'worktrees', 'locks', `${context.runId}.json`)), false);
  const manifest = JSON.parse(readFileSync(join(context.root, '.harness', 'runtime', 'worktrees', 'manifest.json'), 'utf8'));
  assert.equal(manifest.worktrees.find(({ runId }) => runId === context.runId).status, 'escalated');
  assert.equal(existsSync(dirtyPath), true);
  assert.match(git(context.worktreePath, 'status', '--short').stdout, /unfinished\.js/);
});

test('L2 recover retires a stale prepared run, releases its lock, and preserves recovery evidence and patch', (t) => {
  const context = l2EvidenceFixture(t, { runId: 'recover-stale' });
  const dirtyPath = join(context.worktreePath, 'apps', 'backend', 'recover-me.js');
  writeFileSync(dirtyPath, 'export const recoverMe = true;\n');
  const runPathValue = join(context.root, '.harness', 'runtime', 'runs', `${context.runId}.json`);
  const runRecord = JSON.parse(readFileSync(runPathValue, 'utf8'));
  runRecord.startedAt = '2020-01-01T00:00:00.000Z';
  writeFileSync(runPathValue, `${JSON.stringify(runRecord, null, 2)}\n`);

  const recovered = cli(context.root, 'loop', 'run', 'recover', '--stale-after', '0', '--json');
  assert.equal(recovered.status, 0, output(recovered));
  const result = json(recovered);
  assert.equal(result.recovered.some(({ runId }) => runId === context.runId), true);
  const recoveredItem = result.recovered.find(({ runId }) => runId === context.runId);
  assert.ok(recoveredItem.evidence);
  assert.match(JSON.stringify(recoveredItem), /command|recover|worktree/i);
  const state = readEmbeddedState(context.root);
  assert.equal(state.patterns['ci-sweeper'].currentRun, null);
  assert.equal(Object.values(state.slots).includes(context.runId), false);
  assert.equal(existsSync(join(context.root, '.harness', 'runtime', 'worktrees', 'locks', `${context.runId}.json`)), false);
  const manifest = JSON.parse(readFileSync(join(context.root, '.harness', 'runtime', 'worktrees', 'manifest.json'), 'utf8'));
  assert.match(manifest.worktrees.find(({ runId }) => runId === context.runId).status, /stale|escalated/);
  assert.equal(existsSync(dirtyPath), true);
});

test('worktree cleanup reports but preserves dirty terminal worktrees', (t) => {
  const context = l2EvidenceFixture(t, { runId: 'cleanup-dirty' });
  const dirtyPath = join(context.worktreePath, 'apps', 'backend', 'untracked-patch.js');
  writeFileSync(dirtyPath, 'export const patch = true;\n');
  assert.equal(cli(context.root, 'loop', 'worktree', 'mark', '--run-id', context.runId, '--status', 'escalated', '--json').status, 0);
  const cleanup = cli(context.root, 'loop', 'worktree', 'cleanup', '--run-id', context.runId, '--json');
  assert.ok([0, 1].includes(cleanup.status), output(cleanup));
  assert.deepEqual(json(cleanup).removed, []);
  assert.equal(json(cleanup).skipped.some(({ runId, reason }) => runId === context.runId && /dirty|untracked|patch/i.test(reason)), true);
  assert.equal(existsSync(context.worktreePath), true);
  assert.equal(existsSync(dirtyPath), true);
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

test('attempt enforces budget.maxAttempts even when escalation.maxIterations is higher', (t) => {
  const config = loopConfig();
  const sweeper = config.patterns.find(({ id }) => id === 'ci-sweeper');
  sweeper.enabled = true;
  sweeper.budget.maxAttempts = 1;
  sweeper.escalation = { sameErrorCount: 5, noProgressCount: 5, maxIterations: 5 };
  const root = loopFixture(t, config);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'attempt-budget', '--slot', 'attempt-budget', '--json').status, 0);
  assert.equal(cli(root, 'loop', 'run', 'attempt', 'attempt-budget', '--action', 'first try', '--outcome', 'failure', '--error', 'first failure', '--json').status, 0);

  const blocked = cli(root, 'loop', 'run', 'attempt', 'attempt-budget', '--action', 'second try', '--outcome', 'failure', '--error', 'second failure', '--json');
  assert.equal(blocked.status, 2, output(blocked));
  assert.match(json(blocked).breaker.trigger, /max-attempts|attempt-budget/i);
  const ledger = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'ledgers', 'attempt-budget.json'), 'utf8'));
  assert.equal(ledger.attempts.length, 1, 'blocked attempt must not be appended');
});

test('concurrent attempts with maxAttempts one admit exactly one and preserve its ledger entry', async (t) => {
  const config = loopConfig();
  const sweeper = config.patterns.find(({ id }) => id === 'ci-sweeper');
  sweeper.enabled = true;
  sweeper.budget.maxAttempts = 1;
  sweeper.escalation = { sameErrorCount: 5, noProgressCount: 5, maxIterations: 5 };
  const root = loopFixture(t, config);
  assert.equal(cli(root, 'loop', 'run', 'prepare', 'ci-sweeper', '--run-id', 'attempt-race', '--slot', 'attempt-race', '--json').status, 0);

  const startAt = Date.now() + 1000;
  const contenders = Array.from({ length: 8 }, (_, index) => loopAtAsync(
    root,
    startAt,
    'run', 'attempt', 'attempt-race', '--action', `parallel-attempt-${index}`, '--outcome', 'failure', '--error', `failure-${index}`, '--json',
  ));
  const results = await Promise.all(contenders);
  assert.equal(results.filter(({ status }) => status === 0).length, 1, results.map(output).join('\n'));
  assert.equal(results.filter(({ status }) => status === 2).length, 7, results.map(output).join('\n'));
  const ledger = JSON.parse(readFileSync(join(root, '.harness', 'runtime', 'ledgers', 'attempt-race.json'), 'utf8'));
  assert.equal(ledger.attempts.length, 1);
  assert.match(ledger.attempts[0].action, /^parallel-attempt-\d$/);
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

test('concurrent prepares for one slot create at most one new run', async (t) => {
  const root = loopFixture(t);
  const oldEntries = Array.from({ length: 3000 }, (_, index) => JSON.stringify({
    schemaVersion: 1,
    runId: `old-run-${index}`,
    loopId: 'daily-triage',
    slotKey: `old-slot-${index}`,
    level: 'L1',
    startedAt: '2020-01-01T00:00:00.000Z',
    finishedAt: '2020-01-01T00:00:01.000Z',
    outcome: 'no-op',
  }));
  writeFileSync(join(root, 'loop-run-log.md'), `# Loop Run Log\n\n<!-- Loop appends below this line -->\n${oldEntries.join('\n')}\n`);

  const contenders = Array.from({ length: 8 }, (_, index) => cliAsync(root, 'loop', 'run', 'prepare', 'harness-health', '--run-id', `concurrent-run-${index}`, '--slot', 'shared-slot', '--json'));
  const results = await Promise.all(contenders);
  const created = readdirSync(join(root, '.harness', 'runtime', 'runs')).filter((name) => /^concurrent-run-\d+\.json$/.test(name));
  assert.equal(created.length, 1, `created=${created.join(', ')}\n${results.map(output).join('\n')}`);
});

test('an old mutex held by a live owner is not stolen as stale', async (t) => {
  const root = loopFixture(t);
  const mutex = join(root, '.harness', 'runtime', 'mutexes', 'run-prepare.lock');
  mkdirSync(mutex, { recursive: true });
  const owner = { owner: 'live-test-owner', pid: process.pid, acquiredAt: '2020-01-01T00:00:00.000Z' };
  writeFileSync(join(mutex, 'owner.json'), `${JSON.stringify(owner)}\n`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(mutex, old, old);

  const contender = await cliWithDeadline(root, 1500, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'must-not-steal', '--slot', 'must-not-steal', '--json');
  assert.notEqual(contender.status, 0, output(contender));
  assert.equal(existsSync(join(root, '.harness', 'runtime', 'runs', 'must-not-steal.json')), false);
  assert.equal(existsSync(join(mutex, 'owner.json')), true);
  assert.deepEqual(JSON.parse(readFileSync(join(mutex, 'owner.json'), 'utf8')), owner);
});

test('concurrent stale mutex reclaimers do not delete a newly acquired generation', async (t) => {
  const root = loopFixture(t);
  instrumentMutexReclaimRace(root);
  const mutex = join(root, '.harness', 'runtime', 'mutexes', 'run-prepare.lock');
  mkdirSync(mutex, { recursive: true });
  writeFileSync(join(mutex, 'owner.json'), `${JSON.stringify({
    owner: 'dead-old-generation',
    pid: 2_147_483_647,
    acquiredAt: '2020-01-01T00:00:00.000Z',
  })}\n`);
  const old = new Date(Date.now() - 120_000);
  utimesSync(mutex, old, old);

  const startAt = Date.now() + 1000;
  const contenders = ['first', 'second'].map((role, index) => loopAtWithEnvAsync(
    root, startAt, { HARNESS_TEST_RECLAIMER_ROLE: role },
    'run', 'prepare', 'harness-health', '--run-id', `reclaim-run-${index}`, '--slot', 'reclaim-shared-slot', '--json',
  ));
  const results = await Promise.all(contenders);
  const barrier = join(root, '.harness', 'runtime', 'mutexes', 'test-reclaimer-barrier');
  const created = readdirSync(join(root, '.harness', 'runtime', 'runs')).filter((name) => /^reclaim-run-\d+\.json$/.test(name));
  const prepared = results.filter((result) => result.status === 0 && json(result).status === 'prepared');
  assert.equal(existsSync(join(barrier, 'overlap')), false, `two mutex generations entered the critical section\n${results.map(output).join('\n')}`);
  assert.equal(created.length, 1, `created generations=${created.join(', ')}\n${results.map(output).join('\n')}`);
  assert.equal(prepared.length, 1, `critical section admitted ${prepared.length} owners`);
});

test('concurrent overlapping lock requests allow at most one owner', async (t) => {
  const root = loopFixture(t);
  const locks = join(root, '.harness', 'runtime', 'worktrees', 'locks');
  mkdirSync(locks, { recursive: true });
  for (let index = 0; index < 2000; index += 1) {
    writeFileSync(join(locks, `expired-${index}.json`), `${JSON.stringify({
      schemaVersion: 1,
      owner: `expired-${index}`,
      paths: ['docs/**'],
      lockedAt: '2020-01-01T00:00:00.000Z',
      expiresAt: '2020-01-01T00:00:01.000Z',
    })}\n`);
  }

  const contenders = Array.from({ length: 8 }, (_, index) => cliAsync(root, 'loop', 'worktree', 'lock', '--owner', `lock-owner-${index}`, '--paths', 'apps/backend/**', '--json'));
  const results = await Promise.all(contenders);
  const acquired = results.filter(({ status }) => status === 0);
  assert.equal(acquired.length, 1, `successful owners=${acquired.map((result) => json(result).lock.owner).join(', ')}`);
  const liveLocks = json(cli(root, 'loop', 'worktree', 'locks', '--json')).locks.filter(({ owner }) => owner.startsWith('lock-owner-'));
  assert.equal(liveLocks.length, 1);
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

test('install --merge into a new target strips template bootstrap maturity evidence', (t) => {
  const root = fullFixture(t);
  const target = join(root, 'truth-safe-install-target');
  const installed = cli(root, 'install', '--merge', target);
  assert.equal(installed.status, 0, output(installed));

  const state = readEmbeddedState(target);
  assert.deepEqual(state.slots, {});
  for (const patternState of Object.values(state.patterns)) {
    assert.equal(patternState.lastRun, null);
    assert.equal(patternState.lastOutcome, null);
    assert.equal(patternState.currentRun, null);
  }
  const inheritedRuns = readFileSync(join(target, 'loop-run-log.md'), 'utf8').split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  assert.deepEqual(inheritedRuns, []);
});

test('init --project remains observed L0 until the target completes its own proven L1 run', (t) => {
  const root = fullFixture(t);
  const target = join(root, 'truth-safe-init-target');
  assert.equal(cli(root, 'install', '--merge', target).status, 0);
  assert.equal(git(target, 'init').status, 0);
  const init = cli(target, 'init', '--project');
  assert.equal(init.status, 0, output(init));

  let doctor = cli(target, 'loop', 'doctor', '--json');
  assert.equal(doctor.status, 0, output(doctor));
  assert.equal(json(doctor).readiness.observedMaturity.level, 'L0');
  assert.equal(json(doctor).readiness.observedMaturity.validL1Runs, 0);

  assert.equal(cli(target, 'loop', 'run', 'prepare', 'harness-health', '--run-id', 'target-first-run', '--slot', 'target-first-run', '--json').status, 0);
  const result = {
    outcome: 'report-only',
    tokens: 1,
    findings: 0,
    actions: 0,
    evidenceComplete: true,
    unauthorizedWrites: 0,
    falsePositives: 0,
    checks: [{ id: 'target-check', status: 'pass', evidence: 'target command passed' }],
    evidence: [{ id: 'target-evidence', type: 'command', subject: 'target repository' }],
  };
  const finish = cli(target, 'loop', 'run', 'finish', 'target-first-run', '--result', JSON.stringify(result), '--json');
  assert.equal(finish.status, 0, output(finish));
  doctor = cli(target, 'loop', 'doctor', '--json');
  assert.equal(json(doctor).readiness.observedMaturity.level, 'L1');
  assert.equal(json(doctor).readiness.observedMaturity.validL1Runs, 1);
});

test('install rejects a junction-backed Loop evidence path before copying the harness body', (t) => {
  const root = fullFixture(t);
  const target = join(root, 'junction-install-target');
  const outside = join(root, 'outside-install-evidence');
  const link = join(target, 'escaped');
  mkdirSync(target, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`directory link unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const config = loopConfig();
  for (const item of config.patterns) {
    item.state.summaryFile = 'escaped/STATE.md';
    item.state.runLogFile = 'escaped/loop-run-log.md';
  }
  writeFileSync(join(target, 'loop.config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const installed = cli(root, 'install', '--merge', target);
  assert.notEqual(installed.status, 0, output(installed));
  assert.equal(existsSync(join(outside, 'STATE.md')), false, 'install must not write through a junction');
  assert.equal(existsSync(join(outside, 'loop-run-log.md')), false, 'install must not write through a junction');
  assert.equal(existsSync(join(target, 'scripts', 'harness', 'cli.mjs')), false, 'unsafe install must fail before copying the harness body');
});

test('install preflight rejects a dangling junction used as an evidence leaf', (t) => {
  const root = fullFixture(t);
  const target = join(root, 'dangling-junction-install-target');
  const outsideMissing = join(root, 'outside-missing-evidence-leaf');
  const danglingLeaf = join(target, 'dangling-state');
  mkdirSync(target, { recursive: true });
  try {
    symlinkSync(outsideMissing, danglingLeaf, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`dangling directory link unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.equal(existsSync(danglingLeaf), false, 'fixture must be a dangling link');
  const config = loopConfig();
  config.patterns[0].state.summaryFile = 'dangling-state';
  writeFileSync(join(target, 'loop.config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const installed = cli(root, 'install', '--merge', target);
  assert.notEqual(installed.status, 0, output(installed));
  assert.equal(existsSync(outsideMissing), false, 'install must not materialize the external dangling target');
  assert.equal(existsSync(join(target, 'scripts', 'harness', 'cli.mjs')), false, 'dangling evidence must be rejected before copying the harness body');
});
