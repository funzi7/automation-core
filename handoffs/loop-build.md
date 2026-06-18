# loop-build — Claude Code ⇄ Claude Chat handoff log

Handoff log for the **self-healing-loop build** Claude Chat session. Claude Code prepends a summary after each task; Claude Chat reads the latest entry here directly instead of the user pasting it (this repo is public). Newest entry is always at the top.

**Entry template** (prepend a new entry directly under this line — newest first):

```
## [YYYY-MM-DD HH:MM UTC] <task title>
- PR: <link>
- Branch: <name>
- Status: <opened / merged-pending / blocked>
- What changed: <2-4 bullets>
- Validation: <actionlint / parity / node --check / etc>
- Needs from the owner: <merge / secrets / decision / nothing>
- Next: <what should happen after>
```

---

## [2026-06-18 06:15 UTC] morning report: match CI-doctor workflow by path/name so HEALTH isn't falsely green
- PR: #31 (push to existing branch `claude/telegram-morning-report`)
- Branch: claude/telegram-morning-report
- Status: done (pushed to branch)
- What changed: Codex P2 (valid): the morning report identified the health workflow by `/health-check|site-health|ci-doctor/i.test(wf.name)`, but the synced doctor declares `name: CI Doctor` (spaced/capitalized) — the hyphenated `ci-doctor` token never matched it, so `out.ciFailing` stayed empty and the digest could falsely report "⚙️ HEALTH: ✅ all green" while CI was red. Fix: match the CI-doctor / health-check / site-health workflow **by PATH first** (most robust — the file is always `ci-doctor.yml` regardless of display name): `/(?:^|\/)(?:ci-doctor|health-check|site-health)\.ya?ml$/.test(wf.path)`, with a spacing/casing-tolerant name regex `/ci[\s-]?doctor|site[\s-]?health|health[\s-]?check/i` as fallback. When the matched workflow's latest run concluded `failure` it's still pushed into `out.ciFailing`, so HEALTH now correctly surfaces red CI. ONLY the health-detection matcher changed — read-only guarantees, dynamic repo discovery, fail-soft secret handling, and the Telegram composition are untouched. Both copies kept byte-identical.
- Validation: actionlint clean on both copies; `node --check` on the github-script block (async-wrapped); a 10-case matcher self-test passes (catches `CI Doctor` with and without a path, `ci-doctor`, `Site Health`, `Health Check`, `*.yaml`; rejects `Build & Test` / `Merge Bot`); `workflows/` ↔ `.github/workflows/` byte-identical (blob `2f3d63e`); diff is +12/-1 (matcher block only); still read-only (grep finds no write API calls).
- needs-from-owner: merge #31 once green.
- Next: with the matcher fixed, a red CI Doctor run in any repo now shows under ⚙️ HEALTH instead of being hidden by a false all-green.

