# attendance-window-runner-pipeline.lib.sh
#
# Shared pipeline helper for the attendance staging window-runner remote script
# (scripts/ops/attendance-staging-window-runner-remote.sh). Sourced, not executed.
#
# Contract (proven by scripts/ops/attendance-window-runner-pipeline.test.mjs, which runs
# this exact file under `bash -o pipefail -c`):
#   filtered_pipe <output_file> <grep_ere_pattern> -- <producer command...>
#   dsn_replace_database <dsn> <new_db_name>
#     Pure string transform (no I/O, no env reads) — see below.
#     Runs `<producer> 2>&1 | grep -E <pattern> > <output_file>` and returns:
#       0        when the producer succeeded — INCLUDING when grep matched ZERO lines
#                (an empty filter result is a normal outcome, e.g. quiet logs);
#       producer's exit code when the producer (first pipeline stage) failed,
#                regardless of whether grep happened to match its partial output;
#       grep's exit code when grep itself failed (rc > 1, e.g. a bad pattern).
#
# The caller is expected to run with pipefail enabled (`bash -o pipefail -c` or
# `set -o pipefail`); this helper additionally reads PIPESTATUS explicitly so the
# producer's failure is never masked by a succeeding grep, and a zero-match grep
# (rc=1) is never misread as a failure.

filtered_pipe() {
  local out_file="$1"
  local pattern="$2"
  shift 2
  if [ "${1:-}" = "--" ]; then
    shift
  fi
  if [ "$#" -eq 0 ]; then
    echo "[filtered_pipe] usage: filtered_pipe <output_file> <pattern> -- <cmd...>" >&2
    return 64
  fi

  local -a pipe_status
  set +e
  "$@" 2>&1 | grep -E "$pattern" > "$out_file"
  pipe_status=("${PIPESTATUS[@]}")
  set -e

  local producer_rc="${pipe_status[0]}"
  local grep_rc="${pipe_status[1]}"

  if [ "$producer_rc" -ne 0 ]; then
    echo "[filtered_pipe] producer failed rc=${producer_rc} (cmd: $*)" >&2
    return "$producer_rc"
  fi
  if [ "$grep_rc" -gt 1 ]; then
    echo "[filtered_pipe] grep failed rc=${grep_rc} (pattern: ${pattern})" >&2
    return "$grep_rc"
  fi
  # grep rc 0 (matches) or 1 (zero matches) with a healthy producer -> success.
  return 0
}

# dsn_replace_database <dsn> <new_db_name>
#
# Swaps the database-name path segment of a postgres/postgresql connection string,
# preserving scheme, userinfo, host, and port, and passing any query string through
# unchanged (e.g. `?sslmode=disable`). Used by the `migrate` action (action_migrate in
# attendance-staging-window-runner-remote.sh) to derive a rehearsal-DB DATABASE_URL from
# the staging backend container's own DATABASE_URL — same host/creds, different db name —
# without hardcoding host/port/credentials anywhere in this repo.
#
# Pure string transform: no I/O, no env reads, no external commands. Proven against
# representative DSNs (including the query-string form) by
# scripts/ops/attendance-window-runner-pipeline.test.mjs.
dsn_replace_database() {
  local dsn="$1" new_db="$2"
  local base="$dsn" query=""
  if [[ "$dsn" == *'?'* ]]; then
    base="${dsn%%\?*}"
    query="?${dsn#*\?}"
  fi
  printf '%s/%s%s' "${base%/*}" "$new_db" "$query"
}

# dsn_database_name <dsn>
# Extracts the db-name path segment (query string stripped) — the inverse read of
# dsn_replace_database, used by the rehearsal isolation guard to psql the real DB directly.
dsn_database_name() {
  local dsn="$1" base="$1"
  if [[ "$dsn" == *'?'* ]]; then
    base="${dsn%%\?*}"
  fi
  printf '%s' "${base##*/}"
}

# backend_override_environment_lines <set_window_env> <tasks_window_enabled>
#
# Pure text generator for action_deploy's persistent runner override (docker-compose.window-
# runner.override.yml, services.backend). Emits AT MOST ONE `    environment:` stanza (4-space
# indent, matching the override writer's `  backend:` nesting one level up) containing the
# rd-window keys (when set_window_env=rd-window) and/or TASKS_ENABLED (when
# tasks_window_enabled=true) — every key appears AT MOST ONCE across the whole stanza, and
# nothing is printed at all when neither flag applies (the `none` shape, matching the writer's
# pre-tasks_enabled behavior byte-for-byte). No I/O, no env reads: pure argv -> stdout, callable
# standalone (proven by scripts/ops/attendance-window-runner-pipeline.test.mjs) and by
# action_deploy in attendance-staging-window-runner-remote.sh.
backend_override_environment_lines() {
  local set_window_env="$1" tasks_window_enabled="$2"
  if [[ "$set_window_env" != "rd-window" && "$tasks_window_enabled" != "true" ]]; then
    return 0
  fi
  echo "    environment:"
  if [[ "$set_window_env" == "rd-window" ]]; then
    echo "      ATTENDANCE_SCHEDULER_ENABLED: \"true\""
    echo "      ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED: \"true\""
  fi
  if [[ "$tasks_window_enabled" == "true" ]]; then
    echo "      TASKS_ENABLED: \"true\""
  fi
}

