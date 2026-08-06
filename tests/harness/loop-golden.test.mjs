import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOLDEN_ROOT = join(REPOSITORY, 'evals', 'golden');
const MANIFEST_PATH = join(GOLDEN_ROOT, 'loop-safety-v1.json');
const PATTERN_SCENARIOS_PATH = join(GOLDEN_ROOT, 'pattern-scenarios-v1.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('loop safety golden manifest is complete and requires a 100% pass rate', () => {
  const manifest = readJson(MANIFEST_PATH);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.suiteId, 'loop-safety-v1');
  assert.equal(manifest.requiredPassRate, 1);
  assert.ok(Array.isArray(manifest.cases));
  assert.ok(manifest.cases.length >= 17);

  const ids = new Set();
  const coveredAreas = new Set();
  for (const scenario of manifest.cases) {
    assert.match(scenario.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(ids.has(scenario.id), false, `duplicate golden id: ${scenario.id}`);
    ids.add(scenario.id);
    assert.equal(scenario.severity, 'P0', `${scenario.id} must remain a P0 safety gate`);
    assert.equal(typeof scenario.commandFamily, 'string');
    assert.ok(scenario.commandFamily.length > 0);
    assert.equal(typeof scenario.expected, 'object');
    assert.ok([0, 1, 2].includes(scenario.expected.exitCode));
    coveredAreas.add(scenario.area);
    if (scenario.fixture) {
      assert.equal(readFileSync(join(GOLDEN_ROOT, scenario.fixture), 'utf8').length > 0, true);
    }
  }

  for (const area of [
    'schema',
    'sync',
    'run',
    'budget',
    'gate',
    'inbox',
    'lifecycle',
    'isolation',
    'verification',
    'evidence',
    'metrics',
    'distribution',
  ]) assert.equal(coveredAreas.has(area), true, `missing golden area: ${area}`);
});

test('run-log golden fixtures distinguish valid, malformed, and sensitive inputs', () => {
  const valid = readFileSync(join(GOLDEN_ROOT, 'fixtures', 'valid-run-log.md'), 'utf8');
  const malformed = readFileSync(join(GOLDEN_ROOT, 'fixtures', 'malformed-run-log.md'), 'utf8');
  const sensitive = readFileSync(join(GOLDEN_ROOT, 'fixtures', 'sensitive-run-log.md'), 'utf8');
  const marker = '<!-- Loop appends below this line -->';

  for (const contents of [valid, malformed, sensitive]) assert.ok(contents.includes(marker));
  const validEntries = valid.split(/\r?\n/).filter((line) => line.startsWith('{')).map(JSON.parse);
  assert.equal(validEntries.length, 2);
  assert.deepEqual(validEntries.map((entry) => entry.outcome), ['no-op', 'escalated']);
  assert.equal(validEntries.reduce((total, entry) => total + entry.tokens, 0), 250);
  assert.throws(() => JSON.parse(malformed.split(/\r?\n/).find((line) => line.startsWith('{this'))));
  assert.match(sensitive, /example-secret-value/);
  assert.match(sensitive, /Bearer example-token-value/);
});

test('every built-in pattern has the complete mandatory golden scenario set', () => {
  const suite = readJson(PATTERN_SCENARIOS_PATH);
  assert.equal(suite.schemaVersion, 1);
  assert.equal(suite.requiredPassRate, 1);
  assert.deepEqual(suite.patterns.map(({ id }) => id), ['harness-health', 'daily-triage', 'ci-sweeper']);
  assert.deepEqual(suite.patterns.map(({ enabled }) => enabled), [true, true, false]);
  assert.deepEqual(suite.patterns.map(({ level }) => level), ['L1', 'L1', 'L2']);
  for (const pattern of suite.patterns) {
    const kinds = pattern.cases.map(({ kind }) => kind);
    assert.equal(new Set(kinds).size, kinds.length, `${pattern.id} has duplicate scenario kinds`);
    assert.deepEqual([...kinds].sort(), [...suite.requiredKinds].sort(), `${pattern.id} golden coverage drift`);
    for (const scenario of pattern.cases) {
      assert.equal(typeof scenario.expectedDecision, 'string');
      assert.ok(scenario.expectedDecision.length > 0);
    }
  }
});
