'use strict';

// Exercise the shipped gate publication and both Merge Bot evidence guards.
// A green helper-only decision test would have missed the former inline bypass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decideCodexGate, signalTargetsHead } = require('../tools/codex_gate_logic');
const { evaluateMergePolicy, isTrustedSync } = require('../tools/merge_bot_logic');
const { reviewEvidenceProvenance } = require('../tools/review_evidence');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ROOT = path.resolve(__dirname, '..');
const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const REPO = 'funzi7/example';
const read = (name) => fs.readFileSync(path.join(ROOT, 'workflows', name), 'utf8');
const sync = (labels = []) => ({
  number: 7, state: 'open', draft: false, mergeable: true,
  title: 'chore(automation): sync from automation-core',
  user: { login: 'funzi7' }, labels: labels.map((name) => ({ name })),
  head: { ref: 'chore/sync-automation-core', sha: HEAD, repo: { full_name: REPO } },
  base: { ref: 'main', repo: { full_name: REPO, default_branch: 'main' } },
});

function gatePublisher() {
  const workflow = read('codex-gate.yml');
  const start = workflow.indexOf("                if (gateDecision.status === 'blocked') {");
  const end = workflow.indexOf('              } catch (err) {', start);
  assert.ok(start >= 0 && end > start);
  return new AsyncFunction('state', 'reviewEvidenceProvenance', `
    const { pr, headObservedAt, gateDecision, reviewAuthority } = state;
    const prNumber = pr.number, headSha = pr.head.sha, head7 = headSha.slice(0, 7);
    const fallbackEvidence = { accepted: false, reason: 'fallback_policy_disabled' };
    const FALLBACK_PROVIDER = 'claude_code_fallback';
    // These old-bypass inputs make the regression fail if its code reappears.
    const SYNC_GRACE_MINUTES = 30, codexSignalCount = 0;
    const isTrustedSync = () => true;
    const published = [], results = []; let anyBlocked = false;
    const publishGateCheck = async (...args) => published.push(args);
    for (const candidate of [pr]) { ${workflow.slice(start, end)} }
    return { published, results, anyBlocked };
  `);
}

async function publish({ ageMinutes = 90, review = null, nonInlineFindings = [], threads = [] } = {}) {
  const headObservedAt = new Date(Date.now() - ageMinutes * 60 * 1000);
  const currentHeadSignal = !!review && signalTargetsHead(review, HEAD, headObservedAt);
  const gateDecision = decideCodexGate({ currentHeadSignal, nonInlineFindings, threads });
  return gatePublisher()({
    pr: sync(), headObservedAt, gateDecision,
    reviewAuthority: currentHeadSignal ? 'codex' : 'none',
  }, reviewEvidenceProvenance);
}

test('shipped sync gate stays pending after 30 minutes, hours, or days with no review', async () => {
  for (const ageMinutes of [31, 90, 24 * 60, 7 * 24 * 60]) {
    const result = await publish({ ageMinutes });
    assert.equal(result.anyBlocked, true, `${ageMinutes} minutes`);
    assert.equal(result.published.length, 1);
    assert.equal(result.published[0][1], 'failure');
    assert.equal(result.published[0][2], '🟡 Waiting for Codex review');
  }
});

test('late valid exact-head review clears a waiting sync without a manual merge label', async () => {
  const result = await publish({ review: { commit_id: HEAD, body: 'No P1/P2 findings.', submitted_at: new Date().toISOString() } });
  assert.equal(result.anyBlocked, false);
  assert.equal(result.published[0][1], 'success');
  assert.match(result.published[0][3], /Codex exact-head review accepted/);
  const policy = evaluateMergePolicy({
    pr: sync(), repositoryFullName: REPO, currentHeadCodexSignal: true,
    checkRuns: ['ci', 'check-codex-status'].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  });
  assert.equal(policy.eligible, true);
  assert.deepEqual(sync().labels, []);
});

test('late old-head review and unbound no-findings text cannot clear the current sync head', async () => {
  for (const review of [
    { commit_id: OLD, body: 'No findings.', submitted_at: new Date().toISOString() },
    { body: `No findings.\n\n**Reviewed commit:** \`${OLD}\``, created_at: new Date().toISOString() },
    { body: 'No findings.', created_at: new Date().toISOString() },
  ]) {
    const result = await publish({ review });
    assert.equal(result.anyBlocked, true);
    assert.equal(result.published[0][1], 'failure');
  }
});

