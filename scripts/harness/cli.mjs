#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandLoop, freshLoopEvidence, safeEvidencePath } from './lib/loop/runtime.mjs';

const CLI_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(CLI_FILE), '..', '..');
const COMMAND_NAMES = ['precommit', 'typecheck', 'lint', 'test'];
const REQUIRED_SPEC_HEADINGS = ['## 目标', '## 范围', '## 非目标', '## 验收标准', '## 实施与验证关联'];
const REQUIRED_DESIGN_HEADINGS = ['## 原型来源与能力记录', '## 视口与状态矩阵', '## 原型图清单', '## 资产清单', '## 设计冻结', '## 页面结构与视觉规范', '## 关键视觉不变量', '## 交互流程与状态', '## 响应式与无障碍', '## 参考规范', '## 视觉验收基线与偏差', '## 实施与验收关联'];
const REQUIRED_VISUAL_HEADINGS = ['## 验收矩阵', '## 偏差记录', '## 验收结论'];
const PROTOTYPE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.svg']);
const DESIGN_MATRIX_HEADER = '| 场景 / 状态 | 视口 | 测试数据 / 权限 | 原型图 | 说明 |';
const VISUAL_MATRIX_HEADER = '| 场景 / 状态 | 视口 | 测试数据 / 权限 | 原型图 | 实现截图 | 比较方法 | 对比结论 |';
const ASSET_MANIFEST_HEADER = '| 资产 ID | 类型 | 原型场景 | 语义用途 | 来源 / 许可 | 冻结文件 | 运行时路径 / 图标包 | 实现规范 | 替代规则 |';
const DEVIATION_TABLE_HEADER = '| 编号 | 级别（P0/P1/P2） | 状态（resolved/accepted/open） | 场景 | 原型表现 | 实际实现 | 原因 | 影响 | UI 确认人 | 设计版本 | 资产版本 |';
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);
const CHECK_PROFILES = new Set(['fast', 'full', 'ci']);
const TASK_PHASES = ['planning', 'awaiting_approval', 'approved', 'implementing', 'accepting', 'completed', 'blocked'];
const TASK_TRANSITIONS = {
  planning: new Set(['awaiting_approval', 'blocked']),
  awaiting_approval: new Set(['approved', 'planning', 'blocked']),
  approved: new Set(['implementing', 'planning', 'blocked']),
  implementing: new Set(['accepting', 'blocked']),
  accepting: new Set(['implementing', 'completed', 'blocked']),
  blocked: new Set(['planning', 'implementing', 'accepting']),
  completed: new Set(),
};
const IDLE_STATUS_MARKERS = ['- 需求：—', '- 需求：`\u2014`', '- 总控状态：待命'];
const AGENTS_BLOCK_START = '<!-- team-orchestrator:start -->';
const AGENTS_BLOCK_END = '<!-- team-orchestrator:end -->';
const GITIGNORE_BLOCK_START = '# harness-security:start';
const GITIGNORE_BLOCK_END = '# harness-security:end';
const LOOP_BOOTSTRAP_EVIDENCE = new Set(['STATE.md', 'loop-run-log.md']);

function fail(message, code = 1) {
  console.error(`harness: ${message}`);
  process.exit(code);
}

function text(path) {
  return readFileSync(path, 'utf8');
}

function ensureNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || (major === 20 && minor < 19) || major >= 25) {
    fail(`Node.js ${process.versions.node} is unsupported; require >=20.19 <25.`);
  }
}

function legacyConfigPath(root = ROOT) {
  return join(root, 'scripts', 'project-checks.env');
}

function configPath(root = ROOT) {
  return join(root, 'harness.config.json');
}

function exampleConfigPath(root = ROOT) {
  return join(root, 'harness.config.example.json');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedPath(value) {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function parseJson(path, label = relative(ROOT, path)) {
  try { return JSON.parse(text(path)); }
  catch (error) { fail(`invalid ${label}: ${error.message}`); }
}

function commandEntry(entry, location) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${location} entries must be objects.`);
  if (typeof entry.program !== 'string' || !entry.program.trim()) fail(`${location} entries require non-empty program.`);
  if (!Array.isArray(entry.args) || !entry.args.every((arg) => typeof arg === 'string')) fail(`${location} entries require a string args array.`);
  if (entry.id !== undefined && (typeof entry.id !== 'string' || !entry.id.trim())) fail(`${location} entry id must be a non-empty string.`);
  if (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || !entry.cwd.trim())) fail(`${location} entry cwd must be a non-empty string.`);
  if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs <= 0)) fail(`${location} entry timeoutMs must be a positive integer.`);
}

function migrateV1(config) {
  const commands = COMMAND_NAMES.flatMap((name) => (config.commands?.[name] ?? []).map((entry, index) => ({
    id: entry.id ?? `${name}-${index + 1}`,
    program: entry.program,
    args: entry.args,
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.timeoutMs ? { timeoutMs: entry.timeoutMs } : {}),
  })));
  return {
    schemaVersion: 2,
    mode: config.projectChecksRequired ? 'project' : 'template',
    governedPaths: [],
    checks: { fast: commands, full: commands, ci: commands },
    boundaries: Array.isArray(config.boundaries) ? config.boundaries : [],
  };
}

function readConfig(root = ROOT, options = {}) {
  const legacy = legacyConfigPath(root);
  if (existsSync(legacy)) {
    fail(`legacy ${relative(root, legacy)} is unsupported. Migrate commands to harness.config.json using program + args arrays.`);
  }
  const path = configPath(root);
  if (!existsSync(path)) fail(`missing ${relative(root, path)}; run \`node scripts/harness/cli.mjs init\`.`);
  const config = parseJson(path, 'harness.config.json');
  validateConfig(config);
  return config.schemaVersion === 1 && options.normalize !== false ? migrateV1(config) : config;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('harness.config.json must be an object.');
  if (![1, 2].includes(config.schemaVersion)) fail('harness.config.json schemaVersion must be 1 or 2.');
  if (config.schemaVersion === 1) {
    if (typeof config.projectChecksRequired !== 'boolean') fail('projectChecksRequired must be boolean.');
    if (!config.commands || typeof config.commands !== 'object' || Array.isArray(config.commands)) fail('commands must be an object.');
    for (const name of COMMAND_NAMES) {
      if (!Array.isArray(config.commands[name])) fail(`commands.${name} must be an array.`);
      for (const entry of config.commands[name]) commandEntry(entry, `commands.${name}`);
    }
  } else {
    if (!['template', 'project'].includes(config.mode)) fail('mode must be template or project.');
    if (!Array.isArray(config.governedPaths) || !config.governedPaths.every((item) => typeof item === 'string' && item.trim())) fail('governedPaths must be a string array.');
    if (!config.checks || typeof config.checks !== 'object' || Array.isArray(config.checks)) fail('checks must be an object.');
    for (const profile of CHECK_PROFILES) {
      if (!Array.isArray(config.checks[profile])) fail(`checks.${profile} must be an array.`);
      const ids = new Set();
      for (const entry of config.checks[profile]) {
        commandEntry(entry, `checks.${profile}`);
        const id = entry.id ?? `${entry.program}:${entry.args.join('\u0000')}`;
        if (ids.has(id)) fail(`checks.${profile} contains duplicate id ${id}.`);
        ids.add(id);
      }
    }
  }
  if (!Array.isArray(config.boundaries)) fail('boundaries must be an array.');
  for (const boundary of config.boundaries) {
    if (!boundary || typeof boundary.from !== 'string' || typeof boundary.forbidden !== 'string' || !boundary.from || !boundary.forbidden) {
      fail('boundaries entries require from and forbidden strings.');
    }
  }
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: options.cwd ?? ROOT, stdio: options.stdio ?? 'inherit', shell: false, encoding: 'utf8', timeout: options.timeoutMs });
  if (result.error) return { ok: false, error: result.error.message, status: result.status };
  return { ok: result.status === 0, status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(args, root = ROOT) {
  return run('git', args, { cwd: root, stdio: 'pipe' });
}

function commandInit(args = []) {
  ensureNode();
  const project = args.includes('--project');
  if (args.some((arg) => arg !== '--project')) fail('init accepts only --project.');
  if (existsSync(legacyConfigPath())) fail('legacy scripts/project-checks.env exists. Migrate it before running init.');
  if (project && activeTaskDirectories().length) fail('init --project requires no active tasks.');
  if (!existsSync(configPath())) {
    cpSync(exampleConfigPath(), configPath());
    console.log('init: created harness.config.json');
  } else {
    console.log('init: harness.config.json already exists');
  }
  if (project) {
    const config = readConfig(ROOT, { normalize: false });
    if (config.schemaVersion === 1) fail('init --project requires schema V2; run `config migrate --dry-run`, then `config migrate --apply`.');
    config.mode = 'project';
    writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
    mkdirSync(join(ROOT, 'docs', 'plans', 'active'), { recursive: true });
    mkdirSync(join(ROOT, 'docs', 'plans', 'completed'), { recursive: true });
    writeFileSync(join(ROOT, 'docs', 'team', 'STATUS.md'), idleStatusContents());
    if (existsSync(join(ROOT, 'harness.manifest.json'))) writeLock(ROOT, lockRecord(ROOT, sourceInventory()));
    console.log('init: project mode enabled; configure non-empty checks.full and checks.ci before delivery.');
  }
  const result = git(['config', 'core.hooksPath', '.githooks']);
  if (!result.ok) fail(`unable to configure Git hooks (${result.error ?? result.stderr.trim() ?? 'git config failed'}).`);
  console.log('init: configured core.hooksPath=.githooks');
  console.log('init: Cursor hooks load after workspace trust. In Codex, run /hooks trust if prompted.');
}

function hasProjectCommands(config) {
  if (config.schemaVersion === 2) return [...CHECK_PROFILES].some((profile) => config.checks[profile].length > 0);
  return COMMAND_NAMES.some((name) => config.commands[name].length > 0);
}

function requiredFiles() {
  return [
    'AGENTS.md',
    'README.md',
    'harness.config.example.json',
    'harness.manifest.json',
    '.agents/team.config.json',
    '.codex/config.toml',
    '.cursor/hooks.json',
    '.githooks/pre-commit',
    '.githooks/pre-push',
    'docs/README.md',
    'docs/HARNESS.md',
    'docs/WORKFLOW.md',
    'docs/ARCHITECTURE.md',
    'docs/product/templates/feature-spec.md',
    'docs/design/README.md',
    'docs/design/templates/design.md',
    'docs/design/templates/assets/manifest.md',
    'docs/design/templates/verification.md',
    'docs/team/STATUS.md',
    'docs/team/SKILL_MATRIX.md',
    'docs/templates/exec-plan.md',
  ];
}

function activeTaskDirectories(root = ROOT) {
  const active = join(root, 'docs', 'plans', 'active');
  if (!existsSync(active)) return [];
  return readdirSync(active, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(active, entry.name));
}

function loadTask(directory) {
  const path = join(directory, 'governance.json');
  if (!existsSync(path)) fail(`active task missing governance.json: ${relative(ROOT, directory)}`);
  const task = parseJson(path);
  validateTaskShape(task, basename(directory));
  return task;
}

function markdownLinkErrors(root = ROOT) {
  const errors = [];
  for (const file of walk(root).filter((path) => extname(path).toLowerCase() === '.md')) {
    const contents = text(file);
    for (const match of contents.matchAll(/(!?)(?:\[[^\]]*\])\(([^)]+)\)/g)) {
      const localFile = normalizedPath(relative(root, file));
      if (match[1] === '!' && localFile.startsWith('docs/design/templates/')) continue;
      let target = match[2].trim().replace(/^<|>$/g, '');
      if (!target || target.startsWith('#') || /^(?:https?:|mailto:|tel:|data:)/i.test(target)) continue;
      target = target.split('#')[0].split('?')[0];
      if (!target) continue;
      try { target = decodeURIComponent(target); } catch { /* retain invalid encoded path */ }
      const candidate = resolve(dirname(file), target);
      if (!candidate.startsWith(`${resolve(root)}${sep}`) && candidate !== resolve(root)) {
        errors.push(`${relative(root, file)} -> ${match[2]} (outside repository)`);
      } else if (!existsSync(candidate)) errors.push(`${relative(root, file)} -> ${match[2]}`);
    }
  }
  return errors;
}

