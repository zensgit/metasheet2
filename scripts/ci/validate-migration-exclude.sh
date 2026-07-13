#!/usr/bin/env bash
# Validates the three independent migration exclusion/skip mechanisms in this repo for
# undocumented drift between them. WARN-ONLY — see "Semantics" below; this script never
# fails the build.
#
# The three mechanisms (full account in packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md
# and docs/development/superseded-legacy-migrations-gap-audit-20260710.md):
#   1. The CI per-PR gate's MIGRATION_EXCLUDE — .github/workflows/plugin-tests.yml (x2),
#      observability-strict.yml, observability-e2e.yml, safety-guard-e2e.yml. Drops a
#      migration entirely (no history marker).
#   2. migration-replay.yml's OWN MIGRATION_EXCLUDE subset — a narrower, independently
#      evolving list for a different job (db:migrate run twice, assert idempotency).
#   3. SUPERSEDED_LEGACY_SQL_MIGRATIONS in
#      packages/core-backend/src/db/migration-provider.ts — turns a migration into a
#      no-op history marker (name stays, body doesn't run) instead of dropping it.
#
# These differ from each other ON PURPOSE in most cases; unifying them by force would break
# the CI/replay lanes that depend on their specific shapes. This guard does not try to make
# them converge — it flags drift that looks UNDOCUMENTED so a human can decide whether it's
# fine (and should be added to the KNOWN_* tables below with a citation) or a real bug.
#
# Coverage (T8, 2026-07-12): previously this script only checked whether MIGRATION_EXCLUDE
# (a single env var, as inherited by this process) contained 3 hardcoded filenames. It now
# reads the actual workflow files and migration-provider.ts directly and checks:
#   A. every item in every CI-gate/replay MIGRATION_EXCLUDE occurrence against the full known
#      baseline (11 items, not 3) — anything extra is reported as a possibly-undocumented new
#      exclusion;
#   B. every occurrence-to-occurrence divergence within those six occurrences against a table
#      of KNOWN, already-reviewed divergences (see MIGRATION_EXCLUDE_TRACKING.md) — anything
#      not in that table is reported as new/undocumented drift;
#   C. the overlap between MIGRATION_EXCLUDE and SUPERSEDED_LEGACY_SQL_MIGRATIONS against the
#      known 3-item overlap (042a/048/049) — a new overlap item, or a missing expected one, is
#      reported;
#   D. a size canary + doc-pointer presence check on SUPERSEDED_LEGACY_SQL_MIGRATIONS itself.
#
# Semantics: WARN-ONLY, unchanged from before this pass — this script always exits 0 and is
# not wired into any workflow today (confirmed unused via repo-wide grep before this rewrite).
# If undocumented drift found here should actually block a merge, that is a behavior change
# (fail-closed + CI wiring) that needs an explicit owner decision — this script does not make
# that call unilaterally. See the PR that introduced this version for that recommendation.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# Overridable so tests can point this at fixture files instead of the real repo (see
# scripts/ci/__tests__/validate-migration-exclude.test.sh).
WORKFLOWS_DIR="${WORKFLOWS_DIR:-$REPO_ROOT/.github/workflows}"
PROVIDER_FILE="${PROVIDER_FILE:-$REPO_ROOT/packages/core-backend/src/db/migration-provider.ts}"

# Known baseline: the union of every item that has appeared, with review, in any CI
# per-PR-gate / migration-replay MIGRATION_EXCLUDE occurrence as of 2026-07-13.
# (#4162 follow-up, 2026-07-13: 20250924120000_create_views_view_states.ts and the three
# snapshot-cluster migrations — 20251117000001_add_snapshot_labels.ts,
# 20251117000002_create_protection_rules.ts, 20251201000001_create_change_management_tables.ts —
# were RE-ENABLED across all five workflow lists at once and removed from this baseline; if one
# of them reappears in a list, this guard now reports it as a possibly-undocumented NEW exclusion.)
KNOWN_BASELINE_ITEMS='008_plugin_infrastructure.sql
048_create_event_bus_tables.sql
049_create_bpmn_workflow_tables.sql
042a_core_model_views.sql
20250924140000_create_gantt_tables.ts
20250925_create_view_tables.sql
zzzz20260114110000_create_user_orgs_table.ts'

