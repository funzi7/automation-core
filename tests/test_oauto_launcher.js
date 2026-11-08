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
  assert.ok(lines.includes('CONTENT .git/config: remote URL or http header embeds credentials'));
  assert.match(lines[lines.length - 1], /^SUMMARY files=\d+ elapsed=[\d.]+s complete=1$/);
  const exhausted = policy(['scan', repo, '--budget', '0']);
  assert.equal(exhausted.status, 3);
  assert.match(exhausted.stdout, /complete=0/);
});

test('scan reports in-repository symlinks to secret-like targets with the reason, and http credentials in .git/config', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'scan-alias', { 'src/a.py': 'x = 1\n', 'packages/pkg/index.js': '1\n', '.ssh/config': 'Host x\n',
    'Config/Prod.Secrets.YAML': 'k: v\n', 'deploy/.aws/credentials': '[default]\n' }, { commit: false });
  const real = fs.realpathSync(repo);
  const aliases = [['review-config.txt', '.git/config'], ['git-meta', '.git'], ['cfg', '.ssh'],
    ['n', 'Config/Prod.Secrets.YAML'], ['docs/aws', '../deploy/.aws', 'deploy/.aws']];
  fs.mkdirSync(path.join(repo, 'docs'));
  for (const [link, target] of aliases) fs.symlinkSync(target, path.join(repo, link));
  fs.symlinkSync('src/a.py', path.join(repo, 'link-inside'));
  fs.mkdirSync(path.join(repo, 'node_modules'));
  fs.symlinkSync('../packages/pkg', path.join(repo, 'node_modules', 'pkg'));
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[http "https://example.invalid/"]\n\textraheader = AUTHORIZATION: basic xyz\n');
  const r = policy(['scan', repo, '--budget', '60']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  for (const [link, target, relTarget = target] of aliases) {
    assert.ok(lines.includes(`SYMLINK ${link} -> ${real}/${relTarget} (secret-like target: ${relTarget})`), `${link}:\n${r.stdout}`);
  }
  assert.ok(!lines.some((l) => /^SYMLINK (link-inside|node_modules\/pkg) /.test(l)), `ordinary in-repo links stay tolerated:\n${r.stdout}`);
  assert.ok(lines.includes('CONTENT .git/config: remote URL or http header embeds credentials'), r.stdout);

  // Any extraHeader line (any case) and any Authorization: Bearer/Basic value count; a plain config does not.
  for (const [label, text, flagged] of [
    ['extraHeader, other case and value', '[http]\n\tExtraHeader = X-Trace: 1\n', true],
    ['bearer token elsewhere', '[credential]\n\thelper = store\n# Authorization: Bearer SYNTH-HEADER-TOKEN-0d1e\n', true],
    ['plain remote', '[remote "origin"]\n\turl = https://example.invalid/x.git\n', false],
  ]) {
    const plain = mkRepo(sb, `scan-header-${label.replace(/\W+/g, '-')}`, { 'a.txt': 'a\n' }, { commit: false });
    fs.appendFileSync(path.join(plain, '.git', 'config'), text);
    const out = policy(['scan', plain, '--budget', '60']).stdout;
    assert.equal(out.includes('CONTENT .git/config: remote URL or http header embeds credentials'), flagged, `${label}:\n${out}`);
  }
});

