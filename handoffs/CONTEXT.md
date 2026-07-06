# CONTEXT.md — Full briefing for the self-healing CI/CD loop

> **Canonical, self-contained handoff.** Read this first. It lets a brand-new
> chat or a different AI understand the entire system and continue work with no
> prior conversation history. `LOOP_STATE.md` is the detailed per-workflow
> reference; `handoffs/loop-build.md` is the dated change log (newest on top).
>
> **Privacy rule (this is a PUBLIC repo):** the owner's personal name must NEVER
> appear anywhere — code, comments, commit messages, PR text, docs, or git
> history. Refer to the human only as "the owner". An older escalation label
> (the "legacy escalation label") was fully removed and must never be
> reintroduced; the only escalation label is `needs-owner`.

---

## 1. PURPOSE

`funzi7/automation-core` is a **public hub repo** for an autonomous, self-healing
CI/CD loop. The loop's workflows are authored here once and **distributed to ~14
downstream repos via a daily sync**, so every participating repo runs the same
review→fix→merge automation. A handful of workflows are **hub-only** (they run
centrally here and read the other repos) and are intentionally not synced.

**The owner's working model:** the owner runs a **chat as the coordinator**. The
chat plans and dispatches discrete, tightly-scoped tasks; two executors carry
them out:

- **Claude Code** — the trusted *fixer* and the tool that edits this repo.
- **Codex** (ChatGPT Codex, the `chatgpt-codex-connector[bot]` GitHub App) — the
  automatic *reviewer* that comments on every PR.

The deliberate division of labor is **"Codex reviews, Claude fixes."** Codex is
good at finding issues but unreliable at landing fixes (phantom/partial commits);
Claude is the reliable fixer. The loop wires these two together so that, ideally,
no human has to type anything between a Codex finding and a merged fix.

---

## 2. ARCHITECTURE — the full loop, step by step

