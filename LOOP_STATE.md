# LOOP_STATE.md — Self-Healing Loop: project state

> Source of truth for the autonomous CI self-healing loop across @funzi7's repos.
> Update this file on every significant change. Do not store a moving `main @ sha`
> snapshot in this header; authoritative code and documentation bases are named below.

**Resume in a new chat:** _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

> Canonical full briefing: [`handoffs/CONTEXT.md`](handoffs/CONTEXT.md). This file is the concise per-workflow state reference.

---

## Current Snapshot (owner exact-head auto-merge rollout, updated 2026-08-11)

Code architecture base: fix #27 plus the Codex backup hardening and the
2026-08-11 reconciliation of paywall-bot's reviewed Codex Gate/watchdog fixes
back into the central workflow source.

Documentation base: final post-fix #27 normalization commit `11ba6a6bf13c91b1be61d4292b853dd15c37063b`, plus this upstream fix record.

Runtime status: paywall-bot PR #93 proved the failure mode: its exact head was
fully green and mergeable, but an automation-added `needs-owner` stranded the
old Merge Bot. PR #89, the stale downstream sync that proposed obsolete gate
and watchdog files, was closed unmerged and its stale branch deleted. The
central source now carries the downstream-reviewed thread-state, trusted-base,
exact-head check publication, and bounded watchdog behavior before the new
merge policy is rolled out.

Current delivery-judged ladder:

```text
Codex auto-review
  -> Claude
  -> Codex API when CODEX_BACKUP_ENABLED == 'true'
  -> Codex Cloud unless CODEX_CLOUD_ENABLED == 'false'
  -> Claude proxy only after genuine Claude no_delivery and only if it can deliver to the original PR head
  -> needs-owner
  -> Codex Gate
  -> Merge Bot
```

Delivery means a real commit reaches the actual relevant PR head branch after that stage's request marker. Workflow success, View task, task diff, Created commit wording, Cloud-side commit hints, or a secondary PR are not delivery.

Per-repo switches are not synced:

| Switch | Default | Literal override |
|---|---:|---|
| `CLAUDE_ENABLED` | enabled | `false` disables Claude runs and lets the watchdog pre-skip Claude. |
| `CODEX_BACKUP_ENABLED` | disabled | only `true` enables the Codex API backup. Disabled means skipped, not immediate escalation. |
| `CODEX_CLOUD_ENABLED` | enabled | `false` disables Codex Cloud. |

Strict Codex identity: trusted REST review/comment surfaces use exact login
`chatgpt-codex-connector[bot]`; GraphQL review threads expose the same App as
exact login `chatgpt-codex-connector`. No substring, regex, or other alias is
trusted.

Escalation labels: manual/unknown `needs-owner` is a hard stop;
`needs-owner-auto` proves temporary PR automation exhaustion and may be cleared
with `needs-owner` only after exact-head fully-green validation. `no-automerge`
is the permanent human opt-out and is never removed by automation.

## Current Open TODO (authoritative)

1. **Claude-budget-blocked runtime verification:** after Anthropic credit is restored, create one harmless same-repo PR with an active P1 or P2 finding, trigger `@claude fix`, verify a commit reaches the original PR head branch, verify no secondary branch/PR appears, verify the watchdog recognizes delivery, and verify no `no_delivery` marker remains after the successful push.
2. **OpenAI API quota-blocked verification:** after OpenAI quota is restored, set `CODEX_BACKUP_ENABLED='true'` only on a controlled test repo and verify Codex API `requested` -> real PR-head push and terminal states, including that `codex_agent_failed` posts only the intended `api_error` marker and never enters the normal patch download/apply path.
3. **paywall-bot PR #73 sync refresh:** this upstream fix addresses the downstream Codex P2 finding, but paywall-bot was not modified directly. Refresh PR #73 through the normal sync, then re-check it before merge.
4. **Downstream audit:** OPT PR #12 and TRF PR #80 are merged. Do not claim downstream workflow sync, secrets, variables, Actions permissions, or runtime health until checked from each repo's latest sync PR/current workflow contents and settings evidence.
5. **Codex Cloud limitation:** View task, task diff, Created commit hint, or ready diff is not delivery unless the PR branch gets a newer commit after the Cloud marker. No browser/UI automation or fake Update branch API workaround exists.
6. **Longer-term:** update minutes-guard target coverage after downstream audit; keep direct-to-main and branch-protection decisions explicit.

