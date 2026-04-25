# Integration Core K3 WISE Preflight Boundary Hardening Design - 2026-04-25

## Objective

Harden the local K3 WISE live PoC preflight generator before customer GATE
answers arrive.

The goal is not to expand the PoC scope. It is to reduce avoidable round trips
when a customer sends imperfect JSON and to keep the preflight safety gates from
silently accepting unsafe intent.

## Files

- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`

## Boundary Findings

The boundary probe covered common customer-input variants:

- URL with trailing slash.
- `apiUrl` omitted but `baseUrl` supplied.
- upper-case or padded environment values.
- Chinese production environment text.
- `autoSubmit` / `autoAudit` supplied as strings instead of booleans.
- upper-case SQL Server mode.
- K3 core table names with case, whitespace, schema qualification, or SQL
  quoting.
- similar but non-core middle-table names.
- plaintext credential values that must be redacted from generated output.

The preflight behavior before this change had four unsafe or noisy edges:

1. `k3Wise.environment: "UAT"` passed validation but was emitted as `UAT`
   instead of canonical `uat`.
2. `autoSubmit: "true"` or `autoAudit: "yes"` passed because only boolean
   `true` was blocked.
3. `sqlServer.mode: "READONLY"` was treated as a write mode and could
   incorrectly block read-only access to K3 core tables.
4. K3 core table names with whitespace, schema qualification, or brackets were
   not detected by the core-table write guard.

## Design

### Environment Normalization

`k3Wise.environment` is trimmed, lower-cased, validated against the existing
non-production allowlist, and then emitted canonically in the packet.

This keeps the packet stable even when the customer answers `UAT`, ` uat `, or
similar safe variants.

### Save-Only Boolean Guard

`autoSubmit` and `autoAudit` now go through a safety-specific boolean parser.

Accepted false-like values:

- `false`
- `0`
- `no`
- `n`
- `off`
- empty string
- `否`
- `禁用`
- `关闭`

Truthy values such as `true`, `1`, `yes`, `on`, `是`, `启用`, and `开启` are
recognized and blocked by the existing Save-only error. Unknown strings such as
`maybe` fail with a field-specific validation error.

This is intentionally strict for unsafe intent but tolerant for harmless
customer formatting mistakes.

### SQL Server Mode Normalization

`sqlServer.mode` is normalized before safety checks.

Canonical modes remain:

- `readonly`
- `middle-table`
- `stored-procedure`

Accepted aliases include `READONLY`, `read only`, `read-only`, `middle table`,
`middle_table`, `stored procedure`, and `stored_procedure`.

Read-only mode can list K3 core tables because it does not write. Write-capable
modes still cannot target K3 core business tables.

### K3 Core Table Name Guard

The core-table guard now normalizes SQL object names before comparison:

- trim whitespace;
- lower-case identifiers;
- strip SQL quoting characters such as `[name]`, `"name"`, `` `name` ``, and
  `'name'`;
- use the final object segment for schema-qualified names such as
  `dbo.t_ICItem`.

The guard still uses exact canonical table names only:

- `t_icitem`
- `t_icbom`
- `t_icbomchild`

This blocks direct writes to K3 core tables while allowing customer-approved
middle tables with similar names such as `t_ICItem_stage`.

## Non-Goals

- No live PLM/K3/SQL Server connectivity.
- No adapter runtime behavior changes.
- No new GATE fields.
- No production-write support.
- No broad vendor-abstraction work before K3 WISE live PoC PASS.