```
push to a PR branch
   │
   ▼
Codex reviews the PR automatically        (GitHub App; fires on every push — not a workflow in this repo)
   │   leaves findings tagged P1 / P2 / P3 (severity badges)
   ▼
The Bridge  (the `trigger_codex_fix` job INSIDE codex-auto-fix.yml)
   │   on an ACTIVE P1 or P2 finding (NEVER P3), posts ONE "@claude fix"
   │   comment per review wave (via AUTOMATION_PAT)
   ▼
Claude Fixer  (claude.yml)
   │   runs anthropics/claude-code-action, fixes on a `claude/*` branch,
   │   opens a PR ("Fixes #N") and labels it `automerge`
   ▼
Codex re-reviews the new commit
   │   3-round circuit breaker: after 3 non-converging @claude-fix rounds →
   │   add `needs-owner` + Telegram alert, stop auto-triggering
   ▼
Codex Gate  (codex-gate.yml — the `check-codex-status` blocking check)
   │   stays red until Codex has reviewed the CURRENT head with no active P1
   ▼
Merge Bot  (merge-bot.yml)
   │   squash-merges a candidate PR once the gate is green
   ▼
merged → (sync propagates updated workflows to ~14 downstream repos daily)
```

### Workflow files and what each does

**Synced to downstream repos** (listed in `sync-config.json.synced_workflows`):

- **`codex-auto-fix.yml`** — Two jobs. (a) **The Bridge** (`trigger_codex_fix`):
  watches Codex reviews/comments and posts `@claude fix` when Codex raises an
  active **P1 or P2** finding (P3 excluded). (b) **`archive_codex_summary`**:
  archives Codex post-fix summaries to `funzi7/agent-memory` (fail-soft if the
  archive PAT is absent).
- **`codex-gate.yml`** — The `check-codex-status` **blocking check**. Goes green
  only once Codex has reviewed the current head and there is no active P1.
- **`claude.yml`** — **Claude Fixer.** Runs `anthropics/claude-code-action` to
  fix a `claude-fix` Issue or an `@claude` mention, opens a PR, labels it
  `automerge`. **Debug toggle (fix #16):** the SDK transcript is hidden by
  default (`show_full_output` defaults false — safe for PUBLIC downstreams, where
  it could echo file contents into world-readable logs). `show_full_output` is
  wired to `${{ vars.CLAUDE_SHOW_FULL_OUTPUT == 'true' }}`: on a PRIVATE repo,
  set the Actions variable `CLAUDE_SHOW_FULL_OUTPUT=true` temporarily to
  enumerate an `error_max_turns` run's permission denials **by tool name** (the
  logged `permission_denials_count` alone can't tune `--allowedTools`), then flip
  it back off. **Delivery-aware (fix #23):** a Delivery-check step + the
  add-only-👎 / `no_delivery`-marker handoff (see "The fixer LADDER" in §3) — a
  no-op "success" no longer looks healthy.
- **`ci-doctor.yml`** — **CI Doctor.** Detects failed CI runs, opens (deduped)
  `claude-fix` Issues, escalates to `needs-owner` after repeated failure.
- **`merge-bot.yml`** — **Merge Bot.** Squash-merges green candidate PRs.

**Hub-only** (run here, NOT synced downstream):

- **`telegram-morning-report.yml`** — once-daily **read-only** Telegram digest of
  the loop's state across all of the owner's repos (dynamically discovered).
- **`bootstrap.yml`** — onboards a new repo into the loop.
- **`minutes-guard.yml`** — guards Actions-minutes spend across repos. Monthly
  re-enable runs at **02:23 UTC on the 1st** (`23 2 1 * *`, moved off the
  congested top-of-hour window — fix #22, after GitHub dropped the old
  `00:05`-on-the-1st tick on 2026-07-01, run gap 06-30T23:04Z → 07-01T01:37Z).
  Belt-and-suspenders: a **day-1/2 fallback** — any `*/30` detect tick on the 1st
  or 2nd whose guard state still holds disabled workflows switches itself to
  re-enable, so a dropped monthly tick can never skip a month (idempotent —
  re-enable empties the state).

---

## 3. KEY MECHANISMS (precise)

### codex-gate.yml — the blocking gate
- Publishes the `check-codex-status` check; **fail-closed** (red until proven
  green). **Two-check architecture (fix #15 — supersedes #11/#14):**
  - **GitHub policy (2025-03-31):** a workflow's `GITHUB_TOKEN` can no longer
    UPDATE the status/conclusion of a check-run created by a *different* Actions
    run ("Check run status and conclusions can only be updated internally by
    GitHub Actions"). So the fix-#11/#14 `checks.update` design is impossible: on
    the **2nd** gate run for a head (🟡 first, then Codex reviews → the update)
    the API rejects it — which would jam the gate permanently red on the normal
    path.
  - **Authoritative check = the ACTIONS-OWNED job-status check.** The job carries
    `name: check-codex-status`, and its conclusion is driven ONLY by the verdict
    via `core.setFailed` (fires iff `anyBlocked`). Actions owns/updates it
    internally, immune to the policy and to token downgrades. The head-targeted
    self-rerun (`ref = pr.head.ref`) lands it on `pr.head.sha` where merge-bot
    reads it (unchanged). Consumers (merge-bot `CODEX_CHECK`, telegram report
    `GATE_CHECK`) read `check-codex-status` **by name** via `checks.listForRef`,
    so the job-status check satisfies them all; **nothing keys on the job via
    `needs:`/required-checks**.
  - **Rich output = a cosmetic, CREATE-ONLY companion** named `codex-gate-verdict`
    (never `check-codex-status`). `publishGateCheck` always `checks.create`s a
    fresh completed check-run with 🟡 "Waiting for Codex review" / 🔴 "Active
    Codex P1/P2" / 🟢 "Reviewed — clear" + summary — **no list/find/update** (the
    exact op the policy blocks). Runs accumulate; latest-per-name surfaces the
    newest. A create failure (downgraded `checks:write` on forked/Dependabot runs)
    is a `core.warning` and **never fails the job** — the verdict lives on the
    authoritative job check. This also permanently resolves Codex's "Restore the
    fallback gate check name" finding.
  - Verdict LOGIC, freshness rule, P1/P2 detection, concurrency, `MAX_ATTEMPTS`,
    and the override label are all unchanged.
- **GREEN requires BOTH:** (a) Codex has **reviewed the current head**, and
  (b) there is **no ACTIVE P1 and no ACTIVE P2** (matching the bridge's
  trigger severity — see fix #6 / Hard-Won Lesson 11). P3 never blocks.
- **Date-only freshness:** a Codex signal (review / comment / inline note / 👍)
  counts only if it is **dated AFTER the latest commit** on the PR
  (`onHead(date) = date > latestCommitDate`, where `latestCommitDate` is the MAX
  committer date across the PR's commits). It deliberately **never** uses
  `commit_id` for freshness — GitHub re-points a still-applicable inline
  comment's `commit_id` to the new head, so `commit_id == head` does not prove a
  fresh review.
- **Re-check model — the self-rerun poll is GONE (fix #25).** The old head-targeted
  self-rerun (`sleep 90` + `createWorkflowDispatch` on the head branch, capped at
  `MAX_ATTEMPTS`) was the single biggest per-wave cost (TRF #88: ~10–12 of ~15
  runner-min). **Deleted.** The verdict lands on the head on every head-run
  (`pull_request` opened/synchronize, `pull_request_review`, `workflow_dispatch`
  from the watchdog). Its two historical jobs are covered elsewhere: a **late 👍**
  (no event) → the **watchdog sweep** (fix #18, ≤~1h re-dispatches the gate on the
  head branch); a **silent trusted sync** → **grace-green** (fix #21). Manual
  re-check: Actions → Codex Gate → Run workflow with the PR number, or the
  `codex-p1-acknowledged` label. `actions:` permission dropped (its only consumer
  was the poll). The `workflow_dispatch` entry + `pr_number` input STAY (the sweep +
  grace dispatch into it).
- **Triggers narrowed (fix #25):** `on:` is now `pull_request` (opened/synchronize/
  reopened) + `pull_request_review` + `issue_comment` (fix-Summary must re-trigger)
  + `workflow_dispatch`. **`pull_request_review_comment` was REMOVED** — the verdict
  is evaluated against the WHOLE head every run, a review already fires
  `pull_request_review`, and each of its N inline notes additionally fired a gate run
  that concurrency mostly cancelled after the runner had started (pure cost). Expected
  wave cost **~15 → ~4–6 runner-min**.
- **Run-collapsing concurrency (fix #12 + #17):** a top-level `concurrency` block
  (`group: codex-gate-pr-<pr#||inputs.pr_number||issue#||run_id>`,
  **`cancel-in-progress: false`**). (Post-#25 a Codex review fires ONE
  `pull_request_review` and a push ONE `pull_request` run — far fewer than the old
  ~4/wave.)
  **fix #17:** an IN-PROGRESS run now always **runs to completion** — GitHub only
  collapses the QUEUE per group (at most one pending run; a superseded pending run
  is dropped before it starts). Under the old `cancel-in-progress: true` a run that
  had already read Codex's 👍 and CREATED the green `codex-gate-verdict` tile got
  cancelled mid-verdict, leaving the authoritative `check-codex-status` job check as
  **`cancelled`** on the head → merge-bot treated it as failed → a green PR was
  stranded (INCIDENT 1). Letting runs finish removes that half-run strand; any
  `cancelled` check-runs left by a superseded QUEUED run are ignored by merge-bot
  (fix #17 cancelled-filter). The `|| github.run_id` fallback guarantees a non-empty
  group key.
- **Triggers** on `push` + review + comment events so it re-evaluates whenever
  the head or the review state changes.
- Manual override label: `codex-p1-acknowledged`.
- **Trusted-sync grace-green (fix #21).** A sync PR is a byte-copy of an upstream
  automation-core `main` that already passed our full validation, and Codex
  engages on syncs inconsistently — **silence is not a finding**, yet the
  fail-closed gate would strand a zero-signal sync 🟡-pending forever (and the
  override label the summary points to did not even exist downstream). So: ONLY
  inside the existing zero-signal 🟡 branch, if the PR is a **trusted sync**
  (`isTrustedSync(pr)` — the SAME title-prefix + owner/same-repo-branch predicate
  as merge-bot; the three copies carry a "keep in sync" comment), it has **ZERO
  Codex signals of any kind** (`codexSignalCount === 0`: reviews + review comments
  + issue comments + issue-level reactions), AND the head is older than
  `SYNC_GRACE_MINUTES` (= 30), the gate returns **GREEN** with the cosmetic title
  **`🟢 Trusted sync — no Codex findings within grace window`**. **ANY Codex signal
  of any kind → `codexSignalCount > 0` → this never fires** and the full normal
  rules apply (active P1/P2 still blocks; a clean review/👍 still greens; a
  younger-than-grace silent sync stays 🟡 with a "auto-clears at <UTC>" line
  appended). The gate's own poll (MAX_ATTEMPTS 3, ~4.5 min) can't wait out the 30
  min, so the watchdog sweep lands the grace-green after the window (below).

### merge-bot.yml — the merger
- **Candidate = any of:** a bot-authored PR, **OR** an `automerge`-labelled PR,
  **OR** a trusted sync PR, **OR** a **same-repo `claude/*` head branch**
  (Claude Code's PRs are AUTOMATION_PAT-authored = the owner, not a bot login,
  and carry no `automerge` label, so they're recognized by their `claude/`
  branch; fork PRs are excluded via the same-repo check so the signal is
  unspoofable).
- **Hard stop FIRST:** any PR carrying `needs-owner` is filtered out before any
  acceptance — automation never touches an escalated PR again.
- **Protected-path guard:** `.claude-guard.json` lists protected paths (e.g. the
  workflow files themselves). A PR that touches them is **not** merged — it's
  escalated to `needs-owner` instead. This is why workflow-editing PRs need a
  manual merge.
- **Head-SHA-pinned squash:** merges with `sha: headSha` so it can only merge the
  exact commit it evaluated (no race with a newer push).
- **Requires AUTOMATION_PAT** (fail-soft skip if absent) — but only for
  **MUTATIONS**. **Two-token split (fix #17 Part C):** fine-grained PATs CANNOT be
  granted the Checks permission at all (no such option in the PAT UI), so
  `checks.listForRef` on the PAT crashes `Resource not accessible by personal
  access token` (INCIDENT 2). So the step keeps `github-token: AUTOMATION_PAT`
  (every mutation — `pulls.merge`, labels, comments, `deleteRef`, issue-close —
  stays PAT-authored; `pulls.merge` MUST be PAT-authored so the push to `main`
  triggers downstream workflows), and a `readonly = getOctokit(github.token)`
  client (built from `env.GH_READONLY_TOKEN`) runs **exactly the two reads**
  (`checks.listForRef` + `repos.listCommitStatusesForRef`) on `GITHUB_TOKEN`,
  which carries the workflow's declared `checks: read` + `statuses: read`.
- **Drops concurrency-cancelled check-runs (fix #17 Part B).** Before the
  latest-per-name dedupe, `checkRuns` is filtered `conclusion !== 'cancelled'`
  (in-progress runs — `conclusion: null` — are kept so `anyRunning` still works).
  A gate run cancelled mid-verdict (fix #17 Part A history) can leave a
  `cancelled` `check-codex-status` tail on the head; treating it as failed
  stranded a green PR (INCIDENT 1). An older SUCCESS on the same head stays
  authoritative past the cancelled tail (checks are pinned to the head SHA); if
  EVERY `check-codex-status` on the head is cancelled, the `CODEX_CHECK` lookup
  finds nothing → fail-closed skip (unchanged).
- **Evaluates only the LATEST check run per name (dedupe).** GitHub emits
  **multiple** `check-codex-status` runs on one head over a PR's life — an early
  pending/red run when the PR opens, then a success run after Codex reviews.
  Merge Bot sorts check runs by recency (`completed_at`, else `started_at`,
  descending) and keeps the **first occurrence per name** before scanning for
  failures and before the codex-gate lookup, matching GitHub's own gating. (See
  Hard-Won Lessons — scanning every run is what kept merge-bot from ever
  merging.)
- **NO module loading in the script — fetch-based second token (fix #19).**
  `merge-bot.yml` uses `actions/github-script@v8` (kept). Do NOT try to build an
  octokit from a module: both `require('@actions/github')` (v7) and
  `__original_require__('@actions/github')` (v8) crashed this step in production
  with `Cannot find module .../dist/index.js` (ncc bundle, no `node_modules`; see
  the HARD RULE in §7). The two-token read/mutation split (fix #17 Part C) now
  does its GITHUB_TOKEN reads with the built-in global `fetch`: `roPage(url)`
  (Bearer + `X-GitHub-Api-Version: 2022-11-28`; parses the `Link` header for
  `rel="next"`), `roPaged(path, extract)` follows `rel="next"` until absent with a
  **50-page safety ceiling** (fix #20 — replaced the fixed 10-page valve), and
  `roCheckRuns(ref)` / `roStatuses(ref)` are one-liners over `roPaged`. Payload
  fields are identical to octokit's (check runs:
  `name`/`status`/`conclusion`/`started_at`/`completed_at`/`output`; statuses:
  `state`/`context`/`created_at`), so every downstream consumer is unchanged.
  `github-token` stays `AUTOMATION_PAT` for all mutations. (The watchdog sweep
  carries the same `roPage`/`roPaged`/`roCheckRuns` — no `roStatuses`.)
- **Manual-edit rules for a `script: |` block (a bad paste already jammed main).**
  A hand-applied diff once pasted a literal `+ ` diff-artifact line plus two JS
  lines at **column 0** inside the block scalar; a column-0 line **terminates**
  `script: |`, so the whole file failed YAML parse (`yaml.safe_load` errored at the
  first col-0 line) and, synced, broke a downstream too. RULES: every script line
  is indented to the block's column (12 spaces here); **no column-0 lines** anywhere
  in the block; **before pushing**, run `python3 -c "import yaml; yaml.safe_load(...)"`
  on BOTH copies + `actionlint` + `node --check` on the extracted body; and keep
  `workflows/` ↔ `.github/workflows/` **byte-identical** (`git hash-object` both).

### The Bridge (inside codex-auto-fix.yml)
- **Triggers on P1 + P2, excludes P3.** Codex tags each finding with a
  shields.io severity **badge whose label is the literal token** —
  `![P1 Badge](.../badge/P1-orange...)`, `![P2 Badge](.../badge/P2-yellow...)`,
  `P3-...`. Detection is a substring check: `body.includes("P1") ||
  body.includes("P2")` catches P1/P2 and never matches a P3-only finding. P2
  routinely carries real correctness issues (e.g. "false-green health"), so it
  is fixed, not just noted; P3 is minor styling/cosmetic and must never start a
  paid run.
- **Freshness:** only Codex bodies dated after the latest commit count (same rule
  as the gate).
- **Self-contained @claude fix comment (fix #13):** Codex posts the specifics as
  INLINE review comments, but **claude.yml's run context CANNOT read inline review
  threads** (`gh pr view --comments` / `gh api` / GraphQL `reviewThreads` all fail
  on a `statusCheckRollup` permission error), so Claude was pinged with the count
  but no actionable text and replied "restate it as a top-level comment". The
  bridge now **inlines the actual Codex P1/P2 finding text** into the comment: from
  the already-fetched `reviewComments` (inline → `` - `path:line` — <body> ``) and
  `reviews` (review body → `- <body>`), filtered to Codex + P1/P2 + onHead, capped
  at ~6000 chars (whole findings, "(N more truncated…)" note). Passed from the
  check step to the comment step via an **env var** (safe for arbitrary markdown —
  no `${{ }}` interpolation into a JS string). Empty-digest fallback: the prior
  generic message + "read the review body/threads on the PR." The MARKER,
  `@claude fix` phrase, token, concurrency, breaker, and freshness are unchanged.
- **Idempotency:** if a `@claude fix` marker (`[auto-triggered]`) already exists
  for the current head in any channel, it does not post again (collapses a
  multi-note review wave into one trigger).
- **3-attempt circuit breaker:** after 3 `@claude fix` rounds on a PR, it stops,
  adds `needs-owner`, and sends a Telegram alert.
- **Codex-author-only guard:** acts only when the triggering author is the Codex
  bot login — enforced in both the job `if:` and the JS author filter.
- Posts with **AUTOMATION_PAT** (a GITHUB_TOKEN-authored comment would not
  trigger `claude.yml`).
- **ai-loop markers (v1):** each `@claude fix` is prepended with an invisible
  HTML-comment marker on its own line:
  `<!-- ai-loop:v1 root_pr=<n> head=<sha> attempt=<N> agent=claude state=requested -->`.
  The marker is for the watchdog (below), not for Claude, and does not disturb
  the `@claude fix` mention line or the `[auto-triggered]` breaker marker.
  **Counting rule (applies everywhere):** an "attempt" is counted ONLY by
  `ai-loop:v1 … attempt=` markers on the PR — never by Codex reviews, inline
  notes, commits, watchdog re-runs on the same marker, debounced duplicate
  `@claude fix`, or an un-pushed patch. Next attempt = max(attempt)+1.

### The fixer LADDER (fix #23 + #26) — Claude → Codex-API → Codex-Cloud → Claude-proxy → owner
**Judged ONLY by DELIVERY** (a new commit on the PR head after the relevant ping),
never by a workflow conclusion. **Success ≠ delivery ≠ ran** — the TRF #84/#88 lessons:
`claude-code-action` returns `success` on a no-op with **zero commits**, AND it
returns `subtype:"success"` even when the account is **out of credit**
(`is_error:true`, `"Credit balance is too low"`, 0 tokens — TRF #88). So a
non-delivery is now CLASSIFIED (fix #26).
- **Honest failure classes (fix #26).** claude.yml's delivery step reads the SDK
  terminal result JSON (`steps.claude.outputs.execution_file`, else
  `find $RUNNER_TEMP -maxdepth 2 -name claude-execution-output.json`) and classifies a
  non-delivery: **`billing_error`** (`is_error` + "Credit balance is too low" / the
  `billing_error` error — Anthropic credit dry), **`fixer_error`** (`is_error`
  otherwise; the result string rides in the marker), **`no_delivery`** (ran clean, no
  commit — a GENUINE model no-op). The 👎 is added for all non-delivered classes; the
  marker becomes `agent=claude state=<class>`; billing/fixer also `core.error` a loud
  line. Only the honest class lets the watchdog skip the 20-min wait and stop
  proxying an empty account.
- **CLAUDE_ENABLED kill-switch (fix #26).** The claude job `if:` is wrapped with
  `vars.CLAUDE_ENABLED != 'false'` (absent = enabled) — flip it off while Anthropic
  credit is exhausted to skip even the ~17s billing bounce. The watchdog reads the
  same var and pre-skips stage 1 (no window) for every PR.

- **`claude.yml` delivery-aware verdict (fix #23 Part A):** a **Delivery check** step
  (`id: delivery`, `always() && has_key`) lists commits on the PR head ref since the
  trigger comment's time — `delivered = ≥1 new commit`. The reaction step now fires on
  `outcome != 'success' **OR** delivered != 'true'`, and it **ADDS** a 👎 (never
  "swaps"): the 👀 on the trigger is placed by the hosted **`claude[bot]` App**, a
  DIFFERENT identity whose reactions we cannot delete — so the old delete-eyes logic is
  gone. It also upserts a `agent=claude state=no_delivery head=<sha>` ai-loop marker so
  the watchdog advances the ladder WITHOUT waiting the full timeout. Fail-soft: if
  delivery can't be determined, treat as delivered (avoid a false 👎).
- **`claude-fallback-watchdog.yml` ladder (fix #23 Part B)** — schedule `2-59/5 * * * *`
  + `workflow_dispatch`. Per open PR with an unanswered `agent=claude state=requested`
  marker on the current head, it climbs a ladder, each stage judged by a
  `deliveredSince(pingTime)` helper (commits on the head ref, injected octokit, zero
  modules) and firing **at most once per head** (marker dedupe):
  1. **claude** — failed = a `claude/no_delivery` marker OR the 20-min window elapsed.
     **fix #26 instant skip:** a `claude/billing_error` or `claude/fixer_error` marker
     (Claude RAN AND DIED) makes stage 1 **terminal immediately** — no window — with a
     once-per-head `🚨 … Claude fixer dead (<class>) — fund Anthropic` notify (deduped
     via a `watchdog/claude_dead` marker); `CLAUDE_ENABLED=false` also pre-skips it.
  2. **codex-api** — ONLY if `vars.CODEX_BACKUP_ENABLED == 'true'`: the existing
     `codex-backup-fix.yml` dispatch (unchanged, runs Codex IN GitHub Actions — Cloud
     strips secrets so it can't push), then its own 20-min delivery window
     (`agent=codex state=requested`). **Skipped entirely when the var is unset** (today's
     reality — dead OpenAI quota).
  3. **codex-cloud (NEW)** — posts a TOP-LEVEL `@codex fix` issue comment via
     AUTOMATION_PAT (a PAT/owner-authored comment provably wakes subscription-billed
     Codex Cloud — TRF #84), with `[auto-triggered]` + **an explicit push instruction
     (fix #24): "Commit and push your fix directly to this PR's head branch (you have
     write permission) — do not leave the diff waiting in the task."** (the Codex
     Connector app is CONFIRMED to hold Read&Write on code+workflows across all repos,
     so Cloud CAN push autonomously — whether it does is a product-behavior question,
     not a permissions one) + the findings digest from the bridge's most recent
     `@claude fix` comment — **sliced + SANITIZED (fix #25):** `findingsDigest()` takes
     only the section after "apply a fix for each:" (else after the first `---`),
     strips every `<!-- ai-loop:v1 … -->` marker, and replaces `@claude` → `claude`.
     WHY: the raw bridge body embeds an `@claude` mention that **re-triggered the Claude
     fixer on the cloud ping** (observed live — claude[bot] 👀 + a no-op + a 👎 on the
     `@codex` comment) and a copied `state=requested` marker that poisons marker-parsing.
     The final cloud comment has exactly ONE mention (`@codex`), zero `@claude`, and only
     its own `agent=codex-cloud state=requested` marker. **HARD LIMIT: ONE codex-cloud attempt
     per head** (dedupe via the marker). **fix #24 fork guard: a fork-headed PR is NEVER
     pinged** (untrusted code; mirrors codex-backup-fix's same-repo guard) — it falls
     through to escalate. Then a 20-min window. **Terminal-summary detection (fix #26):**
     Codex Cloud's sandbox has **no push remote** — instead of pushing it posts a
     TERMINAL summary comment ("View task", sometimes "Created commit `sha` (msg)"). When
     a `/codex/i`-authored comment dated after the ping contains "View task", the stage is
     terminal — do NOT wait the window, go straight to the proxy/escalate path (and parse
     `Created commit \`sha\` (msg)` for the ready-diff hint).
  4. **claude-proxy (NEW, fix #26)** — between codex-cloud and escalate. When the cloud
     stage ended without delivery **AND the original Claude failure was a GENUINE no-op**
     (`claude/no_delivery` — NEVER billing/fixer: a recipe can't fix an empty account) AND
     Claude is enabled AND same-repo AND no proxy attempt exists yet (one/head): post a
     `@claude fix` comment (`agent=claude-proxy state=requested`) telling Claude to
     **implement EXACTLY** Codex Cloud's summary (the `<EMBED>` = the terminal summary body,
     else the findings digest) on the head branch — sanitized per fix #25 **plus**
     `@codex`→`codex`. Then a delivery window. `findingsDigest()` EXCLUDES `claude-proxy`
     comments so it never re-embeds itself; stage 1's `agent==='claude'` filter can't match
     `claude-proxy`.
  5. **escalate** — only after every ENABLED stage failed delivery: the existing
     `needs-owner` upsert (fix #14B) + Telegram, chain-named ("Claude[, the Codex API
     backup,], Codex Cloud[, and the Claude apply-by-proxy] didn't deliver"). **fix #26
     enriched hint:** with a detected commit → "A ready diff waits in the Codex Cloud task
     — commit `sha` (msg). Open the task (View task) → Update branch to apply."; else the
     generic View-task hint.
  Each advance sends a Telegram info line (existing plumbing). The old fixed 3-attempt cap
  is REPLACED by this per-head stage ladder (each stage ≤1/head; escalate terminal/head).
  - **Late-signal sweep (fix #18) — a SECOND step in this same workflow.** Closes
    the late-👍 gap: Codex's 👍 (or review) can land AFTER the gate's 3-attempt
    poll window (~4.5 min) closes, and a reaction fires **no webhook event**, so
    nothing re-runs the gate → the PR strands 🟡-pending forever. Piggybacking on
    the existing 5-min schedule (**zero new billed runs**), the sweep scans every
    open PR, reads the newest `codex-gate-verdict` check-run on the head (via the
    **GITHUB_TOKEN `roCheckRuns` fetch helper** — fix #19; fine-grained PATs can't
    hold Checks, and no module can be loaded in-script; the permissions block gained
    `checks: read`), and treats a **🟡 "Waiting for Codex
    review"** (or absent) verdict as a candidate (🟢 needs nothing; 🔴 is the
    bridge's job). For a candidate, if a **fresh Codex signal on the head** exists —
    a Codex review `submitted_at > latestCommitDate` OR a Codex-authored issue-level
    👍 `created_at > latestCommitDate`, using the gate's EXACT `isCodex` matcher and
    `latestCommitDate` (max committer date across PR commits) — it re-dispatches the
    gate on the head branch exactly as `scheduleRerun` does (`codex-gate.yml`,
    `ref: pr.head.ref`, `inputs.pr_number`), via **AUTOMATION_PAT** (the watchdog's
    dispatch token; loud-fail = `core.error` + Telegram, fix #4). **Self-limiting:**
    after the run the verdict is 🟢 (candidate clears) or 🔴 (skipped thereafter) —
    at most one extra gate run per stuck head per tick. Own step, whole body +
    per-PR `try/catch`, so it never blocks the timeout logic.
    - **Silent-sync class + label bootstrap (fix #21).** A SECOND dispatch class on
      the same 🟡/no-verdict candidate: `isTrustedSync(pr)` (same mirrored predicate,
      "keep in sync" comment) AND head older than `SYNC_GRACE_MINUTES` (= 30, equal
      to the gate's) → dispatch the gate too (log `silent-sync grace: dispatching
      gate for PR #N @ <head7>`), so the gate's trusted-sync grace-green actually
      lands on the head after the window (the gate's own poll can't wait 30 min).
      Self-limiting: the dispatched run flips 🟡→🟢. And ONCE PER TICK before the PR
      loop, the sweep **upserts the `codex-p1-acknowledged` label** (`createLabel`,
      green `0e8a16`, catch/ignore 422) — the incident was that the very override
      label the gate's 🟡 summary tells humans to add did not exist in the downstream
      repo. Mirrors the `needs-owner` upsert pattern.
    - **Auto update-branch (fix #23 Part C).** For each open **loop PR** (carries an
      ai-loop marker OR a `claude/*` head ref OR a trusted sync) that is
      `mergeable_state == 'behind'` and NOT `needs-owner`, the sweep calls
      `pulls.updateBranch` (PUT update-branch, `expected_head_sha` = current head) via
      AUTOMATION_PAT — the owner used to click "Update branch" by hand (TRF #84).
      **NEVER for `'dirty'`** (real conflicts stay a human's job) and **NEVER for a
      fork-headed PR (fix #24 same-repo guard)**. Log `auto update-branch: PR #N`,
      loud-fail (`core.error` + Telegram), at most once per PR per tick. The update
      advances the head → the gate re-runs → the fixer ladder continues on the fresh
      head.
    - **Override-label sweep (fix #26 Part G).** Adding `codex-p1-acknowledged` fires no
      workflow, so a 🔴 PR the owner acknowledged stayed red until a manual head-run
      (TRF #88). The sweep now treats any open PR carrying `codex-p1-acknowledged` whose
      newest `codex-gate-verdict` on the head is **NOT 🟢** as a candidate (regardless of
      the pending check) and dispatches the gate **head-targeted** (`ref: pr.head.ref`,
      the shared helper), log `override-label sweep: dispatching gate for PR #N @ <head7>`,
      loud-fail, once/PR/tick. Self-limiting: the dispatched run sees the label → 🟢 on the
      head → the PR stops matching.
- **`codex-backup-fix.yml`** — `workflow_dispatch` (pr_number, head_sha,
  attempt), two jobs:
  - **`generate-patch`** (`permissions: contents: read` — NO write token):
    fork-PR security guard FIRST (if head repo ≠ this repo → add `needs-owner`
    and stop the whole workflow; never run the agent or expose secrets on fork
    code); checkout the exact `head_sha` (`persist-credentials: false`); gather the
    active Codex finding **filtered for FRESHNESS (fix #24)** — mirrors codex-gate's
    date-only model: keep a review COMMENT only if `created_at > latestCommitDate`
    and a review BODY only if `submitted_at > latestCommitDate` (`latestCommitDate` =
    MAX committer date across the PR's commits, else `pr.created_at`), so stale,
    already-addressed P1/P2s are NOT fed to the agent; run `openai/codex-action@v1`
    (`sandbox: workspace-write`, `safety-strategy: drop-sudo`); capture `git diff
    --binary HEAD > codex.patch` and upload it. Does NOT push.
  - **`apply-and-push`** (`permissions: contents/pull-requests/issues: write`):
    download the patch; **stale-head guard** — re-read the PR head SHA and if it
    moved, do NOT apply the stale patch. Otherwise `git apply --index`, commit, push.
    **Honest end states (fix #24):** the apply step sets a `pushed` output — `'false'`
    on the empty-patch no-op, `'true'` ONLY after `git push` succeeds — and the marker
    is split by outcome: `pushed=='true'` → `agent=codex state=pushed` (as before);
    `pushed=='false'` → `agent=codex state=no_change` (+ `core.notice`, "empty patch —
    not counted as a fix"); the apply step FAILED → `agent=codex state=patch_failed`
    (`if: failure()`, + `core.error`). Previously it posted `state=pushed` even on an
    empty patch (a LIE). The fix #23 watchdog judges the codex-api stage by
    `deliveredSince` (real commits) — it reads only `agent=codex state=requested` and
    NEVER treats `no_change`/`patch_failed`/`pushed` as delivered, so the markers just
    can't lie. Net on a real push: new commit → Codex re-reviews → gate re-checks →
    merge-bot. **No new PR is created.**
- **Claude-reviews-Codex is best-effort, NOT a gate.** No required check depends
  on Claude reviewing Codex's fix — Claude being unavailable (no budget) is a
  known-normal state, and gating on it would deadlock exactly when Codex is the
  backup. The **Codex Gate remains the only required merge gate.**

---

## 4. HARD-WON LESSONS (preserve these — they are not obvious)

1. **The handoff entry MUST be in the SAME commit as the change.** A *trailing*
   handoff commit pushes a new head **after** Codex reviewed the previous head,
   which **resets the gate's head-reviewed state and turns the gate red**. Always
   include the `handoffs/` + `LOOP_STATE.md` updates in the one commit that makes
   the change.
2. **merge-bot must dedupe check runs to the latest run per name.** Otherwise a
   stale early-red `check-codex-status` run blocks **every** merge — this is the
   reason merge-bot never merged for a long time. (Fixed; see §3.)
3. **The gate flickers red on a fresh PR before Codex reviews.** This is
   **by-design fail-closed**, not a bug; the merge-bot latest-per-name dedupe
   makes it harmless (the stale early-red run is ignored once a green run
   exists).
4. **Codex Cloud DOES push fixes to an existing branch** (confirmed) and also
   opens a **parallel PR via its `make_pr` tool**. So a Codex "fix" may appear
   both as a push to the branch and as a separate PR — watch for duplicates.
5. **Codex re-introduces the legacy escalation label on almost every fix** (it
   infers backward-compat from repo history). That label was **fully removed**
   and must **NOT** come back. There are currently **0** issues/PRs carrying it.
   When reviewing a Codex fix, drop any re-added legacy-label clause; keep
   `needs-owner` only.
6. **PRs that touch protected workflow paths do NOT auto-merge, by design** (the
   `.claude-guard.json` guard escalates them). They need a **manual merge** by
   the owner.
7. **The owner merges.** Never claim merge-bot merged a PR without confirmed PR
   closure — verify the PR state before reporting a merge.
8. **PUBLIC repo:** the owner's personal name must never appear anywhere — code,
   comments, commit messages, PR text, docs, or history. Build any check that
   needs the name from runtime data, never by typing it.
9. **Claude Fixer (claude.yml) runs on a PAID budget that is currently
   exhausted,** so the *automated* fixer can't run right now. The **chat** and
   **manually-run Claude Code are separate** and still work. This is exactly why
   **Codex-as-backup** (see TODO) matters — when the paid fixer is down,
   something else has to land the fix.
10. **AUTOMATION_PAT must have the fine-grained `Actions: write` scope.** Without
    it, `createWorkflowDispatch` (watchdog → backup-fix) and minutes-guard's
    enable/disable calls all fail with **403 "Resource not accessible by personal
    access token"**. This was the confirmed root cause of the backup never
    running on PR #33: the watchdog matched and *tried* to dispatch, but the
    dispatch 403'd and was swallowed by `core.warning`. The repo's **Workflow
    permissions** setting (Settings → Actions) governs only the **GITHUB_TOKEN**
    — it does **not** grant the PAT any scope. Fixing it is a manual PAT-settings
    action; the watchdog now surfaces the failure loudly (annotation + Telegram)
    and retries without burning an attempt until the scope is granted.
11. **Bridge-trigger severity and gate-block severity MUST match.** The bridge
    sends a Claude fix on P1 **and** P2, but the Codex Gate originally blocked on
    P1 only — so a **P2-no-P1** PR could go green and **merge BEFORE the fix
    landed** (the merge-before-fix race). Codex caught this on #48. Fix #6: the
    gate now blocks on active P1 **or** active P2, using a `p2Pattern` that
    mirrors `p1Pattern` against the same `P2-yellow` badge the bridge keys on, so
    the two always agree on "what is an active P2". Rule of thumb: any severity
    the bridge auto-fixes, the gate must also block on.
12. **`error_max_turns` + a high `permission_denials_count` in claude-code-action's
    result = the allowlist is too narrow and/or `--max-turns` is too low.** On
    paywall-bot #49 the fixer spent $0.77 over 21 turns with **11 permission
    denials** — it kept trying tools OUTSIDE its narrow `--allowedTools` list,
    burned the 20-turn cap on denial churn, and never opened a fix PR. Fix #7
    raised `--max-turns` 20→50 and broadened the allowlist (`Bash(git:*)`,
    python/python3/pytest/pip/node/npm, ls/cat/find/head/tail/sed/mkdir/cp/mv,
    MultiEdit) + told the fixer to stay inside the allowlist and treat CI as the
    final validation. The fixer can already commit+push via Edit+git, so a
    broader command allowlist adds little marginal risk.
13. **OpenAI quota is exhausted → Codex BACKUP is dead → Claude is the sole
    autonomous fixer.** `openai/codex-action` fails with "Quota exceeded" (see the
    #49 maiden run), so the watchdog must NOT keep dispatching the dead backup.
    Fix #8 gates the dispatch on the Actions variable `CODEX_BACKUP_ENABLED`
    (must be EXACTLY `'true'`; default/unset = disabled): when disabled the
    watchdog escalates to `needs-owner` on the first timeout instead. Re-enable by
    restoring OpenAI quota AND setting `CODEX_BACKUP_ENABLED='true'`. NOTE: Codex
    REVIEW (the GitHub App that posts P1/P2 on PRs) is a SEPARATE OpenAI surface
    from codex-action; if Codex review also lapses on quota, the Codex Gate would
    sit pending (fail-closed) — monitor, and use the `codex-p1-acknowledged`
    override if review stops entirely.
14. **`IGNORE_WORKFLOWS` (ci-doctor) must list EVERY automation/infra workflow
    `name:`, not just the loop ones.** Missing `Minutes Guard` / `Bootstrap repos`
    / `Loop Morning Report` (fix #9) meant their infra failures opened noisy
    `claude-fix` issues. Match the exact `name:` field, and add any NEW infra
    workflow to the set when you create it.

---

## 5. CURRENT STATE

Snapshot against `main` (the loop runs on its own PRs — automation-core is a
consumer of itself).

| Workflow | Live on main? | Notes |
|----------|---------------|-------|
| `codex-auto-fix.yml` (Bridge + archive) | ✅ yes | Bridge now triggers on **P1 + P2** (P3 excluded). |
| `codex-gate.yml` | ✅ yes | Date-only freshness; head-targeted capped self-rerun. |
| `claude.yml` (Claude Fixer) | ✅ yes | **Paid budget currently exhausted.** Now wakes on `issues.opened` carrying `claude-fix` (not just `labeled`); `automerge` is applied ONLY to a PR Claude CREATES to close a claude-fix Issue (no longer to any PR that @-mentions Claude). |
| `ci-doctor.yml` | ✅ yes | Escalates to `needs-owner` only. IGNORE_WORKFLOWS skips ALL automation/infra workflows: Codex Backup Fix, Claude Fallback Watchdog, **Minutes Guard, Bootstrap repos, Loop Morning Report** (fix #9) — so their failures don't open noisy claude-fix issues. |
| `merge-bot.yml` | ✅ yes | Latest-check-run-per-name dedupe; `needs-owner` hard stop; protected-path guard. |
| `telegram-morning-report.yml` | ✅ yes (PR #31 merged) | Hub-only read-only digest; counts-only public logs; honest Telegram delivery + minutes. |
| `claude-fallback-watchdog.yml` | ✅ yes (synced) | On Claude timeout: dispatches the Codex backup **only when `vars.CODEX_BACKUP_ENABLED=='true'`** (fix #8; default disabled → escalates to `needs-owner` on first timeout instead). Marker-based attempt counting; 3 → `needs-owner` + Telegram. Blocked dispatch stays loud (`core.error` + Telegram + `state=dispatch_failed` marker, no burned attempt). |
| `codex-backup-fix.yml` | ⏸️ present but **DORMANT** (synced) | Codex backup fixer via `openai/codex-action@v1`; fork guard + stale-head guard; pushes to the PR head branch. **Disabled by default** — needs OpenAI quota (currently exhausted: "Quota exceeded") AND `CODEX_BACKUP_ENABLED='true'`. Left in place, re-enableable. |
| `bootstrap.yml` | ✅ yes (hub-only) | Onboards a new repo. |
| `minutes-guard.yml` | ✅ yes (hub-only) | Actions-minutes guard. |

- **`AUTOMATION_PAT` is present** in this repo (all cross-workflow writes + the
  morning report's cross-repo reads depend on it).
- **The legacy escalation label is fully removed**; `needs-owner` is the single
  escalation label. **0** issues/PRs carry the legacy label.
- `workflows/` and `.github/workflows/` copies are kept **byte-identical** for
  every synced workflow.

### Downstream requirement for the Codex backup fixer (per-repo)
`sync` copies workflow files only — it does **NOT** copy secrets or Actions
settings. So each downstream repo that wants the Codex fallback must
**independently**:
- set the **`OPENAI_API_KEY`** secret, and
- set **Settings → Actions → General → Workflow permissions = Read and write**
  (the backup needs to push the fix commit to the PR head branch).

Without these the backup simply fails-soft / can't push — harmless on a repo
that hasn't opted in. On **public** repos, **fork PRs are skipped and escalated
to `needs-owner`** (the agent never runs on untrusted fork code, so secrets are
never exposed).

---

## 6. OPEN DECISIONS / TODO

1. **Legacy label keeps coming back on Codex fixes.** Codex re-adds the legacy
   escalation label on nearly every fix; the root cause is likely the repo's git
   **history** (Codex infers backward-compat from it). **Decision pending:**
   whether to rewrite git history to purge the label entirely (a history rewrite
   force-pushes and would disturb open branches, so it needs explicit
   authorization).
2. **Build mutual review.** Each agent reviews **and** fixes the other: Codex
   reviews Claude's fixes; Claude reviews Codex's fixes — up to a **3-round
   limit**, then escalate to `needs-owner`.
3. **Codex-as-backup — DONE.** Built as `claude-fallback-watchdog.yml` +
   `codex-backup-fix.yml`: when Claude doesn't deliver within 20 min, the
   watchdog dispatches the Codex backup, which runs `openai/codex-action@v1` in
   GitHub Actions (not Cloud, which can't push) and pushes the fix to the PR head
   branch — no new PR. Per-repo prerequisites: `OPENAI_API_KEY` + Read-and-write
   workflow permissions (see Downstream requirement above).
4. **PR #31 — DONE** (merged). The morning report is live.
5. **`main` is unprotected** — intentionally, so Claude Code can push directly.
   **Add branch protection once the loop is stable.**
6. **Grant `AUTOMATION_PAT` the fine-grained `Actions: write` scope (MANUAL).**
   This is the outstanding blocker for the Codex backup: without it the watchdog's
   `createWorkflowDispatch` 403s (and minutes-guard's enable/disable too). Repo
   Workflow-permissions does NOT cover the PAT — see Hard-Won Lesson 10.
7. **Five loop-hardening fixes — DONE (this commit):** (1) `claude.yml` only labels
   `automerge` on a PR Claude creates for a claude-fix Issue (not any @claude
   mention); (2) `claude.yml` wakes on `issues.opened` carrying `claude-fix`;
   (3) `ci-doctor.yml` ignores `Codex Backup Fix` + `Claude Fallback Watchdog`;
   (4) watchdog makes a blocked dispatch loud + retryable (no burned attempt);
   (5) the bridge never auto-@claude-fixes the `chore/sync-automation-core` PR
   (fix upstream, not the downstream copy).
8. **Fix #6 — DONE (this commit):** the Codex Gate now blocks on an active **P2**
   as well as P1 (`p2Pattern` mirrors `p1Pattern` against the `P2-yellow` badge
   the bridge keys on), closing the merge-before-fix race a P2-no-P1 PR had — the
   gate-block severity now matches the bridge-trigger severity. Closes Codex #48.
9. **paywall-bot Quality Monitor pileup — DONE** (rolling Issue + cleanup; PR #49,
   Issue #50). Owner-driven by default (`ROUTE_FINDINGS_TO_AUTOFIX=False`).
10. **Fix #7 — DONE (this commit):** `claude.yml`'s fixer was failing
    `error_max_turns` (paywall-bot #49: 20-turn cap exhausted by 11 tool-denial
    churns, no PR). Raised `--max-turns` 20→50 and broadened `--allowedTools`
    (`Bash(git:*)` + interpreters/inspectors + MultiEdit), plus a prompt line to
    stay inside the allowlist and treat CI as final validation. See Lesson 12.
11. **Fix #8 — DONE (this commit):** OpenAI quota is exhausted → the Codex backup
    is dead. The watchdog now dispatches it ONLY when `vars.CODEX_BACKUP_ENABLED
    == 'true'` (default disabled); when disabled it escalates to `needs-owner` on
    the first timeout instead of dispatching a dead backup. `codex-backup-fix.yml`
    left in place, dormant + re-enableable. See Lesson 13.
12. **Fix #9 — DONE (this commit):** added `Minutes Guard`, `Bootstrap repos`,
    `Loop Morning Report` to ci-doctor's `IGNORE_WORKFLOWS`. See Lesson 14.
13. **Re-enable Codex backup when OpenAI quota returns:** restore OpenAI billing,
    then set Actions variable `CODEX_BACKUP_ENABLED='true'`. Until then Claude
    (Anthropic budget OK) is the sole autonomous fixer; watch that Codex *review*
    doesn't also lapse on quota (would leave the gate pending).
14. **Fix #10 — DONE (this commit):** when `claude.yml`'s fixer RAN but did not
    succeed, a new fail-soft step swaps the triggering comment's reaction from 👀
    (eyes, "in progress") to 👎, so a failed run no longer looks like it's still
    checking. github-script, gated `always() && has_key=='true' && claude.outcome
    != 'success'`; picks the issue- vs review-comment reaction endpoint by event
    name; deletes the bot's 👀 then adds 👎; no-ops on Issue events with no
    comment id; never fails the job.
15. **Next steps:** close #38 (the sync PR that tripped the breaker — its findings
    belong upstream, now suppressed); run a **fresh sync to downstreams** so they
    pick up these workflow fixes (fix #6 + #7 + #8 + #9 + #10).

---

## 7. CONVENTIONS

- **Every Claude Code prompt opens with the no-name rule:** never write the
  owner's personal name (or the legacy label string) anywhere.
- **The handoff entry goes in the SAME commit as the change** (never a trailing
  commit — see Lesson 1).
- **`workflows/` and `.github/workflows/` are kept byte-identical** for every
  synced workflow (verify with `git hash-object` on both copies).
- **Greps are reported by COUNT only** (never echo the matched name/label
  string).
- **Scope each task to one repo**, stated explicitly, and commit directly to the
  named branch (often `main` here, since `main` is unprotected by design).
- **Validate before commit:** `actionlint` on both workflow copies + `node
  --check` on each `github-script` block.
- **HARD RULE — never load a module inside `actions/github-script` (fix #19).**
  BOTH module-loading forms have crashed merge-bot in production with `Cannot
  find module .../dist/index.js`: the v7 `require('@actions/github')` and the v8
  `__original_require__('@actions/github')`. Root cause: the action ships an
  **ncc-bundled `dist` with NO `node_modules`** — there is nothing to resolve,
  under either require, in either major. The provided `github`/`context`/`core`
  globals are fine (they're injected, not required). When you need a SECOND token
  (e.g. a GITHUB_TOKEN read client because the step's `github-token` is a
  fine-grained PAT that can't hold Checks), the ONLY sanctioned pattern is **raw
  REST via the built-in global `fetch`** (Node 20/24 both have it) — the
  `roPage` / `roPaged` / `roCheckRuns` / `roStatuses` helpers (a `Bearer` header +
  `Accept: application/vnd.github+json` + `X-GitHub-Api-Version: 2022-11-28`).
  **Pagination follows the `Link` `rel="next"` header until absent, with a 50-page
  safety ceiling** (fix #20 — the earlier fixed 10-page valve could silently drop
  runs on a very chatty head; Codex flagged the cap on a downstream sync PR, but a
  downstream workflow edit is always overwritten by the next sync — and misses the
  watchdog's copy — so the fix was adopted HERE upstream, still zero-module).
  Zero modules, zero dependencies. Grep must
  stay clean of `require('@actions/github')`, `__original_require__`, and
  `getOctokit`.
