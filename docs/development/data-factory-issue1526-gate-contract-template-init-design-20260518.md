# Data Factory #1526 Gate Contract Template Init Design - 2026-05-18

## Purpose

The #1526 GATE-front checker can validate O1-O6 WebAPI read/list answers and
R1-R7 relationship-mapping answers, but operators still had to hand-write the
packet file and eight sample filenames before the customer returned evidence.
That made the next customer handoff easy to mis-shape and hard to repeat.

This slice adds a packaged, read-only template initializer:

```bash
node scripts/ops/integration-k3wise-gate-contract-check.mjs \
  --init-template /path/outside-git/k3wise-gate-contract
```

The command writes a canonical fillable packet plus the eight redacted sample
skeletons expected by the existing checker.

## Boundary

- No `plugins/plugin-integration-core` runtime changes.
- No DB migrations, API routes, adapter behavior, or K3 calls.
- No Stage 1 Lock lift: runtime read/list, SQL sampling, and relationship
  resolver work still wait for customer GATE PASS.
- The generated template intentionally returns `GATE_BLOCKED` until all
  customer placeholders are replaced outside Git.

## Files Written By The Initializer

The target directory receives:

- `k3wise-gate-contract-packet.template.json`
- `sample-material-list.redacted.json`
- `sample-material-detail.redacted.json`
- `sample-bom-list.redacted.json`
- `sample-bom-detail.redacted.json`
- `relationship-flat-bom-lines.redacted.json`
- `relationship-tree-bom.redacted.json`
- `relationship-unresolved-child.redacted.json`
- `relationship-k3-bom-save-shape.redacted.json`

The packet uses the same answer IDs already validated by the checker:

- WebAPI read/list: `O1-MAT`, `O1-MAT-M`, `O1-BOM`, `O1-BOM-M`, `O2-P`,
  `O2-T`, `O2-C`, `O3-F`, `O3-M`, `O4-MAT`, `O4-BOM`, `O6`
- Relationship mapping: `R1` through `R7`

## Safety Rules

- Values that require customer input are set to `<fill-outside-git>`.
- Sample skeletons contain example record shapes only; no URL, token, password,
  session ID, authority code, or SQL connection string is emitted.
- Existing files are not overwritten. A rerun against a populated directory
  fails instead of clobbering a partially filled customer packet.
- The generated packet is useful for shape and filename alignment, but it is not
  sufficient evidence. Running the checker against it must return
  `GATE_BLOCKED`.

## Packaging

The on-prem package verifier now asserts:

- the checker exposes `--init-template`;
- the canonical packet filename is present in the checker;
- both customer sample manifests document the initializer;
- this design and its verification document are included in the package.

This keeps the operator-visible workflow aligned with the packaged binary and
prevents a stale zip from silently missing the template command.
