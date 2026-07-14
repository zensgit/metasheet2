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