test('SENSITIVE_DIR_COMPONENTS names exactly the directories the read patterns protect', () => {
  const r = spawnSync('python3', ['-I', '-c', [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("oauto_policy", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'print(json.dumps({"patterns": mod.SENSITIVE_READ_PATTERNS, "dirs": sorted(mod.SENSITIVE_DIR_COMPONENTS)}))',
  ].join('\n'), POLICY], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { patterns, dirs } = JSON.parse(r.stdout);
  // Only X/* and */X/* deny directory X as a whole (.docker/config.json denies one file).
  const derived = new Set();
  for (const p of patterns) {
    const m = p.match(/^(?:\*\/)?([^*?/]+)\/\*$/);
    if (m) derived.add(m[1]);
  }
  assert.deepEqual([...derived].sort(), dirs);
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

// ---------------------------------------------------------------------------
// The git preflight runs before OpenCode's restrictions apply: no helper program
// the repository configures may run, pathnames are classified by their exact
// bytes, and rename detection may not hide a secret-like path.
// ---------------------------------------------------------------------------
function readPreflight(sb, repo) {
  return fs.readFileSync(path.join(stateDir(sb, repo), 'preflight.md'), 'utf8');
}

// Text from `from` up to (not including) `to`; '' when `from` is absent.
function sectionOf(text, from, to) {
  const start = text.indexOf(from);
  if (start < 0) return '';
  const end = to ? text.indexOf(to, start + from.length) : -1;
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

// Lines of the preflight's "Excluded" block ([] when there is none).
function excludedLines(preflight) {
  const m = preflight.match(/## Excluded from this preflight \(secret-like paths; names only\)\n```\n([\s\S]*?)```\n/);
  return m ? m[1].split('\n').filter(Boolean) : [];
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const nulJoin = (...items) => Buffer.concat(items.flatMap((x) => [Buffer.from(x), Buffer.from([0])]));

function policyBytes(args, input) {
  return spawnSync('python3', ['-I', POLICY, ...args], { input });
}

// Helper programs that only leave a marker behind: any marker means git ran one.
function probes(sb, names) {
  const dir = path.join(sb.root, 'markers');
  fs.mkdirSync(dir, { recursive: true });
  const scripts = {};
  for (const name of names) {
    scripts[name] = path.join(sb.root, `probe-${name}`);
    fs.writeFileSync(scripts[name], `#!/bin/sh\ntouch '${path.join(dir, name)}'\nexit 0\n`);
    fs.chmodSync(scripts[name], 0o755);
  }
  return {
    scripts,
    fired: () => fs.readdirSync(dir).sort(),
    clear: () => { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f)); },
  };
}

// An empty commit whose object carries a (synthetic) gpgsig header, so that git log
// has a signature it could verify.
function commitWithSignatureHeader(repo, message) {
  const tree = git(repo, ['rev-parse', 'HEAD^{tree}']).trim();
  const parent = git(repo, ['rev-parse', 'HEAD']).trim();
  const who = 'oauto-test <oauto-test@example.invalid> 1700000000 +0000';
  const object = [`tree ${tree}`, `parent ${parent}`, `author ${who}`, `committer ${who}`,
    'gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' iQEzBAABCAAdFiEESYNTHETICSIGNATUREFOROAUTOTESTS', ' =oaut',
    ' -----END PGP SIGNATURE-----', '', message, ''].join('\n');
  const sha = git(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], object).trim();
  git(repo, ['update-ref', 'refs/heads/main', sha]);
}

// A settings file long enough for git's rename detection to pair it after one line changed.
function settings(token) {
  return ['# service settings', 'HOST=db.internal', 'PORT=5432', 'POOL=8', 'TIMEOUT=30',
    'RETRIES=3', 'REGION=eu-1', 'LOG=info', `TOKEN=${token}`, ''].join('\n');
}

test('P1-A: the preflight runs no repository-configured git helper (textconv, external diff, filters, fsmonitor, hooks, gpg)', () => {
  const sb = sandbox();
  const p = probes(sb, ['textconv', 'diff-command', 'diff-external', 'env-external-diff', 'filter-clean', 'filter-smudge',
    'filter-process', 'filter-empty-name', 'filter-from-env', 'filter-in-submodule', 'filter-equals-name', 'fsmonitor', 'gpg',
    'post-index-change']);
  const s = p.scripts;
  const sub = mkRepo(sb, 'helpers-sub', { '.gitattributes': '* filter=subprobe\n', 'lib.txt': 'lib\n' });
  const repo = mkRepo(sb, 'helpers', {
    '.gitattributes': '*.txt diff=probe\n*.txt filter=probe\n*.md filter=envprobe\n*.cfg filter=\n*.ini filter=x=y\n',
    'notes.txt': 'alpha\n', 'other.md': 'one\n', 'app.cfg': 'k=1\n', 'conf.ini': 'a=1\n', 'touched.md': 'same\n',
  });
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/lib']);
  git(repo, ['commit', '-q', '-m', 'add submodule']);
  commitWithSignatureHeader(repo, 'signed (synthetic) commit');
  const hooks = path.join(sb.root, 'hooks');
  fs.mkdirSync(hooks);
  fs.copyFileSync(s['post-index-change'], path.join(hooks, 'post-index-change'));
  fs.chmodSync(path.join(hooks, 'post-index-change'), 0o755);
  const fired = {};

  // Phase 1, the reported finding: a textconv driver selected by the tracked .gitattributes.
  git(repo, ['config', 'diff.probe.textconv', s.textconv]);
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'beta\n');
  p.clear();
  const r1 = runOauto(sb, repo, ['--check']);
  fired.textconv = p.fired();
  const preflight1 = r1.status === 0 ? readPreflight(sb, repo) : '';

  // Phase 2: every other helper the repository config, a submodule's own config or the
  // caller's environment can select, all at once.
  for (const [key, value] of [
    ['diff.probe.command', s['diff-command']], ['diff.external', s['diff-external']],
    ['filter.probe.clean', s['filter-clean']], ['filter.probe.smudge', s['filter-smudge']],
    ['filter.probe.process', s['filter-process']], ['filter.probe.required', 'true'],
    ['core.fsmonitor', s.fsmonitor], ['log.showSignature', 'true'], ['gpg.program', s.gpg],
    ['core.hooksPath', hooks],
  ]) git(repo, ['config', key, value]);
  fs.appendFileSync(path.join(repo, '.git', 'config'), `[filter ""]\n\tclean = ${s['filter-empty-name']}\n`);
  git(path.join(repo, 'vendor', 'lib'), ['config', 'filter.subprobe.clean', s['filter-in-submodule']]);
  fs.writeFileSync(path.join(repo, 'other.md'), 'two\n');
  fs.writeFileSync(path.join(repo, 'app.cfg'), 'k=2\n');
  const past = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(path.join(repo, 'touched.md'), past, past); // stat-only change: git diff rewrites the index
  fs.utimesSync(path.join(repo, 'vendor', 'lib', 'lib.txt'), past, past); // dirty submodule worktree
  const callerEnv = {
    GIT_EXTERNAL_DIFF: s['env-external-diff'],
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.envprobe.clean', GIT_CONFIG_VALUE_0: s['filter-from-env'],
  };
  p.clear();
  const r2 = runOauto(sb, repo, ['--check'], callerEnv);
  fired.everything = p.fired();
  const preflight2 = r2.status === 0 ? readPreflight(sb, repo) : '';

  // Phase 3: a driver named "x=y" cannot be addressed by git -c, so it cannot be
  // neutralised; the launcher must refuse before any diff runs.
  git(repo, ['config', 'filter.x=y.clean', s['filter-equals-name']]);
  fs.writeFileSync(path.join(repo, 'conf.ini'), 'a=2\n');
  p.clear();
  const r3 = runOauto(sb, repo, ['--check'], callerEnv);
  fired.equalsName = p.fired();

  assert.deepEqual(fired, { textconv: [], everything: [], equalsName: [] }, 'no helper program may run during the preflight');
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(preflight1, /diff --git a\/notes\.txt b\/notes\.txt\n[\s\S]*?-alpha\n\+beta\n/, 'the raw .txt diff must be shown');
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(sectionOf(preflight2, '## git status --short', '## Uncommitted').includes('\n M notes.txt\n'), preflight2);
  assert.match(preflight2, /diff --git a\/notes\.txt b\/notes\.txt\n[\s\S]*?-alpha\n\+beta\n/);
  assert.match(preflight2, /diff --git a\/other\.md b\/other\.md\n[\s\S]*?-one\n\+two\n/);
  assert.match(preflight2, /diff --git a\/app\.cfg b\/app\.cfg\n[\s\S]*?-k=1\n\+k=2\n/);
  assert.equal(r3.status, 1, `an un-neutralisable filter driver must refuse the launch:\n${r3.stderr}`);
  assert.match(r3.stderr, /filter driver name contains '='/);
});

test('P1-B: a deleted tracked secret with a TAB in its name is excluded, without the sensitive-files override', () => {
  const sb = sandbox();
  const secret = 'SYNTH-TAB-SECRET-7f3a';
  const repo = mkRepo(sb, 'tab-name', { 'prod\t.env': `API_TOKEN=${secret}\n`, 'src/a.py': 'x = 1\n' });
  git(repo, ['rm', '-q', '--', 'prod\t.env']);
  fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 2\n');
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  assert.ok(!preflight.includes(secret), 'the deleted secret must not reach the preflight');
  assert.deepEqual(excludedLines(preflight), ['"prod\\t.env"']);
  assert.match(preflight, /-x = 1\n\+x = 2\n/);
  assert.match(r.stderr, /secret-like paths excluded/);
});

test('P1-B: newline, non-ASCII, space, quote, backslash and leading-dash names never leak a deleted or modified secret', () => {
  const sb = sandbox();
  const cases = [
    // [name, synthetic secret, deleted with, as the Excluded block must show it]
    ['new\nline.env', 'SYNTH-NEWLINE-SECRET-1b2c', 'git rm', '"new\\nline.env"'],
    ['naïve.env', 'SYNTH-UTF8-SECRET-3d4e', 'rm', '"na\\303\\257ve.env"'],
    ['with space.env', 'SYNTH-SPACE-SECRET-5f60', 'git rm', 'with space.env'],
    ['dq"del.env', 'SYNTH-DQUOTE-SECRET-7a8b', 'rm', '"dq\\"del.env"'],
    ['back\\slash.env', 'SYNTH-BACKSLASH-SECRET-9c0d', 'git rm', '"back\\\\slash.env"'],
    ['-dash.env', 'SYNTH-DASH-SECRET-e1f2', 'rm', '-dash.env'],
  ];
  const files = { 'src/naïve file.py': 'x = 1\n' };
  for (const [name, secret] of cases) files[name] = `TOKEN=${secret}\n`;
  const repo = mkRepo(sb, 'special-names', files);
  for (const [name, , how] of cases) {
    if (how === 'git rm') git(repo, ['rm', '-q', '--', name]);
    else fs.rmSync(path.join(repo, name));
  }
  fs.writeFileSync(path.join(repo, 'src/naïve file.py'), 'x = 2\n');
  const promptFile = path.join(sb.root, 'prompt-deleted.txt');
  fakeControl(sb, { PROMPT_FILE: promptFile });
  // A full launch (no --check, nothing secret-like left in the worktree), so the test
  // double records the whole prompt OpenCode would receive.
  const r = runOauto(sb, repo, []);
  assert.equal(r.status, 0, r.stderr);
  const sd = stateDir(sb, repo);
  const preflight = readPreflight(sb, repo);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const helperErr = fs.readFileSync(path.join(sd, 'last-helper.err'), 'utf8');
  const leaked = cases.filter(([, secret]) => preflight.includes(secret) || prompt.includes(secret) || helperErr.includes(secret))
    .map(([name]) => JSON.stringify(name));
  assert.deepEqual(leaked, [], 'no deleted secret may reach the preflight, the prompt or the helper log');
  assert.deepEqual(excludedLines(preflight), [...cases].sort((a, b) => byteOrder(a[0], b[0])).map((c) => c[3]));
  assert.ok(prompt.includes(preflight.trimEnd()), 'the prompt carries the preflight verbatim');
  // F: a non-sensitive file with a special name keeps its diff.
  assert.match(preflight, /diff --git "a\/src\/na\\303\\257ve file\.py" "b\/src\/na\\303\\257ve file\.py"\n[\s\S]*?-x = 1\n\+x = 2\n/);

  // A MODIFIED tracked secret stays in the worktree: refused unless overridden, and its
  // old and new values stay out of the preflight either way.
  const repo2 = mkRepo(sb, 'quoted-modified', { 'quo"te.env': 'TOKEN=SYNTH-QUOTE-OLD-1a2b\n', 'src/b.py': 'y = 1\n' });
  fs.writeFileSync(path.join(repo2, 'quo"te.env'), 'TOKEN=SYNTH-QUOTE-NEW-3c4d\n');
  fs.writeFileSync(path.join(repo2, 'src/b.py'), 'y = 2\n');
  assert.equal(runOauto(sb, repo2, ['--check']).status, 1, 'a secret-like file in the worktree needs the override');
  const promptFile2 = path.join(sb.root, 'prompt-modified.txt');
  fakeControl(sb, { PROMPT_FILE: promptFile2 });
  const r2 = runOauto(sb, repo2, [], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r2.status, 0, r2.stderr);
  const preflight2 = readPreflight(sb, repo2);
  const prompt2 = fs.readFileSync(promptFile2, 'utf8');
  for (const secret of ['SYNTH-QUOTE-OLD-1a2b', 'SYNTH-QUOTE-NEW-3c4d']) {
    assert.ok(!preflight2.includes(secret) && !prompt2.includes(secret), `${secret} must not reach the preflight or prompt`);
  }
  assert.deepEqual(excludedLines(preflight2), ['"quo\\"te.env"']);
  assert.match(preflight2, /-y = 1\n\+y = 2\n/);
});

test('P1-C: a staged rename never hides a secret-like source or destination (uncommitted changes)', () => {
  const sb = sandbox();
  const variants = {
    // git mv .env safe.txt, then the secret in the destination replaced by a placeholder
    sanitised: { from: '.env', to: 'safe.txt', secret: 'SYNTH-RENAME-SECRET-a1b2', rewrite: settings('PLACEHOLDER-0000'), env: {} },
    // git mv .env safe.txt, content unchanged
    pure: { from: '.env', to: 'safe.txt', secret: 'SYNTH-PURE-SECRET-c3d4', rewrite: null, env: {} },
    // git mv notes.txt .env: the destination is the secret-like side
    reverse: { from: 'notes.txt', to: '.env', secret: 'SYNTH-REVERSE-SECRET-e5f6', rewrite: null, env: { OAUTO_ALLOW_SENSITIVE_FILES: '1' } },
  };
  const results = {};
  for (const [label, v] of Object.entries(variants)) {
    const repo = mkRepo(sb, `mv-${label}`, { [v.from]: settings(v.secret), 'src/a.py': 'x = 1\n' });
    git(repo, ['mv', v.from, v.to]);
    if (v.rewrite !== null) fs.writeFileSync(path.join(repo, v.to), v.rewrite);
    const r = runOauto(sb, repo, ['--check'], v.env);
    results[label] = { r, preflight: r.status === 0 ? readPreflight(sb, repo) : '' };
  }
  const leaked = Object.keys(variants).filter((label) => results[label].preflight.includes(variants[label].secret));
  assert.deepEqual(leaked, [], 'a rename may not carry a secret into the preflight');
  for (const [label, { r }] of Object.entries(results)) assert.equal(r.status, 0, `${label}: ${r.stderr}`);
  for (const label of ['sanitised', 'pure']) {
    const { preflight } = results[label];
    assert.ok(!preflight.includes('diff --git a/safe.txt '), `${label}: the renamed destination's hunk must be excluded`);
    assert.ok(!preflight.includes('PLACEHOLDER-0000'));
    assert.deepEqual(excludedLines(preflight), ['.env (renamed to "safe.txt")', 'safe.txt (renamed from ".env")'], label);
  }
  const { preflight } = results.reverse;
  assert.ok(!preflight.includes('diff --git a/notes.txt ') && !preflight.includes('diff --git a/.env '));
  assert.deepEqual(excludedLines(preflight), ['.env (renamed from "notes.txt")', 'notes.txt (renamed to ".env")']);
  for (const { preflight: text } of Object.values(results)) assert.match(text, /^## Uncommitted changes/m);
});

test('P1-C: branch-delta renames exclude both sides, and a non-sensitive rename diffs as delete + add', () => {
  const sb = sandbox();
  const py = (version) => ['def area(w, h):', '    return w * h', '', 'def perimeter(w, h):', '    return 2 * (w + h)',
    '', 'def square(s):', '    return area(s, s)', '', `VERSION = "${version}"`, ''].join('\n');
  const repo = mkRepo(sb, 'branch-rename', {
    '.env': settings('SYNTH-BRANCH-SECRET-0a1b'),
    'keys/deploy.pem': 'synthetic test material, not a key\nSYNTH-BRANCH-PEM-2c3d\n',
    'config/app.env': settings('SYNTH-WORKTREE-SECRET-4e5f'),
    'a.py': py('1'),
  });
  git(repo, ['checkout', '-q', '-b', 'feature']);
  git(repo, ['mv', '.env', 'settings.txt']);
  fs.writeFileSync(path.join(repo, 'settings.txt'), settings('PLACEHOLDER-1111')); // sanitised destination
  git(repo, ['mv', 'keys/deploy.pem', 'keys/deploy.txt']); // pure rename
  git(repo, ['mv', 'a.py', 'b.py']);
  fs.writeFileSync(path.join(repo, 'b.py'), py('2'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'move settings']);
  // The worktree variant on top: an uncommitted, sanitised rename of another secret.
  git(repo, ['mv', 'config/app.env', 'config/app.txt']);
  fs.writeFileSync(path.join(repo, 'config/app.txt'), settings('PLACEHOLDER-2222'));
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  const secrets = ['SYNTH-BRANCH-SECRET-0a1b', 'SYNTH-BRANCH-PEM-2c3d', 'SYNTH-WORKTREE-SECRET-4e5f'];
  assert.deepEqual(secrets.filter((x) => preflight.includes(x)), [], 'no secret may reach the preflight');
  assert.match(preflight, /- Base for branch delta: main \(behind 0, ahead 1\)/);
  const delta = sectionOf(preflight, '## Branch delta vs main');
  const uncommitted = sectionOf(preflight, '## Uncommitted changes', '## Recent commits');
  assert.ok(delta && uncommitted, preflight);
  for (const p of ['.env', 'settings.txt', 'keys/deploy.pem', 'keys/deploy.txt']) {
    assert.ok(!delta.includes(`diff --git a/${p} `), `${p} must be excluded from the branch delta`);
  }
  for (const p of ['config/app.env', 'config/app.txt']) {
    assert.ok(!uncommitted.includes(`diff --git a/${p} `), `${p} must be excluded from the uncommitted diff`);
  }
  assert.match(delta, /diff --git a\/a\.py b\/a\.py\ndeleted file mode 100644\n/);
  assert.match(delta, /diff --git a\/b\.py b\/b\.py\nnew file mode 100644\n[\s\S]*?\+VERSION = "2"\n/);
  assert.ok(!/^(rename|copy) (from|to) |^similarity index /m.test(preflight), 'renames must diff as delete + add');
  assert.deepEqual(excludedLines(preflight), [
    '.env (renamed to "settings.txt")',
    'config/app.env (renamed to "config/app.txt")',
    'config/app.txt (renamed from "config/app.env")',
    'keys/deploy.pem (renamed to "keys/deploy.txt")',
    'keys/deploy.txt (renamed from "keys/deploy.pem")',
    'settings.txt (renamed from ".env")',
  ]);
});

// Similar but not identical: one non-secret line changes, the TOKEN line stays.
const tweakSettings = (text) => text.replace('POOL=8', 'POOL=16');
const utilPy = (version) => ['def f():', '    return 1', '', 'def g():', '    return 2', '', `V = ${version}`, ''].join('\n');

test('P1-C: a repository diff.renameLimit cannot unpair a renamed secret from its safe-named destination', () => {
  const sb = sandbox();
  const secrets = { 'config/one.env': 'SYNTH-LIMIT-SECRET-1a1a', 'keys/two.pem': 'SYNTH-LIMIT-SECRET-2b2b' };
  const repo = mkRepo(sb, 'rename-limit', {
    'config/one.env': settings(secrets['config/one.env']), 'keys/two.pem': settings(secrets['keys/two.pem']), 'lib/util.py': utilPy(1),
  });
  // Throttles git's inexact rename detection: with more than 1x1 candidates it is skipped.
  git(repo, ['config', 'diff.renameLimit', '1']);
  git(repo, ['mv', 'config/one.env', 'config/one.txt']);
  git(repo, ['mv', 'keys/two.pem', 'keys/two.txt']);
  git(repo, ['mv', 'lib/util.py', 'lib/helpers.py']);
  writeFiles(repo, {
    'config/one.txt': tweakSettings(settings(secrets['config/one.env'])),
    'keys/two.txt': tweakSettings(settings(secrets['keys/two.pem'])),
    'lib/helpers.py': utilPy(2),
  });
  git(repo, ['add', '-A']);
  const promptFile = path.join(sb.root, 'prompt-rename-limit.txt');
  fakeControl(sb, { PROMPT_FILE: promptFile });
  const r = runOauto(sb, repo, []); // full launch: the recorded --prompt is checked as well
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.deepEqual(Object.values(secrets).filter((x) => preflight.includes(x) || prompt.includes(x)), [],
    'a throttled rename detection may not let a renamed secret reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), [
    'config/one.env (renamed to "config/one.txt")',
    'config/one.txt (renamed from "config/one.env")',
    'keys/two.pem (renamed to "keys/two.txt")',
    'keys/two.txt (renamed from "keys/two.pem")',
  ]);
  assert.match(preflight, /diff --git a\/lib\/util\.py b\/lib\/util\.py\ndeleted file mode 100644\n/);
  assert.match(preflight, /diff --git a\/lib\/helpers\.py b\/lib\/helpers\.py\nnew file mode 100644\n[\s\S]*?\+V = 2\n/);
  assert.ok(!/^(rename|copy) (from|to) |^similarity index /m.test(preflight), 'renames must diff as delete + add');
});

test('P1-C: a copy of a secret modified in the same change set is excluded under its safe name too', () => {
  const sb = sandbox();
  const secret = 'SYNTH-COPY-SECRET-3c3c';
  const repo = mkRepo(sb, 'copy-modified', { '.env': settings(secret), 'src/a.py': 'x = 1\n' });
  writeFiles(repo, { '.env': tweakSettings(settings(secret)), 'env-backup.txt': settings(secret), 'src/a.py': 'x = 2\n' });
  git(repo, ['add', '-A']);
  const r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' }); // .env stays in the worktree
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  assert.ok(!preflight.includes(secret), 'the copied secret must not reach the preflight');
  assert.deepEqual(excludedLines(preflight), ['.env (copied to "env-backup.txt")', 'env-backup.txt (copied from ".env")']);
  assert.match(preflight, /-x = 1\n\+x = 2\n/);
});

test('oauto-run has no branch delta when the base shares no history with HEAD (the strict pair pass does not refuse)', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'orphan', { 'a.txt': 'a\n' });
  git(repo, ['checkout', '-q', '--orphan', 'island']);
  git(repo, ['rm', '-rqf', '.']);
  writeFiles(repo, { 'island.txt': 'i\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'island']);
  fs.writeFileSync(path.join(repo, 'island.txt'), 'j\n');
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  assert.match(preflight, /- Base for branch delta: \(none found\) \n/);
  assert.ok(!preflight.includes('## Branch delta'));
  assert.match(preflight, /-i\n\+j\n/);
});

test('P1-D: in-repository symlinks aliasing Git metadata or secret-like paths are refused; ordinary in-repository links are not', () => {
  const sb = sandbox();
  // A harmless-looking name for .git/config (and one for .git itself), plain --check.
  const repo = mkRepo(sb, 'alias-git', { 'src/a.py': 'x = 1\n' });
  fs.symlinkSync('.git/config', path.join(repo, 'review-config.txt'));
  fs.symlinkSync('.git', path.join(repo, 'git-meta'));
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `an alias of .git/config must be refused:\n${r.stderr}`);
  assert.match(r.stderr, /symlinks leaving the repository or aliasing secret-like paths/);
  assert.match(r.stderr, /review-config\.txt -> \S+\/\.git\/config \(secret-like target: \.git\/config\)/);
  assert.match(r.stderr, /git-meta -> \S+\/\.git \(secret-like target: \.git\)/);
  assert.ok(!fs.existsSync(stateDir(sb, repo)), 'nothing is rendered before the scan passes');

  // Aliases of a protected directory and of secret-like files: refused even with the
  // sensitive-files override, which only accepts such files under their own names.
  const repo2 = mkRepo(sb, 'alias-secrets', { 'src/a.py': 'x = 1\n', '.ssh/config': 'Host example\n',
    'config/prod.secrets.yaml': 'k: v\n', 'keys/server.pem': 'synthetic test material\n' });
  fs.symlinkSync('.ssh', path.join(repo2, 'cfg'));
  fs.symlinkSync('config/prod.secrets.yaml', path.join(repo2, 'n'));
  fs.symlinkSync('keys/server.pem', path.join(repo2, 'k'));
  r = runOauto(sb, repo2, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, r.stderr);
  for (const [link, target] of [['cfg', '.ssh'], ['n', 'config/prod.secrets.yaml'], ['k', 'keys/server.pem']]) {
    assert.ok(r.stderr.includes(`${link} -> ${fs.realpathSync(repo2)}/${target} (secret-like target: ${target})`), `${link}:\n${r.stderr}`);
  }

  // Ordinary in-repository links stay tolerated.
  const repo3 = mkRepo(sb, 'alias-ordinary', { 'src/a.py': 'x = 1\n', 'packages/pkg/index.js': 'module.exports = 1;\n' });
  fs.symlinkSync('src/a.py', path.join(repo3, 'link-inside'));
  fs.mkdirSync(path.join(repo3, 'node_modules'));
  fs.symlinkSync('../packages/pkg', path.join(repo3, 'node_modules', 'pkg'));
  r = runOauto(sb, repo3, ['--check']);
  assert.equal(r.status, 0, r.stderr);
});

const GRADLE_SECRET = 'SYNTH-GRADLE-SECRET-91af';
const gradleProps = ({ password = true, jvm = '1g' } = {}) => [`org.gradle.jvmargs=-Xmx${jvm}`,
  ...(password ? [`signingPassword=${GRADLE_SECRET}`] : []), 'org.gradle.parallel=true', ''].join('\n');

// Full launch: the test double records the whole prompt OpenCode would receive.
function launchRecordingPrompt(sb, repo, env = {}) {
  const promptFile = path.join(sb.root, `prompt-${path.basename(repo)}.txt`);
  fakeControl(sb, { PROMPT_FILE: promptFile });
  const r = runOauto(sb, repo, [], env);
  return {
    r,
    preflight: r.status === 0 ? readPreflight(sb, repo) : '',
    prompt: fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : '',
  };
}

test('P1-E: removing a credential line from gradle.properties keeps the removed value out of the preflight and the prompt', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'gradle-edit', { 'gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  writeFiles(repo, { 'gradle.properties': gradleProps({ password: false }), 'src/a.py': 'x = 2\n' });
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/credential-looking content in:/.test(r.stderr), 'the worktree is clean, so the scan reports nothing');
  assert.ok(!preflight.includes(GRADLE_SECRET) && !prompt.includes(GRADLE_SECRET), 'the removed credential must not reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), ['gradle.properties (credential-looking content in its diff)']);
  assert.ok(!preflight.includes('diff --git a/gradle.properties '));
  assert.match(preflight, /-x = 1\n\+x = 2\n/);
});

test('P1-E: a deleted, nested or branch-committed credential removal is excluded, an innocuous gradle.properties edit is shown', () => {
  const sb = sandbox();
  const results = {};
  // (b) the file deleted in the worktree
  const deleted = mkRepo(sb, 'gradle-deleted', { 'gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  fs.rmSync(path.join(deleted, 'gradle.properties'));
  results.deleted = { ...launchRecordingPrompt(sb, deleted), file: 'gradle.properties' };
  // (e) a nested app/gradle.properties, the line removed and staged
  const nested = mkRepo(sb, 'gradle-nested', { 'app/gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  fs.writeFileSync(path.join(nested, 'app/gradle.properties'), gradleProps({ password: false }));
  git(nested, ['add', '-A']);
  results.nested = { ...launchRecordingPrompt(sb, nested), file: 'app/gradle.properties' };
  // (c) the removal committed on a feature branch off main: only the branch delta carries it
  const branch = mkRepo(sb, 'gradle-branch', { 'gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  git(branch, ['checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(branch, 'gradle.properties'), gradleProps({ password: false }));
  git(branch, ['commit', '-q', '-am', 'drop the signing password']);
  results.branch = { ...launchRecordingPrompt(sb, branch), file: 'gradle.properties' };
  const leaked = Object.keys(results).filter((k) => results[k].preflight.includes(GRADLE_SECRET) || results[k].prompt.includes(GRADLE_SECRET));
  assert.deepEqual(leaked, [], 'a removed credential may not reach the preflight or the prompt');
  for (const [label, x] of Object.entries(results)) {
    assert.equal(x.r.status, 0, `${label}: ${x.r.stderr}`);
    assert.deepEqual(excludedLines(x.preflight), [`${x.file} (credential-looking content in its diff)`], label);
  }
  const delta = sectionOf(results.branch.preflight, '## Branch delta vs main');
  assert.ok(delta && !delta.includes('gradle.properties'), `the branch delta must not show gradle.properties:\n${delta}`);

  // (d) an innocuous edit of a credential-free gradle.properties is reviewed as usual.
  const innocuous = mkRepo(sb, 'gradle-innocuous', { 'gradle.properties': gradleProps({ password: false }) });
  fs.writeFileSync(path.join(innocuous, 'gradle.properties'), gradleProps({ password: false, jvm: '2g' }));
  let r = runOauto(sb, innocuous, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  let preflight = readPreflight(sb, innocuous);
  assert.deepEqual(excludedLines(preflight), []);
  assert.match(preflight, /diff --git a\/gradle\.properties b\/gradle\.properties\n[\s\S]*?-org\.gradle\.jvmargs=-Xmx1g\n\+org\.gradle\.jvmargs=-Xmx2g\n/);
  // A jvmargs-only edit next to a credential that stays (override set for the scan): the
  // credential would be a context line of the hunk, so the path is excluded.
  const context = mkRepo(sb, 'gradle-context', { 'gradle.properties': gradleProps() });
  fs.writeFileSync(path.join(context, 'gradle.properties'), gradleProps({ jvm: '2g' }));
  r = runOauto(sb, context, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  preflight = readPreflight(sb, context);
  assert.ok(!preflight.includes(GRADLE_SECRET), 'a credential in a context line must not reach the preflight');
  assert.deepEqual(excludedLines(preflight), ['gradle.properties (credential-looking content in its diff)']);
});

test('check-diff-content, classify --content-candidates and quote-path: content-checked diffs fail closed', () => {
  const sb = sandbox();
  const diff = (...hunk) => ['diff --git a/gradle.properties b/gradle.properties', 'index 1111111..2222222 100644',
    '--- a/gradle.properties', '+++ b/gradle.properties', '@@ -1,3 +1,2 @@', ...hunk, ''].join('\n');
  const check = (file, text) => spawnSync('python3', ['-I', POLICY, 'check-diff-content', '--', file], { input: text }).status;
  assert.equal(check('gradle.properties', diff(' org.gradle.jvmargs=-Xmx1g', '-signingPassword=SYNTH', ' org.gradle.parallel=true')), 3, 'removed line');
  assert.equal(check('gradle.properties', diff('+storePassword=SYNTH')), 3, 'added line');
  assert.equal(check('app/Gradle.Properties', diff(' signingPassword=SYNTH', '-org.gradle.jvmargs=-Xmx1g', '+org.gradle.jvmargs=-Xmx2g')), 3,
    'context line, nested path, any case');
  assert.equal(check('-lead/gradle.properties', diff('-api_key = SYNTH')), 3, 'a leading-dash path after --');
  assert.equal(check('gradle.properties', diff('-org.gradle.jvmargs=-Xmx1g', '+org.gradle.jvmargs=-Xmx2g')), 0, 'innocuous edit');
  assert.equal(check('gradle.properties', ''), 0, 'empty diff');
  assert.equal(check('README.md', diff('-password=x')), 2, 'no content check for that name');

  // --checker: the content check a pair partner inherits; an unknown checker fails closed.
  const checkAs = (file, checker, text) => spawnSync('python3', ['-I', POLICY, 'check-diff-content', '--checker', checker, '--', file], { input: text }).status;
  assert.equal(checkAs('release.props', 'gradle.properties', diff('-signingPassword=SYNTH')), 3, 'a renamed gradle.properties keeps its check');
  assert.equal(checkAs('release.props', 'no-such-check', diff('-signingPassword=SYNTH')), 2, 'unknown checker');

  // Candidates are KEY\0PATH\0 records: own name (incl. backup suffixes), or a rename/copy partner.
  const pairs = path.join(sb.root, 'pairs');
  const cands = path.join(sb.root, 'cands');
  fs.writeFileSync(pairs, nulJoin('R100', 'gradle.properties', 'build/gradle.properties', 'R090', 'old/gradle.properties', 'release.props'));
  const r = policyBytes(['classify', '-z', '--renames', pairs, '--content-candidates', cands],
    nulJoin('gradle.properties', 'app/Gradle.Properties', 'src/a.py', '.env', 'gradle.properties.bak', 'gradle.properties.example', 'build/gradle.properties'));
  assert.equal(r.status, 0, r.stderr.toString());
  assert.deepEqual(r.stdout, nulJoin('.env'));
  const key = 'gradle.properties';
  assert.deepEqual(fs.readFileSync(cands), nulJoin(key, 'app/Gradle.Properties', key, 'build/gradle.properties', key, 'gradle.properties',
    key, 'gradle.properties.bak', key, 'old/gradle.properties', key, 'release.props'));
  assert.equal(policy(['classify', '--content-candidates', cands], 'x\n').status, 2, '--content-candidates needs -z');

  const q = policyBytes(['quote-path'], nulJoin('app/gradle.properties', 'tab\tgradle.properties'));
  assert.equal(q.status, 0, q.stderr.toString());
  assert.equal(q.stdout.toString(), 'app/gradle.properties\n"tab\\tgradle.properties"\n');
});

// ---------------------------------------------------------------------------
// Review round 5: alias forms (D1-D4), Git config credential forms (D5) and the
// content checks (E1-E3).
// ---------------------------------------------------------------------------
test('D1: a directory alias of a folder holding secret-like files is refused even with the override; an alias of an ordinary folder is not', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'dir-alias', { 'src/a.py': 'x = 1\n', 'secrets/db.json': '{"password": "SYNTH-DIR-ALIAS-1d1d"}\n', 'docs/readme.md': '# docs\n' });
  fs.symlinkSync('secrets', path.join(repo, 'cfgdir')); // cfgdir/db.json would pass the read rules by name
  let r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, `cfgdir -> secrets must be refused even with the override:\n${r.stderr}`);
  assert.match(r.stderr, /cfgdir -> \S+\/secrets \(aliases a directory holding secret-like files: secrets\/db\.json\)/);
  fs.unlinkSync(path.join(repo, 'cfgdir'));
  fs.symlinkSync('docs', path.join(repo, 'cfgdir'));
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, `cfgdir -> docs holds nothing secret-like:\n${r.stderr}`);
});

test('D3: a link into .docker is judged by its target: Dockerfile is accepted, config.json is refused', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'docker-links', { 'src/a.py': 'x = 1\n', '.docker/Dockerfile': 'FROM scratch\n' });
  fs.symlinkSync('.docker/Dockerfile', path.join(repo, 'Dockerfile'));
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, `Dockerfile -> .docker/Dockerfile aliases nothing secret-like:\n${r.stderr}`);
  fs.writeFileSync(path.join(repo, '.docker/config.json'), '{"auths": {}}\n');
  fs.symlinkSync('.docker/config.json', path.join(repo, 'c'));
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\nc -> \S+\/\.docker\/config\.json \(secret-like target: \.docker\/config\.json\)/);
  assert.ok(!/Dockerfile -> /.test(r.stderr), r.stderr);
});

test('D2: a hard link to .git/config or to a secret-like file is refused; ordinary files, linked or not, are not', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'hard-git', { 'src/a.py': 'x = 1\n' });
  fs.linkSync(path.join(repo, '.git', 'config'), path.join(repo, 'review.txt'));
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `ln .git/config review.txt must be refused:\n${r.stderr}`);
  assert.match(r.stderr, /review\.txt -> \S+\/\.git\/config \(hard link to \.git\/config\)/);
  const repo2 = mkRepo(sb, 'hard-secret', { 'src/a.py': 'x = 1\n', 'keys/server.pem': 'synthetic test material\n', 'docs/a.md': 'a\n' });
  fs.linkSync(path.join(repo2, 'keys/server.pem'), path.join(repo2, 'notes.txt'));
  fs.linkSync(path.join(repo2, 'docs/a.md'), path.join(repo2, 'docs/b.md')); // two ordinary names (pnpm-style): fine
  r = runOauto(sb, repo2, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /notes\.txt -> \S+\/keys\/server\.pem \(hard link to keys\/server\.pem\)/);
  assert.ok(!/docs\/[ab]\.md -> /.test(r.stderr), r.stderr);
  fs.unlinkSync(path.join(repo2, 'notes.txt'));
  r = runOauto(sb, repo2, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
});

