'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  decideCodexGate,
  classifyThreads,
  severity,
  signalTargetsHead,
  currentHeadEpochStart,
  currentHeadEpochFromVerifiedRuns,
  selectHeadEpoch,
  isCodexCapacityNotice,
  isCodexTaskResult,
  reactionTargetsOnlyObservedHead,
  REVIEW_STATE_MARKER_PATTERN,
} = require('../tools/codex_gate_logic');

const CODEX = 'chatgpt-codex-connector';
const CODEX_REST = 'chatgpt-codex-connector[bot]';

test('Codex quota/capacity notices are not affirmative review signals', () => {
  assert.equal(isCodexCapacityNotice(
    'You have reached your Codex usage limits for code reviews. You can see your limits in the dashboard.'
  ), true);
  assert.equal(isCodexCapacityNotice(
    'Codex is currently at capacity and unable to complete this code review.'
  ), true);
  assert.equal(isCodexCapacityNotice(
    '**Reviewed commit:** `abcdef1234`\n\nNo P1/P2 findings.'
  ), false);
});

function thread({
  body = '**P2** fix the scheduler',
  author = CODEX,
  resolved = false,
  outdated = false,
  path = 'core/source_health.py',
} = {}) {
  return {
    id: 'T1',
    isResolved: resolved,
    isOutdated: outdated,
    path,
    line: 42,
    startLine: 40,
    comments: [{ author: { login: author }, body }],
  };
}

