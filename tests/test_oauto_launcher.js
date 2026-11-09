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
// Credential files of common tools (Composer, PostgreSQL, MySQL, s3cmd, PuTTY, kubectl,
// Terraform CLI, RubyGems, service-account keys), spelled as the case-sensitive read rules
// match them; and near misses that stay reviewable.
const MORE_CREDENTIAL_FILES = ['auth.json', 'vendor/composer/auth.json', '.pgpass', 'db/prod.pgpass', '.my.cnf', 'etc/.my.cnf',
  '.s3cfg', 'deploy/.s3cfg', 'keys/server.ppk', '.kube/config', 'deploy/.kube/config', 'cluster.kubeconfig', '.terraformrc',
  'ci/.terraformrc', 'terraform.rc', 'ci/terraform.rc', '.gem/credentials', 'ci/.gem/credentials', 'sa/my_service_account.json',
  'sa/serviceaccount.json', 'deploy/sa/serviceAccountKey.json'];
const NOT_CREDENTIAL_FILES = ['docs/oauth.json', 'src/auth.js', 'my.cnf', '.kube/README.md', 'composer.json'];

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

// The state directory is created before the scan (it receives the scan's list of
// included Git config files); a refused launch must leave nothing in it.
function nothingRendered(sb, repo) {
  const sd = stateDir(sb, repo);
  return !fs.existsSync(sd) || fs.readdirSync(sd).length === 0;
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
      'app-secrets.json', 'oauth/client_secret_1.json', 'infra/terraform.tfstate', '.aws/credentials', '.docker/config.json',
      ...MORE_CREDENTIAL_FILES];
    for (const p of denied) assert.equal(decide(cfg.permissions, 'read', p), 'deny', `read ${p} must be denied`);
    for (const p of ['src/main.kt', '.env.example', 'gradle.properties', 'README.md', ...NOT_CREDENTIAL_FILES]) {
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
    for (const p of denied) assert.equal(decide(pol, 'tool.use', `read:${p}`), 'deny', `tool.use read:${p} must be denied`);
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
  // The scanner and the preflight match case-insensitively (Vendor/Auth.JSON), the read rules as spelled.
  const more = [...MORE_CREDENTIAL_FILES, 'Vendor/Composer/Auth.JSON', 'Keys/Server.PPK', 'sa/ServiceAccount-Key.json'];
  const input = ['.env', 'Config/Prod.Secrets.YAML', 'app/Local.Properties', 'deploy/.ssh/key', 'src/main.kt',
    '.env.example', 'config/server.PEM', '.git/config', 'gradle.properties', 'notes/README.md', 'infra/x.tfvars',
    ...more, ...NOT_CREDENTIAL_FILES].join('\n');
  const r = policy(['classify'], `${input}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), ['.env', '.git/config', 'Config/Prod.Secrets.YAML', 'app/Local.Properties',
    'config/server.PEM', 'deploy/.ssh/key', 'infra/x.tfvars', ...more].sort());
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
    'vendor/composer/auth.json': '{"http-basic": {}}\n',
    'deploy/.kube/config': 'apiVersion: v1\n',
    'keys/putty.PPK': 'synthetic test material\n',
    'composer.json': '{}\n',
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
  for (const p of ['vendor/composer/auth.json', 'deploy/.kube/config', 'keys/putty.PPK']) assert.ok(lines.includes(`SENSITIVE ${p}`), `${p}:\n${r.stdout}`);
  assert.ok(!lines.some((l) => l.includes('.env.example')));
  assert.ok(!lines.some((l) => l.includes('clean.properties')));
  assert.ok(!lines.some((l) => l.includes('composer.json')));
  assert.ok(lines.some((l) => l.startsWith('SYMLINK link-out -> ')));
  assert.ok(lines.some((l) => l.startsWith('SYMLINK link-dangling -> ') && l.endsWith('(dangling)')));
  assert.ok(!lines.some((l) => l.includes('link-system')), 'system interpreter links are tolerated');
  assert.ok(!lines.some((l) => l.includes('link-inside')));
  assert.ok(lines.includes('CONTENT gradle.properties: credential-looking assignment'));
  assert.ok(lines.includes('CONTENT .git/config: remote URL or http header embeds credentials'));
  assert.match(lines[lines.length - 1], /^SUMMARY files=\d+ sensitive=6 symlinks=2 content=2 elapsed=[\d.]+s complete=1$/);
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
  // `info` is the parsed document as OpenCode 2.2.6 prints it (the rendered config itself).
  const good = [{ type: 'document', path: `${dir}/opencode.json`, info: render('glm') }, { type: 'directory', path: dir }];
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
  for (const line of ['config sources ok', 'policies ok: ', 'models ok', 'agents ok', '--check: configuration verified', 'Model : opencode/glm-5.3-flash-free', 'Agent : review-glm']) {
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
  assert.ok(nothingRendered(sb, repo), 'nothing is rendered before the scan passes');

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
  assert.ok(nothingRendered(sb, repo), 'nothing is rendered before the scan passes');

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

test('D2 follow-up: a hook installed as a hard link from the worktree is not an alias, a hard-linked .git/config is', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'hook-link', { 'scripts/pre-commit': '#!/bin/sh\nexit 0\n', 'src/a.py': 'x = 1\n' });
  fs.linkSync(path.join(repo, 'scripts', 'pre-commit'), path.join(repo, '.git', 'hooks', 'pre-commit'));
  let out = policy(['scan', repo, '--budget', '60']);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes('SYMLINK'), `a hard-linked hook must not be reported: ${out.stdout}`);
  fs.linkSync(path.join(repo, '.git', 'config'), path.join(repo, 'review.txt'));
  out = policy(['scan', repo, '--budget', '60']);
  assert.match(out.stdout, /SYMLINK review\.txt -> .*\(hard link to \.git\/config\)/);
});

test('Git config files that are symlinks, and a symlinked .git, are refused (credentials would land in a readable file)', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'cfg-link', { 'src/a.py': 'x = 1\n', 'review-config.txt': '# placeholder\n' });
  // The repository's real config moves into a worktree file; git would then write there.
  fs.renameSync(path.join(repo, '.git', 'config'), path.join(repo, 'review-config.txt'));
  fs.symlinkSync('../review-config.txt', path.join(repo, '.git', 'config'));
  fs.appendFileSync(path.join(repo, 'review-config.txt'), '[http]\n\textraheader = AUTHORIZATION: bearer SYNTH-CFGLINK-TOKEN-77aa\n');
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\.git\/config -> .*\(Git config file is a symlink\)/);
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, 'the override must not bypass a symlinked Git config');

  const real = mkRepo(sb, 'real-git', { 'src/a.py': 'x = 1\n' });
  const moved = path.join(sb.root, 'moved-git-dir');
  fs.renameSync(path.join(real, '.git'), moved);
  fs.symlinkSync(moved, path.join(real, '.git'));
  r = runOauto(sb, real, ['--check']);
  assert.equal(r.status, 1, r.stderr);
  // check-repo-git now refuses a symlinked .git before any git runs (it was formerly the
  // scan's `.git itself is a symlink` record; the launch is still refused either way).
  assert.match(r.stderr, /\.git is a symlink/);
  assert.match(r.stderr, /no git command was run against it/);
});

test('the gradle.properties content check reads the whole file and refuses one too large to read', () => {
  const sb = sandbox();
  const big = `${'# filler\n'.repeat(40000)}repoPassword=SYNTH-LARGE-SECRET-88bb\n`;   // credential after 360 KB
  assert.ok(Buffer.byteLength(big) > 262144);
  const repo = mkRepo(sb, 'large-props', { 'src/a.py': 'x = 1\n', 'gradle.properties': big }, { commit: false });
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, 'a credential past 256 KiB must still refuse the launch');
  assert.match(r.stderr, /gradle\.properties: credential-looking assignment/);
  fs.writeFileSync(path.join(repo, 'gradle.properties'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x23));
  r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, 'an unreadably large content-checked file must fail closed');
  assert.match(r.stderr, /gradle\.properties: too large to content-check/);
  fs.writeFileSync(path.join(repo, 'gradle.properties'), 'org.gradle.jvmargs=-Xmx1g\n');
  r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
});

test('E1: gradle.properties credentials are found with =, : or whitespace separators and key-material names', () => {
  const sb = sandbox();
  const hits = ['signingPassword: V', 'signingPassword V', 'signingInMemoryKey=V', 'mavenCentralSecretKey=V',
    'api.key=V', 'signing.key=V', 'access.key: V', 'private.key V', 'aws.secret.key=V'];
  const misses = ['org.gradle.jvmargs=-Xmx1g', 'kotlin.code.style=official', 'android.useAndroidX=true'];
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

// ---------------------------------------------------------------------------
// Round 6: a structured scan contract (P1-H) and included Git config files (P1-I).
// ---------------------------------------------------------------------------
test('P1-H: a secret-like file whose name starts with a newline is counted, shown C-quoted and excluded', () => {
  const sb = sandbox();
  const name = '\n.env';
  const secret = 'SYNTH-NEWLINE-LEAD-5e5e';
  const repo = mkRepo(sb, 'newline-name', { 'src/a.py': 'x = 1\n' });
  fs.writeFileSync(path.join(repo, name), `TOKEN=${secret}\n`);
  git(repo, ['add', '--', name]);
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `a secret-like file must refuse the launch whatever its name:\n${r.stderr}`);
  assert.ok(r.stderr.includes('"\\n.env"'), r.stderr);
  // The scan prints names C-quoted, one record per line, and counts every kind in SUMMARY.
  const scan = policy(['scan', repo, '--budget', '60']).stdout.trim().split('\n');
  assert.ok(scan.includes('SENSITIVE "\\n.env"'), scan.join('\n'));
  assert.match(scan[scan.length - 1], /^SUMMARY files=\d+ sensitive=1 symlinks=0 content=0 elapsed=[\d.]+s complete=1$/);
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  assert.ok(!preflight.includes(secret));
  assert.deepEqual(excludedLines(preflight), ['"\\n.env"']);
});

test('P1-H: every scan record is one ASCII line with C-quoted names (links, targets and reasons included)', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'quoted-scan', { 'src/a.py': 'x = 1\n', 'sec\tdir/db.secrets.json': '{}\n', 'gradle.properties': 'signingPassword=V\n' }, { commit: false });
  fs.symlinkSync('sec\tdir/db.secrets.json', path.join(repo, 'nïce'));
  fs.symlinkSync(path.join(sb.root, 'gone\nfile'), path.join(repo, 'out\nlink'));
  const r = policy(['scan', repo, '--budget', '60']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.every((l) => /^(SENSITIVE|SYMLINK|CONTENT|SUMMARY) [\x20-\x7e]*$/.test(l)), r.stdout);
  const real = fs.realpathSync(repo);
  assert.ok(lines.includes('SENSITIVE "sec\\tdir/db.secrets.json"'), r.stdout);
  assert.ok(lines.includes(`SYMLINK "n\\303\\257ce" -> "${real}/sec\\tdir/db.secrets.json" (secret-like target: "sec\\tdir/db.secrets.json")`), r.stdout);
  assert.ok(lines.includes(`SYMLINK "out\\nlink" -> "${fs.realpathSync(sb.root)}/gone\\nfile" (dangling)`), r.stdout);
  assert.ok(lines.includes('CONTENT gradle.properties: credential-looking assignment'), r.stdout);
  assert.match(lines[lines.length - 1], /^SUMMARY files=\d+ sensitive=1 symlinks=2 content=1 elapsed=[\d.]+s complete=1$/);
});

test('P1-I: a worktree file included from .git/config is Git configuration: counted, checked, excluded and denied by name', () => {
  const sb = sandbox();
  const token = 'SYNTH-INCLUDE-TOKEN-99cc';
  const repo = mkRepo(sb, 'include-main', { 'src/a.py': 'x = 1\n' });
  fs.writeFileSync(path.join(repo, 'review-config.txt'), `[http]\n\textraheader = AUTHORIZATION: bearer ${token}\n`);
  git(repo, ['add', 'review-config.txt']);
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../review-config.txt\n');
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `an included Git config in the worktree must refuse the launch without the override:\n${r.stderr}`);
  assert.match(r.stderr, /\nreview-config\.txt \(included Git config\)\n/);
  assert.match(r.stderr, /\nreview-config\.txt: remote URL or http header embeds credentials\n/);
  assert.ok(nothingRendered(sb, repo));

  const { r: r2, preflight, prompt } = launchRecordingPrompt(sb, repo, { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'the included config must not reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), ['review-config.txt (included Git config)']);
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(sb, repo), 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  for (const agent of ['review-glm', 'review-deepseek']) {
    assert.equal(decide(cfg.agents[agent].permissions, 'read', 'review-config.txt'), 'deny', `${agent} must not read the included config`);
    assert.equal(decide(cfg.agents[agent].permissions, 'read', 'src/a.py'), 'allow', `${agent} still reads ordinary files`);
  }
  assert.equal(decide(cfg.permissions, 'read', 'review-config.txt'), 'deny');
  assert.equal(decide(cfg.policies, 'tool.use', 'read:review-config.txt'), 'deny');
});

test('P1-I: chained and includeIf includes are followed; an include outside the repository is ignored', () => {
  const sb = sandbox();
  const scanLines = (repo, env = {}) => spawnSync('python3', ['-I', POLICY, 'scan', repo, '--budget', '60'],
    { encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim().split('\n');
  const flagged = (lines, file, credential) => lines.includes(`SENSITIVE ${file} (included Git config)`)
    && lines.includes(`CONTENT ${file}: remote URL or http header embeds credentials`) === credential;
  // Chained: .git/config -> conf/review.cfg -> ../more.cfg (git resolves an include
  // relative to the file that contains it, so this is <repo>/more.cfg).
  const chain = mkRepo(sb, 'include-chain', { 'src/a.py': 'x = 1\n', 'conf/review.cfg': '[include]\n\tpath = ../more.cfg\n',
    'more.cfg': '[remote "x"]\n\turl = https://ghp_x@github.com/o/r.git\n' });
  fs.appendFileSync(path.join(chain, '.git', 'config'), '[include]\n\tpath = ../conf/review.cfg\n');
  let lines = scanLines(chain);
  assert.ok(flagged(lines, 'conf/review.cfg', false) && flagged(lines, 'more.cfg', true), lines.join('\n'));
  let r = runOauto(sb, chain, ['--check']);
  assert.equal(r.status, 1, r.stderr);
  // --included-out hands the launcher the in-repository included configs (NUL-terminated, sorted).
  const out = path.join(sb.root, 'included.z');
  assert.equal(spawnSync('python3', ['-I', POLICY, 'scan', chain, '--budget', '60', '--included-out', out]).status, 0);
  assert.deepEqual(fs.readFileSync(out), nulJoin('conf/review.cfg', 'more.cfg'));
  // includeIf: the condition is not evaluated; quoted value, trailing comment, any case.
  const cond = mkRepo(sb, 'include-if', { 'src/a.py': 'x = 1\n', 'team.cfg': '[http]\n\tExtraHeader = X-Token: SYNTH-TEAM\n' });
  fs.appendFileSync(path.join(cond, '.git', 'config'), '[IncludeIf "onbranch:feature/*"]\n\tPath = "../team.cfg" ; team settings\n');
  lines = scanLines(cond);
  assert.ok(flagged(lines, 'team.cfg', true), lines.join('\n'));
  assert.equal(runOauto(sb, cond, ['--check']).status, 1);
  // An include loop does not hang the scan.
  const loop = mkRepo(sb, 'include-loop', { 'src/a.py': 'x = 1\n', 'a.cfg': '[include]\n\tpath = b.cfg\n', 'b.cfg': '[include]\n\tpath = a.cfg\n' });
  fs.appendFileSync(path.join(loop, '.git', 'config'), '[include]\n\tpath = ../a.cfg\n');
  lines = scanLines(loop);
  assert.ok(flagged(lines, 'a.cfg', false) && flagged(lines, 'b.cfg', false), lines.join('\n'));
  // Outside the repository (the user's own ~/.gitconfig-work): ignored.
  const outside = mkRepo(sb, 'include-outside', { 'src/a.py': 'x = 1\n' });
  fs.writeFileSync(path.join(sb.home, '.gitconfig-work'), '[http]\n\textraHeader = X-Token: SYNTH-HOME\n');
  fs.appendFileSync(path.join(outside, '.git', 'config'), '[include]\n\tpath = ~/.gitconfig-work\n');
  lines = scanLines(outside, { HOME: sb.home });
  assert.ok(!lines.some((l) => l.includes('gitconfig-work')), lines.join('\n'));
  r = runOauto(sb, outside, ['--check']);
  assert.equal(r.status, 0, r.stderr);
});

test('P1-I: classify --extra-sensitive and render --deny-read', () => {
  const sb = sandbox();
  const extra = path.join(sb.root, 'extra.z');
  const display = path.join(sb.root, 'display');
  fs.writeFileSync(extra, nulJoin('review-config.txt', 'conf/unchanged.cfg'));
  const r = policyBytes(['classify', '-z', '--extra-sensitive', extra, '--display', display], nulJoin('review-config.txt', 'src/a.py'));
  assert.equal(r.status, 0, r.stderr.toString());
  assert.deepEqual(r.stdout, nulJoin('review-config.txt'));
  assert.equal(fs.readFileSync(display, 'utf8'), 'review-config.txt (included Git config)\n');
  const cfg = render('glm', ['--deny-read', 'review-config.txt', '--deny-read=-dash.cfg']);
  for (const rules of [cfg.permissions, cfg.agents['review-glm'].permissions, cfg.agents['review-deepseek'].permissions]) {
    assert.equal(decide(rules, 'read', 'review-config.txt'), 'deny');
    assert.equal(decide(rules, 'read', './review-config.txt'), 'deny', 'the */ form covers other spellings of the path');
    assert.equal(decide(rules, 'read', '/abs/repo/review-config.txt'), 'deny');
    assert.equal(decide(rules, 'read', '-dash.cfg'), 'deny');
    assert.equal(decide(rules, 'read', 'review-config.txt.bak'), 'allow', 'an exact path, not a pattern');
  }
  assert.equal(decide(cfg.policies, 'tool.use', 'read:review-config.txt'), 'deny');
  assert.equal(decide(cfg.policies, 'tool.use', 'read:./review-config.txt'), 'deny');
  assert.deepEqual(render('glm'), JSON.parse(JSON.stringify(render('glm', []))), 'no --deny-read: unchanged contract');
});

// ---------------------------------------------------------------------------
// Round 7: included Git config files the hand parser missed (I-a..I-d). Each case is
// refused without the override; with it the token stays out of the preflight and the
// prompt and the file is listed as an included Git config.
// ---------------------------------------------------------------------------
function stageIncludedConfig(repo, file, token) {
  fs.writeFileSync(path.join(repo, file), `[http]\n\textraheader = AUTHORIZATION: bearer ${token}\n`);
  git(repo, ['add', '--', file]);
}

function includedConfigOutcome(sb, repo, file, token) {
  const refused = runOauto(sb, repo, ['--check']);
  const launched = launchRecordingPrompt(sb, repo, { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  return {
    outcome: {
      refusedWithoutOverride: refused.status === 1 && refused.stderr.includes(`${file} (included Git config)`),
      launchedWithOverride: launched.r.status === 0,
      tokenReachesModel: launched.preflight.includes(token) || launched.prompt.includes(token),
      listedAsIncluded: excludedLines(launched.preflight).includes(`${file} (included Git config)`),
    },
    detail: `${refused.stderr}\n---\n${launched.r.stderr}`,
  };
}
const INCLUDED_OK = { refusedWithoutOverride: true, launchedWithOverride: true, tokenReachesModel: false, listedAsIncluded: true };

test('I-a: an include that hops outside the repository and back in is followed', () => {
  const sb = sandbox();
  const token = 'SYNTH-HOP-TOKEN-1a7a';
  const repo = mkRepo(sb, 'include-hop', { 'src/a.py': 'x = 1\n' });
  stageIncludedConfig(repo, 'review-config.txt', token);
  const hop = path.join(sb.root, 'hop.cfg'); // outside the repository
  fs.writeFileSync(hop, `[include]\n\tpath = ${path.join(repo, 'review-config.txt')}\n`);
  fs.appendFileSync(path.join(repo, '.git', 'config'), `[include]\n\tpath = ${hop}\n`);
  const { outcome, detail } = includedConfigOutcome(sb, repo, 'review-config.txt', token);
  assert.deepEqual(outcome, INCLUDED_OK, detail);
});

test('I-b: a comment ending in a backslash does not swallow the next include line', () => {
  const sb = sandbox();
  const token = 'SYNTH-COMMENT-TOKEN-2b7b';
  const repo = mkRepo(sb, 'include-comment', { 'src/a.py': 'x = 1\n' });
  stageIncludedConfig(repo, 'review-config.txt', token);
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = /dev/null ; c \\\n\tpath = ../review-config.txt\n');
  const { outcome, detail } = includedConfigOutcome(sb, repo, 'review-config.txt', token);
  assert.deepEqual(outcome, INCLUDED_OK, detail);
});

test('I-c: an include in a .git/config that starts with a UTF-8 BOM is followed', () => {
  const sb = sandbox();
  const token = 'SYNTH-BOM-TOKEN-3c7c';
  const repo = mkRepo(sb, 'include-bom', { 'src/a.py': 'x = 1\n' });
  stageIncludedConfig(repo, 'review-config.txt', token);
  const cfg = path.join(repo, '.git', 'config');
  fs.writeFileSync(cfg, `﻿[include]\n\tpath = ../review-config.txt\n${fs.readFileSync(cfg, 'utf8')}`);
  const { outcome, detail } = includedConfigOutcome(sb, repo, 'review-config.txt', token);
  assert.deepEqual(outcome, INCLUDED_OK, detail);
});

test('I-d: reviewing a linked worktree, the main repository config including a file inside it is caught', () => {
  const sb = sandbox();
  const token = 'SYNTH-WORKTREE-TOKEN-4d7d';
  const main = mkRepo(sb, 'wt-main', { 'src/a.py': 'x = 1\n' });
  const linked = path.join(sb.repos, 'wt-linked');
  git(main, ['worktree', 'add', '-q', '-b', 'review', linked]);
  assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
  stageIncludedConfig(linked, 'review-config.txt', token);
  fs.appendFileSync(path.join(main, '.git', 'config'), `[include]\n\tpath = ${path.join(linked, 'review-config.txt')}\n`);
  const { outcome, detail } = includedConfigOutcome(sb, linked, 'review-config.txt', token);
  assert.deepEqual(outcome, INCLUDED_OK, detail);
});

test('I: an included config path holding a glob metacharacter is refused, even with the override', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'include-glob', { 'src/a.py': 'x = 1\n', 'conf/a*b.cfg': '[k]\n\tv = 1\n' });
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../conf/a*b.cfg\n');
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /conf\/a\*b\.cfg: cannot be denied by exact path \(glob metacharacter\)/);
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, `the override cannot make an inexact deny rule acceptable:\n${r.stderr}`);
  assert.match(r.stderr, /glob metacharacter/);
});

test('I: scan --config-origins counts every in-repository file git loaded; other origins are ignored', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'origins', { 'src/a.py': 'x = 1\n', 'review-config.txt': '[k]\n\tv = 1\n',
    'conf/team.cfg': '[http]\n\textraHeader = X-Token: SYNTH-TEAM\n' }, { commit: false });
  const userCfg = path.join(sb.root, 'user.cfg');
  fs.writeFileSync(userCfg, '[http]\n\textraHeader = X-Token: SYNTH-USER\n');
  const origins = path.join(sb.root, 'origins.z');
  fs.writeFileSync(origins, nulJoin('file:.git/config', 'core.bare\nfalse', 'file:.git/../review-config.txt', 'k.v\n1',
    `file:${path.join(repo, 'conf', 'team.cfg')}`, 'http.extraheader\nX-Token: SYNTH-TEAM',
    `file:${userCfg}`, 'http.extraheader\nX-Token: SYNTH-USER', 'command line:', 'core.pager\ncat', 'blob:0123abcd', 'x.y\nz'));
  const scanWith = () => spawnSync('python3', ['-I', POLICY, 'scan', repo, '--budget', '60', '--config-origins', origins], { encoding: 'utf8' });
  let r = scanWith();
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  for (const want of ['SENSITIVE review-config.txt (included Git config)', 'SENSITIVE conf/team.cfg (included Git config)',
    'CONTENT conf/team.cfg: remote URL or http header embeds credentials']) assert.ok(lines.includes(want), `${want}:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('user.cfg'), 'a user-owned config outside the repository is ignored');
  fs.writeFileSync(origins, Buffer.from('file:review-config.txt\0'));
  r = scanWith();
  assert.notEqual(r.status, 0, 'a malformed origins list fails closed');
});

