'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  LARGE_SCRIPT_EXPRESSION_THRESHOLD,
  largeGithubScriptHasDirectExpression,
  githubScriptHasUnquotedExpression,
  failureFingerprint,
  failureAlertMarker,
  hasFailureAlertMarker,
  isInternalAutomationRun,
} = require('../tools/automation_safety_logic');

const ROOT = path.join(__dirname, '..');
const HEAD = 'a'.repeat(40);

function githubScriptBodies(workflow) {
  const lines = workflow.split('\n');
  const bodies = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/uses:\s*actions\/github-script@/.test(lines[index])) continue;
    const usesIndent = lines[index].match(/^\s*/)[0].length;
    let scriptIndex = index + 1;
    while (scriptIndex < lines.length) {
      const line = lines[scriptIndex];
      const indent = line.match(/^\s*/)[0].length;
      if (line.trim() && indent < usesIndent) break;
      if (/^\s*script:\s*\|\s*$/.test(line)) break;
      scriptIndex += 1;
    }
    if (scriptIndex >= lines.length || !/^\s*script:\s*\|\s*$/.test(lines[scriptIndex])) {
      continue;
    }
    const scalarIndent = lines[scriptIndex].match(/^\s*/)[0].length;
    const contentIndent = scalarIndent + 2;
    const body = [];
    for (let cursor = scriptIndex + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      const indent = line.match(/^\s*/)[0].length;
      if (line.trim() && indent <= scalarIndent) break;
      body.push(line.trim() ? line.slice(contentIndent) : '');
    }
    bodies.push(body.join('\n'));
  }
  return bodies;
}

test('large github-script expressions are rejected while env transport is safe', () => {
  const padding = 'x'.repeat(LARGE_SCRIPT_EXPRESSION_THRESHOLD);
  assert.equal(
    largeGithubScriptHasDirectExpression(`${padding}\nconst value = '\${{ steps.x.outputs.value }}';`),
    true,
  );
  assert.equal(
    largeGithubScriptHasDirectExpression(`${padding}\nconst value = process.env.VALUE;`),
    false,
  );
  assert.equal(largeGithubScriptHasDirectExpression("const value = '${{ github.sha }}';"), false);
});

test('unquoted or template github-script expressions fail typed syntax safety', () => {
  assert.equal(githubScriptHasUnquotedExpression('const sha = ${{ github.sha }};'), true);
  assert.equal(githubScriptHasUnquotedExpression('const enabled = ${{ inputs.enabled }};'), true);
  assert.equal(githubScriptHasUnquotedExpression('const sha = `${{ github.sha }}`;'), true);
  assert.equal(githubScriptHasUnquotedExpression("const sha = '${{ github.sha }}';"), false);
  assert.equal(githubScriptHasUnquotedExpression('// ${{ github.sha }}\nconst sha = process.env.SHA;'), false);
  assert.equal(githubScriptHasUnquotedExpression('const sha = process.env.SHA;'), false);
});

function trackedYamlFiles() {
  return execFileSync('git', ['ls-files', '*.yml', '*.yaml'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .map((relativePath) => path.join(ROOT, relativePath));
}

test('all tracked workflow github-script bodies pass expression-size safety', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'sync-config.json'), 'utf8'));
  let largeBlocks = 0;
  let checkedBlocks = 0;
  for (const workflowPath of trackedYamlFiles()) {
    const workflow = fs.readFileSync(workflowPath, 'utf8');
    for (const body of githubScriptBodies(workflow)) {
      checkedBlocks += 1;
      if (Buffer.byteLength(body, 'utf8') >= LARGE_SCRIPT_EXPRESSION_THRESHOLD) largeBlocks += 1;
      assert.equal(largeGithubScriptHasDirectExpression(body), false, workflowPath);
      assert.equal(githubScriptHasUnquotedExpression(body), false, workflowPath);
    }
  }
  assert.ok(checkedBlocks >= 1, 'regression must inspect tracked github-script bodies');
  assert.ok(largeBlocks >= 3, 'regression must exercise large source, mirror, and hub-only scripts');

  for (const name of config.synced_workflows) {
    const sourcePath = path.join(ROOT, 'workflows', name);
    const mirrorPath = path.join(ROOT, '.github', 'workflows', name);
    const source = fs.readFileSync(sourcePath, 'utf8');
    const mirror = fs.readFileSync(mirrorPath, 'utf8');
    assert.equal(source, mirror, `${name} source/mirror drift`);
  }

  const hubOnly = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'minutes-guard.yml'),
    'utf8',
  );
  assert.ok(
    githubScriptBodies(hubOnly).some(
      (body) => Buffer.byteLength(body, 'utf8') >= LARGE_SCRIPT_EXPRESSION_THRESHOLD,
    ),
    'regression must exercise a large hub-only github-script body',
  );
  const gate = fs.readFileSync(path.join(ROOT, 'workflows', 'codex-gate.yml'), 'utf8');
  assert.match(gate, /PR_NUMBERS_JSON: \$\{\{ steps\.prs\.outputs\.numbers \}\}/);
  assert.match(gate, /JSON\.parse\(process\.env\.PR_NUMBERS_JSON \|\| '\[\]'\)/);
});

