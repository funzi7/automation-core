'use strict';

/**
 * Canonical exact-head review-evidence decision.
 *
 * Codex Gate, Merge Bot and the Claude Fallback Watchdog must all reach the
 * SAME verdict from the SAME rules. The old assumption
 *
 *   valid review == Codex review
 *
 * is replaced by the canonical contract
 *
 *   valid exact-head review evidence ==
 *     normal Codex evidence
 *     OR approved Claude fallback evidence when Codex is provably unavailable
 *
 * Everything here is pure. Trust establishment (who authored a comment, and
 * whether the run that claims to have produced an attestation really exists)
 * happens in the trusted workflow, which passes only already-authenticated
 * material into these functions. The authoritative implementation stays inline
 * in the trusted workflow YAML; this module exists so the identical rules can
 * be exercised deterministically and so the three workflows cannot drift.
 */

const {
  decideCodexGate,
  isCodexCapacityNotice,
  TRUSTED_CODEX_LOGINS,
} = require('./codex_gate_logic');

// The attestation is a single atomic HTML marker. Every canonical field lives
// inside it, so a partially-forged body cannot contribute individual fields.
const CLAUDE_FALLBACK_MARKER_PATTERN =
  /<!--\s*claude-fallback-review:v1\b([^>]*)-->/gi;

const FALLBACK_PROVIDER = 'claude_code_fallback';
const FALLBACK_REASON = 'codex_quota_unavailable';
const FALLBACK_VERDICT = 'clean';

// The workflow that is allowed to produce an attestation. A marker naming any
// other workflow path is not evidence, however well-formed it looks.
const FALLBACK_ATTESTATION_WORKFLOW_PATH =
  '.github/workflows/claude-fallback-review.yml';

// Route B bound: a decline from an earlier head epoch authorizes a fallback
// only this long, so stale evidence cannot authorize a later unrelated
// fallback forever.
const QUOTA_EPISODE_TTL_MS = 24 * 60 * 60 * 1000;

