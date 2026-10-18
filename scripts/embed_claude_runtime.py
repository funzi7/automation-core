#!/usr/bin/env python3
"""Embed the audited runtime into both workflow copies; downstream sync is YAML-only."""
import argparse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
START = '          # BEGIN GENERATED CLAUDE RUNTIME\n'
END = '          # END GENERATED CLAUDE RUNTIME\n'


def generated():
    code = (ROOT / 'tools/claude_fixer_runtime.js').read_text()
    return START + '          cat > "$RUNNER_TEMP/claude-fixer-runtime.js" <<\'CLAUDE_RUNTIME\'\n' + ''.join(('          ' + line if line else '') + '\n' for line in code.splitlines()) + '          CLAUDE_RUNTIME\n' + END


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for relative in ['workflows/claude.yml', '.github/workflows/claude.yml']:
        file = ROOT / relative
        text = file.read_text()
        before, rest = text.split(START, 1)
        _, after = rest.split(END, 1)
        expected = before + generated() + after
        if args.check:
            if text != expected:
                raise SystemExit(f'Stale embedded runtime: {relative}; run python3 scripts/embed_claude_runtime.py')
        else:
            file.write_text(expected)

if __name__ == '__main__':
    main()
