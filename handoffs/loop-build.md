# loop-build — Claude Code ⇄ Claude Chat handoff log

Handoff log for the self-healing-loop build. Newest entry is first. Historical entries below are retained as incident context only; when they describe behavior that differs from the current architecture, they are explicitly marked HISTORICAL or SUPERSEDED and defer to `LOOP_STATE.md` and `handoffs/CONTEXT.md` for current operating instructions.

---

## [2026-11-08 UTC] oauto — Codex P1 round: helper-free git preflight, exact pathnames, no rename hiding
- PR: <https://github.com/funzi7/automation-core/pull/58> (same PR as the entry below; fixes pushed to its branch)
- Branch: `claude/oauto-opencode-reviewer`
- Status: Codex P1 findings fixed with regression tests; see "Review and gate state" at the end of this
  entry for the re-review outcome.
- What Codex found (review of commit `d17f3a1`, 2026-11-08T00:23Z, three P1 inline threads on
  `launchers/oauto/oauto-run`):
  - P1-A `--no-ext-diff`/`--no-textconv` missing: a repository's `.gitattributes` + `diff.<driver>.textconv`
    (or an external diff driver) executed during the preflight's `git diff` calls, before OpenCode's
    restrictions apply; Codex reproduced a helper creating a file outside the repository while `--check`
    succeeded.
  - P1-B C-quoted pathnames: `git diff --name-only` munged a deleted tracked `prod<TAB>.env` into
    `"prod\t.env"`, so classification never saw the real path and the deleted secret reached `preflight.md`.
  - P1-C rename detection: `git mv .env safe.txt` plus a sanitised destination made `--name-only` report
    only the destination, the sensitive source was absent from the exclusion pathspecs, and the removed
    secret appeared in the diff.
