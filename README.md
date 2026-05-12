# automation-core

Central source of truth for CI/CD automation across all of @funzi7's repositories.

## What lives here

`workflows/` — generic GitHub Actions workflows synced to every participating repo:
- `codex-auto-fix.yml` — triggers Codex to fix flagged P1/P2 reviews automatically
- `codex-gate.yml` — blocks PR merge until Codex signals (review with no P1, 👍 reaction, or fix Summary after P1)

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
