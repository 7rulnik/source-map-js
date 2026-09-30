#!/usr/bin/env bash
#
# profile.sh — run scripts/profile-driver.js under V8 profilers and emit:
#   tmp/profiles/$SCENARIO.cpuprofile      load in Chrome DevTools → Performance
#   tmp/profiles/$SCENARIO.heapprofile     load in Chrome DevTools → Memory → Allocation profile
#   tmp/profiles/$SCENARIO.prof.txt        node --prof text summary (V8 ticks)
#
# Usage:
#   scripts/profile.sh                                  # SCENARIO=opf, FIXTURE=babel.min.js.map
#   SCENARIO=init scripts/profile.sh
#   SCENARIO=eachmap-gen FIXTURE=vscode.map scripts/profile.sh
#   SCENARIO=opf MODE=cpu scripts/profile.sh            # cpu profile only (skip heap + prof)
#
# MODE values: all (default), cpu, heap, prof

set -euo pipefail

SCENARIO="${SCENARIO:-opf}"
FIXTURE="${FIXTURE:-babel.min.js.map}"
MODE="${MODE:-all}"

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

OUT_DIR="$ROOT/tmp/profiles"
mkdir -p "$OUT_DIR"

# Skip the per-call sandbox/permission overhead; --no-warnings keeps the
# output clean. --max-old-space-size matches the bench scripts so vscode.map
# doesn't OOM.
NODE_FLAGS=(--no-warnings --max-old-space-size=8192)

DRIVER="$ROOT/scripts/profile-driver.js"

export SCENARIO FIXTURE

run_cpu() {
  echo "--- CPU profile (SCENARIO=$SCENARIO FIXTURE=$FIXTURE) ---"
  rm -f "$OUT_DIR/$SCENARIO.cpuprofile"
  node "${NODE_FLAGS[@]}" \
    --cpu-prof \
    --cpu-prof-dir="$OUT_DIR" \
    --cpu-prof-name="$SCENARIO.cpuprofile" \
    --cpu-prof-interval=100 \
    "$DRIVER"
  echo "  → $OUT_DIR/$SCENARIO.cpuprofile"
}

run_heap() {
  echo "--- Heap allocation profile (SCENARIO=$SCENARIO FIXTURE=$FIXTURE) ---"
  rm -f "$OUT_DIR/$SCENARIO.heapprofile"
  node "${NODE_FLAGS[@]}" \
    --heap-prof \
    --heap-prof-dir="$OUT_DIR" \
    --heap-prof-name="$SCENARIO.heapprofile" \
    "$DRIVER"
  echo "  → $OUT_DIR/$SCENARIO.heapprofile"
}

run_prof() {
  echo "--- V8 tick profile (SCENARIO=$SCENARIO FIXTURE=$FIXTURE) ---"
  local work
  work="$(mktemp -d)"
  (
    cd "$work"
    node "${NODE_FLAGS[@]}" --prof "$DRIVER"
    local log
    log="$(ls isolate-*.log | head -n 1)"
    node --prof-process "$log" > "$OUT_DIR/$SCENARIO.prof.txt"
  )
  rm -rf "$work"
  echo "  → $OUT_DIR/$SCENARIO.prof.txt"
}

case "$MODE" in
  cpu)  run_cpu ;;
  heap) run_heap ;;
  prof) run_prof ;;
  all)  run_cpu; run_heap; run_prof ;;
  *) echo "ERROR: unknown MODE='$MODE' (expected: all, cpu, heap, prof)" >&2; exit 1 ;;
esac
