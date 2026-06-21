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

## [2026-06-21 02:10 UTC] docs: add comprehensive CONTEXT.md handoff briefing
- PR: direct commit to main
- Branch: main (direct commit)
- Status: done
- What changed: Created `handoffs/CONTEXT.md` — a single, self-contained briefing so any brand-new chat or different AI can understand the ENTIRE system and continue without prior chat history. Seven sections: (1) PURPOSE (public hub for a self-healing CI/CD loop synced to ~14 downstream repos; the owner's chat-as-coordinator → Claude Code / Codex execute model); (2) ARCHITECTURE (the full push→PR→Codex review→bridge→Claude Fixer→re-review→3-round breaker→needs-owner+Telegram→merge-bot loop, naming every workflow file); (3) KEY MECHANISMS (codex-gate date-only freshness + capped head-targeted self-rerun; merge-bot candidate set + needs-owner hard stop + `.claude-guard.json` protected-path guard + head-SHA-pinned squash + latest-check-run-per-name dedupe; the bridge's P1+P2-exclude-P3 badge detection + idempotency + 3-attempt breaker + Codex-author guard); (4) HARD-WON LESSONS (same-commit handoff or the gate resets red; merge-bot must dedupe to latest-per-name; the gate's fresh-PR red flicker is by-design fail-closed; Codex pushes fixes to a branch AND opens a parallel make_pr PR; Codex keeps re-adding the legacy escalation label — 0 carry it now and it must stay gone; protected-path PRs need manual merge; the owner merges — never claim a merge without confirmed closure; public repo = the owner's name never appears; claude.yml's paid budget is exhausted so the automated fixer can't run — hence Codex-as-backup matters); (5) CURRENT STATE (per-workflow live-on-main table; AUTOMATION_PAT present; morning report on PR #31, open, needs manual merge as it touches protected paths); (6) OPEN DECISIONS/TODO (history-rewrite decision for the legacy label; mutual review; Codex-as-backup; PR #31 cleanup; add branch protection once stable); (7) CONVENTIONS. Also pointed `LOOP_STATE.md` at CONTEXT.md as the canonical full briefing.
- Validation: legacy-label grep (whole repo, case-insensitive) = 0; owner-name standalone grep = 0; CONTEXT.md contains all 7 numbered sections; LOOP_STATE links to it.
- needs-from-owner: nothing — live on main in one commit (handoff + LOOP_STATE + CONTEXT.md all in the same commit, no trailing commit, so the gate's head-reviewed state isn't reset).
- Next: new sessions start from `handoffs/CONTEXT.md`; keep it current as mechanisms change.

## [2026-06-21 01:30 UTC] bridge: trigger auto-fix on P1 AND P2 (exclude P3)
- PR: direct commit to main
- Branch: main (direct commit)
- Status: done
- What changed: Expanded the codex→claude bridge (the `trigger_codex_fix` job in `codex-auto-fix.yml`) from P1-only to **P1 + P2, excluding P3**. P2 findings routinely carry real correctness issues (e.g. the "false-green health" P2 on PR #31), so they should be auto-fixed, not just noted; P3 is minor styling/cosmetic and must never start a paid run. Confirmed the literal severity marker by inspecting real Codex comments in this repo: each finding renders a shields.io badge whose label is the literal token — `![P1 Badge](.../badge/P1-orange...)`, `![P2 Badge](.../badge/P2-yellow...)`, `P3-...`. The job-level `if:` gate now fires when a body `contains 'P1' || 'P2'` (per channel); the JS check computes `hasP1 = some(b.includes("P1"))` and `hasP2 = some(b.includes("P2"))` and triggers when either is true — a P3-only finding contains neither token, so it never triggers. Same freshness rule (only Codex bodies dated AFTER the latest commit, plus the triggering body — reused the existing `codexBodiesThisWave` array, no parallel detection path). The posted `@claude fix` comment now notes the severity (`P1`, `P2`, or `P1/P2`) and a best-effort finding count (counts `![Px Badge]` alt-texts). Safety rails UNCHANGED: idempotency (`alreadyThisWave` marker dedupe for the current head), the 3-round circuit breaker (`MAX_FIX_ROUNDS = 3` → adds `needs-owner` + Telegram), and the Codex-author-only guard (bot login in both the `if:` and the `e.login === CODEX` JS filter) all still run as before. The literal `@claude fix` first line and the `[auto-triggered]` breaker marker are byte-exact. Both copies kept byte-identical. (NOT in scope here: the Codex-as-backup fallback — that's a separate step pending verification Codex can push to a branch. claude.yml unchanged.)
- Validation: actionlint clean on both copies; node --check on all 3 github-script blocks; a 7-case detection self-test passes (P1→trigger, P2→trigger, P3→NO trigger, P1+P2→"P1/P2" count 2, P2+P3→trigger on P2 ignoring P3, P1+P3→P1, clean review→NO trigger); safety-rail greps confirm breaker/idempotency/author-guard intact; `workflows/` ↔ `.github/workflows/` byte-identical (blob `6d7328b`).
- needs-from-owner: nothing — live on main in one commit (handoff + LOOP_STATE in the same commit, no trailing commit, so the codex gate's head-reviewed state isn't reset). Downstream repos pick up the wider trigger on the next daily sync.
- Next: P2 correctness findings now get auto-fixed like P1; the 3-round breaker keeps any endless trickle bounded. The Codex-as-backup fallback remains a separate, later step.

## [2026-06-20 18:10 UTC] standardize on needs-owner — remove the legacy escalation label entirely
- PR: direct commit to main
- Branch: main (direct commit)
- Status: done
- What changed: Removed the backward-compat dual-matching and standardized fully on `needs-owner`. Step A (read-only): swept all OPEN issues + PRs in this repo for the old escalation label — **0 stragglers** (no re-tag needed). Step B: deleted the `LABEL_ESCALATE_LEGACY` constant from `ci-doctor.yml` and `merge-bot.yml`, and dropped every `|| ... LABEL_ESCALATE_LEGACY` clause — merge-bot's candidate hard-stop is now `some(l => l.name === LABEL_ESCALATE)` and ci-doctor's "already escalated" skip is now `=== LABEL_ESCALATE` only. `codex-auto-fix.yml`'s escalation comment lost its legacy mention (it already only ADDED `needs-owner`). Docs updated: README label table, LOOP_STATE label table + merge-bot description + the migration note now say the old label is fully removed and `needs-owner` is the single source of truth. ONLY the escalation-label logic/prose changed — no other workflow logic touched. `funzi7` untouched. The old label string now appears NOWHERE in the repo (workflows, comments, or docs).
- Validation: actionlint clean on all 6 changed workflow copies; node --check on every changed github-script block; `workflows/` ↔ `.github/workflows/` byte-identical for all three (ci-doctor / merge-bot / codex-auto-fix); legacy-label grep (case-insensitive, whole repo) = 0; target-name grep = 0; `needs-owner` still present in every add/check path; `funzi7` unchanged.
- needs-from-owner: nothing — live on main in one commit (handoff + LOOP_STATE in the same commit, no trailing commit, so the codex gate's head-reviewed state isn't reset). Downstream repos pick up the leaner logic on the next daily sync.
- Next: with no compat shim, a single `needs-owner` is the only escalation signal everywhere; nothing else to do unless a repo somewhere still has the old label on an item (none did at removal time).

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
