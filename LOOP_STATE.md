# LOOP_STATE.md — Self-Healing Loop: project state

> Source of truth for the autonomous CI self-healing loop across @funzi7's repos.
> Update this file on every significant change. Snapshot taken against `main` @ `171f33f`.

**Resume in a new chat:** _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

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

Generic loop workflows live in `workflows/` (sync source) and are copied byte-identical into `.github/workflows/` so automation-core runs the loop on its own PRs (it is consumer #12 of itself). `sync-config.json.synced_workflows = [codex-auto-fix.yml, codex-gate.yml, claude.yml, ci-doctor.yml, merge-bot.yml]`.

> **Note:** there is **no separate `codex-claude-bridge.yml`** — "the bridge" IS the `trigger_codex_fix` job inside **`codex-auto-fix.yml`**.

### claude.yml — Claude Fixer  (sha `a33a4a8`)
- **Does:** runs `anthropics/claude-code-action@v1` to fix a `claude-fix` Issue (or an `@claude` mention), opens a PR (`Fixes #N`), then labels that PR `automerge` (only if the Claude step **succeeded** — `if: steps.claude.outcome == 'success'`).
- **Triggers:** `issue_comment: [created]`, `pull_request_review_comment: [created]`, `issues: [labeled, assigned]`. Job `if:` maps each event to exactly one clause (`@claude` mention / assigned / `labeled && label==claude-fix`) → one run per action.
- **Concurrency:** `group: claude-fix-${{ issue.number || pull_request.number }}`, **`cancel-in-progress: false`** (never kill a paying run).
- **Auth:** `github_token: AUTOMATION_PAT || github.token`. fail-soft on missing `ANTHROPIC_API_KEY` (exits green).

### codex-auto-fix.yml — the Bridge + Codex-summary archive  (sha `e0bda69`; P1+P2 trigger (exclude P3) + cross-channel debounce)
- **Job `trigger_codex_fix`:** on a Codex review that carries an **active P1 or P2** finding (real bug / security, or an important correctness/quality issue), posts **exactly one** `@claude fix` per review wave. **P3 (minor styling/cosmetic) never auto-triggers.** Detection reuses the existing badge substring check: Codex tags each finding with a shields.io severity badge whose label is the literal token (`P1-orange`, `P2-yellow`, `P3-...`), so `body.includes("P1") || body.includes("P2")` catches P1/P2 and never a P3-only finding. Same freshness rule (only Codex bodies dated after the latest commit). The posted comment notes which severity (P1/P2) and a best-effort finding count. The 3-round circuit breaker still bounds the loop. (Earlier the bridge was P1-only; P2 — which routinely carries real correctness issues like "false-green health" — was expanded in.)
  - **Cross-channel debounce:** a Codex review with N inline notes fires N events across **two** channels (top-level `issue_comment` **and** inline `pull_request_review_comment`) — the bridge posts its own inline trigger as a review-comment *reply*. The dedupe counts the `[auto-triggered]` marker across **all** channels (issue comments + review comments + reviews), so once one trigger for the current head exists, no further event re-fires → one trigger per wave. (The old code counted only `issues.listComments` and missed the inline replies, so PR #19 got 2 triggers from 3 notes.)
  - Circuit breaker `MAX_FIX_ROUNDS = 3` → `needs-owner` + Telegram (now counts markers across all channels too). Posts with `AUTOMATION_PAT` (else a GITHUB_TOKEN comment wouldn't trigger claude.yml).
  - Concurrency: `codex-claude-bridge-${{ repo }}-${{ pr }}`, `cancel-in-progress: false` (serializes near-simultaneous events so the dedupe is seen before the next event runs).
- **Job `archive_codex_summary`:** archives Codex post-fix summaries to `funzi7/agent-memory` (needs `AGENT_MEMORY_PAT`, fail-soft if absent). Concurrency `codex-summary-archive`.
- **Triggers:** `pull_request_review: [submitted]`, `pull_request_review_comment: [created]`, `issue_comment: [created]`. **Does NOT listen to `issues` events** (removed in PR #17 — it was waking + skipping in ~2s on every Issue label).
- _Removed in PR #17:_ the `trigger_codex_on_health_issue` job (auto-tagged `@codex` on `site-health` Issues). Not currently running anywhere — see Open debt.

### codex-gate.yml — Codex Gate (blocking check)  (sha `92019ec`; P1-only + wait-for-first-review + head-targeted self-rerun in PR #25)
- **Does:** the `check-codex-status` blocking check. **GREEN requires BOTH:** (a) Codex has **reviewed the current head** — a Codex signal (review / comment / inline / 👍) **dated after the latest commit** — **and** (b) **no ACTIVE P1** — a P1 marker **dated after the latest commit**, not yet followed by a later Codex fix Summary. **ONE consistent date-only freshness rule for both**: `commit_id` is **never** used to decide freshness, because GitHub re-points a still-applicable inline comment's `commit_id` to the new head — so `commit_id == head` does NOT mean Codex reviewed the new commit. Using it would either falsely block on a stale P1 **or** (the 4th P1) make a stale comment read as a *fresh review* and flip the gate green before Codex re-reviews (merge-before-review via a side door). It **BLOCKS** on an unresolved active P1 **OR** when Codex hasn't reviewed the head yet (**pending**). Otherwise GREEN: clean review, P2-only, 👍, or a **stale P1 (predating the latest commit)** once Codex has re-reviewed. `codex-p1-acknowledged` = manual override. `latestCommitDate` = the **max** committer date across the PR's commits (not assumed sorted). Same P1 detection as the bridge across the same 3 channels, fully paginated.
- **Wait-for-first-review, NOT approval:** the pending block is the #66/#67-race guard — it stops merge-bot from merging before Codex has weighed in. ANY Codex signal on the head (even an empty/👍 review) flips it green; escape hatch if Codex never reviews = the override label (no fail-open merge at timeout).
- **Head-targeted self-rerun (restored — fixes the 2 P1s Codex raised on PR #25):** merge-bot reads `check-codex-status` via `checks.listForRef(pr.head.sha)`, so the green must land **on the head commit**. A 👍 reaction fires no event, and an `issue_comment` (e.g. a fix Summary) runs on the **default branch**, so neither lands on the head on its own. So whenever the gate is non-green-on-head — pending (incl. the 👍 poll) OR a clean verdict computed on a run whose `head_sha != pr.head.sha` — it re-dispatches itself via `createWorkflowDispatch` against the **PR head branch** (`ref = pr.head.ref`); that run's `head_sha == pr.head.sha`, so its check lands where merge-bot looks. Capped at `MAX_ATTEMPTS = 5` per head SHA, ~90s apart; a new push resets the cap. The attempt count uses the workflow-specific `actions.listWorkflowRuns` (the repo-level `listWorkflowRunsForRepo` ignores `workflow_id` and would count unrelated workflows' runs toward the cap). Needs `actions: write` (restored). This makes all four clean paths land green on the head: **reaction-only / comment-only / review-no-P1 / P1-then-Summary**.
- **fail-soft:** a *technical* error evaluating a PR does NOT block (never wedge a PR red on an API hiccup); a *detected* P1 always blocks (safety wins).
- **Triggers:** `pull_request: [opened, synchronize, reopened]`, `pull_request_review: [submitted, edited, dismissed]`, `pull_request_review_comment: [created, edited, deleted]`, `issue_comment: [created, edited, deleted]`, `workflow_dispatch` (self-rerun / manual re-check, input `pr_number`, dispatched against the head branch).

### ci-doctor.yml — CI Doctor  (sha `ae4ba37`)
- **Does:** scans the default branch for failed runs (13h lookback), opens a `claude-fix` Issue per failure (logs tail + root-cause prompt), upserts the loop labels, nudges ≤3 attempts then escalates to `needs-owner` + Telegram. Skips Issues already escalated.
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

### bootstrap.yml — onboarding + auto-enrollment  (automation-core only)
- **Does:** installs `sync-automation-core.yml` into eligible repos via PRs (`chore(automation): bootstrap...`). Eligible = owner / non-archived / non-fork / not automation-core / no existing sync workflow / no `.automation-core-ignore` opt-out. **Auto-enrollment (Stage 3):** a weekly `schedule` sweep OPENS an onboarding PR in any newly-eligible repo but **never merges** it — auto-propose, not auto-apply; the PR is the human checkpoint (a brand-new/experimental repo can't get automation wired in and merged with zero review). **Triggers:** `schedule: '0 4 * * 1'` (Mondays 04:00 UTC, NOT dry-run — opens PRs) + `workflow_dispatch` (inputs `dry_run`, `target_repo`; `dry_run` previews without opening PRs). fail-soft: missing `CROSS_REPO_PAT` → green run + notice (no red); a single failing repo is recorded and skipped (per-repo try/catch) so one bad repo can't abort the unattended sweep. Auth: `CROSS_REPO_PAT`.

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
| `AUTOMATION_PAT` | claude.yml, ci-doctor, merge-bot, bridge, sync | **All cross-workflow writes** (comment/label/merge/PR). All-repos fine-grained PAT (Contents/PRs/Issues write, Metadata read). Absent → those workflows fail-soft skip (loop inert). |
| `AGENT_MEMORY_PAT` | codex-auto-fix (archive) | Optional. Absent → archive step fail-soft skips. |
| `CROSS_REPO_PAT` | bootstrap, minutes-guard | automation-core only. Cross-repo admin (Workflows write). |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | ci-doctor, merge-bot, bridge | Optional escalation pings (HTML parse_mode). Skipped silently if unset. |

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
- Telegram control center.

### Deferred (intentional)
- ~~**Codex P2 — inline-reply debounce in the bridge.**~~ ✅ **Done in PR #21:** real cross-channel debounce (marker deduped across issue comments + inline review comments + reviews) → exactly one `@claude fix` per review wave; and the bridge now triggers on **P1 only** (P2 no longer auto-fires), which also ends the P2 loop.
- **`trigger_codex_on_health_issue`** (site-health `@codex` auto-tag) was removed from codex-auto-fix in PR #17. If wanted, re-add as a separate `issues`-only workflow so the bridge stays PR-only.

---

## How to resume in a new chat

> _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

This file is the source of truth — keep it updated on every significant change.