## [2026-06-18 04:30 UTC] telegram morning report: read-only daily loop digest across all repos
- PR: (opened from `claude/telegram-morning-report`)
- Branch: claude/telegram-morning-report
- Status: opened (awaiting review/merge by the loop)
- What changed: New hub-only workflow `telegram-morning-report.yml` (+ byte-identical `.github/workflows/` mirror) sends a once-daily (05:30 UTC) **read-only** Telegram digest of the self-healing loop across ALL of the owner's repos. Repos are discovered **dynamically** (`listForAuthenticatedUser`, affiliation owner, forks/archived excluded) — no hardcoded list, so new repos appear automatically. Per repo (each wrapped in try/catch so one bad/empty repo can't abort the run): open PRs with each PR's `check-codex-status` gate state (🟢/🔴/⏳/⚪), PRs labeled `needs-owner`, merges in the last 24h, failing health-check/site-health/ci-doctor runs, and disabled/paused workflows. Plus account Actions minutes (billing GET, or n/a). Composes ONE structured HTML message (🔴 NEEDS ATTENTION first → ⏳ OPEN PRs → ✅ MERGED 24h → ⚙️ HEALTH → 📊 MINUTES), splitting at ~3800 chars into multiple sends, and also writes the full report to the Actions run summary. This is the Stage-3 "Telegram control center" read-only digest (informational only — no buttons/actions). It is automation-core-only and is NOT added to sync-config (it reads downstream repos centrally, it doesn't deploy to them).
- Validation: actionlint clean on both copies; node --check on the github-script block; `workflows/` ↔ `.github/workflows/` byte-identical (blob `d2f07e6`); **read-only confirmed** — only `repos.listForAuthenticatedUser` / `pulls.list` / `checks.listForRef` / `actions.listRepoWorkflows` / `actions.listWorkflowRuns` (+ a billing GET and the Telegram POST), ZERO GitHub write calls (no addLabels/merge/createComment/dispatch); fail-soft on every secret (missing AUTOMATION_PAT → exit green; missing Telegram → still log the summary, skip send; billing falls back CROSS_REPO_PAT → AUTOMATION_PAT → n/a); dynamic repo discovery (no hardcoded list).
- needs-from-owner: review/merge the PR (or let the loop carry it); optionally confirm TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set in automation-core so the digest actually sends (otherwise it just logs to the run summary).
- Next: once merged, the digest runs every morning at 05:30 UTC. A future interactive Telegram control center (buttons to trigger merges/reruns) can build on this read-only base.
## [2026-06-18 05:05 UTC] merge-bot: evaluate only the LATEST check run per name (fixes "never merged")
- PR: direct commit to main
- Branch: main (direct commit)
- Status: done
- What changed: ROOT CAUSE of merge-bot never merging: the Codex gate emits MULTIPLE `check-codex-status` check runs on the same head SHA over a PR's life — an early PENDING/red run when the PR opens (before Codex reviews), then a SUCCESS run after. GitHub's own merge gating uses the most-recent run per name (so its merge button reflects the green one), but merge-bot scanned EVERY check run and set `anyFailed` on the stale early-red one → skipped the merge every time. Fix: after `checks.listForRef`, dedupe to the LATEST run per `name` (sort by `completed_at` then `started_at` descending, keep the first occurrence of each name → `latestCheckRuns`), and use `latestCheckRuns` for BOTH the anyRunning/anyFailed scan AND the codex lookup (`latestCheckRuns.find(c => c.name === 'check-codex-status')`). Commit statuses (listCommitStatusesForRef → latestByCtx) are already deduped per context and were left untouched. Everything else unchanged: candidate filter (needs-owner/legacy hard-stop FIRST, automerge, trusted sync, same-repo `claude/*`), `.claude-guard.json` protected-path guard, head-SHA-pinned squash merge, fail-soft on missing PAT, draft/mergeable checks, branch delete, linked-issue close. Net: a stale early-red gate run no longer blocks a PR whose latest gate is green; a genuinely failing latest check still blocks; a genuine active P1 still blocks (latest codex run is red). Both merge-bot.yml copies kept byte-identical.
- Validation: actionlint clean on both copies; node --check on the github-script block; `workflows/` ↔ `.github/workflows/` byte-identical (blob `999bc00`); diff is +18/-2 (the dedupe block + 2 reference swaps) — hard-stop, protected-path guard, and head-SHA pin lines are unchanged; dedupe runs BEFORE both the anyFailed scan and the codex lookup.
- needs-from-owner: nothing — live on main in one commit (handoff + LOOP_STATE in the same commit, no trailing commit, so the codex gate's head-reviewed state isn't reset).
- Next: green PRs whose latest `check-codex-status` is success now actually auto-merge; the fix syncs to downstream repos on the next daily sync.

