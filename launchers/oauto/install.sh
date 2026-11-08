#!/usr/bin/env bash
# install.sh — install the oauto launcher on the Termux/Debian device. Idempotent.
#
#   bash launchers/oauto/install.sh            # install / refresh
#   bash launchers/oauto/install.sh --verify   # report drift, change nothing
#
# Installs:
#   /root/work/bin/ai-launch                     (shared launcher, + opencode mode)
#   /root/work/bin/oauto-run, oauto-policy.py    (reviewer launcher + policy)
#   $TERMUX/usr/bin/oauto-launch                 (Termux entrypoint)
#   oauto() in Termux ~/.bashrc and Debian ~/.bashrc (marker-delimited blocks)
#
# A file that is replaced is first copied to <file>.backup-before-oauto-<UTC stamp>,
# following the existing /root/work/bin backup convention.
set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
LAUNCHERS="$(dirname "$HERE")"
BIN="${OAUTO_INSTALL_BIN:-/root/work/bin}"
TERMUX_BIN="${OAUTO_INSTALL_TERMUX_BIN:-/data/data/com.termux/files/usr/bin}"
TERMUX_HOME="${OAUTO_INSTALL_TERMUX_HOME:-/data/data/com.termux/files/home}"
DEBIAN_BASHRC="${OAUTO_INSTALL_BASHRC:-$HOME/.bashrc}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
VERIFY=0
case "${1:-}" in
  "") ;;
  --verify) VERIFY=1 ;;
  *) echo "usage: install.sh [--verify]" >&2; exit 64 ;;
esac
(( $# <= 1 )) || { echo "usage: install.sh [--verify]" >&2; exit 64; }
status=0

install_file() { # src dst mode
  local src="$1" dst="$2" mode="$3"
  if [[ -e "$dst" ]] && cmp -s "$src" "$dst"; then
    if [[ "$(stat -c %a "$dst")" == "$mode" ]]; then
      echo "  ok:        $dst"
    elif (( VERIFY )); then
      echo "  DRIFT:     $dst mode $(stat -c %a "$dst"), expected $mode"
      status=1
    else
      chmod "$mode" "$dst"
      echo "  mode set:  $dst ($mode)"
    fi
    return
  fi
  if (( VERIFY )); then
    echo "  DRIFT:     $dst differs from $src"
    status=1
    return
  fi
  mkdir -p "$(dirname "$dst")"
  if [[ -e "$dst" ]]; then
    cp -p "$dst" "$dst.backup-before-oauto-$STAMP"
    echo "  backup:    $dst.backup-before-oauto-$STAMP"
  fi
  install -m "$mode" "$src" "$dst"
  echo "  installed: $dst"
}

install_block() { # bashrc snippet-file
  local rc="$1" snippet="$2" start end starts ends
  start="$(head -1 "$snippet")"
  end="$(tail -1 "$snippet")"
  starts=0; ends=0
  if [[ -f "$rc" ]]; then
    starts="$(grep -cF -- "$start" "$rc" || true)"
    ends="$(grep -cF -- "$end" "$rc" || true)"
  fi
  if (( starts == 0 && ends == 0 )); then
    if (( VERIFY )); then
      echo "  MISSING:   $rc has no oauto block"
      status=1
      return
    fi
    # Append after a blank line; a last line without newline first gets one.
    if [[ -s "$rc" ]] && [[ "$(tail -c1 "$rc" | od -An -c | tr -d ' ')" != '\n' ]]; then
      printf '\n' >> "$rc"
    fi
    { printf '\n'; cat "$snippet"; } >> "$rc"
    echo "  appended:  $rc block"
    return
  fi
  if (( starts != 1 || ends != 1 )); then
    echo "  ERROR:     $rc has $starts start and $ends end markers for the oauto block; fix it by hand" >&2
    status=1
    return
  fi
  if awk -v s="$start" -v e="$end" 'index($0, s) {p=1} p {print} index($0, e) {p=0}' "$rc" | cmp -s - "$snippet"; then
    echo "  ok:        $rc ($start)"
    return
  fi
  if (( VERIFY )); then
    echo "  DRIFT:     $rc block differs from $snippet"
    status=1
    return
  fi
  # Replace the single existing block in place; everything else is preserved.
  cp -p "$rc" "$rc.backup-before-oauto-$STAMP"
  awk -v s="$start" -v e="$end" -v f="$snippet" '
    index($0, s) { while ((getline line < f) > 0) print line; close(f); skip=1; next }
    skip && index($0, e) { skip=0; next }
    !skip { print }
  ' "$rc" > "$rc.oauto-tmp"
  cat "$rc.oauto-tmp" > "$rc"
  rm -f "$rc.oauto-tmp"
  echo "  updated:   $rc block (backup $rc.backup-before-oauto-$STAMP)"
}

echo "oauto install ($([[ $VERIFY == 1 ]] && echo verify-only || echo apply))"
echo "Debian side:"
install_file "$LAUNCHERS/ai-launch" "$BIN/ai-launch" 755
install_file "$HERE/oauto-run" "$BIN/oauto-run" 755
install_file "$HERE/oauto-policy.py" "$BIN/oauto-policy.py" 644
install_block "$DEBIAN_BASHRC" "$HERE/debian-bashrc-snippet.sh"

if [[ -d "$TERMUX_BIN" && -d "$TERMUX_HOME" ]]; then
  echo "Termux side:"
  install_file "$HERE/termux/oauto-launch" "$TERMUX_BIN/oauto-launch" 755
  install_block "$TERMUX_HOME/.bashrc" "$HERE/termux/bashrc-snippet.sh"
else
  echo "Termux side: not reachable from here ($TERMUX_BIN); skipped"
fi

exit "$status"
