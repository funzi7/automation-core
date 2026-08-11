'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isAutoMergeCandidate,
  evaluateMergePolicy,
} = require('../tools/merge_bot_logic');

const REPOSITORY = 'funzi7/example';
const HEAD = 'a'.repeat(40);

function pr(overrides = {}) {
  const base = {
    number: 7,
    state: 'open',
    draft: false,
    mergeable: true,
    title: 'fix: ordinary development change',
    user: { login: 'funzi7' },
    labels: [],
    head: {
      sha: HEAD,
      ref: 'fix/ordinary-development-change',
      repo: { full_name: REPOSITORY },
    },
    base: { ref: 'main', repo: { full_name: REPOSITORY } },
  };
  return {
    ...base,
    ...overrides,
    user: overrides.user || base.user,
    labels: overrides.labels || base.labels,
    head: { ...base.head, ...(overrides.head || {}) },
    base: { ...base.base, ...(overrides.base || {}) },
  };
}

function check(name, conclusion = 'success', status = 'completed', minute = 1) {
  return {
    name,
    conclusion,
    status,
    started_at: `2026-08-11T00:0${minute}:00Z`,
    completed_at: status === 'completed' ? `2026-08-11T00:0${minute}:30Z` : null,
  };
}

function greenChecks() {
  return [
    check('ci'),
    check('check-codex-status', 'success', 'completed', 2),
  ];
}

function decide(overrides = {}) {
  return evaluateMergePolicy({
    pr: pr(),
    repositoryFullName: REPOSITORY,
    checkRuns: greenChecks(),
    statuses: [],
    evaluatedHead: HEAD,
    currentHead: HEAD,
    ...overrides,
  });
}

test('normal same-repo owner fix PR with exact-head green is eligible', () => {
  assert.equal(decide().eligible, true);
});

test('one running current check blocks merge', () => {
  const result = decide({ checkRuns: [...greenChecks(), check('lint', null, 'in_progress', 3)] });
  assert.equal(result.reason, 'running_check');
});

test('one failed current check blocks merge', () => {
  const result = decide({ checkRuns: [...greenChecks(), check('lint', 'failure', 'completed', 3)] });
  assert.equal(result.reason, 'failed_check');
});

test('latest run per check name wins over stale failure', () => {
  const result = decide({
    checkRuns: [
      check('ci', 'failure', 'completed', 1),
      check('ci', 'success', 'completed', 3),
      check('check-codex-status', 'success', 'completed', 2),
    ],
  });
  assert.equal(result.eligible, true);
});

test('cancelled tail is ignored but cannot substitute for a missing gate', () => {
  assert.equal(decide({
    checkRuns: [
      check('ci'),
      check('check-codex-status', 'success', 'completed', 2),
      check('check-codex-status', 'cancelled', 'completed', 3),
    ],
  }).eligible, true);
  assert.equal(decide({
    checkRuns: [
      check('ci'),
      check('check-codex-status', 'cancelled', 'completed', 3),
    ],
  }).reason, 'missing_or_red_codex_gate');
});

test('missing authoritative Codex gate blocks merge', () => {
  const result = decide({ checkRuns: [check('ci')] });
  assert.equal(result.reason, 'missing_or_red_codex_gate');
});

test('red Codex gate or active trusted P1/P2 blocks merge', () => {
  assert.equal(
    decide({ checkRuns: [check('ci'), check('check-codex-status', 'failure', 'completed', 2)] }).reason,
    'failed_check',
  );
  assert.equal(decide({ activeTrustedFinding: true }).reason, 'active_trusted_finding');
});

test('head SHA movement after validation blocks merge', () => {
  assert.equal(decide({ currentHead: 'b'.repeat(40) }).reason, 'head_moved');
});

test('fork PR gets no implicit owner, title, or branch trust', () => {
  const fork = pr({
    title: 'chore(automation): sync from automation-core',
    head: { ref: 'claude/looks-trusted', repo: { full_name: 'attacker/fork' } },
    user: { login: 'someone' },
  });
  assert.equal(isAutoMergeCandidate(fork, REPOSITORY), false);
});