# Rehearsal restore: clone-only function search_path shim (see action_migrate_rehearse in
# attendance-staging-window-runner-remote.sh). The candidate list comes from the source DB's
# catalog; these two helpers never let catalog text shape SQL beyond one exact line format.
#
# rehearsal_shim_candidates_sql
#   The read-only candidate query run against the SOURCE DB: public-schema sql/plpgsql functions
#   that are not extension members and do not already pin a search_path (a pinned one is left
#   untouched). Kept here as one literal so the test pins it byte for byte.
rehearsal_shim_candidates_sql() {
  printf '%s' 'SELECT pg_catalog.quote_ident(n.nspname) || '\''.'\'' || pg_catalog.quote_ident(p.proname) || '\''('\'' || pg_catalog.pg_get_function_identity_arguments(p.oid) || '\'')'\'' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE n.nspname = '\''public'\'' AND p.prokind = '\''f'\'' AND l.lanname IN ('\''sql'\'', '\''plpgsql'\'') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid OPERATOR(pg_catalog.=) '\''pg_catalog.pg_proc'\''::pg_catalog.regclass AND d.objid = p.oid AND d.deptype = '\''e'\'') AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE '\''search_path=%'\'') ORDER BY 1;'
}

# rehearsal_shim_parity_sql
#   md5 over every public function's (signature, proconfig), aggregated in a fixed order (an
#   aggregate's `ORDER BY 1` would sort by the constant 1, not the first column). Run against the
#   source and the clone
#   after the RESET: equal digests prove the clone starts the rehearsal migration from the source's
#   exact function configuration.
rehearsal_shim_parity_sql() {
  printf '%s' 'SELECT md5(coalesce(string_agg(p.oid::pg_catalog.regprocedure::text || '\''|'\'' || coalesce(pg_catalog.array_to_string(p.proconfig, '\'','\''), '\''-'\''), '\'';'\'' ORDER BY p.oid::pg_catalog.regprocedure::text COLLATE "C"), '\'''\'')) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '\''public'\'';'
}

# rehearsal_shim_validate_signatures <file>
#   Prints the number of non-empty lines. Returns 1 (printing nothing) if any line is not a
#   plain `public.<snake_case_name>(<identity arguments>)` signature — fail closed rather than
#   build an ALTER statement from an unexpected shape.
rehearsal_shim_validate_signatures() {
  local file="$1" line count=0
  # POSIX bracket expression: `]` must come first to be literal; backslash is literal inside.
  local re='^public\.[a-z_][a-z0-9_]*\([]A-Za-z0-9_ ,."[]*\)$'
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ $re ]] || return 1
    count=$((count + 1))
  done < "$file"
  echo "$count"
}

# rehearsal_shim_sql <set|reset> <file>
#   One `ALTER FUNCTION <signature> SET search_path = pg_catalog, public;` (or `RESET
#   search_path;`) per signature. Call only on a list rehearsal_shim_validate_signatures accepted.
rehearsal_shim_sql() {
  local mode="$1" file="$2" line clause
  case "$mode" in
    set) clause="SET search_path = pg_catalog, public" ;;
    reset) clause="RESET search_path" ;;
    *) return 1 ;;
  esac
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    printf 'ALTER FUNCTION %s %s;\n' "$line" "$clause"
  done < "$file"
}

# Owner-ruled staging migration exclusions (owner 2026-09-29: A-3 stays off staging until the
# owner approves applying it; "Add owner-ruled exclude"). These are the ONLY names that ever
# reach migrate.js as MIGRATION_EXCLUDE on the staging runner; an inherited MIGRATION_EXCLUDE is
# still a hazard that aborts. Removing an entry is a separate owner-ruled change, made together
# with applying that migration. Each migration lists the tables it would create; the runner
# proves they are still absent before and after every migration step.
STAGING_OWNER_EXCLUDED_MIGRATIONS=(
  zzzz20260919090000_create_approval_template_group_backfill_batches
)
STAGING_OWNER_EXCLUDED_TABLES=(
  approval_template_group_backfill_batches
  approval_template_group_backfill_batch_groups
  approval_template_group_backfill_batch_links
)

# staging_owner_excluded_names
#   One excluded migration name per line (nothing for an empty list). Returns 1, printing
#   nothing, if any name is not a plain [A-Za-z0-9_] migration basename.
staging_owner_excluded_names() {
  local name re='^[A-Za-z0-9_]+$' out=""
  for name in ${STAGING_OWNER_EXCLUDED_MIGRATIONS[@]+"${STAGING_OWNER_EXCLUDED_MIGRATIONS[@]}"}; do
    [[ "$name" =~ $re ]] || return 1
    out="${out}${name}"$'\n'
  done
  printf '%s' "$out"
}

# staging_owner_exclude_csv
#   The MIGRATION_EXCLUDE value (comma-separated, empty for an empty list). Same validation.
staging_owner_exclude_csv() {
  local names
  names="$(staging_owner_excluded_names)" || return 1
  printf '%s' "$names" | tr '\n' ',' | sed 's/,$//'
}