test('watchdog alert fingerprint ignores volatile line and run coordinates', () => {
  const first = Object.assign(
    new Error('Invalid Argument - failed to parse workflow: (Line: 145, Col: 19): Exceeded max expression length 21000; run 31679371202'),
    { status: 422 },
  );
  const repeat = Object.assign(
    new Error('Invalid Argument - failed to parse workflow: (Line: 151, Col: 21): Exceeded max expression length 21000; run 31690000001'),
    { status: 422 },
  );
  const different = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });
  assert.equal(failureFingerprint(first), failureFingerprint(repeat));
  assert.notEqual(failureFingerprint(first), failureFingerprint(different));
});

test('watchdog dedupe is exact to trusted PR head operation and error', () => {
  const fingerprint = failureFingerprint(Object.assign(new Error('parse failed'), { status: 422 }));
  const marker = failureAlertMarker({
    prNumber: 38,
    headSha: HEAD,
    operation: 'gate_dispatch',
    fingerprint,
  });
  const trusted = [{ user: { login: 'funzi7' }, body: marker }];
  const query = {
    ownerLogin: 'funzi7',
    prNumber: 38,
    headSha: HEAD,
    operation: 'gate_dispatch',
    fingerprint,
  };
  assert.equal(hasFailureAlertMarker(trusted, query), true);
  assert.equal(hasFailureAlertMarker(trusted, { ...query, headSha: 'b'.repeat(40) }), false);
  assert.equal(hasFailureAlertMarker(trusted, { ...query, operation: 'update_branch' }), false);
  assert.equal(hasFailureAlertMarker(trusted, { ...query, fingerprint: 'deadbeef' }), false);
  assert.equal(
    hasFailureAlertMarker([{ user: { login: 'attacker' }, body: marker }], query),
    false,
  );
});

test('watchdog failure paths use durable alert dedupe', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, 'workflows', 'claude-fallback-watchdog.yml'),
    'utf8',
  );
  assert.match(workflow, /state=failure_alerted op=\$\{operation\} error=\$\{fingerprint\}/);
  assert.match(workflow, /'backup_dispatch', e,/);
  assert.match(workflow, /'update_branch', e,/);
  assert.match(workflow, /'gate_dispatch', e,/);
  assert.match(workflow, /Telegram alert suppressed by durable marker/);
});

test('CI Doctor ignores parse-failed internal paths but not product CI', () => {
  assert.equal(isInternalAutomationRun({
    name: '.github/workflows/codex-gate.yml',
    path: '.github/workflows/codex-gate.yml',
  }), true);
  assert.equal(isInternalAutomationRun({
    name: 'unparsed workflow',
    path: '.github/workflows/claude-fallback-watchdog.yml@refs/heads/main',
  }), true);
  assert.equal(isInternalAutomationRun({
    name: 'CI',
    path: '.github/workflows/ci.yml',
  }), false);
  const workflow = fs.readFileSync(path.join(ROOT, 'workflows', 'ci-doctor.yml'), 'utf8');
  assert.match(workflow, /IGNORE_WORKFLOW_PATHS/);
  assert.match(workflow, /IGNORE_WORKFLOW_PATHS\.has\(normalizeWorkflowPath\(run\.path\)\)/);
  assert.match(workflow, /if \(isInternalAutomationRun\(run\)\)/);
});
