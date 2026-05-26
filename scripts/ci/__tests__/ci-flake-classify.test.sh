#!/usr/bin/env bash
# Unit test for ci-flake-classify.sh's infra-signature matcher (the testable core).
# Does NOT hit real CI (that would be flaky); feeds recorded incident excerpts to is_infra_log.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../ci-flake-classify.sh
source "$HERE/../ci-flake-classify.sh"
FIX="$HERE/../__fixtures__"
fail=0
assert_infra()    { if is_infra_log "$(cat "$1")"; then echo "ok   infra:   $(basename "$1")"; else echo "FAIL infra:   $(basename "$1") (expected match)"; fail=1; fi; }
assert_genuine()  { if is_infra_log "$(cat "$1")"; then echo "FAIL genuine: $(basename "$1") (matched infra, expected genuine)"; fail=1; else echo "ok   genuine: $(basename "$1")"; fi; }
assert_infra   "$FIX/infra-action-setup.txt"
assert_infra   "$FIX/infra-checkout-403.txt"
assert_genuine "$FIX/genuine-test-failure.txt"
assert_genuine "$FIX/genuine-app-403.txt"
[[ "$fail" == "0" ]] && { echo "ci-flake-classify matcher: PASS"; exit 0; } || { echo "ci-flake-classify matcher: FAIL"; exit 1; }
