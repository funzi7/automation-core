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

Verified 2026-11-09 (oauto GLM-audit round, device, disposable fixtures only):

- OpenCode 2.2.6's `glob`/`grep` tools run ripgrep with the pattern as a
  `--glob` filter rooted at the tool's `path`; `path` goes through
  `FileAccess.resolve`, which raises `external_directory` for anything outside
  the project directory and treats a backslash as a literal filename character
  (`windowsPath` is the identity on POSIX). Backslash glob patterns pass oauto's
  deny list but cannot list or read anything outside the repository (replayed
  against the real `rg`; evidence in the 2026-11-09 handoff entry).
- `opencode debug config --standalone` reports the loaded document's parsed
  content under `info`, including its `permissions` and `policies` arrays in
  the rendered shape; `verify-sources` now fails closed on them
  (`policies ok: 62 probes; permissions ok: 44 probes` on the device).
- The three GLM gaps (outside hard links, linked-worktree git dirs, missing
  credential names) reproduced on the previous launcher and are refused by the
  current one, on the real binary as well as in the node suite.

Verified 2026-11-08 (Codex Gate fail-closed pass, read-only against GitHub):

- Every `pull_request_target` Codex Gate run in paywall-bot and automation-core
  logged `trusted head marker publish failed ... Resource not accessible by
  integration`; no `codex-head-epoch:v3` comment exists on any PR of either
  repository (automation-core #41–#58, paywall-bot #94–#122). Cause: the gate
  declared `pull-requests: read`; the marker is a PR comment. Both repositories
  report `default_workflow_permissions: write`, so the fix is workflow YAML,
  not a repository setting.
- paywall-bot PRs #120/#121/#122 (Telegraph token fix) were gated correctly:
  pre-review `🟡` verdicts, then exact-head `Reviewed commit` receipts, then
  `🟢` on the exact head, then SHA-pinned Merge Bot squashes; PR #120's three
  Codex P2 threads were resolved before its final head.
- paywall-bot `main` carries locally modified `codex-gate.yml`,
  `merge-bot.yml`, `claude-fallback-watchdog.yml` (`b07344f4`, 2026-09-05)
  that predate PR #56; `codex-auto-fix.yml` matches the source.

- automation-core's `AUTOMATION_PAT` is rejected by GitHub: Merge Bot, the
  watchdog and CI Doctor fail every run in this repository with `Unhandled
  error: HttpError: Bad credentials` (401) — last Merge Bot success
  2026-09-08, failures continuous from 2026-09-11, including both runs woken by
  PR #59's green gate on 2026-11-08. paywall-bot's own PAT works. Owner must
  rotate the secret (LOOP_STATE item 9); nothing in PR #59 depends on it.

Not physically verifiable before the 2026-11-08 fix merges to `main`
(`pull_request_target` loads the gate from the default branch): the first
successful marker publish and the first `🟠 Gate evaluation error —
fail-closed` verdict.

Unknown / not checked in this pass:

- Downstream repo secrets, Actions variables, and broader runtime health,
  including paywall-bot beyond the exact evidence recorded below.
- Whether downstream repositories other than paywall-bot have the latest
  synced workflow contents.
- Any current Codex Cloud product behavior beyond the documented limitation: a ready diff is not delivery unless the PR head branch receives a commit.

## 4. Workflow Summary

### Canonical exact-head review evidence (contract)

The old assumption `valid review == Codex review` is retired. The contract is:

```
valid exact-head review evidence ==
  normal Codex evidence
  OR approved Claude fallback evidence when Codex is provably unavailable
```

Codex Gate, Merge Bot and the Claude Fallback Watchdog carry the identical
`CANONICAL EXACT-HEAD REVIEW EVIDENCE` block verbatim; a test asserts the three
copies are byte-identical and that `tools/review_evidence.js` mirrors its reason
codes, so the three deciders cannot drift.

Structured attestation (one atomic marker, all fields inside it):

```
<!-- claude-fallback-review:v1 run=<id> attempt=<n> pr=<n>
     provider=claude_code_fallback reviewed_head=<40-char SHA> verdict=clean
     findings_found=<N> findings_fixed=<N> unresolved_p1=0 unresolved_p2=0
     validation=passed/<reference> reason=codex_quota_unavailable -->
```

Trust, all fail-closed:

- Only `claude-fallback-review.yml` mints it: dispatch-only, default-branch
  only, policy-gated, no checkout, verdict derived not accepted.
- Consumers require `github-actions[bot]` authorship AND re-authenticate the
  run+attempt through the Actions API: the run must be that workflow, event
  `workflow_dispatch`, `head_branch` the default branch, and the comment must
  fall inside the run window. Any lookup failure ignores the attestation, and
  the whole evidence call is wrapped so a failure inside it looks like absent
  evidence, never like success and never like an evaluator error (the Gate's
  technical-error branch itself fails closed since 2026-11-08).
- Exact-head binding: `reviewed_head` must equal the live head. Any new commit
  invalidates it; a previous-head attestation fails.
- Trusted quota episode: the Codex connector identity must have posted its own
  code-review usage-limit notice. Route A = the decline landed on this head
  epoch. Route B = the decline predates this head epoch and Codex has posted
  nothing since. Both routes admit a fallback only when it was attested within
  24 h after the newest notice (Route A also admits one attested before that
  notice, because the head epoch bounds it from below); anything later is
  `stale_quota_evidence`. Any genuine Codex activity at least as new as the
  newest notice closes the episode — a same-second tie fails closed. No
  authenticated head epoch means no episode at all.
- Epoch binding and candidate scanning (2026-11-08 hardening, triggered by the
  Codex findings on paywall-bot PR #107): an attestation whose comment predates
  the current head epoch (A -> B -> A; 5 s skew like the run window) is
  rejected as `attestation_predates_head_epoch`; a candidate outside its
  episode no longer ends the scan, so a newer stale attestation cannot hide an
  older still-valid exact-head one, while a blocking (unresolved P1/P2)
  attestation still wins immediately. The producer run's `path` is accepted
  bare or suffixed with that run's own branch (`@<head_branch>` or
  `@refs/heads/<head_branch>`) and nothing else, and the producer counts
  trusted Codex reactions as Codex activity exactly as every consumer does and
  refuses to mint more than 24 h after the newest notice.
- Precedence: override (clear) or technical evaluation error (pending,
  fail-closed), then active Codex findings, then a fallback
  declaring unresolved P1/P2, then genuine current-head Codex evidence, then an
  accepted fallback, else pending. A fallback can never bypass a real Codex
  finding, and a returning Codex review on the current head is the authority.
- Provenance is truthful: `Codex exact-head review accepted` or
  `Claude Code fallback review accepted for exact head; Codex quota
  unavailable`. Never "Codex reviewed" for a Claude review.
- `codex-p1-acknowledged`, owner override and reaction acknowledgement keep
  their own semantics and are never used to represent a fallback.

Acceptance coverage lives in `tests/test_review_evidence.js` (50 tests,
numbered `1`..`15` to match the mandated matrix one-for-one): the
full mandatory matrix, the paywall-bot PR #103 regression built on that PR's
real timestamps, the shipped inline block from all three consumers executed
directly across the trust matrix, the producer executed against its refusal
matrix, and proof that the Codex-only path is unchanged when the policy switch
is off. Rationale: `docs/adr/0001-canonical-review-evidence.md`.

### `claude-fallback-review.yml`

Canonical attestation producer. See the contract above and README for the
operator command. Fallback stays off until a repository sets
`CLAUDE_FALLBACK_REVIEW_ENABLED` to `true`; Actions variables are not synced.

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
- paywall-bot, checked 2026-11-08: `main` runs a STALE and LOCALLY MODIFIED
  `codex-gate.yml`, `merge-bot.yml` and `claude-fallback-watchdog.yml`
  (feature commit `b07344f4`, 2026-09-05, added a Codex summary-row reaction
  binding) that predate PR #56; `codex-auto-fix.yml` matches the source and
  `claude-fallback-review.yml` is absent. The official sync PR #107 (head
  `c770aa5`, open since 2026-10-02) is red for two reasons: Codex left 4 P1 +
  5 P2 findings on the synced gate/evidence code (addressed centrally by the
  2026-11-08 fail-closed work), and paywall-bot's own
  `tests/test_codex_gate_logic.js` asserts the local summary-row patch
  (`not ok 19 - authoritative workflow keeps gate policy inline`), which must
  be updated in paywall-bot when the sync lands. The Telegraph PRs
  #120/#121/#122 (2026-11-08) were gated correctly by that stale gate through
  exact-head `Reviewed commit` receipts; their marker publishes failed with the
  same 403 as everywhere else.

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