function isIdleStatus(root = ROOT) {
  const path = join(root, 'docs', 'team', 'STATUS.md');
  if (!existsSync(path)) return false;
  const contents = text(path);
  const demandIdle = IDLE_STATUS_MARKERS.slice(0, 2).some((marker) => contents.includes(marker));
  return demandIdle && contents.includes(IDLE_STATUS_MARKERS[2]);
}

function manifestEntries(root = ROOT) {
  const path = join(root, 'harness.manifest.json');
  if (!existsSync(path)) return [];
  const manifest = parseJson(path);
  const raw = Array.isArray(manifest.files) ? manifest.files : [];
  return raw.map((entry) => typeof entry === 'string' ? { path: entry, strategy: 'replace-if-unmodified' } : entry)
    .filter((entry) => entry && typeof entry.path === 'string');
}

function syncAgentsErrors(root = ROOT) {
  const outputs = renderAgentOutputs(root);
  return [...outputs.entries()].filter(([path, expected]) => !existsSync(path) || text(path) !== expected)
    .map(([path]) => normalizedPath(relative(root, path)));
}

function commandDoctor(args) {
  ensureNode();
  const strict = args.includes('--strict');
  const forcedTemplate = args.includes('--template');
  const forcedProject = args.includes('--project');
  if (forcedTemplate && forcedProject) fail('doctor accepts only one of --template or --project.');
  let failed = false;
  const check = (pass, message) => {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${message}`);
    if (!pass) failed = true;
  };
  console.log(`doctor: checking harness at ${ROOT}`);
  for (const file of requiredFiles()) check(existsSync(join(ROOT, file)), `file ${file}`);
  let config = null;
  try { config = readConfig(); check(true, 'harness.config.json schema valid'); }
  catch { check(false, 'harness.config.json schema valid'); }
  const gitVersion = git(['--version']);
  check(gitVersion.ok, 'git available');
  const hookPath = git(['config', '--get', 'core.hooksPath']);
  const hooksConfigured = hookPath.ok && hookPath.stdout.trim().replaceAll('\\', '/') === '.githooks';
  check(!strict || hooksConfigured, hooksConfigured ? 'core.hooksPath=.githooks' : 'core.hooksPath not configured (run init)');
  const cursorPath = join(ROOT, '.cursor', 'hooks.json');
  try {
    const cursor = JSON.parse(text(cursorPath));
    check(JSON.stringify(cursor).includes('node scripts/harness/cli.mjs'), 'Cursor hooks use Node CLI');
  } catch { check(false, 'Cursor hooks JSON valid'); }
  const codexPath = join(ROOT, '.codex', 'config.toml');
  try {
    const codex = text(codexPath);
    check(codex.includes('node "$(git rev-parse --show-toplevel)/scripts/harness/cli.mjs"'), 'Codex hooks use Node CLI');
    check(/matcher\s*=\s*"[^"]*compact/.test(codex), 'Codex SessionStart matches compact');
  } catch { check(false, 'Codex hooks readable'); }
  if (config) {
    const mode = forcedTemplate ? 'template' : forcedProject ? 'project' : config.mode;
    if (forcedTemplate) check(config.mode === 'template', 'config mode matches --template');
    if (forcedProject) check(config.mode === 'project', 'config mode matches --project');
    const fullReady = config.checks.full.length > 0;
    const ciReady = config.checks.ci.length > 0;
    if (mode === 'project' && strict) {
      check(fullReady, fullReady ? 'full checks configured' : 'project full checks required');
      check(ciReady, ciReady ? 'ci checks configured' : 'project ci checks required');
    }
    if (strict && mode === 'template') {
      check(activeTaskDirectories().length === 0, 'template has no active task');
      check(isIdleStatus(), 'template STATUS.md is idle');
    }
  }
  const links = markdownLinkErrors();
  check(links.length === 0, links.length ? `local Markdown links valid (${links.slice(0, 5).join('; ')})` : 'local Markdown links valid');
  let syncErrors = [];
  try { syncErrors = syncAgentsErrors(); }
  catch { syncErrors = ['unable to render team agents']; }
  check(syncErrors.length === 0, syncErrors.length ? `generated agents synchronized (${syncErrors.join(', ')})` : 'generated agents synchronized');
  const entries = manifestEntries();
  for (const entry of entries) check(existsSync(join(ROOT, entry.path)), `manifest file ${entry.path}`);
  if ((forcedProject || config?.mode === 'project') && strict) check(existsSync(join(ROOT, 'harness.lock.json')), 'project harness.lock.json');
  if (failed) process.exitCode = 1;
  else console.log('doctor: PASS');
}

function globToRegex(glob) {
  const normalized = glob.replaceAll('\\', '/');
  let output = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      if (normalized[index + 2] === '/') { output += '(?:.*/)?'; index += 2; }
      else { output += '.*'; index += 1; }
    } else if (char === '*') output += '[^/]*';
    else if (char === '?') output += '[^/]';
    else output += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${output}$`);
}

function walk(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, join(current, entry.name), files);
    } else if (entry.isFile()) files.push(join(current, entry.name));
  }
  return files;
}

function checkBoundaries(config) {
  if (config.boundaries.length === 0) {
    console.log('verify: no boundaries configured; skip.');
    return true;
  }
  let valid = true;
  const files = walk(ROOT);
  for (const boundary of config.boundaries) {
    const matcher = globToRegex(boundary.from);
    for (const file of files) {
      const local = relative(ROOT, file).split(sep).join('/');
      if (!matcher.test(local)) continue;
      if (text(file).includes(boundary.forbidden)) {
        console.error(`BOUNDARY VIOLATION: ${local} contains ${JSON.stringify(boundary.forbidden)} (${boundary.from}).`);
        valid = false;
      }
    }
  }
  if (valid) console.log('verify: boundary checks passed.');
  return valid;
}

function changedPaths(root = ROOT) {
  const names = new Set();
  for (const args of [['diff', '--name-only'], ['diff', '--cached', '--name-only']]) {
    const result = git(args, root);
    if (result.ok) for (const line of result.stdout.split(/\r?\n/)) if (line.trim()) names.add(normalizedPath(line.trim()));
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard'], root);
  if (untracked.ok) for (const line of untracked.stdout.split(/\r?\n/)) if (line.trim()) names.add(normalizedPath(line.trim()));
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    const baseRef = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '';
    const comparisons = [...(baseRef ? [[`${baseRef}...HEAD`]] : []), ['HEAD^', 'HEAD']];
    for (const comparison of comparisons) {
      const result = git(['diff', '--name-only', ...comparison], root);
      if (!result.ok) continue;
      for (const line of result.stdout.split(/\r?\n/)) if (line.trim()) names.add(normalizedPath(line.trim()));
      break;
    }
  }
  return [...names];
}

