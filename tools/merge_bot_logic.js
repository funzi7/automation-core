'use strict';

/**
 * Pure mirror of Merge Bot's security-critical eligibility policy.
 *
 * The authoritative implementation remains inline in the trusted workflow.
 * This module exists only for deterministic regression tests; the workflow
 * must never load executable policy from a PR-controlled checkout.
 */

const OWNER_LOGIN = 'funzi7';
const CODEX_CHECK = 'check-codex-status';
const LABEL_AUTOMERGE = 'automerge';
const LABEL_ESCALATE = 'needs-owner';
const LABEL_ESCALATE_AUTO = 'needs-owner-auto';
const LABEL_NO_AUTOMERGE = 'no-automerge';
const CODEX_OVERRIDE_LABEL = 'codex-p1-acknowledged';
const SYNC_TITLE_PREFIX = 'chore(automation): sync from automation-core';
const SYNC_BRANCH = 'chore/sync-automation-core';
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

function labelNames(pr) {
  return new Set((pr?.labels || []).map((label) => label?.name || label));
}

function isSameRepo(pr, repositoryFullName) {
  return !!(
    pr?.head?.repo?.full_name &&
    pr.head.repo.full_name === repositoryFullName
  );
}

function isOwnerSameRepo(pr, repositoryFullName) {
  return isSameRepo(pr, repositoryFullName) && pr?.user?.login === OWNER_LOGIN;
}

function isClaudeBot(login) {
  return !!login && login.endsWith('[bot]') && login.toLowerCase().includes('claude');
}

function isTrustedSync(pr, repositoryFullName) {
  if (!String(pr?.title || '').startsWith(SYNC_TITLE_PREFIX)) return false;
  if (!isSameRepo(pr, repositoryFullName)) return false;
  return pr?.user?.login === OWNER_LOGIN || pr?.head?.ref === SYNC_BRANCH;
}

function isAutoMergeCandidate(pr, repositoryFullName) {
  if (!pr || pr.state !== 'open' || pr.draft) return false;
  const labels = labelNames(pr);
  if (labels.has(LABEL_NO_AUTOMERGE)) return false;
  const sameRepo = isSameRepo(pr, repositoryFullName);
  const byClaudeBot = sameRepo && isClaudeBot(pr?.user?.login);
  const explicitlyLabeled = labels.has(LABEL_AUTOMERGE);
  const claudeBranch = sameRepo && String(pr?.head?.ref || '').startsWith('claude/');
  return (
    isOwnerSameRepo(pr, repositoryFullName) || byClaudeBot ||
    explicitlyLabeled || isTrustedSync(pr, repositoryFullName) || claudeBranch
  );
}

function recency(check) {
  return new Date(check?.completed_at || check?.started_at || 0).getTime();
}

function latestChecksByName(checkRuns) {
  const seen = new Set();
  return [...(checkRuns || [])]
    .filter((check) => check?.conclusion !== 'cancelled')
    .sort((a, b) => recency(b) - recency(a))
    .filter((check) => {
      if (seen.has(check.name)) return false;
      seen.add(check.name);
      return true;
    });
}

function latestLabelEvent(events = [], labelName) {
  return events
    .filter((event) =>
      (event?.event === 'labeled' || event?.event === 'unlabeled') &&
      event?.label?.name === labelName
    )
    .sort((a, b) =>
      new Date(b?.created_at || 0) - new Date(a?.created_at || 0) ||
      Number(b?.id || 0) - Number(a?.id || 0)
    )[0];
}

function companionAutomationProvenance(events = []) {
  const needs = latestLabelEvent(events, LABEL_ESCALATE);
  const auto = latestLabelEvent(events, LABEL_ESCALATE_AUTO);
  if (needs?.event !== 'labeled' || auto?.event !== 'labeled') return false;
  if (!['github-actions[bot]', OWNER_LOGIN].includes(auto?.actor?.login)) return false;
  const needsAt = new Date(needs.created_at || 0).getTime();
  const autoAt = new Date(auto.created_at || 0).getTime();
  if (!Number.isFinite(needsAt) || !Number.isFinite(autoAt)) return false;
  const ordered = autoAt > needsAt || (
    autoAt === needsAt && Number(auto.id || 0) >= Number(needs.id || 0)
  );
  return ordered && autoAt - needsAt <= 5 * 60 * 1000;
}