# staging_owner_excluded_tables_present_sql
#   SQL returning how many of the owner-excluded tables exist (must be 0). Returns 1 if a table
#   name is not a plain lower-case identifier.
staging_owner_excluded_tables_present_sql() {
  local table re='^[a-z_][a-z0-9_]*$' values=""
  for table in ${STAGING_OWNER_EXCLUDED_TABLES[@]+"${STAGING_OWNER_EXCLUDED_TABLES[@]}"}; do
    [[ "$table" =~ $re ]] || return 1
    values="${values}${values:+, }('public.${table}')"
  done
  if [[ -z "$values" ]]; then
    printf '%s' 'SELECT 0;'
    return 0
  fi
  printf 'SELECT count(*) FROM (VALUES %s) AS t(n) WHERE pg_catalog.to_regclass(t.n) IS NOT NULL;' "$values"
}

# owner_excluded_only_pending <migrate --list output file>
#   Exit 0 when the listed Pending count is nonzero AND every pending name is an owner-excluded
#   migration (the pending set is exactly what the owner ruled to keep unapplied); exit 1
#   otherwise (nothing pending, any other name pending, or an unreadable list). Prints nothing.
#   Used only to explain a strict pending=0 refusal accurately — it never turns one into a pass.
owner_excluded_only_pending() {
  local file="$1" count names name listed=0
  count="$(sed -n 's/^Pending: \([0-9][0-9]*\)$/\1/p' "$file" | tail -n 1)"
  [[ "$count" =~ ^[0-9]+$ && "$count" -gt 0 ]] || return 1
  names="$(staging_owner_excluded_names)" || return 1
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    grep -qxF -- "$name" <<< "$names" || return 1
    listed=$((listed + 1))
  done < <(sed -n 's/^  - \(.*\)$/\1/p' "$file")
  [[ "$listed" == "$count" ]]
}

# --- staging org-membership inspect / repair (owner ruling 2026-10-12) -----------------------
#
# Pure text helpers for action=org-membership-inspect and action=org-membership-repair in
# attendance-staging-window-runner-remote.sh. No I/O, no docker, no env reads beyond the
# constants below; every SQL generator prints text only, so the self-test
# (attendance-window-runner-pipeline.test.mjs) can scan and run them without a database.
#
# The population both actions address is the one action=migrate's read-only prechecks count as
# zero_membership_no_row_count: an ACTIVE user with NO user_orgs row at all. Output is
# values-free: a user is named only by fp = left(md5(id), 16); no id, username, email or name
# column ever reaches a SELECT list.

# shellcheck disable=SC2034  # read by the remote script's REPAIR_SPEC refusal message
ORG_MEMBERSHIP_REPAIR_CONFIRM='I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR'
# Same literal as the workflow's validation step (the self-test pins the two byte for byte).
ORG_MEMBERSHIP_REPAIR_SPEC_RE='^(deactivate:[0-9a-f]{16}|add-membership:[0-9a-f]{16}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}):I_CONFIRM_STAGING_ORG_MEMBERSHIP_REPAIR$'
# An org id the repair spec can name: no ':' (the spec separator), no quote, no whitespace.
ORG_MEMBERSHIP_ORG_ID_RE='^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
# Known synthetic identity families, as "<class>:<prefix>". The smoke stamps (action_smoke's
# stamp_prefix values) prefix user ids; the soak family (SOAK_USER_PREFIX) prefixes usernames and
# emails only (its ids are minted UUIDs). Inspect prints the class name, never the matched value.
ORG_MEMBERSHIP_SYNTHETIC_CLASSES=(
  "ae4-smoke:ae4-smoke-"
  "rd45-smoke:rd45-smoke-"
  "otbank-v18-smoke:otbank-v18-smoke-"
  "mp6-smoke:mp6-smoke-"
  "hmr5-smoke:hmr5-smoke-"
  "tasks-smoke:tasks-smoke-"
  "soak-w4w7:synth-w4w7-"
)

# org_membership_repair_spec_parse <spec>
#   Prints "<mode> <fp16> <org_id|->" for a well-formed spec; returns 2, printing nothing, for
#   anything else (missing or wrong confirm phrase, extra or missing fields, upper-case fp, any
#   character outside the regex, an embedded newline/CR).
org_membership_repair_spec_parse() {
  local spec="${1-}" re="$ORG_MEMBERSHIP_REPAIR_SPEC_RE" mode fp rest org
  [[ "$spec" != *$'\n'* && "$spec" != *$'\r'* ]] || return 2
  [[ "$spec" =~ $re ]] || return 2
  IFS=':' read -r mode fp rest <<< "$spec"
  case "$mode" in
    deactivate) org='-' ;;
    add-membership)
      org="${rest%%:*}"
      [[ "$org" =~ $ORG_MEMBERSHIP_ORG_ID_RE ]] || return 2
      ;;
    *) return 2 ;;
  esac
  printf '%s %s %s\n' "$mode" "$fp" "$org"
}

# org_membership_read_only_wrap
#   stdin SQL -> stdout SQL wrapped in ONE read-only transaction that is rolled back (never
#   committed). The caller additionally sets PGOPTIONS default_transaction_read_only=on.
org_membership_read_only_wrap() {
  printf '%s\n' '\set VERBOSITY terse' 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;' "SET LOCAL TIME ZONE 'UTC';"
  cat
  printf '\n%s\n' 'ROLLBACK;'
}

# target_precheck_counters_query <org_null_predicate>
#   The ONE source of action=migrate's read-only precheck counters (action_migrate_read_only_
#   prechecks) and of the before/after counters of both org-membership actions: a single SELECT
#   yielding (ord, line) rows, one "<label>=<value>" line per counter. <org_null_predicate> is ''
#   or exactly 'AND i.org_id IS NULL' (returns 1 for anything else).
target_precheck_counters_query() {
  local org_null_predicate="${1-}"
  case "$org_null_predicate" in
    ''|'AND i.org_id IS NULL') ;;
    *) return 1 ;;
  esac
  cat <<SQL