test('active P2 remains blocked after unrelated commit/current signal', () => {
  const result = decideCodexGate({
    threads: [thread()],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.activeFindings[0].path, 'core/source_health.py');
});

test('active P1 remains blocked after docs commit', () => {
  const result = decideCodexGate({
    threads: [thread({ body: '[P1] unsafe publication' })],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'blocked');
});

test('current-head non-inline trusted finding blocks despite clean signal', () => {
  const result = decideCodexGate({
    threads: [],
    nonInlineFindings: [{
      severity: 'P1',
      path: '(review body)',
      line: null,
      threadId: '',
    }],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'active_current_head_non_inline_finding');
});

test('review freshness is bound to the actual head, not a backdated commit', () => {
  const oldReview = {
    submitted_at: '2026-08-11T13:00:00Z',
    commit_id: 'a'.repeat(40),
    body: '**Reviewed commit:** `aaaaaaaaaa`',
  };
  assert.equal(
    signalTargetsHead(oldReview, 'b'.repeat(40), '2026-08-11T14:00:00Z', 'submitted_at'),
    false,
  );
  assert.equal(
    signalTargetsHead(oldReview, 'a'.repeat(40), '2026-08-11T14:00:00Z', 'submitted_at'),
    true,
  );
});

test('unmarked signal cannot inherit a newer head from timing alone', () => {
  const signal = { created_at: '2026-08-11T15:00:00Z', body: 'clean' };
  assert.equal(signalTargetsHead(signal, 'c'.repeat(40), '2026-08-11T14:00:00Z'), false);
  assert.equal(signalTargetsHead(signal, 'c'.repeat(40), '2026-08-11T16:00:00Z'), false);
  assert.equal(signalTargetsHead(signal, 'c'.repeat(40), null), false);
});

test('delayed Codex task result cannot satisfy a newer exact head', () => {
  const task = {
    created_at: '2026-08-13T13:40:08Z',
    body: [
      '### Summary',
      '* Updated the earlier head.',
      '**Reviewed commit:** `bbbbbbbbbb`',
      '[View task →](https://chatgpt.com/s/example)',
    ].join('\n'),
  };
  assert.equal(isCodexTaskResult(task.body), true);
  assert.equal(
    signalTargetsHead(task, 'b'.repeat(40), '2026-08-13T13:39:24Z'),
    false,
  );
});

test('explicit reviewed-commit result binds only to its exact head', () => {
  const result = {
    created_at: '2026-08-13T13:40:08Z',
    body: 'Codex Review: clean\n\n**Reviewed commit:** `cccccccccc`',
  };
  assert.equal(isCodexTaskResult(result.body), false);
  assert.equal(signalTargetsHead(result, 'c'.repeat(40)), true);
  assert.equal(signalTargetsHead(result, 'd'.repeat(40)), false);
});

test('reaction-only clean signal is limited to a PR with one observed head', () => {
  const reaction = { content: '+1', created_at: '2026-08-13T14:05:00Z' };
  assert.equal(
    reactionTargetsOnlyObservedHead(reaction, '2026-08-13T14:00:00Z', true),
    true,
  );
  assert.equal(
    reactionTargetsOnlyObservedHead(reaction, '2026-08-13T14:00:00Z', false),
    false,
  );
  assert.equal(
    reactionTargetsOnlyObservedHead(reaction, '2026-08-13T14:06:00Z', true),
    false,
  );
});

test('an explicit mismatched commit never falls back to a later timestamp', () => {
  const delayedOldReview = {
    submitted_at: '2026-08-11T17:00:00Z',
    commit_id: 'd'.repeat(40),
    body: '**Reviewed commit:** `dddddddddd`',
  };
  assert.equal(
    signalTargetsHead(delayedOldReview, 'e'.repeat(40), '2026-08-11T16:00:00Z', 'submitted_at'),
    false,
  );
  const repointedInline = {
    created_at: '2026-08-11T17:00:00Z',
    original_commit_id: 'd'.repeat(40),
    commit_id: 'e'.repeat(40),
  };
  assert.equal(
    signalTargetsHead(repointedInline, 'e'.repeat(40), '2026-08-11T16:00:00Z'),
    false,
  );
});

test('unchanged head uses its first server observation as freshness floor', () => {
  const head = 'f'.repeat(40);
  const runs = [
    { head_sha: head, created_at: '2026-08-11T18:00:00Z', pull_requests: [{ number: 9 }] },
    { head_sha: head, created_at: '2026-08-11T16:00:00Z', pull_requests: [{ number: 9 }] },
    { head_sha: head, created_at: '2026-08-11T15:00:00Z', pull_requests: [{ number: 10 }] },
  ];
  assert.equal(currentHeadEpochStart(runs, 9, head).toISOString(), '2026-08-11T16:00:00.000Z');
});

test('A to B to A force-push starts a new current-head epoch', () => {
  const headA = 'a'.repeat(40);
  const headB = 'b'.repeat(40);
  const runs = [
    { head_sha: headA, created_at: '2026-08-11T20:00:00Z', pull_requests: [{ number: 9 }] },
    { head_sha: headA, created_at: '2026-08-11T20:00:01Z', pull_requests: [{ number: 9 }] },
    { head_sha: headB, created_at: '2026-08-11T19:00:00Z', pull_requests: [{ number: 9 }] },
    { head_sha: headA, created_at: '2026-08-11T18:00:00Z', pull_requests: [{ number: 9 }] },
  ];
  assert.equal(currentHeadEpochStart(runs, 9, headA).toISOString(), '2026-08-11T20:00:00.000Z');
  assert.equal(currentHeadEpochStart(runs, 9, headB), null);
});

test('verified gate runs preserve the current contiguous epoch beyond run-search caps', () => {
  const headA = 'a'.repeat(40);
  const headB = 'b'.repeat(40);
  const markers = [
    { head: headA, observedAt: '2026-08-11T10:00:00Z', id: 1 },
    { head: headA, observedAt: '2026-08-11T11:00:00Z', id: 2 },
    { head: headB, observedAt: '2026-08-11T12:00:00Z', id: 3 },
    { head: headA, observedAt: '2026-08-11T13:00:00Z', id: 4 },
    { head: headA, observedAt: '2026-08-11T14:00:00Z', id: 5 },
  ];
  assert.equal(
    currentHeadEpochFromVerifiedRuns(markers, headA).toISOString(),
    '2026-08-11T13:00:00.000Z',
  );
  assert.equal(currentHeadEpochFromVerifiedRuns(markers, headB), null);
});

test('rerun comment order cannot move an old authenticated epoch ahead', () => {
  const headA = 'a'.repeat(40);
  const headB = 'b'.repeat(40);
  // The old-A marker appears first as if its rerun comment were newest. The
  // authenticated run times still prove B and then the restored A epoch.
  const markerCommentOrder = [
    { head: headA, observedAt: '2026-08-11T10:00:00Z', id: 1 },
    { head: headA, observedAt: '2026-08-11T12:00:00Z', id: 3 },
    { head: headB, observedAt: '2026-08-11T11:00:00Z', id: 2 },
  ];
  assert.equal(
    currentHeadEpochFromVerifiedRuns(markerCommentOrder, headA).toISOString(),
    '2026-08-11T12:00:00.000Z',
  );
});

test('authenticated marker epoch wins when bounded run history starts later', () => {
  const markerEpoch = new Date('2026-08-11T13:00:00Z');
  const truncatedRunEpoch = new Date('2026-08-11T14:00:00Z');
  assert.equal(selectHeadEpoch(markerEpoch, truncatedRunEpoch, false), markerEpoch);
  assert.equal(selectHeadEpoch(null, truncatedRunEpoch), truncatedRunEpoch);
});

test('proven intervening run head advances an incomplete marker epoch', () => {
  const incompleteMarkerEpoch = new Date('2026-08-11T13:00:00Z');
  const provenReturnToHead = new Date('2026-08-11T15:00:00Z');
  assert.equal(
    selectHeadEpoch(incompleteMarkerEpoch, provenReturnToHead, true).toISOString(),
    '2026-08-11T15:00:00.000Z',
  );
});

test('resolved thread clears with a current-head signal', () => {
  assert.equal(
    decideCodexGate({
      threads: [thread({ resolved: true })],
      currentHeadSignal: true,
    }).status,
    'clear',
  );
});

test('resolved old thread cannot waive review of a later head', () => {
  const result = decideCodexGate({
    threads: [thread({ resolved: true })],
    currentHeadSignal: false,
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'current_head_review_pending');
});

test('outdated thread plus current-head clean signal clears', () => {
  const result = decideCodexGate({
    threads: [thread({ outdated: true })],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'clear');
});

test('outdated thread without current-head signal is pending', () => {
  const result = decideCodexGate({
    threads: [thread({ outdated: true })],
    currentHeadSignal: false,
  });
  assert.equal(result.status, 'pending');
});

test('current-head thumbs-up cannot clear an active old thread', () => {
  const result = decideCodexGate({
    threads: [thread()],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'blocked');
});

test('P2 quoted only in a fix Summary is not a finding', () => {
  const quoted = [
    '### Summary',
    '> **P2** previous review finding',
    'Implemented the scheduler fix in commit abc.',
    '### Testing',
    '- node --test',
  ].join('\n');
  assert.equal(severity(quoted), null);
  assert.equal(
    decideCodexGate({
      threads: [thread({ body: quoted })],
      currentHeadSignal: true,
    }).status,
    'clear',
  );
});

test('REST-style trusted Codex bot login also blocks', () => {
  const result = decideCodexGate({
    threads: [
      thread({
        author: CODEX_REST,
        body: '**P2** trusted REST identity',
      }),
    ],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'blocked');
});

test('Codex lookalike login is ignored', () => {
  const result = decideCodexGate({
    threads: [
      thread({
        author: 'chatgpt-codex-connector-attacker',
        body: '**P1** untrusted lookalike',
      }),
    ],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'clear');
});

test('untrusted P1 author is ignored', () => {
  const result = decideCodexGate({
    threads: [thread({ author: 'random-user', body: '**P1** nope' })],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'clear');
});

test('explicit administrator override clears', () => {
  const result = decideCodexGate({
    threads: [thread({ body: '**P1** blocking' })],
    override: true,
  });
  assert.equal(result.status, 'clear');
  assert.equal(result.reason, 'administrator_override');
});

test('technical API error fails closed instead of clearing the head', () => {
  // An API failure proves nothing about the head. The former
  // `technical_fail_soft` branch published a GREEN check-codex-status on any
  // exception, which Merge Bot and branch protection read as approval.
  const result = decideCodexGate({ technicalError: true });
  assert.notEqual(result.status, 'clear');
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'technical_error_fail_closed');
  assert.deepEqual(result.activeFindings, []);
  // Even an override-less, finding-less head with a clean signal does not
  // turn green while the evaluation itself failed.
  const withSignal = decideCodexGate({ technicalError: true, currentHeadSignal: true });
  assert.equal(withSignal.status, 'pending');
});

test('one active thread blocks among resolved/outdated threads', () => {
  const result = decideCodexGate({
    threads: [
      thread({ resolved: true }),
      thread({ outdated: true }),
      thread({ body: 'P2: still active', path: 'core/main.py' }),
    ],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.activeFindings.length, 1);
  assert.equal(result.activeFindings[0].path, 'core/main.py');
});

test('mere old textual P1 mention outside trusted thread is not active', () => {
  const result = decideCodexGate({
    threads: [{ ...thread(), comments: [] }],
    currentHeadSignal: true,
  });
  assert.equal(result.status, 'clear');
});

test('authoritative workflow keeps gate policy inline', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'codex-gate.yml'),
    'utf8',
  );
  assert.match(workflow, /SECURITY: authoritative policy stays inline/);
  assert.match(workflow, /\n  pull_request_target:\n/);
  assert.match(workflow, /types: \[opened, synchronize, reopened, labeled, unlabeled\]/);
  assert.match(workflow, /\n  workflow_run:\n/);
  assert.match(workflow, /workflows: \['Codex Auto-Fix'\]/);
  assert.match(workflow, /listPullRequestsAssociatedWithCommit/);
  assert.match(workflow, /group: codex-gate-\$\{\{ github\.repository \}\}/);
  assert.match(workflow, /cron: '7,22,37,52 \* \* \* \*'/);
  assert.match(workflow, /context\.eventName === 'schedule'/);
  assert.match(workflow, /async function observedHeadTransition\(prNumber, headSha, comments = \[\]\)/);
  assert.match(workflow, /codex-head-epoch:v3/);
  assert.match(workflow, /pr=\$\{prNumber\} head=\$\{markerHead\}/);
  assert.match(workflow, /const head = markerHead/);
  assert.doesNotMatch(workflow, /const head = String\(run\.head_sha \|\| ''\)\.toLowerCase\(\)/);
  assert.match(workflow, /async function ensureHeadEpochMarker\(prNumber, comments\)/);
  assert.match(workflow, /context\.payload\.pull_request\?\.head\?\.sha/);
  assert.match(workflow, /String\(match\[4\]\)\.toLowerCase\(\) === markerHead/);
  assert.match(workflow, /if \(\(comment\.user\?\.login \|\| ''\) !== 'github-actions\[bot\]'\) return false/);
  assert.match(workflow, /actions\/runs\/\{run_id\}\/attempts\/\{attempt_number\}/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/codex-gate\.yml'/);
  assert.match(workflow, /run\.event !== 'pull_request_target'/);
  assert.match(workflow, /Number\(run\.run_attempt\) !== attempt \|\| !belongsToPr \|\| !commentInsideRun/);
  assert.match(workflow, /const head = markerHead/);
  assert.match(workflow, /const MAX_EPOCH_MARKER_CANDIDATES = 16/);
  assert.match(workflow, /const refsByRun = new Map\(\)/);
  assert.match(workflow, /refsByRun\.set\(ref\.runId, ref\)/);
  assert.match(workflow, /\.sort\(\(a, b\) => b\.runId - a\.runId\)\s*\.slice\(0, MAX_EPOCH_MARKER_CANDIDATES\)/);
  assert.doesNotMatch(workflow, /accepted\.has\(/);
  assert.match(workflow, /return markers\.sort\(\(a, b\) =>\s*b\.observedAt - a\.observedAt \|\| b\.id - a\.id\)/);
  assert.doesNotMatch(workflow, /refs\.sort\(/);
  assert.doesNotMatch(workflow, /if \(head !== exactHead\) break/);
  // The head-epoch marker is a comment on a PULL REQUEST. `pull-requests: read`
  // made every publish fail with "Resource not accessible by integration"
  // (2026-11-08, paywall-bot #120/#122 and automation-core #58).
  assert.match(workflow, /\n  pull-requests: write\n/);
  assert.doesNotMatch(workflow, /\n  pull-requests: read\n/);
  assert.match(workflow, /issues: write/);
  // Technical errors must publish a non-success verdict, never a green one.
  assert.match(workflow, /const GATE_ERROR_TITLE = '🟠 Gate evaluation error — fail-closed';/);
  assert.doesNotMatch(workflow, /Technical fail-soft/);
  assert.doesNotMatch(workflow, /technical_fail_soft/);
  const technicalCatch = workflow.slice(
    workflow.indexOf('} catch (err) {'),
    workflow.indexOf("core.summary.addHeading('Codex Gate Results')"),
  );
  assert.ok(technicalCatch.length > 200, 'the technical-error catch block must be located');
  assert.match(technicalCatch, /anyBlocked = true;/);
  assert.match(technicalCatch, /'failure',\s*GATE_ERROR_TITLE,/);
  assert.doesNotMatch(technicalCatch, /'success'/);
  assert.ok(
    workflow.indexOf('comments = await ensureHeadEpochMarker') <
      workflow.indexOf('// Manual override — admin force-merge.'),
    'head epoch reconciliation must precede the administrator override return',
  );
  assert.match(workflow, /let prWorkflowRunsPromise = null/);
  assert.match(workflow, /const \[markers, runs\] = await Promise\.all/);
  assert.match(workflow, /return markerEpoch \|\| runEpoch/);
  assert.match(workflow, /runEvidence\.hasBoundary/);
  assert.match(workflow, /function signalTargetsHead\(item, headSha, headObservedAt/);
  assert.match(workflow, /actions: read/);
  assert.doesNotMatch(workflow, /latestCommitDate/);
  assert.doesNotMatch(workflow, /\n  pull_request:\n/);
  assert.doesNotMatch(workflow, /\n  pull_request_review(?:_comment)?:\n/);
  assert.doesNotMatch(workflow, /uses:\s*actions\/checkout/);
  assert.doesNotMatch(workflow, /trusted-gate-source/);
  assert.doesNotMatch(workflow, /require\([^)]*codex_gate_logic/);
  assert.doesNotMatch(workflow, /all_findings_explicitly_resolved/);
  assert.match(workflow, /chatgpt-codex-connector\[bot\]/);
  assert.match(workflow, /'chatgpt-codex-connector'/);
});

test('queued PR head events are revalidated before gate evaluation', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'codex-gate.yml'),
    'utf8',
  );
  assert.match(workflow, /async function triggeringHeadEventIsCurrent\(prNumber, liveHead\)/);
  assert.match(workflow, /payloadHead !== liveHead\.toLowerCase\(\)/);
  assert.match(workflow, /github\.rest\.actions\.getWorkflowRun/);
  assert.match(workflow, /event\.event === 'head_ref_force_pushed'/);
  assert.match(workflow, /newestForcePushAt < runCreatedAt/);
  assert.doesNotMatch(workflow, /context\.payload\.action !== 'synchronize'\) return true/);
  // Tri-state: a freshness-lookup API error is skipped fail-closed AND loudly
  // (anyBlocked), never silently relabelled as a stale event.
  assert.match(workflow, /const headEventState = await triggeringHeadEventIsCurrent\(prNumber, headSha\);/);
  assert.match(workflow, /if \(headEventState === 'lookup_failed'\) \{[\s\S]{0,600}?anyBlocked = true;/);
  assert.match(workflow, /if \(headEventState !== 'current'\) \{/);
  assert.match(workflow, /return 'lookup_failed';/);
  assert.doesNotMatch(workflow, /freshness lookup failed[^\n]*\n[^\n]*return false;/);
  assert.match(workflow, /stale queued head event skipped/);
  assert.ok(
    workflow.indexOf('await triggeringHeadEventIsCurrent(prNumber, headSha)') <
      workflow.indexOf('comments = await ensureHeadEpochMarker(prNumber, comments)'),
    'stale event must stop before marker publication and evaluation',
  );
});



test('trusted evaluator publishes the authoritative check on the PR head', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'codex-gate.yml'),
    'utf8',
  );
  assert.match(workflow, /name: codex-gate-evaluator/);
  assert.match(
    workflow,
    /name: 'check-codex-status', head_sha: headSha/,
  );
  assert.doesNotMatch(workflow, /name: 'codex-gate-verdict'/);
});

test('watchdog rechecks changed red thread state from the trusted base ref', () => {
  const watchdog = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'claude-fallback-watchdog.yml'),
    'utf8',
  );
  assert.match(watchdog, /const VERDICT_CHECK = 'check-codex-status'/);
  assert.match(watchdog, /async function hasActiveTrustedFinding\(prNumber\)/);
  assert.match(watchdog, /redThreadStateChanged/);
  assert.match(
    watchdog,
    /const greenHeadNewFinding = !hasOverride && verdictGreen && activeFindingNow/,
  );
  assert.match(watchdog, /hasCurrentHeadNonInlineFinding/);
  assert.match(watchdog, /let prWorkflowRunsPromise = null/);
  assert.match(watchdog, /const \[markers, runs\] = await Promise\.all/);
  assert.match(watchdog, /return markerEpoch \|\| runEpoch/);
  assert.match(watchdog, /runEvidence\.hasBoundary/);
  assert.match(watchdog, /const MAX_EPOCH_MARKER_CANDIDATES = 16/);
  assert.match(watchdog, /const refsByRun = new Map\(\)/);
  assert.match(watchdog, /refsByRun\.set\(ref\.runId, ref\)/);
  assert.match(watchdog, /\.sort\(\(a, b\) => b\.runId - a\.runId\)\s*\.slice\(0, MAX_EPOCH_MARKER_CANDIDATES\)/);
  assert.doesNotMatch(watchdog, /accepted\.has\(/);
  assert.match(watchdog, /roPage\(`https:\/\/api\.github\.com\/repos\/\$\{owner\}\/\$\{repo\}\/actions\/runs\/\$\{runId\}\/attempts\/\$\{attempt\}`\)/);
  assert.match(watchdog, /return markers\.sort\(\(a, b\) =>\s*b\.observedAt - a\.observedAt \|\| b\.id - a\.id\)/);
  assert.doesNotMatch(watchdog, /refs\.sort\(/);
  assert.doesNotMatch(watchdog, /if \(head !== exactHead\) break/);
  assert.match(
    watchdog,
    /!overrideCandidate && !redThreadStateChanged/,
  );
  assert.match(
    watchdog,
    /ref: pr\.base\.ref \|\| context\.payload\.repository\.default_branch/,
  );
  assert.doesNotMatch(watchdog, /ref: pr\.head\.ref/);
  assert.match(watchdog, /'chatgpt-codex-connector'/);
  assert.match(watchdog, /'chatgpt-codex-connector\[bot\]'/);
});

test('watchdog preserves a concurrently added manual needs-owner stop', () => {
  const watchdog = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'claude-fallback-watchdog.yml'),
    'utf8',
  );
  assert.match(watchdog, /const \{ data: livePr \} = await github\.rest\.pulls\.get/);
  assert.match(watchdog, /if \(liveLabelNames\.has\(LABEL_ESCALATE\)\)/);
  assert.match(watchdog, /live needs-owner is manual\/unknown/);
  assert.match(watchdog, /could not prove needs-owner was absent/);
});

test('temporary escalation attaches the hard stop independently of provenance', () => {
  for (const name of ['codex-auto-fix.yml', 'claude-fallback-watchdog.yml']) {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', '.github', 'workflows', name),
      'utf8',
    );
    assert.match(workflow, /labels: \[hardStop\.name\]/);
    assert.match(workflow, /hard stop remains without transient provenance/);
    assert.match(workflow, /labels: \[provenance\.name\]/);
    assert.doesNotMatch(workflow, /labels: escalationLabels\.map/);
  }
});

test('review-thread changes have a supported PAT-independent gate sweep', () => {
  const bridge = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'codex-auto-fix.yml'),
    'utf8',
  );
  assert.doesNotMatch(bridge, /\n  pull_request_review_thread:/);
  const gate = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'codex-gate.yml'),
    'utf8',
  );
  assert.match(gate, /GitHub Actions has no pull_request_review_thread trigger/);
  assert.match(gate, /state: 'open', per_page: 100/);
  assert.match(gate, /anyBlocked && context\.eventName !== 'schedule'/);
});

