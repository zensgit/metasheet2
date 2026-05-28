#!/usr/bin/env bash
# Focused test for the #1912 / build-provenance checks added to
# multitable-onprem-package-verify.sh. It sources the verify script (functions only,
# via its direct-execution guard) and exercises verify_build_provenance +
# verify_integration_fix_markers against synthesized fixtures — one positive case and
# three drift negatives, each asserting a SPECIFIC failure message. No real on-prem
# package is required, so this runs in well under a second.
#
#   bash scripts/ops/multitable-onprem-package-verify.provenance.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERIFY="${SCRIPT_DIR}/multitable-onprem-package-verify.sh"
FAKE_COMMIT="0123456789abcdef0123456789abcdef01234567"
MARKER="material-k3wise-customer-profile-v1"
FAILCLOSED="Unknown K3 WISE material profile"
pass=0
fail=0

make_fixture() {
  # $1=dir  $2=embedded(true|false)  $3=gitCommit  $4=include_marker(1|0)
  local d="$1" emb="$2" commit="$3" inc="$4"
  local ad="${d}/plugins/plugin-integration-core/lib/adapters"
  mkdir -p "$ad"
  cat > "${d}/BUILD_PROVENANCE.json" <<JSON
{
  "schema": "metasheet-onprem-build-provenance/v1",
  "packageName": "fixture",
  "gitCommit": "${commit}",
  "gitCommitShort": "${commit:0:12}",
  "builtAt": "2026-05-27T00:00:00Z",
  "fixMarkers": { "issue1912": { "embedded": ${emb} } }
}
JSON
  if [[ "$inc" == "1" ]]; then
    printf "const MATERIAL_CUSTOMER_PROFILE_ID = '%s'\n" "$MARKER" > "${ad}/k3-wise-document-templates.cjs"
  else
    printf "const X = 'no #1912 marker here'\n" > "${ad}/k3-wise-document-templates.cjs"
  fi
  printf "throw new AdapterValidationError(\`%s: x\`)\n" "$FAILCLOSED" > "${ad}/k3-wise-webapi-adapter.cjs"
}

run_case() {
  # $1=label  $2=expect(pass|<die-substring>)  $3=fixture_dir  $4=func
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

echo "## build-provenance / #1912 marker verify — focused test"

# Positive: real 40-hex commit, marker present, provenance claims embedded:true.
make_fixture "${TMP}/ok" true "$FAKE_COMMIT" 1
run_case "valid provenance shape"                 pass "${TMP}/ok" verify_build_provenance
run_case "marker present + provenance agrees"     pass "${TMP}/ok" verify_integration_fix_markers

# Negative (a): provenance claims embedded:true but the adapter marker is gone → stale adapter.
make_fixture "${TMP}/stale_adapter" true "$FAKE_COMMIT" 0
run_case "stale adapter (marker missing, prov claims true)" "stale adapter in the package" "${TMP}/stale_adapter" verify_integration_fix_markers

# Negative (b): blank gitCommit → provenance cannot prove its source.
make_fixture "${TMP}/bad_commit" true "" 1
run_case "blank gitCommit rejected" "gitCommit must be a full 40-hex" "${TMP}/bad_commit" verify_build_provenance

# Negative (c): marker present but provenance says embedded!=true → stale/lying provenance.
make_fixture "${TMP}/lying_prov" false "$FAKE_COMMIT" 1
run_case "provenance disagrees with present marker" "provenance file is stale or wrong" "${TMP}/lying_prov" verify_integration_fix_markers

echo
echo "RESULT: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
