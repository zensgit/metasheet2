# Data Factory staging metadata supports - verification - 2026-05-14

## Scope

This verification covers the adapter discovery metadata hygiene for
`metasheet:staging`.

Validated behavior:

- `metasheet:staging` advertises read-only supports;
- `metasheet:staging` still carries `guardrails.write.supported: false`;
- `metasheet:multitable` target metadata is not changed.

## Commands

### HTTP route metadata test

Command:

```bash
pnpm -F plugin-integration-core test:http-routes
```

Expected:

- adapter discovery route still passes;
- staging metadata includes `supports:
  ['testConnection','listObjects','getSchema','read']`;
- staging metadata includes `guardrails.write.supported: false`;
- multitable target metadata still includes `upsert`.

Result: PASS.

Observed output:

```text
http-routes: REST auth/list/upsert/run/dry-run/staging/replay tests passed
```

### Staging adapter runtime regression

Command:

```bash
pnpm -F plugin-integration-core test:metasheet-staging-source
```

Expected:

- staging adapter remains read-only;
- write attempts continue to be rejected by the adapter contract.

Result: PASS.

Observed output:

```text
✓ metasheet-staging-source-adapter: read-only multitable source tests passed
```

### Multitable target adapter regression

Command:

```bash
pnpm -F plugin-integration-core test:metasheet-multitable-target
```

Expected:

- multitable target remains write-only;
- append/upsert behavior is unchanged.

Result: PASS.

Observed output:

```text
✓ metasheet-multitable-target-adapter: write-only multitable target tests passed
```

### Diff hygiene

Command:

```bash
git diff --check
```

Expected: PASS.

Result: PASS (`rc=0`).
