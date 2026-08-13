# CONTEXT.md — Full briefing for the self-healing CI/CD loop

> Canonical, self-contained handoff. Read this first. `LOOP_STATE.md` is the concise per-workflow state reference; `handoffs/loop-build.md` is the dated change log.
>
> Privacy rule: this is a public repo. Never write the owner's personal name. Refer to the human as "the owner". `needs-owner` is the escalation stop; `needs-owner-auto` is provenance only, and `no-automerge` is the permanent opt-out.

---

## 1. Purpose

`funzi7/automation-core` is the public hub repository for a self-healing CI/CD loop distributed to participating repos through workflow sync. The deliberate division of labor is:

- Codex (`chatgpt-codex-connector[bot]`) reviews PRs and raises P1/P2 findings.
- Claude fixes when asked by the bridge or CI Doctor.
- Codex Gate blocks merge until Codex has reviewed the current head and no active P1/P2 remains.
- Merge Bot automatically squash-merges an eligible exact-head-green PR. A
  same-repository owner PR is eligible by default; `no-automerge` is the
  permanent opt-out, and manual/unknown `needs-owner` remains a hard stop.

The repository preserves a direct-to-main operating convention for automation-core maintenance unless a task explicitly says otherwise. Workflow logic is the source of truth for behavior; this document explains the current architecture and marks superseded incident history.

## 2. Current Architecture Snapshot

2026-08-13 completed emergency recovery: bootstrap PR #40 restored Codex Gate parsing in
merge `fd16f6ad875726386f4f7c029993639cafebaa01`, added durable Watchdog
Telegram failure dedupe, and made CI Doctor ignore internal automation paths.
The repaired dispatch then exposed a separate flaw: a Codex usage-limit notice
was accepted as a current-head review signal, and PR #38 auto-merged as
`cdf4c94528fdfd81ab00742c549355912355bcc1`. Forward security PR #41 and
review-driven follow-ups #42-#51 are merged; they isolate Issue-mode Claude
from PAT credentials and interpreters, reject capacity notices, authenticate
head epochs, require real delivery, preserve permanent/manual stops through
label races, and include every trusted finding channel in fixer context.
All four loop workflows are enabled in automation-core and paywall-bot.

Production evidence: Gate dispatch `31681859499` succeeded after bootstrap;
scheduled Watchdog runs `31687590924` and `31692340712` completed without the
old parse/dispatch/Telegram failure; CI Doctor did not recreate closed Issue
#39. Paywall-bot PR #94 ended at exact head
`5d65f205708435aab09ce03ace5880c30b342293`, passed application CI, clean Codex
review and Gate, then Merge Bot auto-merged it as
`2575f0f2b16c12ebb9b9173e8c9a8248ab529ebe`.

Expression-safety PR #52 normally auto-merged as
`961b51d9ff23edd215ff026d8dc0845f9a8124a9`, then paywall-bot sync PR #96
normally auto-merged as `cb5cc5d87f335963e1f80db54de11fe706e3f6de`.
Documentation PR #97 exposed a separate delayed-result race: a Codex task
summary initiated on the old head arrived after a new push, and timestamp-only
binding let it green the new head before that head's review completed. The
current repair admits review/result surfaces explicitly bound by `commit_id`,
`original_commit_id`, or `Reviewed commit`; task summaries and timing-only
signals are non-review evidence. Reaction-only clean is accepted only while
authenticated marker history proves the PR has had one observed head.

Code architecture base: fix #27 implementation commit `93f6acb9d2e0396afad3e10854503024843c32de`.

Previous documentation reconciliation: `ff57a73220faa5dbb563edc7b035fc6cc653c509`.

This recovery pass also hardens workflow expression transport and its validator.
It moves values out of every `actions/github-script` body and into step/job
`env` in `bootstrap.yml` plus the source/mirror copies of `claude.yml`,
`codex-auto-fix.yml`, and `codex-backup-fix.yml`. The gate/fixer semantics are
unchanged, and the source/mirror pairs remain byte-identical.

Current fixer ladder:

```text
Codex auto-review
  -> Claude
  -> Codex API only when CODEX_BACKUP_ENABLED == 'true'
  -> Codex Cloud unless CODEX_CLOUD_ENABLED == 'false'
  -> Claude proxy only after genuine Claude no_delivery and only if it can deliver to the original PR head
  -> needs-owner
  -> Codex Gate
  -> Merge Bot
```

