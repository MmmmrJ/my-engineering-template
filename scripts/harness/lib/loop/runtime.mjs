import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync as atomicRenameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveCheck, runDeclaredChecks } from './adapters.mjs';
import { executePatternRunner } from './runner.mjs';

const LEVELS = new Set(['L1', 'L2']);
const MODES = new Set(['report-only', 'assisted']);
const ACTIONS = new Set(['report', 'proposal', 'write', 'push', 'merge']);
const GATE_ACTIONS = new Set([...ACTIONS, 'maker', 'scope']);
const OUTCOMES = new Set(['no-op', 'report-only', 'proposal', 'success', 'failed', 'escalated']);
const TRIGGERS = new Set(['manual', 'schedule', 'event']);
const WORKTREE_STATUSES = new Set(['active', 'proposed', 'rejected', 'escalated', 'merged', 'stale']);
const STATE_START = '<!-- loop-state-json:start -->';
const STATE_END = '<!-- loop-state-json:end -->';
const CONFIG_HASH_PREFIX = '<!-- loop-config-sha256:';
const PROJECTION_START = '<!-- loop-config-projection:start -->';
const PROJECTION_END = '<!-- loop-config-projection:end -->';
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const PATTERN_INPUT_ADAPTERS = {
  'harness-health': ['harness-checks'],
  'daily-triage': ['git-status', 'ci-signal'],
  'ci-sweeper': ['ci-failure', 'git-diff'],
};

function fail(message, code = 1) {
  console.error(`loop: ${message}`);
  process.exit(code);
}

function now() {
  return new Date().toISOString();
}

function normalized(value) {
  return value.replaceAll('\\', '/');
}

function parseJson(path, label = path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { fail(`invalid JSON in ${label}: ${error.message}`); }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  atomicRenameSync(temporary, path);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function redact(value) {
  return String(value ?? '')
    .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
  return value;
}

function configDigest(config) {
  return hash(JSON.stringify(config));
}

function registryEntry(pattern, previous = {}) {
  const template = previous.template ?? (PATTERN_INPUT_ADAPTERS[pattern.id] ? pattern.id : null);
  const inputAdapters = PATTERN_INPUT_ADAPTERS[template] ?? ['manual-input'];
  const skills = [
    pattern.roles.triageSkill,
    ...(pattern.level === 'L2' ? ['minimal-fix', 'loop-verifier'] : []),
  ];
  return {
    id: pattern.id,
    template,
    level: pattern.level,
    mode: pattern.mode,
    file: PATTERN_INPUT_ADAPTERS[pattern.id] ? `${pattern.id}.md` : null,
    owner: {
      role: pattern.roles.makerRole ?? 'parent',
      verifierRole: pattern.roles.verifierRole,
    },
    cadence: {
      trigger: pattern.trigger.type,
      fireImmediately: pattern.trigger.fireImmediately,
      offHours: pattern.trigger.offHours,
    },
    inputAdapters,
    skills: [...new Set(skills)],
    checks: pattern.checks,
    cost: {
      maxRunsPerDay: pattern.budget.maxRunsPerDay,
      maxTokensPerRun: pattern.budget.maxTokensPerRun,
      maxTokensPerDay: pattern.budget.maxTokensPerDay,
      maxActionsPerDay: pattern.budget.maxActionsPerDay,
    },
    humanGates: {
      taskApproval: pattern.level === 'L2' && pattern.gates.write === 'approved-task',
      independentVerifier: pattern.roles.independentVerifier,
      push: pattern.gates.push,
      merge: pattern.gates.merge,
    },
  };
}

function expectedRegistry(config, current = {}) {
  const currentPatterns = Array.isArray(current.patterns) ? current.patterns : [];
  return {
    schemaVersion: 2,
    patterns: config.patterns.map((pattern) => registryEntry(
      pattern,
      currentPatterns.find((entry) => entry?.id === pattern.id),
    )),
    configHash: configDigest(config),
  };
}

function registryErrors(config, registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return ['patterns/registry.json must be an object'];
  const expected = expectedRegistry(config, registry);
  const errors = [];
  if (registry.schemaVersion !== 2) errors.push('patterns/registry.json schemaVersion must be 2');
  const actualPatterns = Array.isArray(registry.patterns) ? registry.patterns : [];
  const actualIds = actualPatterns.map((entry) => entry?.id);
  const expectedIds = expected.patterns.map((entry) => entry.id);
  if (JSON.stringify([...actualIds].sort()) !== JSON.stringify([...expectedIds].sort())) errors.push('patterns/registry.json pattern set drift');
  for (const expectedEntry of expected.patterns) {
    const actual = actualPatterns.find((entry) => entry?.id === expectedEntry.id);
    if (!actual) continue;
    if (JSON.stringify(actual) !== JSON.stringify(expectedEntry)) errors.push(`patterns/registry.json metadata drift: ${expectedEntry.id}`);
  }
  if (registry.configHash !== expected.configHash) errors.push('patterns/registry.json config hash drift');
  return errors;
}

function unknownKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value ?? {})) if (!allowed.has(key)) errors.push(`${label} has unknown field ${key}`);
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const path = normalized(value.trim());
  return !path.startsWith('/') && !/^[a-z]:\//i.test(path) && !path.split('/').includes('..') && !path.includes('\0');
}

function futureRealPath(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`cannot resolve evidence path boundary: ${path}.`);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync.native(cursor), ...missing);
}

function withinPath(root, candidate) {
  const value = relative(root, candidate);
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function validateEvidenceComponents(root, target) {
  const lexicalRoot = resolve(root);
  const physicalRoot = futureRealPath(lexicalRoot);
  const parts = relative(lexicalRoot, target).split(sep).filter(Boolean);
  let cursor = lexicalRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stats;
    try { stats = lstatSync(cursor); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isSymbolicLink()) continue;
    let resolvedLink;
    try { resolvedLink = realpathSync.native(cursor); }
    catch { fail(`Loop evidence path contains a dangling symlink or junction: ${normalized(relative(lexicalRoot, cursor))}.`); }
    if (!withinPath(physicalRoot, resolvedLink)) {
      fail(`Loop evidence path crosses a symlink or junction outside repository: ${normalized(relative(lexicalRoot, cursor))}.`);
    }
  }
}

export function safeEvidencePath(root, value) {
  if (!safeRelative(value)) fail(`unsafe Loop evidence path: ${JSON.stringify(value)}.`);
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(root, value);
  if (!withinPath(lexicalRoot, lexicalTarget)) fail(`Loop evidence path escapes repository: ${value}.`);
  validateEvidenceComponents(lexicalRoot, lexicalTarget);
  const physicalRoot = futureRealPath(lexicalRoot);
  const physicalTarget = futureRealPath(lexicalTarget);
  if (!withinPath(physicalRoot, physicalTarget)) fail(`Loop evidence path crosses a symlink or junction outside repository: ${value}.`);
  return lexicalTarget;
}

function option(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value.`);
  return value;
}

function integerOption(args, name, fallback = 0) {
  const raw = option(args, name, String(fallback));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} must be a non-negative integer.`);
  return value;
}

function positionals(args, valueOptions = []) {
  const values = new Set(valueOptions);
  return args.filter((arg, index) => !arg.startsWith('--') && !values.has(args[index - 1]));
}

function output(value, json, human) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(human ?? `${value.command}: ${value.ok ? 'PASS' : 'BLOCKED'}`);
}

function run(program, args, cwd, stdio = 'pipe') {
  const result = spawnSync(program, args, { cwd, shell: false, encoding: 'utf8', stdio });
  return {
    ok: !result.error && result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
  };
}

function configPath(root) { return join(root, 'loop.config.json'); }
function configuredPaths(root, config, field, fallback) {
  const values = [...new Set((config?.patterns ?? []).map((pattern) => pattern.state?.[field]).filter(Boolean))];
  return (values.length ? values : [fallback]).map((value) => safeEvidencePath(root, value));
}
function statePaths(root, config) { return configuredPaths(root, config, 'summaryFile', 'STATE.md'); }
function statePath(root, config) { return statePaths(root, config)[0]; }
function runLogPaths(root, config) { return configuredPaths(root, config, 'runLogFile', 'loop-run-log.md'); }
function runLogPath(root, config, pattern = null) { return safeEvidencePath(root, pattern?.state?.runLogFile ?? config?.patterns?.[0]?.state?.runLogFile ?? 'loop-run-log.md'); }
function runtimeRoot(root) { return join(root, '.harness', 'runtime'); }
function runDirectory(root) { return join(runtimeRoot(root), 'runs'); }
function ledgerDirectory(root) { return join(runtimeRoot(root), 'ledgers'); }
function internalStatePath(root) { return join(runtimeRoot(root), 'state.json'); }
function worktreeRoot(root) { return join(runtimeRoot(root), 'worktrees'); }
function lockDirectory(root) { return join(worktreeRoot(root), 'locks'); }
function worktreeManifestPath(root) { return join(worktreeRoot(root), 'manifest.json'); }
function gateDirectory(root) { return join(runtimeRoot(root), 'gates'); }
function verificationDirectory(root) { return join(runtimeRoot(root), 'verifications'); }
function gateReceiptPath(root, runId, action) { return join(gateDirectory(root), `${runId}-${action}.json`); }
function verificationPath(root, runId) { return join(verificationDirectory(root), `${runId}.json`); }
function mutexRoot(root) { return join(runtimeRoot(root), 'mutexes'); }

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withMutex(root, name, callback, { timeoutMs = 30000, staleMs = 60000 } = {}) {
  const directory = mutexRoot(root);
  const path = join(directory, `${name}.lock`);
  const owner = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  let expectedRecoveryOwner = null;
  let recoveryClaim = null;
  const renameSync = (source, destination) => {
    const ownerPath = join(source, 'owner.json');
    const currentOwner = existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, 'utf8')) : null;
    if (!expectedRecoveryOwner || currentOwner?.owner !== expectedRecoveryOwner) {
      const error = new Error('stale mutex generation changed before recovery claim');
      error.code = 'EEXIST';
      throw error;
    }
    const claimPath = join(source, 'recovery-claim.json');
    const claim = { owner: expectedRecoveryOwner, claimant: `${process.pid}-${randomUUID()}`, pid: process.pid, claimedAt: now() };
    let descriptor;
    try {
      descriptor = openSync(claimPath, 'wx');
      writeFileSync(descriptor, `${JSON.stringify(claim)}\n`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const confirmedOwner = existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, 'utf8')) : null;
    const confirmedClaim = existsSync(claimPath) ? JSON.parse(readFileSync(claimPath, 'utf8')) : null;
    if (confirmedOwner?.owner !== expectedRecoveryOwner || confirmedClaim?.claimant !== claim.claimant) {
      const error = new Error('stale mutex generation changed after recovery claim');
      error.code = 'EEXIST';
      throw error;
    }
    atomicRenameSync(source, destination);
    recoveryClaim = claim;
  };
  mkdirSync(directory, { recursive: true });
  while (true) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), `${JSON.stringify({ owner, pid: process.pid, acquiredAt: now() })}\n`);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          const metadataPath = join(path, 'owner.json');
          const observed = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
          let ownerAlive = false;
          if (Number.isSafeInteger(observed?.pid) && observed.pid > 0) {
            try {
              process.kill(observed.pid, 0);
              ownerAlive = true;
            } catch (probeError) {
              ownerAlive = probeError.code === 'EPERM';
            }
          }
          if (!ownerAlive) {
            const confirmed = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
            if (confirmed?.owner === observed?.owner && Date.now() - statSync(path).mtimeMs > staleMs) {
              expectedRecoveryOwner = observed.owner;
              recoveryClaim = null;
              const tombstone = `${path}.stale-${randomUUID()}`;
              try { renameSync(path, tombstone); }
              catch (renameError) {
                if (['ENOENT', 'EEXIST', 'EPERM', 'EACCES'].includes(renameError.code)) continue;
                throw renameError;
              }
              const tombstoneMetadataPath = join(tombstone, 'owner.json');
              const tombstoneClaimPath = join(tombstone, 'recovery-claim.json');
              const retired = existsSync(tombstoneMetadataPath) ? JSON.parse(readFileSync(tombstoneMetadataPath, 'utf8')) : null;
              const retiredClaim = existsSync(tombstoneClaimPath) ? JSON.parse(readFileSync(tombstoneClaimPath, 'utf8')) : null;
              if (retired?.owner !== observed?.owner || retiredClaim?.claimant !== recoveryClaim?.claimant || retiredClaim?.owner !== observed?.owner) {
                fail(`stale ${name} recovery generation verification failed.`, 2);
              }
              rmSync(tombstone, { recursive: true, force: true });
              continue;
            }
          }
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() >= deadline) fail(`timed out waiting for ${name} transaction lock.`, 2);
      sleep(10);
    }
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const metadataPath = join(path, 'owner.json');
      const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, 'utf8')) : null;
      if (metadata?.owner === owner) rmSync(path, { recursive: true, force: true });
    } catch {
      // A stale-lock recovery may already have removed this owner's directory.
    }
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  try { return callback(); }
  finally { release(); }
}

function validateStringArray(value, label, errors, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) errors.push(`${label} must be a string array`);
  else if (nonEmpty && value.length === 0) errors.push(`${label} must not be empty`);
}