SELECT 1 AS ord, 'approval_action_histogram=' || COALESCE(jsonb_object_agg(action, n ORDER BY action), '{}'::jsonb)::text AS line
  FROM (SELECT action, count(*) AS n FROM approval_records GROUP BY action) h
UNION ALL
SELECT 2, 'invalid_approval_action_count=' || count(*)::text
  FROM approval_records
 WHERE action NOT IN ('created','approve','reject','return','revoke','transfer','sign','comment','cc','remind','jump','add_sign','reduce_sign','reassign','handle','policy_denied')
UNION ALL
SELECT 3, 'attachment_org_conflict_count=' || count(*)::text FROM (
  SELECT a.instance_id
    FROM approval_attachments a
    JOIN approval_instances i ON i.id = a.instance_id
   WHERE a.instance_id IS NOT NULL
     ${org_null_predicate}
   GROUP BY a.instance_id
  HAVING count(DISTINCT a.org_id) > 1
) c
UNION ALL
SELECT 4, 'zero_membership_active_user_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE)
UNION ALL
SELECT 5, 'zero_membership_no_row_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
UNION ALL
SELECT 6, 'zero_membership_only_deactivated_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE)
UNION ALL
SELECT 7, 'recovery09_repairable_user_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE)
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.org_id = 'default')
UNION ALL
SELECT 8, 'distinct_active_org_count=' || count(*)::text
  FROM (SELECT DISTINCT org_id FROM user_orgs WHERE is_active = TRUE) o
UNION ALL
SELECT 9, 'directory_integration_distinct_org_count=' || count(*)::text
  FROM (SELECT DISTINCT org_id FROM directory_integrations WHERE org_id IS NOT NULL AND btrim(org_id) <> '') o
UNION ALL
SELECT 10, 'directory_integration_non_default_count=' || count(*)::text
  FROM directory_integrations WHERE org_id <> 'default'
UNION ALL
SELECT 11, 'legacy_anchor_active_membership_witness_count=' || count(*)::text
  FROM user_orgs WHERE org_id = 'default' AND is_active = TRUE
UNION ALL
SELECT 12, 'class6_candidate_count=' || count(*)::text
  FROM approval_instances i
 WHERE i.id NOT LIKE 'plm:%'
   AND i.id NOT LIKE 'afs:%'
   AND COALESCE(i.source_system, 'platform') = 'platform'
   AND i.template_id IS NULL
   ${org_null_predicate}
   AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
   AND NOT EXISTS (
     SELECT 1 FROM user_orgs uo
      WHERE uo.user_id = i.requester_snapshot->>'id'
        AND uo.is_active = TRUE
      GROUP BY uo.user_id
     HAVING count(*) = 1
   )
UNION ALL
SELECT 13, 'recovery09_unsupported_class6_count=' || count(*)::text
  FROM approval_instances i
 WHERE i.id NOT LIKE 'plm:%'
   AND i.id NOT LIKE 'afs:%'
   AND COALESCE(i.source_system, 'platform') = 'platform'
   AND i.template_id IS NULL
   ${org_null_predicate}
   AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)
   AND NOT EXISTS (
     SELECT 1 FROM user_orgs uo
      WHERE uo.user_id = i.requester_snapshot->>'id' AND uo.is_active = TRUE
      GROUP BY uo.user_id HAVING count(*) = 1
   )
   AND NOT (
     NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.requester_snapshot->>'id')
     OR EXISTS (
       SELECT 1 FROM users u
        WHERE u.id = i.requester_snapshot->>'id' AND u.is_active = TRUE
          AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = TRUE)
          AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id AND uo.org_id = 'default')
     )
   )
SQL
}

# target_precheck_counters_sql <org_null_predicate>
#   The counters as one runnable statement, in counter order (one line per counter under -tA).
target_precheck_counters_sql() {
  local query
  query="$(target_precheck_counters_query "${1-}")" || return 1
  printf 'SELECT line FROM (\n%s\n) counters ORDER BY ord;\n' "$query"
}

# org_membership_class6_shaped_predicate <org_null_predicate>
#   WHERE-clause tail (after "i.requester_snapshot->>'id' = <user>") selecting the approval
#   instances whose class-6 shape depends ONLY on the requester's memberships: the same
#   conditions as class6_candidate_count minus its membership clause. For a no-row user this is
#   exactly that user's share of class6_candidate_count.
org_membership_class6_shaped_predicate() {
  local org_null_predicate="${1-}"
  case "$org_null_predicate" in
    ''|'AND i.org_id IS NULL') ;;
    *) return 1 ;;
  esac
  printf '%s' "AND i.id NOT LIKE 'plm:%' AND i.id NOT LIKE 'afs:%' AND COALESCE(i.source_system, 'platform') = 'platform' AND i.template_id IS NULL ${org_null_predicate} AND NOT EXISTS (SELECT 1 FROM approval_attachments a WHERE a.instance_id = i.id)"
}

