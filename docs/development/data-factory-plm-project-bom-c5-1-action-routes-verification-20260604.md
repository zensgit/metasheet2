# Data Factory #2253 C5-1 action routes verification (2026-06-04)

## Scope

PR scope: backend parameterized table action routes for the PLM project BOM ->
stock-preparation flow.

This slice wires the already-landed C2/C3/C4 helpers behind a server-side action
contract:

- `GET /api/integration/table-actions`;
- `POST /api/integration/table-actions/:actionId/dry-run`;
- `POST /api/integration/table-actions/:actionId/apply`.

It adds no UI, migration, package, external database write, PLM write, K3
Save/Submit/Audit/BOM, or multi-project mode.

## Security locks

- Public action metadata does not expose source bindings or target `sheetId`.
- Action execution uses server-side action config. Browser requests carry only
  allowlisted parameters and confirmation metadata.
- Unknown top-level request fields such as `sheetId`, `target`, `plan`, or C4
  payloads reject before source reads or writes.
- Dry-run uses `requireAccess(read)` and reads the readonly SQL source as the
  request user's principal.
- Apply uses `requireAccess(write)` and derives C4 permission from the
  authenticated user (`admin` for admin users, otherwise `write`); it never
  accepts permission from the client.
- Apply requires a server-generated dry-run token. Tokens are stored in plugin
  storage, are one-use, and bind action id + normalized parameters + current
  source/target revision.
- Apply recomputes C2 expansion + C3 planning server-side before C4. A shifted
  source/target revision rejects instead of applying stale reviewed output.
- C4 receives a target-scoped records API bound to the configured
  stock-preparation sheet. The browser cannot choose `sheetId`.
- `manual_confirm` rows stay held; clean rows can still apply when the operator
  explicitly accepts the hold.
- Evidence responses are values-free summaries. They contain counts/status/error
  codes, not PLM project/component/material values or write payloads.

## Verification run

Commands:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test:http-routes
pnpm --filter plugin-integration-core test:stock-preparation-apply-writer
```

Result:

```text
stock-preparation-table-actions.test.cjs OK
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
stock-preparation-apply-writer.test.cjs OK
```

## Test locks

`stock-preparation-table-actions.test.cjs`:

- configured action metadata is public and values-free;
- unconfigured action fails closed;
- dry-run rejects unknown parameters and stores a token;
- dry-run existing-row read is scoped to the configured target sheet and one
  project;
- apply cannot run without a token;
- apply recomputes and rejects data shifted after review;
- apply writes only the configured target sheet;
- dry-run tokens are one-use;
- `manual_confirm` rows require explicit `acceptManualConfirmHold=true`.

`http-routes.test.cjs`:

- routes are reachable through the real HTTP route harness;
- list route does not expose source system id or target sheet id;
- client-supplied `sheetId` rejects before adapter creation;
- dry-run passes request principal to `createAdapter`;
- read-only user cannot apply;
- client-supplied C3 `plan` rejects and does not consume the dry-run token;
- admin apply passes `permission:"admin"` to C4, proving permission is not
  hardcoded to `"write"`;
- apply creates through the configured target sheet only;
- unconfigured action returns `TABLE_ACTION_NOT_CONFIGURED`.

## Remaining gates

C5-2 is still required for the workbench UI. C5-3 is still required for
entity-machine validation. C6 option sync remains separate.

