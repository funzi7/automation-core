#!/usr/bin/env python3
"""oauto policy module — renders and verifies the read-only OpenCode reviewer configuration.

Run with ``python3 -I`` (isolated mode). Standard library only.

Subcommands
  render          Print the opencode.json document for one launch.
  scan            Walk a repository once: report secret-like files, symlinks that
                  leave it, and credential-looking content in known config files.
  classify        Read paths on stdin; print the ones the reviewer may never read.
                  With -z: NUL-delimited, bytes-exact, rename pairs (--renames) and a
                  C-quoted listing (--display); the form the launcher uses.
  check-excluded  Fail if a path the preflight still diffs was excluded or is
                  secret-like (proves the exclusion pathspecs applied).
  check-diff-content
                  Read one file's unified diff on stdin; exit 3 when it carries a
                  credential-looking line for that file's content check (removed,
                  added, context or hunk-header text; --checker for a rename/copy
                  partner), 0 when not.
  quote-path      Print NUL-delimited paths from stdin C-quoted like git, one per line.
  verify-sources  Read ``opencode debug config`` JSON on stdin; fail unless the only
                  configuration sources are the oauto-owned config directory and file.
  verify-agents   Read ``opencode debug agents`` JSON on stdin; fail unless every agent
                  resolves to the read-only ruleset and no unexpected agent exists.
  verify-models   Read ``opencode models`` output on stdin; fail unless exactly the
                  approved models are offered.
  approved        Print the approved model table (alias, model id).

Every verifier exits non-zero on the first violation and prints the reason, so the
launcher can fail closed. One pattern list (SENSITIVE_READ_PATTERNS) drives the
``read`` deny rules, the ``tool.use`` policy ceiling, the pre-launch scan and the
preflight diff exclusion, so the four controls cannot drift apart.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import sys
import time

# ---------------------------------------------------------------------------
# Approved models (OpenCode Zen free tier). Their published terms on
# https://opencode.ai/docs/zen/ state: "Its provider follows a zero-retention
# policy and does not use your data for model training." Both are listed with
# $0 input / $0 output pricing. Nothing else may be offered to the reviewer.
# ---------------------------------------------------------------------------
APPROVED_MODELS = {
    "glm": "opencode/glm-5.3-flash-free",
    "deepseek": "opencode/deepseek-v4.1-flash-free",
}
DEFAULT_ALIAS = "glm"
APPROVED_PROVIDER = "opencode"

# Free models that the installed binary (2.2.6) or the Zen page listed on 2026-11-07
# but that are NOT approved: their Zen terms allow retention and/or training. They
# are disabled statically; the launcher also disables, dynamically, anything else
# the binary lists at launch time, and then verifies that only the approved set
# remains.
KNOWN_UNAPPROVED_MODELS = [
    "opencode/beam-free",
    "opencode/big-pickle",
    "opencode/crouton-alpha-free",
    "opencode/flint-40b-free",
    "opencode/iceman-free",
    "opencode/iceman-contributor-free",
    "opencode/inkling-2-small-free",
    "opencode/jev-1.13-free",
    "opencode/mimo-v2.6-flash-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/nemotron-3.5-super-vl-free",
]

REVIEW_AGENTS = {
    "review-glm": "glm",
    "review-deepseek": "deepseek",
}
BUILTIN_DISABLED = ["build", "plan", "general", "explore"]
BUILTIN_HIDDEN = ["title", "summary", "compaction"]

# Permission actions the reviewer may never use (OpenCode 2 action names).
DENIED_ACTIONS = [
    "shell",
    "edit",
    "webfetch",
    "websearch",
    "subagent",
    "skill",
    "execute",
    "external_directory",
    "experimental_image_generate",
    "browser",
]

# Files the reviewer may never read even inside the repository, in OpenCode 2
# resource syntax: resources for ``read`` are location-relative paths, ``*``
# matches across ``/``, ``?`` matches one character, whole value must match.
# The same list is matched case-insensitively by the scanner.
SENSITIVE_READ_PATTERNS = [
    # dotenv and shell env
    "*.env", "*.env.*", "*.envrc",
    # key material and stores
    "*.pem", "*.key", "*.p12", "*.pfx", "*.p8", "*.jks", "*.keystore", "*.kdbx",
    "*.gpg", "*.asc", "*.ovpn", "*.htpasswd",
    "*keystore.properties", "*signing.properties", "local.properties", "*/local.properties",
    "*id_rsa*", "*id_dsa*", "*id_ecdsa*", "*id_ed25519*",
    # tool and cloud credential homes
    ".ssh/*", "*/.ssh/*", ".gnupg/*", "*/.gnupg/*", ".aws/*", "*/.aws/*",
    ".docker/config.json", "*/.docker/config.json",
    "*.netrc", "*.git-credentials", "*.npmrc", "*.pypirc",
    # repository metadata (remote URLs can embed tokens; nothing to review there)
    ".git/*", "*/.git/*",
    # credential-shaped JSON/YAML/TOML/properties
    "*credentials*.json", "*client_secret*.json", "*service-account*.json",
    "*secrets*.json", "*secrets*.yaml", "*secrets*.yml", "*secrets*.toml", "*secrets*.properties",
    # infrastructure state
    "*.tfstate", "*.tfstate.*", "*.tfvars",
]
# Directories the patterns above deny as a whole (X/* and */X/*). An in-repository
# symlink whose target passes through one of them is refused: OpenCode checks the
# requested (alias) path, not the canonical one. A test keeps this in step with
# SENSITIVE_READ_PATTERNS. (.docker is not one: only .docker/config.json is denied.)
SENSITIVE_DIR_COMPONENTS = frozenset({".git", ".ssh", ".gnupg", ".aws"})
# Documented examples are not secrets; re-allowed after the denies (last match wins).
SENSITIVE_READ_EXCEPTIONS = [
    "*.env.example",
    "*.env.sample",
    "*.env.template",
    "*.env.dist",
]
# Glob patterns that try to leave the repository (absolute, home, parent, brace or
# class tricks). Legitimate globs such as ``**/*.{kt,java}`` stay allowed.
ESCAPING_GLOB_PATTERNS = ["/*", "~*", "$HOME*", "..*", "*/../*", "*{/*", "*[*", "*$*"]

# Known config files that are reviewable in general but sometimes carry secrets:
# the scanner refuses the launch when a line looks like a credential assignment, and
# the preflight excludes such a file when its diff does. Java properties separate
# key and value by '=', ':' or whitespace.
CONTENT_CHECKS = {
    "gradle.properties": re.compile(
        r"^\s*[\w.-]*(password|passwd|secret|token|passphrase|api[_.-]?key|access[_.-]?key|secret[_.-]?key"
        r"|signing[_.-]?key|inmemorykey|private[_.-]?key|credential)[\w.-]*(\s*[=:]\s*|\s+)\S", re.I | re.M),
}
# The word list above is a heuristic: it names the credential keys seen in Gradle,
# Maven-publishing and signing setups (dotted, underscored, dashed or camel-cased).
# A key outside it (sonar.login, bintrayKey) is not recognised; the path-based rules
# and the worktree refusal remain the primary controls.
# A content-checked name also covers its copies under a further suffix
# (gradle.properties.bak, .orig ...), but not documented templates.
CONTENT_CHECK_TEMPLATE_SUFFIXES = (".example", ".sample", ".template", ".dist")
# Content-checked files are read in full; beyond this size the launch is refused.
CONTENT_CHECK_MAX_BYTES = 16 * 1024 * 1024
# Any user-info in a URL is a credential (https://user:secret@..., https://<token>@...),
# except a bare login name in an ssh URL (ssh://git@host/...), which ssh never uses as one.
GIT_CONFIG_USERINFO = re.compile(r"([A-Za-z][A-Za-z0-9+.-]*)?://([^/\s@]+)@")
SSH_URL_SCHEMES = frozenset({"ssh", "git+ssh", "ssh+git"})
# http.<url>.extraHeader anywhere on a line (any value, also after a section header on
# the same line; CI checkouts store tokens there) and any Authorization: Bearer/Basic value.
GIT_CONFIG_HTTP_CREDENTIALS = re.compile(r"extraheader\s*=|authorization:\s*(bearer|basic)\s+\S", re.I)

# Symlink targets under these read-only system prefixes are not an escape (Python
# virtualenvs link their interpreter there); anything else outside the repo is.
ALLOWED_SYMLINK_PREFIXES = ("/usr/", "/bin/", "/sbin/", "/lib/", "/lib32/", "/lib64/")

WATCHER_IGNORE = [
    "**/node_modules/**",
    "**/.git/**",
    "**/build/**",
    "**/.gradle/**",
    "**/dist/**",
    "**/.venv/**",
    "**/__pycache__/**",
    "**/go-build-cache/**",
]

SYSTEM_PROMPT = """You are oauto, a read-only senior code reviewer running inside OpenCode.

