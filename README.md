# automation-core

Central source of truth for CI/CD automation across all of @funzi7's repositories.

## What lives here

`workflows/` — generic GitHub Actions workflows synced to every participating repo:
- `codex-auto-fix.yml` — triggers Codex to fix flagged P1/P2 reviews automatically
- `codex-gate.yml` — blocks PR merge until a valid current-head Codex review signal exists and no P1/P2 remains; quota/capacity notices never count
- `claude.yml` — **Claude Fixer**: Claude Code fixes a `claude-fix` Issue (or an `@claude` mention) on a branch and opens a PR
- `ci-doctor.yml` — **CI Doctor**: detects failed runs on the default branch and opens `claude-fix` Issues
- `merge-bot.yml` — **Merge Bot**: squash-merges fully-green PRs once codex-gate passes

`template/` — files a repo copies into its own root (not auto-synced):
- `sync-automation-core.yml` — the per-repo sync workflow (installed by Bootstrap)
- `claude-guard.example.json` — example `.claude-guard.json` protected-paths config for Merge Bot

## Self-Healing Loop

An autonomous detect → fix → review → merge loop, assembled from the four
workflows above plus the existing `codex-gate`:

```
  any workflow fails on main
          │
          ▼
  ci-doctor.yml   opens an Issue (logs + root-cause prompt), labels it claude-fix
          │
          ▼  (label: claude-fix)
  claude.yml      Claude diagnoses, fixes on a branch, opens a PR (Fixes #N)
          │
          ▼  (PR opened)
  codex-gate.yml  check-codex-status must pass (no unresolved P1/P2)
          │
          ▼  (all green)
  merge-bot.yml   squash-merges the exact checked head, deletes its branch,
                  closes the ci-doctor Issue
```

Trusted cross-workflow writes use `AUTOMATION_PAT` because default-token events
do not trigger other workflows. The Issue-mode Claude model is the deliberate
exception: it receives only `github.token`; only a later trusted post-step may
receive the PAT.

The 2026-08-13 Gate incident is closed. Large `github-script` bodies receive
workflow values through `env`, and validation scans all tracked workflow YAML
to reject every direct `${{ ... }}` interpolation inside `github-script`
bodies. This prevents expression-size failures and string/type injection; Node
syntax checks therefore inspect the exact script body. Scheduled Watchdog
dispatch/update/backup failures alert once per repository/PR/exact-head/
operation/normalized-error marker; identical retries keep logging without
repeating Telegram. CI Doctor also ignores internal automation by workflow
path, including parse-failed runs whose display name degrades to the YAML path.

**Scheduling (kept light to restrain Actions-minute cost):** CI Doctor runs on
a cron **twice a day** (06:00 & 18:00 UTC) to sweep the default branch for
failed runs — its lookback window (13h) overlaps the two runs so nothing slips
through. Merge Bot keeps only a **once-daily** safety-net cron (07:30 UTC). The
loop's real responsiveness does **not** come from these schedules but from
**events**: Merge Bot fires immediately on `check_suite` completion, PR
`labeled`, and the Codex Gate `workflow_run`; Claude Fixer fires the moment the
`claude-fix` label is applied or `@claude` is mentioned. So fixes and merges
still happen within minutes — the crons are just the backstop.

### Label dictionary (uniform across all repos)

| Label | Meaning |
|-------|---------|
| `claude-fix` | "Claude, fix this." Set by ci-doctor; triggers Claude Fixer. |
| `automerge` | This PR may be auto-merged by Merge Bot once green. |
| `claude-generated` | Durable provenance that the trusted Claude workflow created the PR; protected paths remain fail-closed even if PAT authorship looks human. |
| `no-automerge` | Permanent human opt-out. Merge Bot never removes it and never merges while it is present. |
| `needs-owner` | Human/manual escalation stop. Without proven automation provenance it remains a hard stop. |
| `needs-owner-auto` | Companion provenance for a temporary PR fixer/watchdog exhaustion. Merge Bot clears it together with `needs-owner` only after the current head is mergeable, fully green, exact-head gated, and free of active trusted P1/P2 findings. |
| `ci-doctor` | Marks Issues opened by CI Doctor (used for dedup + close). |

### Secrets

| Secret | Required by | Notes |
|--------|-------------|-------|
| `ANTHROPIC_API_KEY` | `claude.yml` | **Required for the fixer.** If absent, Claude Fixer exits green (fail-soft) — no fix, no red runs, ~0 minutes. Set only on the repos you want auto-fixed (cost control). |
| `CROSS_REPO_PAT` | `bootstrap.yml` (onboarding / auto-enrollment), `minutes-guard.yml` | automation-core only. Cross-repo fine-grained PAT (Contents/PRs/Workflows write, Metadata read; all repos). If absent, auto-enrollment exits green with a notice (fail-soft). |
| `AUTOMATION_PAT` | `ci-doctor.yml`, `merge-bot.yml`, and trusted post-Claude PR creation | **Required for the loop to chain.** It is never passed to Issue-mode Claude or its model-facing checkout. If absent, trusted writes exit green (fail-soft). Needs Contents/PRs/Issues write, Metadata read. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | optional | Escalation pings on `needs-owner` / protected-path blocks. Messages use `parse_mode: HTML` (Markdown underscores broke us before). Skipped silently if unset. |

### fail-soft behaviour

Every workflow's first step checks for its required secret and exits green
with a log notice if it is missing. This is deliberate: these files are
synced to **every** repo, but only repos that opt in (by having the secrets
set) actually run the automation. Key-less repos never produce red failures
and burn essentially no Actions minutes.

