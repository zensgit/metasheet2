# Attendance Import CSV Template Verification

Date: 2026-03-23

## Status

- Implemented and locally verified on `2026-03-23`.
- Backend route, frontend fallback integration, OpenAPI source files, and generated artifacts were validated in the same branch.
- One pre-existing local integration failure remains in the unrelated long-path attendance approval flow; the CSV template endpoint itself was verified with a dedicated targeted integration case.

## What Must Be Verified

- The new endpoint returns a downloadable CSV file.
- The CSV header matches the same import template profile metadata used by the JSON guide.
- An optional `profileId` parameter selects the intended profile.
- Invalid `profileId` input returns a validation error.
- The existing JSON template endpoint remains backward compatible and still returns structured guide data.
- OpenAPI generation and contract checks remain clean after the addition.

## Executed Validation Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportWorkflow.spec.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "serves attendance import templates as JSON and CSV"
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web build
pnpm exec tsx packages/openapi/tools/build.ts
./scripts/ops/attendance-run-gate-contract-case.sh openapi
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/useAttendanceAdminImportWorkflow.spec.ts --watch=false`
  - `1 file / 14 tests passed`
- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "serves attendance import templates as JSON and CSV"`
  - `1 file / 1 test passed / 46 skipped`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - passed
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`
  - passed
- `pnpm --filter @metasheet/web build`
  - passed
- `pnpm exec tsx packages/openapi/tools/build.ts`
  - passed
- `./scripts/ops/attendance-run-gate-contract-case.sh openapi`
  - passed

Additional note:

- Running the entire `tests/integration/attendance-plugin.test.ts` file in this local environment still exposes an unrelated existing failure in `registers attendance routes and lists plugin`, where leave approval returns `403` instead of `200`. That failure is outside the CSV template endpoint scope, so the feature-specific verification was pinned to the dedicated import-template test added in this change.

## Endpoint Checks

### `GET /api/attendance/import/template`

- Returns `200` with the existing JSON guide payload.
- Still exposes `mapping`, `mappingProfiles`, and `payloadExample`.
- Now includes profile-shaped `payloadExample.columns` and `payloadExample.requiredFields` for more useful downstream template generation.

### `GET /api/attendance/import/template.csv`

- Returns `200` with `Content-Type: text/csv`.
- Returns a CSV header row and a profile-specific sample row.
- Uses the expected import profile when `profileId` is omitted.
- Uses the requested profile when `profileId` is valid.
- Returns `400` for an unknown `profileId`.

### Auth Semantics

- `401` for unauthenticated access.
- `403` for authenticated callers without `attendance:admin`.

## Expected Local Gates

- Backend integration test covering the CSV endpoint passes.
- TypeScript compile for backend and frontend passes.
- Web build passes with the frontend switched to server-first CSV download plus local fallback.
- OpenAPI build and drift checks pass.

## Expected CI Gates

- OpenAPI contract checks pass with the new CSV path documented.
- Backend integration suites remain green.
- Frontend tests remain green if the UI path changes.
- No new deploy-blocking regressions are introduced.

## Acceptance Checklist

- CSV download is reachable at the documented route.
- CSV output is deterministic for the selected profile.
- Invalid profile input fails with a clear validation response.
- JSON template behavior is preserved.
- Generated OpenAPI artifacts, if tracked, match the source contract.

## Notes

- The verification scope is intentionally narrower than the full attendance import pipeline.
- The goal is to validate the template download contract without reopening import engine behavior.
- Generated OpenAPI dist artifacts must be staged/committed together with the source spec changes, or the contract gate will report dist drift even when the source YAML is correct.
