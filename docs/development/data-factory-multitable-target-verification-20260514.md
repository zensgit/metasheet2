# Data Factory multitable target adapter - verification - 2026-05-14

## Scope

This verification covers the `metasheet:multitable` target adapter:

- adapter registration in `plugin-integration-core`;
- adapter discovery metadata;
- schema/object listing;
- append and keyed upsert behavior;
- dry-run preview payload projection;
- write-only contract;
- existing K3 offline PoC regression.

It does not validate live K3 WISE connectivity or arbitrary user-owned table writes.

## Checks

### Rebase after staging-source merge

After PR #1550 merged, this branch was rebased on the new `origin/main`.
Conflict resolution kept both adapter registrations and metadata entries:

- `metasheet:staging` remains registered as a source-only adapter;
- `metasheet:multitable` remains registered as a target-only adapter;
- runtime smoke and HTTP route tests assert both adapter kinds.

Result: PASS.

### Backend plugin tests

Command:

```bash
pnpm -F plugin-integration-core test
```

Expected coverage:

- runtime status includes `metasheet:multitable`;
- discovery metadata marks it as a non-advanced target adapter;
- unit test writes a new target record with `createRecord()`;
- unit test updates an existing target record through `queryRecords()` + `patchRecord()`;
- field projection omits unknown and `_integration_*` fields;
- append mode always creates;
- missing configured key fields become per-record write errors;
- `read()` is rejected as unsupported.

Result: PASS.

Observed output:

```text
✓ plugin-runtime-smoke: all assertions passed
✓ metasheet-multitable-target-adapter: write-only multitable target tests passed
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
✓ migration-sql: 057/058/059 integration migration structure passed
```

### K3 offline PoC regression

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Expected coverage:

- existing K3 Material / BOM mock chain remains PASS;
- this local MetaSheet target adapter does not alter K3 WebAPI behavior.

Result: PASS.

Observed output:

```text
✓ K3 WISE PoC mock chain verified end-to-end (PASS)
```

### Diff hygiene

Command:

```bash
git diff --check origin/main...HEAD
```

Result: PASS (`rc=0`).

### Worktree dependency note

The first plugin test attempt in the isolated worktree failed before product
tests because `node_modules` had not been installed there:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'
```

The worktree was prepared with:

```bash
pnpm install --frozen-lockfile
```

The backend plugin test then passed. This was an isolated worktree dependency
bootstrap issue, not a product regression.

## Manual review checklist

- No migration added.
- No secrets added to docs or fixtures.
- Adapter is target-only.
- Writes go through plugin-scoped `context.api.multitable.records`.
- Internal `_integration_*` fields are not written by default.
- K3 Submit / Audit is untouched.
