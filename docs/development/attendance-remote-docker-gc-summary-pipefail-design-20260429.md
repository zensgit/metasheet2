# Attendance Remote Docker GC Summary Pipefail Design - 2026-04-29

## Context

`Attendance Remote Docker GC (Prod)` successfully reclaimed deploy-host disk
space after the root filesystem reached 100% usage. The remote GC step returned
`gc_rc=0` and reclaimed `37.31GB`, lowering `/` from 100% to 41%.

The workflow still ended red because the local summary step used this shape:

```bash
awk '...' "$gc_log" | head -n 120
```

With `set -euo pipefail`, `head` can exit after consuming the requested lines
and leave `awk` with `SIGPIPE` (`141`). That makes a successful maintenance run
look failed.

## Design

Keep the change summary-only:

- do not change SSH, Docker prune, artifact upload, or final `gc_rc` semantics.
- remove the pipe to `head` from the summary snippet extraction.
- enforce the 120-line cap inside the single `awk` program.

The new extraction is:

```bash
awk '
  /^=== DOCKER GC START ===$/ { printing=1; count=0; next }
  /^=== DOCKER GC END ===$/ { printing=0 }
  printing && count < 120 { print; count++ }
' "$gc_log"
```

## Files

- `.github/workflows/attendance-remote-docker-gc-prod.yml`
- `scripts/ops/attendance-remote-docker-gc-workflow-contract.test.mjs`

## Non-Goals

- No change to which Docker resources are pruned.
- No change to deploy workflow behavior.
- No change to storage thresholds or runbook links.
