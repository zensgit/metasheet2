# attendance-window-runner-pipeline.lib.sh
#
# Shared pipeline helper for the attendance staging window-runner remote script
# (scripts/ops/attendance-staging-window-runner-remote.sh). Sourced, not executed.
#
# Contract (proven by scripts/ops/attendance-window-runner-pipeline.test.mjs, which runs
# this exact file under `bash -o pipefail -c`):
#   filtered_pipe <output_file> <grep_ere_pattern> -- <producer command...>
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
