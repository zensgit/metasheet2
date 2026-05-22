# Bridge Agent Data Factory Adapter Verification - 2026-05-22

## Scope

Verification companion for `bridge-agent-data-factory-adapter-design-20260522.md`.

This validates BA-M2 first slice only:

- adapter registration;
- Data Factory adapter metadata;
- Bridge Agent health/object/schema/query calls;
- read limit cap;
- raw SQL / filters rejected before network I/O;
- write path remains unsupported;
- redaction of bridge error text.

It does not validate customer SQL data, real K3 writes, or source refresh into
staging multitables.

## Local Commands

Before the package-level test, the isolated worktree dependency graph was
materialized with:

```bash
pnpm install --frozen-lockfile --ignore-scripts --prefer-offline
```

This created temporary `node_modules` state in the worktree only; no dependency
files are part of the PR commit.

### 1. Focused Bridge Agent adapter test

```bash
node plugins/plugin-integration-core/__tests__/bridge-agent-readonly-adapter.test.cjs
```

Result:

```text
PASS - bridge-agent-readonly-adapter: BA-M2 source contract tests passed
```

Coverage:

| Check | Result |
| --- | --- |
| `testConnection()` calls `/health` then `/objects` | PASS |
| shared-secret header is attached | PASS |
| no bearer/basic auth header is synthesized | PASS |
| `databaseReachable=false` keeps connection test red | PASS |
| object list maps `material`, `bom`, `bom_child` | PASS |
| schema maps Bridge fields | PASS |
| default preview limit is `3` | PASS |
| oversized read is capped to `20` before network call | PASS |
| filters rejected before network call | PASS |
| raw SQL option rejected before network call | PASS |
| non-localhost base URL rejected | PASS |
| unsafe object name rejected | PASS |
| bridge error message redacted | PASS |
| `upsert()` throws `UnsupportedAdapterOperationError` | PASS |

### 2. Adapter metadata route test

```bash
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
```

Result:

```text
PASS - http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
```

New assertion:

- `/api/integration/adapters` includes `bridge:legacy-sql-readonly`;
- it is `advanced: true`;
- roles are `["source"]`;
- supports are `["testConnection", "listObjects", "getSchema", "read"]`;
- read guardrails include `localhostOnly`, `requiresObjectAllowlist`,
  `maxPreviewLimit: 20`, `noRawSql`, and `dryRunFriendly`;
- write guardrail is `{ "supported": false }`.

### 3. Plugin runtime smoke

```bash
node plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs
```

Result:

```text
PASS - plugin-runtime-smoke: all assertions passed
```

New assertion:

- plugin status reports `bridge:legacy-sql-readonly`.

### 4. Host-loader smoke

The isolated worktree initially had no `node_modules`, so the first direct
attempt reported `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'`. I then ran
`pnpm install --frozen-lockfile --ignore-scripts --prefer-offline` inside the
temporary worktree and re-ran the normal package script.

Command:

```bash
pnpm -F plugin-integration-core test:host-loader
```

Result:

```text
PASS - host-loader-smoke: PluginLoader load + activate path passed
```

New assertion:

- PluginLoader activation reports `bridge:legacy-sql-readonly`.

### 5. Full plugin-integration-core test chain

```bash
pnpm -F plugin-integration-core test
```

Result:

```text
PASS - plugin-integration-core test chain
```

Notable passing slices:

- plugin runtime smoke;
- host-loader smoke;
- credential / DB / external-system registry tests;
- adapter contracts;
- HTTP adapter regression;
- Bridge Agent readonly adapter regression;
- pipeline runner;
- REST routes;
- K3 WISE mock control-plane chain;
- staging installer;
- migration SQL structure.

### 6. K3 WISE offline PoC regression

```bash
pnpm verify:integration-k3wise:poc
```

Result:

```text
PASS - K3 WISE PoC mock chain verified end-to-end
```

This confirms the new source adapter did not change the existing K3 Save-only
mock path.

## Static Checks

### Secret-shape scan

Command:

```bash
SECRET_PATTERNS='Bearer [A-Za-z0-9._~+/=-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|pass''word=|access_''token=|postgres:''//[^\s]+:[^\s]+@'
rg -n "$SECRET_PATTERNS" \
  plugins/plugin-integration-core/lib/adapters/bridge-agent-readonly-adapter.cjs \
  plugins/plugin-integration-core/__tests__/bridge-agent-readonly-adapter.test.cjs \
  docs/development/bridge-agent-data-factory-adapter-design-20260522.md \
  docs/development/bridge-agent-data-factory-adapter-verification-20260522.md
```

Expected result:

```text
0 tracked secret values
```

The adapter and tests contain redaction pattern strings and synthetic
placeholder text only.

## Runtime Safety Matrix

| Risk | Guard | Verified By |
| --- | --- | --- |
| MetaSheet connects directly to SQL | Adapter only calls Bridge HTTP endpoints. | Code review + adapter test calls |
| Remote Bridge Agent exposed early | `baseUrl` rejects non-localhost hostnames. | Adapter test |
| Raw SQL injected through Data Factory | `options.sql` / `rawSql` / statement keys rejected. | Adapter test |
| Hidden filters bypass BA-M1 contract | non-empty filters/watermark rejected. | Adapter test |
| Large table read | adapter caps to `maxLimit` before request. | Adapter test |
| Bridge HTTP alive but DB unreachable | `databaseReachable=false` makes `ok=false`. | Adapter test |
| Bridge error leaks credentials | adapter redacts secret-shaped text again. | Adapter test |
| K3 write accidentally triggered | adapter has no target role and `upsert()` unsupported. | Adapter test + metadata route test |

## Entity-Machine Follow-Up After Merge

After this PR is merged and a new on-prem package is built:

1. configure Data Factory source system:

   ```json
   {
     "kind": "bridge:legacy-sql-readonly",
     "role": "source",
     "config": {
       "baseUrl": "http://127.0.0.1:19091/",
       "sampleLimit": 3,
       "maxLimit": 20
     }
   }
   ```

2. store the shared secret in credentials, not plain config;
3. run Data Factory test connection;
4. list objects and confirm `material`, `bom`, `bom_child`;
5. get schema for each object;
6. run dry-run/sample preview with `limit <= 3`;
7. do not run K3 Save / Submit / Audit.

## Conclusion

BA-M2 first slice is ready for review as a backend/plugin adapter PR. It
creates the product-side bridge needed for Data Factory to discover and preview
readonly SQL data, while preserving the current no-write and no-raw-SQL
boundaries.