test('verify-agents --deny-read proves the per-launch read denial; render refuses an inexact deny path', () => {
  const base = policy(['verify-agents'], JSON.stringify(resolvedAgents(render('glm'))));
  assert.equal(base.status, 0, base.stderr);
  const probes = Number(base.stdout.match(/(\d+) probes each/)[1]);
  const ok = policy(['verify-agents', '--deny-read=review-config.txt'], JSON.stringify(resolvedAgents(render('glm', ['--deny-read', 'review-config.txt']))));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`${probes + 1} probes each`));
  const missing = policy(['verify-agents', '--deny-read=review-config.txt'], JSON.stringify(resolvedAgents(render('glm'))));
  assert.notEqual(missing.status, 0, 'a reviewer that can read the included config must fail verification');
  assert.match(missing.stderr, /read 'review-config\.txt' resolves to allow, expected deny/);
  for (const bad of ['conf/a*b.cfg', 'a?.cfg', 'x[1].cfg', 'a{b,c}.cfg', 'back\\slash.cfg']) {
    assert.notEqual(policy(['render', '--model', 'glm', `--deny-read=${bad}`]).status, 0, `render must refuse ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Round 8 (P1-J): an include target that no longer exists in the worktree. Git skips a
// missing include, but the deleted file's last content is in the diff.
// ---------------------------------------------------------------------------
const includedConfigText = (token) => `[http]\n\textraheader = AUTHORIZATION: bearer ${token}\n`;

function repoIncluding(sb, name, token) {
  const repo = mkRepo(sb, name, { 'src/a.py': 'x = 1\n', 'review-config.txt': includedConfigText(token) });
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../review-config.txt\n');
  return repo;
}

test('P1-J: an included Git config deleted in the worktree stays out of the preflight and the prompt, without refusing', () => {
  const sb = sandbox();
  const token = 'SYNTH-DELETED-INCLUDE-5e8e';
  const repo = repoIncluding(sb, 'include-deleted', token);
  fs.rmSync(path.join(repo, 'review-config.txt'));
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo); // no override: a missing file is not a refusal
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'the deleted include target must not reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), ['review-config.txt (included Git config)']);
  // The scan hands it over for exclusion and denial without counting it as present.
  const out = path.join(sb.root, 'included.z');
  const scan = spawnSync('python3', ['-I', POLICY, 'scan', repo, '--budget', '60', '--included-out', out], { encoding: 'utf8' });
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /^SUMMARY files=\d+ sensitive=0 symlinks=0 content=0 /m);
  assert.deepEqual(fs.readFileSync(out), nulJoin('review-config.txt'));
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(sb, repo), 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  assert.equal(decide(cfg.agents['review-glm'].permissions, 'read', 'review-config.txt'), 'deny');
});

test('P1-J: an include target deleted in a branch commit stays out of the branch delta', () => {
  const sb = sandbox();
  const token = 'SYNTH-DELETED-BRANCH-6f8f';
  const repo = repoIncluding(sb, 'include-deleted-branch', token);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  git(repo, ['rm', '-q', 'review-config.txt']);
  git(repo, ['commit', '-q', '-m', 'drop the review config']);
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo);
  assert.equal(r.status, 0, r.stderr);
  const delta = sectionOf(preflight, '## Branch delta vs main');
  assert.ok(delta, preflight);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), `the branch delta must not carry the token:\n${delta}`);
  assert.deepEqual(excludedLines(preflight), ['review-config.txt (included Git config)']);
});

test('P1-J: a renamed include target: the old name is excluded, and the rename pair excludes the new name too', () => {
  const sb = sandbox();
  const token = 'SYNTH-RENAMED-INCLUDE-7a8a';
  const repo = repoIncluding(sb, 'include-renamed', token);
  git(repo, ['mv', 'review-config.txt', 'notes.txt']); // credential kept; include.path still names the old file
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'neither name may carry the token into the preflight');
  // What the code does: the exhaustive rename pass pairs the two names (R100), so the new
  // name is excluded as the rename partner of an included config, not on its own.
  assert.deepEqual(excludedLines(preflight), ['notes.txt (renamed from "review-config.txt")',
    'review-config.txt (included Git config) (renamed to "notes.txt")']);
});

// ---------------------------------------------------------------------------
// Round 9: a chain of included Git configs deleted from the worktree. A missing file
// cannot be read, so its includes are taken from its last committed content.
// ---------------------------------------------------------------------------
function chainRepo(sb, name, files, rootInclude) {
  const repo = mkRepo(sb, name, { 'src/a.py': 'x = 1\n', ...files });
  fs.appendFileSync(path.join(repo, '.git', 'config'), `[include]\n\tpath = ${rootInclude}\n`);
  return repo;
}

test('P1-K: a chain of included Git configs deleted from the worktree is followed through their last committed content', () => {
  const sb = sandbox();
  const token = 'S-CHAIN-SYNTH-8c9c';
  const repo = chainRepo(sb, 'chain-deleted', {
    'conf/a.cfg': '[include]\n\tpath = b.cfg\n',
    'conf/b.cfg': includedConfigText(token),
  }, '../conf/a.cfg');
  fs.rmSync(path.join(repo, 'conf'), { recursive: true });
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo); // no override: nothing secret-like is present
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'the second hop of the deleted chain must not reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)']);
});

test('P1-K: a deleted chain committed on a branch, a three-hop chain, an outside hop and odd names', () => {
  const sb = sandbox();
  const outcome = {};
  const record = (label, repo, tokens, env = {}) => {
    const { r, preflight, prompt } = launchRecordingPrompt(sb, repo, env);
    const leaked = tokens.some((token) => preflight.includes(token) || prompt.includes(token));
    outcome[label] = { status: r.status, leaked, excluded: excludedLines(preflight), stderr: r.stderr };
  };
  // The chain deleted in a commit on feature (base main): only the merge base still has it.
  const branch = chainRepo(sb, 'chain-branch', { 'conf/a.cfg': '[include]\n\tpath = b.cfg\n', 'conf/b.cfg': includedConfigText('S-CHAIN-BRANCH-1b9b') }, '../conf/a.cfg');
  git(branch, ['checkout', '-q', '-b', 'feature']);
  git(branch, ['rm', '-q', '-r', 'conf']);
  git(branch, ['commit', '-q', '-m', 'drop the review configs']);
  record('branch', branch, ['S-CHAIN-BRANCH-1b9b']);
  // Three hops, all deleted.
  const three = chainRepo(sb, 'chain-three', { 'conf/a.cfg': '[include]\n\tpath = b.cfg\n', 'conf/b.cfg': '[include]\n\tpath = ../deep/c.cfg\n',
    'deep/c.cfg': includedConfigText('S-CHAIN-THREE-2c9c') }, '../conf/a.cfg');
  fs.rmSync(path.join(three, 'conf'), { recursive: true });
  fs.rmSync(path.join(three, 'deep'), { recursive: true });
  record('three', three, ['S-CHAIN-THREE-2c9c']);
  // The second hop points outside the repository: ignored.
  const outsideCfg = path.join(sb.root, 'outside.cfg');
  fs.writeFileSync(outsideCfg, includedConfigText('S-CHAIN-OUTSIDE-3d9d'));
  const outside = chainRepo(sb, 'chain-outside', { 'conf/a.cfg': `[include]\n\tpath = ${outsideCfg}\n` }, '../conf/a.cfg');
  fs.rmSync(path.join(outside, 'conf'), { recursive: true });
  record('outside', outside, ['S-CHAIN-OUTSIDE-3d9d']);
  // Hops named with a colon and with a leading dash, both deleted.
  const odd = chainRepo(sb, 'chain-odd', { 'conf/a.cfg': '[include]\n\tpath = ../x:y.cfg\n\tpath = ../-lead.cfg\n',
    'x:y.cfg': includedConfigText('S-CHAIN-COLON-4e9e'), '-lead.cfg': includedConfigText('S-CHAIN-DASH-5f9f') }, '../conf/a.cfg');
  for (const f of ['conf/a.cfg', 'x:y.cfg', '-lead.cfg']) fs.rmSync(path.join(odd, f));
  record('odd', odd, ['S-CHAIN-COLON-4e9e', 'S-CHAIN-DASH-5f9f']);
  // The include line removed from a present a.cfg while its target b.cfg is deleted:
  // a.cfg's committed content still names b.cfg (a.cfg itself needs the override).
  const unlinked = chainRepo(sb, 'chain-unlinked', { 'conf/a.cfg': '[include]\n\tpath = b.cfg\n[k]\n\tv = 1\n',
    'conf/b.cfg': includedConfigText('S-CHAIN-UNLINKED-6a9a') }, '../conf/a.cfg');
  fs.writeFileSync(path.join(unlinked, 'conf/a.cfg'), '[k]\n\tv = 2\n');
  fs.rmSync(path.join(unlinked, 'conf/b.cfg'));
  record('unlinked', unlinked, ['S-CHAIN-UNLINKED-6a9a'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  // An include of a path that never existed: no history to read, no failure.
  const never = chainRepo(sb, 'chain-never', {}, '../never-existed.cfg');
  record('never', never, ['S-NEVER']);

  const brief = Object.fromEntries(Object.entries(outcome).map(([k, v]) => [k, { status: v.status, leaked: v.leaked, excluded: v.excluded }]));
  assert.deepEqual(brief, {
    branch: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)'] },
    three: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)', 'deep/c.cfg (included Git config)'] },
    outside: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)'] },
    odd: { status: 0, leaked: false, excluded: ['-lead.cfg (included Git config)', 'conf/a.cfg (included Git config)', 'x:y.cfg (included Git config)'] },
    unlinked: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)'] },
    never: { status: 0, leaked: false, excluded: [] },
  }, Object.entries(outcome).map(([k, v]) => `${k}: ${v.stderr}`).join('\n'));
});

test('includes-in-config: targets of a Git config read from stdin, resolved like git, inside the repository only', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'includes-in-config', { 'src/a.py': 'x = 1\n' }, { commit: false });
  const text = '﻿[include]\n\tpath = b.cfg ; a comment \\\n\tpath = ../top.cfg\n[includeIf "onbranch:x"]\n\tpath = "sub dir/c.cfg"\n'
    + '[include]\n\tpath = ../../outside.cfg\n\tpath = ../.git/config\n\tpath = b.cfg\n';
  const r = spawnSync('python3', ['-I', POLICY, 'includes-in-config', `--repo=${repo}`, '--config-path=conf/a.cfg'], { input: text });
  assert.equal(r.status, 0, r.stderr.toString());
  // I records: in-repository targets (relative); O records: anything else, a file to follow (absolute).
  const real = fs.realpathSync(repo);
  assert.deepEqual(r.stdout, nulJoin('I', 'conf/b.cfg', 'I', 'top.cfg', 'I', 'conf/sub dir/c.cfg',
    'O', path.join(path.dirname(real), 'outside.cfg'), 'O', path.join(real, '.git', 'config')));
  // An outside file's content resolves relative to its own (absolute) location.
  const outside = spawnSync('python3', ['-I', POLICY, 'includes-in-config', `--repo=${repo}`, `--config-path=${path.join(sb.root, 'bridge.cfg')}`],
    { input: `[include]\n\tpath = ${path.join(real, 'conf', 'b.cfg')}\n\tpath = elsewhere.cfg\n` });
  assert.deepEqual(outside.stdout, nulJoin('I', 'conf/b.cfg', 'O', path.join(sb.root, 'elsewhere.cfg')));
  // A symlinked outside config resolves its relative includes against the link's own
  // directory, as git does, not against the link target's directory.
  fs.mkdirSync(path.join(sb.root, 'sub'));
  fs.writeFileSync(path.join(sb.root, 'sub', 'real.cfg'), '[include]\n\tpath = r.cfg\n');
  fs.symlinkSync(path.join(sb.root, 'sub', 'real.cfg'), path.join(sb.root, 'bridge-link.cfg'));
  const linked = spawnSync('python3', ['-I', POLICY, 'includes-in-config', `--repo=${repo}`, `--config-path=${path.join(sb.root, 'bridge-link.cfg')}`],
    { input: fs.readFileSync(path.join(sb.root, 'bridge-link.cfg')) });
  assert.deepEqual(linked.stdout, nulJoin('O', path.join(sb.root, 'r.cfg')), 'resolved against the link directory, not sub/');
  // A symlinked in-repository name: the referenced name and its canonical target.
  fs.writeFileSync(path.join(repo, 'real.cfg'), '[k]\n\tv = 1\n');
  fs.symlinkSync('real.cfg', path.join(repo, 'link.cfg'));
  const named = spawnSync('python3', ['-I', POLICY, 'includes-in-config', `--repo=${repo}`, '--config-path=conf/a.cfg'],
    { input: '[include]\n\tpath = ../link.cfg\n\tpath = ../dangling.cfg\n' });
  fs.symlinkSync('nowhere.cfg', path.join(repo, 'dangling.cfg'));
  const named2 = spawnSync('python3', ['-I', POLICY, 'includes-in-config', `--repo=${repo}`, '--config-path=conf/a.cfg'],
    { input: '[include]\n\tpath = ../link.cfg\n\tpath = ../dangling.cfg\n' });
  assert.deepEqual(named.stdout, nulJoin('I', 'link.cfg', 'I', 'real.cfg', 'I', 'dangling.cfg'));
  assert.deepEqual(named2.stdout, nulJoin('I', 'link.cfg', 'I', 'real.cfg', 'I', 'dangling.cfg', 'I', 'nowhere.cfg'));
});

// ---------------------------------------------------------------------------
// Round 10: the scan is the single decision point. Targets found through history or
// through files outside the repository are handed back to it until nothing new appears.
// ---------------------------------------------------------------------------
test('P1-L: a present file reached only through a deleted include is counted, checked, excluded, denied and alias-protected', () => {
  const sb = sandbox();
  const token = 'SYNTH-L-TOKEN-11aa';
  const repo = chainRepo(sb, 'chain-present', { 'conf/a.cfg': '[include]\n\tpath = b.cfg\n', 'conf/b.cfg': includedConfigText(token) }, '../conf/a.cfg');
  fs.rmSync(path.join(repo, 'conf/a.cfg'));
  fs.appendFileSync(path.join(repo, 'conf/b.cfg'), '[k]\n\tv = 1\n'); // changed, so its diff would carry the token
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `the present target must refuse the launch without the override:\n${r.stderr}`);
  assert.match(r.stderr, /\nconf\/b\.cfg \(included Git config\)\n/);
  assert.match(r.stderr, /\nconf\/b\.cfg: remote URL or http header embeds credentials\n/);
  assert.match(r.stderr, /worktree scan passes: 2\n/);
  const { r: r2, preflight, prompt } = launchRecordingPrompt(sb, repo, { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'the history-discovered target must not reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)']);
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(sb, repo), 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  for (const agent of ['review-glm', 'review-deepseek']) assert.equal(decide(cfg.agents[agent].permissions, 'read', 'conf/b.cfg'), 'deny', agent);
  // An alias of that target is refused, override or not.
  fs.symlinkSync('conf/b.cfg', path.join(repo, 'link'));
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /\nlink -> \S+\/conf\/b\.cfg \(secret-like target: conf\/b\.cfg\)\n/);
});

test('P1-M: a deleted include bridging through a file outside the repository back to a deleted target is followed', () => {
  const sb = sandbox();
  const token = 'SYNTH-M-TOKEN-22bb';
  const bridge = path.join(sb.root, 'bridge.cfg'); // outside the repository, present
  const repo = chainRepo(sb, 'chain-bridge', { 'conf/a.cfg': `[include]\n\tpath = ${bridge}\n`, 'conf/b.cfg': includedConfigText(token) }, '../conf/a.cfg');
  fs.writeFileSync(bridge, `[include]\n\tpath = ${path.join(repo, 'conf', 'b.cfg')}\n`);
  fs.rmSync(path.join(repo, 'conf'), { recursive: true });
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo); // no override: nothing present is secret-like
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'the target reached through the outside bridge must not reach the preflight or the prompt');
  assert.deepEqual(excludedLines(preflight), ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)']);
});

test('P1-L: a chain needing two scan passes (deleted a -> present b -> deleted c), and one pass without includes', () => {
  const sb = sandbox();
  const token = 'SYNTH-TWO-PASS-33cc';
  const repo = chainRepo(sb, 'chain-two-pass', { 'conf/a.cfg': '[include]\n\tpath = b.cfg\n', 'conf/b.cfg': '[include]\n\tpath = c.cfg\n',
    'conf/c.cfg': includedConfigText(token) }, '../conf/a.cfg');
  fs.rmSync(path.join(repo, 'conf/a.cfg'));
  fs.rmSync(path.join(repo, 'conf/c.cfg'));
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `b.cfg is present Git configuration and must be counted:\n${r.stderr}`);
  assert.match(r.stderr, /\nconf\/b\.cfg \(included Git config\)\n/);
  assert.match(r.stderr, /worktree scan passes: 2\n/);
  const { r: r2, preflight, prompt } = launchRecordingPrompt(sb, repo, { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token));
  assert.deepEqual(excludedLines(preflight), ['conf/a.cfg (included Git config)', 'conf/c.cfg (included Git config)']);
  // A repository without includes is scanned exactly once.
  const plain = mkRepo(sb, 'plain-one-pass', { 'src/a.py': 'x = 1\n' });
  r = runOauto(sb, plain, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /worktree scan passes: 1\n/);
});

// ---------------------------------------------------------------------------
// Round 11: include targets are registered and traversed under the name they were
// referenced by (the resolution context), not only under their canonical target.
// ---------------------------------------------------------------------------
test('P1-N: an include name replaced by a dangling symlink is excluded under the referenced name', () => {
  const sb = sandbox();
  const token = 'SYNTH-N-TOKEN-44dd';
  const repo = mkRepo(sb, 'include-dangling', { 'src/a.py': 'x = 1\n', 'review.cfg': includedConfigText(token) });
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../review.cfg\n');
  fs.rmSync(path.join(repo, 'review.cfg'));
  fs.symlinkSync('missing.cfg', path.join(repo, 'review.cfg')); // type change: the old content is removed in the diff
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo); // no override: nothing present is secret-like
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'the referenced name must be excluded although its target is missing');
  assert.deepEqual(excludedLines(preflight), ['review.cfg (included Git config)']);
});

test('P1-N: an include name symlinked to a present in-repository config: both names excluded, the file counted', () => {
  const sb = sandbox();
  const [oldToken, newToken] = ['SYNTH-N-OLD-66ff', 'SYNTH-N-NEW-77aa'];
  const repo = mkRepo(sb, 'include-symlinked', { 'src/a.py': 'x = 1\n', 'review.cfg': includedConfigText(oldToken) });
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../review.cfg\n');
  fs.rmSync(path.join(repo, 'review.cfg'));
  fs.writeFileSync(path.join(repo, 'existing-other.cfg'), includedConfigText(newToken));
  fs.symlinkSync('existing-other.cfg', path.join(repo, 'review.cfg'));
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, `the present target is Git configuration holding a credential:\n${r.stderr}`);
  assert.match(r.stderr, /\nexisting-other\.cfg \(included Git config\)\n/);
  assert.match(r.stderr, /\nexisting-other\.cfg: remote URL or http header embeds credentials\n/);
  const { r: r2, preflight, prompt } = launchRecordingPrompt(sb, repo, { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r2.status, 0, `the referenced symlink is itself denied by name, not an alias:\n${r2.stderr}`);
  for (const token of [oldToken, newToken]) assert.ok(!preflight.includes(token) && !prompt.includes(token), token);
  assert.deepEqual(excludedLines(preflight), ['existing-other.cfg (included Git config)', 'review.cfg (included Git config)']);
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(sb, repo), 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  for (const name of ['review.cfg', 'existing-other.cfg']) assert.equal(decide(cfg.agents['review-glm'].permissions, 'read', name), 'deny', name);
});

test('a directory alias over an exempt include-name link is still refused, even with the override', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'alias-over-include-link', { 'src/a.py': 'x = 1\n',
    'conf/real.cfg': '[http]\n\textraheader = AUTHORIZATION: bearer SYNTH-ALIASLINK-TOKEN-99aa\n' });
  fs.mkdirSync(path.join(repo, 'linkdir'));
  fs.symlinkSync('../conf/real.cfg', path.join(repo, 'linkdir', 'link.cfg'));
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../linkdir/link.cfg\n');
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, 'the included config is counted without the override');
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, `the include-name link itself is denied by name, not refused:\n${r.stderr}`);
  fs.symlinkSync('linkdir', path.join(repo, 'd'));
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, 'a directory alias over the exempt link would re-expose it as d/link.cfg');
  assert.match(r.stderr, /^d -> .*aliases a directory holding secret-like files: linkdir\/link\.cfg/m);
});

test('P1-O: two symlinked bridges to one file are each followed in their own directory', () => {
  const sb = sandbox();
  const token = 'SYNTH-O-TOKEN-55ee';
  const repo = mkRepo(sb, 'chain-bridges', { 'src/a.py': 'x = 1\n', 'review.cfg': includedConfigText(token) });
  const real = path.join(sb.root, 'real', 'bridge.cfg');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '[include]\n\tpath = ../chain-bridges/review.cfg\n');
  const far = path.join(sb.root, 'far', 'away', 'l1.cfg'); // from here ../chain-bridges/review.cfg leads nowhere
  const near = path.join(sb.repos, 'bridges', 'l2.cfg'); // from here it is the repository's review.cfg
  for (const link of [far, near]) {
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
  }
  fs.appendFileSync(path.join(repo, '.git', 'config'), `[include]\n\tpath = ${far}\n\tpath = ${near}\n`);
  fs.rmSync(path.join(repo, 'review.cfg'));
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token), 'the second bridge resolves into the repository and must be followed');
  assert.deepEqual(excludedLines(preflight), ['review.cfg (included Git config)']);
});

test('P1-O: a symlink loop among outside bridges terminates, live and through history', () => {
  const sb = sandbox();
  const loopDir = path.join(sb.root, 'loop');
  fs.mkdirSync(loopDir);
  fs.writeFileSync(path.join(loopDir, 'x.cfg'), '[include]\n\tpath = ylink.cfg\n');
  fs.symlinkSync('x.cfg', path.join(loopDir, 'ylink.cfg'));
  // Live: git itself gives up (include depth), so the launcher fails closed; the scan ends.
  const live = mkRepo(sb, 'loop-live', { 'src/a.py': 'x = 1\n' });
  fs.appendFileSync(path.join(live, '.git', 'config'), `[include]\n\tpath = ${path.join(loopDir, 'x.cfg')}\n`);
  const scan = spawnSync('python3', ['-I', POLICY, 'scan', live, '--budget', '60'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(scan.status, 0, `the scan must terminate on its own: ${scan.stderr}`);
  let r = runOauto(sb, live, ['--check']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git configuration cannot be listed \(fail closed\)/);
  // Through history: a deleted include whose committed content reaches the loop.
  const hist = chainRepo(sb, 'loop-history', { 'conf/a.cfg': `[include]\n\tpath = ${path.join(loopDir, 'x.cfg')}\n` }, '../conf/a.cfg');
  fs.rmSync(path.join(hist, 'conf'), { recursive: true });
  r = runOauto(sb, hist, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /worktree scan passes: 1\n/);
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
  assert.match(code, /python3 -I "\$POLICY" classify -z --renames "\$pairs" --display "\$display" --content-candidates "\$content_z" --extra-sensitive "\$included_z" < "\$names" > "\$excluded_z" \|\|\s*die /);
  // The scan decision rests on SUMMARY counts, never on text extracted from records.
  assert.match(code, /python3 -I "\$POLICY" scan "\$REPO" --budget "\$SCAN_BUDGET" --included-out "\$included_z"/);
  assert.match(code, /summary_re='\^SUMMARY files=\[0-9\]\+ sensitive=\(\[0-9\]\+\) symlinks=\(\[0-9\]\+\) content=\(\[0-9\]\+\) elapsed=\[0-9\.\]\+s complete=1\$'/);
  assert.match(code, /\[\[ "\$summary" =~ \$summary_re \]\] \|\|\s*die /);
  assert.match(code, /if \(\( n_symlinks > 0 \)\); then/);
  assert.match(code, /if \(\( n_sensitive \+ n_content > 0 \)\); then/);
  assert.ok(!/\[\[ -n "\$(outward|sensitive)/.test(code), 'no decision on extracted record text');
  // Included Git config files reach classify, both renders and verify-agents; a path
  // with a glob metacharacter cannot be denied exactly and is refused.
  assert.match(code, /while IFS= read -r -d '' path; do\n\s*\[\[ "\$path" != \*\[\\\*\\\?\\\[\\\{\\\}\\\\\]\* \]\] \|\|\s*die "[^"]*glob metacharacter[^"]*"\n\s*deny_read_args\+=\("--deny-read=\$path"\)\ndone < "\$included_z"/);
  assert.match(code, /python3 -I "\$POLICY" render --model "\$MODEL_ALIAS" "\$\{deny_read_args\[@\]\}" "\$@"/);
  assert.match(code, /\| python3 -I "\$POLICY" verify-agents "\$\{deny_read_args\[@\]\}" >&2/);
  assert.match(code, /\| python3 -I "\$POLICY" verify-sources --config-dir "\$CONFIG_DIR" "\$\{deny_read_args\[@\]\}" >&2/);
  // check-repo-git refuses a crafted .git file before ANY git command runs against the repo.
  assert.match(code, /python3 -I "\$POLICY" check-repo-git "\$REPO" \|\|\s*\n?\s*die /);
  const crgLine = lines.findIndex((l) => l.includes('check-repo-git "$REPO"'));
  const firstGit = lines.findIndex((l) => /git -C "\$REPO"/.test(l));
  assert.ok(crgLine >= 0 && firstGit >= 0 && crgLine < firstGit, `check-repo-git (${crgLine}) must precede the first git invocation (${firstGit})`);
  // Git itself lists every config file it loaded, before the scan, through g().
  const gLine = lines.findIndex((l) => /^g\(\) +\{/.test(l));
  const scanLine = lines.findIndex((l) => l.includes('python3 -I "$POLICY" scan "$REPO"'));
  assert.ok(gLine >= 0 && scanLine > gLine, 'the git helpers are defined before the scan');
  assert.match(code, /scan "\$REPO" --budget "\$SCAN_BUDGET" .* --unruled-out "\$unruled_z"/);
  assert.match(code, /g config --list --show-origin -z > "\$origins_z" \|\| die "git configuration cannot be listed \(fail closed\)"/);
  assert.match(code, /scan "\$REPO" --budget "\$SCAN_BUDGET" --included-out "\$included_z" --config-origins "\$origins_z" --missing-out "\$missing_z"/);
  // Missing include targets are followed through their committed content (HEAD and the
  // merge base); a missing blob is a skip, a parser failure is fatal; the deny rules are
  // built only after every hop is known.
  assert.match(code, /^\s*g cat-file blob "\$rev:\$path" > "\$blob_tmp" \|\| continue$/m);
  assert.match(code, /includes-in-config --repo="\$REPO" --config-path="\$1" >> "\$hops_z" \|\|\n\s*die "/);
  assert.match(code, /^\s*parse_config_includes "\$path" < "\$path" /m, 'a file outside the repository is read as it is, without git');
  // One decision point: the scan runs in a bounded loop, fed what history reveals, and the
  // verdict, the deny rules and classify use the final pass.
  assert.match(code, /\(\( scan_pass <= 8 \)\) \|\| die "/);
  assert.match(code, /--missing-out "\$missing_z" --extra-config "\$extra_z" --unruled-out "\$unruled_z"\)" \|\| scan_status=\$\?/);
  assert.match(code, /\n\s*history_pass\n\s*\[\[ -s "\$new_z" \]\] \|\| break\n\s*cat "\$new_z" >> "\$extra_z"\ndone\n/);
  const loopEnd = lines.findIndex((l) => l.startsWith('note "worktree scan passes: $scan_pass"'));
  assert.ok(loopEnd > 0 && lines.findIndex((l) => l.startsWith('if (( n_symlinks > 0 )); then')) > loopEnd, 'the verdict follows the last pass');
  assert.ok(lines.findIndex((l) => l.startsWith('deny_read_args=()')) > loopEnd, 'the deny rules cover everything the passes found');
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
// Round 12: hard links with a name outside the repository (A), the git dirs of a
// linked worktree (C), more credential files (D) and the policy ceiling as OpenCode
// loaded it (E).
// ---------------------------------------------------------------------------
const hardOutside = (names, inside) =>
  `(hard link: ${names} names, ${inside} inside the repository; the other names are outside it or unscanned)`;
const scanOf = (repo) => policy(['scan', repo, '--budget', '60']);
const symlinkRecords = (stdout) => stdout.split('\n').filter((l) => l.startsWith('SYMLINK '));

test('A: a hard link whose other name lies outside the repository is refused, even with the override, and nothing is rendered', () => {
  const sb = sandbox();
  const outside = path.join(sb.root, 'id_ed25519');
  fs.writeFileSync(outside, 'SYNTH-OUTSIDE-KEY-MATERIAL-a1a1 (not a key)\n');
  const repo = mkRepo(sb, 'hard-outside', { 'src/a.py': 'x = 1\n' });
  fs.linkSync(outside, path.join(repo, 'notes.md')); // an innocent name the read rules allow
  const r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, `ln <outside>/id_ed25519 notes.md must be refused even with the override:\n${r.stderr}`);
  assert.match(r.stderr, /symlinks leaving the repository or aliasing secret-like paths/);
  assert.ok(r.stderr.includes(`\nnotes.md -> ${fs.realpathSync(repo)}/notes.md ${hardOutside(2, 1)}\n`), r.stderr);
  assert.match(r.stderr, /refusing to launch: OpenCode resolves reads through symlinks/);
  assert.ok(nothingRendered(sb, repo), 'nothing is rendered before the scan passes');
});

test('A: a hard-linked file passes only when the scan saw all its names in the worktree or .git; aliases keep their reason', () => {
  const sb = sandbox();
  const outsideFile = (name) => {
    const p = path.join(sb.root, 'outside', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${name}\n`);
    return p;
  };
  const repo = mkRepo(sb, 'hard-names', { 'src/a.py': 'x = 1\n', 'README.md': '# r\n', 'scripts/pre-commit': '#!/bin/sh\nexit 0\n' });
  const link = (from, rel) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.linkSync(from, path.join(repo, rel));
  };
  link(outsideFile('nested'), 'docs/deep/notes.md');
  link(outsideFile('module'), 'node_modules/pkg/readme.md'); // the scan prunes nothing
  link(outsideFile('three'), 'a3.txt'); // three names, two of them inside
  link(path.join(repo, 'a3.txt'), 'b3.txt');
  link(outsideFile('odd'), 'odd\tnämé.md');
  link(path.join(repo, 'README.md'), 'docs/README-copy.md'); // both names inside: fine
  fs.linkSync(path.join(repo, 'scripts', 'pre-commit'), path.join(repo, '.git', 'hooks', 'pre-commit')); // a hook: fine
  link(path.join(repo, '.git', 'config'), 'review.txt'); // an alias of .git/config keeps its own reason
  const r = scanOf(repo);
  assert.equal(r.status, 0, r.stderr);
  const real = fs.realpathSync(repo);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.every((l) => /^(SENSITIVE|SYMLINK|CONTENT|SUMMARY) [\x20-\x7e]*$/.test(l)), r.stdout);
  assert.deepEqual(symlinkRecords(r.stdout).sort(), [
    `SYMLINK "odd\\tn\\303\\244m\\303\\251.md" -> "${real}/odd\\tn\\303\\244m\\303\\251.md" ${hardOutside(2, 1)}`,
    `SYMLINK a3.txt -> ${real}/a3.txt ${hardOutside(3, 2)}`,
    `SYMLINK b3.txt -> ${real}/b3.txt ${hardOutside(3, 2)}`,
    `SYMLINK docs/deep/notes.md -> ${real}/docs/deep/notes.md ${hardOutside(2, 1)}`,
    `SYMLINK node_modules/pkg/readme.md -> ${real}/node_modules/pkg/readme.md ${hardOutside(2, 1)}`,
    `SYMLINK review.txt -> ${real}/.git/config (hard link to .git/config)`,
  ].sort(), r.stdout);
  assert.match(lines[lines.length - 1], /^SUMMARY files=\d+ sensitive=0 symlinks=6 content=0 elapsed=[\d.]+s complete=1$/);
});

