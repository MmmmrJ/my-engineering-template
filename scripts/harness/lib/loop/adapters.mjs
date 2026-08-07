import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const BUILTIN_CHECKS = {
  'doctor-template-strict': ['scripts/harness/cli.mjs', 'doctor', '--template', '--strict'],
  'sync-agents': ['scripts/harness/cli.mjs', 'sync-agents', '--check'],
  'guard-secrets': ['scripts/harness/cli.mjs', 'guard-secrets', '--tracked'],
  'loop-doctor-strict': ['scripts/harness/cli.mjs', 'loop', 'doctor', '--strict'],
  'loop-validate': ['scripts/harness/cli.mjs', 'loop', 'validate', '--strict'],
  'project-fast': ['scripts/harness/cli.mjs', 'verify', '--profile', 'fast'],
  'project-full': ['scripts/harness/cli.mjs', 'verify', '--profile', 'full'],
  'qa-acceptance': ['scripts/harness/run-tests.mjs'],
};
const RAW_STDOUT = Symbol('rawRedactedStdout');
const MAX_GIT_FINDINGS = 500;

function now() {
  return new Date().toISOString();
}

function normalized(value) {
  return String(value ?? '').replaceAll('\\', '/');
}

function redact(value) {
  return String(value ?? '')
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]');
}

