# LOOP_STATE.md — Self-Healing Loop: project state

> Source of truth for the autonomous CI self-healing loop across @funzi7's repos.
> Update this file on every significant change. Do not store a moving `main @ sha`
> snapshot in this header; authoritative code and documentation bases are named below.

**Resume in a new chat:** _"Read LOOP_STATE.md in funzi7/automation-core to see where the self-healing loop project stands, then continue."_

> Canonical full briefing: [`handoffs/CONTEXT.md`](handoffs/CONTEXT.md). This file is the concise per-workflow state reference.

---

## Current Snapshot addendum (Codex Gate fail-closed enforcement, 2026-11-08)

Investigation of the paywall-bot Codex Gate "failures" seen during the
Telegraph token fix (PR #120 run `42477092393`, PR #122 run `42485718581`)
found three distinct things, none of which was an unreviewed merge:

1. **Expected WAITING state.** Each failed `pull_request_target` run fired
   seconds after the push, before Codex had reviewed, and published
   `check-codex-status` = `🟡 Waiting for Codex review` (conclusion `failure`)
   while application CI was green. Codex then posted a `codex-review-receipt`
   comment with `**Reviewed commit:**` naming the exact head within 1–3
   minutes (#120 `23eac35` at 11:47:14Z, #121 `68985bc` at 12:49:00Z, #122
   `fcd6263` at 13:36:47Z), the `issue_comment` gate run republished
   `🟢 Reviewed — clear` on that exact head, and Merge Bot merged with the
   SHA-pinned squash (merged_by is `funzi7` because Merge Bot uses
   `AUTOMATION_PAT`). PR #120's three Codex P2 threads were all resolved before
   its final head; no P1/P2 was active at any merge.
2. **Real permission defect (universal).** The warning `trusted head marker
   publish failed ... Resource not accessible by integration` appears on every
   `pull_request_target` gate run in paywall-bot AND automation-core (PR #58,
   all day). The gate declared `issues: write` but `pull-requests: read`; the
   `codex-head-epoch:v3` marker is a comment on a pull request. Zero markers
   exist on any PR in either repository since the mechanism shipped
   (2026-08-13), so the authenticated head-epoch model never engaged. The
   consequence was fail-closed everywhere (reaction-only clean, sync grace and
   fallback episodes all stayed pending), never a false green. The canonical
   fallback producer `claude-fallback-review.yml` carried the identical defect,
   so no fallback attestation could ever have been minted.
3. **Fail-open on technical errors.** The gate's exception branch published a
   GREEN `check-codex-status` ("Technical fail-soft"). It never fired in the
   observed runs, but it converted any API error into an approval signal.

Fix (this branch, source of truth `workflows/`): `pull-requests: write` on the
gate and the producer; technical errors publish `failure` titled
`🟠 Gate evaluation error — fail-closed` (watchdog treats it like pending; the
pure mirror returns `pending`/`technical_error_fail_closed`); Codex's structured
`codex-review-state:v1` completed marker (full 40-char `commit_sha`) counts as
exact-head evidence alongside `commit_id`/`Reviewed commit`; review threads
with more than 100 comments fail closed (`review_thread_truncated`); the
canonical evidence block closes quota episodes on timestamp ties, bounds Route A
by the attestation time, binds attestations to the current head epoch, keeps
scanning past inactive candidates, tolerates an `@ref` suffix on the producer
run path, and the producer counts Codex reactions as activity. Regression tests
drive the SHIPPED gate script end to end (`tests/test_codex_gate_workflow.js`)
through the 2026-11-08 incident shape: marker 403, missing marker + reaction,
late previous-head review, active P1/P2, technical error.

Downstream fact: paywall-bot's `codex-gate.yml`, `merge-bot.yml` and
`claude-fallback-watchdog.yml` on `main` are NOT automation-core copies — a
paywall-bot feature commit (`b07344f4`, 2026-09-05) modified them locally
(summary-row reaction binding) and they predate PR #56. The official sync PR
paywall-bot #107 (open since 2026-10-02) is blocked by Codex findings against
the synced gate code (addressed here) and by paywall-bot's own
`tests/test_codex_gate_logic.js` asserting the local patch. See the Open TODO.

## Current Snapshot (emergency gate recovery, updated 2026-08-13)

Emergency bootstrap PR #40 repaired the GitHub-unparseable Codex Gate and was
squash-merged as `fd16f6ad875726386f4f7c029993639cafebaa01`. The root cause was
direct `${{ ... }}` interpolation inside a roughly 25 KB `github-script`
scalar, which crossed GitHub's 21,000-character expression ceiling after
template expansion. Large scripts now receive values through `env`, and the
validation suite rejects direct expression interpolation in large script
scalars. Watchdog dispatch/update/backup failures now alert once per exact
repository/PR/head/operation/normalized-error marker instead of once per tick.
CI Doctor identifies internal workflows by authoritative path as well as name.

The first repaired Gate dispatch succeeded, but exposed an independent safety
bug: the old Gate treated Codex's usage-limit comment as an affirmative review
signal and Merge Bot auto-merged PR #38 at
`cdf4c94528fdfd81ab00742c549355912355bcc1`. Forward security PR #41 was then
exact-head reviewed and normally auto-merged as
`dd9a9de615eb0613e314b26e989d82375c808e66`; follow-up reviewed corrections
#42-#51 completed the provenance, head-epoch, delivery, label-race, backup
context, and fixer-digest design. Current automation-core main is the source
of truth. Claude Fixer, Codex Gate, Watchdog, and Merge Bot are enabled.

Production verification: Gate dispatch `31681859499` parsed and succeeded;
Watchdog schedule runs `31687590924` and `31692340712` both completed without
the expression parse failure, gate-dispatch failure, or runtime Telegram error.
Issue #39 was factually closed after repair and CI Doctor did not recreate it.
Paywall-bot sync PR #94 received the final seven byte-identical workflows,
green application CI, a clean exact-head Codex review and Gate, and was normally
auto-merged by Merge Bot as `2575f0f2b16c12ebb9b9173e8c9a8248ab529ebe`.

Later expression-safety PR #52 normally auto-merged as
`961b51d9ff23edd215ff026d8dc0845f9a8124a9`, and downstream sync PR #96 normally
auto-merged as `cb5cc5d87f335963e1f80db54de11fe706e3f6de`. Paywall documentation PR #97
then exposed another exact-head race: a Codex task summary started on the old
head arrived after a new push and the Gate accepted its later timestamp as a
review of the new head, merging PR #97 before that head's review completed.
The current correction rejects task summaries and timing-only signals. A clean
reaction is accepted only when authenticated Gate markers prove the PR has had
one observed head; after any transition, commit-bearing review/result evidence
is mandatory.

Code architecture base: fix #27 plus the Codex backup hardening and the
2026-08-11 reconciliation of paywall-bot's reviewed Codex Gate/watchdog fixes
back into the central workflow source.

Documentation base: final post-fix #27 normalization commit `11ba6a6bf13c91b1be61d4292b853dd15c37063b`, plus this upstream fix record.

Runtime status: paywall-bot PR #93 proved the old failure mode, and stale sync
PR #89 was closed unmerged with its branch deleted. PR #94 delivered the
provenance/security rollout; PR #96 delivered the final expression transport
hardening after exact-head CI/review/Gate and normal Merge Bot auto-merge. PR
#97 then exposed the delayed old-head task-result race described above. The
current central fix must be normally reviewed/merged and synced once more.

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
3. **Downstream audit:** paywall-bot PR #94 is merged with the seven current
   workflows and its four loop workflows were observed active; OPT PR #12 and
   TRF PR #80 are merged. Secrets, variables, Actions permissions, and broader
   runtime health remain unverified for paywall-bot and every other downstream.
   For downstreams other than paywall-bot, workflow-sync state is also
   unverified until checked from each repository's latest sync PR and current
   workflow contents.
4. **Codex Cloud limitation:** View task, task diff, Created commit hint, or ready diff is not delivery unless the PR branch gets a newer commit after the Cloud marker. No browser/UI automation or fake Update branch API workaround exists.
5. **Canonical Claude fallback review evidence — merged; rollout pending.**
   The central contract is implemented and deterministically covered in
   automation-core (see `docs/adr/0001-canonical-review-evidence.md`).
   (a) DONE 2026-09-15T14:03:30Z: PR #56 was merged into `main` as
   `15652f663ccf31fac3c03651a5a7b56758257de4`. Still physically pending as
   checked on 2026-11-07: (b) no consumer default branch carries
   `claude-fallback-review.yml` yet — paywall-bot, OptionsProfitTracker,
   thai-rent-finder and agent-memory all return 404 for it, while sync PRs
   paywall-bot #107 (2026-10-02), OptionsProfitTracker #20 (2026-09-22) and
   thai-rent-finder #92 (2026-08-12) are open and unmerged; (c) no repository
   has set `CLAUDE_FALLBACK_REVIEW_ENABLED` (variables seen: paywall-bot
   `CLAUDE_SHOW_FULL_OUTPUT`, `CODEX_CLOUD_ENABLED`; thai-rent-finder
   `CLAUDE_SHOW_FULL_OUTPUT`; OptionsProfitTracker and agent-memory none), so
   every repo keeps the Codex-only contract unchanged. No production fallback
   attestation has been minted or honoured yet, and the new gate/merge-bot/
   watchdog paths have not been exercised in production.
6. **OptionsProfitTracker PR #19 — not yet passable.** Its trusted quota notices
   (2026-09-07 and 2026-09-09) all predate its current head
   `074de86e52f2a168b89dc21ff32a851570f1b144`, pushed 2026-09-14T19:45:26Z, and
   the PR carries `no-automerge` plus `needs-owner`. Under the canonical rules
   the Route B window has long expired, so a pass requires either a current
   Codex quota notice on this head followed by a fresh exact-head fallback
   review and attestation, or a normal Codex review once quota returns. Do not
   claim it passes before that evidence exists.
7. **Longer-term:** update minutes-guard target coverage after downstream audit; keep direct-to-main and branch-protection decisions explicit.
8. **Codex Gate fail-closed enforcement (2026-11-08) — PR #59 merged to `main`
   (`15e44e6`, 2026-11-08); first post-merge marker publish OBSERVED
   2026-11-09 02:20Z.** On PR #58's first push after the merge, the
   `pull_request_target` gate run `42550382183` logged `PR #58: indexed trusted
   head epoch run 42550382183/1` and left the `github-actions[bot]`
   `<!-- codex-head-epoch:v3 run=42550382183 attempt=1 pr=58 head=33c0dda… -->`
   comment on the PR at 02:20:32Z — no `Resource not accessible by
   integration` any more; the `🟡` pre-review verdict followed as designed. The
   `🟠` technical-error verdict was not induced and stays covered by the
   end-to-end tests only. Branch `claude/codex-gate-fail-closed`,
   <https://github.com/funzi7/automation-core/pull/59>. Physically verified:
   the root cause (403 on the PR-comment marker in both repositories; zero
   markers ever written) and the legitimacy of the three paywall-bot merges;
   the full local suite and CI on the PR head. NOT physically verifiable
   before merge: `pull_request_target` loads the gate from the default branch,
   so the first marker publish and the first real `🟠` error verdict can only
   be observed after this PR merges to `main`. First post-merge checks: a
   `pull_request_target` gate run logs `indexed trusted head epoch run` and a
   `<!-- codex-head-epoch:v3 ... -->` comment by `github-actions[bot]` appears
   on the PR; `tests/test_workflow_permissions.js` stays green. Then the daily
   sync refreshes paywall-bot #107 (Codex must re-review the new sync head;
   paywall-bot's local `tests/test_codex_gate_logic.js` summary-binding
   assertions must be updated in paywall-bot itself — the synced gate now binds
   through the connector's structured `codex-review-state:v1` marker instead of
   the local summary-row heuristic). If a marker publish still fails after
   merge, the remaining suspects are repository Actions settings (both repos
   currently report `default_workflow_permissions: write`), not workflow YAML.
   **Merge Bot cannot merge PR #59 by design** (dry-run of the policy mirror
   `tools/merge_bot_logic.js` against the live PR, 2026-11-08 21:45Z): without
   `automerge` the `claude/*` branch is `not_candidate`; with `automerge`, a
   green gate and exact-head Codex evidence it is `protected_path_untrusted`,
   because the PR touches `workflows/**` and `.github/workflows/**` and a
   `claude/*` branch carries Claude provenance — such PRs require a human
   merge (adding `automerge` would only escalate it to `needs-owner`). Owner
   action: `gh pr merge 59 --squash --repo funzi7/automation-core` once
   satisfied with the review state. Review state at 21:47Z: Codex reviewed the
   exact head `5491701` on request (`@codex review` 21:44:50Z) — receipt
   "Didn't find any major issues" with `**Reviewed commit:** 5491701be5`
   (21:46:39Z), review-state marker `completed` for `5491701…` with
   `has_any_findings=false`, 👍 (21:46:43Z), no review threads; the gate
   published `🟢 Reviewed — clear` (`current_head_signal_no_active_findings`)
   at 21:46:52Z and CI `validate-automation-core` is green on the head. Review
   and required checks are genuinely satisfied; only the human merge remains.
   Independently of policy, **Merge Bot is non-functional in automation-core**:
   both runs woken by this PR's green gate (`42526903520`, `42526913653`) — and
   every Merge Bot run since 2026-09-11 — fail with `Unhandled error: HttpError:
   Bad credentials` (401) on the first `AUTOMATION_PAT` call; see item 9.
