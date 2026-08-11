#!/bin/bash
# validate.sh — Sanity check for automation-core itself
set -euo pipefail

echo "Validating all tracked workflow YAML..."
mapfile -t tracked_yml < <(git ls-files '*.yml')
for f in "${tracked_yml[@]}"; do
  if ! python3 -c "import yaml, pathlib; yaml.safe_load(pathlib.Path('$f').read_text())"; then
    echo "  invalid YAML: $f" >&2
    exit 1
  fi
  echo "  ok: $f"
done

echo "Validating JSON..."
python3 -c "import json; json.loads(open('sync-config.json').read()); print('  ok: sync-config.json')"

echo "Cross-checking sync-config.json mentions only existing workflows..."
python3 << 'EOF'
import json
import os

config = json.load(open('sync-config.json'))
existing = set(os.listdir('workflows'))

for wf in config['synced_workflows']:
    assert wf in existing, f"sync-config lists '{wf}' but file missing"
    print(f"  ok: {wf}")

print("All synced_workflows exist.")
EOF

echo "Checking source/active-mirror parity for every synced workflow..."
python3 << 'EOF'
import json
from pathlib import Path

config = json.loads(Path('sync-config.json').read_text())
for name in config['synced_workflows']:
    source = Path('workflows') / name
    mirror = Path('.github/workflows') / name
    assert source.read_bytes() == mirror.read_bytes(), f"source/mirror drift: {name}"
    print(f"  identical: {name}")
EOF

echo "Checking JavaScript helper syntax and deterministic logic tests..."
for f in tools/*.js; do
  node --check "$f"
  echo "  syntax ok: $f"
done
node --test tests/*.js

echo "Checking every github-script block in changed synced workflows..."
python3 scripts/validate_github_scripts.py

if command -v actionlint >/dev/null 2>&1; then
  echo "Running actionlint..."
  actionlint
else
  echo "actionlint not installed; skipped."
fi

git diff --check

echo "Validation complete."
