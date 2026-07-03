# Attendance MP-5 — makeup-punch request-side UX design-lock (PROPOSED)

**Status:** PROPOSED · **Date:** 2026-07-03 · **Slice:** MP-5 (Request Center UX for `makeupPunchPolicy` rejections)

This document proposes the request-side UX slice that follows the ratified makeup-punch policy runtime and the MP-4 admin config card. It writes **no runtime code**. Runtime starts only after owner ratification and remains a separate PR.

---

## §1 Scope

**In scope (MP-5):** make the employee Request Center explain `MAKEUP_PUNCH_*` policy rejections in a human-actionable way, expose the already-supported `attachmentUrl` field for the three makeup request types, and prove anomaly / missed-punch-reminder prefilled drafts still submit through the same `POST /api/attendance/requests` path.

**Explicitly OUT:**

- No backend enforcement change. `enforceMakeupPunchPolicy` remains the server authority for quota/window/type/reason/attachment.
- No admin policy-card changes. MP-4 already shipped the config surface; this slice reads no settings directly.
- No org-configurable `allowedRequestTypes`. MP-4 deliberately rendered it read-only because enforcement uses the frozen `MAKEUP_PUNCH_ALLOWED_REQUEST_TYPES` constant. Wiring that stored field into enforcement is the separate backend slice recorded in the MP-4 lock §7.
- No HMR/reminder producer change. Existing manual missed-punch reminder code only queues notifications; it does not create requests or consume quota.
- No MP-6 staging smoke. MP-6 remains a separate operator-run proof for quota/window/type/anomaly-prefill/approval-adjusted-record/residue=0.
- Not part of the AE staging-closure window. The AE/RD/OT-bank staging bundle remains closed; MP-5 feeds none of its PASS stamps.

---

## §2 Current grounding on `origin/main`

Backend policy authority lives in `plugins/plugin-attendance/index.cjs`:

| Symbol / route | Current role |
|---|---|
| `MAKEUP_PUNCH_ALLOWED_REQUEST_TYPES` | Frozen request-type set: `missed_check_in`, `missed_check_out`, `time_correction`. |
| `enforceMakeupPunchPolicy` | Throws the server `MAKEUP_PUNCH_*` errors; runs inside the request-write transaction after the duplicate guard. |
| `buildMakeupPunchPolicySnapshot` | Writes the accepted policy evidence onto request metadata. |
| `POST /api/attendance/requests` | Self-service create path; token user is the subject; all anomaly/reminder-prefilled drafts must still use this route. |
| `PUT /api/attendance/requests/:id` | Pending-request update path; MP-v1 already fail-closes cross-user edits when policy applies. |
| `/api/attendance/manual-missed-punch-reminders/*` | Admin missed-punch reminder producer. It enqueues notification deliveries; it must not create requests or bypass policy. |

Frontend request UX lives in `apps/web/src/views/AttendanceView.vue`:

| Symbol / surface | Current role |
|---|---|
| `submitRequest` | Single Request Center submit handler. It builds the request body and calls `POST /api/attendance/requests`. |
| `createApiError` | Preserves `payload.error.code` on thrown errors. |
| `classifyStatusError` / `setStatusFromErrorWithContext` | Status-banner error mapper; currently has no `MAKEUP_PUNCH_*` special cases. |
| `prefillRequestFromAnomaly` | Existing anomaly quick action; only mutates the form and scrolls to the Request Center. |
| `openMissingPunchQuickAction` | Existing self-service missing-punch quick action; uses an anomaly if present, otherwise opens a blank missed-check-in draft. |
| `#attendance-request-attachment` | Existing attachment URL field, but currently rendered only for leave requests. The submit payload already sends `attachmentUrl` for all request types, so MP-5 only needs to expose the field for makeup types. |
| manual missed-punch reminder admin UI | Existing producer for notifications; any employee landing from such a reminder must still submit through the Request Center path above. |

The first runtime cut should therefore be frontend-only unless the implementation discovers that a needed server detail is absent. The server already emits machine codes; the gap is presentation and regression coverage.

---

## §3 Error-code UX contract

