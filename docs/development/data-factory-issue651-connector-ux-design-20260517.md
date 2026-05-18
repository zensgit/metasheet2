# Data Factory connector UX follow-up for issue #651

Date: 2026-05-17
Branch: `codex/issue651-data-factory-connector-ux-20260517`

## Context

The Windows on-prem feedback in issue #651 moved past the C1 record-create context bug and exposed two Data Factory UX gaps:

1. The source/target selectors looked inconsistent: K3 WISE WebAPI appeared only as a target, while users expected it might also be a source.
2. The connection inventory listed saved systems but did not provide basic management actions or duplicate warnings.

The backend contract matters here. `plugin-integration-core` currently exposes external-system list/get/upsert/test routes, but it does not expose a delete or clone route. K3 WISE WebAPI is also deliberately target-only until the GATE-front read/list contract is satisfied.

## Design

### Selector semantics

The Data Factory selectors now filter saved connections by both:

- the saved connection role (`source`, `target`, `bidirectional`)
- the adapter metadata role/supports contract

This means:

- source selector shows only readable saved connections
- target selector shows only writable saved connections
- K3 WISE WebAPI remains target-only
- K3 SQL Server Channel remains hidden until advanced connectors are shown

The page now says explicitly that selectors show saved connections, not every adapter.

### K3 WISE WebAPI read/list gate

When a saved K3 WISE WebAPI target exists, the source side shows a gate notice:

- K3 WISE WebAPI is available as a target write channel
- WebAPI read/list runtime remains GATE-blocked
- K3 reads should use SQL read channel or staging multitable until customer O1-O6 and redacted samples arrive

This keeps Stage 1 Lock intact and prevents the UI from implying that WebAPI read is already implemented.

### Connection management

The inventory now provides safe actions:

- Edit: loads metadata and non-credential config into a draft.
- Copy: creates an inactive draft with the same adapter/role/config.
- Deactivate: upserts the existing connection with `status=inactive`.
- Delete: shown disabled as `删除待接口`, because the backend has no delete route yet.

The draft blocks saves when JSON is invalid, role does not match adapter metadata, or secret-like values are present in config/capabilities.

### Duplicate warnings

The draft warns on:

- same connection name
- same adapter kind plus same role

The warning does not hard-block saves because some deployments intentionally use multiple logical connections for the same physical system. It pushes users to name connections by protocol, data set, or purpose.

## Out of scope

- No physical delete API.
- No backend migration.
- No `plugin-integration-core` runtime read/list implementation.
- No credential editing in Data Factory workbench.

