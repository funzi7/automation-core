'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  decideCodexGate,
  severity,
  signalTargetsHead,
  currentHeadEpochStart,
  currentHeadEpochFromVerifiedRuns,
} = require('../tools/codex_gate_logic');

const CODEX = 'chatgpt-codex-connector';
const CODEX_REST = 'chatgpt-codex-connector[bot]';

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

test('unmarked current-head signal must follow the observed head transition', () => {
  const signal = { created_at: '2026-08-11T15:00:00Z', body: 'clean' };
  assert.equal(signalTargetsHead(signal, 'c'.repeat(40), '2026-08-11T14:00:00Z'), true);
  assert.equal(signalTargetsHead(signal, 'c'.repeat(40), '2026-08-11T16:00:00Z'), false);
  assert.equal(signalTargetsHead(signal, 'c'.repeat(40), null), false);
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

test('technical API error retains intentional fail-soft policy', () => {
  const result = decideCodexGate({ technicalError: true });
  assert.equal(result.status, 'clear');
  assert.equal(result.reason, 'technical_fail_soft');
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
  assert.match(workflow, /codex-head-epoch:v2/);
  assert.match(workflow, /async function ensureHeadEpochMarker\(prNumber, comments\)/);
  assert.match(workflow, /github\.rest\.actions\.getWorkflowRun/);
  assert.match(workflow, /run\.path !== '\.github\/workflows\/codex-gate\.yml'/);
  assert.match(workflow, /run\.event !== 'pull_request_target'/);
  assert.match(workflow, /Number\(run\.run_attempt\) !== attempt \|\| !belongsToPr/);
  assert.match(workflow, /issues: write/);
  assert.ok(
    workflow.indexOf('comments = await ensureHeadEpochMarker') <
      workflow.indexOf('// Manual override — admin force-merge.'),
    'head epoch reconciliation must precede the administrator override return',
  );
  assert.match(workflow, /let prWorkflowRunsPromise = null/);
  assert.match(workflow, /const \[markers, runs\] = await Promise\.all/);
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
