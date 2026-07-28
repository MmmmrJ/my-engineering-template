#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(CLI_FILE), '..', '..');
const COMMAND_NAMES = ['precommit', 'typecheck', 'lint', 'test'];
const REQUIRED_SPEC_HEADINGS = ['## 目标', '## 范围', '## 非目标', '## 验收标准', '## 实施与验证关联'];
const REQUIRED_DESIGN_HEADINGS = ['## 视口与状态矩阵', '## 原型图清单', '## 页面结构与视觉规范', '## 交互流程与状态', '## 响应式与无障碍', '## 参考规范', '## 视觉验收基线与偏差', '## 实施与验收关联'];
const REQUIRED_VISUAL_HEADINGS = ['## 验收矩阵', '## 偏差记录', '## 验收结论'];
const PROTOTYPE_EXTENSIONS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.svg']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next']);

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

function readConfig(root = ROOT) {
  const legacy = legacyConfigPath(root);
  if (existsSync(legacy)) {
    fail(`legacy ${relative(root, legacy)} is unsupported. Migrate commands to harness.config.json using program + args arrays.`);
  }
  const path = configPath(root);
  if (!existsSync(path)) fail(`missing ${relative(root, path)}; run \`node scripts/harness/cli.mjs init\`.`);
  let config;
  try {
    config = JSON.parse(text(path));
  } catch (error) {
    fail(`invalid harness.config.json: ${error.message}`);
  }
  validateConfig(config);
  return config;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('harness.config.json must be an object.');
  if (config.schemaVersion !== 1) fail('harness.config.json schemaVersion must be 1.');
  if (typeof config.projectChecksRequired !== 'boolean') fail('projectChecksRequired must be boolean.');
  if (!config.commands || typeof config.commands !== 'object' || Array.isArray(config.commands)) fail('commands must be an object.');
  for (const name of COMMAND_NAMES) {
    const commands = config.commands[name];
    if (!Array.isArray(commands)) fail(`commands.${name} must be an array.`);
    for (const command of commands) {
      if (!command || typeof command.program !== 'string' || !command.program.trim() || !Array.isArray(command.args) || !command.args.every((arg) => typeof arg === 'string')) {
        fail(`commands.${name} entries require non-empty program and string args array.`);
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
  const result = spawnSync(program, args, { cwd: options.cwd ?? ROOT, stdio: options.stdio ?? 'inherit', shell: false, encoding: 'utf8' });
  if (result.error) return { ok: false, error: result.error.message, status: result.status };
  return { ok: result.status === 0, status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(args, root = ROOT) {
  return run('git', args, { cwd: root, stdio: 'pipe' });
}

function commandInit() {
  ensureNode();
  if (existsSync(legacyConfigPath())) fail('legacy scripts/project-checks.env exists. Migrate it before running init.');
  if (!existsSync(configPath())) {
    cpSync(exampleConfigPath(), configPath());
    console.log('init: created harness.config.json');
  } else {
    console.log('init: harness.config.json already exists');
  }
  const result = git(['config', 'core.hooksPath', '.githooks']);
  if (!result.ok) fail(`unable to configure Git hooks (${result.error ?? result.stderr.trim() ?? 'git config failed'}).`);
  console.log('init: configured core.hooksPath=.githooks');
  console.log('init: Cursor hooks load after workspace trust. In Codex, run /hooks trust if prompted.');
}

function hasProjectCommands(config) {
  return COMMAND_NAMES.some((name) => config.commands[name].length > 0);
}

function requiredFiles() {
  return [
    'AGENTS.md',
    'README.md',
    'harness.config.example.json',
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
    'docs/design/templates/verification.md',
    'docs/team/STATUS.md',
    'docs/team/SKILL_MATRIX.md',
    'docs/templates/exec-plan.md',
  ];
}

function commandDoctor(args) {
  ensureNode();
  const strict = args.includes('--strict');
  let failed = false;
  const check = (pass, message) => {
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${message}`);
    if (!pass) failed = true;
  };
  console.log(`doctor: checking harness at ${ROOT}`);
  for (const file of requiredFiles()) check(existsSync(join(ROOT, file)), `file ${file}`);
  const config = (() => {
    try { return readConfig(); } catch { failed = true; return null; }
  })();
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
    const ready = hasProjectCommands(config);
    check(!strict || !config.projectChecksRequired || ready, ready ? 'project checks configured' : 'project checks disabled for empty template');
  }
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

function commandVerify() {
  ensureNode();
  const config = readConfig();
  let valid = checkBoundaries(config);
  if (config.projectChecksRequired && !hasProjectCommands(config)) {
    console.error('verify: projectChecksRequired is true but no project commands are configured.');
    valid = false;
  }
  for (const name of COMMAND_NAMES) {
    const entries = config.commands[name];
    if (entries.length === 0) {
      console.log(`verify: ${name} not configured; skip.`);
      continue;
    }
    for (const entry of entries) {
      console.log(`verify: running ${name}: ${entry.program} ${entry.args.join(' ')}`);
      const result = run(entry.program, entry.args);
      if (!result.ok) {
        console.error(`verify: ${name} failed (${result.error ?? `exit ${result.status}`}).`);
        valid = false;
      }
    }
  }
  if (!hasProjectCommands(config) && !config.projectChecksRequired) console.log('verify: project checks disabled for empty template.');
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
  let command = args.join(' ').trim();
  if (!command && !process.stdin.isTTY) {
    const input = readFileSync(0, 'utf8').trim();
    if (input) {
      try { command = extractCommand(JSON.parse(input)); } catch { command = ''; }
    }
  }
  if (!command) {
    console.log('guard: no command provided; allow.');
    return;
  }
  const reason = blockedReason(command);
  if (reason) {
    console.error(`BLOCKED by harness guard: ${reason}`);
    console.error(`Command: ${command}`);
    process.exitCode = 2;
  } else console.log('guard: allow.');
}

function commandSession() {
  console.log('=== harness session context ===');
  const branch = git(['branch', '--show-current']);
  console.log(`branch: ${branch.ok ? branch.stdout.trim() || 'detached' : '(not a git repo)'}`);
  console.log('status file: docs/team/STATUS.md');
  const active = join(ROOT, 'docs', 'plans', 'active');
  const plans = existsSync(active) ? readdirSync(active).filter((file) => file.endsWith('.md')) : [];
  console.log(`active plans: ${plans.length ? plans.join(', ') : '(none)'}`);
  console.log('read next: docs/README.md → docs/WORKFLOW.md');
  console.log('=== end session context ===');
}

function managedFiles(root = ROOT) {
  const fixed = [
    'README.md', '.gitignore', '.env.example', 'package.json', 'harness.config.example.json',
    '.codex/config.toml', '.cursor/hooks.json', '.githooks/pre-commit', '.githooks/pre-push',
    'docs/README.md', 'docs/HARNESS.md', 'docs/WORKFLOW.md', 'docs/ARCHITECTURE.md',
    'docs/templates/exec-plan.md', 'docs/team/STATUS.md', 'docs/team/SKILL_MATRIX.md',
    'docs/product/templates/feature-spec.md', 'docs/design/README.md', 'docs/design/templates/design.md', 'docs/design/templates/verification.md',
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
  const start = '<!-- team-orchestrator:start -->';
  const end = '<!-- team-orchestrator:end -->';
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
  const start = '<!-- team-orchestrator:start -->';
  const end = '<!-- team-orchestrator:end -->';
  const from = old.indexOf(start);
  const to = old.indexOf(end);
  const next = from >= 0 && to >= from ? `${old.slice(0, from)}${block}${old.slice(to + end.length)}` : `${old.trimEnd()}\n\n${block}\n`;
  if (!dryRun) writeFileSync(target, next);
  return 'merge AGENTS.md team-orchestrator block';
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
  if (!dryRun) mkdirSync(destination, { recursive: true });
  for (const file of managedFiles()) {
    const source = join(ROOT, file);
    const output = join(destination, file);
    if (file === 'AGENTS.md') continue;
    if (existsSync(output) && mode === 'merge') { report(`keep ${file}`); continue; }
    report(`copy ${file}`);
    if (!dryRun) {
      mkdirSync(dirname(output), { recursive: true });
      cpSync(source, output);
    }
  }
  const sourceAgents = text(join(ROOT, 'AGENTS.md'));
  const outputAgents = join(destination, 'AGENTS.md');
  if (mode === 'override' && existsSync(outputAgents)) {
    const backup = `${outputAgents}.bak.${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
    report(`backup ${basename(backup)} and copy AGENTS.md`);
    if (!dryRun) { cpSync(outputAgents, backup); cpSync(join(ROOT, 'AGENTS.md'), outputAgents); }
  } else {
    report(mergeAgents(sourceAgents, outputAgents, dryRun));
  }
  console.log(`${dryRun ? 'DRY-RUN complete (no files written).' : 'install complete; run `node scripts/harness/cli.mjs init` in the target.'}`);
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
  if (!designDirectory) missing.push('设计目录');
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

function designValidationErrors(input) {
  const candidate = resolve(input);
  const designPath = existsSync(candidate) && statSync(candidate).isDirectory() ? join(candidate, 'design.md') : candidate;
  const errors = [];
  if (!existsSync(designPath)) return ['design.md 不存在'];
  if (basename(designPath) !== 'design.md') errors.push('文件必须命名为 design.md');
  const contents = text(designPath);
  if (!contents.startsWith('# Design:')) errors.push('缺少 # Design 标题');
  for (const heading of ['关联规格：', '方案版本：', '关联计划：']) if (!contents.includes(heading)) errors.push(`缺少 ${heading}`);
  for (const heading of REQUIRED_DESIGN_HEADINGS) if (!contents.includes(heading)) errors.push(`缺少 ${heading}`);
  const links = [...contents.matchAll(/!\[[^\]]*]\(([^)\s]+)\)/g)].map((match) => match[1]);
  if (links.length === 0) errors.push('至少需要一张本地原型图');
  for (const link of links) {
    const normalized = link.replaceAll('\\', '/');
    const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase();
    if (!normalized.startsWith('prototypes/') || !PROTOTYPE_EXTENSIONS.has(extension)) {
      errors.push(`原型图必须是 prototypes/ 下的 PNG/WebP/JPG/JPEG/SVG：${link}`);
      continue;
    }
    const prototype = resolve(dirname(designPath), normalized);
    const allowedRoot = `${resolve(dirname(designPath), 'prototypes')}${sep}`;
    if (!prototype.startsWith(allowedRoot) || !existsSync(prototype) || !statSync(prototype).isFile()) errors.push(`原型图不存在：${link}`);
  }
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
  for (const field of ['设计版本：', '实现提交：', '运行环境：']) if (!contents.includes(field)) errors.push(`缺少 ${field}`);
  for (const heading of REQUIRED_VISUAL_HEADINGS) if (!contents.includes(heading)) errors.push(`缺少 ${heading}`);
  if (!contents.includes('| 场景 / 状态 | 视口 | 原型图 | 实现截图 | 对比结论 |')) errors.push('缺少验收矩阵表头');
  const designPath = join(directory, 'design.md');
  const prototypeLinks = existsSync(designPath) ? markdownImageLinks(text(designPath), 'prototypes/') : [];
  const screenshotLinks = markdownImageLinks(contents, 'verification/');
  if (screenshotLinks.length === 0) errors.push('至少需要一张实现截图');
  errors.push(...localImageErrors(directory, screenshotLinks, 'verification/'));
  const mappedRows = contents.split(/\r?\n/).filter((line) => line.startsWith('|') && line.includes('prototypes/') && line.includes('verification/'));
  if (mappedRows.length < prototypeLinks.length) errors.push('每张原型图都必须在验收矩阵中映射到实现截图');
  const deviation = contents.match(/- 是否存在偏差：`(yes|no)`/);
  if (!deviation) errors.push('缺少是否存在偏差（yes 或 no）');
  if (deviation?.[1] === 'yes' && (!contents.includes('UI 确认人') || !contents.includes('设计版本'))) errors.push('存在偏差时必须记录 UI 确认人与设计版本');
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
  console.log('Usage: node scripts/harness/cli.mjs <init|doctor|verify|guard|session|install|validate-spec|validate-design|validate-visual> [options]');
}

ensureNode();
const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'init': commandInit(); break;
  case 'doctor': commandDoctor(args); break;
  case 'verify': commandVerify(); break;
  case 'guard': commandGuard(args); break;
  case 'session': commandSession(); break;
  case 'install': commandInstall(args); break;
  case 'validate-spec': commandValidateSpec(args); break;
  case 'validate-design': commandValidateDesign(args); break;
  case 'validate-visual': commandValidateVisual(args); break;
  case '--help': case '-h': case undefined: usage(); break;
  default: usage(); fail(`unknown command: ${command}`);
}
