# loop-build — Claude Code ⇄ Claude Chat handoff log

Handoff log for the self-healing-loop build. Newest entry is first. Historical entries below are retained as incident context only; when they describe behavior that differs from the current architecture, they are explicitly marked HISTORICAL or SUPERSEDED and defer to `LOOP_STATE.md` and `handoffs/CONTEXT.md` for current operating instructions.

---

## [2026-09-15 UTC] Canonical Claude fallback review evidence
- PR: <https://github.com/funzi7/automation-core/pull/56>
- Branch: `claude/canonical-fallback-review-evidence`
- Status: opened — exact-head CI green, Gate red pending review evidence
- What changed:
  - The central contract is now `valid exact-head review evidence == normal
    Codex evidence OR approved Claude fallback evidence when Codex is provably
    unavailable`. Implemented in automation-core, not as a consumer patch.
  - New `workflows/claude-fallback-review.yml` is the only sanctioned producer
    of a structured `claude-fallback-review:v1` attestation: dispatch-only,
    default-branch only, gated on `CLAUDE_FALLBACK_REVIEW_ENABLED`, no checkout,
    verdict derived rather than accepted, and it refuses to attest unless the
    SHA is the live head, a trusted Codex quota notice exists, Codex has no
    result on that head, and no trusted Codex P1/P2 is still active.
  - Codex Gate, Merge Bot and the watchdog now carry one verbatim-shared
    `CANONICAL EXACT-HEAD REVIEW EVIDENCE` block; a test asserts the three
    inline copies are byte-identical and that `tools/review_evidence.js`
    mirrors its reason codes.
  - Consumers re-authenticate every attestation against the producing run
    (workflow path, `workflow_dispatch` event, default-branch `head_branch`,
    attempt, comment-inside-run-window) and fail closed on any lookup error;
    the evidence call cannot throw into the Gate's technical fail-soft green.
  - Quota episodes are bound to real evidence: Route A (decline on this head
    epoch) or Route B (decline predates it, Codex silent since, attested within
    24 h). Genuine Codex activity newer than the newest notice closes the
    episode; no authenticated head epoch means no episode.
  - Provenance is truthful; `codex-p1-acknowledged`, owner override and
    reaction acknowledgement are untouched and are never used for fallback.
- Validation: 127 deterministic tests pass (43 new in
  `tests/test_review_evidence.js`) — the full mandatory acceptance matrix, the
  paywall-bot PR #103 regression built on that PR's real timestamps, the
  shipped inline block from all three consumers executed directly across the
  whole trust matrix, and the producer script executed against its refusal
  matrix (it mints exactly what the consumers accept, and refuses malformed
  inputs, a disabled policy, a non-default dispatch ref, a stale or malformed
  head, a closed PR, missing or untrusted quota evidence, declared unresolved
  P1/P2, a non-passed validation, a genuine Codex result on the head, an
  unresolved Codex thread whether or not it is outdated, and a review thread
  too long to read in one page). `bash scripts/validate.sh` green — every tracked YAML parses,
  all synced source/`.github` mirrors byte-identical, all 59 `github-script`
  bodies expression-safe and syntax-checked; `git diff --check` clean.
  Real GitHub Actions validation: `actionlint` 1.7.7 reports zero findings
  across every workflow, including the new producer.
- Two defects were caught and fixed during self-review: the gate's reworded
  pending check title would have broken the watchdog's exact `PENDING_TITLE`
  match (title restored, and a test now pins the two together), and the pure
  mirror did not short-circuit fallback evaluation on a current-head Codex
  signal the way the inline block does, so a stale attestation could have
  blocked a Codex-reviewed head in the mirror only.
