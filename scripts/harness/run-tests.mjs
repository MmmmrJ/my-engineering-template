#!/usr/bin/env node

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST_ROOT = join(ROOT, 'tests', 'harness');
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry)) tests.push(...collectTests(path));
    } else if (entry.endsWith('.test.mjs')) {
      tests.push(relative(ROOT, path));
    }
  }
  return tests.sort();
}

const tests = collectTests(TEST_ROOT);
if (tests.length === 0) {
  console.error('No harness tests were found under tests/harness.');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: ROOT,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
