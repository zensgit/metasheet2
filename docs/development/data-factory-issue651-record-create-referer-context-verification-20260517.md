# Data Factory Issue #651 Record Create Context Verification

Date: 2026-05-17

## Scope

Verification covers the follow-up fix for the Windows on-prem C1 retest finding:

```text
400 VALIDATION_ERROR
sheetId or viewId is required
```

The goal is to ensure `+ New Record` can recover `sheetId` / `viewId` from deployed multitable
routes before field-level required validation runs.

## Local Verification

### Frontend grid regression

Command:

```bash
pnpm --filter @metasheet/web exec vitest run tests/multitable-grid.spec.ts --watch=false
```

Result:

```text
45/45 pass
```

Coverage added:

- authenticated `/multitable/:sheetId/:viewId` route fallback remains covered
- hash-backed multitable route fallback
- `sheetId` / `viewId` query fallback
- public-form route exclusion remains covered
- create request sends recovered `sheetId` / `viewId`

### Backend context helper

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/multitable-record-create-context.test.ts --reporter=dot
```

Result:

```text
4/4 pass
```

Coverage added:

- Referer-style authenticated multitable URL extracts `sheetId` / `viewId`
- hash-backed multitable URL extracts `sheetId` / `viewId`
- query fallback extracts `sheetId` / `viewId`
- public-form URL is ignored

### Typecheck and build gates

Commands:

```bash
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
git diff --check origin/main...HEAD
```

Results:

```text
vue-tsc: pass
core-backend build: pass
web build: pass
diff-check: pass
```

## Security Checks

- Public-form context is not reused for authenticated record creation.
- Referer-derived context still goes through existing sheet resolution and capability checks.
- No token, password, SQL connection string, or K3 secret is logged or added to docs.

## Expected Physical-Box Retest

After merge and official Windows package rebuild:

1. Deploy the new package.
2. Open Data Factory.
3. Use the Standard Materials staging card generated multitable link.
4. Click `+ New Record`.

Expected result:

- No `sheetId or viewId is required`.
- No generic `500 Failed to create meta record`.
- Empty Standard Materials create reaches field-level validation and can show required-field toast.
