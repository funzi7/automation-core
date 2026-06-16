# automation-core

Central source of truth for CI/CD automation across all of @funzi7's repositories.

## What lives here

`workflows/` — generic GitHub Actions workflows synced to every participating repo:
- `codex-auto-fix.yml` — triggers Codex to fix flagged P1/P2 reviews automatically
- `codex-gate.yml` — blocks PR merge until Codex signals (review with no P1, 👍 reaction, or fix Summary after P1)
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
  codex-gate.yml  check-codex-status must pass (no unresolved P1)
          │
          ▼  (all green)
  merge-bot.yml   squash-merges, deletes branch, closes the ci-doctor Issue
```

Every cross-workflow write (Issue create, re-label, merge) uses
`AUTOMATION_PAT` — events made with the default `GITHUB_TOKEN` do not trigger
other workflows (GitHub loop protection), which would silently kill the loop.

### Label dictionary (uniform across all repos)

| Label | Meaning |
|-------|---------|
| `claude-fix` | "Claude, fix this." Set by ci-doctor; triggers Claude Fixer. |
| `automerge` | This PR may be auto-merged by Merge Bot once green. |
| `needs-dima` | Escalation — automation stopped, a human must act. |
| `ci-doctor` | Marks Issues opened by CI Doctor (used for dedup + close). |

### Secrets

| Secret | Required by | Notes |
|--------|-------------|-------|
| `ANTHROPIC_API_KEY` | `claude.yml` | **Required for the fixer.** If absent, Claude Fixer exits green (fail-soft) — no fix, no red runs, ~0 minutes. Set only on the repos you want auto-fixed (cost control). |
| `AUTOMATION_PAT` | `ci-doctor.yml`, `merge-bot.yml`, and `claude.yml` PR creation | **Required for the loop to chain.** Events created with the default `GITHUB_TOKEN` do not trigger other workflows (GitHub loop protection), so Issue/label/merge writes use this PAT. If absent, those workflows exit green (fail-soft) and the loop is inert in that repo. Needs Contents/PRs/Issues write, Metadata read. |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | optional | Escalation pings on `needs-dima` / protected-path blocks. Messages use `parse_mode: HTML` (Markdown underscores broke us before). Skipped silently if unset. |

### fail-soft behaviour

Every workflow's first step checks for its required secret and exits green
with a log notice if it is missing. This is deliberate: these files are
synced to **every** repo, but only repos that opt in (by having the secrets
set) actually run the automation. Key-less repos never produce red failures
and burn essentially no Actions minutes.

### Protected paths

Drop a `.claude-guard.json` in a repo root (see
`template/claude-guard.example.json`) to list globs Merge Bot must never
auto-merge. A PR touching a protected path is escalated to `needs-dima`
instead of merged.

## How to onboard repos

Run the **Bootstrap repos** workflow from the Actions tab.

1. Go to Actions → Bootstrap repos → Run workflow
2. Optional inputs:
   - `dry_run`: true → only list eligible repos, don't open PRs
   - `target_repo`: limit to a single repo (leave empty for all)
3. Workflow opens a PR titled `chore(automation): bootstrap sync from automation-core` in each eligible repo
4. Merge each PR
5. From then on, daily sync is active in that repo

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
5. You review and merge

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

Create `.automation-core-ignore` in the repo root. The sync action will skip it.