test('bridge requires explicit head binding for top-level findings', () => {
  const bridge = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'codex-auto-fix.yml'),
    'utf8',
  );
  assert.match(bridge, /const HEAD_EPOCH_MARKER_PATTERN =/);
  assert.match(bridge, /const MAX_EPOCH_MARKER_CANDIDATES = 16/);
  assert.match(bridge, /const refsByRun = new Map\(\)/);
  assert.match(bridge, /refsByRun\.set\(ref\.runId, ref\)/);
  assert.match(bridge, /\.sort\(\(a, b\) => b\.runId - a\.runId\)\s*\.slice\(0, MAX_EPOCH_MARKER_CANDIDATES\)/);
  assert.match(bridge, /markerPr: Number\(match\[3\]\)/);
  assert.match(bridge, /markerHead: match\[4\]\.toLowerCase\(\)/);
  assert.match(bridge, /const runHead = ref\.markerHead/);
  assert.match(bridge, /permissions:[\s\S]*actions: read/);
  assert.match(bridge, /async function observedHeadTransition\(comments\)/);
  assert.match(bridge, /comment\.user\?\.login \|\| ''\) !== 'github-actions\[bot\]'/);
  assert.match(bridge, /run\.path !== '\.github\/workflows\/codex-gate\.yml'/);
  assert.match(bridge, /run\.event !== 'pull_request_target'/);
  assert.match(bridge, /Number\(run\.run_attempt\) !== ref\.attempt/);
  assert.match(bridge, /!belongsToPr \|\| !commentInsideRun/);
  assert.match(bridge, /const epochEvidence = \(timeline\) =>/);
  assert.match(bridge, /b\.observedAt - a\.observedAt \|\| \(b\.id \|\| 0\) - \(a\.id \|\| 0\)/);
  assert.match(bridge, /ordered\[0\]\.head !== exactHead/);
  assert.match(bridge, /if \(run\.head !== exactHead\) \{/);
  assert.match(bridge, /github\.rest\.actions\.listWorkflowRunsForRepo/);
  assert.match(bridge, /event: 'pull_request', per_page: 100/);
  assert.match(bridge, /markerEvidence\.epoch \|\| runEvidence\.epoch/);
  assert.match(bridge, /headObservedAt = await observedHeadTransition\(issueComments\)/);
  assert.match(bridge, /if \(isCodexTaskResult\(item\?\.body\)\) return false/);
  assert.match(bridge, /const loopHead = markerHead\(item\?\.body\)/);
  assert.doesNotMatch(bridge, /signalAt > observedAt/);
  assert.doesNotMatch(bridge, /prData\?\.updated_at/);
  assert.doesNotMatch(bridge, /commit dates.*transition timestamp/i);
  const digest = bridge.slice(
    bridge.indexOf('const digestBullets = []'),
    bridge.indexOf('// Cap the WHOLE digest'),
  );
  assert.match(digest, /for \(const c of issueComments\)/);
  assert.match(bridge, /const isCodexCapacityNotice = \(body\) =>/);
  assert.match(digest, /c\.user\?\.login === CODEX && isP12\(c\.body\) && signalTargetsHead\(c\)/);
  assert.match(digest, /!isCodexCapacityNotice\(c\.body\)/);
});