# org_membership_probe_sql
#   Read-only probe: one "<table>.<column>" line per optional column the inspect report reads
#   and the database actually has. Inspect only references what this probe found (a reference
#   to a missing table fails at parse time, so to_regclass inside the same statement is not
#   enough).
org_membership_probe_sql() {
  cat <<'SQL'
SELECT c.table_name || '.' || c.column_name
  FROM information_schema.columns c
 WHERE c.table_schema = 'public'
   AND (c.table_name, c.column_name) IN (
     ('users', 'username'), ('users', 'email'), ('users', 'created_at'), ('users', 'is_admin'),
     ('users', 'role'), ('users', 'last_login_at'), ('users', 'updated_at'),
     ('user_roles', 'user_id'), ('user_roles', 'role_id'),
     ('approval_instances', 'requester_snapshot'), ('approval_instances', 'org_id'),
     ('tasks', 'created_by'), ('task_assignees', 'user_id'),
     ('meta_records', 'created_by'),
     ('user_external_identities', 'local_user_id'),
     ('directory_account_links', 'local_user_id'),
     ('directory_deprovision_events', 'local_user_id'), ('directory_deprovision_events', 'status'),
     ('directory_deprovision_effects', 'local_user_id'), ('directory_deprovision_effects', 'status')
   )
 ORDER BY 1;
SQL
}

# org_membership_synthetic_class_expr <present_columns_file>
#   SQL CASE expression naming the synthetic class of u (or 'none') and, separately, which column
#   matched. Matches with starts_with (never LIKE: '_' is a LIKE wildcard). Prints
#   "<class_expr>\t<field_expr>".
org_membership_synthetic_class_expr() {
  local present="$1" entry class prefix col
  local -a cols=(id)
  grep -qx 'users.username' "$present" && cols+=(username)
  grep -qx 'users.email' "$present" && cols+=(email)
  local class_expr="CASE" field_expr="CASE"
  for entry in "${ORG_MEMBERSHIP_SYNTHETIC_CLASSES[@]}"; do
    class="${entry%%:*}"
    prefix="${entry#*:}"
    [[ "$class" =~ ^[a-z0-9-]+$ && "$prefix" =~ ^[a-z0-9-]+$ ]] || return 1
    for col in "${cols[@]}"; do
      class_expr+=" WHEN starts_with(COALESCE(u.${col}, ''), '${prefix}') THEN '${class}'"
      field_expr+=" WHEN starts_with(COALESCE(u.${col}, ''), '${prefix}') THEN '${col}'"
    done
  done
  class_expr+=" ELSE 'none' END"
  field_expr+=" ELSE 'none' END"
  printf '%s\t%s' "$class_expr" "$field_expr"
}

# org_membership_applied_evidence_expr <present_columns_file> <user_id_expr>
#   SQL expression counting the 'applied' directory deprovision events + effects of one user (the
#   evidence the platform's access-graph writers supersede; this runner does not, so it refuses).
#   Prints 'n/a' (as a SQL literal) when neither table is present. <user_id_expr> is u.id only.
org_membership_applied_evidence_expr() {
  local present="$1" user_expr="$2" parts=()
  [[ "$user_expr" == 'u.id' ]] || return 1
  if grep -qx 'directory_deprovision_events.local_user_id' "$present" && grep -qx 'directory_deprovision_events.status' "$present"; then
    parts+=("(SELECT count(*) FROM directory_deprovision_events de WHERE de.local_user_id = u.id AND de.status = 'applied')")
  fi
  if grep -qx 'directory_deprovision_effects.local_user_id' "$present" && grep -qx 'directory_deprovision_effects.status' "$present"; then
    parts+=("(SELECT count(*) FROM directory_deprovision_effects df WHERE df.local_user_id = u.id AND df.status = 'applied')")
  fi
  if [[ "${#parts[@]}" -eq 0 ]]; then
    printf '%s' "'n/a'"
  else
    local joined
    joined="$(printf ' + %s' "${parts[@]}")"
    printf '(%s)::text' "${joined# + }"
  fi
}

