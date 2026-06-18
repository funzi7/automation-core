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

## [2026-06-18 01:50 UTC] privacy re-sweep (automation-core): case-insensitive content check + PR #28/#29 metadata cleaned
- PR: direct to main (content already clean); plus metadata cleaned on PRs #28 and #29
- Branch: main (direct commit)
- Status: done
- What changed: Re-ran the name scrub on automation-core **case-INSENSITIVELY** (the prior pass in #29 was case-sensitive, so variants could have survived). A working-tree grep across `LOOP_STATE.md`, `README.md`, every `handoffs/*.md`, and all workflow comments found **zero** standalone name occurrences outside the `needs-dima` label — so no content edits were needed; the earlier pass had already caught every case variant. Also cleaned **PR metadata**: PR #28 body had 2 standalone name occurrences and PR #29 body had 2 (backticked technical references); both bodies were rewritten with "the owner". Titles were already clean. The `needs-dima` label string and the `funzi7` handle were left untouched, and no workflow logic changed.
- Validation: case-insensitive working-tree grep = 0 standalone (only `needs-dima` label substrings remain); no workflow files modified (byte-parity intact); PR #28/#29 bodies re-fetched and confirmed 0 standalone name.
- Needs from the owner: nothing — public content + #28/#29 metadata are name-free. (Optional commit-message history rewrite was intentionally NOT run; it would force-push and break open branches such as #28 — request it separately if wanted.)
- Next: if a git-history scrub is desired, authorize it explicitly; otherwise the public surface is clean.

## [2026-06-17 17:20 UTC] privacy scrub: remove the owner's personal name from all public content
- PR: https://github.com/funzi7/automation-core/pull/29
- Branch: claude/privacy-scrub
- Status: open (awaiting merge)
- What changed: This is a PUBLIC repo; the owner's personal first name appeared in prose/comments/docs. Replaced every standalone occurrence with "the owner" (case-sensitive whole-word swap) across codex-auto-fix.yml comments (3 per copy, both mirror copies kept byte-identical), LOOP_STATE.md (1), handoffs/README.md (1), and this file (5) — 13 total. The `needs-dima` LABEL STRING was left byte-for-byte intact everywhere it appears in workflow logic (addLabels/removeLabel/filters/if:) — renaming it would break ci-doctor/merge-bot/codex-auto-fix. The public GitHub handle `funzi7` (incl. merge-bot's `OWNER_LOGIN`) was left as-is — it's the public account name, not a private personal name. Comments/text only; no workflow logic changed.
- Validation: repo-wide grep confirms ZERO standalone personal-name occurrences remain (only `needs-dima` label strings); actionlint clean on both codex-auto-fix.yml copies; `workflows/` ↔ `.github/workflows/` codex-auto-fix byte-identical (blob `7005c92`); node --check on the changed github-script block.
- Needs from the owner: merge #29.
- Next: after merge, the scrubbed codex-auto-fix.yml syncs to consumer repos on the next daily sync. NOTE: the still-open codex-gate / merge-bot / auto-enroll branches carry newer handoff entries that reintroduce the name — scrub those as they land (or via their own PRs).

## [2026-06-17 15:09 UTC] codex-gate: "has reviewed" is now date-only (4th Codex P1 — re-pointed commit_id no longer = a fresh review)
- PR: https://github.com/funzi7/automation-core/pull/25
- Branch: claude/fix-codex-gate-green
- Status: open (awaiting merge; circuit-breaker added needs-dima after 3 rounds — the owner clears it after this lands)
- What changed: Codex's 4th P1 ("don't count re-pointed comments as a fresh review") was correct. The prior fix made the *active-P1* test date-only but left `hasCodexSignalOnHead` accepting `commit_id == headSha`. Since GitHub re-points a non-outdated inline comment's `commit_id` to the new head, an old unresolved P1 comment whose line still exists would read as "Codex reviewed this head" → a push that doesn't touch that line could flip the gate GREEN before Codex actually re-reviewed (merge-before-review via a side door). Fix: collapsed `reviewedHead`/`activeOnHead` into ONE date-only predicate `onHead(date) = date > latestCommitDate`, used for BOTH "has reviewed" and "active P1"; removed all `commit_id`-based freshness (commit_id now only appears in explanatory comments). 👍 already date-only. Everything else kept: head-targeted self-rerun (green lands on `pr.head.sha`), rerun cap via workflow-specific `listWorkflowRuns`, P1-only blocking, fail-soft, override label, P1-then-Summary clearing.
- Validation: actionlint clean on both copies; node --check on all 3 github-script blocks; `workflows/` ↔ `.github/workflows/` byte-identical (SHA parity, blob `461b280`); 0 stray `reviewedHead`/`activeOnHead` refs.
- Needs from the owner: merge #25, and clear the `needs-dima` label the circuit-breaker added (the gate is correct now; it only escalated because the stale-P1 bug kept it red past 3 rounds).
- Next: after merge + label cleared, Codex re-reviews the head with no P1 → gate goes green on `pr.head.sha` → merge-bot auto-merges. Then Stage 3 (auto-enrollment + Telegram control center).

