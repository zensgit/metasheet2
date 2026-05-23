# Attendance comprehensive-hours PR5 strong-control verification - 2026-05-23

## Scope verified

Runtime PR5 implementation against the design lock in
`docs/development/attendance-comprehensive-hours-pr5-strong-control-design-20260523.md`.

This slice adds a deliberately-opt-in strong-control toggle that blocks
shift/rotation assignment save when the read-only comprehensive-hours preview
returns `aggregate.status === 'violation'`. PR4 weak-control behavior is the
default and is preserved byte-for-byte when the toggle is off.

## Files changed

| File | Delta |
| --- | --- |
| `apps/web/src/views/AttendanceView.vue` | +49 lines, -5 lines: add `comprehensiveHoursSaveBlockMode` ref, extend advisory `kind` discriminator with `'block'`, plumb mode + violation gate through `previewComprehensiveHoursAssignmentAdvisory`, add early-return in `saveAssignment` + `saveRotationAssignment`, add admin checkbox UI + hint update on preview-form enforcement field, add `--block` CSS modifier class and `data-attendance-comprehensive-hours-assignment-advisory-kind` data attribute |
| `apps/web/tests/attendance-admin-regressions.spec.ts` | +6 PR5 tests covering all 9 design-required assertions plus the rotation surface |
| `docs/development/attendance-comprehensive-hours-pr5-strong-control-design-20260523.md` | +new design lock MD |
| `docs/development/attendance-comprehensive-hours-pr5-strong-control-verification-20260523.md` | +this verification MD |

No new files outside the above four. No `plugins/`, `packages/`, `migrations/`,
`scripts/`, or `.github/workflows/` touches.

## Contract coverage

| Contract from design MD | Test(s) | Result |
| --- | --- | --- |
| Default off → PR4 weak behavior preserved | 3 PR4 tests `runs a weak comprehensive-hours advisory ...` (shift + rotation) + `keeps shift assignment save available when the weak ... preview fails` | PASS — 3/3 green |
| Strong mode + `violation` blocks save (shift) | `PR5 strong-control blocks shift assignment save when preview returns violation` | PASS |
| Strong mode + `violation` blocks save (rotation) | `PR5 strong-control blocks rotation assignment save when preview returns violation` | PASS |
| Strong mode + `warning` allows save | `PR5 strong-control allows shift assignment save when preview returns warning` | PASS |
| Strong mode + `ok` allows save | `PR5 strong-control allows shift assignment save when preview returns ok` | PASS |
| Strong mode + preview 503 allows save | `PR5 strong-control allows shift assignment save when preview fails with 503` | PASS |
| Inactive assignment skips preview entirely | `PR5 inactive shift assignment skips the preview call in both modes` | PASS |
| Strong mode + `degraded: true` still allows save even on `violation` status (locks `!result?.degraded` guard) | `PR5 strong-control does NOT block shift assignment save when preview is degraded even if status is violation` | PASS |
| Payload contract: `metric: planned`, single `userId`, `custom_range`, no `allUsers`, `enforcement` mirrors mode (`warn`/`block`) | Asserted in all 6 PR5 tests (positive enforcement assertion in shift+rotation block tests; preserved in PR4 weak tests for `warn` mode) | PASS |
| Block-state advisory copy banned-language scan | In the shift-violation block test: `advisoryText` must NOT contain `cannot save`, `policy enforced`, `violation prevented`, `禁止保存`, `已强制策略`, `已阻止违规` | PASS |
| Preview reuses existing `/api/attendance/comprehensive-hours/preview` route | URL match in every test mock | PASS |

## Bundle fingerprint (against built `dist/assets/index-CA82mKPV.js`)

| Fingerprint (PR5 new) | Count |
| --- | ---: |
| `Save-time strong control` | 1 |
| `保存时强管控` | 1 |
| `strong-control: save blocked` | 1 |
| `综合工时强管控` | 1 |
| `attendance-comprehensive-hours-save-block-mode` (id + data attr) | 2 |

PR4 fingerprints preserved in the same built bundle:

| Fingerprint (PR4 must remain) | Count |
| --- | ---: |
| `data-attendance-comprehensive-hours-assignment-advisory` | 2 |
| `Saving is still allowed in this stage` | 1 |
| `当前阶段仍允许保存` | 1 |
| `Comprehensive-hours advisory` | 1 |
| `comprehensive-hours/preview` | 1 |

PR5 banned-language scan in the built bundle:

| Pattern | Count |
| --- | ---: |
| `cannot save` | 0 |
| `policy enforced` | 0 |
| `violation prevented` | 0 |
| `禁止保存` | 0 |
| `已强制策略` | 0 |
| `已阻止违规` | 0 |

