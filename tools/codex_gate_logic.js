'use strict';

/**
 * Pure Codex Gate decision logic.
 *
 * A review finding is authoritative only when it belongs to an inline review
 * thread, was written by a trusted Codex actor, and has a real line-leading
 * P1/P2 marker after Summary/Testing quote sections are removed. Commit time
 * is deliberately irrelevant to finding liveness.
 */

// GitHub exposes the same installed App as an unsuffixed Bot login in
// GraphQL review threads and with the conventional [bot] suffix on REST
// review/reaction surfaces. Trust exactly those two identities.
const TRUSTED_CODEX_LOGINS = new Set([
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
]);
const P1_PATTERN = /(?:P1-orange|(?:^|\n)[\s>*\-_#`]*(?:\*\*\s*P1\s*\*\*|\[P1\]|P1:))/i;
const P2_PATTERN = /(?:P2-yellow|(?:^|\n)[\s>*\-_#`]*(?:\*\*\s*P2\s*\*\*|\[P2\]|P2:))/i;
const REVIEWED_COMMIT_PATTERN = /(?:^|\n)\*\*Reviewed commit:\*\*\s*`([a-f0-9]{10,40})`(?:\s|$)/i;
const HEAD_EPOCH_MARKER_PATTERN = /<!--\s*codex-head-epoch:v3\s+run=(\d+)\s+attempt=(\d+)\s+pr=(\d+)\s+head=([a-f0-9]{40})\s*-->/i;

function isCodexCapacityNotice(body) {
  const text = String(body || '').trim();
  return /^You have reached your Codex usage limits for code reviews\./i.test(text) ||
    /^Codex (?:is|was) (?:currently )?(?:at capacity|unable to (?:complete|perform) (?:this )?code review)/i.test(text);
}

function isCodexTaskResult(body) {
  const text = String(body || '');
  return /(?:^|\n)#{2,3}\s+Summary(?:\s|$)/i.test(text) &&
    /\[View task(?:\s*(?:→|->))?\s*\]\(/i.test(text);
}

function signalTargetsHead(item, headSha, headObservedAt = null, dateField = 'created_at') {
  const exactHead = String(headSha || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(exactHead)) return false;
  if (isCodexTaskResult(item?.body)) return false;
  const originalCommit = String(item?.original_commit_id || '').toLowerCase();
  if (originalCommit) return originalCommit === exactHead;
  const commit = String(item?.commit_id || '').toLowerCase();
  if (commit) return commit === exactHead;
  const marker = String(item?.body || '').match(REVIEWED_COMMIT_PATTERN)?.[1]?.toLowerCase();
  if (marker) return exactHead.startsWith(marker);
  // Timing alone cannot bind an asynchronous result to a head: an old-head
  // task can finish after a new push. Affirmative signals must name a commit.
  return false;
}

function reactionTargetsOnlyObservedHead(reaction, headObservedAt, onlyObservedHead) {
  if (!onlyObservedHead || reaction?.content !== '+1') return false;
  const reactionAt = new Date(reaction?.created_at || 0).getTime();
  const observedAt = new Date(headObservedAt || 0).getTime();
  return Number.isFinite(reactionAt) && Number.isFinite(observedAt) &&
    observedAt > 0 && reactionAt > observedAt;
}

function currentHeadEpochStart(runs = [], prNumber, headSha) {
  const timeline = runs
    .filter((run) =>
      (run?.pull_requests || []).some((candidate) => candidate.number === prNumber))
    .sort((a, b) =>
      new Date(b?.created_at || 0).getTime() - new Date(a?.created_at || 0).getTime());
  // If Actions has not observed the live head yet, do not reuse an older
  // historical epoch for the same SHA.
  if (!timeline.length || String(timeline[0]?.head_sha || '') !== headSha) return null;
  const currentEpoch = [];
  for (const run of timeline) {
    if (String(run?.head_sha || '') !== headSha) break;
    const observedAt = new Date(run?.created_at || 0).getTime();
    if (Number.isFinite(observedAt) && observedAt > 0) currentEpoch.push(observedAt);
  }
  return currentEpoch.length ? new Date(Math.min(...currentEpoch)) : null;
}

function currentHeadEpochFromVerifiedRuns(markers = [], headSha) {
  const exactHead = String(headSha || '').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(exactHead)) return null;
  const timeline = markers
    .map((marker) => ({
      head: String(marker?.head || '').toLowerCase(),
      observedAt: new Date(marker?.observedAt || 0).getTime(),
      id: Number(marker?.id || 0),
    }))
    .filter((marker) =>
      /^[a-f0-9]{40}$/.test(marker.head) &&
      Number.isFinite(marker.observedAt) && marker.observedAt > 0)
    .sort((a, b) => b.observedAt - a.observedAt || b.id - a.id);
  if (!timeline.length || timeline[0].head !== exactHead) return null;
  const epoch = [];
  for (const marker of timeline) {
    if (marker.head !== exactHead) break;
    epoch.push(marker.observedAt);
  }
  return epoch.length ? new Date(Math.min(...epoch)) : null;
}

function selectHeadEpoch(markerEpoch, runEpoch, runHasBoundary = false) {
  // Verified markers are the unbounded source. A repository run page can be
  // truncated inside an unchanged-head epoch. It may advance the marker epoch
  // only when it proves an intervening different head.
  if (markerEpoch && runEpoch && runHasBoundary) {
    return new Date(Math.max(markerEpoch.getTime(), runEpoch.getTime()));
  }
  return markerEpoch || runEpoch || null;
}

function stripSummarySections(body) {
  if (!body) return '';
  return String(body)
    .replace(/(?:^|\n)#{2,3}\s+Summary[\s\S]*?(?=\n#{2,3}\s|\n---|$)/gi, '')
    .replace(/(?:^|\n)#{2,3}\s+Testing[\s\S]*?(?=\n#{2,3}\s|\n---|$)/gi, '');
}

function severity(body) {
  const semantic = stripSummarySections(body);
  if (P1_PATTERN.test(semantic)) return 'P1';
  if (P2_PATTERN.test(semantic)) return 'P2';
  return null;
}

function authorLogin(comment) {
  return String(
    comment?.author?.login || comment?.user?.login || comment?.authorLogin || ''
  );
}

function findingFromThread(thread) {
  for (const comment of thread?.comments || []) {
    const login = authorLogin(comment);
    if (!TRUSTED_CODEX_LOGINS.has(login)) continue;
    const level = severity(comment?.body || '');
    if (!level) continue;
    return {
      severity: level,
      path: String(thread?.path || ''),
      line: Number.isInteger(thread?.line) ? thread.line : null,
      startLine: Number.isInteger(thread?.startLine) ? thread.startLine : null,
      threadId: String(thread?.id || ''),
    };
  }
  return null;
}

function classifyThreads(threads) {
  const active = [];
  const outdated = [];
  const resolved = [];
  for (const thread of threads || []) {
    const finding = findingFromThread(thread);
    if (!finding) continue;
    if (thread?.isResolved === true) {
      resolved.push(finding);
    } else if (thread?.isOutdated === true) {
      outdated.push(finding);
    } else {
      active.push(finding);
    }
  }
  return { active, outdated, resolved };
}

function decideCodexGate({
  threads = [],
  nonInlineFindings = [],
  currentHeadSignal = false,
  override = false,
  technicalError = false,
} = {}) {
  if (override) {
    return { status: 'clear', reason: 'administrator_override', activeFindings: [] };
  }
  if (technicalError) {
    return { status: 'clear', reason: 'technical_fail_soft', activeFindings: [] };
  }

  if (nonInlineFindings.length) {
    return {
      status: 'blocked',
      reason: 'active_current_head_non_inline_finding',
      activeFindings: nonInlineFindings,
    };
  }

  const classified = classifyThreads(threads);
  if (classified.active.length) {
    return {
      status: 'blocked',
      reason: 'active_unresolved_review_thread',
      activeFindings: classified.active,
      outdatedFindings: classified.outdated,
    };
  }

  if (classified.outdated.length && !currentHeadSignal) {
    return {
      status: 'pending',
      reason: 'outdated_finding_needs_current_head_signal',
      activeFindings: [],
      outdatedFindings: classified.outdated,
    };
  }

  if (currentHeadSignal) {
    return {
      status: 'clear',
      reason: classified.outdated.length
        ? 'outdated_findings_and_current_head_signal'
        : 'current_head_signal_no_active_findings',
      activeFindings: [],
      outdatedFindings: classified.outdated,
    };
  }

  return {
    status: 'pending',
    reason: 'current_head_review_pending',
    activeFindings: [],
  };
}

module.exports = {
  TRUSTED_CODEX_LOGINS,
  P1_PATTERN,
  P2_PATTERN,
  REVIEWED_COMMIT_PATTERN,
  HEAD_EPOCH_MARKER_PATTERN,
  isCodexCapacityNotice,
  isCodexTaskResult,
  signalTargetsHead,
  reactionTargetsOnlyObservedHead,
  currentHeadEpochStart,
  currentHeadEpochFromVerifiedRuns,
  selectHeadEpoch,
  stripSummarySections,
  severity,
  findingFromThread,
  classifyThreads,
  decideCodexGate,
};
