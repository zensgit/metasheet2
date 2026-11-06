# attendance-window-runner-pipeline.lib.sh
#
# Shared pipeline helper for the attendance staging window-runner remote script
# (scripts/ops/attendance-staging-window-runner-remote.sh). Sourced, not executed.
#
# Contract (proven by scripts/ops/attendance-window-runner-pipeline.test.mjs, which runs
# this exact file under `bash -o pipefail -c`):
#   filtered_pipe <output_file> <grep_ere_pattern> -- <producer command...>
#   masked_log_slice <output_file> <grep_ere_pattern> -- <producer command...>
#     filtered_pipe whose kept lines pass through mask_log_identifiers first (see below).
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

# mask_log_identifiers <file>
#
# Prints <file> with account-shaped values replaced by ***, so a log slice kept in the
# uploaded output dir carries no account ids or contact details. Works line by line:
#   - the value of a JSON key that names an account, tenant or contact field (user_id, userId,
#     tenant_id, actor_id, created_by, email, phone, mobile, username, display_name, ...),
#     including prefixed camelCase id keys (actorUserId, targetUserId, localUserId, ...), id
#     arrays (userIds -> ["***"]) and a nested id ("user":{"id":...});
#   - the id token after a message prefix "user ", "admin " or "account " (so "for user X",
#     "to user X", "by admin X" are covered); the next word is masked even when it is not an
#     id ("user not found" -> "user *** found"), which loses that word only;
#   - every other occurrence, on the same line, of a value masked by the two rules above
#     (values of 4 characters or more, matched on alphanumeric boundaries);
#   - every UUID-shaped value, except the value of orgId, org_id, requestId, request_id,
#     traceId, spanId or correlation_id (server correlation and org ids, kept for diagnosis);
#   - email-shaped strings, mobile-number-shaped digit runs and JWT-shaped tokens anywhere.
# Not recognised: non-UUID ids in free text without one of the prefixes above, keys inside an
# escaped JSON string (\"userId\":...). Byte-preserving for everything else. Returns nonzero
# (output then incomplete) when the file cannot be read or python3 is unavailable; the caller
# decides what to keep.
mask_log_identifiers() {
  python3 - "$1" <<'PY'
import re, sys
ID_ROOT = (r'(?:user|tenant|actor|employee|requester|approver|assignee|owner|operator|member|'
           r'subject|recipient|account|admin)')
VALUE = r'("(?:[^"\\]|\\.)*"|-?[0-9]+|\[[^\[\]]*\])'
KEY = re.compile(
    r'("(?:[A-Za-z_]*?' + ID_ROOT + r'_?ids?|(?:created|updated|deleted|submitted|approved)_?by|'
    r'e_?mail|phone|mobile|tel|user_?name|login|display_?name|real_?name|full_?name|nick_?name)"'
    r'\s*:\s*)' + VALUE,
    re.IGNORECASE,
)
NESTED = re.compile(r'("' + ID_ROOT + r'"\s*:\s*\{[^{}]*?"id"\s*:\s*)' + VALUE, re.IGNORECASE)
PREFIX = re.compile(
    r'(?<![A-Za-z0-9_-])((?:user|admin|account)\s+)'
    r'(?!(?:user|admin|account)\b)([A-Za-z0-9_@.-]*[A-Za-z0-9_@])',
    re.IGNORECASE,
)
UUID = r'[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
UUIDS = re.compile(
    r'("(?:orgId|org_id|requestId|request_id|traceId|spanId|correlation_id)"\s*:\s*")(' + UUID + r')(?=")'
    r'|(?<![0-9A-Za-z])' + UUID + r'(?![0-9A-Za-z])'
)
EMAIL = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}')
MOBILE = re.compile(r'(?<![0-9])(?:\+?86[- ]?)?1[3-9][0-9]{9}(?![0-9])')
JWT = re.compile(r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*')
STRING_ITEM = re.compile(r'"((?:[^"\\]|\\.)*)"|(-?[0-9]+)')

def mask_line(line):
    seen = set()

    def keyed(m):
        value = m.group(2)
        for item in STRING_ITEM.finditer(value):
            seen.add(item.group(1) if item.group(1) is not None else item.group(2))
        return m.group(1) + ('["***"]' if value.startswith('[') else '"***"')

    def prefixed(m):
        seen.add(m.group(2))
        return m.group(1) + '***'

    line = KEY.sub(keyed, line)
    line = NESTED.sub(keyed, line)
    line = PREFIX.sub(prefixed, line)
    line = UUIDS.sub(lambda m: m.group(1) + m.group(2) if m.group(1) else '***', line)
    line = JWT.sub('***', line)
    line = EMAIL.sub('***', line)
    line = MOBILE.sub('***', line)
    for value in sorted(seen, key=len, reverse=True):
        if len(value) >= 4 and value != '***':
            line = re.sub(r'(?<![A-Za-z0-9])' + re.escape(value) + r'(?![A-Za-z0-9])', '***', line)
    return line

with open(sys.argv[1], 'rb') as f:
    text = f.read().decode('utf-8', 'surrogateescape')
text = '\n'.join(mask_line(line) for line in text.split('\n'))
sys.stdout.buffer.write(text.encode('utf-8', 'surrogateescape'))
PY
}

# masked_log_slice <output_file> <grep_ere_pattern> -- <producer command...>
#
# filtered_pipe with the result passed through mask_log_identifiers: the unmasked lines go to a
# temp file outside the output dir (removed on every path) and only the masked text is written
# to <output_file>. Same return contract as filtered_pipe (0 for zero matches, the producer's rc
# when it failed, grep's rc when grep failed); a partial slice from a failed producer is masked
# the same way. If masking fails, <output_file> holds a one-line "withheld" notice instead and
# the return code is still filtered_pipe's, so the caller's pass/fail rule does not change.
masked_log_slice() {
  local out_file="$1" pattern="$2"
  shift 2
  local raw rc=0
  raw="$(mktemp "${TMPDIR:-/tmp}/window-runner-log-slice.XXXXXX")" || return 1
  filtered_pipe "$raw" "$pattern" "$@" || rc=$?
  if ! mask_log_identifiers "$raw" > "$out_file" 2>/dev/null; then
    echo "log slice withheld: identifier masking failed" > "$out_file"
    echo "[masked_log_slice] identifier masking failed; ${out_file##*/} withheld" >&2
  fi
  rm -f "$raw"
  return "$rc"
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
