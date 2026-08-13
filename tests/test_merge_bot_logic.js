'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isAutoMergeCandidate,
  evaluateMergePolicy,
  companionAutomationProvenance,
  legacyAutomationProvenance,
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

test('diagnostic evaluator failure is ignored but authoritative gate remains mandatory', () => {
  assert.equal(decide({
    checkRuns: [...greenChecks(), check('codex-gate-evaluator', 'failure', 'completed', 3)],
  }).eligible, true);
  assert.equal(decide({
    checkRuns: [check('ci'), check('codex-gate-evaluator', 'success', 'completed', 3)],
  }).reason, 'missing_or_red_codex_gate');
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

test('administrator Codex override preserves the established escape hatch', () => {
  const overridden = pr({ labels: [{ name: 'codex-p1-acknowledged' }] });
  assert.equal(decide({ pr: overridden, activeTrustedFinding: true }).eligible, true);
});

test('removing an override cannot reuse its green check without current-head review', () => {
  assert.equal(decide({ currentHeadCodexSignal: false }).reason, 'current_head_review_pending');
  const overridden = pr({ labels: [{ name: 'codex-p1-acknowledged' }] });
  assert.equal(decide({ pr: overridden, currentHeadCodexSignal: false }).eligible, true);
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
    companionAutomationProven: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.clearTransient, undefined);
});

test('automated needs-owner clears only when exact current head is fully green', () => {
  const result = decide({
    pr: pr({ labels: [{ name: 'needs-owner' }, { name: 'needs-owner-auto' }] }),
    companionAutomationProven: true,
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

test('legacy github-actions label requires positive circuit-breaker evidence', () => {
  const event = {
    id: 1,
    event: 'labeled',
    label: { name: 'needs-owner' },
    actor: { login: 'github-actions[bot]' },
    created_at: '2026-08-11T20:00:00Z',
  };
  assert.equal(legacyAutomationProvenance([event], []), false);
  const comments = [1, 2, 3].map((attempt) => ({
    user: { login: 'funzi7' },
    created_at: `2026-08-11T19:0${attempt}:00Z`,
    body: `<!-- ai-loop:v1 root_pr=7 head=${HEAD} attempt=${attempt} agent=claude state=requested -->\n[auto-triggered]`,
  }));
  assert.equal(legacyAutomationProvenance(
    [event], comments, { prNumber: 7, commitShas: [HEAD], currentHead: HEAD },
  ), true);
});

test('companion provenance rejects an orphan before a later manual hold', () => {
  const events = [
    {
      id: 10, event: 'labeled', label: { name: 'needs-owner-auto' },
      actor: { login: 'github-actions[bot]' }, created_at: '2026-08-11T20:00:00Z',
    },
    {
      id: 11, event: 'labeled', label: { name: 'needs-owner' },
      actor: { login: 'funzi7' }, created_at: '2026-08-11T20:10:00Z',
    },
  ];
  assert.equal(companionAutomationProvenance(events), false);
  events.push({
    id: 12, event: 'labeled', label: { name: 'needs-owner-auto' },
    actor: { login: 'github-actions[bot]' }, created_at: '2026-08-11T20:10:01Z',
  });
  assert.equal(companionAutomationProvenance(events), false);
  events.push(
    {
      id: 13, event: 'unlabeled', label: { name: 'needs-owner' },
      actor: { login: 'funzi7' }, created_at: '2026-08-11T20:11:00Z',
    },
    {
      id: 14, event: 'labeled', label: { name: 'needs-owner' },
      actor: { login: 'github-actions[bot]' }, created_at: '2026-08-11T20:12:00Z',
    },
    {
      id: 15, event: 'labeled', label: { name: 'needs-owner-auto' },
      actor: { login: 'github-actions[bot]' }, created_at: '2026-08-11T20:12:01Z',
    },
  );
  assert.equal(companionAutomationProvenance(events), true);
});

test('legacy PAT-owner label needs a nearby watchdog marker', () => {
  const event = {
    id: 2,
    event: 'labeled',
    label: { name: 'needs-owner' },
    actor: { login: 'funzi7' },
    created_at: '2026-08-11T20:00:00Z',
  };
  assert.equal(legacyAutomationProvenance([event], []), false);
  assert.equal(legacyAutomationProvenance([event], [{
    user: { login: 'funzi7' },
    created_at: '2026-08-11T20:00:02Z',
    body: `<!-- ai-loop:v1 root_pr=7 head=${HEAD} agent=watchdog state=escalated -->`,
  }], { prNumber: 7, commitShas: [HEAD], currentHead: HEAD }), true);
});

test('watchdog marker must have trusted author and matching PR head', () => {
  const event = {
    id: 20, event: 'labeled', label: { name: 'needs-owner' },
    actor: { login: 'funzi7' }, created_at: '2026-08-11T20:00:00Z',
  };
  const marker = (user, root, head) => ({
    user: { login: user }, created_at: '2026-08-11T20:00:01Z',
    body: `<!-- ai-loop:v1 root_pr=${root} head=${head} agent=watchdog state=escalated -->`,
  });
  assert.equal(legacyAutomationProvenance(
    [event], [marker('attacker', 7, HEAD)], { prNumber: 7, commitShas: [HEAD], currentHead: HEAD },
  ), false);
  assert.equal(legacyAutomationProvenance(
    [event], [marker('funzi7', 8, HEAD)], { prNumber: 7, commitShas: [HEAD], currentHead: HEAD },
  ), false);
  assert.equal(legacyAutomationProvenance(
    [event], [marker('funzi7', 7, 'b'.repeat(40))], { prNumber: 7, commitShas: [HEAD], currentHead: HEAD },
  ), false);
  assert.equal(legacyAutomationProvenance(
    [event], [marker('funzi7', 7, 'b'.repeat(40))],
    { prNumber: 7, commitShas: [HEAD, 'b'.repeat(40)], currentHead: HEAD },
  ), false);
});

test('protected-path evidence keeps legacy automation label fail-closed', () => {
  assert.equal(legacyAutomationProvenance([{
    id: 3,
    event: 'labeled',
    label: { name: 'needs-owner' },
    actor: { login: 'github-actions[bot]' },
    created_at: '2026-08-11T20:00:00Z',
  }], [{
    created_at: '2026-08-11T20:00:01Z',
    body: 'Auto-merge blocked: this PR touches protected path(s)',
  }]), false);
});

test('protected-path trusted owner PR may merge after full review', () => {
  assert.equal(decide({ protectedPathHit: true }).eligible, true);
});

test('protected-path PAT-owner Claude PR remains escalated', () => {
  const claude = pr({
    title: 'chore(automation): sync from automation-core',
    head: { ref: 'claude/fix-sensitive-workflow' },
    labels: [{ name: 'automerge' }],
  });
  assert.equal(isAutoMergeCandidate(claude, REPOSITORY), true);
  assert.equal(
    decide({ pr: claude, protectedPathHit: true }).reason,
    'protected_path_untrusted',
  );
});

test('failed Claude delivery is not a candidate without success-only automerge', () => {
  const failedClaude = pr({
    head: { ref: 'claude/partial-fix' },
    labels: [{ name: 'claude-generated' }],
  });
  assert.equal(isAutoMergeCandidate(failedClaude, REPOSITORY), false);
  assert.equal(decide({ pr: failedClaude }).reason, 'not_candidate');
  const deliveredClaude = pr({
    head: { ref: 'claude/delivered-fix' },
    labels: [{ name: 'claude-generated' }, { name: 'automerge' }],
  });
  assert.equal(isAutoMergeCandidate(deliveredClaude, REPOSITORY), true);
});

test('durable Claude provenance blocks protected arbitrary owner branch', () => {
  const arbitrary = pr({ head: { ref: 'fix/claude-chose-this-name' } });
  assert.equal(decide({ pr: arbitrary, protectedPathHit: true }).eligible, true);
  assert.equal(
    decide({
      pr: arbitrary,
      protectedPathHit: true,
      claudeAutomationProven: true,
    }).reason,
    'protected_path_untrusted',
  );
  const labeled = pr({
    head: { ref: 'fix/another-name' },
    labels: [{ name: 'claude-generated' }],
  });
  assert.equal(
    decide({ pr: labeled, protectedPathHit: true }).reason,
    'not_candidate',
  );
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
  assert.equal(decide({ pr: sync, protectedPathHit: true }).eligible, true);
  assert.equal(
    decide({
      pr: sync,
      protectedPathHit: true,
      claudeAutomationProven: true,
    }).reason,
    'protected_path_untrusted',
  );
});

test('sync title alone cannot grant trusted protected-path provenance', () => {
  const spoof = pr({
    title: 'chore(automation): sync from automation-core',
    user: { login: 'github-actions[bot]' },
    labels: [{ name: 'automerge' }],
    head: { ref: 'fix/not-the-sync-branch' },
  });
  assert.equal(
    decide({ pr: spoof, protectedPathHit: true }).reason,
    'protected_path_untrusted',
  );
  const claudeSpoof = pr({
    title: 'chore(automation): sync from automation-core',
    head: { ref: 'claude/not-the-sync-branch' },
  });
  assert.equal(
    decide({ pr: claudeSpoof, protectedPathHit: true }).reason,
    'not_candidate',
  );
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
  assert.match(workflow, /hasCurrentHeadNonInlineFinding/);
  assert.match(workflow, /hasActiveTrustedBlocker/);
  assert.match(workflow, /isClaudeAutomationPr/);
  assert.match(workflow, /hasClaudeAutomationProvenance/);
  assert.match(workflow, /!\(await mayAutoMergeProtectedPaths\(pr\)\)/);
  assert.match(workflow, /event\.actor\?\.login === 'github-actions\[bot\]'/);
  assert.match(workflow, /workflows: \["Codex Gate", "CI", "Automation Core CI"\]/);
  assert.match(workflow, /const trustedLoopMarker = \(comment\) =>/);
  assert.match(workflow, /Number\(root\[1\]\) !== prNumber/);
  assert.match(workflow, /!commitShas\.has\(head\[1\]\)/);
  assert.match(workflow, /marker\.head === currentHead/);
  assert.match(workflow, /async function hasCurrentHeadCodexSignal\(prNumber, headSha\)/);
  assert.match(workflow, /async function observedHeadTransition\(prNumber, headSha, comments = \[\]\)/);
  assert.match(workflow, /codex-head-epoch:v3/);
  assert.match(workflow, /const head = markerHead/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/codex-gate\.yml'/);
  assert.match(workflow, /run\.event !== 'pull_request_target'/);
  assert.match(workflow, /Number\(run\.run_attempt\) !== attempt \|\| !belongsToPr \|\| !commentInsideRun/);
  assert.match(workflow, /const head = markerHead/);
  assert.match(workflow, /const MAX_EPOCH_MARKER_CANDIDATES = 16/);
  assert.match(workflow, /const refsByRun = new Map\(\)/);
  assert.match(workflow, /refsByRun\.set\(ref\.runId, ref\)/);
  assert.match(workflow, /\.sort\(\(a, b\) => b\.runId - a\.runId\)\s*\.slice\(0, MAX_EPOCH_MARKER_CANDIDATES\)/);
  assert.doesNotMatch(workflow, /accepted\.has\(/);
  assert.match(workflow, /roPage\(`https:\/\/api\.github\.com\/repos\/\$\{owner\}\/\$\{repo\}\/actions\/runs\/\$\{runId\}\/attempts\/\$\{attempt\}`\)/);
  assert.match(workflow, /return markers\.sort\(\(a, b\) =>\s*b\.observedAt - a\.observedAt \|\| b\.id - a\.id\)/);
  assert.doesNotMatch(workflow, /refs\.sort\(/);
  assert.doesNotMatch(workflow, /if \(head !== exactHead\) break/);
  assert.match(workflow, /NON_BLOCKING_DIAGNOSTIC_CHECKS = new Set\(\['codex-gate-evaluator'\]\)/);
  assert.match(workflow, /\.filter\(\(c\) => !NON_BLOCKING_DIAGNOSTIC_CHECKS\.has\(c\.name\)\)/);
  assert.match(workflow, /let prWorkflowRunsPromise = null/);
  assert.match(workflow, /const \[markers, runs\] = await Promise\.all/);
  assert.match(workflow, /return markerEpoch \|\| runEpoch/);
  assert.match(workflow, /runEvidence\.hasBoundary/);
  assert.match(workflow, /function signalTargetsHead\(item, headSha, headObservedAt/);
  assert.doesNotMatch(workflow, /latestCommitDate/);
  assert.match(workflow, /override absent and current-head Codex signal missing/);
  assert.match(workflow, /needsEvent\.actor\?\.login === 'github-actions\[bot\]'/);
  assert.match(workflow, /autoEvent\.actor\?\.login === 'github-actions\[bot\]'/);
  assert.match(workflow, /GH_LABEL_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /async function actionLabelRequest\(method, path, body\)/);
});

test('merge-failure restoration preserves a concurrently added manual stop', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'merge-bot.yml'),
    'utf8',
  );
  assert.match(workflow, /async function restoreTransientIfOpen\(prNumber\)/);
  assert.match(workflow, /const currentLabels = labelNames\(current\)/);
  assert.match(workflow, /if \(currentLabels\.has\(LABEL_ESCALATE\)\)/);
  assert.match(workflow, /name: LABEL_ESCALATE_AUTO/);
  assert.match(workflow, /currentProvenance = await escalationProvenance\(prNumber\)/);
  assert.match(workflow, /if \(currentProvenance\.companion\)/);
  assert.match(workflow, /original transient escalation is still intact/);
  assert.match(workflow, /could not classify live transient pair.*preserving both labels/);
  assert.match(workflow, /preserving it as a manual\/unknown hard stop/);
  assert.match(workflow, /partially completed clear can leave only the companion/);
  assert.match(workflow, /if \(currentLabels\.has\(LABEL_ESCALATE_AUTO\)\)/);
  assert.match(workflow, /const \{ data: beforeAdd \} = await github\.rest\.pulls\.get/);
  assert.match(workflow, /for \(const label of definitions\)/);
  assert.match(workflow, /\{ labels: \[label\.name\] \}/);
  assert.match(workflow, /const restoredProvenance = await escalationProvenance\(prNumber\)/);
  assert.match(workflow, /restored hard stop lacked exact bot provenance/);
  assert.doesNotMatch(workflow, /restoreTransientEscalation/);
});

test('transient clear revalidates the exact label assignments before merge', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'merge-bot.yml'),
    'utf8',
  );
  assert.match(workflow, /needsEventId: Number\(needsEvent\?\.id \|\| 0\)/);
  assert.match(workflow, /autoEventId: Number\(autoEvent\?\.id \|\| 0\)/);
  assert.match(workflow, /async function transientClearKeptValidatedOwnership/);
  assert.match(workflow, /const currentResponse = await github\.rest\.pulls\.get/);
  assert.match(workflow, /const events = await github\.paginate/);
  assert.ok(
    workflow.indexOf('const currentResponse = await github.rest.pulls.get',
      workflow.indexOf('async function transientClearKeptValidatedOwnership')) <
      workflow.indexOf('const events = await github.paginate',
        workflow.indexOf('async function transientClearKeptValidatedOwnership')),
    'label snapshot must precede the final event snapshot',
  );
  assert.match(workflow, /Number\(timeline\[1\]\?\.id \|\| 0\) === Number\(expectedEventId\)/);
  assert.match(workflow, /transitionIsDirectClear\(LABEL_ESCALATE, expectedNeedsEventId\)/);
  assert.match(workflow, /transitionIsDirectClear\(LABEL_ESCALATE_AUTO, expectedAutoEventId\)/);
  assert.match(workflow, /const clearStillOwned = await transientClearKeptValidatedOwnership/);
  assert.match(workflow, /if \(!clearStillOwned\) \{/);
  assert.match(workflow, /await restoreRaceHardStopIfOpen\(prNumber\)/);
  assert.match(workflow, /labels: \[LABEL_ESCALATE\]/);
  assert.match(workflow, /state=clear_race/);
  assert.match(workflow, /marker && \/\\bstate=clear_race/);
  assert.match(workflow, /marker persistence fails, attach the permanent policy stop/);
  assert.match(workflow, /labels: \[LABEL_NO_AUTOMERGE\]/);
  assert.match(workflow, /ownership changed during clear.*skipped merge/);
  assert.ok(
    workflow.indexOf('const clearStillOwned = await transientClearKeptValidatedOwnership') <
      workflow.indexOf('clearedTransient = true'),
    'ownership must be revalidated before merge eligibility continues',
  );
});

test('quota notices cannot satisfy any current-head Codex signal consumer', () => {
  for (const name of ['codex-gate.yml', 'claude-fallback-watchdog.yml', 'merge-bot.yml']) {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'workflows', name),
      'utf8',
    );
    assert.match(workflow, /function isCodexCapacityNotice\(body\)/, name);
    assert.match(workflow, /You have reached your Codex usage limits for code reviews/, name);
    assert.match(workflow, /!isCodexCapacityNotice\(/, name);
  }
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
  assert.match(read('codex-auto-fix.yml'), /pre-existing needs-owner is manual\/unknown/);
  assert.match(read('codex-auto-fix.yml'), /could not prove needs-owner was absent/);
  assert.match(read('claude-fallback-watchdog.yml'), /needs-owner-auto/);
  assert.match(read('claude-fallback-watchdog.yml'), /GH_LABEL_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(read('claude-fallback-watchdog.yml'), /async function actionLabelRequest\(method, path, body\)/);
  assert.doesNotMatch(read('claude.yml'), /needs-owner-auto/);
  assert.doesNotMatch(read('codex-backup-fix.yml'), /needs-owner-auto/);
  assert.doesNotMatch(read('ci-doctor.yml'), /needs-owner-auto/);
});

test('Claude PR provenance records on failure while automerge remains success-only', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'claude.yml'),
    'utf8',
  );
  assert.match(workflow, /always\(\) && steps\.claude_issue\.outcome != 'skipped'/);
  assert.match(workflow, /name: Capture Issue-mode branch baselines/);
  assert.match(workflow, /github\.rest\.git\.listMatchingRefs/);
  assert.match(workflow, /core\.setOutput\('branch_heads_json', JSON\.stringify\(baselines\)\)/);
  assert.match(workflow, /name: Revoke stale Issue-mode automerge before retry/);
  assert.match(workflow, /const provenancePattern = \/<!--\\s\*claude-pr-provenance:v1/);
  assert.match(workflow, /comment\.user\?\.login \|\| ''\) !== 'github-actions\[bot\]'/);
  assert.match(workflow, /linkedPrNumbers\.add\(Number\(marker\[2\]\)\)/);
  assert.match(workflow, /pr\.head\?\.repo\?\.full_name === `\$\{owner\}\/\$\{repo\}`/);
  assert.match(workflow, /entry\.name === 'claude-generated'/);
  const preModelRevocation = workflow.slice(
    workflow.indexOf('Revoke stale Issue-mode automerge before retry'),
    workflow.indexOf('Run Claude Code (Issue/new-PR path)'),
  );
  assert.doesNotMatch(preModelRevocation, /Fixes #/);
  assert.match(workflow, /stale automerge remained before Claude retry/);
  assert.ok(
    workflow.indexOf('Revoke stale Issue-mode automerge before retry') <
      workflow.indexOf('Run Claude Code (Issue/new-PR path)'),
    'stale automerge must be revoked before model execution',
  );
  assert.match(workflow, /ISSUE_BRANCH_BASELINES_JSON: \$\{\{ steps\.issue_branch_baseline\.outputs\.branch_heads_json \}\}/);
  assert.match(workflow, /IS_PR_COMMENT: \$\{\{ steps\.pr_context\.outputs\.is_pr_comment \}\}/);
  assert.match(workflow, /if \(process\.env\.IS_PR_COMMENT !== 'true'\)/);
  assert.match(workflow, /const before = String\(baselines\[branch\] \|\| process\.env\.ISSUE_BASE_SHA \|\| ''\)\.toLowerCase\(\)/);
  assert.match(workflow, /after !== before/);
  assert.match(workflow, /CLAUDE_DELIVERED: \$\{\{ steps\.delivery\.outputs\.delivered \}\}/);
  assert.match(workflow, /const delivered = process\.env\.CLAUDE_ACTION_OUTCOME === 'success' &&\s*process\.env\.CLAUDE_DELIVERED === 'true'/);
  const provenanceStep = workflow.slice(
    workflow.indexOf('Record Claude PR provenance and conditionally auto-merge'),
  );
  assert.match(provenanceStep, /CLAUDE_ACTION_OUTCOME: \$\{\{ steps\.claude_issue\.outcome \}\}/);
  assert.match(provenanceStep, /CLAUDE_DELIVERED: \$\{\{ steps\.delivery\.outputs\.delivered \}\}/);
  assert.match(provenanceStep, /if \(!delivered\) \{/);
  assert.match(provenanceStep, /await github\.rest\.issues\.removeLabel\(\{/);
  assert.match(provenanceStep, /name: 'automerge'/);
  assert.match(provenanceStep, /stale automerge remained after undelivered retry/);
  assert.match(provenanceStep, /const marker = `<!-- claude-pr-provenance:v1 issue=\$\{issueNum\} pr=\$\{prNumber\} -->`/);
  assert.match(provenanceStep, /\(comment\.user\?\.login \|\| ''\) === 'github-actions\[bot\]'/);
  assert.match(provenanceStep, /Trusted Claude workflow linkage to PR #\$\{prNumber\}/);
  assert.doesNotMatch(workflow, /No trigger comment .* treat as delivered/);
  assert.match(workflow, /labels: delivered \? \['claude-generated', 'automerge'\] : \['claude-generated'\]/);
  assert.match(workflow, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /CLAUDE_BRANCH_NAME: \$\{\{ steps\.claude_issue\.outputs\.branch_name \}\}/);
  assert.match(workflow, /name: Create Claude PR from trusted branch/);
  assert.match(workflow, /branch_prefix: "claude\/"/);
  assert.match(workflow, /if \(!branch\.startsWith\('claude\/'\)\) throw new Error/);
  assert.match(workflow, /await github\.rest\.pulls\.create/);
  assert.match(workflow, /const trustedDelivery = process\.env\.CLAUDE_ACTION_OUTCOME === 'success' &&\s*process\.env\.CLAUDE_DELIVERED === 'true'/);
  assert.match(workflow, /message: 'chore: activate trusted Claude delivery'/);
  assert.match(workflow, /tree: deliveredCommit\.tree\.sha/);
  assert.match(workflow, /parents: \[deliveredHead\]/);
  assert.match(workflow, /await github\.rest\.git\.updateRef\(\{/);
  assert.match(workflow, /sha: activation\.sha, force: false/);
  assert.match(workflow, /head: `\$\{owner\}:\$\{claudeBranch\}`/);
  const issuePath = workflow.slice(
    workflow.indexOf('Run Claude Code (Issue/new-PR path)'),
    workflow.indexOf('Run Claude Code (existing PR head path)'),
  );
  const issueExecutionPath = workflow.slice(
    workflow.indexOf('Checkout repository for Issue/new-PR path'),
    workflow.indexOf('Checkout existing PR head branch'),
  );
  assert.match(issuePath, /github_token: \$\{\{ github\.token \}\}/);
  assert.match(issuePath, /use_commit_signing: true/);
  assert.match(issuePath, /--allowedTools "Read,Glob,Grep"/);
  assert.match(issueExecutionPath, /token: \$\{\{ github\.token \}\}[\s\S]*persist-credentials: false/);
  assert.doesNotMatch(issueExecutionPath, /secrets\.AUTOMATION_PAT/);
  assert.doesNotMatch(issuePath, /Bash\(/);
  assert.doesNotMatch(issuePath, /(?:^|,)\s*(?:Edit|Write|MultiEdit)(?:,|$)/m);
  assert.match(issuePath, /name: Scrub Issue-mode model credentials/);
  assert.match(issuePath, /git config --local --unset-all/);
  assert.match(issuePath, /git remote set-url origin/);
  assert.match(issuePath, /x-access-token\|authorization/);
  assert.match(workflow, /steps\.scrub_issue_credentials\.outcome == 'success'/);
  assert.ok(
    workflow.indexOf('Scrub Issue-mode model credentials') <
      workflow.indexOf('token: ${{ secrets.AUTOMATION_PAT || github.token }}'),
    'the first PAT-backed step must follow the Issue-mode credential scrub',
  );
  const trustedPost = workflow.slice(workflow.indexOf('Create Claude PR from trusted branch'));
  assert.match(trustedPost, /secrets\.AUTOMATION_PAT \|\| github\.token/);
});

test('synced review freshness never uses the removed latest-commit-date model', () => {
  for (const name of [
    'codex-auto-fix.yml',
    'codex-gate.yml',
    'merge-bot.yml',
    'claude-fallback-watchdog.yml',
    'codex-backup-fix.yml',
  ]) {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'workflows', name),
      'utf8',
    );
    assert.doesNotMatch(workflow, /latestCommitDate/);
  }
});