# Known, reviewed occurrence-to-occurrence divergences: "<item>|<workflow-file-basename that
# is known to OMIT it, while the rest of the baseline occurrences include it>". See
# packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md for the full per-row explanation
# (git-blame-verified commits/PRs, not guessed).
KNOWN_DIVERGENCES='20250925_create_view_tables.sql|migration-replay.yml
zzzz20260114110000_create_user_orgs_table.ts|plugin-tests.yml'

# Known, reviewed overlap between MIGRATION_EXCLUDE (mechanisms #1/#2) and
# SUPERSEDED_LEGACY_SQL_MIGRATIONS (mechanism #3) — confirmed intentional/harmless by the
# 2026-07-10 audit (docs/development/superseded-legacy-migrations-gap-audit-20260710.md §0).
KNOWN_SUPERSEDED_OVERLAP='042a_core_model_views
048_create_event_bus_tables
049_create_bpmn_workflow_tables'

# The array has 30 entries as of 2026-07-12 (counted directly from migration-provider.ts, not
# copied from the audit doc — docs/development/superseded-legacy-migrations-gap-audit-20260710.md
# §0 says "29 项", which appears to be an off-by-one in that doc's count rather than in the code;
# this guard trusts the source file).
EXPECTED_SUPERSEDED_COUNT=30

WARN_COUNT=0

warn() {
  echo "⚠️  $*"
  WARN_COUNT=$((WARN_COUNT + 1))
}

info() {
  echo "ℹ️  $*"
}

ok() {
  echo "✅ $*"
}

