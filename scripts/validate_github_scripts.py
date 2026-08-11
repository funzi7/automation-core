#!/usr/bin/env python3
"""Run `node --check` on every inline actions/github-script program.

The authoritative policies remain inline in trusted workflow YAML. This
validator parses YAML using a loader that preserves the literal `on` key and
checks each github-script block without executing it.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import yaml


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


config = json.loads(Path("sync-config.json").read_text())
changed = {
    line.strip()
    for line in subprocess.run(
        ["git", "diff", "--name-only", "origin/main...HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
}
changed.update(
    line.strip()
    for line in subprocess.run(
        ["git", "diff", "--name-only"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
)

workflow_paths = []
for name in config["synced_workflows"]:
    source = Path("workflows") / name
    mirror = Path(".github/workflows") / name
    if str(source) in changed or str(mirror) in changed:
        workflow_paths.extend([source, mirror])

checked = 0
for workflow_path in workflow_paths:
    workflow = yaml.load(workflow_path.read_text(), Loader=WorkflowLoader)
    for location, script in github_scripts(workflow):
        if not script.strip():
            raise SystemExit(f"empty github-script block: {workflow_path}:{location}")
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".js", encoding="utf-8"
        ) as handle:
            handle.write("async function __validate__() {\n")
            handle.write(script)
            handle.write("\n}\n")
            handle.flush()
            subprocess.run(["node", "--check", handle.name], check=True)
        checked += 1
        print(f"  syntax ok: {workflow_path}:{location}")

if not checked:
    raise SystemExit("no changed github-script blocks found")
print(f"Checked {checked} github-script blocks.")
