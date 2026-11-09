# oauto — read-only OpenCode reviewer launcher

`oauto <repo>` opens OpenCode on a repository under `/root/work` exactly the way
`cauto`/`clauto` pick the repository, but as a **privacy-restricted, read-only code
reviewer**: the model can read, glob and grep inside the repository and nothing
else. Rationale and the enforcement model: `docs/adr/0002-oauto-read-only-opencode-reviewer.md`.

## Usage (from Termux)

```bash
oauto <repo>            # GLM-5.3-Flash Free reviewer (default)
oauto <repo> deepseek   # DeepSeek V4.1 Flash Free reviewer, a separate session
oauto <repo> --check    # run the whole preflight + verification, print the banner, do not launch
oauto                   # repository menu, same as cauto/clauto
oauto deepseek          # repository menu, then the DeepSeek reviewer
```

Only one oauto session per repository can be open at a time
(`/root/work/.locks/oauto-<repo>-<hash>.lock`); run the DeepSeek pass after the GLM
pass finishes. The first message is pre-filled with a read-only git preflight (branch,
HEAD, upstream, status, capped diffs, recent log) because the reviewer has no shell.
Reviews are static: no tests, builds, linters or ADB.

## What is transmitted

Every model request sends the selected code context, including the preflight diff,
to OpenCode's remote inference service (`https://opencode.ai/inference/...`). The
approved models' published terms (https://opencode.ai/docs/zen/) state zero
retention and no training; that is the provider's term, not something the device can
enforce. Session content is also stored locally in `~/.local/share/opencode/opencode.db`;
treat that directory as sensitive. The preflight is passed as a command-line argument,
so it is visible in `/proc/<pid>/cmdline` to processes of the same user while the
session runs.

## Approved models

| Alias | Model id | Pricing | Published terms (opencode.ai/docs/zen, 2026-11-07) |
|---|---|---|---|
| `glm` (default) | `opencode/glm-5.3-flash-free` | Free ($0 in/out) | zero-retention, no training |
| `deepseek` | `opencode/deepseek-v4.1-flash-free` | Free ($0 in/out) | zero-retention, no training |

Every other model the binary offers is disabled before launch and the launch is
refused unless `opencode models` lists exactly these two. No other provider can be
used or connected (policy), and the environment is scrubbed so no API key reaches
OpenCode.

## What is blocked, and how

