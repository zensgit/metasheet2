# Data Factory K3 WISE SQL port field verification - 2026-05-19

## Scope

Branch: `codex/k3-sql-port-field-20260519`

Files changed:

- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`
- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.test.mjs`
- `scripts/ops/fixtures/integration-k3wise/gate-sample.json`
- `scripts/ops/fixtures/integration-k3wise/gate-intake-template.json`
- `docs/development/data-factory-k3wise-sql-port-field-design-20260519.md`
- `docs/development/data-factory-k3wise-sql-port-field-verification-20260519.md`

No backend, plugin runtime, migration, API route, or package script changed. The
ops script change is limited to preserving and validating `sqlServer.port` in
the live PoC packet builder.

## Local verification

### Focused K3 setup specs

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/k3WiseSetup.spec.ts tests/IntegrationK3WiseSetupView.spec.ts --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       49 passed (49)
```

Covered assertions:

- SQL Server setup payload writes canonical `server` plus numeric `port`.
- GATE draft includes `sqlServer.port`.
- Customer GATE JSON import splits `server: "10.0.0.10,14330"` into host and
  port fields.
- Legacy Windows named-instance input such as `K3-SQL\WISE,1433` is split
  without dropping the instance segment.
- Saved SQL Server external systems reload into canonical host and port fields.
- The K3 WISE setup page displays a dedicated `Port` input with default `1433`.
- Pasting `10.0.0.9,14330` into `Server / Host` splits the form on blur.

### Live PoC preflight packet

Command:

```bash
pnpm run verify:integration-k3wise:poc
```

Result:

```text
K3 WISE PoC mock chain verified end-to-end (PASS)
exit 0
```

Covered assertions:

- `sqlServer.port: "14330"` is validated and emitted as numeric
  `config.port: 14330` in the generated SQL external-system packet.
- Invalid SQL Server ports such as `0`, `65536`, `abc`, and `1433.5` are
  rejected before packet generation.
- `gate-sample.json` remains equivalent to `--print-sample`, including the new
  `sqlServer.port` sample value.
- `gate-intake-template.json` remains accepted by the preflight parser.
- Existing Save-only, secret-redaction, SQL core-table guard, and K3/PLM
  mapping checks remain green across the full offline PoC chain.

### Type-check

Command:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Result: exit 0.

### Production build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
vue-tsc -b && vite build
built in 5.79s
exit 0
```

The build emitted the existing large-chunk warning and the existing
`WorkflowDesigner.vue` dynamic/static import warning. Neither warning is caused
by this SQL port field change.

### Diff hygiene

Command:

```bash
git diff --check origin/main...HEAD
```

Result: exit 0.

## Behavior matrix

| Scenario | Expected result | Covered by |
| --- | --- | --- |
| Fresh form | `sqlPort` defaults to `1433` | K3 setup view spec |
| Paste `host,port` | Host and port split on blur | K3 setup view spec |
| Paste `host:port` | Helper parses legacy colon form | K3 setup helper spec |
| Save SQL connection | Payload stores `config.server` and `config.port` | K3 setup helper spec |
| Export GATE draft | Draft includes `sqlServer.port` when SQL channel enabled | K3 setup helper spec |
| Import GATE draft | Embedded port from `sqlServer.server` is preserved | K3 setup helper spec |
| Reload saved system | Existing non-default host-port string is canonicalized without falling back to `1433` | K3 setup helper spec |
| Build live PoC packet | Dedicated `sqlServer.port` reaches SQL external-system `config.port` | Preflight script spec |
| Invalid live PoC port | Invalid TCP ports fail before packet generation | Preflight script spec |

## Deployment impact

This is a frontend/operator-form improvement plus a matching preflight packet
contract update. Existing saved SQL Server connections remain readable because
the loader accepts both:

- legacy `config.server = "host,port"`
- canonical `config.server = "host"` plus `config.port = 1433`

The next on-prem package retest should confirm the K3 WISE setup page displays
the separate port field and no longer asks operators to encode the port inside
the server field.