Delivery means a real commit reaches the actual relevant PR head branch after that stage's request marker.

Not delivery:

- workflow success alone;
- View task;
- task diff;
- Created commit wording;
- Cloud-side commit hint;
- secondary PR.

Per-repo switches are not synced:

| Switch | Default | Literal override |
|---|---:|---|
| `CLAUDE_ENABLED` | enabled | `false` disables Claude and lets the watchdog pre-skip Claude. |
| `CODEX_BACKUP_ENABLED` | disabled | only `true` enables the Codex API backup. Disabled means skipped, not immediate escalation. |
| `CODEX_CLOUD_ENABLED` | enabled | `false` disables Codex Cloud. |

Trusted Codex identity is surface-specific and exact:
`chatgpt-codex-connector[bot]` on REST comments/reviews and
`chatgpt-codex-connector` for the same App in GraphQL review threads. Do not
add substring, regex, or other alias matchers.

## 3. Verification State

Code-verified in this pass:

- `claude.yml` resolves PR comments through the GitHub API before running Claude.
- Same-repo PR comments check out the exact PR head SHA and attach to the existing head branch.
- Fork PR comments skip before writable checkout / Claude execution and mark `needs-owner` / `fixer_error` where possible.
- Public comment-triggered Claude runs require owner-authored comments.
- Bridge and gate both support P1 + P2 and exclude P3.
- Codex API backup is enabled only by literal `CODEX_BACKUP_ENABLED == 'true'`.
- Codex Cloud is enabled unless literal `CODEX_CLOUD_ENABLED == 'false'`.
- The trusted Codex login is the exact app bot login above.

Runtime verified:

- Older incidents verified that workflow success and Cloud summaries can fail to deliver a PR-head commit, which is why current delivery checks exist.
- Older incidents verified Anthropic credit exhaustion can surface as a Claude `billing_error` with zero tokens.

Runtime-unverified after fix #27:

- Claude direct delivery to the original same-repo PR head branch.
- Claude proxy applying a Codex Cloud ready diff to the original PR head.
- Codex API backup delivery while OpenAI quota is unavailable.

Unknown / not checked in this pass:

- Downstream repo secrets, Actions variables, workflow permissions, and broader
  runtime health, including paywall-bot beyond the exact evidence recorded
  below.
- Whether downstream repositories other than paywall-bot have the latest
  synced workflow contents.
- Any current Codex Cloud product behavior beyond the documented limitation: a ready diff is not delivery unless the PR head branch receives a commit.

## 4. Workflow Summary

### `codex-auto-fix.yml`

The bridge watches trusted Codex reviews/comments. It posts exactly one owner-authored `@claude fix` per current-head review wave when there is active P1 or P2. P3 does not trigger paid fixing. It inlines finding text because Claude's run context cannot reliably read inline review threads. Sync PRs are suppressed so downstream workflow copies are not patched locally.

The archive job writes Codex summaries to agent-memory when configured; it is fail-soft.

### `claude.yml`

Claude fixes `claude-fix` Issues by creating a new branch/PR with `Fixes #N`.
Issue mode receives only `github.token`, checks out without persisted
credentials, grants no shell/interpreter tools, uses constrained signed API
file operations, and must pass a git-credential scrub before any trusted
PAT-backed post-step. For same-repo existing PR comments, fix #27 checks out
the original PR head SHA/branch and intentionally permits its writable branch
credential and validation tools, with no new branch and no second PR.
Fork-headed PR comments are skipped safely.

Claude is default-on unless `CLAUDE_ENABLED == 'false'`. Current Anthropic credit is exhausted in recent runs, so this path is implemented but not runtime-proven after fix #27.

### `claude-fallback-watchdog.yml`

The watchdog advances stages by delivery, not by workflow conclusions. It reads loop markers and checks for commits after each request marker.

Current stage behavior:

- Claude `billing_error` / `fixer_error` advances immediately.
- Claude `no_delivery` or timeout advances to the next enabled stage.
- Codex API runs only when `CODEX_BACKUP_ENABLED == 'true'`; disabled means skipped.
- Codex API `stale` stops the old head cycle.
- Codex Cloud is requested unless `CODEX_CLOUD_ENABLED == 'false'` and never counts View task / ready diff as delivery.
- Claude proxy is attempted only for genuine Claude `no_delivery`, same-repo, Claude-enabled cases, and is runtime-unverified.
- `needs-owner` is terminal for automation.