MP-5 adds a request-context mapper for the server codes below. The first runtime cut wires the mapper into `context === 'request-submit'` because that is the currently exposed Request Center create path. `MAKEUP_PUNCH_CROSS_USER_FORBIDDEN` is still listed because the backend emits it from the pending-request update path; a future request-update UI must use the same mapper instead of inventing a second wording. Other contexts keep current generic handling.

| Server code | User-facing message | Hint / action |
|---|---|---|
| `MAKEUP_PUNCH_QUOTA_EXCEEDED` | Makeup-punch quota for this cycle has been used. | Refresh recent requests and review pending/approved makeup requests before retrying. Action: `reload-requests`. |
| `MAKEUP_PUNCH_WINDOW_EXPIRED` | This work date is outside the allowed makeup-punch window. | Choose an allowed work date or ask an attendance admin to adjust the policy. Action: none beyond request-list reload. |
| `MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED` | Future work dates cannot be submitted for makeup punch. | Choose today or an earlier work date. |
| `MAKEUP_PUNCH_TYPE_NOT_ALLOWED` | The selected date/type is not eligible under the current makeup-punch policy. | Use the anomaly quick action if available, or choose a different request type/date; do not imply that an anomaly definitely does not exist. |
| `MAKEUP_PUNCH_REASON_REQUIRED` | A reason is required by the makeup-punch policy. | Fill the reason field and retry. Action: `retry-submit-request`. |
| `MAKEUP_PUNCH_ATTACHMENT_REQUIRED` | An attachment is required by the makeup-punch policy. | Add an attachment URL in the Request Center and retry. Action: `retry-submit-request`. |
| `MAKEUP_PUNCH_CROSS_USER_FORBIDDEN` | This makeup-punch request cannot be edited for another user in v1. | Ask the employee to submit their own request; admin/delegated submission is out of v1. Runtime does not need to fabricate a PUT UI just to surface this code. |

The status banner already displays the normalized code line when `meta.code` is present. MP-5 must preserve that. It should not hide the code behind prose, because support/admins need the exact server reason.

---

## §4 Request-side hinting

MP-5 may add lightweight, non-authoritative hints beside the request form. These hints must never be presented as a client-side policy decision:

- A static policy-aware hint for the three makeup request types: quota/window/type checks are enforced on submit by the server.
- A reason/attachment reminder only after a server rejection, not a pre-submit hard block. The backend remains the source of truth.
- The `attachmentUrl` input must be visible for the three makeup request types (`missed_check_in`, `missed_check_out`, `time_correction`) as well as leave. It stays optional until the server rejects with `MAKEUP_PUNCH_ATTACHMENT_REQUIRED`; MP-5 must not fetch admin settings to decide whether it is required.
- For `MAKEUP_PUNCH_QUOTA_EXCEEDED`, the request list should be reloaded or offer the existing status action to reload it; do not try to recompute quota in the browser.
- Do not fetch `/api/attendance/settings` from the employee view just to show policy internals. MP-5 should not expose admin settings to employees or create a new read surface.

If runtime chooses to add an inline alert near the form, it must be driven by the last request-submit error only and cleared on a new successful prefill/submit. It must not stale-display a prior date's rejection after the user changes the draft.

---

## §5 Prefill path invariant

The prefill invariant is the load-bearing MP-5 contract:

1. `prefillRequestFromAnomaly` may set `workDate` and `requestType`, then scroll to the Request Center.
2. `openMissingPunchQuickAction` may call the anomaly prefill or open a blank missed-check-in draft.
3. A manual missed-punch reminder may guide the employee to the Request Center, but it may not create a request, consume quota, or assert anomaly truth.
4. All paths must converge on `submitRequest` → `POST /api/attendance/requests`.
5. If the server rejects with `MAKEUP_PUNCH_*`, the UI must show the failure and must not display `Request submitted.` or append a fake request row.

This protects the MP-2/MP-3 server policy from being bypassed by convenience entry points.

---

## §6 Runtime acceptance gates

The runtime PR must satisfy all gates below before it can claim MP-5:

