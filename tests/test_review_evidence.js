'use strict';

/**
 * Canonical review-evidence contract tests.
 *
 * Covers the mandatory acceptance matrix for
 *   valid exact-head review evidence ==
 *     normal Codex evidence OR approved Claude fallback evidence
 *     when Codex is provably unavailable
 * including the paywall-bot PR #103 regression fixture.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  decideReviewEvidence,
  evaluateFallbackAttestation,
  evaluateQuotaEpisode,
  parseFallbackAttestations,
  trustedQuotaNotices,
  isTrustedAttestationAuthor,
  attestationRunIsTrusted,
  reviewEvidenceProvenance,
  QUOTA_EPISODE_TTL_MS,
  HEAD_EPOCH_SKEW_MS,
  FALLBACK_ATTESTATION_WORKFLOW_PATH,
} = require('../tools/review_evidence');

const CODEX = 'chatgpt-codex-connector';
const CODEX_REST = 'chatgpt-codex-connector[bot]';
const BOT = 'github-actions[bot]';
// Every carrier of the canonical inline block.
const WORKFLOWS = ['codex-gate.yml', 'merge-bot.yml', 'claude-fallback-watchdog.yml'];

const HEAD = 'd068d977a700093affc47a46aa2b1610fe72248f';
const PREVIOUS_HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NEXT_HEAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f001234567';

const HEAD_OBSERVED_AT = new Date('2026-09-09T09:00:00Z');
const NOW = new Date('2026-09-09T10:30:00Z').getTime();

const QUOTA_TEXT =
  'You have reached your Codex usage limits for code reviews. ' +
  'You can see your limits in the Codex usage dashboard.';

function quotaNotice({ login = CODEX_REST, at = '2026-09-09T09:50:28Z', body = QUOTA_TEXT } = {}) {
  return { user: { login }, body, created_at: at };
}

function attestationMarker({
  head = HEAD,
  pr = 103,
  run = 314159,
  attempt = 1,
  provider = 'claude_code_fallback',
  verdict = 'clean',
  found = 6,
  fixed = 6,
  p1 = 0,
  p2 = 0,
  validation = 'passed/automation-core-suite-661-green',
  reason = 'codex_quota_unavailable',
} = {}) {
  return `<!-- claude-fallback-review:v1 run=${run} attempt=${attempt} pr=${pr} ` +
    `provider=${provider} reviewed_head=${head} verdict=${verdict} ` +
    `findings_found=${found} findings_fixed=${fixed} unresolved_p1=${p1} unresolved_p2=${p2} ` +
    `validation=${validation} reason=${reason} -->`;
}

function attestation(options) {
  return parseFallbackAttestations(attestationMarker(options))[0];
}

function codexThread({
  body = '**P2** unchecked source direction control',
  author = CODEX,
  resolved = false,
  outdated = false,
} = {}) {
  return {
    id: 'thread-1',
    isResolved: resolved,
    isOutdated: outdated,
    path: 'core/themarker.py',
    line: 42,
    startLine: null,
    comments: [{ body, author: { login: author } }],
  };
}

function decide(overrides = {}) {
  return decideReviewEvidence({
    headSha: HEAD,
    headObservedAt: HEAD_OBSERVED_AT,
    // The Route B window is measured from when the attestation was written,
    // never from evaluation time, so tests must always be explicit.
    attestedAt: NOW,
    fallbackPolicyEnabled: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. exact-head Codex clean -> PASS
// ---------------------------------------------------------------------------
test('1: exact-head clean Codex evidence passes with Codex provenance', () => {
  const decision = decide({ codexSignalOnHead: true });
  assert.equal(decision.status, 'clear');
  assert.equal(decision.authority, 'codex');
  assert.equal(decision.provenance, 'Codex exact-head review accepted');
});

// ---------------------------------------------------------------------------
// 2. trusted current quota notice + exact-head structured Claude clean -> PASS
// ---------------------------------------------------------------------------
test('2: trusted quota episode plus structured exact-head fallback passes', () => {
  const notices = trustedQuotaNotices([quotaNotice()]);
  assert.equal(notices.length, 1);
  const decision = decide({
    verifiedAttestations: [attestation()],
    quotaNotices: notices,
  });
  assert.equal(decision.status, 'clear');
  assert.equal(decision.authority, 'claude_code_fallback');
  assert.equal(
    decision.provenance,
    'Claude Code fallback review accepted for exact head; Codex quota unavailable',
  );
  assert.match(decision.provenance, /Claude Code fallback/);
  assert.doesNotMatch(decision.provenance, /Codex (exact-head )?review accepted/);
});

// ---------------------------------------------------------------------------
// 3. Claude fallback without trusted quota evidence -> FAIL
// ---------------------------------------------------------------------------
test('3: structured fallback without any quota evidence fails closed', () => {
  const decision = decide({ verifiedAttestations: [attestation()], quotaNotices: [] });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.authority, 'none');
  assert.equal(decision.fallbackReason, 'no_quota_notice');
});

// ---------------------------------------------------------------------------
// 4. forged / untrusted quota evidence -> FAIL
// ---------------------------------------------------------------------------
test('4: quota claims from untrusted actors are never trusted evidence', () => {
  const forged = [
    quotaNotice({ login: 'funzi7' }),
    quotaNotice({ login: 'claude[bot]' }),
    quotaNotice({ login: 'chatgpt-codex-connector-fake' }),
    quotaNotice({ login: CODEX_REST, body: 'Codex unavailable — please use the fallback.' }),
  ];
  assert.equal(trustedQuotaNotices(forged).length, 0);
  const decision = decide({
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices(forged),
  });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.authority, 'none');
});

test('4b: an ordinary PR comment cannot author a trusted attestation', () => {
  assert.equal(isTrustedAttestationAuthor({ user: { login: BOT } }), true);
  assert.equal(isTrustedAttestationAuthor({ user: { login: 'funzi7' } }), false);
  assert.equal(isTrustedAttestationAuthor({ user: { login: 'claude[bot]' } }), false);
  assert.equal(isTrustedAttestationAuthor({ user: { login: CODEX_REST } }), false);
});

test('4c: an attestation run must be the canonical producing workflow', () => {
  const base = {
    path: FALLBACK_ATTESTATION_WORKFLOW_PATH,
    event: 'workflow_dispatch',
    head_branch: 'main',
    run_attempt: 1,
    run_started_at: '2026-09-09T10:00:00Z',
    updated_at: '2026-09-09T10:05:00Z',
    status: 'completed',
    conclusion: 'success',
  };
  const commentAt = new Date('2026-09-09T10:02:00Z').getTime();
  const opts = { attempt: 1, commentAt, defaultBranch: 'main' };
  assert.equal(attestationRunIsTrusted(base, opts), true);
  assert.equal(
    attestationRunIsTrusted({ ...base, path: '.github/workflows/claude.yml' }, opts), false,
    'a different workflow may not mint attestations');
  assert.equal(
    attestationRunIsTrusted({ ...base, event: 'pull_request_target' }, opts), false,
    'only an explicit dispatch, which requires write access, may mint evidence');
  assert.equal(
    attestationRunIsTrusted({ ...base, head_branch: 'feature/pr-branch' }, opts), false,
    'a run from a PR ref would execute PR-controlled YAML');
  assert.equal(
    attestationRunIsTrusted(base, { ...opts, attempt: 2 }), false,
    'attempt must match the marker');
  assert.equal(
    attestationRunIsTrusted(base,
      { ...opts, commentAt: new Date('2026-09-09T11:00:00Z').getTime() }), false,
    'a comment outside the run window is not from that run');
  assert.equal(
    attestationRunIsTrusted({ ...base, status: 'in_progress' }, opts), false,
    'an unfinished run leaves an open-ended window');
  assert.equal(
    attestationRunIsTrusted({ ...base, conclusion: 'failure' }, opts), false,
    'a run that refused to attest proves nothing');
  assert.equal(
    attestationRunIsTrusted(base, { ...opts, defaultBranch: null }), false,
    'an unknown default branch must fail closed, not skip the check');
  // GitHub's documented example for "Get a workflow run attempt" shows
  // `"path": ".github/workflows/build.yml@main"`; live responses (verified on
  // two repositories on 2026-11-08) return the bare path. Both spellings of
  // the ONE canonical path pass; the ref itself stays pinned by head_branch.
  assert.equal(
    attestationRunIsTrusted({ ...base, path: `${FALLBACK_ATTESTATION_WORKFLOW_PATH}@main` }, opts), true,
    'the documented @ref spelling of the canonical path is the same workflow');
  assert.equal(
    attestationRunIsTrusted({ ...base, path: '.github/workflows/claude.yml@main' }, opts), false,
    'the suffix never lets a different workflow through');
  assert.equal(
    attestationRunIsTrusted({ ...base, path: '.github/workflows/evil@claude-fallback-review.yml' }, opts), false,
    'only the text before the first @ is the path');
  assert.equal(
    attestationRunIsTrusted(
      { ...base, path: `${FALLBACK_ATTESTATION_WORKFLOW_PATH}@main`, head_branch: 'feature/pr-branch' }, opts,
    ), false,
    'the ref is pinned by head_branch, not by the suffix');
  assert.equal(attestationRunIsTrusted(null, opts), false);
});

test('4d: the SHIPPED block pins the producer path with or without an @ref suffix', async () => {
  const commentAt = new Date('2026-09-09T10:02:00Z').getTime();
  for (const name of WORKFLOWS) {
    const api = loadInlineEvidence(name).make();
    assert.equal(api.attestationRunIsTrusted(TRUSTED_RUN, 1, commentAt, 'main'), true, name);
    assert.equal(
      api.attestationRunIsTrusted({ ...TRUSTED_RUN, path: `${TRUSTED_RUN.path}@main` }, 1, commentAt, 'main'),
      true, `${name}: the documented @ref spelling is the canonical producer`);
    assert.equal(
      api.attestationRunIsTrusted({ ...TRUSTED_RUN, path: '.github/workflows/claude.yml@main' }, 1, commentAt, 'main'),
      false, `${name}: another workflow never mints evidence, suffix or not`);
    assert.equal(
      api.attestationRunIsTrusted(
        { ...TRUSTED_RUN, path: `${TRUSTED_RUN.path}@main`, head_branch: 'claude/some-pr' }, 1, commentAt, 'main',
      ),
      false, `${name}: the ref stays pinned by head_branch`);

    const base = {
      prNumber: 103,
      headSha: HEAD,
      headObservedAt: EPOCH_AT,
      comments: [attestationComment()],
      quotaNotices: [quotaNotice({ at: NOTICE_AT })],
      realActivity: [],
      defaultBranch: 'main',
      codexSignalOnHead: false,
    };
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, fetchRunAttempt: async () => ({ ...TRUSTED_RUN, path: `${TRUSTED_RUN.path}@main` }),
    })).accepted, true, `${name}: a suffixed canonical path authenticates the run`);
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, fetchRunAttempt: async () => ({ ...TRUSTED_RUN, path: '.github/workflows/claude.yml@main' }),
    })).accepted, false, `${name}: a suffixed foreign path still fails`);
  }
});

// ---------------------------------------------------------------------------
// 5. fallback bound to a previous SHA -> FAIL
// ---------------------------------------------------------------------------
test('5: a previous-head attestation never satisfies the current head', () => {
  const decision = decide({
    verifiedAttestations: [attestation({ head: PREVIOUS_HEAD })],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.authority, 'none');
  assert.equal(decision.fallbackReason, 'reviewed_head_mismatch');
});

test('5b: an attestation from an earlier epoch of the same head (A -> B -> A) is rejected', () => {
  // The branch moved A -> B -> A. The current epoch of A began when the
  // automation observed the RETURN to A; an attestation written during the
  // first epoch of A predates it and must not be revived, even though its
  // reviewed_head matches byte for byte (paywall-bot PR #107, Codex P1).
  const returnedAt = new Date('2026-09-09T09:50:19Z');
  const notices = trustedQuotaNotices([quotaNotice({ at: '2026-09-09T09:50:28Z' })]);
  const onReturn = (attestedAt, overrides = {}) => decide({
    headObservedAt: returnedAt,
    attestedAt,
    verifiedAttestations: [attestation()],
    quotaNotices: notices,
    ...overrides,
  });

  const revived = onReturn(new Date('2026-09-09T09:40:00Z').getTime());
  assert.notEqual(revived.status, 'clear');
  assert.equal(revived.authority, 'none');
  assert.equal(revived.fallbackReason, 'attestation_predates_head_epoch');
  // The episode itself WOULD be active for that time (Route A, attested
  // before the newest notice), so the rejection must come from the binding.
  assert.equal(revived.quotaEpisode.active, true);

  // The same 5 s skew the run-window checks allow, and not a millisecond more.
  const insideSkew = onReturn(returnedAt.getTime() - HEAD_EPOCH_SKEW_MS + 1000);
  assert.equal(insideSkew.status, 'clear');
  assert.equal(insideSkew.authority, 'claude_code_fallback');
  const beyondSkew = onReturn(returnedAt.getTime() - HEAD_EPOCH_SKEW_MS - 1000);
  assert.equal(beyondSkew.fallbackReason, 'attestation_predates_head_epoch');

  // A later attestation on the returned head is accepted.
  const fresh = onReturn(new Date('2026-09-09T10:02:00Z').getTime());
  assert.equal(fresh.status, 'clear');
  assert.equal(fresh.authority, 'claude_code_fallback');

  // The binding only ever REMOVES acceptance. A blocking attestation from the
  // earlier epoch still blocks: the SHA is identical, so the unresolved
  // finding it reports is still in the code.
  const blocking = onReturn(new Date('2026-09-09T09:40:00Z').getTime(), {
    verifiedAttestations: [attestation({ p1: 1 })],
  });
  assert.equal(blocking.status, 'blocked');
  assert.equal(blocking.reason, 'unresolved_fallback_finding');
});

// ---------------------------------------------------------------------------
// 6. commit after fallback -> FAIL until a new review
// ---------------------------------------------------------------------------
test('6: a commit after an accepted fallback invalidates it until re-review', () => {
  const accepted = decide({
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.equal(accepted.status, 'clear');

  // Same attestation, new head pushed afterwards.
  const afterCommit = decideReviewEvidence({
    headSha: NEXT_HEAD,
    headObservedAt: new Date('2026-09-09T10:00:00Z'),
    attestedAt: NOW,
    fallbackPolicyEnabled: true,
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([
      quotaNotice({ at: '2026-09-09T10:10:00Z' }),
    ]),
  });
  assert.notEqual(afterCommit.status, 'clear');
  assert.equal(afterCommit.authority, 'none');
  assert.equal(afterCommit.fallbackReason, 'reviewed_head_mismatch');

  // A fresh fallback on the new head restores a pass.
  const rereviewed = decideReviewEvidence({
    headSha: NEXT_HEAD,
    headObservedAt: new Date('2026-09-09T10:00:00Z'),
    attestedAt: NOW,
    fallbackPolicyEnabled: true,
    verifiedAttestations: [attestation({ head: NEXT_HEAD })],
    quotaNotices: trustedQuotaNotices([
      quotaNotice({ at: '2026-09-09T10:10:00Z' }),
    ]),
  });
  assert.equal(rereviewed.status, 'clear');
  assert.equal(rereviewed.authority, 'claude_code_fallback');
});

// ---------------------------------------------------------------------------
// 7. unresolved Codex P1/P2 -> FAIL even with a valid fallback
// ---------------------------------------------------------------------------
test('7: a valid fallback never bypasses an unresolved Codex finding', () => {
  const withThread = decide({
    threads: [codexThread()],
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.equal(withThread.status, 'blocked');
  assert.equal(withThread.authority, 'none');
  assert.equal(withThread.reason, 'active_unresolved_review_thread');

  const withNonInline = decide({
    nonInlineFindings: [{
      severity: 'P1', path: '(review body)', line: null, startLine: null, threadId: '',
    }],
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.equal(withNonInline.status, 'blocked');
  assert.equal(withNonInline.authority, 'none');
  assert.equal(withNonInline.reason, 'active_current_head_non_inline_finding');
});

test('7b: a REST-suffixed Codex P1 thread also blocks a fallback pass', () => {
  const decision = decide({
    threads: [codexThread({ author: CODEX_REST, body: '**P1** unsafe direction control' })],
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.activeFindings[0].severity, 'P1');
});

// ---------------------------------------------------------------------------
// 8. unresolved Claude fallback P1/P2 -> FAIL
// ---------------------------------------------------------------------------
test('8: a fallback declaring unresolved P1/P2 blocks instead of clearing', () => {
  for (const [p1, p2, expected] of [[1, 0, 'P1'], [0, 2, 'P2']]) {
    const decision = decide({
      verifiedAttestations: [attestation({ p1, p2, verdict: 'clean' })],
      quotaNotices: trustedQuotaNotices([quotaNotice()]),
    });
    assert.equal(decision.status, 'blocked');
    assert.equal(decision.authority, 'none');
    assert.equal(decision.reason, 'unresolved_fallback_finding');
    assert.equal(decision.activeFindings[0].severity, expected);
  }
});

test('8b: a non-clean verdict is not accepted evidence', () => {
  const decision = decide({
    verifiedAttestations: [attestation({ verdict: 'dirty' })],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.fallbackReason, 'verdict_not_clean');
});

// ---------------------------------------------------------------------------
// 9. free-form "Claude reviewed" comment -> FAIL
// ---------------------------------------------------------------------------
test('9: free-form prose claiming a Claude review is never authority', () => {
  const freeform =
    'Claude reviewed this PR fully at the current head and found no issues. ' +
    'provider=claude_code_fallback verdict=clean unresolved_p1=0 unresolved_p2=0';
  assert.deepEqual(parseFallbackAttestations(freeform), []);
  const decision = decide({
    verifiedAttestations: parseFallbackAttestations(freeform),
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.authority, 'none');
  assert.equal(decision.fallbackReason, 'no_attestation');
});

test('9b: a structurally incomplete marker is rejected field by field', () => {
  const cases = [
    [{ provider: 'claude_manual' }, 'wrong_provider'],
    [{ reason: 'owner_says_so' }, 'wrong_reason'],
    [{ head: 'not-a-sha' }, 'malformed_reviewed_head'],
    [{ found: 'many' }, 'malformed_counts'],
    [{ found: 1, fixed: 5 }, 'malformed_counts'],
    [{ validation: '' }, 'missing_validation'],
    [{ validation: 'failed/suite-661-red' }, 'missing_validation'],
    [{ validation: 'suite-661-green' }, 'missing_validation'],
  ];
  for (const [options, expected] of cases) {
    const parsed = attestation(options);
    assert.equal(
      evaluateFallbackAttestation(parsed, HEAD).reason, expected,
    );
  }
});

// ---------------------------------------------------------------------------
// 10. stale quota evidence -> FAIL
// ---------------------------------------------------------------------------
test('10: quota evidence from an earlier head epoch cannot authorize fallback', () => {
  const stale = trustedQuotaNotices([
    quotaNotice({ at: '2026-09-07T10:45:22Z' }),
  ]);
  const episode = evaluateQuotaEpisode(stale, {
    headObservedAt: HEAD_OBSERVED_AT,
    attestedAt: new Date('2026-09-09T10:00:00Z').getTime(),
  });
  assert.equal(episode.active, false);
  assert.equal(episode.reason, 'stale_quota_evidence');

  const decision = decide({
    verifiedAttestations: [attestation()],
    quotaNotices: stale,
  });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.authority, 'none');
});

test('10b: both routes admit a decline only inside the TTL measured from the newest notice', () => {
  // Codex stops answering entirely while its quota is out, so a decline can
  // predate the current head epoch. That still counts, but only briefly.
  const observedAt = new Date('2026-09-09T09:50:19Z');
  const notices = trustedQuotaNotices([quotaNotice({ at: '2026-09-09T02:13:50Z' })]);
  const noticeAt = new Date('2026-09-09T02:13:50Z').getTime();

  const inside = evaluateQuotaEpisode(notices, {
    headObservedAt: observedAt,
    attestedAt: noticeAt + (6 * 60 * 60 * 1000),
  });
  assert.equal(inside.active, true, 'a recent pre-epoch decline still authorizes');
  assert.equal(inside.reason, 'trusted_quota_episode');

  const expired = evaluateQuotaEpisode(notices, {
    headObservedAt: observedAt,
    attestedAt: noticeAt + QUOTA_EPISODE_TTL_MS + 1000,
  });
  assert.equal(expired.active, false, 'stale evidence cannot authorize forever');
  assert.equal(expired.reason, 'stale_quota_evidence');

  // Route B still demands that the attestation FOLLOW the pre-epoch decline.
  const beforePreEpochNotice = evaluateQuotaEpisode(notices, {
    headObservedAt: observedAt,
    attestedAt: noticeAt - (60 * 1000),
  });
  assert.equal(beforePreEpochNotice.active, false);

  // Route A. This block used to assert "a decline on this head epoch needs no
  // TTL at all" and accepted an attestation three days after the notice.
  // Codex's review of paywall-bot PR #107 (2026-11-08) showed why that was
  // wrong: on an unchanged head a months-old decline would authorize a NEWLY
  // dispatched fallback although quota may have been restored long ago and
  // nobody re-requested a review. Route A is now bounded by the same TTL,
  // measured from the newest notice to the attestation, so the former
  // expectation is deliberately inverted below.
  const onEpoch = trustedQuotaNotices([quotaNotice({ at: '2026-09-09T09:50:28Z' })]);
  const onEpochNoticeAt = new Date('2026-09-09T09:50:28Z').getTime();
  const onEpochInside = evaluateQuotaEpisode(onEpoch, {
    headObservedAt: observedAt,
    attestedAt: onEpochNoticeAt + (6 * 60 * 60 * 1000),
  });
  assert.equal(onEpochInside.active, true, 'an on-epoch decline authorizes inside the TTL');
  assert.equal(onEpochInside.reason, 'trusted_quota_episode');
  const onEpochExpired = evaluateQuotaEpisode(onEpoch, {
    headObservedAt: observedAt,
    attestedAt: onEpochNoticeAt + QUOTA_EPISODE_TTL_MS + 1000,
  });
  assert.equal(onEpochExpired.active, false, 'an on-epoch decline is stale evidence after the TTL');
  assert.equal(onEpochExpired.reason, 'stale_quota_evidence');
  const threeDaysLater = evaluateQuotaEpisode(onEpoch, {
    headObservedAt: observedAt,
    attestedAt: new Date('2026-09-12T00:00:00Z').getTime(),
  });
  assert.equal(threeDaysLater.active, false, 'the former no-TTL expectation no longer holds');
  assert.equal(threeDaysLater.reason, 'stale_quota_evidence');

  // An attestation written BEFORE the newest on-epoch notice is fine: the
  // head-epoch binding, not the TTL, bounds it from below.
  const beforeOnEpochNotice = evaluateQuotaEpisode(onEpoch, {
    headObservedAt: observedAt,
    attestedAt: onEpochNoticeAt - (60 * 1000),
  });
  assert.equal(beforeOnEpochNotice.active, true);

  // Without an attestation time neither route can be bounded, so both fail
  // closed instead of defaulting to "active".
  for (const set of [notices, onEpoch]) {
    for (const attestedAt of [null, undefined, Number.NaN, 0]) {
      const unbounded = evaluateQuotaEpisode(set, { headObservedAt: observedAt, attestedAt });
      assert.equal(unbounded.active, false, `attestedAt=${attestedAt} must not authorize`);
      assert.equal(unbounded.reason, 'stale_quota_evidence');
    }
  }
});

test('10e: Route A is bounded by the TTL in the SHIPPED block of all three workflows', async () => {
  const notice = new Date(NOTICE_AT).getTime();
  const fresh = attestationComment({ at: '2026-09-09T10:02:00Z' });
  const stale = attestationComment({ at: STALE_AT });
  for (const name of WORKFLOWS) {
    const api = loadInlineEvidence(name).make();
    // The notice lands ON this head epoch (Route A).
    const episode = (attestedAt) => api.evaluateQuotaEpisode(
      [quotaNotice({ at: NOTICE_AT })], { headObservedAt: EPOCH_AT, realActivity: [], attestedAt },
    );
    assert.equal(episode(notice + (6 * 60 * 60 * 1000)).active, true, `${name}: inside the TTL`);
    assert.equal(episode(notice - (60 * 1000)).active, true, `${name}: attested before the notice`);
    const expired = episode(notice + QUOTA_EPISODE_TTL_MS + 1000);
    assert.equal(expired.active, false, `${name}: an on-epoch decline expires too`);
    assert.equal(expired.reason, 'stale_quota_evidence');
    assert.equal(episode(null).active, false, `${name}: no attestation time fails closed`);

    // End to end, the attestation time is the comment's own created_at.
    const base = {
      prNumber: 103,
      headSha: HEAD,
      headObservedAt: EPOCH_AT,
      quotaNotices: [quotaNotice({ at: NOTICE_AT })],
      realActivity: [],
      defaultBranch: 'main',
      codexSignalOnHead: false,
    };
    const accepted = await api.acceptedFallbackEvidence({
      ...base, comments: [fresh], fetchRunAttempt: runReaderFor([fresh]),
    });
    assert.equal(accepted.accepted, true, `${name}: inside the TTL`);
    const late = await api.acceptedFallbackEvidence({
      ...base, comments: [stale], fetchRunAttempt: runReaderFor([stale]),
    });
    assert.equal(late.accepted, false, `${name}: a day-old on-epoch decline is stale`);
    assert.equal(late.reason, 'stale_quota_evidence');
  }
});

test('10f: a same-second tie between Codex activity and the newest notice closes the episode', async () => {
  // REST timestamps carry one-second precision: when a genuine Codex item and
  // the newest notice share a second, nothing proves the notice came last.
  const options = { headObservedAt: HEAD_OBSERVED_AT, attestedAt: NOW };
  const notices = trustedQuotaNotices([quotaNotice({ at: NOTICE_AT })]);
  const tie = evaluateQuotaEpisode(notices, { ...options, realActivity: [{ created_at: NOTICE_AT }] });
  assert.equal(tie.active, false);
  assert.equal(tie.reason, 'quota_episode_closed');
  // One second earlier the order IS provable, so the episode stays open.
  const earlier = evaluateQuotaEpisode(notices, {
    ...options, realActivity: [{ created_at: '2026-09-09T09:50:27Z' }],
  });
  assert.equal(earlier.active, true);

  const decision = decide({
    verifiedAttestations: [attestation()],
    quotaNotices: notices,
    realActivity: [{ created_at: NOTICE_AT }],
  });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.authority, 'none');
  assert.equal(decision.fallbackReason, 'quota_episode_closed');

  for (const name of WORKFLOWS) {
    const api = loadInlineEvidence(name).make();
    const inlineTie = api.evaluateQuotaEpisode(
      [quotaNotice({ at: NOTICE_AT })], { ...options, realActivity: [{ created_at: NOTICE_AT }] },
    );
    assert.equal(inlineTie.active, false, `${name}: a tie closes the episode`);
    assert.equal(inlineTie.reason, 'quota_episode_closed');
    const out = await api.acceptedFallbackEvidence({
      prNumber: 103,
      headSha: HEAD,
      headObservedAt: EPOCH_AT,
      comments: [attestationComment()],
      quotaNotices: [quotaNotice({ at: NOTICE_AT })],
      realActivity: [{ created_at: NOTICE_AT }],
      defaultBranch: 'main',
      codexSignalOnHead: false,
      fetchRunAttempt: async () => TRUSTED_RUN,
    });
    assert.equal(out.accepted, false, `${name}: a tie must not authorize a fallback`);
    assert.equal(out.reason, 'quota_episode_closed');
  }
});

test('10d: real Codex activity after the newest notice closes the episode', () => {
  const episode = evaluateQuotaEpisode(
    trustedQuotaNotices([quotaNotice({ at: '2026-09-09T09:50:28Z' })]),
    {
      headObservedAt: HEAD_OBSERVED_AT,
      realActivity: [{ created_at: '2026-09-09T10:05:00Z' }],
      attestedAt: NOW,
    },
  );
  assert.equal(episode.active, false);
  assert.equal(episode.reason, 'quota_episode_closed');
});

test('10c: an unknown head epoch fails closed', () => {
  const episode = evaluateQuotaEpisode(
    trustedQuotaNotices([quotaNotice()]), { headObservedAt: null, attestedAt: NOW },
  );
  assert.equal(episode.active, false);
  assert.equal(episode.reason, 'head_epoch_unknown');
});

// ---------------------------------------------------------------------------
// 11. Codex returns later with new P1/P2 -> FAIL
// ---------------------------------------------------------------------------
test('11: a returning Codex P1/P2 on the current head blocks a prior fallback', () => {
  const decision = decide({
    codexSignalOnHead: true,
    threads: [codexThread({ body: '**P1** regression introduced by this PR' })],
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.equal(decision.status, 'blocked');
  assert.equal(decision.authority, 'none');
  assert.equal(decision.activeFindings[0].severity, 'P1');
});

// ---------------------------------------------------------------------------
// 12. clean current Codex supersedes the fallback normally
// ---------------------------------------------------------------------------
test('12: genuine current-head Codex evidence is the authority over a fallback', () => {
  const decision = decide({
    codexSignalOnHead: true,
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.equal(decision.status, 'clear');
  assert.equal(decision.authority, 'codex');
  assert.equal(decision.provenance, 'Codex exact-head review accepted');
  assert.equal(decision.quotaEpisode.active, false);
  assert.equal(decision.quotaEpisode.reason, 'codex_available_on_head');
});

test('12c: a leftover unresolved attestation cannot block a Codex-reviewed head', () => {
  // Codex returning clean on the current head is the authority. A stale
  // attestation declaring unresolved work must not re-block it — and the
  // inline block short-circuits identically.
  const decision = decide({
    codexSignalOnHead: true,
    verifiedAttestations: [attestation({ p1: 2 })],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.equal(decision.status, 'clear');
  assert.equal(decision.authority, 'codex');
  assert.equal(decision.fallbackReason, 'codex_available_on_head');
});

test('12b: fallback stays disabled unless repository policy enables it', () => {
  const decision = decide({
    fallbackPolicyEnabled: false,
    verifiedAttestations: [attestation()],
    quotaNotices: trustedQuotaNotices([quotaNotice()]),
  });
  assert.notEqual(decision.status, 'clear');
  assert.equal(decision.fallbackReason, 'fallback_policy_disabled');
});

// ---------------------------------------------------------------------------
// Requirement 12: the normal Codex path must not be weakened. With the policy
// switch off — the default in every repository — every decision must be
// exactly what the pre-existing gate logic produced.
// ---------------------------------------------------------------------------
test('policy off reproduces the pre-existing Codex-only decision exactly', () => {
  const { decideCodexGate } = require('../tools/codex_gate_logic');
  const scenarios = [
    { threads: [], nonInlineFindings: [], codexSignalOnHead: true },
    { threads: [], nonInlineFindings: [], codexSignalOnHead: false },
    { threads: [codexThread()], codexSignalOnHead: true },
    { threads: [codexThread({ resolved: true })], codexSignalOnHead: true },
    { threads: [codexThread({ resolved: true })], codexSignalOnHead: false },
    { threads: [codexThread({ outdated: true })], codexSignalOnHead: false },
    { threads: [codexThread({ outdated: true })], codexSignalOnHead: true },
    {
      nonInlineFindings: [{ severity: 'P1', path: '(review body)', line: null, startLine: null, threadId: '' }],
      codexSignalOnHead: true,
    },
    { threads: [], override: true },
    { threads: [], technicalError: true },
  ];
  for (const scenario of scenarios) {
    const legacy = decideCodexGate({
      threads: scenario.threads || [],
      nonInlineFindings: scenario.nonInlineFindings || [],
      currentHeadSignal: !!scenario.codexSignalOnHead,
      override: !!scenario.override,
      technicalError: !!scenario.technicalError,
    });
    // Fallback disabled, yet every fallback input is present and tempting.
    const now = decideReviewEvidence({
      headSha: HEAD,
      headObservedAt: HEAD_OBSERVED_AT,
      attestedAt: NOW,
      fallbackPolicyEnabled: false,
      verifiedAttestations: [attestation()],
      quotaNotices: trustedQuotaNotices([quotaNotice()]),
      threads: scenario.threads || [],
      nonInlineFindings: scenario.nonInlineFindings || [],
      codexSignalOnHead: !!scenario.codexSignalOnHead,
      override: !!scenario.override,
      technicalError: !!scenario.technicalError,
    });
    assert.equal(now.status, legacy.status, `status drift for ${JSON.stringify(scenario)}`);
    assert.equal(now.reason, legacy.reason, `reason drift for ${JSON.stringify(scenario)}`);
    assert.deepEqual(now.activeFindings, legacy.activeFindings);
    assert.notEqual(now.authority, 'claude_code_fallback');
  }
});

// ---------------------------------------------------------------------------
// 14. Gate and Merge Bot reach identical decisions
// ---------------------------------------------------------------------------
test('14: the three SHIPPED blocks decide identically on identical evidence', async () => {
  // The previous version of this test called one pure function twice, so it
  // would have passed even if Gate and Merge Bot disagreed completely. Drive
  // the actual inline blocks from all three workflows instead.
  const apis = ['codex-gate.yml', 'merge-bot.yml', 'claude-fallback-watchdog.yml']
    .map((name) => ({ name, api: loadInlineEvidence(name).make() }));

  const base = {
    prNumber: 103,
    headSha: HEAD,
    headObservedAt: new Date('2026-09-09T09:50:19Z'),
    defaultBranch: 'main',
    codexSignalOnHead: false,
    fetchRunAttempt: async () => TRUSTED_RUN,
  };
  const earlierEpoch = attestationComment({ at: '2026-09-09T09:40:00Z', options: { run: 314100 } });
  const staleComment = attestationComment({ at: STALE_AT, options: { run: 314160 } });
  const matrix = [
    ['accepted', { comments: [attestationComment()], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })] }],
    ['attestation predates the head epoch', { comments: [earlierEpoch], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })], fetchRunAttempt: runReaderFor([earlierEpoch]) }],
    ['stale on-epoch decline', { comments: [staleComment], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })], fetchRunAttempt: runReaderFor([staleComment]) }],
    ['newer stale candidate, older valid one', { comments: [staleComment, attestationComment()], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })], fetchRunAttempt: runReaderFor([staleComment, attestationComment()]) }],
    ['Codex activity ties the notice', { comments: [attestationComment()], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })], realActivity: [{ created_at: '2026-09-09T09:50:28Z' }] }],
    ['run path with @ref suffix', { comments: [attestationComment()], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })], fetchRunAttempt: async () => ({ ...TRUSTED_RUN, path: `${TRUSTED_RUN.path}@main` }) }],
    ['no attestation', { comments: [], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })] }],
    ['no quota episode', { comments: [attestationComment()], quotaNotices: [] }],
    ['previous head', { comments: [attestationComment({ options: { head: PREVIOUS_HEAD } })], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })] }],
    ['unresolved fallback P1', { comments: [attestationComment({ options: { p1: 4 } })], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })] }],
    ['untrusted author', { comments: [attestationComment({ login: 'funzi7' })], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })] }],
    ['codex returned', { comments: [attestationComment()], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })], realActivity: [{ created_at: '2026-09-09T10:10:00Z' }] }],
    ['edited attestation', { comments: [{ ...attestationComment(), updated_at: '2026-09-09T11:00:00Z' }], quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })] }],
  ];

  for (const [label, override] of matrix) {
    const results = [];
    for (const { name, api } of apis) {
      const out = await api.acceptedFallbackEvidence({ ...base, ...override });
      results.push({ name, key: `${out.accepted}/${out.blocking}/${out.reason}` });
    }
    const first = results[0].key;
    for (const result of results.slice(1)) {
      assert.equal(result.key, first,
        `${label}: ${result.name} disagreed with ${results[0].name} (${result.key} vs ${first})`);
    }
  }
});

test('14d: the three SHIPPED blocks build identical evidence inputs', async () => {
  // Byte-identical logic still drifts if the three feed it different sets.
  const raw = {
    reviews: [
      { user: { login: CODEX_REST }, body: QUOTA_TEXT, submitted_at: '2026-09-09T02:13:50Z' },
      { user: { login: CODEX_REST }, body: '**P2** something', submitted_at: '2026-09-09T02:00:00Z' },
    ],
    comments: [
      { user: { login: CODEX_REST }, body: QUOTA_TEXT, created_at: '2026-09-09T09:50:28Z' },
      { user: { login: 'funzi7' }, body: QUOTA_TEXT, created_at: '2026-09-09T09:55:00Z' },
    ],
    reviewComments: [
      { user: { login: CODEX }, body: 'inline note', created_at: '2026-09-09T02:05:00Z' },
    ],
    reactions: [
      { user: { login: CODEX_REST }, content: '+1', created_at: '2026-09-09T02:06:00Z' },
    ],
  };
  const shapes = ['codex-gate.yml', 'merge-bot.yml', 'claude-fallback-watchdog.yml'].map((name) => {
    const api = loadInlineEvidence(name).make();
    const out = api.collectReviewEvidenceInputs(raw);
    return JSON.stringify({
      quota: out.quotaNotices.map((i) => i.created_at || i.submitted_at).sort(),
      real: out.realActivity.map((i) => i.created_at || i.submitted_at).sort(),
    });
  });
  assert.equal(shapes[1], shapes[0], 'merge-bot must build the same inputs as the gate');
  assert.equal(shapes[2], shapes[0], 'the watchdog must build the same inputs as the gate');
  const parsed = JSON.parse(shapes[0]);
  assert.deepEqual(parsed.quota, ['2026-09-09T02:13:50Z', '2026-09-09T09:50:28Z'],
    'only trusted Codex usage-limit notices count');
  assert.ok(!parsed.real.includes('2026-09-09T09:55:00Z'),
    'an untrusted author never contributes evidence');
  assert.ok(parsed.real.includes('2026-09-09T02:06:00Z'),
    'a Codex reaction is real activity even though it has no body');
});

test('14e: a quota notice that also carries a finding cannot open an episode', async () => {
  const api = loadInlineEvidence('codex-gate.yml').make();
  const inputs = api.collectReviewEvidenceInputs({
    comments: [{
      user: { login: CODEX_REST },
      body: `${QUOTA_TEXT}\n\n**P1** unsafe direction control`,
      created_at: '2026-09-09T09:50:28Z',
    }],
  });
  assert.equal(inputs.quotaNotices.length, 0,
    'a notice carrying P1/P2 is a finding, not proof of unavailability');
  // It must land in realActivity, which is what makes it CLOSE an episode —
  // otherwise it would vanish from both lists and count for nothing.
  assert.equal(inputs.realActivity.length, 1,
    'a severity-carrying notice still counts as Codex activity');
  const episode = api.evaluateQuotaEpisode(
    [{ created_at: '2026-09-09T09:00:00Z' }],
    {
      headObservedAt: new Date('2026-09-09T08:00:00Z'),
      realActivity: inputs.realActivity,
      attestedAt: new Date('2026-09-09T11:00:00Z').getTime(),
    },
  );
  assert.equal(episode.active, false);
  assert.equal(episode.reason, 'quota_episode_closed',
    'a later severity-carrying message means Codex is answering again');
});

test('14b: provenance never attributes a Claude review to Codex', () => {
  assert.equal(reviewEvidenceProvenance('codex'), 'Codex exact-head review accepted');
  assert.equal(
    reviewEvidenceProvenance('claude_code_fallback'),
    'Claude Code fallback review accepted for exact head; Codex quota unavailable',
  );
  assert.equal(
    reviewEvidenceProvenance('none'), 'No accepted exact-head review evidence',
  );
  for (const authority of ['claude_code_fallback', 'none']) {
    assert.doesNotMatch(reviewEvidenceProvenance(authority), /^Codex /);
  }
});

// ---------------------------------------------------------------------------
// Acknowledgement semantics must stay distinct from fallback semantics
// ---------------------------------------------------------------------------
test('override and fail-soft never masquerade as fallback review evidence', () => {
  const override = decide({ override: true });
  assert.equal(override.status, 'clear');
  assert.equal(override.authority, 'none');
  assert.equal(override.reason, 'administrator_override');
  assert.doesNotMatch(override.provenance, /fallback review accepted/);

  const technical = decide({ technicalError: true });
  assert.equal(technical.status, 'pending', 'a technical error fails closed');
  assert.equal(technical.authority, 'none');
  assert.equal(technical.reason, 'technical_error_fail_closed');
  assert.doesNotMatch(technical.provenance, /fallback review accepted/);
  assert.doesNotMatch(technical.provenance, /Codex .*review accepted/);
});

// ---------------------------------------------------------------------------
// 15. paywall-bot PR #103 canonical regression
// ---------------------------------------------------------------------------
test('15: paywall-bot PR #103 passes only through the valid structured path', () => {
  // Real scenario: exact-head CI green; 3 earlier Codex rounds raised 4 real
  // P2 findings, all fixed and resolved; Codex then hit its code-review usage
  // limit; a full Claude fallback review of the final head found 6 further
  // real defects including a regression this PR introduced; all were fixed;
  // the suite grew to 661 and state stayed byte-clean.
  const resolvedCodexRounds = [
    codexThread({ body: '**P2** publication accounting drifts', resolved: true }),
    codexThread({ body: '**P2** direction control trusted too early', resolved: true }),
    codexThread({ body: '**P2** missing truthful failure path', resolved: true }),
    codexThread({ body: '**P2** stale source map reused', resolved: true }),
  ];
  // Real timestamps from the PR: the three Codex rounds ran on EARLIER heads
  // (01:53:36Z, 02:01:39Z, 02:09:43Z), the connector then posted usage-limit
  // notices, and the final head d068d97 was committed at 09:50:19Z.
  const quota = trustedQuotaNotices([
    quotaNotice({ at: '2026-09-09T02:13:50Z' }),
    quotaNotice({ at: '2026-09-09T02:26:34Z' }),
    quotaNotice({ at: '2026-09-09T09:49:02Z' }),
    quotaNotice({ at: '2026-09-09T09:50:28Z' }),
  ]);
  const earlierCodexRounds = [
    { created_at: '2026-09-09T01:53:36Z' },
    { created_at: '2026-09-09T02:01:39Z' },
    { created_at: '2026-09-09T02:09:43Z' },
  ];
  const fallback = attestation({
    head: HEAD, pr: 103, found: 6, fixed: 6,
    validation: 'passed/suite-661-green;state-byte-clean',
  });
  const attestedAt = new Date('2026-09-09T10:02:00Z').getTime();
  const regression = (overrides = {}) => decideReviewEvidence({
    headSha: HEAD,
    threads: resolvedCodexRounds,
    codexSignalOnHead: false,
    verifiedAttestations: [fallback],
    quotaNotices: quota,
    realActivity: earlierCodexRounds,
    // The gate observed this head just after it was pushed.
    headObservedAt: new Date('2026-09-09T09:50:19Z'),
    attestedAt,
    fallbackPolicyEnabled: true,
    ...overrides,
  });

  const decision = regression();
  assert.equal(decision.status, 'clear');
  assert.equal(decision.authority, 'claude_code_fallback');
  assert.equal(
    decision.provenance,
    'Claude Code fallback review accepted for exact head; Codex quota unavailable',
  );

  // The last notice beats the push by only 9 seconds, so the regression must
  // also hold when the gate observes the head AFTER that notice (Route B).
  const lateEpoch = regression({
    headObservedAt: new Date('2026-09-09T09:51:00Z'),
  });
  assert.equal(lateEpoch.status, 'clear');
  assert.equal(lateEpoch.authority, 'claude_code_fallback');

  // The three earlier Codex rounds are older than the newest notice, so they
  // must not be mistaken for Codex having returned.
  assert.equal(decision.quotaEpisode.active, true);
  assert.equal(decision.quotaEpisode.reason, 'trusted_quota_episode');

  // The same scenario must NOT pass without each canonical requirement.
  const mustFail = {
    'no attestation': { verifiedAttestations: [] },
    'free-form claim only': {
      verifiedAttestations: parseFallbackAttestations(
        'Claude fully reviewed d068d977 and it is clean.',
      ),
    },
    'attestation bound to an earlier head': {
      verifiedAttestations: [attestation({ head: PREVIOUS_HEAD })],
    },
    'no trusted quota episode': { quotaNotices: [] },
    'untrusted quota claim': {
      quotaNotices: trustedQuotaNotices([quotaNotice({ login: 'funzi7' })]),
    },
    'fallback policy disabled': { fallbackPolicyEnabled: false },
  };
  mustFail['Codex returned after the quota notice'] = {
    realActivity: [...earlierCodexRounds, { created_at: '2026-09-09T09:55:00Z' }],
  };
  mustFail['fallback attested a day after the last decline'] = {
    headObservedAt: new Date('2026-09-09T09:51:00Z'),
    attestedAt: new Date('2026-09-09T09:50:28Z').getTime() + QUOTA_EPISODE_TTL_MS + 1000,
  };
  // Since 2026-11-08 Route A carries the same bound: with the head observed
  // BEFORE the last notice (09:50:19Z), a fallback minted more than 24 h after
  // that notice is stale evidence too.
  mustFail['fallback attested a day after the last decline (on-epoch notice)'] = {
    attestedAt: new Date('2026-09-09T09:50:28Z').getTime() + QUOTA_EPISODE_TTL_MS + 1000,
  };
  // And the attestation must belong to the current epoch of this head.
  mustFail['attestation written before this head epoch began'] = {
    attestedAt: new Date('2026-09-09T09:40:00Z').getTime(),
  };
  for (const [label, override] of Object.entries(mustFail)) {
    const blocked = regression(override);
    assert.notEqual(blocked.status, 'clear', `#103 must not pass: ${label}`);
    assert.equal(blocked.authority, 'none', `#103 must not pass: ${label}`);
  }

  // An unresolved P2 from the earlier Codex rounds still blocks.
  const stillOpen = regression({
    threads: [
      ...resolvedCodexRounds.slice(1),
      codexThread({ body: '**P2** publication accounting drifts' }),
    ],
  });
  assert.equal(stillOpen.status, 'blocked');
  assert.equal(stillOpen.reason, 'active_unresolved_review_thread');
});

// ---------------------------------------------------------------------------
// Workflow wiring: one shared decision, no divergent duplicates (13 + 14)
// ---------------------------------------------------------------------------
function workflow(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'workflows', name), 'utf8',
  );
}

test('13+14: gate, merge bot and watchdog share the canonical decision inline', () => {
  for (const name of ['codex-gate.yml', 'merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    const body = workflow(name);
    assert.match(body, /claude-fallback-review:v1/,
      `${name} must recognise the canonical attestation marker`);
    assert.match(body, /decideReviewEvidence|acceptedFallbackEvidence/,
      `${name} must consume the canonical review-evidence decision`);
    assert.match(body, /claude_code_fallback/,
      `${name} must carry the canonical provider constant`);
    assert.match(body, new RegExp(FALLBACK_ATTESTATION_WORKFLOW_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${name} must pin the canonical producing workflow path`);
  }
});

test('14c: the canonical block is byte-identical in all three workflows', () => {
  const START = '// ===== CANONICAL EXACT-HEAD REVIEW EVIDENCE ======================';
  const END = '// ===== END CANONICAL EXACT-HEAD REVIEW EVIDENCE ==================';
  const extract = (name) => {
    const body = workflow(name);
    const start = body.indexOf(START);
    const end = body.indexOf(END);
    assert.ok(start >= 0, `${name} is missing the canonical block start marker`);
    assert.ok(end > start, `${name} is missing the canonical block end marker`);
    assert.equal(body.indexOf(START, start + 1), -1, `${name} has a duplicated block`);
    return body.slice(start, end + END.length);
  };
  const gate = extract('codex-gate.yml');
  assert.ok(gate.length > 5000, 'the canonical block should be substantial');
  for (const name of ['merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    assert.equal(extract(name), gate,
      `${name} must carry the canonical review-evidence block verbatim`);
  }
  // The same rules must also exist in the tested mirror module.
  for (const fragment of [
    'reviewed_head_mismatch', 'unresolved_fallback_finding', 'stale_quota_evidence',
    'no_quota_notice', 'quota_episode_closed', 'head_epoch_unknown',
    'fallback_policy_disabled', 'codex_available_on_head', 'structured_fallback_clean',
    'attestation_predates_head_epoch',
  ]) {
    assert.ok(gate.includes(fragment), `inline block must produce reason ${fragment}`);
    assert.ok(
      fs.readFileSync(path.join(__dirname, '..', 'tools', 'review_evidence.js'), 'utf8')
        .includes(fragment),
      `tools/review_evidence.js must mirror reason ${fragment}`,
    );
  }
});

test('the synced mirrors of the canonical workflows stay byte-identical', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'sync-config.json'), 'utf8',
  ));
  assert.ok(config.synced_workflows.includes('claude-fallback-review.yml'),
    'the canonical producer must be synced to consumer repositories');
  for (const name of config.synced_workflows) {
    assert.deepEqual(
      fs.readFileSync(path.join(__dirname, '..', 'workflows', name)),
      fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name)),
      `source/mirror drift: ${name}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The shipped inline block is what actually runs. Exercise it directly.
// ---------------------------------------------------------------------------
function loadInlineEvidence(name) {
  const START = '// ===== CANONICAL EXACT-HEAD REVIEW EVIDENCE ======================';
  const END = '// ===== END CANONICAL EXACT-HEAD REVIEW EVIDENCE ==================';
  const body = workflow(name);
  const marker = body.indexOf(START);
  const end = body.indexOf(END);
  assert.ok(marker >= 0 && end > marker, `${name} has no canonical block`);
  // Slice from the START of that line so the 12-space script indent is intact.
  const start = body.lastIndexOf('\n', marker) + 1;
  const source = body
    .slice(start, end + END.length)
    .split('\n')
    .map((line) => line.slice(12))
    .join('\n');
  const warnings = [];
  const factory = new Function(
    'github', 'owner', 'repo', 'core', 'process',
    `${source}\nreturn { acceptedFallbackEvidence, evaluateQuotaEpisode, evaluateFallbackAttestation, parseFallbackAttestations, reviewEvidenceProvenance, attestationRunIsTrusted, collectReviewEvidenceInputs };`,
  );
  return {
    warnings,
    make: ({ enabled = true } = {}) => factory(
      {},
      'funzi7',
      'automation-core',
      { warning: (m) => warnings.push(m), info: () => {} },
      { env: { CLAUDE_FALLBACK_REVIEW_ENABLED: enabled ? 'true' : 'false' } },
    ),
  };
}

const TRUSTED_RUN = {
  path: '.github/workflows/claude-fallback-review.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  run_attempt: 1,
  run_started_at: '2026-09-09T10:00:00Z',
  updated_at: '2026-09-09T10:05:00Z',
  status: 'completed',
  conclusion: 'success',
};

function attestationComment({ login = BOT, at = '2026-09-09T10:02:00Z', options = {} } = {}) {
  return { user: { login }, created_at: at, body: attestationMarker(options) };
}

// The paywall-bot PR #103 shape used by the inline tests: the gate observed
// the head at 09:50:19Z and the newest trusted notice landed nine seconds
// later, on this head epoch. STALE_AT is one second past the TTL after it.
const EPOCH_AT = new Date('2026-09-09T09:50:19Z');
const NOTICE_AT = '2026-09-09T09:50:28Z';
const STALE_AT = new Date(
  new Date(NOTICE_AT).getTime() + QUOTA_EPISODE_TTL_MS + 1000,
).toISOString();

// A trusted producer run whose execution window brackets `at`.
function runAround(at, overrides = {}) {
  const time = new Date(at).getTime();
  return {
    ...TRUSTED_RUN,
    run_started_at: new Date(time - (60 * 1000)).toISOString(),
    updated_at: new Date(time + (60 * 1000)).toISOString(),
    ...overrides,
  };
}

// An authenticated run reader that resolves each marker's run id to a run
// bracketing that comment, so every candidate authenticates on its own.
function runReaderFor(comments) {
  const byRun = new Map();
  for (const comment of comments) {
    for (const parsed of parseFallbackAttestations(comment.body)) {
      byRun.set(Number(parsed.run), comment.created_at);
    }
  }
  return async (runId) => {
    if (!byRun.has(Number(runId))) throw new Error(`no run ${runId}`);
    return runAround(byRun.get(Number(runId)));
  };
}

test('inline: the shipped block accepts only fully trusted exact-head evidence', async () => {
  for (const name of ['codex-gate.yml', 'merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    const loaded = loadInlineEvidence(name);
    const api = loaded.make();
    const base = {
      prNumber: 103,
      headSha: HEAD,
      headObservedAt: new Date('2026-09-09T09:50:19Z'),
      comments: [attestationComment()],
      quotaNotices: [quotaNotice({ at: '2026-09-09T09:50:28Z' })],
      realActivity: [],
      defaultBranch: 'main',
      codexSignalOnHead: false,
      fetchRunAttempt: async () => TRUSTED_RUN,
    };

    const ok = await api.acceptedFallbackEvidence(base);
    assert.equal(ok.accepted, true, `${name}: trusted evidence must be accepted`);
    assert.equal(ok.reason, 'structured_fallback_clean');

    // Untrusted author.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, comments: [attestationComment({ login: 'funzi7' })],
    })).accepted, false, `${name}: only the automation identity may attest`);

    // Wrong producing workflow.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base,
      fetchRunAttempt: async () => ({ ...TRUSTED_RUN, path: '.github/workflows/claude.yml' }),
    })).accepted, false, `${name}: only the canonical producer may attest`);

    // Run started from a PR ref.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base,
      fetchRunAttempt: async () => ({ ...TRUSTED_RUN, head_branch: 'claude/some-pr' }),
    })).accepted, false, `${name}: a PR-ref run may not attest`);

    // Previous head.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, comments: [attestationComment({ options: { head: PREVIOUS_HEAD } })],
    })).accepted, false, `${name}: previous-head attestation must fail`);

    // Unresolved fallback findings block.
    const blocking = await api.acceptedFallbackEvidence({
      ...base, comments: [attestationComment({ options: { p1: 1 } })],
    });
    assert.equal(blocking.accepted, false);
    assert.equal(blocking.blocking, true, `${name}: unresolved fallback P1 must block`);

    // No trusted quota episode.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, quotaNotices: [],
    })).accepted, false, `${name}: no quota evidence must fail closed`);

    // Codex returned after the notice — episode closed.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, realActivity: [{ created_at: '2026-09-09T10:01:00Z' }],
    })).accepted, false, `${name}: a returning Codex closes the episode`);

    // Genuine current-head Codex evidence short-circuits the fallback.
    const superseded = await api.acceptedFallbackEvidence({ ...base, codexSignalOnHead: true });
    assert.equal(superseded.accepted, false);
    assert.equal(superseded.reason, 'codex_available_on_head', `${name}: Codex is the authority`);

    // Run authentication hardening — each of these must be enforced by the
    // SHIPPED block, not only by the mirror.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, fetchRunAttempt: async () => ({ ...TRUSTED_RUN, status: 'in_progress', updated_at: null }),
    })).accepted, false, `${name}: an unfinished producer run leaves an open-ended window`);

    assert.equal((await api.acceptedFallbackEvidence({
      ...base, fetchRunAttempt: async () => ({ ...TRUSTED_RUN, conclusion: 'failure' }),
    })).accepted, false, `${name}: a run that REFUSED to attest proves nothing`);

    assert.equal((await api.acceptedFallbackEvidence({
      ...base, defaultBranch: undefined,
    })).accepted, false, `${name}: an unknown default branch must fail closed`);

    assert.equal((await api.acceptedFallbackEvidence({
      ...base,
      comments: [{ ...attestationComment(), updated_at: '2026-09-09T11:30:00Z' }],
    })).accepted, false, `${name}: an edited attestation comment is not evidence`);

    // An outdated thread nobody resolved still holds a live Codex finding.
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, outdatedUnresolvedFinding: true,
    })).accepted, false, `${name}: an outdated unresolved Codex finding blocks a fallback`);
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, outdatedUnresolvedFinding: true,
    })).reason, 'outdated_finding_needs_resolution', `${name}: with the honest reason`);

    // A failing run lookup must yield no evidence, never a throw.
    const failed = await api.acceptedFallbackEvidence({
      ...base,
      fetchRunAttempt: async () => { throw new Error('actions API 403'); },
    });
    assert.equal(failed.accepted, false, `${name}: unverifiable attestation is not evidence`);

    // A catastrophic input must fail closed rather than reach fail-soft green.
    const exploded = await api.acceptedFallbackEvidence(null);
    assert.equal(exploded.accepted, false, `${name}: null input must fail closed`);
    assert.equal(exploded.blocking, false);

    // Policy off.
    const disabled = loadInlineEvidence(name).make({ enabled: false });
    assert.equal((await disabled.acceptedFallbackEvidence(base)).reason,
      'fallback_policy_disabled', `${name}: policy switch must gate everything`);

    // Provenance never credits Codex for a Claude review.
    assert.equal(
      api.reviewEvidenceProvenance('claude_code_fallback'),
      'Claude Code fallback review accepted for exact head; Codex quota unavailable',
    );
    assert.equal(api.reviewEvidenceProvenance('codex'), 'Codex exact-head review accepted');
  }
});

test('inline: free-form prose parses to no attestation in the shipped block', async () => {
  const api = loadInlineEvidence('codex-gate.yml').make();
  assert.deepEqual(
    api.parseFallbackAttestations(
      'Claude reviewed this fully. provider=claude_code_fallback verdict=clean',
    ),
    [],
  );
  const decision = await api.acceptedFallbackEvidence({
    prNumber: 103,
    headSha: HEAD,
    headObservedAt: new Date('2026-09-09T09:50:19Z'),
    comments: [{ user: { login: BOT }, created_at: '2026-09-09T10:02:00Z', body: 'Claude reviewed this fully.' }],
    quotaNotices: [quotaNotice()],
    defaultBranch: 'main',
    fetchRunAttempt: async () => TRUSTED_RUN,
  });
  assert.equal(decision.accepted, false);
  assert.equal(decision.reason, 'no_attestation');
});

test('inline: an attestation from an earlier epoch of the same head is not revived (A -> B -> A)', async () => {
  // The branch moved A -> B -> A; headObservedAt is the first observation of
  // the RETURNED A. The attestation minted during the first epoch of A has the
  // right reviewed_head, a real producer run and an active episode (Route A,
  // written before the newest notice) — only the epoch binding rejects it.
  const earlier = attestationComment({ at: '2026-09-09T09:40:00Z', options: { run: 314100 } });
  const later = attestationComment({ at: '2026-09-09T10:02:00Z', options: { run: 314159 } });
  const earlierBlocking = attestationComment({
    at: '2026-09-09T09:40:00Z', options: { run: 314100, p1: 1 },
  });
  for (const name of WORKFLOWS) {
    const api = loadInlineEvidence(name).make();
    const base = {
      prNumber: 103,
      headSha: HEAD,
      headObservedAt: EPOCH_AT,
      quotaNotices: [quotaNotice({ at: NOTICE_AT })],
      realActivity: [],
      defaultBranch: 'main',
      codexSignalOnHead: false,
    };
    assert.equal(api.evaluateQuotaEpisode(
      [quotaNotice({ at: NOTICE_AT })],
      { headObservedAt: EPOCH_AT, realActivity: [], attestedAt: new Date(earlier.created_at).getTime() },
    ).active, true, `${name}: the episode alone would have admitted it`);

    const revived = await api.acceptedFallbackEvidence({
      ...base, comments: [earlier], fetchRunAttempt: runReaderFor([earlier]),
    });
    assert.equal(revived.accepted, false, `${name}: an earlier-epoch attestation must not be revived`);
    assert.equal(revived.reason, 'attestation_predates_head_epoch');

    // A later attestation on the returned head is accepted, with or without
    // the earlier one still on the PR.
    const fresh = await api.acceptedFallbackEvidence({
      ...base, comments: [earlier, later], fetchRunAttempt: runReaderFor([earlier, later]),
    });
    assert.equal(fresh.accepted, true, `${name}: the returned head can be re-attested`);
    assert.equal(fresh.reason, 'structured_fallback_clean');

    // Inside the 5 s skew the comment still belongs to this epoch.
    const skewed = attestationComment({
      at: new Date(EPOCH_AT.getTime() - 4000).toISOString(), options: { run: 314158 },
    });
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, comments: [skewed], fetchRunAttempt: runReaderFor([skewed]),
    })).accepted, true, `${name}: the run-window skew applies to the epoch too`);

    // The binding only removes acceptance: a blocking attestation from the
    // earlier epoch still blocks, because the SHA is byte-identical.
    const blocked = await api.acceptedFallbackEvidence({
      ...base, comments: [earlierBlocking], fetchRunAttempt: runReaderFor([earlierBlocking]),
    });
    assert.equal(blocked.blocking, true, `${name}: an earlier-epoch unresolved P1 still blocks`);
    assert.equal(blocked.accepted, false);

    // No authenticated head observation: nothing is accepted, as before.
    const unknown = await api.acceptedFallbackEvidence({
      ...base, headObservedAt: null, comments: [later], fetchRunAttempt: runReaderFor([later]),
    });
    assert.equal(unknown.accepted, false, `${name}: an unknown epoch fails closed`);
    assert.equal(unknown.reason, 'head_epoch_unknown');
  }
});

test('inline: a newer candidate outside its episode does not hide an older valid one', async () => {
  const valid = attestationComment({ at: '2026-09-09T10:02:00Z', options: { run: 314159 } });
  const stale = attestationComment({ at: STALE_AT, options: { run: 314160 } });
  const blocking = attestationComment({ at: '2026-09-09T10:03:00Z', options: { run: 314161, p2: 1 } });
  const previousHead = attestationComment({
    at: '2026-09-09T10:04:00Z', options: { run: 314162, head: PREVIOUS_HEAD },
  });
  for (const name of WORKFLOWS) {
    const api = loadInlineEvidence(name).make();
    const base = {
      prNumber: 103,
      headSha: HEAD,
      headObservedAt: EPOCH_AT,
      quotaNotices: [quotaNotice({ at: NOTICE_AT })],
      realActivity: [],
      defaultBranch: 'main',
      codexSignalOnHead: false,
    };
    // The stale candidate alone is rejected...
    const alone = await api.acceptedFallbackEvidence({
      ...base, comments: [stale], fetchRunAttempt: runReaderFor([stale]),
    });
    assert.equal(alone.accepted, false, name);
    assert.equal(alone.reason, 'stale_quota_evidence');
    // ...and, being the newest run, used to END the scan. It must not hide
    // the older exact-head attestation that is still inside its own episode.
    const both = await api.acceptedFallbackEvidence({
      ...base, comments: [stale, valid], fetchRunAttempt: runReaderFor([stale, valid]),
    });
    assert.equal(both.accepted, true, `${name}: the older valid attestation must still be found`);
    assert.equal(both.reason, 'structured_fallback_clean');
    // Two stale candidates stay rejected.
    const olderStale = attestationComment({ at: STALE_AT, options: { run: 314157 } });
    assert.equal((await api.acceptedFallbackEvidence({
      ...base, comments: [stale, olderStale], fetchRunAttempt: runReaderFor([stale, olderStale]),
    })).accepted, false, `${name}: continuing the scan never widens acceptance`);

    // A blocking newer candidate still wins immediately.
    const blocked = await api.acceptedFallbackEvidence({
      ...base, comments: [blocking, valid], fetchRunAttempt: runReaderFor([blocking, valid]),
    });
    assert.equal(blocked.blocking, true, `${name}: an unresolved P2 still blocks ahead of an older clean one`);
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.reason, 'unresolved_fallback_finding');

    // Diagnostics: the authenticated exact-head rejection is reported even
    // when a newer marker for another head sits in front of it.
    const masked = await api.acceptedFallbackEvidence({
      ...base, comments: [previousHead, stale], fetchRunAttempt: runReaderFor([previousHead, stale]),
    });
    assert.equal(masked.accepted, false);
    assert.equal(masked.reason, 'stale_quota_evidence', `${name}: the exact-head rejection is the useful one`);
  }
});

// ---------------------------------------------------------------------------
// Finding: the mandated precedence was asserted only against the mirror.
// Prove it against the SHIPPED gate path instead.
// ---------------------------------------------------------------------------
function inlineFunctionSource(name, fnName, prefix = 'function') {
  const body = workflow(name);
  const head = `            ${prefix} ${fnName}(`;
  const start = body.indexOf(head);
  assert.ok(start >= 0, `${name} must define ${fnName} inline`);
  const end = body.indexOf('\n            }\n', start);
  assert.ok(end > start, `${name}: could not bound ${fnName}`);
  return body.slice(start, end + '\n            }'.length);
}

// Compare logic, not formatting: line comments and trailing commas differ
// harmlessly between the inline copy and the module.
const normalize = (source) => String(source)
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/,(\s*[}\])])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim();

test('the gate\'s inline decideCodexGate is equivalent to the tested module', () => {
  const { decideCodexGate } = require('../tools/codex_gate_logic');
  const inline = normalize(inlineFunctionSource('codex-gate.yml', 'decideCodexGate'));
  const mirrored = normalize(decideCodexGate.toString());
  // Guard against the normalizer silently collapsing everything: `//` stripping
  // would eat the rest of a line containing a URL or a regex with a slash pair.
  assert.ok(inline.length > 600,
    'the normalized comparison must still be substantial, not collapsed away');
  assert.equal(inline, mirrored,
    'the gate must decide with exactly the logic the acceptance tests exercise');
});

test('shipped path: precedence holds for requirements 5, 7 and PR #103', async () => {
  // Compose the SHIPPED evidence function with the gate's decision function
  // (pinned equivalent by the test above) and the gate's branch ordering.
  const { decideCodexGate } = require('../tools/codex_gate_logic');
  const api = loadInlineEvidence('codex-gate.yml').make();

  async function shippedGate({
    threads = [], nonInlineFindings = [], codexSignalOnHead = false,
    comments = [attestationComment()],
    quotaNotices = [quotaNotice({ at: '2026-09-09T09:50:28Z' })],
    realActivity = [],
    fetchRunAttempt = async () => TRUSTED_RUN,
  } = {}) {
    const fallbackEvidence = await api.acceptedFallbackEvidence({
      prNumber: 103,
      headSha: HEAD,
      headObservedAt: new Date('2026-09-09T09:50:19Z'),
      defaultBranch: 'main',
      comments, quotaNotices, realActivity, codexSignalOnHead,
      fetchRunAttempt,
    });
    const gateDecision = decideCodexGate({
      threads, nonInlineFindings,
      currentHeadSignal: codexSignalOnHead || fallbackEvidence.accepted,
    });
    // The gate computes reviewAuthority but only ever reports it on the clear
    // path — it `continue`s before that on blocked/pending — so the effective
    // authority of a non-clear verdict is none.
    const authority = gateDecision.status !== 'clear'
      ? 'none'
      : codexSignalOnHead
        ? 'codex'
        : fallbackEvidence.accepted ? 'claude_code_fallback' : 'none';
    // The gate's branch ordering, reproduced exactly.
    if (gateDecision.status !== 'blocked' && fallbackEvidence.blocking) {
      return { status: 'blocked', reason: 'unresolved_fallback_finding', authority: 'none' };
    }
    return { status: gateDecision.status, reason: gateDecision.reason, authority };
  }

  // Requirement 5 — a valid fallback never bypasses an unresolved Codex finding.
  const activeThread = await shippedGate({ threads: [codexThread()] });
  assert.equal(activeThread.status, 'blocked');
  assert.equal(activeThread.reason, 'active_unresolved_review_thread');
  assert.equal(activeThread.authority, 'none');

  const nonInline = await shippedGate({
    nonInlineFindings: [{ severity: 'P1', path: '(review body)', line: null, startLine: null, threadId: '' }],
  });
  assert.equal(nonInline.status, 'blocked');
  assert.equal(nonInline.authority, 'none');

  // Requirement 6 — an unresolved fallback finding blocks rather than clears.
  const fallbackFinding = await shippedGate({
    comments: [attestationComment({ options: { p1: 2 } })],
  });
  assert.equal(fallbackFinding.status, 'blocked');
  assert.equal(fallbackFinding.reason, 'unresolved_fallback_finding');

  // Requirement 7 — a returning Codex P1 on the current head blocks.
  const codexReturned = await shippedGate({
    codexSignalOnHead: true,
    threads: [codexThread({ body: '**P1** regression introduced by this PR' })],
  });
  assert.equal(codexReturned.status, 'blocked');
  assert.equal(codexReturned.authority, 'none');

  // Requirement 12 — clean current Codex supersedes the fallback.
  const codexClean = await shippedGate({ codexSignalOnHead: true });
  assert.equal(codexClean.status, 'clear');
  assert.equal(codexClean.authority, 'codex');

  // PR #103 — passes, and only through the valid structured path.
  const staleComment = attestationComment({ at: STALE_AT, options: { run: 314160 } });
  const earlierEpoch = attestationComment({ at: '2026-09-09T09:40:00Z', options: { run: 314100 } });
  const resolvedRounds = [
    codexThread({ body: '**P2** publication accounting drifts', resolved: true }),
    codexThread({ body: '**P2** direction control trusted too early', resolved: true }),
    codexThread({ body: '**P2** missing truthful failure path', resolved: true }),
    codexThread({ body: '**P2** stale source map reused', resolved: true }),
  ];
  const regression = await shippedGate({ threads: resolvedRounds });
  assert.equal(regression.status, 'clear', 'PR #103 must pass on the shipped path');
  assert.equal(regression.authority, 'claude_code_fallback');

  for (const [label, override] of Object.entries({
    'no attestation': { comments: [] },
    'free-form prose only': {
      comments: [{ user: { login: BOT }, created_at: '2026-09-09T10:02:00Z', body: 'Claude reviewed this fully.' }],
    },
    'previous head': { comments: [attestationComment({ options: { head: PREVIOUS_HEAD } })] },
    'no quota episode': { quotaNotices: [] },
    'Codex returned after the notice': { realActivity: [{ created_at: '2026-09-09T10:10:00Z' }] },
    'Codex activity in the same second as the notice': { realActivity: [{ created_at: '2026-09-09T09:50:28Z' }] },
    'fallback attested a day after the on-epoch decline': {
      comments: [staleComment], fetchRunAttempt: runReaderFor([staleComment]),
    },
    'attestation from an earlier epoch of this head': {
      comments: [earlierEpoch], fetchRunAttempt: runReaderFor([earlierEpoch]),
    },
    'an unresolved P2 remains': { threads: [...resolvedRounds.slice(1), codexThread()] },
  })) {
    const blocked = await shippedGate({ threads: resolvedRounds, ...override });
    assert.notEqual(blocked.status, 'clear', `#103 must not pass on the shipped path: ${label}`);
    assert.equal(blocked.authority, 'none', `#103 must not pass on the shipped path: ${label}`);
  }
});

test('13: the watchdog stops chasing Codex once a fallback goes green', () => {
  const body = workflow('claude-fallback-watchdog.yml');
  // An accepted fallback is a review signal, so the gate is dispatched while
  // the verdict is still pending...
  assert.match(body, /const fallbackDispatchNeeded = fallbackSatisfiesReview &&\s*!verdictGreen &&/);
  assert.match(body, /const freshSignal = codexSignalOnHead \|\| fallbackDispatchNeeded;/);
  // ...bounded by the verdict's AGE, so one transient pending verdict cannot
  // suppress the head forever and a persistent disagreement cannot re-dispatch
  // the gate every tick.
  assert.match(body, /const FALLBACK_REDISPATCH_MIN_AGE_MS = 10 \* 60 \* 1000;/);
  assert.match(body, /verdictAgeMs >= FALLBACK_REDISPATCH_MIN_AGE_MS/);
  assert.doesNotMatch(body, /verdictAt < Number\(fallbackEvidence\.attestedAt/,
    'ordering-based suppression must not come back');

  // ...and the no-spam property is structural: once the verdict is green,
  // isCandidate is already false, so the sweep stops on its own. Pin that, or
  // the dispatch above could start repeating every tick.
  const candidate = body.slice(
    body.indexOf('const isCandidate ='),
    body.indexOf('if (!isCandidate) continue;'),
  );
  assert.match(candidate, /!newestVerdict \|\| title === PENDING_TITLE/);
  assert.match(candidate, /overrideCandidate \|\| redThreadStateChanged/);
  assert.match(candidate, /greenHeadNewFinding/);

  // The sweep must never itself ask Codex for a review or alert about a
  // missing Codex result.
  const sweep = body.slice(body.indexOf('Late-signal sweep'));
  assert.doesNotMatch(sweep, /@codex/,
    'the sweep must not post a Codex review request');

  // The watchdog matches the gate check title exactly; the two must agree.
  const pending = body.match(/const PENDING_TITLE = '([^']+)'/);
  assert.ok(pending, 'watchdog must define PENDING_TITLE');
  assert.ok(
    workflow('codex-gate.yml').includes(`'${pending[1]}'`),
    `codex-gate.yml must still publish the exact title ${pending[1]} the watchdog matches`,
  );
  // A technical gate error publishes a distinct non-success verdict. The
  // watchdog must treat it like pending (re-dispatch on a fresh signal) and
  // the two titles must stay verbatim-identical.
  const error = body.match(/const ERROR_TITLE = '([^']+)'/);
  assert.ok(error, 'watchdog must define ERROR_TITLE');
  assert.ok(
    workflow('codex-gate.yml').includes(`const GATE_ERROR_TITLE = '${error[1]}'`),
    `codex-gate.yml must publish the exact title ${error[1]} the watchdog matches`,
  );
  assert.match(candidate, /title === ERROR_TITLE/);
  assert.notEqual(error[1], pending[1]);
  assert.doesNotMatch(error[1], /^🟢/, 'an error verdict must never look green');
});

// P2-B: the two new outdated-thread predicates are security-relevant and sit
// one `!` away from their sibling hasActiveTrustedFinding. Execute them.
function loadOutdatedHelper(name, pages) {
  const source = inlineFunctionSource(name, 'hasOutdatedUnresolvedTrustedFinding', 'async function')
    .split('\n')
    .map((line) => line.slice(12))
    .join('\n');
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
    `${source}\nreturn hasOutdatedUnresolvedTrustedFinding;`,
  )(
    github, 'funzi7', 'example',
    new Set([CODEX, CODEX_REST]),
    (user) => [CODEX, CODEX_REST].includes(String(user?.login || '')),
    (body) => /\*\*\s*P[12]\s*\*\*/.test(String(body || '')),
  );
  return { fn, calls: () => call };
}