Operating contract (enforced by configuration, not only by this prompt):
- You can only read files, list files with glob and search with grep inside the repository.
- You cannot edit or create files, run shell commands, fetch the web, search the web,
  launch subagents, load skills or read anything outside the repository. Any attempt is
  denied by policy; do not retry it and do not ask the user to approve it.
- Git metadata (branch, HEAD, status, diffs, recent log) was gathered for you by a
  read-only preflight and is given to you in the first message. Use it instead of trying
  to run git.
- Never ask for secrets, tokens or .env contents. Files that look like secrets are
  denied on purpose, and their diffs were excluded from the preflight on purpose.

Review method:
1. Read the preflight summary. If there are uncommitted changes or commits ahead of the
   base branch, review that delta first; otherwise ask the user what to review.
2. Read the affected files in full before judging a hunk. Read existing tests that cover
   the changed code.
3. Report findings ordered by severity:
   P1 = correctness, data loss, security or privacy defects that will happen;
   P2 = probable bugs, missing error handling, race conditions, broken contracts;
   P3 = maintainability, clarity, test gaps.
   For each finding give file:line, what is wrong, why it matters and a concrete
   suggested fix described in words (you cannot apply patches).
4. Say explicitly what you could not verify. Never claim that tests or builds were run;
   you cannot run them.