test('backup fixer includes trusted current-head top-level findings', () => {
  const backup = fs.readFileSync(
    path.join(__dirname, '..', 'workflows', 'codex-backup-fix.yml'),
    'utf8',
  );
  assert.match(backup, /actions: read/);
  assert.match(backup, /issues: read/);
  assert.match(backup, /github\.rest\.issues\.listComments/);
  assert.match(backup, /issue_number: prNumber, per_page: 100/);
  assert.match(backup, /const HEAD_EPOCH_MARKER_PATTERN =/);
  assert.match(backup, /const MAX_EPOCH_MARKER_CANDIDATES = 16/);
  assert.match(backup, /comment\.user\?\.login \|\| ''\) !== 'github-actions\[bot\]'/);
  assert.match(backup, /run\.path !== '\.github\/workflows\/codex-gate\.yml'/);
  assert.match(backup, /run\.event !== 'pull_request_target'/);
  assert.match(backup, /github\.rest\.actions\.listWorkflowRunsForRepo/);
  assert.match(backup, /headObservedAt = await observedHeadTransition\(ic\)/);
  assert.match(backup, /if \(isCodexTaskResult\(item\?\.body\)\) return false/);
  assert.doesNotMatch(backup, /signalAt > observedAt/);
  assert.match(backup, /\.\.\.ic\.filter\(\(c\) => isCodex\(c\) && targetsHead\(c\)/);
  assert.match(backup, /isCapacityNotice\(c\.body\)/);
  assert.match(backup, /PR_NUMBER: \$\{\{ inputs\.pr_number \}\}/);
  assert.match(backup, /TARGET_HEAD: \$\{\{ inputs\.head_sha \}\}/);
  assert.match(backup, /parseInt\(process\.env\.PR_NUMBER \|\| '', 10\)/);
  assert.match(backup, /String\(process\.env\.TARGET_HEAD \|\| ''\)/);
});

