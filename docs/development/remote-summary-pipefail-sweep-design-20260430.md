# Remote Summary Pipefail Sweep Design - 2026-04-30

## Context

The production Docker GC maintenance workflow exposed a false-red pattern:
remote work completed successfully, but the local GitHub summary step failed
with exit code `141` because the summary renderer used `awk ... | head` under
`set -euo pipefail`.

PR `#1262` fixed that single Docker GC summary. A follow-up scan found the same
summary-rendering shape still present in:

- `.github/workflows/docker-build.yml`
- `.github/workflows/attendance-remote-env-reconcile-prod.yml`
- `.github/workflows/attendance-remote-upload-cleanup-prod.yml`

These are operator-facing workflows where a false red wastes time and can hide
the real signal.

## Design

Keep the fix scoped to summary rendering only:

- no remote SSH command changes.
- no deploy, reconcile, cleanup, or final gate semantic changes.
- no threshold or artifact contract changes.
- replace `awk ... | head -n 120` with a single `awk` program that enforces the
  line cap internally.

For simple bounded blocks:

```bash
awk '
  /^=== START ===$/ { printing=1; count=0; next }
  /^=== END ===$/ { printing=0 }
  printing && count < 120 { print; count++ }
' "$log_file"
```

For workflows that include a small post-block tail after the end marker:

```bash
awk '
  /^=== START ===$/ { printing=1; total=0; next }
  /^=== END ===$/ { printing=0; after=1; next }
  printing && total < 120 { print; total++; next }
  after && total < 120 {
    print
    total++
    count++
    if (count >= 20) exit
  }
' "$log_file"
```

## Files

- `.github/workflows/docker-build.yml`
- `.github/workflows/attendance-remote-env-reconcile-prod.yml`
- `.github/workflows/attendance-remote-upload-cleanup-prod.yml`
- `scripts/ops/remote-summary-pipefail-contract.test.mjs`

## Non-Goals

- Do not change Docker deploy behavior.
- Do not change K3 WISE smoke behavior.
- Do not change attendance env reconcile or upload cleanup remote logic.
- Do not touch production secrets or remote host state.
