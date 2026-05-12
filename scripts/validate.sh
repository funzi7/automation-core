#!/bin/bash
# validate.sh — Sanity check for automation-core itself
set -euo pipefail

echo "Validating YAML..."
for f in workflows/*.yml template/*.yml; do
  python3 -c "import yaml, pathlib; yaml.safe_load(pathlib.Path('$f').read_text())" && echo "  ok: $f"
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

echo "Validation complete."