### Protected paths

Drop a `.claude-guard.json` in a repo root (see
`template/claude-guard.example.json`) to list sensitive globs. Forks,
untrusted authors, and ambiguous/bot-only PRs touching those paths are
escalated to manual `needs-owner`. A same-repository PR authored by `funzi7`
may still auto-merge protected workflow changes, but only after the unchanged
full exact-head CI, trusted Codex review/gate, active-thread, mergeability, and
SHA-pinned merge requirements pass. Add `no-automerge` for an explicit human
hold. Because `AUTOMATION_PAT` can make a Claude-created PR appear owner-authored,
the trusted Claude workflow records durable `claude-generated` provenance using
the Actions identity. On Issue runs, checkout uses `github.token` with
credential persistence disabled; the model has no shell, generic interpreter,
or generic write tool; the action uses constrained file operations and signed
API commits; and a mandatory scrub removes its git credential before a trusted
PAT-backed post-step creates the PR from the exact branch output. The branch therefore
provides immediate provenance at PR creation, with the durable label following.
The exact same-repository automation-core sync signature remains trusted when
no Claude provenance exists.

### Default merge policy

An open, non-draft PR authored by `funzi7` whose head repository exactly
matches its base repository is a trusted Merge Bot candidate regardless of a
normal `fix/*`, `feat/*`, or `chore/*` branch name. Established Claude,
explicit `automerge`, and trusted automation-core sync candidates remain
supported. Fork titles and branch names never establish trust.

The candidate is merged only when every latest relevant check/status is
terminal-green, the authoritative `check-codex-status` success exists on the
exact current head, no active trusted P1/P2 thread exists, and GitHub reports
the PR mergeable. Codex quota/capacity notices are not review signals. The
squash call is pinned to that evaluated SHA; a moved
head fails closed. A successful same-repo merge is followed by branch
deletion, and the PAT-authored merge continues to trigger downstream
workflows.

## How to onboard repos

**Onboarding is automatic.** The **Bootstrap repos** workflow runs on a weekly
schedule (**Mondays 04:00 UTC**) and opens an onboarding PR titled
`chore(automation): bootstrap sync from automation-core` in every eligible repo
that isn't enrolled yet. A repo is **eligible** when it is:

- owned by you (not an org/collaborator repo), not archived, not a fork, and not automation-core itself;
- not already enrolled (no `.github/workflows/sync-automation-core.yml`);
- not opted out (no `.automation-core-ignore` at the repo root).

**Auto-enrollment only OPENS the PR — it never merges it.** Merging stays a
human checkpoint (auto-propose, not auto-apply), so a brand-new or experimental
repo can't get automation wired in and merged with zero review. Merge the
onboarding PR to join the loop; from then on the daily sync keeps the repo's
workflows up to date.

> fail-soft: if `CROSS_REPO_PAT` is missing, the scheduled sweep exits green
> with a notice (no red run) — onboarding is simply inert until the PAT is set.

### Opt a repo OUT of auto-enrollment

Create `.automation-core-ignore` at the repo root. The weekly sweep (and the
daily sync) will skip it — this is how you exclude a repo from the loop.

### Manual onboarding (optional)

You can still onboard on demand: Actions → **Bootstrap repos** → Run workflow.

1. Optional inputs:
   - `dry_run`: true → only list the repos that *would* get a PR, don't open any
   - `target_repo`: limit to a single repo (leave empty for all)
2. The workflow opens the same onboarding PR in each eligible repo
3. Merge each PR — from then on, daily sync is active in that repo

### Setup (one-time)

The bootstrap workflow needs a fine-grained PAT with cross-repo access:

1. Go to https://github.com/settings/personal-access-tokens
2. Create new token (fine-grained)
3. Resource owner: your user
4. Repository access: All repositories
5. Permissions: Contents (write), Pull requests (write), Workflows (write), Metadata (read)
6. Save the token, then add it as a secret named `CROSS_REPO_PAT` in this repo (Settings → Secrets and variables → Actions)

> The Self-Healing Loop also needs `AUTOMATION_PAT` (Contents/PRs/Issues write, Metadata read) set on each participating repo, and `ANTHROPIC_API_KEY` on the repos you want Claude to auto-fix.

## How sync works

Each participating repo has `.github/workflows/sync-automation-core.yml` that:
1. Runs daily at 03:00 UTC
2. Clones automation-core
3. Compares files in `.github/workflows/` (matching the allow-list from `automation-core/sync-config.json`) against the local repo
4. If diffs exist → opens a PR titled `chore(automation): sync from automation-core`
5. CI and the trusted Codex Gate review the fresh sync head; Merge Bot then
   auto-merges it when fully green unless `no-automerge` or a manual
   `needs-owner` stop is present

## How to add a new workflow to all repos

1. Add the workflow file to `workflows/` here
2. Add its filename to `sync-config.json` → `synced_workflows[]`
3. Within 24h all repos will get PRs

## How to remove a workflow from all repos

1. Remove the filename from `sync-config.json` → `synced_workflows[]`
2. Add to `sync-config.json` → `removed_workflows[]`
3. Within 24h all repos will get PRs that delete the file
4. After all are merged, you can remove the entry from `removed_workflows[]`

## How to opt out a specific repo

Create `.automation-core-ignore` in the repo root. Both the weekly
auto-enrollment sweep and the per-repo sync action will skip it.