## [2026-06-18 03:20 UTC] merge-bot: auto-merge green PRs from claude/* branches
- PR: direct commit to main
- Branch: main (direct commit)
- Status: done
- What changed: merge-bot's candidate filter now also accepts a PR whose head ref starts with `claude/` AND is in THIS repo (same-repo, not a fork) — `isClaudeBranch`. Claude Code opens its PRs via AUTOMATION_PAT, so they're authored by the owner (not a bot login) and carry no `automerge` label; previously `byBot`/`hasAutomerge` missed them and they never auto-merged. They now auto-merge once codex-gate is green. Safety unchanged and ordered correctly: the escalation hard-stop (`needs-owner` / legacy label) is still the FIRST check and filters the PR out before any acceptance; the `.claude-guard.json` protected-path guard still runs before merge and escalates a protected-path `claude/*` PR to `needs-owner` instead of merging; head-SHA-pinned squash, fail-soft-on-missing-PAT, and codex-gate-must-be-green are untouched. Same-repo requirement makes `claude/*` acceptance unspoofable from a fork (a fork PR carries a different head.repo). Both merge-bot.yml copies kept byte-identical.
- Validation: actionlint clean on both copies; node --check on the github-script block; `workflows/` ↔ `.github/workflows/` byte-identical (blob `12a4851`); hard-stop + protected-path guard confirmed to run before the new `claude/*` acceptance.
- needs-from-owner: nothing — change is live on main in one commit (handoff + LOOP_STATE included in the same commit, no trailing commit, so codex-gate head state isn't reset).
- Next: green PRs on `claude/*` branches now self-merge after codex-gate passes; the leaner candidate logic syncs to downstream repos on the next daily sync.

## [2026-06-18 02:55 UTC] migrate escalation label → needs-owner (loop-safe, backward-compat) + name re-scrub
- PR: direct commit to main
- Branch: main (direct commit)
- Status: done
- What changed: Migrated the escalation label to `needs-owner` across all synced workflows, **backward-compatibly**. New escalations now tag `needs-owner` (ci-doctor REQUIRED_LABELS upsert + addLabels; merge-bot createLabel + addLabels; codex-auto-fix now createLabel-upserts then addLabels `needs-owner`). Every gate that CHECKS for an escalation — merge-bot's candidate hard-stop filter and ci-doctor's “already escalated” skip — now matches BOTH `needs-owner` AND the legacy label, so existing escalations across the ~14 downstream repos are NOT orphaned during the transition. No workflow REMOVES the escalation label, so no dual-remove was needed. Comments + docs updated to `needs-owner` (README label table / secrets / protected-path note; LOOP_STATE label table + workflow descriptions + a new migration note). Also re-confirmed the owner-name scrub: 0 standalone occurrences repo-wide (case-insensitive). `funzi7` untouched.
- Validation: actionlint clean on all 8 changed workflow copies; node --check clean on all 6 github-script blocks; `workflows/` ↔ `.github/workflows/` byte-identical for every synced workflow; standalone-name grep = 0; the legacy label remains ONLY inside backward-compat CHECK constants/comments (0 occurrences in any addLabels/createLabel); `needs-owner` present in the new add/upsert paths.
- needs-from-owner: nothing blocking here; downstream rollout is the remaining work (see Next).
- Next: the migrated workflows must propagate to the ~14 downstream repos (daily sync / onboarding PRs), AND existing items already tagged with the legacy label across all repos should be re-tagged to `needs-owner` before the backward-compat CHECK is eventually removed. Until then both labels are honored.

## [2026-06-18 01:50 UTC] privacy re-sweep (automation-core): case-insensitive content check + PR #28/#29 metadata cleaned
- PR: direct to main (content already clean); plus metadata cleaned on PRs #28 and #29
- Branch: main (direct commit)
- Status: done
- What changed: Re-ran the name scrub on automation-core **case-INSENSITIVELY** (the prior pass in #29 was case-sensitive, so variants could have survived). A working-tree grep across `LOOP_STATE.md`, `README.md`, every `handoffs/*.md`, and all workflow comments found **zero** standalone name occurrences outside the legacy label — so no content edits were needed; the earlier pass had already caught every case variant. Also cleaned **PR metadata**: PR #28 body had 2 standalone name occurrences and PR #29 body had 2 (backticked technical references); both bodies were rewritten with "the owner". Titles were already clean. The legacy label string and the `funzi7` handle were left untouched, and no workflow logic changed.
- Validation: case-insensitive working-tree grep = 0 standalone (only legacy-label substrings remain); no workflow files modified (byte-parity intact); PR #28/#29 bodies re-fetched and confirmed 0 standalone name.
- Needs from the owner: nothing — public content + #28/#29 metadata are name-free. (Optional commit-message history rewrite was intentionally NOT run; it would force-push and break open branches such as #28 — request it separately if wanted.)
- Next: if a git-history scrub is desired, authorize it explicitly; otherwise the public surface is clean.

## [2026-06-17 17:20 UTC] privacy scrub: remove the owner's personal name from all public content
- PR: https://github.com/funzi7/automation-core/pull/29
- Branch: claude/privacy-scrub
- Status: open (awaiting merge)
- What changed: This is a PUBLIC repo; the owner's personal first name appeared in prose/comments/docs. Replaced every standalone occurrence with "the owner" (case-sensitive whole-word swap) across codex-auto-fix.yml comments (3 per copy, both mirror copies kept byte-identical), LOOP_STATE.md (1), handoffs/README.md (1), and this file (5) — 13 total. The legacy LABEL STRING was left byte-for-byte intact everywhere it appears in workflow logic (addLabels/removeLabel/filters/if:) — renaming it would break ci-doctor/merge-bot/codex-auto-fix. The public GitHub handle `funzi7` (incl. merge-bot's `OWNER_LOGIN`) was left as-is — it's the public account name, not a private personal name. Comments/text only; no workflow logic changed.
- Validation: repo-wide grep confirms ZERO standalone personal-name occurrences remain (only legacy-label strings); actionlint clean on both codex-auto-fix.yml copies; `workflows/` ↔ `.github/workflows/` codex-auto-fix byte-identical (blob `7005c92`); node --check on the changed github-script block.
- Needs from the owner: merge #29.
- Next: after merge, the scrubbed codex-auto-fix.yml syncs to consumer repos on the next daily sync.

## [2026-06-17 15:09 UTC] codex-gate: "has reviewed" is now date-only (4th Codex P1)
- PR: https://github.com/funzi7/automation-core/pull/25
- Branch: claude/fix-codex-gate-green
- Status: open (awaiting merge)
- What changed: Collapsed `reviewedHead`/`activeOnHead` into ONE date-only predicate `onHead(date) = date > latestCommitDate`, used for BOTH "has reviewed" and "active P1"; removed all `commit_id`-based freshness. Everything else kept: head-targeted self-rerun, rerun cap via workflow-specific `listWorkflowRuns`, P1-only blocking, fail-soft, override label, P1-then-Summary clearing.
- Validation: actionlint clean on both copies; node --check on all 3 github-script blocks; `workflows/` ↔ `.github/workflows/` byte-identical (blob `461b280`).
- Needs from the owner: merge #25, and clear the escalation label the circuit-breaker added.
- Next: after merge + label cleared, the gate goes green on `pr.head.sha` → merge-bot auto-merges. Then Stage 3.

## [2026-06-17 14:56 UTC] codex-gate: clean review = green, P1-only, wait-for-first-review, head-targeted rerun
- PR: https://github.com/funzi7/automation-core/pull/25
- Branch: claude/fix-codex-gate-green
- Status: open (awaiting merge)
- What changed: Rewrote codex-gate to go GREEN on a clean review / 👍 / P2-only; block only on an ACTIVE P1; wait for Codex's first signal before green; head-targeted self-rerun so clean verdicts land on `pr.head.sha`; date-only active-P1 detection; rerun-cap via workflow-specific `listWorkflowRuns`.
- Validation: actionlint clean on both copies; node --check on all 3 github-script blocks; byte-identical (blob `2cf1b06`); final commit `526332f`.
- Needs from the owner: merge #25.
- Next: verify merge-bot auto-merges once the gate is green on the head; then Stage 3.

## [2026-06-17 03:44 UTC] Codex Gate: clean review = green, block only on active P1, + wait-for-first-review
- PR: https://github.com/funzi7/automation-core/pull/25
- Branch: claude/fix-codex-gate-green
- Status: opened (awaiting merge)
- What changed: `codex-gate.yml` goes GREEN on a clean Codex review; blocks ONLY on an ACTIVE P1; added a wait-for-first-review guard; removed the old wait/self-rerun loop; fail-soft preserved. Updated `LOOP_STATE.md`.
- Validation: actionlint clean on both copies; node --check; byte-identical (blob `1dc0e83`).
- Needs from the owner: merge PR #25.
- Next: after merge, `codex-gate.yml` syncs to every consumer repo on the next daily sync.
