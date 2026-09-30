#!/usr/bin/env bash
#
# bench-diff.sh — diff working-tree perf against a git ref using two processes.
#
# Usage:
#   scripts/bench-diff.sh                    # working tree vs main, both benches
#   scripts/bench-diff.sh <ref>              # working tree vs <ref>, both benches
#   scripts/bench-diff.sh <ref> trace        # only trace bench
#   scripts/bench-diff.sh <ref> generate     # only generate bench
#
# Why two-process: in-process DIFF=1 mode shows a structural ~20-50% gap on
# init benches even when both columns are byte-identical, because V8 specializes
# distinct module instances asymmetrically when the bench chains
# `new Consumer(...).originalPositionFor(...)`. Running each side in its own
# process eliminates the cross-module artifact at the cost of a 2× wall-clock
# bench run.
#
# Mechanism:
#   1. Run yarn bench:jridgewell:<which> in working tree → candidate output.
#   2. Save working-tree source-map.js / source-map.d.ts / package.json / lib/.
#   3. Overlay <ref>'s versions of those files into the working tree.
#   4. Run yarn bench:jridgewell:<which> → baseline output.
#   5. Restore working tree (always, via trap).
#   6. Print the candidate-vs-baseline delta of "source-map-js current" lines.

set -euo pipefail

BASELINE_REF="${1:-main}"
WHICH="${2:-both}"

case "$WHICH" in
  trace|generate|both) ;;
  *) echo "ERROR: unknown bench '$WHICH' (expected: trace, generate, both)" >&2; exit 1 ;;
esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

if ! git rev-parse --verify "$BASELINE_REF" >/dev/null 2>&1; then
  echo "ERROR: baseline ref '$BASELINE_REF' not found." >&2
  exit 1
fi

BACKUP_DIR="$(mktemp -d)"
EXTRACT_DIR="$(mktemp -d)"
CANDIDATE_LOG="$(mktemp -t bench-cand.XXXXXX)"
BASELINE_LOG="$(mktemp -t bench-base.XXXXXX)"
RESTORED=0

restore_working_tree() {
  if [ -f "$BACKUP_DIR/source-map.js" ]; then
    cp "$BACKUP_DIR/source-map.js"   ./source-map.js
    cp "$BACKUP_DIR/source-map.d.ts" ./source-map.d.ts
    cp "$BACKUP_DIR/package.json"    ./package.json
    rm -rf ./lib
    cp -R "$BACKUP_DIR/lib" ./lib
  fi
}

cleanup() {
  if [ "$RESTORED" -eq 0 ]; then
    restore_working_tree
  fi
  rm -rf "$BACKUP_DIR" "$EXTRACT_DIR"
}
trap cleanup EXIT INT TERM

CANDIDATE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
CANDIDATE_SHA="$(git rev-parse HEAD)"
BASELINE_SHA="$(git rev-parse "$BASELINE_REF")"

DIRTY=""
if ! git diff --quiet || ! git diff --cached --quiet; then
  DIRTY=" + uncommitted changes"
fi

echo "================================================================="
echo "  bench-diff (two-process)"
echo "================================================================="
echo "  candidate = $CANDIDATE_BRANCH @ ${CANDIDATE_SHA:0:10}$DIRTY"
echo "  baseline  = $BASELINE_REF @ ${BASELINE_SHA:0:10}"
echo "  bench     = $WHICH"
echo "  cand log  = $CANDIDATE_LOG"
echo "  base log  = $BASELINE_LOG"
echo "================================================================="

run_benches() {
  local out="$1"
  : > "$out"
  if [ "$WHICH" = "trace" ] || [ "$WHICH" = "both" ]; then
    yarn bench:jridgewell:trace 2>&1 | tee -a "$out"
  fi
  if [ "$WHICH" = "generate" ] || [ "$WHICH" = "both" ]; then
    yarn bench:jridgewell:generate 2>&1 | tee -a "$out"
  fi
}

echo ""
echo "--- Run 1/2: CANDIDATE ($CANDIDATE_BRANCH) ---"
run_benches "$CANDIDATE_LOG"

echo ""
echo "--- Overlaying baseline ($BASELINE_REF) into working tree ---"
cp ./source-map.js   "$BACKUP_DIR/source-map.js"
cp ./source-map.d.ts "$BACKUP_DIR/source-map.d.ts"
cp ./package.json    "$BACKUP_DIR/package.json"
cp -R ./lib          "$BACKUP_DIR/lib"

git archive "$BASELINE_REF" source-map.js source-map.d.ts package.json lib | tar -x -C "$EXTRACT_DIR"
cp "$EXTRACT_DIR/source-map.js"   ./source-map.js
cp "$EXTRACT_DIR/source-map.d.ts" ./source-map.d.ts
cp "$EXTRACT_DIR/package.json"    ./package.json
rm -rf ./lib
cp -R "$EXTRACT_DIR/lib" ./lib

echo ""
echo "--- Run 2/2: BASELINE ($BASELINE_REF) ---"
run_benches "$BASELINE_LOG"

restore_working_tree
RESTORED=1

echo ""
echo "================================================================="
echo "  Delta (candidate vs baseline) — only \"source-map-js current\" lines"
echo "================================================================="
node "$ROOT/scripts/bench-delta.js" "$CANDIDATE_LOG" "$BASELINE_LOG"
