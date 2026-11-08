'use strict';

/**
 * GITHUB_TOKEN permission regression guards.
 *
 * 2026-11-08 incident: Codex Gate declared `issues: write` but
 * `pull-requests: read`, and its trusted head-epoch marker — an issue comment
 * on a PULL REQUEST — failed with "Resource not accessible by integration" on
 * every pull_request_target run in every repository (paywall-bot #120/#122,
 * automation-core #58). Zero markers were ever written, so the authenticated
 * head-epoch model silently never engaged. The canonical fallback attestation
 * producer carried the identical defect. These tests pin the permission shape
 * every default-token PR-comment writer needs, so the same silent failure
 * cannot ship again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function workflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'workflows', name), 'utf8');
}

// The top-level `permissions:` map of a workflow, parsed line by line. The
// repository has no YAML dependency for node tests; the block is a flat map of
// `  key: value` lines (comments allowed) ending at the next top-level key.
function topLevelPermissions(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line === 'permissions:');
  assert.ok(start >= 0, 'workflow must declare top-level permissions');
  const scopes = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s+#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s+([a-z-]+):\s*([a-z]+)\s*(?:#.*)?$/);
    assert.ok(match, `unparseable permissions line: ${JSON.stringify(line)}`);
    scopes[match[1]] = match[2];
  }
  return scopes;
}

// Every github-script step that calls issues.createComment with the step's
// default token (no `github-token:` override on that step).
function defaultTokenCommentWriters(body) {
  const steps = body.split(/\n\s+- name: /).slice(1);
  return steps.filter((step) =>
    /uses:\s*actions\/github-script@/.test(step) &&
    /\.issues\.createComment\(/.test(step) &&
    !/github-token:/.test(step));
}

test('codex-gate.yml may write the head-epoch marker on a pull request', () => {
  const scopes = topLevelPermissions(workflow('codex-gate.yml'));
  assert.equal(scopes['pull-requests'], 'write',
    'the marker is a comment on a pull request; read was the 2026-11-08 failure');
  assert.equal(scopes.issues, 'write');
  // The rest of the declared surface is unchanged: reads plus the check publish.
  assert.equal(scopes.contents, 'read');
  assert.equal(scopes.actions, 'read');
  assert.equal(scopes.checks, 'write');
  assert.equal(scopes.statuses, undefined);
  assert.ok(defaultTokenCommentWriters(workflow('codex-gate.yml')).length >= 1,
    'the gate publishes its marker with the default token');
});

test('claude-fallback-review.yml may post its attestation on a pull request', () => {
  const scopes = topLevelPermissions(workflow('claude-fallback-review.yml'));
  assert.equal(scopes['pull-requests'], 'write',
    'the attestation is a comment on a pull request');
  assert.equal(scopes.issues, 'write');
  assert.equal(scopes.contents, 'read');
  // The producer must stay unable to mint checks or push code.
  assert.equal(scopes.checks, undefined);
  assert.equal(scopes.actions, undefined);
  assert.ok(defaultTokenCommentWriters(workflow('claude-fallback-review.yml')).length >= 1,
    'the producer posts its attestation with the default token');
});

test('every default-token PR comment writer declares pull-requests: write', () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'sync-config.json'), 'utf8',
  ));
  const checked = [];
  for (const name of config.synced_workflows) {
    const body = workflow(name);
    if (!/^permissions:$/m.test(body)) continue; // job-level permissions only
    const writers = defaultTokenCommentWriters(body);
    if (!writers.length) continue;
    // ci-doctor comments on the Issues it opens itself, never on a PR.
    if (name === 'ci-doctor.yml') continue;
    const scopes = topLevelPermissions(body);
    assert.equal(scopes['pull-requests'], 'write',
      `${name} comments on pull requests with the default token`);
    checked.push(name);
  }
  assert.ok(checked.includes('codex-gate.yml'));
  assert.ok(checked.includes('claude-fallback-review.yml'));
});

test('the gate never grants itself write scopes it does not use', () => {
  const scopes = topLevelPermissions(workflow('codex-gate.yml'));
  for (const scope of ['contents', 'actions', 'statuses', 'id-token', 'packages', 'deployments']) {
    assert.notEqual(scopes[scope], 'write', `codex-gate must not hold ${scope}: write`);
  }
  // No step may escalate to a PAT: the gate's authority is its trusted
  // default-branch identity, and its marker must be authored by
  // github-actions[bot] to be authenticated by every consumer.
  assert.doesNotMatch(workflow('codex-gate.yml'), /github-token:/);
  assert.doesNotMatch(workflow('codex-gate.yml'), /secrets\.AUTOMATION_PAT/);
});
