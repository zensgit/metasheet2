# K3 WISE Preflight Disabled SQL Mode Guidance Design - 2026-05-05

## Scope

This slice tightens the customer GATE preflight error for one ambiguous SQL Server configuration:

```json
{
  "sqlServer": {
    "enabled": true,
    "mode": "disabled"
  }
}
```

Before this change, the preflight rejected the packet with the generic mode message:

`sqlServer.mode must be readonly, middle-table, or stored-procedure`

That was technically correct but not actionable enough for customer-filled GATE JSON. If the operator wants to disable SQL Server, the correct field is `sqlServer.enabled=false`, not `mode=disabled` while the channel is enabled.

## Design

`scripts/ops/integration-k3wise-live-poc-preflight.mjs` keeps the existing semantics:

- `enabled=false` with no explicit mode still normalizes to `disabled`.
- `enabled=true` with no explicit mode still defaults to `readonly`.
- `enabled=true` with valid modes still accepts `readonly`, `middle-table`, and `stored-procedure`.
- unknown modes still use the generic mode validation error.

The only new branch is:

- `mode=disabled` and `enabled=true` throws a targeted `LivePocPreflightError`.

The new message is:

`sqlServer.mode=disabled requires sqlServer.enabled=false; set enabled=false or choose readonly, middle-table, or stored-procedure`

The error details include:

- `field: "sqlServer.mode"`
- `mode`
- `sqlServerEnabled: true`
- `acceptedModes`

This keeps machine-readable diagnostics stable while giving operators a direct remediation path.

## Boundary

This does not change SQL Server channel safety behavior. It only improves the preflight guidance for an already-rejected packet shape.
