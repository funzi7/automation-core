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
   │  → add `needs-dima` + Telegram ping, stop auto-triggering
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
| `needs-dima` | Escalation — automation stopped, a human must act. Hard stop for Merge Bot. |
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

### codex-auto-fix.yml — the Bridge + Codex-summary archive  (sha `e0bda69`; P1-only + cross-channel debounce pending in PR #21)
- **Job `trigger_codex_fix`:** on a Codex review that carries an **active P1** (real bug / security), posts **exactly one** `@claude fix` per review wave. **P2 (nice-to-have) never auto-triggers** — Codex finds new P2s endlessly, an infinite paid loop; P2 notes stay on the PR for reference and Dima can `@claude fix` one by hand. P1 detection reuses the existing badge substring check (`body.includes("P1")`).
  - **Cross-channel debounce:** a Codex review with N inline notes fires N events across **two** channels (top-level `issue_comment` **and** inline `pull_request_review_comment`) — the bridge posts its own inline trigger as a review-comment *reply*. The dedupe counts the `[auto-triggered]` marker across **all** channels (issue comments + review comments + reviews), so once one trigger for the current head exists, no further event re-fires → one trigger per wave. (The old code counted only `issues.listComments` and missed the inline replies, so PR #19 got 2 triggers from 3 notes.)
  - Circuit breaker `MAX_FIX_ROUNDS = 3` → `needs-dima` + Telegram (now counts markers across all channels too). Posts with `AUTOMATION_PAT` (else a GITHUB_TOKEN comment wouldn't trigger claude.yml).
  - Concurrency: `codex-claude-bridge-${{ repo }}-${{ pr }}`, `cancel-in-progress: false` (serializes near-simultaneous events so the dedupe is seen before the next event runs).
- **Job `archive_codex_summary`:** archives Codex post-fix summaries to `funzi7/agent-memory` (needs `AGENT_MEMORY_PAT`, fail-soft if absent). Concurrency `codex-summary-archive`.
- **Triggers:** `pull_request_review: [submitted]`, `pull_request_review_comment: [created]`, `issue_comment: [created]`. **Does NOT listen to `issues` events** (removed in PR #17 — it was waking + skipping in ~2s on every Issue label).
- _Removed in PR #17:_ the `trigger_codex_on_health_issue` job (auto-tagged `@codex` on `site-health` Issues). Not currently running anywhere — see Open debt.

### codex-gate.yml — Codex Gate (blocking check)  (sha `92019ec`)
- **Does:** the `check-codex-status` check that blocks merge until Codex signals (👍 reaction = no issues / review with no active P1 / P1 followed by a fix Summary / `codex-p1-acknowledged` override / timeout after 5 attempts).
- **Triggers:** `pull_request: [opened, synchronize, reopened]`, `pull_request_review: [submitted, edited, dismissed]`, `pull_request_review_comment: [created, edited, deleted]`, `issue_comment: [created, edited, deleted]`, `workflow_dispatch` (input `pr_number`).
- **Concurrency:** none — instead it **self-reruns every ~90s via `createWorkflowDispatch`, max 5 attempts** while waiting for Codex.

### ci-doctor.yml — CI Doctor  (sha `ae4ba37`)
- **Does:** scans the default branch for failed runs (13h lookback), opens a `claude-fix` Issue per failure (logs tail + root-cause prompt), upserts the loop labels, nudges ≤3 attempts then escalates to `needs-dima` + Telegram. Skips Issues already escalated.
- **Triggers:** `schedule: '0 6,18 * * *'` (twice daily) + `workflow_dispatch`.
- **Concurrency:** `ci-doctor-${{ repo }}`, `cancel-in-progress: false`. Uses `AUTOMATION_PAT` for all writes.

### merge-bot.yml — Merge Bot  (sha `b8c4372`)
- **Does:** squash-merges (head-SHA-pinned) PRs that are fully green. Candidate = Claude-bot author **OR `automerge` label OR** trusted sync PR; `needs-dima` is a hard stop. `check-codex-status` must **exist AND be success** (fail-closed). `.claude-guard.json` protected-path guard → escalate. Closes linked CI-Doctor Issue.
- **Triggers:** `check_suite: [completed]`, `workflow_run: ["Codex Gate"] [completed]`, `schedule: '30 7 * * *'`, `workflow_dispatch`. Job early-exits unless a success/neutral `check_suite`, a **successful** Codex Gate `workflow_run`, the cron, or manual.
- **Concurrency:** `merge-bot-${{ repo }}`, `cancel-in-progress: false`. Merges with `AUTOMATION_PAT` (so the push triggers downstream).

### sync-automation-core.yml — per-repo sync  (sha `a7c8563`, lives only in `.github/workflows/`)
- **Does:** clones automation-core's `main`, copies `synced_workflows` into the repo's `.github/workflows/`, opens a `chore(automation): sync from automation-core` PR on diff. Uses `AUTOMATION_PAT` (the `GITHUB_TOKEN` template variant can't push files under `.github/workflows/`).
- **Triggers:** `schedule: '0 3 * * *'` (daily) + `workflow_dispatch`.

### minutes-guard.yml — Actions minutes guard  (sha `a64db42`, automation-core only, public/free)
- **Does:** detects billing-kill failures in `TARGET_REPOS = [funzi7/paywall-bot, funzi7/thai-rent-finder]` and disables their *scheduled* workflows when the account quota is exhausted; re-enables monthly.
- **Triggers:** `schedule: '*/30 * * * *'` + `'5 0 1 * *'` (monthly re-enable) + `workflow_dispatch` (`force_enable`, `dry_run`). Auth: `CROSS_REPO_PAT`.
- ⚠️ **TARGET_REPOS is stale** vs the loop: OptionsProfitTracker + paper-trader also have crons and are NOT protected (see the minutes audit).

### bootstrap.yml — onboarding  (automation-core only)
- **Does:** installs `sync-automation-core.yml` into eligible repos via PRs (`chore(automation): bootstrap...`). **Triggers:** `workflow_dispatch` only (inputs `dry_run`, `target_repo`). Auth: `CROSS_REPO_PAT`.

---

## Key decisions made

- **Claude fixes, Codex reviews.** Codex produces phantom/empty fix commits; Claude is the reliable fixer.
- **`--max-turns 20`** in claude.yml (balance cost vs completing the task; most fixes need far fewer than 35).
- **`cancel-in-progress: false`** on claude.yml — never kill a run that is already burning money; a second event queues behind it.
- **Final minimal allowlist** in claude.yml (`Read,Glob,Grep,Edit,Write` + scoped `git`/`gh pr`/`gh issue`/`actionlint`; no bare `Bash`, no interpreters, no `gh api`) — ends the "shrink-the-allowlist" loop; if something's missing the fixer fails to `needs-dima` rather than looping.
- **Codex Gate kept as a blocking check** — the human waits for the loop instead of merging manually.
- **Merge Bot identifies Claude PRs by the `automerge` label**, not author login (Claude's PRs are PAT-authored = owner `funzi7`, not a bot login).
- **Cost:** ~$1–1.7 per Claude fix run (duration-based). A Spending Limit is set in the Anthropic Console.

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
| **OptionsProfitTracker (OPT)** | ⬜ NOT onboarded | **Stage 2.** Private. No sync workflow yet (only `auto-fix-nudge`, `health-check`). Private-repo Actions quota exhausted → blocked until ~July 1 reset. |
| **thai-rent-finder (TRF)** | ⬜ NOT onboarded | **Stage 2.** Private. Has `codex-gate` + `codex-auto-fix` but **no `sync-automation-core.yml`** → no active ongoing sync. |
| 11 other downstream repos | via sync | Receive synced workflows where bootstrapped. fail-soft everywhere → no key/PAT = no red runs, ~0 minutes. |

> Account: GitHub Free, 2000 private-repo Actions min/month, resets the 1st. Public repos (automation-core) are free.

---

## Open debt / TODO

### 3 original Codex P1s (from the PR #11 self-healing stack) — STATUS
| # | P1 | Status |
|---|----|--------|
| 1 | **Gate check must EXIST** — merge-bot fails closed if `check-codex-status` is absent (never merge an ungated PR) | ✅ **merged to main** (PR #15, merge-bot `b8c4372`) |
| 2 | **PAT-author `automerge` label** — Claude's PRs are owner-authored, so claude.yml labels them `automerge` and merge-bot keys off the label | ✅ **merged to main** (PR #15 + #17, claude.yml `a33a4a8`) |
| 3 | **Escalation label upsert** — `createLabel` before `addLabels` (addLabels only attaches existing labels) so `needs-dima` works on fresh repos | ✅ **merged to main** (PR #15, merge-bot `b8c4372`) |

**All three are live on `main`.** (Other merged loop hardening: head-SHA-pinned merge, 3-round circuit breaker, twice-daily ci-doctor / daily merge-bot crons, success-filtered `workflow_run` trigger, per-wave bridge debounce, `cancel-in-progress: false`, allowlist `--allowedTools`.)

### Stage 2 — onboard OPT + TRF
- Run **Bootstrap** (needs `CROSS_REPO_PAT`) to install `sync-automation-core.yml` in OPT + TRF.
- Per repo: build/test gate workflow, `.claude-guard.json` (protect data/migrations/build files), `CLAUDE.md` with the gate command, connect site-health → `claude-fix`.
- Set `ANTHROPIC_API_KEY` + `AUTOMATION_PAT` on each. (OPT blocked until private quota resets ~July 1.)
- Add OPT (+ paper-trader) to minutes-guard `TARGET_REPOS`.

### Stage 3
- Auto-enrollment for new repos.
- Telegram control center.

### Deferred (intentional)
- ~~**Codex P2 — inline-reply debounce in the bridge.**~~ ✅ **Done in PR #21:** real cross-channel debounce (marker deduped across issue comments + inline review comments + reviews) → exactly one `@claude fix` per review wave; and the bridge now triggers on **P1 only** (P2 no longer auto-fires), which also ends the P2 loop.
- **`trigger_codex_on_health_issue`** (site-health `@codex` auto-tag) was removed from codex-auto-fix in PR #17. If wanted, re-add as a separate `issues`-only workflow so the bridge stays PR-only.

---

## How to resume in a new chat

> _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

This file is the source of truth — keep it updated on every significant change.