function thread({ resolved, outdated, author = CODEX, body = '**P1** unsafe' }) {
  return {
    isResolved: resolved,
    isOutdated: outdated,
    comments: { nodes: [{ body, author: { login: author } }] },
  };
}

test('the outdated-thread predicate selects exactly unresolved-and-outdated', async () => {
  for (const name of ['merge-bot.yml', 'claude-fallback-watchdog.yml']) {
    const cases = [
      ['unresolved + outdated', { resolved: false, outdated: true }, true],
      ['resolved + outdated', { resolved: true, outdated: true }, false],
      ['unresolved + current', { resolved: false, outdated: false }, false],
      ['resolved + current', { resolved: true, outdated: false }, false],
    ];
    for (const [label, shape, expected] of cases) {
      const { fn } = loadOutdatedHelper(name, [{ nodes: [thread(shape)] }]);
      assert.equal(await fn(7), expected, `${name}: ${label}`);
    }

    // An untrusted author never contributes a finding.
    const untrusted = loadOutdatedHelper(name, [{
      nodes: [thread({ resolved: false, outdated: true, author: 'funzi7' })],
    }]);
    assert.equal(await untrusted.fn(7), false, `${name}: untrusted author is not a Codex finding`);

    // A thread with no severity marker is not a finding.
    const noSeverity = loadOutdatedHelper(name, [{
      nodes: [thread({ resolved: false, outdated: true, body: 'nit: rename this' })],
    }]);
    assert.equal(await noSeverity.fn(7), false, `${name}: a nit is not P1/P2`);

    // The cursor loop must reach a finding on a later page.
    const paged = loadOutdatedHelper(name, [
      { nodes: [thread({ resolved: true, outdated: true })], hasNextPage: true },
      { nodes: [thread({ resolved: false, outdated: true })] },
    ]);
    assert.equal(await paged.fn(7), true, `${name}: must paginate to a later page`);
    assert.equal(paged.calls(), 2, `${name}: must actually request the second page`);

    // No threads at all is not a finding.
    const empty = loadOutdatedHelper(name, [{ nodes: [] }]);
    assert.equal(await empty.fn(7), false, `${name}: no threads means no finding`);
  }
});

