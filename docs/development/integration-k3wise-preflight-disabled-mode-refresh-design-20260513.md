# K3 WISE Preflight Disabled SQL Mode Refresh Design - 2026-05-13

## Scope

Refresh stale PR #1316 on current `main` after the K3 WISE PoC hardening queue moved forward.

The behavior gap is narrow: a GATE packet with `sqlServer.enabled=true` and `sqlServer.mode=disabled` is already invalid, but current `main` reports the generic mode error:

`sqlServer.mode must be readonly, middle-table, or stored-procedure`

That message is technically correct but not actionable for customer-filled GATE JSON. If the operator wants to disable SQL Server, the field to change is `sqlServer.enabled=false`.

## Design

`normalizeSqlMode()` keeps existing semantics:

- `enabled=false` and no explicit mode normalizes to `disabled`.
- `enabled=true` and no explicit mode defaults to `readonly`.
- Valid enabled modes remain `readonly`, `middle-table`, and `stored-procedure`.
- Unknown modes still use the generic validation error.

The only new branch is the explicit invalid shape:

```json
{
  "sqlServer": {
    "enabled": true,
    "mode": "disabled"
  }
}
```

It now throws `LivePocPreflightError` with operator-facing remediation:

`sqlServer.mode=disabled requires sqlServer.enabled=false; set enabled=false or choose readonly, middle-table, or stored-procedure`

Machine-readable details include:

- `field: "sqlServer.mode"`
- `mode`
- `sqlServerEnabled: true`
- `acceptedModes`

The K3 WISE runbook quick lookup table now maps the exact error to the same remediation.

## Compatibility

This does not change SQL Server write safety or any accepted packet shape. It only improves guidance for a packet that was already rejected.

