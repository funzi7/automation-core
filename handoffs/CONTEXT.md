# CONTEXT.md — Full briefing for the self-healing CI/CD loop

> Canonical, self-contained handoff. Read this first. `LOOP_STATE.md` is the concise per-workflow state reference; `handoffs/loop-build.md` is the dated change log.
>
> Privacy rule: this is a public repo. Never write the owner's personal name. Refer to the human as "the owner". The only escalation label is `needs-owner`.

---

## 1. Purpose

`funzi7/automation-core` is the public hub repository for a self-healing CI/CD loop distributed to participating repos through workflow sync. The deliberate division of labor is:

- Codex (`chatgpt-codex-connector[bot]`) reviews PRs and raises P1/P2 findings.
- Claude fixes when asked by the bridge or CI Doctor.
- Codex Gate blocks merge until Codex has reviewed the current head and no active P1/P2 remains.
- Merge Bot merges eligible green PRs when no `needs-owner` hard stop exists.

The repository preserves a direct-to-main operating convention for automation-core maintenance unless a task explicitly says otherwise. Workflow logic is the source of truth for behavior; this document explains the current architecture and marks superseded incident history.

## 2. Current Architecture Snapshot

Code architecture base: fix #27 implementation commit `93f6acb9d2e0396afad3e10854503024843c32de`.

Previous documentation reconciliation: `ff57a73220faa5dbb563edc7b035fc6cc653c509`.

This final normalization is documentation-only. It does not change workflow logic.

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

Trusted Codex identity is exact: `chatgpt-codex-connector[bot]`. Do not add substring, regex, or alias matchers.

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

- Downstream repo secrets, Actions variables, workflow permissions, and current runtime health.
- Whether each downstream has the latest synced workflow contents.
- Any current Codex Cloud product behavior beyond the documented limitation: a ready diff is not delivery unless the PR head branch receives a commit.

## 4. Workflow Summary

### `codex-auto-fix.yml`

The bridge watches trusted Codex reviews/comments. It posts exactly one owner-authored `@claude fix` per current-head review wave when there is active P1 or P2. P3 does not trigger paid fixing. It inlines finding text because Claude's run context cannot reliably read inline review threads. Sync PRs are suppressed so downstream workflow copies are not patched locally.

The archive job writes Codex summaries to agent-memory when configured; it is fail-soft.

### `claude.yml`

Claude fixes `claude-fix` Issues by creating a new branch/PR with `Fixes #N`. For same-repo existing PR comments, fix #27 checks out the original PR head SHA/branch and instructs Claude to commit/push only there, with no new branch and no second PR. Fork-headed PR comments are skipped safely.

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

The gate blocks until Codex has reviewed the current head and no active P1/P2 remains. It uses date-only freshness against the max commit date and does not trust `commit_id` for freshness. Trusted sync grace-green only applies to zero-signal trusted sync PRs after the grace window.

### `merge-bot.yml`

Merge Bot considers bot-authored PRs, `automerge` PRs, trusted sync PRs, and same-repo `claude/*` PRs. It filters `needs-owner` first, requires latest `check-codex-status` success on the head, respects protected paths, and uses head-SHA-pinned squash merge.

### Hub-only workflows

- `bootstrap.yml`: opens onboarding PRs for eligible repos; never auto-merges them.
- `telegram-morning-report.yml`: read-only digest; no GitHub writes.
- `minutes-guard.yml`: Actions-minutes guard; target list needs current downstream audit before expansion.

## 5. Current Downstream Facts

Verified current facts only:

- OptionsProfitTracker PR #12 is merged.
- thai-rent-finder PR #80 is merged.

Not verified in this pass:

- downstream secrets;
- Actions variables;
- workflow permissions;
- current synced workflow contents;
- current CI/runtime health;
- whether any downstream is fully in sync beyond specific PR facts above.

Do not claim a downstream is synced or healthy without fresh evidence from the repo's latest sync PR/current workflow contents and settings.

## 6. Historical / Superseded Lessons

These are preserved as incident records. They are not current operating instructions when marked HISTORICAL or SUPERSEDED.

- HISTORICAL: Fix #8 originally made disabled Codex API backup escalate on first Claude timeout. SUPERSEDED by fix #23/#26: disabled Codex API is skipped; the ladder proceeds to Codex Cloud, then eligible Claude proxy, then `needs-owner` only after enabled stages fail delivery.
- HISTORICAL: early gate/bridge behavior was P1-focused. SUPERSEDED: current bridge and gate both use P1 + P2, P3 excluded.
- HISTORICAL: action success was once treated as adequate. SUPERSEDED: delivery requires a real PR-head commit after the request marker.
- HISTORICAL: Cloud View task / Created commit summaries once looked actionable enough to wait on. Current rule: they are non-delivery unless a real PR-head commit lands.
- HISTORICAL: prior onboarding notes described OPT #12 and TRF #80 before merge. Current verified facts: both are merged.
- HISTORICAL: old escalation-label migration notes exist in git history. Current rule: only `needs-owner` is valid; do not reintroduce any prior name.
- HISTORICAL: manually applied YAML/script edits once broke workflow parsing. Current rule: validate YAML/actionlint/script syntax before workflow changes. This task did not change workflows.

## 7. Current Open TODO

A. Documentation/state work completed in this pass:

- stale current-tense claims normalized;
- Claude PR-head delivery and Claude proxy described as implemented but runtime-unverified;
- disabled Codex API backup behavior corrected to skipped, not immediate escalation;
- OPT #12 and TRF #80 recorded as merged;
- no workflow logic changed.

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
- Use `needs-owner` as the only escalation label.
- Preserve direct-to-main unless explicitly redirected.
- Never force-push unless the owner explicitly authorizes that exact operation.
- Never use browser automation, Playwright, session cookies, UI-click automation, or fake Codex Cloud Update-branch implementations.
