#!/usr/bin/env bash
set -euo pipefail

SYN=10
REAL=15
while [[ $# -gt 0 ]]; do
  case "$1" in
    --synthetic) SYN="$2"; shift 2;;
    --real) REAL="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

BASE_URL=${BASE_URL:-http://127.0.0.1:8900}
TOKEN=${TOKEN:-}
AUTH_HEADER=""
if [[ -n "$TOKEN" ]]; then AUTH_HEADER="Authorization: Bearer $TOKEN"; fi

echo "[RBAC_TRAFFIC] Start synthetic=$SYN real=$REAL base=$BASE_URL token_present=$([[ -n $TOKEN ]] && echo yes || echo no)"

syn_ok=0
for i in $(seq 1 $SYN); do
  if curl -fsS "$BASE_URL/api/permissions/health" >/dev/null 2>&1; then syn_ok=$((syn_ok+1)); else echo "[RBAC_TRAFFIC] warn: synthetic call $i failed"; fi
done

real_ok=0
for i in $(seq 1 $REAL); do
  if (( i % 3 == 0 )); then
    curl -fsS -H "$AUTH_HEADER" "$BASE_URL/api/approvals/demo-1" >/dev/null 2>&1 && real_ok=$((real_ok+1)) || echo "[RBAC_TRAFFIC] warn: approve call $i failed"
  else
    curl -fsS -H "$AUTH_HEADER" "$BASE_URL/api/permissions?userId=u$i" >/dev/null 2>&1 && real_ok=$((real_ok+1)) || echo "[RBAC_TRAFFIC] warn: perm call $i failed"
  fi
done

echo "[RBAC_TRAFFIC] Summary synthetic_ok=$syn_ok/$SYN real_ok=$real_ok/$REAL"
echo "RBAC_TRAFFIC_RESULT synthetic_ok=$syn_ok synthetic_total=$SYN real_ok=$real_ok real_total=$REAL"
exit 0

