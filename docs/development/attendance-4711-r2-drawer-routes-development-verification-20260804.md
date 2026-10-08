# Attendance #4711 R2 Drawer Routes Development Verification

Status: **IMPLEMENTED / HOLD FOR EXACT-HEAD GATE**

- Ratified contract: `attendance-4711-group-context-routes-design-lock-20260801.md`
- Fresh-main base: `4784d8fb8a5b90f4b239031d6d5211543aa60592`
- Original implementation base: `55b76fd8d62a304cb308ae34d251a5bf1af4558e`
- Required predecessor: `c64d952259366449a4f73be4146fcd3a32564f50`
- Scope: R2 drawer and workflow entry points only
- Explicitly excluded: later slices, merge authorization, feature flags, deployment,
  soak, production or customer data, and closing #4556

## 1. Delivered mapping

The R2 entry-point builder accepts only an authorized group UUID, one of the
three public route steps, and that step's closed surface set. The following live
controls now call `router.push(...)` through that builder:

| Existing control | Canonical target |
| --- | --- |
| Summary and work-time drawer: Shifts | `schedule?surface=shifts` |
| Summary and work-time drawer: Assignments | `schedule?surface=assignments` |
| Summary and work-time drawer: Advanced scheduling | `schedule?surface=advanced-scheduling` |
| Fixed-shift workflow stage | `schedule?surface=assignments` |
| Non-fixed workflow stage | `schedule?surface=advanced-scheduling` |
| Rule-policy and work-time drawers: Holidays | `calendar` |
| Summary and rule-policy drawer: Rule Sets | `rules?surface=rule-sets` |

The work-time, rule-policy, and punch-method quick-view actions remain drawers.
The entry action itself issues no write request. The existing user-label resolver
uses a read-only POST endpoint; the browser proof classifies that endpoint as a
read operation and rejects every other non-GET API request.

## 2. Automated evidence

Focused Vitest results on 2026-08-04:

| Spec | Result | Contract |
| --- | ---: | --- |
| `attendanceGroupContextRoute.spec.ts` | 129/129 PASS | closed route builder and parser |
| `attendance-experience-entrypoints.spec.ts` | 14/14 PASS | host event, mobile return target, and router push |
| `attendance-experience-mobile-zh.spec.ts` | 2/2 PASS | ordinary mobile overview fallback stays distinct from group `returnTo` |
| `attendance-group-context-history.spec.ts` | 1/1 PASS | real Vue Router memory-history push/back/forward |
| `attendance-admin-regressions.spec.ts` | 141/141 PASS | all R2 mappings, retained drawers, route authority, zero entry writes |

`pnpm --filter @metasheet/web type-check` also passed. The new real-history spec
is present in both changed-file classifiers and the targeted run list of the
required `Attendance Web Guard`; `attendance-web-guard-workflow.spec.ts` pins
that provenance.

The exact required Attendance Web Guard command passed **47/47 files and
1019/1019 tests** after the second remediation.

## 3. Real browser evidence

Command:

```text
pnpm --filter @metasheet/web exec playwright test verification/attendance-group-context-r2.spec.ts --config playwright.verification.config.ts --project chromium
```

Result: **5/5 PASS**.

| Scenario | Runtime evidence |
| --- | --- |
| Desktop drawer entry | DOM proves authorized group, Schedule breadcrumb, schedule step, and Assignments surface before capture |
| Back / Forward / refresh | Real browser history returns to the group list, moves forward to the same canonical group route, and refresh restores the same surface |
| Narrow touch, 390x844 | URL remains intact; desktop recommendation appears; no group host, drawer overlay, group probe, or scoped group request mounts; Back to Overview uses the normalized safe `returnTo` |
| Wide coarse pointer, 1440x900 | The route is not mobile-blocked and the authorized Assignments surface renders |
| Missing and cross-org group | Both show the same unavailable posture; no request under the scoped group resource starts |

Named captures:

- `assets/attendance-r2-20260804/r2-desktop-assignments-1440x900.png`
- `assets/attendance-r2-20260804/r2-narrow-touch-blocked-390x844.png`
- `assets/attendance-r2-20260804/r2-wide-coarse-ready-1440x900.png`

SHA-256 of the final generated evidence:

| Capture | SHA-256 |
| --- | --- |
| desktop assignments | `18921ea584808cbaa11592a5c3f758ef6958519f9d09f86e241b06750d92f483` |
| narrow touch blocked | `a0eb6bbba37be353169f5192aad56e51c1836b8f6992dcdd23f1dbebef46c36e` |
| wide coarse ready | `d5f51dce00eae2060cf1961a95bbc20904b545f256eb2a74e94348ce7fb222c4` |

Manual inspection found and corrected a missing breadcrumb separator before the
evidence was accepted. The browser assertion now pins the visible authorized
group and localized step as one breadcrumb.

## 4. Independent-review remediation

The first independent review returned 0 P1, 3 P2, and 1 P3. The implementation
was not advanced as merge-ready. The remediation closes those findings as
follows:

1. the mobile-blocked Back to Overview action now uses the parser-normalized
   safe `returnTo` instead of a hard-coded overview route;
2. route-owned group identity takes precedence over mutable list/editor state,
   including the explicit route-A/stale-selection-B regression;
3. the real browser narrow-touch leg clicks Back to Overview, while the missing
   and cross-org legs reject every request beneath the scoped group path;
4. this document records the actual branch base rather than the predecessor
   merge SHA.

Two focused mutations prove the new guards are load-bearing:

- hard-coding mobile return to `/attendance` makes exactly the normalized
  `returnTo` test fail;
- preferring mutable editor group B over route group A makes exactly the A/B
  route-authority test fail.

Both mutations were restored and their focused positive controls passed.

The second independent exact-head review found one additional P2: the mobile
button had been changed globally, so ordinary admin/workflow mobile fallback
incorrectly inherited the group-list return target. The button now reuses the
existing branch-aware return handler: an active group route uses its normalized
`returnTo`, while every non-group mobile route keeps the existing Overview
transition. The two-path Chinese mobile regression and the full required guard
both pass. The same review's screenshot P3 is closed by regenerating all three
captures after the final product change and recording their hashes above.

## 5. Honest remaining gates

This document does not claim merge readiness by itself. Before R2 can be
presented for merge consideration, the exact PR head still requires:

1. fresh required GitHub checks;
2. independent exact-head review with zero open P1/P2;
3. confirmation that the committed screenshots match the reviewed exact head.

Passing those gates still does not authorize merge or any later attendance
slice.