// ---------------------------------------------------------------------------
// paywall-bot #107 P1: Codex's structured review-state marker is exact-head
// evidence. Codex keeps ONE summary comment per PR, edited in place, whose
// body starts with this machine-written marker. When a PR has had several
// heads and Codex returns clean through that summary plus a 👍 only (no
// `Reviewed commit` receipt), nothing else can bind the head and the gate
// stayed yellow forever.
// ---------------------------------------------------------------------------
const WORKFLOWS = ['codex-gate.yml', 'merge-bot.yml', 'claude-fallback-watchdog.yml'];
const workflowSource = (name) => fs.readFileSync(
  path.join(__dirname, '..', 'workflows', name), 'utf8',
);

const PR120_HEAD = '23eac3576e5b7213311f26bd34fa6537f5017a4c';
// Verbatim opening of the summary comment on paywall-bot PR #120
// (automation-core #58 has the same shape with has_any_findings:false).
const PR120_BODY = [
  '<!-- codex-pull-request-review-summary -->',
  '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"23eac3576e5b7213311f26bd34fa6537f5017a4c","has_any_findings":true,"has_unresolved_findings":false,"status":"completed"},"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->',
  '',
  '<details>',
  '<summary><strong>Codex Review Summary</strong>: ✅ Completed</summary>',
  '',
  'This comment shows the latest Codex review activity on this pull request.',
  '',
  '| Review | Status | Commit | Review trigger |',
  '| --- | --- | --- | --- |',
  '| 📝 **Code Review** | ✅ **Completed** | `23eac35` | Manual request |',
  '</details>',
].join('\n');

function reviewStateBody(codeReview, securityReview = {
  commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null,
}) {
  const state = typeof codeReview === 'string'
    ? codeReview
    : JSON.stringify({ code_review: codeReview, security_review: securityReview });
  return `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${state} -->\n\nCodex Review Summary`;
}
const completedReview = (overrides = {}) => ({
  commit_sha: PR120_HEAD, has_any_findings: false, has_unresolved_findings: false,
  status: 'completed', ...overrides,
});