- The independent Opus review raised no P1 and six P2s, all fixed: an outdated
  (not resolved) Codex P1/P2 could be cleared by a fallback — the producer now
  refuses while any trusted Codex thread is unresolved, outdated or not; the
  three consumers fed the byte-identical block three different evidence sets —
  a shared `collectReviewEvidenceInputs` collector now builds them, and a test
  drives all three shipped blocks over a fixture matrix; attestation runs that
  were queued or had refused to attest still authenticated, and an edited
  comment body still passed — the run must now be completed+successful, the
  window is bounded at both ends, an unknown default branch fails closed, and
  an edited attestation is rejected; the "Gate and Merge Bot agree" test called
  one pure function twice and was vacuous — it now compares the three shipped
  inline blocks; the mandated precedence and the PR #103 regression were proven
  only against the mirror — both are now also proven against the shipped gate
  path, with the gate's inline `decideCodexGate` pinned equivalent to the tested
  module; and the mirror's signature and Route B timing semantics now match the
  inline copy. Nits fixed too: a quota notice carrying a P1/P2 no longer opens
  an episode, a review thread too long to read in one page fails closed, the
  success summary no longer reports a Codex-sounding reason for a Claude
  review, and Merge Bot paginates each PR once instead of three times.
- A second independent Opus pass verified those fixes by mutation testing on a
  scratch copy and found three more P2s, all fixed: producer-side enforcement of
  the outdated-thread rule was NOT sufficient (a resolved thread can be
  re-opened, and a late Codex finding can arrive already-outdated, both without
  a new commit), so the rule is now enforced on every evaluation by Gate, Merge
  Bot and the watchdog; the run-authentication hardening and the wiring that
  consumes the decision were both untested — deleting either left the suite
  green. Ten mutations that previously survived, including
  `currentHeadSignal: true` (which would have greened every PR) and disabling
  Merge Bot's three evidence guards, are now all killed by the suite; that was
  re-verified locally on a scratch copy with the real tree untouched.
- A third pass confirmed by execution that both post-mint attack sequences are
  blocked end to end and that the watchdog rewrite does not repeat dispatches,
  and found two coverage regressions rather than live holes: the previous
  commit had silently deleted the producer's test harness (every producer
  precondition could be removed with the suite green, and the truncated-thread
  guard has no consumer counterpart), and the two new outdated-thread helpers
  shipped untested one `!` away from their sibling. Both are fixed: the harness
  is restored and extended, and the helpers are now executed directly over
  resolved/outdated/author/severity shapes and a two-page cursor. Ten further
  mutations — including the copy-paste `!` slip and every producer precondition
  — are now killed in clean isolation. The dead `attestedAt` field was dropped,
  the severity-carrying-notice classification is asserted, and the watchdog's
  pending-verdict dispatch is bounded by verdict age rather than ordering, so
  neither permanent suppression nor per-tick re-dispatch is possible. The same
  pass also confirmed the Route A no-TTL decision is correct and withdrew that
  suggestion.
- Real consumer scenario, read-only, no mutation: the shipped inline block was
  run against OptionsProfitTracker PR #19's actual comment history. It found
  exactly the four genuine `chatgpt-codex-connector[bot]` usage-limit notices
  (2026-09-07 ×2, 2026-09-09 ×2) and zero real Codex activity, and returned
  `no_attestation` as it stands. Given a hypothetical valid exact-head
  attestation it returns `stale_quota_evidence`, because every notice predates
  the current head `074de86e…` (pushed 2026-09-14T19:45:26Z) and the Route B
  window is 24 h. Adding a current-head notice flips it to
  `structured_fallback_clean`. That is the contract behaving exactly as
  specified on real data.
- NOT validated in production: `pull_request_target` loads Codex Gate from the
  base branch, so the gate run on this PR executed main's OLD code. The new
  gate/merge-bot/watchdog paths take effect only after merge; no production
  fallback attestation has been minted or honoured yet.
- Review provider for this change: `review_provider = claude_code_fallback`,
  `reason = codex_quota_unavailable` — an independent Opus reviewer. Codex
  posted a genuine usage-limit notice on this PR at 2026-09-15T12:49:40Z, so
  normal Codex review is unavailable. The new central mechanism is NOT claimed
  as authoritative for its own PR: it did not exist before it, and
  automation-core has not set `CLAUDE_FALLBACK_REVIEW_ENABLED`.
- Needs from the owner: merge, then set `CLAUDE_FALLBACK_REVIEW_ENABLED=true` on
  each repository that should honour fallback evidence (Actions variables are
  not synced, so the Codex-only contract stays in force until it is set).
