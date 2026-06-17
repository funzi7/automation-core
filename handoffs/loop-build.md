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
- Needs from Dima: <merge / secrets / decision / nothing>
- Next: <what should happen after>
```

---

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
- Needs from Dima: merge PR #25.
- Next: after merge, `codex-gate.yml` is in `synced_workflows` so every consumer repo (paywall-bot, and OPT/TRF once their onboarding PRs #12/#80 land) gets the fix on the next daily sync.
