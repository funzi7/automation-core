# LOOP_STATE.md — Self-Healing Loop: project state

> Source of truth for the autonomous CI self-healing loop across @funzi7's repos.
> Update this file on every significant change. Snapshot taken against `main` @ `171f33f`.

**Resume in a new chat:** _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

> 📖 **Canonical full briefing:** [`handoffs/CONTEXT.md`](handoffs/CONTEXT.md) is the single self-contained handoff that lets a brand-new chat or a different AI understand the ENTIRE system (purpose, architecture, key mechanisms, hard-won lessons, current state, open TODOs, conventions). Start there; this file is the detailed per-workflow reference.

---

## Architecture (planned end state)

```
push to a PR
   │
   ▼
Codex reviews the PR        (GitHub App, automatic on every push — not a workflow here)
   │  leaves P1/P2 findings
   ▼
Bridge (codex-auto-fix.yml) posts ONE "@claude fix" per review wave   (via AUTOMATION_PAT)
   │
   ▼
Claude Fixer (claude.yml)   fixes on a branch — the RELIABLE fixer.
   │  opens a PR with "Fixes #N" + the `automerge` label
   ▼
Codex re-reviews the new commit
   │  Circuit breaker: after 3 @claude-fix rounds that don't converge
   │  → add `needs-owner` + Telegram ping, stop auto-triggering
   ▼
Merge Bot (merge-bot.yml)   merges when everything is green
                            (identifies Claude PRs by the `automerge` LABEL, not author login,
                             because Claude's PRs are PAT-authored = owner, not a bot)
```

**Direction is deliberate: Codex reviews, Claude fixes.** Codex is unreliable at *fixing* (phantom commits); Claude is the trusted fixer. We never hand the fix back to Codex.

**Labels (uniform across all repos):**
| Label | Meaning |
|-------|---------|
| `claude-fix` | "Claude, fix this." Set by CI Doctor; triggers Claude Fixer. |
| `automerge` | May be auto-merged by Merge Bot once green. Set by Claude's PR step. |
| `needs-owner` | Escalation — automation stopped, a human must act. Hard stop for Merge Bot. (The sole escalation label; the older one was fully removed.) |
| `ci-doctor` | Marks Issues opened by CI Doctor (dedup + close). |

---

## Workflows (current state on `main`)