5. Be concise and factual. No praise, no filler.
"""


def _die(message: str, code: int = 2) -> None:
    print(f"oauto-policy: {message}", file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _rule(action: str, resource: str, effect: str) -> dict:
    return {"action": action, "resource": resource, "effect": effect}


def read_only_ruleset(deny_read: list[str] = ()) -> list[dict]:
    """``deny_read``: exact repository-relative paths (worktree files that .git/config
    includes as Git configuration), denied after the exceptions so nothing re-allows them."""
    rules = [_rule("*", "*", "deny")]
    rules += [_rule(a, "*", "allow") for a in ("read", "glob", "grep", "question")]
    rules += [_rule("read", p, "deny") for p in SENSITIVE_READ_PATTERNS]
    rules += [_rule("read", p, "allow") for p in SENSITIVE_READ_EXCEPTIONS]
    rules += [_rule("read", p, "deny") for p in deny_read]
    rules += [_rule("glob", p, "deny") for p in ESCAPING_GLOB_PATTERNS]
    rules += [_rule(a, "*", "deny") for a in DENIED_ACTIONS]
    return rules


def deny_all_ruleset() -> list[dict]:
    return [_rule("*", "*", "deny")]


def policies(deny_read: list[str] = ()) -> list[dict]:
    pol = [
        _rule("provider.use", "*", "deny"),
        _rule("provider.use", APPROVED_PROVIDER, "allow"),
        _rule("integration.connect", "*", "deny"),
        _rule("integration.use", "*", "deny"),
        _rule("integration.use", APPROVED_PROVIDER, "allow"),
        _rule("mcp.use", "*", "deny"),
        _rule("skill.use", "*", "deny"),
        _rule("plugin.use", "*", "deny"),
        _rule("websearch.use", "*", "deny"),
    ]
    pol += [_rule("tool.use", f"{a}:*", "deny") for a in DENIED_ACTIONS]
    pol += [_rule("tool.use", f"read:{p}", "deny") for p in SENSITIVE_READ_PATTERNS]
    pol += [_rule("tool.use", f"read:{p}", "allow") for p in SENSITIVE_READ_EXCEPTIONS]
    pol += [_rule("tool.use", f"read:{p}", "deny") for p in deny_read]
    return pol


def render(alias: str, extra_disabled: list[str], deny_read: list[str] = ()) -> dict:
    if alias not in APPROVED_MODELS:
        _die(f"unknown model alias {alias!r}; approved: {', '.join(APPROVED_MODELS)}")
    model = APPROVED_MODELS[alias]
    disabled = []
    for mid in KNOWN_UNAPPROVED_MODELS + list(extra_disabled):
        if mid in APPROVED_MODELS.values() or mid in disabled:
            continue
        if not mid.startswith(APPROVED_PROVIDER + "/"):
            # Other providers are already denied by provider.use; a foreign id here
            # means the launcher saw a provider it must not see.
            _die(f"refusing to render: non-{APPROVED_PROVIDER} model offered: {mid}")
        disabled.append(mid)

    agents: dict = {}
    for name in BUILTIN_DISABLED:
        agents[name] = {"disabled": True}
    for name in BUILTIN_HIDDEN:
        agents[name] = {"model": model, "permissions": deny_all_ruleset()}
    for name, agent_alias in REVIEW_AGENTS.items():
        agents[name] = {
            "description": f"oauto read-only code reviewer on {APPROVED_MODELS[agent_alias]}",
            "mode": "primary",
            "model": APPROVED_MODELS[agent_alias],
            "system": SYSTEM_PROMPT,
            "permissions": read_only_ruleset(deny_read),
        }

    provider_models = {
        mid.split("/", 1)[1]: {"disabled": True} for mid in disabled
    }

    return {
        "$schema": "https://opencode.ai/config.json",
        "model": model,
        "default_agent": f"review-{alias}",
        "update": "disable",
        "share": "disabled",
        "snapshots": False,
        "lsp": False,
        "formatter": False,
        "websearch": False,
        # No "plugins" key on purpose: a "-*" directive also removes OpenCode's own
        # built-in free-tier provider plugin (verified: zero models offered). Local
        # and packaged plugins are blocked by the plugin.use policy below instead
        # (verified: a project .opencode/plugins module no longer executes).
        "mcp": {"servers": {}},
        "skills": [],
        "instructions": [],
        "watcher": {"ignore": WATCHER_IGNORE},
        "experimental": {"todo": False},
        "providers": {APPROVED_PROVIDER: {"models": provider_models}},
        "permissions": read_only_ruleset(deny_read),
        "policies": policies(deny_read),
        "agents": agents,
    }


# ---------------------------------------------------------------------------
# Matching (OpenCode 2 resource semantics) and classification
# ---------------------------------------------------------------------------

def _glob_match(pattern: str, value: str) -> bool:
    """``*`` any run (including ``/``), ``?`` one char, whole-value match; a pattern
    ending in `` *`` also matches the bare value."""
    if pattern.endswith(" *") and value == pattern[:-2]:
        return True

    def rec(p: int, v: int) -> bool:
        while p < len(pattern):
            c = pattern[p]
            if c == "*":
                p += 1
                if p == len(pattern):
                    return True
                for k in range(v, len(value) + 1):
                    if rec(p, k):
                        return True
                return False
            if v >= len(value):
                return False
            if c != "?" and c != value[v]:
                return False
            p += 1
            v += 1
        return v == len(value)

    return rec(0, 0)


def decide(rules: list[dict], action: str, resource: str) -> str:
    """Last matching rule wins; no match means ``ask``."""
    effect = "ask"
    for rule in rules:
        if _glob_match(rule["action"], action) and _glob_match(rule["resource"], resource):
            effect = rule["effect"]
    return effect


_SENSITIVE_RULES = [_rule("read", p.lower(), "deny") for p in SENSITIVE_READ_PATTERNS] + \
                   [_rule("read", p.lower(), "allow") for p in SENSITIVE_READ_EXCEPTIONS]


def is_sensitive_path(relpath: str) -> bool:
    """Case-insensitive classification of a repository-relative path."""
    rel = relpath.replace(os.sep, "/")
    while rel.startswith("./"):
        rel = rel[2:]
    return decide(_SENSITIVE_RULES, "read", rel.lower()) == "deny"


# ---------------------------------------------------------------------------
# Bytes-exact classification for the launcher's git preflight. Paths arrive
# NUL-delimited exactly as git stores them (no C-quoting, any byte but NUL), are
# decoded only to be matched, and leave as the same bytes, so the launcher's
# :(exclude,literal) pathspecs name exactly what git diffs.
# ---------------------------------------------------------------------------

# git's C-style quoting (quote.c with core.quotePath=true).
_CQ_ESCAPES = {0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0B: "\\v", 0x0C: "\\f",
               0x0D: "\\r", 0x22: '\\"', 0x5C: "\\\\"}
# `git diff --name-status` status letters; R and C carry a score and two paths.
_NAME_STATUS_SINGLE = re.compile(rb"[ADMTUX][0-9]*")
_NAME_STATUS_PAIR = re.compile(rb"([RC])[0-9]*")


def git_quote(path: bytes, always: bool = False) -> str:
    """Quote a pathname like git with core.quotePath=true: \\a \\b \\t \\n \\v \\f \\r,
    \\" and \\\\, other control bytes, DEL and bytes >= 0x80 as \\ooo; wrapped in double
    quotes only when something was escaped (or when ``always``)."""
    out = []
    escaped = False
    for byte in path:
        if byte in _CQ_ESCAPES:
            out.append(_CQ_ESCAPES[byte])
        elif byte < 0x20 or byte >= 0x7F:
            out.append(f"\\{byte:03o}")
        else:
            out.append(chr(byte))
            continue
        escaped = True
    text = "".join(out)
    return f'"{text}"' if escaped or always else text


def _sensitive_bytes(path: bytes) -> bool:
    return is_sensitive_path(path.decode("utf-8", "surrogateescape"))


def _read_bytes(path: str) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError as exc:
        _die(f"cannot read {path}: {exc.strerror}")
    return b""


def _nul_fields(data: bytes, what: str, terminated: bool) -> list[bytes]:
    """Split NUL-delimited records. An empty record, or a missing final NUL where git
    always writes one (``terminated``), means truncated or forged input."""
    if not data:
        return []
    if terminated and not data.endswith(b"\0"):
        _die(f"{what}: last record is not NUL-terminated (truncated input; fail closed)")
    fields = data.split(b"\0")
    if fields[-1] == b"":
        fields.pop()
    if b"" in fields:
        _die(f"{what}: empty path or field in NUL-delimited input (fail closed)")
    return fields


def parse_name_status_z(data: bytes) -> tuple[list[bytes], list[tuple[str, bytes, bytes]]]:
    """Parse concatenated ``git diff --name-status -z -M`` output. Returns every path
    named and the (kind, source, destination) pairs of R and C records; anything else
    (unknown status, missing or empty path) fails closed."""
    fields = _nul_fields(data, "--renames", terminated=True)
    paths: list[bytes] = []
    pairs: list[tuple[str, bytes, bytes]] = []
    i = 0
    while i < len(fields):
        status = fields[i]
        pair = _NAME_STATUS_PAIR.fullmatch(status)
        if pair:
            count = 2
        elif _NAME_STATUS_SINGLE.fullmatch(status):
            count = 1
        else:
            _die(f"--renames: unknown status {git_quote(status)} (fail closed)")
        record = fields[i + 1:i + 1 + count]
        if len(record) != count:
            _die(f"--renames: record {git_quote(status)} is missing a path (fail closed)")
        paths.extend(record)
        if pair:
            pairs.append(("renamed" if pair.group(1) == b"R" else "copied", record[0], record[1]))
        i += 1 + count
    return paths, pairs


def content_check_key(name: str) -> str | None:
    """The CONTENT_CHECKS key covering a file name, case-insensitively: the key itself
    or the key plus a further suffix (gradle.properties.bak, .orig ...), but not the key
    plus a template suffix (.example, .sample, .template, .dist)."""
    lower = name.lower()
    for key in CONTENT_CHECKS:
        if lower == key or (lower.startswith(key + ".") and lower[len(key):] not in CONTENT_CHECK_TEMPLATE_SUFFIXES):
            return key
    return None


def _content_key_bytes(path: bytes) -> str | None:
    return content_check_key(path.rsplit(b"/", 1)[-1].decode("utf-8", "surrogateescape"))


def git_config_has_credentials(text: str) -> bool:
    """User-info in a URL (other than a bare ssh login name), an http extraHeader, or an
    Authorization: Bearer/Basic value."""
    if GIT_CONFIG_HTTP_CREDENTIALS.search(text):
        return True
    for m in GIT_CONFIG_USERINFO.finditer(text):
        if (m.group(1) or "").lower() in SSH_URL_SCHEMES and ":" not in m.group(2):
            continue
        return True
    return False


# Include directives are followed this deep (git itself stops at 10); a deeper chain
# is reported instead of being treated as clean.
MAX_INCLUDE_DEPTH = 8
_CONFIG_SECTION_HEADER = re.compile(r'\s*\[\s*([^\]\s"]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\](.*)$', re.S)


def _strip_config_comment(line: str) -> str:
    """A Git config line without its ; or # comment (outside double quotes)."""
    out, quoted, escaped = [], False, False
    for ch in line:
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == '"':
            quoted = not quoted
        elif ch in "#;" and not quoted:
            break
        out.append(ch)
    return "".join(out)