- Next: normal sync delivers the new workflow to consumers, including
  OptionsProfitTracker. OPT PR #19 still needs current-head quota evidence plus
  a fresh exact-head fallback review, or a normal Codex review, before it can
  pass — its existing notices all predate its current head.

## [2026-08-13 UTC] Reject delayed old-head task results
- Production trigger: paywall-bot PR #97 head `29b7c16d29749ba35b371a6a17068b4ee6746e0c` was pushed at 13:39 UTC. A Codex task summary initiated on the prior head arrived at 13:40 and the timestamp fallback treated it as current-head review, allowing merge `0c4ae03fdbc7c7bf79b41c4fb31dd19db0c10e10` before the actual current-head Codex review at 13:41.
- Correction: Gate, Merge Bot, Watchdog, bridge, and backup fixer reject task summaries and timing-only result binding. Review/result surfaces use immutable `commit_id`/`original_commit_id`, explicit `Reviewed commit`, or trusted `ai-loop` head markers where applicable. Reaction-only clean remains supported only when authenticated Gate marker history proves the PR has had exactly one observed head; after a transition, commit-bearing evidence is mandatory.
- Reaction-history API failures are fail-closed: history is queried only when a trusted clean reaction exists, lookup errors make that reaction non-binding, and the normal immutable-signal/thread decision continues instead of reaching the Gate's broad technical fail-soft handler.
- Containment: automation-core Merge Bot was disabled while the forward fix was prepared. Re-enable it only after this PR is exact-head CI/review/Gate green so it can perform the normal SHA-pinned merge; then complete the downstream sync.

## [2026-08-13 UTC] Emergency Gate repair, provenance hardening, and paywall rollout
- Emergency bootstrap: PR #40, merge `fd16f6ad875726386f4f7c029993639cafebaa01`.
- Root cause: direct `${{ ... }}` interpolation inside a roughly 25 KB `actions/github-script` scalar exceeded GitHub's 21,000-character expression ceiling after template expansion. Inputs now travel through `env`; final review expanded deterministic validation to all tracked workflow YAML and rejects every direct expression inside `github-script` bodies, including quoted/type-injectable forms.
- Spam repair: Gate/update-branch/backup dispatch failures use durable trusted markers keyed by repository, PR, exact head, operation, and normalized error fingerprint. First material failure alerts once; identical scheduled repeats log without another Telegram; a new head or error class can alert once.
- CI Doctor: internal automation is identified by authoritative workflow path as well as display name. Issue #39 was closed only after the repaired Gate was production-verified; no equivalent Issue reappeared.
- PR #38: the old head was accidentally auto-merged as `cdf4c94528fdfd81ab00742c549355912355bcc1` after the old Gate accepted a Codex quota notice. Forward security PR #41 merged as `dd9a9de615eb0613e314b26e989d82375c808e66`; reviewed follow-ups #42-#51 completed credential isolation, authenticated provenance/head epochs, real-delivery activation, fail-closed label races, and complete finding context.
- Production proof: Gate dispatch `31681859499` parsed and succeeded. Scheduled Watchdog runs `31687590924` and `31692340712` succeeded without the former expression/dispatch/Telegram error. Codex review quota was available for the forward fixes.
- Downstream: normal sync continuously updated existing paywall-bot PR #94. Its final head `5d65f205708435aab09ce03ace5880c30b342293` contained only the seven byte-identical synced workflows, passed full CI, clean exact-head Codex review, zero unresolved threads, and green Gate. Re-enabled Merge Bot normally auto-merged it as `2575f0f2b16c12ebb9b9173e8c9a8248ab529ebe`.
- Current state: automation-core and paywall-bot Claude Fixer, Codex Gate, Watchdog, and Merge Bot are enabled. No owner merge, `codex-p1-acknowledged`, force push, or application/state change was used.