Generic loop workflows live in `workflows/` (sync source) and are copied byte-identical into `.github/workflows/` so automation-core runs the loop on its own PRs (it is consumer #12 of itself). `sync-config.json.synced_workflows = [codex-auto-fix.yml, codex-gate.yml, claude.yml, ci-doctor.yml, merge-bot.yml, claude-fallback-watchdog.yml, codex-backup-fix.yml]`.

> **Note:** there is **no separate `codex-claude-bridge.yml`** — "the bridge" IS the `trigger_codex_fix` job inside **`codex-auto-fix.yml`**.

### claude.yml — Claude Fixer  (sha `a33a4a8`)
- **Does:** runs `anthropics/claude-code-action@v1` to fix a `claude-fix` Issue (or an `@claude` mention), opens a PR (`Fixes #N`), then labels that PR `automerge` — **only** a PR Claude CREATES to close a claude-fix Issue (open PRs matching `Fixes #<issueNum>`). It **no longer** labels an arbitrary PR reached via an `@claude` mention (Codex P1: that auto-merged any PR merely mentioning Claude). Label step still gated on `if: steps.claude.outcome == 'success'`.
- **Triggers:** `issue_comment: [created]`, `pull_request_review_comment: [created]`, `issues: [opened, labeled, assigned]`. Job `if:` clauses: `@claude` mention / assigned / `labeled && label==claude-fix` / **`opened` && issue carries `claude-fix`** (`contains(join(github.event.issue.labels.*.name, ','), 'claude-fix')`) — so a fresh ci-doctor Issue (created already carrying `claude-fix`, firing `issues.opened` not `labeled`) is no longer missed.
- **Concurrency:** `group: claude-fix-${{ issue.number || pull_request.number }}`, **`cancel-in-progress: false`** (never kill a paying run).
- **Auth:** `github_token: AUTOMATION_PAT || github.token`. fail-soft on missing `ANTHROPIC_API_KEY` (exits green).
- **`claude_args` (fix #7):** `--max-turns 50` + a **broad** `--allowedTools` (`Read,Glob,Grep,Edit,Write,MultiEdit,Bash(git:*),Bash(python:*),Bash(python3:*),Bash(pytest:*),Bash(pip:*),Bash(node:*),Bash(npm:*),Bash(ls:*),Bash(cat:*),Bash(find:*),Bash(head:*),Bash(tail:*),Bash(sed:*),Bash(mkdir:*),Bash(cp:*),Bash(mv:*),Bash(gh pr:*),Bash(gh issue:*),Bash(actionlint)`). The old `--max-turns 20` + narrow per-subcommand list caused **`error_max_turns`** on paywall-bot #49 (21 turns, **11 permission_denials** from tool-denial churn, no PR opened — budget WAS fine: $0.77 spent). The prompt now also tells the fixer to stay inside the allowlist and treat the PR's CI (codex-gate) as the final validation rather than blocking on a local full-suite run. Security: the fixer can already commit+push via Edit+git, so the broader command allowlist adds little marginal risk.
- **Failed-fix reaction swap (fix #10):** a fail-soft github-script step after the Claude step (gated `always() && has_key=='true' && steps.claude.outcome != 'success'`) swaps the triggering comment's 👀 (added by claude-code-action) to 👎, so a failed run doesn't look like it's still "checking". Picks the issue-comment vs review-comment reaction endpoint by `context.eventName`; deletes the bot-authored `eyes` reaction then adds `-1`; no-ops when there's no triggering comment id (Issue `opened`/`labeled` events); wrapped in try/catch so a reaction error never fails the job. Reaction only — no extra comment.

### codex-auto-fix.yml — the Bridge + Codex-summary archive  (sha `e0bda69`; P1+P2 trigger (exclude P3) + cross-channel debounce)
- **Job `trigger_codex_fix`:** on a Codex review that carries an **active P1 or P2** finding (real bug / security, or an important correctness/quality issue), posts **exactly one** `@claude fix` per review wave. **P3 (minor styling/cosmetic) never auto-triggers.** Detection reuses the existing badge substring check: Codex tags each finding with a shields.io severity badge whose label is the literal token (`P1-orange`, `P2-yellow`, `P3-...`), so `body.includes("P1") || body.includes("P2")` catches P1/P2 and never a P3-only finding. Same freshness rule (only Codex bodies dated after the latest commit). The posted comment notes which severity (P1/P2) and a best-effort finding count. The 3-round circuit breaker still bounds the loop. (Earlier the bridge was P1-only; P2 — which routinely carries real correctness issues like "false-green health" — was expanded in.)
  - **Sync-PR suppression:** the bridge sets `should_trigger=false` (no loop marker, no `@claude fix`) when the PR head ref is `chore/sync-automation-core` OR the title starts with `chore(automation): sync from automation-core`. Codex findings on a sync PR are about the UPSTREAM workflow design and must be fixed in automation-core upstream — auto-patching the downstream copy would diverge it and trip the 3-round breaker → `needs-owner` (exactly what happened to #38). Codex still reviews; only the auto-trigger is suppressed.
  - **Cross-channel debounce:** a Codex review with N inline notes fires N events across **two** channels (top-level `issue_comment` **and** inline `pull_request_review_comment`) — the bridge posts its own inline trigger as a review-comment *reply*. The dedupe counts the `[auto-triggered]` marker across **all** channels (issue comments + review comments + reviews), so once one trigger for the current head exists, no further event re-fires → one trigger per wave. (The old code counted only `issues.listComments` and missed the inline replies, so PR #19 got 2 triggers from 3 notes.)
  - Circuit breaker `MAX_FIX_ROUNDS = 3` → `needs-owner` + Telegram (now counts markers across all channels too). Posts with `AUTOMATION_PAT` (else a GITHUB_TOKEN comment wouldn't trigger claude.yml).
  - Concurrency: `codex-claude-bridge-${{ repo }}-${{ pr }}`, `cancel-in-progress: false` (serializes near-simultaneous events so the dedupe is seen before the next event runs).
- **Job `archive_codex_summary`:** archives Codex post-fix summaries to `funzi7/agent-memory` (needs `AGENT_MEMORY_PAT`, fail-soft if absent). Concurrency `codex-summary-archive`.
- **Triggers:** `pull_request_review: [submitted]`, `pull_request_review_comment: [created]`, `issue_comment: [created]`. **Does NOT listen to `issues` events** (removed in PR #17 — it was waking + skipping in ~2s on every Issue label).
- _Removed in PR #17:_ the `trigger_codex_on_health_issue` job (auto-tagged `@codex` on `site-health` Issues). Not currently running anywhere — see Open debt.

### codex-gate.yml — Codex Gate (blocking check)  (sha `92019ec`; P1+P2 block + wait-for-first-review + head-targeted self-rerun)
- **Does:** the `check-codex-status` blocking check. **GREEN requires BOTH:** (a) Codex has **reviewed the current head** — a Codex signal (review / comment / inline / 👍) **dated after the latest commit** — **and** (b) **no ACTIVE P1 and no ACTIVE P2** — a P1 marker (`p1Pattern`, badge `P1-orange`) OR a P2 marker (`p2Pattern`, badge `P2-yellow`) **dated after the latest commit**, not yet followed by a later Codex fix Summary. **Fix #6 (closes Codex #48):** the gate previously blocked on P1 only, but the bridge triggers a Claude fix on P1 **and** P2 — so a P2-no-P1 PR could merge BEFORE the fix landed (merge-before-fix race). `p2Pattern` mirrors `p1Pattern` exactly (same `P2-yellow` badge fragment + line-leading `**P2**`/`[P2]`/`P2:`, same `stripSummarySections` + later-fix-Summary-clears-it logic), so **gate-block severity == bridge-trigger severity**. **ONE consistent date-only freshness rule**: `commit_id` is **never** used to decide freshness, because GitHub re-points a still-applicable inline comment's `commit_id` to the new head — so `commit_id == head` does NOT mean Codex reviewed the new commit. It **BLOCKS** on an unresolved active P1/P2 **OR** when Codex hasn't reviewed the head yet (**pending**). Otherwise GREEN: clean review, **P3**, 👍, or a **stale P1/P2 (predating the latest commit)** once Codex has re-reviewed. `codex-p1-acknowledged` = manual override. `latestCommitDate` = the **max** committer date across the PR's commits (not assumed sorted). Same P1/P2 detection as the bridge across the same 3 channels, fully paginated.
- **Wait-for-first-review, NOT approval:** the pending block is the #66/#67-race guard — it stops merge-bot from merging before Codex has weighed in. ANY Codex signal on the head (even an empty/👍 review) flips it green; escape hatch if Codex never reviews = the override label (no fail-open merge at timeout).
- **Explicit check-run with output (fix #11):** the job is named **`codex-gate`**; `check-codex-status` is published as an EXPLICIT check-run via octokit `checks.create`/`checks.update` (`checks: write`) on the PR head, find-and-update so there's exactly one per head and no job-status duplicate. It carries `output.title`/`summary` per state — 🟡 "Waiting for Codex review" (pending, includes rerun attempt N/MAX), 🔴 "Active Codex P1/P2" (blocked, names last-active/last-fix dates), 🟢 "Reviewed — clear" (green/override/stale-only) — each with the 7-char head SHA — so a red gate shows WHY instead of a blank red square. The verdict LOGIC, freshness rule, P1/P2 detection, self-rerun, and MAX_ATTEMPTS are unchanged; publishing is wrapped in try/catch and fail-soft (a cosmetic output error never flips the gate or crashes the job). Name stays exactly `check-codex-status` (merge-bot reads it).
- **Run-collapsing concurrency + smaller poll (fix #12):** the gate was over-running (~275 runs on a downstream) — a Codex review fires both `pull_request_review` and `pull_request_review_comment` (one per inline note) and a push fires a `pull_request` run + its self-rerun (~4 runs/wave). Added a top-level `concurrency: { group: codex-gate-pr-${{ pull_request.number || inputs.pr_number || issue.number || run_id }}, cancel-in-progress: true }` so OVERLAPPING runs for the same PR cancel down to the latest authoritative one (sequential ~90s self-reruns don't overlap → untouched; the `|| run_id` fallback prevents an empty group). Safe because every run publishes `check-codex-status` on the PR HEAD sha (fix #11) so the survivor's find-and-update lands the check on the head. Also lowered `MAX_ATTEMPTS` **5→3** (fix #11 already lands the check from every run, so the poll now mainly covers the 👍-reaction case which fires no event). Verdict logic / freshness / P1/P2 detection / override unchanged.
- **Head-targeted self-rerun (restored — fixes the 2 P1s Codex raised on PR #25):** merge-bot reads `check-codex-status` via `checks.listForRef(pr.head.sha)`, so the green must land **on the head commit**. A 👍 reaction fires no event, and an `issue_comment` (e.g. a fix Summary) runs on the **default branch**, so neither lands on the head on its own. So whenever the gate is non-green-on-head — pending (incl. the 👍 poll) OR a clean verdict computed on a run whose `head_sha != pr.head.sha` — it re-dispatches itself via `createWorkflowDispatch` against the **PR head branch** (`ref = pr.head.ref`); that run's `head_sha == pr.head.sha`, so its check lands where merge-bot looks. Capped at `MAX_ATTEMPTS = 5` per head SHA, ~90s apart; a new push resets the cap. The attempt count uses the workflow-specific `actions.listWorkflowRuns` (the repo-level `listWorkflowRunsForRepo` ignores `workflow_id` and would count unrelated workflows' runs toward the cap). Needs `actions: write` (restored). This makes all four clean paths land green on the head: **reaction-only / comment-only / review-no-P1 / P1-then-Summary**.
- **fail-soft:** a *technical* error evaluating a PR does NOT block (never wedge a PR red on an API hiccup); a *detected* P1 always blocks (safety wins).
- **Triggers:** `pull_request: [opened, synchronize, reopened]`, `pull_request_review: [submitted, edited, dismissed]`, `pull_request_review_comment: [created, edited, deleted]`, `issue_comment: [created, edited, deleted]`, `workflow_dispatch` (self-rerun / manual re-check, input `pr_number`, dispatched against the head branch).

### ci-doctor.yml — CI Doctor  (sha `ae4ba37`)
- **Does:** scans the default branch for failed runs (13h lookback), opens a `claude-fix` Issue per failure (logs tail + root-cause prompt), upserts the loop labels, nudges ≤3 attempts then escalates to `needs-owner` + Telegram. Skips Issues already escalated. **`IGNORE_WORKFLOWS`** (EVERY automation/infra workflow `name:`, not just loop ones) = CI Doctor, Claude Fixer, Merge Bot, Sync from automation-core, Codex Gate, Codex Auto-Fix, Codex Backup Fix, Claude Fallback Watchdog, **Minutes Guard, Bootstrap repos, Loop Morning Report** (last three added in fix #9) — so an infra-workflow failure (dispatch 403, minutes-guard push denial, morning-report hiccup, etc.) doesn't get filed as product CI breakage. Add any NEW infra workflow's `name:` here too.
- **Triggers:** `schedule: '0 6,18 * * *'` (twice daily) + `workflow_dispatch`.
- **Concurrency:** `ci-doctor-${{ repo }}`, `cancel-in-progress: false`. Uses `AUTOMATION_PAT` for all writes.

### merge-bot.yml — Merge Bot  (sha `b8c4372`)
- **Does:** squash-merges (head-SHA-pinned) PRs that are fully green. Candidate = Claude-bot author **OR `automerge` label OR** trusted sync PR **OR** a same-repo `claude/*` head branch (Claude Code's PRs are AUTOMATION_PAT-authored = owner, not a bot, and carry no `automerge` label, so they're recognized by their `claude/` branch — fork PRs excluded via the same-repo check); `needs-owner` is a hard stop checked FIRST. `check-codex-status` must **exist AND be success** (fail-closed). `.claude-guard.json` protected-path guard → escalate. Closes linked CI-Doctor Issue. **Evaluates only the LATEST check run per name** (GitHub emits multiple `check-codex-status` runs on a head — an early pending/red one, then a success after Codex reviews); scanning every run tripped on the stale early-red run and skipped every merge — the reason merge-bot never merged. Now deduped to the most recent run per name (by `completed_at`/`started_at`), matching GitHub's own gating.
- **Triggers:** `workflow_run: ["Codex Gate"] [completed]`, `schedule: '30 7 * * *'`, `workflow_dispatch`. Job early-exits unless a **successful** Codex Gate `workflow_run`, the cron, or manual. (PR #27 dropped the `check_suite` trigger.)
- **Concurrency:** `merge-bot-${{ repo }}`, `cancel-in-progress: false`. Merges with `AUTOMATION_PAT` (so the push triggers downstream).

### sync-automation-core.yml — per-repo sync  (sha `a7c8563`, lives only in `.github/workflows/`)
- **Does:** clones automation-core's `main`, copies `synced_workflows` into the repo's `.github/workflows/`, opens a `chore(automation): sync from automation-core` PR on diff. Uses `AUTOMATION_PAT` (the `GITHUB_TOKEN` template variant can't push files under `.github/workflows/`).
- **Triggers:** `schedule: '0 3 * * *'` (daily) + `workflow_dispatch`.

### minutes-guard.yml — Actions minutes guard  (sha `a64db42`, automation-core only, public/free)
- **Does:** detects billing-kill failures in `TARGET_REPOS = [funzi7/paywall-bot, funzi7/thai-rent-finder]` and disables their *scheduled* workflows when the account quota is exhausted; re-enables monthly.
- **Triggers:** `schedule: '*/30 * * * *'` + `'5 0 1 * *'` (monthly re-enable) + `workflow_dispatch` (`force_enable`, `dry_run`). Auth: `CROSS_REPO_PAT`.
- ⚠️ **TARGET_REPOS is stale** vs the loop: OptionsProfitTracker + paper-trader also have crons and are NOT protected (see the minutes audit).

### claude-fallback-watchdog.yml — Claude timeout → Codex backup (gated) / escalate  (synced)
- **Backup gate (fix #8):** the Codex backup (`codex-backup-fix.yml`) needs OpenAI quota, currently exhausted, so dispatch is gated on the Actions variable **`CODEX_BACKUP_ENABLED`** — it must be EXACTLY `'true'`; anything else (incl. unset) = **DISABLED (default)**. When DISABLED, on the FIRST timeout the watchdog does NOT dispatch — it escalates: adds `needs-owner` (deduped against a prior `agent=watchdog state=escalated` marker for the head or an existing `needs-owner` label), posts "Claude didn't fix PR #N within the timeout and the autonomous backup is disabled (no OpenAI quota) — needs a manual fix.", and sends a counts-only Telegram alert (fail-soft). When ENABLED, the original dispatch path (incl. the 3-attempt cap) runs unchanged.
- **Does (ENABLED path):** every 5 min (`schedule: '2-59/5 * * * *'` + `workflow_dispatch`), scans open PRs for an `ai-loop:v1 … agent=claude state=requested` marker on the current head and, when Claude has not delivered within the **20-minute** timeout, dispatches `codex-backup-fix.yml` (inputs `pr_number`, `head_sha`, `attempt=max+1`) and posts an `agent=codex state=requested` marker so the attempt is counted and not re-fired. **Fires only when ALL hold:** PR open; marker `head` == PR head SHA; no Claude-app commit on the head after the marker; ≥20 min elapsed since the marker; no `agent=codex` **requested/pushed** marker yet for this head; cumulative attempts < 3. At **3 attempts** → adds `needs-owner` + a counts-only Telegram alert (no Codex fire). **Attempt counting rule:** counted ONLY by `ai-loop:v1 … attempt=` markers — never Codex reviews, inline notes, commits, watchdog re-runs, debounced `@claude fix`, or un-pushed patches. **Blocked-dispatch handling (root cause of the #33 stall):** when `createWorkflowDispatch` throws (e.g. 403 "Resource not accessible by personal access token" — `AUTOMATION_PAT` missing `Actions: write`), it's now **loud, not silent**: `core.error` (annotation) + counts-only Telegram (fail-soft if Telegram unset) + a deduped `<!-- ai-loop:v1 … agent=watchdog state=dispatch_failed -->` marker with **no `attempt=`** field — so no attempt is burned, `needs-owner` is NOT added, and the watchdog auto-retries each tick until the PAT scope is fixed. The "already fired" guard matches only `agent=codex` `state` requested/pushed, so the failure marker can't be misread as "already fired". **Permissions:** `contents: read`, `pull-requests/issues: write`. **Auth:** `AUTOMATION_PAT` (fail-soft if absent; needs `Actions: write` to dispatch). Reads issue + review-comment channels for markers.

### codex-backup-fix.yml — Codex backup fixer (CI agent, pushes to PR head)  (synced; DORMANT — fix #8)
- **DORMANT by default:** the watchdog only dispatches this when `vars.CODEX_BACKUP_ENABLED == 'true'`. Currently OFF because the OpenAI quota is exhausted — the maiden run on paywall-bot #49 failed with `ERROR: Quota exceeded. Check your plan and billing details.` (codex-action ran model `gpt-5.5`, no auth issue; apply-and-push then SKIPPED → no commit). Left in place + re-enableable: restore OpenAI quota AND set `CODEX_BACKUP_ENABLED='true'`.
- **Does:** `workflow_dispatch` (inputs `pr_number`, `head_sha`, `attempt`). Runs Codex **in GitHub Actions** via `openai/codex-action@v1` (NOT Codex Cloud, which strips secrets pre-agent and cannot push), generates a patch, and pushes it directly to the **existing PR head branch** — no new PR, so merge-bot is unchanged; Codex then auto-reviews the new head and the Codex Gate re-checks.
- **Job 1 `generate-patch`** (`permissions: contents: read` — NO write token): **fork-PR security guard FIRST** (head repo ≠ this repo → add `needs-owner`, `setFailed`, stop the whole workflow; never run the agent or expose secrets on fork code); checkout the exact `head_sha` (`persist-credentials: false`); write the active Codex P1/P2 finding to `codex-finding.txt`; run `openai/codex-action@v1` (`openai-api-key: OPENAI_API_KEY`, `sandbox: workspace-write`, `safety-strategy: drop-sudo`); capture `git diff --binary HEAD > codex.patch`; upload as artifact. Does **not** push.
- **Job 2 `apply-and-push`** (`needs: generate-patch`; `permissions: contents/pull-requests/issues: write`): download the patch; **stale-head guard** — re-read the PR head SHA, and if it moved since `head_sha`, do NOT apply the stale patch (post a counts-only note, exit); else `git apply --index`, commit, and `git push origin HEAD:<head_ref>`; post an `agent=codex state=pushed` marker.
- **Per-repo prerequisites (sync does NOT copy these):** `OPENAI_API_KEY` secret + Settings → Actions → Workflow permissions = **Read and write**. **Claude-reviews-Codex is best-effort, never a required check** — the Codex Gate stays the only required merge gate (gating on a possibly-unavailable Claude would deadlock the backup).

### bootstrap.yml — onboarding + auto-enrollment  (automation-core only)
- **Does:** installs `sync-automation-core.yml` into eligible repos via PRs (`chore(automation): bootstrap...`). Eligible = owner / non-archived / non-fork / not automation-core / no existing sync workflow / no `.automation-core-ignore` opt-out. **Auto-enrollment (Stage 3):** a weekly `schedule` sweep OPENS an onboarding PR in any newly-eligible repo but **never merges** it — auto-propose, not auto-apply; the PR is the human checkpoint (a brand-new/experimental repo can't get automation wired in and merged with zero review). **Triggers:** `schedule: '0 4 * * 1'` (Mondays 04:00 UTC, NOT dry-run — opens PRs) + `workflow_dispatch` (inputs `dry_run`, `target_repo`; `dry_run` previews without opening PRs). fail-soft: missing `CROSS_REPO_PAT` → green run + notice (no red); a single failing repo is recorded and skipped (per-repo try/catch) so one bad repo can't abort the unattended sweep. Auth: `CROSS_REPO_PAT`.

### telegram-morning-report.yml — Loop Morning Report  (NEW; automation-core only, NOT synced)
- **Does:** once-daily **read-only** Telegram digest of the loop's state across ALL of the owner's repos (dynamically discovered via `listForAuthenticatedUser`, forks/archived excluded — new repos appear automatically). Sections: 🔴 NEEDS ATTENTION (PRs labeled `needs-owner`, per repo) → ⏳ OPEN PRs (per repo, each PR's `check-codex-status` gate state 🟢/🔴/⏳/⚪) → ✅ MERGED (24h) → ⚙️ HEALTH (failing health-check/site-health/ci-doctor runs + disabled/paused workflows; the health workflow is matched **by PATH first** — `*/ci-doctor.yml` / `health-check.yml` / `site-health.yml` — with a spacing/casing-tolerant name regex as fallback, so the synced doctor's display name "CI Doctor" is caught and HEALTH no longer falsely shows all-green) → 📊 ACTIONS MINUTES (account billing, or n/a). Splits at ~3800 chars across multiple Telegram messages; also logs the full report to the Actions run summary.
- **Strictly read-only:** only `repos.listForAuthenticatedUser` / `pulls.list` / `checks.listForRef` / `actions.listRepoWorkflows` / `actions.listWorkflowRuns` (+ a billing GET and the Telegram POST). NO writes anywhere — no labels, comments, merges, or dispatches. Each repo is wrapped in try/catch (one bad/empty repo is noted "unavailable", never aborts the digest).
- **Triggers:** `schedule: '30 5 * * *'` (05:30 UTC, offset from the other crons) + `workflow_dispatch`. **Permissions:** `contents/actions/pull-requests/issues: read`. **Auth:** `AUTOMATION_PAT` (read across private repos); billing tries `CROSS_REPO_PAT` then falls back to `AUTOMATION_PAT`. fail-soft on every secret: missing `AUTOMATION_PAT` → exit green; missing Telegram creds → still write the run summary, skip the send.

---

## Key decisions made

- **Claude fixes, Codex reviews.** Codex produces phantom/empty fix commits; Claude is the reliable fixer.
- **`--max-turns 20`** in claude.yml (balance cost vs completing the task; most fixes need far fewer than 35).
- **`cancel-in-progress: false`** on claude.yml — never kill a run that is already burning money; a second event queues behind it.
- **Final minimal allowlist** in claude.yml (`Read,Glob,Grep,Edit,Write` + scoped `git`/`gh pr`/`gh issue`/`actionlint`; no bare `Bash`, no interpreters, no `gh api`) — ends the "shrink-the-allowlist" loop; if something's missing the fixer fails to `needs-owner` rather than looping.
- **Codex Gate kept as a blocking check** — the human waits for the loop instead of merging manually.
- **Merge Bot identifies Claude PRs by the `automerge` label OR a same-repo `claude/*` branch**, not author login (Claude's PRs are PAT-authored = owner `funzi7`, not a bot login). The escalation hard-stop is always checked first, and the protected-path guard still runs before any merge. **Merge Bot evaluates only the LATEST check run per name** (GitHub creates a fresh `check-codex-status` run on each gate pass; the old early-red run must be ignored) — this was why merge-bot never merged.
- **Cost:** ~$1–1.7 per Claude fix run (duration-based). A Spending Limit is set in the Anthropic Console.
- **Escalation label standardized on `needs-owner` (older label fully removed).** Every workflow now adds AND checks only `needs-owner`. The earlier backward-compat dual-matching (the `LABEL_ESCALATE_LEGACY` constant and the `|| ... LEGACY` clauses in merge-bot's candidate hard-stop and ci-doctor's "already escalated" skip) has been deleted — there were no open issues/PRs still carrying the old label, so the compat shim was unnecessary complexity. `needs-owner` is the single source of truth.

---

## Secrets required per repo

| Secret | Used by | Notes |
|--------|---------|-------|
| `ANTHROPIC_API_KEY` | claude.yml | Required for the fixer. Absent → fail-soft skip (no fix, ~0 minutes). Set only where you want auto-fix (cost control). |
| `AUTOMATION_PAT` | claude.yml, ci-doctor, merge-bot, bridge, sync, telegram-morning-report | **All cross-workflow writes** (comment/label/merge/PR) + the morning report's cross-repo reads. All-repos fine-grained PAT (Contents/PRs/Issues write, Metadata read). Absent → those workflows fail-soft skip. |
| `AGENT_MEMORY_PAT` | codex-auto-fix (archive) | Optional. Absent → archive step fail-soft skips. |
| `CROSS_REPO_PAT` | bootstrap, minutes-guard, telegram-morning-report (billing read, optional) | automation-core only. Cross-repo admin (Workflows write); the morning report uses it for the account billing read, falling back to AUTOMATION_PAT. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | ci-doctor, merge-bot, bridge, telegram-morning-report | Optional escalation pings + the daily digest (HTML parse_mode). Skipped silently if unset (the report still logs to the run summary). |

---

## Repos status

| Repo | Status | Notes |
|------|--------|-------|
| **automation-core** | ✅ loop installed & live | Public → free Actions. Source of truth + test bed. Runs the loop on its own PRs (consumer #12). |
| **paywall-bot** | 🟡 partial | Has `sync-automation-core.yml` (AUTOMATION_PAT variant) + `codex-gate` + `codex-auto-fix` synced. |
| **OptionsProfitTracker (OPT)** | 🟡 onboarded — PR #12 awaiting merge | **Stage 2.** Private. PR #12 adds sync (AUTOMATION_PAT), health-check→`claude-fix`, `build-gate` (compileDebugKotlin), `.claude-guard.json`, CLAUDE.md loop section. **Installed-and-waiting** — private Actions quota exhausted → activates after the ~July 1 reset. |
| **thai-rent-finder (TRF)** | 🟡 onboarded — PR #80 awaiting merge | **Stage 2.** Private. Already had `codex-gate` + `codex-auto-fix`; PR #80 adds the missing sync (AUTOMATION_PAT), site-health→`claude-fix`, `build-gate` (`tsc --noEmit`), `.claude-guard.json` (schema/migrations). |
| 11 other downstream repos | via sync | Receive synced workflows where bootstrapped. fail-soft everywhere → no key/PAT = no red runs, ~0 minutes. |

> Account: GitHub Free, 2000 private-repo Actions min/month, resets the 1st. Public repos (automation-core) are free.

---

## Open debt / TODO

### 3 original Codex P1s (from the PR #11 self-healing stack) — STATUS
| # | P1 | Status |
|---|----|--------|
| 1 | **Gate check must EXIST** — merge-bot fails closed if `check-codex-status` is absent (never merge an ungated PR) | ✅ **merged to main** (PR #15, merge-bot `b8c4372`) |
| 2 | **PAT-author `automerge` label** — Claude's PRs are owner-authored, so claude.yml labels them `automerge` and merge-bot keys off the label | ✅ **merged to main** (PR #15 + #17, claude.yml `a33a4a8`) |
| 3 | **Escalation label upsert** — `createLabel` before `addLabels` (addLabels only attaches existing labels) so the escalation label works on fresh repos | ✅ **merged to main** (PR #15, merge-bot `b8c4372`) |

**All three are live on `main`.** (Other merged loop hardening: head-SHA-pinned merge, 3-round circuit breaker, twice-daily ci-doctor / daily merge-bot crons, success-filtered `workflow_run` trigger, per-wave bridge debounce, `cancel-in-progress: false`, allowlist `--allowedTools`.)

### Stage 2 — onboard OPT + TRF  (onboarding PRs open, awaiting merge)
- 🟡 **OPT — PR #12 (awaiting merge):** `sync-automation-core.yml` (AUTOMATION_PAT variant); `health-check.yml` now opens `claude-fix` Issues via AUTOMATION_PAT (was the dead `cc @codex`); `pr-build-gate.yml` (`build-gate` = `:app:compileDebugKotlin`, fails on any `^e:` line or non-zero exit); `.claude-guard.json` (`ProfitCalculator` / `StrategicRiskAnalyzer` / `BlackScholesCalculator` / `*Database*` / `*Migration*` / `AppPreferences` / `AvgCostResolver`); CLAUDE.md autonomous-loop section. **Installed-and-waiting** — private quota resets ~July 1.
- 🟡 **TRF — PR #80 (awaiting merge):** `sync-automation-core.yml` (AUTOMATION_PAT variant); `site-health.yml` now opens `claude-fix` Issues via AUTOMATION_PAT (was `@codex`); `pr-build-gate.yml` (`build-gate` = `tsc --noEmit`; `npm run build` deliberately avoided because it runs `prisma migrate deploy`, which needs a DB); `.claude-guard.json` (`schema.prisma` + `migrations/**`).
- Bootstrap was **not** used — both PRs add the sync workflow directly. After merge + secrets (`AUTOMATION_PAT`, `ANTHROPIC_API_KEY`, both reportedly already set), the generic loop workflows (`claude`, `codex-auto-fix`, `codex-gate`, `ci-doctor`, `merge-bot`) arrive on the next daily sync.
- Still TODO: add OPT (+ paper-trader) to minutes-guard `TARGET_REPOS`.

### Stage 3
- ✅ **Auto-enrollment for new repos — DONE** (branch `claude/auto-enrollment`): `bootstrap.yml` now runs on a weekly `schedule` (`0 4 * * 1`, Mondays 04:00 UTC) and automatically opens onboarding PRs in newly-eligible repos. Safety: opt-out via `.automation-core-ignore`; already-enrolled / archived / fork / non-owner repos skipped (reuses the existing eligible-repo scan); PRs are **opened-not-merged** (human checkpoint); the PAT step is fail-soft (missing `CROSS_REPO_PAT` → green + notice); per-repo try/catch so one bad repo doesn't abort the sweep. Manual `workflow_dispatch` + `dry_run` preview preserved.
- ✅ **Telegram morning report (read-only digest) — DONE** (branch `claude/telegram-morning-report`): a once-daily 05:30 UTC `telegram-morning-report.yml` (automation-core hub only, NOT synced) sends a read-only cross-repo snapshot (escalations / open-PR gate states / 24h merges / health / minutes). fail-soft on every secret.
- Telegram **interactive** control center (buttons/actions) — still future; the digest is informational only.

### Deferred (intentional)
- ~~**Codex P2 — inline-reply debounce in the bridge.**~~ ✅ **Done in PR #21:** real cross-channel debounce (marker deduped across issue comments + inline review comments + reviews) → exactly one `@claude fix` per review wave; and the bridge now triggers on **P1 only** (P2 no longer auto-fires), which also ends the P2 loop.
- **`trigger_codex_on_health_issue`** (site-health `@codex` auto-tag) was removed from codex-auto-fix in PR #17. If wanted, re-add as a separate `issues`-only workflow so the bridge stays PR-only.

---

## How to resume in a new chat

> _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

This file is the source of truth — keep it updated on every significant change.