// [label, item, head, expected] — shared by the module test and the inline
// copies so all four implementations are held to the same table.
const MARKER_CASES = [
  ['real PR #120 summary binds its exact head', { body: PR120_BODY }, PR120_HEAD, true],
  ['real PR #120 summary does not bind another head', { body: PR120_BODY }, 'a'.repeat(40), false],
  ['an upper-case commit_sha still binds the lower-case head',
    { body: reviewStateBody(completedReview({ commit_sha: PR120_HEAD.toUpperCase() })) }, PR120_HEAD, true],
  ['the head is compared case-insensitively too', { body: PR120_BODY }, PR120_HEAD.toUpperCase(), true],
  ['status in_progress is not a review',
    { body: reviewStateBody(completedReview({ status: 'in_progress' })) }, PR120_HEAD, false],
  ['status pending is not a review',
    { body: reviewStateBody(completedReview({ status: 'pending' })) }, PR120_HEAD, false],
  ['status null is not a review',
    { body: reviewStateBody(completedReview({ status: null })) }, PR120_HEAD, false],
  ['status must equal completed exactly',
    { body: reviewStateBody(completedReview({ status: 'Completed' })) }, PR120_HEAD, false],
  ['a 7-char commit_sha prefix never binds',
    { body: reviewStateBody(completedReview({ commit_sha: PR120_HEAD.slice(0, 7) })) }, PR120_HEAD, false],
  ['a 39-char commit_sha never binds',
    { body: reviewStateBody(completedReview({ commit_sha: PR120_HEAD.slice(0, 39) })) }, PR120_HEAD, false],
  ['a null commit_sha never binds',
    { body: reviewStateBody(completedReview({ commit_sha: null })) }, PR120_HEAD, false],
  ['malformed JSON never binds',
    { body: reviewStateBody('{"code_review":{"commit_sha":"' + PR120_HEAD + '","status":"completed"}') }, PR120_HEAD, false],
  ['a marker without a code_review block never binds',
    { body: reviewStateBody('{"security_review":{"commit_sha":"' + PR120_HEAD + '","status":"completed"}}') }, PR120_HEAD, false],
  ['a matching security_review never speaks for the code review',
    { body: reviewStateBody(
      { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
      { commit_sha: PR120_HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
    ) }, PR120_HEAD, false],
  ['a completed review of a different head never binds this one',
    { body: reviewStateBody(completedReview({ commit_sha: 'b'.repeat(40) })) }, PR120_HEAD, false],
  ['isCodexTaskResult still wins when a task summary carries the marker',
    { body: ['### Summary', '* Fixed the earlier head.', PR120_BODY, '[View task →](https://chatgpt.com/s/example)'].join('\n') },
    PR120_HEAD, false],
  ['an explicit mismatched commit_id wins over the marker',
    { commit_id: 'b'.repeat(40), body: PR120_BODY }, PR120_HEAD, false],
  ['an explicit mismatched original_commit_id wins over the marker',
    { original_commit_id: 'b'.repeat(40), commit_id: PR120_HEAD, body: PR120_BODY }, PR120_HEAD, false],
  ['a Reviewed commit receipt wins over the marker',
    { body: '**Reviewed commit:** `bbbbbbbbbb`\n\n' + PR120_BODY }, PR120_HEAD, false],
  ['a body with no binding of any kind never binds', { body: 'Codex Review Summary: ✅ Completed' }, PR120_HEAD, false],
];

test('the structured review-state marker binds a completed review to its exact head', () => {
  const captured = PR120_BODY.match(REVIEW_STATE_MARKER_PATTERN);
  assert.ok(captured, 'the exported pattern must match the real summary body');
  assert.equal(JSON.parse(captured[1]).code_review.commit_sha, PR120_HEAD);
  for (const [label, item, head, expected] of MARKER_CASES) {
    assert.equal(signalTargetsHead(item, head), expected, label);
  }
  // The marker is informational about findings; liveness still comes from
  // the review threads, so unresolved findings do not stop the binding.
  assert.equal(
    signalTargetsHead({ body: reviewStateBody(completedReview({ has_unresolved_findings: true })) }, PR120_HEAD),
    true,
    'a completed review with unresolved findings is still a review of this head',
  );
});

// Execute the SHIPPED signalTargetsHead of each workflow, not a mirror. The
// region from REVIEWED_COMMIT_PATTERN through signalTargetsHead is
// self-contained in all three workflows (gate and Merge Bot define it as a
// function, the watchdog as an arrow function).
function inlineSignalTargetsHead(name) {
  const body = workflowSource(name);
  const start = body.indexOf('            const REVIEWED_COMMIT_PATTERN = ');
  assert.ok(start >= 0, `${name} must define REVIEWED_COMMIT_PATTERN inline`);
  const definition = body.indexOf('function signalTargetsHead(', start) >= 0
    ? body.indexOf('            function signalTargetsHead(', start)
    : body.indexOf('            const signalTargetsHead = (', start);
  assert.ok(definition > start, `${name} must define signalTargetsHead inline`);
  let end = body.indexOf('\n            }', definition);
  assert.ok(end > definition, `${name}: could not bound signalTargetsHead`);
  end += '\n            }'.length;
  if (body[end] === ';') end += 1;
  const source = body.slice(start, end).split('\n').map((line) => line.slice(12)).join('\n');
  return {
    source: body.slice(definition, end),
    fn: new Function(`${source}\nreturn signalTargetsHead;`)(),
  };
}

test('all three inline signalTargetsHead copies bind the review-state marker like the module', () => {
  for (const name of WORKFLOWS) {
    const { fn } = inlineSignalTargetsHead(name);
    for (const [label, item, head, expected] of MARKER_CASES) {
      assert.equal(fn(item, head), expected, `${name}: ${label}`);
      assert.equal(fn(item, head), signalTargetsHead(item, head), `${name}: must agree with the module: ${label}`);
    }
    // The legacy bindings are untouched.
    assert.equal(fn({ commit_id: PR120_HEAD }, PR120_HEAD), true, `${name}: commit_id still binds`);
    assert.equal(fn({ body: '**Reviewed commit:** `23eac3576e`' }, PR120_HEAD), true, `${name}: receipt still binds`);
    assert.equal(fn({ created_at: '2026-11-08T00:00:00Z', body: 'clean' }, PR120_HEAD), false, `${name}: timing alone never binds`);
  }
});

test('the review-state marker binding is pinned in every workflow with the mandated precedence', () => {
  const markerSource = `const REVIEW_STATE_MARKER_PATTERN = /${REVIEW_STATE_MARKER_PATTERN.source}/;`;
  assert.match(markerSource, /codex-review-state:v1/);
  for (const name of WORKFLOWS) {
    const body = workflowSource(name);
    assert.ok(body.includes(markerSource), `${name} must define the module's REVIEW_STATE_MARKER_PATTERN verbatim`);
    assert.match(body, /machine-written state marker from the trusted\s+(?:\/\/ )?connector/,
      `${name} must document that the marker is machine-written by the trusted connector`);
    assert.match(body, /is NOT a review/, `${name} must document that a non-completed state is not a review`);
    const { source } = inlineSignalTargetsHead(name);
    assert.match(source, /codex-review-state|REVIEW_STATE_MARKER_PATTERN/,
      `${name}: signalTargetsHead must consult the review-state marker`);
    assert.match(source, /review = JSON\.parse\(state\)\?\.code_review;/);
    assert.match(source, /if \(!review \|\| review\.status !== 'completed'\) return false;/);
    assert.match(source, /return \/\^\[a-f0-9\]\{40\}\$\/\.test\(reviewedSha\) && reviewedSha === exactHead;/);
    assert.doesNotMatch(source, /login/, `${name}: trust stays the caller's job inside signalTargetsHead`);
    const order = [
      'isCodexTaskResult(item?.body)) return false',
      'original_commit_id',
      'commit_id || \'\')',
      'REVIEWED_COMMIT_PATTERN',
      'REVIEW_STATE_MARKER_PATTERN',
    ];
    const indices = order.map((needle) => source.indexOf(needle));
    indices.forEach((index, position) => assert.ok(index >= 0, `${name}: missing ${order[position]}`));
    for (let i = 1; i < indices.length; i += 1) {
      assert.ok(indices[i] > indices[i - 1], `${name}: ${order[i]} must come after ${order[i - 1]}`);
    }
    assert.ok(source.lastIndexOf('return false;') > indices[indices.length - 1],
      `${name}: the marker must be the last binding before the fail-closed return`);
  }
});

// ---------------------------------------------------------------------------
// paywall-bot #107 P2: every thread reader requests comments(first: 100). A
// trusted P1/P2 beyond the first page was invisible, so a clean signal or a
// fallback could turn the gate green past a live finding. Fail closed.
// ---------------------------------------------------------------------------
function truncatedThread(overrides = {}) {
  return {
    id: 'T-overflow',
    isResolved: false,
    isOutdated: false,
    path: 'core/scheduler.py',
    line: 7,
    startLine: null,
    commentsTruncated: true,
    comments: [{ author: { login: 'funzi7' }, body: 'long discussion continues on the next page' }],
    ...overrides,
  };
}

test('classifyThreads reports a truncated unresolved thread without a visible finding', () => {
  const classified = classifyThreads([truncatedThread()]);
  assert.deepEqual(classified, {
    active: [],
    outdated: [],
    resolved: [],
    truncated: [{ path: 'core/scheduler.py', line: 7, startLine: null, threadId: 'T-overflow' }],
  });
  // A finding visible on the first page classifies exactly as before.
  const visible = classifyThreads([truncatedThread({
    comments: [{ author: { login: CODEX }, body: '**P1** visible on page one' }],
  })]);
  assert.equal(visible.active.length, 1);
  assert.deepEqual(visible.truncated, []);
  const visibleOutdated = classifyThreads([truncatedThread({
    isOutdated: true,
    comments: [{ author: { login: CODEX }, body: '**P2** visible on page one' }],
  })]);
  assert.equal(visibleOutdated.outdated.length, 1);
  assert.deepEqual(visibleOutdated.truncated, []);
  // A resolved thread is settled no matter how long it is.
  assert.deepEqual(classifyThreads([truncatedThread({ isResolved: true })]).truncated, []);
  // Legacy shapes without the flag, or with a complete page, are not truncated.
  assert.deepEqual(classifyThreads([{ ...thread(), comments: [] }]).truncated, []);
  assert.deepEqual(classifyThreads([truncatedThread({ commentsTruncated: false })]).truncated, []);
  assert.deepEqual(classifyThreads([truncatedThread({ commentsTruncated: undefined })]).truncated, []);
});

test('a truncated unresolved thread keeps the gate pending even with a clean current-head signal', () => {
  const result = decideCodexGate({ threads: [truncatedThread()] });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'review_thread_truncated');
  assert.deepEqual(result.activeFindings, []);
  assert.deepEqual(result.outdatedFindings, []);
  // A signal never clears an unreadable thread.
  const withSignal = decideCodexGate({ threads: [truncatedThread()], currentHeadSignal: true });
  assert.equal(withSignal.status, 'pending');
  assert.equal(withSignal.reason, 'review_thread_truncated');
  // An OUTDATED truncated thread is just as unreadable.
  const outdatedTruncated = decideCodexGate({
    threads: [truncatedThread({ isOutdated: true })],
    currentHeadSignal: true,
  });
  assert.equal(outdatedTruncated.status, 'pending');
  assert.equal(outdatedTruncated.reason, 'review_thread_truncated');
  // Visible outdated findings travel with the verdict.
  const mixed = decideCodexGate({
    threads: [thread({ outdated: true }), truncatedThread()],
    currentHeadSignal: true,
  });
  assert.equal(mixed.reason, 'review_thread_truncated');
  assert.equal(mixed.outdatedFindings.length, 1);
});

test('a truncated thread with a visible P1 blocks, a resolved truncated thread is ignored', () => {
  const blocked = decideCodexGate({
    threads: [truncatedThread({
      comments: [{ author: { login: CODEX }, body: '**P1** visible on page one' }],
    })],
    currentHeadSignal: true,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'active_unresolved_review_thread');
  // An active finding elsewhere still wins over the truncation verdict.
  const activeFirst = decideCodexGate({ threads: [truncatedThread(), thread()] });
  assert.equal(activeFirst.status, 'blocked');
  // Resolved means settled: the gate behaves exactly as without the thread.
  const resolved = truncatedThread({ isResolved: true });
  assert.equal(decideCodexGate({ threads: [resolved], currentHeadSignal: true }).status, 'clear');
  const unsignalled = decideCodexGate({ threads: [resolved], currentHeadSignal: false });
  assert.equal(unsignalled.status, 'pending');
  assert.equal(unsignalled.reason, 'current_head_review_pending');
  // A complete page without findings is clean as before.
  assert.equal(
    decideCodexGate({ threads: [truncatedThread({ commentsTruncated: false })], currentHeadSignal: true }).status,
    'clear',
  );
});

test('every review-thread comments page carries hasNextPage so truncation can fail closed', () => {
  const expectedBlocks = { 'codex-gate.yml': 1, 'merge-bot.yml': 2, 'claude-fallback-watchdog.yml': 2 };
  for (const [name, count] of Object.entries(expectedBlocks)) {
    const body = workflowSource(name);
    const blocks = body.match(/comments\(first: 100\)/g) || [];
    assert.equal(blocks.length, count, `${name}: expected ${count} comments(first: 100) block(s)`);
    const flagged = body.match(/comments\(first: 100\) \{\s*pageInfo \{ hasNextPage \}\s*nodes/g) || [];
    assert.equal(flagged.length, count,
      `${name}: every comments(first: 100) block must request pageInfo { hasNextPage }`);
  }
  const gate = workflowSource('codex-gate.yml');
  assert.match(gate, /commentsTruncated: !!t\.comments\?\.pageInfo\?\.hasNextPage,/,
    'the gate must carry the truncation flag onto each mapped thread');
  assert.match(gate, /if \(thread\?\.isResolved !== true && thread\?\.commentsTruncated === true\) \{\s*truncated\.push\(threadLocation\(thread\)\);/);
  assert.match(gate, /return \{ active, outdated, resolved, truncated \};/);
  assert.match(gate, /if \(classified\.truncated\.length\) \{/);
  assert.match(gate, /reason: 'review_thread_truncated',/);
  assert.ok(
    gate.indexOf('if (classified.active.length) {') <
      gate.indexOf('if (classified.truncated.length) {') &&
    gate.indexOf('if (classified.truncated.length) {') <
      gate.indexOf('if (classified.outdated.length && !currentHeadSignal) {'),
    'the truncation verdict must sit after the active check and before the outdated check',
  );
  assert.match(gate,
    /gateDecision\.reason === 'review_thread_truncated'\s*\? 'a review thread has more comments than can be read in one page; cannot prove no Codex finding is unresolved'/,
    'the pending verdict must explain the truncation');
  assert.match(gate, /'🟡 Waiting for Codex review',/, 'the watchdog matches this title verbatim');
  assert.match(gate, /const truncatedReviewThread =\s*classifyThreads\(reviewThreads\)\.truncated\.length > 0;/);
  assert.match(gate, /outdatedUnresolvedFinding: outdatedUnresolvedFinding \|\| truncatedReviewThread,/,
    'a fallback must never clear a thread the gate could not read');
  for (const name of ['merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    const body = workflowSource(name);
    const hits = body.match(/if \(thread\.comments\?\.pageInfo\?\.hasNextPage\) return true;/g) || [];
    assert.equal(hits.length, 2, `${name}: both thread predicates must fail closed on a truncated page`);
  }
});

// Execute the SHIPPED Merge Bot / watchdog thread predicates against paged
// GraphQL fixtures, modelled on loadOutdatedHelper in test_review_evidence.js.
function inlineAsyncFunctionSource(name, fnName) {
  const body = workflowSource(name);
  const head = `            async function ${fnName}(`;
  const start = body.indexOf(head);
  assert.ok(start >= 0, `${name} must define ${fnName} inline`);
  const end = body.indexOf('\n            }\n', start);
  assert.ok(end > start, `${name}: could not bound ${fnName}`);
  return body.slice(start, end + '\n            }'.length)
    .split('\n')
    .map((line) => line.slice(12))
    .join('\n');
}

function loadThreadPredicate(name, fnName, pages) {
  const source = inlineAsyncFunctionSource(name, fnName);
  let call = 0;
  const github = {
    graphql: async () => {
      const page = pages[call] || { nodes: [], hasNextPage: false };
      call += 1;
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: !!page.hasNextPage, endCursor: 'c' },
              nodes: page.nodes,
            },
          },
        },
      };
    },
  };
  const fn = new Function(
    'github', 'owner', 'repo', 'TRUSTED_CODEX_LOGINS', 'isCodex', 'hasSeverity',
    `${source}\nreturn ${fnName};`,
  )(
    github, 'funzi7', 'example',
    new Set([CODEX, CODEX_REST]),
    (user) => [CODEX, CODEX_REST].includes(String(user?.login || '')),
    (body) => severity(body) !== null,
  );
  return { fn, calls: () => call };
}

// GraphQL shape. `truncated` undefined omits pageInfo entirely, which is how
// every pre-existing fixture looks and must keep meaning "complete page".
function graphqlThread({
  resolved = false, outdated = false, author = CODEX, body = 'nit: tidy this up', truncated,
} = {}) {
  const comments = { nodes: [{ body, author: { login: author } }] };
  if (truncated !== undefined) comments.pageInfo = { hasNextPage: truncated };
  return { isResolved: resolved, isOutdated: outdated, comments };
}

test('Merge Bot and watchdog hasActiveTrustedFinding fail closed on a truncated unresolved thread', async () => {
  for (const name of ['merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    const run = (threads) => loadThreadPredicate(name, 'hasActiveTrustedFinding', [{ nodes: threads }]).fn(7);
    assert.equal(await run([graphqlThread({ truncated: true })]), true,
      `${name}: a truncated unresolved thread without a visible finding must block`);
    assert.equal(await run([graphqlThread({ truncated: true, author: 'funzi7', body: '**P1** untrusted' })]), true,
      `${name}: an untrusted finding on a truncated page proves nothing; still fail closed`);
    assert.equal(await run([graphqlThread({ truncated: true, body: '**P1** visible on page one' })]), true,
      `${name}: a visible trusted finding still blocks`);
    assert.equal(await run([graphqlThread({ truncated: true, outdated: true })]), false,
      `${name}: an outdated truncated thread belongs to the outdated predicate`);
    assert.equal(await run([graphqlThread({ truncated: true, resolved: true })]), false,
      `${name}: a resolved truncated thread is settled`);
    assert.equal(await run([graphqlThread({ truncated: false })]), false,
      `${name}: a complete page without a finding is clean`);
    assert.equal(await run([graphqlThread()]), false,
      `${name}: a page without pageInfo is a complete page`);
    // Truncation on a later reviewThreads page is reached through the cursor loop.
    const paged = loadThreadPredicate(name, 'hasActiveTrustedFinding', [
      { nodes: [graphqlThread({ truncated: false })], hasNextPage: true },
      { nodes: [graphqlThread({ truncated: true })] },
    ]);
    assert.equal(await paged.fn(7), true, `${name}: must paginate to a truncated thread`);
    assert.equal(paged.calls(), 2, `${name}: must actually request the second page`);
  }
});

test('Merge Bot and watchdog hasOutdatedUnresolvedTrustedFinding fail closed on a truncated outdated thread', async () => {
  for (const name of ['merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    const run = (threads) => loadThreadPredicate(name, 'hasOutdatedUnresolvedTrustedFinding', [{ nodes: threads }]).fn(7);
    assert.equal(await run([graphqlThread({ truncated: true, outdated: true })]), true,
      `${name}: a truncated unresolved outdated thread without a visible finding must block a fallback`);
    assert.equal(await run([graphqlThread({ truncated: true, outdated: true, body: '**P2** visible' })]), true,
      `${name}: a visible outdated finding still counts`);
    assert.equal(await run([graphqlThread({ truncated: true, outdated: false })]), false,
      `${name}: a current truncated thread belongs to the active predicate`);
    assert.equal(await run([graphqlThread({ truncated: true, outdated: true, resolved: true })]), false,
      `${name}: a resolved truncated thread is settled`);
    assert.equal(await run([graphqlThread({ truncated: false, outdated: true })]), false,
      `${name}: a complete outdated page without a finding is clean`);
    assert.equal(await run([graphqlThread({ outdated: true })]), false,
      `${name}: a page without pageInfo is a complete page`);
  }
});