function evidenceSummary(result, exitCode) {
  const detail = redact([result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n')).trim();
  const summary = detail || `command exited with code ${exitCode}`;
  return summary.length <= 2000 ? summary : `${summary.slice(0, 1980)}\n...[truncated]`;
}

function inside(root, candidate) {
  const value = relative(resolve(root), resolve(candidate));
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function configuredChecks(root) {
  const path = resolve(root, 'harness.config.json');
  if (!existsSync(path)) return new Map();
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return new Map();
  }
  const entries = Object.values(config?.checks ?? {}).flatMap((profile) => Array.isArray(profile) ? profile : []);
  return new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
}

export function resolveCheck(root, id, { runId = '' } = {}) {
  const configured = configuredChecks(root).get(id);
  if (configured) {
    const args = [...configured.args];
    if (id === 'loop-doctor-strict' && runId) args.push('--ignore-run', runId);
    return {
      id,
      program: configured.program,
      args,
      cwd: configured.cwd ?? '.',
      timeoutMs: configured.timeoutMs ?? 120000,
      env: id === 'loop-doctor-strict' && runId ? { HARNESS_LOOP_INTERNAL_RUNNER: runId } : undefined,
    };
  }
  if (BUILTIN_CHECKS[id]) {
    const args = [...BUILTIN_CHECKS[id]];
    if (id === 'loop-doctor-strict' && runId) args.push('--ignore-run', runId);
    return {
      id,
      program: process.execPath,
      args,
      cwd: '.',
      timeoutMs: 120000,
      env: id === 'loop-doctor-strict' && runId ? { HARNESS_LOOP_INTERNAL_RUNNER: runId } : undefined,
    };
  }
  return null;
}

export function executeCommand(root, command) {
  const startedAt = now();
  const configuredCwd = command.cwd ?? '.';
  const cwd = isAbsolute(configuredCwd) ? resolve(configuredCwd) : resolve(root, configuredCwd);
  if (
    typeof command.program !== 'string'
    || !command.program
    || !Array.isArray(command.args)
    || !command.args.every((arg) => typeof arg === 'string')
    || !inside(root, cwd)
  ) {
    const finishedAt = now();
    return {
      id: command.id,
      program: typeof command.program === 'string' ? command.program : '',
      args: Array.isArray(command.args) ? command.args : [],
      cwd: normalized(relative(root, cwd) || '.'),
      exitCode: 1,
      startedAt,
      finishedAt,
      status: 'fail',
      evidence: 'invalid or repository-escaping check command',
    };
  }
  const result = spawnSync(command.program, command.args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: command.timeoutMs,
    maxBuffer: 1024 * 1024,
    env: command.env ? { ...process.env, ...command.env } : process.env,
  });
  const exitCode = Number.isInteger(result.status) ? result.status : 1;
  const receipt = {
    id: command.id,
    program: command.program,
    args: command.args,
    cwd: normalized(relative(root, cwd) || '.'),
    exitCode,
    startedAt,
    finishedAt: now(),
    status: !result.error && exitCode === 0 ? 'pass' : 'fail',
    evidence: evidenceSummary(result, exitCode),
  };
  Object.defineProperty(receipt, RAW_STDOUT, {
    value: redact(result.stdout ?? ''),
    enumerable: false,
  });
  return receipt;
}

function commandStdout(receipt) {
  return receipt[RAW_STDOUT] ?? '';
}

export function runDeclaredChecks(root, pattern, context = {}) {
  return pattern.checks.map((id) => {
    const command = resolveCheck(root, id, context);
    if (command) return executeCommand(root, command);
    const timestamp = now();
    return {
      id,
      program: '',
      args: [],
      cwd: '.',
      exitCode: 1,
      startedAt: timestamp,
      finishedAt: timestamp,
      status: 'fail',
      evidence: `unknown check id: ${id}; execution failed closed`,
    };
  });
}

export function stableFindingId(source, subject) {
  const digest = createHash('sha256').update(`${source}\0${subject}`).digest('hex').slice(0, 20);
  return `finding-${digest}`;
}

function finding(pattern, bucket, source, subject, message) {
  return {
    id: stableFindingId(source, subject),
    patternId: pattern.id,
    loopId: pattern.id,
    bucket,
    sourceAdapter: source,
    source,
    subject,
    message,
    status: bucket === 'inbox' ? 'open' : undefined,
    humanOverride: null,
  };
}

function resultFor(pattern, checks, findings, extraEvidence = [], managedAdapters = []) {
  const failures = checks.filter(({ status }) => status === 'fail');
  const escalated = failures.length > 0;
  return {
    outcome: escalated ? 'escalated' : findings.length ? 'report-only' : 'no-op',
    tokens: 0,
    findings: findings.length,
    actions: 0,
    escalations: escalated ? Math.max(1, failures.length) : 0,
    escalationEvidence: failures.map((receipt) => ({
      trigger: 'check-failure',
      reason: `${receipt.id} exited with code ${receipt.exitCode}`,
    })),
    evidenceComplete: checks.every((receipt) => Boolean(receipt.evidence?.trim())),
    unauthorizedWrites: 0,
    falsePositives: 0,
    killSwitchDrill: false,
    checks,
    evidence: [
      ...checks.map((receipt) => ({ id: `check-${receipt.id}`, type: 'command', subject: receipt.id })),
      ...extraEvidence,
    ],
    humanDispositions: [],
    triageFindings: findings,
    managedAdapters,
  };
}

export function runHarnessHealth(root, pattern, context = {}) {
  const checks = runDeclaredChecks(root, pattern, context);
  const findings = checks
    .filter(({ status }) => status === 'fail')
    .map((receipt) => finding(
      pattern,
      'inbox',
      'harness-check',
      receipt.id,
      `${receipt.id} failed with exit code ${receipt.exitCode}`,
    ));
  return resultFor(pattern, checks, findings, [], ['harness-check']);
}

export function collectDailyInputs(root) {
  const git = executeCommand(root, {
    id: 'git-status-porcelain-v1',
    program: 'git',
    args: ['status', '--porcelain=v1'],
    cwd: '.',
    timeoutMs: 30000,
  });
  return {
    git,
    ci: {
      status: String(process.env.HARNESS_LOOP_CI_STATUS ?? '').trim().toLowerCase(),
      check: String(process.env.HARNESS_LOOP_CI_CHECK ?? 'ci').trim() || 'ci',
    },
  };
}

function gitFindings(pattern, receipt) {
  if (receipt.status === 'fail') {
    return [finding(pattern, 'highPriority', 'git-status', 'command', 'Unable to collect local git worktree status')];
  }
  const ignored = new Set([pattern.state.summaryFile, pattern.state.runLogFile].map(normalized));
  const lines = commandStdout(receipt)
    .split(/\r?\n/)
    .filter((line) => /^.. /.test(line))
    .filter((line) => {
      const subject = normalized(line.slice(3).trim().replace(/^.* -> /, ''));
      return !ignored.has(subject) && !subject.startsWith('.harness/runtime/');
    });
  const selected = lines.length <= MAX_GIT_FINDINGS
    ? lines
    : [...lines.slice(0, MAX_GIT_FINDINGS / 2), ...lines.slice(-(MAX_GIT_FINDINGS / 2))];
  const findings = selected.map((line) => {
      const code = line.slice(0, 2);
      const subject = normalized(line.slice(3).trim().replace(/^.* -> /, ''));
      const bucket = /(?:UU|AA|DD|AU|UA|DU|UD)/.test(code) ? 'highPriority' : code === '??' ? 'noise' : 'watch';
      return finding(pattern, bucket, 'git-worktree', subject, `${code.trim() || 'changed'} ${subject}`);
    });
  if (lines.length > pattern.scope.maxChangedFiles) {
    findings.push(finding(
      pattern,
      'highPriority',
      'git-worktree',
      `overflow-${lines.length}`,
      `Git worktree has ${lines.length} changed paths, exceeding maxChangedFiles ${pattern.scope.maxChangedFiles}${lines.length > MAX_GIT_FINDINGS ? `; retained first and last ${MAX_GIT_FINDINGS / 2}` : ''}`,
    ));
  }
  return findings;
}

function ciFindings(pattern, ci) {
  if (!ci.status || ['passed', 'pass', 'success', 'clean'].includes(ci.status)) return [];
  if (['failed', 'failure', 'error', 'timed_out'].includes(ci.status)) {
    return [finding(pattern, 'highPriority', 'ci', ci.check, `CI check ${ci.check} is ${ci.status}`)];
  }
  if (['pending', 'queued', 'in_progress', 'cancelled'].includes(ci.status)) {
    return [finding(pattern, 'watch', 'ci', ci.check, `CI check ${ci.check} is ${ci.status}`)];
  }
  if (['skipped', 'neutral'].includes(ci.status)) {
    return [finding(pattern, 'noise', 'ci', ci.check, `CI check ${ci.check} is ${ci.status}`)];
  }
  return [finding(pattern, 'inbox', 'ci', ci.check, `Unclassified CI status for ${ci.check}: ${ci.status}`)];
}

export function runDailyTriage(root, pattern, context = {}) {
  const checks = runDeclaredChecks(root, pattern, context);
  const inputs = collectDailyInputs(root);
  const checkFindings = checks
    .filter(({ status }) => status === 'fail')
    .map((receipt) => finding(
      pattern,
      'highPriority',
      'triage-check',
      receipt.id,
      `${receipt.id} failed with exit code ${receipt.exitCode}`,
    ));
  const findings = [...checkFindings, ...gitFindings(pattern, inputs.git), ...ciFindings(pattern, inputs.ci)];
  const result = resultFor(pattern, checks, findings, [
    { id: 'git-status', type: 'command', subject: 'local worktree' },
    ...(inputs.ci.status ? [{ id: 'ci-environment', type: 'environment', subject: inputs.ci.check }] : []),
  ], ['triage-check', 'git-status', 'git-worktree', 'ci']);
  if (inputs.git.status === 'fail') {
    result.outcome = 'escalated';
    result.escalations += 1;
    result.escalationEvidence.push({ trigger: 'input-collection-failure', reason: inputs.git.evidence });
  }
  result.evidenceComplete = result.evidenceComplete && Boolean(inputs.git.evidence?.trim());
  result.inputReceipts = [inputs.git];
  return result;
}