def _config_value(raw: str) -> str:
    """A Git config value: surrounding blanks removed, double quotes dropped, escapes undone."""
    out, escaped = [], False
    for ch in raw.strip():
        if escaped:
            out.append({"n": "\n", "t": "\t", "b": "\b"}.get(ch, ch))
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch != '"':
            out.append(ch)
    return "".join(out)


def config_include_paths(text: str) -> list[str]:
    """Every `path` value of an [include] or [includeIf "<condition>"] section, in any
    case, conservatively: conditions are not evaluated (any of them may apply). Like
    git: a leading UTF-8 BOM is skipped, a comment ends at the newline (a trailing
    backslash continues values only), an odd run of trailing backslashes continues."""
    if text.startswith("﻿"):
        text = text[1:]
    paths: list[str] = []
    section = ""
    pending = ""
    for physical in text.split("\n"):
        line = _strip_config_comment(pending + physical.rstrip("\r"))
        if (len(line) - len(line.rstrip("\\"))) % 2 == 1:
            pending = line[:-1]  # the value continues on the next line
            continue
        pending = ""
        header = _CONFIG_SECTION_HEADER.match(line)
        if header:
            section = header.group(1).split(".", 1)[0].lower()
            line = header.group(2)  # a variable may follow the header on the same line
        if section not in ("include", "includeif"):
            continue
        key, sep, value = line.partition("=")
        if sep and key.strip().lower() == "path":
            value = _config_value(value)
            if value:
                paths.append(value)
    return paths


def _q(path: str) -> str:
    """A scan pathname, C-quoted like git: ASCII and always one line."""
    return git_quote(os.fsencode(path))


def _is_git_config(rel: str) -> bool:
    """config / config.worktree directly in .git, in .git/worktrees/<name>/, and anywhere
    under .git/modules/ (submodule git dirs, nested ones included)."""
    parts = rel.split("/")
    if parts[-1] not in ("config", "config.worktree"):
        return False
    return len(parts) == 2 or (len(parts) == 4 and parts[1] == "worktrees") or (len(parts) >= 3 and parts[1] == "modules")


def classify_z(names: bytes, renames: bytes | None, display: str | None,
               content_candidates: str | None = None, extra_sensitive: frozenset = frozenset()) -> None:
    """stdout: the unique excluded paths, NUL-terminated, sorted by bytes. A rename or
    copy with a secret-like side excludes BOTH sides: a renamed secret must not
    reappear under a safe name, and a secret's new name must not reveal what its old
    (safe-named) source contained. ``content_candidates`` receives KEY\\0PATH\\0 records
    for the paths that are not excluded but are content-checked (gradle.properties ...,
    by their own name or as either side of a rename/copy with such a side): the
    launcher checks their diffs, which can carry a credential line the worktree no
    longer has."""
    candidates = _nul_fields(names, "classify -z", terminated=False)
    pairs: list[tuple[str, bytes, bytes]] = []
    if renames is not None:
        named, pairs = parse_name_status_z(renames)
        candidates += named
    excluded: dict[bytes, set[str]] = {}

    def secret_like(path: bytes) -> bool:
        # extra_sensitive: worktree files that .git/config includes as Git configuration.
        return _sensitive_bytes(path) or path in extra_sensitive

    for path in candidates:
        if secret_like(path):
            excluded.setdefault(path, set())
            if path in extra_sensitive:
                excluded[path].add("(included Git config)")
    for kind, src, dst in pairs:
        if secret_like(src) or secret_like(dst):
            excluded.setdefault(src, set()).add(f"({kind} to {git_quote(dst, always=True)})")
            excluded.setdefault(dst, set()).add(f"({kind} from {git_quote(src, always=True)})")
    ordered = sorted(excluded)
    if display:
        with open(display, "w", encoding="ascii") as fh:
            for path in ordered:
                fh.write(" ".join([git_quote(path), *sorted(excluded[path])]) + "\n")
    if content_candidates:
        checked: dict[bytes, str] = {}
        for path in candidates:
            key = _content_key_bytes(path)
            if key is not None and path not in excluded:
                checked.setdefault(path, key)
        for _kind, src, dst in pairs:
            # The check follows the content: a renamed or copied gradle.properties keeps it.
            key = _content_key_bytes(src) or _content_key_bytes(dst)
            if key is not None:
                for side in (src, dst):
                    if side not in excluded:
                        checked.setdefault(side, key)
        with open(content_candidates, "wb") as fh:
            fh.write(b"".join(checked[p].encode() + b"\0" + p + b"\0" for p in sorted(checked)))
    sys.stdout.buffer.write(b"".join(path + b"\0" for path in ordered))