| Capability | Mechanism |
|---|---|
| edit / write / patch, shell, webfetch, websearch, subagents, code-mode execute, image generation, browser | `permissions` deny on every agent + `tool.use` deny policies; these tools are not offered to the model at all |
| skills | `skill` permission deny + `skill.use` policy: the `skill` tool stays listed but no skill is visible or loadable |
| reading outside the repository | `external_directory` deny (permission + policy) at tool level; the preflight refuses symlinks that leave the repository, because OpenCode resolves a symlinked read without re-checking |
| aliases of denied paths | the preflight refuses, unconditionally, symlinks whose canonical target is or lies under `.git`/`.ssh`/`.gnupg`/`.aws` (git-annex links included), symlinks to a secret-like file (`n -> config/prod.secrets.yaml`, `c -> .docker/config.json`), symlinks to a directory holding secret-like files (`cfgdir -> secrets/`), hard links to a secret-like file in the repository or to a file of its git dir(s) other than its hooks, any worktree file with more hard-link names (`st_nlink`) than the scan finds in the worktree and `.git` (another name outside the repository cannot be checked and may be a secret: files hard-linked from a package store or a `cp -al` copy outside the repository are refused for this, and so is a link into `.git/objects`, which the scan does not walk), symlinks inside `.git` that leave the repository, a symlinked `.git` and symlinked Git config files, since the alias name would pass the `read` rules; for a linked worktree or submodule checkout (`.git` is a file) the git dir and commondir it names are walked under the same rules (symlinked Git config files refused, their files hard-link alias targets but not names inside the repository, their configs credential-checked), except that ordinary symlinks there are not reported, as nothing in those directories is reachable from the worktree; the one exception is a symlink that is itself an include name of a Git config, which is denied by its own name instead (a directory alias over it is still refused); a hard link on a filesystem that reports `st_nlink` = 1 for it cannot be detected |
| credentials in `gradle.properties` history | a changed `gradle.properties` (or `gradle.properties.<suffix>`, templates exempt; both sides of a rename/copy involving one) whose worktree or branch-delta diff contains a credential-looking assignment on either side — `=`, `:` or whitespace separator, hunk headers included, a heuristic word list (password, passwd, secret, token, passphrase, credential, api/access/secret/signing/private key, inMemoryKey) — is excluded from the preflight (listed), so removing a committed password of those names never sends it; such a file that still carries one refuses the launch unless `OAUTO_ALLOW_SENSITIVE_FILES=1` (files are read in full; one above 16 MiB refuses the launch) |
| credentials in Git config | `.git/config`, `config.worktree`, linked-worktree and submodule configs, and every file git loads from them (git's own `--show-origin` listing plus a conservative parse of `include`/`includeIf` directives git did not apply) are checked for user-info in remote URLs (a bare login name in an `ssh://` URL is exempt; `https://org@...` remotes are flagged), `extraHeader` lines and `Authorization: Bearer/Basic` values; a hit refuses the launch unless `OAUTO_ALLOW_SENSITIVE_FILES=1`. An included file inside the repository is treated as secret-like: refused unless overridden, excluded from the preflight diffs and read-denied by exact name (plus its `*/` form) for that launch, verified through `debug agents`; a name holding `* ? [ { } \` refuses the launch; a referenced file that was deleted is still excluded from the diffs (its removed contents never travel, and its last committed content is read to follow a deleted chain hop by hop, through outside files too; every in-repository target found that way goes back through the scan until nothing new appears, so a present file reached only through history is counted and checked like any other include) without refusing the launch for the deleted ones; an include through a directory symlink whose link and target are both deleted is not resolved; included files outside the repository are followed for further hops but not checked |
| filenames crafted against the scan | pathnames in the scan report are C-quoted and the launcher acts on the report's hit counts, not on extracted text, so a name beginning with a newline cannot hide a hit |
| `.env*`, keys, keystores (PuTTY `.ppk` included), SSH/GPG material, `.git/`, credential/service-account JSON, `secrets.*`, Terraform state, `.npmrc`/`.pypirc`/`.aws`/`.docker`, kubeconfig (`.kube/config`, `*.kubeconfig`), Composer `auth.json`, `.pgpass`, `.my.cnf`, `.s3cfg`, Terraform CLI (`.terraformrc`, `terraform.rc`) and RubyGems (`.gem/credentials`) credentials | `read` deny (permission + policy; the rules match as spelled, the scan and the preflight case-insensitively); the preflight refuses to launch while such files exist anywhere in the worktree (`OAUTO_ALLOW_SENSITIVE_FILES=1` overrides, loudly) and always excludes their diffs from the preflight — deleted, modified, renamed and untracked, whatever bytes the filename contains (NUL-delimited collection, `:(exclude,literal)` pathspecs, exclusion proven before the preflight is written); the other side of a rename/copy that git's exhaustive detection pairs (`-M -C -l0`, refuse on failure) is excluded too, while a safe-named file that merely still contains secret text stays reviewable content and is shown |
| repository-configured git helpers during the preflight (textconv, external diff drivers, clean/smudge/process filters, fsmonitor hook, gpg signature verification, hooks, `core.worktree` redirection, colour escapes) | every preflight git call runs `env -i` with `--work-tree` pinned to the repository, `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `log.showSignature=false`, `submodule.recurse=false`, `color.*` off, emptied `diff.external` and emptied `filter.*` drivers (`required=false`; a driver name containing `=` refuses the launch); every diff carries `--no-ext-diff --no-textconv --no-renames --no-relative --no-color --submodule=short --ignore-submodules=dirty`; `git log` carries `--no-show-signature --no-color` |
| other models / providers | `provider.use` + `integration.*` policies, per-model `disabled`, scrubbed env, pre-launch `opencode models` check |
| plugins, MCP servers, project config | `plugin.use`/`mcp.use` deny policies, empty `mcp.servers`; preflight refuses repositories with `opencode.json(c)` or `.opencode/` and any `opencode.json(c)` in a parent directory |
| session sharing, auto-update, snapshots, LSP, formatters | `share: disabled`, `update: disable`, `snapshots/lsp/formatter/websearch: false` |
| background service | every call uses `--standalone`; nothing is left running after exit |
| automatic approval | `--auto` is never passed; there is no `ask` rule left to approve |
| concurrent sessions on one repo | per-repository `flock`, taken before anything is rendered and held for the OpenCode process lifetime |

Verified before every launch, through OpenCode's own diagnostics (`--standalone`), or
the launch fails closed: `debug config` may list only the oauto directory and document,
and the `policies` ceiling and the `permissions` it loaded from that document must
resolve every probe as rendered (each denied tool, each secret-like read spelling and
the launch's own read denials, the documented exceptions, and the provider,
integration, MCP, skill, plugin and web-search ceilings); `debug agents` must resolve
every agent's permissions the same way; `opencode models` must list exactly the
approved pair.

Known limits: `grep` returns matching lines and its permission resource is the
pattern, not the path, so a secret-like file in the worktree could be surfaced —
hence the preflight refusal. Project `AGENTS.md` files are sent to the model as
instructions. OpenCode downloads ripgrep into `~/.cache/opencode/bin/rg` on first
grep use (one-time, cached). The launcher is pinned to OpenCode **2.2.6**; any other
version fails closed until re-validated. `gradle.properties` stays readable unless it
contains a credential-looking assignment, in which case the launch is refused.

## Files

| Path | Role |
|---|---|
| `launchers/ai-launch` | shared launcher (tracked copy of `/root/work/bin/ai-launch`); the `opencode` mode hands off to `oauto-run` right after repository resolution, before the cauto/clauto banner |
| `launchers/oauto/oauto-run` | lock, preflight, scan, git metadata, config render, diagnostics, exec |
| `launchers/oauto/oauto-policy.py` | one pattern list → renders `opencode.json`, scans the worktree, classifies paths, verifies `debug config` / `debug agents` / `models` output |
| `launchers/oauto/install.sh` | idempotent installer (`--verify` reports drift; replaced files are backed up as `*.backup-before-oauto-<stamp>`) |
| `launchers/oauto/termux/oauto-launch` | Termux entrypoint (`proot-distro login debian -- ai-launch opencode`) |
| `launchers/oauto/termux/bashrc-snippet.sh`, `debian-bashrc-snippet.sh` | `oauto()` shell functions |
| `tests/test_oauto_launcher.js`, `tests/fixtures/` | deterministic contract and behaviour tests driven against `fake-opencode`, a test double of the CLI surface (run by `scripts/validate.sh`) |

Install or refresh on the device: `bash launchers/oauto/install.sh` (then open a new
Termux shell so `.bashrc` is re-read). Per launch, oauto writes only under
`~/.local/state/oauto/<repo>-<hash>/` (preflight, private `xdg-config/opencode/opencode.json`)
and the lock file; `~/.config/opencode` is never read or written.

## Validation record (2026-11-07/08, OpenCode 2.2.6, Debian under PRoot)

The dated entry in `handoffs/loop-build.md` has the complete list of performed tests,
what each proved, defects fixed during validation, and what was not physically tested.
Helper calls must use `--standalone`: without it OpenCode starts its shared background
service (`opencode service stop` removes it).