export function loopConfigErrors(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['loop.config.json must be an object'];
  unknownKeys(config, new Set(['schemaVersion', 'patterns']), 'loop.config.json', errors);
  if (config.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!Array.isArray(config.patterns) || config.patterns.length === 0) return [...errors, 'patterns must be a non-empty array'];
  const ids = new Set();
  for (const [index, pattern] of config.patterns.entries()) {
    const at = `patterns[${index}]`;
    if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) { errors.push(`${at} must be an object`); continue; }
    unknownKeys(pattern, new Set(['id', 'enabled', 'level', 'mode', 'goal', 'nonGoals', 'trigger', 'scope', 'roles', 'state', 'budget', 'isolation', 'gates', 'checks', 'escalation', 'promotion']), at, errors);
    if (!SAFE_ID.test(pattern.id ?? '')) errors.push(`${at}.id must be a safe lowercase id`);
    else if (ids.has(pattern.id)) errors.push(`${at}.id is duplicated: ${pattern.id}`);
    else ids.add(pattern.id);
    if (typeof pattern.enabled !== 'boolean') errors.push(`${at}.enabled must be boolean`);
    if (!LEVELS.has(pattern.level)) errors.push(`${at}.level must be L1 or L2`);
    if (!MODES.has(pattern.mode)) errors.push(`${at}.mode must be report-only or assisted`);
    if (pattern.level === 'L1' && pattern.mode !== 'report-only') errors.push(`${at} L1 must be report-only`);
    if (typeof pattern.goal !== 'string' || !pattern.goal.trim()) errors.push(`${at}.goal is required`);
    validateStringArray(pattern.nonGoals, `${at}.nonGoals`, errors, { nonEmpty: true });
    if (!pattern.trigger || !TRIGGERS.has(pattern.trigger.type)) errors.push(`${at}.trigger.type must be manual, schedule, or event`);
    else unknownKeys(pattern.trigger, new Set(['type', 'fireImmediately', 'offHours', 'cron', 'timezone', 'event']), `${at}.trigger`, errors);
    if (!pattern.scope || typeof pattern.scope !== 'object') errors.push(`${at}.scope is required`);
    else {
      unknownKeys(pattern.scope, new Set(['watchPaths', 'denyPaths', 'maxChangedFiles', 'branches']), `${at}.scope`, errors);
      validateStringArray(pattern.scope.watchPaths, `${at}.scope.watchPaths`, errors, { nonEmpty: true });
      validateStringArray(pattern.scope.denyPaths, `${at}.scope.denyPaths`, errors, { nonEmpty: true });
      for (const path of [...(pattern.scope.watchPaths ?? []), ...(pattern.scope.denyPaths ?? [])]) if (!safeRelative(path)) errors.push(`${at}.scope contains unsafe path ${JSON.stringify(path)}`);
      if (!Number.isSafeInteger(pattern.scope.maxChangedFiles) || pattern.scope.maxChangedFiles < 1) errors.push(`${at}.scope.maxChangedFiles must be a positive integer`);
    }
    if (!pattern.roles || typeof pattern.roles.triageSkill !== 'string' || typeof pattern.roles.verifierRole !== 'string') errors.push(`${at}.roles requires triageSkill and verifierRole`);
    else unknownKeys(pattern.roles, new Set(['triageSkill', 'makerRole', 'verifierRole', 'independentVerifier']), `${at}.roles`, errors);
    if (!pattern.state || typeof pattern.state.summaryFile !== 'string' || typeof pattern.state.runLogFile !== 'string') errors.push(`${at}.state requires summaryFile and runLogFile`);
    else {
      unknownKeys(pattern.state, new Set(['summaryFile', 'runLogFile', 'retentionDays']), `${at}.state`, errors);
      if (!safeRelative(pattern.state.summaryFile) || !safeRelative(pattern.state.runLogFile)) errors.push(`${at}.state paths must be safe relative paths`);
      if (pattern.state.retentionDays !== undefined && (!Number.isSafeInteger(pattern.state.retentionDays) || pattern.state.retentionDays < 0)) errors.push(`${at}.state.retentionDays must be a non-negative integer`);
    }
    const budget = pattern.budget;
    if (budget) unknownKeys(budget, new Set(['maxRunsPerDay', 'maxTokensPerRun', 'maxTokensPerDay', 'maxAttempts', 'maxActionsPerDay', 'on80Percent', 'onExceed']), `${at}.budget`, errors);
    for (const field of ['maxRunsPerDay', 'maxTokensPerRun', 'maxTokensPerDay', 'maxAttempts', 'maxActionsPerDay']) {
      if (!budget || !Number.isSafeInteger(budget[field]) || budget[field] < 0) errors.push(`${at}.budget.${field} must be a non-negative integer`);
    }
    if (!pattern.isolation || !['none', 'worktree'].includes(pattern.isolation.mode)) errors.push(`${at}.isolation.mode must be none or worktree`);
    else {
      unknownKeys(pattern.isolation, new Set(['mode', 'lockPaths', 'lockTtlSeconds']), `${at}.isolation`, errors);
      validateStringArray(pattern.isolation.lockPaths, `${at}.isolation.lockPaths`, errors);
      for (const path of pattern.isolation.lockPaths ?? []) if (!safeRelative(path)) errors.push(`${at}.isolation contains unsafe path ${JSON.stringify(path)}`);
    }
    if (pattern.level === 'L2') {
      if (pattern.mode !== 'assisted') errors.push(`${at} L2 must be assisted`);
      if (pattern.isolation?.mode !== 'worktree') errors.push(`${at} L2 requires worktree isolation`);
      if (!pattern.roles?.independentVerifier) errors.push(`${at} L2 requires independentVerifier`);
      if (!pattern.isolation?.lockPaths?.length) errors.push(`${at} L2 requires lockPaths`);
    }
    if (!pattern.gates || typeof pattern.gates !== 'object') errors.push(`${at}.gates is required`);
    else {
      unknownKeys(pattern.gates, ACTIONS, `${at}.gates`, errors);
      for (const action of ACTIONS) if (!['allow', 'approved-task', 'human', 'never'].includes(pattern.gates[action])) errors.push(`${at}.gates.${action} is invalid`);
      if (pattern.gates.merge !== 'never') errors.push(`${at}.gates.merge must be never in V1`);
    }
    validateStringArray(pattern.checks, `${at}.checks`, errors, { nonEmpty: true });
    const esc = pattern.escalation;
    if (esc) unknownKeys(esc, new Set(['sameErrorCount', 'noProgressCount', 'maxIterations']), `${at}.escalation`, errors);
    for (const field of ['sameErrorCount', 'noProgressCount', 'maxIterations']) if (!esc || !Number.isSafeInteger(esc[field]) || esc[field] < 1) errors.push(`${at}.escalation.${field} must be a positive integer`);
    if (pattern.promotion) unknownKeys(pattern.promotion, new Set(['level', 'by', 'evidence', 'at']), `${at}.promotion`, errors);
  }
  return errors;
}

function readConfig(root) {
  const path = configPath(root);
  if (!existsSync(path)) fail('missing loop.config.json; run `loop init`.');
  const config = parseJson(path, 'loop.config.json');
  const errors = loopConfigErrors(config);
  if (errors.length) fail(`invalid loop.config.json: ${errors.join('; ')}.`);
  return config;
}

function defaultState(config) {
  return {
    schemaVersion: 1,
    configHash: configDigest(config),
    updatedAt: null,
    patterns: Object.fromEntries(config.patterns.map((pattern) => [pattern.id, {
      paused: false,
      pauseReason: null,
      lastRun: null,
      lastOutcome: null,
      currentRun: null,
      level: pattern.level,
    }])),
    slots: {},
    highPriority: [],
    watch: [],
    noise: [],
    inbox: [],
  };
}

function embeddedStateAt(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  const contents = readFileSync(path, 'utf8');
  const start = contents.indexOf(STATE_START);
  const end = contents.indexOf(STATE_END);
  if (start < 0 || end < start) return null;
  const block = contents.slice(start + STATE_START.length, end).replace(/^\s*```json\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(block); } catch { return null; }
}

function embeddedState(root, config) {
  for (const path of statePaths(root, config)) {
    const state = embeddedStateAt(path);
    if (state) return state;
  }
  return null;
}

function readState(root, config) {
  let state = null;
  if (existsSync(internalStatePath(root))) {
    try { state = parseJson(internalStatePath(root)); } catch { state = null; }
  }
  state ??= embeddedState(root, config) ?? defaultState(config);
  state.patterns ??= {};
  state.slots ??= {};
  state.highPriority ??= [];
  state.watch ??= [];
  state.noise ??= [];
  state.inbox ??= [];
  for (const pattern of config.patterns) state.patterns[pattern.id] ??= defaultState({ patterns: [pattern] }).patterns[pattern.id];
  return state;
}

function stateMarkdown(config, state) {
  const rows = config.patterns.map((pattern) => {
    const value = state.patterns[pattern.id] ?? {};
    return `| ${pattern.id} | ${pattern.enabled ? 'enabled' : 'disabled'} | ${value.level ?? pattern.level} | ${pattern.mode} | ${value.paused ? `paused: ${value.pauseReason ?? 'unspecified'}` : 'ready'} | ${value.lastRun ?? '—'} | ${value.lastOutcome ?? '—'} |`;
  }).join('\n');
  const inbox = state.inbox.filter((item) => item.status === 'open');
  const inboxLines = inbox.length ? inbox.map((item) => `- [ ] ${item.id} · ${item.loopId}: ${item.message}`).join('\n') : '- —';
  const itemLines = (items) => items.length ? items.map((item) => `- ${item.id}: ${item.message}`).join('\n') : '- —';
  return `# Loop State\n\nGenerated by \`harness loop\`. Do not hand-edit the embedded machine state.\n\nLast updated: ${state.updatedAt ?? '—'}\n\n## Patterns\n\n| Pattern | Enabled | Level | Mode | Controller | Last run | Outcome |\n|---|---|---|---|---|---|---|\n${rows}\n\n## High Priority\n\n${itemLines(state.highPriority)}\n\n## Watch List\n\n${itemLines(state.watch)}\n\n## Recent Noise\n\n${itemLines(state.noise)}\n\n## Human Inbox\n\n${inboxLines}\n\n${STATE_START}\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n${STATE_END}\n`;
}

export function freshLoopEvidence(config) {
  const state = defaultState(config);
  return {
    state: [...new Set(config.patterns.map((pattern) => pattern.state.summaryFile))].map((path) => ({ path, contents: stateMarkdown(config, state) })),
    runLogs: [...new Set(config.patterns.map((pattern) => pattern.state.runLogFile))].map((path) => ({
      path,
      contents: '# Loop Run Log\n\nOne JSON object per completed run. Entries are append-only and may be pruned after the configured retention period.\n\n## Runs\n\n',
    })),
  };
}

function configHeader(config, name = '') {
  return name === 'gate.yaml' ? `# loop-config-sha256:${configDigest(config)}` : `${CONFIG_HASH_PREFIX}${configDigest(config)} -->`;
}

function projectionBody(name, config) {
  if (name === 'LOOP.md') return `# Loop Runtime\n\nMachine configuration: \`loop.config.json\`.\n\n## Patterns\n\n${config.patterns.map((pattern) => `- \`${pattern.id}\`: ${pattern.level} / ${pattern.mode} / ${pattern.enabled ? 'enabled' : 'disabled'}`).join('\n')}\n`;
  if (name === 'loop-budget.md') return `# Loop Budget\n\n| Pattern | Runs/day | Tokens/run | Tokens/day | Attempts | Actions/day |\n|---|---:|---:|---:|---:|---:|\n${config.patterns.map((pattern) => `| ${pattern.id} | ${pattern.budget.maxRunsPerDay} | ${pattern.budget.maxTokensPerRun} | ${pattern.budget.maxTokensPerDay} | ${pattern.budget.maxAttempts} | ${pattern.budget.maxActionsPerDay} |`).join('\n')}\n\nAt 80% the controller becomes report-only; at 100% it pauses.\n`;
  if (name === 'loop-constraints.md') return `# Loop Constraints\n\n- L1 is report-only.\n- L2 requires an approved task, isolated worktree, valid lock, attempt ledger, and distinct passing verifier.\n- Never auto-push or auto-merge.\n- Stop on budget, denylist, lock, breaker, or verification failure.\n`;
  if (name === 'gate.yaml') {
    const deny = [...new Set(config.patterns.flatMap((pattern) => pattern.scope.denyPaths))];
    return `version: 1\ndenylist:\n${deny.map((path) => `  - ${JSON.stringify(path)}`).join('\n')}\nmaxFiles: ${Math.min(...config.patterns.map((pattern) => pattern.scope.maxChangedFiles))}\nactions:\n  report: allow\n  proposal: allow\n  write: approved-task\n  push: human\n  merge: never\n`;
  }
  return '';
}

function writeProjectionFile(root, name, config) {
  const path = join(root, name);
  let contents = existsSync(path) ? readFileSync(path, 'utf8') : projectionBody(name, config);
  const header = configHeader(config, name);
  if (name === 'gate.yaml') {
    writeFileSync(path, `${header}\n${projectionBody(name, config)}`);
    return;
  }
  if (name === 'gate.yaml' && contents.startsWith('# loop-config-sha256:')) contents = contents.replace(/^# loop-config-sha256:[a-f0-9]{64}\r?\n?/, `${header}\n`);
  else if (contents.startsWith(CONFIG_HASH_PREFIX)) contents = contents.replace(/^<!-- loop-config-sha256:[a-f0-9]{64} -->\r?\n?/, `${header}\n`);
  else contents = `${header}\n${contents}`;
  const projection = `${PROJECTION_START}\n${projectionBody(name, config).trim()}\n${PROJECTION_END}`;
  const start = contents.indexOf(PROJECTION_START);
  const end = contents.indexOf(PROJECTION_END);
  if (start >= 0 && end >= start) contents = `${contents.slice(0, start)}${projection}${contents.slice(end + PROJECTION_END.length)}`;
  else contents = `${contents.trimEnd()}\n\n${projection}\n`;
  writeFileSync(path, contents);
}

function writeConfigProjections(root, config) {
  for (const name of ['LOOP.md', 'loop-budget.md', 'loop-constraints.md', 'gate.yaml']) writeProjectionFile(root, name, config);
  const registryPath = join(root, 'patterns', 'registry.json');
  const existing = existsSync(registryPath) ? parseJson(registryPath) : {};
  writeJson(registryPath, expectedRegistry(config, existing));
}

function writeState(root, config, state) {
  const projections = statePaths(root, config);
  state.configHash = configDigest(config);
  state.updatedAt = now();
  writeJson(internalStatePath(root), state);
  for (const path of projections) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, stateMarkdown(config, state));
  }
}

function patternById(config, id) {
  if (!SAFE_ID.test(id ?? '')) fail('pattern id must be a safe lowercase id.');
  const pattern = config.patterns.find((item) => item.id === id);
  if (!pattern) fail(`unknown pattern: ${id}.`);
  return pattern;
}

function logEntries(root, config) {
  const entries = [];
  for (const path of runLogPaths(root, config)) {
    if (!existsSync(path)) continue;
    for (const [index, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const entry = JSON.parse(line);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.schemaVersion !== 1 || !SAFE_ID.test(entry.runId ?? '') || !SAFE_ID.test(entry.loopId ?? '')) throw new Error('invalid run entry shape');
        entries.push(entry);
      } catch (error) { fail(`corrupt ${normalized(relative(root, path))} JSON at line ${index + 1}: ${error.message}.`); }
    }
  }
  return entries;
}

function todayEntries(root, config, id) {
  const day = now().slice(0, 10);
  return logEntries(root, config).filter((entry) => entry.loopId === id && String(entry.finishedAt ?? entry.startedAt ?? '').startsWith(day));
}

function runPath(root, runId) {
  if (!SAFE_ID.test(runId ?? '')) fail('run id must be a safe lowercase id.');
  return join(runDirectory(root), `${runId}.json`);
}

function ledgerPath(root, runId) {
  if (!SAFE_ID.test(runId ?? '')) fail('run id must be a safe lowercase id.');
  return join(ledgerDirectory(root), `${runId}.json`);
}

function findRun(root, runId) {
  const path = runPath(root, runId);
  if (!existsSync(path)) fail(`run not found: ${runId}.`);
  return { path, run: parseJson(path) };
}