def check_diff_content(path: str, checker_key: str | None = None) -> int:
    """Exit status for the launcher: 3 when the unified diff on stdin holds a
    credential-looking assignment for the file's content check (``checker_key``, else
    the one its name selects), 0 when not; no or an unknown check fails closed (exit 2).
    Added, removed and context lines count, and so does the text git copies after a
    hunk header (@@ -a,b +c,d @@ <nearest preceding line starting with a letter>)."""
    raw = os.fsencode(path)
    key = checker_key if checker_key is not None else _content_key_bytes(raw)
    checker = CONTENT_CHECKS.get(key) if key is not None else None
    if checker is None:
        _die(f"check-diff-content: no content check for {git_quote(raw)}"
             + (f" (--checker {checker_key!r})" if checker_key is not None else ""))
    text = sys.stdin.buffer.read().decode("utf-8", "replace")
    lines: list[str] = []
    for line in text.split("\n"):
        if line.startswith("@@"):
            end = line.find("@@", 2)
            if end >= 0:
                lines.append(line[end + 2:].lstrip())
            lines.append(line)
        elif line[:1] in ("+", "-", " "):
            lines.append(line[1:])
        else:
            lines.append(line)
    return 3 if checker.search("\n".join(lines)) else 0


def check_excluded(excluded_file: str, remaining_file: str) -> None:
    """Exit 2 if any path still in the diff (REMAINING, NUL-delimited) was excluded,
    or is secret-like at all (an incomplete name collection must not pass)."""
    excluded = set(_nul_fields(_read_bytes(excluded_file), "excluded list", terminated=True))
    remaining = set(_nul_fields(_read_bytes(remaining_file), "remaining list", terminated=True))
    leaked = sorted(p for p in remaining if p in excluded or _sensitive_bytes(p))
    if leaked:
        _die("excluded or secret-like paths still reach the preflight diff: "
             + ", ".join(git_quote(p) for p in leaked))
    print(f"preflight exclusion ok: {len(excluded)} path(s) excluded, {len(remaining)} diffed path(s) checked")


# ---------------------------------------------------------------------------
# Scanner: one walk, no pruning (an explicit grep path bypasses ignore rules)
# ---------------------------------------------------------------------------

