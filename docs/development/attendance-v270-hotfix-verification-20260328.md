# Attendance v2.7.0 Hotfix Verification

## What I verified

### Frontend

- `pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-anchor-nav.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false`
  - result: passed
  - verified:
    - admin section focus toggling
    - group-members user picker regression
    - holiday calendar guidance
    - structured rule builder
    - import template guidance

- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - result: passed

- `pnpm --filter @metasheet/web build`
  - result: passed

### Backend

- `pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "supports shift and overtime rule lookup by id and rejects malformed ids with 400" --reporter=dot`
  - result: passed
  - verified:
    - `GET /api/attendance/rotation-rules/:id` returns `200`
    - malformed ids still return `400`
    - missing rotation rules return `404`

- `pnpm --filter @metasheet/core-backend exec tsc --noEmit`
  - result: passed

### Repo hygiene

- `git diff --check`
  - result: passed

## Notes

I also did one exploratory full-file integration run while narrowing the backend verification target. That broader file still surfaced an unrelated attendance request approval failure outside this hotfix scope. The route-level hotfix itself was then re-verified with the focused lookup test above so the PR stays scoped to:

- admin regression recovery
- rotation-rule lookup availability
- matching OpenAPI contract

## Validation intent

The verification focus for this hotfix is:

- the admin page regressions are restored in the UI
- the new rotation-rule lookup contract is present and documented
- the repository still builds cleanly after the change
