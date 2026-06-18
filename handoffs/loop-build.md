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
