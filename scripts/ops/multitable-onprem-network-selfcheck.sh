#!/usr/bin/env bash
set +x
set -eu
if ! command -v node >/dev/null 2>&1; then
  printf 'FAIL runtime httpStatus=0 time=%s elapsedMs=0 requestId=unavailable\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'HINT Verify the local Node runtime with an authorized operator; do not change security policy.\nSUMMARY PASS=0 FAIL=1 SKIP=0\n'
  exit 1
fi
node "$(dirname "${BASH_SOURCE[0]}")/multitable-onprem-network-selfcheck.mjs" "$@" 2>/dev/null