function pathMatches(path, globs = []) {
  return globs.some((glob) => globToRegex(glob).test(normalizedPath(path)));
}

function governanceErrors(config, root = ROOT) {
  if (!config.governedPaths.length) return [];
  const changes = changedPaths(root);
  const governed = changes.filter((path) => pathMatches(path, config.governedPaths));
  if (!governed.length) return [];
  const tasks = activeTaskDirectories(root);
  if (tasks.length > 1) return [`governed changes require exactly one task; found ${tasks.length} active tasks: ${governed.join(', ')}`];
  let task = null;
  let archived = false;
  if (tasks.length === 1) task = loadTask(tasks[0]);
  else {
    const archiveDirectories = [...new Set(changes.flatMap((path) => {
      const match = path.match(/^docs\/(?:plans\/completed|harness\/history)\/([^/]+)\/governance\.json$/);
      return match ? [dirname(join(root, path))] : [];
    }))];
    if (archiveDirectories.length !== 1) return [`governed changes require one active task or one completed task archive in the same change; found ${archiveDirectories.length}: ${governed.join(', ')}`];
    task = loadTask(archiveDirectories[0]);
    archived = true;
  }
  const errors = [];
  if (!task.approvedVersion || task.approvedVersion !== task.planVersion || task.approval?.status !== 'approved') errors.push('active task plan is not approved at its current version');
  if (archived) {
    if (task.phase !== 'completed') errors.push(`archived task phase ${task.phase} is not completed`);
    errors.push(...taskValidationErrors(task, 'complete').map((error) => `completed task evidence: ${error}`));
  } else if (!['approved', 'implementing', 'accepting'].includes(task.phase)) errors.push(`active task phase ${task.phase} does not permit governed changes`);
  const roles = Array.isArray(task.roles) ? task.roles.filter((role) => !['skipped', '跳过'].includes(role.status)) : [];
  for (const path of governed) {
    const owners = roles.filter((role) => pathMatches(path, role.allowedPaths ?? []) && !pathMatches(path, role.forbiddenPaths ?? []));
    if (owners.length === 0) errors.push(`governed path has no participating role owner: ${path}`);
  }
  return errors;
}

function commandVerify(args) {
  ensureNode();
  const config = readConfig();
  const profileFlag = args.indexOf('--profile');
  const profile = profileFlag >= 0 ? args[profileFlag + 1] : 'full';
  if (!CHECK_PROFILES.has(profile)) fail('verify --profile must be fast, full, or ci.');
  let valid = checkBoundaries(config);
  for (const error of governanceErrors(config)) { console.error(`GOVERNANCE VIOLATION: ${error}.`); valid = false; }
  const entries = config.checks[profile];
  if (config.mode === 'project' && ['full', 'ci'].includes(profile) && entries.length === 0) {
    console.error(`verify: project checks.${profile} is empty or not configured.`);
    valid = false;
  }
  if (entries.length === 0) console.log(`verify: checks.${profile} not configured; skip.`);
  for (const entry of entries) {
    const id = entry.id ?? entry.program;
    const cwd = resolve(ROOT, entry.cwd ?? '.');
    if (cwd !== ROOT && !cwd.startsWith(`${ROOT}${sep}`)) { console.error(`verify: ${id} cwd escapes repository.`); valid = false; continue; }
    console.log(`verify: running ${profile}/${id}: ${entry.program} ${entry.args.join(' ')}`);
    const result = run(entry.program, entry.args, { cwd, timeoutMs: entry.timeoutMs });
    if (!result.ok) {
      const detail = result.error?.includes('ETIMEDOUT') ? `timeout after ${entry.timeoutMs}ms` : result.error ?? `exit ${result.status}`;
      console.error(`verify: ${profile}/${id} failed (${detail}).`);
      valid = false;
    }
  }
  if (!hasProjectCommands(config) && config.mode === 'template') console.log('verify: project checks disabled for empty template.');
  if (!valid) process.exitCode = 1;
  else console.log('verify: PASS');
}

function extractCommand(value) {
  if (!value || typeof value !== 'object') return '';
  for (const key of ['command', 'cmd']) if (typeof value[key] === 'string') return value[key];
  for (const child of Object.values(value)) {
    const found = extractCommand(child);
    if (found) return found;
  }
  return '';
}