Older items below are history. If they conflict with this section, treat them as HISTORICAL or SUPERSEDED and follow this section.

## Workflows

Synced workflows listed in `sync-config.json`: `codex-auto-fix.yml`, `codex-gate.yml`, `claude.yml`, `ci-doctor.yml`, `merge-bot.yml`, `claude-fallback-watchdog.yml`, `codex-backup-fix.yml`.

### `claude.yml` — Claude Fixer

- Fixes `claude-fix` Issues by creating a new branch/PR with `Fixes #N`.
- Fixes existing same-repo PR comments by resolving the PR via API, checking out the exact original head SHA, attaching the local checkout to the original head branch, and instructing Claude to commit/push only to that branch.
- Fork-headed PR comments are skipped before writable checkout or Claude execution, labeled `needs-owner`, and marked `agent=claude state=fixer_error`.
- Comment-triggered public-repo runs require the owner-authored comment guard: `github.event.comment.user.login == github.repository_owner`.
- `ANTHROPIC_API_KEY` missing is fail-soft. Anthropic credit is currently exhausted in recent runs, so runtime delivery is blocked.
- `--max-turns 50` and the current broad allowlist are intentional after the historical `error_max_turns`/permission-denial incidents.

### `codex-auto-fix.yml` — Bridge + Codex summary archive

- Bridge triggers exactly one `@claude fix` per review wave when trusted Codex reports active P1 or P2. P3 is excluded.
- P1/P2 detection is badge-token based (`P1-orange`, `P2-yellow`) and feedback is bound to the exact head through review `commit_id`, Codex's `Reviewed commit` marker, or an authenticated `ai-loop` head marker.
- The bridge inlines the actual P1/P2 finding text because Claude's run context cannot reliably read inline review threads.
- Sync PRs are suppressed because findings belong upstream in automation-core, not in downstream copied workflow files.
- Circuit breaker: 3 rounds -> `needs-owner` + Telegram if configured.

### `codex-gate.yml` — Codex Gate

- `check-codex-status` is the blocking check.
- Green requires Codex has reviewed the current head and no active P1/P2 remains.
- P1 and P2 both block; this must match bridge-trigger severity. Historical P1-only behavior is SUPERSEDED.
- Freshness is never inferred from Git author/committer dates. Review objects and Codex result comments bind directly to the exact SHA; unmarked surfaces count only after the server-observed start of the current contiguous head-SHA epoch. Each epoch marker is merely an index to an immutable Actions run attempt: consumers accept it only when GitHub proves the referenced attempt is this repository's `pull_request_target` Codex Gate run, associated with the same PR, and the bot comment was created inside that attempt. SHA/time come from the attempt, not comment text or the mutable live PR association. Consumers validate newest-first only through the first different-head boundary, while recent PR-run history is combined conservatively with verified markers. Thus A→B→A starts fresh, long-lived epochs survive the repository-wide search cap, and verification cost does not grow with the PR lifetime. Repointable inline `commit_id` values alone do not waive current-head review.
- Trusted-sync grace-green is limited to zero-Codex-signal sync PRs older than `SYNC_GRACE_MINUTES`.
- The old in-run self-rerun poll is gone; the watchdog sweep handles late Codex signals and override-label dispatches.

### `claude-fallback-watchdog.yml` — Delivery-judged fixer ladder

- Current ladder is delivery-only: Claude -> Codex API if enabled -> Codex Cloud unless disabled -> Claude proxy only for genuine Claude `no_delivery` -> `needs-owner`.
- A disabled Codex API backup is skipped, not escalation.
- Codex API `stale` stops the old head cycle; it does not advance that stale cycle to Cloud.
- Claude `billing_error` / `fixer_error` terminally advance without waiting the 20-minute window.
- Codex Cloud ready diff / View task is terminal non-delivery unless a real PR-head commit lands.
- Claude proxy is implemented after Cloud non-delivery only when the original Claude failure was genuine `no_delivery`; it is runtime-unverified after fix #27.
- Dispatch failures before the Codex API agent starts are `dispatch_failed`, retryable, and non-attempt-consuming.

### `codex-backup-fix.yml` — Codex API backup

