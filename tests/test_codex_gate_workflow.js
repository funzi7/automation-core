'use strict';

/**
 * Codex Gate evaluator — end-to-end harness for the SHIPPED inline script.
 *
 * The authoritative gate is the `script: |` body of the step named
 * "Evaluate Codex P1 status for each PR" in workflows/codex-gate.yml.
 * tests/test_codex_gate_logic.js exercises the pure decision mirror; nothing
 * executed the real evaluator together with its API wiring (marker publish,
 * run authentication, head-epoch reconciliation, check publication). That is
 * exactly where the 2026-11-08 incident lived: the trusted head-epoch marker
 * failed with "Resource not accessible by integration" on every
 * pull_request_target run (paywall-bot #120/#122, automation-core #58) and
 * nobody could say what the gate published afterwards.
 *
 * This file extracts the step body by STRUCTURE (step name + block scalar),
 * never by line numbers, runs it under a fake `github`/`context`/`core`/
 * `process` exactly as actions/github-script would, and asserts the published
 * `check-codex-status` verdict (conclusion AND title) plus every side effect:
 * marker comments, warnings, errors and the job's setFailed.
 *
 * The fixture mirrors paywall-bot PR #120: run 42477092393, head 23eac35,
 * previous head 3561ee6, activity between 11:43 and 11:48 UTC.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Identities, SHAs and the incident timeline
// ---------------------------------------------------------------------------
const OWNER = 'funzi7';
const REPO = 'paywall-bot';
const PR = 120;
const RUN_ID = 42477092393;
const HEAD = '23eac3576e5b7213311f26bd34fa6537f5017a4c';
const PREVIOUS_HEAD = '3561ee66ee5717be2209e7689dd5e31be9ddcee7';

const CODEX_REST = 'chatgpt-codex-connector[bot]'; // REST surfaces
const CODEX_GRAPHQL = 'chatgpt-codex-connector'; // GraphQL thread authors
const BOT = 'github-actions[bot]'; // trusted marker author

const T = {
  previousHeadRun: '2026-11-08T11:30:00Z', // pull_request run for the previous head
  runCreated: '2026-11-08T11:43:58Z', // this gate run's immutable created_at
  runStarted: '2026-11-08T11:44:00Z',
  headRun: '2026-11-08T11:44:05Z', // pull_request run for the new head
  marker: '2026-11-08T11:44:30Z', // marker comment written inside this run
  lateReview: '2026-11-08T11:46:00Z', // Codex finishes an old-head task
  receipt: '2026-11-08T11:46:40Z',
  reaction: '2026-11-08T11:47:00Z',
  runUpdated: '2026-11-08T11:48:00Z',
  forcePush: '2026-11-08T11:50:00Z',
};

// Published verdict titles. Pinned verbatim: the watchdog matches two of them.
const TITLE = {
  waiting: '🟡 Waiting for Codex review',
  clear: '🟢 Reviewed — clear',
  blocked: '🔴 Active Codex P1/P2 finding',
  error: '🟠 Gate evaluation error — fail-closed',
};

// ---------------------------------------------------------------------------
// Structural extraction of the evaluator script
// ---------------------------------------------------------------------------
const EVALUATOR_STEP = 'Evaluate Codex P1 status for each PR';
const STEP_INDENT = '      '; // `- name:` of a step in the single job
const SCRIPT_INDENT = ' '.repeat(12); // block-scalar content indentation

function workflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'workflows', name), 'utf8');
}

let cachedSource = null;
function evaluatorScript() {
  if (cachedSource !== null) return cachedSource;
  const body = workflow('codex-gate.yml');
  const stepStart = body.indexOf(`${STEP_INDENT}- name: ${EVALUATOR_STEP}\n`);
  assert.ok(stepStart >= 0, `codex-gate.yml must have a step named "${EVALUATOR_STEP}"`);
  const header = '          script: |\n';
  const scriptStart = body.indexOf(header, stepStart);
  assert.ok(scriptStart >= 0, 'the evaluator step must carry a literal github-script body');
  const nextStep = body.indexOf(`\n${STEP_INDENT}- name: `, scriptStart);
  assert.ok(
    nextStep < 0 || body.indexOf(header, scriptStart + header.length) < 0 ||
      body.indexOf(header, scriptStart + header.length) > nextStep,
    'the evaluator step must hold exactly one script body',
  );
  // A YAML block scalar ends at the first non-blank line indented less than
  // its content. Blank lines inside it are kept.
  const lines = [];
  for (const line of body.slice(scriptStart + header.length).split('\n')) {
    if (line !== '' && !line.startsWith(SCRIPT_INDENT)) break;
    lines.push(line.slice(SCRIPT_INDENT.length));
  }
  const source = lines.join('\n');
  assert.ok(source.length > 20000, 'the evaluator body should be the whole gate, not a fragment');
  // Workflow expressions inside the script would be template injection; the
  // gate reads its inputs through env instead.
  assert.ok(!source.includes('${{'), 'the evaluator script must not interpolate workflow expressions');
  cachedSource = source;
  return source;
}

let compiled = null;
function compiledEvaluator() {
  if (!compiled) {
    // actions/github-script wraps the body in an async function with
    // `github`, `context` and `core` in scope; `process` is Node's.
    compiled = new Function(
      'github', 'context', 'core', 'process',
      `return (async () => {\n${evaluatorScript()}\n})();`,
    );
  }
  return compiled;
}

// Source of one top-level function of the dedented script, bounded by the
// first column-0 closing brace after its header.
function evaluatorFunctionSource(name, prefix = 'function') {
  const source = evaluatorScript();
  const start = source.indexOf(`\n${prefix} ${name}(`);
  assert.ok(start >= 0, `the evaluator must define ${name} at top level`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `could not bound ${name}`);
  return source.slice(start + 1, end + 2);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
let nextId = 9000;
function id() { nextId += 1; return nextId; }

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// The run document GitHub returns for
// GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}
// describing this gate attempt, with the marker comment inside its window.
function gateRunAttempt(overrides = {}) {
  return {
    id: RUN_ID,
    path: '.github/workflows/codex-gate.yml',
    event: 'pull_request_target',
    run_attempt: 1,
    pull_requests: [{ number: PR }],
    run_started_at: T.runStarted,
    created_at: T.runCreated,
    updated_at: T.runUpdated,
    status: 'completed',
    ...overrides,
  };
}

// A `pull_request`-event workflow run in the repository's run history.
function prRun({ head = HEAD, at = T.headRun, pr = PR } = {}) {
  return {
    id: id(),
    event: 'pull_request',
    head_sha: head,
    created_at: at,
    pull_requests: [{ number: pr }],
  };
}

function markerComment({
  runId = RUN_ID, attempt = 1, pr = PR, head = HEAD, at = T.marker, login = BOT,
} = {}) {
  return {
    id: id(),
    user: { login },
    created_at: at,
    updated_at: at,
    body: `<!-- codex-head-epoch:v3 run=${runId} attempt=${attempt} pr=${pr} head=${head} -->`,
  };
}

// Codex's clean receipt comment; the backticked value is head[0:10].
function receipt(head = HEAD, at = T.receipt) {
  return {
    id: id(),
    user: { login: CODEX_REST },
    created_at: at,
    updated_at: at,
    body: '<!-- codex-review-receipt:v1 -->\n\n' +
      'Codex Review: Didn\'t find any major issues. :+1:\n\n' +
      `**Reviewed commit:** \`${head.slice(0, 10)}\``,
  };
}

function codexReview({ commitId = HEAD, at = T.receipt, body = 'Codex Review: looked at this head.' } = {}) {
  return {
    id: id(),
    user: { login: CODEX_REST },
    state: 'COMMENTED',
    commit_id: commitId,
    submitted_at: at,
    body,
  };
}

function codexReaction(at = T.reaction, content = '+1') {
  return { id: id(), user: { login: CODEX_REST }, content, created_at: at };
}

function quotaNotice(at = T.receipt) {
  return {
    id: id(),
    user: { login: CODEX_REST },
    created_at: at,
    updated_at: at,
    body: 'You have reached your Codex usage limits for code reviews. ' +
      'You can see your limits in the Codex usage dashboard.',
  };
}

// A Codex finding as rendered on GitHub; the badge token is what the gate's
// severity patterns match.
function badge(level, title, body = 'Detail of the finding.') {
  const colour = level === 'P1' ? 'P1-orange' : 'P2-yellow';
  return `**<sub><sub>![${level} Badge](https://img.shields.io/badge/${colour}?style=flat)</sub></sub>  ${title}**\n\n${body}`;
}

// A GraphQL reviewThreads node. `comments.pageInfo` is included so the fake
// also satisfies a query that asks whether the thread was truncated.
function thread({
  threadId = 'PRRT_kwDOA1',
  resolved = false,
  outdated = false,
  filePath = 'core/paywall.py',
  line = 42,
  startLine = null,
  body = badge('P1', 'Unsafe direction control'),
  author = CODEX_GRAPHQL,
  at = T.receipt,
} = {}) {
  return {
    id: threadId,
    isResolved: resolved,
    isOutdated: outdated,
    path: filePath,
    line,
    startLine,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [{ body, createdAt: at, author: { login: author } }],
    },
  };
}

// One evaluation's inputs. Defaults describe the post-fix world: a
// pull_request_target `synchronize` event whose payload head is the live
// head, a marker publish that succeeds and authenticates, one observed head,
// no Codex activity, fallback policy off.
function fixture(overrides = {}) {
  const fx = {
    prNumber: PR,
    head: HEAD, // live PR head (pulls.get)
    payloadHead: HEAD, // immutable triggering payload head
    eventName: 'pull_request_target',
    action: 'synchronize',
    runId: RUN_ID,
    runAttempt: '1',
    fallbackEnabled: '',
    title: 'feat(paywall): tighten the source map',
    labels: [],
    reviews: [],
    comments: [],
    reviewComments: [],
    reactions: [],
    threads: [],
    workflowRuns: [prRun({ head: HEAD, at: T.headRun })],
    issueEvents: [],
    thisRunCreatedAt: T.runCreated,
    markerCreatedAt: T.marker,
    // Injected failures, by surface: createComment, attempts, graphql,
    // pullsGet, checksCreate, getWorkflowRun.
    errors: {},
    ...overrides,
  };
  if (!overrides.attemptRuns) {
    const attempt = Number(fx.runAttempt);
    fx.attemptRuns = {
      [`${fx.runId}/${attempt}`]: gateRunAttempt({ id: fx.runId, run_attempt: attempt }),
    };
  }
  return fx;
}

function prObject(fx) {
  return {
    number: fx.prNumber,
    state: 'open',
    title: fx.title,
    user: { login: OWNER },
    labels: fx.labels,
    head: {
      sha: fx.head,
      ref: 'feat/paywall-source-map',
      repo: { full_name: `${OWNER}/${REPO}` },
    },
    base: { ref: 'main', repo: { full_name: `${OWNER}/${REPO}`, default_branch: 'main' } },
  };
}

function makeContext(fx) {
  const payload = {};
  if (fx.eventName === 'pull_request_target') {
    payload.action = fx.action;
    payload.pull_request = { number: fx.prNumber, head: { sha: fx.payloadHead } };
  } else if (fx.eventName === 'issue_comment') {
    payload.action = 'created';
    payload.issue = { number: fx.prNumber, pull_request: { url: 'https://api.github.com/x' } };
  } else if (fx.eventName === 'schedule') {
    payload.schedule = '7,22,37,52 * * * *';
  }
  return { repo: { owner: OWNER, repo: REPO }, eventName: fx.eventName, payload, runId: fx.runId };
}

const ATTEMPTS_ROUTE = 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}';
const ISSUE_EVENTS_ROUTE = 'GET /repos/{owner}/{repo}/issues/{issue_number}/events';

// Fake Octokit covering exactly the surfaces the evaluator uses.
function makeGithub(fx, record) {
  // Live comment list: a successful marker write is visible on a re-read.
  const comments = [...fx.comments];
  const injected = (name) => fx.errors[name];
  const rest = {
    pulls: {
      get: async () => {
        record.calls.push('pulls.get');
        if (injected('pullsGet')) throw injected('pullsGet');
        return { data: prObject(fx) };
      },
      listReviews: async () => fx.reviews,
      listReviewComments: async () => fx.reviewComments,
    },
    issues: {
      listComments: async () => [...comments],
      createComment: async (params) => {
        record.calls.push('issues.createComment');
        record.createdComments.push(params);
        if (injected('createComment')) throw injected('createComment');
        const marker = {
          id: id(),
          user: { login: BOT },
          body: params.body,
          created_at: fx.markerCreatedAt,
          updated_at: fx.markerCreatedAt,
        };
        comments.push(marker);
        return { data: marker };
      },
    },
    reactions: { listForIssue: async () => fx.reactions },
    actions: {
      listWorkflowRunsForRepo: async () => {
        record.calls.push('actions.listWorkflowRunsForRepo');
        return fx.workflowRuns;
      },
      getWorkflowRun: async (params) => {
        record.calls.push('actions.getWorkflowRun');
        if (injected('getWorkflowRun')) throw injected('getWorkflowRun');
        return { data: { id: params.run_id, created_at: fx.thisRunCreatedAt } };
      },
    },
    checks: {
      create: async (params) => {
        record.calls.push('checks.create');
        record.checks.push({
          name: params.name,
          head_sha: params.head_sha,
          status: params.status,
          conclusion: params.conclusion,
          title: params.output?.title,
          summary: params.output?.summary,
        });
        if (injected('checksCreate')) throw injected('checksCreate');
        return { data: { id: id() } };
      },
    },
  };
  return {
    rest,
    // paginate(restFn, params) yields the array the fake list function
    // returns; paginate(route, params) is only used for issue events.
    paginate: async (target, params) => {
      if (typeof target === 'function') return target(params);
      if (target === ISSUE_EVENTS_ROUTE) return fx.issueEvents;
      throw new Error(`unexpected paginate route: ${target}`);
    },
    request: async (route, params) => {
      if (route !== ATTEMPTS_ROUTE) throw new Error(`unexpected request route: ${route}`);
      const key = `${params.run_id}/${params.attempt_number}`;
      record.calls.push('request.attempts');
      record.attemptLookups.push(key);
      if (injected('attempts')) throw injected('attempts');
      const run = fx.attemptRuns[key];
      if (!run) throw httpError(404, 'Not Found');
      return { data: run };
    },
    graphql: async (query) => {
      record.calls.push('graphql');
      record.graphqlQueries.push(query);
      if (injected('graphql')) throw injected('graphql');
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: fx.threads,
            },
          },
        },
      };
    },
  };
}

function makeCore() {
  const log = {
    infos: [], warnings: [], errors: [], outputs: {}, failed: null,
    summaryHeadings: [], summaryLists: [], summaryWrites: 0,
  };
  const summary = {
    addHeading(text) { log.summaryHeadings.push(String(text)); return summary; },
    addList(items) { log.summaryLists.push([...items]); return summary; },
    write() { log.summaryWrites += 1; return Promise.resolve(summary); },
  };
  const core = {
    info: (message) => log.infos.push(String(message)),
    warning: (message) => log.warnings.push(String(message)),
    error: (message) => log.errors.push(String(message)),
    setFailed: (message) => { log.failed = String(message); },
    setOutput: (key, value) => { log.outputs[key] = value; },
    summary,
  };
  return { core, log };
}

// Run the shipped evaluator once against a fixture. Returns every observable
// side effect: published checks, marker comments, log lines, setFailed.
async function runGate(fx) {
  const record = {
    calls: [], checks: [], createdComments: [], attemptLookups: [], graphqlQueries: [],
  };
  const github = makeGithub(fx, record);
  const { core, log } = makeCore();
  const env = {
    PR_NUMBERS_JSON: JSON.stringify([fx.prNumber]),
    GITHUB_RUN_ATTEMPT: fx.runAttempt,
    CLAUDE_FALLBACK_REVIEW_ENABLED: fx.fallbackEnabled,
  };
  await compiledEvaluator()(github, makeContext(fx), core, { env });
  return { ...record, ...log, summary: log.summaryLists.flat() };
}

function onlyCheck(result, head = HEAD) {
  assert.equal(result.checks.length, 1,
    `expected exactly one published check, got ${JSON.stringify(result.checks)}`);
  const check = result.checks[0];
  assert.equal(check.name, 'check-codex-status');
  assert.equal(check.status, 'completed');
  assert.equal(check.head_sha, head, 'the verdict must be published on the exact PR head');
  return check;
}

function assertVerdict(result, conclusion, title, head = HEAD) {
  const check = onlyCheck(result, head);
  assert.equal(check.title, title);
  assert.equal(check.conclusion, conclusion);
  return check;
}

function neverGreen(result) {
  assert.ok(
    result.checks.every((check) => check.conclusion !== 'success'),
    `no success check may be published: ${JSON.stringify(result.checks)}`,
  );
}

// ---------------------------------------------------------------------------
// Harness self-check
// ---------------------------------------------------------------------------
test('harness: the evaluator is extracted by structure and pins the published titles', () => {
  const source = evaluatorScript();
  assert.ok(typeof compiledEvaluator() === 'function', 'the step body must compile');
  // Every verdict this file asserts on must be a literal in the shipped
  // script, so a reword fails here instead of silently never matching.
  for (const title of Object.values(TITLE)) {
    assert.ok(source.includes(`'${title}'`), `the gate must publish the exact title ${title}`);
  }
  assert.ok(source.includes(`const GATE_ERROR_TITLE = '${TITLE.error}';`));
  assert.match(source, /name: 'check-codex-status'/);
});

// ---------------------------------------------------------------------------
// 1. The 2026-11-08 incident: the marker write is refused
// ---------------------------------------------------------------------------
test('1: a 403 on the head marker is logged and the evaluation continues to a pending verdict', async () => {
  const result = await runGate(fixture({
    errors: { createComment: httpError(403, 'Resource not accessible by integration') },
  }));
  // The write was attempted and refused...
  assert.equal(result.createdComments.length, 1);
  assert.ok(result.warnings.some((w) =>
    w.includes('PR #120: trusted head marker publish failed') &&
    w.includes('Resource not accessible by integration')),
  `expected the marker warning, got ${JSON.stringify(result.warnings)}`);
  // ...but it is not a technical error: the evaluation went on to read
  // thread state and publish the ordinary pending verdict.
  assert.ok(result.calls.includes('graphql'), 'thread state must still be read');
  assertVerdict(result, 'failure', TITLE.waiting);
  assert.ok(!result.warnings.some((w) => w.includes('technical error')));
  assert.ok(result.failed, 'a pending head fails the evaluator job loudly');
  assert.match(result.summary.join('\n'), /PR #120: ⏳ pending — Codex has not reviewed head 23eac35/);
});

// ---------------------------------------------------------------------------
// 2. Markerless thumbs-up
// ---------------------------------------------------------------------------
test('2: a Codex thumbs-up with no authenticated marker history never clears', async () => {
  // No marker was ever written (the incident), Codex reacts 👍 after the run.
  const incident = await runGate(fixture({
    errors: { createComment: httpError(403, 'Resource not accessible by integration') },
    reactions: [codexReaction(T.reaction)],
  }));
  assertVerdict(incident, 'failure', TITLE.waiting);
  assert.match(onlyCheck(incident).summary, /Codex has not reviewed head 23eac35/);

  // The scheduled sweep writes no marker either; with none in history the
  // reaction stays non-binding there too. A sweep does not fail the aggregate
  // job for one pending PR (existing behaviour).
  const sweep = await runGate(fixture({
    eventName: 'schedule',
    reactions: [codexReaction(T.reaction)],
  }));
  assert.equal(sweep.createdComments.length, 0, 'the sweep never writes markers');
  assertVerdict(sweep, 'failure', TITLE.waiting);
  assert.equal(sweep.failed, null);
});

// ---------------------------------------------------------------------------
// 3. Marker written but not authenticated
// ---------------------------------------------------------------------------
test('3: a marker that cannot be re-authenticated against its run keeps reaction-only clean pending', async () => {
  const result = await runGate(fixture({
    errors: { attempts: httpError(404, 'Not Found') },
    reactions: [codexReaction(T.reaction)],
  }));
  assert.equal(result.createdComments.length, 1, 'the marker itself was written');
  assert.ok(result.attemptLookups.includes(`${RUN_ID}/1`),
    'the gate must try to authenticate its own freshly written marker');
  assert.ok(result.warnings.some((w) =>
    /PR #120: epoch run 42477092393 verification failed: Not Found/.test(w)));
  assertVerdict(result, 'failure', TITLE.waiting);
});

// ---------------------------------------------------------------------------
// 4. Authenticated marker + single head: the only reaction-only clean path
// ---------------------------------------------------------------------------
test('4: an authenticated marker on a single-head PR lets a later Codex thumbs-up clear', async () => {
  const result = await runGate(fixture({ reactions: [codexReaction(T.reaction)] }));
  assert.equal(result.createdComments.length, 1);
  assert.ok(result.attemptLookups.includes(`${RUN_ID}/1`));
  const check = assertVerdict(result, 'success', TITLE.clear);
  assert.match(check.summary, /current_head_signal_no_active_findings/);
  assert.match(check.summary, /Codex exact-head review accepted/);
  assert.equal(result.failed, null);
});

test('4b: the same thumbs-up is non-binding once run history shows another head of this PR', async () => {
  const result = await runGate(fixture({
    reactions: [codexReaction(T.reaction)],
    workflowRuns: [
      prRun({ head: PREVIOUS_HEAD, at: T.previousHeadRun }),
      prRun({ head: HEAD, at: T.headRun }),
    ],
  }));
  assertVerdict(result, 'failure', TITLE.waiting);
});

test('4c: an authenticated marker for an earlier head also disqualifies reaction-only clean', async () => {
  // Marker history (not run history) proves the PR had another head.
  const earlierRun = 42476000000;
  const result = await runGate(fixture({
    reactions: [codexReaction(T.reaction)],
    comments: [markerComment({ runId: earlierRun, head: PREVIOUS_HEAD, at: '2026-11-08T11:30:20Z' })],
    attemptRuns: {
      [`${RUN_ID}/1`]: gateRunAttempt(),
      [`${earlierRun}/1`]: gateRunAttempt({
        id: earlierRun,
        created_at: '2026-11-08T11:30:00Z',
        run_started_at: '2026-11-08T11:30:02Z',
        updated_at: '2026-11-08T11:33:00Z',
      }),
    },
  }));
  assertVerdict(result, 'failure', TITLE.waiting);
});

test('4d: a thumbs-up older than the head epoch is not a current-head signal', async () => {
  // Reaction created before this run observed the head.
  const result = await runGate(fixture({ reactions: [codexReaction('2026-11-08T11:40:00Z')] }));
  assertVerdict(result, 'failure', TITLE.waiting);
});

// ---------------------------------------------------------------------------
// 5. Exact-head receipt
// ---------------------------------------------------------------------------
test('5: a Codex receipt naming the exact head clears', async () => {
  const result = await runGate(fixture({ comments: [receipt(HEAD)] }));
  const check = assertVerdict(result, 'success', TITLE.clear);
  assert.match(check.summary, /current_head_signal_no_active_findings/);
  assert.match(check.summary, /Codex exact-head review accepted/);
  assert.equal(result.failed, null);
  assert.match(result.summary.join('\n'), /✅ current_head_signal_no_active_findings on head 23eac35/);
});

// ---------------------------------------------------------------------------
// 6. Late review of the previous head
// ---------------------------------------------------------------------------
test('6: a Codex review of the previous head finishing after the push never clears the new head', async () => {
  const result = await runGate(fixture({
    reviews: [codexReview({ commitId: PREVIOUS_HEAD, at: T.lateReview })],
    comments: [receipt(PREVIOUS_HEAD, T.receipt)],
  }));
  const check = assertVerdict(result, 'failure', TITLE.waiting);
  assert.match(check.summary, /Codex has not reviewed head 23eac35/);
});

// ---------------------------------------------------------------------------
// 7. Active P1 thread
// ---------------------------------------------------------------------------
test('7: an active trusted P1 thread blocks even with a clean receipt on the head', async () => {
  const result = await runGate(fixture({
    comments: [receipt(HEAD)],
    threads: [thread({ body: badge('P1', 'Unsafe direction control') })],
  }));
  const check = assertVerdict(result, 'failure', TITLE.blocked);
  assert.match(check.summary, /P1 core\/paywall\.py:42/);
  assert.ok(result.failed);
});

// ---------------------------------------------------------------------------
// 8. Resolved and outdated threads
// ---------------------------------------------------------------------------
test('8: resolved threads clear with a receipt', async () => {
  const result = await runGate(fixture({
    comments: [receipt(HEAD)],
    threads: [
      thread({ resolved: true }),
      thread({ threadId: 'PRRT_kwDOA2', resolved: true, outdated: true, body: badge('P2', 'Stale source map reused') }),
    ],
  }));
  const check = assertVerdict(result, 'success', TITLE.clear);
  assert.match(check.summary, /current_head_signal_no_active_findings/);
});

test('8b: an outdated unresolved thread waits for a current-head signal, then clears with one', async () => {
  const silent = await runGate(fixture({ threads: [thread({ outdated: true })] }));
  const pending = assertVerdict(silent, 'failure', TITLE.waiting);
  assert.match(pending.summary, /an outdated finding awaits a clean current-head Codex signal/);

  const signalled = await runGate(fixture({
    comments: [receipt(HEAD)],
    threads: [thread({ outdated: true })],
  }));
  const cleared = assertVerdict(signalled, 'success', TITLE.clear);
  assert.match(cleared.summary, /outdated_findings_and_current_head_signal/);
});

// ---------------------------------------------------------------------------
// 9. Non-inline findings
// ---------------------------------------------------------------------------
test('9: a trusted P2 in a review body bound to the head blocks without any inline thread', async () => {
  const result = await runGate(fixture({
    reviews: [codexReview({ commitId: HEAD, body: badge('P2', 'Stale source map reused') })],
  }));
  const check = assertVerdict(result, 'failure', TITLE.blocked);
  assert.match(check.summary, /P2 \(review body\)/);
});

test('9b: the same P2 bound to the previous head neither blocks nor clears the new head', async () => {
  const result = await runGate(fixture({
    reviews: [codexReview({ commitId: PREVIOUS_HEAD, body: badge('P2', 'Stale source map reused') })],
  }));
  assertVerdict(result, 'failure', TITLE.waiting);
});

// ---------------------------------------------------------------------------
// 10. Quota notice
// ---------------------------------------------------------------------------
test('10: a trusted Codex quota notice on the head is not a review signal', async () => {
  const result = await runGate(fixture({ comments: [quotaNotice(T.receipt)] }));
  const check = assertVerdict(result, 'failure', TITLE.waiting);
  assert.match(check.summary, /Claude fallback review evidence is not enabled for this repository/);
});

// ---------------------------------------------------------------------------
// 11. Technical errors fail closed
// ---------------------------------------------------------------------------
test('11: a GraphQL outage publishes the fail-closed error verdict and never a green one', async () => {
  const result = await runGate(fixture({
    comments: [receipt(HEAD)], // a clean signal that could have been green
    errors: { graphql: new Error('GraphQL outage') },
  }));
  assertVerdict(result, 'failure', TITLE.error);
  neverGreen(result);
  assert.ok(result.failed, 'setFailed must be called');
  assert.match(result.failed, /fail-closed/);
  assert.ok(result.warnings.some((w) =>
    /Codex Gate technical error on PR #120: .*GraphQL outage/s.test(w)));
  assert.match(result.summary.join('\n'), /⚠️ gate errored technically — fail-closed/);
});

test('11b: when the PR cannot be read, nothing is published and the job fails', async () => {
  // Without a payload head (sweep) there is no SHA to publish against.
  const sweep = await runGate(fixture({
    eventName: 'schedule',
    errors: { pullsGet: httpError(502, 'Bad Gateway') },
  }));
  assert.equal(sweep.checks.length, 0);
  assert.ok(sweep.failed, 'gatePublishFailed must fail the job even on a sweep');
  neverGreen(sweep);

  // With a payload head, the error verdict lands on that head instead.
  const event = await runGate(fixture({ errors: { pullsGet: httpError(502, 'Bad Gateway') } }));
  assertVerdict(event, 'failure', TITLE.error);
  assert.ok(event.failed);
});

// ---------------------------------------------------------------------------
// 12. Administrator override (existing behaviour)
// ---------------------------------------------------------------------------
test('12: the codex-p1-acknowledged label forces green, after the marker is indexed', async () => {
  const result = await runGate(fixture({
    labels: [{ name: 'codex-p1-acknowledged' }],
    threads: [thread()], // an active P1 the override deliberately bypasses
  }));
  const check = assertVerdict(result, 'success', TITLE.clear);
  assert.match(check.summary, /codex-p1-acknowledged/);
  assert.equal(result.failed, null);
  // Epoch reconciliation happens before the override short-circuit, so
  // A -> B -> A cannot reuse the earlier A's signal once the label is gone.
  const markerAt = result.calls.indexOf('issues.createComment');
  const checkAt = result.calls.indexOf('checks.create');
  assert.ok(markerAt >= 0, 'the marker must be written');
  assert.ok(markerAt < checkAt, 'the marker must be written before the verdict');
  // The override path never consults thread state (documented behaviour).
  assert.ok(!result.calls.includes('graphql'));
});

// ---------------------------------------------------------------------------
// 13. Marker publish contract
// ---------------------------------------------------------------------------
test('13: the marker is written once per run/attempt, from the payload head, only on PR head events', async () => {
  const synced = await runGate(fixture());
  assert.equal(synced.createdComments.length, 1);
  const written = synced.createdComments[0];
  assert.equal(written.owner, OWNER);
  assert.equal(written.repo, REPO);
  assert.equal(written.issue_number, PR);
  assert.match(written.body, /^<!-- codex-head-epoch:v3 run=\d+ attempt=1 pr=\d+ head=[a-f0-9]{40} -->$/);
  assert.equal(written.body, `<!-- codex-head-epoch:v3 run=${RUN_ID} attempt=1 pr=${PR} head=${HEAD} -->`);
  assert.ok(synced.infos.some((line) => line.includes(`PR #120: indexed trusted head epoch run ${RUN_ID}/1`)));

  // `opened` and `reopened` write it too; a label change does not.
  for (const action of ['opened', 'reopened']) {
    const result = await runGate(fixture({ action }));
    assert.equal(result.createdComments.length, 1, `${action} must index the head`);
  }
  const labeled = await runGate(fixture({ action: 'labeled' }));
  assert.equal(labeled.createdComments.length, 0, 'a label event is not a head epoch');

  // An issue_comment evaluation never writes a marker.
  const commentEvent = await runGate(fixture({ eventName: 'issue_comment' }));
  assert.equal(commentEvent.createdComments.length, 0);

  // Idempotent per run/attempt: an identical marker is not written twice.
  const again = await runGate(fixture({ comments: [markerComment()] }));
  assert.equal(again.createdComments.length, 0);

  // A re-run is a new attempt and records its own marker.
  const rerun = await runGate(fixture({ runAttempt: '2', comments: [markerComment()] }));
  assert.equal(rerun.createdComments.length, 1);
  assert.match(rerun.createdComments[0].body, / attempt=2 /);

  // The head comes from the immutable triggering payload, never from the
  // re-fetched live PR: the function is not even handed the live head.
  const marker = evaluatorFunctionSource('ensureHeadEpochMarker', 'async function');
  assert.match(marker, /context\.payload\.pull_request\?\.head\?\.sha/);
  assert.doesNotMatch(marker, /pr\.head\.sha|\bheadSha\b/);
  assert.match(evaluatorScript(), /comments = await ensureHeadEpochMarker\(prNumber, comments\);/);
});

// ---------------------------------------------------------------------------
// 14. Stale queued head event
// ---------------------------------------------------------------------------
test('14: a stale queued head event publishes nothing for either SHA and is reported as skipped', async () => {
  const result = await runGate(fixture({
    payloadHead: PREVIOUS_HEAD, // the PR moved on while this run was queued
    comments: [receipt(HEAD)],
  }));
  assert.equal(result.checks.length, 0, 'no verdict for the stale or the live head');
  assert.equal(result.createdComments.length, 0, 'no marker for a stale payload head');
  assert.ok(result.infos.some((line) => /PR #120: ⏭️ stale queued head event skipped/.test(line)));
  assert.ok(result.summary.some((line) => /stale queued head event skipped/.test(line)));
  assert.ok(result.infos.some((line) => /stale queued head event does not match the latest live head epoch/.test(line)));

  // Equal SHAs are not enough: a force-push newer than this run proves the
  // queued payload describes an older A in A -> B -> A.
  const forcePushed = await runGate(fixture({
    comments: [receipt(HEAD)],
    issueEvents: [{ event: 'head_ref_force_pushed', created_at: T.forcePush }],
  }));
  assert.equal(forcePushed.checks.length, 0);
  assert.equal(forcePushed.createdComments.length, 0);

  // A force-push older than this run is fine.
  const earlierPush = await runGate(fixture({
    comments: [receipt(HEAD)],
    issueEvents: [{ event: 'head_ref_force_pushed', created_at: '2026-11-08T11:43:00Z' }],
  }));
  assertVerdict(earlierPush, 'success', TITLE.clear);
});

test('14b: when freshness cannot be established the head is skipped fail-closed AND loudly', async () => {
  const result = await runGate(fixture({
    comments: [receipt(HEAD)], // would have been green
    errors: { getWorkflowRun: httpError(502, 'Bad Gateway') },
  }));
  assert.equal(result.checks.length, 0, 'nothing is published when freshness cannot be proven');
  neverGreen(result);
  assert.ok(result.warnings.some((line) =>
    /PR #120: queued head-event freshness lookup failed; skipping fail-closed: Bad Gateway/.test(line)));
  // An API failure is reported as what it is — never relabelled as a stale
  // queued event — and the evaluator job fails so the skip is visible.
  assert.ok(result.summary.some((line) =>
    /PR #120: ⚠️ head-event freshness lookup failed — evaluation skipped fail-closed, no verdict published/.test(line)));
  assert.ok(!result.summary.some((line) => /stale queued head event skipped/.test(line)),
    'a lookup failure must not be reported as a stale event');
  assert.ok(result.failed, 'the evaluator job must fail loudly on a freshness-lookup error');
  assert.match(result.failed, /fail-closed/);
});

// ---------------------------------------------------------------------------
// 15. Check publish failure
// ---------------------------------------------------------------------------
test('15: a failed check publish fails the evaluator job even on a clean head', async () => {
  const result = await runGate(fixture({
    comments: [receipt(HEAD)],
    errors: { checksCreate: httpError(403, 'Resource not accessible by integration') },
  }));
  assert.equal(result.checks.length, 1, 'the publish was attempted');
  assert.equal(result.checks[0].conclusion, 'success');
  assert.ok(result.errors.some((line) =>
    /check-codex-status publish failed for 23eac35: Resource not accessible by integration/.test(line)));
  assert.ok(result.failed, 'gatePublishFailed must fail the job');
});
