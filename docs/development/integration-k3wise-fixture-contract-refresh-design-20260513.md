# K3 WISE Fixture Contract Refresh Design - 2026-05-13

## Scope

Refresh stale PR #1320 on current `main`. The old branch had two stacked concerns:

- keep copy-and-edit K3 WISE GATE/evidence fixtures aligned with exported script samples;
- harden live evidence decisions before customer evidence is accepted as PASS.

This refresh replays both concerns after the later K3 WISE offline PoC, auth transport, disabled SQL mode, and delivery readiness changes landed.

## Changes

### Fixture contract

Added `scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs`.

The test proves:

- `gate-sample.json`, after stripping `_comment`, equals `sampleGate()`;
- `evidence-sample.json`, after stripping `_comment`, equals `sampleEvidence()`;
- the GATE fixture builds a Save-only preflight packet with the expected external systems and pipelines;
- the evidence fixture compiles against that packet with `decision=PASS`;
- placeholder credential values do not leak into generated preflight output.

`verify:integration-k3wise:poc` now includes this fixture contract test while preserving the current mock K3 WebAPI, mock SQL executor, and mock demo chain.

### Material dry-run proof

When `materialDryRun.status` is `pass`, the evidence compiler now requires:

- `materialDryRun.runId`;
- `materialDryRun.rowsPreviewed` as an integer from `1..3`.

Non-pass dry-run statuses still defer to the phase status and do not trigger proof-specific failures.

### Secret container scanning

The evidence scanner already rejects secret-looking text in arbitrary strings. This refresh also rejects nested values under secret-like keys, for example:

- `credentials: { value: "..." }`;
- `authorization: ["Bearer ..."]`.

Safe placeholders remain allowed, and credential metadata keys such as `requiredCredentialKeys` are ignored because they describe field names rather than secret values.

### Optional SQL failure semantics

The SQL Server evidence phase is optional because some customer GATE packets disable SQL. Optional still does not mean "failed is acceptable": if a SQL phase is present and explicitly `fail`, the overall evidence decision is now `FAIL`. `skipped` remains acceptable for optional SQL.

## Compatibility

No live K3 WISE, SQL Server, or customer credential path is invoked. This slice only tightens local evidence validation and the offline PoC verification chain.
