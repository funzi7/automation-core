# loop-build — Claude Code ⇄ Claude Chat handoff log

Handoff log for the self-healing-loop build. Newest entry is first. Historical entries below are retained as incident context only; when they describe behavior that differs from the current architecture, they are explicitly marked HISTORICAL or SUPERSEDED and defer to `LOOP_STATE.md` and `handoffs/CONTEXT.md` for current operating instructions.

---

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
- Validation: documentation structure reviewed; stale current-tense claims were normalized in the edited docs. Local `git pull --ff-only` and local diff validation were blocked by the workspace write-sandbox error `bwrap: fchdir to oldroot: No such file or directory`; updates were published through the GitHub connector as direct documentation commits.
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