- Dormant by default. The watchdog dispatches it only when `CODEX_BACKUP_ENABLED == 'true'`.
- Requires `OPENAI_API_KEY`, available quota, and write-capable workflow permissions in the target repo.
- Agent job is read-only and gets only `OPENAI_API_KEY`; apply-and-push is the write-capable job.
- Fork PRs are skipped/escalated before agent execution.
- The 2026-07-09 downstream PR #73 P2 fix splits marker-only terminal paths from the normal patch path: after `codex_agent_failed`, apply-and-push posts only the intended `api_error` marker and does not resolve the PR head, check out, download `codex-patch`, apply, push, or emit `no_change`/`patch_failed` from a missing artifact.
- Honest terminal states: `api_error`, `fixer_error`, `no_change`, `patch_failed`, `stale`, and `pushed`. Only a real branch commit after the request marker is delivery.

### `merge-bot.yml` — Merge Bot

- Candidates include normal same-repository PRs authored by `funzi7`, plus
  established Claude, explicit `automerge`, and trusted sync paths. A fork is
  never trusted by title/branch naming.
- `no-automerge` and manual/unknown `needs-owner` are hard stops.
- Temporary `needs-owner` + `needs-owner-auto` (or a proven legacy
  GitHub-Actions label event with no human/protected reason) stays in place
  while anything is red/pending/ambiguous, then both labels clear and the PR
  merges in the same exact-head evaluation.
- Requires latest `check-codex-status` on the exact head to be success and
  independently checks for active trusted P1/P2 review threads.
- Uses latest check run per name and ignores cancelled tails from superseded queued runs.
- Ignores only the intentionally diagnostic `codex-gate-evaluator` job, whose
  expected pre-review failure can remain attached to the PR head. The explicit
  exact-head `check-codex-status` is authoritative; every other latest failed
  or running check/status still blocks.
- Protected paths still escalate untrusted/fork/ambiguous PRs. A fully reviewed
  same-repo owner PR may merge without a second manual merge step.
- Squash merge is head-SHA-pinned.

### Hub-only workflows

- `bootstrap.yml`: opens onboarding PRs for newly eligible repos; never auto-merges them.
- `telegram-morning-report.yml`: read-only daily digest; no write API calls.
- `minutes-guard.yml`: hub-only Actions-minutes guard. Its target coverage may be stale and needs audit before expansion.

## Repos Status

| Repo | Status | Notes |
|---|---|---|
| automation-core | loop installed and live | Public source of truth and test bed. |
| paywall-bot | sync refresh needed | PR #73 surfaced the Codex P2 fixed upstream on 2026-07-09; refresh by normal sync before merge. Current secrets/variables/runtime not checked in this pass. |
| OptionsProfitTracker | onboarding PR #12 merged | Verified fact only. Current sync/secrets/variables/permissions/runtime health not checked in this pass. |
| thai-rent-finder | onboarding PR #80 merged | Verified fact only. Current sync/secrets/variables/permissions/runtime health not checked in this pass. |
| other downstream repos | via sync where bootstrapped | Do not claim synced or healthy without checking current evidence. |

## Historical / Superseded Incident Record

- HISTORICAL: Fix #8 originally treated disabled Codex API backup as first-timeout escalation. SUPERSEDED by fix #23/#26: the disabled API stage is skipped, and escalation happens only after enabled stages fail delivery.
- HISTORICAL: Early bridge/gate behavior was P1-focused. SUPERSEDED: current bridge and gate both use P1 + P2, P3 excluded.
- HISTORICAL: Cloud View task / Created commit wording looked like success in incidents. Current rule: only a real PR-head commit is delivery.
- HISTORICAL: Claude action success could mean no delivered commit or even billing failure. Current rule: delivery check + failure-class marker drives the ladder.
- HISTORICAL: older onboarding notes for OPT/TRF described PRs before merge. Current verified facts: OPT #12 merged; TRF #80 merged.
- HISTORICAL: prior escalation-label migration notes exist in older commits. Current docs and workflows use only `needs-owner`; do not reintroduce any prior name.

## Validation Notes For This Normalization

- Workflow logic was not changed.
- `workflows/` and `.github/workflows/` were intentionally not changed.
- No downstream repo was changed.
- No force push, browser automation, Playwright, session-cookie automation, UI automation, or fake Codex Cloud Update-branch implementation was used.
