'use strict';

// Deterministic tests for the oauto read-only OpenCode reviewer launcher.
// They run anywhere node, bash, git and python3 exist (no OpenCode binary needed):
// the rendered configuration is checked against the contract, the verifiers are
// exercised with good and mutated payloads, the launcher itself is driven end to end
// against a test double of the OpenCode CLI (tests/fixtures/fake-opencode), and the
// shipped ai-launch copy must equal the pristine device launcher plus exactly the
// intended opencode-mode edits.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OAUTO = path.join(ROOT, 'launchers', 'oauto');
const POLICY = path.join(OAUTO, 'oauto-policy.py');
const RUN = path.join(OAUTO, 'oauto-run');
const INSTALL = path.join(OAUTO, 'install.sh');
const AI_LAUNCH = path.join(ROOT, 'launchers', 'ai-launch');
const PRISTINE = path.join(__dirname, 'fixtures', 'ai-launch.pristine');
const FAKE = path.join(__dirname, 'fixtures', 'fake-opencode');

const APPROVED = {
  glm: 'opencode/glm-5.3-flash-free',
  deepseek: 'opencode/deepseek-v4.1-flash-free',
};
const DENIED_ACTIONS = ['shell', 'edit', 'webfetch', 'websearch', 'subagent', 'skill',
  'execute', 'external_directory', 'experimental_image_generate', 'browser'];

fs.chmodSync(FAKE, 0o755);

function policy(args, input) {
  return spawnSync('python3', ['-I', POLICY, ...args], { input, encoding: 'utf8' });
}

function render(alias, extra = []) {
  const result = policy(['render', '--model', alias, ...extra]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Last-match evaluation with OpenCode 2 wildcard semantics (mirrors the launcher's verifier).
function globMatch(pattern, value) {
  if (pattern.endsWith(' *') && value === pattern.slice(0, -2)) return true;
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
  return re.test(value);
}
function decide(rules, action, resource) {
  let effect = 'ask';
  for (const rule of rules) {
    if (globMatch(rule.action, action) && globMatch(rule.resource, resource)) effect = rule.effect;
  }
  return effect;
}

// ---------------------------------------------------------------------------
// Fixture helpers: temp HOME/state/lock dirs and disposable git repositories.
// ---------------------------------------------------------------------------
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oauto-test-'));
  const dirs = { root, home: path.join(root, 'home'), state: path.join(root, 'state'), locks: path.join(root, 'locks'), repos: path.join(root, 'repos') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

function git(repo, args, input) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function mkRepo(sb, name, files, { commit = true } = {}) {
  const repo = path.join(sb.repos, name);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, ['config', 'user.email', 'oauto-test@example.invalid']);
  git(repo, ['config', 'user.name', 'oauto-test']);
  writeFiles(repo, files);
  if (commit) {
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'initial']);
  }
  return repo;
}

function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

// oauto-run scrubs the environment before every OpenCode call, so the test double is
// steered through $HOME/.fake-opencode-control instead of environment variables.
function fakeControl(sb, settings) {
  const lines = Object.entries(settings).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(sb.home, '.fake-opencode-control'), `${lines}\n`);
}

function runOauto(sb, repo, args = [], extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: sb.home,
    XDG_STATE_HOME: sb.state,
    CODEX_RESOURCE_LOCK_DIR: sb.locks,
    OAUTO_OPENCODE_BIN: FAKE,
    LANG: 'C.UTF-8',
    ...extraEnv,
  };
  return spawnSync('bash', [RUN, repo, ...args], { encoding: 'utf8', env, timeout: 120000 });
}

function repoKey(repo) {
  const real = fs.realpathSync(repo);
  return `${path.basename(real)}-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 8)}`;
}

function stateDir(sb, repo) {
  return path.join(sb.state, 'oauto', repoKey(repo));
}

// ---------------------------------------------------------------------------
// Rendered configuration contract
// ---------------------------------------------------------------------------
test('scripts parse under bash -n', () => {
  for (const script of [RUN, AI_LAUNCH, INSTALL, FAKE,
    path.join(OAUTO, 'termux', 'oauto-launch'), path.join(OAUTO, 'termux', 'bashrc-snippet.sh'),
    path.join(OAUTO, 'debian-bashrc-snippet.sh')]) {
    execFileSync('bash', ['-n', script]);
  }
});