// validation is `<status>/<reference>`, and only a PASSED status can carry
// evidence: a failed or unknown validation must never mint a clean
// attestation. The marker is whitespace-delimited, so no spaces or `>`.
const VALIDATION_TOKEN_PATTERN = /^passed\/[A-Za-z0-9._:#=,;+()-]{1,180}$/;

function parseMarkerAttributes(attributes) {
  const parsed = {};
  for (const part of String(attributes || '').trim().split(/\s+/)) {
    if (!part) continue;
    const equals = part.indexOf('=');
    if (equals > 0) parsed[part.slice(0, equals)] = part.slice(equals + 1);
  }
  return parsed;
}

/**
 * Extract every `claude-fallback-review:v1` marker from one comment body.
 * Parsing alone confers no trust whatsoever.
 */
function parseFallbackAttestations(body) {
  const found = [];
  const pattern = new RegExp(
    CLAUDE_FALLBACK_MARKER_PATTERN.source,
    CLAUDE_FALLBACK_MARKER_PATTERN.flags,
  );
  let match;
  while ((match = pattern.exec(String(body || ''))) !== null) {
    found.push(parseMarkerAttributes(match[1]));
  }
  return found;
}

/**
 * Trusted quota evidence: authored by the real Codex connector identity AND
 * matching the connector's own code-review usage-limit wording. A user, a
 * Claude comment or any other bot writing "Codex unavailable" is never this.
 */
function trustedQuotaNotices(items = []) {
  return (items || []).filter((item) =>
    TRUSTED_CODEX_LOGINS.has(
      String(item?.user?.login || item?.author?.login || ''),
    ) && isCodexCapacityNotice(item?.body)
  );
}

/**
 * An attestation comment counts only when the trusted automation identity
 * authored it. PR-controlled content cannot author as this identity, so
 * untrusted PR bodies and ordinary issue comments can never inject one.
 */
function isTrustedAttestationAuthor(comment, botLogin = 'github-actions[bot]') {
  return String(comment?.user?.login || comment?.author?.login || '') === botLogin;
}

/**
 * Authenticated-run check for an attestation marker, mirroring the proven
 * `codex-head-epoch` model: the referenced run must really be an execution of
 * the canonical producing workflow in this repository, and the comment must
 * have been written while that run was alive. Callers must fail closed when
 * the run lookup itself fails.
 */
function attestationRunIsTrusted(run, {
  attempt,
  commentAt,
  defaultBranch = null,
  workflowPath = FALLBACK_ATTESTATION_WORKFLOW_PATH,
  skewMs = 5000,
} = {}) {
  if (!run) return false;
  // Only the canonical producer workflow may mint evidence, and only when it
  // ran from the trusted default branch through an explicit dispatch (which
  // requires write access). A run started from a PR ref would execute
  // PR-controlled YAML.
  if (String(run.path || '') !== workflowPath) return false;
  if (String(run.event || '') !== 'workflow_dispatch') return false;
  if (defaultBranch && String(run.head_branch || '') !== String(defaultBranch)) return false;
  if (Number(run.run_attempt) !== Number(attempt)) return false;
  const startedAt = new Date(run.run_started_at || run.created_at || 0).getTime();
  const finishedAt = new Date(run.updated_at || 0).getTime();
  const at = Number(commentAt);
  if (!Number.isFinite(at) || !Number.isFinite(startedAt) || startedAt <= 0) return false;
  if (at < startedAt - skewMs) return false;
  if (run.status === 'completed' && at > finishedAt + skewMs) return false;
  return true;
}

function nonNegativeInteger(value) {
  if (!/^\d{1,9}$/.test(String(value ?? ''))) return null;
  return Number(value);
}

/**
 * Structural validation of one attestation against the exact current head.
 *
 * `blocking` is reserved for a well-formed exact-head attestation that itself
 * declares unresolved P1/P2 work: Claude reviewing its own head and reporting
 * unresolved severity is a real finding, not merely absent evidence.
 */
function evaluateFallbackAttestation(attestation, { headSha } = {}) {
  const exactHead = String(headSha || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(exactHead)) {
    return { accepted: false, blocking: false, reason: 'unknown_head' };
  }
  if (!attestation) {
    return { accepted: false, blocking: false, reason: 'no_attestation' };
  }

  if (String(attestation.provider || '') !== FALLBACK_PROVIDER) {
    return { accepted: false, blocking: false, reason: 'wrong_provider' };
  }
  // Exact-head binding. A previous-head attestation, or any attestation left
  // behind by an earlier commit, is not evidence for this head.
  const reviewedHead = String(attestation.reviewed_head || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(reviewedHead)) {
    return { accepted: false, blocking: false, reason: 'malformed_reviewed_head' };
  }
  if (reviewedHead !== exactHead) {
    return { accepted: false, blocking: false, reason: 'reviewed_head_mismatch' };
  }
  if (String(attestation.reason || '') !== FALLBACK_REASON) {
    return { accepted: false, blocking: false, reason: 'wrong_reason' };
  }

  const found = nonNegativeInteger(attestation.findings_found);
  const fixed = nonNegativeInteger(attestation.findings_fixed);
  const unresolvedP1 = nonNegativeInteger(attestation.unresolved_p1);
  const unresolvedP2 = nonNegativeInteger(attestation.unresolved_p2);
  if (found === null || fixed === null || unresolvedP1 === null || unresolvedP2 === null) {
    return { accepted: false, blocking: false, reason: 'malformed_counts' };
  }
  if (fixed > found) {
    return { accepted: false, blocking: false, reason: 'malformed_counts' };
  }

  const validation = String(attestation.validation || '');
  if (!VALIDATION_TOKEN_PATTERN.test(validation)) {
    return { accepted: false, blocking: false, reason: 'missing_validation' };
  }

  if (unresolvedP1 > 0 || unresolvedP2 > 0) {
    return {
      accepted: false,
      blocking: true,
      reason: 'unresolved_fallback_finding',
      severity: unresolvedP1 > 0 ? 'P1' : 'P2',
    };
  }
  if (String(attestation.verdict || '') !== FALLBACK_VERDICT) {
    return { accepted: false, blocking: false, reason: 'verdict_not_clean' };
  }

  return {
    accepted: true,
    blocking: false,
    reason: 'structured_fallback_clean',
    findingsFound: found,
    findingsFixed: fixed,
    validation,
  };
}

/**
 * Is a trusted Codex quota/capacity episode active for THIS head right now?
 *
 * `notices` must already be filtered by the caller to bodies that a trusted
 * Codex identity actually authored and that `isCodexCapacityNotice` matched,
 * so they are review-relevant and unforgeable by ordinary PR/issue comments.
 *
 * The episode is bound to the current head epoch: a notice from an earlier
 * head never authorizes a fallback on a later head. Without an authenticated
 * head-transition observation there is no episode at all (fail closed).
 */
function evaluateQuotaEpisode(notices = [], {
  headObservedAt = null,
  realActivity = [],
  attestedAt = null,
  codexSignalOnHead = false,
} = {}) {
  const itemAt = (item) => new Date(
    item?.created_at || item?.submitted_at || item?.at || 0,
  ).getTime();
  const newestOf = (items) => {
    let newest = null;
    for (const item of items || []) {
      const at = itemAt(item);
      if (!Number.isFinite(at) || at <= 0) continue;
      if (newest === null || at > newest) newest = at;
    }
    return newest;
  };
  // Codex answering on this head is a materially new availability state: the
  // episode is over and genuine Codex evidence is the authority.
  if (codexSignalOnHead) {
    return { active: false, reason: 'codex_available_on_head', noticeAt: null };
  }
  const newestNotice = newestOf(notices);
  if (newestNotice === null) {
    return { active: false, reason: 'no_quota_notice', noticeAt: null };
  }
  const newestReal = newestOf(realActivity);
  if (newestReal !== null && newestReal > newestNotice) {
    return {
      active: false, reason: 'quota_episode_closed', noticeAt: new Date(newestNotice),
    };
  }
  const observedAt = new Date(headObservedAt || 0).getTime();
  if (!Number.isFinite(observedAt) || observedAt <= 0) {
    return { active: false, reason: 'head_epoch_unknown', noticeAt: null };
  }
  // Route A — Codex declined on THIS head epoch.
  if (newestNotice >= observedAt) {
    return {
      active: true, reason: 'trusted_quota_episode', noticeAt: new Date(newestNotice),
    };
  }
  // Route B — the decline predates this head epoch, Codex has posted nothing
  // since, and the fallback review was attested within the TTL of it.
  const attested = Number(attestedAt);
  if (
    Number.isFinite(attested) && attested >= newestNotice &&
    attested - newestNotice <= QUOTA_EPISODE_TTL_MS
  ) {
    return {
      active: true, reason: 'trusted_quota_episode', noticeAt: new Date(newestNotice),
    };
  }
  return {
    active: false, reason: 'stale_quota_evidence', noticeAt: new Date(newestNotice),
  };
}

/**
 * Human-readable provenance. It must never claim Codex reviewed anything that
 * Claude actually reviewed.
 */
function reviewEvidenceProvenance(authority) {
  if (authority === 'codex') return 'Codex exact-head review accepted';
  if (authority === FALLBACK_PROVIDER) {
    return 'Claude Code fallback review accepted for exact head; Codex quota unavailable';
  }
  return 'No accepted exact-head review evidence';
}

/**
 * The one canonical decision.
 *
 * `verifiedAttestations` are attestations whose producing workflow run the
 * caller has already authenticated; `quotaNotices` are trusted-actor quota
 * notices. Normal Codex evidence keeps its exact previous behaviour: fallback
 * is only ever consulted as an additional way to satisfy the current-head
 * signal, and it never suppresses a Codex finding.
 */
function decideReviewEvidence({
  headSha,
  threads = [],
  nonInlineFindings = [],
  codexSignalOnHead = false,
  verifiedAttestations = [],
  quotaNotices = [],
  realActivity = [],
  attestedAt = Date.now(),
  headObservedAt = null,
  fallbackPolicyEnabled = false,
  override = false,
  technicalError = false,
} = {}) {
  const episode = evaluateQuotaEpisode(quotaNotices, {
    headObservedAt, realActivity, attestedAt, codexSignalOnHead,
  });

  // Genuine Codex evidence on this head is the authority, so the fallback is
  // not consulted at all — matching the inline block, which short-circuits on
  // the same condition. Without this, a leftover attestation could still block
  // a head that Codex has just reviewed.
  let fallback = codexSignalOnHead
    ? { accepted: false, blocking: false, reason: 'codex_available_on_head' }
    : { accepted: false, blocking: false, reason: 'no_attestation' };
  if (!codexSignalOnHead) {
    for (const attestation of verifiedAttestations || []) {
      const evaluated = evaluateFallbackAttestation(attestation, { headSha });
      if (evaluated.blocking) { fallback = evaluated; break; }
      if (evaluated.accepted) fallback = evaluated;
      else if (fallback.reason === 'no_attestation') fallback = evaluated;
    }
  }

  // Policy gate and episode proof are preconditions for ACCEPTING fallback.
  // They never soften a blocking self-declared finding.
  let fallbackReason = fallback.reason;
  let fallbackAccepted = fallback.accepted;
  if (fallbackAccepted && !fallbackPolicyEnabled) {
    fallbackAccepted = false;
    fallbackReason = 'fallback_policy_disabled';
  }
  if (fallbackAccepted && !episode.active) {
    fallbackAccepted = false;
    fallbackReason = episode.reason;
  }

  // A self-declared unresolved exact-head P1/P2 blocks before anything else
  // can read it as a clean signal.
  const fallbackFindings = fallback.blocking
    ? [{
        severity: fallback.severity || 'P1',
        path: '(claude fallback attestation)',
        line: null,
        startLine: null,
        threadId: '',
      }]
    : [];

  const base = decideCodexGate({
    threads,
    nonInlineFindings,
    currentHeadSignal: codexSignalOnHead || fallbackAccepted,
    override,
    technicalError,
  });

  // Genuine Codex findings and active threads keep their absolute precedence:
  // decideCodexGate blocks on them before it ever consults a head signal, so a
  // fallback can never erase or bypass real Codex findings.
  if (base.status === 'blocked' || override || technicalError) {
    return {
      ...base,
      authority: 'none',
      fallbackReason,
      quotaEpisode: episode,
      provenance: override
        ? 'Administrator override — no review evidence claimed'
        : technicalError
          ? 'Technical fail-soft — no review evidence claimed'
          : 'Blocked by active exact-head findings',
    };
  }

  if (fallback.blocking) {
    return {
      status: 'blocked',
      reason: 'unresolved_fallback_finding',
      activeFindings: fallbackFindings,
      outdatedFindings: base.outdatedFindings || [],
      authority: 'none',
      fallbackReason,
      quotaEpisode: episode,
      provenance:
        'Claude Code fallback review reports unresolved P1/P2 on the exact head',
    };
  }

  // Normal Codex evidence stays the default authority whenever it exists.
  const authority = codexSignalOnHead
    ? 'codex'
    : (base.status === 'clear' && fallbackAccepted) ? FALLBACK_PROVIDER : 'none';

  return {
    ...base,
    authority,
    fallbackReason,
    quotaEpisode: episode,
    // When the accepted evidence was recorded; consumers use it to avoid
    // repeating work that already ran after the attestation.
    attestedAt: fallbackAccepted ? attestedAt : null,
    provenance: reviewEvidenceProvenance(authority),
  };
}

module.exports = {
  CLAUDE_FALLBACK_MARKER_PATTERN,
  FALLBACK_PROVIDER,
  FALLBACK_REASON,
  FALLBACK_VERDICT,
  FALLBACK_ATTESTATION_WORKFLOW_PATH,
  QUOTA_EPISODE_TTL_MS,
  VALIDATION_TOKEN_PATTERN,
  parseMarkerAttributes,
  parseFallbackAttestations,
  trustedQuotaNotices,
  isTrustedAttestationAuthor,
  attestationRunIsTrusted,
  evaluateFallbackAttestation,
  evaluateQuotaEpisode,
  reviewEvidenceProvenance,
  decideReviewEvidence,
};