## [2026-06-17 14:56 UTC] codex-gate: clean review = green, P1-only, wait-for-first-review, head-targeted rerun, date-only stale detection
- PR: https://github.com/funzi7/automation-core/pull/25
- Branch: claude/fix-codex-gate-green
- Status: open (awaiting merge; head 526332f, mergeable)
- What changed: Rewrote codex-gate to (1) go GREEN on a clean review / 👍 / P2-only instead of demanding an explicit approval marker; (2) block only on an ACTIVE P1; (3) wait for Codex's first signal before green (no merge-before-review — the #66/#67 race); (4) head-targeted self-rerun so clean verdicts land `check-codex-status` on `pr.head.sha` where merge-bot reads it (👍 fires no event; issue_comment runs on the default branch); (5) date-only active-P1 detection — GitHub re-points `commit_id` on non-outdated inline comments, which was making an 11h-stale P1 look active and block the PR on itself; (6) rerun-cap now uses workflow-specific `listWorkflowRuns` so only Codex Gate runs count toward `MAX_ATTEMPTS` (`listWorkflowRunsForRepo` ignores `workflow_id`).
- Validation: actionlint clean on both copies; node --check on all 3 github-script blocks; `workflows/` ↔ `.github/workflows/` byte-identical (SHA parity, blob `2cf1b06`); final commit `526332f`.
- Needs from the owner: merge #25 (last manual merge — after this the fixed gate is on main and clean PRs go green on the head for merge-bot to auto-merge).
- Next: verify merge-bot auto-merges once the gate is green on the head; then Stage 3 (auto-enrollment + Telegram control center).

## [2026-06-17 03:44 UTC] Codex Gate: clean review = green, block only on active P1, + wait-for-first-review
- PR: https://github.com/funzi7/automation-core/pull/25
- Branch: claude/fix-codex-gate-green
- Status: opened (awaiting merge)
- What changed:
  - `codex-gate.yml` (`check-codex-status`) now goes GREEN on a clean Codex review (👍 / no P1) instead of staying red and forcing a manual merge (fixed PR #24's bug — the old gate demanded an explicit post-commit approval marker and never counted the 👍 reaction).
  - Blocks ONLY on an ACTIVE P1 — a P1 marker on the current head, not yet followed by a Codex fix Summary; P2 / stale P1 / clean review are all green. Consistent with the bridge's P1-only logic; same P1 detection across the 3 channels, fully paginated.
  - Added a wait-for-first-review guard: a PR stays PENDING (red) until Codex leaves ANY signal on the head (review object, inline note, top-level comment, or 👍), so merge-bot can't merge before Codex reviews (the #66/#67 race). "On the head" = `commit_id == head SHA` OR dated after the latest commit, so a real review is never missed and it can't wedge red-forever.
  - Removed the old wait/self-rerun loop + `actions: write`; fail-soft preserved (technical error → no block, a detected P1 always blocks). Updated `LOOP_STATE.md`.
- Validation: actionlint clean on both copies; both github-script blocks pass node --check; `workflows/` ↔ `.github/workflows/` byte-identical (blob `1dc0e83`), SHA-parity verified after push.
- Needs from the owner: merge PR #25.
- Next: after merge, `codex-gate.yml` is in `synced_workflows` so every consumer repo (paywall-bot, and OPT/TRF once their onboarding PRs #12/#80 land) gets the fix on the next daily sync.