test('rendered config pins the approved model, provider and read-only ruleset', () => {
  for (const [alias, model] of Object.entries(APPROVED)) {
    const cfg = render(alias);
    assert.equal(cfg.model, model);
    assert.equal(cfg.default_agent, `review-${alias}`);
    assert.equal(cfg.share, 'disabled');
    assert.equal(cfg.update, 'disable');
    assert.equal(cfg.snapshots, false);
    assert.equal(cfg.lsp, false);
    assert.equal(cfg.formatter, false);
    assert.equal(cfg.websearch, false);
    assert.deepEqual(cfg.mcp, { servers: {} });
    assert.deepEqual(cfg.skills, []);
    assert.deepEqual(cfg.instructions, []);
    assert.ok(!('plugins' in cfg), 'a plugins directive would disable the built-in free-tier provider');
    assert.deepEqual(cfg.permissions[0], { action: '*', resource: '*', effect: 'deny' });
    assert.ok(!cfg.permissions.some((r) => r.effect === 'ask'), 'no ask rule may remain');

    for (const action of DENIED_ACTIONS) {
      assert.equal(decide(cfg.permissions, action, 'anything'), 'deny', `${action} must be denied`);
    }
    const denied = ['.env', 'config/.env.production', 'deploy/.ssh/id_ed25519', '.ssh/config', '.gnupg/pubring.kbx',
      '.git/config', '.npmrc', 'app/local.properties', 'app/keystore.properties', 'keys/server.pem', 'config/prod.secrets.yaml',
      'app-secrets.json', 'oauth/client_secret_1.json', 'infra/terraform.tfstate', '.aws/credentials', '.docker/config.json'];
    for (const p of denied) assert.equal(decide(cfg.permissions, 'read', p), 'deny', `read ${p} must be denied`);
    for (const p of ['src/main.kt', '.env.example', 'gradle.properties', 'README.md']) {
      assert.equal(decide(cfg.permissions, 'read', p), 'allow', `read ${p} must be allowed`);
    }
    for (const p of ['/root/*', '{/root,x}/.ssh/*', '../**', '~/x', '$HOME/x']) {
      assert.equal(decide(cfg.permissions, 'glob', p), 'deny', `glob ${p} must be denied`);
    }
    for (const p of ['**/*.py', 'src/**/*.{kt,java}']) assert.equal(decide(cfg.permissions, 'glob', p), 'allow');
    assert.equal(decide(cfg.permissions, 'grep', 'TODO'), 'allow');
    assert.equal(decide(cfg.permissions, 'question', '*'), 'allow');
    assert.equal(decide(cfg.permissions, 'some_future_tool', 'x'), 'deny');

    // Hard policy ceiling: only the opencode provider, nothing else connectable.
    const pol = cfg.policies;
    assert.equal(decide(pol, 'provider.use', 'anthropic'), 'deny');
    assert.equal(decide(pol, 'provider.use', 'openai'), 'deny');
    assert.equal(decide(pol, 'provider.use', 'opencode'), 'allow');
    assert.equal(decide(pol, 'integration.connect', 'anthropic'), 'deny');
    assert.equal(decide(pol, 'integration.use', 'opencode'), 'allow');
    assert.equal(decide(pol, 'integration.use', 'anthropic'), 'deny');
    for (const act of ['mcp.use', 'skill.use', 'plugin.use', 'websearch.use']) {
      assert.equal(decide(pol, act, 'anything'), 'deny', `${act} must be denied`);
    }
    for (const action of DENIED_ACTIONS) assert.equal(decide(pol, 'tool.use', `${action}:whatever`), 'deny');
    assert.equal(decide(pol, 'tool.use', 'read:.env'), 'deny');
    assert.equal(decide(pol, 'tool.use', 'read:.ssh/config'), 'deny');
    assert.equal(decide(pol, 'tool.use', 'read:.env.example'), 'allow');

    // Agents: built-ins off, hidden maintenance agents pinned and tool-less, reviewers read-only.
    for (const name of ['build', 'plan', 'general', 'explore']) assert.deepEqual(cfg.agents[name], { disabled: true });
    for (const name of ['title', 'summary', 'compaction']) {
      assert.equal(cfg.agents[name].model, model);
      assert.deepEqual(cfg.agents[name].permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
    }
    for (const [agent, agentAlias] of [['review-glm', 'glm'], ['review-deepseek', 'deepseek']]) {
      assert.equal(cfg.agents[agent].mode, 'primary');
      assert.equal(cfg.agents[agent].model, APPROVED[agentAlias]);
      assert.deepEqual(cfg.agents[agent].permissions, cfg.permissions);
      assert.match(cfg.agents[agent].system, /read-only/);
    }
    // Every known unapproved free model is disabled; the approved ones never are.
    const disabled = Object.keys(cfg.providers.opencode.models);
    assert.ok(disabled.includes('big-pickle'));
    assert.ok(disabled.includes('iceman-free'));
    for (const id of Object.values(APPROVED)) assert.ok(!disabled.includes(id.split('/')[1]), `${id} must not be disabled`);
    for (const entry of Object.values(cfg.providers.opencode.models)) assert.deepEqual(entry, { disabled: true });
  }
});

test('dynamic disable list rejects foreign providers and never disables an approved model', () => {
  const cfg = render('glm', ['--disable-model', 'opencode/new-free', '--disable-model', 'opencode/glm-5.3-flash-free']);
  assert.ok('new-free' in cfg.providers.opencode.models);
  assert.ok(!('glm-5.3-flash-free' in cfg.providers.opencode.models));
  const foreign = policy(['render', '--model', 'glm', '--disable-model', 'anthropic/claude-x']);
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /non-opencode model offered/);
  assert.notEqual(policy(['render', '--model', 'gpt']).status, 0);
});