1. **Error mapper gate:** every code in §3 has a focused test asserting message, code visibility, and action/hint where specified. For `MAKEUP_PUNCH_CROSS_USER_FORBIDDEN`, use a pure mapper/helper test or a real request-update UI if one exists; do **not** fake a POST-only path just to cover a PUT-only backend code.
2. **No-success-on-reject gate:** a prefilled anomaly draft that receives `MAKEUP_PUNCH_QUOTA_EXCEEDED` from `POST /api/attendance/requests` must show the policy failure and must not show `Request submitted.`.
3. **Shared-path gate:** anomaly quick action and missing-punch quick action both produce a draft that still sends exactly one `POST /api/attendance/requests` when submitted. No alternate route, no request creation during prefill.
4. **Stale-error gate:** changing or refilling the draft after a policy rejection clears any inline MP-5 error state, so a previous date's policy failure cannot visually stick to a new draft.
5. **No settings leak gate:** employee-mode MP-5 tests must assert no new `GET /api/attendance/settings` request is made solely for the request-side hints.
6. **Attachment retry gate:** a `MAKEUP_PUNCH_ATTACHMENT_REQUIRED` rejection must lead to a visible makeup attachment URL input, and a retry after filling it must send `attachmentUrl` in the `POST /api/attendance/requests` body.
7. **Guard inclusion gate:** `apps/web/tests/attendance-selfservice-dashboard.spec.ts` is the preferred target, but it is **not** in `attendance-web-guard` on current `origin/main`. The runtime PR must add it to the workflow pull_request/push path filters and the `vitest run` list in `.github/workflows/attendance-web-guard.yml`, or use another already-guarded spec with equivalent coverage. Without that workflow change, the runtime is skip-shaped-green.

The runtime PR is frontend-only unless one of these gates proves a server code/detail is missing.

---

## §7 Verification plan

Minimum tests for the runtime PR:

- `MAKEUP_PUNCH_QUOTA_EXCEEDED`: response from `POST /api/attendance/requests` after anomaly prefill; assert no success status and no request-row append.
- `MAKEUP_PUNCH_WINDOW_EXPIRED`: direct form submit; assert localized message + code.
- `MAKEUP_PUNCH_FUTURE_DATE_UNSUPPORTED`: direct form submit; assert localized message + code.
- `MAKEUP_PUNCH_TYPE_NOT_ALLOWED`: anomaly prefill with selected type rejected; assert hint points to current policy eligibility / date/type choice, not admin-only settings and not "no anomaly exists".
- `MAKEUP_PUNCH_REASON_REQUIRED`: empty reason rejected; assert retry action remains submit-focused.
- `MAKEUP_PUNCH_ATTACHMENT_REQUIRED`: missing attachment rejected; assert retry action remains submit-focused; fill the makeup-visible attachment field and assert the retry body carries `attachmentUrl`.
- `MAKEUP_PUNCH_CROSS_USER_FORBIDDEN`: mapper/helper coverage only unless a real request-update UI exists; no fake POST coverage.
- Missing-punch quick action: with and without an anomaly in the list, submit still posts to `/api/attendance/requests`.
- No employee settings fetch: mounting overview + using MP-5 flow does not call `/api/attendance/settings`.
- Workflow coverage: prove the runtime PR added its spec to `attendance-web-guard` path filters and run-list, or that it used an already-guarded spec.

Run target:

```bash
pnpm --filter @metasheet/web exec vitest run tests/attendance-selfservice-dashboard.spec.ts --watch=false
pnpm --filter @metasheet/web type-check
```

CI gate: `attendance-web-guard` plus required PR checks. If `attendance-selfservice-dashboard.spec.ts` remains the target, the runtime PR must update `attendance-web-guard` first so the same spec executes in CI.

---

## §8 Deferrals

- **MP-5 runtime** — separate owner-approved PR after this lock is ratified.
- **MP-6 staging smoke** — separate operator-run proof after MP-5 runtime lands.
- **Org-configurable `allowedRequestTypes`** — separate backend slice; not required for MP-5.
- **Admin/delegated makeup submission** — still OUT for v1 because the current table cannot audit the true submitter.
- **Workday/flexible-window semantics** — MP-v2; MP-v1 remains calendar-day based.