function legacyAutomationProvenance(events = [], comments = []) {
  const latest = latestLabelEvent(events, LABEL_ESCALATE);
  if (latest?.event !== 'labeled') return false;
  if (!latest) return false;
  const latestAt = new Date(latest.created_at || 0).getTime();
  const nearbyWatchdogMarker = comments.some((comment) => {
    const body = String(comment?.body || '');
    const commentAt = new Date(comment?.created_at || 0).getTime();
    return (
      /<!-- ai-loop:v1\b[^>]*\bagent=watchdog\b[^>]*\bstate=escalated\b[^>]*-->/i.test(body) &&
      Number.isFinite(commentAt) && Number.isFinite(latestAt) &&
      Math.abs(commentAt - latestAt) <= 5 * 60 * 1000
    );
  });
  const circuitBreakerMarkers = comments.filter((comment) => {
    const body = String(comment?.body || '');
    const commentAt = new Date(comment?.created_at || 0).getTime();
    return (
      ['github-actions[bot]', OWNER_LOGIN].includes(comment?.user?.login || comment?.author?.login) &&
      body.includes('[auto-triggered]') &&
      /<!-- ai-loop:v1\b[^>]*\battempt=\d+\b[^>]*\bagent=claude\b[^>]*\bstate=requested\b[^>]*-->/i.test(body) &&
      Number.isFinite(commentAt) && Number.isFinite(latestAt) &&
      commentAt <= latestAt && latestAt - commentAt <= 6 * 60 * 60 * 1000
    );
  });
  const positiveTemporaryEvidence = (
    (latest?.actor?.login === 'github-actions[bot]' && circuitBreakerMarkers.length >= 3) ||
    (latest?.actor?.login === OWNER_LOGIN && nearbyWatchdogMarker)
  );
  if (!positiveTemporaryEvidence) return false;
  return !comments.some((comment) => {
    const body = String(comment?.body || '');
    return (
      /Auto-merge blocked: this PR touches protected path/i.test(body) ||
      /skipped this fork-headed PR/i.test(body) ||
      /fork-headed PR[^\n]*Escalated to needs-owner/is.test(body)
    );
  });
}

function evaluateHeadChecks(checkRuns, statuses) {
  const latestChecks = latestChecksByName(checkRuns);
  let running = false;
  let failed = false;
  for (const check of latestChecks) {
    if (check.status !== 'completed') running = true;
    else if (!OK_CONCLUSIONS.has(check.conclusion)) failed = true;
  }

  const latestStatuses = new Map();
  for (const status of statuses || []) {
    if (!latestStatuses.has(status.context)) {
      latestStatuses.set(status.context, status.state);
    }
  }
  for (const state of latestStatuses.values()) {
    if (state === 'pending') running = true;
    else if (state !== 'success') failed = true;
  }

  if (failed) return { eligible: false, reason: 'failed_check', latestChecks };
  if (running) return { eligible: false, reason: 'running_check', latestChecks };
  const codex = latestChecks.find((check) => check.name === CODEX_CHECK);
  if (!codex || codex.status !== 'completed' || codex.conclusion !== 'success') {
    return { eligible: false, reason: 'missing_or_red_codex_gate', latestChecks };
  }
  return { eligible: true, reason: 'checks_green', latestChecks };
}

function evaluateMergePolicy({
  pr,
  repositoryFullName,
  checkRuns = [],
  statuses = [],
  activeTrustedFinding = false,
  protectedPathHit = false,
  legacyAutomationProven = false,
  companionAutomationProven = false,
  evaluatedHead = pr?.head?.sha,
  currentHead = pr?.head?.sha,
} = {}) {
  if (!isAutoMergeCandidate(pr, repositoryFullName)) {
    return { eligible: false, reason: 'not_candidate' };
  }

  const labels = labelNames(pr);
  if (labels.has(LABEL_NO_AUTOMERGE)) {
    return { eligible: false, reason: 'no_automerge' };
  }
  const hasNeedsOwner = labels.has(LABEL_ESCALATE);
  const hasAutoProvenance = labels.has(LABEL_ESCALATE_AUTO);
  const transientEscalation = hasNeedsOwner && (
    (hasAutoProvenance && companionAutomationProven) || legacyAutomationProven
  );
  if (hasNeedsOwner && !transientEscalation) {
    return { eligible: false, reason: 'manual_needs_owner' };
  }
  if (pr.mergeable !== true) {
    return { eligible: false, reason: 'not_mergeable' };
  }

  const checks = evaluateHeadChecks(checkRuns, statuses);
  if (!checks.eligible) return checks;
  if (activeTrustedFinding && !labels.has(CODEX_OVERRIDE_LABEL)) {
    return { eligible: false, reason: 'active_trusted_finding' };
  }
  if (protectedPathHit && !isOwnerSameRepo(pr, repositoryFullName)) {
    return { eligible: false, reason: 'protected_path_untrusted' };
  }
  if (!evaluatedHead || currentHead !== evaluatedHead || pr?.head?.sha !== evaluatedHead) {
    return { eligible: false, reason: 'head_moved' };
  }
  return {
    eligible: true,
    reason: 'fully_green',
    clearTransient: transientEscalation,
    clearLegacy: transientEscalation && !hasAutoProvenance,
  };
}

module.exports = {
  OWNER_LOGIN,
  CODEX_CHECK,
  LABEL_AUTOMERGE,
  LABEL_ESCALATE,
  LABEL_ESCALATE_AUTO,
  LABEL_NO_AUTOMERGE,
  CODEX_OVERRIDE_LABEL,
  SYNC_TITLE_PREFIX,
  SYNC_BRANCH,
  labelNames,
  isSameRepo,
  isOwnerSameRepo,
  isTrustedSync,
  isAutoMergeCandidate,
  latestChecksByName,
  companionAutomationProvenance,
  legacyAutomationProvenance,
  evaluateHeadChecks,
  evaluateMergePolicy,
};
