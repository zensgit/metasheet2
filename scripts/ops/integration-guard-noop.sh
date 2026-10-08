#!/usr/bin/env bash
# Integration Guard no-op (out-of-scope) message (governance slice, #4614 maintenance-cost
# ruling, 2026-07-26). Extracted out of .github/workflows/integration-guard.yml's `id: noop` step
# so the workflow only pins a single-line invocation of this script, not the message text itself
# (owner ruling: "They do not accept long-term exact-copying of ... the no-op text. Move those
# commands into named scripts / the roster, and have the workflow pin only the single-line
# invocation."). `GITHUB_EVENT_NAME` is one of GitHub Actions' own always-set default env vars, so
# no explicit `env:` wiring is needed in the workflow step to reach it here.
set -euo pipefail

echo "Integration Guard: no changes in guarded paths for this ${GITHUB_EVENT_NAME:-<unknown>} event."
echo "This is a DELIBERATE NO-OP SUCCESS (exit 0) -- an auditable, in-band result in this"
echo "job's own log, not an out-of-band skipped conclusion a reviewer would have to look up."
exit 0
