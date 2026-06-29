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
  `automerge`.
- **`ci-doctor.yml`** — **CI Doctor.** Detects failed CI runs, opens (deduped)
  `claude-fix` Issues, escalates to `needs-owner` after repeated failure.
- **`merge-bot.yml`** — **Merge Bot.** Squash-merges green candidate PRs.

**Hub-only** (run here, NOT synced downstream):

- **`telegram-morning-report.yml`** — once-daily **read-only** Telegram digest of
  the loop's state across all of the owner's repos (dynamically discovered).
- **`bootstrap.yml`** — onboards a new repo into the loop.
- **`minutes-guard.yml`** — guards Actions-minutes spend across repos.

---

## 3. KEY MECHANISMS (precise)

### codex-gate.yml — the blocking gate
- Publishes the `check-codex-status` check; **fail-closed** (red until proven
  green). **(fix #11)** The job is named **`codex-gate`** and it publishes
  `check-codex-status` as an EXPLICIT check-run (octokit `checks.create`/`update`
  on the PR head, find-and-update so there's one per head) carrying
  `output.title`/`summary` — so a red gate shows WHY instead of a blank red
  square: 🟡 "Waiting for Codex review" (pending), 🔴 "Active Codex P1/P2"
  (blocked), 🟢 "Reviewed — clear" (green). The GREEN/RED **logic is unchanged**;
  publishing is fail-soft (a cosmetic output error never flips the verdict). The
  check NAME stays exactly `check-codex-status` (merge-bot reads it).
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
- **Head-targeted self-rerun (capped):** re-runs itself so a clean verdict lands
  on `pr.head.sha`; the rerun count is capped (via a workflow-specific
  `listWorkflowRuns` lookup) so it can't loop forever. **(fix #12)** `MAX_ATTEMPTS`
  lowered **5→3** — since fix #11 lands the check on the head from every run, the
  poll's only remaining job is catching a 👍 reaction (which fires no event), so
  3 polls suffice. The poll is kept (not removed).
- **Run-collapsing concurrency (fix #12):** a top-level `concurrency` block
  (`group: codex-gate-pr-<pr#||inputs.pr_number||issue#||run_id>`,
  `cancel-in-progress: true`) cancels OVERLAPPING gate runs for the SAME PR,
  leaving only the latest authoritative run. A Codex review fires both
  `pull_request_review` and `pull_request_review_comment` (one per inline note)
  and a push fires a `pull_request` run + its self-rerun — ~4 runs/wave; this
  collapses the simultaneous burst to one. Sequential self-reruns (~90s apart)
  don't overlap, so they're untouched. Safe because every run publishes
  `check-codex-status` on the PR HEAD sha (fix #11), so the surviving run's
  find-and-update lands the check on the head — a canceled run leaves no stale
  check. The `|| github.run_id` fallback guarantees a non-empty group key.
- **Triggers** on `push` + review + comment events so it re-evaluates whenever
  the head or the review state changes.
- Manual override label: `codex-p1-acknowledged`.

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
- **Requires AUTOMATION_PAT** (fail-soft skip if absent).
- **Evaluates only the LATEST check run per name (dedupe).** GitHub emits
  **multiple** `check-codex-status` runs on one head over a PR's life — an early
  pending/red run when the PR opens, then a success run after Codex reviews.
  Merge Bot sorts check runs by recency (`completed_at`, else `started_at`,
  descending) and keeps the **first occurrence per name** before scanning for
  failures and before the codex-gate lookup, matching GitHub's own gating. (See
  Hard-Won Lessons — scanning every run is what kept merge-bot from ever
  merging.)

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

### Codex backup fixer + watchdog (Claude is first, Codex is backup)
Claude is the FIRST fixer; Codex is a BACKUP fixer that runs **in GitHub
Actions** (NOT Codex Cloud — Cloud strips secrets before its agent phase, so it
cannot push).

- **`claude-fallback-watchdog.yml`** — schedule `2-59/5 * * * *` (every 5 min) +
  `workflow_dispatch`. For each open PR with a `state=requested agent=claude`
  ai-loop marker on the current head, it fires the Codex backup ONLY when ALL
  hold: PR still open; the marker's `head` still equals the PR head SHA; Claude
  has not delivered (no Claude-app commit on the head after the marker); ≥ the
  **20-minute** timeout has elapsed since the marker's comment; no `agent=codex`
  marker already exists for this head; and cumulative attempts < 3. It then
  `workflow_dispatch`-es `codex-backup-fix.yml` (inputs `pr_number`, `head_sha`,
  `attempt=max+1`) and posts a `agent=codex state=requested` marker so the
  attempt is counted and never re-fired. At 3 attempts it adds `needs-owner` +
  a counts-only Telegram alert instead of firing Codex.
- **`codex-backup-fix.yml`** — `workflow_dispatch` (pr_number, head_sha,
  attempt), two jobs:
  - **`generate-patch`** (`permissions: contents: read` — NO write token):
    fork-PR security guard FIRST (if head repo ≠ this repo → add `needs-owner`
    and stop the whole workflow; never run the agent or expose secrets on fork
    code); checkout the exact `head_sha` (`persist-credentials: false`); run
    `openai/codex-action@v1` (`openai-api-key: OPENAI_API_KEY`, `sandbox:
    workspace-write`, `safety-strategy: drop-sudo`) with a prompt pointing the
    agent at the active Codex finding; capture `git diff --binary HEAD >
    codex.patch` and upload it as an artifact. Does NOT push.
  - **`apply-and-push`** (`permissions: contents/pull-requests/issues: write`):
    download the patch; **stale-head guard** — re-read the PR head SHA and if it
    moved since `head_sha`, do NOT apply the stale patch (post a counts-only note
    and exit; a fresh review on the new head starts a new cycle); otherwise
    `git apply --index`, commit, and **push directly to the PR head branch**
    (`git push origin HEAD:<head_ref>`). Posts a `agent=codex state=pushed`
    marker. Net: the existing PR gets a new commit → Codex auto-reviews → Codex
    Gate re-checks → merge-bot proceeds. **No new PR is created.**
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
