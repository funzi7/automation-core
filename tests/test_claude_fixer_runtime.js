'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const runtime = require('../tools/claude_fixer_runtime');
const ROOT = path.resolve(__dirname, '..');
const SHA = 'a'.repeat(40);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'example.txt'), 'before\n');
  return root;
}
function plan(files) { return { summary: 'minimal fix', files }; }
function githubFixture(target = { number: 4, state: 'open', labels: [] }) {
  const calls = [];
  const github = { rest: {
    issues: { get: async () => ({ data: target }), listComments: () => {} },
    pulls: { get: async () => ({ data: { ...target, head: { ref: 'claude/issue-4-123-2', repo: { full_name: 'owner/repo' } } } }) },
    git: { createRef: async (args) => { calls.push(['branch', args]); } },
  }, paginate: async () => [], graphql: async (query, args) => {
    calls.push(['commit', query, args]);
    return { createCommitOnBranch: { commit: { oid: 'b'.repeat(40), signature: { isValid: true, wasSignedByGitHub: true } } } };
  } };
  return { github, calls, core: { info() {}, setOutput: (...args) => calls.push(['output', ...args]) },
    context: { repo: { owner: 'owner', repo: 'repo' }, payload: { issue: { number: 4 } } } };
}

test('pause accepts exact labels and draft/closed only, keeping merge pause distinct', () => {
  for (const label of ['no-autofix', 'review-only']) assert.equal(runtime.paused({ state: 'open', labels: [{ name: label }] }), true);
  assert.equal(runtime.paused({ state: 'open', draft: true, labels: [] }), true);
  assert.equal(runtime.paused({ state: 'closed', labels: [] }), true);
  for (const label of ['no-automerge', 'my-no-autofix', 'automerge']) assert.equal(runtime.paused({ state: 'open', labels: [{ name: label }] }), false);
  assert.throws(() => runtime.paused({ state: 'open' }), /labels unavailable/);
});

test('budget has a bounded estimated stopping threshold, not unlimited/NaN', () => {
  assert.equal(runtime.budget(''), '2');
  assert.equal(runtime.budget('0.1'), '0.1');
  assert.equal(runtime.budget('10'), '10');
  for (const value of ['0', '-1', 'Infinity', 'NaN', '11', 'not-money']) assert.throws(() => runtime.budget(value));
});

test('Issue environment excludes action attribution, routing, OAuth and GitHub credentials', () => {
  const source = { ANTHROPIC_API_KEY: 'fake-key', GH_TOKEN: 'fake-pat', GITHUB_TOKEN: 'fake-token',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-oidc', CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth',
    CLAUDE_CODE_ENTRYPOINT: 'github-action', ANTHROPIC_BASE_URL: 'https://untrusted.invalid',
    ANTHROPIC_AUTH_TOKEN: 'fake-auth', CLAUDE_CODE_USE_BEDROCK: '1', NODE_OPTIONS: '--require evil.js' };
  const env = runtime.modelEnvironment(source, '/isolated/home', 'issue');
  assert.equal(env.ANTHROPIC_API_KEY, 'fake-key');
  for (const key of Object.keys(source).filter((key) => key !== 'ANTHROPIC_API_KEY')) assert.equal(env[key], undefined, key);
  assert.equal(env.HOME, '/isolated/home');
  assert.equal(runtime.modelEnvironment(source, '/home', 'pr').GH_TOKEN, 'fake-pat');
});