The block-state advisory uses the word `blocked` as the legitimate state
descriptor; that is the only block/strong-control terminology allowed by the
design MD.

## Test commands and results

| Command | Result |
| --- | --- |
| `pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts tests/attendance-admin-anchor-nav.spec.ts --watch=false` | **48/48 PASS** (25 admin-regressions + 23 anchor-nav), 5.91 s |
| `pnpm --filter @metasheet/web type-check` | PASS |
| `pnpm --filter @metasheet/web build` | PASS, 6.63 s |
| `node --check plugins/plugin-attendance/index.cjs` | PASS |
| `git diff --check` | PASS |

## Boundary reaffirmation

| Constraint | Check |
| --- | --- |
| No new backend route | Diff confines to `apps/web/` and `docs/development/`. `grep "addRoute(" plugins/ packages/` Δ = 0. |
| No `attendance_*` migration | No `migrations/` change. |
| No `meta_*` write | No `multitable*` / `meta_*` code reference added. |
| No policy persistence | Strong-mode toggle is a Vue ref. No `localStorage`, no settings/catalog row, no API write. Page reload resets the toggle. |
| No preview compute change | Backend `comprehensive-hours/preview` route unchanged. The frontend reuses the existing payload contract; `enforcement: 'block'` was already accepted by the route per #1776. |
| No `allUsers` | Test asserts `not.toHaveProperty('allUsers')` in both shift and rotation PR5 tests. |
| PR4 weak behavior preserved | 3 PR4 tests still pass; default `comprehensiveHoursSaveBlockMode = false` keeps `enforcement: 'warn'` and the unconditional save path. |
| Inactive assignment skip preserved | `PR5 inactive ... skips the preview call in both modes` test asserts `previewCalled === false`. |
| Codex review only model | PR will be opened OPEN without auto-merge per user direction. |

## Secret / home-path scan

```
$ grep -rE "eyJ[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_.-]{20,}|/Users/[a-z]|/home/[a-z]" \
    apps/web/src/views/AttendanceView.vue \
    apps/web/tests/attendance-admin-regressions.spec.ts \
    docs/development/attendance-comprehensive-hours-pr5-*.md
(no matches)
```

No JWT, no `Bearer` token, no user home path in any PR5 file.

## Items intentionally NOT done

- No production smoke for PR5. The bundle fingerprint is in the local build
  only; deploy and rerun a smoke against `:8081` after this PR is merged and
  the build/push pipeline lands the image.
- No staging E2E for PR5 — same reason as above. Per `[[staging-8082-jwt-and-deploy-lane]]`
  memory, staging requires a separate deploy lane trigger and its own JWT.
- No backend integration test for `enforcement: 'block'` on the preview route
  (the existing #1776 tests already lock `INVALID_*` rejection for invalid
  enums; `'block'` is a valid enum already accepted by the route).
- No persistence of the strong-mode toggle. Intentional per design MD §
  Hard Boundaries "No policy persistence".
- No telemetry / audit trail when a save is blocked. Deferred to PR6 reporting.
- No bulk / multi-user save flow change. There is no such flow today.

## Production runtime check after merge (recommended SOP)

After admin-merge + `Build and Push Docker Images` on the merge SHA, run the
following anonymous bundle fingerprint check against production:

```
curl -s http://<prod-host>:8081/attendance \
  | grep -oE '/assets/index-[^"]+\.js' \
  | xargs -I{} curl -s "http://<prod-host>:8081{}" \
  | grep -E "Save-time strong control|保存时强管控|strong-control: save blocked|attendance-comprehensive-hours-save-block-mode"
```

Expect 5 matches (one per fingerprint above) before declaring PR5 live.

## References

- Design MD: `docs/development/attendance-comprehensive-hours-pr5-strong-control-design-20260523.md`
- PR4 runtime: #1790
- PR4 design lock: #1778 (defines PR5 as the deferred strong-control slice)
- Preview route hardening: #1776 (already accepts `enforcement: 'block'`)
- Admin preview UI: #1777 (defines the section that hosts the new toggle)
- PR4 staging E2E PASS: #1795
- Memory: `[[k3-poc-stage1-lock-no-new-fronts]]` (this PR sits in the
  authorized 内核打磨 lane).
- Memory: `[[staged-optin-lineage]]` (user opt-in at 2026-05-23 unlocks PR5).
- Memory: `[[skip-when-unreachable]]` (no early-return-on-unmocked, all tests
  assert real ordered behavior).
- Memory: `[[staging-8082-jwt-and-deploy-lane]]` (explains why staging E2E is
  deferred until staging deploy + staging JWT are both ready).
