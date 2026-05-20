# Data Factory K3 WISE SQL port field design - 2026-05-19

## Purpose

This slice follows the entity-machine feedback that the K3 WISE SQL Server
advanced connection form did not make port entry obvious. Operators had to know
whether to put the port into `Server`, and the saved SQL connection payload did
not carry an explicit `port` field for downstream verification.

The runtime change is frontend-only, with one matching operator-script update so
the live PoC preflight packet preserves the same `sqlServer.port` contract. It
does not add migrations, backend routes, SQL executor behavior, K3 WebAPI
read/list runtime, or integration-core changes.

## Prior dependency

PR #1684 was merged first and closed the backend/package wrapper gap for the
same issue-1526 delivery path. This PR starts from `origin/main` after that
merge (`66d74119a`) and only improves the K3 WISE setup form contract.

## Changes

### Dedicated SQL Server port field

The K3 WISE setup page now shows two separate SQL Server endpoint inputs:

- `Server / Host`
- `Port`

The port defaults to `1433`, matching SQL Server's standard TCP port and the
existing operator expectation for K3 WISE deployments.

### Legacy paste compatibility

Operators can still paste either legacy endpoint shape into the host field:

- `10.0.0.8,1433`
- `10.0.0.8:1433`
- `K3-SQL\WISE,1433`

On blur, the form canonicalizes the values into:

- `sqlServer = 10.0.0.8`
- `sqlPort = 1433`

If both an embedded host-port value and a dedicated port are present, validation
requires them to match. This avoids silently saving a misleading pair such as
`10.0.0.8,1433` plus `14330`.

### Payload and GATE contract

The setup helpers now persist SQL Server configuration as canonical host plus
port:

```json
{
  "config": {
    "server": "10.0.0.10",
    "port": 14330,
    "database": "AIS_TEST"
  }
}
```

GATE draft export/import follows the same shape through
`sqlServer.port`. Imported customer JSON may still provide a legacy host string
with embedded port; the importer splits it before writing to the form.

The live PoC preflight packet builder now also validates and copies
`sqlServer.port` into the generated SQL external-system config. That keeps the
operator-facing GATE package and the script-generated packet aligned for
non-default SQL Server ports.

### Saved-system reload

When an existing `erp:k3-wise-sqlserver` external system is loaded back into the
setup form, the helper normalizes `config.server` and `config.port` into the
dedicated fields. This keeps old saved values readable while making the new UI
unambiguous.

## Non-goals

- No SQL Server executor injection.
- No K3 WebAPI read/list runtime.
- No real K3 Save / Submit / Audit behavior change.
- No Data Factory route or navigation change.
- No package build or release workflow change.