test('CLI arguments lock config, tools, budget, turn count and persistence independently', () => {
  const issue = runtime.cliArgs('issue', '2');
  for (const arg of ['--bare', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(issue.includes(arg));
  assert.equal(issue[issue.indexOf('--setting-sources') + 1], '');
  assert.equal(issue[issue.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.equal(issue[issue.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(issue[issue.indexOf('--max-turns') + 1], '50');
  assert.ok(issue.includes('--json-schema'));
  assert.ok(!issue.join(' ').includes('Bash'));
  const pr = runtime.cliArgs('pr', '2');
  assert.ok(pr[pr.indexOf('--allowedTools') + 1].includes('Bash(pytest:*)'));
  assert.ok(!pr.includes('--dangerously-skip-permissions'));
  assert.throws(() => runtime.cliArgs('arbitrary', '2'));
});

test('constrained text edits normalize no-ops and reject traversal, duplicates and oversized plans', (t) => {
  const root = fixture(t);
  assert.deepEqual(runtime.validatePlan(plan([{ path: 'example.txt', content: 'before\n' }]), root), { additions: [], deletions: [] });
  const edits = runtime.validatePlan(plan([{ path: 'new/file.txt', content: 'after\n' }, { path: 'example.txt', content: null }]), root);
  assert.equal(Buffer.from(edits.additions[0].contents, 'base64').toString(), 'after\n');
  assert.deepEqual(edits.deletions, [{ path: 'example.txt' }]);
  for (const name of ['../escape', '/tmp/escape', '.git/config', 'x/.GiT/config', 'x\\escape', 'x//y', 'x/./y', 'x\ny']) assert.throws(() => runtime.validatePlan(plan([{ path: name, content: 'x' }]), root));
  assert.throws(() => runtime.validatePlan(plan([{ path: 'x', content: 'x' }, { path: 'x', content: null }]), root), /Duplicate/);
  assert.throws(() => runtime.validatePlan(plan([{ path: 'absent', content: null }]), root), /absent/);
  assert.throws(() => runtime.validatePlan(plan([{ path: 'x', content: 'a'.repeat(1024 * 1024 + 1) }]), root), /budget/);
  assert.throws(() => runtime.validatePlan(plan(Array.from({ length: 31 }, (_, i) => ({ path: `${i}`, content: 'x' }))), root));
  assert.throws(() => runtime.validatePlan(plan([{ path: 'x', content: 'x\0y' }]), root), /UTF-8/);
});

test('constrained edits reject symlinks including dangling targets and linked ancestors', (t) => {
  const root = fixture(t);
  fs.symlinkSync('/no-such-file', path.join(root, 'dangling'));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'linked-dir'));
  for (const name of ['dangling', 'linked-dir/new.txt']) assert.throws(() => runtime.validatePlan(plan([{ path: name, content: 'x' }]), root), /Symlink/);
});

test('terminal parser accepts JSON/NDJSON but rejects missing or ambiguous result', () => {
  const result = { type: 'result', subtype: 'success', is_error: false };
  assert.deepEqual(runtime.terminalResult(JSON.stringify(result)), result);
  assert.deepEqual(runtime.terminalResult(`${JSON.stringify({ type: 'assistant' })}\n${JSON.stringify(result)}\n`), result);
  assert.throws(() => runtime.terminalResult('{}'));
  assert.throws(() => runtime.terminalResult('private-output-sentinel'), (error) => !error.message.includes('private-output-sentinel'));
  assert.throws(() => runtime.terminalResult(JSON.stringify([result, result])));
});

test('terminal completion rejects partial, deferred, refused, queued and error-shaped success', () => {
  const success = { type: 'result', subtype: 'success', is_error: false };
  assert.equal(runtime.completedResult(success), true);
  assert.equal(runtime.completedResult({ ...success, terminal_reason: 'completed', queued_turn_count: 0 }), true);
  for (const extra of [
    { is_error: undefined }, { is_error: true }, { subtype: 'error_max_turns' },
    { terminal_reason: 'aborted_tools' }, { terminal_reason: 'budget_exhausted' },
    { terminal_reason: 'tool_deferred' }, { terminal_reason: 'unknown' },
    { stop_reason: 'refusal' }, { deferred_tool_use: {} }, { queued_turn_count: 1 },
  ]) assert.equal(runtime.completedResult({ ...success, ...extra }), false, JSON.stringify(extra));
});

test('bounded context preserves inline coordinates and relevant discussion without executable interpolation', () => {
  const comment = { id: 9, user: { login: 'owner' }, body: '@claude fix this', path: 'src/a.js', line: 42, diff_hunk: 'untrusted diff', in_reply_to_id: 8 };
  const discussion = Array.from({ length: 50 }, (_, index) => ({ id: index, created_at: new Date(index * 1000).toISOString(), user: { login: 'reviewer' }, body: 'a'.repeat(6000) }));
  const context = runtime.buildContext({ comment }, 'pull_request_review_comment', { number: 4, title: 'PR', body: 'description' }, discussion);
  assert.equal(context.owner_request.path, 'src/a.js');
  assert.equal(context.owner_request.line, 42);
  assert.equal(context.owner_request.in_reply_to_id, 8);
  assert.equal(context.recent_discussion[0].id, 49);
  assert.ok(context.recent_discussion.reduce((sum, item) => sum + item.body.length, 0) <= 24000);
  assert.equal(context.discussion_truncated, true);
});

test('live guard fails closed on API failure and covers source Issue / linked paused PR', async () => {
  const f = githubFixture();
  assert.equal(await runtime.guardTarget(f), true);
  f.github.rest.issues.get = async () => { throw new Error('403'); };
  await assert.rejects(runtime.guardTarget(f), /403/);
  const linked = githubFixture();
  linked.github.paginate = async () => [{ user: { login: 'github-actions[bot]' }, body: '<!-- claude-pr-provenance:v1 issue=4 pr=12 -->' }];
  linked.github.rest.pulls.get = async () => ({ data: { state: 'open', labels: [{ name: 'claude-generated' }, { name: 'no-autofix' }], head: { ref: 'claude/issue-4-1-1', repo: { full_name: 'owner/repo' } } } });
  assert.equal(await runtime.guardTarget(linked), false);
  linked.github.paginate = async () => [{ user: { login: 'attacker' }, body: '<!-- claude-pr-provenance:v1 issue=4 pr=12 -->' }];
  assert.equal(await runtime.guardTarget(linked), true);
});

test('trusted publisher uses signed API with exact expected head; paused or invalid plans cannot mutate', async (t) => {
  const root = fixture(t);
  const oldId = process.env.GITHUB_RUN_ID, oldAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ID = '123'; process.env.GITHUB_RUN_ATTEMPT = '2';
  t.after(() => { if (oldId === undefined) delete process.env.GITHUB_RUN_ID; else process.env.GITHUB_RUN_ID = oldId; if (oldAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT; else process.env.GITHUB_RUN_ATTEMPT = oldAttempt; });
  const args = { branch: 'claude/issue-4-123-2', base: SHA, plan: plan([{ path: 'example.txt', content: 'after\n' }]), root };
  const f = githubFixture();
  await runtime.publishIssue({ ...f, ...args });
  assert.equal(f.calls[0][1].ref, 'refs/heads/claude/issue-4-123-2');
  assert.match(f.calls[1][1], /createCommitOnBranch/);
  assert.equal(f.calls[1][2].input.expectedHeadOid, SHA);
  assert.equal(f.calls[2][1], 'delivered_sha');
  const paused = githubFixture({ state: 'open', labels: [{ name: 'review-only' }] });
  await runtime.publishIssue({ ...paused, ...args });
  assert.deepEqual(paused.calls, []);
  await assert.rejects(runtime.publishIssue({ ...f, ...args, branch: 'main' }));
  const unsigned = githubFixture(); unsigned.github.graphql = async () => ({ createCommitOnBranch: { commit: { oid: SHA, signature: { isValid: false } } } });
  await assert.rejects(runtime.publishIssue({ ...unsigned, ...args }), /signed delivery/);
  const raced = githubFixture(); raced.github.graphql = async () => { throw new Error('expectedHeadOid mismatch'); };
  await assert.rejects(runtime.publishIssue({ ...raced, ...args }), /expectedHeadOid/);
});

test('offline end-to-end Issue run uses fake CLI, isolated snapshot and structured plan only', (t) => {
  const temp = fixture(t), repo = path.join(temp, 'repo'); fs.mkdirSync(repo);
  cp.execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'example.txt'), 'before\n');
  cp.execFileSync('git', ['add', '.'], { cwd: repo });
  cp.execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: repo });
  const base = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const bin = path.join(temp, 'claude-cli/node_modules/.bin'); fs.mkdirSync(bin, { recursive: true });
  const capture = path.join(temp, 'capture.json');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\nif(process.argv.includes('--version')) { console.log('2.1.288 (Claude Code)'); } else { require('fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),env:process.env,cwd:process.cwd()})); console.log(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: plan([{ path: 'example.txt', content: 'after\n' }]) }))}); }\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(temp, 'claude-context.json'), JSON.stringify({ number: 4, title: 'Issue fixture' }));
  const output = path.join(temp, 'github-output');
  runtime.run({ FIXER_MODE: 'issue', ANTHROPIC_API_KEY: 'fake-key-no-network', GH_TOKEN: 'must-not-inherit', GITHUB_WORKSPACE: repo,
    RUNNER_TEMP: temp, ISSUE_BASE_SHA: base, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_OUTPUT: output });
  const captured = JSON.parse(fs.readFileSync(capture));
  assert.notEqual(captured.cwd, repo);
  assert.ok(!fs.existsSync(path.join(captured.cwd, '.git')));
  assert.equal(captured.env.GH_TOKEN, undefined);
  assert.equal(captured.env.GITHUB_OUTPUT, undefined);
  assert.equal(fs.readFileSync(path.join(repo, 'example.txt'), 'utf8'), 'before\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'claude-edit-plan.json'))).files[0].content, 'after\n');
  assert.match(fs.readFileSync(output, 'utf8'), /branch_name=claude\/issue-4-123-2/);
});

test('workflow contract embeds helper, remains opt-in, gates paid calls and preserves review-only semantics', () => {
  cp.execFileSync('python3', ['scripts/embed_claude_runtime.py', '--check'], { cwd: ROOT });
  const read = (name) => fs.readFileSync(path.join(ROOT, 'workflows', name), 'utf8');
  const claude = read('claude.yml'), bridge = read('codex-auto-fix.yml');
  assert.doesNotMatch(claude, /uses: anthropics\/claude-code-action/);
  assert.match(claude, /vars\.CLAUDE_STANDALONE_ENABLED == 'true'/);
  assert.match(bridge, /vars\.CLAUDE_STANDALONE_ENABLED == 'true'/);
  assert.match(claude, /@anthropic-ai\/claude-code@2\.1\.288/);
  assert.match(claude, /install\.cjs/);
  assert.match(claude, /if: steps\.issue_start\.outputs\.allowed == 'true'/);
  assert.match(claude, /if: steps\.pr_start\.outputs\.allowed == 'true'/);
  assert.doesNotMatch(claude, /id-token: write/);
  assert.match(bridge, /livePr\.head\.sha !== process\.env\.TARGET_HEAD/);
  assert.match(bridge, /Live PR\/pause check failed; refusing to trigger/);
  assert.match(read('claude-fallback-watchdog.yml'), /if \(!fixPaused && loopPr/);
  assert.match(read('claude-fallback-watchdog.yml'), /process\.env\.CLAUDE_STANDALONE_ENABLED === 'true' && process\.env\.CLAUDE_ENABLED !== 'false'/);
  const provenance = claude.slice(claude.indexOf('Record Claude PR provenance'));
  assert.match(provenance, /Always record durable provenance/);
  assert.doesNotMatch(provenance, /if \(!await runtime\.guardTarget/);
  assert.match(claude, /Signed Issue head moved before PR delivery/);
  assert.match(read('codex-backup-fix.yml'), /const stale = fixPaused \|\| pr\.head\.sha !== inputSha/);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'sync-config.json')));
  assert.ok(config.synced_workflows.includes('claude.yml'));
});
