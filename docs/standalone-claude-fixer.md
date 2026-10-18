# Standalone Claude Fixer: opt-in preparation

This change is a draft implementation, not a rollout. It does not change any
repository variable, secret, linked Console organization, credit balance, or
downstream PR. Merging the upstream workflow can distribute it through
the existing daily sync, so upstream merge and downstream activation require a
separate rollout decision.

## Eligibility and billing boundary

The [Anthropic credit documentation](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)
states that a self-run `claude -p` process using an API key from the linked Console
organization is eligible; runs started by the Claude Code GitHub Action are not.
The generic fixer therefore installs the exact official npm package
`@anthropic-ai/claude-code@2.1.288`, places its pinned native binary with the package's
installer, verifies the version, and starts it directly. It does not run the
Claude Code Action or spoof its attribution.

The model process receives the existing `ANTHROPIC_API_KEY`, isolated HOME/config
state, and an allowlisted environment. It does not inherit subscription OAuth,
provider-routing overrides, action attribution, hooks, project settings, plugins,
or MCP discovery. No key or account setting is created or changed here. A key's
organization and actual promotional-credit debit cannot be proved by offline
code/tests; an operator must verify those separately before approving a live run.

`CLAUDE_MAX_BUDGET_USD` defaults to 2 and accepts 0.1–10. The CLI also stops after
50 turns and has a 15-minute process timeout (25-minute job timeout). The dollar
value is an estimated stopping threshold, **not a hard billing cap**. Requests
already in flight can cost money, and other clients share the organization's
balance. Purchased credit, auto-reload or invoiced usage can continue after the
promotion is depleted. None of those billing settings is changed here.

## Two existing trust modes

### Issue / new PR

- Read the live target and trusted linked-PR provenance. Closed, draft, or paused
  targets never start model work. API errors fail closed.
- Capture one live default-branch SHA, then check out exactly that SHA without
  persistent credentials.
- Copy tracked regular files into an isolated read-only-model workspace; omit
  git metadata, symlinks, submodules and Claude/MCP configuration. The model has
  only Read/Glob/Grep with the pinned CLI’s `--restricted` working-directory
  read fence, no shell, interpreter, generic write tool or GitHub token.
- Replace the removed Action's constrained file-ops MCP with a bounded structured
  text edit plan: up to 30 files and 1 MiB of replacement text. Reject traversal,
  symlinks, special paths, duplicate edits, NUL content, absent deletions and
  malformed output. Executable tests remain the PR CI boundary, as before.
- After the model exits and credentials are scrubbed, re-read pause state and use
  the short-lived repository token to create a unique `claude/issue-N-RUN-ATTEMPT`
  branch. A GitHub `createCommitOnBranch` mutation pins `expectedHeadOid`, and its
  GitHub signature must verify before delivery is accepted. This preserves
  [GitHub-signed commits](https://github.blog/changelog/2021-09-13-a-simpler-api-for-authoring-commits/).
- A later trusted PAT-backed step creates the PR, waking CI. Actions-owned
  `claude-generated` provenance and the Issue linkage remain durable. Successful,
  verified delivery alone may obtain the existing `automerge` label.

The replacement intentionally accepts text edits only, not arbitrary binary or
filesystem operations. A malformed/oversized plan or permission failure requires
human attention rather than broadening tools. Branches are unique per invocation;
existing incomplete branches are never silently adopted or overwritten.

### Existing same-repository PR

Owner-authored mentions retain the established broader edit/local-test tool
allowlist and the same PAT/default-token fallback. Fork PRs are rejected. The
checkout does not persist a token; only this model process receives GH_TOKEN with
an ephemeral git credential-helper configuration. It can validate, commit and
push only as permitted by the existing PR-mode trust boundary. This is not a
sandbox against hostile same-repository code; its shell/interpreter permissions
are unchanged. The new launcher never grants bypassPermissions or new tools.

Immediately before starting, fetch fresh labels/draft status and require the
exact checked-out head. The Issue model never shares this credential environment.
The Issue read fence is a CLI permission boundary, not OS/container isolation.
Both modes keep transcripts off public logs; the former full-output opt-in is
intentionally removed. Delivery classification exposes only a sanitized category.

## Sync review safety addition

The same draft also removes the trusted-sync 30-minute Codex-silence exception.
A sync PR stays pending without valid exact-current-head review, regardless of
age or absence of findings. Merge Bot independently checks that evidence at both
candidate evaluation and the final merge boundary, so a stale grace-green check
cannot authorize merging. Its ordinary automatic merging remains in place once
review, checks and the existing stop-label/protected-path conditions pass.
Existing explicit administrator overrides and opt-in fallback review semantics
are unchanged. No new manual merge-approval label is introduced.

## Per-target pause

Add either `no-autofix` or `review-only` to the PR (create the label first if the
repository does not yet have it). Either label stops new automatic fixer starts:

- Codex Auto-Fix refuses to post a new trigger, including a final live recheck.
- Claude Fixer checks live state at admission and immediately before invocation.
- The fallback watchdog skips its fixer ladder and automatic branch updates.
- Codex backup refuses model generation and rechecks before patch application.
- Issue-mode publishing and PR creation recheck pause state after the model.

Draft and closed PRs are also paused. The same labels work on source Issues, and
a trusted linked Claude PR pause blocks an Issue-origin retry. Removing a pause
does not automatically rerun a missed event; a fresh authorized trigger is needed.
Reviews and existing review-evidence gates remain enabled.

`no-automerge` remains a merge-only hold. It does not pause fixers. Conversely,
`no-autofix`/`review-only` does not change merge eligibility: use `no-automerge` too
when the PR must not merge under the repository's existing policy.

This is a start/delivery guard, not retroactive cancellation or an atomic lock
with GitHub label edits. A PR-mode process already running with push credentials
may finish after a label is added. For an immediate stop, the operator must also
cancel active runs and verify that they have stopped. The workflow never promises
that a mid-flight label can retract API costs or already-pushed commits.

## Explicit activation and distribution

Both the generic CLI and the Codex-to-Claude bridge require
`CLAUDE_STANDALONE_ENABLED=true` on each repository. Unset/false is disabled even
when the API key exists. `CLAUDE_ENABLED=false` continues to stop the CLI. Variables
are not synced and this PR does not set them. Before rollout, verify the API key's
linked organization, cost controls, pause labels and unchanged protected-path
policy, then obtain approval for a bounded live smoke test. Offline success alone
is not evidence that production authentication, billing or API commit signing
has worked.

The existing sync still copies the same eight workflow files. There is no runtime
fetch of a mutable helper and no dependency on a helper in an untrusted PR head.
`tools/claude_fixer_runtime.js` is the authored/tested source;
`python3 scripts/embed_claude_runtime.py` embeds it into both Claude workflow
copies. `--check` in CI rejects stale embedding or mirror drift. The workflow
writes that trusted embedded code into RUNNER_TEMP before checkout.

## Offline verification

Run `bash scripts/validate.sh`. Tests use fake CLI output and mocked GitHub calls;
no API model request is made. Coverage includes isolated environment/arguments,
malicious edit paths and symlinks, terminal-result failures, pause state and
trusted linkage, exact-head signed publishing, and source/mirror/embedding parity.
The pinned real binary was checked with `--version` and `--help` only. A live model
call, actual GitHub signed delivery and promotional-credit consumption remain
unverified until a separately approved smoke test.