A00. Codex Gate fail-closed enforcement (2026-11-08, branch
`claude/codex-gate-fail-closed`, PR #59
<https://github.com/funzi7/automation-core/pull/59>, owner merge pending):

- DONE in this repository: `pull-requests: write` on the gate and the fallback
  producer (the PR-comment markers were failing with 403 everywhere, never
  written once since 2026-08-13); technical gate errors publish a failure
  verdict titled `🟠 Gate evaluation error — fail-closed` instead of a green
  one (watchdog treats it like pending); Codex's structured
  `codex-review-state:v1` completed marker counts as exact-head evidence;
  review threads longer than one GraphQL page fail closed; the canonical
  evidence block closes quota episodes on ties, bounds Route A by the
  attestation time, binds attestations to the current head epoch, skips
  inactive candidates, tolerates an `@ref` run path, and the producer counts
  Codex reactions — the Codex P1/P2 findings left on paywall-bot sync PR #107.
  Regression tests execute the shipped gate script end to end through the
  incident shape (marker 403, missing marker + reaction, late previous-head
  review, active P1/P2, technical error) and pin the permission shape.
- PENDING (physical): owner merge — Merge Bot cannot do it by design (policy
  mirror dry-run 2026-11-08: `not_candidate` without `automerge`, and
  `protected_path_untrusted` with it, because a `claude/*` branch carries
  Claude provenance and the PR touches `workflows/**` /
  `.github/workflows/**`; `main` is unprotected, so the owner merges with
  `gh pr merge 59 --squash`). Review state at 21:47Z: Codex reviewed the exact
  head `5491701` on request — receipt with `**Reviewed commit:** 5491701be5`,
  completed review-state marker with no findings, 👍, no threads; the gate
  published `🟢 Reviewed — clear` on that head and CI is green, so review and
  required checks are genuinely satisfied. Second, independent blocker: Merge
  Bot cannot run at all in this repository — its `AUTOMATION_PAT` is rejected
  (`Bad credentials`, since 2026-09-11; both runs woken by this green gate
  crashed), so the owner must also rotate that secret (LOOP_STATE item 9) before
  any automated merge here. After the merge, the first
  `pull_request_target` gate run on `main` (any push to an open PR, e.g. #58,
  or a new PR) must log `indexed trusted head epoch run` and leave a
  `github-actions[bot]` `codex-head-epoch:v3` comment on that PR — OBSERVED
  2026-11-09 02:20Z on PR #58's first push after the merge (PR #59 merged as
  `15e44e6` on 2026-11-08): run `42550382183` logged `indexed trusted head
  epoch run 42550382183/1` and the marker comment is on the PR, no 403; the `🟠` verdict cannot be induced safely in production
  and stays covered by the end-to-end tests only. Then paywall-bot's daily
  sync (03:00 UTC cron, template-identical `sync-automation-core.yml`; or an
  owner `gh workflow run sync-automation-core.yml --repo funzi7/paywall-bot`)
  pushes the new contents to `chore/sync-automation-core`, refreshing PR #107
  (unchanged since 2026-10-02 only because automation-core `main` has not
  changed since PR #56); Codex must re-review the new sync head; and
  paywall-bot's own `tests/test_codex_gate_logic.js` must drop its pins on
  `completedCodexSummaryTargetsHead` / `codex-pull-request-review-summary` in
  `.github/workflows/codex-gate.yml`, `merge-bot.yml` and
  `claude-fallback-watchdog.yml` (test "authoritative workflow keeps gate
  policy inline", plus the three `completedCodexSummaryTargetsHead` unit tests
  and the export in its local `tools/codex_gate_logic.js`) — the synced gate
  binds through `codex-review-state:v1` instead. That test change is a
  paywall-bot commit, not made from this repository.
- SUPERSEDED by this pass: "intentional technical fail-soft" in the gate (now
  fail-closed) and "Route A deliberately carries no TTL" in ADR 0001 (now
  bounded by the attestation time); paywall-bot's local summary-row reaction
  binding (replaced by the structured `codex-review-state:v1` binding).

A0. Canonical Claude fallback review evidence (this pass):

- implemented centrally in automation-core and covered deterministically;
  PR #56 merged 2026-09-15 as `15652f663ccf31fac3c03651a5a7b56758257de4`;
- physically pending (checked 2026-11-07): no consumer default branch carries
  `claude-fallback-review.yml` yet — sync PRs paywall-bot #107, OPT #20 and
  TRF #92 are open and unmerged — and no repository has set
  `CLAUDE_FALLBACK_REVIEW_ENABLED` to `true`, so no fallback evidence is
  honoured anywhere yet;
- no production attestation has been minted or honoured yet;
- OptionsProfitTracker PR #19 still cannot pass: every trusted quota notice on
  it predates its current head, so it needs either fresh current-head quota
  evidence plus a new exact-head fallback review, or a normal Codex review.

A1. oauto — read-only OpenCode reviewer launcher (2026-11-07):

- `launchers/ai-launch` (tracked copy of the device launcher, + `opencode`
  mode) and `launchers/oauto/` (preflight, policy render/verify, installer,
  Termux wrapper, tests) are on branch `claude/oauto-opencode-reviewer` (PR #58);
  contract in `docs/adr/0002-oauto-read-only-opencode-reviewer.md`;
- installed on the device and validated against OpenCode 2.2.6 with disposable
  fixture repositories; full record in the dated `handoffs/loop-build.md` entries;
- 2026-11-08: Codex's review of the first PR head reported three P1s in the git
  preflight (external diff/textconv helpers could execute; TAB/newline/non-ASCII
  filenames escaped the secret exclusion; rename detection hid a renamed
  secret's source). Fixed on the PR branch — scrubbed, helper-free, `--work-tree`
  pinned git calls; NUL-delimited bytes-exact classification with a proof step;
  `--no-renames` plus both-sides exclusion of renamed secrets — with regression
  tests that reproduced each leak first; ADR 0002 amended (decision item 8). The
  Codex re-review and Gate state for the fixed head live in
  `agent-memory/automation-core/cc-latest.md`;
- 2026-11-09: the owner's GLM whole-repository audit (run through `oauto` on
  automation-core itself, 2026-11-08) was verified claim by claim. Fixed with
  reproduce-first regression tests: a hard link whose other name lies outside
  the repository was undetectable (refused unconditionally when `st_nlink`
  exceeds the names the scan sees in the worktree and `.git`); a linked
  worktree's git dir and commondir skipped the symlinked-config refusal and the
  hard-link alias registration (walked under the `.git` rules); Composer
  `auth.json`, `.pgpass`, `.my.cnf`, `.s3cfg`, `*.ppk`, kubeconfig, Terraform
  CLI, RubyGems and service-account spellings added to the one pattern list;
  `verify-sources` now requires the `policies` and `permissions` of the
  document OpenCode reports having loaded to equal the rendered arrays rule for
  rule and probes them (real 2.2.6: 62 + 44 probes). An independent Opus review
  then found a pre-existing P2 — a crafted `.git` file pointed the preflight at
  another local repository and leaked its content into the prompt — fixed with
  `check-repo-git` before any git command, plus six P3s (git-exact pointer
  parsing, verbatim arrays, exact-name denial of case-variant secret files
  under the override, object-store hard-link accounting, secret-named git-dir
  aliases, walk errors failing closed); Codex's review of the pushed head
  `33c0dda` added one P1 of the same class — a real `.git` directory carrying
  a `commondir` file naming another repository — fixed in `5860e1f`; its
  review of `0ca1844` added a P1 in the include-history traversal (a committed
  symlink among deleted included configs read as text instead of followed) —
  fixed in `afd4639` (`resolve-link`); its review of `2c743cf` added a P1 in
  that resolver (an absolute target inside the repository treated as outside)
  — fixed in `62fca59`, which also resolves committed directory symlinks on
  include paths; its review of `4dc70dd` added a P1 (an include path through
  a later-retargeted directory symlink lost its written name) — fixed in
  `4544f09` (written name registered next to the resolved one); its review
  of `9e8a88d` added the same gap inside `resolve-link` for absolute targets
  — fixed in `09dfcc8` (targets judged both as written and as live-resolved);
  its review of `bdc6cef` added a P1 (nested relative includes of a symlinked
  config resolved against the target's directory, not the path git opened) —
  fixed in `2d5d7b7` (history entries carry their resolution context); its
  review of `0bc9c29` added a P1 (a symlink target with a symlinked directory
  followed by `..` collapsed lexically) — fixed in `3059954` + `f16dfe6`
  (historical include paths are walked through the tree at the revision,
  `tree_walk`, replacing the per-link resolver); its review of `d64744c`
  added a P1 (an include directive written `conf/../b.cfg` collapsed before
  the walk) — fixed in `f852171` (directives reach the walk uncollapsed, as
  `W` records and `--walk-out`); its review of `2389a03` added a P1 (a link
  target ending in a newline lost it to command substitution) — fixed in
  `d9b71a1` (targets read byte-exact); its review of `68d2fd2` added a P1
  (a link target leaving through an outside alias pointing back into the
  repository treated as outside) — fixed in `8308090` (such paths re-enter
  the walk); a second Codex pass on `3833718` added a P1 (command
  substitution around `realpath` dropped trailing newline bytes of an
  in-repository name reached through an outside alias) — fixed in `1e6fbd0`
  (`realpath -z -m` read NUL-terminated). Owner-approved OPTION 1
  (2026-11-09): default mode unchanged, PR review mode added in `425e6ee`
  (`oauto <repo> pr`: one read-only `gh api` call outside the model
  identifies the branch's open pull request, validated fail-closed; the
  unchanged pipeline runs against the verified base commit; never fetches).
  An independent review of that diff found a pre-existing P1 (`git ls-tree`
  read a leading `:` in an included config's name as pathspec magic; fixed
  with `:(literal)`, `e01de32`) and a PR-mode P2 (`gh api` placeholder
  rewriting of the head filter, gh running git in the repository; `%3A` and
  `cd /`, `1b62929`) plus four P3s, all fixed with tests. Shown
  NOT reproducible on the real binary: the claimed backslash glob escape
  (ripgrep `--glob` filter rooted at the tool path; `external_directory` gates
  the path) — no rule added. Recorded as backlog, not changed here: mutable
  third-party action tags, the `validate.sh` YAML glob, the duplicated alias
  regex (LOOP_STATE item 11). `main` (PR #59) merged into the branch
  (`01f6840`). Full record: the 2026-11-09 `handoffs/loop-build.md` entry;
- DONE by the owner (2026-11-08): the Termux hop and a review of a real project
  repository (the GLM audit above);
- physically pending: the PR merge, a full DeepSeek TUI session, and the
  owner's decision on listing `oauto` in `DEVELOPMENT_RULES_FULL` §7. The
  launcher refuses any OpenCode version other than 2.2.6 until re-validated.

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