# org_membership_inspect_users_sql <present_columns_file> <org_null_predicate>
#   One values-free line per user matching the population predicate. Every per-user fact is a
#   count, a yes/no, a class name, a UTC timestamp or the md5 fingerprint; a fact whose table or
#   column is absent prints n/a.
org_membership_inspect_users_sql() {
  local present="$1" org_null_predicate="${2-}" exprs class_expr field_expr shaped
  exprs="$(org_membership_synthetic_class_expr "$present")" || return 1
  class_expr="${exprs%%$'\t'*}"
  field_expr="${exprs#*$'\t'}"
  shaped="$(org_membership_class6_shaped_predicate "$org_null_predicate")" || return 1
  has() { grep -qx "$1" "$present"; }
  local created="'n/a'" is_admin="'n/a'" role_admin="'n/a'" logged_in="'n/a'"
  local user_roles="'n/a'" admin_roles="'n/a'" approvals="'n/a'" shaped_count="'n/a'"
  local tasks="'n/a'" assignees="'n/a'" records="'n/a'" identities="'n/a'" links="'n/a'" evidence
  evidence="$(org_membership_applied_evidence_expr "$present" 'u.id')" || return 1
  has users.created_at && created="COALESCE(to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), 'null')"
  has users.is_admin && is_admin="CASE WHEN u.is_admin THEN 'yes' ELSE 'no' END"
  has users.role && role_admin="CASE WHEN u.role = 'admin' THEN 'yes' ELSE 'no' END"
  has users.last_login_at && logged_in="CASE WHEN u.last_login_at IS NULL THEN 'no' ELSE 'yes' END"
  has user_roles.user_id && user_roles="(SELECT count(*) FROM user_roles ur WHERE ur.user_id = u.id)::text"
  has user_roles.role_id && has user_roles.user_id && admin_roles="(SELECT count(*) FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = 'admin')::text"
  if has approval_instances.requester_snapshot; then
    approvals="(SELECT count(*) FROM approval_instances i WHERE i.requester_snapshot->>'id' = u.id)::text"
    shaped_count="(SELECT count(*) FROM approval_instances i WHERE i.requester_snapshot->>'id' = u.id ${shaped})::text"
  fi
  has tasks.created_by && tasks="(SELECT count(*) FROM tasks t WHERE t.created_by = u.id)::text"
  has task_assignees.user_id && assignees="(SELECT count(*) FROM task_assignees ta WHERE ta.user_id = u.id)::text"
  has meta_records.created_by && records="(SELECT count(*) FROM meta_records mr WHERE mr.created_by = u.id)::text"
  has user_external_identities.local_user_id && identities="(SELECT count(*) FROM user_external_identities xi WHERE xi.local_user_id = u.id)::text"
  has directory_account_links.local_user_id && links="(SELECT count(*) FROM directory_account_links dl WHERE dl.local_user_id = u.id)::text"
  unset -f has
  cat <<SQL
SELECT 'user'
    || ' fp=' || left(md5(u.id), 16)
    || ' fp_shared_by_users=' || (SELECT count(*) FROM users x WHERE left(md5(x.id), 16) = left(md5(u.id), 16))::text
    || ' created_at=' || ${created}
    || ' synthetic_class=' || ${class_expr}
    || ' synthetic_match=' || ${field_expr}
    || ' inactive_memberships=' || (SELECT count(*) FROM user_orgs uo WHERE uo.user_id = u.id AND uo.is_active = FALSE)::text
    || ' user_roles=' || ${user_roles}
    || ' admin_role_rows=' || ${admin_roles}
    || ' is_admin_flag=' || ${is_admin}
    || ' role_column_admin=' || ${role_admin}
    || ' has_logged_in=' || ${logged_in}
    || ' approvals_as_requester=' || ${approvals}
    || ' class6_shaped_requested=' || ${shaped_count}
    || ' tasks_created=' || ${tasks}
    || ' task_assignee_rows=' || ${assignees}
    || ' multitable_records_created=' || ${records}
    || ' external_identity_rows=' || ${identities}
    || ' directory_account_links=' || ${links}
    || ' applied_deprovision_evidence=' || ${evidence}
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
 ORDER BY left(md5(u.id), 16);
SQL
}

# org_membership_inspect_orgs_sql
#   One line per org with ACTIVE members (org ids are not personal values). An org id the repair
#   spec could not name is withheld and shown by fingerprint with spec_nameable=no.
org_membership_inspect_orgs_sql() {
  cat <<SQL
SELECT 'org '
    || CASE WHEN o.org_id ~ '${ORG_MEMBERSHIP_ORG_ID_RE}'
            THEN 'id=' || o.org_id || ' spec_nameable=yes'
            ELSE 'id_fp=' || left(md5(o.org_id), 16) || ' spec_nameable=no' END
    || ' active_members=' || o.n::text
  FROM (SELECT org_id, count(*) AS n FROM user_orgs WHERE is_active = TRUE GROUP BY org_id) o
 ORDER BY o.n DESC, left(md5(o.org_id), 16);
SQL
}

# org_membership_repair_precheck_sql <present_columns_file>
#   Read-only preconditions, run BEFORE the backup and the write (psql variables :'fp', :'org').
#   applied_deprovision_evidence is the matching user's count ('n/a' without the ledger tables).
org_membership_repair_precheck_sql() {
  local present="$1" evidence
  evidence="$(org_membership_applied_evidence_expr "$present" 'u.id')" || return 1
  cat <<'SQL'
SELECT 'predicate_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id);
SELECT 'match_count=' || count(*)::text
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
   AND left(md5(u.id), 16) = :'fp';
SELECT 'org_active_member_count=' || count(*)::text
  FROM user_orgs
 WHERE org_id = :'org' AND is_active = TRUE;
SQL
  cat <<SQL
SELECT 'applied_deprovision_evidence=' || COALESCE(string_agg(${evidence}, ','), '0')
  FROM users u
 WHERE u.is_active = TRUE
   AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
   AND left(md5(u.id), 16) = :'fp';
SQL
}