def scan(repo: str, budget: float, included_out: str | None = None,
         config_origins: str | None = None) -> int:
    """Print one ASCII record per finding (every pathname C-quoted like git) and a final
    SUMMARY line whose counts are what the launcher decides on:

      SENSITIVE <path>[ (included Git config)]
      SYMLINK <link> -> <target>[ (<reason>)]
      CONTENT <path>: <reason>
      SUMMARY files=N sensitive=N symlinks=N content=N elapsed=Xs complete=0|1

    ``included_out`` receives the in-repository files that a Git config includes
    (NUL-terminated, repository-relative, sorted)."""
    repo = os.path.realpath(repo)
    git_dir = os.path.join(repo, ".git")
    started = time.monotonic()
    files = 0
    sensitive: set[str] = set()
    symlinks: set[tuple[str, str, str]] = set()     # (link, target, reason quoting its own paths)
    content: set[tuple[str, str]] = set()
    dir_links: list[tuple[str, str, str]] = []      # in-repo directory aliases (link, target, rel target)
    alias_inodes: dict[tuple[int, int], str] = {}   # (st_dev, st_ino) of secret-like files and .git files
    linked: list[tuple[str, tuple[int, int]]] = []  # other regular files with st_nlink > 1
    included: dict[str, str] = {}                   # in-repo, non-.git included Git configs: canonical -> rel
    seen_configs: set[str] = set()
    complete = True

    def rel(path: str) -> str:
        return os.path.relpath(path, repo).replace(os.sep, "/")

    def lstat(path: str):
        try:
            return os.lstat(path)
        except OSError:
            return None

    def inside_repo(path: str) -> bool:
        return path == repo or path.startswith(repo + os.sep)

    def link_target(path: str) -> tuple[str, bool]:
        """(canonical target, inside the repository); reports a link that leaves it,
        unless the target is under a tolerated system prefix."""
        target = os.path.realpath(path)
        inside = inside_repo(target)
        if not inside and not (target.startswith(ALLOWED_SYMLINK_PREFIXES) and os.path.exists(target)):
            symlinks.add((rel(path), target, "" if os.path.lexists(target) else "dangling"))
        return target, inside

    def check_symlink(path: str) -> None:
        target, inside = link_target(path)
        if not inside:
            return
        rel_target = "" if target == repo else rel(target)
        parts = rel_target.lower().split("/") if rel_target else []
        if (any(p in SENSITIVE_DIR_COMPONENTS for p in parts) or (rel_target and is_sensitive_path(rel_target))
                or target in included):
            # An alias of Git metadata, a protected directory, a secret-like file or an
            # included Git config: the alias name would pass OpenCode's read rules.
            symlinks.add((rel(path), target, f"secret-like target: {_q(rel_target)}"))
        elif os.path.isdir(target):
            dir_links.append((rel(path), target, rel_target))  # judged after the walk

    def own_git_dirs() -> list[str]:
        """This repository's git dir(s): .git itself, or for a .git file (linked
        worktree, submodule checkout) the gitdir it names and that gitdir's commondir."""
        if os.path.isdir(git_dir):
            return [git_dir]
        try:
            with open(git_dir, encoding="utf-8", errors="replace") as fh:
                first = fh.readline().strip()
        except OSError:
            return []
        if not first.startswith("gitdir:"):
            return []
        gitdir = os.path.realpath(os.path.join(repo, first[len("gitdir:"):].strip()))
        dirs = [gitdir]
        try:
            with open(os.path.join(gitdir, "commondir"), encoding="utf-8", errors="replace") as fh:
                dirs.append(os.path.realpath(os.path.join(gitdir, fh.readline().strip())))
        except OSError:
            pass
        return dirs

    git_dirs = own_git_dirs()

    def config_role(canon: str, printed: str | None = None) -> str | None:
        """Register a Git config file by where it lives. Returns the name its findings
        are reported under, or None for a file of the user's own outside the repository
        (still followed, never reported). A file inside the repository but outside .git
        is Git configuration the reviewer could read by name."""
        if inside_repo(canon) and not (canon == git_dir or canon.startswith(git_dir + os.sep)):
            r = rel(canon)
            if canon not in included:
                included[canon] = r
                if any(c in r for c in "*?["):
                    content.add((r, "cannot be denied by exact path (glob metacharacter)"))
            return r
        if inside_repo(canon):
            return rel(canon)  # under .git
        if any(canon == d or canon.startswith(d + os.sep) for d in git_dirs):
            return printed or canon  # this repository's own config, kept outside the worktree
        return None

    def check_git_config(found: str, depth: int, report: str | None, anchor: str | None) -> None:
        """Credentials in one Git config file (when it is reportable), then every file its
        include directives name, resolved like git: relative to the directory of the file
        as found. Files outside the repository are followed too, as an include may hop
        back in; only reportable files are reported. ``anchor``: the nearest reportable
        file of the chain, which a too-deep chain is reported under."""
        canon = os.path.realpath(found)
        if canon in seen_configs:
            return
        seen_configs.add(canon)
        try:
            with open(canon, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            return
        if report is not None and git_config_has_credentials(text):
            content.add((report, "remote URL or http header embeds credentials"))
        anchor = report if report is not None else anchor
        for inc in config_include_paths(text):
            target = os.path.join(os.path.dirname(found), os.path.expanduser(inc))
            canon_inc = os.path.realpath(target)
            if not os.path.isfile(canon_inc):
                continue
            if depth >= MAX_INCLUDE_DEPTH:
                if anchor is not None:
                    content.add((anchor, f"Git config includes nested deeper than {MAX_INCLUDE_DEPTH} levels"))
                continue
            check_git_config(target, depth + 1, config_role(canon_inc), anchor)

    def check_config_origins(path: str) -> None:
        """Every file git itself reports having loaded (git config --list --show-origin
        -z: ORIGIN NUL KEY LF VALUE NUL records); paths are as git printed them, relative
        to the repository root. Other origins (command line, blob, stdin) are ignored."""
        fields = _nul_fields(_read_bytes(path), "--config-origins", terminated=True)
        if len(fields) % 2:
            _die("--config-origins: a record without its key and value (fail closed)")
        for origin in dict.fromkeys(fields[0::2]):
            if not origin.startswith(b"file:"):
                continue
            printed = os.fsdecode(origin[len(b"file:"):])
            found = os.path.join(repo, printed)
            canon = os.path.realpath(found)
            if os.path.isfile(canon):
                check_git_config(found, 0, config_role(canon, printed), None)

    # .git: links that leave the repository, the inodes of its files (a hard link to
    # one is an alias) and every Git config file (credentials, include directives). Its
    # object store holds none of these and can be large.
    if os.path.islink(git_dir):
        # Git would write its config (and credentials) wherever this points; refuse.
        symlinks.add((".git", os.path.realpath(git_dir), ".git itself is a symlink"))
    if os.path.isdir(git_dir):
        for dirpath, dirnames, filenames in os.walk(git_dir, topdown=True, followlinks=False):
            if time.monotonic() - started > budget:
                complete = False
                break
            for d in dirnames:
                if os.path.islink(os.path.join(dirpath, d)):
                    link_target(os.path.join(dirpath, d))
            dirnames[:] = [d for d in dirnames if d != "objects"]
            for name in filenames:
                full = os.path.join(dirpath, name)
                if os.path.islink(full):
                    target, _inside = link_target(full)
                    if _is_git_config(rel(full)):
                        # Git writes credentials into its config files; through a link
                        # they would land in a file the reviewer may read by name.
                        symlinks.add((rel(full), target, "Git config file is a symlink"))
                    continue
                st = lstat(full)
                if st is None or not stat.S_ISREG(st.st_mode):
                    continue
                r = rel(full)
                # Hooks are scripts, not secrets; a hook installed as a hard link from
                # the worktree (ln scripts/pre-commit .git/hooks/pre-commit) is not an alias.
                if not r.startswith(".git/hooks/"):
                    alias_inodes.setdefault((st.st_dev, st.st_ino), r)
                if _is_git_config(r):
                    check_git_config(full, 0, r, r)
    if not os.path.isdir(git_dir):
        # A .git file: this repository's config lives in the git dir(s) it names.
        for d in git_dirs:
            for name in ("config", "config.worktree"):
                full = os.path.join(d, name)
                if os.path.isfile(full):
                    check_git_config(full, 0, full, full)
    if config_origins:
        check_config_origins(config_origins)
    # An included Git config is secret-like wherever it lives: by name, as a link target
    # and as a hard-link partner.
    for canon, r in included.items():
        st = lstat(canon)
        if st is not None and stat.S_ISREG(st.st_mode):
            alias_inodes.setdefault((st.st_dev, st.st_ino), r)

    for dirpath, dirnames, filenames in os.walk(repo, topdown=True, followlinks=False):
        if not complete or time.monotonic() - started > budget:
            complete = False
            break
        # .git is examined above; it is not reviewable content.
        dirnames[:] = [d for d in dirnames if not (dirpath == repo and d == ".git")]
        for d in list(dirnames):
            full = os.path.join(dirpath, d)
            if os.path.islink(full):
                check_symlink(full)
        for name in filenames:
            full = os.path.join(dirpath, name)
            files += 1
            is_link = os.path.islink(full)
            if is_link:
                check_symlink(full)
            r = rel(full)
            st = None if is_link else lstat(full)
            regular = st is not None and stat.S_ISREG(st.st_mode)
            if is_sensitive_path(r):
                sensitive.add(r)
                if regular:
                    alias_inodes.setdefault((st.st_dev, st.st_ino), r)
                continue
            if regular and st.st_nlink > 1:
                linked.append((r, (st.st_dev, st.st_ino)))
            key = content_check_key(name)
            if key is not None:
                # The whole file is checked; one too large to read in full is refused
                # rather than treated as clean past a cut-off.
                try:
                    if os.stat(full).st_size > CONTENT_CHECK_MAX_BYTES:
                        content.add((r, f"too large to content-check (> {CONTENT_CHECK_MAX_BYTES} bytes)"))
                        continue
                    with open(full, encoding="utf-8", errors="replace") as fh:
                        if CONTENT_CHECKS[key].search(fh.read()):
                            content.add((r, "credential-looking assignment"))
                except OSError:
                    pass

    included_rels = set(included.values())
    secret_like = sensitive | included_rels
    # A directory alias renames every path below its target, so a file that is
    # secret-like only through a directory name above it would be readable by name.
    for link, target, rel_target in dir_links:
        prefix = rel_target + "/" if rel_target else ""
        flagged = sorted(p for p in secret_like if p.startswith(prefix))
        if flagged:
            symlinks.add((link, target, f"aliases a directory holding secret-like files: {_q(flagged[0])}"))
    # A hard link is the same file under another name, which no symlink rule sees.
    for r, inode in linked:
        other = alias_inodes.get(inode)
        if other is not None and other != r:
            symlinks.add((r, os.path.join(repo, other), f"hard link to {_q(other)}"))

    for path in sorted(secret_like, key=os.fsencode):
        print(f"SENSITIVE {_q(path)}" + (" (included Git config)" if path in included_rels else ""))
    for link, target, reason in sorted(symlinks):
        print(f"SYMLINK {_q(link)} -> {_q(target)}" + (f" ({reason})" if reason else ""))
    for path, reason in sorted(content):
        print(f"CONTENT {_q(path)}: {reason}")
    elapsed = time.monotonic() - started
    print(f"SUMMARY files={files} sensitive={len(secret_like)} symlinks={len(symlinks)} content={len(content)}"
          f" elapsed={elapsed:.1f}s complete={'1' if complete else '0'}")
    if included_out:
        with open(included_out, "wb") as fh:
            fh.write(b"".join(os.fsencode(r) + b"\0" for r in sorted(included_rels, key=os.fsencode)))
    return 0 if complete else 3


# ---------------------------------------------------------------------------
# Verification helpers
# ---------------------------------------------------------------------------

# (action, resource, expected effect for the reviewer agents)
PROBES = [
    ("shell", "git status", "deny"),
    ("shell", "ls", "deny"),
    ("shell", "./gradlew assembleDebug", "deny"),
    ("edit", "src/main.kt", "deny"),
    ("edit", "README.md", "deny"),
    ("webfetch", "https://example.com", "deny"),
    ("websearch", "anything", "deny"),
    ("subagent", "explore", "deny"),
    ("subagent", "general", "deny"),
    ("skill", "anything", "deny"),
    ("execute", "*", "deny"),
    ("external_directory", "/root/.ssh", "deny"),
    ("external_directory", "/etc", "deny"),
    ("read", ".env", "deny"),
    ("read", "config/.env.production", "deny"),
    ("read", "keys/server.pem", "deny"),
    ("read", "deploy/.ssh/id_ed25519", "deny"),
    ("read", ".ssh/config", "deny"),
    ("read", ".gnupg/pubring.kbx", "deny"),
    ("read", ".git/config", "deny"),
    ("read", ".npmrc", "deny"),
    ("read", "app/local.properties", "deny"),
    ("read", "app/keystore.properties", "deny"),
    ("read", "config/prod.secrets.yaml", "deny"),
    ("read", "app-secrets.json", "deny"),
    ("read", "oauth/client_secret_123.json", "deny"),
    ("read", "infra/terraform.tfstate", "deny"),
    ("read", ".env.example", "allow"),
    ("read", "gradle.properties", "allow"),
    ("read", "src/main.kt", "allow"),
    ("glob", "**/*.kt", "allow"),
    ("glob", "src/**/*.{kt,java}", "allow"),
    ("glob", "/root/**", "deny"),
    ("glob", "{/root,x}/.ssh/*", "deny"),
    ("glob", "../**", "deny"),
    ("grep", "TODO", "allow"),
    ("question", "*", "allow"),
    ("experimental_image_generate", "x", "deny"),
    ("browser", "x", "deny"),
    ("unknown_future_tool", "x", "deny"),
]


def _model_string(model) -> str:
    """Normalise the model reference `debug agents` prints (string or object form).

    The object form has been seen with `model` (config schema) and `id`
    (resolved agent, 2.2.6: {"id": ..., "providerID": ...}) as the model key;
    `modelID` is accepted as well, nothing else is."""
    if isinstance(model, dict):
        provider = model.get("providerID") or model.get("provider")
        name = model.get("id") or model.get("modelID") or model.get("model")
        if not provider or not name:
            return f"<unparsed model reference {json.dumps(model, sort_keys=True)}>"
        base = f"{provider}/{name}"
        if model.get("variant"):
            base += f"#{model['variant']}"
        return base
    return str(model)


def verify_agents(payload, deny_read: list[str] = ()) -> None:
    if not isinstance(payload, list):
        _die("debug agents output is not a JSON array")
    # The launch's own read denials (included Git config files) must resolve to deny too.
    probes = PROBES + [("read", p, "deny") for p in deny_read]
    by_id = {a.get("id"): a for a in payload if isinstance(a, dict)}
    expected_visible = set(REVIEW_AGENTS)
    visible = {i for i, a in by_id.items() if not a.get("hidden")}
    if visible != expected_visible:
        _die(f"unexpected visible agents: {sorted(visible)} (expected {sorted(expected_visible)})")
    for name in BUILTIN_DISABLED:
        if name in by_id:
            _die(f"built-in agent {name!r} is still enabled")
    for name, agent in by_id.items():
        rules = agent.get("permissions")
        if not isinstance(rules, list) or not rules:
            _die(f"agent {name!r} has no resolved permissions")
        for action, resource, expected in probes:
            got = decide(rules, action, resource)
            if name in REVIEW_AGENTS:
                if got != expected:
                    _die(f"agent {name!r}: {action} {resource!r} resolves to {got}, expected {expected}")
            elif got != "deny":
                # Hidden maintenance agents must never get a tool at all.
                _die(f"hidden agent {name!r}: {action} {resource!r} resolves to {got}, expected deny")
        if name in REVIEW_AGENTS:
            model_id = _model_string(agent.get("model"))
            want = APPROVED_MODELS[REVIEW_AGENTS[name]]
            if model_id != want:
                _die(f"agent {name!r} model is {model_id!r}, expected {want!r}")
            if agent.get("mode") != "primary":
                _die(f"agent {name!r} mode is {agent.get('mode')!r}, expected primary")
    print(f"agents ok: {', '.join(sorted(visible))} visible; {len(by_id)} resolved; {len(probes)} probes each")


def verify_models(lines: list[str]) -> None:
    offered = {line.strip() for line in lines if line.strip()}
    approved = set(APPROVED_MODELS.values())
    if offered != approved:
        extra = sorted(offered - approved)
        missing = sorted(approved - offered)
        parts = []
        if extra:
            parts.append(f"unapproved models offered: {extra}")
        if missing:
            parts.append(f"approved models missing: {missing}")
        _die("; ".join(parts))
    print(f"models ok: exactly {sorted(approved)}")


def verify_sources(payload, config_dir: str, config_file: str) -> None:
    if not isinstance(payload, list):
        _die("debug config output is not a JSON array")
    seen_file = False
    for entry in payload:
        kind = entry.get("type")
        path = entry.get("path")
        if kind == "directory" and path == config_dir:
            continue
        if kind == "document" and path == config_file:
            seen_file = True
            continue
        _die(f"unexpected configuration source: {kind} {path}")
    if not seen_file:
        _die(f"oauto config document {config_file} is not loaded")
    print(f"config sources ok: only {config_file}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(prog="oauto-policy")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_render = sub.add_parser("render")
    p_render.add_argument("--model", default=DEFAULT_ALIAS, choices=sorted(APPROVED_MODELS))
    p_render.add_argument("--disable-model", action="append", default=[],
                          help="additional provider/model id to disable (repeatable)")
    p_render.add_argument("--deny-read", action="append", default=[], metavar="PATH",
                          help="exact repository-relative path the reviewer may not read (repeatable)")

    p_scan = sub.add_parser("scan")
    p_scan.add_argument("repo")
    p_scan.add_argument("--budget", type=float, default=180.0, help="seconds before the scan gives up (exit 3)")
    p_scan.add_argument("--config-origins", metavar="FILE",
                        help="git config --list --show-origin -z output: every config file git loaded")
    p_scan.add_argument("--included-out", metavar="FILE",
                        help="write the in-repository files .git/config includes, NUL-terminated")

    p_classify = sub.add_parser("classify")
    p_classify.add_argument("-z", dest="nul", action="store_true",
                            help="NUL-delimited paths on stdin, bytes-exact; NUL-terminated output")
    p_classify.add_argument("--renames", metavar="FILE",
                            help="concatenated `git diff --name-status -z -M` output (needs -z)")
    p_classify.add_argument("--display", metavar="FILE",
                            help="write the excluded paths C-quoted, one per line (needs -z)")
    p_classify.add_argument("--content-candidates", metavar="FILE",
                            help="write the not-excluded paths that have a content check, NUL-terminated (needs -z)")
    p_classify.add_argument("--extra-sensitive", metavar="FILE",
                            help="NUL-terminated paths to treat as secret-like: included Git config files (needs -z)")
    p_check = sub.add_parser("check-excluded")
    p_check.add_argument("excluded", help="NUL-delimited excluded paths (classify -z output)")
    p_check.add_argument("remaining", help="NUL-delimited paths the preflight still diffs")
    p_cdc = sub.add_parser("check-diff-content")
    p_cdc.add_argument("--checker", metavar="KEY",
                       help="CONTENT_CHECKS key to apply (a rename/copy partner's) instead of the one the name selects")
    p_cdc.add_argument("path", help="repository-relative path whose diff is on stdin")
    sub.add_parser("quote-path")
    sub.add_parser("verify-sources").add_argument("--config-dir", required=True)
    sub.add_parser("verify-agents").add_argument("--deny-read", action="append", default=[], metavar="PATH",
                                                 help="also probe that the reviewers cannot read PATH (repeatable)")
    sub.add_parser("verify-models")
    sub.add_parser("approved")

    args = parser.parse_args(argv)

    if args.cmd == "render":
        deny_read = list(dict.fromkeys(p for p in args.deny_read if p))
        inexact = [p for p in deny_read if any(c in p for c in "*?[")]
        if inexact:
            _die(f"refusing to render: --deny-read takes exact paths; glob metacharacter in {', '.join(_q(p) for p in inexact)}")
        doc = render(args.model, args.disable_model, deny_read)
        json.dump(doc, sys.stdout, indent=2)
        sys.stdout.write("\n")
    elif args.cmd == "scan":
        sys.exit(scan(args.repo, args.budget, args.included_out, args.config_origins))
    elif args.cmd == "classify":
        if args.nul:
            renames = _read_bytes(args.renames) if args.renames else None
            extra = frozenset(_nul_fields(_read_bytes(args.extra_sensitive), "--extra-sensitive", terminated=True)) \
                if args.extra_sensitive else frozenset()
            classify_z(sys.stdin.buffer.read(), renames, args.display, args.content_candidates, extra)
        elif args.renames or args.display or args.content_candidates or args.extra_sensitive:
            _die("--renames, --display, --content-candidates and --extra-sensitive need -z")
        else:
            for line in sys.stdin.read().splitlines():
                if line and is_sensitive_path(line):
                    print(line)
    elif args.cmd == "check-excluded":
        check_excluded(args.excluded, args.remaining)
    elif args.cmd == "check-diff-content":
        sys.exit(check_diff_content(args.path, args.checker))
    elif args.cmd == "quote-path":
        for path in _nul_fields(sys.stdin.buffer.read(), "quote-path", terminated=False):
            print(git_quote(path))
    elif args.cmd == "verify-sources":
        config_dir = args.config_dir.rstrip("/")
        verify_sources(json.load(sys.stdin), config_dir, os.path.join(config_dir, "opencode.json"))
    elif args.cmd == "verify-agents":
        verify_agents(json.load(sys.stdin), args.deny_read)
    elif args.cmd == "verify-models":
        verify_models(sys.stdin.read().splitlines())
    elif args.cmd == "approved":
        for alias, mid in APPROVED_MODELS.items():
            print(f"{alias}\t{mid}")


if __name__ == "__main__":
    main(sys.argv[1:])