test('sync age or clean signal cannot bypass an active finding', async () => {
  const result = await publish({
    ageMinutes: 7 * 24 * 60,
    review: { commit_id: HEAD, body: 'Clean' },
    nonInlineFindings: [{ severity: 'P1', path: 'workflows/example.yml', line: 42 }],
  });
  assert.equal(result.anyBlocked, true);
  assert.equal(result.published[0][2], '🔴 Active Codex P1/P2 finding');
});

test('Merge Bot rejects stale grace-green checks without review and preserves the explicit override', () => {
  const base = {
    pr: sync(), repositoryFullName: REPO, currentHeadCodexSignal: false,
    checkRuns: ['ci', 'check-codex-status'].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  };
  assert.equal(isTrustedSync(base.pr, REPO), true);
  assert.equal(evaluateMergePolicy(base).reason, 'current_head_review_pending');
  assert.equal(evaluateMergePolicy({ ...base, pr: sync(['codex-p1-acknowledged']) }).eligible, true);
  assert.equal(evaluateMergePolicy({ ...base, currentHeadCodexSignal: true, activeTrustedFinding: true }).reason, 'active_trusted_finding');
  assert.equal(evaluateMergePolicy({ ...base, currentHeadCodexSignal: true, currentHead: OLD }).reason, 'head_moved');
});

function mergeGuard(final) {
  const workflow = read('merge-bot.yml');
  const start = workflow.indexOf(final
    ? '              if (!finalLabels.has(CODEX_OVERRIDE_LABEL)'
    : "              let reviewEvidence = { accepted: true, authority: 'none'");
  const end = workflow.indexOf(final
    ? '              if (\n                !finalLabels.has(CODEX_OVERRIDE_LABEL) &&\n                await hasActiveTrustedBlocker'
    : '              // The authoritative current review-thread state', start);
  assert.ok(start >= 0 && end > start, 'must execute the shipped evidence guard');
  return new AsyncFunction('evidence', 'labels', `
    const pr = ${JSON.stringify(sync())}, finalPr = pr, prNumber = pr.number, headSha = pr.head.sha;
    const initialLabels = new Set(labels), finalLabels = new Set(labels);
    const CODEX_OVERRIDE_LABEL = 'codex-p1-acknowledged';
    const isTrustedSync = () => true;
    const core = { info() {} }; let calls = 0, proceeds = false;
    const hasCurrentHeadReviewEvidence = async () => { calls++; return evidence; };
    ${final ? 'let reviewEvidence;' : ''}
    for (const candidate of [pr]) { ${workflow.slice(start, end)} proceeds = true; }
    return { calls, proceeds };
  `);
}

test('both shipped Merge Bot boundaries independently require sync review evidence', async () => {
  for (const final of [false, true]) {
    const guard = mergeGuard(final);
    assert.deepEqual(await guard({ accepted: false, blocking: false, reason: 'current_head_review_pending' }, []), { calls: 1, proceeds: false });
    assert.deepEqual(await guard({ accepted: true, blocking: false, authority: 'codex' }, []), { calls: 1, proceeds: true });
    assert.deepEqual(await guard({ accepted: true, blocking: false, authority: 'claude_code_fallback' }, []), { calls: 1, proceeds: true });
    assert.deepEqual(await guard({ accepted: true, blocking: true }, []), { calls: 1, proceeds: false });
    assert.deepEqual(await guard({ accepted: false }, ['codex-p1-acknowledged']), { calls: 0, proceeds: true });
  }
});

test('timer-only sync clearing/redispatch is removed from shipped source and mirrors', () => {
  for (const name of ['codex-gate.yml', 'merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    const workflow = read(name);
    assert.doesNotMatch(workflow, /SYNC_GRACE_MINUTES|silentTrustedSync|silentSyncStale|grace-eligible/);
    assert.equal(workflow, fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8'));
  }
  const watchdog = read('claude-fallback-watchdog.yml');
  assert.match(watchdog, /const freshSignal = codexSignalOnHead \|\| fallbackDispatchNeeded/);
  assert.match(watchdog, /!freshSignal &&\s*!overrideCandidate && !redThreadStateChanged &&\s*!greenHeadNewFinding/);
});
