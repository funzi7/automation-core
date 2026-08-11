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
    hasAutoProvenance || legacyAutomationProven
  );
  if (hasNeedsOwner && !transientEscalation) {
    return { eligible: false, reason: 'manual_needs_owner' };
  }
  if (pr.mergeable !== true) {
    return { eligible: false, reason: 'not_mergeable' };
  }

  const checks = evaluateHeadChecks(checkRuns, statuses);
  if (!checks.eligible) return checks;
  if (activeTrustedFinding) {
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
  SYNC_TITLE_PREFIX,
  SYNC_BRANCH,
  labelNames,
  isSameRepo,
  isOwnerSameRepo,
  isTrustedSync,
  isAutoMergeCandidate,
  latestChecksByName,
  evaluateHeadChecks,
  evaluateMergePolicy,
};
