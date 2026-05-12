#!/bin/bash
# bootstrap.sh — Add sync-automation-core.yml to all of funzi7's repos
#
# Usage: GITHUB_TOKEN=ghp_xxxxx ./bootstrap.sh
#
# Requirements: gh CLI installed and authenticated, jq

set -euo pipefail

if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ERROR: GITHUB_TOKEN env var required (needs repo scope)"
  exit 1
fi

OWNER="funzi7"
SOURCE_REPO="automation-core"
TEMPLATE_PATH="template/sync-automation-core.yml"
WORKFLOW_DEST=".github/workflows/sync-automation-core.yml"
BRANCH="chore/bootstrap-automation-core"

# Get template content from source repo
TEMPLATE_URL="https://raw.githubusercontent.com/$OWNER/$SOURCE_REPO/main/$TEMPLATE_PATH"
TEMPLATE_CONTENT=$(curl -fsSL "$TEMPLATE_URL")

# Get all repos for funzi7 (excluding source repo itself)
echo "Fetching repos..."
REPOS=$(gh repo list "$OWNER" --limit 200 --json name,isArchived,isFork --jq '.[] | select(.isArchived == false and .isFork == false) | .name')

for REPO in $REPOS; do
  # Skip the source repo
  if [ "$REPO" = "$SOURCE_REPO" ]; then
    continue
  fi

  echo ""
  echo "--- Processing $REPO ---"

  # Check if workflow already exists
  if gh api "repos/$OWNER/$REPO/contents/$WORKFLOW_DEST" --silent 2>/dev/null; then
    echo "Already has sync workflow, skipping."
    continue
  fi

  # Check if .automation-core-ignore exists
  if gh api "repos/$OWNER/$REPO/contents/.automation-core-ignore" --silent 2>/dev/null; then
    echo "Has opt-out file, skipping."
    continue
  fi

  # Clone, add file, push branch, open PR
  TMP=$(mktemp -d)
  pushd "$TMP" > /dev/null

  git clone --depth 1 "https://x-access-token:$GITHUB_TOKEN@github.com/$OWNER/$REPO.git" repo 2>&1 | tail -3 || {
    echo "Clone failed, skipping."
    popd > /dev/null
    rm -rf "$TMP"
    continue
  }

  cd repo

  # Detect default branch
  DEFAULT_BRANCH=$(git symbolic-ref --short HEAD)

  git checkout -b "$BRANCH"

  mkdir -p .github/workflows
  echo "$TEMPLATE_CONTENT" > "$WORKFLOW_DEST"

  git config user.email "automation@funzi7.dev"
  git config user.name "automation-core bootstrap"

  git add "$WORKFLOW_DEST"
  git commit -m "chore(automation): bootstrap sync from automation-core

Adds daily sync workflow that pulls CI automation from
https://github.com/$OWNER/$SOURCE_REPO

Opt out by creating .automation-core-ignore at repo root."

  git push origin "$BRANCH" 2>&1 | tail -3 || {
    echo "Push failed, skipping."
    popd > /dev/null
    rm -rf "$TMP"
    continue
  }

  gh pr create \
    --repo "$OWNER/$REPO" \
    --base "$DEFAULT_BRANCH" \
    --head "$BRANCH" \
    --title "chore(automation): bootstrap sync from automation-core" \
    --body "Adds daily sync workflow that pulls CI automation from [automation-core](https://github.com/$OWNER/$SOURCE_REPO).

After merge, this repo will receive automatic PRs whenever automation-core updates the synced workflows.

To opt out, create \`.automation-core-ignore\` at the repo root." 2>&1 | tail -3 || {
    echo "PR create failed."
  }

  popd > /dev/null
  rm -rf "$TMP"

  echo "Done: $REPO"
done

echo ""
echo "Bootstrap complete. Review and merge the PRs across your repos."
