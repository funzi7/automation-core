# handoffs/ — per-chat handoff logs

This directory holds handoff logs, one file per Claude Chat session. Claude Code prepends a summary after each task to the file named for the current chat (the chat's coordinator tells Claude Code which file). Claude Chat reads its own chat's file directly (this repo is public). Newest entry always at the top of each file. File naming: `handoffs/<chat-topic>.md` (e.g. `handoffs/loop-build.md`).

## Cross-repo rule (important)

Claude Code tasks that operate on OTHER repos (OPT, TRF, paywall-bot — which are private and unreadable by Claude Chat) must STILL write their handoff summary to `handoffs/<chat-topic>.md` here in **automation-core** (this public repo), **NOT** to the private repo. Claude Code has `AUTOMATION_PAT` with all-repos access, so it can write cross-repo. This is the whole point: the summary always lands in the public automation-core where Claude Chat can read it, even when the actual work was on a private repo.

## Entry template

Each entry uses this template (prepend a new entry to the top of the chat's file — newest first):

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

## Current files

- `loop-build.md` — the self-healing-loop build chat (automation-core loop: codex-gate, bridge, claude fixer, merge-bot, onboarding).