- What changed (`launchers/oauto/oauto-run`, `launchers/oauto/oauto-policy.py`, tests, docs):
  - Every preflight git call now runs `timeout 120 env -i` (HOME, PATH, LANG, TMPDIR, `GIT_OPTIONAL_LOCKS=0`,
    `GIT_TERMINAL_PROMPT=0`, LC_ALL/TZ when set — no `GIT_DIR`/`GIT_WORK_TREE`/`GIT_EXTERNAL_DIFF`/
    `GIT_CONFIG_*` from the caller), `git -C "$REPO" --work-tree="$REPO"` (a `core.worktree` in
    `.git/config` cannot redirect the diff to another directory), with `core.fsmonitor=false`,
    `core.hooksPath=/dev/null`, `log.showSignature=false`, `submodule.recurse=false`, `color.ui/diff/
    status/decorate=never`, `diff.external=` and, for every `filter.<name>` driver found by
    `git config --get-regexp` (the empty driver name included), `clean=`/`smudge=`/`process=`/
    `required=false`; a driver name containing `=` cannot be addressed by `git -c` and refuses the launch.
    Every diff goes through one helper carrying `--no-ext-diff --no-textconv --no-renames --no-relative
    --no-color --submodule=short --ignore-submodules=dirty`; `git log` carries `--no-show-signature --no-color`.
  - Changed paths are collected NUL-delimited (`--name-only -z`, `ls-files -z`) into 0600 temp files inside
    the state directory, never through command substitution; `oauto-policy.py classify -z --renames
    --display` classifies the exact bytes (decoded only for matching, surrogateescape), excludes both
    sides of every rename/copy pair when either side is secret-like, writes a C-quoted display list
    (git's `core.quotePath` rules, ASCII only) and fails closed on any empty, truncated or unknown record;
    the launcher builds `:(exclude,literal)` pathspecs with `read -r -d ''` and then PROVES the exclusion
    (`check-excluded`: the name diffs re-run with the pathspecs may list no excluded and no secret-like
    path) before `preflight.md` is written. Temp files are removed (EXIT trap covers failures).
  - Diffs never use rename detection; the single `-M --name-status -z` pass exists only to find pairs
    for the both-sides exclusion. The excluded list shows e.g. `safe.txt (renamed from ".env")`.
  - `tests/fixtures/fake-opencode` gained a `PROMPT_FILE` control so tests can assert on the whole
    `--prompt` argument. ADR 0002 gained decision item 8 and two consequences; `launchers/oauto/README.md`
    "What is blocked" gained the helper row; LOOP_STATE item 8 / "Device launchers" and CONTEXT A1 updated.
- Regression tests (`tests/test_oauto_launcher.js`, now 29 tests; the launcher is driven end to end against
  the test double, so the exact bash code paths run): `P1-A` (textconv, external diff, driver command,
  clean/process filter incl. the empty driver name and a submodule-local filter, fsmonitor hook,
  `post-index-change` hook via `core.hooksPath`, `gpg.program` reached through a crafted `gpgsig` commit,
  caller-environment `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_COUNT`; a `filter.x=y` driver must be refused);
  `P1-B` TAB name without the sensitive override; `P1-B` newline, non-ASCII, space, quote, backslash,
  leading-dash names, deleted and modified, asserting on `preflight.md`, the recorded `--prompt` and
  `last-helper.err`; `P1-C` staged, pure and reverse renames; `P1-C` branch delta plus a non-sensitive
  rename shown as delete+add; `F` ordinary and special-named non-sensitive changes still appear;
  `core.worktree` redirection and a linked worktree (`.git` file); forced ANSI colour; the NUL interface
  (`classify -z`, `check-excluded`, pairs, quoting, fail-closed cases); source-shape guard for the helpers.
  - Reproduction first: run against the previous launcher, 7 new/changed tests failed (helpers executed;
    TAB, newline, non-ASCII, quote and backslash names leaked; sanitised and reverse renames leaked;
    branch-delta rename leaked; `classify -z` unknown). Not reproducible on the old code and kept as
    guards: case F (by design), pure 100 % renames (the old code printed no hunk for them), and some
    P1-A helpers (external diff, driver command, clean/smudge, post-index-change) because git died on the
    required process filter first — masked, not safe. Removing each new defence one at a time in scratch
    copies made the suite fail every time except for `-c log.showSignature=false` alone, which
    `--no-show-signature` already covers. `color.decorate` and `submodule.recurse` are no-ops for these
    commands in git 2.47 and stay as guards.
- Validation performed (device, git 2.47.3, OpenCode 2.2.6, disposable fixture repositories only):
  - `node --test tests/test_oauto_launcher.js`: 28/29 before the re-install (the device-parity test fails
    until `install.sh` runs; see below), `bash -n`, `git diff --check` clean.
  - Real binary, `oauto-run --check` on fixtures (scratchpad battery, 20 checks): hostile config
    (`diff.probe.textconv/command`, `diff.external`, `filter.probe.clean/process/required`,
    `core.fsmonitor`, `log.showSignature` + `gpg.program`) → exit 0, no helper marker, textual diffs
    present, `config sources ok` / `models ok: exactly [glm, deepseek]` / `agents ok`; six deleted
    special-name secrets (TAB, newline, `naïve`, `"`, `\`, `-dash`) → exit 0 without the override, no
    synthetic value in `preflight.md`, `"prod\t.env"` listed quoted, ordinary change shown; renamed
    secrets on a `feature` branch and staged in the worktree → no original value in the branch-delta or
    worktree sections, no `rename from` anywhere, `safe.txt (renamed from ".env")` listed, non-sensitive
    rename shown as add.
  - Real binary, tool level under the rendered config (`opencode run --standalone`, six remote requests
    with synthetic fixture content): edit/write → denied and no file created; shell → denied;
    `/etc/hostname` → `external_directory` denied; `.env` → `Permission denied`; the probe secret never
    appeared in any transcript; `--model opencode/big-pickle` → unavailable; `--agent build` → not found.
    No fixture, lock or process left behind.
- Independent review (Opus reviewer subagent, not the implementing agent, full PR diff vs `main`,
  attack fixtures under mktemp only): P1-A and P1-B confirmed closed (no helper fired for textconv,
  driver command, external diff, env `GIT_EXTERNAL_DIFF`, clean/smudge/process filters incl. the empty
  name, an `include.path` driver, an env-injected `GIT_CONFIG_*` driver and a submodule's driver,
  fsmonitor, gpg, hooks; `--work-tree` defeats `core.worktree`; `--stat` honours the pathspecs; NUL
  interface fail-closed on every malformed input tried). One P1 in this round's own design
  (CONFIRMED): the destination-side exclusion of a renamed secret rested on a single `-M` pass whose
  rename detection a repository can throttle (`diff.renameLimit=1` + two ≈80 %-similar renames →
  D/A instead of R → the destinations' add-hunks, still holding the secrets, reached `preflight.md`);
  plus the matching test gap (only ≥50 %-similar or pure renames were tested) and the over-claim
  "both sides" in ADR/README. Fixed: the pair pass runs `-M -C -l0` (exhaustive, limits pinned,
  copies included) and the launch is refused if that pass fails or times out; a regression test with
  `diff.renameLimit=1` reproduces the leak on the previous code; ADR item 8, its consequences and the
  README row now state the real contract — the source side is always excluded, the other side of a
  pair git detects is excluded, and a safe-named file that merely still contains secret text (edited
  beyond git's similarity threshold) is reviewable content and is shown. No P2; nothing else found in
  ai-launch, install.sh, lock, config rendering, verifiers or the scrubbed exec.
  Provenance: `review_provider = claude_code_fallback` style independent review in addition to the
  Codex review that opened this round; the Codex re-review of the fixed head is recorded below.
  Follow-up from the same review's caveats: the name-collection and proof passes were `|| true` and a
  transient git failure could have left a secret-like path unexcluded while the content diff still
  succeeded — now fatal (`name_pass_failed`), with a source-shape test.
- Device (Phase 5): `bash launchers/oauto/install.sh` refreshed `/root/work/bin/oauto-run` and
  `oauto-policy.py` after each validated state during the round (previous copies kept as
  `*.backup-before-oauto-20261108-120902`, `-132239`, `-134043`, `-140044`, `-144953`, `-152257`,
  `-154043`, `-160518`, `-163804`, `-171353`, `-174147`, `-183754` and `-192727`; `ai-launch`, the
  Termux `oauto-launch` wrapper and both `.bashrc` blocks were already identical and untouched; the
  original `ai-launch.backup-before-oauto-20261107` still equals the pristine fixture); `install.sh
  --verify` clean; installed copies byte-identical to the tracked ones (device-parity test passes);
  `/root/work/bin/ai-launch opencode oauto-selftest-j [deepseek] --check` through the installed
  launcher resolved the fixture, proved the exclusion (`preflight exclusion ok`), verified
  sources/models/agents (GLM and DeepSeek default agents) and printed the banner; fixture, state dir
  and lock removed; no OpenCode process or service left.
- Final validation at the pushed head: `bash scripts/validate.sh` green (YAML, JSON, sync/mirror parity,
  JS syntax, `node --test` 202/202 including `tests/test_oauto_launcher.js` 75/75, 59 github-script
  bodies, actionlint, `git diff --check`); real-binary battery (scratchpad script, every scenario of
  this entry) passed on the final launcher, and the six live model probes were repeated on it: shell,
  `/etc/hostname`, `.env`, `opencode/big-pickle` and `--agent build` denied as before, probe secret
  absent from every transcript, no file created; the edit probe's first run matched none of the
  expected phrases because the model declined without calling any tool, so it was re-run with a
  tool-listing prompt — the model reported its tools as exactly `glob, grep, question, read, skill`
  and answered `NO-WRITE-TOOL`; nothing was created.
- Not physically tested: the Termux hop itself (unchanged this round; `proot-distro login` cannot run
  from inside the Debian session, so `oauto <repo>` still needs one run from a real Termux shell); a
  review on a real project repository; a full DeepSeek TUI session; a repository using git-lfs
  filters, submodules or linked worktrees against the real binary (covered by the node tests against
  the test double and by real git in the fixtures, not by a real OpenCode session); a pair-pass
  timeout on a huge change set (the refusal path is exercised only by forcing a failure in a scratch
  copy).
- Limitations / risks after this round: classification is by path, so a safe-named file that still
  holds secret text (edited beyond git's 50 % similarity, or copied from an unmodified secret file under
  the `OAUTO_ALLOW_SENSITIVE_FILES=1` override) is shown like any added file; the content-based
  exception covers only the `CONTENT_CHECKS` basenames (SUPERSEDED within this entry: the
  `gradle.properties.bak` rename and hard links to `.git/config` listed here as open at the time
  were closed by the later rounds recorded below — suffixed copies and rename pairs are checked,
  hard links to secret-like files or `.git` files are refused); `git diff` against the
  worktree still refreshes stat data in `.git/index` (no content, ref or hook; `GIT_OPTIONAL_LOCKS=0`
  covers `status` only); changes made to the repository during the second of collection are not
  covered; `-l0` makes the pair pass exhaustive, so a change set with thousands of unpaired deletions
  and additions can hit the 120 s timeout and the launch is refused rather than degraded; LFS-style
  filtered files diff raw; submodule worktree dirtiness is not reported; `color.decorate` and
  `submodule.recurse` are no-ops for these commands in git 2.47 and stay as guards.
- Codex re-review of the first fixed head (`de81444`, requested with `@codex review`, exact-head CI
  green, the three original P1 threads replied to with the fix commits and resolved): two NEW P1s,
  both valid and reproduced by Codex — (D) a worktree symlink aliasing Git metadata or a secret-like
  path under a harmless name (`review-config.txt -> .git/config`) passed the scan (target inside the
  repo; `.git` pruned; only the alias name classified) and, because OpenCode checks the requested
  path, made `.git/config` readable; (E) the `gradle.properties` content check looked only at the
  current worktree, so a change that removed a committed credential line (or deleted the file) sent
  the removed line in the diff. Fixed in this round: the scan refuses, unconditionally like outward
  links, any symlink whose canonical target is or lies under `.git`/`.ssh`/`.gnupg`/`.aws`/`.docker`
  (constant kept in sync with the directory patterns by a test) or whose target is secret-like by
  name, and the `.git/config` content check also flags `extraHeader`/`Authorization` values;
  changed `gradle.properties` paths (any directory) have their worktree and branch-delta diffs
  checked (`check-diff-content`, both sides of every hunk) and a hit excludes the file from the
  preflight, listed as `credential-looking content in its diff`. Regression tests reproduce both
  leaks on the previous code; the real-binary battery gained both scenarios.
- Second independent review (same Opus reviewer, read-only, `git diff de81444`): P1-D and P1-E
  closed as reported (chained links, `..` targets, nested hops, case variants, link loops and the
  override all held; `:(literal)` with special bytes, `--` for leading-dash paths, pipefail death on a
  failing git, and the `check-excluded` proof all held); no P1; 5 P2 and 4 P3, all fixed in the next
  commit: a symlink to a *directory* holding secret-like files (`cfgdir -> secrets/`) renamed the
  directory past the name rules (D1 → refused when any flagged path lies under the target); the
  `.git/config` check missed a token as URL user-info, `extraheader` on a section line,
  `config.worktree`, linked-worktree and submodule configs (D5 → all checked); the `gradle.properties`
  pattern missed `:`/whitespace separators and key-material names (E1 → broadened, no bare `auth`);
  the content check did not follow renames/copies to `.bak`/`.orig` (E2 → prefix rule with template
  exemption, both sides of a pair checked); git's hunk headers carried the credential line (E3 →
  header text checked); hard links to `.git/config` or a secret-like file (D2 → refused); symlinks
  inside `.git` leaving the repo (D4 → refused); `.docker` over-refused harmless links (D3 →
  component set is `.git/.ssh/.gnupg/.aws`, file links by name). ADR item 4/8 and the README rows
  now describe exactly these rules.
- Third pass of the same reviewer on those nine fixes: all hold (root alias, two-level directory
  alias, pnpm hard-linked store, `ssh://git@` vs `ssh://user:pw@`, `gradle.properties.example.bak`,
  partner without a checker, `:`-separated header text); one P2 left — dotted Gradle keys (`api.key`,
  `signing.key`, `access.key`, `private.key`) escaped the pattern → `[_.-]?` separators, test with
  dotted/colon/space forms; P3s: a hook installed as a hard link from the worktree was refused →
  `.git/hooks/` excluded from the hard-link inode set (test); git-annex object links and
  `https://org@dev.azure.com`-style login-name remotes are refused by design (the latter
  overridable) and documented; docs now say "in the repository" for hard links, name the `ssh://`
  exemption, call the word list a heuristic, and say "unless `OAUTO_ALLOW_SENSITIVE_FILES=1`" where
  it applies.
- Codex re-review of the second fixed head (`a174b19`, exact-head CI green, the two P1-D/P1-E
  threads replied to and resolved): one P1 and one P2, both valid and reproduced by Codex — a
  `.git/config` that is itself a symlink to a worktree file (`.git/config -> ../review-config.txt`)
  skipped the credential check while the target stayed readable by name; and the `gradle.properties`
  content check read only the first 262,144 characters, so a credential after 320 KB of comments in
  an untracked file passed. Fixed: a symlinked `.git` or any symlinked Git config file is refused
  unconditionally (`SYMLINK ... (Git config file is a symlink)`), and content-checked files are read
  in full with a 16 MiB ceiling above which the launch is refused (`too large to content-check`).
  Regression tests reproduce both on the previous code; the real-binary battery gained both.
- Codex re-review of the third fixed head (`a23cfec`, exact-head CI green, the previous two threads
  replied to and resolved): two more P1s, both valid and reproduced by Codex — a secret-like file whose
  name begins with a newline printed as `SENSITIVE ` + newline + name, the launcher's line extraction
  yielded an empty line that command substitution dropped, and the launch proceeded without the
  override; and a `.git/config` `include.path` (or `includeIf`) pointing at an ordinary-named worktree
  file made that file Git configuration without any credential check, diff exclusion or read deny.
  Fixed: the scan now prints every pathname C-quoted and ends with a `SUMMARY` line carrying
  `sensitive=`/`symlinks=`/`content=` counts, and the launcher decides on those counts (a missing
  summary fails closed); include directives are parsed conservatively (every `path` under `[include]`
  or `[includeIf ...]`, recursively, loops guarded) and every included file inside the repository is
  credential-checked, reported as `SENSITIVE ... (included Git config)` (refuse unless overridden),
  excluded from the preflight diffs and read-denied by name in the rendered permissions and policies
  (`render --deny-read`). Regression tests reproduce both on the previous code; the real-binary
  battery gained both.
- Fourth pass of the independent reviewer on that round: the quoted-records/count contract held
  against forged names (a filename that is itself a `SUMMARY` line, names with ` -> `, `(`, quotes,
  embedded newlines), malformed or empty summaries, budget exhaustion and the "nothing rendered
  before the scan" property; the include handling held for `~/` into the repo, outside symlinks
  landing inside, submodule configs, `includeIf "gitdir:..."`, quoted values with comments, real
  continuations, deny-read paths with metacharacters, and `check-excluded`. One P2 (CONFIRMED): the
  hand-written include resolver missed files git itself loads — an include that hops through a file
  outside the repository back into it, a `;` comment ending in a backslash (git ends the comment at
  the newline), a UTF-8 BOM before `[include]`, and a linked worktree (`.git` is a file, so no config
  was scanned). Fixed by asking git: the launcher runs `git config --list --show-origin -z` through
  the hardened helper before the scan and every `file:` origin inside the repository is handled as
  an included Git config; the parser stays as a conservative complement for includes git did not
  apply (BOM stripped, comment-continuation fixed, outside hops followed); an included path with
  glob metacharacters refuses the launch rather than relying on matcher semantics; the per-launch
  deny-read rules are also probed through `verify-agents --deny-read`. Regression tests reproduce the
  four misses on the previous code; the battery gained the outside-hop and linked-worktree cases.
- Fifth pass of the reviewer on that fix: no P1/P2; the four cases and their neighbours (commondir
  and `config.worktree` includes in a linked worktree, fake `file:` text inside a multi-line value,
  `.git/../x` origins, a vanished origin file, malformed origin lists and a config syntax error
  both failing closed, an include target that is a symlink, a deny-read path with a space, each
  mechanism alone) all held; the docs matched. Its P3s were taken: the per-launch deny rules now
  also carry the `*/<path>` form so `./x` or absolute spellings are denied too, and `{`, `}` and
  `\` join `*`, `?`, `[` as characters that refuse an included path instead of relying on matcher
  semantics. Behaviour change worth knowing: a repository whose `.git/config` includes a tracked
  file (`include.path = ../.gitconfig`) is now refused unless `OAUTO_ALLOW_SENSITIVE_FILES=1`.
- Codex re-review of the fourth fixed head (`ac10beb`, exact-head CI green, the previous two threads
  replied to and resolved): one P1, valid and reproduced by Codex — a tracked file referenced by
  `include.path` and then DELETED was skipped by the parser's existence check (and git's origin
  listing omits a missing include), so it never reached the exclusion list and its deletion hunk,
  credential included, was in the preflight. Fixed: an in-repository include path is registered for
  exclusion (and per-launch read deny) as soon as it is referenced, before the existence check;
  only an existing file counts as secret-like, so reviewing the deletion of a leaked config does not
  refuse the launch and does not transmit the removed contents. Regression tests cover the worktree
  deletion, a deletion committed on the branch and a rename of the target (the exhaustive pair pass
  excludes both names; the new name is an ordinary file until `include.path` is updated, so the
  owner should update the include after renaming such a file); the battery gained the deletion case.
- Sixth (final) pass of the independent reviewer on that fix: worktree deletion, branch-committed
  deletion, `git mv`, a deleted directory, `..` and `~` spellings of a missing target all held; the
  `*/<path>` deny and the shared metacharacter set were confirmed in code; one P2 (CONFIRMED) — a
  chained include with BOTH files deleted leaked one hop deeper (the missing first file cannot be
  read, so its include of the second was never found, and git's origin list omits both). Fixed: the
  launcher fetches a missing include's last committed content (`HEAD:<path>`, and the merge base's
  copy for the branch delta) through the hardened git helper and feeds it to the parser
  (`includes-in-config`; `git cat-file blob` plumbing, present includes seeded too so an include line
  dropped from an existing config while its target is deleted is still traced), repeating over newly
  found targets (depth 8, deeper fails closed), so a deleted chain is excluded hop by hop. Its P3 — an
  include through a directory symlink with link and target both deleted — stays a documented
  limitation (resolving through HEAD's tree is not attempted); likewise an include line removed from
  `.git/config` itself together with its target cannot be traced (`.git/config` has no history). The
  stale first-round limitation lines (`.bak` rename, hard links) were marked superseded in this entry.
- Codex re-review of the fifth fixed head (`3733fb3`, exact-head CI green, the previous thread
  replied to and resolved): two P1s in the new history traversal, both valid and reproduced by
  Codex — a still-present file reached only through a deleted include's committed content was
  excluded and read-denied but never counted by the scan's refusal or alias checks (so a bearer
  value in it stayed grep-reachable without the override); and a deleted chain passing through a
  file outside the repository was not followed, so the returning in-repository target was missed.
  Fixed: the scan is the single decision point and runs to a fixed point — the history traversal
  (now following outside bridges by reading them) hands every in-repository target back to the scan
  (`--extra-config`), which runs again until nothing new appears; refusal, credential checks,
  alias protection, exclusion and deny-read all apply to the final set. Regression tests reproduce
  both on the previous code; the battery gained both cases.
- Seventh pass of the independent reviewer on that loop: no P1/P2 — termination (self-include, in/out
  alternation, ten hops → fails closed), FIFO and 24 MB outside bridges, a bridge into another
  repository, aliases of history-found present targets, the final-pass decision source, branch-only
  content and an absent base all held. Its P3 was taken: an outside bridge that is a symlink now
  resolves its relative includes against the link's own directory, as git does (`O` records carry
  the path as joined, canonical only for the inside/outside test and de-duplication; unit test
  added). ADR item 4 now states the deleted-directory-symlink limitation and the up-to-eight-pass
  worst case.
- Codex re-review of the sixth fixed head (`d789b5d`, exact-head CI green, the previous two threads
  replied to and resolved): two P1s, both valid and reproduced by Codex, both about canonicalising
  include paths — a tracked included config replaced by a dangling in-repository symlink
  (`review.cfg -> missing.cfg`) lost its referenced name, so only the target was registered and the
  type-change hunk with the committed credential was shown; and de-duplicating traversal by
  canonical path skipped a second symlinked outside bridge whose relative includes resolved into
  the repository. Fixed: every in-repository include target is registered under its referenced
  name AND its canonical target, history is inspected under the referenced name, and traversal
  (scan, `includes-in-config`, launcher history queue) is keyed by the referenced path — the
  resolution context — with canonical paths used only for the inside/outside test and the
  existing-file checks; depth and loop guards unchanged. Regression tests reproduce both on the
  previous code; the battery gained both.
- Eighth pass of the independent reviewer on that round: Codex's two cases closed (include-name links
  pointing at `.git/config`, `.env` or a secret-like directory still refused; chains of include-name
  links denied name by name; link loops terminate live and through history; `..`/`./`-heavy
  spellings register once; three bridges; a metacharacter include name refuses). One P2 introduced
  by the new exemption (CONFIRMED): a directory alias over a folder holding an exempt include-name
  link (`d -> linkdir`, `linkdir/link.cfg -> ../conf/real.cfg`) re-exposed it as `d/link.cfg` under
  the override → fixed by adding every handed-over include name to the set the directory-alias check
  uses (regression test); ADR item 4 and the README now state the exemption and that a directory
  alias over such a link is refused.
- Review and gate state: the fixes were pushed to the PR branch after this entry's commit; the
  exact-head CI result, the Codex re-review of the pushed head (`@codex review`), the resolution of
  every Codex P1/P2 thread and the Codex Gate verdict are recorded on the PR and in agent-memory
  `automation-core/cc-latest.md` (owner-facing state), never claimed here ahead of the evidence.
- Needs from the owner: unchanged — run `oauto <repo>` once from Termux; merge the PR once Codex Gate is
  green; decide whether `DEVELOPMENT_RULES_FULL` §7 should list `oauto` next to `cauto`/`clauto`.

## [2026-11-08 UTC] oauto — read-only, privacy-restricted OpenCode reviewer launcher
- PR: <https://github.com/funzi7/automation-core/pull/58>
- Branch: `claude/oauto-opencode-reviewer` (from `main` = `15652f663ccf31fac3c03651a5a7b56758257de4`)
- Status: opened — launcher installed and validated on the device; the Termux hop itself needs one manual run by the owner
- What changed:
  - `launchers/ai-launch` is now the tracked copy of `/root/work/bin/ai-launch` (first commit:
    byte-identical import of the live file; later: the `opencode` mode). The mode hands off to
    `oauto-run` right after repository resolution and before the cauto/clauto banner, and a
    leading `glm`/`deepseek` argument is kept for oauto-run instead of being taken as a repo name.
    The `codex`/`claude` exec blocks and the `ai` menu are byte-identical (a test rebuilds the file
    from `tests/fixtures/ai-launch.pristine` plus exactly the intended edits).
  - `launchers/oauto/oauto-run` + `oauto-policy.py`: per-repo lock taken first (re-exec under
    `flock --close`, held by the flock parent for the OpenCode process lifetime); fail-closed
    preflight (OpenCode **2.2.6** only, no `/etc/opencode`, no `opencode.json(c)`/`.opencode/` in
    the repo, no `opencode.json(c)` in any parent); one unpruned, case-insensitive worktree scan
    driven by the same pattern list as the `read` denies (secret-like files → refuse unless
    `OAUTO_ALLOW_SENSITIVE_FILES=1`; symlinks leaving the repo → refuse, `/usr`,`/bin`,`/lib`
    targets tolerated; credential-looking lines in `gradle.properties` or `.git/config` → refuse);
    read-only git preflight (`GIT_OPTIONAL_LOCKS=0`, time-bounded, byte-capped, secret-like
    changed/deleted/untracked paths excluded from every diff and listed by name only); a private
    config directory per launch via `XDG_CONFIG_HOME` (`~/.config/opencode` is never read or
    written); deny-all `permissions` + read/glob/grep/question allows, hard `policies` ceiling,
    provider pinned to `opencode`, every offered model except the approved one(s) disabled
    (statically and dynamically from `opencode models`); verification through `opencode debug
    config`/`debug agents`/`models` (all `--standalone`, 40 probes per agent) plus a check that
    nothing else appeared in the private config dir; scrubbed `env -i`; never `--auto`; the TUI
    `--prompt` carries the preflight. Approved models: `opencode/glm-5.3-flash-free` (default)
    and `opencode/deepseek-v4.1-flash-free` (`oauto <repo> deepseek`), both $0 and published as
    zero-retention/no-training on opencode.ai/docs/zen (read 2026-11-07).
  - Termux: `/data/data/com.termux/files/usr/bin/oauto-launch` + `oauto()` in Termux `.bashrc`;
    Debian: `oauto()` in `~/.bashrc`; `launchers/oauto/install.sh` (idempotent, `--verify`,
    refuses unpaired bashrc markers, backs up replaced files). The original live `ai-launch` is
    kept as `/root/work/bin/ai-launch.backup-before-oauto-20261107`.
  - Docs: `docs/adr/0002-oauto-read-only-opencode-reviewer.md`, `launchers/oauto/README.md`,
    README `launchers/` section, this entry, LOOP_STATE item 8 + "Device launchers", CONTEXT §7 A1.
- Validation performed (device, OpenCode 2.2.6, disposable fixture repositories only):
  - Deterministic: `tests/test_oauto_launcher.js` 20/20 pass — rendered contract (every deny,
    allow, policy, disabled model, agent shape), `classify`/`scan` behaviour (case-insensitive,
    `node_modules` not pruned, symlink classes, content checks, budget exhaustion), verifiers
    against good and 13 mutated payloads, and the launcher driven end to end against
    `tests/fixtures/fake-opencode`: clean `--check`, dynamic model disabling, secret refusal and
    override, outward vs system symlinks, deleted-secret exclusion from the diff, project/parent
    config refusal, version pin, bad arguments, lock contention, detached and unborn HEAD,
    oversized diff truncation, scrubbed launch argv/env, ai-launch routing (including the bare
    `oauto deepseek` menu path) and parity, `install.sh` idempotency/backup/unpaired markers.
    `bash scripts/validate.sh` green; `git diff --check` clean.
  - Real binary, `--check` paths: `oauto-run <clean>` with GLM and DeepSeek, `ai-launch opencode
    <repo> --check`, the Debian `oauto` function — each: config sources = only the private file,
    models = exactly the two approved ids, 5 agents resolved with 40 probes each as expected.
  - Real binary, refusals: `.opencode/` present, outward symlink (even with the secrets override),
    secret-like files; override → pass with WARNING and 0 secret markers in the preflight.
  - Real binary, tool level (exact rendered rules, harness prompt): read `.env`,
    `config/server.pem`, `.git/config`, `.ssh/config` → `Permission denied: read`; read
    `/etc/hostname` → `Permission denied: external_directory`; `.env.example` and `src/calc.py`
    readable; write/edit/shell/webfetch/subagent not in the tool list; with `--auto` the same
    denials hold; glob `{/root,x}/.ssh/*` → `Permission denied: glob` while `**/*.py` works;
    `--model opencode/big-pickle` → `Model unavailable`; `--agent build` → `Agent not found`.
    Earlier rounds on the same rules additionally showed: `glob /root/*` denied, websearch absent,
    `skill` load of the real local skill `docs` → `Unable to load skill` with no skills visible, a
    project `.opencode/plugins/marker.ts` executing without policies and not executing under the
    `plugin.use` deny policy, and `plugins: ["-*"]` removing the free-tier provider (so it is not
    used). No fixture file was ever changed by the model; no process was left behind.
  - Real launch through the installed `/root/work/bin/oauto-run` under a PTY: lock held by the
    flock parent, process tree `flock → bash oauto-run → opencode --standalone --prompt → opencode.exe
    serve --stdio --port 0` (no shared service), the preflight prompt auto-submitted, the model read
    `src/calc.py`, globbed for tests and returned a review with a P1 on the planted regression;
    after SIGTERM nothing remained and the lock was free. `~/.config/opencode` was not touched.
- Independent review: an Opus reviewer subagent (not the implementing agent) reviewed the first
  complete version and reported 2 P1 / 10 P2 / 10 P3. All were addressed: secret contents could
  reach the model through the preflight diff of deleted or modified tracked secrets → excluded by
  pathspec; the scan was narrower than the read-deny list, case-sensitive and pruned
  `node_modules` → one shared pattern list, case-insensitive, unpruned, plus `.ssh/`, `.gnupg/`,
  `.git/`, `.npmrc`, `.pypirc`, `.aws/`, `.docker/config.json`, `local.properties`,
  `client_secret*.json`, `*.p8` and content checks; config rendered before the lock and into the
  shared global file → lock first and a private `XDG_CONFIG_HOME` directory; `oauto deepseek` ran
  GLM silently → alias routing; cap arithmetic and chars-vs-bytes → byte caps under a 100,000-byte
  limit; virtualenv symlinks refused → system prefixes tolerated; skills wording, symlink wording,
  "every refusal fires", ADR env/probe/parent inaccuracies → corrected; `install.sh` could delete
  the rest of `.bashrc` on an unpaired marker and took any argument → refuses both, backs up
  files, checks modes; detached/unborn HEAD rendering, XDG pass-through, basename-keyed lock →
  fixed; behavioural tests added. Review provenance: `review_provider = claude_code_fallback`
  style independent review (no Codex review exists yet; PR just opened).
- Not physically tested: the Termux entrypoint itself — `proot-distro login` refuses to run from
  inside the Debian PRoot session ("attempted to run proot-distro in a proot session"), so
  `oauto <repo>` must be run once from a real Termux shell by the owner; a review on a real project
  repository (only disposable fixtures were used); a full DeepSeek TUI session (only `opencode run`
  with the DeepSeek agent and `--check`); offline behaviour (fails closed at the `models` step by
  design, not exercised); the free tier's daily request limit (documented by OpenCode without a
  number); `/etc/opencode` refusal and the preflight-size refusal (code paths only, not
  exercised); whether a running TUI re-reads its private config mid-session.
- Limitations / risks: every model request transmits the selected code context and the preflight
  diff to OpenCode's remote inference service — zero retention is the provider's published term
  only; the preflight is visible in `/proc/<pid>/cmdline` to same-user processes while the session
  runs; `grep` is content-returning and path-unrestricted by OpenCode design (an explicit
  `path: ".env"` returned the line), so the worktree scan is the real control; project `AGENTS.md`
  is sent to the model as instructions; OpenCode downloads ripgrep to `~/.cache/opencode/bin/rg`
  on first grep; helper commands without `--standalone` start the shared background service (one
  was started and stopped during this investigation; it left `~/.config/opencode/service.json`
  with a local service password, untouched); the launcher refuses any OpenCode version other than
  2.2.6 until re-validated; no code-editing OpenCode mode exists.
- Needs from the owner: run `oauto <repo>` once from Termux; merge the PR; decide whether
  `DEVELOPMENT_RULES_FULL` §7 should list `oauto` next to `cauto`/`clauto`.
- Next: after any OpenCode upgrade, re-run `oauto <repo> --check`, the fixture battery and the
  tool-level probes, then bump `VALIDATED_VERSION` deliberately.

## [2026-09-15 UTC] Canonical Claude fallback review evidence
- PR: <https://github.com/funzi7/automation-core/pull/56>
- Branch: `claude/canonical-fallback-review-evidence`
- Status: opened — exact-head CI green, Gate red pending review evidence
- What changed:
  - The central contract is now `valid exact-head review evidence == normal
    Codex evidence OR approved Claude fallback evidence when Codex is provably
    unavailable`. Implemented in automation-core, not as a consumer patch.
  - New `workflows/claude-fallback-review.yml` is the only sanctioned producer
    of a structured `claude-fallback-review:v1` attestation: dispatch-only,
    default-branch only, gated on `CLAUDE_FALLBACK_REVIEW_ENABLED`, no checkout,
    verdict derived rather than accepted, and it refuses to attest unless the
    SHA is the live head, a trusted Codex quota notice exists, Codex has no
    result on that head, and no trusted Codex P1/P2 is still active.
  - Codex Gate, Merge Bot and the watchdog now carry one verbatim-shared
    `CANONICAL EXACT-HEAD REVIEW EVIDENCE` block; a test asserts the three
    inline copies are byte-identical and that `tools/review_evidence.js`
    mirrors its reason codes.
  - Consumers re-authenticate every attestation against the producing run
    (workflow path, `workflow_dispatch` event, default-branch `head_branch`,
    attempt, comment-inside-run-window) and fail closed on any lookup error;
    the evidence call cannot throw into the Gate's technical fail-soft green.
  - Quota episodes are bound to real evidence: Route A (decline on this head
    epoch) or Route B (decline predates it, Codex silent since, attested within
    24 h). Genuine Codex activity newer than the newest notice closes the
    episode; no authenticated head epoch means no episode.
  - Provenance is truthful; `codex-p1-acknowledged`, owner override and
    reaction acknowledgement are untouched and are never used for fallback.
- Validation: 127 deterministic tests pass (43 new in
  `tests/test_review_evidence.js`) — the full mandatory acceptance matrix, the
  paywall-bot PR #103 regression built on that PR's real timestamps, the
  shipped inline block from all three consumers executed directly across the
  whole trust matrix, and the producer script executed against its refusal
  matrix (it mints exactly what the consumers accept, and refuses malformed
  inputs, a disabled policy, a non-default dispatch ref, a stale or malformed
  head, a closed PR, missing or untrusted quota evidence, declared unresolved
  P1/P2, a non-passed validation, a genuine Codex result on the head, an
  unresolved Codex thread whether or not it is outdated, and a review thread
  too long to read in one page). `bash scripts/validate.sh` green — every tracked YAML parses,
  all synced source/`.github` mirrors byte-identical, all 59 `github-script`
  bodies expression-safe and syntax-checked; `git diff --check` clean.
  Real GitHub Actions validation: `actionlint` 1.7.7 reports zero findings
  across every workflow, including the new producer.
- Two defects were caught and fixed during self-review: the gate's reworded
  pending check title would have broken the watchdog's exact `PENDING_TITLE`
  match (title restored, and a test now pins the two together), and the pure
  mirror did not short-circuit fallback evaluation on a current-head Codex
  signal the way the inline block does, so a stale attestation could have
  blocked a Codex-reviewed head in the mirror only.
- The independent Opus review raised no P1 and six P2s, all fixed: an outdated
  (not resolved) Codex P1/P2 could be cleared by a fallback — the producer now
  refuses while any trusted Codex thread is unresolved, outdated or not; the
  three consumers fed the byte-identical block three different evidence sets —
  a shared `collectReviewEvidenceInputs` collector now builds them, and a test
  drives all three shipped blocks over a fixture matrix; attestation runs that
  were queued or had refused to attest still authenticated, and an edited
  comment body still passed — the run must now be completed+successful, the
  window is bounded at both ends, an unknown default branch fails closed, and
  an edited attestation is rejected; the "Gate and Merge Bot agree" test called
  one pure function twice and was vacuous — it now compares the three shipped
  inline blocks; the mandated precedence and the PR #103 regression were proven
  only against the mirror — both are now also proven against the shipped gate
  path, with the gate's inline `decideCodexGate` pinned equivalent to the tested
  module; and the mirror's signature and Route B timing semantics now match the
  inline copy. Nits fixed too: a quota notice carrying a P1/P2 no longer opens
  an episode, a review thread too long to read in one page fails closed, the
  success summary no longer reports a Codex-sounding reason for a Claude
  review, and Merge Bot paginates each PR once instead of three times.
- A second independent Opus pass verified those fixes by mutation testing on a
  scratch copy and found three more P2s, all fixed: producer-side enforcement of
  the outdated-thread rule was NOT sufficient (a resolved thread can be
  re-opened, and a late Codex finding can arrive already-outdated, both without
  a new commit), so the rule is now enforced on every evaluation by Gate, Merge
  Bot and the watchdog; the run-authentication hardening and the wiring that
  consumes the decision were both untested — deleting either left the suite
  green. Ten mutations that previously survived, including
  `currentHeadSignal: true` (which would have greened every PR) and disabling
  Merge Bot's three evidence guards, are now all killed by the suite; that was
  re-verified locally on a scratch copy with the real tree untouched.
- A third pass confirmed by execution that both post-mint attack sequences are
  blocked end to end and that the watchdog rewrite does not repeat dispatches,
  and found two coverage regressions rather than live holes: the previous
  commit had silently deleted the producer's test harness (every producer
  precondition could be removed with the suite green, and the truncated-thread
  guard has no consumer counterpart), and the two new outdated-thread helpers
  shipped untested one `!` away from their sibling. Both are fixed: the harness
  is restored and extended, and the helpers are now executed directly over
  resolved/outdated/author/severity shapes and a two-page cursor. Ten further
  mutations — including the copy-paste `!` slip and every producer precondition
  — are now killed in clean isolation. The dead `attestedAt` field was dropped,
  the severity-carrying-notice classification is asserted, and the watchdog's
  pending-verdict dispatch is bounded by verdict age rather than ordering, so
  neither permanent suppression nor per-tick re-dispatch is possible. The same
  pass also confirmed the Route A no-TTL decision is correct and withdrew that
  suggestion.
- Real consumer scenario, read-only, no mutation: the shipped inline block was
  run against OptionsProfitTracker PR #19's actual comment history. It found
  exactly the four genuine `chatgpt-codex-connector[bot]` usage-limit notices
  (2026-09-07 ×2, 2026-09-09 ×2) and zero real Codex activity, and returned
  `no_attestation` as it stands. Given a hypothetical valid exact-head
  attestation it returns `stale_quota_evidence`, because every notice predates
  the current head `074de86e…` (pushed 2026-09-14T19:45:26Z) and the Route B
  window is 24 h. Adding a current-head notice flips it to
  `structured_fallback_clean`. That is the contract behaving exactly as
  specified on real data.
- NOT validated in production: `pull_request_target` loads Codex Gate from the
  base branch, so the gate run on this PR executed main's OLD code. The new
  gate/merge-bot/watchdog paths take effect only after merge; no production
  fallback attestation has been minted or honoured yet.
- Review provider for this change: `review_provider = claude_code_fallback`,
  `reason = codex_quota_unavailable` — an independent Opus reviewer. Codex
  posted a genuine usage-limit notice on this PR at 2026-09-15T12:49:40Z, so
  normal Codex review is unavailable. The new central mechanism is NOT claimed
  as authoritative for its own PR: it did not exist before it, and
  automation-core has not set `CLAUDE_FALLBACK_REVIEW_ENABLED`.
- Needs from the owner: merge, then set `CLAUDE_FALLBACK_REVIEW_ENABLED=true` on
  each repository that should honour fallback evidence (Actions variables are
  not synced, so the Codex-only contract stays in force until it is set).
- Next: normal sync delivers the new workflow to consumers, including
  OptionsProfitTracker. OPT PR #19 still needs current-head quota evidence plus
  a fresh exact-head fallback review, or a normal Codex review, before it can
  pass — its existing notices all predate its current head.

## [2026-08-13 UTC] Reject delayed old-head task results
- Production trigger: paywall-bot PR #97 head `29b7c16d29749ba35b371a6a17068b4ee6746e0c` was pushed at 13:39 UTC. A Codex task summary initiated on the prior head arrived at 13:40 and the timestamp fallback treated it as current-head review, allowing merge `0c4ae03fdbc7c7bf79b41c4fb31dd19db0c10e10` before the actual current-head Codex review at 13:41.
- Correction: Gate, Merge Bot, Watchdog, bridge, and backup fixer reject task summaries and timing-only result binding. Review/result surfaces use immutable `commit_id`/`original_commit_id`, explicit `Reviewed commit`, or trusted `ai-loop` head markers where applicable. Reaction-only clean remains supported only when authenticated Gate marker history proves the PR has had exactly one observed head; after a transition, commit-bearing evidence is mandatory.
- Reaction-history API failures are fail-closed: history is queried only when a trusted clean reaction exists, lookup errors make that reaction non-binding, and the normal immutable-signal/thread decision continues instead of reaching the Gate's broad technical fail-soft handler.
- Containment: automation-core Merge Bot was disabled while the forward fix was prepared. Re-enable it only after this PR is exact-head CI/review/Gate green so it can perform the normal SHA-pinned merge; then complete the downstream sync.

## [2026-08-13 UTC] Emergency Gate repair, provenance hardening, and paywall rollout
- Emergency bootstrap: PR #40, merge `fd16f6ad875726386f4f7c029993639cafebaa01`.
- Root cause: direct `${{ ... }}` interpolation inside a roughly 25 KB `actions/github-script` scalar exceeded GitHub's 21,000-character expression ceiling after template expansion. Inputs now travel through `env`; final review expanded deterministic validation to all tracked workflow YAML and rejects every direct expression inside `github-script` bodies, including quoted/type-injectable forms.
- Spam repair: Gate/update-branch/backup dispatch failures use durable trusted markers keyed by repository, PR, exact head, operation, and normalized error fingerprint. First material failure alerts once; identical scheduled repeats log without another Telegram; a new head or error class can alert once.
- CI Doctor: internal automation is identified by authoritative workflow path as well as display name. Issue #39 was closed only after the repaired Gate was production-verified; no equivalent Issue reappeared.
- PR #38: the old head was accidentally auto-merged as `cdf4c94528fdfd81ab00742c549355912355bcc1` after the old Gate accepted a Codex quota notice. Forward security PR #41 merged as `dd9a9de615eb0613e314b26e989d82375c808e66`; reviewed follow-ups #42-#51 completed credential isolation, authenticated provenance/head epochs, real-delivery activation, fail-closed label races, and complete finding context.
- Production proof: Gate dispatch `31681859499` parsed and succeeded. Scheduled Watchdog runs `31687590924` and `31692340712` succeeded without the former expression/dispatch/Telegram error. Codex review quota was available for the forward fixes.
- Downstream: normal sync continuously updated existing paywall-bot PR #94. Its final head `5d65f205708435aab09ce03ace5880c30b342293` contained only the seven byte-identical synced workflows, passed full CI, clean exact-head Codex review, zero unresolved threads, and green Gate. Re-enabled Merge Bot normally auto-merged it as `2575f0f2b16c12ebb9b9173e8c9a8248ab529ebe`.
- Current state: automation-core and paywall-bot Claude Fixer, Codex Gate, Watchdog, and Merge Bot are enabled. No owner merge, `codex-p1-acknowledged`, force push, or application/state change was used.

## [2026-08-11 UTC] Reconcile gate drift and make exact-head-green owner PRs hands-off
- PR: current `agent/owner-green-automerge` change; exact PR/merge SHA is recorded by GitHub and agent-memory after bootstrap validation.
- Branch: `agent/owner-green-automerge`
- Status: bootstrap validation/rollout in progress at authoring time.
- What changed:
  - Closed paywall-bot PR #89 unmerged and deleted only its verified stale sync branch; the obsolete PR was not salvaged.
  - Ported paywall-bot's current reviewed Codex Gate and watchdog hardening into automation-core source/mirrors before changing merge policy, closing the eight active trusted P1 findings still attached to #89's obsolete versions.
  - Added default candidacy for open non-draft same-repository PRs authored by `funzi7`, permanent `no-automerge`, transient `needs-owner-auto`, legacy label-event provenance checks, owner-only protected-path continuation after the full gate, direct active-thread defense, and per-PR failure isolation.
  - Preserved latest-per-context checks, exact-head gate existence/success, affirmative mergeability, SHA-pinned squash, same-repo post-merge branch deletion, PAT-authored downstream triggering, and fail-closed fork handling.
- Validation: tracked workflow YAML, source/mirror parity, every changed github-script block with `node --check`, 43 deterministic Node policy tests plus static writer guards, `git diff --check`; actionlint is run when installed.
- Needs from the owner: nothing if exact-head GitHub CI/trusted review/gate completes green; the task authorizes the one-time bootstrap merge and fresh downstream sync rollout.
- Next: merge only the exact reviewed central head, run the normal paywall-bot sync, and prove the fresh exact-head-green sync closes itself without owner intervention.

## [2026-07-09 09:18 UTC] Fix paywall-bot PR #73 Codex P2 upstream
- PR: direct commit to automation-core `main`; downstream evidence from `funzi7/paywall-bot` PR #73, Codex P2 "Skip patch download after agent failure".
- Branch: main
- Status: done upstream; downstream sync still needed
- What changed:
  - Fixed `codex-backup-fix.yml` upstream so `codex_agent_failed` no longer enters the normal patch download/apply path.
  - Kept `apply-and-push` broad enough for marker-only terminal paths and normal patch application, but added a `normal_patch_path` gate based on `proceed == 'true'`, no fork skip, no agent failure, and successful patch artifact readiness.
  - Gated PR-head resolve, checkout, `codex-patch` download, apply/push, `pushed`, `no_change`, `patch_failed`, and stale-note steps on the normal patch path. After agent failure, only the intended Codex `api_error` marker path runs.
  - Updated both mirrored workflow copies byte-identically: `workflows/codex-backup-fix.yml` and `.github/workflows/codex-backup-fix.yml`.
- Validation: recorded in `/root/work/agent-memory/automation-core/cc-latest.md` for this commit. Local writes and `git pull --ff-only` were blocked by the workspace `bwrap` error, so remote GitHub API readback was used for changed-file validation.
- Needs from the owner: refresh/sync paywall-bot PR #73 from automation-core, then re-check PR #73 and do not merge it until the refreshed sync includes this fix and Codex Gate is green.
- Files intentionally not changed: paywall-bot and all downstream repos; workflow logic outside `codex-backup-fix.yml`; browser/UI automation; force-push behavior.

## [2026-07-07 18:45 UTC] Post-fix #27 final documentation normalization
- PR: direct commit to main (documentation/state/handoff only)
- Branch: main
- Status: done
- What changed:
  - Normalized `LOOP_STATE.md`, `handoffs/CONTEXT.md`, and this handoff around the current delivery-judged ladder: Codex auto-review -> Claude -> Codex API only when `CODEX_BACKUP_ENABLED == 'true'` -> Codex Cloud unless `CODEX_CLOUD_ENABLED == 'false'` -> Claude proxy after genuine Claude `no_delivery` only when it can deliver to the original PR head -> `needs-owner` -> Codex Gate -> Merge Bot.
  - Removed or marked as HISTORICAL/SUPERSEDED stale current-tense claims about old snapshots, onboarding PR merge state, P1-focused bridge scope, Anthropic credit being available, Claude being the only live autonomous fixer, disabled backup causing first-timeout escalation, Claude proxy delivery being live-verified, and prior escalation-label naming.
  - Reconciled Codex Cloud wording: View task, task diff, ready diff, Created commit wording, Cloud-side commit hints, and secondary PRs are not delivery unless a real commit reaches the actual relevant PR head after that stage's request marker. No supported automatic Update branch action or fake API/browser workaround is documented.
  - Preserved useful incident history as historical context instead of current runbook text.
- Code facts re-verified from workflow files before documenting:
  - `CLAUDE_ENABLED != 'false'` is default ON; public-repo Claude comment triggers require an owner-authored comment; fork PRs are not run with writable credentials or secrets.
  - `CODEX_BACKUP_ENABLED === 'true'` is required for Codex API backup; default is OFF; a disabled backup stage is skipped rather than escalated.
  - `CODEX_CLOUD_ENABLED !== 'false'` is default ON unless explicitly disabled.
  - Trusted Codex identity is exactly `chatgpt-codex-connector[bot]`, with no substring or regex matcher.
  - Bridge/gate severity currently supports P1 + P2 for actionable findings.
- Runtime checks still blocked:
  - Claude PR-head delivery from fix #27 is implemented but runtime-unverified because recent Claude runs return Anthropic `billing_error`.
  - Claude proxy remains runtime-unverified for the same budget reason.
  - Codex API backup remains runtime-unverified while OpenAI API quota is unavailable.
  - Downstream secrets, variables, permissions, and current workflow runtime health were not audited in this task.
- Exact next Claude live-test requirement: create one harmless same-repo PR with an active P1 or P2 finding; trigger `@claude fix`; verify a real commit reaches the original PR head branch after the Claude marker; verify no secondary branch or PR; verify the watchdog recognizes delivery; verify no `no_delivery` marker is left after the successful push.
- Validation: documentation structure reviewed; stale current-tense claims were normalized in the edited docs; `git diff --check` was run and exited clean on the local worktree. Local `git pull --ff-only` and local file writes were blocked by the workspace write-sandbox error `bwrap: fchdir to oldroot: No such file or directory`, so remote readback of the GitHub connector updates was used for Markdown and stale-claim review.
- Needs from the owner: Anthropic credit for Claude live verification; OpenAI quota for Codex API backup verification; downstream repo sync/secrets/variables audit.
- Files changed in automation-core: `LOOP_STATE.md`, `handoffs/CONTEXT.md`, `handoffs/loop-build.md`.
- Files intentionally not changed: `workflows/`, `.github/workflows/`, `sync-config.json`, downstream repositories, and workflow logic.
- Explicit guardrails observed: no workflow logic changed; no downstream repository changed; no force push; no browser, Playwright, session-cookie, UI automation, or fake Codex Cloud Update-branch implementation was used.

## HISTORICAL/SUPERSEDED Incident Summary
- 2026-07-07 first documentation reconciliation after fix #27: corrected major top-level contradictions but left older chronological entries that could still read as current. This entry supersedes that residual ambiguity; the authoritative current architecture is now in `LOOP_STATE.md` and `handoffs/CONTEXT.md`.
- 2026-07-07 fix #27: implemented original-PR-head Claude delivery, default-on Codex Cloud switch, strict Codex identity matching, terminal Codex API states, and issue-vs-PR Claude routing. Runtime verification of the Claude delivery path was blocked by Anthropic billing failure.
- 2026-06 incidents: onboarding/sync, severity bridge, backup-fix, gate, and watchdog iterations produced useful lessons, but their old references to merge state, P1-focused scope, disabled-backup escalation, or prior escalation-label naming are historical only. Current code supports P1 + P2, uses only `needs-owner` for escalation, skips disabled Codex API backup, and treats delivery strictly as a real commit on the relevant head branch.
- Historical downstream state: OptionsProfitTracker PR #12 and thai-rent-finder PR #80 are now merged. Do not use older entries that imply those onboarding PRs still need merge action.
- Historical runtime claims: any older wording implying Claude proxy delivery, Claude PR-head delivery, or Codex API backup is proven in live runtime is superseded. Current state is implemented but runtime-unverified until budget/quota permits live tests.
