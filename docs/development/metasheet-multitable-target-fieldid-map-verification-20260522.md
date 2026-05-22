# MetaSheet Multitable Target Field-ID Mapping Verification - 2026-05-22

## Scope

This verifies the BA-M3 follow-up for issue #1710: target writes from the
readonly Bridge Agent into MetaSheet staging tables must translate logical Data
Factory field ids into provisioned multitable field ids before calling the
records API.

## Local Commands

```bash
node plugins/plugin-integration-core/__tests__/metasheet-multitable-target-adapter.test.cjs
pnpm -F plugin-integration-core test
pnpm verify:integration-k3wise:poc
bash -n scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
git diff --check origin/main...HEAD
```

## Results

| Check | Result |
| --- | --- |
| `node plugins/plugin-integration-core/__tests__/metasheet-multitable-target-adapter.test.cjs` | PASS |
| `pnpm -F plugin-integration-core test` | PASS |
| `pnpm verify:integration-k3wise:poc` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `git diff --check origin/main...HEAD` | PASS |
| `BUILD_WEB=1 BUILD_BACKEND=1 PACKAGE_TAG=fieldid-smoke scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-fieldid-smoke.zip` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-fieldid-smoke.tgz` | PASS |

The temporary local package was built only as verification evidence. Build
outputs under `output/releases/` are ignored artifacts and are not part of this
change.

## Regression Case

The focused adapter test covers an installed `plm_raw_items` sheet where the
stored row uses physical field ids:

```json
{
  "fld_sourceSystemId": "bridge_source_1",
  "fld_objectType": "material",
  "fld_sourceId": "1",
  "fld_code": "OLD"
}
```

The adapter receives logical rows:

```json
[
  {
    "sourceSystemId": "bridge_source_1",
    "objectType": "material",
    "sourceId": "1",
    "code": "MAT-001",
    "name": "Bolt"
  },
  {
    "sourceSystemId": "bridge_source_1",
    "objectType": "bom",
    "sourceId": "2",
    "code": "BOM-002",
    "name": "Parent"
  }
]
```

The test asserts that `metasheet-multitable-target-adapter.test.cjs`:

- calls `context.api.multitable.provisioning.resolveFieldIds()` with logical
  field ids;
- queries existing rows with physical key fields;
- patches existing rows with physical `fld_*` keys;
- creates new rows with physical `fld_*` keys;
- keeps logical upsert validation intact.

## Package Verify

`scripts/ops/multitable-onprem-package-verify.sh` now checks the package for:

- `resolveProvisionedFieldIdMap` in the target adapter;
- `mapRecordFieldsForWrite` in the target adapter;
- this design/verification document pair.

That makes the official Windows package fail verification if a stale package
omits the BA-M3 target-field mapping fix.

## Entity-Machine Acceptance

The final acceptance remains the entity-machine BA-M3 smoke, not local unit
tests alone. The expected post-release result is:

```text
bridge-refresh-material-run     PASS
bridge-refresh-bom-run          PASS
bridge-refresh-bom_child-run    PASS
deadLetters.open                0 new METASHEET_MULTITABLE_WRITE_FAILED entries for Unknown fieldId
```

This still does not exercise or unlock real K3 WISE Save/Submit/Audit.