### `codex-backup-fix.yml`

The Codex API backup is dormant by default and requires OpenAI quota plus `CODEX_BACKUP_ENABLED='true'`. Its agent job is read-only and receives only `OPENAI_API_KEY`; its apply job is write-capable and handles stale/no-change/patch-failed states honestly. Fork PRs are skipped before agent execution.

### `codex-gate.yml`

The gate blocks until Codex has reviewed the current head and no active P1/P2 remains. Trusted Codex usage-limit/capacity notices are explicitly excluded. Review objects and inline comments bind through immutable `commit_id`/`original_commit_id`; Codex result comments must name the exact `Reviewed commit`. Task summaries and timing-only surfaces never become affirmative review signals, because asynchronous old-head work can complete after a new push. Reaction-only clean is accepted only when authenticated Gate marker history proves there has been no other observed head; after a transition, immutable commit-bearing evidence is mandatory. Authenticated head epochs also preserve A→B→A boundaries and trusted-sync grace. Trusted sync grace-green applies only to zero-signal trusted sync PRs after the server-observed grace window.

### `merge-bot.yml`

Merge Bot considers ordinary open non-draft same-repository PRs authored by
`funzi7`, along with established Claude, explicit `automerge`, and trusted
sync paths. Fork title/branch naming never creates trust. It requires every
latest relevant check/status green, an authoritative `check-codex-status`
success on the exact head, no active trusted P1/P2 thread, affirmative
mergeability, and a SHA-pinned squash merge. `no-automerge` and manual/unknown
`needs-owner` are hard stops. Temporary fixer/watchdog escalation writes both
`needs-owner` and `needs-owner-auto`; only an exact-head fully-green evaluation
may remove both and continue to merge in the same pass. Protected paths remain
fail-closed for forks/untrusted/ambiguous PRs but no longer force an additional
manual merge for a fully reviewed ordinary same-repo owner PR. The trusted
Claude workflow writes durable `claude-generated` provenance as
`github-actions[bot]`; Merge Bot also checks historical label events. For Issue
runs, the action controls the `claude/*` branch, Claude lacks broad branch and
PR-creation commands, and a trusted post-step creates the PR from the action's
exact branch output. Provenance is therefore present at creation, before CI or
Gate can wake. PAT-owner Claude PRs remain protected-path fail-closed; exact
trusted automation-core sync PRs retain rollout only without Claude provenance.

The native `codex-gate-evaluator` job is diagnostic and can retain its expected
pre-review failure on the PR head. Merge Bot ignores only that diagnostic
check name; the explicit exact-head `check-codex-status` must exist and
succeed, and every other latest failed/running check or status still blocks.

The 2026-08-11 source reconciliation ported paywall-bot's reviewed Codex Gate
and watchdog safety fixes upstream before changing merge policy. The stale
paywall-bot sync PR #89 was closed unmerged and its stale
`chore/sync-automation-core` branch deleted; it is not a rollout base.

### Hub-only workflows

- `bootstrap.yml`: opens onboarding PRs for eligible repos; never auto-merges them.
- `telegram-morning-report.yml`: read-only digest; no GitHub writes.
- `minutes-guard.yml`: Actions-minutes guard; target list needs current downstream audit before expansion.

## 5. Current Downstream Facts

Verified current facts only:

- paywall-bot PR #96 exact head
  `d29810b1c2f3e0a4bf425aa364cf3bbfec99aa3d` contained all seven configured
  workflows byte-identical to automation-core source, passed downstream CI,
  exact-head Codex review and Gate, and was normally auto-merged as
  `cb5cc5d87f335963e1f80db54de11fe706e3f6de`. Its Codex Gate, Claude Fixer,
  Watchdog, and Merge Bot workflows are active. One final sync is required for
  the delayed-result race correction in the current automation-core PR.
- OptionsProfitTracker PR #12 is merged.
- thai-rent-finder PR #80 is merged.

Not verified in this pass for every downstream, including paywall-bot:

- downstream secrets;
- Actions variables;
- workflow permissions;
- broader current CI/runtime health beyond the exact facts above.

