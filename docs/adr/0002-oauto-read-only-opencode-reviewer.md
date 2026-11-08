# ADR 0002 — `oauto`: a read-only, privacy-restricted OpenCode reviewer launcher

- Status: accepted
- Date: 2026-11-07
- Relates to: `launchers/oauto/`, `launchers/ai-launch`

## Context

The owner's Termux/Debian device launches coding agents through
`/root/work/bin/ai-launch` (`cauto` for Codex, `clauto` for Claude Code, `ai` for
the menu). Those agents run with full tool access and are protected by global
hooks (heavy-build queue, ADB lease, agent-memory Git lock). OpenCode 2.2.6 was
installed in Debian (npm, `/usr/local/bin/opencode`) to add a second, free
reviewer. None of the Claude/Codex hooks apply to OpenCode, and OpenCode 2's
defaults are wide open: every tool is allowed, `external_directory` is allowed,
project-local `.opencode/plugins/*.ts` execute on open, and a project
`opencode.json` outranks the user's global config.

Only two OpenCode Zen free models are approved for the owner's code:
`opencode/glm-5.3-flash-free` and `opencode/deepseek-v4.1-flash-free`. Their
published terms (https://opencode.ai/docs/zen/, read 2026-11-07) say "Its
provider follows a zero-retention policy and does not use your data for model
training"; the same page lists them at $0 input/output. The other free models on
that page carry retention or training clauses and are not approved.

## Decision

`oauto <repo>` is a fourth mode of the shared launcher that hands off to
`oauto-run` after repository resolution. It launches OpenCode as a read-only
reviewer, and every restriction is enforced by OpenCode configuration and
policy, not by the system prompt alone:

1. **Permissions** (OpenCode 2 `permissions` array, last match wins): deny
   everything, then allow only `read`, `glob`, `grep` and `question`; deny
   `read` on secret-like paths (`.env*`, keys, keystores, SSH/GPG material,
   credentials/service-account JSON, Terraform state), re-allow
   `.env.example`-style templates; deny escaping glob patterns; deny `shell`,
   `edit` (covers write/patch), `webfetch`, `websearch`, `subagent`, `skill`,
   `execute`, `external_directory`, image generation and browser. The same
   ruleset is attached to both reviewer agents, and the hidden maintenance
   agents (`title`, `summary`, `compaction`) are deny-all.
2. **Policies** (OpenCode 2 `policies`, a ceiling that only tightens and that
   global config wins over project config): `provider.use` deny `*` then allow
   `opencode`; `integration.connect` deny `*`; `integration.use` allow only the
   free tier; `mcp.use`, `skill.use`, `plugin.use`, `websearch.use` deny `*`;
   `tool.use` denies mirroring the permission denies.
3. **Models**: root `model` and each agent's `model` are the approved IDs; the
   built-in `build`, `plan`, `general` and `explore` agents are disabled; every
   model the binary offers except the approved pair is disabled in
   `providers.opencode.models` — statically for the known free models and
   dynamically at each launch from `opencode models`. `share` is disabled,
   `update` is disabled, `snapshots`, `lsp`, `formatter` and `websearch` are
   off, `mcp.servers` and `skills` are empty.
4. **Launcher preflight, fail closed**: a per-repository lock is taken before
   anything is written; validated binary version only; no system config under
   `/etc/opencode`; no `opencode.json(c)` or `.opencode/` in the repository and
   no `opencode.json(c)` in any parent directory; one scan of the whole worktree
   (nothing pruned, case-insensitive, driven by the same pattern list as the
   `read` denies) refuses secret-like files (grep returns matching lines and
   accepts an explicit path, so a secret in the worktree could reach the model),
   symlinks leaving the repository (OpenCode checks the requested path, not the
   canonical one; targets under `/usr`, `/bin`, `/lib` such as virtualenv
   interpreters are tolerated), aliases of denied paths under a harmless name
   (the alias would be readable by name, so these are refused unconditionally,
   like outward links): symlinks whose canonical target is or lies under
   `.git`, `.ssh`, `.gnupg` or `.aws`, symlinks to a secret-like file
   (`notes.txt -> config/prod.secrets.yaml`, `c -> .docker/config.json`),
   symlinks to a directory that holds secret-like files (`cfgdir -> secrets/`),
   hard links to a secret-like file in the repository or to a file under
   `.git` other than its hooks, symlinks inside `.git` that leave the
   repository (git-annex object links are refused by the `.git` rule), a
   `.git` that is itself a symlink, and Git config files that are symlinks
   (git would write credentials through them into a file readable by name);
   and,
   refused unless `OAUTO_ALLOW_SENSITIVE_FILES=1` is set, credential-looking
   content in `gradle.properties`-style files (`CONTENT_CHECKS`: basename
   equal to the key or key plus a suffix, template suffixes exempt; `=`, `:`
   or whitespace separators; a heuristic word list — password, passwd,
   secret, token, passphrase, credential, and api/access/secret/signing/
   private key with `_`, `.`, `-` or no separator, plus `inMemoryKey`; files
   are read in full and one above 16 MiB is refused rather than skipped) or in
   Git config files (`.git/config`, `config.worktree`, linked-worktree and
   submodule configs, and every file git actually loads from them — resolved
   by git's own `config --list --show-origin` in the scrubbed environment,
   complemented by a conservative parse of `include`/`includeIf` directives
   git did not apply: any user-info in a remote URL except a bare login name
   in an `ssh://` URL, so `https://org@dev.azure.com/...` is flagged too;
   `extraHeader` anywhere on a line; `Authorization: Bearer|Basic` values).
   An included file that lives inside the repository is Git configuration
   under an ordinary name: it is reported as secret-like (refused unless
   overridden), excluded from the preflight diffs and denied to the `read`
   tool by extra per-launch rules (the exact relative path and its `*/`
   form, in permissions and `tool.use` policies) that `opencode debug
   agents` must resolve to deny; a path containing `*`, `?`, `[`, `{`, `}`
   or `\` cannot be named exactly and refuses the launch instead. An include
   path is registered for exclusion as soon as it is referenced, so a
   referenced file that was deleted (or renamed away) never sends its
   removed contents either, while only an existing one counts as a
   secret-like file; a missing include's last committed content (at HEAD
   and at the branch delta's merge base) is read through the hardened git
   helper and its own includes are followed the same way — through files
   outside the repository too — and every in-repository target found this
   way is handed back to the scan, which runs again until nothing new
   appears, so a present file reached only through history is counted,
   credential-checked and alias-protected like any other include and a
   deleted chain is excluded hop by hop. Included files outside the repository are followed for
   further hops but not themselves checked; they belong to the user. The scan
   reports pathnames C-quoted and ends with a count summary that the
   launcher decides on, so no filename byte can hide a hit.
5. **Diagnostics before exec**: `opencode debug config`, `opencode models` and
   `opencode debug agents` are run with `--standalone` and parsed; the launch
   proceeds only if the sole config source is the oauto file, exactly the
   approved models are offered, and every resolved agent evaluates each probe
   to its expected effect (`shell`, `edit`, external, `.env`, `.ssh/`,
   `.git/config` → deny; `read src/...`, `glob **/*.kt`, `grep`, `question` →
   allow; hidden agents → deny for everything).
6. **Process hygiene**: `--standalone` (no background service), scrubbed
   environment (`env -i` passing only HOME, PATH, TERM, LANG, TMPDIR, SHELL,
   USER, the private `XDG_CONFIG_HOME`, and COLORTERM/LC_ALL/XDG_*_HOME when set,
   so no API key or `OPENCODE_*` override can widen the model set), the
   per-repository `flock` held by the launcher's parent process for the
   session's lifetime, never `--auto`, never `--worktree`.
7. **Git context without a shell**: the launcher collects branch, HEAD,
   upstream, ahead/behind, status, byte-capped diffs and recent log with
   `GIT_OPTIONAL_LOCKS=0` and time-bounded git calls, excludes every changed,
   deleted or untracked path that the policy classifies as secret-like from the
   diffs (listing only their names), stores the result under
   `~/.local/state/oauto/<repo>-<hash>/` and passes it as the first prompt. The
   model never runs git.
8. **The preflight itself runs no repository-controlled code and preserves
   exact pathnames** (amended 2026-11-08 after Codex review of PR #58): every
   git call runs in a scrubbed environment (`env -i`, so no `GIT_DIR`,
   `GIT_EXTERNAL_DIFF` or `GIT_CONFIG_*` redirection) pinned to the resolved
   repository with `--work-tree` (a `core.worktree` in `.git/config` cannot point
   the diff at another directory), with `core.fsmonitor=false`,
   `core.hooksPath=/dev/null`, `log.showSignature=false` (`git log
   --no-show-signature`), `submodule.recurse=false`, every `color.*` forced off
   (`--no-color`), `diff.external` emptied and every configured
   `filter.<name>.{clean,smudge,process}` driver — the empty driver name
   included — emptied with `required=false` (a driver name containing `=`
   cannot be addressed by `git -c`, so the launch is refused); every diff —
   name collection, `--stat`, worktree and branch delta — carries
   `--no-ext-diff --no-textconv --no-renames --no-relative --submodule=short
   --ignore-submodules=dirty` (no child `git` runs inside a submodule with the
   submodule's own config). Changed paths are collected
   NUL-delimited (`-z`) into private files, never through command
   substitution, classified bytes-exact, excluded with `:(exclude,literal)`
   pathspecs, listed C-quoted, and the exclusion is proven by re-listing the
   diff with the pathspecs before anything is written. The diffs themselves
   show renames as delete + add, so a renamed secret's source is always
   classified under its own name and excluded. One separate pass runs git's
   exhaustive rename/copy detection (`-M -C -l0`: limits pinned so repository
   config cannot throttle it; the launch is refused if that pass fails or
   times out) and additionally excludes the *other* side of every pair it
   reports when either side is secret-like. That destination-side exclusion
   is best effort by nature: it holds when git pairs the files (identical or
   ≥50 % similar content); a safe-named file that merely still contains
   secret text is reviewable content under name-based classification, and
   its hunks are shown. The one content-based exception is the
   `CONTENT_CHECKS` set (`gradle.properties` and `gradle.properties.<suffix>`
   names, template suffixes exempt): a changed file of that name — and both
   sides of any rename or copy pair that involves one — has its worktree and
   branch-delta diffs checked for credential-looking assignments on either
   side, hunk-header context included, and a hit excludes the file from the
   preflight (listed as `credential-looking content in its diff`), so
   removing a committed credential never sends the removed line.

The config is rendered at every launch into a private directory,
`~/.local/state/oauto/<repo>-<hash>/xdg-config/opencode/opencode.json`, selected
through `XDG_CONFIG_HOME`; OpenCode then neither loads nor touches
`~/.config/opencode`, two sessions on different repositories share no file, and
the launcher checks after the diagnostics that nothing else appeared in that
directory. Two primary agents exist, `review-glm` (default) and
`review-deepseek`; the alias argument selects which one is the default, so a
DeepSeek pass follows a GLM pass without any other model becoming selectable.

## Consequences

- Reviews cannot run tests, builds, linters or ADB: static review only. Heavy
  builds and device work stay with `cauto`/`clauto` under the existing hooks.
- Every model request still transmits the selected code context, including the
  preflight diff, to OpenCode's remote inference service. Zero retention is the
  provider's published term, not a local guarantee; the banner says so.
- Repositories that contain OpenCode project config, outward symlinks or
  secret-like files are refused; the secret-file refusal can be overridden
  explicitly with `OAUTO_ALLOW_SENSITIVE_FILES=1` (their diffs stay excluded
  from the preflight regardless), the others cannot. Large worktrees are scanned
  in full; `OAUTO_SCAN_BUDGET` (seconds, default 180) bounds the scan and the
  launch fails closed when it is exceeded.
- The launcher is pinned to OpenCode 2.2.6. Upgrades change permission
  semantics (2.x already renamed `permission`/`bash`/`task`), so a new version
  must be re-validated and the pin bumped deliberately.
- `grep` is content-returning and path-unrestricted by OpenCode design; the
  preflight refusal is the mitigation. Ripgrep itself is downloaded by OpenCode
  into `~/.cache/opencode/bin/rg` on first use (one-time, now cached).
- The `skill` tool stays in the model's tool list, but every skill is denied by
  permission and policy, so none is visible or loadable (`Unable to load skill`).
- Project `AGENTS.md` files are sent to the model as instructions; the reviewer
  must treat them as untrusted repository content.
- The preflight travels as a command-line argument, so it is visible in
  `/proc/<pid>/cmdline` to processes of the same user for the session's lifetime.
- Because clean/smudge filters are neutralised for the preflight, files tracked
  through such a driver (git-lfs style) diff raw — pointer blob against worktree
  content — and may show as modified in the preflight; they are not reviewable
  content anyway. Rename detection in the diffs is off, so a moved file appears
  as a deletion plus an addition. Classification is by path, not by content:
  moving a secret into a safe-named file and editing it beyond git's
  similarity threshold leaves a reviewable file that still contains the
  secret, and the preflight shows it like any other added file (the worktree
  scan cannot see it either). Submodules whose only change is a dirty
  worktree are not reported (`--ignore-submodules=dirty`); changed submodule
  commits still are.
- `git diff` against the worktree refreshes stat information in `.git/index`
  when entries are stat-dirty (`GIT_OPTIONAL_LOCKS=0` stops `git status` from
  doing so, not `git diff`); no content, ref or hook runs from it, but the
  preflight is not byte-for-byte free of writes under `.git/`.
- No code-editing OpenCode mode exists; adding one is a separate decision.