# org_membership_repair_write_sql <org_null_predicate>
#   The ONE write transaction (psql variables :'mode', :'fp', :'org'). Inside a single BEGIN ..
#   COMMIT it: locks the matching user row(s) FOR UPDATE, then user_orgs against concurrent
#   writers (the app's order: user row first, then the membership table); snapshots the
#   counters; re-checks that EXACTLY ONE active no-row user has this fingerprint and that it has
#   no 'applied' directory deprovision evidence; writes exactly one row (deactivate: UPDATE users,
#   also advancing access_generation when that column exists; add-membership: INSERT user_orgs,
#   only into an org that already has active members); requires ROW_COUNT = 1; re-snapshots the
#   counters and requires the full expected delta vector (anything else raises, which rolls the
#   whole transaction back). RAISE arguments are counts and labels only (the self-test pins an
#   allowlist).
org_membership_repair_write_sql() {
  local org_null_predicate="${1-}" counters shaped
  counters="$(target_precheck_counters_query "$org_null_predicate")" || return 1
  shaped="$(org_membership_class6_shaped_predicate "$org_null_predicate")" || return 1
  # The shaped predicate is embedded as a dollar-quoted literal; refuse a $ inside it.
  [[ "$shaped" != *'$'* ]] || return 1
  cat <<'SQL'
\set VERBOSITY terse
-- window-runner:org-membership-repair-write
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SELECT 'orgfix_settings=' || (
         set_config('window_runner.orgfix_mode', :'mode', true) IS NOT NULL
     AND set_config('window_runner.orgfix_fp', :'fp', true) IS NOT NULL
     AND set_config('window_runner.orgfix_org', :'org', true) IS NOT NULL)::text;
SELECT 'orgfix_user_rows_locked=' || count(*)::text
  FROM (SELECT 1 FROM users u WHERE left(md5(u.id), 16) = :'fp' FOR UPDATE) locked;
LOCK TABLE user_orgs IN SHARE ROW EXCLUSIVE MODE;
SQL
  printf 'CREATE TEMP TABLE orgfix_before ON COMMIT DROP AS\n%s;\n' "$counters"
  printf "SELECT 'orgfix_shaped_set=' || (set_config('window_runner.orgfix_shaped', \$orgfix_shaped\$%s\$orgfix_shaped\$, true) IS NOT NULL)::text;\n" "$shaped"
  cat <<'SQL'
DO $orgfix_write$
DECLARE
  v_mode text := current_setting('window_runner.orgfix_mode');
  v_fp text := current_setting('window_runner.orgfix_fp');
  v_org text := current_setting('window_runner.orgfix_org');
  v_ids text[];
  v_matches integer;
  v_rows bigint;
  v_shaped bigint;
  v_evidence bigint := 0;
  v_n bigint;
  v_set text;
BEGIN
  IF v_fp !~ '^[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'ORGFIX_ABORT malformed_fp';
  END IF;
  IF v_mode NOT IN ('deactivate', 'add-membership') THEN
    RAISE EXCEPTION 'ORGFIX_ABORT malformed_mode';
  END IF;
  SELECT array_agg(u.id) INTO v_ids
    FROM users u
   WHERE u.is_active = TRUE
     AND NOT EXISTS (SELECT 1 FROM user_orgs uo WHERE uo.user_id = u.id)
     AND left(md5(u.id), 16) = v_fp;
  v_matches := COALESCE(array_length(v_ids, 1), 0);
  IF v_matches <> 1 THEN
    RAISE EXCEPTION 'ORGFIX_ABORT match_count=% (exactly 1 required)', v_matches;
  END IF;
  EXECUTE 'SELECT count(*) FROM approval_instances i WHERE i.requester_snapshot->>''id'' = $1 '
       || current_setting('window_runner.orgfix_shaped')
     INTO v_shaped USING v_ids[1];
  PERFORM set_config('window_runner.orgfix_class6_shaped', v_shaped::text, true);
  IF to_regclass('public.directory_deprovision_events') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM directory_deprovision_events WHERE local_user_id = $1 AND status = ''applied'''
       INTO v_n USING v_ids[1];
    v_evidence := v_evidence + v_n;
  END IF;
  IF to_regclass('public.directory_deprovision_effects') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM directory_deprovision_effects WHERE local_user_id = $1 AND status = ''applied'''
       INTO v_n USING v_ids[1];
    v_evidence := v_evidence + v_n;
  END IF;
  IF v_evidence <> 0 THEN
    RAISE EXCEPTION 'ORGFIX_ABORT applied_deprovision_evidence=% (not repairable by this runner)', v_evidence;
  END IF;
  IF v_mode = 'deactivate' THEN
    IF v_org <> '' THEN
      RAISE EXCEPTION 'ORGFIX_ABORT deactivate_takes_no_org';
    END IF;
    -- The SET list is built from fixed fragments only (column presence), never from input.
    v_set := 'is_active = FALSE';
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'updated_at') THEN
      v_set := v_set || ', updated_at = now()';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'access_generation') THEN
      v_set := v_set || ', access_generation = COALESCE(access_generation, 0) + 1';
    END IF;
    EXECUTE 'UPDATE users SET ' || v_set || ' WHERE id = $1 AND is_active = TRUE' USING v_ids[1];
  ELSE
    IF v_org !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' THEN
      RAISE EXCEPTION 'ORGFIX_ABORT malformed_org';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM user_orgs WHERE org_id = v_org AND is_active = TRUE) THEN
      RAISE EXCEPTION 'ORGFIX_ABORT org_has_no_active_members';
    END IF;
    INSERT INTO user_orgs (user_id, org_id, is_active) VALUES (v_ids[1], v_org, TRUE);
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'ORGFIX_ABORT write_row_count=% (exactly 1 required)', v_rows;
  END IF;
END
$orgfix_write$;
SQL
  printf 'CREATE TEMP TABLE orgfix_after ON COMMIT DROP AS\n%s;\n' "$counters"
  cat <<'SQL'
DO $orgfix_check$
DECLARE
  v_mode text := current_setting('window_runner.orgfix_mode');
  v_org text := current_setting('window_runner.orgfix_org');
  v_shaped bigint := current_setting('window_runner.orgfix_class6_shaped')::bigint;
  v_expected bigint;
  v_n_before integer;
  v_n_after integer;
  r record;
