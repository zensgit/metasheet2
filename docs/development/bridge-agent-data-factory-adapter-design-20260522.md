# Bridge Agent Data Factory Adapter Design - 2026-05-22

## Purpose

This slice starts BA-M2: connect the validated BA-M1 readonly Bridge Agent to
MetaSheet Data Factory as a source adapter.

The scope is intentionally narrow:

- add adapter kind `bridge:legacy-sql-readonly`;
- call the existing Bridge Agent HTTP contract;
- expose object discovery, schema discovery, and capped read/sample preview;
- keep writes impossible through the adapter contract;
- keep K3 Save / Submit / Audit out of scope.

BA-M0.5 and BA-M1 have already supplied the entity-machine evidence that the
selected bridge host can run the PowerShell agent and query the allowlisted SQL
views. This PR only gives MetaSheet a product-side connector to that already
validated localhost service.

## Files

| File | Purpose |
| --- | --- |
| `plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs` | BA-M2 readonly adapter implementation. |
| `plugins/plugin-integration-core/index.cjs` | Registers `bridge:legacy-sql-readonly`. |
| `plugins/plugin-integration-core/lib/http-routes.cjs` | Publishes Data Factory adapter metadata and guardrails. |
| `plugins/plugin-integration-core/__tests__/bridge-agent-readonly-adapter.test.cjs` | Adapter contract tests. |
| `plugins/plugin-integration-core/__tests__/http-routes.test.cjs` | Adapter metadata discovery regression. |
| `plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs` | Runtime registration regression. |
| `plugins/plugin-integration-core/__tests__/host-loader-smoke.test.mjs` | Host-loader registration regression. |
| `plugins/plugin-integration-core/package.json` | Adds the focused test script to the plugin test chain. |

## Public Adapter Contract

External system kind:

```json
{
  "kind": "bridge:legacy-sql-readonly",
  "role": "source",
  "config": {
    "baseUrl": "http://127.0.0.1:19091/",
    "sampleLimit": 3,
    "maxLimit": 20,
    "authHeaderName": "X-MetaSheet-Bridge-Secret"
  },
  "credentials": {
    "sharedSecret": "<stored in credential store>"
  }
}
```

Supported operations:

| Operation | Bridge endpoint | Notes |
| --- | --- | --- |
| `testConnection()` | `GET /health` then `GET /objects` | The result is red unless `databaseReachable !== false`. |
| `listObjects()` | `GET /objects` | Maps Bridge allowlist objects into Data Factory datasets. |
| `getSchema({ object })` | `GET /schema/:object` | Object names must match the Bridge allowlist identifier pattern. |
| `read({ object, limit })` | `POST /query/:object` | Sends only `{ "limit": N }`; default `3`, cap `20` unless configured lower/higher within `<=500`. |
| `upsert()` | none | Always throws `UnsupportedAdapterOperationError`. |

## Security Boundaries

### Localhost Only

`config.baseUrl` defaults to `http://127.0.0.1:19091/` and is rejected unless
the hostname is `localhost`, `127.0.0.1`, or `::1`. BA-M2 therefore assumes the
Bridge Agent is running on the same MetaSheet on-prem server. Separate bridge
machines remain a later design item because they need firewall, TLS, and
rotation decisions.

### No Raw SQL

The adapter has no SQL text parameter. `read()` rejects `options.sql`,
`options.rawSql`, `options.queryText`, and related raw-statement keys before a
network request is made. It also rejects non-empty filters and watermarks
because BA-M1 explicitly blocks filters until a later query contract is
designed.

### Object Allowlist

The adapter does not invent objects locally. `listObjects()` reflects the
Bridge Agent allowlist, and `getSchema()` / `read()` accept only safe object
identifiers matching:

```text
^[A-Za-z_][A-Za-z0-9_]*$
```

The first validated objects remain:

- `material`
- `bom`
- `bom_child`

### Capped Reads

When Data Factory asks for a preview without a limit, the adapter sends
`limit=3`. If the runner asks for a larger batch, the adapter caps it at
`config.maxLimit` (default `20`) before calling the Bridge Agent. The Bridge
Agent keeps its own max-limit guard as a second layer.

### Secret Handling

The shared secret is passed through the encrypted external-system credentials
path (`credentials.sharedSecret`) or, if configured, a local process env var.
It is never returned by `listObjects()`, `getSchema()`, `read()` metadata, or
test-result summaries.

Bridge error messages are redacted again in the adapter even though BA-M1
already redacts server-side errors. This protects against future bridge
implementation drift.

## Data Factory Metadata

`/api/integration/adapters` now describes the adapter as:

```json
{
  "kind": "bridge:legacy-sql-readonly",
  "label": "Readonly Bridge Agent",
  "roles": ["source"],
  "supports": ["testConnection", "listObjects", "getSchema", "read"],
  "advanced": true,
  "guardrails": {
    "read": {
      "localhostOnly": true,
      "requiresObjectAllowlist": true,
      "maxPreviewLimit": 20,
      "noRawSql": true,
      "dryRunFriendly": true
    },
    "write": {
      "supported": false
    }
  }
}
```

It is marked advanced so normal users continue to start from staging
multitables and K3/material/BOM presets. Implementation users can enable
advanced connectors to wire the Bridge Agent as a source system.

## Out Of Scope

- UI-specific connection form for Bridge Agent.
- Source refresh into staging multitables.
- Remote bridge-machine TLS/mTLS mode.
- SQL filters, incremental watermarks, joins, or relationship expansion.
- Any SQL write, DDL, stored procedure, or raw SQL execution.
- K3 Save / Submit / Audit.

## Follow-Up

After this PR lands and a package is rebuilt, the next entity-machine smoke is:

1. create a `bridge:legacy-sql-readonly` external system pointing at
   `http://127.0.0.1:19091/`;
2. store the shared secret through credentials, not config text;
3. run test connection;
4. confirm objects: `material`, `bom`, `bom_child`;
5. confirm schema discovery for all three;
6. run dry-run/sample preview with `limit <= 3`;
7. only after that, add source refresh into staging multitables in a separate
   PR.
