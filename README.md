# automation-core

Central source of truth for CI/CD automation across all of @funzi7's repositories.

## What lives here

`workflows/` — generic GitHub Actions workflows synced to every participating repo:
- `codex-auto-fix.yml` — triggers Codex to fix flagged P1/P2 reviews automatically
- `codex-gate.yml` — blocks PR merge until Codex signals (review with no P1, 👍 reaction, or fix Summary after P1)

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