9. **`AUTOMATION_PAT` rejected in automation-core since 2026-09-11 — owner
   action.** Merge Bot, Claude Fallback Watchdog and CI Doctor in THIS
   repository fail every run with `HttpError: Bad credentials` (401): last
   Merge Bot success 2026-09-08 13:40Z, failures from 2026-09-11 00:27Z through
   today; watchdog and CI Doctor scheduled runs on 2026-11-07/08 show the same
   error. The secret exists but GitHub rejects it (expired or revoked
   fine-grained PAT). paywall-bot's own `AUTOMATION_PAT` works (its Merge Bot
   merged #120–#122 on 2026-11-08). Owner: regenerate the fine-grained PAT
   (Contents/PRs/Issues write, Metadata read) and update the automation-core
   secret, then confirm one green Merge Bot and Watchdog run. Design note: the
   fail-soft check only tests that the secret is non-empty, so an invalid PAT
   crashes the job instead of exiting green or alerting — a loud, deduplicated
   `Bad credentials` preflight (with the Telegram escalation) is a future
   hardening item and is deliberately NOT part of PR #59.
10. **oauto (read-only OpenCode reviewer launcher) — installed, PR #58 pending
    (conflicts with `main` resolved 2026-11-09).** The launcher, its policy
    module, tests and docs live under `launchers/` on branch
    `claude/oauto-opencode-reviewer` (ADR 0002). Validated on the device against
    OpenCode 2.2.6 with disposable fixture repositories (see the 2026-11-08 and
    2026-11-09 `handoffs/loop-build.md` entries for the full record). Codex's
    first review (commit `d17f3a1`) found three P1s in the git preflight —
    repository-configured textconv/external-diff helpers executed,
    special-character filenames escaped the secret exclusion, rename detection
    hid a renamed secret's source — all fixed on the PR branch with regression
    tests ("Codex P1 round" entry). 2026-11-09 round: the owner's GLM
    whole-repository audit (run through `oauto` itself on 2026-11-08) was
    verified finding by finding; three real gaps were fixed with reproduce-first
    regression tests — a hard link whose other name lies outside the repository
    was undetectable (now refused unconditionally when `st_nlink` exceeds the
    names the scan sees), a linked worktree's git dir and commondir skipped the
    symlinked-config refusal and the hard-link alias registration (now walked
    under the `.git` rules), Composer `auth.json` and other common credential
    files were missing from the pattern list (added on all four controls) — the
    policy ceiling OpenCode loads is now verified at every launch (`debug
    config` document `policies` + `permissions` loaded verbatim, 62 + 44 probes
    on the real binary), and the claimed backslash glob escape was shown NOT
    reproducible on the real binary (ripgrep `--glob` filter rooted at the tool
    path, which `external_directory` gates) — no rule added. An independent
    Opus review of that round found one pre-existing P2 — a crafted `.git`
    file (`gitdir: <other repo>/.git`) pointed the preflight at another local
    repository, whose content then reached the prompt — fixed with
    `check-repo-git` (refuses a `.git` pointer this worktree does not own
    before any git command runs), plus six P3s fixed (git-exact pointer
    parsing, verbatim rule arrays, exact-name denial of case-variant secret
    files under the override, object-store hard-link accounting, secret-named
    git-dir aliases, walk errors failing closed). Codex's review of the pushed
    head `33c0dda` added one P1 of the same class — a real `.git` directory
    carrying a `commondir` file naming another repository — fixed in `5860e1f`
    (refused before any git command; a submodule git dir is accepted only
    without one); its review of the next head `0ca1844` added a P1 in the
    include-history traversal — a committed symlink among deleted included
    configs was read as text instead of followed, so its target's removed
    credential travelled — fixed in `afd4639` (`resolve-link`: the target is
    excluded and followed within the same revision); its review of `2c743cf`
    added a P1 in that resolver — an absolute target inside the repository was
    treated as outside — fixed in `62fca59`, which also resolves a committed
    directory symlink on an include path (the last documented gap of this
    class; only a never-committed, deleted directory link stays unresolvable).
    `main` (PR #59) was merged into the branch (`01f6840`). The Codex review, CI and Codex Gate state of the
    pushed head are recorded in `agent-memory/automation-core/cc-latest.md`.
    DONE by the owner on 2026-11-08: the Termux hop (`oauto <repo>` from a real
    Termux shell) and a review of a real project repository (the GLM audit).
    Physically pending: the PR merge, a full DeepSeek TUI session, and an owner
    decision on listing `oauto` in `DEVELOPMENT_RULES_FULL` §7. Any OpenCode
    upgrade re-opens validation: the launcher refuses every version other than
    2.2.6.
11. **Future backlog recorded from the GLM audit (verified, deliberately NOT in
    PR #58):** pin the third-party actions `peter-evans/create-pull-request@v6`,
    `anthropics/claude-code-action@v1` and `openai/codex-action@v1` (and the
    `actions/*` major tags) to commit SHAs with provenance comments — two of them
    run with `AUTOMATION_PAT` / `ANTHROPIC_API_KEY` in scope; make
    `scripts/validate.sh` glob `*.yml *.yaml` like `validate_github_scripts.py`
    (no tracked `.yaml` exists today, so nothing is skipped yet); let
    `ai-launch` take the oauto alias set from `oauto-policy approved` instead of
    duplicating `glm|deepseek`; optionally add a `*\*` glob deny as defence in
    depth (not exploitable on OpenCode 2.2.6, see the 2026-11-09 handoff entry);
    a probe test that `git config --list --show-origin -z` still yields a
    non-empty include set on a repository with includes (format-drift guard).

Older items below are history. If they conflict with this section, treat them as HISTORICAL or SUPERSEDED and follow this section.

## Workflows

Synced workflows listed in `sync-config.json`: `codex-auto-fix.yml`, `codex-gate.yml`, `claude.yml`, `ci-doctor.yml`, `merge-bot.yml`, `claude-fallback-watchdog.yml`, `codex-backup-fix.yml`, `claude-fallback-review.yml`.

### `claude-fallback-review.yml` — Claude Fallback Review Attestation

- The ONLY sanctioned producer of structured Claude Code fallback review
  evidence. `workflow_dispatch` only, so GitHub restricts it to actors with
  write access; it checks out nothing.
- Refuses unless `CLAUDE_FALLBACK_REVIEW_ENABLED == 'true'`, unless dispatched
  from the default branch, unless `reviewed_head` is the live PR head, unless a
  trusted Codex code-review quota notice exists, if Codex already has a genuine
  result on that head, or if any trusted Codex P1/P2 is still active.
- Derives `verdict` itself; `unresolved_p1`/`unresolved_p2` must both be 0 and
  `validation` must be `passed/<reference>`.
- Posts one atomic `claude-fallback-review:v1` marker as `github-actions[bot]`.
- The attestation is necessary, never sufficient: Gate, Merge Bot and the
  watchdog re-authenticate it independently.

### `claude.yml` — Claude Fixer

- Fixes `claude-fix` Issues by creating a new branch/PR with `Fixes #N`.
- Fixes existing same-repo PR comments by resolving the PR via API, checking out the exact original head SHA, attaching the local checkout to the original head branch, and instructing Claude to commit/push only to that branch.
- Fork-headed PR comments are skipped before writable checkout or Claude execution, labeled `needs-owner`, and marked `agent=claude state=fixer_error`.
- Comment-triggered public-repo runs require the owner-authored comment guard: `github.event.comment.user.login == github.repository_owner`.
- `ANTHROPIC_API_KEY` missing is fail-soft. Anthropic credit is currently exhausted in recent runs, so runtime delivery is blocked.
- Issue-mode uses `github.token`, `persist-credentials: false`, signed API commits, and only `Read,Glob,Grep`; a mandatory post-model scrub precedes every PAT-backed trusted step. Existing same-repo PR mode intentionally retains its writable branch credential and broader validation tools.

### `codex-auto-fix.yml` — Bridge + Codex summary archive

- Bridge triggers exactly one `@claude fix` per review wave when trusted Codex reports active P1 or P2. P3 is excluded.
- P1/P2 detection is badge-token based (`P1-orange`, `P2-yellow`) and feedback is bound to the exact head through review `commit_id`, Codex's `Reviewed commit` marker, or an authenticated `ai-loop` head marker.
- The bridge inlines the actual P1/P2 finding text because Claude's run context cannot reliably read inline review threads.
- Sync PRs are suppressed because findings belong upstream in automation-core, not in downstream copied workflow files.
- Circuit breaker: 3 rounds -> `needs-owner` + Telegram if configured.

### `codex-gate.yml` — Codex Gate

- Consumes the shared `CANONICAL EXACT-HEAD REVIEW EVIDENCE` block: exact-head
  review evidence is normal Codex evidence OR an approved Claude fallback
  attestation when Codex is provably unavailable. Findings are still evaluated
  first, so a fallback can never bypass a real Codex P1/P2, and a fallback that
  declares unresolved P1/P2 blocks. The published check states truthful
  provenance and never claims "Codex reviewed" for a Claude review.

- `check-codex-status` is the blocking check.
- Green requires Codex has reviewed the current head and no active P1/P2 remains.
- Usage-limit and capacity notices from the trusted Codex actor are explicitly non-review signals.
- P1 and P2 both block; this must match bridge-trigger severity. Historical P1-only behavior is SUPERSEDED.
- Freshness is never inferred from Git author/committer dates or from a signal timestamp after the observed head transition. Review objects and inline comments bind through immutable `commit_id`/`original_commit_id`; Codex result comments must name the exact `Reviewed commit`. Task summaries and other unmarked result surfaces are not affirmative because old-head asynchronous work can finish after a new push. Reaction-only clean is the narrow exception: it counts only when authenticated Gate marker history proves the PR has never had another observed head. After any head transition, immutable commit-bearing evidence is mandatory.
- Trusted-sync grace-green is limited to zero-Codex-signal sync PRs older than `SYNC_GRACE_MINUTES`.
- The old in-run self-rerun poll is gone; the watchdog sweep handles late Codex signals and override-label dispatches.
- 2026-11-08: the head-epoch marker is a comment on a pull request and needs
  `pull-requests: write` (declared alongside `issues: write`); a missing or
  unverifiable marker is fail-closed, never a clean review. A technical
  evaluation error publishes `failure` titled `🟠 Gate evaluation error —
  fail-closed` (never green); the watchdog treats that title like pending.
  Codex's structured `codex-review-state:v1` marker with `status: completed`
  and a full 40-char `commit_sha` equal to the head is exact-head evidence. A
  review thread whose comments exceed one GraphQL page fails closed
  (`review_thread_truncated`).

### `claude-fallback-watchdog.yml` — Delivery-judged fixer ladder

- The late-signal sweep uses the identical shared block and the same shared
  input collector. An accepted exact-head fallback counts as a review signal, so
  the gate is dispatched while the verdict is still pending and publishes its
  green verdict. The sweep posts no Codex review request and no missing-review
  alert on that path, and once the verdict is green its own `isCandidate` test
  already excludes the head, so it stops rather than re-dispatching every tick.
  A new head invalidates the fallback and re-opens evaluation.

- Current ladder is delivery-only: Claude -> Codex API if enabled -> Codex Cloud unless disabled -> Claude proxy only for genuine Claude `no_delivery` -> `needs-owner`.
- A disabled Codex API backup is skipped, not escalation.
- Codex API `stale` stops the old head cycle; it does not advance that stale cycle to Cloud.
- Claude `billing_error` / `fixer_error` terminally advance without waiting the 20-minute window.
- Codex Cloud ready diff / View task is terminal non-delivery unless a real PR-head commit lands.
- Claude proxy is implemented after Cloud non-delivery only when the original Claude failure was genuine `no_delivery`; it is runtime-unverified after fix #27.
- Dispatch failures before the Codex API agent starts are `dispatch_failed`, retryable, and non-attempt-consuming.
- Gate-dispatch, update-branch, and backup-dispatch errors use durable per-PR/head/operation/error fingerprints: the first material failure alerts, identical scheduled repeats only log, and a new head or error class alerts once again.

### `codex-backup-fix.yml` — Codex API backup

- Dormant by default. The watchdog dispatches it only when `CODEX_BACKUP_ENABLED == 'true'`.
- Requires `OPENAI_API_KEY`, available quota, and write-capable workflow permissions in the target repo.
- Agent job is read-only and gets only `OPENAI_API_KEY`; apply-and-push is the write-capable job.
- Fork PRs are skipped/escalated before agent execution.
- The 2026-07-09 downstream PR #73 P2 fix splits marker-only terminal paths from the normal patch path: after `codex_agent_failed`, apply-and-push posts only the intended `api_error` marker and does not resolve the PR head, check out, download `codex-patch`, apply, push, or emit `no_change`/`patch_failed` from a missing artifact.
- Honest terminal states: `api_error`, `fixer_error`, `no_change`, `patch_failed`, `stale`, and `pushed`. Only a real branch commit after the request marker is delivery.

### `merge-bot.yml` — Merge Bot

- Uses `hasCurrentHeadReviewEvidence`, which wraps the identical shared block,
  so Merge Bot and the Gate cannot disagree. Both the initial and the final
  candidate revalidation go through it, and the merge log records the real
  review authority.

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
  ordinary same-repo owner PR may merge without a second manual merge step;
  PAT-owner Claude PRs carry durable `claude-generated` Actions provenance and
  remain escalated. Issue-mode Claude works only on the action-controlled
  `claude/*` branch and cannot open PRs; a trusted post-step creates the PR from
  the exact branch output, making provenance immediate. Exact trusted sync PRs
  retain their path only without Claude provenance.
- Squash merge is head-SHA-pinned.

### Hub-only workflows

- `bootstrap.yml`: opens onboarding PRs for newly eligible repos; never auto-merges them.
- `telegram-morning-report.yml`: read-only daily digest; no write API calls.
- `minutes-guard.yml`: hub-only Actions-minutes guard. Its target coverage may be stale and needs audit before expansion.

## Device launchers (not synced)

`launchers/ai-launch` is the tracked copy of `/root/work/bin/ai-launch` (`cauto`,
`clauto`, `ai`, plus the `opencode` mode). `launchers/oauto/` is the `oauto <repo>`
read-only OpenCode reviewer: OpenCode 2.2.6 pinned to `opencode/glm-5.3-flash-free`
(default) or `opencode/deepseek-v4.1-flash-free`, read/glob/grep only, every other
tool, provider, model, plugin, MCP server and external directory denied by
`permissions` + `policies` in a private per-launch config directory, verified
before every launch with OpenCode's own diagnostics, one session per repository.
Its git preflight runs no repository-configured helper (no textconv, external
diff, clean/smudge filter, fsmonitor, gpg or hook; `--work-tree` pinned) and
excludes secret-like paths by exact bytes, renames included. The worktree scan
refuses outward symlinks, aliases of denied paths, hard links with a name
outside the repository (or more names than the scan sees), symlinked Git config
files — in `.git` and in the git dir and commondir of a linked worktree — and
secret-like files (Composer `auth.json`, `.pgpass`, `.my.cnf`, `.s3cfg`, `.ppk`,
kubeconfig, Terraform CLI and RubyGems credentials included since 2026-11-09)
unless explicitly overridden; the policy ceiling and permissions OpenCode
reports having loaded are probed before every launch.
Install/refresh with `bash launchers/oauto/install.sh`; contract in
`docs/adr/0002-oauto-read-only-opencode-reviewer.md`.

## Repos Status

| Repo | Status | Notes |
|---|---|---|
| automation-core | loop installed; PAT-backed workflows crashing since 2026-09-11 | Public source of truth and test bed. Codex Gate and CI run normally; Merge Bot, Watchdog and CI Doctor fail every run with `Bad credentials` because the repository's `AUTOMATION_PAT` is rejected (TODO item 9). PRs here are merged by the owner until the secret is rotated. |
| paywall-bot | sync stale and locally diverged; sync PR #107 blocked | PR #96 normally auto-merged as `cb5cc5d87f335963e1f80db54de11fe706e3f6de`. Checked 2026-11-08: `codex-auto-fix.yml` matches the source; `codex-gate.yml`, `merge-bot.yml` and `claude-fallback-watchdog.yml` were modified locally by `b07344f4` (2026-09-05) and predate PR #56; `claude-fallback-review.yml` absent. Sync PR #107 (head `c770aa5`) is red: Codex P1/P2 findings on the synced gate code (addressed in the 2026-11-08 fail-closed work) and the local `tests/test_codex_gate_logic.js` asserting the local patch. The 2026-11-08 Telegraph PRs #120–#122 were legitimately gated (exact-head Codex receipts, no active P1/P2, CI green) despite the marker 403. |
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

## Validation Notes For This Recovery Record And Hardening

- The recovery documentation was reconciled with production evidence.
- Workflow data transport was hardened without changing gate or fixer semantics:
  direct GitHub expressions in every `actions/github-script` body were moved to
  step/job `env`, including `bootstrap.yml` and the source/mirror copies of
  `claude.yml`, `codex-auto-fix.yml`, and `codex-backup-fix.yml`.
- The validator now examines every tracked YAML workflow, rejects any direct
  expression in a `github-script` body, and syntax-checks all extracted scripts.
- The source/mirror workflow pairs remain byte-identical. Paywall-bot received
  the expression-safety version through PR #96; the exact-head race correction
  requires one final normal downstream sync after this change merges.
- No application repository logic was changed.
- No force push, browser automation, Playwright, session-cookie automation, UI automation, or fake Codex Cloud Update-branch implementation was used.