test('the shipped wiring that consumes the evidence is pinned', () => {
  // The decision functions are tested directly, but the few lines that WIRE
  // them into each workflow are what actually gate a merge. Mutating any of
  // them (e.g. `currentHeadSignal: true`) would otherwise pass every test.
  const gate = workflow('codex-gate.yml');
  assert.match(gate, /currentHeadSignal: hasCodexSignalOnHead \|\| fallbackEvidence\.accepted,/,
    'the gate must derive its head signal from Codex OR an accepted fallback');
  assert.match(gate, /if \(gateDecision\.status !== 'blocked' && fallbackEvidence\.blocking\) \{/,
    'a fallback declaring unresolved P1\/P2 must block');
  assert.match(gate, /const outdatedUnresolvedFinding =\s*classifyThreads\(reviewThreads\)\.outdated\.length > 0;/,
    'the gate must tell the decision about outdated unresolved findings');
  assert.match(gate, /reviewAuthority === FALLBACK_PROVIDER/,
    'the published check must distinguish fallback provenance');

  const mergeBot = workflow('merge-bot.yml');
  assert.match(mergeBot, /if \(reviewEvidence\.blocking\) \{/,
    'Merge Bot must skip on a blocking fallback finding');
  assert.match(mergeBot, /if \(!reviewEvidence\.accepted\) \{/,
    'Merge Bot must skip without accepted exact-head review evidence');
  assert.match(mergeBot, /if \(finalEvidence\.blocking \|\| !finalEvidence\.accepted\) \{/,
    'Merge Bot must revalidate the final candidate through the same decision');
  assert.match(mergeBot, /outdatedUnresolvedFinding: \(\) => hasOutdatedUnresolvedTrustedFinding\(prNumber\)/,
    'Merge Bot must tell the decision about outdated unresolved findings');
  assert.match(mergeBot, /reviewEvidenceProvenance\(reviewEvidence\.authority\)/,
    'the merge log must record the real review authority');

  const watchdog = workflow('claude-fallback-watchdog.yml');
  assert.match(watchdog, /outdatedUnresolvedFinding: \(\) => hasOutdatedUnresolvedTrustedFinding\(prNumber\)/,
    'the watchdog must tell the decision about outdated unresolved findings');
  // The lookup must stay lazy so a repository with fallback disabled never
  // pays for an extra GraphQL round trip on the normal Codex path.
  for (const [name, body] of [['merge-bot.yml', mergeBot], ['claude-fallback-watchdog.yml', watchdog]]) {
    assert.doesNotMatch(body, /await hasOutdatedUnresolvedTrustedFinding\(/,
      `${name} must resolve the outdated lookup lazily, not eagerly`);
  }
});

function producerScript() {
  const body = workflow('claude-fallback-review.yml');
  const marker = body.indexOf('          script: |\n');
  assert.ok(marker >= 0, 'producer must have a github-script body');
  return body
    .slice(marker + '          script: |\n'.length)
    .split('\n')
    .map((line) => line.slice(12))
    .join('\n');
}

async function attemptAttestation(overrides = {}) {
  const {
    enabled = 'true',
    ref = 'refs/heads/main',
    defaultBranch = 'main',
    prState = 'open',
    liveHead = HEAD,
    reviewedHead = HEAD,
    comments = [quotaNotice({ at: '2026-09-09T09:50:28Z' })],
    reviews = [],
    reviewComments = [],
    reactions = [],
    threads = [],
    validation = 'passed/suite-661-green',
    p1 = '0',
    p2 = '0',
    found = '6',
    fixed = '6',
  } = overrides;

  const posted = [];
  let failure = null;
  const core = {
    setFailed: (m) => { failure = m; },
    info: () => {},
    warning: () => {},
    summary: { addHeading: () => core.summary, addList: () => core.summary, write: () => {} },
  };
  const github = {
    rest: {
      pulls: { get: async () => ({ data: { state: prState, head: { sha: liveHead } } }) },
      issues: { createComment: async (args) => { posted.push(args); } },
    },
    paginate: async (fn) => fn(),
    graphql: async () => ({
      repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: threads } } },
    }),
  };
  // github.paginate is called with the listing function; return the fixtures.
  github.rest.pulls.listReviews = () => reviews;
  github.rest.issues.listComments = () => comments;
  github.rest.pulls.listReviewComments = () => reviewComments;
  github.rest.reactions = { listForIssue: () => reactions };

  const fn = new Function(
    'github', 'context', 'core', 'process',
    `return (async () => {\n${producerScript()}\n})();`,
  );
  await fn(
    github,
    { repo: { owner: 'funzi7', repo: 'automation-core' }, ref },
    core,
    {
      env: {
        PR_NUMBER: '103',
        REVIEWED_HEAD: reviewedHead,
        FINDINGS_FOUND: found,
        FINDINGS_FIXED: fixed,
        UNRESOLVED_P1: p1,
        UNRESOLVED_P2: p2,
        VALIDATION: validation,
        RUN_ID: '4242',
        RUN_ATTEMPT: '1',
        CLAUDE_FALLBACK_REVIEW_ENABLED: enabled,
        DEFAULT_BRANCH: defaultBranch,
      },
    },
  );
  return { posted, failure };
}

test('producer: attests only when every canonical precondition holds', async () => {
  const ok = await attemptAttestation();
  assert.equal(ok.failure, null, `unexpected refusal: ${ok.failure}`);
  assert.equal(ok.posted.length, 1, 'exactly one attestation comment');
  const body = ok.posted[0].body;
  assert.match(body, /claude-fallback-review:v1/);
  assert.match(body, new RegExp(`reviewed_head=${HEAD}`));
  assert.match(body, /provider=claude_code_fallback/);
  assert.match(body, /verdict=clean/);
  assert.match(body, /unresolved_p1=0 unresolved_p2=0/);
  assert.match(body, /reason=codex_quota_unavailable/);
  assert.match(body, /not a Codex review/i, 'the comment must not read as a Codex review');
  // The parsed marker must satisfy the consumers' own validation.
  const parsed = parseFallbackAttestations(body)[0];
  assert.equal(
    evaluateFallbackAttestation(parsed, HEAD).accepted, true,
    'what the producer mints must be what consumers accept',
  );
});

test('producer: refuses every unsafe attestation', async () => {
  const cases = {
    'policy disabled': { enabled: 'false' },
    'dispatched from a non-default ref': { ref: 'refs/heads/claude/some-pr' },
    'unknown default branch': { defaultBranch: '' },
    'reviewed head is not the live head': { reviewedHead: PREVIOUS_HEAD },
    'malformed reviewed head': { reviewedHead: 'not-a-sha' },
    'closed PR': { prState: 'closed' },
    'no trusted quota notice': { comments: [] },
    'untrusted quota claim': { comments: [quotaNotice({ login: 'funzi7' })] },
    'unresolved P1 declared': { p1: '1' },
    'unresolved P2 declared': { p2: '3' },
    'more fixed than found': { found: '2', fixed: '5' },
    'non-passed validation': { validation: 'failed/suite-red' },
    'unstructured validation': { validation: 'suite-661-green' },
    'non-numeric counts': { found: 'many' },
  };
  for (const [label, override] of Object.entries(cases)) {
    const result = await attemptAttestation(override);
    assert.ok(result.failure, `producer must refuse: ${label}`);
    assert.equal(result.posted.length, 0, `producer must post nothing: ${label}`);
  }
});

test('producer: refuses when Codex is available or still has active findings', async () => {
  // A genuine Codex result on this exact head.
  const codexOnHead = await attemptAttestation({
    comments: [
      quotaNotice({ at: '2026-09-09T09:50:28Z' }),
      {
        user: { login: CODEX_REST },
        created_at: '2026-09-09T10:00:00Z',
        body: `**Reviewed commit:** \`${HEAD}\`\n\nNo findings.`,
      },
    ],
  });
  assert.ok(codexOnHead.failure, 'must defer to a genuine Codex result on this head');
  assert.equal(codexOnHead.posted.length, 0);

  // Codex's machine-written review-state summary (edited in place, so its
  // created_at predates the quota notice) naming a COMPLETED review of this
  // exact head is also a genuine result: the consumers bind through it, so
  // the producer must not mint an attestation they would then supersede.
  const reviewState = (sha, status = 'completed') =>
    '<!-- codex-pull-request-review-summary -->\n' +
    `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":false,` +
    `"has_unresolved_findings":false,"status":"${status}"},"security_review":{"commit_sha":null,` +
    '"has_any_findings":null,"has_unresolved_findings":null,"status":null}} -->\n\n' +
    '<details><summary><strong>Codex Review Summary</strong>: ✅ Completed</summary></details>';
  const summaryOnHead = await attemptAttestation({
    comments: [
      { user: { login: CODEX_REST }, created_at: '2026-09-09T01:00:00Z', body: reviewState(HEAD) },
      quotaNotice({ at: '2026-09-09T09:50:28Z' }),
    ],
  });
  assert.ok(summaryOnHead.failure, 'a completed review-state marker for this head is a genuine Codex result');
  assert.match(summaryOnHead.failure, /genuine result on this exact head/);
  assert.equal(summaryOnHead.posted.length, 0);
  // ...but a summary still in progress, or completed for another head, is not.
  for (const [label, body] of [
    ['in progress', reviewState(HEAD, 'in_progress')],
    ['previous head', reviewState(PREVIOUS_HEAD)],
  ]) {
    const notOnHead = await attemptAttestation({
      comments: [
        { user: { login: CODEX_REST }, created_at: '2026-09-09T01:00:00Z', body },
        quotaNotice({ at: '2026-09-09T09:50:28Z' }),
      ],
    });
    assert.equal(notOnHead.failure, null, `${label}: not a result on this head: ${notOnHead.failure}`);
    assert.equal(notOnHead.posted.length, 1, `${label}: the attestation is minted`);
  }

  // An active unresolved trusted Codex thread.
  const activeFinding = await attemptAttestation({
    threads: [{
      isResolved: false,
      isOutdated: false,
      path: 'core/x.py',
      line: 7,
      comments: { nodes: [{ body: '**P1** unsafe', author: { login: CODEX } }] },
    }],
  });
  assert.ok(activeFinding.failure, 'must refuse while a trusted Codex P1 is active');
  assert.equal(activeFinding.posted.length, 0);

  // Outdated is NOT resolved. Pushing a cosmetic change over an unaddressed
  // P1 strands it in an outdated thread; a fallback must not clear that.
  const outdatedFinding = await attemptAttestation({
    threads: [{
      isResolved: false,
      isOutdated: true,
      path: 'core/x.py',
      line: 7,
      comments: { nodes: [{ body: '**P1** unsafe', author: { login: CODEX } }] },
    }],
  });
  assert.ok(outdatedFinding.failure,
    'must refuse while a trusted Codex P1 is unresolved, even when outdated');
  assert.match(outdatedFinding.failure, /outdated/i);
  assert.equal(outdatedFinding.posted.length, 0);

  // A resolved thread does not block — that is the PR #103 shape.
  const resolved = await attemptAttestation({
    threads: [{
      isResolved: true,
      isOutdated: true,
      path: 'core/x.py',
      line: 7,
      comments: { nodes: [{ body: '**P2** fixed', author: { login: CODEX } }] },
    }],
  });
  assert.equal(resolved.failure, null, `resolved threads must not block: ${resolved.failure}`);
  assert.equal(resolved.posted.length, 1);

  // A thread too long to read in one page cannot be proven clean.
  const truncated = await attemptAttestation({
    threads: [{
      isResolved: true,
      isOutdated: false,
      path: 'core/x.py',
      line: 7,
      comments: { nodes: Array.from({ length: 100 }, () => ({ body: 'note', author: { login: CODEX } })) },
    }],
  });
  assert.ok(truncated.failure, 'an unreadable thread must fail closed');
  assert.equal(truncated.posted.length, 0);
});

test('producer: a trusted Codex reaction is Codex activity, exactly as the consumers count it', async () => {
  // Every consumer feeds trusted Codex reactions into realActivity, so a
  // reaction newer than the newest quota notice makes them reject the
  // attestation as quota_episode_closed. The producer must not mint it.
  const reaction = (at, login = CODEX_REST) => ({ user: { login }, content: '+1', created_at: at });

  const newer = await attemptAttestation({ reactions: [reaction('2026-09-09T09:55:00Z')] });
  assert.ok(newer.failure, 'must refuse when a trusted Codex reaction is newer than the quota notice');
  assert.match(newer.failure, /Codex reaction/);
  assert.equal(newer.posted.length, 0);

  // A same-second tie fails closed too: the consumers close the episode on
  // a tie because REST timestamps cannot prove which came last.
  const tie = await attemptAttestation({ reactions: [reaction('2026-09-09T09:50:28Z')] });
  assert.ok(tie.failure, 'a tie must refuse');
  assert.match(tie.failure, /Codex reaction/);
  assert.equal(tie.posted.length, 0);

  // Older than the notice: the notice still describes the present.
  const older = await attemptAttestation({ reactions: [reaction('2026-09-09T09:40:00Z')] });
  assert.equal(older.failure, null, `an older reaction must not refuse: ${older.failure}`);
  assert.equal(older.posted.length, 1);

  // An untrusted reaction is not Codex activity at all.
  const untrusted = await attemptAttestation({
    reactions: [reaction('2026-09-09T09:55:00Z', 'funzi7')],
  });
  assert.equal(untrusted.failure, null, `an untrusted reaction is not evidence: ${untrusted.failure}`);
  assert.equal(untrusted.posted.length, 1);

  // The same tie rule covers the other surfaces, and the message names them.
  const commentTie = await attemptAttestation({
    comments: [
      quotaNotice({ at: '2026-09-09T09:50:28Z' }),
      { user: { login: CODEX_REST }, created_at: '2026-09-09T09:50:28Z', body: 'Looking at this now.' },
    ],
  });
  assert.ok(commentTie.failure, 'a Codex comment in the same second as the notice must refuse');
  assert.match(commentTie.failure, /Codex comment/);
  assert.equal(commentTie.posted.length, 0);
});

test('the canonical producing workflow validates before it attests', () => {
  const producer = workflow('claude-fallback-review.yml');
  assert.match(producer, /workflow_dispatch/);
  assert.match(producer, /claude-fallback-review:v1/);
  // It must re-verify every authority-bearing precondition itself.
  assert.match(producer, /reviewed_head/);
  assert.match(producer, /isCodexCapacityNotice|trustedQuotaNotices/);
  assert.match(producer, /unresolved_p1/);
  assert.match(producer, /unresolved_p2/);
});
