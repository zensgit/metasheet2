# Data Factory #1526 Gate Contract Install Entry Design - 2026-05-18

## Purpose

PR #1634 packaged `integration-k3wise-gate-contract-check.mjs --init-template`,
but the generated package root `INSTALL.txt` still only showed the later
`--input` validation command. A Windows/on-prem operator using the package
without reading the full runbook could miss the safer first step and hand-write
the packet again.

This slice adds the initializer to `INSTALL.txt` and makes package verification
fail if the entry disappears from a future zip/tgz.

## Boundary

- No runtime behavior changes.
- No integration-core, DB, API route, adapter, pipeline, or K3 call changes.
- Stage 1 Lock remains held.
- This is package operator guidance plus verifier coverage only.

## INSTALL.txt Flow

The K3 WISE operator section now lists:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs --init-template <safe-dir>
```

before:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs --input <contract.json> --out-dir <art>
```

The text explains that the initializer creates the fillable O1-O6/R1-R7 packet
and 8 redacted sample skeletons outside Git, then the operator fills that
directory with customer evidence before running the checker.

## Package Verifier Guard

`scripts/ops/multitable-onprem-package-verify.sh` now checks packaged
`INSTALL.txt` for:

- `--init-template`
- `8 redacted`

The first assertion proves the command is visible at the package root. The
second assertion proves the quickstart mentions the concrete sample skeleton
count rather than only naming the script.

## Why This Is Separate From #1634

#1634 added the actual CLI and runbook/docs contract. This PR closes the final
operator-discovery gap in the generated package landing file. Keeping it small
makes the review surface obvious and avoids mixing runtime work into the Stage 1
handoff path.