function globToRegex(glob) {
  const value = normalized(glob);
  let output = '^';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];
    if (char === '*' && next === '*') {
      if (value[index + 2] === '/') { output += '(?:.*/)?'; index += 2; }
      else { output += '.*'; index += 1; }
    } else if (char === '*') output += '[^/]*';
    else if (char === '?') output += '[^/]';
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${output}$`);
}

function matching(paths, globs) {
  return paths.filter((path) => globs.some((glob) => globToRegex(glob).test(normalized(path))));
}

function changedPaths(root) {
  const names = new Set();
  for (const args of [['diff', '--name-only'], ['diff', '--cached', '--name-only'], ['ls-files', '--others', '--exclude-standard']]) {
    const result = run('git', args, root);
    if (result.ok) for (const line of result.stdout.split(/\r?\n/)) if (line.trim()) names.add(normalized(line.trim()));
  }
  return [...names];
}

function governanceFor(root, id) {
  if (!id) return null;
  if (!SAFE_ID.test(id)) fail('task id must be a safe lowercase id.');
  const path = join(root, 'docs', 'plans', 'active', id, 'governance.json');
  if (!existsSync(path)) return null;
  const task = parseJson(path);
  if (![1, 2].includes(task.schemaVersion)) return null;
  return task;
}

function approvedTask(task) {
  return Boolean(task && task.approval?.status === 'approved' && task.approvedVersion === task.planVersion && ['approved', 'implementing', 'accepting'].includes(task.phase));
}

function taskOwnsPaths(task, paths) {
  const roles = (task?.roles ?? []).filter((role) => !['skipped', '跳过'].includes(role.status));
  const violations = paths.filter((path) => !roles.some((role) => matching([path], role.allowedPaths ?? []).length > 0 && matching([path], role.forbiddenPaths ?? []).length === 0));
  return violations;
}

function worktreeForRun(root, runId, patternId, { active = true } = {}) {
  const item = worktreeManifest(root).worktrees.find((entry) => (
    entry.runId === runId
    && entry.pattern === patternId
    && (!active || entry.status === 'active')
  ));
  if (!item) return null;
  const path = safeWorktreePath(root, join(root, item.path));
  return existsSync(path) ? { item, path } : null;
}

function worktreeSnapshot(root, worktree) {
  const changedFiles = changedPaths(worktree.path).sort();
  const head = run('git', ['rev-parse', 'HEAD'], worktree.path);
  if (!head.ok) fail(`unable to resolve worktree HEAD: ${head.stderr.trim() || head.error}.`);
  const tracked = run('git', ['diff', '--binary', 'HEAD', '--'], worktree.path);
  if (!tracked.ok) fail(`unable to read worktree diff: ${tracked.stderr.trim() || tracked.error}.`);
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard'], worktree.path);
  if (!untracked.ok) fail(`unable to enumerate untracked worktree files: ${untracked.stderr.trim() || untracked.error}.`);
  const digest = createHash('sha256').update(tracked.stdout);
  for (const path of untracked.stdout.split(/\r?\n/).map((value) => normalized(value.trim())).filter(Boolean).sort()) {
    digest.update(`\0${path}\0`);
    const object = run('git', ['hash-object', '--no-filters', '--', path], worktree.path);
    if (!object.ok) fail(`unable to hash untracked worktree path ${path}: ${object.stderr.trim() || object.error}.`);
    digest.update(object.stdout.trim());
  }
  return {
    baseSha: worktree.run.baseSha,
    headSha: head.stdout.trim(),
    diffHash: digest.digest('hex'),
    changedFiles,
  };
}

function l2Context(root, pattern, args, { requirePaths = false } = {}) {
  const runId = option(args, '--run-id', '');
  const taskId = option(args, '--task', '');
  const paths = option(args, '--paths', '').split(',').map((item) => normalized(item.trim())).filter(Boolean);
  if (!SAFE_ID.test(runId)) return { error: { trigger: 'run-evidence', reason: 'a safe --run-id is required', paths } };
  const runRecord = existsSync(runPath(root, runId)) ? parseJson(runPath(root, runId)) : null;
  if (!runRecord || runRecord.loopId !== pattern.id || runRecord.status !== 'prepared') {
    return { error: { trigger: 'run-evidence', reason: 'a prepared run for this L2 pattern is required', paths } };
  }
  const config = readConfig(root);
  if (runRecord.configHash !== configDigest(config)) return { error: { trigger: 'config-drift', reason: 'run configuration has drifted', paths } };
  const task = governanceFor(root, taskId);
  if (!approvedTask(task)) return { error: { trigger: 'approved-task', reason: 'current approved task evidence is required', paths } };
  const worktree = worktreeForRun(root, runId, pattern.id);
  if (!worktree) return { error: { trigger: 'active-worktree', reason: 'an active isolated worktree is required', paths } };
  worktree.run = runRecord;
  const lock = lockRecords(root).find((entry) => entry.owner === runId && (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()));
  if (!lock) return { error: { trigger: 'path-lock', reason: 'a live run-owned path lock is required', paths } };
  if (requirePaths && paths.length === 0) return { error: { trigger: 'paths-required', reason: 'explicit planned paths are required', paths } };
  return { runId, runRecord, taskId, task, worktree, lock, paths };
}

function l2PathDecision(pattern, task, lock, paths) {
  const unsafe = paths.filter((path) => !safeRelative(path));
  if (unsafe.length) return { trigger: 'unsafe-path', reason: 'paths must be safe repository-relative paths', paths: unsafe };
  const deny = matching(paths, pattern.scope.denyPaths);
  if (deny.length) return { trigger: 'denylist', reason: 'changed paths match denylist', paths: deny };
  const unwatched = paths.filter((path) => matching([path], pattern.scope.watchPaths).length === 0);
  if (unwatched.length) return { trigger: 'scope-watch', reason: 'changed paths are outside the pattern watch scope', paths: unwatched };
  if (paths.length > pattern.scope.maxChangedFiles) return { trigger: 'file-count', reason: `${paths.length} exceeds maxChangedFiles ${pattern.scope.maxChangedFiles}`, paths };
  const ownership = taskOwnsPaths(task, paths);
  if (ownership.length) return { trigger: 'task-path-ownership', reason: 'changed paths are outside participating role ownership', paths: ownership };
  const unlocked = paths.filter((path) => !lock.paths.some((held) => globToRegex(held).test(path)));
  if (unlocked.length) return { trigger: 'path-lock', reason: 'the run lock does not cover every path', paths: unlocked };
  return null;
}

function latestGateDecision(record, action) {
  return [...(record.gateDecisions ?? [])].reverse().find((decision) => decision.action === action && decision.allowed === true) ?? null;
}

function persistGateDecision(root, context, decision) {
  const record = parseJson(runPath(root, context.runId));
  record.gateDecisions ??= [];
  record.gateDecisions.push(decision);
  if (decision.makerSession) record.makerSession = decision.makerSession;
  writeJsonAtomic(runPath(root, context.runId), record);
  writeJsonAtomic(gateReceiptPath(root, context.runId, decision.action), decision);
}

function breakerDecision(pattern, ledger) {
  const attempts = Array.isArray(ledger?.attempts) ? ledger.attempts : [];
  if (attempts.length >= pattern.escalation.maxIterations) return { blocked: true, trigger: 'max-iterations', reason: `attempt limit ${pattern.escalation.maxIterations} reached` };
  const tailFailures = [];
  for (let index = attempts.length - 1; index >= 0 && attempts[index].outcome === 'failure'; index -= 1) tailFailures.unshift(attempts[index]);
  if (tailFailures.length >= pattern.escalation.noProgressCount) return { blocked: true, trigger: 'no-progress', reason: `${tailFailures.length} consecutive failures` };
  if (tailFailures.length >= pattern.escalation.sameErrorCount) {
    const signatures = tailFailures.slice(-pattern.escalation.sameErrorCount).map((attempt) => String(attempt.error ?? '').toLowerCase().replace(/\d+/g, '#').trim());
    if (signatures[0] && signatures.every((value) => value === signatures[0])) return { blocked: true, trigger: 'same-error', reason: `same error repeated ${signatures.length} times` };
  }
  return { blocked: false, trigger: 'ok', reason: 'within attempt policy' };
}

function policyBlock(value, json) {
  output(value, json, `loop gate: BLOCKED (${value.trigger}) ${value.reason}`);
  process.exit(2);
}

function rootOnly() {
  const role = process.env.HARNESS_AGENT_ROLE ?? process.env.CODEX_AGENT_ROLE ?? '';
  if (role && !['parent', 'orchestrator', 'root'].includes(role)) fail(`controller mutation is parent-only (current role: ${role}).`, 2);
}

function commandInit(root, args) {
  const json = args.includes('--json');
  const dryRun = args.includes('--dry-run');
  const id = positionals(args, ['--pattern'])[0] ?? '';
  const templateId = option(args, '--pattern', '');
  const allowed = new Set(['--json', '--dry-run', '--pattern']);
  if (args.some((arg) => arg.startsWith('--') && !allowed.has(arg))) fail(`unknown loop init option: ${args.find((arg) => arg.startsWith('--') && !allowed.has(arg))}.`);
  const required = ['loop.config.json', 'STATE.md', 'loop-budget.md', 'loop-constraints.md', 'loop-run-log.md', 'gate.yaml', 'patterns/registry.json'];
  const missing = required.filter((file) => !existsSync(join(root, file)));
  const result = { ok: missing.length === 0, command: 'init', dryRun, id: id || null, pattern: templateId || null, missing, created: [] };
  if (!dryRun && missing.length) fail(`template loop assets missing: ${missing.join(', ')}.`);
  if (id || templateId) {
    if (!id || !templateId) fail('loop init requires both <id> and --pattern <pattern>.');
    if (!SAFE_ID.test(id) || !SAFE_ID.test(templateId)) fail('loop init ids must be safe lowercase ids.');
    const config = readConfig(root);
    if (config.patterns.some((pattern) => pattern.id === id)) {
      result.status = 'already-exists';
    } else {
      const template = patternById(config, templateId);
      const next = structuredClone(template);
      next.id = id;
      next.enabled = templateId !== 'ci-sweeper';
      next.trigger = { ...next.trigger, type: 'manual' };
      result.created.push(`loop.config.json#${id}`);
      if (!dryRun) {
        config.patterns.push(next);
        writeJson(configPath(root), config);
        const registryPath = join(root, 'patterns', 'registry.json');
        const registry = parseJson(registryPath);
        registry.patterns.push({ id, level: next.level, mode: next.mode, template: templateId, file: null });
        writeJson(registryPath, registry);
        writeConfigProjections(root, config);
        const state = readState(root, config);
        state.patterns[id] = defaultState({ patterns: [next] }).patterns[id];
        writeState(root, config, state);
      }
    }
  }
  output(result, json, `loop init: ${missing.length ? `missing ${missing.join(', ')}` : 'ready'}${dryRun ? ' (dry-run)' : ''}`);
}

