#!/bin/bash
# DT-CLOSE-01B log-probe remote-pipeline builders.
#
# Extracted out of dingtalk-oauth-stability-check.sh (rather than left inline) so a test can execute
# the EXACT string these functions produce, locally, under `bash -c` with a stubbed `docker` on PATH —
# proving the FAIL-HONEST contract for real, not just through the ssh-shim layer (the ssh shim only
# ever returns a canned exit code/output for the whole remote command; it never actually runs the
# pipeline, so it cannot by itself prove the pipeline is fail-honest). See
# dingtalk-oauth-stability-metrics-only-fullscript.test.mjs for both the ssh-shim marker tests and the
# real-pipeline-with-stubbed-docker tests.
#
# BUG THIS FIXES: the previous inline form was
#   `VAR="$(ssh_cmd '... | wc -l | tr -d '\'' '\''' 2>/dev/null || printf '0')"`
# which has two independent defects: (1) the `|| printf 0` fallback sits OUTSIDE the ssh command
# substitution and never sets the ALERT_TOPOLOGY_DEFERRED marker even when it fires (same
# subshell-assignment class as the status probes above it); (2) worse, it never fires at all in the
# case that matters most — `docker logs ... 2>&1 | grep ... | wc -l` masks a `docker logs` failure
# (e.g. "Error: No such container") as a successful zero count, because `wc -l` always exits 0
# regardless of what fed it, and `2>&1` even risks the error TEXT itself being grep-matched.
#
# FAIL-HONEST CONTRACT (each function's stdout, run under `bash -c "$(fn)"` with LOG_WINDOW set):
#   - `docker logs` fails (container missing, daemon unreachable, ...) => NON-ZERO exit
#   - `docker logs` succeeds, nothing matches                          => exit 0, prints "0"
#   - `docker logs` succeeds, N lines match                            => exit 0, prints "N"
#
# HOW: `set -o pipefail` is enabled INSIDE the remote command (a fresh non-interactive remote shell
# does not inherit this script's own top-level `set -o pipefail`), so docker's non-zero exit
# propagates through the pipe even though `wc -l` itself always exits 0. `2>/dev/null` (NOT `2>&1`)
# keeps docker's stderr error text out of the piped byte stream entirely, so it can never be
# miscounted as a grep match. Each grep's own "no lines matched" exit status (1) is neutralized with
# `|| test $? = 1` so a genuine zero-match read still reports pipeline success; any OTHER grep exit
# status (a real grep error, e.g. 2 for a malformed pattern) is left unneutralized and fails the
# pipeline honestly. The grep patterns themselves are byte-identical to the pre-fix ones.
#
# Callers must have LOG_WINDOW set before invoking these functions (they read it at call time, not at
# source time).

alertmanager_error_count_cmd() {
  printf '%s' "set -o pipefail; docker logs --since ${LOG_WINDOW} metasheet-alertmanager 2>/dev/null | { grep -E 'Notify for alerts failed|no_text' || test \$? = 1; } | wc -l | tr -d ' '"
}

bridge_notify_count_cmd() {
  printf '%s' "set -o pipefail; docker logs --since ${LOG_WINDOW} metasheet-alert-webhook 2>/dev/null | { grep '\"path\": \"/notify\"' || test \$? = 1; } | wc -l | tr -d ' '"
}

bridge_resolved_count_cmd() {
  printf '%s' "set -o pipefail; docker logs --since ${LOG_WINDOW} metasheet-alert-webhook 2>/dev/null | { grep '\"path\": \"/notify\"' || test \$? = 1; } | { grep '\"status\": \"resolved\"' || test \$? = 1; } | wc -l | tr -d ' '"
}