trim() {
  local s="$1"
  # shellcheck disable=SC2295
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Strip a .sql/.ts/.js/.mjs/.mts extension, mirroring migration-provider.ts's
# normalizeMigrationName, so items can be compared across mechanisms #1/#2 (filenames with
# extensions) and #3 (bare migration names).
strip_ext() {
  local s="$1"
  s="${s%.sql}"
  s="${s%.ts}"
  s="${s%.js}"
  s="${s%.mjs}"
  s="${s%.mts}"
  printf '%s' "$s"
}

# $1 = item, $2 = newline-delimited list (single string). Returns 0 if present.
item_in_list() {
  local item="$1" list="$2" line
  while IFS= read -r line; do
    line="$(trim "$line")"
    [[ -z "$line" ]] && continue
    [[ "$line" == "$item" ]] && return 0
  done <<< "$list"
  return 1
}

# Prints "<file-basename>:<line>\t<csv-value>" for every MIGRATION_EXCLUDE occurrence found
# under .github/workflows.
collect_occurrences() {
  local f lineno rest value
  for f in "$WORKFLOWS_DIR"/*.yml; do
    [[ -f "$f" ]] || continue
    while IFS=: read -r lineno rest; do
      [[ -z "${lineno:-}" ]] && continue
      value="${rest#*MIGRATION_EXCLUDE:}"
      value="$(trim "$value")"
      printf '%s:%s\t%s\n' "$(basename "$f")" "$lineno" "$value"
    done < <(grep -n "MIGRATION_EXCLUDE:" "$f" 2>/dev/null || true)
  done
}

# Extracts SUPERSEDED_LEGACY_SQL_MIGRATIONS entries (bare names, one per line) from
# migration-provider.ts.
extract_superseded_list() {
  [[ -f "$PROVIDER_FILE" ]] || return 0
  awk '
    /const SUPERSEDED_LEGACY_SQL_MIGRATIONS = \[/ { collecting = 1; next }
    collecting && /^\]/ { collecting = 0 }
    collecting { print }
  ' "$PROVIDER_FILE" | sed -n "s/^[[:space:]]*'\\([^']*\\)'.*/\\1/p"
}

# run_checks() performs all of A/B/C/D above and prints findings, but never calls exit — it is
# the testable core (see scripts/ci/__tests__/validate-migration-exclude.test.sh, which sources
# this file and calls run_checks directly against fixture WORKFLOWS_DIR/PROVIDER_FILE values).
# Resets and leaves the result in WARN_COUNT. main() below is the only thing that exits.
run_checks() {
  WARN_COUNT=0

  if [[ ! -d "$WORKFLOWS_DIR" ]]; then
    warn "workflows directory not found at $WORKFLOWS_DIR — cannot check CI-gate/replay lists."
  fi

  local occurrences
  occurrences="$(collect_occurrences)"

  if [[ -z "$occurrences" ]]; then
    warn "No MIGRATION_EXCLUDE occurrences found under $WORKFLOWS_DIR — expected at least 6."
  fi

  # --- A: every item in every occurrence must be a known baseline item ------------------
  local locref value item
  local seen_items=""
  while IFS=$'\t' read -r locref value; do
    [[ -z "${locref:-}" ]] && continue
    local IFS_SAVE="$IFS"
    IFS=','
    for item in $value; do
      IFS="$IFS_SAVE"
      item="$(trim "$item")"
      [[ -z "$item" ]] && continue
      seen_items="$seen_items
$item"
      if ! item_in_list "$item" "$KNOWN_BASELINE_ITEMS"; then
        warn "$locref excludes '$item', which is NOT in this guard's known baseline. Either this is a newly-added, undocumented exclusion (add a reason comment in the workflow file AND register it here), or the baseline below is out of date."
      fi
    done
    IFS="$IFS_SAVE"
  done <<< "$occurrences"

  # --- B: occurrence-to-occurrence divergences must be pre-registered as known ------------
  # For each known baseline item, find which occurrences include it and which omit it.
  local baseline_item
  while IFS= read -r baseline_item; do
    baseline_item="$(trim "$baseline_item")"
    [[ -z "$baseline_item" ]] && continue
    local including="" omitting=""
    while IFS=$'\t' read -r locref value; do
      [[ -z "${locref:-}" ]] && continue
      if [[ ",${value}," == *",${baseline_item},"* ]]; then
        including="$including $locref"
      else
        omitting="$omitting $locref"
      fi
    done <<< "$occurrences"

    if [[ -n "$(trim "$omitting")" && -n "$(trim "$including")" ]]; then
      # There is a real divergence for this item. Every file present in $omitting must be
      # covered by a KNOWN_DIVERGENCES row for this item, or it's undocumented drift.
      local o
      for o in $omitting; do
        local o_file="${o%%:*}"
        local known_row="${baseline_item}|${o_file}"
        if ! item_in_list "$known_row" "$KNOWN_DIVERGENCES"; then
          warn "Undocumented divergence: '$baseline_item' is excluded in [$(trim "$including")] but NOT in $o, and that omission is not in this guard's KNOWN_DIVERGENCES table. If reviewed and intentional, add a reason comment in $o_file and register '$known_row' here; otherwise this may be a stale or accidental omission."
        fi
      done
    fi
  done <<< "$KNOWN_BASELINE_ITEMS"

  # --- C: overlap between MIGRATION_EXCLUDE and SUPERSEDED_LEGACY_SQL_MIGRATIONS ----------
  local superseded_list
  superseded_list="$(extract_superseded_list)"

  if [[ -z "$superseded_list" ]]; then
    warn "Could not extract SUPERSEDED_LEGACY_SQL_MIGRATIONS from $PROVIDER_FILE (file missing, moved, or array shape changed) — overlap check (C) and size canary (D) skipped."
  else
    local superseded_count
    superseded_count="$(printf '%s\n' "$superseded_list" | sed '/^$/d' | wc -l | tr -d ' ')"

    # Unique, extension-stripped baseline items observed across all occurrences.
    local uniq_baseline_stripped=""
    local bi
    while IFS= read -r bi; do
      bi="$(trim "$bi")"
      [[ -z "$bi" ]] && continue
      local stripped
      stripped="$(strip_ext "$bi")"
      if ! item_in_list "$stripped" "$uniq_baseline_stripped"; then
        uniq_baseline_stripped="$uniq_baseline_stripped
$stripped"
      fi
    done <<< "$seen_items"

    local overlap_found=""
    while IFS= read -r stripped; do
      stripped="$(trim "$stripped")"
      [[ -z "$stripped" ]] && continue
      if item_in_list "$stripped" "$superseded_list"; then
        overlap_found="$overlap_found
$stripped"
        if ! item_in_list "$stripped" "$KNOWN_SUPERSEDED_OVERLAP"; then
          warn "'$stripped' appears in BOTH MIGRATION_EXCLUDE (CI-gate/replay) AND SUPERSEDED_LEGACY_SQL_MIGRATIONS, which is not in this guard's KNOWN_SUPERSEDED_OVERLAP table (042a/048/049 only). Double-listing is usually harmless (belt-and-suspenders) but should be a reviewed, cited decision, not a silent accident."
        fi
      fi
    done <<< "$uniq_baseline_stripped"

    local expected_overlap_item
    while IFS= read -r expected_overlap_item; do
      expected_overlap_item="$(trim "$expected_overlap_item")"
      [[ -z "$expected_overlap_item" ]] && continue
      if ! item_in_list "$expected_overlap_item" "$superseded_list"; then
        warn "Expected overlap item '$expected_overlap_item' is no longer in SUPERSEDED_LEGACY_SQL_MIGRATIONS — the known 3-item overlap with MIGRATION_EXCLUDE (042a/048/049) has changed; re-verify against docs/development/superseded-legacy-migrations-gap-audit-20260710.md."
      elif ! item_in_list "$expected_overlap_item" "$uniq_baseline_stripped"; then
        warn "Expected overlap item '$expected_overlap_item' is no longer excluded by any CI-gate/replay MIGRATION_EXCLUDE occurrence — the known 3-item overlap has changed; re-verify."
      fi
    done <<< "$KNOWN_SUPERSEDED_OVERLAP"

    # --- D: size canary + doc-pointer presence check --------------------------------------
    if [[ "$superseded_count" != "$EXPECTED_SUPERSEDED_COUNT" ]]; then
      info "SUPERSEDED_LEGACY_SQL_MIGRATIONS now has $superseded_count entries (this guard's baseline: $EXPECTED_SUPERSEDED_COUNT). Not a failure by itself — if you intentionally added/removed entries, confirm packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md and the audit doc are still accurate, then update EXPECTED_SUPERSEDED_COUNT in this script."
    fi

    if ! grep -q "migration-legacy-sql-skip-design-20260512" "$PROVIDER_FILE" 2>/dev/null; then
      warn "migration-provider.ts no longer references docs/development/migration-legacy-sql-skip-design-20260512.md near SUPERSEDED_LEGACY_SQL_MIGRATIONS — the design-doc pointer may have been removed."
    fi
  fi

  # --- Always-on informational note: the asymmetry this guard does not, and cannot, close --
  info "Known asymmetry (not a bug this guard can catch): production/on-prem 'db:migrate' runs"
  info "with NO MIGRATION_EXCLUDE at all. Only CI's per-PR gate trims the list above. #4162"
  info "follow-up (2026-07-13): views/view_states + the snapshot/protection-rule/change-management"
  info "migrations are re-enabled in CI and now DO get per-PR green runs; the still-excluded"
  info "remainder (008/048/049, 042a, gantt, 20250925) keeps this gap. Do not close it by"
  info "editing this script."
}

# main() is the only thing in this file that calls exit. It is intentionally NOT wired into any
# workflow today (see the header comment) and always exits 0 (warn-only, unchanged semantics).
main() {
  echo "🔎 Validating migration exclusion/skip lists for undocumented drift (warn-only, full coverage — T8)"
  echo

  run_checks

  echo
  if [[ "$WARN_COUNT" -eq 0 ]]; then
    ok "No undocumented drift detected across the three migration exclusion/skip lists."
  else
    echo "ℹ️  $WARN_COUNT warning(s) above. This is a WARN-ONLY guard — it does not fail CI and"
    echo "   is not wired into any workflow today. If you believe undocumented drift should"
    echo "   block a merge, that is a deliberate behavior change (fail-closed + CI wiring);"
    echo "   raise it with the owner rather than flipping this script unilaterally."
  fi
  exit 0
}

# Allow sourcing (for tests) without executing main.
if [[ "${BASH_SOURCE[0]:-$0}" == "${0}" ]]; then
  main "$@"
fi