Also not verified for downstream repositories other than paywall-bot:

- current synced workflow contents;
- whether they are fully in sync beyond the specific PR facts above.

Do not claim a downstream is synced or healthy without fresh evidence from the repo's latest sync PR/current workflow contents and settings.

## 6. Historical / Superseded Lessons

These are preserved as incident records. They are not current operating instructions when marked HISTORICAL or SUPERSEDED.

- HISTORICAL: Fix #8 originally made disabled Codex API backup escalate on first Claude timeout. SUPERSEDED by fix #23/#26: disabled Codex API is skipped; the ladder proceeds to Codex Cloud, then eligible Claude proxy, then `needs-owner` only after enabled stages fail delivery.
- HISTORICAL: early gate/bridge behavior was P1-focused. SUPERSEDED: current bridge and gate both use P1 + P2, P3 excluded.
- HISTORICAL: action success was once treated as adequate. SUPERSEDED: delivery requires a real PR-head commit after the request marker.
- HISTORICAL: Cloud View task / Created commit summaries once looked actionable enough to wait on. Current rule: they are non-delivery unless a real PR-head commit lands.
- HISTORICAL: prior onboarding notes described OPT #12 and TRF #80 before merge. Current verified facts: both are merged.
- HISTORICAL: old escalation-label migration notes exist in git history. Current rule: only `needs-owner` is valid; do not reintroduce any prior name.
- HISTORICAL: manually applied YAML/script edits once broke workflow parsing. Current rule: validate YAML/actionlint/script syntax before workflow changes. This pass changed expression transport in four workflow definitions and validated every tracked workflow/script body.

## 7. Current Open TODO

A. Recovery documentation and expression-safety work completed in this pass:

- stale current-tense claims normalized;
- Claude PR-head delivery and Claude proxy described as implemented but runtime-unverified;
- disabled Codex API backup behavior corrected to skipped, not immediate escalation;
- OPT #12 and TRF #80 recorded as merged;
- GitHub expression values were moved from inline `github-script` bodies to
  step/job `env` without changing gate or fixer semantics;
- validation now scans every tracked YAML workflow, rejects any direct
  expression in a `github-script` body, and syntax-checks every extracted body;
- the changed source/mirror workflow pairs are byte-identical; paywall-bot PR
  #96 delivered the expression-safety changes, and one final normal sync is
  required for the delayed-result race correction.

B. Claude-budget-blocked runtime verification:

- restore Anthropic credit;
- create one harmless same-repo PR with active P1 or P2;
- trigger `@claude fix`;
- verify commit reaches original PR head branch;
- verify no secondary branch or PR;
- verify watchdog recognizes delivery;
- verify no `no_delivery` marker after successful push.

C. OpenAI API quota-blocked verification:

- restore OpenAI quota;
- set `CODEX_BACKUP_ENABLED='true'` only in a controlled repo;
- verify request, terminal states, stale behavior, and real PR-head push.

D. Downstream sync / secrets / variables audit:

- verify latest sync PR/current workflow contents per repo;
- verify `AUTOMATION_PAT`, `ANTHROPIC_API_KEY`, and optional `OPENAI_API_KEY` where intended;
- verify `CLAUDE_ENABLED`, `CODEX_BACKUP_ENABLED`, `CODEX_CLOUD_ENABLED`, and `CLAUDE_SHOW_FULL_OUTPUT` where intended;
- verify Actions workflow permissions before enabling Codex API backup;
- update minutes-guard target coverage only after the audit.

E. Longer-term work:

- Telegram control surface remains future work;
- possible history rewrite to purge prior escalation-label strings requires explicit authorization and would involve a force push, so it is not part of normal work;
- branch protection can be revisited once the loop is stable.

## 8. Operating Conventions

- Keep workflow source copies byte-identical when workflow logic changes.
- Do not change workflows during documentation-only tasks.
- Use `needs-owner` for the stop, `needs-owner-auto` only as temporary PR
  automation provenance, and `no-automerge` as the permanent human opt-out.
- Preserve direct-to-main unless explicitly redirected.
- Never force-push unless the owner explicitly authorizes that exact operation.
- Never use browser automation, Playwright, session cookies, UI-click automation, or fake Codex Cloud Update-branch implementations.