## [2026-08-11 UTC] Reconcile gate drift and make exact-head-green owner PRs hands-off
- PR: current `agent/owner-green-automerge` change; exact PR/merge SHA is recorded by GitHub and agent-memory after bootstrap validation.
- Branch: `agent/owner-green-automerge`
- Status: bootstrap validation/rollout in progress at authoring time.
- What changed:
  - Closed paywall-bot PR #89 unmerged and deleted only its verified stale sync branch; the obsolete PR was not salvaged.
  - Ported paywall-bot's current reviewed Codex Gate and watchdog hardening into automation-core source/mirrors before changing merge policy, closing the eight active trusted P1 findings still attached to #89's obsolete versions.
  - Added default candidacy for open non-draft same-repository PRs authored by `funzi7`, permanent `no-automerge`, transient `needs-owner-auto`, legacy label-event provenance checks, owner-only protected-path continuation after the full gate, direct active-thread defense, and per-PR failure isolation.
  - Preserved latest-per-context checks, exact-head gate existence/success, affirmative mergeability, SHA-pinned squash, same-repo post-merge branch deletion, PAT-authored downstream triggering, and fail-closed fork handling.
- Validation: tracked workflow YAML, source/mirror parity, every changed github-script block with `node --check`, 43 deterministic Node policy tests plus static writer guards, `git diff --check`; actionlint is run when installed.
- Needs from the owner: nothing if exact-head GitHub CI/trusted review/gate completes green; the task authorizes the one-time bootstrap merge and fresh downstream sync rollout.
- Next: merge only the exact reviewed central head, run the normal paywall-bot sync, and prove the fresh exact-head-green sync closes itself without owner intervention.

## [2026-07-09 09:18 UTC] Fix paywall-bot PR #73 Codex P2 upstream
- PR: direct commit to automation-core `main`; downstream evidence from `funzi7/paywall-bot` PR #73, Codex P2 "Skip patch download after agent failure".
- Branch: main
- Status: done upstream; downstream sync still needed
- What changed:
  - Fixed `codex-backup-fix.yml` upstream so `codex_agent_failed` no longer enters the normal patch download/apply path.
  - Kept `apply-and-push` broad enough for marker-only terminal paths and normal patch application, but added a `normal_patch_path` gate based on `proceed == 'true'`, no fork skip, no agent failure, and successful patch artifact readiness.
  - Gated PR-head resolve, checkout, `codex-patch` download, apply/push, `pushed`, `no_change`, `patch_failed`, and stale-note steps on the normal patch path. After agent failure, only the intended Codex `api_error` marker path runs.
  - Updated both mirrored workflow copies byte-identically: `workflows/codex-backup-fix.yml` and `.github/workflows/codex-backup-fix.yml`.
- Validation: recorded in `/root/work/agent-memory/automation-core/cc-latest.md` for this commit. Local writes and `git pull --ff-only` were blocked by the workspace `bwrap` error, so remote GitHub API readback was used for changed-file validation.
- Needs from the owner: refresh/sync paywall-bot PR #73 from automation-core, then re-check PR #73 and do not merge it until the refreshed sync includes this fix and Codex Gate is green.
- Files intentionally not changed: paywall-bot and all downstream repos; workflow logic outside `codex-backup-fix.yml`; browser/UI automation; force-push behavior.

## [2026-07-07 18:45 UTC] Post-fix #27 final documentation normalization
- PR: direct commit to main (documentation/state/handoff only)
- Branch: main
- Status: done
- What changed:
  - Normalized `LOOP_STATE.md`, `handoffs/CONTEXT.md`, and this handoff around the current delivery-judged ladder: Codex auto-review -> Claude -> Codex API only when `CODEX_BACKUP_ENABLED == 'true'` -> Codex Cloud unless `CODEX_CLOUD_ENABLED == 'false'` -> Claude proxy after genuine Claude `no_delivery` only when it can deliver to the original PR head -> `needs-owner` -> Codex Gate -> Merge Bot.
  - Removed or marked as HISTORICAL/SUPERSEDED stale current-tense claims about old snapshots, onboarding PR merge state, P1-focused bridge scope, Anthropic credit being available, Claude being the only live autonomous fixer, disabled backup causing first-timeout escalation, Claude proxy delivery being live-verified, and prior escalation-label naming.
  - Reconciled Codex Cloud wording: View task, task diff, ready diff, Created commit wording, Cloud-side commit hints, and secondary PRs are not delivery unless a real commit reaches the actual relevant PR head after that stage's request marker. No supported automatic Update branch action or fake API/browser workaround is documented.
  - Preserved useful incident history as historical context instead of current runbook text.
