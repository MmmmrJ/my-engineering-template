import { runDailyTriage, runHarnessHealth } from './adapters.mjs';

const ADAPTERS = new Map([
  ['harness-health', runHarnessHealth],
  ['daily-triage', runDailyTriage],
]);

function validateResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('adapter returned no structured result');
  for (const field of ['tokens', 'findings', 'actions', 'escalations']) {
    if (!Number.isSafeInteger(result[field]) || result[field] < 0) throw new Error(`adapter result.${field} must be a non-negative integer`);
  }
  if (!['no-op', 'report-only', 'escalated'].includes(result.outcome)) throw new Error(`adapter returned unsafe outcome: ${result.outcome}`);
  if (!Array.isArray(result.checks) || !result.checks.length) throw new Error('adapter must return check receipts');
  if (!Array.isArray(result.evidence) || !result.evidence.length) throw new Error('adapter must return structured evidence');
  if (result.actions !== 0 || result.tokens !== 0) throw new Error('L1 adapters must not consume action or token budgets');
  return result;
}

export function executePatternRunner(root, pattern, context = {}) {
  const adapter = ADAPTERS.get(pattern.id);
  if (!adapter) throw new Error(`no L1 adapter registered for pattern ${pattern.id}`);
  return validateResult(adapter(root, pattern, context));
}

