#!/usr/bin/env bash
# atg-exec-line-post-rebase-check.sh
#
# WHY THIS EXISTS (p3-hygiene-gate-A2-20260919.md §P2-1, verification MD §12.9):
# `apps/web/scripts/run-required-web-tests.sh` ends in ONE unconditional
# `exec npx vitest run <hundreds of tokens> --reporter=dot` line. Because it's
# a single overlong line, any rebase/three-way-merge that touches it while the
# OTHER side has also touched it is a known, repeated conflict point in this
# repo (see docs/development/integration-ui-consolidation-program-20260910.md
# :157/:167 and docs/development/multitable-remaining-development-inventory-
# and-sequencing-20260712.md:112 — both call the fix "take the union, drop
# nothing"). On 2026-09-18 a rebase on this branch resolved that collision by
# silently KEEPING BOTH versions of the line instead of erroring: the first
# (earlier) copy ran via bash's `exec` — which unconditionally replaces the
# process — so the second copy, carrying three new tokens
# (SessionOrgSwitcher.spec.ts / approvalTemplateGroupsClient /
# ApprovalTemplateGroupsPanel), was dead code. No existing reader caught it:
# the three consumers of this file (attendance-web-guard-workflow.spec.ts:57,
# stock-preparation-handoff.test.cjs:2888, and the FE verification MD's own
# recount script) all use first-match/tail semantics, and
# approval-ci-coverage-enumeration.test.ts's extractVitestTokensFromBashScript
# takes the UNION of tokens across ALL non-comment lines — so it counted the
# dead copy's tokens as "covered" without knowing that line never executes.
#
# This script is the mechanical precondition the gate report asked for: run
# it after any rebase/merge that could have touched this line, before trusting
# any token-count claim about it.
#
# Usage:
#   scripts/dev/atg-exec-line-post-rebase-check.sh [<script-path>] [<ref-a> <ref-b>]
#
#   <script-path> defaults to apps/web/scripts/run-required-web-tests.sh
#     (relative to the repo root; resolved via `git rev-parse --show-toplevel`).
#
#   <ref-a> <ref-b> are OPTIONAL git refs (e.g. two pre-rebase tips, or
#     ORIG_HEAD and the post-rebase tip) to diff token sets against, for the
#     "token set = union, nothing silently dropped" half of the check. Without
#     them, only the exec-line-count check runs.
#
# Checks:
#   1. Exactly ONE line in the current working-tree file matches
#      `^exec npx vitest run` (this is the load-bearing invariant: `exec`
#      unconditionally replaces the process, so a second such line is either
#      redundant or, worse, dead code hiding tokens nobody runs).
#   2. (only if <ref-a> <ref-b> given) The token set on the CURRENT file's
#      (sole) exec line is a SUPERSET of the union of the exec-line token sets
#      at <ref-a> and <ref-b> — i.e. a rebase/merge of those two states did not
#      silently drop a token either side had.
#
# Exit codes: 0 = both checks passed (or check 2 skipped); 1 = check 1 failed
# (duplicate/zero exec lines); 2 = check 2 failed (a token was dropped).
# This is a real precondition gate, not a reporting-only tool — a nonzero exit
# should block trusting the file's coverage claims until a human resolves it.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SCRIPT_PATH="${1:-apps/web/scripts/run-required-web-tests.sh}"
REF_A="${2:-}"
REF_B="${3:-}"

if [[ "$SCRIPT_PATH" == /* ]]; then
  ABS_PATH="$SCRIPT_PATH"
else
  ABS_PATH="$REPO_ROOT/$SCRIPT_PATH"
fi

if [[ ! -f "$ABS_PATH" ]]; then
  echo "FAIL: $SCRIPT_PATH not found under $REPO_ROOT" >&2
  exit 1
fi

extract_tokens_from_stream() {
  # Reads a script's content on stdin, prints the exec-line token set on
  # stdout (one token per line, sorted+uniqued). Fails loudly (via the caller
  # checking exec_line_count) if there isn't exactly one such line.
  grep -E '^exec npx vitest run ' | sed -E 's/^exec npx vitest run //' | tr ' ' '\n' | grep -vE '^--' | grep -v '^$' | sort -u
}

exec_line_count() {
  grep -c '^exec npx vitest run ' -- "$1" 2>/dev/null || true
}

echo "== Check 1: exactly one '^exec npx vitest run' line in $SCRIPT_PATH =="
COUNT="$(exec_line_count "$ABS_PATH")"
echo "found: $COUNT"

if [[ "$COUNT" -ne 1 ]]; then
  echo "FAIL: expected exactly 1 matching line, found $COUNT." >&2
  echo "Matching line numbers:" >&2
  grep -n '^exec npx vitest run ' -- "$ABS_PATH" | cut -d: -f1 >&2
  if [[ "$COUNT" -gt 1 ]]; then
    echo "-- token counts per matching line (to spot which is the dead duplicate) --" >&2
    grep -n '^exec npx vitest run ' -- "$ABS_PATH" | while IFS=: read -r lineno content; do
      tokcount=$(echo "$content" | sed -E 's/^[0-9]+://' | wc -w | tr -d ' ')
      echo "  line $lineno: $tokcount words" >&2
    done
  fi
  exit 1
fi
echo "PASS: exactly one exec line."

if [[ -z "$REF_A" || -z "$REF_B" ]]; then
  echo "== Check 2 skipped (no <ref-a> <ref-b> given) =="
  exit 0
fi

echo "== Check 2: current token set is a superset of the union of $REF_A and $REF_B =="

TMP_A="$(mktemp)"; TMP_B="$(mktemp)"; TMP_CUR="$(mktemp)"; TMP_UNION="$(mktemp)"
trap 'rm -f "$TMP_A" "$TMP_B" "$TMP_CUR" "$TMP_UNION"' EXIT

if [[ "$(exec_line_count <(git show "$REF_A:$SCRIPT_PATH" 2>/dev/null) 2>/dev/null || echo 0)" -lt 1 ]]; then
  : # tolerate refs where the file didn't have the marker yet; extract_tokens_from_stream will just be empty
fi

git show "$REF_A:$SCRIPT_PATH" 2>/dev/null | extract_tokens_from_stream > "$TMP_A" || true
git show "$REF_B:$SCRIPT_PATH" 2>/dev/null | extract_tokens_from_stream > "$TMP_B" || true
extract_tokens_from_stream < "$ABS_PATH" > "$TMP_CUR"

sort -u "$TMP_A" "$TMP_B" > "$TMP_UNION"

MISSING="$(comm -23 "$TMP_UNION" "$TMP_CUR" || true)"

if [[ -n "$MISSING" ]]; then
  echo "FAIL: the following tokens are present in $REF_A and/or $REF_B but MISSING from the current file's exec line:" >&2
  echo "$MISSING" >&2
  exit 2
fi

echo "PASS: current exec line's token set is a superset of the union of $REF_A/$REF_B (nothing silently dropped)."
exit 0
