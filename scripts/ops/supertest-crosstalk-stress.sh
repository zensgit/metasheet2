#!/bin/bash
# Reproducible stress entry for the #4154 supertest cross-talk A/B. Usage: supertest-crosstalk-stress.sh <core-backend-dir> <arm-name> [runs=25]
# Runs the FULL tests/unit lane (cross-talk needs whole-suite ephemeral-port churn) at retry=0.
set -u
DIR="$1"; ARM="$2"; RUNS="${3:-25}"
OUT="${STRESS_OUT_DIR:-/tmp/supertest-stress}/${ARM}"
mkdir -p "$OUT"
cd "$DIR" || exit 2
RED=0
for i in $(seq 1 "$RUNS"); do
  LOG="$OUT/run_${i}.log"
  npx vitest run tests/unit --retry=0 --reporter=dot > "$LOG" 2>&1
  CODE=$?
  if [ "$CODE" -ne 0 ]; then
    RED=$((RED+1))
    # Keep a compact record of which files failed this run.
    grep -E '^ *(FAIL|✗|×)|Test Files' "$LOG" | tail -20 > "$OUT/run_${i}.fail.txt"
    echo "run $i: RED (exit $CODE)"
  else
    echo "run $i: green"
    rm -f "$LOG"   # keep disk bounded; only red logs are retained
  fi
done
echo "ARM=$ARM RUNS=$RUNS RED=$RED"
