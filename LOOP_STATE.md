# LOOP_STATE.md — Self-Healing Loop: project state

> Source of truth for the autonomous CI self-healing loop across @funzi7's repos.
> Update this file on every significant change. Do not store a moving `main @ sha`
> snapshot in this header; authoritative code and documentation bases are named below.

**Resume in a new chat:** _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

> Canonical full briefing: [`handoffs/CONTEXT.md`](handoffs/CONTEXT.md). This file is the concise per-workflow state reference.

---

## Current Snapshot (post-fix #27, normalized 2026-07-07)

Code architecture base: fix #27 implementation commit `93f6acb9d2e0396afad3e10854503024843c32de`.

Documentation base: first reconciliation commit `ff57a73220faa5dbb563edc7b035fc6cc653c509`, plus this final documentation-only normalization.

Runtime status: workflow code was re-read for this pass. No successful post-fix #27 Claude PR-head run has happened yet. Claude PR-head delivery and Claude proxy are implemented but runtime-unverified. Recent Claude runs return Anthropic `billing_error` / credit exhaustion. Codex API backup is runtime-unverified while OpenAI quota is unavailable.

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

Strict Codex identity: trusted Codex comments are only from exact login `chatgpt-codex-connector[bot]`. No substring or regex identity matcher is trusted.

Only escalation label: `needs-owner`.

## Current Open TODO (authoritative)

1. **Claude-budget-blocked runtime verification:** after Anthropic credit is restored, create one harmless same-repo PR with an active P1 or P2 finding, trigger `@claude fix`, verify a commit reaches the original PR head branch, verify no secondary branch/PR appears, verify the watchdog recognizes delivery, and verify no `no_delivery` marker remains after the successful push.
2. **OpenAI API quota-blocked verification:** after OpenAI quota is restored, set `CODEX_BACKUP_ENABLED='true'` only on a controlled test repo and verify Codex API `requested` -> real PR-head push and terminal states.
3. **Downstream audit:** OPT PR #12 and TRF PR #80 are merged. Do not claim downstream workflow sync, secrets, variables, Actions permissions, or runtime health until checked from each repo's latest sync PR/current workflow contents and settings evidence.
4. **Codex Cloud limitation:** View task, task diff, Created commit hint, or ready diff is not delivery unless the PR branch gets a newer commit after the Cloud marker. No browser/UI automation or fake Update branch API workaround exists.
5. **Longer-term:** update minutes-guard target coverage after downstream audit; keep direct-to-main and branch-protection decisions explicit.

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
- P1/P2 detection is badge-token based (`P1-orange`, `P2-yellow`) and freshness is date-after-latest-commit.
- The bridge inlines the actual P1/P2 finding text because Claude's run context cannot reliably read inline review threads.
- Sync PRs are suppressed because findings belong upstream in automation-core, not in downstream copied workflow files.
- Circuit breaker: 3 rounds -> `needs-owner` + Telegram if configured.

### `codex-gate.yml` — Codex Gate

- `check-codex-status` is the blocking check.
- Green requires Codex has reviewed the current head and no active P1/P2 remains.
- P1 and P2 both block; this must match bridge-trigger severity. Historical P1-only behavior is SUPERSEDED.
- Freshness is date-only against the max committer date across PR commits; `commit_id` is not trusted for freshness because GitHub can repoint inline comments.
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
- Honest terminal states: `api_error`, `fixer_error`, `no_change`, `patch_failed`, `stale`, and `pushed`. Only a real branch commit after the request marker is delivery.

### `merge-bot.yml` — Merge Bot

- Candidates include bot-authored PRs, `automerge` PRs, trusted sync PRs, and same-repo `claude/*` PRs.
- `needs-owner` is a hard stop before any candidate acceptance.
- Requires latest `check-codex-status` on the head to be success.
- Uses latest check run per name and ignores cancelled tails from superseded queued runs.
- Protected paths in `.claude-guard.json` escalate instead of merge.
- Squash merge is head-SHA-pinned.

### Hub-only workflows

- `bootstrap.yml`: opens onboarding PRs for newly eligible repos; never auto-merges them.
- `telegram-morning-report.yml`: read-only daily digest; no write API calls.
- `minutes-guard.yml`: hub-only Actions-minutes guard. Its target coverage may be stale and needs audit before expansion.

## Repos Status

| Repo | Status | Notes |
|---|---|---|
| automation-core | loop installed and live | Public source of truth and test bed. |
| paywall-bot | partial | Has sync + gate + bridge synced per prior docs; current secrets/variables/runtime not checked in this pass. |
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