test('A: a secret-named file hard-linked from outside is refused like an outward symlink, override or not', () => {
  // `ln ~/global.env repo/.env`: the name is denied and counted as secret-like, but the
  // file is also a name outside the repository, so the unconditional hard-link rule applies
  // (the override only accepts the grep exposure of in-repository secret-like files).
  const sb = sandbox();
  const outside = path.join(sb.root, 'global.env');
  fs.writeFileSync(outside, 'SYNTH-OUTSIDE-ENV-b2b2=1\n');
  const repo = mkRepo(sb, 'hard-secret-name', { 'src/a.py': 'x = 1\n' });
  fs.linkSync(outside, path.join(repo, '.env'));
  const r = scanOf(repo);
  assert.equal(r.status, 0, r.stderr);
  const real = fs.realpathSync(repo);
  assert.ok(r.stdout.includes('SENSITIVE .env\n'), r.stdout);
  assert.deepEqual(symlinkRecords(r.stdout), [`SYMLINK .env -> ${real}/.env ${hardOutside(2, 1)}`]);
  assert.match(r.stdout, /SUMMARY files=\d+ sensitive=1 symlinks=1 content=0 /);
  const run = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(run.status, 1, `the override must not accept a hard link with a name outside the repository:\n${run.stderr}`);
  assert.match(run.stderr, /symlinks leaving the repository or aliasing secret-like paths/);
  assert.ok(nothingRendered(sb, repo), 'nothing is rendered before the scan passes');
});

