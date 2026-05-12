# Generic Integration Workbench Advanced Connectors Design - 2026-05-12

## Purpose

Close the Workbench UX gap around SQL channels and same-system object conversion:

- SQL channels should not appear in the default business-user connector lists.
- Advanced implementers should be able to reveal SQL/advanced connections explicitly.
- Same-system pipelines must be described as "same system, different business object", not as loopback sync.
- When one physical K3 WISE account uses different protocols, the UI should recommend two logical connections.

## Implementation

`IntegrationWorkbenchView.vue` now derives advanced status from adapter discovery metadata:

- `adapters[].advanced === true` marks a connector kind as advanced.
- Default source and target system lists filter out systems whose adapter kind is advanced.
- The adapter pill list also hides advanced adapters by default.
- A new `显示 SQL / 高级连接` toggle reveals advanced adapters and systems.

The system selectors continue to use the existing backend external-system list. No backend route or schema change was needed.

## Same-System Copy

When source and target system IDs match:

- role `bidirectional` shows the exact copy `same system, different business object`;
- any non-bidirectional same-system selection shows a warning that same-system mode requires `role=bidirectional`.

When source and target are both K3 WISE but use different connector kinds, the UI recommends:

- SQL read channel as the source logical connection;
- WebAPI Save channel as the target logical connection.

## Security Boundary

The advanced toggle is a UI exposure control, not an authorization boundary. Backend permissions and adapter allowlists remain the enforcement layer. The UI copy explicitly states that SQL is for allowlisted table/view reads or middle-table writes and that direct core-table writes must not be exposed to normal users.

## Non-Goals

- No SQL allowlist editor in this slice.
- No middle-table write configuration in this slice.
- No raw SQL field.
- No backend permission or registry change.
