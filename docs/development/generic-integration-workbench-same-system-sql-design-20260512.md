# Generic Integration Workbench Same-System and SQL Advanced Design - 2026-05-12

## Purpose

This slice turns two product decisions into concrete repo artifacts:

1. a source and target may be the same external system when the business objects differ;
2. SQL channels are supported as advanced implementation features, not casual business-user connectors.

The implementation intentionally stays narrow: it adds regression coverage and planning docs, but does not introduce new runtime APIs or database migrations.

## Same-System Rule

The pipeline model already separates system identity from business object identity:

- `sourceSystemId`
- `sourceObject`
- `targetSystemId`
- `targetObject`

Therefore a valid pipeline may read `customers_raw` and write `customers_clean` on the same CRM connection, or read a source object and write a normalized object on the same SRM connection.

The safety condition is role-based:

- same-system pipeline is valid when the external system role is `bidirectional`;
- same-system pipeline is invalid when the external system is only `source`;
- same-system pipeline is invalid when the external system is only `target`.

This matches the existing registry role checks and is now explicitly covered by tests.

## SQL Channel Rule

SQL channel should be exposed as an advanced connector path:

- SQL read is allowed only through configured object metadata and table allowlists.
- SQL write is allowed only for configured middle tables by default.
- Raw SQL is never accepted.
- Direct writes to K3 WISE core tables remain outside normal UI.
- Delivery/admin users may configure SQL objects; ordinary business users should consume the resulting connector, not author SQL behavior.

This aligns with the existing K3 WISE SQL Server adapter, which uses object configuration, identifier validation, read/write allowlists, and middle-table write mode.

## Product Impact

The generic workbench can support these examples:

| Example | Source | Target | Recommended setup |
| --- | --- | --- | --- |
| CRM cleanup | CRM `customers_raw` | CRM `customers_clean` | one `bidirectional` CRM HTTP system |
| SRM supplier normalization | SRM `supplier_candidates` | SRM `suppliers` | one `bidirectional` SRM HTTP system |
| K3 table correction | K3 SQL `t_ICItem` read object | K3 WebAPI `material` Save | two logical systems pointing to one K3 account |
| K3 middle-table integration | K3 SQL source view | K3 SQL middle table | advanced SQL channel with allowlists |

The UI copy should use "same system, different business object" rather than "loopback" to avoid implying uncontrolled self-sync.

## Non-Goals

- No new `integration_document_templates` table in this slice.
- No new REST endpoints in this slice.
- No user-defined JavaScript.
- No raw SQL editor.
- No direct K3 core-table write UI.
- No Submit/Audit default enablement.