// A main repository with one linked worktree (its .git is a file); paths are canonical.
function linkedWorktree(sb, name) {
  const main = mkRepo(sb, `${name}-main`, { 'src/a.py': 'x = 1\n' });
  const wt = path.join(sb.repos, `${name}-wt`);
  git(main, ['worktree', 'add', '-q', '-b', `${name}-review`, wt]);
  fs.writeFileSync(path.join(wt, 'innocent.txt'), 'innocent\n');
  const realMain = fs.realpathSync(main);
  return { main: realMain, wt: fs.realpathSync(wt), admin: path.join(realMain, '.git', 'worktrees', `${name}-wt`) };
}

test('C: reviewing a linked worktree, a symlinked config.worktree in its git dir is refused, even with the override (into the worktree or dangling)', () => {
  const sb = sandbox();
  const { wt, admin } = linkedWorktree(sb, 'cwt');
  assert.ok(fs.statSync(path.join(wt, '.git')).isFile());
  assert.deepEqual(symlinkRecords(scanOf(wt).stdout), [], 'a clean linked worktree has no record');
  const cfg = path.join(admin, 'config.worktree');
  fs.symlinkSync(path.join(wt, 'innocent.txt'), cfg); // git would write `config --worktree` values into innocent.txt
  assert.deepEqual(symlinkRecords(scanOf(wt).stdout), [`SYMLINK ${cfg} -> ${wt}/innocent.txt (Git config file is a symlink)`]);
  let r = runOauto(sb, wt, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, `a symlinked config.worktree must be refused even with the override:\n${r.stderr}`);
  assert.ok(r.stderr.includes(`\n${cfg} -> ${wt}/innocent.txt (Git config file is a symlink)\n`), r.stderr);
  assert.ok(nothingRendered(sb, wt), 'nothing is rendered before the scan passes');
  fs.unlinkSync(cfg);
  fs.symlinkSync(path.join(sb.root, 'nowhere.cfg'), cfg);
  r = runOauto(sb, wt, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, `a dangling config.worktree link must be refused too:\n${r.stderr}`);
  assert.ok(r.stderr.includes(`\n${cfg} -> ${fs.realpathSync(sb.root)}/nowhere.cfg (Git config file is a symlink)\n`), r.stderr);
});

