# handoffs/ — per-chat handoff logs

This directory holds handoff logs, one file per Claude Chat session. Claude Code prepends a summary after each task to the file named for the current chat (the chat's coordinator tells Claude Code which file). Claude Chat reads its own chat's file directly (this repo is public). Newest entry always at the top of each file. File naming: `handoffs/<chat-topic>.md` (e.g. `handoffs/loop-build.md`).

## Cross-repo rule (important)

Tasks that operate on OTHER repos (OPT, TRF, paywall-bot — which may be
private and unreadable by Claude Chat) must still keep the canonical handoff
summary in `handoffs/<chat-topic>.md` here in **automation-core**. A task may
also update a downstream repository's own handoff when explicitly requested.
Do not give a model-facing Issue/new-PR step `AUTOMATION_PAT` or a persisted
cross-repository git credential. If cross-repository handoff publishing needs
that PAT, only trusted post-model workflow code or the trusted coordinator may
receive it. The canonical summary remains public so Claude Chat can read it
even when the implementation repository is private.

## Entry template

Each entry uses this template (prepend a new entry to the top of the chat's file — newest first):

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

## Current files

- `loop-build.md` — the self-healing-loop build chat (automation-core loop: codex-gate, bridge, claude fixer, merge-bot, onboarding).