const POWERSHELL_SEGMENT = /(?:^|[\s;|&'"(])(?:remove-item|del|erase|rmdir)\b([^;|&]*)/gi;
const POWERSHELL_ENV_MUTATION = /(?:^|[\s;|&'"(])(?:set-content|add-content|out-file|new-item|copy-item|move-item)\b([^;|&]*)/gi;
const POWERSHELL_DELETE_OPTION = /(?:\/(?:s|f|q)\b|-(?:recurse|recursive|force)\b|-(?:r|f)\b)/i;
const ENV_PATH = String.raw`(?:[^\s'";|&]*[\\/])?\.env(?:\.[^\s'";|&]*)?`;
const ENV_PATH_PATTERN = new RegExp(`(?:^|[\\s'"(])${ENV_PATH}(?=$|[\\s'");|&])`, 'i');
const ENV_REDIRECTION = new RegExp(`(?:^|[\\s;|&])(?:\\d?>|>>)\\s*${ENV_PATH}(?=$|[\\s'");|&])`, 'i');
const BROAD_WINDOWS_DELETE_TARGET = /(?:^|[\s'"(])(?:[a-z]:[\\/](?:\*?)?|\\\\[^\\/\s'"()]+[\\/][^\\/\s'"()]+[\\/]?(?:\*?)?|[a-z]:[\\/](?:users|documents and settings)(?:[\\/][^\\/\s'"()]+)?[\\/]?(?:\*?)?|\$(?:env:)?(?:userprofile|home|pwd)(?:[\\/]\*?)?|%(?:userprofile|homepath|homedrive%%homepath)%(?:[\\/]\*?)?|~[\\/]?(?:\*?)?|\.{1,2}(?:[\\/]\*?)?)(?=$|[\s'"),;|&])/i;

function containsPowerShellBroadDelete(command) {
  for (const match of command.matchAll(POWERSHELL_SEGMENT)) {
    const segment = match[1];
    if (POWERSHELL_DELETE_OPTION.test(segment) && BROAD_WINDOWS_DELETE_TARGET.test(segment)) return true;
  }
  return false;
}

function containsPowerShellEnvMutation(command) {
  if (ENV_REDIRECTION.test(command)) return true;
  for (const match of command.matchAll(POWERSHELL_ENV_MUTATION)) {
    if (ENV_PATH_PATTERN.test(match[1])) return true;
  }
  return false;
}

function blockedReason(command) {
  const lower = command.toLowerCase();
  if (/(^|[\s;|&])git\s+push\b/.test(lower) && !/--force-with-lease/.test(lower) && /--force(?:\s|$)|(?:^|\s)-f(?:\s|$)|\+[a-z0-9._/-]+:/.test(lower)) return 'git force-push is blocked';
  if (/--no-verify|--no-gpg-sign/.test(lower)) return 'skipping Git hooks or GPG signing is blocked';
  if (/(curl|wget|fetch)[^|;]*\|\s*(?:ba)?sh\b/.test(lower)) return 'pipe-to-shell download is blocked';
  if (/(^|[\s;|&])sudo\b/.test(lower) || /chmod\s+777\b/.test(lower)) return 'sudo / chmod 777 is blocked';
  if (/(^|[\s;|&])rm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\s+(?:\/|\/\*|~(?:\/|$)|\.\.\/|\/users|\/home|\/var|\/etc|\/usr|\/bin|\/sbin)/.test(lower)) return 'dangerous recursive delete targets a broad path';
  if (containsPowerShellBroadDelete(command)) return 'dangerous recursive delete targets a broad Windows path';
  if (/git\s+add[^;&|]*\.env(?:\s|$|\*)/.test(lower)) return 'staging .env files is blocked';
  if (containsPowerShellEnvMutation(command)) return 'mutating .env files is blocked';
  if (/(?:>|cat\s*>)\s*\.env(?:\.|\s|$)/.test(lower) || /(?:rm|mv|cp|truncate)\s+[^;&|]*\.env(?:\s|$)/.test(lower)) return 'mutating .env files is blocked';
  return '';
}

function commandGuard(args) {
  const protocol = args.length === 0;
  let command = args.join(' ').trim();
  if (!command && !process.stdin.isTTY) {
    const input = readFileSync(0, 'utf8').trim();
    if (input) {
      try { command = extractCommand(JSON.parse(input)); } catch { command = ''; }
    }
  }
  if (!command) {
    console.log(protocol ? JSON.stringify({ permission: 'allow' }) : 'guard: allow');
    return;
  }
  const reason = blockedReason(command);
  if (reason) {
    if (protocol) {
      console.log(JSON.stringify({
        permission: 'deny',
        user_message: `Blocked by harness guard: ${reason}.`,
        agent_message: `Blocked by harness guard: ${reason}.`,
      }));
      console.error(`guard: blocked (${reason})`);
    } else console.error(`guard: blocked (${reason})`);
    process.exitCode = 2;
  } else console.log(protocol ? JSON.stringify({ permission: 'allow' }) : 'guard: allow');
}

function configMigration(args) {
  const apply = args.includes('--apply');
  if (args.some((arg) => !['--dry-run', '--apply'].includes(arg))) fail('config migrate accepts --dry-run or --apply.');
  if (args.includes('--dry-run') && apply) fail('choose only one of --dry-run or --apply.');
  const current = readConfig(ROOT, { normalize: false });
  if (current.schemaVersion === 2) {
    console.log('config migrate: already schemaVersion 2; no changes.');
    return;
  }
  const migrated = migrateV1(current);
  const output = `${JSON.stringify(migrated, null, 2)}\n`;
  if (!apply) {
    console.log(output.trimEnd());
    console.log('config migrate: DRY-RUN (no files written).');
    return;
  }
  writeFileSync(configPath(), output);
  console.log('config migrate: wrote harness.config.json schemaVersion 2.');
}

function ensureParentMutation() {
  const role = process.env.HARNESS_AGENT_ROLE ?? process.env.CODEX_AGENT_ROLE ?? '';
  if (role && !['parent', 'orchestrator', 'root'].includes(role)) fail(`task state changes are parent-only (current role: ${role}).`);
}

function validTaskId(id) {
  return typeof id === 'string' && /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/.test(id);
}

function validateTaskShape(task, expectedId = '') {
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('governance.json must be an object.');
  if (![1, 2].includes(task.schemaVersion)) fail('governance schemaVersion must be 1 or 2.');
  if (!validTaskId(task.taskId)) fail('governance taskId must be a safe lowercase identifier.');
  if (expectedId && task.taskId !== expectedId) fail(`governance taskId ${task.taskId} does not match directory ${expectedId}.`);
  if (!TASK_PHASES.includes(task.phase)) fail(`invalid task phase: ${task.phase}.`);
  if (typeof task.planVersion !== 'string' || !task.planVersion.trim()) fail('governance planVersion is required.');
  if (!Array.isArray(task.roles)) fail('governance roles must be an array.');
  for (const role of task.roles) {
    if (!role || typeof role.role !== 'string') fail('each governance role requires role.');
    for (const field of ['allowedPaths', 'forbiddenPaths']) if (role[field] !== undefined && (!Array.isArray(role[field]) || !role[field].every((item) => typeof item === 'string'))) fail(`role ${role.role} ${field} must be a string array.`);
  }
  if (!Array.isArray(task.requiredChecks)) fail('governance requiredChecks must be an array.');
  if (!task.acceptance || !Array.isArray(task.acceptance.results) || !Array.isArray(task.acceptance.remainingRisks)) fail('governance acceptance requires results and remainingRisks arrays.');
  if (task.schemaVersion === 2) {
    if (!task.source || !['human', 'loop'].includes(task.source.kind)) fail('governance V2 source.kind must be human or loop.');
    if (task.source.kind === 'loop' && (typeof task.source.loopId !== 'string' || typeof task.source.runId !== 'string')) fail('loop-sourced governance V2 requires source.loopId and source.runId.');
    if (!task.policy || typeof task.policy !== 'object') fail('governance V2 policy is required.');
    if (!task.isolation || typeof task.isolation !== 'object') fail('governance V2 isolation is required.');
  }
}

function uniqueTask(id = '') {
  const directories = activeTaskDirectories();
  if (id) {
    const directory = join(ROOT, 'docs', 'plans', 'active', id);
    if (!existsSync(directory) || !directories.includes(directory)) fail(`active task not found: ${id}.`);
    return { directory, task: loadTask(directory) };
  }
  if (directories.length !== 1) fail(`expected exactly one active task; found ${directories.length}.`);
  return { directory: directories[0], task: loadTask(directories[0]) };
}

function writeTask(directory, task) {
  validateTaskShape(task, basename(directory));
  writeFileSync(join(directory, 'governance.json'), `${JSON.stringify(task, null, 2)}\n`);
}

function optionValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) fail(`${name} requires a value.`);
  return args[index + 1];
}

function completedStatus(value) {
  return ['completed', 'complete', '完成', 'skipped', 'skip', '跳过'].includes(value);
}

function taskValidationErrors(task, phase) {
  const errors = [];
  if (!task.approvedVersion || task.approvedVersion !== task.planVersion || task.approval?.status !== 'approved') errors.push('current plan version is not approved');
  const implementationRoles = task.roles.filter((role) => !['parent', 'qa_engineer'].includes(role.role));
  if (['acceptance', 'complete'].includes(phase)) {
    for (const role of implementationRoles) if (!completedStatus(role.status)) errors.push(`implementation role ${role.role} is not completed`);
  }
  if (phase === 'complete') {
    for (const role of task.roles) if (!completedStatus(role.status)) errors.push(`participating role ${role.role} is not completed`);
    const qa = task.roles.find((role) => role.role === 'qa_engineer');
    if (!qa) errors.push('qa_engineer is required for completion');
    const qaConclusion = task.acceptance.results.find((item) => (item?.checkId ?? item?.id) === 'qa-acceptance');
    if (!qaConclusion || qaConclusion.status !== 'pass' || typeof qaConclusion.evidence !== 'string' || !qaConclusion.evidence.trim()) errors.push('qa-acceptance has no passing conclusion and evidence');
    for (const checkId of task.requiredChecks) {
      const result = task.acceptance.results.find((item) => (item?.checkId ?? item?.id) === checkId);
      if (!result || result.status !== 'pass' || typeof result.evidence !== 'string' || !result.evidence.trim()) errors.push(`required check ${checkId} has no passing evidence`);
    }
    if (task.acceptance.remainingRisks.length > 0 && !task.acceptance.acceptedByUser) errors.push('remaining risks require explicit user acceptance');
  }
  return errors;
}

function idleStatusContents() {
  return `# 团队状态\n\n此文件是五角色团队的持久状态来源。实时运行状态请查看当前工具的 Subagents / 活动面板。多会话执行计划见 \`docs/plans/active/\`。\n\n## 当前需求\n\n- 需求：—\n- 入口：—\n- 总控状态：待命\n- 最后同步：—\n\n## 角色状态\n\n| 角色 | 当前任务 | 状态 | 产出/进度 | 阻塞 | 下一步 | 更新时间 |\n|---|---|---|---|---|---|---|\n| 产品经理 | — | 待命 | — | 无 | 等待下一需求 | — |\n| UI设计 | — | 待命 | — | 无 | 等待下一需求 | — |\n| 前端开发 | — | 待命 | — | 无 | 等待下一需求 | — |\n| 后端开发 | — | 待命 | — | 无 | 等待下一需求 | — |\n| 测试工程师 | — | 待命 | — | 无 | 等待下一需求 | — |\n`;
}

function commandTask(args) {
  const [action, ...rest] = args;
  if (!action) fail('task requires create, status, approve, phase, validate, or complete.');
  if (action === 'create') {
    ensureParentMutation();
    if (activeTaskDirectories().length) fail('only one active task is allowed.');
    const id = rest.find((arg) => !arg.startsWith('--') && rest[rest.indexOf(arg) - 1]?.startsWith('--') !== true);
    if (!validTaskId(id)) fail('task create requires a safe lowercase task id.');
    const title = optionValue(rest, '--title', id);
    const version = optionValue(rest, '--version', 'V1');
    const directory = join(ROOT, 'docs', 'plans', 'active', id);
    mkdirSync(directory, { recursive: true });
    const sourceKind = optionValue(rest, '--source', 'human');
    if (!['human', 'loop'].includes(sourceKind)) fail('task create --source must be human or loop.');
    const source = sourceKind === 'loop'
      ? { kind: 'loop', loopId: optionValue(rest, '--loop-id'), runId: optionValue(rest, '--run-id'), findingId: optionValue(rest, '--finding-id', '') || null }
      : { kind: 'human', loopId: null, runId: null, findingId: null };
    if (sourceKind === 'loop' && (!source.loopId || !source.runId)) fail('loop-sourced task create requires --loop-id and --run-id.');
    const task = { schemaVersion: 2, taskId: id, title, phase: 'planning', planVersion: version, approvedVersion: null, source, approval: { status: 'pending', approvedBy: null, approvedAt: null, evidence: '' }, roles: [], capabilities: [], requiredChecks: ['qa-acceptance'], policy: { decision: 'pending', evidence: [] }, isolation: { mode: 'none', worktree: null, lockOwner: null }, acceptance: { results: [], remainingRisks: [], acceptedByUser: null } };
    writeFileSync(join(directory, 'plan.md'), `# Exec Plan: ${title}\n\n- 状态：\`planning\`\n- 方案版本：\`${version}\`\n`);
    writeTask(directory, task);
    console.log(`task create: ${id}`);
    return;
  }
  if (action === 'status') {
    ensureParentMutation();
    const id = rest.find((arg) => !arg.startsWith('--')) ?? '';
    const { task } = uniqueTask(id);
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (action === 'approve') {
    ensureParentMutation();
    const id = rest.find((arg) => !arg.startsWith('--') && !['--version', '--by', '--evidence'].includes(rest[rest.indexOf(arg) - 1])) ?? '';
    const { directory, task } = uniqueTask(id);
    const version = optionValue(rest, '--version', task.planVersion);
    if (version !== task.planVersion) fail(`approval version ${version} does not match planVersion ${task.planVersion}.`);
    if (task.phase !== 'awaiting_approval') fail(`task cannot be approved from ${task.phase}; move it to awaiting_approval first.`);
    task.approvedVersion = version;
    task.approval = { status: 'approved', approvedBy: optionValue(rest, '--by', 'user'), approvedAt: new Date().toISOString(), evidence: optionValue(rest, '--evidence', `User approved ${version}`) };
    task.phase = 'approved';
    writeTask(directory, task);
    console.log(`task approve: ${task.taskId} ${version}`);
    return;
  }
  if (action === 'phase') {
    ensureParentMutation();
    const positional = rest.filter((arg, index) => !arg.startsWith('--') && !rest[index - 1]?.startsWith('--'));
    const phase = positional.find((value) => TASK_PHASES.includes(value));
    const id = positional.find((value) => value !== phase) ?? '';
    if (!phase) fail(`task phase requires one of: ${TASK_PHASES.join(', ')}.`);
    const { directory, task } = uniqueTask(id);
    if (!TASK_TRANSITIONS[task.phase].has(phase)) fail(`invalid task phase transition: ${task.phase} -> ${phase}.`);
    const validationPhase = phase === 'implementing' ? 'implementation' : phase === 'accepting' ? 'acceptance' : phase === 'completed' ? 'complete' : '';
    if (validationPhase) {
      const errors = taskValidationErrors(task, validationPhase);
      if (errors.length) fail(`task phase blocked: ${errors.join('; ')}.`);
    }
    task.phase = phase;
    writeTask(directory, task);
    console.log(`task phase: ${task.taskId} -> ${phase}`);
    return;
  }
  if (action === 'validate') {
    const phase = optionValue(rest, '--phase');
    if (!['implementation', 'acceptance', 'complete'].includes(phase)) fail('task validate --phase must be implementation, acceptance, or complete.');
    const id = rest.find((arg, index) => !arg.startsWith('--') && rest[index - 1] !== '--phase') ?? '';
    const { task } = uniqueTask(id);
    const errors = taskValidationErrors(task, phase);
    if (phase === 'implementation') errors.push(...governanceErrors(readConfig()));
    if (errors.length) fail(`task validate ${phase}: ${errors.join('; ')}.`);
    console.log(`task validate: PASS ${task.taskId} ${phase}`);
    return;
  }
  if (action === 'complete') {
    ensureParentMutation();
    const id = rest.find((arg) => !arg.startsWith('--')) ?? '';
    const { directory, task } = uniqueTask(id);
    if (task.phase !== 'accepting') fail(`task complete requires accepting phase; current ${task.phase}.`);
    const errors = taskValidationErrors(task, 'complete');
    if (errors.length) fail(`task complete blocked: ${errors.join('; ')}.`);
    const templateEvolution = readConfig().mode === 'template';
    const completedRoot = templateEvolution ? join(ROOT, 'docs', 'harness', 'history') : join(ROOT, 'docs', 'plans', 'completed');
    mkdirSync(completedRoot, { recursive: true });
    const destination = join(completedRoot, task.taskId);
    if (existsSync(destination)) fail(`completed task archive already exists: ${task.taskId}.`);
    task.phase = 'completed';
    writeTask(directory, task);
    renameSync(directory, destination);
    writeFileSync(join(ROOT, 'docs', 'team', 'STATUS.md'), idleStatusContents());
    console.log(`task complete: archived ${task.taskId} to ${normalizedPath(relative(ROOT, destination))} and reset STATUS.md.`);
    return;
  }
  fail(`unknown task action: ${action}.`);
}

function secretAllowlist(root = ROOT) {
  const path = join(root, '.harness-secret-allowlist');
  if (!existsSync(path)) return [];
  return text(path).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

function secretFileName(path) {
  const name = basename(path).toLowerCase();
  if (/^\.env(?:\.|$)/.test(name) && !/^(?:\.env\.)?(?:example|sample|template)$/.test(name) && !/\.env\.(?:example|sample|template)$/.test(name)) return true;
  return /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx|jks|keystore))$/.test(name);
}

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\b(?:xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /(?:^|\n)\s*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|DATABASE_URL|PRIVATE_KEY|SECRET_KEY|PASSWORD)\s*=\s*["']?(?!example|sample|placeholder|changeme|your[_-])[A-Za-z0-9+/_=:@.-]{12,}/i,
];

function commandGuardSecrets(args) {
  const staged = args.includes('--staged');
  const tracked = args.includes('--tracked');
  if (staged === tracked || args.some((arg) => !['--staged', '--tracked'].includes(arg))) fail('guard-secrets requires exactly one of --staged or --tracked.');
  const listed = git(staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['ls-files']);
  if (!listed.ok) fail(`unable to list ${staged ? 'staged' : 'tracked'} files.`);
  const allowlist = secretAllowlist();
  const violations = [];
  for (const path of listed.stdout.split(/\r?\n/).map(normalizedPath).filter(Boolean)) {
    if (path === '.harness-secret-allowlist' || pathMatches(path, allowlist)) continue;
    if (secretFileName(path)) { violations.push(`${path}: sensitive filename`); continue; }
    let contents = '';
    if (staged) {
      const result = git(['show', `:${path}`]);
      if (!result.ok) continue;
      contents = result.stdout;
    } else {
      const file = join(ROOT, path);
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      try { contents = text(file); } catch { continue; }
    }
    if (contents.includes('\u0000')) continue;
    const pattern = SECRET_PATTERNS.find((candidate) => candidate.test(contents));
    if (pattern) violations.push(`${path}: high-confidence secret pattern`);
  }
  if (violations.length) fail(`secret scan failed:\n- ${violations.join('\n- ')}`, 2);
  console.log(`guard-secrets: PASS (${staged ? 'staged' : 'tracked'}).`);
}

function teamConfig(root = ROOT) {
  const path = join(root, '.agents', 'team.config.json');
  if (!existsSync(path)) fail('missing .agents/team.config.json.');
  const config = parseJson(path);
  if (config.schemaVersion !== 1 || !Array.isArray(config.statuses) || !Array.isArray(config.invariants) || !Array.isArray(config.roles)) fail('invalid .agents/team.config.json schema.');
  return config;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function renderAgentOutputs(root = ROOT) {
  const config = teamConfig(root);
  const outputs = new Map();
  for (const role of [...config.roles].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    for (const field of ['id', 'label', 'description', 'sharedSkill', 'codexType', 'cursorType', 'nickname']) if (typeof role[field] !== 'string' || !role[field]) fail(`team role missing ${field}.`);
    const body = [
      `你是本项目的${role.label} subagent。`, '',
      `## 默认共享 Skill`, '', `- 必须读取并使用 \`.agents/skills/${role.sharedSkill}/SKILL.md\`。`, '',
      '## 职责', '', ...role.responsibilities.map((item) => `- ${item}`), '',
      '## 边界', '', ...role.boundaries.map((item) => `- ${item}`), '',
      '## 团队不变量', '', ...config.invariants.map((item) => `- ${item}`), '',
      '## 可选增强', '', ...role.codexEnhancements.map((item) => `- ${item}`), '',
      `状态只能是：${config.statuses.join('、')}。`,
      `回复以状态行结尾：\`| ${role.label} | 当前任务 | 状态 | 产出/进度 | 阻塞 | 下一步 | YYYY-MM-DD HH:mm +08:00 |\``, '',
    ].join('\n');
    const codex = `# Generated by harness sync-agents. Do not edit.\nname = ${tomlString(role.codexType)}\ndescription = ${tomlString(role.description)}\nnickname_candidates = [${tomlString(role.nickname)}]\ndeveloper_instructions = ${tomlString(body)}\n`;
    const cursorBody = body.replace('## 可选增强\n\n' + role.codexEnhancements.map((item) => `- ${item}`).join('\n'), '## 可选增强\n\n' + role.cursorEnhancements.map((item) => `- ${item}`).join('\n'));
    const cursor = `---\nname: ${role.cursorType}\ndescription: ${role.description}\nmodel: inherit\n---\n\n<!-- Generated by harness sync-agents. Do not edit. -->\n\n${cursorBody}`;
    outputs.set(join(root, '.codex', 'agents', `${role.codexType}.toml`), codex);
    outputs.set(join(root, '.cursor', 'agents', `${role.cursorType}.md`), cursor);
  }
  return outputs;
}

function commandSyncAgents(args) {
  const check = args.includes('--check');
  const write = args.includes('--write');
  if (check === write || args.some((arg) => !['--check', '--write'].includes(arg))) fail('sync-agents requires exactly one of --check or --write.');
  const outputs = renderAgentOutputs();
  const drift = [];
  for (const [path, expected] of outputs) {
    if (check) {
      if (!existsSync(path) || text(path) !== expected) drift.push(relative(ROOT, path));
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, expected);
      console.log(`sync-agents: wrote ${relative(ROOT, path)}`);
    }
  }
  if (drift.length) fail(`generated agents out of sync: ${drift.join(', ')}.`);
  if (check) console.log('sync-agents: PASS');
}

function commandSession() {
  console.log('=== harness session context ===');
  const branch = git(['branch', '--show-current']);
  console.log(`branch: ${branch.ok ? branch.stdout.trim() || 'detached' : '(not a git repo)'}`);
  console.log('status file: docs/team/STATUS.md');
  const active = join(ROOT, 'docs', 'plans', 'active');
  const plans = existsSync(active) ? readdirSync(active, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  console.log(`active plans: ${plans.length ? plans.join(', ') : '(none)'}`);
  console.log('read next: docs/README.md → docs/WORKFLOW.md');
  console.log('=== end session context ===');
}

function managedFiles(root = ROOT) {
  if (existsSync(join(root, 'harness.manifest.json'))) return sourceInventory(root).map((entry) => entry.path);
  const fixed = [
    'README.md', '.gitignore', '.env.example', 'package.json', 'harness.config.example.json',
    '.codex/config.toml', '.cursor/hooks.json', '.githooks/pre-commit', '.githooks/pre-push',
    'docs/README.md', 'docs/HARNESS.md', 'docs/WORKFLOW.md', 'docs/ARCHITECTURE.md',
    'docs/templates/exec-plan.md', 'docs/team/STATUS.md', 'docs/team/SKILL_MATRIX.md',
    'docs/product/templates/feature-spec.md', 'docs/design/README.md', 'docs/design/templates/design.md', 'docs/design/templates/assets/manifest.md', 'docs/design/templates/verification.md',
  ];
  const dirs = ['.agents/skills', '.codex/agents', '.cursor/agents', 'scripts/harness'];
  const entries = [...fixed];
  for (const directory of dirs) {
    const source = join(root, directory);
    if (!existsSync(source)) continue;
    for (const file of walk(source)) entries.push(relative(root, file));
  }
  return entries;
}

function orchestratorBlock(source) {
  const start = AGENTS_BLOCK_START;
  const end = AGENTS_BLOCK_END;
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from < 0 || to < from) fail('source AGENTS.md has no team-orchestrator block.');
  return source.slice(from, to + end.length);
}

function mergeAgents(source, target, dryRun) {
  const block = orchestratorBlock(source);
  if (!existsSync(target)) {
    if (!dryRun) writeFileSync(target, source);
    return 'copy AGENTS.md';
  }
  const old = text(target);
  const start = AGENTS_BLOCK_START;
  const end = AGENTS_BLOCK_END;
  const from = old.indexOf(start);
  const to = old.indexOf(end);
  const next = from >= 0 && to >= from ? `${old.slice(0, from)}${block}${old.slice(to + end.length)}` : `${old.trimEnd()}\n\n${block}\n`;
  if (!dryRun) writeFileSync(target, next);
  return 'merge AGENTS.md team-orchestrator block';
}

function markedBlock(source, start, end, label) {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  if (from < 0 || to < from) fail(`source ${label} has no managed block.`);
  return source.slice(from, to + end.length);
}

function mergeMarkedFile(sourcePath, targetPath, start, end, dryRun) {
  const source = text(sourcePath);
  const block = markedBlock(source, start, end, basename(sourcePath));
  if (!existsSync(targetPath)) {
    if (!dryRun) { mkdirSync(dirname(targetPath), { recursive: true }); writeFileSync(targetPath, source); }
    return `copy ${basename(sourcePath)}`;
  }
  const old = text(targetPath);
  const from = old.indexOf(start);
  const to = old.indexOf(end);
  const next = from >= 0 && to >= from ? `${old.slice(0, from)}${block}${old.slice(to + end.length)}` : `${old.trimEnd()}\n\n${block}\n`;
  if (!dryRun) writeFileSync(targetPath, next);
  return `merge ${basename(sourcePath)} managed block`;
}

function sourceInventory(root = ROOT) {
  const entries = [];
  for (const manifestEntry of manifestEntries(root)) {
    const source = join(root, manifestEntry.path);
    if (!existsSync(source)) continue;
    if (statSync(source).isDirectory()) {
      for (const file of walk(source)) entries.push({ path: normalizedPath(relative(root, file)), strategy: manifestEntry.strategy });
    } else entries.push({ path: normalizedPath(manifestEntry.path), strategy: manifestEntry.strategy });
  }
  if (existsSync(join(root, 'harness.manifest.json')) && !entries.some((entry) => entry.path === 'harness.manifest.json')) entries.push({ path: 'harness.manifest.json', strategy: 'replace-if-unmodified' });
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function harnessManifest(root = ROOT) {
  const path = join(root, 'harness.manifest.json');
  if (!existsSync(path)) fail('missing harness.manifest.json.');
  const manifest = parseJson(path);
  if (manifest.schemaVersion !== 1 || typeof manifest.harnessVersion !== 'string' || !Array.isArray(manifest.files)) fail('invalid harness.manifest.json schema.');
  return manifest;
}

function lockRecord(destination, inventory, previous = {}) {
  const files = { ...(previous.files ?? {}) };
  for (const entry of inventory) {
    const path = join(destination, entry.path);
    if (existsSync(path) && statSync(path).isFile()) files[entry.path] = { hash: sha256(text(path)), strategy: entry.strategy };
  }
  return { schemaVersion: 1, harnessVersion: harnessManifest().harnessVersion, files };
}

function writeLock(destination, lock) {
  writeFileSync(join(destination, 'harness.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
}

function installLoopSeedConfig(destination) {
  for (const path of [join(destination, 'loop.config.json'), join(ROOT, 'loop.config.json')]) {
    if (!existsSync(path)) continue;
    try {
      const config = JSON.parse(text(path));
      if (Array.isArray(config.patterns) && config.patterns.length > 0 && config.patterns.every((pattern) => {
        const files = [pattern.state?.summaryFile, pattern.state?.runLogFile];
        return files.every((file) => typeof file === 'string' && file.trim());
      })) return config;
    } catch {
      // A target-owned invalid Loop configuration is preserved; use the template only to seed inert evidence files.
    }
  }
  fail('unable to load a valid Loop configuration for clean install evidence.');
}

function preflightCleanLoopEvidence(destination) {
  const evidence = freshLoopEvidence(installLoopSeedConfig(destination));
  return [...evidence.state, ...evidence.runLogs].map((entry) => ({
    ...entry,
    output: safeEvidencePath(destination, entry.path),
  }));
}

function seedCleanLoopEvidence(destination, entries, dryRun, report) {
  for (const entry of entries) {
    const output = safeEvidencePath(destination, entry.path);
    if (existsSync(output)) {
      report(`keep ${entry.path} (target-owned evidence)`);
      continue;
    }
    report(`seed clean ${entry.path}`);
    if (!dryRun) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, entry.contents);
    }
  }
}

function commandInstall(args) {
  let mode = 'merge';
  let dryRun = false;
  let target = '';
  for (const arg of args) {
    if (arg === '--merge') mode = 'merge';
    else if (arg === '--override') mode = 'override';
    else if (arg === '--dry-run') dryRun = true;
    else if (!target) target = arg;
    else fail(`unknown argument: ${arg}`);
  }
  if (!target) fail('install requires a target directory.');
  const destination = resolve(process.cwd(), target);
  const report = (message) => console.log(`${dryRun ? 'DRY' : 'DO '} ${message}`);
  const cleanEvidence = preflightCleanLoopEvidence(destination);
  if (!dryRun) mkdirSync(destination, { recursive: true });
  const inventory = sourceInventory();
  for (const entry of inventory) {
    const { path: file, strategy } = entry;
    const source = join(ROOT, file);
    const output = join(destination, file);
    if (file === 'AGENTS.md' || file === '.gitignore') continue;
    if (LOOP_BOOTSTRAP_EVIDENCE.has(file)) continue;
    if (existsSync(output) && mode === 'merge') {
      if (strategy === 'generated') report(`generate ${file}`);
      else { report(`keep ${file} (${strategy})`); continue; }
    } else report(`copy ${file}`);
    if (!dryRun) {
      mkdirSync(dirname(output), { recursive: true });
      cpSync(source, output);
    }
  }
  seedCleanLoopEvidence(destination, cleanEvidence, dryRun, report);
  const sourceAgents = text(join(ROOT, 'AGENTS.md'));
  const outputAgents = join(destination, 'AGENTS.md');
  if (mode === 'override' && existsSync(outputAgents)) {
    const backup = `${outputAgents}.bak.${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
    report(`backup ${basename(backup)} and copy AGENTS.md`);
    if (!dryRun) { cpSync(outputAgents, backup); cpSync(join(ROOT, 'AGENTS.md'), outputAgents); }
  } else {
    report(mergeAgents(sourceAgents, outputAgents, dryRun));
  }
  const gitignoreSource = join(ROOT, '.gitignore');
  if (existsSync(gitignoreSource)) report(mergeMarkedFile(gitignoreSource, join(destination, '.gitignore'), GITIGNORE_BLOCK_START, GITIGNORE_BLOCK_END, dryRun));
  if (!dryRun) writeLock(destination, lockRecord(destination, inventory));
  console.log(`${dryRun ? 'DRY-RUN complete (no files written).' : 'install complete; run `node scripts/harness/cli.mjs init --project` in the target.'}`);
}

function commandUpgrade(args) {
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run') || !apply;
  if (args.includes('--apply') && args.includes('--dry-run')) fail('upgrade accepts only one of --dry-run or --apply.');
  const target = args.find((arg) => !arg.startsWith('--'));
  if (!target) fail('upgrade requires a target directory.');
  const destination = resolve(process.cwd(), target);
  const lockPath = join(destination, 'harness.lock.json');
  if (!existsSync(lockPath)) fail('target has no harness.lock.json; install the harness first.');
  const oldLock = parseJson(lockPath);
  if (oldLock.schemaVersion !== 1 || !oldLock.files || typeof oldLock.files !== 'object') fail('invalid target harness.lock.json.');
  const inventory = sourceInventory();
  const nextLock = { schemaVersion: 1, harnessVersion: harnessManifest().harnessVersion, files: { ...oldLock.files } };
  const conflicts = [];
  const report = (kind, path) => console.log(`${dryRun ? 'DRY' : 'DO '} ${kind} ${path}`);
  for (const entry of inventory) {
    const source = join(ROOT, entry.path);
    const output = join(destination, entry.path);
    if (!existsSync(output)) {
      report('add', entry.path);
      if (!dryRun) { mkdirSync(dirname(output), { recursive: true }); cpSync(source, output); nextLock.files[entry.path] = { hash: sha256(text(output)), strategy: entry.strategy }; }
      continue;
    }
    if (entry.strategy === 'seed-only') { report('keep seed', entry.path); continue; }
    if (entry.strategy === 'managed-block') {
      report('merge block', entry.path);
      if (!dryRun) {
        if (entry.path === 'AGENTS.md') mergeAgents(text(source), output, false);
        else if (entry.path === '.gitignore') mergeMarkedFile(source, output, GITIGNORE_BLOCK_START, GITIGNORE_BLOCK_END, false);
        else conflicts.push(entry.path);
        if (!conflicts.includes(entry.path)) nextLock.files[entry.path] = { hash: sha256(text(output)), strategy: entry.strategy };
      }
      continue;
    }
    const currentHash = sha256(text(output));
    const base = oldLock.files[entry.path];
    if (entry.strategy === 'generated' || (base && base.hash === currentHash)) {
      report(entry.strategy === 'generated' ? 'regenerate' : 'update', entry.path);
      if (!dryRun) { cpSync(source, output); nextLock.files[entry.path] = { hash: sha256(text(output)), strategy: entry.strategy }; }
    } else if (sha256(text(source)) === currentHash) {
      report('unchanged', entry.path);
      if (!dryRun) nextLock.files[entry.path] = { hash: currentHash, strategy: entry.strategy };
    } else {
      report('conflict', entry.path);
      conflicts.push(entry.path);
    }
  }
  if (!dryRun) writeLock(destination, nextLock);
  if (conflicts.length) {
    console.error(`upgrade: conflicts were not overwritten: ${conflicts.join(', ')}`);
    process.exitCode = 1;
  } else console.log(`${dryRun ? 'upgrade: DRY-RUN complete (no files written).' : 'upgrade: complete.'}`);
}

function commandValidateSpec(args) {
  const input = args[0];
  if (!input) fail('validate-spec requires a Markdown file path.');
  const path = resolve(process.cwd(), input);
  if (!existsSync(path)) fail(`spec file not found: ${input}`);
  const contents = text(path);
  const missing = [
    ...(contents.startsWith('# Feature Spec:') ? [] : ['# Feature Spec']),
    ...(contents.includes('方案版本：') ? [] : ['方案版本']),
    ...(contents.includes('关联计划：') ? [] : ['关联计划']),
    ...REQUIRED_SPEC_HEADINGS.filter((heading) => !contents.includes(heading)),
  ];
  const delivery = contents.match(/- 设计交付：`(required|not-applicable)`/);
  const designDirectory = contents.match(/- 设计目录：`([^`]+)`/);
  if (!delivery) missing.push('设计交付（required 或 not-applicable）');
  if (delivery?.[1] === 'required') {
    if (!designDirectory || designDirectory[1] === '不适用') missing.push('required 设计目录');
    else {
      const errors = designValidationErrors(resolve(process.cwd(), designDirectory[1]));
      if (errors.length) missing.push(`设计交付无效（${errors.join('；')}）`);
    }
  }
  if (delivery?.[1] === 'not-applicable' && designDirectory?.[1] !== '不适用') missing.push('not-applicable 设计目录必须为不适用');
  if (missing.length) fail(`invalid spec; missing: ${missing.join(', ')}.`);
  console.log(`validate-spec: PASS ${relative(ROOT, path)}`);
}

function fieldValue(contents, label) {
  const match = contents.match(new RegExp(`^- ${label}：\\s*\\x60?([^\\x60\\n]+)\\x60?\\s*$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function markdownTableRows(contents, header) {
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === header);
  if (index < 0) return [];
  const rows = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor].trim();
    if (!line.startsWith('|')) break;
    if (/^\|[\s:|-]+\|$/.test(line)) continue;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

function firstMarkdownImage(cell, prefix) {
  return markdownImageLinks(cell, prefix)[0] ?? '';
}

function localAssetError(directory, path, label) {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized.startsWith('assets/')) return `${label}必须是 assets/ 下的本地文件：${path}`;
  const asset = resolve(directory, normalized);
  const allowedRoot = `${resolve(directory, 'assets')}${sep}`;
  if (!asset.startsWith(allowedRoot) || !existsSync(asset) || !statSync(asset).isFile()) return `${label}不存在：${path}`;
  return '';
}

function assetManifestValidationErrors(directory, designContents) {
  const errors = [];
  const manifestReference = fieldValue(designContents, '资产清单');
  if (manifestReference !== 'assets/manifest.md') {
    errors.push('资产清单必须引用 assets/manifest.md');
    return errors;
  }
  const manifestPath = join(directory, 'assets', 'manifest.md');
  if (!existsSync(manifestPath)) return ['assets/manifest.md 不存在'];
  const contents = text(manifestPath);
  if (!contents.startsWith('# Asset Manifest:')) errors.push('资产清单缺少 # Asset Manifest 标题');
  const designVersion = fieldValue(designContents, '方案版本');
  const assetVersion = fieldValue(designContents, '资产版本');
  if (!fieldValue(contents, '设计版本')) errors.push('资产清单缺少设计版本');
  else if (fieldValue(contents, '设计版本') !== designVersion) errors.push('资产清单设计版本与 design.md 不一致');
  if (!fieldValue(contents, '资产版本')) errors.push('资产清单缺少资产版本');
  else if (fieldValue(contents, '资产版本') !== assetVersion) errors.push('资产清单资产版本与 design.md 不一致');
  if (!['draft', 'frozen'].includes(fieldValue(contents, '冻结状态'))) errors.push('资产清单冻结状态必须为 draft 或 frozen');
  if (!contents.includes(ASSET_MANIFEST_HEADER)) errors.push('资产清单缺少标准表头');
  const rows = markdownTableRows(contents, ASSET_MANIFEST_HEADER);
  if (rows.length === 0) errors.push('资产清单至少需要一行资产或 none 声明');
  for (const row of rows) {
    const [assetId, type, scenario, purpose, source, frozenFile, runtime, specification, fallback] = row;
    if ([assetId, type, scenario, purpose, source, frozenFile, runtime, specification, fallback].some((cell) => !cell)) {
      errors.push(`资产清单存在不完整条目：${assetId || '未命名资产'}`);
      continue;
    }
    if (assetId === 'none') continue;
    if (/待补充|<[^>]+>/.test(source)) errors.push(`资产来源与许可必须是可追溯记录：${assetId}`);
    if (/https?:\/\//i.test(runtime)) errors.push(`资产运行时路径不得使用外链：${assetId}`);
    if (!/@\d/.test(runtime) && !/^(assets\/|\/assets\/|apps\/|packages\/)/.test(runtime)) errors.push(`资产运行时路径必须是本地资产或固定版本图标包：${assetId}`);
    if (!['not-applicable', 'N/A', 'N/A（锁定图标包）'].includes(frozenFile)) {
      const error = localAssetError(directory, frozenFile, '冻结文件');
      if (error) errors.push(`${assetId}：${error}`);
    }
    const normalizedType = type.toLowerCase();
    if ((normalizedType.includes('icon') || type.includes('图标')) && !runtime.startsWith('assets/') && !/@\d/.test(runtime)) {
      errors.push(`图标包必须固定版本：${assetId}`);
    }
    if (/未登记|相似图标|临时 CSS|emoji|Unicode/i.test(fallback)) errors.push(`资产替代规则必须登记偏差并取得 UI 确认：${assetId}`);
    if (normalizedType.includes('background') || type.includes('背景')) {
      if (['not-applicable', 'N/A', 'N/A（锁定图标包）'].includes(frozenFile)) errors.push(`背景图必须有冻结本地文件：${assetId}`);
      if (!/(cover|contain)/i.test(specification) || !/(裁切)?焦点/.test(specification) || !specification.includes('对比度')) {
        errors.push(`背景图实现规范必须包含 cover/contain、裁切焦点和对比度：${assetId}`);
      }
    }
  }
  return errors;
}

function designValidationErrors(input) {
  const candidate = resolve(input);
  const designPath = existsSync(candidate) && statSync(candidate).isDirectory() ? join(candidate, 'design.md') : candidate;
  const errors = [];
  if (!existsSync(designPath)) return ['design.md 不存在'];
  if (basename(designPath) !== 'design.md') errors.push('文件必须命名为 design.md');
  const contents = text(designPath);
  const directory = dirname(designPath);
  if (!contents.startsWith('# Design:')) errors.push('缺少 # Design 标题');
  for (const heading of ['关联规格：', '方案版本：', '关联计划：']) if (!contents.includes(heading)) errors.push(`缺少 ${heading}`);
  for (const heading of REQUIRED_DESIGN_HEADINGS) if (!contents.includes(heading)) errors.push(`缺少 ${heading}`);
  const capabilityStart = contents.indexOf('## 原型来源与能力记录');
  const capabilityEnd = contents.indexOf('\n## ', capabilityStart + 1);
  const capabilitySection = capabilityStart < 0 ? '' : contents.slice(capabilityStart, capabilityEnd < 0 ? undefined : capabilityEnd);
  if (!contents.includes('| 用户指定能力 |') || /待补充|<[^>]+>/.test(capabilitySection)) errors.push('缺少可追溯的用户指定能力记录');
  if (!['draft', 'frozen'].includes(fieldValue(contents, '资产冻结'))) errors.push('资产冻结必须为 draft 或 frozen');
  if (!fieldValue(contents, '资产版本')) errors.push('缺少资产版本');
  if (!contents.includes(DESIGN_MATRIX_HEADER)) errors.push('缺少包含测试数据的视口与状态矩阵表头');
  const allLinks = [...contents.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)].map((match) => match[1]);
  const links = allLinks.filter((link) => link.replaceAll('\\', '/').startsWith('prototypes/'));
  if (links.length === 0) errors.push('至少需要一张本地原型图');
  for (const link of allLinks) {
    if (!link.replaceAll('\\', '/').startsWith('prototypes/')) errors.push(`原型图必须是 prototypes/ 下的本地文件：${link}`);
  }
  errors.push(...localImageErrors(directory, links, 'prototypes/'));
  const sceneRows = markdownTableRows(contents, DESIGN_MATRIX_HEADER);
  if (sceneRows.length === 0) errors.push('视口与状态矩阵至少需要一个场景');
  for (const row of sceneRows) {
    if (row.length < 5 || !row[0] || !row[1] || !row[2] || !firstMarkdownImage(row[3], 'prototypes/')) errors.push('视口与状态矩阵必须记录场景、视口、测试数据和原型图');
  }
  errors.push(...assetManifestValidationErrors(directory, contents));
  return errors;
}

function markdownImageLinks(contents, prefix) {
  return [...contents.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)].map((match) => match[1]).filter((link) => link.replaceAll('\\', '/').startsWith(prefix));
}

function localImageErrors(base, links, prefix) {
  const errors = [];
  for (const link of links) {
    const normalized = link.replaceAll('\\', '/');
    const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase();
    if (!normalized.startsWith(prefix) || !PROTOTYPE_EXTENSIONS.has(extension)) {
      errors.push(`图片必须是 ${prefix} 下的 PNG/WebP/JPG/JPEG/SVG：${link}`);
      continue;
    }
    const image = resolve(base, normalized);
    const allowedRoot = `${resolve(base, prefix)}${sep}`;
    if (!image.startsWith(allowedRoot) || !existsSync(image) || !statSync(image).isFile()) errors.push(`图片不存在：${link}`);
  }
  return errors;
}

function visualValidationErrors(input) {
  const candidate = resolve(input);
  const directory = existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : dirname(candidate);
  const errors = designValidationErrors(directory);
  const verificationPath = join(directory, 'verification.md');
  if (!existsSync(verificationPath)) return [...errors, 'verification.md 不存在'];
  const contents = text(verificationPath);
  if (!contents.startsWith('# Visual Verification:')) errors.push('缺少 # Visual Verification 标题');
  for (const field of ['设计版本：', '资产版本：', '实现提交：', '运行环境：', '资产一致性检查：']) if (!contents.includes(field)) errors.push(`缺少 ${field}`);
  for (const heading of REQUIRED_VISUAL_HEADINGS) if (!contents.includes(heading)) errors.push(`缺少 ${heading}`);
  if (!contents.includes(VISUAL_MATRIX_HEADER)) errors.push('缺少包含测试数据和比较方法的验收矩阵表头');
  const designPath = join(directory, 'design.md');
  const designContents = existsSync(designPath) ? text(designPath) : '';
  const prototypeLinks = markdownImageLinks(designContents, 'prototypes/');
  const screenshotLinks = markdownImageLinks(contents, 'verification/');
  if (screenshotLinks.length === 0) errors.push('至少需要一张实现截图');
  errors.push(...localImageErrors(directory, screenshotLinks, 'verification/'));
  const designRows = markdownTableRows(designContents, DESIGN_MATRIX_HEADER);
  const visualRows = markdownTableRows(contents, VISUAL_MATRIX_HEADER);
  for (const row of visualRows) {
    if (row.length < 7 || !row[0] || !row[1] || !row[2] || !firstMarkdownImage(row[3], 'prototypes/') || !firstMarkdownImage(row[4], 'verification/') || !row[5] || !row[6]) {
      errors.push('验收矩阵必须记录场景、视口、测试数据、原型、实现截图、比较方法和结论');
    }
  }
  for (const [scene, viewport, data, prototypeCell] of designRows) {
    const prototype = firstMarkdownImage(prototypeCell, 'prototypes/');
    const matches = visualRows.some((row) => row[0] === scene && row[1] === viewport && row[2] === data && firstMarkdownImage(row[3] ?? '', 'prototypes/') === prototype && firstMarkdownImage(row[4] ?? '', 'verification/'));
    if (!matches) errors.push(`验收矩阵必须按相同场景、视口、测试数据映射原型和实现截图：${scene}`);
  }
  if (visualRows.length < prototypeLinks.length) errors.push('每张原型图都必须在验收矩阵中映射到实现截图');
  if (fieldValue(contents, '设计版本') !== fieldValue(designContents, '方案版本')) errors.push('验收设计版本与 design.md 不一致');
  const manifestPath = join(directory, 'assets', 'manifest.md');
  if (existsSync(manifestPath) && fieldValue(contents, '资产版本') !== fieldValue(text(manifestPath), '资产版本')) errors.push('验收资产版本与资产清单不一致');
  if (fieldValue(designContents, '资产冻结') !== 'frozen') errors.push('视觉验收要求 design.md 的资产已冻结');
  if (existsSync(manifestPath) && fieldValue(text(manifestPath), '冻结状态') !== 'frozen') errors.push('视觉验收要求资产清单冻结状态为 frozen');
  if (fieldValue(contents, '资产一致性检查') !== 'pass') errors.push('资产一致性检查必须为 pass');
  const deviation = contents.match(/- 是否存在偏差：`(yes|no)`/);
  if (!deviation) errors.push('缺少是否存在偏差（yes 或 no）');
  if (!contents.includes(DEVIATION_TABLE_HEADER)) errors.push('偏差记录缺少级别、状态和 UI 确认人字段');
  const deviations = markdownTableRows(contents, DEVIATION_TABLE_HEADER);
  if (deviation?.[1] === 'yes' && deviations.length === 0) errors.push('存在偏差时必须登记偏差条目');
  for (const row of deviations) {
    const [id, level, status, , , , , , approver, version] = row;
    if (!id || !['P0', 'P1', 'P2'].includes(level) || !['resolved', 'accepted', 'open'].includes(status)) {
      errors.push('偏差记录必须包含有效编号、级别和状态');
      continue;
    }
    if ((level === 'P0' || level === 'P1') && status !== 'resolved') errors.push(`${level} 偏差必须修复后才能通过：${id}`);
    if (level === 'P2' && (status !== 'accepted' || !approver || approver === '—' || version !== fieldValue(designContents, '方案版本'))) {
      errors.push(`P2 偏差必须经 UI 确认并关联当前设计版本：${id}`);
    }
    if (status === 'open') errors.push(`存在未关闭偏差：${id}`);
  }
  const result = contents.match(/- 结论：`(pass|blocked|fail)`/);
  if (!result) errors.push('缺少验收结论（pass、blocked 或 fail）');
  else if (result[1] !== 'pass') errors.push(`验收结论为 ${result[1]}，不能通过视觉验收`);
  return errors;
}

function commandValidateDesign(args) {
  const input = args[0];
  if (!input) fail('validate-design requires a design directory or design.md path.');
  const path = resolve(process.cwd(), input);
  const errors = designValidationErrors(path);
  if (errors.length) fail(`invalid design; ${errors.join('；')}.`);
  const designPath = existsSync(path) && statSync(path).isDirectory() ? join(path, 'design.md') : path;
  console.log(`validate-design: PASS ${relative(ROOT, designPath)}`);
}

function commandValidateVisual(args) {
  const input = args[0];
  if (!input) fail('validate-visual requires a design directory or verification.md path.');
  const path = resolve(process.cwd(), input);
  const errors = visualValidationErrors(path);
  if (errors.length) fail(`invalid visual verification; ${errors.join('；')}.`);
  console.log(`validate-visual: PASS ${relative(ROOT, path)}`);
}

function usage() {
  console.log(`Usage: node scripts/harness/cli.mjs <command> [options]\n\nCommands:\n  init [--project]\n  config migrate [--dry-run|--apply]\n  migrate-config [--dry-run|--apply]\n  doctor [--template|--project] [--strict]\n  verify [--profile fast|full|ci]\n  task <create|status|approve|phase|validate|complete> ...\n  loop <init|validate|doctor|status|sync|run|inbox|gate|pause|resume|promote|worktree|metrics> ...\n  guard [command ...]\n  guard-secrets <--staged|--tracked>\n  sync-agents <--check|--write>\n  session\n  install [--merge|--override] [--dry-run] <target>\n  upgrade [--dry-run|--apply] <target>\n  validate-spec <file>\n  validate-design <directory|file>\n  validate-visual <directory|file>`);
}

ensureNode();
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'init': commandInit(args); break;
  case 'config': if (args[0] !== 'migrate') fail('config requires migrate.'); else configMigration(args.slice(1)); break;
  case 'migrate-config': configMigration(args); break;
  case 'doctor': commandDoctor(args); break;
  case 'verify': commandVerify(args); break;
  case 'task': commandTask(args); break;
  case 'loop': commandLoop(ROOT, args); break;
  case 'guard': commandGuard(args); break;
  case 'guard-secrets': commandGuardSecrets(args); break;
  case 'sync-agents': commandSyncAgents(args); break;
  case 'session': commandSession(); break;
  case 'install': commandInstall(args); break;
  case 'upgrade': commandUpgrade(args); break;
  case 'validate-spec': commandValidateSpec(args); break;
  case 'validate-design': commandValidateDesign(args); break;
  case 'validate-visual': commandValidateVisual(args); break;
  case '--help': case '-h': case undefined: usage(); break;
  default: usage(); fail(`unknown command: ${command}`);
}