BEGIN
  SELECT count(*) INTO v_n_before FROM orgfix_before;
  SELECT count(*) INTO v_n_after FROM orgfix_after;
  IF v_n_before = 0 OR v_n_before <> v_n_after THEN
    RAISE EXCEPTION 'ORGFIX_ABORT counter_set_mismatch before=% after=%', v_n_before, v_n_after;
  END IF;
  FOR r IN
    SELECT split_part(b.line, '=', 1) AS label,
           substr(b.line, strpos(b.line, '=') + 1) AS before_value,
           substr(a.line, strpos(a.line, '=') + 1) AS after_value
      FROM orgfix_before b
      LEFT JOIN orgfix_after a ON a.ord = b.ord AND split_part(a.line, '=', 1) = split_part(b.line, '=', 1)
  LOOP
    IF r.after_value IS NULL THEN
      RAISE EXCEPTION 'ORGFIX_ABORT counter_missing_after label=%', r.label;
    END IF;
    IF r.label = 'approval_action_histogram' THEN
      IF r.before_value <> r.after_value THEN
        RAISE EXCEPTION 'ORGFIX_ABORT counter_changed label=%', r.label;
      END IF;
      CONTINUE;
    END IF;
    v_expected := CASE r.label
      WHEN 'zero_membership_active_user_count' THEN -1
      WHEN 'zero_membership_no_row_count' THEN -1
      WHEN 'recovery09_repairable_user_count' THEN -1
      WHEN 'class6_candidate_count' THEN CASE WHEN v_mode = 'add-membership' THEN -v_shaped ELSE 0 END
      WHEN 'recovery09_unsupported_class6_count' THEN CASE WHEN v_mode = 'deactivate' THEN v_shaped ELSE 0 END
      WHEN 'legacy_anchor_active_membership_witness_count' THEN CASE WHEN v_mode = 'add-membership' AND v_org = 'default' THEN 1 ELSE 0 END
      ELSE 0
    END;
    IF r.after_value::bigint - r.before_value::bigint <> v_expected THEN
      RAISE EXCEPTION 'ORGFIX_ABORT counter_delta_mismatch label=% expected=% actual=%',
        r.label, v_expected, r.after_value::bigint - r.before_value::bigint;
    END IF;
  END LOOP;
END
$orgfix_check$;
SELECT 'in_txn_before ' || line FROM orgfix_before ORDER BY ord;
SELECT 'in_txn_after ' || line FROM orgfix_after ORDER BY ord;
SELECT 'class6_shaped_requested=' || current_setting('window_runner.orgfix_class6_shaped');
COMMIT;
SELECT 'write_committed=yes';
SQL
}

# org_membership_migrate_gate_rule <invalid> <conflicts> <active_orgs> <repairable> <class6>
#   action=migrate's read-only precheck verdict (action_migrate_read_only_prechecks) for these
#   counters, ASSUMING the Recovery09 migrations are already applied (as on staging): then the
#   multi-org repair branch, entered when repairable > 0 or class6 > 0 on a DB whose
#   distinct_active_org_count is not 1, always fails. Prints pass, blocked, or unknown (a
#   non-numeric input, for example n/a).
org_membership_migrate_gate_rule() {
  [[ $# -eq 5 ]] || return 1
  local v
  for v in "$@"; do
    [[ "$v" =~ ^-?[0-9]+$ ]] || { printf 'unknown'; return 0; }
  done
  if (( $1 != 0 || $2 != 0 )); then printf 'blocked'; return 0; fi
  if (( ($4 > 0 || $5 > 0) && $3 != 1 )); then printf 'blocked'; return 0; fi
  printf 'pass'
}

# org_membership_migrate_gate_from_counters <counters_file> <repairable_delta> <class6_delta>
#   The rule above applied to a counter file (target_precheck_counters_sql output) shifted by the
#   given deltas: (0, 0) for the measured state, (-1, -k) for a projected add-membership, (-1, 0)
#   for a projected deactivate. A non-numeric delta (k = n/a) prints unknown.
org_membership_migrate_gate_from_counters() {
  local file="$1" d_rep="$2" d_c6="$3" label invalid conflicts orgs rep c6
  for label in invalid_approval_action_count attachment_org_conflict_count distinct_active_org_count recovery09_repairable_user_count class6_candidate_count; do
    sed -n "s/^${label}=//p" "$file" | tail -n 1 | grep -Eq '^[0-9]+$' || { printf 'unknown'; return 0; }
  done
  [[ "$d_rep" =~ ^-?[0-9]+$ && "$d_c6" =~ ^-?[0-9]+$ ]] || { printf 'unknown'; return 0; }
  invalid="$(sed -n 's/^invalid_approval_action_count=//p' "$file" | tail -n 1)"
  conflicts="$(sed -n 's/^attachment_org_conflict_count=//p' "$file" | tail -n 1)"
  orgs="$(sed -n 's/^distinct_active_org_count=//p' "$file" | tail -n 1)"
  rep="$(sed -n 's/^recovery09_repairable_user_count=//p' "$file" | tail -n 1)"
  c6="$(sed -n 's/^class6_candidate_count=//p' "$file" | tail -n 1)"
  org_membership_migrate_gate_rule "$invalid" "$conflicts" "$orgs" "$((rep + d_rep))" "$((c6 + d_c6))"
}
