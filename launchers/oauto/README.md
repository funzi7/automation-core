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
| `.env*`, keys, keystores, SSH/GPG material, `.git/`, credential/service-account JSON, `secrets.*`, Terraform state, `.npmrc`/`.pypirc`/`.aws`/`.docker` | `read` deny (permission + policy); the preflight refuses to launch while such files exist anywhere in the worktree (`OAUTO_ALLOW_SENSITIVE_FILES=1` overrides, loudly) and always excludes their diffs from the preflight, deleted files included |
| other models / providers | `provider.use` + `integration.*` policies, per-model `disabled`, scrubbed env, pre-launch `opencode models` check |
| plugins, MCP servers, project config | `plugin.use`/`mcp.use` deny policies, empty `mcp.servers`; preflight refuses repositories with `opencode.json(c)` or `.opencode/` and any `opencode.json(c)` in a parent directory |
| session sharing, auto-update, snapshots, LSP, formatters | `share: disabled`, `update: disable`, `snapshots/lsp/formatter/websearch: false` |
| background service | every call uses `--standalone`; nothing is left running after exit |
| automatic approval | `--auto` is never passed; there is no `ask` rule left to approve |
| concurrent sessions on one repo | per-repository `flock`, taken before anything is rendered and held for the OpenCode process lifetime |

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
