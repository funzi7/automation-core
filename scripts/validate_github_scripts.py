#!/usr/bin/env python3
"""Run `node --check` on every inline actions/github-script program.

The authoritative policies remain inline in trusted workflow YAML. This
validator parses YAML using a loader that preserves the literal `on` key and
checks each github-script block without executing it.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import yaml


# GitHub template expansion can reject a workflow before it creates jobs when
# a large scalar contains a direct `${{ ... }}` interpolation. Keep large
# github-script programs data-only and pass workflow values through step env.
LARGE_SCRIPT_EXPRESSION_THRESHOLD = 10_000


class WorkflowLoader(yaml.SafeLoader):
    pass


for first_char, resolvers in list(WorkflowLoader.yaml_implicit_resolvers.items()):
    WorkflowLoader.yaml_implicit_resolvers[first_char] = [
        resolver
        for resolver in resolvers
        if resolver[0] != "tag:yaml.org,2002:bool"
    ]


def github_scripts(workflow: dict) -> list[tuple[str, str]]:
    scripts: list[tuple[str, str]] = []
    for job_name, job in (workflow.get("jobs") or {}).items():
        for index, step in enumerate(job.get("steps") or []):
            uses = str(step.get("uses") or "")
            if not uses.startswith("actions/github-script@"):
                continue
            script = str((step.get("with") or {}).get("script") or "")
            scripts.append((f"{job_name}:{index}:{step.get('name', 'unnamed')}", script))
    return scripts


def validate_expression_safety(workflow_path: Path, location: str, script: str) -> None:
    size = len(script.encode("utf-8"))
    if size < LARGE_SCRIPT_EXPRESSION_THRESHOLD:
        return
    if "${{" in script:
        raise SystemExit(
            "unsafe direct GitHub expression in large github-script block: "
            f"{workflow_path}:{location} ({size} bytes); pass the value via env"
        )
    print(f"  expression safe: {workflow_path}:{location} ({size} bytes)")


def has_unquoted_github_expression(script: str) -> bool:
    """Return true when an expression appears in executable JS, not a quote/comment."""
    state = "code"
    index = 0
    while index < len(script):
        pair = script[index : index + 2]
        if state == "code":
            if script.startswith("${{", index):
                return True
            if pair == "//":
                state = "line_comment"
                index += 2
                continue
            if pair == "/*":
                state = "block_comment"
                index += 2
                continue
            if script[index] in ("'", '"'):
                state = script[index]
            elif script[index] == "`":
                state = "template"
        elif state in ("'", '"'):
            if script.startswith("${{", index):
                end = script.find("}}", index + 3)
                if end < 0:
                    return True
                index = end + 2
                continue
            if script[index] == "\\":
                index += 2
                continue
            if script[index] == state:
                state = "code"
        elif state == "template":
            # A GitHub expression in template text can inject a backtick or a
            # `${...}` sequence, so require env transport here as well.
            if script.startswith("${{", index):
                return True
            if script[index] == "\\":
                index += 2
                continue
            if script[index] == "`":
                state = "code"
        elif state == "line_comment":
            if script[index] == "\n":
                state = "code"
        elif state == "block_comment" and pair == "*/":
            state = "code"
            index += 2
            continue
        index += 1
    return False


# Scan every tracked workflow candidate on every run. This deliberately covers
# synced source/mirror pairs, active hub-only workflows, and workflow templates;
# limiting the scan to sync-config would leave large hub-only github-script
# bodies vulnerable to the same pre-job GitHub template-expansion failure.
workflow_paths = [
    Path(line)
    for line in subprocess.run(
        ["git", "ls-files", "*.yml", "*.yaml"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    if line.strip()
]

checked = 0
for workflow_path in workflow_paths:
    workflow = yaml.load(workflow_path.read_text(), Loader=WorkflowLoader)
    for location, script in github_scripts(workflow):
        if not script.strip():
            raise SystemExit(f"empty github-script block: {workflow_path}:{location}")
        validate_expression_safety(workflow_path, location, script)
        if has_unquoted_github_expression(script):
            raise SystemExit(
                "unsafe unquoted GitHub expression in github-script block: "
                f"{workflow_path}:{location}; pass typed values via env"
            )
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".js", encoding="utf-8"
        ) as handle:
            handle.write("async function __validate__() {\n")
            # Quoted expressions remain literal JavaScript strings during this
            # syntax check. Unquoted/template expressions fail closed above
            # instead of being replaced with a universally valid fake value.
            handle.write(script)
            handle.write("\n}\n")
            handle.flush()
            subprocess.run(["node", "--check", handle.name], check=True)
        checked += 1
        print(f"  syntax ok: {workflow_path}:{location}")

if not checked:
    raise SystemExit("no github-script blocks found")
print(f"Checked {checked} github-script blocks.")