test('C: reviewing a linked worktree, a symlinked config in its commondir is refused, even with the override', () => {
  const sb = sandbox();
  const { main, wt } = linkedWorktree(sb, 'ccommon');
  const moved = path.join(fs.realpathSync(sb.root), 'real-config');
  fs.renameSync(path.join(main, '.git', 'config'), moved);
  fs.symlinkSync(moved, path.join(main, '.git', 'config')); // git follows it
  const r = runOauto(sb, wt, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`\n${main}/.git/config -> ${moved} (Git config file is a symlink)\n`), r.stderr);
});

test('C: a linked-worktree file hard-linked into its git dirs is refused: a config as an alias, a hook as a name outside the worktree', () => {
  const sb = sandbox();
  const { main, wt, admin } = linkedWorktree(sb, 'chard');
  const cfg = path.join(admin, 'config.worktree');
  fs.writeFileSync(cfg, '[core]\n\tsparseCheckout = false\n');
  fs.linkSync(cfg, path.join(wt, 'innocent2.txt'));
  fs.writeFileSync(path.join(main, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  fs.linkSync(path.join(main, '.git', 'hooks', 'pre-push'), path.join(wt, 'hook-copy.sh'));
  assert.deepEqual(symlinkRecords(scanOf(wt).stdout).sort(), [
    `SYMLINK hook-copy.sh -> ${wt}/hook-copy.sh ${hardOutside(2, 1)}`,
    `SYMLINK innocent2.txt -> ${cfg} (hard link to ${cfg})`,
  ]);
  const r = runOauto(sb, wt, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`\ninnocent2.txt -> ${cfg} (hard link to ${cfg})\n`), r.stderr);
});

// Repository-relative .git paths and whether they name a Git config file (the contract
// _is_git_config had before the git-dir-relative helper was factored out of it).
const GIT_CONFIG_PATHS = { '.git/config': true, '.git/config.worktree': true, '.git/worktrees/wt/config.worktree': true,
  '.git/worktrees/wt/config': true, '.git/modules/sub/config': true, '.git/modules/sub/modules/inner/config': true,
  '.git/modules/sub/worktrees/x/config.worktree': true, '.git/hooks/config': false, '.git/worktrees/config': false,
  '.git/worktrees/wt/sub/config': false, '.git/info/config.worktree': false, '.git/description': false, '.git/configs': false };

test('C: ordinary symlinks in a git dir outside the worktree are not reported; _is_git_config keeps its .git/ contract', () => {
  const sb = sandbox();
  const { main, wt } = linkedWorktree(sb, 'cordinary');
  fs.symlinkSync('/etc/hostname', path.join(main, '.git', 'info', 'outward'));
  assert.ok(symlinkRecords(scanOf(main).stdout).some((l) => l.startsWith('SYMLINK .git/info/outward -> /etc/hostname')),
    'reviewing the main repository refuses it (D4)');
  assert.deepEqual(symlinkRecords(scanOf(wt).stdout), [], 'nothing in that git dir is reachable from the linked worktree');
  const r = runOauto(sb, wt, ['--check']);
  assert.equal(r.status, 0, r.stderr);

  const py = spawnSync('python3', ['-I', '-c', [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("oauto_policy", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'paths = json.loads(sys.argv[2])',
    'print(json.dumps([[mod._is_git_config(p), mod._is_git_dir_config(p[5:])] for p in paths]))',
  ].join('\n'), POLICY, JSON.stringify(Object.keys(GIT_CONFIG_PATHS))], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(JSON.parse(py.stdout), Object.values(GIT_CONFIG_PATHS).map((v) => [v, v]));
});

test('D: a repository holding Composer auth.json is refused without the override; with it the file stays read-denied', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'composer-auth', { 'src/a.php': '<?php echo 1;\n', 'composer.json': '{}\n' });
  fs.writeFileSync(path.join(repo, 'auth.json'), '{"github-oauth": {"github.com": "SYNTH-COMPOSER-TOKEN-d1d1"}}\n');
  let r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /secret-like files present in [^\n]*:\nauth\.json\n/);
  assert.match(r.stderr, /refusing to launch: the model's grep tool/);
  assert.ok(nothingRendered(sb, repo), 'nothing is rendered before the scan passes');
  r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(sb, repo), 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  for (const rules of [cfg.permissions, cfg.agents['review-glm'].permissions, cfg.agents['review-deepseek'].permissions]) {
    assert.equal(decide(rules, 'read', 'auth.json'), 'deny');
    assert.equal(decide(rules, 'read', 'composer.json'), 'allow');
  }
  assert.equal(decide(cfg.policies, 'tool.use', 'read:auth.json'), 'deny');
  assert.ok(!readPreflight(sb, repo).includes('SYNTH-COMPOSER-TOKEN-d1d1'));
});

test('D: a deleted auth.json is excluded from the preflight diff (no override needed)', () => {
  const sb = sandbox();
  const token = 'SYNTH-COMPOSER-DELETED-d2d2';
  const repo = mkRepo(sb, 'composer-deleted', { 'auth.json': `{"github-oauth": {"github.com": "${token}"}}\n`, 'src/a.py': 'x = 1\n' });
  git(repo, ['rm', '-q', 'auth.json']);
  fs.writeFileSync(path.join(repo, 'src/a.py'), 'x = 2\n');
  const r = runOauto(sb, repo, ['--check']);
  assert.equal(r.status, 0, r.stderr);
  const preflight = readPreflight(sb, repo);
  assert.ok(!preflight.includes(token), 'the deleted auth.json must not reach the preflight');
  assert.deepEqual(excludedLines(preflight), ['auth.json']);
  assert.match(preflight, /-x = 1\n\+x = 2/);
  assert.match(r.stderr, /secret-like paths excluded/);
});

const SOURCES_DIR = '/x/state/xdg-config/opencode';
const sourcesPayload = (info) => [{ type: 'document', path: `${SOURCES_DIR}/opencode.json`, info }, { type: 'directory', path: SOURCES_DIR }];
const verifySources = (payload, extra = []) => policy(['verify-sources', '--config-dir', SOURCES_DIR, ...extra], JSON.stringify(payload));

test('E: verify-sources requires the rendered policies and permissions verbatim, then replays the probes', () => {
  const cfg = render('glm');
  const ok = verifySources(sourcesPayload(cfg));
  assert.equal(ok.status, 0, ok.stderr);
  const m = ok.stdout.match(/^config sources ok: only \/x\/state\/xdg-config\/opencode\/opencode\.json \(policies and permissions loaded verbatim\)\npolicies ok: (\d+) probes; permissions ok: (\d+) probes\n$/);
  assert.ok(m, ok.stdout);
  const [nPol, nPerm] = [Number(m[1]), Number(m[2])];
  const mutated = (fn) => {
    const c = JSON.parse(JSON.stringify(cfg));
    fn(c);
    return sourcesPayload(c);
  };
  const without = (rules, action, resource) => rules.filter((x) => !(x.action === action && x.resource === resource));
  const flipped = (rules, action, resource) => rules.map((x) => (x.action === action && x.resource === resource ? { ...x, effect: 'allow' } : x));
  // Exact list equality: a removed, reordered, re-allowed or appended rule — even ones no
  // probe samples (a lone key pattern, a foreign provider/integration/mcp) — fails closed.
  for (const [label, payload, reason] of [
    ['policies missing', mutated((c) => { delete c.policies; }), /the loaded document \S+ has no policies/],
    ['policies empty', mutated((c) => { c.policies = []; }), /has no policies/],
    ['no parsed document', [{ type: 'document', path: `${SOURCES_DIR}/opencode.json` }, { type: 'directory', path: SOURCES_DIR }], /no parsed content \(info\)/],
    ['a probed deny rule removed', mutated((c) => { c.policies = without(c.policies, 'tool.use', 'read:*.env'); }),
      /loaded policies(\[\d+\] is | is missing rule \d+: ).*read:\*\.env/],
    ['an unprobed key pattern removed', mutated((c) => { c.policies = without(c.policies, 'tool.use', 'read:*id_rsa*'); }),
      /loaded policies\[\d+\] is .*expected .*id_rsa/],
    ['a credential pattern removed', mutated((c) => { c.policies = without(c.policies, 'tool.use', 'read:auth.json'); }),
      /loaded policies\[\d+\] is .*expected .*auth\.json/],
    ['provider.use * flipped to allow', mutated((c) => { c.policies = flipped(c.policies, 'provider.use', '*'); }),
      /loaded policies\[\d+\] is \{"action": "provider\.use", "effect": "allow", "resource": "\*"\}/],
    ['a foreign provider appended (no probe samples it)', mutated((c) => { c.policies.push({ action: 'provider.use', resource: 'openrouter', effect: 'allow' }); }),
      /loaded policies has an unexpected extra rule \d+: .*openrouter/],
    ['the .env.example exception removed', mutated((c) => { c.policies = without(c.policies, 'tool.use', 'read:*.env.example'); }),
      /loaded policies\[\d+\] is /],
    ['reordered policies (first rule moved to the end)', mutated((c) => { c.policies.push(c.policies.shift()); }), /loaded policies\[0\] is /],
    ['malformed policy rule (resource array)', mutated((c) => { c.policies.push({ action: 'tool.use', resource: ['read:x'], effect: 'allow' }); }), /has a malformed policies rule/],
    ['permissions widened', mutated((c) => { c.permissions.push({ action: 'read', resource: '*', effect: 'allow' }); }),
      /loaded permissions has an unexpected extra rule \d+: .*"read"/],
    ['a permission deny removed', mutated((c) => { c.permissions = without(c.permissions, 'read', '*.env'); }), /loaded permissions\[\d+\] is /],
    ['permissions missing', mutated((c) => { delete c.permissions; }), /has no permissions/],
  ]) {
    const r = verifySources(payload);
    assert.notEqual(r.status, 0, `${label} must fail verification`);
    assert.match(r.stderr, reason, `${label}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${label}: no ok line`);
  }
  // The launch's own read denials must be loaded verbatim too (both spellings, in the
  // policies and the permissions).
  const rendered = render('glm', ['--deny-read', 'review-config.txt']);
  const notRendered = verifySources(sourcesPayload(cfg), ['--deny-read=review-config.txt']);
  assert.notEqual(notRendered.status, 0);
  assert.match(notRendered.stderr, /loaded policies is missing rule \d+: .*read:review-config\.txt/);
  const half = JSON.parse(JSON.stringify(rendered));
  half.policies = without(half.policies, 'tool.use', 'read:*/review-config.txt');
  const halfDenied = verifySources(sourcesPayload(half), ['--deny-read=review-config.txt']);
  assert.notEqual(halfDenied.status, 0);
  assert.match(halfDenied.stderr, /loaded policies(\[\d+\] is | is missing rule \d+: ).*review-config\.txt/);
  const permHalf = JSON.parse(JSON.stringify(rendered));
  permHalf.permissions = without(permHalf.permissions, 'read', 'review-config.txt');
  const permDenied = verifySources(sourcesPayload(permHalf), ['--deny-read=review-config.txt']);
  assert.notEqual(permDenied.status, 0);
  assert.match(permDenied.stderr, /loaded permissions(\[\d+\] is | is missing rule \d+: ).*review-config\.txt/);
  const denied = verifySources(sourcesPayload(rendered), ['--deny-read=review-config.txt']);
  assert.equal(denied.status, 0, denied.stderr);
  assert.ok(denied.stdout.includes(`policies ok: ${nPol + 2} probes; permissions ok: ${nPerm + 2} probes`), denied.stdout);
});

// A copy of PROBES with the effect the policies ceiling (tool.use, `action:resource`) must
// give: deny where it covers the denial, allow for the documented exceptions, 'not deny' for
// the reviewer's own tools (left to the permissions) and 'not allow' where only the
// permissions deny (escaping globs, unknown tools: the ceiling has no rule for them).
const PROBE_TABLE = [
  ['shell', 'git status', 'deny', 'deny'], ['shell', 'ls', 'deny', 'deny'], ['shell', './gradlew assembleDebug', 'deny', 'deny'],
  ['edit', 'src/main.kt', 'deny', 'deny'], ['edit', 'README.md', 'deny', 'deny'], ['webfetch', 'https://example.com', 'deny', 'deny'],
  ['websearch', 'anything', 'deny', 'deny'], ['subagent', 'explore', 'deny', 'deny'], ['subagent', 'general', 'deny', 'deny'],
  ['skill', 'anything', 'deny', 'deny'], ['execute', '*', 'deny', 'deny'], ['external_directory', '/root/.ssh', 'deny', 'deny'],
  ['external_directory', '/etc', 'deny', 'deny'], ['read', '.env', 'deny', 'deny'], ['read', 'config/.env.production', 'deny', 'deny'],
  ['read', 'keys/server.pem', 'deny', 'deny'], ['read', 'deploy/.ssh/id_ed25519', 'deny', 'deny'], ['read', '.ssh/config', 'deny', 'deny'],
  ['read', '.gnupg/pubring.kbx', 'deny', 'deny'], ['read', '.git/config', 'deny', 'deny'], ['read', '.npmrc', 'deny', 'deny'],
  ['read', 'app/local.properties', 'deny', 'deny'], ['read', 'app/keystore.properties', 'deny', 'deny'],
  ['read', 'config/prod.secrets.yaml', 'deny', 'deny'], ['read', 'app-secrets.json', 'deny', 'deny'],
  ['read', 'oauth/client_secret_123.json', 'deny', 'deny'], ['read', 'infra/terraform.tfstate', 'deny', 'deny'],
  ['read', 'auth.json', 'deny', 'deny'], ['read', 'vendor/auth.json', 'deny', 'deny'], ['read', '.kube/config', 'deny', 'deny'],
  ['read', 'deploy/sa/serviceAccountKey.json', 'deny', 'deny'], ['read', '.env.example', 'allow', 'allow'],
  ['read', 'gradle.properties', 'allow', 'not deny'], ['read', 'src/main.kt', 'allow', 'not deny'], ['glob', '**/*.kt', 'allow', 'not deny'],
  ['glob', 'src/**/*.{kt,java}', 'allow', 'not deny'], ['glob', '/root/**', 'deny', 'not allow'], ['glob', '{/root,x}/.ssh/*', 'deny', 'not allow'],
  ['glob', '../**', 'deny', 'not allow'], ['grep', 'TODO', 'allow', 'not deny'], ['question', '*', 'allow', 'not deny'],
  ['experimental_image_generate', 'x', 'deny', 'deny'], ['browser', 'x', 'deny', 'deny'], ['unknown_future_tool', 'x', 'deny', 'not allow'],
];
const effectHolds = (got, want) => (want === 'not deny' ? got !== 'deny' : want === 'not allow' ? got !== 'allow' : got === want);

test('E: every probe resolves as intended against the rendered permissions and the policies ceiling (the table is PROBES)', () => {
  const r = spawnSync('python3', ['-I', '-c', [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("oauto_policy", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(mod)',
    'print(json.dumps({"probes": mod.PROBES, "policy_probes": mod.policy_probes(["review-config.txt"])}))',
  ].join('\n'), POLICY], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { probes, policy_probes: policyProbes } = JSON.parse(r.stdout);
  assert.deepEqual(PROBE_TABLE.map(([action, resource, effect]) => [action, resource, effect]), probes, 'the table must be exactly PROBES');
  const wrong = [];
  for (const alias of Object.keys(APPROVED)) {
    const cfg = render(alias);
    for (const [action, resource, perm, pol] of PROBE_TABLE) {
      const gotPerm = decide(cfg.permissions, action, resource);
      const gotPol = decide(cfg.policies, 'tool.use', `${action}:${resource}`);
      if (gotPerm !== perm) wrong.push(`${alias} permissions: ${action} ${resource} -> ${gotPerm}, want ${perm}`);
      if (!effectHolds(gotPol, pol)) wrong.push(`${alias} policies: tool.use ${action}:${resource} -> ${gotPol}, want ${pol}`);
    }
  }
  // The verifier's own ceiling probes agree with this independent matcher on the rendered document.
  const withDenial = render('glm', ['--deny-read', 'review-config.txt']);
  for (const [action, resource, want] of policyProbes) {
    const got = decide(withDenial.policies, action, resource);
    if (!effectHolds(got, want)) wrong.push(`policy_probes: ${action} ${resource} -> ${got}, want ${want}`);
  }
  assert.deepEqual(wrong, []);
});

test('E: oauto-run verifies the loaded policies and permissions including the launch\'s own read denials', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'policies-deny-read', { 'src/a.py': 'x = 1\n', 'review-config.txt': '[k]\n\tv = 1\n' });
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../review-config.txt\n');
  const r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  const direct = verifySources(sourcesPayload(render('glm', ['--deny-read', 'review-config.txt'])), ['--deny-read=review-config.txt']);
  assert.equal(direct.status, 0, direct.stderr);
  const line = direct.stdout.split('\n')[1];
  assert.match(line, /^policies ok: \d+ probes; permissions ok: \d+ probes$/);
  assert.ok(r.stderr.includes(`\n${line}\n`), `the launcher must hand its read denials to verify-sources:\n${r.stderr}`);
});

// ---------------------------------------------------------------------------
// Round 13: a crafted .git FILE (P2-1/P3-2), verbatim-only verify (P3-3), case-variant
// read denials (P3-4), object-store hard-link accounting (P3-5) and secret-named git-dir
// aliases (P3-6).
// ---------------------------------------------------------------------------
const checkRepoGit = (repo) => policy(['check-repo-git', repo]);
// A plain directory (not a git repo) whose .git is a FILE naming `gitdir`.
function dotGitFile(sb, name, gitdir, { raw = null } = {}) {
  const dir = path.join(sb.repos, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# project to review\n');
  fs.writeFileSync(path.join(dir, '.git'), raw !== null ? raw : `gitdir: ${gitdir}\n`);
  return dir;
}

test('P2-1: a .git file naming another repository is refused before any git runs, nothing is rendered, the victim is untouched', () => {
  const sb = sandbox();
  const victim = mkRepo(sb, 'victim', { 'notes.md': 'VICTIM-NOTES-SYNTH-7f71\n', '.env': 'TOKEN=VICTIM-ENV-SYNTH\n' });
  git(victim, ['commit', '-q', '--allow-empty', '-m', 'VICTIM-LOG-SYNTH-7f71']);
  const realVictim = fs.realpathSync(victim);
  const idx = path.join(realVictim, '.git', 'index');
  const before = fs.existsSync(idx) ? fs.statSync(idx) : null;
  for (const [label, gitdir] of [['absolute', `${realVictim}/.git`], ['relative', '../victim/.git']]) {
    const attacker = dotGitFile(sb, `attacker-${label}`, gitdir);
    const r = runOauto(sb, attacker, ['--check']);
    assert.equal(r.status, 1, `${label} crafted .git must be refused (exit 0 leaked the victim):\n${r.stderr}`);
    assert.match(r.stderr, /does not belong to this worktree/);
    assert.match(r.stderr, /no git command was run against it/);
    assert.ok(nothingRendered(sb, attacker), `${label}: nothing may be rendered`);
    const pf = path.join(stateDir(sb, attacker), 'preflight.md');
    assert.ok(!fs.existsSync(pf), `${label}: no preflight may be written`);
    for (const token of ['VICTIM-NOTES-SYNTH-7f71', 'VICTIM-LOG-SYNTH-7f71']) {
      assert.ok(!r.stderr.includes(token), `${label}: the victim's ${token} must not surface`);
    }
  }
  const after = fs.existsSync(idx) ? fs.statSync(idx) : null;
  assert.equal(before === null, after === null, 'victim .git/index existence unchanged');
  if (before && after) {
    assert.equal(after.mtimeMs, before.mtimeMs, 'victim .git/index mtime unchanged (no git ran against it)');
    assert.equal(after.size, before.size, 'victim .git/index size unchanged');
  }
});

test('P2-1: check-repo-git accepts a real .git dir, a linked worktree and a submodule; refuses symlinks, foreign, missing and moved', () => {
  const sb = sandbox();
  const plain = mkRepo(sb, 'plain', { 'a.py': 'x = 1\n' });
  assert.equal(checkRepoGit(plain).status, 0, 'a real .git directory is accepted');

  const { wt } = linkedWorktree(sb, 'lw');
  assert.equal(checkRepoGit(wt).status, 0, 'a legitimate linked worktree is accepted');

  // A real submodule checkout: <super>/sub has a .git file naming <super>/.git/modules/sub.
  const subsrc = mkRepo(sb, 'subsrc', { 's.txt': 's\n' });
  const sup = mkRepo(sb, 'super', { 'a.py': 'x = 1\n' });
  git(sup, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subsrc, 'sub']);
  git(sup, ['commit', '-q', '-m', 'add submodule']);
  const sub = path.join(sup, 'sub');
  assert.ok(fs.statSync(path.join(sub, '.git')).isFile(), 'the submodule .git is a file');
  assert.equal(checkRepoGit(sub).status, 0, `a legitimate submodule checkout is accepted:\n${checkRepoGit(sub).stderr}`);

  // A symlinked .git is refused with its own reason, before any git could run.
  const realrepo = mkRepo(sb, 'realrepo', { 'a.py': 'x = 1\n' });
  const symd = path.join(sb.repos, 'symd');
  fs.mkdirSync(symd, { recursive: true });
  fs.symlinkSync(path.join(realrepo, '.git'), path.join(symd, '.git'));
  let r = checkRepoGit(symd);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /\.git is a symlink/);

  const foreign = dotGitFile(sb, 'foreign', `${fs.realpathSync(realrepo)}/.git`);
  assert.equal(checkRepoGit(foreign).status, 2, 'a .git file naming an unrelated repo is refused');
  assert.match(checkRepoGit(foreign).stderr, /does not belong to this worktree.*git worktree repair/s);

  const missing = dotGitFile(sb, 'missingtgt', `${sb.repos}/does-not-exist/.git`);
  r = checkRepoGit(missing);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist/);

  const malformed = dotGitFile(sb, 'malformed', '', { raw: 'this is not a gitdir pointer\n' });
  r = checkRepoGit(malformed);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /malformed \.git file/);

  // A moved linked worktree (its admin dir's back-pointer no longer matches): refused with the repair hint.
  const { wt: wt2 } = linkedWorktree(sb, 'moved');
  const movedTo = path.join(sb.repos, 'moved-elsewhere');
  fs.renameSync(wt2, movedTo);
  r = checkRepoGit(movedTo);
  assert.equal(r.status, 2, 'a moved linked worktree is refused until `git worktree repair`');
  assert.match(r.stderr, /git worktree repair/);
});

