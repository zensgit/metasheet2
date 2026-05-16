# Data Factory Issue 651 C1 Record Create Repair - Verification

Date: 2026-05-16

## Local Verification

### Migration Structure

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/onprem-multitable-record-create-repair-migration.test.ts --watch=false
```

Result:

```text
2/2 tests passed
```

Coverage:

- repair migration adds `created_by` and `modified_by` idempotently;
- repair migration creates `meta_record_revisions` idempotently;
- repair migration targets `plugin_multitable_object_registry`;
- repair migration backfills required validation for `standard_materials` and `bom_cleanse` required fields.

### Record Create Error Mapping

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/field-validation-flow.test.ts --watch=false
```

Result:

```text
15/15 tests passed
```

Coverage:

- direct record create with missing required field returns:

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Record validation failed",
    "fieldErrors": {
      "fld_code": "Material Code is required"
    }
  }
}
```

- direct record create with missing `meta_record_revisions` returns:

```json
{
  "ok": false,
  "error": {
    "code": "DB_NOT_READY",
    "message": "Database schema not ready ..."
  }
}
```

### Backend Build

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

```text
exit 0
```

### Package Verifier Syntax

Command:

```bash
bash -n scripts/ops/multitable-onprem-package-verify.sh
```

Result:

```text
exit 0
```

Coverage:

- package verification requires the built repair migration at
  `packages/core-backend/dist/src/db/migrations/zzzz20260516113000_repair_onprem_multitable_record_create.js`;
- package verification checks the migration body for `meta_record_revisions`
  and `plugin_multitable_object_registry` so a stale package fails before
  on-prem deployment.

### Local On-Prem Package Smoke

Command:

```bash
PACKAGE_TAG=issue651-c1-repair-local BUILD_WEB=1 BUILD_BACKEND=0 INSTALL_DEPS=0 \
  scripts/ops/multitable-onprem-package-build.sh
```

Result:

```text
exit 0
```

Then:

```bash
scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-issue651-c1-repair-local.zip

scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-issue651-c1-repair-local.tgz
```

Result:

```text
Package verify OK
Package verify OK
```

The local package smoke proves the new package verifier requirement resolves
against the built backend migration output and passes for both Windows zip and
Linux tgz artifacts.

### Diff Check

Command:

```bash
git diff --check
```

Result:

```text
exit 0
```

## Physical Box Retest Plan

After this PR is merged and a new Windows on-prem package is built:

1. Deploy the new package.
2. Confirm deploy migrations complete.
3. Open `/integrations/workbench`.
4. Click staging card `生成打开链接` if needed.
5. Open `Standard Materials` via `打开多维表（新建记录入口）`.
6. Click `+ New Record`.

Expected C1 result:

- no generic `500 INTERNAL_ERROR / Failed to create meta record`;
- either field-level required toast such as `Material Code is required`, or if the DB has a deeper schema gap, a `DB_NOT_READY` response that identifies migration readiness instead of masking the failure.

## Gate Status

- Gate A/B: unchanged, expected to remain PASS.
- C2/C4: unchanged, expected to remain PASS.
- C3: unchanged in this PR; run29 already showed effective scope text.
- C1: primary target of this PR.
