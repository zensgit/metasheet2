#!/usr/bin/env bash
# Focused test for verify_no_loopback_frontend_config() in
# multitable-onprem-package-verify.sh — the check ported from
# scripts/ops/attendance-onprem-package-verify.sh's loopback rule (owner review #4604 P1:
# "reuse attendance's rule ... add positive AND negative fixtures ... without the negative
# fixture the check is unfalsifiable and worthless"). Sources the verify script (functions
# only, via its direct-execution guard) and exercises the function directly against
# synthesized apps/web/dist fixtures. No real on-prem package is required.
#
# Also pins the main-flow call site itself (review #4604 P2), not just the function's
# in-isolation logic — see the wiring check below.
#
#   bash scripts/ops/multitable-onprem-package-verify-loopback.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="${SCRIPT_DIR}/multitable-onprem-package-verify.sh"
pass=0
fail=0

run_case() {
  # $1=label  $2=expect(pass|<die-substring>)  $3=fixture_root  $4=func
  local label="$1" expect="$2" root="$3" func="$4" err rc
  err="$( ( source "$VERIFY"; "$func" "$root" ) 2>&1 )"
  rc=$?
  if [[ "$expect" == "pass" ]]; then
    if [[ $rc -eq 0 ]]; then echo "  PASS: ${label}"; pass=$((pass+1));
    else echo "  FAIL: ${label} — expected pass, rc=${rc}: ${err}"; fail=$((fail+1)); fi
  else
    if [[ $rc -ne 0 && "$err" == *"$expect"* ]]; then echo "  PASS: ${label} — died as expected (…${expect}…)"; pass=$((pass+1));
    else echo "  FAIL: ${label} — expected die containing '${expect}', rc=${rc}: ${err}"; fail=$((fail+1)); fi
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "## loopback frontend config verify — focused test"

# Positive: apps/web/dist present, bundle references a real (non-loopback) API host.
mkdir -p "${TMP}/ok/apps/web/dist/assets"
cat > "${TMP}/ok/apps/web/dist/assets/index-abc123.js" <<'JS'
const e={VITE_API_URL:"https://entity-host.example.internal",VITE_API_BASE:"https://entity-host.example.internal/api"};
JS
run_case "clean bundle (real host, no loopback)" pass "${TMP}/ok" verify_no_loopback_frontend_config

# Negative (a): VITE_API_URL + 127.0.0.1 — one corner of the alternation.
mkdir -p "${TMP}/bad_url_ip/apps/web/dist/assets"
cat > "${TMP}/bad_url_ip/apps/web/dist/assets/index-def456.js" <<'JS'
const e={VITE_API_URL:"http://127.0.0.1:4000"};
JS
run_case "loopback VITE_API_URL + 127.0.0.1 rejected" "embeds loopback VITE_API_* config" "${TMP}/bad_url_ip" verify_no_loopback_frontend_config

# Negative (b): VITE_API_BASE + localhost — the opposite corner (both tokens in the
# alternation must be load-bearing; a same-door fixture that only exercises one token
# would let the other rot unnoticed).
mkdir -p "${TMP}/bad_base_localhost/apps/web/dist/assets"
cat > "${TMP}/bad_base_localhost/apps/web/dist/assets/index-ghi789.js" <<'JS'
const e={VITE_API_BASE:"http://localhost:4000/api"};
JS
run_case "loopback VITE_API_BASE + localhost rejected" "embeds loopback VITE_API_* config" "${TMP}/bad_base_localhost" verify_no_loopback_frontend_config

# Negative (c): apps/web/dist missing entirely. search_extended_regex returns non-zero
# (no match) on a target directory that does not exist, which would otherwise let this
# case silently PASS instead of failing loud — the vacuous-pass hole this test closes.
run_case "apps/web/dist missing entirely rejected" "apps/web/dist missing" "${TMP}/no_web_dist" verify_no_loopback_frontend_config

# Wiring pin (review #4604 P2): the four cases above call verify_no_loopback_frontend_config
# directly, which proves the function's own logic but nothing about whether the main verify
# flow actually invokes it — deleting the call site (main flow, ~L1052) would leave this exact
# suite at 4/4 green. Grep for the literal top-level call (distinct from the `function
# verify_no_loopback_frontend_config() {` definition, which survives a call-site deletion) so
# removing the wiring reds this test instead of staying silently green.
if grep -qE '^\s*verify_no_loopback_frontend_config "\$pkg_root"\s*$' "$VERIFY"; then
  echo "  PASS: loopback check is wired into the main verify flow (call site present)"
  pass=$((pass+1))
else
  echo "  FAIL: loopback check call site not found in the main verify flow — the function is defined but not invoked"
  fail=$((fail+1))
fi

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
