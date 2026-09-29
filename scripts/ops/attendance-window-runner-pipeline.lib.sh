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