// ---------------------------------------------------------------------------
// Classification and the single-pass scan
// ---------------------------------------------------------------------------
test('classify denies exactly what the read rules deny, case-insensitively', () => {
  const input = ['.env', 'Config/Prod.Secrets.YAML', 'app/Local.Properties', 'deploy/.ssh/key', 'src/main.kt',
    '.env.example', 'config/server.PEM', '.git/config', 'gradle.properties', 'notes/README.md', 'infra/x.tfvars'].join('\n');
  const r = policy(['classify'], `${input}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), ['.env', '.git/config', 'Config/Prod.Secrets.YAML', 'app/Local.Properties',
    'config/server.PEM', 'deploy/.ssh/key', 'infra/x.tfvars'].sort());
});

test('scan reports secret-like files, outward symlinks and credential content in one pass', () => {
  const sb = sandbox();
  const outside = path.join(sb.root, 'outside.txt');
  fs.writeFileSync(outside, 'outside');
  const repo = mkRepo(sb, 'scanme', {
    'src/a.py': 'print(1)\n',
    '.env.example': 'X=1\n',
    'Config/Prod.Secrets.YAML': 'k: v\n',
    'node_modules/pkg/.env': 'TOKEN=1\n',
    'app/Local.Properties': 'sdk.dir=/x\n',
    'gradle.properties': 'org.gradle.jvmargs=-Xmx1g\nsigningPassword=hunter2\n',
    'clean.properties': 'a=b\n',
  }, { commit: false });
  fs.symlinkSync(outside, path.join(repo, 'link-out'));
  fs.symlinkSync('/usr/bin/env', path.join(repo, 'link-system'));
  fs.symlinkSync('src/a.py', path.join(repo, 'link-inside'));
  fs.symlinkSync(path.join(sb.root, 'missing'), path.join(repo, 'link-dangling'));
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://user:tok@example.com/x.git\n');
  const r = policy(['scan', repo, '--budget', '60']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.includes('SENSITIVE Config/Prod.Secrets.YAML'));
  assert.ok(lines.includes('SENSITIVE node_modules/pkg/.env'), 'node_modules must not be pruned');
  assert.ok(lines.includes('SENSITIVE app/Local.Properties'));
  assert.ok(!lines.some((l) => l.includes('.env.example')));
  assert.ok(!lines.some((l) => l.includes('clean.properties')));
  assert.ok(lines.some((l) => l.startsWith('SYMLINK link-out -> ')));
  assert.ok(lines.some((l) => l.startsWith('SYMLINK link-dangling -> ') && l.endsWith('(dangling)')));
  assert.ok(!lines.some((l) => l.includes('link-system')), 'system interpreter links are tolerated');
  assert.ok(!lines.some((l) => l.includes('link-inside')));
  assert.ok(lines.includes('CONTENT gradle.properties: credential-looking assignment'));
  assert.ok(lines.includes('CONTENT .git/config: remote URL embeds credentials (user:secret@)'));
  assert.match(lines[lines.length - 1], /^SUMMARY files=\d+ elapsed=[\d.]+s complete=1$/);
  const exhausted = policy(['scan', repo, '--budget', '0']);
  assert.equal(exhausted.status, 3);
  assert.match(exhausted.stdout, /complete=0/);
});

// ---------------------------------------------------------------------------
// Verifiers
// ---------------------------------------------------------------------------
test('verify-models accepts exactly the approved set and nothing else', () => {
  assert.equal(policy(['verify-models'], `${APPROVED.glm}\n${APPROVED.deepseek}\n`).status, 0);
  const extra = policy(['verify-models'], `${APPROVED.glm}\n${APPROVED.deepseek}\nopencode/big-pickle\n`);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /unapproved models offered/);
  const missing = policy(['verify-models'], `${APPROVED.glm}\n`);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /approved models missing/);
  assert.notEqual(policy(['verify-models'], '').status, 0);
});

test('verify-sources refuses any configuration source beyond the oauto directory and file', () => {
  const dir = '/x/state/xdg-config/opencode';
  const good = [{ type: 'document', path: `${dir}/opencode.json`, info: {} }, { type: 'directory', path: dir }];
  assert.equal(policy(['verify-sources', '--config-dir', dir], JSON.stringify(good)).status, 0);
  const project = [...good, { type: 'document', path: '/root/work/x/opencode.json', info: {} }];
  const r = policy(['verify-sources', '--config-dir', dir], JSON.stringify(project));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unexpected configuration source/);
  const global = [...good, { type: 'directory', path: '/root/.config/opencode' }];
  assert.notEqual(policy(['verify-sources', '--config-dir', dir], JSON.stringify(global)).status, 0);
  assert.notEqual(policy(['verify-sources', '--config-dir', dir], JSON.stringify([{ type: 'directory', path: dir }])).status, 0);
});

function resolvedAgents(cfg) {
  // Shape as `opencode debug agents` (2.2.6) prints it: model = {id, providerID}, global rules then agent rules.
  return Object.entries(cfg.agents)
    .filter(([, a]) => !a.disabled)
    .map(([id, a]) => ({
      id,
      hidden: ['title', 'summary', 'compaction'].includes(id),
      mode: a.mode || 'primary',
      model: { id: a.model.split('/')[1], providerID: a.model.split('/')[0] },
      permissions: [...cfg.permissions, ...a.permissions],
    }));
}

test('verify-agents passes the rendered agents and fails on any widened agent', () => {
  const cfg = render('glm');
  const resolved = resolvedAgents(cfg);
  const ok = policy(['verify-agents'], JSON.stringify(resolved));
  assert.equal(ok.status, 0, ok.stderr);
  const find = (agents, id) => agents[agents.findIndex((a) => a.id === id)];
  const mutations = [
    ['shell allowed on reviewer', (a) => find(a, 'review-glm').permissions.push({ action: 'shell', resource: '*', effect: 'allow' })],
    ['edit asked on reviewer', (a) => find(a, 'review-glm').permissions.push({ action: 'edit', resource: '*', effect: 'ask' })],
    ['env readable', (a) => find(a, 'review-deepseek').permissions.push({ action: 'read', resource: '*', effect: 'allow' })],
    ['ssh dir readable', (a) => find(a, 'review-glm').permissions.push({ action: 'read', resource: '.ssh/*', effect: 'allow' })],
    ['external directory allowed', (a) => find(a, 'review-glm').permissions.push({ action: 'external_directory', resource: '*', effect: 'allow' })],
    ['glob escape allowed', (a) => find(a, 'review-glm').permissions.push({ action: 'glob', resource: '/*', effect: 'allow' })],
    ['build agent present', (a) => a.push({ id: 'build', hidden: false, mode: 'primary', model: { id: 'glm-5.3-flash-free', providerID: 'opencode' }, permissions: [{ action: '*', resource: '*', effect: 'allow' }] })],
    ['extra visible agent', (a) => a.push({ id: 'helper', hidden: false, mode: 'primary', model: { id: 'glm-5.3-flash-free', providerID: 'opencode' }, permissions: cfg.permissions })],
    ['hidden agent with a tool', (a) => find(a, 'compaction').permissions.push({ action: 'shell', resource: '*', effect: 'allow' })],
    ['reviewer on unapproved model', (a) => { find(a, 'review-glm').model = { id: 'big-pickle', providerID: 'opencode' }; }],
    ['reviewer on foreign provider', (a) => { find(a, 'review-glm').model = { id: 'glm-5.3-flash-free', providerID: 'zai' }; }],
    ['reviewer model unparsable', (a) => { find(a, 'review-glm').model = { providerID: 'opencode' }; }],
    ['reviewer not primary', (a) => { find(a, 'review-glm').mode = 'subagent'; }],
  ];
  for (const [label, mutate] of mutations) {
    const agents = JSON.parse(JSON.stringify(resolved));
    mutate(agents);
    assert.notEqual(policy(['verify-agents'], JSON.stringify(agents)).status, 0, `${label} must fail verification`);
  }
});

// ---------------------------------------------------------------------------
// The launcher, end to end against the OpenCode test double
// ---------------------------------------------------------------------------
test('oauto-run --check passes on a clean repository and leaves a private, verified config', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'clean', { 'src/calc.py': 'def add(a, b):\n    return a + b\n', 'README.md': '# x\n' });
  fs.writeFileSync(path.join(repo, 'src/calc.py'), 'def add(a, b):\n    return a - b\n');
  fakeControl(sb, { EXTRA_MODELS: 'opencode/new-free opencode/big-pickle' });
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  for (const line of ['config sources ok', 'models ok', 'agents ok', '--check: configuration verified', 'Model : opencode/glm-5.3-flash-free', 'Agent : review-glm']) {
    assert.ok(r.stderr.includes(line), `missing "${line}" in\n${r.stderr}`);
  }
  const sd = stateDir(sb, repo);
  const preflight = fs.readFileSync(path.join(sd, 'preflight.md'), 'utf8');
  assert.match(preflight, /- Branch: main/);
  assert.match(preflight, /## Uncommitted changes/);
  assert.match(preflight, /-    return a \+ b\n\+    return a - b/);
  assert.ok(!preflight.includes('Excluded from this preflight'));
  const cfg = JSON.parse(fs.readFileSync(path.join(sd, 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(cfg.default_agent, 'review-glm');
  assert.ok('new-free' in cfg.providers.opencode.models, 'a model the binary offered must be disabled dynamically');
  assert.deepEqual(fs.readdirSync(path.join(sd, 'xdg-config', 'opencode')), ['opencode.json']);
  assert.equal(fs.statSync(path.join(sd, 'preflight.md')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(sb.home, '.config')), 'the user config directory must stay untouched');

  const d = runOauto(sb, repo, ['deepseek', '--check']);
  assert.equal(d.status, 0, d.stderr);
  assert.ok(d.stderr.includes('Model : opencode/deepseek-v4.1-flash-free'));
  const cfg2 = JSON.parse(fs.readFileSync(path.join(sd, 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(cfg2.default_agent, 'review-deepseek');
  assert.equal(cfg2.model, APPROVED.deepseek);
});

test('oauto-run refuses secret-like files unless overridden, and symlinks that leave the repo always', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'secrets', { 'src/a.py': 'x = 1\n', '.gitignore': '.env\n' });
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=abc\n');
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /secret-like files present/);
  assert.match(r.stderr, /refusing to launch: the model's grep tool/);
  assert.ok(!fs.existsSync(stateDir(sb, repo)), 'nothing is rendered before the scan passes');

  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /WARNING: OAUTO_ALLOW_SENSITIVE_FILES=1/);

  fs.mkdirSync(path.join(repo, 'Config'));
  fs.writeFileSync(path.join(repo, 'Config', 'Prod.Secrets.YAML'), 'k: v\n');
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '0' });
  assert.equal(r.status, 1, 'case-insensitive match must refuse');
  assert.match(r.stderr, /Config\/Prod\.Secrets\.YAML/);
  fs.rmSync(path.join(repo, 'Config'), { recursive: true });
  fs.rmSync(path.join(repo, '.env'));

  fs.symlinkSync('/usr/bin/env', path.join(repo, 'venv-python'));
  r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, `system symlink must be tolerated: ${r.stderr}`);

  fs.writeFileSync(path.join(sb.root, 'outside.txt'), 'secret outside');
  fs.symlinkSync(path.join(sb.root, 'outside.txt'), path.join(repo, 'link'));
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /symlinks leaving the repository/);
  assert.match(r.stderr, /refusing to launch: OpenCode resolves reads through symlinks/);
});

test('oauto-run excludes deleted and modified secret paths from the preflight diff', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'leak', { 'config/credentials.json': '{"token":"TOPSECRET-123"}\n', 'src/a.py': 'x = 1\n' });
  git(repo, ['rm', '-q', 'config/credentials.json']);
  fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 2\n');
  fs.writeFileSync(path.join(repo, '.env'), 'NEW=UNTRACKED-SECRET-456\n');
  const r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  const preflight = fs.readFileSync(path.join(stateDir(sb, repo), 'preflight.md'), 'utf8');
  assert.ok(!preflight.includes('TOPSECRET-123'), 'deleted secret content must not enter the preflight');
  assert.ok(!preflight.includes('UNTRACKED-SECRET-456'));
  assert.match(preflight, /## Excluded from this preflight[\s\S]*config\/credentials\.json/);
  assert.match(preflight, /\.env\n/);
  assert.match(preflight, /-x = 1\n\+x = 2/);
  assert.match(r.stderr, /secret-like paths excluded/);
});

test('oauto-run refuses repositories that reconfigure OpenCode, wrong versions and bad arguments', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'cfg', { 'a.txt': 'a\n' });
  fs.mkdirSync(path.join(repo, '.opencode'));
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /repository contains OpenCode project config .*\.opencode/);
  fs.rmdirSync(path.join(repo, '.opencode'));
  fs.writeFileSync(path.join(repo, 'opencode.jsonc'), '{}\n');
  r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /opencode\.jsonc/);
  fs.rmSync(path.join(repo, 'opencode.jsonc'));
  fs.writeFileSync(path.join(sb.repos, 'opencode.json'), '{}\n');
  r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /parent directory carries OpenCode config/);
  fs.rmSync(path.join(sb.repos, 'opencode.json'));

  fakeControl(sb, { VERSION: '2.3.0' });
  r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OpenCode '2\.3\.0' is installed but only 2\.2\.6 was validated/);
  fakeControl(sb, {});
  r = runOauto(sb, repo, ['gpt', '--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown argument 'gpt'/);
  r = runOauto(sb, repo, ['--yolo']);
  assert.equal(r.status, 1);
  r = runOauto(sb, path.join(sb.root, 'not-a-repo'), ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a Git repository root/);
  const render = runOauto(sb, repo, ['deepseek', '--render-only']);
  assert.equal(render.status, 0, render.stderr);
  assert.equal(JSON.parse(render.stdout).default_agent, 'review-deepseek');
});

test('oauto-run holds one lock per repository', async () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'locked', { 'a.txt': 'a\n' });
  const lock = path.join(sb.locks, `oauto-${repoKey(repo)}.lock`);
  fs.mkdirSync(sb.locks, { recursive: true });
  // --close: only the flock parent holds the lock, so killing it releases the lock at once.
  const holder = spawn('flock', ['--exclusive', '--close', lock, 'sleep', '6']);
  await new Promise((resolve) => setTimeout(resolve, 700));
  try {
    const busy = runOauto(sb, repo, ['--check']);
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /another oauto session is already open on locked/);
  } finally {
    holder.kill('SIGTERM');
    await new Promise((resolve) => holder.on('exit', resolve));
  }
  const free = runOauto(sb, repo, ['--check']);
  assert.equal(free.status, 0, free.stderr);
  assert.ok(fs.existsSync(lock));
});

test('oauto-run handles a detached HEAD, an unborn repository and an oversized diff', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'detached', { 'a.txt': 'a\n' });
  git(repo, ['checkout', '-q', '--detach']);
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  let preflight = fs.readFileSync(path.join(stateDir(sb, repo), 'preflight.md'), 'utf8');
  assert.match(preflight, /- Branch: \(detached\)\n- HEAD: [0-9a-f]{40}\n/);

  const unborn = mkRepo(sb, 'unborn', { 'a.txt': 'a\n' }, { commit: false });
  r = runOauto(sb, unborn, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  preflight = fs.readFileSync(path.join(stateDir(sb, unborn), 'preflight.md'), 'utf8');
  assert.match(preflight, /- HEAD: \(no commits\)\n/);
  assert.match(preflight, /\?\? a\.txt/);
  assert.ok(!preflight.includes('## Uncommitted changes'));

  const big = mkRepo(sb, 'big', { 'big.txt': 'small\n' });
  fs.writeFileSync(path.join(big, 'big.txt'), 'x'.repeat(150000) + '\n');
  r = runOauto(sb, big, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  preflight = fs.readFileSync(path.join(stateDir(sb, big), 'preflight.md'), 'utf8');
  assert.match(preflight, /truncated by oauto: 24000 of \d+ bytes shown/);
  assert.ok(Buffer.byteLength(preflight) <= 100000);
});

test('oauto-run launches OpenCode standalone with the preflight prompt in a scrubbed environment', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'launch', { 'src/a.py': 'x = 1\n' });
  fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 2\n');
  const log = path.join(sb.root, 'launch.log');
  fakeControl(sb, { LAUNCH_LOG: log });
  const r = runOauto(sb, repo, [], { TEST_LEAK_TOKEN: 'must-not-reach-opencode', OPENCODE_API_KEY: 'nope' });
  assert.equal(r.status, 0, r.stderr);
  const recorded = fs.readFileSync(log, 'utf8');
  const args = recorded.split('ARGS_BEGIN\n')[1].split('\nARGS_END')[0].split('\n');
  assert.equal(args[0], '--standalone');
  assert.equal(args[1], '--prompt');
  assert.ok(!args.includes('--auto'));
  assert.ok(!args.includes('--worktree'));
  const envNames = recorded.split('ENV_BEGIN\n')[1].split('\nENV_END')[0].split('\n');
  assert.ok(!envNames.includes('TEST_LEAK_TOKEN'));
  assert.ok(!envNames.includes('OPENCODE_API_KEY'));
  assert.ok(!envNames.includes('CODEX_RESOURCE_LOCK_DIR'));
  assert.ok(envNames.includes('XDG_CONFIG_HOME'));
  assert.match(recorded, /PROMPT_HEAD You are reviewing the repository "launch"/);
  assert.match(recorded, /oauto preflight/);
  assert.match(recorded, new RegExp(`CWD ${fs.realpathSync(repo)}`));
  // The lock is released once OpenCode exits.
  const lock = path.join(sb.locks, `oauto-${repoKey(repo)}.lock`);
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0);
});

test('oauto-run source: no automatic approval, standalone helpers, bounded helper calls', () => {
  const src = fs.readFileSync(RUN, 'utf8');
  const code = src.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.ok(!/--auto\b/.test(code), 'oauto-run must never pass --auto');
  assert.ok(!code.includes('--worktree'));
  assert.equal(code.split('\n').filter((l) => /"\$OPENCODE_BIN" --standalone --prompt/.test(l)).length, 1);
  for (const helper of [/oc \d+ models --standalone/, /oc \d+ debug config --standalone/, /oc \d+ debug agents --standalone/]) {
    assert.match(code, helper);
  }
  assert.ok(!/timeout \d+ oc /.test(code), 'timeout must wrap the binary inside oc(), not the function');
  assert.match(code, /GIT_OPTIONAL_LOCKS=0 timeout 120 git/);
  assert.match(code, /exec env -i "\$\{clean_env\[@\]\}" "\$OPENCODE_BIN" --standalone --prompt/);
});

// ---------------------------------------------------------------------------
// ai-launch: routing of the opencode mode and parity with the pristine launcher
// ---------------------------------------------------------------------------
test('ai-launch equals the pristine device launcher plus exactly the opencode-mode edits', () => {
  const pristine = fs.readFileSync(PRISTINE, 'utf8');
  let expected = pristine;
  const replaceOnce = (from, to) => {
    assert.equal(expected.split(from).length, 2, `anchor must occur once: ${from.slice(0, 40)}`);
    expected = expected.replace(from, to);
  };
  replaceOnce('  codex|claude)\n    SELECTED_MODE="$MODE"', '  codex|claude|opencode)\n    SELECTED_MODE="$MODE"');
  replaceOnce('die "Usage: ai-launch [codex|claude|menu] [repo]"', 'die "Usage: ai-launch [codex|claude|opencode|menu] [repo]"');
  replaceOnce('if (($#)) && [[ "$1" != -* ]]; then\n  direct="$1"',
    '# oauto: a leading model alias (`oauto deepseek`) is not a repository name; keep it\n'
    + '# for oauto-run and fall through to the normal repository menu.\n'
    + 'oauto_alias=""\n'
    + 'if [[ "$SELECTED_MODE" == opencode ]] && (($#)) && [[ "$1" =~ ^(glm|deepseek)$ ]]; then\n'
    + '  oauto_alias="$1"\n  shift\nfi\n\n'
    + 'if (($#)) && [[ "$1" != -* ]]; then\n  direct="$1"');
  replaceOnce('cd "$SELECTED_REPO"\n\necho\necho "============================================================"',
    'cd "$SELECTED_REPO"\n\n'
    + '# oauto: read-only OpenCode reviewer. Repository resolution above is shared with\n'
    + '# cauto/clauto; everything OpenCode-specific (preflight, policy, lock, banner)\n'
    + '# lives in oauto-run, so the codex/claude paths below are untouched.\n'
    + 'if [[ "$SELECTED_MODE" == opencode ]]; then\n'
    + '  exec /root/work/bin/oauto-run "$SELECTED_REPO" ${oauto_alias:+"$oauto_alias"} "$@"\nfi\n\n'
    + 'echo\necho "============================================================"');
  assert.equal(fs.readFileSync(AI_LAUNCH, 'utf8'), expected);
});

test('ai-launch routes opencode arguments to oauto-run and keeps the menu for a bare alias', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'alpha', { 'a.txt': 'a\n' });
  mkRepo(sb, 'beta', { 'b.txt': 'b\n' });
  const stub = path.join(sb.root, 'oauto-run-stub');
  fs.writeFileSync(stub, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$STUB_LOG"\n');
  fs.chmodSync(stub, 0o755);
  const cache = path.join(sb.root, 'cache');
  const launcher = path.join(sb.root, 'ai-launch');
  fs.writeFileSync(launcher, fs.readFileSync(AI_LAUNCH, 'utf8')
    .replace('WORK_ROOT=/root/work\n', `WORK_ROOT=${sb.repos}\n`)
    .replace('REPO_CACHE_DIR=/root/.cache/ai-launch\n', `REPO_CACHE_DIR=${cache}\n`)
    .replace('exec /root/work/bin/oauto-run', `exec ${stub}`));
  const log = path.join(sb.root, 'stub.log');
  const env = { PATH: process.env.PATH, HOME: sb.home, STUB_LOG: log };

  let r = spawnSync('bash', [launcher, 'opencode', 'alpha', 'deepseek', '--check'], { encoding: 'utf8', env, input: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [fs.realpathSync(repo), 'deepseek', '--check']);

  r = spawnSync('bash', [launcher, 'opencode', 'alpha'], { encoding: 'utf8', env, input: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [fs.realpathSync(repo)]);

  // `oauto deepseek`: the alias is not a repository; the menu appears and the alias survives.
  r = spawnSync('bash', [launcher, 'opencode', 'deepseek'], { encoding: 'utf8', env, input: '1\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Choose repository:/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [fs.realpathSync(repo), 'deepseek']);

  r = spawnSync('bash', [launcher, 'bogus'], { encoding: 'utf8', env, input: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage: ai-launch \[codex\|claude\|opencode\|menu\] \[repo\]/);
});

// ---------------------------------------------------------------------------
// install.sh
// ---------------------------------------------------------------------------
test('install.sh installs idempotently, backs up replaced files and refuses unpaired markers', () => {
  const sb = sandbox();
  const bin = path.join(sb.root, 'bin');
  const termuxBin = path.join(sb.root, 'termux', 'usr', 'bin');
  const termuxHome = path.join(sb.root, 'termux', 'home');
  fs.mkdirSync(termuxBin, { recursive: true });
  fs.mkdirSync(termuxHome, { recursive: true });
  const bashrc = path.join(sb.home, '.bashrc');
  fs.writeFileSync(bashrc, 'export A=1\nalias ll="ls -l"');   // no trailing newline on purpose
  fs.writeFileSync(path.join(termuxHome, '.bashrc'), '# termux\n');
  const env = { PATH: process.env.PATH, HOME: sb.home, OAUTO_INSTALL_BIN: bin, OAUTO_INSTALL_TERMUX_BIN: termuxBin, OAUTO_INSTALL_TERMUX_HOME: termuxHome, OAUTO_INSTALL_BASHRC: bashrc };
  const run = (...args) => spawnSync('bash', [INSTALL, ...args], { encoding: 'utf8', env });

  let r = run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /installed: .*\/bin\/ai-launch/);
  assert.match(r.stdout, /appended: .*\.bashrc block/);
  assert.equal(fs.readFileSync(path.join(bin, 'oauto-run'), 'utf8'), fs.readFileSync(RUN, 'utf8'));
  assert.equal(fs.statSync(path.join(bin, 'oauto-run')).mode & 0o777, 0o755);
  const rc = fs.readFileSync(bashrc, 'utf8');
  assert.ok(rc.startsWith('export A=1\nalias ll="ls -l"\n\n# >>> funzi7 oauto launcher >>>'));
  assert.ok(rc.endsWith('# <<< funzi7 oauto launcher <<<\n'));
  assert.ok(fs.existsSync(path.join(termuxBin, 'oauto-launch')));

  r = run('--verify');
  assert.equal(r.status, 0, r.stdout);
  r = run();
  assert.equal(r.status, 0);
  assert.ok(!/installed:|appended:|updated:/.test(r.stdout), 'second apply must change nothing');

  fs.appendFileSync(path.join(bin, 'oauto-run'), '# drift\n');
  r = run('--verify');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /DRIFT: .*oauto-run/);
  r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /backup: .*oauto-run\.backup-before-oauto-/);
  assert.equal(fs.readFileSync(path.join(bin, 'oauto-run'), 'utf8'), fs.readFileSync(RUN, 'utf8'));

  // Block drift is replaced in place; the rest of the file is preserved.
  fs.writeFileSync(bashrc, rc.replace('oauto-launch "$@"', 'echo tampered').replace('/root/work/bin/ai-launch opencode "$@"', 'echo tampered') + 'export Z=9\n');
  r = run();
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /updated: .*\.bashrc block/);
  const after = fs.readFileSync(bashrc, 'utf8');
  assert.ok(after.startsWith('export A=1\nalias ll="ls -l"\n\n# >>> funzi7 oauto launcher >>>'));
  assert.ok(after.includes('/root/work/bin/ai-launch opencode "$@"'));
  assert.ok(after.endsWith('# <<< funzi7 oauto launcher <<<\nexport Z=9\n'));

  // An unpaired marker is refused and the file is left alone.
  fs.writeFileSync(bashrc, '# >>> funzi7 oauto launcher >>>\nB\nC\n');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /1 start and 0 end markers/);
  assert.equal(fs.readFileSync(bashrc, 'utf8'), '# >>> funzi7 oauto launcher >>>\nB\nC\n');

  r = run('--verfy');
  assert.equal(r.status, 64);
});

test('installed launcher copies match the repository (device only)', (t) => {
  const live = '/root/work/bin/ai-launch';
  if (!fs.existsSync(live)) {
    t.skip('not on the Termux/Debian device');
    return;
  }
  for (const [repoFile, installed] of [
    [AI_LAUNCH, live],
    [RUN, '/root/work/bin/oauto-run'],
    [POLICY, '/root/work/bin/oauto-policy.py'],
  ]) {
    assert.ok(fs.existsSync(installed), `${installed} not installed`);
    assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(repoFile, 'utf8'), `${installed} drifted from ${repoFile}`);
  }
});
