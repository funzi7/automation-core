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
   `read` on secret-like paths (`.env*`, keys, keystores, PuTTY keys, SSH/GPG
   material, credentials/service-account JSON, Terraform state, and the
   credential files of kubectl, Composer (`auth.json`), PostgreSQL
   (`.pgpass`), MySQL (`.my.cnf`), s3cmd, the Terraform CLI and RubyGems;
   these rules match as spelled, so common case variants such as
   `serviceAccount` are listed, while the scan and the preflight match
   case-insensitively), re-allow
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
   anything is written; before any git command runs, `check-repo-git` refuses a
   repository whose `.git` is not a real directory or a `.git` file this worktree
   owns (added 2026-11-09 after the whole-repo audit found a crafted `.git`
   file, `gitdir: <other repo>/.git`, would make every preflight git command run
   against another local repository and leak its content): the `.git` file is
   parsed exactly as git does (content starts `gitdir: `, only trailing CR/LF
   stripped so a trailing space stays part of the path) and the named git dir
   must be either this linked worktree's admin dir — its `gitdir` back-pointer
   resolves to this `.git` file and it is `<realpath(commondir)>/worktrees/<name>`
   — or this submodule's git dir — a `modules` path component and a last
   `core.worktree` (resolved relative to the git dir) that is this worktree; a
   symlinked, malformed, missing or otherwise foreign `.git` is refused (a moved
   worktree is told to run `git worktree repair`); a real `.git` directory that
   carries a `commondir` file is refused as well — git honours that file in any
   git dir and would take refs, objects and config from the directory it names
   (Codex P1 on `33c0dda`, 2026-11-09) — and a submodule git dir is accepted
   only without one; the scan applies the same
   parser so it never walks a decoy git dir. Then: validated binary version only;
   no system config under
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
   hard links to a secret-like file in the repository or to a file of its git
   dir(s) other than its hooks (refused even under a secret-like alias name,
   which no `read` rule the file itself is denied by would catch), any worktree
   file that has more hard-link
   names (`st_nlink`) than the scan accounts for in the worktree and `.git`
   (another name outside the repository cannot be checked and may be a secret,
   so a file hard-linked from a package store or a `cp -al` copy outside the
   repository is refused; the object store is not walked in full, but when a
   worktree file would otherwise be unaccounted its object-store partners are
   counted, so a self-clone or git-annex thin mode — which hard-link worktree
   files to objects — is accepted, those being names inside the repository, not
   aliases; a filesystem that reports one link for a hard-linked file defeats
   this),
   symlinks inside `.git` that leave the
   repository (git-annex object links are refused by the `.git` rule), a
   `.git` that is itself a symlink, and Git config files that are symlinks
   (git would write credentials through them into a file readable by name). A
   directory that cannot be listed is reported as `SKIPPED` and fails the scan
   closed (exit 3), so a hidden subtree never reads as a clean worktree.
   For a `.git` file (linked worktree, submodule checkout) the git dir and
   commondir it names are walked under the same per-file rules — symlinked
   Git config files refused, their files alias targets for hard links (not
   names inside the repository), their config files credential-checked —
   but ordinary symlinks there are not reported, since nothing in those
   directories is reachable from the worktree;
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
   outside the repository too; every historical include path is walked
   through the tree at that revision like a path lookup (`git ls-tree` per
   component): a committed symlink — file or directory, mode `120000`, its
   blob the target, read byte-exact so a trailing newline stays part of the
   name — is replaced by its target before the next component is
   looked at, so `..` applies after the link it follows (`conf/../b.cfg`
   follows `conf` first), an absolute target inside the repository, a
   relative one that leaves and re-enters it, or any outside path that the
   live filesystem resolves back into the repository (an outside alias
   directory pointing at it) continues inside — outside paths are resolved
   NUL-terminated (`realpath -z -m`, read with `read -d ''`) so a pathname
   ending in newline bytes is kept byte-exact (Codex P1 on `3833718`) — and
   more
   than 40 hops (the kernel's ELOOP), an empty target or a result at the
   repository root fail closed; the file reached is excluded and followed,
   never parsed as config text, and its own relative includes are resolved
   against the path git opened — the referenced name, carried as the
   traversal context, not the directory the link led to — with a content
   path reached under two contexts followed under both; an include directive
   whose own spelling keeps `.`/`..` components (`path = conf/../b.cfg`, in
   `.git/config` or in any config met live or in history) is handed to the
   same walk uncollapsed instead of being normalised first (Codex P1s on
   `0ca1844`, `2c743cf`, `9e8a88d`, `bdc6cef`, `0bc9c29` and `d64744c`,
   2026-11-09) — and every in-repository target found this
   way is handed back to the scan, which runs again until nothing new
   appears (include targets are tracked under their referenced name and
   their canonical target, and traversal is keyed by the referenced path,
   so a symlinked include or bridge is followed the way git resolves it; a
   symlink that is itself an include name is denied by its own name rather
   than refused as an alias, and a directory alias over such a link is
   refused like any alias of a denied path),
   so a present file reached only through history is counted,
   credential-checked and alias-protected like any other include and a
   deleted chain is excluded hop by hop (a chain that passed through a
   directory symlink deleted together with its target is resolved when the
   link was committed — its tree entry has mode `120000`, so the walk
   continues at the link's target — and stays unresolved only for a
   never-committed link; include paths are registered under their written
   name as well as their resolved one, so a directory symlink retargeted
   after the commit still leads history to the committed link (Codex P1 on
   `4dc70dd`); a
   repository with such chains can take up to eight scan passes, each
   within the scan budget, before the launch fails closed). Included files outside the repository are followed for
   further hops but not themselves checked; they belong to the user. The scan
   reports pathnames C-quoted and ends with a count summary that the
   launcher decides on, so no filename byte can hide a hit.
5. **Diagnostics before exec**: `opencode debug config`, `opencode models` and
   `opencode debug agents` are run with `--standalone` and parsed; the launch
   proceeds only if the sole config source is the oauto file, exactly the
   approved models are offered, and every resolved agent evaluates each probe
   to its expected effect (`shell`, `edit`, external, `.env`, `.ssh/`,
   `.git/config` → deny; `read src/...`, `glob **/*.kt`, `grep`, `question` →
   allow; hidden agents → deny for everything). The document as `debug
   config` reports it loaded is verified too (amended 2026-11-09): the
   `policies` ceiling and the top-level `permissions` it loaded must equal the
   arrays oauto rendered **verbatim** — exact, order-sensitive list equality,
   so a removed, reordered or appended rule fails closed even when no probe
   samples it (a lone key pattern, a foreign provider or integration) — after
   which the probes replay as a semantic cross-check: the ceiling denies every
   denied tool, every secret-like read probe and the launch's own read denials
   (exact path and `*/` form), allows the documented exceptions and the
   `opencode` provider, denies the other providers, `integration.connect`,
   MCP, skills, plugins and web search, and leaves the reviewer's own tools to
   the permissions, while the permissions resolve the same probes as the agents.
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
9. **PR review mode** (`oauto <repo> pr`, owner-approved 2026-11-09 as option
   1: the default behaviour above is kept unchanged — a test compares its
   preflight, prompt, banner and config with those of `1e6fbd0` — and PR review
   is a separate, explicit mode, with `pr` and the model alias in either order,
   `--check` included, and `oauto pr` / `oauto deepseek pr` before the
   repository menu). After the lock, `check-repo-git` and the hardened git
   helpers, and before the scan, the launcher identifies the pull request
   outside the model's tool execution: the GitHub repository from
   `remote.origin.url` (only `https://github.com/<o>/<r>[.git]`,
   `git@github.com:<o>/<r>[.git]` and `ssh://git@github.com/<o>/<r>[.git]`; the
   URL reaches the policy on stdin and is never printed), then one
   authenticated, read-only REST call,
   `gh api repos/<o>/<r>/pulls?state=open&head=<o>%3A<branch>&per_page=10`
   (`timeout 60`; `env -i` keeping only HOME, PATH, `GH_PAGER=cat`,
   `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `TERM=dumb`), run from `/`:
   `gh api` rewrites `:owner`, `:repo`, `:branch` and `{…}` in an endpoint by
   running git in its working directory (amended 2026-11-09 after the independent
   review found `head=<o>:branch-x` sent as `head=<o>branch-x-x` and gh's git run
   inside the reviewed repository), so the endpoint holds no `:`, `{` or `}` —
   the branch percent-encoded, the filter's colon `%3A`, anything else refused —
   and gh never runs in the repository. `oauto-policy.py
   pr-select` accepts exactly one open pull request whose head is the current
   branch of that repository (not a fork) at the local HEAD and whose base is a
   branch of it, and hands back only number, `html_url`, base ref, base sha and
   head sha; the response file is deleted. The base must exist locally as
   `origin/<base>` — unambiguous, with a merge base with HEAD — and the
   existing `base` variable is set to the commit it names, verified once
   (`origin/<base>` is only the label shown, so a branch or tag of that name
   appearing mid-run cannot redirect a diff), so the existing pipeline (name
   collection, exhaustive rename pairs, classification, content checks,
   exclusion proof, caps, `--stat` and diff) produces the pull request's delta:
   no second implementation. Every doubt fails closed with its reason before
   anything is scanned or rendered and never falls back to the default review;
   a GitHub base sha that differs from the local ref is stated in the preflight,
   whose merge base comes from the local ref; HEAD or the base ref moving while
   the preflight is collected refuses it. The launcher never fetches, pulls,
   checks out, switches, updates a ref or creates a worktree. The prompt names
   the pull request and asks for its delta to be reviewed (uncommitted changes
   separately); the banner adds `Mode  : pull request #<n> → origin/<base>
   (merge base <sha12>)`. Scan, history traversal, exclusions, caps, rendered
   config, permissions, policies, models and lock are the default mode's.

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
  preflight refusal is the mitigation.
- The escaping-glob `glob` denies are defence in depth (verified on the real
  2.2.6 binary, 2026-11-09): the `glob`/`grep` pattern is handed to ripgrep as
  a `--glob` filter rooted at the tool's `path`, and `path` is resolved through
  `FileAccess.resolve`, which raises `external_directory` for anything outside
  the project directory and treats a backslash as a literal filename character
  on POSIX. A backslash-written pattern therefore passes the deny list and still
  cannot list or read anything outside the repository; no backslash rule was
  added (fix only what is reproducible). An OpenCode upgrade re-opens this
  together with the `VALIDATED_VERSION` pin. Ripgrep itself is downloaded by OpenCode
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
- PR review mode (item 9) reads the GitHub API once per launch with the owner's
  `gh` login, sending the repository and branch name to `api.github.com`, and it
  reviews the local `origin/<base>`: a stale base gives a stale delta, stated in
  the preflight when GitHub's base differs, because the launcher never fetches; a
  local HEAD that is not the pull request's head (unpushed, or behind) refuses the
  launch. The model receives the pull request's delta instead of the upstream
  delta, plus its number, URL and shas.
- No code-editing OpenCode mode exists; adding one is a separate decision.
