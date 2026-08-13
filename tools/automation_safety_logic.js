'use strict';

/**
 * Pure mirrors of safety helpers that remain inline in trusted workflow YAML.
 * Workflows must not import this PR-controlled file; deterministic tests use it
 * to exercise normalization and dedupe edge cases.
 */

const LARGE_SCRIPT_EXPRESSION_THRESHOLD = 10_000;

const INTERNAL_AUTOMATION_NAMES = new Set([
  'CI Doctor',
  'Claude Fixer',
  'Merge Bot',
  'Sync from automation-core',
  'Codex Gate',
  'Codex Auto-Fix',
  'Codex Backup Fix',
  'Claude Fallback Watchdog',
  'Minutes Guard',
  'Bootstrap repos',
  'Loop Morning Report',
]);

const INTERNAL_AUTOMATION_PATHS = new Set([
  '.github/workflows/codex-gate.yml',
  '.github/workflows/codex-auto-fix.yml',
  '.github/workflows/claude.yml',
  '.github/workflows/ci-doctor.yml',
  '.github/workflows/merge-bot.yml',
  '.github/workflows/claude-fallback-watchdog.yml',
  '.github/workflows/codex-backup-fix.yml',
  '.github/workflows/bootstrap.yml',
  '.github/workflows/sync-automation-core.yml',
  '.github/workflows/minutes-guard.yml',
  '.github/workflows/telegram-morning-report.yml',
]);

function largeGithubScriptHasDirectExpression(
  script,
  threshold = LARGE_SCRIPT_EXPRESSION_THRESHOLD,
) {
  return Buffer.byteLength(String(script || ''), 'utf8') >= threshold &&
    String(script || '').includes('${{');
}

function githubScriptHasUnquotedExpression(script) {
  const source = String(script || '');
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const pair = source.slice(index, index + 2);
    if (state === 'code') {
      if (source.startsWith('${{', index)) return true;
      if (pair === '//') {
        state = 'line-comment';
        index += 1;
      } else if (pair === '/*') {
        state = 'block-comment';
        index += 1;
      } else if (source[index] === "'" || source[index] === '"') {
        state = source[index];
      } else if (source[index] === '`') {
        state = 'template';
      }
    } else if (state === "'" || state === '"') {
      if (source.startsWith('${{', index)) {
        const end = source.indexOf('}}', index + 3);
        if (end < 0) return true;
        index = end + 1;
      } else if (source[index] === '\\') {
        index += 1;
      } else if (source[index] === state) {
        state = 'code';
      }
    } else if (state === 'template') {
      if (source.startsWith('${{', index)) return true;
      if (source[index] === '\\') index += 1;
      else if (source[index] === '`') state = 'code';
    } else if (state === 'line-comment') {
      if (source[index] === '\n') state = 'code';
    } else if (state === 'block-comment' && pair === '*/') {
      state = 'code';
      index += 1;
    }
  }
  return false;
}

function normalizeFailure(error) {
  const rawStatus = Number(error?.status);
  const status = Number.isFinite(rawStatus) ? String(rawStatus) : 'unknown';
  const message = String(error?.message || error || 'error')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\(\s*line:\s*\d+\s*,\s*col:\s*\d+\s*\)/g, '(line:<n>,col:<n>)')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\b\d{6,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return `${status}:${message}`;
}

function failureFingerprint(error) {
  const normalized = normalizeFailure(error);
  let hash = 2166136261;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseLoopMarkers(body) {
  const markers = [];
  const pattern = /<!--\s*ai-loop:v1\b([^>]*)-->/g;
  let match;
  while ((match = pattern.exec(String(body || ''))) !== null) {
    const attributes = {};
    for (const part of match[1].trim().split(/\s+/)) {
      const equals = part.indexOf('=');
      if (equals > 0) attributes[part.slice(0, equals)] = part.slice(equals + 1);
    }
    markers.push(attributes);
  }
  return markers;
}

function failureAlertMarker({ prNumber, headSha, operation, fingerprint }) {
  return `<!-- ai-loop:v1 root_pr=${prNumber} head=${headSha} agent=watchdog state=failure_alerted op=${operation} error=${fingerprint} -->`;
}

function hasFailureAlertMarker(
  comments,
  { ownerLogin, prNumber, headSha, operation, fingerprint },
) {
  const trusted = new Set([ownerLogin, 'github-actions[bot]']);
  return (comments || []).some((comment) => {
    const login = comment?.user?.login || comment?.author?.login || '';
    if (!trusted.has(login)) return false;
    return parseLoopMarkers(comment?.body).some((marker) =>
      marker.root_pr === String(prNumber) &&
      marker.head === headSha &&
      marker.agent === 'watchdog' &&
      marker.state === 'failure_alerted' &&
      marker.op === operation &&
      marker.error === fingerprint
    );
  });
}

function normalizeWorkflowPath(value) {
  return String(value || '')
    .trim()
    .split('@')[0]
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function isInternalAutomationRun(run) {
  const name = String(run?.name || '');
  return INTERNAL_AUTOMATION_NAMES.has(name) ||
    INTERNAL_AUTOMATION_PATHS.has(normalizeWorkflowPath(run?.path)) ||
    INTERNAL_AUTOMATION_PATHS.has(normalizeWorkflowPath(name));
}

module.exports = {
  LARGE_SCRIPT_EXPRESSION_THRESHOLD,
  INTERNAL_AUTOMATION_NAMES,
  INTERNAL_AUTOMATION_PATHS,
  largeGithubScriptHasDirectExpression,
  githubScriptHasUnquotedExpression,
  normalizeFailure,
  failureFingerprint,
  parseLoopMarkers,
  failureAlertMarker,
  hasFailureAlertMarker,
  normalizeWorkflowPath,
  isInternalAutomationRun,
};