test('D4: symlinks inside .git that leave the repository are refused; ones that stay inside are not', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'git-links', { 'src/a.py': 'x = 1\n', 'scripts/hook.sh': '#!/bin/sh\nexit 0\n' });
  fs.symlinkSync('../../scripts/hook.sh', path.join(repo, '.git', 'hooks', 'pre-commit'));
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, `a hook link inside the repository is fine:\n${r.stderr}`);
  fs.symlinkSync('/etc/hostname', path.join(repo, '.git', 'info', 'outward'));
  r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `.git/info/outward -> /etc/hostname must be refused:\n${r.stderr}`);
  assert.match(r.stderr, /\.git\/info\/outward -> \/etc\/hostname/);
});

test('D5: credentials in any Git config of the repository are found and refuse the launch; ordinary remotes do not', () => {
  const sb = sandbox();
  const forms = [
    // [label, file under .git, appended text, reported path]
    ['token as URL user', 'config', '[remote "origin"]\n\turl = https://ghp_SYNTHtoken00000000@github.com/o/r.git\n', '.git/config'],
    ['extraHeader on the section line', 'config', '[http "https://example.invalid/"] extraheader = PRIVATE-TOKEN: SYNTH-PRIVATE-0e0e\n', '.git/config'],
    ['ssh URL with a password', 'config', '[remote "origin"]\n\turl = ssh://deploy:SYNTH-SSH-PW@example.invalid/x.git\n', '.git/config'],
    ['config.worktree', 'config.worktree', '[remote "origin"]\n\turl = https://user:SYNTH-PW-0f0f@example.invalid/x.git\n', '.git/config.worktree'],
    ['linked worktree config.worktree', 'worktrees/wt/config.worktree', '[http]\n\textraHeader = AUTHORIZATION: bearer SYNTH\n', '.git/worktrees/wt/config.worktree'],
    ['linked worktree config', 'worktrees/wt/config', '[remote "o"]\n\turl = https://SYNTH-tok@example.invalid/x\n', '.git/worktrees/wt/config'],
    ['submodule config', 'modules/sub/config', '[remote "origin"]\n\turl = https://ghp_SYNTHsub000000@github.com/o/sub.git\n', '.git/modules/sub/config'],
    ['nested submodule config', 'modules/sub/modules/inner/config', '[http]\n\textraheader = X-Token: 1\n', '.git/modules/sub/modules/inner/config'],
  ];
  const missed = [];
  for (const [label, file, text, reported] of forms) {
    const repo = mkRepo(sb, `cred-${label.replace(/\W+/g, '-')}`, { 'src/a.py': 'x = 1\n' });
    const full = path.join(repo, '.git', file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, text);
    const scanLines = policy(['scan', repo, '--budget', '60']).stdout.split('\n');
    const r = runOauto(sb, repo, ['--check']);
    if (!scanLines.includes(`CONTENT ${reported}: remote URL or http header embeds credentials`) || r.status !== 1
      || !/credential-looking content in:/.test(r.stderr)) missed.push(label);
  }
  assert.deepEqual(missed, [], 'every credential form must be reported and refuse the launch without the override');
  // Ordinary remotes (an ssh login name is not a credential) pass.
  const plain = mkRepo(sb, 'cred-plain', { 'src/a.py': 'x = 1\n' });
  fs.appendFileSync(path.join(plain, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/o/r.git\n'
    + '[remote "ssh"]\n\turl = ssh://git@github.com/o/r.git\n[remote "scp"]\n\turl = git@github.com:o/r.git\n');
  assert.ok(!policy(['scan', plain, '--budget', '60']).stdout.includes('CONTENT .git/config'));
  const r = runOauto(sb, plain, ['--check']);
  assert.equal(r.status, 0, r.stderr);
});

test('E1: gradle.properties credentials are found with =, : or whitespace separators and key-material names', () => {
  const sb = sandbox();
  const hits = ['signingPassword: V', 'signingPassword V', 'signingInMemoryKey=V', 'mavenCentralSecretKey=V'];
  const misses = ['org.gradle.jvmargs=-Xmx1g', 'kotlin.code.style=official'];
  const lines = [...hits, ...misses];
  const files = {};
  lines.forEach((line, i) => { files[`m${i}/gradle.properties`] = `${line}\n`; });
  const repo = mkRepo(sb, 'gradle-forms', files, { commit: false });
  const out = policy(['scan', repo, '--budget', '60']).stdout.split('\n');
  const removedDiff = (line) => ['diff --git a/gradle.properties b/gradle.properties', 'deleted file mode 100644',
    '--- a/gradle.properties', '+++ /dev/null', '@@ -1 +0,0 @@', `-${line}`, ''].join('\n');
  const wrong = [];
  lines.forEach((line, i) => {
    const expected = i < hits.length;
    if (out.includes(`CONTENT m${i}/gradle.properties: credential-looking assignment`) !== expected) wrong.push(`worktree: ${line}`);
    const status = spawnSync('python3', ['-I', POLICY, 'check-diff-content', '--', 'gradle.properties'], { input: removedDiff(line) }).status;
    if (status !== (expected ? 3 : 0)) wrong.push(`removed line: ${line} (exit ${status})`);
  });
  assert.deepEqual(wrong, []);
});

test('E2: content checks follow gradle.properties through renames, copies and backup names; templates stay reviewable', () => {
  const sb = sandbox();
  // git mv to a backup name, credential kept, no override: the scan checks the backup name.
  const kept = mkRepo(sb, 'gradle-bak-kept', { 'gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  git(kept, ['mv', 'gradle.properties', 'gradle.properties.bak']);
  let r = runOauto(sb, kept, ['--check']);
  assert.equal(r.status, 1, `gradle.properties.bak with the credential must be refused:\n${r.stderr}`);
  assert.match(r.stderr, /gradle\.properties\.bak: credential-looking assignment/);
  // A staged copy .orig keeps the credential while gradle.properties is sanitised: refused too.
  const copy = mkRepo(sb, 'gradle-orig', { 'gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  fs.copyFileSync(path.join(copy, 'gradle.properties'), path.join(copy, 'gradle.properties.orig'));
  fs.writeFileSync(path.join(copy, 'gradle.properties'), gradleProps({ password: false }));
  git(copy, ['add', '-A']);
  r = runOauto(sb, copy, ['--check']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /gradle\.properties\.orig: credential-looking assignment/);
  // The credential removed from the .bak but present at HEAD: the deleted source is excluded.
  const sanitised = mkRepo(sb, 'gradle-bak-clean', { 'gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  git(sanitised, ['mv', 'gradle.properties', 'gradle.properties.bak']);
  fs.writeFileSync(path.join(sanitised, 'gradle.properties.bak'), gradleProps({ password: false }));
  const s = launchRecordingPrompt(sb, sanitised);
  assert.equal(s.r.status, 0, s.r.stderr);
  assert.ok(!s.preflight.includes(GRADLE_SECRET) && !s.prompt.includes(GRADLE_SECRET));
  assert.deepEqual(excludedLines(s.preflight), ['gradle.properties (credential-looking content in its diff)']);
  // A rename to a name without a content check of its own: the check follows the pair.
  const moved = mkRepo(sb, 'gradle-moved', { 'gradle.properties': gradleProps(), 'src/a.py': 'x = 1\n' });
  git(moved, ['mv', 'gradle.properties', 'release.props']);
  const m = launchRecordingPrompt(sb, moved);
  assert.equal(m.r.status, 0, m.r.stderr);
  assert.ok(!m.preflight.includes(GRADLE_SECRET) && !m.prompt.includes(GRADLE_SECRET), 'the renamed file must not carry the credential into the preflight');
  assert.deepEqual(excludedLines(m.preflight), ['gradle.properties (credential-looking content in its diff)', 'release.props (credential-looking content in its diff)']);
  // A documented template keeps its placeholder reviewable.
  const template = mkRepo(sb, 'gradle-example', { 'src/a.py': 'x = 1\n' });
  writeFiles(template, { 'gradle.properties.example': 'signingPassword=changeme\n' });
  git(template, ['add', '-A']);
  r = runOauto(sb, template, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const t = readPreflight(sb, template);
  assert.deepEqual(excludedLines(t), []);
  assert.match(t, /diff --git a\/gradle\.properties\.example b\/gradle\.properties\.example\nnew file mode 100644\n[\s\S]*?\+signingPassword=changeme\n/);
});

test('E3: a credential that git copies into a hunk header stays out of the preflight and the prompt', () => {
  const sb = sandbox();
  const secret = 'SYNTH-FUNC-66ff';
  const before = [`signingPassword=${secret}`, '# one', '# two', '# three', '# four', '# five', 'org.gradle.jvmargs=-Xmx1g', ''].join('\n');
  const repo = mkRepo(sb, 'gradle-funcname', { 'gradle.properties': before, 'src/a.py': 'x = 1\n' });
  fs.writeFileSync(path.join(repo, 'gradle.properties'), before.replace('-Xmx1g', '-Xmx2g'));
  // git itself would print "@@ -4,4 +4,4 @@ signingPassword=..." for this hunk.
  assert.match(git(repo, ['diff', 'HEAD']), /^@@ [^@]+ @@ signingPassword=SYNTH-FUNC-66ff$/m);
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo, { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(secret) && !prompt.includes(secret), 'the hunk-header credential must not reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), ['gradle.properties (credential-looking content in its diff)']);
});

test('F: ordinary changes and non-sensitive special names still reach the preflight', () => {
  const sb = sandbox();
  const names = { naive: 'src/naïve file.py', tab: 'docs/tab\tname.md', dash: '-lead.py', plain: 'src/plain.py' };
  const repo = mkRepo(sb, 'ordinary', { [names.naive]: 'x = 1\n', [names.tab]: 'old\n', [names.dash]: 'p = 1\n', [names.plain]: 'q = 1\n' });
  writeFiles(repo, { [names.naive]: 'x = 2\n', [names.tab]: 'new\n', [names.dash]: 'p = 2\n', [names.plain]: 'q = 2\n' });
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  assert.ok(!preflight.includes('Excluded from this preflight'), preflight);
  assert.ok(!/secret-like paths excluded/.test(r.stderr));
  assert.match(preflight, /diff --git "a\/src\/na\\303\\257ve file\.py" "b\/src\/na\\303\\257ve file\.py"\n[\s\S]*?-x = 1\n\+x = 2\n/);
  assert.match(preflight, /diff --git "a\/docs\/tab\\tname\.md" "b\/docs\/tab\\tname\.md"\n[\s\S]*?-old\n\+new\n/);
  assert.match(preflight, /diff --git a\/-lead\.py b\/-lead\.py\n[\s\S]*?-p = 1\n\+p = 2\n/);
  assert.match(preflight, /diff --git a\/src\/plain\.py b\/src\/plain\.py\n[\s\S]*?-q = 1\n\+q = 2\n/);
});

test('oauto-run diffs the real worktree when .git/config redirects core.worktree, and accepts a linked worktree (.git file)', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'worktree-redirect', { 'src/a.py': 'x = 1\n', 'README.md': '# readme\n' });
  fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 2\n');
  fs.writeFileSync(path.join(repo, 'real-untracked.md'), 'here\n');
  // Outside the repository: a same-named tracked file with a marker, and an extra file.
  const elsewhere = path.join(sb.root, 'elsewhere');
  writeFiles(elsewhere, { 'src/a.py': 'SYNTH-OUTSIDE-WORKTREE-MARKER-5a6b = 1\n', 'outside-only.txt': 'SYNTH-OUTSIDE-UNTRACKED-7c8d\n' });
  git(repo, ['config', 'core.worktree', elsewhere]); // last: from here on git itself would look elsewhere
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  assert.ok(!preflight.includes('SYNTH-OUTSIDE'), 'content from outside the repository must not reach the preflight');
  assert.match(preflight, /diff --git a\/src\/a\.py b\/src\/a\.py\n[\s\S]*?-x = 1\n\+x = 2\n/);
  const status = sectionOf(preflight, '## git status --short', '## Uncommitted');
  assert.ok(status.includes('\n M src/a.py\n') && status.includes('\n?? real-untracked.md\n'), status);
  assert.ok(!status.includes('README.md') && !status.includes('outside-only.txt'), `status must describe the real worktree:\n${status}`);

  // A linked worktree: its .git is a file (gitdir: ...), which the launcher accepts.
  const main = mkRepo(sb, 'linked-main', { 'src/c.py': 'c = 1\n' });
  const linked = path.join(sb.repos, 'linked-review');
  git(main, ['worktree', 'add', '-q', '-b', 'review', linked]);
  assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
  fs.writeFileSync(path.join(linked, 'src/c.py'), 'c = 2\n');
  const r2 = runOauto(sb, linked, ['--check']);
  assert.equal(r2.status, 0, r2.stderr);
  const preflight2 = readPreflight(sb, linked);
  assert.match(preflight2, /- Branch: review\n/);
  assert.match(preflight2, /-c = 1\n\+c = 2\n/);
});

test('the preflight carries no ANSI colour even when the repository config forces it', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'forced-colour', { 'src/a.py': 'x = 1\n' });
  git(repo, ['checkout', '-q', '-b', 'feature']);
  writeFiles(repo, { 'src/b.py': 'y = 1\n' });
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'add b']);
  fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 2\n');
  fs.writeFileSync(path.join(repo, 'untracked.md'), 'u\n');
  for (const [key, value] of [['color.ui', 'always'], ['color.diff', 'always'], ['color.status', 'always'],
    ['color.decorate', 'always'], ['log.decorate', 'short']]) git(repo, ['config', key, value]);
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const raw = fs.readFileSync(path.join(stateDir(sb, repo), 'preflight.md'));
  assert.equal(raw.indexOf(0x1b), -1, 'no ESC byte may reach the preflight');
  const preflight = raw.toString('utf8');
  assert.match(sectionOf(preflight, '## Uncommitted changes', '## Recent commits'), /diff --git a\/src\/a\.py b\/src\/a\.py\n[\s\S]*?-x = 1\n\+x = 2\n/);
  assert.match(sectionOf(preflight, '## Branch delta vs main'), /diff --git a\/src\/b\.py b\/src\/b\.py\nnew file mode 100644\n[\s\S]*?\+y = 1\n/);
  assert.ok(sectionOf(preflight, '## git status --short', '## Uncommitted').includes('\n M src/a.py\n'));
  assert.match(sectionOf(preflight, '## Recent commits', '## Branch delta'), /\n[0-9a-f]{7,} \(HEAD -> feature\) add b\n/);
});

test('classify -z and check-excluded: byte-exact NUL interface, rename/copy pairs, git-style quoting, fail closed', () => {
  const sb = sandbox();
  const pairs = path.join(sb.root, 'pairs');
  const display = path.join(sb.root, 'display');
  const latin1 = Buffer.from('b\xe9.env', 'latin1'); // not valid UTF-8: matched via surrogateescape, emitted as is
  fs.writeFileSync(pairs, nulJoin('M', 'src/a.py', 'R087', '.env', 'safe.txt', 'R100', 'old.py', 'new.py',
    'C075', 'tpl.txt', 'x.pem', 'D', 'gone.env'));
  const names = nulJoin('src/a.py', 'prod\t.env', latin1, 'safe.txt', '.env', '.env', 'notes/README.md', 'new\nline.env', '-dash.env');
  const r = policyBytes(['classify', '-z', '--renames', pairs, '--display', display], names);
  assert.equal(r.status, 0, r.stderr.toString());
  assert.deepEqual(r.stdout, nulJoin('-dash.env', '.env', latin1, 'gone.env', 'new\nline.env', 'prod\t.env', 'safe.txt', 'tpl.txt', 'x.pem'));
  assert.equal(fs.readFileSync(display, 'utf8'), [
    '-dash.env',
    '.env (renamed to "safe.txt")',
    '"b\\351.env"',
    'gone.env',
    '"new\\nline.env"',
    '"prod\\t.env"',
    'safe.txt (renamed from ".env")',
    'tpl.txt (copied to "x.pem")',
    'x.pem (copied from "tpl.txt")',
    '',
  ].join('\n'));
  // git's quoting table: \a \b \t \n \v \f \r, \" and \\, octal for other control bytes, DEL and >= 0x80.
  const quoted = policyBytes(['classify', '-z', '--display', display], nulJoin(Buffer.from('q\x07\x08\x0b\x0c\x0d\x01\x7f"\\.env', 'latin1')));
  assert.equal(quoted.status, 0, quoted.stderr.toString());
  assert.equal(fs.readFileSync(display, 'utf8'), '"q\\a\\b\\v\\f\\r\\001\\177\\"\\\\.env"\n');

  // Anything unparsable fails closed (exit 2, a reason, no output).
  const refuse = (label, renames, input, reason) => {
    fs.writeFileSync(pairs, renames);
    const res = policyBytes(['classify', '-z', '--renames', pairs, '--display', display], input);
    assert.equal(res.status, 2, `${label} must fail closed`);
    assert.match(res.stderr.toString(), reason, label);
    assert.equal(res.stdout.length, 0, `${label}: nothing may be printed`);
  };
  refuse('unknown status letter', nulJoin('Z', 'a.py'), nulJoin('a.py'), /unknown status/);
  refuse('rename without destination', nulJoin('R100', 'only-source'), nulJoin('a.py'), /missing a path/);
  refuse('empty path in --renames', nulJoin('M', ''), nulJoin('a.py'), /empty/);
  refuse('unterminated --renames', Buffer.from('M\0a.py'), nulJoin('a.py'), /not NUL-terminated/);
  refuse('empty path on stdin', Buffer.alloc(0), Buffer.from('a.py\0\0b.env\0'), /empty/);
  assert.equal(policy(['classify', '--display', display], 'x.env\n').status, 2, '--display needs -z');

  // check-excluded proves that no excluded (or otherwise secret-like) path is still diffed.
  const ex = path.join(sb.root, 'excluded');
  const rem = path.join(sb.root, 'remaining');
  fs.writeFileSync(ex, nulJoin('.env', 'safe.txt', 'prod\t.env'));
  const check = (remaining) => {
    fs.writeFileSync(rem, remaining);
    return policyBytes(['check-excluded', ex, rem]);
  };
  assert.equal(check(nulJoin('src/a.py', 'README.md')).status, 0);
  assert.equal(check(Buffer.alloc(0)).status, 0);
  let c = check(nulJoin('src/a.py', 'safe.txt'));
  assert.equal(c.status, 2);
  assert.match(c.stderr.toString(), /safe\.txt/);
  c = check(nulJoin('prod\t.env'));
  assert.equal(c.status, 2);
  assert.match(c.stderr.toString(), /"prod\\t\.env"/, 'names are reported C-quoted, never raw');
  c = check(nulJoin('stray.pem'));
  assert.equal(c.status, 2, 'a secret-like path that was never excluded is refused too');
  assert.match(c.stderr.toString(), /stray\.pem/);
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
  assert.match(code, /exec env -i "\$\{clean_env\[@\]\}" "\$OPENCODE_BIN" --standalone --prompt/);

  // Preflight git: scrubbed, time-bounded, helper-free. g() is the only git entry point
  // besides the filter-driver enumeration; every diff goes through gd().
  const lines = code.split('\n');
  const gDef = lines.find((l) => /^g\(\) +\{/.test(l));
  assert.match(gDef || '', /^g\(\) +\{ timeout 120 env -i "\$\{git_env\[@\]\}" git -C "\$REPO" --work-tree="\$REPO" "\$\{git_cfg\[@\]\}" "\$\{filter_cfg\[@\]\}" --no-pager "\$@" 2>\/dev\/null; \}$/);
  assert.match(code, /^git_env=\([^)]*\bGIT_OPTIONAL_LOCKS=0\b[^)]*\)/m);
  for (const opt of ['core.fsmonitor=false', 'core.hooksPath=/dev/null', 'log.showSignature=false', 'core.pager=cat', 'color.ui=never',
    'color.diff=never', 'color.status=never', 'color.decorate=never', 'submodule.recurse=false']) {
    assert.match(code, new RegExp(`^git_cfg=\\([^)]*-c ${opt.replace(/[.]/g, '\\.')}(\\s|\\))`, 'm'), `git_cfg must carry -c ${opt}`);
  }
  assert.ok(code.includes('timeout 120 env -i "${git_env[@]}" git -C "$REPO" --work-tree="$REPO" config -z --get-regexp \'^filter\\..*\\.(clean|smudge|process|required)$\''),
    'filter drivers are enumerated with the same scrubbed environment');
  assert.equal(code.match(/\bgit -C\b/g).length, 2, 'no git call may bypass g()');
  const gdDef = lines.find((l) => /^gd\(\) \{/.test(l)) || '';
  for (const flag of [' g diff ', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--no-color', '--submodule=short', '--ignore-submodules=dirty']) {
    assert.ok(gdDef.includes(flag), `gd() must carry ${flag}`);
  }
  assert.equal(code.match(/\bg diff\b/g).length, 1, 'every diff goes through gd()');
  // Only the two rename/copy-pair passes re-enable detection: exhaustive (-l0), copies
  // included (-C), and fatal on failure or timeout, never `|| true`.
  const renameLines = lines.filter((l) => /(^|\s)-M(\s|$)/.test(l));
  assert.equal(renameLines.length, 2, 'only the rename/copy-pair passes re-enable rename detection');
  for (const l of renameLines) {
    assert.match(l, /^\s*gd -M -C -l0 --name-status -z (HEAD|"\$base\.\.\.HEAD") >> "\$pairs" \|\| pair_pass_failed \$\?$/);
    assert.ok(!/\|\|\s*true/.test(l), `the pair pass must not be || true: ${l}`);
  }
  assert.match(code, /die "rename\/copy detection for the preflight failed or exceeded 120 s; the change set is too large for oauto's secret-exclusion pass/);
  // The name passes (changed, branch delta, untracked) and the two proof passes are fatal on
  // failure as well: a partial list would leave a secret-like path unexcluded.
  const nameLines = lines.filter((l) => /\bgd --name-only -z\b|\bg ls-files\b/.test(l));
  assert.equal(nameLines.length, 5, 'two name passes, one untracked pass, two proof passes');
  for (const l of nameLines) assert.match(l, /\|\| name_pass_failed \$\?$/, `collection must fail closed: ${l}`);
  assert.ok(!/>> "\$(names|pairs|after)"[^\n]*\|\|\s*true/.test(code), 'no collection pass may be || true');
  assert.match(code, /die "collecting the changed paths for the preflight failed or exceeded 120 s/);
  assert.equal(code.match(/\bg log\b/g).length, 1);
  assert.match(code, /\bg log --no-show-signature --no-color --oneline -15\b/);
  assert.match(code, /\bg status --short --untracked-files=normal --ignore-submodules=dirty\b/);
  assert.match(code, /python3 -I "\$POLICY" classify -z --renames "\$pairs" --display "\$display" --content-candidates "\$content_z" < "\$names" > "\$excluded_z" \|\|\s*die /);
  // Content-checked files (gradle.properties ...): every candidate's own diff is checked
  // through gd with a literal pathspec, and anything but "clean" or "found" is fatal.
  const contentLines = lines.filter((l) => l.includes('check-diff-content'));
  assert.equal(contentLines.length, 1, contentLines.join('\n'));
  assert.match(contentLines[0], /^\s*gd "\$rev" -- ":\(literal\)\$path" \| python3 -I "\$POLICY" check-diff-content --checker "\$key" -- "\$path" \|\| status=\$\?$/);
  assert.match(code, /IFS= read -r -d '' path <&3 \|\| die "/, 'a malformed candidate list is fatal');
  assert.match(code, /\(\( status == 0 \)\) \|\|\s*die "/);
  assert.match(code, /python3 -I "\$POLICY" check-excluded "\$excluded_z" "\$after" >&2 \|\|\s*die /);
  assert.ok(!/<<< "\$excluded"/.test(code), 'excluded paths never travel through a shell variable');
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
