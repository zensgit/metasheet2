#!/usr/bin/env bash
# Stand-in for scripts/ops/attendance-preflight.sh on the fake deploy host.
echo "[attendance-preflight] harness stand-in"
exit "${H_PREFLIGHT_RC:-0}"
