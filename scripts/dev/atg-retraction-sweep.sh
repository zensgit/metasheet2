#!/usr/bin/env bash
# atg-retraction-sweep.sh
#
# Mechanical retraction sweep for the approval-template-groups Phase 1 branch
# (impl-gate-A-slice1-round5-20260918.md P2-1).
#
# WHY THIS EXISTS: round 5's gate found that the round-4 retraction of the
# falsified "guard population ⊆ manager" / "no HTTP-reachable path" / "pure HTTP
# tests cannot construct a counterexample" claims had been fixed by ENUMERATING
# the three copies the round-4 report named, not by SCANNING the branch for every
# phrasing of the claim — so a fourth and fifth copy (design MD §3.5, verification
# MD §18.1) kept standing in the present tense after two of the three named copies
# were fixed. "按枚举逐处改,两轮都漏副本" (see verification MD §24). This script
# is the machine-countable half of not letting that happen a third time: run it
# over the CURRENT branch diff (against the merge-base, not a hardcoded commit)
# and read every hit yourself — this script does NOT classify hits as retracted
# vs. legitimate-historical-reference; a human must read each line's surrounding
# sentence and judge whether it asserts the falsified claim as a PRESENT-TENSE
# fact (bad) or narrates it as something already retracted/falsified (fine, e.g.
# "which is false", "已撤回", "已证伪", "过强声明").
#
# ROUND 6 (impl-gate-A-slice1-round6-20260918.md §2 P2-1): the fix that replaced
# "⊆" with "guard population ⊋ manager population (a strict superset)" was ITSELF
# the SAME failure mode one level up — a retracted overclaim replaced by a second,
# narrower-but-still-false overclaim, never covered by this script's own pattern
# set (P3-3 of that same report). The pattern set below is widened accordingly:
# every containment SYMBOL (⊆/⊇/⊂/⊃/⊋/⊊), every containment WORD in either
# language (子集/超集/严格超集/subset/superset/strict superset), and the two
# patterns round 5 had narrowed to require a specific co-occurring phrase on the
# SAME line ("纯 HTTP 测试.*无法制造", "通配权限码.*过 guard") are now bare
# substrings ("无法制造", "通配权限码") so a differently-worded restatement of the
# same claim cannot slip past by rephrasing the other half of the sentence.
#
# Usage:
#   scripts/dev/atg-retraction-sweep.sh [<base-ref>]
#   <base-ref> defaults to origin/main. The scan covers the file set from
#   `git diff --name-only <base-ref>..HEAD` — i.e. it follows the branch's own
#   diff, not a fixed file list, so it keeps covering new files the branch adds.
#
# Exit code is always 0 (this is a reporting tool, not a gate); read the output.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BASE_REF="${1:-origin/main}"

echo "=== scan scope: git diff --name-only $BASE_REF..HEAD ==="
FILES=$(git diff --name-only "$BASE_REF"..HEAD)
echo "$FILES"
echo

# Each pattern below is one phrasing of the falsified "guard population ⊆
# manager" family of claims (impl-gate-A-slice1-round4-20260918.md §2 P2-1,
# impl-gate-A-slice1-round5-20260918.md §2 P2-1). Kept as separate greps (not
# one big -E alternation) so a hit tells you WHICH phrasing survived, and so
# each pattern's own false-positive rate (e.g. "⊆" also appears in unrelated
# "export ⊆ read" commentary elsewhere in approvals.ts) is easy to see per-line
# rather than buried in one merged count.
declare -a PATTERNS=(
  '⊆'
  '⊇'
  '⊂'
  '⊃'
  '⊋'
  '⊊'
  '每个 *actor'
  'isTemplateManager *= *true'
  '没有.{0,6}HTTP *可达'
  '今天.{0,6}HTTP *可达路径'
  '无法制造'
  'guard population'
  'guard *人口'
  'sees everything'
  'wildcard permission'
  '通配权限码'
  '子集'
  '超集'
  '严格超集'
  'strict superset'
  'subset'
  'superset'
)

for pat in "${PATTERNS[@]}"; do
  echo "=== pattern: $pat ==="
  HIT=0
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    if grep -nE "$pat" "$f" >/tmp/atg-retraction-sweep.$$ 2>/dev/null; then
      HIT=1
      sed "s|^|$f:|" /tmp/atg-retraction-sweep.$$
    fi
    rm -f /tmp/atg-retraction-sweep.$$
  done <<<"$FILES"
  [ "$HIT" -eq 0 ] && echo "(zero hits)"
  echo
done

cat <<'EOF'
=== how to use this output ===
1. For every hit printed above, read the FULL sentence it sits in (open the
   file at that line, don't judge from the grep fragment alone).
2. If the sentence asserts a CONTAINMENT relationship as true of TODAY's
   behavior in EITHER direction ("guard population IS a subset of manager",
   "guard population is a strict SUPERSET of manager", "there is NO
   HTTP-reachable path today") -> that is a live P2, not a stale one. Both
   directions have already been found false once: round 5 found "⊆" false
   (impl-gate-A-slice1-round5-20260918.md §2 P2-1); round 6 found the "⊋"
   replacement ALSO false, in the opposite direction
   (impl-gate-A-slice1-round6-20260918.md §2 P2-1) — a principal holding only
   the guard's own literal `approval-templates:manage` code satisfies
   `isTemplateManager` but is refused by the guard itself (see verification
   MD §23.6's `ZZR4-EXACT-RESULT status=403`, and the lifecycle suite's
   "§2(d)" case). DO NOT rewrite a live hit into a THIRD containment claim in
   either direction. The measured relationship is: the two populations are
   MUTUALLY NON-INCLUSIVE (neither is a subset of the other), with one
   end-to-end-measured counterexample per direction — guard-pass/non-manager
   is the DB-side `isAdmin(userId)` leg (the §2(c) lifecycle test case);
   manager/guard-fail is the bare `approval-templates:manage` permission code
   (the §2(d) lifecycle test case) — and say nothing, either way, about
   whether a PRODUCTION provisioning path always pairs the two grants (that
   is a separate, unmeasured claim).
3. If the sentence narrates the claim as something ALREADY retracted or
   falsified ("which is false", "已撤回", "已证伪", "过强声明", "被撤回的声
   明"), or is a changelog-style "this round replaced X with Y" entry — that
   is legitimate history, not a live defect. Leave it. A sentence stating the
   measured "mutually non-inclusive" conclusion in PROSE (no containment
   symbol or word asserted as true) is also fine and will still show up as a
   hit on the word-patterns above — that is expected, not itself a defect;
   judge the SENTENCE, not the pattern match.
4. A hit on a "⊆"/"guard population" pattern in an UNRELATED sentence (e.g.
   `export ⊆ read`, a different endpoint's differential-privilege claim that
   has nothing to do with `approvalTemplateAdminGuard`/`isTemplateManager`) is
   a false positive of the pattern, not a retraction gap — confirm it is a
   different subject before dismissing it, don't dismiss on pattern name alone.
5. Re-run this script after any further edit to the files it lists and expect
   the count of "asserts as present-tense fact" hits (category 2 above) to be
   ZERO before calling the sweep done; category-3 historical hits are allowed
   to remain indefinitely.
EOF