- Code facts re-verified from workflow files before documenting:
  - `CLAUDE_ENABLED != 'false'` is default ON; public-repo Claude comment triggers require an owner-authored comment; fork PRs are not run with writable credentials or secrets.
  - `CODEX_BACKUP_ENABLED === 'true'` is required for Codex API backup; default is OFF; a disabled backup stage is skipped rather than escalated.
  - `CODEX_CLOUD_ENABLED !== 'false'` is default ON unless explicitly disabled.
  - Trusted Codex identity is exactly `chatgpt-codex-connector[bot]`, with no substring or regex matcher.
  - Bridge/gate severity currently supports P1 + P2 for actionable findings.
- Runtime checks still blocked:
  - Claude PR-head delivery from fix #27 is implemented but runtime-unverified because recent Claude runs return Anthropic `billing_error`.
  - Claude proxy remains runtime-unverified for the same budget reason.
  - Codex API backup remains runtime-unverified while OpenAI API quota is unavailable.
  - Downstream secrets, variables, permissions, and current workflow runtime health were not audited in this task.
- Exact next Claude live-test requirement: create one harmless same-repo PR with an active P1 or P2 finding; trigger `@claude fix`; verify a real commit reaches the original PR head branch after the Claude marker; verify no secondary branch or PR; verify the watchdog recognizes delivery; verify no `no_delivery` marker is left after the successful push.
- Validation: documentation structure reviewed; stale current-tense claims were normalized in the edited docs; `git diff --check` was run and exited clean on the local worktree. Local `git pull --ff-only` and local file writes were blocked by the workspace write-sandbox error `bwrap: fchdir to oldroot: No such file or directory`, so remote readback of the GitHub connector updates was used for Markdown and stale-claim review.
- Needs from the owner: Anthropic credit for Claude live verification; OpenAI quota for Codex API backup verification; downstream repo sync/secrets/variables audit.
- Files changed in automation-core: `LOOP_STATE.md`, `handoffs/CONTEXT.md`, `handoffs/loop-build.md`.
- Files intentionally not changed: `workflows/`, `.github/workflows/`, `sync-config.json`, downstream repositories, and workflow logic.
- Explicit guardrails observed: no workflow logic changed; no downstream repository changed; no force push; no browser, Playwright, session-cookie, UI automation, or fake Codex Cloud Update-branch implementation was used.

## HISTORICAL/SUPERSEDED Incident Summary
- 2026-07-07 first documentation reconciliation after fix #27: corrected major top-level contradictions but left older chronological entries that could still read as current. This entry supersedes that residual ambiguity; the authoritative current architecture is now in `LOOP_STATE.md` and `handoffs/CONTEXT.md`.
- 2026-07-07 fix #27: implemented original-PR-head Claude delivery, default-on Codex Cloud switch, strict Codex identity matching, terminal Codex API states, and issue-vs-PR Claude routing. Runtime verification of the Claude delivery path was blocked by Anthropic billing failure.
- 2026-06 incidents: onboarding/sync, severity bridge, backup-fix, gate, and watchdog iterations produced useful lessons, but their old references to merge state, P1-focused scope, disabled-backup escalation, or prior escalation-label naming are historical only. Current code supports P1 + P2, uses only `needs-owner` for escalation, skips disabled Codex API backup, and treats delivery strictly as a real commit on the relevant head branch.
- Historical downstream state: OptionsProfitTracker PR #12 and thai-rent-finder PR #80 are now merged. Do not use older entries that imply those onboarding PRs still need merge action.
- Historical runtime claims: any older wording implying Claude proxy delivery, Claude PR-head delivery, or Codex API backup is proven in live runtime is superseded. Current state is implemented but runtime-unverified until budget/quota permits live tests.