test('P3-2: the .git file parser keeps git\'s trailing-space semantics; a bare redirect to a foreign git dir is refused', () => {
  const sb = sandbox();
  // git strips only trailing CR/LF, so `gitdir: <dir> \n` names "<dir> " (with the space),
  // not a sibling decoy the old .strip() would have walked. Either way the dir is a bare
  // redirect (not a worktree or submodule), so it is unowned and refused.
  const src = mkRepo(sb, 'b2src', { 'a.py': 'x = 1\n' });
  const real = `${fs.realpathSync(sb.repos)}/b2-gitdir `;    // trailing space is part of the name
  fs.renameSync(path.join(src, '.git'), real);
  fs.mkdirSync(`${fs.realpathSync(sb.repos)}/b2-gitdir`, { recursive: true });  // the decoy the old parser walked
  const wt = path.join(sb.repos, 'b2wt');
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'a.py'), 'x = 1\n');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${fs.realpathSync(sb.repos)}/b2-gitdir \n`);
  const scan = scanOf(wt);
  assert.equal(scan.status, 0, scan.stderr);
  assert.ok(symlinkRecords(scan.stdout).some((l) => l.includes('b2-gitdir ') && l.includes('does not belong to this worktree')),
    `the scan must name the trailing-space git dir, not the decoy:\n${scan.stdout}`);
  const r = runOauto(sb, wt, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, 'a bare redirect to a foreign git dir is refused even with the override');
  assert.match(r.stderr, /does not belong to this worktree/);
});

test('P1 (Codex on 33c0dda): a real .git directory carrying a commondir file is refused before any git runs; a planted commondir in a submodule git dir too', () => {
  const sb = sandbox();
  const victim = mkRepo(sb, 'cd-victim', { 'private.txt': 'VICTIM-PRIVATE-SYNTH-c0c0\n' });
  const realVictim = fs.realpathSync(victim);
  const idx = path.join(realVictim, '.git', 'index');
  const before = fs.statSync(idx);
  // An otherwise ordinary repository whose REAL .git directory names the victim's git dir as its
  // common dir: git would take refs, objects and config from there despite --work-tree.
  const attacker = mkRepo(sb, 'cd-attacker', { 'README.md': '# review me\n' });
  fs.writeFileSync(path.join(attacker, '.git', 'commondir'), `${realVictim}/.git\n`);
  let r = checkRepoGit(attacker);
  assert.equal(r.status, 2, 'a real .git with a commondir file must be refused');
  assert.match(r.stderr, /\.git holds a commondir file \(.*cd-victim\/\.git\)/);
  const scan = scanOf(attacker);
  assert.equal(scan.status, 0, scan.stderr);
  assert.deepEqual(symlinkRecords(scan.stdout),
    [`SYMLINK .git -> ${realVictim}/.git (.git holds a commondir file naming another git dir)`]);
  r = runOauto(sb, attacker, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, `exit 0 would have leaked the victim:\n${r.stderr}`);
  assert.match(r.stderr, /holds a commondir file/);
  assert.match(r.stderr, /no git command was run against it/);
  assert.ok(nothingRendered(sb, attacker), 'nothing may be rendered');
  assert.ok(!fs.existsSync(path.join(stateDir(sb, attacker), 'preflight.md')), 'no preflight may be written');
  assert.ok(!r.stderr.includes('VICTIM-PRIVATE-SYNTH-c0c0'));
  const after = fs.statSync(idx);
  assert.equal(after.mtimeMs, before.mtimeMs, 'victim .git/index mtime unchanged (no git ran against it)');
  assert.equal(after.size, before.size);
  // An empty commondir file is refused as well: git would still honour the file.
  fs.writeFileSync(path.join(attacker, '.git', 'commondir'), '');
  r = checkRepoGit(attacker);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /holds a commondir file/);
  // A submodule git dir has no commondir file; a planted one would redirect the submodule's
  // refs, objects and config, so the checkout is no longer owned.
  const subsrc = mkRepo(sb, 'cd-subsrc', { 's.txt': 's\n' });
  const sup = mkRepo(sb, 'cd-super', { 'a.py': 'x = 1\n' });
  git(sup, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subsrc, 'sub']);
  git(sup, ['commit', '-q', '-m', 'add submodule']);
  const sub = path.join(sup, 'sub');
  assert.equal(checkRepoGit(sub).status, 0, 'the clean submodule checkout is accepted');
  fs.writeFileSync(path.join(sup, '.git', 'modules', 'sub', 'commondir'), `${realVictim}/.git\n`);
  r = checkRepoGit(sub);
  assert.equal(r.status, 2, 'a planted commondir in the submodule git dir must be refused');
  assert.match(r.stderr, /does not belong to this worktree/);
});

test('P1 (Codex on 0ca1844): a committed symlink among deleted included configs is resolved within the revision, so its target is excluded and followed', () => {
  const sb = sandbox();
  const token = 'S-LINK-HISTORY-SYNTH-9d9d';
  // .git/config includes conf/a.cfg; at HEAD a.cfg is a symlink to b.cfg, which holds the
  // credential; both are deleted in the worktree. The old history pass parsed the link's
  // blob ("b.cfg") as config text, so b.cfg was never excluded and its removed line travelled.
  const repo = chainRepo(sb, 'link-history', { 'conf/b.cfg': includedConfigText(token) }, '../conf/a.cfg');
  fs.symlinkSync('b.cfg', path.join(repo, 'conf', 'a.cfg'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'link a.cfg to b.cfg']);
  assert.equal(git(repo, ['ls-tree', 'HEAD', '--', 'conf/a.cfg']).slice(0, 6), '120000', 'the include target is a committed symlink');
  fs.rmSync(path.join(repo, 'conf'), { recursive: true });
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo); // no override: nothing secret-like is present
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token),
    `the deleted target of a committed symlink include must not reach the preflight or the prompt:\n${preflight}`);
  assert.deepEqual(excludedLines(preflight), ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)']);
});

test('P1 (Codex on 0ca1844): symlink chains, loops, escaping targets and a type change in included-config history; resolve-link fails closed', () => {
  const sb = sandbox();
  const outcome = {};
  const record = (label, repo, tokens, env = {}) => {
    const { r, preflight, prompt } = launchRecordingPrompt(sb, repo, env);
    outcome[label] = { status: r.status, leaked: tokens.some((t) => preflight.includes(t) || prompt.includes(t)), excluded: excludedLines(preflight), stderr: r.stderr };
  };
  // Two committed symlinks before the file: a.cfg -> b.cfg -> ../deep/c.cfg (credential); all deleted.
  const chain = chainRepo(sb, 'link-chain', { 'deep/c.cfg': includedConfigText('S-LINK-CHAIN-1a1a') }, '../conf/a.cfg');
  fs.mkdirSync(path.join(chain, 'conf'));
  fs.symlinkSync('../deep/c.cfg', path.join(chain, 'conf', 'b.cfg'));
  fs.symlinkSync('b.cfg', path.join(chain, 'conf', 'a.cfg'));
  git(chain, ['add', '-A']);
  git(chain, ['commit', '-q', '-m', 'links']);
  fs.rmSync(path.join(chain, 'conf'), { recursive: true });
  fs.rmSync(path.join(chain, 'deep'), { recursive: true });
  record('chain', chain, ['S-LINK-CHAIN-1a1a']);
  // A loop of committed symlinks, both deleted: terminates, both excluded. (The include is
  // added after the commit: git itself cannot read a looping include while staging.)
  const loop = mkRepo(sb, 'link-loop', { 'src/a.py': 'x = 1\n' });
  fs.mkdirSync(path.join(loop, 'conf'));
  fs.symlinkSync('b.cfg', path.join(loop, 'conf', 'a.cfg'));
  fs.symlinkSync('a.cfg', path.join(loop, 'conf', 'b.cfg'));
  git(loop, ['add', '-A']);
  git(loop, ['commit', '-q', '-m', 'loop']);
  fs.appendFileSync(path.join(loop, '.git', 'config'), '[include]\n\tpath = ../conf/a.cfg\n');
  fs.rmSync(path.join(loop, 'conf'), { recursive: true });
  record('loop', loop, []);
  // A committed symlink whose target escapes the repository: followed as an outside file (never parsed as text).
  const outsideCfg = path.join(fs.realpathSync(sb.root), 'escape-target.cfg');
  fs.writeFileSync(outsideCfg, includedConfigText('S-LINK-ESCAPE-2b2b'));
  const esc = chainRepo(sb, 'link-escape', {}, '../conf/a.cfg');
  fs.mkdirSync(path.join(esc, 'conf'));
  fs.symlinkSync(path.relative(path.join(fs.realpathSync(esc), 'conf'), outsideCfg), path.join(esc, 'conf', 'a.cfg'));
  git(esc, ['add', '-A']);
  git(esc, ['commit', '-q', '-m', 'escaping link']);
  fs.rmSync(path.join(esc, 'conf'), { recursive: true });
  record('escape', esc, ['S-LINK-ESCAPE-2b2b']);
  // Type change: a.cfg was a symlink to b.cfg at HEAD and is now an ordinary (included, present) file; b.cfg deleted.
  const typed = chainRepo(sb, 'link-typechange', { 'conf/b.cfg': includedConfigText('S-LINK-TYPE-3c3c') }, '../conf/a.cfg');
  fs.symlinkSync('b.cfg', path.join(typed, 'conf', 'a.cfg'));
  git(typed, ['add', '-A']);
  git(typed, ['commit', '-q', '-m', 'link']);
  fs.unlinkSync(path.join(typed, 'conf', 'a.cfg'));
  fs.writeFileSync(path.join(typed, 'conf', 'a.cfg'), '[k]\n\tv = 1\n');
  fs.rmSync(path.join(typed, 'conf', 'b.cfg'));
  record('typechange', typed, ['S-LINK-TYPE-3c3c'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' }); // a.cfg is present and included
  assert.deepEqual(Object.fromEntries(Object.entries(outcome).map(([k, v]) => [k, { status: v.status, leaked: v.leaked, excluded: v.excluded }])), {
    chain: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)', 'deep/c.cfg (included Git config)'] },
    loop: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)'] },
    escape: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)'] },
    typechange: { status: 0, leaked: false, excluded: ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)'] },
  }, JSON.stringify(outcome, null, 1));
  // resolve-link itself: empty and .git targets fail closed; absolute and relative targets resolve as git would.
  for (const [input, want] of [['', /empty or malformed/], ['../.git/config', /cannot be an included config/], ['..', /cannot be an included config|empty or malformed/]]) {
    const bad = policy(['resolve-link', '--repo', chain, '--link-path', 'conf/a.cfg'], input);
    assert.notEqual(bad.status, 0, `resolve-link must refuse ${JSON.stringify(input)}`);
    if (input !== '..') assert.match(bad.stderr, want);
  }
  const abs = policy(['resolve-link', '--repo', chain, '--link-path', 'conf/a.cfg'], '/etc/gitconfig');
  assert.equal(abs.status, 0, abs.stderr);
  assert.equal(abs.stdout, 'O\0/etc/gitconfig\0');
  const rel = policy(['resolve-link', '--repo', chain, '--link-path', 'conf/a.cfg'], '../deep/./c.cfg');
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(rel.stdout, 'I\0deep/c.cfg\0');
  const up = policy(['resolve-link', '--repo', chain, '--link-path', 'conf/a.cfg'], '../../x.cfg');
  assert.equal(up.status, 0, up.stderr);
  assert.equal(up.stdout, `O\0${path.join(fs.realpathSync(chain), '..', 'x.cfg')}\0`);
});

test('P1 (Codex on 2c743cf): a committed symlink with an ABSOLUTE target inside the repository is an in-repository include target', () => {
  const sb = sandbox();
  const token = 'S-LINK-ABSOLUTE-SYNTH-4d4d';
  const repo = chainRepo(sb, 'link-absolute', { 'conf/b.cfg': includedConfigText(token) }, '../conf/a.cfg');
  const real = fs.realpathSync(repo);
  fs.symlinkSync(path.join(real, 'conf', 'b.cfg'), path.join(repo, 'conf', 'a.cfg')); // absolute, inside the repository
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'absolute link']);
  fs.rmSync(path.join(repo, 'conf'), { recursive: true });
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo); // no override: nothing secret-like is present
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token),
    `the deleted target of an absolute in-repository symlink include must not reach the preflight:\n${preflight}`);
  assert.deepEqual(excludedLines(preflight), ['conf/a.cfg (included Git config)', 'conf/b.cfg (included Git config)']);
  // resolve-link: absolute inside → I with the repository-relative path; .git or the root → fail closed; outside → O.
  const inside = policy(['resolve-link', '--repo', repo, '--link-path', 'conf/a.cfg'], path.join(real, 'conf', 'b.cfg'));
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(inside.stdout, 'I\0conf/b.cfg\0');
  for (const bad of [path.join(real, '.git', 'config'), real, `${real}/`]) {
    const refused = policy(['resolve-link', '--repo', repo, '--link-path', 'conf/a.cfg'], bad);
    assert.notEqual(refused.status, 0, `resolve-link must refuse ${bad}`);
    assert.match(refused.stderr, /cannot be an included config/);
  }
  const outside = policy(['resolve-link', '--repo', repo, '--link-path', 'conf/a.cfg'], `${real}-sibling/x.cfg`);
  assert.equal(outside.status, 0, outside.stderr);
  assert.equal(outside.stdout, `O\0${real}-sibling/x.cfg\0`, 'a sibling directory sharing the prefix is outside');
});

test('a committed DIRECTORY symlink on an included-config path (conf -> realconf), link and target deleted, is resolved within the revision', () => {
  const sb = sandbox();
  const token = 'S-DIRLINK-HISTORY-SYNTH-5e5e';
  // .git/config includes conf/a.cfg; at HEAD `conf` is a symlink to realconf/, which holds a.cfg
  // with the credential. Both the link and the directory are deleted. git cannot read
  // HEAD:conf/a.cfg through a tree symlink, so the hop must resolve the directory link.
  const repo = chainRepo(sb, 'dirlink-history', { 'realconf/a.cfg': includedConfigText(token) }, '../conf/a.cfg');
  fs.symlinkSync('realconf', path.join(repo, 'conf'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'conf -> realconf']);
  assert.equal(git(repo, ['ls-tree', 'HEAD', '--', 'conf']).slice(0, 6), '120000');
  fs.unlinkSync(path.join(repo, 'conf'));
  fs.rmSync(path.join(repo, 'realconf'), { recursive: true });
  const { r, preflight, prompt } = launchRecordingPrompt(sb, repo); // no override: nothing secret-like is present
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!preflight.includes(token) && !prompt.includes(token),
    `the deleted file behind a deleted committed directory symlink must not reach the preflight:\n${preflight}`);
  // The diff holds the deleted link `conf` (content "realconf", shown) and the deleted real
  // file; `conf/a.cfg` itself was never a path git tracked, so only the real file is listed.
  assert.deepEqual(excludedLines(preflight), ['realconf/a.cfg (included Git config)']);
  assert.match(preflight, /^-realconf$/m, 'the deleted directory link itself is ordinary content');
  // resolve-link --rest: the path below the directory link is appended after resolution.
  const below = policy(['resolve-link', '--repo', repo, '--link-path', 'conf', '--rest', 'deep/a.cfg'], 'elsewhere/real');
  assert.equal(below.status, 0, below.stderr);
  assert.equal(below.stdout, 'I\0elsewhere/real/deep/a.cfg\0');
  const nested = policy(['resolve-link', '--repo', repo, '--link-path', 'etc/conf', '--rest', 'deep/a.cfg'], '../elsewhere/real');
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(nested.stdout, 'I\0elsewhere/real/deep/a.cfg\0', 'a link below the root resolves relative to its own directory');
  const escaping = policy(['resolve-link', '--repo', repo, '--link-path', 'conf', '--rest', 'a.cfg'], '../../out');
  assert.equal(escaping.status, 0, escaping.stderr);
  assert.equal(escaping.stdout, `O\0${path.join(fs.realpathSync(repo), '..', '..', 'out', 'a.cfg')}\0`, 'two levels above the root');
});

test('P3-4: case-variant secret-like files are denied by their exact name under the override, in both agents and the ceiling', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'case-variants', { 'src/a.py': 'x = 1\n', 'Auth.json': '{"t":"SYNTH"}\n',
    '.PGPASS': 'h:5432:d:u:p\n', 'keys/Server.PPK': 'synthetic test material\n', 'sa/ServiceAccountKey.json': '{}\n',
    'vendor/auth.json': '{}\n' });  // lowercase: the static */auth.json rule denies it exactly
  // Without the override a secret-like file (whatever its case) already refuses the launch.
  assert.equal(runOauto(sb, repo, ['--check']).status, 1);
  const base = Number(policy(['verify-agents'], JSON.stringify(resolvedAgents(render('glm')))).stdout.match(/(\d+) probes each/)[1]);
  const r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir(sb, repo), 'xdg-config', 'opencode', 'opencode.json'), 'utf8'));
  const names = ['Auth.json', '.PGPASS', 'keys/Server.PPK', 'sa/ServiceAccountKey.json'];
  for (const p of names) {
    for (const rules of [cfg.permissions, cfg.agents['review-glm'].permissions, cfg.agents['review-deepseek'].permissions]) {
      assert.equal(decide(rules, 'read', p), 'deny', `read ${p} must be denied by exact name`);
    }
    assert.equal(decide(cfg.policies, 'tool.use', `read:${p}`), 'deny', `ceiling must deny read:${p}`);
    assert.equal(decide(cfg.policies, 'tool.use', `read:x/${p}`), 'deny', `ceiling must deny the */ spelling of ${p}`);
  }
  // The launcher handed these to verify-agents, so its probe count grew (one per name; a
  // nested name also gets its */ form only in the ceiling, agents probe the exact path).
  assert.match(r.stderr, new RegExp(`${base + names.length} probes each`));
  // The lowercase vendor/auth.json is secret-like too, but the static rules already deny
  // its exact spelling, so it is NOT added to the deny-read set: the probe count above
  // grew by the four case variants only, and no per-launch rule names it.
  assert.equal(decide(cfg.permissions, 'read', 'vendor/auth.json'), 'deny');
  assert.ok(!cfg.permissions.some((x) => x.resource === 'vendor/auth.json' || x.resource === '*/vendor/auth.json'),
    'a name the static rules deny exactly gets no per-launch rule');
});

test('P3-4: a case-variant secret-like name holding a glob metacharacter refuses the launch even with the override', () => {
  const sb = sandbox();
  const repo = mkRepo(sb, 'case-glob', { 'src/a.py': 'x = 1\n' });
  // `*.pem` matches `keys/Server[1].PEM` case-insensitively, but the case-sensitive read
  // rule does not deny that exact spelling, and `[` cannot be denied by an exact name.
  fs.mkdirSync(path.join(repo, 'keys'));
  fs.writeFileSync(path.join(repo, 'keys', 'Server[1].PEM'), 'synthetic test material\n');
  // Without the override the secret-like refusal already fires.
  assert.equal(runOauto(sb, repo, ['--check']).status, 1);
  // With the override the exact-name denial is attempted, and the metacharacter is fatal.
  const r = runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' });
  assert.equal(r.status, 1, `a glob-metacharacter secret-like name must refuse under the override:\n${r.stderr}`);
  assert.match(r.stderr, /secret-like file name holds a glob metacharacter.*rename it/s);
});

test('P3-5: hard links to the object store are accounted names, not aliases (self-clone and annex), but outside partners still refuse', () => {
  const sb = sandbox();
  // A clone of the repo inside its own worktree hard-links objects; those are names inside
  // the repository (the inner copy under */.git/*), so no hard-link record — only the usual
  // SENSITIVE */.git/* entries, which need the override.
  const self = mkRepo(sb, 'selfclone', { 'a.py': 'x = 1\n' });
  execFileSync('git', ['clone', '-q', self, path.join(self, 'inner-copy')]);
  let scan = scanOf(self);
  assert.equal(scan.status, 0, scan.stderr);
  assert.deepEqual(symlinkRecords(scan.stdout), [], `a self-clone must produce no hard-link record:\n${scan.stdout}`);
  assert.equal(runOauto(sb, self, ['--check']).status, 1, 'the inner .git/* files are still SENSITIVE (override needed)');
  assert.equal(runOauto(sb, self, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' }).status, 0);

  // git-annex thin mode: a worktree file hard-linked to .git/annex/objects/... is accounted.
  const annex = mkRepo(sb, 'annex', { 'a.py': 'x = 1\n' });
  fs.mkdirSync(path.join(annex, '.git', 'annex', 'objects', 'aa', 'bb', 'K'), { recursive: true });
  fs.writeFileSync(path.join(annex, '.git', 'annex', 'objects', 'aa', 'bb', 'K', 'K'), 'annex object\n');
  fs.linkSync(path.join(annex, '.git', 'annex', 'objects', 'aa', 'bb', 'K', 'K'), path.join(annex, 'data.bin'));
  scan = scanOf(annex);
  assert.equal(scan.status, 0, scan.stderr);
  assert.deepEqual(symlinkRecords(scan.stdout), [], `an annex-object hard link must be accounted:\n${scan.stdout}`);
  assert.equal(runOauto(sb, annex, ['--check']).status, 0, 'nothing is secret-like, so the launch passes');

  // A third name hidden in the object store plus one outside: still refused, count reflects the object name.
  const outside = path.join(sb.root, 'outside-secret');
  fs.writeFileSync(outside, 'OUTSIDE-SYNTH\n');
  const a7 = mkRepo(sb, 'objname', { 'a.py': 'x = 1\n' });
  fs.linkSync(outside, path.join(a7, 'notes.md'));
  fs.mkdirSync(path.join(a7, '.git', 'objects', 'zz'), { recursive: true });
  fs.linkSync(path.join(a7, 'notes.md'), path.join(a7, '.git', 'objects', 'zz', 'hidden'));
  scan = scanOf(a7);
  assert.ok(symlinkRecords(scan.stdout).some((l) => l.startsWith('SYMLINK notes.md -> ') && l.includes('3 names, 2 inside the repository')),
    `an outside partner must still refuse, now counting the object name:\n${scan.stdout}`);

  // A clone of a repository that lives OUTSIDE the worktree: objects are hard-linked to the
  // outside source, so the names are outside — still refused.
  const src = mkRepo(sb, 'vendor-src', { 'f.txt': 'f\n' });
  const vendor = mkRepo(sb, 'vendor', { 'a.py': 'x = 1\n' });
  execFileSync('git', ['clone', '-q', src, path.join(vendor, 'lib')]);
  scan = scanOf(vendor);
  assert.ok(symlinkRecords(scan.stdout).some((l) => l.includes('inside the repository')),
    `a vendored clone from outside keeps outside partners and is refused:\n${scan.stdout}`);
});

test('P3-6: a secret-named hard link to a .git dir file is refused unconditionally; two secret names of one ordinary file are not', () => {
  const sb = sandbox();
  // ln .git/config notes.pem: the alias name (*.pem) would pass no read rule that the file
  // itself is denied by, so it must be refused as an alias, not merely listed SENSITIVE.
  const repo = mkRepo(sb, 'secret-alias-gitcfg', { 'src/a.py': 'x = 1\n' });
  fs.linkSync(path.join(repo, '.git', 'config'), path.join(repo, 'notes.pem'));
  const scan = scanOf(repo);
  assert.equal(scan.status, 0, scan.stderr);
  assert.ok(symlinkRecords(scan.stdout).some((l) => /^SYMLINK notes\.pem -> .*\(hard link to \.git\/config\)$/.test(l)),
    `a secret-named alias of .git/config must be refused as an alias:\n${scan.stdout}`);
  // Even with the override the launch is refused (the alias is unconditional, not SENSITIVE-overridable).
  assert.equal(runOauto(sb, repo, ['--check'], { OAUTO_ALLOW_SENSITIVE_FILES: '1' }).status, 1);

  // Two secret-like names of one ordinary worktree file (.env <-> prod.env): both are denied
  // by name, so no hard-link record is needed (neither is a git dir file).
  const repo2 = mkRepo(sb, 'two-secret-names', { 'src/a.py': 'x = 1\n' });
  fs.writeFileSync(path.join(repo2, '.env'), 'TOKEN=SYNTH\n');
  fs.linkSync(path.join(repo2, '.env'), path.join(repo2, 'prod.env'));
  const scan2 = scanOf(repo2);
  assert.equal(scan2.status, 0, scan2.stderr);
  assert.deepEqual(symlinkRecords(scan2.stdout), [], `two secret names of one ordinary file need no hard-link record:\n${scan2.stdout}`);
  assert.ok(scan2.stdout.includes('SENSITIVE .env') && scan2.stdout.includes('SENSITIVE prod.env'), scan2.stdout);
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