function commandValidate(root, args) {
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const config = existsSync(configPath(root)) ? parseJson(configPath(root), 'loop.config.json') : null;
  const errors = config ? loopConfigErrors(config) : ['missing loop.config.json'];
  const required = ['loop-budget.md', 'loop-constraints.md', 'gate.yaml', 'patterns/registry.json'];
  if (config && Array.isArray(config.patterns)) {
    required.push(
      ...config.patterns.flatMap((pattern) => [pattern.state?.summaryFile, pattern.state?.runLogFile]).filter((path) => safeRelative(path)),
    );
  } else required.push('STATE.md', 'loop-run-log.md');
  for (const file of new Set(required)) {
    const path = join(root, file);
    if (!existsSync(path)) errors.push(`missing ${file}`);
    else if (strict && !statSync(path).isFile()) errors.push(`state reference ${file} must resolve to a regular file`);
  }
  const registryPath = join(root, 'patterns', 'registry.json');
  if (config && loopConfigErrors(config).length === 0 && existsSync(registryPath) && statSync(registryPath).isFile()) {
    errors.push(...registryErrors(config, parseJson(registryPath)));
  }
  const result = { ok: errors.length === 0, command: 'validate', errors };
  output(result, json, result.ok ? 'loop validate: PASS' : `loop validate: FAIL ${errors.join('; ')}`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

function syncErrors(root, config, state) {
  const errors = [];
  const expectedHash = configDigest(config);
  for (const path of statePaths(root, config)) {
    const label = normalized(relative(root, path));
    if (!existsSync(path)) {
      errors.push(`${label} missing`);
      continue;
    }
    const embedded = embeddedStateAt(path);
    if (!embedded) errors.push(`${label} machine projection missing or invalid`);
    else {
      const configIds = config.patterns.map((item) => item.id).sort();
      const stateIds = Object.keys(embedded.patterns ?? {}).filter((id) => configIds.includes(id)).sort();
      if (JSON.stringify(configIds) !== JSON.stringify(stateIds)) errors.push('STATE.md pattern set drift');
      for (const pattern of config.patterns) if (embedded.patterns?.[pattern.id]?.level !== pattern.level) errors.push(`STATE.md level drift: ${pattern.id}`);
      if (embedded.configHash !== expectedHash) errors.push('STATE.md config hash drift');
    }
  }
  for (const name of ['LOOP.md', 'loop-budget.md', 'loop-constraints.md', 'gate.yaml']) {
    const path = join(root, name);
    if (!existsSync(path)) errors.push(`${name} missing`);
    else {
      const contents = readFileSync(path, 'utf8');
      if (!contents.startsWith(configHeader(config, name))) errors.push(`${name} config hash drift`);
      if (name === 'gate.yaml') {
        if (contents !== `${configHeader(config, name)}\n${projectionBody(name, config)}`) errors.push(`${name} generated projection drift`);
      } else {
        const expected = `${PROJECTION_START}\n${projectionBody(name, config).trim()}\n${PROJECTION_END}`;
        if (!contents.includes(expected)) errors.push(`${name} generated projection drift`);
      }
    }
  }
  const registryPath = join(root, 'patterns', 'registry.json');
  if (existsSync(registryPath)) {
    const registry = parseJson(registryPath);
    errors.push(...registryErrors(config, registry));
  }
  return errors;
}

function commandSync(root, args) {
  const json = args.includes('--json');
  const write = args.includes('--write');
  if (args.includes('--check') && write) fail('loop sync accepts only one of --check or --write.');
  const config = readConfig(root);
  const state = readState(root, config);
  let errors = syncErrors(root, config, state);
  if (write) {
    for (const pattern of config.patterns) state.patterns[pattern.id].level = pattern.level;
    for (const id of Object.keys(state.patterns)) if (!config.patterns.some((pattern) => pattern.id === id)) delete state.patterns[id];
    writeConfigProjections(root, config);
    writeState(root, config, state);
    errors = syncErrors(root, config, state);
  }
  const result = { ok: errors.length === 0, command: 'sync', mode: write ? 'write' : 'check', errors };
  output(result, json, result.ok ? `loop sync: PASS (${result.mode})` : `loop sync: FAIL ${errors.join('; ')}`);
  if (!result.ok) process.exitCode = 1;
}

function patternMetrics(root, pattern, state, sourceEntries) {
  const entries = sourceEntries.filter((entry) => entry.loopId === pattern.id);
  const day = now().slice(0, 10);
  const today = entries.filter((entry) => String(entry.finishedAt ?? entry.startedAt ?? '').startsWith(day));
  const outcomes = Object.fromEntries([...OUTCOMES].map((outcome) => [outcome, entries.filter((entry) => entry.outcome === outcome).length]));
  return {
    id: pattern.id,
    enabled: pattern.enabled,
    level: state.patterns[pattern.id]?.level ?? pattern.level,
    mode: pattern.mode,
    paused: Boolean(state.patterns[pattern.id]?.paused),
    pauseReason: state.patterns[pattern.id]?.pauseReason ?? null,
    lastRun: state.patterns[pattern.id]?.lastRun ?? null,
    lastOutcome: state.patterns[pattern.id]?.lastOutcome ?? null,
    runs: entries.length,
    runsToday: today.length,
    tokensToday: today.reduce((sum, entry) => sum + Number(entry.tokens ?? 0), 0),
    outcomes,
  };
}

function commandStatus(root, args) {
  const json = args.includes('--json');
  const id = positionals(args)[0] ?? '';
  const config = readConfig(root);
  const state = readState(root, config);
  const selected = id ? [patternById(config, id)] : config.patterns;
  const entries = logEntries(root, config);
  const patterns = selected.map((pattern) => patternMetrics(root, pattern, state, entries));
  const result = { ok: true, command: 'status', patterns, inboxOpen: state.inbox.filter((item) => item.status === 'open').length };
  output(result, json, patterns.map((item) => `${item.id}: ${item.enabled ? item.paused ? 'paused' : 'ready' : 'disabled'} ${item.level} runs=${item.runs} today=${item.runsToday}`).join('\n'));
}

function readiness(root, config, state, { ignoreRun = '' } = {}) {
  const findings = [];
  const configuredL1 = [...statePaths(root, config), ...runLogPaths(root, config), join(root, 'loop-budget.md'), join(root, 'loop-constraints.md'), join(root, 'gate.yaml')].every((path) => existsSync(path) && statSync(path).isFile());
  if (!configuredL1) findings.push('L1 runtime artifacts incomplete');
  const l2Patterns = config.patterns.filter((pattern) => pattern.level === 'L2');
  const l2Ready = (pattern) => (
    configuredL1
    && pattern.mode === 'assisted'
    && pattern.isolation?.mode === 'worktree'
    && pattern.isolation.lockPaths.length
    && pattern.roles?.independentVerifier
    && pattern.gates?.merge === 'never'
  );
  const configuredL2 = l2Patterns.some((pattern) => pattern.enabled && l2Ready(pattern));
  if (!configuredL2) findings.push('L2 worktree/lock/verifier capability incomplete');
  const entries = logEntries(root, config).filter((entry) => entry.runId !== ignoreRun);
  const validL1 = entries.filter((entry) => entry.level === 'L1' && entry.evidenceComplete === true && entry.unauthorizedWrites === 0 && !['failed', 'escalated'].includes(entry.outcome));
  const validL2 = entries.filter((entry) => entry.level === 'L2' && entry.evidenceComplete === true && entry.unauthorizedWrites === 0 && ['proposal', 'success'].includes(entry.outcome) && entry.verification?.verifierStatus === 'pass' && entry.task?.taskId);
  let observedLevel = 'L0';
  if (validL1.length) observedLevel = 'L1';
  if (validL2.length && config.patterns.some((pattern) => pattern.promotion?.level === 'L2')) observedLevel = 'L2';
  if (!entries.length) findings.push('no proven loop run');
  const configuredScore = configuredL2 ? 100 : configuredL1 ? 70 : 30;
  const patterns = config.patterns.map((pattern) => {
    const patternEntries = entries.filter((entry) => entry.loopId === pattern.id);
    const patternL1 = validL1.filter((entry) => entry.loopId === pattern.id);
    const patternL2 = validL2.filter((entry) => entry.loopId === pattern.id);
    const level = patternL2.length && pattern.promotion?.level === 'L2' ? 'L2' : patternL1.length ? 'L1' : 'L0';
    const capabilityLevel = l2Ready(pattern) ? 'L2-ready' : configuredL1 ? 'L1-ready' : 'L0';
    return {
      id: pattern.id,
      enabled: pattern.enabled,
      configuredCapability: { level: capabilityLevel, l1: configuredL1, l2: l2Ready(pattern) },
      observedMaturity: {
        level,
        validRuns: patternL1.length + patternL2.length,
        validL1Runs: patternL1.length,
        validL2Runs: patternL2.length,
        totalRuns: patternEntries.length,
      },
    };
  });
  return {
    score: configuredScore,
    level: observedLevel,
    activity: entries.length > 0,
    configuredCapability: { level: configuredL2 ? 'L2-ready' : configuredL1 ? 'L1-ready' : 'L0', l1: configuredL1, l2: configuredL2 },
    observedMaturity: { level: observedLevel, validL1Runs: validL1.length, validL2Runs: validL2.length, totalRuns: entries.length },
    patterns,
    findings,
    paused: config.patterns.filter((pattern) => state.patterns[pattern.id]?.paused).map((pattern) => pattern.id),
  };
}

function commandDoctor(root, args) {
  const json = args.includes('--json');
  const strict = args.includes('--strict');
  const allowed = new Set(['--json', '--strict', '--ignore-run']);
  const unknown = args.find((arg) => arg.startsWith('--') && !allowed.has(arg));
  if (unknown) fail(`unknown loop doctor option: ${unknown}.`);
  const ignoreRun = option(args, '--ignore-run', '');
  if (ignoreRun && !SAFE_ID.test(ignoreRun)) fail('--ignore-run must be a safe lowercase run id.');
  if (ignoreRun && process.env.HARNESS_LOOP_INTERNAL_RUNNER !== ignoreRun) fail('--ignore-run is reserved for the internal Loop runner.');
  const config = readConfig(root);
  const state = readState(root, config);
  const errors = syncErrors(root, config, state);
  const health = readiness(root, config, state, { ignoreRun });
  if (strict && health.observedMaturity.level === 'L0') errors.push('strict readiness requires at least one proven L1 run');
  if (strict) {
    for (const pattern of config.patterns) {
      const currentRun = state.patterns[pattern.id]?.currentRun;
      if (!currentRun) continue;
      if (currentRun === ignoreRun) continue;
      const path = runPath(root, currentRun);
      errors.push(existsSync(path) ? `unfinished currentRun: ${pattern.id}/${currentRun}` : `stale currentRun without evidence: ${pattern.id}/${currentRun}`);
    }
    for (const lock of lockRecords(root)) if (lock.expiresAt && Date.parse(lock.expiresAt) <= Date.now()) errors.push(`expired worktree lock: ${lock.owner}`);
    for (const item of worktreeManifest(root).worktrees) {
      if (item.status !== 'active') continue;
      const path = safeWorktreePath(root, join(root, item.path));
      if (!existsSync(path)) errors.push(`active worktree missing on disk: ${item.runId}`);
    }
  }
  const result = { ok: errors.length === 0, command: 'doctor', strict, readiness: health, errors };
  output(result, json, result.ok ? `loop doctor: PASS configured=${health.configuredCapability.level} observed=${health.observedMaturity.level}` : `loop doctor: FAIL ${errors.join('; ')}`);
  if (!result.ok) process.exitCode = 1;
}

function prepareRun(root, args, { emit = true } = {}) {
  const json = args.includes('--json');
  const id = positionals(args, ['--run-id', '--slot', '--trigger', '--actor'])[0];
  if (!id) fail('loop run prepare requires a pattern id.');
  return withMutex(root, 'run-prepare', () => {
  const config = readConfig(root);
  const pattern = patternById(config, id);
  const state = readState(root, config);
  if (!pattern.enabled) policyBlock({ ok: false, allowed: false, command: 'run.prepare', loopId: id, trigger: 'disabled', reason: 'pattern is disabled', matchedPaths: [] }, json);
  const patternState = state.patterns[id];
  if (patternState.paused) policyBlock({ ok: false, allowed: false, command: 'run.prepare', loopId: id, trigger: 'paused', reason: patternState.pauseReason ?? 'pattern paused', matchedPaths: [] }, json);
  const trigger = option(args, '--trigger', 'manual');
  if (!TRIGGERS.has(trigger)) fail('--trigger must be manual, schedule, or event.');
  const slotKey = option(args, '--slot', `${id}:${now().slice(0, 10)}`);
  const existing = state.slots[slotKey] ?? logEntries(root, config).find((entry) => entry.slotKey === slotKey)?.runId;
  if (existing) {
    const result = { ok: true, command: 'run.prepare', loopId: id, runId: existing, slotKey, status: 'duplicate', budget: null, paths: null };
    if (emit) output(result, json, `loop run prepare: duplicate ${existing}`);
    return result;
  }
  if (patternState.currentRun) {
    const currentPath = runPath(root, patternState.currentRun);
    const status = existsSync(currentPath) ? parseJson(currentPath).status : 'stale-missing-evidence';
    policyBlock({ ok: false, allowed: false, command: 'run.prepare', loopId: id, trigger: 'active-run', reason: `unfinished currentRun ${patternState.currentRun} (${status}) must be finished or escalated before a new slot`, matchedPaths: [] }, json);
  }
  const today = todayEntries(root, config, id);
  const tokensToday = today.reduce((sum, entry) => sum + Number(entry.tokens ?? 0), 0);
  if (today.length >= pattern.budget.maxRunsPerDay || tokensToday >= pattern.budget.maxTokensPerDay) {
    patternState.paused = true;
    patternState.pauseReason = today.length >= pattern.budget.maxRunsPerDay ? 'daily-run-budget' : 'daily-token-budget';
    writeState(root, config, state);
    policyBlock({ ok: false, allowed: false, command: 'run.prepare', loopId: id, trigger: patternState.pauseReason, reason: 'daily budget exhausted; controller paused', matchedPaths: [] }, json);
  }
  const runRatio = pattern.budget.maxRunsPerDay === 0 ? 1 : (today.length + 1) / pattern.budget.maxRunsPerDay;
  const tokenRatio = pattern.budget.maxTokensPerDay === 0 ? 1 : tokensToday / pattern.budget.maxTokensPerDay;
  const degraded = runRatio >= 0.8 || tokenRatio >= 0.8;
  patternState.budgetMode = degraded ? 'report-only' : null;
  const requested = option(args, '--run-id', '');
  const runId = requested || `${id}-${now().replace(/[-:.TZ]/g, '').toLowerCase()}-${randomUUID().slice(0, 8)}`;
  if (!SAFE_ID.test(runId)) fail('--run-id must be a safe lowercase id.');
  const record = {
    schemaVersion: 1,
    runId,
    loopId: id,
    slotKey,
    trigger: { type: trigger, actor: option(args, '--actor', 'unknown') },
    level: degraded ? 'L1' : pattern.level,
    configuredLevel: pattern.level,
    mode: degraded ? 'report-only' : pattern.mode,
    status: 'prepared',
    startedAt: now(),
    finishedAt: null,
    configHash: configDigest(config),
    baseSha: (() => { const result = run('git', ['rev-parse', 'HEAD'], root); return result.ok ? result.stdout.trim() : null; })(),
    budget: { runsToday: today.length + 1, tokensToday, maxTokensPerRun: pattern.budget.maxTokensPerRun, maxTokensPerDay: pattern.budget.maxTokensPerDay, degradedToReportOnly: degraded },
    findings: 0,
    actions: 0,
    escalations: 0,
    escalationEvidence: [],
    tokens: 0,
    attempts: [],
    evidence: [],
    inputs: [],
    checks: [],
    evidenceComplete: false,
    unauthorizedWrites: 0,
    falsePositives: 0,
    killSwitchDrill: false,
    humanDispositions: [],
  };
  writeJson(runPath(root, runId), record);
  if (pattern.level === 'L2') writeJson(ledgerPath(root, runId), { schemaVersion: 1, runId, loopId: id, goal: pattern.goal, startedAt: record.startedAt, attempts: [] });
  state.slots[slotKey] = runId;
  patternState.currentRun = runId;
  writeState(root, config, state);
  const result = { ok: true, command: 'run.prepare', loopId: id, runId, slotKey, status: 'prepared', budget: record.budget, paths: { run: normalized(relative(root, runPath(root, runId))), ledger: pattern.level === 'L2' ? normalized(relative(root, ledgerPath(root, runId))) : null } };
  if (emit) output(result, json, `loop run prepare: ${runId}`);
  return result;
  });
}

function commandPrepare(root, args) {
  return prepareRun(root, args);
}

function commandAttempt(root, args) {
  const json = args.includes('--json');
  const runId = positionals(args, ['--action', '--outcome', '--error', '--tokens', '--maker-session'])[0];
  if (!runId) fail('loop run attempt requires a run id.');
  if (!SAFE_ID.test(runId)) fail('run id must be a safe lowercase id.');
  return withMutex(root, `run-attempt-${runId}`, () => {
  const { run: record } = findRun(root, runId);
  const config = readConfig(root);
  const pattern = patternById(config, record.loopId);
  const path = ledgerPath(root, runId);
  const ledger = existsSync(path) ? parseJson(path) : { schemaVersion: 1, runId, loopId: record.loopId, goal: pattern.goal, attempts: [] };
  const outcome = option(args, '--outcome');
  if (!['success', 'failure', 'noop'].includes(outcome)) fail('--outcome must be success, failure, or noop.');
  if (ledger.attempts.length >= pattern.budget.maxAttempts) {
    const decision = { blocked: true, trigger: 'max-attempts', reason: `attempt budget ${pattern.budget.maxAttempts} reached` };
    const result = { ok: false, command: 'run.attempt', loopId: record.loopId, runId, attempt: null, breaker: decision };
    output(result, json, `loop run attempt: ESCALATE (${decision.trigger})`);
    process.exit(2);
  }
  const attempt = { iteration: ledger.attempts.length + 1, timestamp: now(), action: redact(option(args, '--action')), outcome, error: option(args, '--error', '') ? redact(option(args, '--error')) : undefined, tokensUsed: integerOption(args, '--tokens', 0), makerSession: option(args, '--maker-session', '') || undefined };
  if (!attempt.action) fail('--action is required.');
  ledger.attempts.push(attempt);
  writeJson(path, ledger);
  const decision = breakerDecision(pattern, ledger);
  const result = { ok: !decision.blocked, command: 'run.attempt', loopId: record.loopId, runId, attempt, breaker: decision };
  output(result, json, decision.blocked ? `loop run attempt: ESCALATE (${decision.trigger})` : `loop run attempt: recorded #${attempt.iteration}`);
  if (decision.blocked) process.exit(2);
  });
}

function appendRunLog(root, config, pattern, record) {
  const path = runLogPath(root, config, pattern);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# Loop Run Log\n\nOne JSON object per completed run.\n\n## Runs\n\n');
  }
  appendFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    runId: record.runId,
    loopId: record.loopId,
    slotKey: record.slotKey,
    level: record.level,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationSeconds: record.durationSeconds,
    findings: record.findings,
    actions: record.actions,
    escalations: record.escalations,
    tokens: record.tokens,
    evidenceComplete: record.evidenceComplete,
    unauthorizedWrites: record.unauthorizedWrites,
    falsePositives: record.falsePositives,
    killSwitchDrill: record.killSwitchDrill,
    outcome: record.outcome,
    evidenceHash: record.evidenceHash,
    configHash: record.configHash,
    baseSha: record.baseSha,
    checks: record.checks,
    inputs: record.inputs,
    evidence: record.evidence,
    escalationEvidence: record.escalationEvidence,
    humanDispositions: record.humanDispositions,
    verification: record.verification,
    task: record.task,
  })}\n`);
}

const TRIAGE_BUCKETS = ['highPriority', 'watch', 'noise', 'inbox'];

function findingOwnershipKey(item) {
  return `${item.patternId ?? ''}\0${item.sourceAdapter ?? ''}\0${item.id ?? ''}`;
}

function applyTriageFindings(state, pattern, findings, managedAdapters = []) {
  if (!Array.isArray(findings)) return;
  const patternId = pattern.id;
  const seenAt = now();
  const retentionMs = (pattern.state.retentionDays ?? 0) * 86_400_000;
  const managed = new Set(managedAdapters);
  const activeKeys = new Set(findings.map(findingOwnershipKey));
  const existing = new Map(TRIAGE_BUCKETS.flatMap((bucket) => state[bucket].map((item) => [findingOwnershipKey(item), item])));
  for (const bucket of TRIAGE_BUCKETS) {
    state[bucket] = state[bucket].filter((item) => {
      if (item.patternId !== patternId || !managed.has(item.sourceAdapter)) return true;
      const key = findingOwnershipKey(item);
      if (activeKeys.has(key)) return false;
      if (item.humanOverride != null) return true;
      const lastSeen = Date.parse(item.lastSeen ?? item.firstSeen ?? '');
      return retentionMs > 0 && Number.isFinite(lastSeen) && Date.now() - lastSeen < retentionMs;
    });
  }
  for (const finding of findings) {
    if (
      !TRIAGE_BUCKETS.includes(finding.bucket)
      || !SAFE_ID.test(finding.id ?? '')
      || finding.patternId !== patternId
      || typeof finding.sourceAdapter !== 'string'
      || !finding.sourceAdapter
      || !managed.has(finding.sourceAdapter)
    ) fail('runner returned an invalid triage finding.');
    const key = findingOwnershipKey(finding);
    const previous = existing.get(key);
    const item = {
      ...finding,
      firstSeen: previous?.firstSeen ?? previous?.createdAt ?? seenAt,
      lastSeen: seenAt,
      humanOverride: previous?.humanOverride ?? finding.humanOverride ?? null,
    };
    delete item.bucket;
    if (finding.bucket === 'inbox') {
      item.status = previous?.status ?? finding.status ?? 'open';
      item.resolvedAt = previous?.resolvedAt ?? null;
    } else {
      delete item.status;
      delete item.resolvedAt;
    }
    state[finding.bucket].push(item);
  }
}

function finishRun(root, args, { emit = true, payloadOverride = null } = {}) {
  const json = args.includes('--json');
  const runId = positionals(args, ['--outcome', '--result', '--tokens', '--findings', '--actions', '--escalations', '--maker-session', '--verifier-session', '--verifier-status', '--unauthorized-writes', '--false-positives', '--evidence-complete', '--kill-switch-drill'])[0];
  if (!runId) fail('loop run finish requires a run id.');
  if (!SAFE_ID.test(runId)) fail('run id must be a safe lowercase id.');
  const initial = findRun(root, runId).run;
  return withMutex(root, `run-finish-${initial.loopId}`, () => {
  const { path, run: record } = findRun(root, runId);
  if (record.status === 'finished') {
    const result = { ok: true, command: 'run.finish', loopId: record.loopId, runId, outcome: record.outcome, status: 'duplicate', readiness: null, evidencePath: normalized(relative(root, path)) };
    if (emit) output(result, json, `loop run finish: duplicate ${runId}`);
    return result;
  }
  const config = readConfig(root);
  const pattern = patternById(config, record.loopId);
  const state = readState(root, config);
  if (record.configHash !== configDigest(config)) policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: 'config-drift', reason: 'loop.config.json changed after run prepare', matchedPaths: [] }, json);
  let payload = payloadOverride === null ? {} : redactDeep(structuredClone(payloadOverride));
  const resultValue = payloadOverride === null ? option(args, '--result', '') : '';
  if (resultValue) {
    try { payload = existsSync(resolve(process.cwd(), resultValue)) ? parseJson(resolve(process.cwd(), resultValue), '--result') : JSON.parse(resultValue); }
    catch (error) { fail(`--result must be a JSON object or JSON file: ${error.message}.`); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('--result must resolve to a JSON object.');
    payload = redactDeep(payload);
    const allowedResult = new Set(['outcome', 'tokens', 'findings', 'actions', 'escalations', 'escalationEvidence', 'makerSession', 'verifierSession', 'verifierStatus', 'evidenceComplete', 'unauthorizedWrites', 'falsePositives', 'killSwitchDrill', 'checks', 'evidence', 'humanDispositions', 'taskId', 'approvedVersion']);
    const unknown = Object.keys(payload).filter((key) => !allowedResult.has(key));
    if (unknown.length) fail(`--result has unknown fields: ${unknown.join(', ')}.`);
    for (const field of ['evidenceComplete', 'killSwitchDrill']) if (payload[field] !== undefined && typeof payload[field] !== 'boolean') fail(`--result.${field} must be boolean.`);
    if (payload.verifierStatus !== undefined && !['pass', 'fail'].includes(payload.verifierStatus)) fail('--result.verifierStatus must be pass or fail.');
    if (payload.taskId !== undefined && !SAFE_ID.test(payload.taskId)) fail('--result.taskId must be a safe lowercase id.');
    if (payload.approvedVersion !== undefined && typeof payload.approvedVersion !== 'string') fail('--result.approvedVersion must be a string.');
  }
  const numeric = (flag, field, fallback = 0) => args.includes(flag) ? integerOption(args, flag, fallback) : (() => {
    const value = payload[field] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 0) fail(`--result.${field} must be a non-negative integer.`);
    return value;
  })();
  const outcome = option(args, '--outcome', payload.outcome ?? '');
  if (!OUTCOMES.has(outcome)) fail(`--outcome must be one of ${[...OUTCOMES].join(', ')}.`);
  if (pattern.level === 'L2' && ['proposal', 'success'].includes(outcome)) {
    const proposal = latestGateDecision(record, 'proposal');
    if (!proposal) {
      policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: 'proposal-receipt', reason: 'L2 proposal finish requires the complete maker, scope, and independent verification gate chain', matchedPaths: [] }, json);
    }
    const task = governanceFor(root, proposal.taskId);
    if (!approvedTask(task) || task.approvedVersion !== proposal.approvedVersion) {
      policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: 'task-drift', reason: 'approved task changed after proposal gate', matchedPaths: [] }, json);
    }
    const worktree = worktreeForRun(root, runId, pattern.id);
    if (!worktree) policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: 'active-worktree', reason: 'proposal worktree is no longer active', matchedPaths: [] }, json);
    worktree.run = record;
    const current = worktreeSnapshot(root, worktree);
    if (current.headSha !== proposal.headSha || current.diffHash !== proposal.diffHash) {
      policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: 'diff-drift', reason: 'worktree changed after proposal gate', matchedPaths: current.changedFiles }, json);
    }
  }
  const tokens = numeric('--tokens', 'tokens', 0);
  if (tokens > pattern.budget.maxTokensPerRun) {
    state.patterns[pattern.id].paused = true;
    state.patterns[pattern.id].pauseReason = 'per-run-token-budget';
    writeState(root, config, state);
    policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: 'per-run-token-budget', reason: `${tokens} exceeds ${pattern.budget.maxTokensPerRun}`, matchedPaths: [] }, json);
  }
  const actions = numeric('--actions', 'actions', 0);
  const today = todayEntries(root, config, pattern.id);
  const tokensToday = today.reduce((sum, entry) => sum + Number(entry.tokens ?? 0), 0);
  const actionsToday = today.reduce((sum, entry) => sum + Number(entry.actions ?? 0), 0);
  const budgetTrigger = tokensToday + tokens > pattern.budget.maxTokensPerDay
    ? 'daily-token-budget'
    : actionsToday + actions > pattern.budget.maxActionsPerDay ? 'daily-action-budget' : null;
  if (budgetTrigger) {
    const limit = budgetTrigger === 'daily-token-budget' ? pattern.budget.maxTokensPerDay : pattern.budget.maxActionsPerDay;
    const attempted = budgetTrigger === 'daily-token-budget' ? tokensToday + tokens : actionsToday + actions;
    record.budgetBlock = { trigger: budgetTrigger, attempted, limit, at: now() };
    writeJson(path, record);
    state.patterns[pattern.id].paused = true;
    state.patterns[pattern.id].pauseReason = budgetTrigger;
    writeState(root, config, state);
    policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: budgetTrigger, reason: `${attempted} exceeds daily limit ${limit}; controller paused`, matchedPaths: [] }, json);
  }
  const makerSession = option(args, '--maker-session', payload.makerSession ?? '');
  const verifierSession = option(args, '--verifier-session', payload.verifierSession ?? '');
  const verifierStatus = option(args, '--verifier-status', payload.verifierStatus ?? '');
  if (pattern.level === 'L2' && ['proposal', 'success'].includes(outcome)) {
    const ledger = existsSync(ledgerPath(root, runId)) ? parseJson(ledgerPath(root, runId)) : { attempts: [] };
    const breaker = breakerDecision(pattern, ledger);
    if (breaker.blocked) policyBlock({ ok: false, allowed: false, command: 'run.finish', loopId: pattern.id, runId, trigger: breaker.trigger, reason: breaker.reason, matchedPaths: [] }, json);
  }
  record.status = 'finished';
  record.finishedAt = now();
  record.durationSeconds = Math.max(0, Math.round((Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000));
  record.findings = numeric('--findings', 'findings', 0);
  record.actions = actions;
  record.escalations = numeric('--escalations', 'escalations', 0);
  record.tokens = tokens;
  const checks = payload.checks ?? [];
  if (!Array.isArray(checks) || !checks.every((check) => check && typeof check.id === 'string' && ['pass', 'fail', 'skipped'].includes(check.status) && (check.evidence === undefined || typeof check.evidence === 'string'))) fail('--result.checks must be an array of {id,status,evidence?}.');
  const evidence = payload.evidence ?? [];
  if (!Array.isArray(evidence) || !evidence.every((item) => item && typeof item.id === 'string' && typeof item.type === 'string' && typeof item.subject === 'string')) fail('--result.evidence must be an array of {id,type,subject,...}.');
  const inputs = payload.inputReceipts ?? [];
  if (!Array.isArray(inputs) || !inputs.every((item) => item && typeof item.id === 'string' && ['pass', 'fail'].includes(item.status) && typeof item.evidence === 'string')) fail('runner input receipts are invalid.');
  const humanDispositions = payload.humanDispositions ?? [];
  if (!Array.isArray(humanDispositions) || !humanDispositions.every((item) => item && typeof item.findingId === 'string' && ['accept', 'dismiss', 'defer'].includes(item.decision))) fail('--result.humanDispositions is invalid.');
  const escalationEvidence = payload.escalationEvidence ?? [];
  if (!Array.isArray(escalationEvidence) || !escalationEvidence.every((item) => item && typeof item.trigger === 'string' && typeof item.reason === 'string')) fail('--result.escalationEvidence is invalid.');
  const evidenceComplete = args.includes('--evidence-complete') ? option(args, '--evidence-complete') === 'true' : payload.evidenceComplete === true;
  if (evidenceComplete && (!checks.length || checks.some((check) => !check.evidence?.trim()) || !evidence.length)) fail('evidenceComplete=true requires non-empty check receipts with evidence and structured evidence records.');
  record.checks = checks;
  record.inputs = inputs;
  record.evidence = evidence;
  record.humanDispositions = humanDispositions;
  record.escalationEvidence = escalationEvidence;
  record.evidenceComplete = evidenceComplete;
  record.unauthorizedWrites = numeric('--unauthorized-writes', 'unauthorizedWrites', 0);
  record.falsePositives = numeric('--false-positives', 'falsePositives', 0);
  record.killSwitchDrill = args.includes('--kill-switch-drill') ? option(args, '--kill-switch-drill') === 'true' : payload.killSwitchDrill === true;
  record.outcome = outcome;
  const proposalEvidence = pattern.level === 'L2' ? latestGateDecision(record, 'proposal') : null;
  record.task = proposalEvidence
    ? { taskId: proposalEvidence.taskId, approvedVersion: proposalEvidence.approvedVersion }
    : payload.taskId ? { taskId: payload.taskId, approvedVersion: payload.approvedVersion ?? null } : null;
  record.verification = proposalEvidence
    ? { makerSession: proposalEvidence.makerSession, verifierSession: proposalEvidence.verifierSession, verifierStatus: 'pass', checksHash: proposalEvidence.checksHash }
    : { makerSession: makerSession || null, verifierSession: verifierSession || null, verifierStatus: verifierStatus || null };
  record.evidenceHash = hash(JSON.stringify({ runId, outcome, tokens, actions, configHash: record.configHash, baseSha: record.baseSha, checks: record.checks, inputs: record.inputs, evidence: record.evidence, task: record.task, humanDispositions: record.humanDispositions, verification: record.verification }));
  writeJson(path, record);
  appendRunLog(root, config, pattern, record);
  const patternState = state.patterns[pattern.id];
  patternState.currentRun = null;
  patternState.lastRun = record.finishedAt;
  patternState.lastOutcome = outcome;
  applyTriageFindings(state, pattern, payload.triageFindings, payload.managedAdapters);
  if (outcome === 'escalated' && !Array.isArray(payload.triageFindings)) {
    const seenAt = now();
    state.inbox.push({ id: `inbox-${randomUUID().slice(0, 8)}`, loopId: pattern.id, message: `Run ${runId} escalated`, source: 'run.finish', firstSeen: seenAt, lastSeen: seenAt, status: 'open', humanOverride: null, resolvedAt: null });
  }
  if (pattern.level === 'L2') {
    for (const [slot, value] of Object.entries(state.slots)) if (value === runId) delete state.slots[slot];
    releaseLock(root, runId);
    const manifest = worktreeManifest(root);
    const worktree = manifest.worktrees.find((item) => item.runId === runId);
    if (worktree) {
      worktree.status = outcome === 'failed' ? 'rejected' : outcome === 'escalated' ? 'escalated' : 'proposed';
      worktree.updatedAt = record.finishedAt;
      writeWorktreeManifest(root, manifest);
    }
  }
  writeState(root, config, state);
  const health = readiness(root, config, state);
  const result = {
    ok: true,
    command: 'run.finish',
    loopId: pattern.id,
    runId,
    outcome,
    status: 'finished',
    findings: record.findings,
    actions: record.actions,
    escalations: record.escalations,
    tokens: record.tokens,
    checks: record.checks,
    readiness: health,
    evidencePath: normalized(relative(root, path)),
  };
  if (emit) output(result, json, `loop run finish: ${runId} -> ${outcome}`);
  return result;
  });
}

function commandFinish(root, args) {
  return finishRun(root, args);
}

function commandVerify(root, args) {
  const json = args.includes('--json');
  const allowed = new Set(['--json', '--session']);
  const unknown = args.find((arg) => arg.startsWith('--') && !allowed.has(arg));
  if (unknown) fail(`loop run verify rejects caller-supplied status; unknown option: ${unknown}.`);
  const runId = positionals(args, ['--session'])[0];
  const verifierSession = option(args, '--session');
  if (!SAFE_ID.test(runId ?? '') || !SAFE_ID.test(verifierSession)) fail('loop run verify requires a safe run id and --session.');
  return withMutex(root, `l2-verify-${runId}`, () => {
    const { run: record } = findRun(root, runId);
    const config = readConfig(root);
    const pattern = patternById(config, record.loopId);
    if (!pattern.enabled || pattern.level !== 'L2') policyBlock({ ok: false, command: 'run.verify', loopId: pattern.id, runId, trigger: 'l2-required', reason: 'verification requires an enabled L2 pattern', matchedPaths: [] }, json);
    const maker = latestGateDecision(record, 'maker');
    const scope = latestGateDecision(record, 'scope');
    if (!maker || !scope) policyBlock({ ok: false, command: 'run.verify', loopId: pattern.id, runId, trigger: 'scope-receipt', reason: 'maker and scope gate receipts are required before verification', matchedPaths: [] }, json);
    const makerSession = record.makerSession ?? maker.makerSession;
    if (!makerSession || verifierSession === makerSession) policyBlock({ ok: false, command: 'run.verify', loopId: pattern.id, runId, trigger: 'independent-verifier', reason: 'verifier session must differ from maker session', matchedPaths: [] }, json);
    const worktree = worktreeForRun(root, runId, pattern.id);
    if (!worktree) policyBlock({ ok: false, command: 'run.verify', loopId: pattern.id, runId, trigger: 'active-worktree', reason: 'active run worktree is required', matchedPaths: [] }, json);
    const checks = runDeclaredChecks(worktree.path, pattern).map((check) => ({
      ...check,
      cwd: normalized(join(worktree.item.path, check.cwd === '.' ? '' : check.cwd)).replace(/\/$/, ''),
    }));
    const receipt = {
      schemaVersion: 1,
      command: 'run.verify',
      runId,
      loopId: pattern.id,
      taskId: scope.taskId,
      approvedVersion: scope.approvedVersion,
      baseSha: scope.baseSha,
      headSha: scope.headSha,
      diffHash: scope.diffHash,
      configHash: record.configHash,
      checksHash: hash(JSON.stringify(checks)),
      verifierSession,
      makerSession,
      startedAt: checks[0]?.startedAt ?? now(),
      finishedAt: checks.at(-1)?.finishedAt ?? now(),
      checks,
    };
    writeJsonAtomic(verificationPath(root, runId), receipt);
    record.verificationReceipt = normalized(relative(root, verificationPath(root, runId)));
    record.verification = { makerSession, verifierSession, verifierStatus: checks.every(({ status }) => status === 'pass') ? 'pass' : 'fail' };
    writeJsonAtomic(runPath(root, runId), record);
    output(receipt, json, `loop run verify: ${runId} ${record.verification.verifierStatus}`);
    if (record.verification.verifierStatus !== 'pass') process.exitCode = 2;
    return receipt;
  });
}

function commandRecover(root, args) {
  const json = args.includes('--json');
  const allowed = new Set(['--json', '--stale-after']);
  const unknown = args.find((arg) => arg.startsWith('--') && !allowed.has(arg));
  if (unknown) fail(`unknown loop run recover option: ${unknown}.`);
  const staleAfter = integerOption(args, '--stale-after', 3600);
  return withMutex(root, 'run-recover', () => {
    const config = readConfig(root);
    const state = readState(root, config);
    const manifest = worktreeManifest(root);
    const recovered = [];
    const directory = runDirectory(root);
    if (existsSync(directory)) {
      for (const name of readdirSync(directory).filter((value) => value.endsWith('.json'))) {
        const path = join(directory, name);
        const record = parseJson(path);
        if (record.status !== 'prepared') continue;
        const ageSeconds = Math.max(0, (Date.now() - Date.parse(record.startedAt)) / 1000);
        if (!Number.isFinite(ageSeconds) || ageSeconds < staleAfter) continue;
        withMutex(root, `run-finish-${record.loopId}`, () => {
          const current = parseJson(path);
          if (current.status !== 'prepared') return;
          const currentAge = Math.max(0, (Date.now() - Date.parse(current.startedAt)) / 1000);
          if (!Number.isFinite(currentAge) || currentAge < staleAfter) return;
          const pattern = patternById(config, current.loopId);
          const recoveredAt = now();
          current.status = 'stale';
          current.outcome = 'escalated';
          current.finishedAt = recoveredAt;
          current.durationSeconds = Math.max(0, Math.round(currentAge));
          current.escalations = Math.max(1, Number(current.escalations ?? 0));
          current.escalationEvidence = [...(current.escalationEvidence ?? []), { trigger: 'stale-run-recovery', reason: `prepared run exceeded ${staleAfter} seconds` }];
          current.evidence = [...(current.evidence ?? []), { id: 'stale-run-recovery', type: 'command', subject: 'loop run recover' }];
          current.evidenceHash = hash(JSON.stringify({ runId: current.runId, outcome: current.outcome, recoveredAt, evidence: current.evidence }));
          writeJsonAtomic(path, current);
          appendRunLog(root, config, pattern, current);
          if (state.patterns[current.loopId]?.currentRun === current.runId) state.patterns[current.loopId].currentRun = null;
          for (const [slot, value] of Object.entries(state.slots)) if (value === current.runId) delete state.slots[slot];
          releaseLock(root, current.runId);
          const worktree = manifest.worktrees.find((item) => item.runId === current.runId);
          if (worktree) { worktree.status = 'stale'; worktree.updatedAt = recoveredAt; }
          recovered.push({
            runId: current.runId,
            loopId: current.loopId,
            status: 'stale',
            evidence: 'stale prepared run retired; worktree and patch retained',
            nextCommand: `node scripts/harness/cli.mjs loop worktree list --json`,
          });
        });
      }
    }
    writeState(root, config, state);
    writeWorktreeManifest(root, manifest);
    const result = { ok: true, command: 'run.recover', staleAfter, recovered };
    output(result, json, `loop run recover: ${recovered.length}`);
    return result;
  });
}

function commandExecute(root, args) {
  const json = args.includes('--json');
  const valueOptions = ['--run-id', '--slot', '--trigger', '--actor'];
  const allowed = new Set(['--json', ...valueOptions]);
  const unknown = args.find((arg) => arg.startsWith('--') && !allowed.has(arg));
  if (unknown) {
    if (unknown === '--result') fail('loop run execute does not accept caller-supplied --result.');
    fail(`unknown loop run execute option: ${unknown}.`);
  }
  const positional = positionals(args, valueOptions);
  if (positional.length !== 1) fail('loop run execute requires exactly one pattern id.');
  const id = positional[0];
  const config = readConfig(root);
  const pattern = patternById(config, id);
  if (!pattern.enabled) {
    policyBlock({ ok: false, allowed: false, command: 'run.execute', loopId: id, trigger: 'disabled', reason: 'pattern is disabled', matchedPaths: [] }, json);
  }
  if (pattern.level !== 'L1' || pattern.mode !== 'report-only') {
    policyBlock({ ok: false, allowed: false, command: 'run.execute', loopId: id, trigger: 'unsupported-level', reason: 'execute supports only enabled L1 report-only patterns', matchedPaths: [] }, json);
  }
  const prepared = prepareRun(root, args, { emit: false });
  if (prepared.status === 'duplicate') {
    const path = runPath(root, prepared.runId);
    const record = existsSync(path)
      ? parseJson(path)
      : logEntries(root, config).find((entry) => entry.runId === prepared.runId) ?? {};
    const result = {
      ok: true,
      command: 'run.execute',
      loopId: id,
      runId: prepared.runId,
      status: 'duplicate',
      outcome: record.outcome ?? null,
      findings: record.findings ?? 0,
      actions: record.actions ?? 0,
      escalations: record.escalations ?? 0,
      tokens: record.tokens ?? 0,
      checks: record.checks ?? [],
      evidencePath: existsSync(path) ? normalized(relative(root, path)) : null,
    };
    output(result, json, `loop run execute: duplicate ${prepared.runId}`);
    return result;
  }
  let runnerResult;
  try {
    runnerResult = executePatternRunner(root, pattern, { runId: prepared.runId });
  } catch (error) {
    const seenAt = now();
    const message = redact(error?.message ?? String(error));
    runnerResult = {
      outcome: 'escalated',
      tokens: 0,
      findings: 1,
      actions: 0,
      escalations: 1,
      escalationEvidence: [{ trigger: 'adapter-execution-failure', reason: message }],
      evidenceComplete: true,
      unauthorizedWrites: 0,
      falsePositives: 0,
      killSwitchDrill: false,
      checks: [{
        id: 'adapter-execution',
        program: '',
        args: [],
        cwd: '.',
        exitCode: 1,
        startedAt: seenAt,
        finishedAt: now(),
        status: 'fail',
        evidence: message || 'adapter execution failed',
      }],
      evidence: [{ id: 'adapter-execution', type: 'controller', subject: pattern.id }],
      humanDispositions: [],
      triageFindings: [{
        id: `finding-${hash(`adapter-execution\0${pattern.id}`).slice(0, 20)}`,
        patternId: pattern.id,
        loopId: pattern.id,
        bucket: 'inbox',
        sourceAdapter: 'adapter-execution',
        source: 'adapter-execution',
        subject: pattern.id,
        message: `Adapter execution failed: ${message}`,
        status: 'open',
        humanOverride: null,
      }],
      managedAdapters: ['adapter-execution'],
    };
  }
  const finished = finishRun(root, [prepared.runId], { emit: false, payloadOverride: runnerResult });
  const result = { ...finished, command: 'run.execute' };
  output(result, json, `loop run execute: ${result.runId} -> ${result.outcome}`);
  return result;
}

function blockDecision(action, trigger, reason, paths = [], extra = {}) {
  return { allowed: false, action, trigger, reason, matchedPaths: paths, ...extra };
}

function l2GateDecision(root, pattern, args) {
  const action = option(args, '--action');
  if (!pattern.enabled) return blockDecision(action, 'disabled', 'pattern is disabled');
  if (pattern.level !== 'L2' || pattern.mode !== 'assisted') return blockDecision(action, 'l2-required', `${action} requires an assisted L2 pattern`);
  const state = readState(root, readConfig(root));
  if (state.patterns[pattern.id]?.paused) return blockDecision(action, 'paused', state.patterns[pattern.id].pauseReason ?? 'pattern paused');
  if (state.patterns[pattern.id]?.budgetMode === 'report-only') return blockDecision(action, 'budget-report-only', 'budget threshold downgraded the controller to report-only');
  const context = l2Context(root, pattern, args, { requirePaths: action === 'maker' });
  if (context.error) return blockDecision(action, context.error.trigger, context.error.reason, context.error.paths);
  if (action === 'maker') {
    const pathFailure = l2PathDecision(pattern, context.task, context.lock, context.paths);
    if (pathFailure) return blockDecision(action, pathFailure.trigger, pathFailure.reason, pathFailure.paths);
    const ledger = existsSync(ledgerPath(root, context.runId)) ? parseJson(ledgerPath(root, context.runId)) : { attempts: [] };
    const breaker = breakerDecision(pattern, ledger);
    if (breaker.blocked) return blockDecision(action, breaker.trigger, breaker.reason, context.paths);
    const makerSession = [...(ledger.attempts ?? [])].reverse().find((attempt) => attempt.makerSession)?.makerSession;
    if (!makerSession || !SAFE_ID.test(makerSession)) return blockDecision(action, 'maker-session', 'maker gate requires a recorded maker session', context.paths);
    return {
      allowed: true,
      action,
      trigger: 'ok',
      reason: 'maker preflight passed',
      matchedPaths: [],
      context,
      evidence: {
        schemaVersion: 1,
        action,
        allowed: true,
        at: now(),
        runId: context.runId,
        loopId: pattern.id,
        paths: context.paths,
        taskId: context.taskId,
        approvedVersion: context.task.approvedVersion,
        makerSession,
        worktree: context.worktree.item.path,
        baseSha: context.runRecord.baseSha,
      },
    };
  }
  const maker = latestGateDecision(context.runRecord, 'maker');
  if (!maker) return blockDecision(action, 'maker-receipt', 'a passing maker preflight receipt is required');
  if (maker.taskId !== context.taskId || maker.approvedVersion !== context.task.approvedVersion) {
    return blockDecision(action, 'task-drift', 'maker receipt does not match the current approved task');
  }
  if (action === 'scope') {
    if (option(args, '--paths-from', '') !== 'git') return blockDecision(action, 'paths-from-git', 'scope gate requires --paths-from git');
    const binding = worktreeSnapshot(root, context.worktree);
    const pathFailure = l2PathDecision(pattern, context.task, context.lock, binding.changedFiles);
    if (pathFailure) return blockDecision(action, pathFailure.trigger, pathFailure.reason, pathFailure.paths);
    return {
      allowed: true,
      action,
      trigger: 'ok',
      reason: 'post-write scope gate passed',
      matchedPaths: [],
      context,
      evidence: {
        schemaVersion: 1,
        action,
        allowed: true,
        at: now(),
        runId: context.runId,
        loopId: pattern.id,
        taskId: context.taskId,
        approvedVersion: context.task.approvedVersion,
        paths: binding.changedFiles,
        changedFiles: binding.changedFiles,
        baseSha: binding.baseSha,
        headSha: binding.headSha,
        diffHash: binding.diffHash,
        worktree: context.worktree.item.path,
      },
    };
  }
  const scope = latestGateDecision(context.runRecord, 'scope');
  if (!scope) return blockDecision(action, 'scope-receipt', 'a passing scope receipt is required');
  const receiptPath = verificationPath(root, context.runId);
  if (!existsSync(receiptPath)) return blockDecision(action, 'verification-receipt', 'an independent verification receipt is required');
  const receipt = parseJson(receiptPath);
  const expectedIds = pattern.checks;
  const actualIds = Array.isArray(receipt.checks) ? receipt.checks.map(({ id }) => id) : [];
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])
  ) return blockDecision(action, 'check-receipt', 'verification check ids must exactly match the pattern declaration');
  const expectedCwd = context.worktree.item.path;
  const malformed = receipt.checks.some((check) => (
    typeof check.program !== 'string'
    || !check.program
    || !Array.isArray(check.args)
    || check.cwd !== expectedCwd
    || check.exitCode !== 0
    || check.status !== 'pass'
    || typeof check.startedAt !== 'string'
    || typeof check.finishedAt !== 'string'
    || typeof check.evidence !== 'string'
    || !check.evidence
  ));
  if (malformed) return blockDecision(action, 'worktree-receipt', 'verification checks must be passing command receipts from the run worktree');
  const commandDrift = receipt.checks.some((check) => {
    const declared = resolveCheck(context.worktree.path, check.id, { runId: context.runId });
    if (!declared) return true;
    const configuredCwd = declared.cwd ?? '.';
    const expectedCwd = normalized(join(context.worktree.item.path, configuredCwd === '.' ? '' : configuredCwd)).replace(/\/$/, '');
    return (
      check.program !== declared.program
      || JSON.stringify(check.args) !== JSON.stringify(declared.args)
      || check.cwd !== expectedCwd
    );
  });
  if (commandDrift) return blockDecision(action, 'check-command-drift', 'verification commands do not match the declared check configuration');
  if (receipt.checksHash !== hash(JSON.stringify(receipt.checks))) return blockDecision(action, 'check-receipt', 'verification checks hash is invalid');
  if (
    receipt.runId !== context.runId
    || receipt.taskId !== context.taskId
    || receipt.configHash !== context.runRecord.configHash
    || receipt.baseSha !== scope.baseSha
    || receipt.headSha !== scope.headSha
    || receipt.diffHash !== scope.diffHash
  ) return blockDecision(action, 'diff-drift', 'verification receipt is not bound to the current run, task, SHA, and diff');
  const makerSession = context.runRecord.makerSession ?? maker.makerSession;
  if (!receipt.verifierSession || receipt.verifierSession === makerSession) return blockDecision(action, 'independent-verifier', 'verifier session must be independent from maker session');
  const current = worktreeSnapshot(root, context.worktree);
  if (current.headSha !== scope.headSha || current.diffHash !== scope.diffHash) return blockDecision(action, 'diff-drift', 'worktree changed after scope verification');
  return {
    allowed: true,
    action,
    trigger: 'ok',
    reason: 'proposal evidence chain passed',
    matchedPaths: [],
    context,
    evidence: {
      schemaVersion: 1,
      action,
      allowed: true,
      at: now(),
      runId: context.runId,
      loopId: pattern.id,
      taskId: context.taskId,
      approvedVersion: context.task.approvedVersion,
      baseSha: scope.baseSha,
      headSha: scope.headSha,
      diffHash: scope.diffHash,
      checksHash: receipt.checksHash,
      makerSession,
      verifierSession: receipt.verifierSession,
      worktree: context.worktree.item.path,
    },
  };
}

function gateDecision(root, pattern, args) {
  const action = option(args, '--action');
  if (!GATE_ACTIONS.has(action)) fail(`--action must be one of ${[...GATE_ACTIONS].join(', ')}.`);
  if (pattern.level === 'L2' && action === 'write') return { allowed: false, action, trigger: 'maker-gate-required', reason: 'legacy write gate is disabled; run the maker preflight gate before writing', matchedPaths: [] };
  let paths = option(args, '--paths', '').split(',').map((item) => normalized(item.trim())).filter(Boolean);
  if (args.includes('--paths-from')) {
    if (option(args, '--paths-from') !== 'git') fail('--paths-from currently supports only git.');
    paths = changedPaths(root);
  }
  const state = readState(root, readConfig(root));
  if (!pattern.enabled) return { allowed: false, action, trigger: 'disabled', reason: 'pattern is disabled', matchedPaths: paths };
  if (state.patterns[pattern.id]?.paused) return { allowed: false, action, trigger: 'paused', reason: state.patterns[pattern.id].pauseReason ?? 'pattern paused', matchedPaths: paths };
  if (state.patterns[pattern.id]?.budgetMode === 'report-only' && ['write', 'push', 'merge'].includes(action)) return { allowed: false, action, trigger: 'budget-report-only', reason: '80% budget threshold downgraded the controller to report-only', matchedPaths: paths };
  if (['write', 'push', 'merge'].includes(action) && paths.length === 0) return { allowed: false, action, trigger: 'paths-required', reason: `${action} requires explicit changed paths`, matchedPaths: [] };
  const unsafePaths = paths.filter((path) => !safeRelative(path));
  if (unsafePaths.length) return { allowed: false, action, trigger: 'unsafe-path', reason: 'paths must be safe repository-relative paths', matchedPaths: unsafePaths };
  const denyHits = matching(paths, pattern.scope.denyPaths);
  if (denyHits.length) return { allowed: false, action, trigger: 'denylist', reason: 'changed paths match denylist', matchedPaths: denyHits };
  if (paths.length > pattern.scope.maxChangedFiles) return { allowed: false, action, trigger: 'file-count', reason: `${paths.length} exceeds maxChangedFiles ${pattern.scope.maxChangedFiles}`, matchedPaths: paths };
  if (pattern.level === 'L1' && ['write', 'push', 'merge'].includes(action)) return { allowed: false, action, trigger: 'l1-report-only', reason: 'L1 cannot mutate governed paths', matchedPaths: paths };
  const policy = pattern.gates[action];
  if (policy === 'never') return { allowed: false, action, trigger: 'policy-never', reason: `${action} is disabled by policy`, matchedPaths: paths };
  if (policy === 'human' && !option(args, '--human-evidence', '')) return { allowed: false, action, trigger: 'human-approval', reason: `${action} requires --human-evidence`, matchedPaths: paths };
  if (policy === 'approved-task' || (pattern.level === 'L2' && ['write', 'push'].includes(action))) {
    const taskId = option(args, '--task', '');
    const task = governanceFor(root, taskId);
    if (!approvedTask(task)) return { allowed: false, action, trigger: 'approved-task', reason: 'current approved task evidence is required', matchedPaths: paths };
    const ownershipViolations = taskOwnsPaths(task, paths);
    if (ownershipViolations.length) return { allowed: false, action, trigger: 'task-path-ownership', reason: 'changed paths are outside participating role ownership', matchedPaths: ownershipViolations };
  }
  if (pattern.level === 'L2' && ['write', 'push'].includes(action)) {
    const maker = option(args, '--maker-session', '');
    const verifier = option(args, '--verifier-session', '');
    if (!maker || !verifier || maker === verifier || option(args, '--verifier-status', '') !== 'pass') return { allowed: false, action, trigger: 'independent-verifier', reason: 'distinct maker/verifier sessions and passing verifier are required', matchedPaths: paths };
    const runId = option(args, '--run-id', '');
    if (!runId || !existsSync(ledgerPath(root, runId))) return { allowed: false, action, trigger: 'attempt-ledger', reason: 'L2 write requires --run-id with an attempt ledger', matchedPaths: paths };
    const runRecord = existsSync(runPath(root, runId)) ? parseJson(runPath(root, runId)) : null;
    if (!runRecord || runRecord.loopId !== pattern.id || runRecord.configHash !== configDigest(readConfig(root))) return { allowed: false, action, trigger: 'run-evidence', reason: 'L2 write requires a current run for this pattern', matchedPaths: paths };
    const breaker = breakerDecision(pattern, parseJson(ledgerPath(root, runId)));
    if (breaker.blocked) return { allowed: false, action, trigger: breaker.trigger, reason: breaker.reason, matchedPaths: paths };
    const worktree = worktreeManifest(root).worktrees.find((item) => item.runId === runId && item.pattern === pattern.id && item.status === 'active');
    if (!worktree || !existsSync(safeWorktreePath(root, join(root, worktree.path)))) return { allowed: false, action, trigger: 'active-worktree', reason: 'L2 write requires an active isolated worktree', matchedPaths: paths };
    const lock = lockRecords(root).find((item) => item.owner === runId && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
    if (!lock || paths.some((path) => !lock.paths.some((held) => globToRegex(held).test(path)))) return { allowed: false, action, trigger: 'path-lock', reason: 'L2 write requires a live lock covering every changed path', matchedPaths: paths };
  }
  return { allowed: true, action, trigger: 'ok', reason: 'within loop policy', matchedPaths: [] };
}

function commandGate(root, args) {
  const json = args.includes('--json');
  const gateArgs = args[0] === 'check' ? args.slice(1) : args;
  const id = positionals(gateArgs, ['--action', '--paths', '--paths-from', '--task', '--run-id', '--maker-session', '--verifier-session', '--verifier-status', '--human-evidence'])[0];
  if (!id) fail('loop gate requires a pattern id.');
  const pattern = patternById(readConfig(root), id);
  const action = option(gateArgs, '--action');
  if (['maker', 'scope'].includes(action) || (action === 'proposal' && pattern.level === 'L2')) {
    return withMutex(root, `l2-gate-${option(gateArgs, '--run-id', 'missing')}`, () => {
      const decision = l2GateDecision(root, pattern, gateArgs);
      const result = {
        ok: decision.allowed,
        allowed: decision.allowed,
        command: 'gate.check',
        loopId: id,
        ...decision,
        context: undefined,
        evidence: undefined,
        ...(decision.evidence ?? {}),
      };
      if (!decision.allowed) policyBlock(result, json);
      persistGateDecision(root, decision.context, decision.evidence);
      output(result, json, `loop gate: PASS ${id}/${decision.action}`);
      return result;
    });
  }
  const decision = gateDecision(root, pattern, gateArgs);
  const result = { ok: decision.allowed, allowed: decision.allowed, command: 'gate.check', loopId: id, ...decision };
  if (!decision.allowed) policyBlock(result, json);
  const runId = option(gateArgs, '--run-id', '');
  if (runId && existsSync(runPath(root, runId))) {
    const record = parseJson(runPath(root, runId));
    record.gateDecisions ??= [];
    const task = governanceFor(root, option(gateArgs, '--task', ''));
    record.gateDecisions.push({ action: decision.action, allowed: true, at: now(), paths: option(gateArgs, '--paths', '').split(',').filter(Boolean), taskId: task?.taskId ?? null, approvedVersion: task?.approvedVersion ?? null });
    writeJson(runPath(root, runId), record);
  }
  output(result, json, `loop gate: PASS ${id}/${decision.action}`);
}

function commandPause(root, args) {
  rootOnly();
  const json = args.includes('--json');
  const id = positionals(args, ['--reason', '--actor'])[0];
  const reason = option(args, '--reason');
  if (!id || !reason) fail('loop pause requires <id> --reason <text>.');
  const config = readConfig(root);
  patternById(config, id);
  const state = readState(root, config);
  state.patterns[id].paused = true;
  state.patterns[id].pauseReason = reason;
  state.patterns[id].pausedBy = option(args, '--actor', 'human');
  state.patterns[id].pausedAt = now();
  writeState(root, config, state);
  output({ ok: true, command: 'pause', loopId: id, paused: true, reason }, json, `loop pause: ${id}`);
}

function commandResume(root, args) {
  rootOnly();
  const json = args.includes('--json');
  const id = positionals(args, ['--by', '--evidence'])[0];
  const by = option(args, '--by');
  const evidence = option(args, '--evidence');
  if (!id || !by || !evidence) fail('loop resume requires <id> --by <human> --evidence <text>.');
  const config = readConfig(root);
  patternById(config, id);
  const state = readState(root, config);
  state.patterns[id].paused = false;
  state.patterns[id].pauseReason = null;
  state.patterns[id].resumedBy = by;
  state.patterns[id].resumeEvidence = evidence;
  state.patterns[id].resumedAt = now();
  state.patterns[id].killSwitchDrill = true;
  state.patterns[id].killSwitchDrillAt = state.patterns[id].resumedAt;
  writeState(root, config, state);
  output({ ok: true, command: 'resume', loopId: id, paused: false, by, evidence }, json, `loop resume: ${id}`);
}

function commandPromote(root, args) {
  rootOnly();
  const json = args.includes('--json');
  const id = positionals(args, ['--to', '--by', '--evidence'])[0];
  const to = option(args, '--to');
  const by = option(args, '--by');
  const evidence = option(args, '--evidence');
  if (to === 'L3') policyBlock({ ok: false, allowed: false, command: 'promote', loopId: id, trigger: 'l3-out-of-scope', reason: 'V1 does not implement L3', matchedPaths: [] }, json);
  if (!LEVELS.has(to) || !id || !by || !evidence) fail('loop promote requires <id> --to L1|L2 --by <human> --evidence <text>.');
  const config = readConfig(root);
  const pattern = patternById(config, id);
  const state = readState(root, config);
  if (to === 'L2') {
    const structural = pattern.isolation.mode === 'worktree' && pattern.roles.independentVerifier && pattern.isolation.lockPaths.length && pattern.gates.merge === 'never'
      && existsSync(join(root, 'loop-budget.md')) && existsSync(join(root, 'loop-constraints.md')) && existsSync(join(root, 'gate.yaml'));
    const runs = logEntries(root, config).filter((entry) => entry.loopId === id && entry.level === 'L1' && !['failed', 'escalated'].includes(entry.outcome));
    const timestamps = runs.map((entry) => Date.parse(entry.finishedAt ?? '')).filter(Number.isFinite).sort((left, right) => left - right);
    const spanDays = timestamps.length > 1 ? (timestamps.at(-1) - timestamps[0]) / 86400000 : 0;
    const evidenceComplete = runs.length > 0 && runs.every((entry) => entry.evidenceComplete === true && typeof entry.evidenceHash === 'string' && entry.evidenceHash.length === 64);
    const unauthorizedWrites = runs.reduce((sum, entry) => sum + Number(entry.unauthorizedWrites ?? 0), 0);
    const findings = runs.reduce((sum, entry) => sum + Number(entry.findings ?? 0), 0);
    const falsePositives = runs.reduce((sum, entry) => sum + Number(entry.falsePositives ?? 0), 0);
    const falsePositiveRate = findings === 0 ? 0 : falsePositives / findings;
    const killSwitchDrill = state.patterns[id]?.killSwitchDrill === true || runs.some((entry) => entry.killSwitchDrill === true);
    const gaps = [];
    if (!structural) gaps.push('worktree/lock/verifier/budget/constraints/gate prerequisites');
    if (runs.length < 10) gaps.push(`valid L1 runs ${runs.length}/10`);
    if (spanDays < 5) gaps.push(`L1 observation span ${spanDays.toFixed(1)}/5 days`);
    if (!evidenceComplete) gaps.push('evidence completeness below 100%');
    if (unauthorizedWrites !== 0) gaps.push(`unauthorized writes ${unauthorizedWrites}`);
    if (falsePositiveRate > 0.2) gaps.push(`false-positive rate ${(falsePositiveRate * 100).toFixed(1)}% > 20%`);
    if (!killSwitchDrill) gaps.push('kill-switch drill missing');
    if (gaps.length) policyBlock({ ok: false, allowed: false, command: 'promote', loopId: id, trigger: 'l2-readiness', reason: gaps.join('; '), matchedPaths: [] }, json);
  }
  pattern.level = to;
  pattern.mode = to === 'L1' ? 'report-only' : 'assisted';
  pattern.promotion = { level: to, by, evidence, at: now() };
  writeJson(configPath(root), config);
  state.patterns[id].level = to;
  writeState(root, config, state);
  output({ ok: true, command: 'promote', loopId: id, level: to, by, evidence }, json, `loop promote: ${id} -> ${to}`);
}

function commandInbox(root, args) {
  const json = args.includes('--json');
  const action = positionals(args, ['--message', '--id', '--by', '--evidence'])[0] ?? 'list';
  const config = readConfig(root);
  const state = readState(root, config);
  if (action === 'list') {
    output({ ok: true, command: 'inbox.list', items: state.inbox }, json, state.inbox.length ? state.inbox.map((item) => `${item.id} [${item.status}] ${item.loopId}: ${item.message}`).join('\n') : 'loop inbox: empty');
    return;
  }
  if (action === 'add') {
    const id = positionals(args, ['--message', '--id', '--by', '--evidence'])[1];
    const message = option(args, '--message');
    if (!id || !message) fail('loop inbox add requires <pattern> --message <text>.');
    patternById(config, id);
    const seenAt = now();
    const item = { id: option(args, '--id', `inbox-${randomUUID().slice(0, 8)}`), loopId: id, message, source: 'inbox.add', firstSeen: seenAt, lastSeen: seenAt, status: 'open', humanOverride: null, resolvedAt: null };
    if (!SAFE_ID.test(item.id)) fail('inbox id must be a safe lowercase id.');
    const existing = state.inbox.find((entry) => entry.id === item.id);
    if (existing) {
      if (existing.loopId !== id || existing.message !== message) fail(`inbox id ${item.id} already exists with different content.`);
      existing.firstSeen ??= existing.createdAt ?? seenAt;
      existing.lastSeen = seenAt;
      existing.source ??= 'inbox.add';
      existing.humanOverride ??= null;
      writeState(root, config, state);
      output({ ok: true, command: 'inbox.add', item: existing, status: 'duplicate' }, json, `loop inbox add: duplicate ${item.id}`);
      return;
    }
    state.inbox.push(item);
    writeState(root, config, state);
    output({ ok: true, command: 'inbox.add', item }, json, `loop inbox add: ${item.id}`);
    return;
  }
  if (action === 'resolve') {
    rootOnly();
    const itemId = positionals(args, ['--message', '--id', '--by', '--evidence'])[1] ?? option(args, '--id');
    const by = option(args, '--by');
    const evidence = option(args, '--evidence');
    const item = state.inbox.find((entry) => entry.id === itemId);
    if (!item || !by || !evidence) fail('loop inbox resolve requires <item-id> --by <human> --evidence <text>.');
    item.status = 'resolved'; item.resolvedAt = now(); item.resolvedBy = by; item.evidence = evidence;
    writeState(root, config, state);
    output({ ok: true, command: 'inbox.resolve', item }, json, `loop inbox resolve: ${item.id}`);
    return;
  }
  if (action === 'decide') {
    rootOnly();
    const itemId = positionals(args, ['--message', '--id', '--by', '--evidence', '--decision'])[1];
    const decision = option(args, '--decision');
    if (!['accept', 'dismiss', 'defer'].includes(decision)) fail('loop inbox decide requires --decision accept, dismiss, or defer.');
    const item = state.inbox.find((entry) => entry.id === itemId);
    if (!item) fail(`inbox item not found: ${itemId}.`);
    item.decision = decision;
    item.decidedAt = now();
    item.decidedBy = option(args, '--by', 'user');
    item.status = decision === 'defer' ? 'open' : 'resolved';
    item.resolvedAt = item.status === 'resolved' ? item.decidedAt : null;
    writeState(root, config, state);
    output({ ok: true, command: 'inbox.decide', findingId: itemId, decision, item }, json, `loop inbox decide: ${itemId} -> ${decision}`);
    return;
  }
  fail(`unknown inbox action: ${action}.`);
}

function worktreeManifest(root) {
  const path = worktreeManifestPath(root);
  return existsSync(path) ? parseJson(path) : { schemaVersion: 1, worktrees: [] };
}

function writeWorktreeManifest(root, value) { writeJson(worktreeManifestPath(root), value); }

function lockRecords(root) {
  const directory = lockDirectory(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => parseJson(join(directory, name)));
}

function pathsOverlap(left, right) {
  if (left === right || left === '**' || right === '**') return true;
  const leftPrefix = left.split('*')[0];
  const rightPrefix = right.split('*')[0];
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix) || globToRegex(left).test(right) || globToRegex(right).test(left);
}

function acquireLock(root, owner, paths, ttlSeconds) {
  if (!SAFE_ID.test(owner)) fail('lock owner must be a safe lowercase id.');
  if (!paths.length) fail('lock paths must not be empty.');
  return withMutex(root, 'worktree-locks', () => {
    const current = Date.now();
    for (const record of lockRecords(root)) {
      if (record.owner === owner) continue;
      const expired = record.expiresAt && Date.parse(record.expiresAt) <= current;
      if (expired) {
        if (SAFE_ID.test(record.owner ?? '')) rmSync(join(lockDirectory(root), `${record.owner}.json`), { force: true });
        continue;
      }
      if (paths.some((path) => record.paths.some((held) => pathsOverlap(path, held)))) return { ok: false, conflict: record };
    }
    const record = { schemaVersion: 1, owner, paths, lockedAt: now(), expiresAt: ttlSeconds ? new Date(current + ttlSeconds * 1000).toISOString() : null };
    writeJson(join(lockDirectory(root), `${owner}.json`), record);
    return { ok: true, record };
  });
}

function releaseLock(root, owner) {
  if (!SAFE_ID.test(owner)) fail('lock owner must be a safe lowercase id.');
  const path = join(lockDirectory(root), `${owner}.json`);
  if (existsSync(path)) rmSync(path);
}

function safeWorktreePath(root, path) {
  const base = resolve(worktreeRoot(root), 'trees');
  const target = resolve(path);
  if (target === base || !target.startsWith(`${base}${sep}`)) fail(`refusing worktree operation outside ${normalized(relative(root, base))}.`);
  return target;
}

function commandWorktree(root, args) {
  const json = args.includes('--json');
  const [action] = positionals(args, ['--run-id', '--pattern', '--base', '--status', '--owner', '--paths', '--ttl']);
  if (!action) fail('loop worktree requires create, mark, list, cleanup, lock, unlock, or locks.');
  if (action === 'lock') {
    const owner = option(args, '--owner');
    const paths = option(args, '--paths').split(',').map((item) => normalized(item.trim())).filter(Boolean);
    const result = acquireLock(root, owner, paths, integerOption(args, '--ttl', 0));
    if (!result.ok) policyBlock({ ok: false, allowed: false, command: 'worktree.lock', trigger: 'lock-conflict', reason: `paths overlap lock owned by ${result.conflict.owner}`, matchedPaths: result.conflict.paths }, json);
    output({ ok: true, command: 'worktree.lock', lock: result.record }, json, `loop worktree lock: ${owner}`);
    return;
  }
  if (action === 'unlock') {
    const owner = option(args, '--owner');
    releaseLock(root, owner);
    output({ ok: true, command: 'worktree.unlock', owner }, json, `loop worktree unlock: ${owner}`);
    return;
  }
  if (action === 'locks') {
    const locks = lockRecords(root).map((record) => ({ ...record, expired: Boolean(record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) }));
    output({ ok: true, command: 'worktree.locks', locks }, json, locks.length ? locks.map((lock) => `${lock.owner}: ${lock.paths.join(', ')}${lock.expired ? ' (expired)' : ''}`).join('\n') : 'loop worktree locks: none');
    return;
  }
  const manifest = worktreeManifest(root);
  if (action === 'list') {
    output({ ok: true, command: 'worktree.list', worktrees: manifest.worktrees }, json, manifest.worktrees.length ? manifest.worktrees.map((item) => `${item.runId} [${item.status}] ${item.path}`).join('\n') : 'loop worktree list: empty');
    return;
  }
  if (action === 'create') {
    const actionPositionals = positionals(args, ['--run-id', '--pattern', '--base', '--status', '--owner', '--paths', '--ttl']);
    const runId = option(args, '--run-id', actionPositionals[1] ?? '');
    const patternId = option(args, '--pattern');
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(patternId)) fail('worktree create requires safe --run-id and --pattern.');
    if (manifest.worktrees.some((item) => item.runId === runId && item.status === 'active')) fail(`active worktree already exists for ${runId}.`);
    const pattern = patternById(readConfig(root), patternId);
    const lock = acquireLock(root, runId, pattern.isolation.lockPaths, pattern.isolation.lockTtlSeconds ?? 21600);
    if (!lock.ok) policyBlock({ ok: false, allowed: false, command: 'worktree.create', trigger: 'lock-conflict', reason: `paths overlap lock owned by ${lock.conflict.owner}`, matchedPaths: lock.conflict.paths }, json);
    const path = safeWorktreePath(root, join(worktreeRoot(root), 'trees', runId));
    mkdirSync(dirname(path), { recursive: true });
    const branch = `codex/loop/${patternId}/${runId}`;
    const result = run('git', ['worktree', 'add', '-b', branch, path, option(args, '--base', 'HEAD')], root);
    if (!result.ok) { releaseLock(root, runId); fail(`git worktree add failed: ${result.stderr.trim() || result.error}.`); }
    const item = { runId, pattern: patternId, path: normalized(relative(root, path)), branch, status: 'active', createdAt: now(), updatedAt: now() };
    manifest.worktrees.push(item); writeWorktreeManifest(root, manifest);
    output({ ok: true, command: 'worktree.create', worktree: item, lock: lock.record }, json, `loop worktree create: ${item.path}`);
    return;
  }
  if (action === 'mark') {
    const runId = option(args, '--run-id');
    const status = option(args, '--status');
    if (!WORKTREE_STATUSES.has(status)) fail(`--status must be one of ${[...WORKTREE_STATUSES].join(', ')}.`);
    const item = manifest.worktrees.find((entry) => entry.runId === runId);
    if (!item) fail(`worktree not found: ${runId}.`);
    item.status = status; item.updatedAt = now(); writeWorktreeManifest(root, manifest);
    output({ ok: true, command: 'worktree.mark', worktree: item }, json, `loop worktree mark: ${runId} -> ${status}`);
    return;
  }
  if (action === 'cleanup') {
    const runId = option(args, '--run-id', '');
    const statuses = option(args, '--status', 'rejected,escalated,stale').split(',');
    const removed = []; const skipped = [];
    for (const item of manifest.worktrees) {
      if ((runId && item.runId !== runId) || (!runId && !statuses.includes(item.status))) continue;
      const path = safeWorktreePath(root, join(root, item.path));
      const result = run('git', ['worktree', 'remove', path], root);
      if (!result.ok) { skipped.push({ runId: item.runId, reason: result.stderr.trim() || result.error }); continue; }
      releaseLock(root, item.runId); removed.push(item.runId);
    }
    manifest.worktrees = manifest.worktrees.filter((item) => !removed.includes(item.runId)); writeWorktreeManifest(root, manifest);
    output({ ok: skipped.length === 0, command: 'worktree.cleanup', removed, skipped }, json, `loop worktree cleanup: removed=${removed.length} skipped=${skipped.length}`);
    if (skipped.length) process.exitCode = 1;
    return;
  }
  fail(`unknown worktree action: ${action}.`);
}

function commandMetrics(root, args) {
  const json = args.includes('--json');
  const id = positionals(args, ['--days'])[0] ?? '';
  const daysRaw = option(args, '--days', '');
  const windowDays = daysRaw === '' ? null : Number(daysRaw);
  if (windowDays !== null && (!Number.isSafeInteger(windowDays) || windowDays <= 0)) fail('--days must be a positive integer.');
  const config = readConfig(root);
  const state = readState(root, config);
  const selected = id ? [patternById(config, id)] : config.patterns;
  const generatedAt = now();
  const generatedAtMs = Date.parse(generatedAt);
  const entries = logEntries(root, config);
  const windowEntries = windowDays === null ? entries : entries.filter((entry) => {
    const timestamp = Date.parse(entry.finishedAt ?? entry.startedAt ?? '');
    return Number.isFinite(timestamp) && timestamp >= generatedAtMs - windowDays * 24 * 60 * 60 * 1000 && timestamp <= generatedAtMs;
  });
  const patterns = selected.map((pattern) => patternMetrics(root, pattern, state, windowEntries));
  const result = { ok: true, command: 'metrics', generatedAt, ...(windowDays === null ? {} : { windowDays }), patterns };
  output(result, json, patterns.map((item) => `${item.id}: runs=${item.runs} tokensToday=${item.tokensToday} escalated=${item.outcomes.escalated}`).join('\n'));
}

function usage() {
  console.log(`Usage: harness loop <command> [options]\n\nCommands:\n  init <id> --pattern <pattern> [--dry-run] [--json]\n  validate [--strict] [--json]\n  doctor [--strict] [--json]\n  status [pattern] [--json]\n  sync [--check|--write] [--json]\n  run prepare <pattern> [--run-id id] [--slot key] [--trigger manual|schedule|event] [--json]\n  run execute <pattern> [--run-id id] [--slot key] [--trigger manual|schedule|event] [--actor value] [--json]\n  run attempt <run-id> --action text --outcome success|failure|noop [--error text] [--tokens n] [--json]\n  run verify <run-id> --session <independent-session> [--json]\n  run recover [--stale-after seconds] [--json]\n  run finish <run-id> --result <json|file> [--json]\n    compatibility: --outcome no-op|report-only|proposal|success|failed|escalated plus metric flags\n  inbox list [--json]\n  inbox add <pattern> --message text [--id finding-id] [--json]\n  inbox decide <finding-id> --decision accept|dismiss|defer [--by human] [--json]\n  inbox resolve <finding-id> --by human --evidence text [--json]\n  gate check <pattern> --action report|maker|scope|proposal|push|merge [--run-id id] [--task id] [--paths csv|--paths-from git] [--json]\n  pause <pattern> --reason text [--actor human] [--json]\n  resume <pattern> --by human --evidence text [--json]\n  promote <pattern> --to L1|L2 --by human --evidence text [--json]\n  worktree create [run-id|--run-id id] --pattern <pattern> [--base ref] [--json]\n  worktree mark --run-id id --status active|proposed|rejected|escalated|merged|stale [--json]\n  worktree list|cleanup [options] [--json]\n  worktree lock --owner id --paths csv [--ttl seconds] [--json]\n  worktree unlock --owner id [--json]\n  worktree locks [--json]\n  metrics [pattern] [--days N] [--json]\n\nL2 promotion requires >=10 valid L1 runs across >=5 days, 100% evidence, zero unauthorized writes, <=20% false positives, a kill-switch drill, configured isolation/gates, and named human evidence.\nExit codes: 0 success/no-op; 1 configuration or execution error; 2 policy block or human escalation.`);
}

export function commandLoop(root, args) {
  const [command, ...rest] = args;
  if (!command || ['--help', '-h'].includes(command)) { usage(); return; }
  switch (command) {
    case 'init': commandInit(root, rest); break;
    case 'validate': commandValidate(root, rest); break;
    case 'doctor': commandDoctor(root, rest); break;
    case 'status': commandStatus(root, rest); break;
    case 'sync': commandSync(root, rest); break;
    case 'run': {
      const [action, ...runArgs] = rest;
      if (action === 'prepare') commandPrepare(root, runArgs);
      else if (action === 'execute') commandExecute(root, runArgs);
      else if (action === 'attempt') commandAttempt(root, runArgs);
      else if (action === 'verify') commandVerify(root, runArgs);
      else if (action === 'recover') commandRecover(root, runArgs);
      else if (action === 'finish') commandFinish(root, runArgs);
      else fail('loop run requires prepare, execute, attempt, verify, recover, or finish.');
      break;
    }
    case 'inbox': commandInbox(root, rest); break;
    case 'gate': commandGate(root, rest); break;
    case 'pause': commandPause(root, rest); break;
    case 'resume': commandResume(root, rest); break;
    case 'promote': commandPromote(root, rest); break;
    case 'worktree': commandWorktree(root, rest); break;
    case 'metrics': commandMetrics(root, rest); break;
    default: usage(); fail(`unknown loop command: ${command}.`);
  }
}