test('no-automerge is a permanent hard stop', () => {
  const stopped = pr({ labels: [{ name: 'no-automerge' }] });
  assert.equal(isAutoMergeCandidate(stopped, REPOSITORY), false);
});

test('human or unknown needs-owner is a hard stop', () => {
  const result = decide({ pr: pr({ labels: [{ name: 'needs-owner' }] }) });
  assert.equal(result.reason, 'manual_needs_owner');
});

test('automated needs-owner remains while the current head is red', () => {
  const result = decide({
    pr: pr({ labels: [{ name: 'needs-owner' }, { name: 'needs-owner-auto' }] }),
    checkRuns: [check('check-codex-status', 'failure')],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.clearTransient, undefined);
});

test('automated needs-owner clears only when exact current head is fully green', () => {
  const result = decide({
    pr: pr({ labels: [{ name: 'needs-owner' }, { name: 'needs-owner-auto' }] }),
  });
  assert.equal(result.eligible, true);
  assert.equal(result.clearTransient, true);
});

test('legacy needs-owner requires proven automation provenance', () => {
  const legacyPr = pr({ labels: [{ name: 'needs-owner' }] });
  assert.equal(decide({ pr: legacyPr }).eligible, false);
  const proven = decide({ pr: legacyPr, legacyAutomationProven: true });
  assert.equal(proven.eligible, true);
  assert.equal(proven.clearLegacy, true);
});

test('protected-path trusted owner PR may merge after full review', () => {
  assert.equal(decide({ protectedPathHit: true }).eligible, true);
});

test('protected-path fork or untrusted PR remains escalated', () => {
  const fork = pr({
    labels: [{ name: 'automerge' }],
    user: { login: 'someone' },
    head: { repo: { full_name: 'someone/fork' } },
  });
  const result = decide({ pr: fork, protectedPathHit: true });
  assert.equal(result.reason, 'protected_path_untrusted');
});

test('trusted same-repo automation-core sync behavior remains eligible', () => {
  const sync = pr({
    title: 'chore(automation): sync from automation-core',
    head: { ref: 'chore/sync-automation-core' },
  });
  assert.equal(decide({ pr: sync }).eligible, true);
});

test('workflow preserves exact-SHA squash merge and same-repo branch deletion', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'merge-bot.yml'),
    'utf8',
  );
  assert.match(workflow, /merge_method: 'squash', sha: headSha/);
  assert.match(workflow, /finalPr\.head\.sha !== headSha/);
  assert.match(workflow, /pr\.head\.repo\.full_name === `\$\{owner\}\/\$\{repo\}`/);
  assert.match(workflow, /await github\.rest\.git\.deleteRef/);
  assert.match(workflow, /unexpected evaluation error; skipping only this PR/);
});

test('only synced automation infrastructure is in the central allow-list', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'sync-config.json'),
    'utf8',
  ));
  assert.deepEqual(config.synced_workflows, [
    'codex-auto-fix.yml',
    'codex-gate.yml',
    'claude.yml',
    'ci-doctor.yml',
    'merge-bot.yml',
    'claude-fallback-watchdog.yml',
    'codex-backup-fix.yml',
  ]);
  assert.equal(config.synced_workflows.some((name) => /poll|backfill|health/.test(name)), false);
});

test('only temporary PR automation writers add needs-owner-auto', () => {
  const read = (name) => fs.readFileSync(
    path.join(__dirname, '..', 'workflows', name),
    'utf8',
  );
  assert.match(read('codex-auto-fix.yml'), /needs-owner-auto/);
  assert.match(read('claude-fallback-watchdog.yml'), /needs-owner-auto/);
  assert.doesNotMatch(read('claude.yml'), /needs-owner-auto/);
  assert.doesNotMatch(read('codex-backup-fix.yml'), /needs-owner-auto/);
  assert.doesNotMatch(read('ci-doctor.yml'), /needs-owner-auto/);
});
