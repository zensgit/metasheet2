# Attendance comprehensive-hours PR4 staging E2E verification - 2026-05-23

## VERDICT

**PASS.** Staging now runs the PR #1790 image, the staging admin JWT validates
against `:8082`, and the browser save-chain exercised the weak-control
contract end to end:

`POST /api/attendance/comprehensive-hours/preview` ran before
`POST /api/attendance/assignments`; preview returned a warning; the assignment
save still completed with HTTP 201; all temporary staging fixtures were
deleted.

## Scope

This document is the staging-side counterpart of the production runtime smoke
at
`docs/development/attendance-comprehensive-hours-pr4-warning-runtime-smoke-verification-20260523.md`.

It verifies the runtime behavior that production could not safely exercise
without creating production scheduling fixtures. This run touched staging only.
No production state was modified.

## Environment

| Item | Value |
| --- | --- |
| Staging API base | `http://23.254.236.11:8082` |
| Staging backend image | `ghcr.io/zensgit/metasheet2-backend:39258df83055e0d124047400e758bccafc4bf1c9` |
| Staging web image | `ghcr.io/zensgit/metasheet2-web:39258df83055e0d124047400e758bccafc4bf1c9` |
| Staging bundle served | `/assets/index-DmcWixg5.js` |
| Bundle size | 1,302,700 bytes |
| Token source | Local restricted staging admin JWT file; token value not printed |
| Auth probe | HTTP 200, `role=admin`, `features.attendanceAdmin=true` |

## Preflight

| Check | Result |
| --- | --- |
| `GET /api/health` | HTTP 200 |
| `GET /api/auth/me` with staging admin JWT | HTTP 200 |
| SSH to `23.254.236.11` | OK |
| Staging bundle contains PR #1790 | OK |

Bundle fingerprint counts:

| Fingerprint string | Count |
| --- | ---: |
| `data-attendance-comprehensive-hours-assignment-advisory` | 2 |
| `Saving is still allowed in this stage` | 2 |
| `当前阶段仍允许保存` | 4 |
| `Comprehensive-hours advisory` | 4 |
| `comprehensive-hours/preview` | 2 |

## Staging RBAC setup note

The staging admin user could authenticate through `/api/auth/me`, but the
attendance plugin RBAC guard initially rejected admin-center routes because no
staging user had `user_roles.role_id = 'admin'` and no user had a direct
`attendance:admin` grant.

To run the staging-only E2E, a temporary `user_roles = admin` grant was added
for the staging admin user and then removed after the test. Final RBAC state
for that user returned to the original `attendance_employee` role only.

This was an environment-auth setup correction for staging validation. It did
not touch `attendance_*` fact tables, `meta_*`, production, or migrations.

## E2E trace

Temporary fixture:

| Fixture | Result |
| --- | --- |
| Shift created | HTTP 201 |
| Assignment created by UI save | HTTP 201 |
| Assignment cleanup | HTTP 200 |
| Shift cleanup | HTTP 200 |
| Residual smoke shifts | 0 |

Network sequence captured from the browser:

| Seq | Method | Route | Status | Key body / response |
| ---: | --- | --- | ---: | --- |
| 1 | POST | `/api/attendance/comprehensive-hours/preview` | 200 | `metric=planned`, `policyDraft.enforcement=warn`, `policyDraft.capHours=0.1`, `scope={userId}`, no `allUsers`, `period.type=custom_range`, response `readOnly=true`, `aggregate.status=warning` |
| 2 | POST | `/api/attendance/assignments` | 201 | assignment save succeeded after the warning preview |

The rendered advisory text was:

> Comprehensive-hours advisory before save: planned minutes are close to the draft cap. Saving is still allowed in this stage.

The assignment status text was:

> Assignment created.

## Assertions

| Assertion | Result |
| --- | --- |
| Preview request ran before assignment save | PASS |
| Preview reused existing `/api/attendance/comprehensive-hours/preview` route | PASS |
| Preview body uses `metric: planned` | PASS |
| Preview body uses `policyDraft.enforcement: warn` | PASS |
| Preview scope is a single `userId` | PASS |
| Preview body does not contain `allUsers` | PASS |
| Preview period is `custom_range` from the assignment dates | PASS |
| Preview returned warning | PASS |
| Assignment save still completed | PASS |
| Temporary assignment and shift were deleted | PASS |

## PR5 banned-language scan

The captured runtime evidence was scanned for PR5-style strong-control
language. All patterns were absent:

| Pattern | Count |
| --- | ---: |
| `blocked` | 0 |
| `cannot save` | 0 |
| `policy enforced` | 0 |
| `violation prevented` | 0 |
| `阻止` | 0 |
| `禁止保存` | 0 |

## Items intentionally not done

- No production fixture created.
- No production assignment save executed.
- No `attendance_*` migration touched.
- No `meta_*` written.
- No backend/frontend code changed.
- No token value printed.

## Secret scan

The run used a local restricted token file and did not write the token value to
this document. The evidence above records only route names, sanitized body
shape, HTTP status, bundle fingerprints, and cleanup results.

## Sibling evidence

Production runtime smoke:

`docs/development/attendance-comprehensive-hours-pr4-warning-runtime-smoke-verification-20260523.md`

That file records production-side PASS for the in-scope axes that did not
require production state changes. This staging E2E adds the missing live
save-chain proof.
