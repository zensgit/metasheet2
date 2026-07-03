# Attendance MP-4 — makeup-punch admin config card design-lock (RATIFIED)

**Status:** RATIFIED (owner review, 2026-07-02) · **Date:** 2026-07-02 · **Slice:** MP-4 (admin config UI for `makeupPunchPolicy`)

This design-lock writes **no runtime code**. It locks the shape of the makeup-punch admin config card so the follow-up implementation (Vue card + behavioral test) is a mechanical, separately-opt-in slice. The runtime slice remains separate and starts only after an explicit owner opt-in.

---

## §1 Scope

**In scope (MP-4):** an admin settings card that reads and writes the already-live `makeupPunchPolicy` org setting through `GET`/`PUT /api/attendance/settings`, plus its admin-rail registration and the two test edits that registration forces. Nothing else.

**Explicitly OUT of MP-4 — separate, individually owner-gated slices:**
- **MP-5** — request-side UX (error codes, quota/window hints, HMR-prefill shared path) for blocked makeup requests. A different surface (the Request Center), not this card. (`attendance-makeup-punch-policy-design-lock-20260626.md` §7 line 242.)
- **MP-6** — staging smoke for the makeup-punch loop (quota/window/type/anomaly-prefill/approval-adjusted-record/residue=0). (Same doc, line 243.)

**Excluded from the AE staging-closure acceptance.** The staging window bundle (`attendance-staging-window-bundle-20260702.md` §1) is a closed set of exactly three smokes — AE-4 (`AE4_RESULT_EDIT_STAGING_SMOKE_PASS`), RD-4/5 (`RD45_REPORT_DIGEST_STAGING_SMOKE_PASS`), OT-bank v1-8 (`OTBANK_V18_STAGING_SMOKE_PASS`). MP-4/5/6 is **not** among the three, feeds **none** of those PASS stamps, and is not part of that window's §8 closure checklist. MP's own staging proof is the separate MP-6 slice.

**No backend change — with one honest caveat.** `makeupPunchPolicy` already exists end-to-end on `origin/main` (all paths in `plugins/plugin-attendance/index.cjs`): `DEFAULT_SETTINGS.makeupPunchPolicy` (~L284), the `mergeSettings` per-sub-object branch (~L13116), `normalizeMakeupPunchPolicySetting` (~L12671 — note L12165 is only its call site inside `normalizeSettings`), the enum-strict zod block (~L21407), and the enforcement path `enforceMakeupPunchPolicy`/`buildMakeupPunchPolicySnapshot` (~L12812–12901, invoked from the request-write hook ~L26781). MP-4 stays **frontend-only** because it edits only the fields enforcement actually consumes and renders the non-consumed / single-valued fields read-only (§2/§3). No migration, no route, no normalizer change. **Caveat:** one stored field, `allowedRequestTypes`, is *not* consumed by enforcement today (§2) — making it editable would require a separate backend slice (§7), so MP-4 renders it read-only rather than shipping a control that saves but changes nothing.

---

## §2 The policy contract the card edits

One row per top-level `makeupPunchPolicy` field (nested objects expanded as sub-rows). Defaults from `index.cjs` ~L284; bounds from the zod block ~L21407; the **Runtime** column is verified against `enforceMakeupPunchPolicy` / `buildMakeupPunchPolicySnapshot` (~L12812–12901). Three states — **Enforced** = drives behavior; **Snapshot-only** = recorded in the enforcement snapshot but single-valued in v1 with no behavioral branch; **Not consumed** = stored + zod-validated but enforcement ignores it (a config trap — the card must NOT present it as editable). Only **Enforced** fields become editable controls.

| Field | Default | Zod bound (PUT rejects outside → 400) | Runtime |
|---|---|---|---|
| `enabled` | `false` | `boolean` | **Enforced** — master gate; enforcement is a byte-identical no-op when not `true` (~L12815/12834). |
| `timezone` | `'Asia/Shanghai'` | `string` min 1, IANA-validated | **Enforced** — anchors the quota cycle window + submit-window day math (~L12846). |
| `cycle.type` | `'calendar_month'` | enum `['calendar_month']` | **Snapshot-only** — recorded (~L12817); single value, no branch. |
| `cycle.startDay` | `1` | int `1..31` (short-month clamped at runtime) | **Enforced** — cycle boundary for quota counting. |
| `quota.maxRequestsPerCycle` | `3` | int `1..99` | **Enforced** — quota ceiling per subject per cycle (~L12901). |
| `quota.countStatuses` | `['pending','approved']` | array of enum `['pending','approved']`, min 1 | **Enforced** — which request states consume quota (~L12820/12882). |
| `quota.principal` | `'self_service_user'` | enum `['self_service_user']` | **Snapshot-only** — recorded (~L12821); single value, no branch. |
| `submitWindow.unit` | `'calendar_day'` | enum `['calendar_day']` | **Snapshot-only** — recorded (~L12823); single value, no branch. |
| `submitWindow.days` | `30` | int `0..180` (`0` = today-only) | **Enforced** — how far back a makeup may target (~L12856). |
| `allowedAnomalyTypes` | `['missing_check_in','missing_check_out','late','severe_late','absence_late','early_leave']` | array of enum `['missing_check_in','missing_check_out','late','severe_late','absence_late','early_leave','normal']`, min 1 | **Enforced** — server-derived anomaly facts must intersect this allow-list (~L12864); `normal` is offerable but **off by default** per §9 ratified normal-correction-off. |
| `allowedRequestTypes` | `['missed_check_in','missed_check_out','time_correction']` | array of enum `['missed_check_in','missed_check_out','time_correction']`, min 1 | **Not consumed** — the request-type gate uses the frozen `MAKEUP_PUNCH_ALLOWED_REQUEST_TYPES` constant (~L12650, referenced ~L12882/26737), NOT this field. It is normalized + zod-validated but enforcement never reads it. Render read-only (§3). |
| `requireReason` | `true` | `boolean` | **Enforced** — blank reason → 422 (~L12872). |
| `requireAttachment` | `false` | `boolean` | **Enforced** — missing attachment → 422 when true (~L12875). |

Coverage is defined by the table above, not by any prose count. Non-**Enforced** fields (`cycle.type`, `quota.principal`, `submitWindow.unit`, `allowedRequestTypes`) render read-only / informational (§3) — shown for transparency, never as controls that would save-but-do-nothing.

**Ratified §9 values the card must honor** (`attendance-makeup-punch-policy-design-lock-20260626.md` §9): quota default 3/cycle (range 1..99); window default 30 calendar-days (0..180, 0 = today-only); `cycle.startDay` 1..31 short-month-clamped; count `pending`+`approved`; normal-correction **default-off**; delegated/admin-submit OUT for v1 (+ cross-user PUT fail-closed); workday-window deferred to MP-v2. The card must not present controls that contradict these (e.g. no delegated-submit toggle).

---

## §3 Card UI shape — mirror the RD-4 report-digest card precedent

RD-4 (`#3283` / `97b363977`) is the direct precedent and its 4-file set is the MP-4 checklist. The makeup card mirrors it exactly.

**Section wrapper** (in `apps/web/src/views/AttendanceView.vue`): `<div v-show="shouldShowAdminSection(ATTENDANCE_ADMIN_SECTION_IDS.makeupPunchPolicy)" class="attendance__admin-section" v-bind="adminSectionBinding(ATTENDANCE_ADMIN_SECTION_IDS.makeupPunchPolicy)" data-attendance-makeup-punch-policy>` — carrying both the spread binding and a stable explicit root attr `data-attendance-makeup-punch-policy` (tests query the card by this attr, the rail link by `data-admin-anchor`).

**Form ref** `makeupPunchPolicyForm` (reactive), a flat template with dotted reactive paths (no child component), mirroring `reportDigestPolicyForm` (`AttendanceView.vue:13776-13797`).

**Controls + `data-*` selector convention** (`data-makeup-punch="…"`):
- `enabled` → checkbox `data-makeup-punch="enabled"`.
- `timezone` → text input `v-model.trim` `data-makeup-punch="timezone"`.
- `cycle.type` → read-only/disabled `<select>` (single option `calendar_month`) `data-makeup-punch="cycle-type"`.
- `cycle.startDay` → `type="number" min="1" max="31"` `v-model.number` `data-makeup-punch="cycle-start-day"`.
- `quota.maxRequestsPerCycle` → `type="number" min="1" max="99"` `v-model.number` `data-makeup-punch="quota-max"`.
- `quota.countStatuses` → checkbox-group bound to an array (`value="pending"` / `value="approved"`), `data-makeup-punch-count-status="pending|approved"` (RD-4 recipients-array pattern).
- `quota.principal` → read-only/disabled `<select>` (single option `self_service_user`) `data-makeup-punch="quota-principal"`.
- `submitWindow.unit` → read-only/disabled `<select>` (single option `calendar_day`) `data-makeup-punch="window-unit"`.
- `submitWindow.days` → `type="number" min="0" max="180"` `v-model.number` `data-makeup-punch="window-days"`.
- `allowedAnomalyTypes` → checkbox-group array, one box per enum value (incl. `normal`, unchecked by default), `data-makeup-punch-anomaly-type="<value>"`.
- `allowedRequestTypes` → **read-only / informational** list of the enforced set (the three `MAKEUP_PUNCH_ALLOWED_REQUEST_TYPES` constant values), labeled "fixed in v1 — not org-configurable", `data-makeup-punch="request-types-readonly"`. **NOT** an editable checkbox group: the field is not consumed by enforcement (§2), so an editable control would save but change nothing. Making it editable is the separate backend slice in §7.
- `requireReason` → checkbox `data-makeup-punch="require-reason"`.
- `requireAttachment` → checkbox `data-makeup-punch="require-attachment"`.
- Primary save `<button data-makeup-punch="save" :disabled="settingsLoading" @click="saveMakeupPunchPolicy">`.

All copy uses the existing `tr('EN','中文')` helper. No external brand names.

**Anchor-nav consequence — stated honestly: this ADDS a section (not a no-op).** `ATTENDANCE_ADMIN_SECTION_IDS` is defined in `apps/web/src/views/attendance/useAttendanceAdminRail.ts` (currently **32 entries**). Registration requires the same three edits RD-4 made in that one file: (1) the id constant `makeupPunchPolicy: 'attendance-admin-makeup-punch-policy'`; (2) a `adminSectionNavItems` entry `{ id, label: tr('Makeup punch policy','补卡策略') }`; (3) membership in the appropriate group's `itemIds` (RD-4 used `'workspace'`). Because this adds a rail section, the hard-coded count in `apps/web/tests/attendance-admin-anchor-nav.spec.ts` **must be bumped 32 → 33 in both assertions** — `toHaveLength(32)` (line 127) and `.toBe(32)` (line 835) — and the new label added to the `expect.arrayContaining([...])` list, exactly as `97b363977` bumped 31 → 32. This is a required, honest part of the slice, not an incidental.

---

## §4 Load / save flow

**Load:** add `applyMakeupPunchPolicyToForm(data.data || {})` into the existing `loadSettings()` applier series (`AttendanceView.vue:~19921`, beside `applyReportDigestPolicyToForm`). It reads `settings.makeupPunchPolicy || {}` and hydrates the form on first admin screen (no reload action required), mirroring `applyReportDigestPolicyToForm` (`:20018-20026`).

**Save:** `saveMakeupPunchPolicy()` mirrors `saveReportDigestPolicy` (`:~20052`): a client validator (`makeupPunchPolicyError()`) enforces the §2 bounds and each array's min-1 (empty `allowedAnomalyTypes`/`allowedRequestTypes`/`countStatuses` blocked) and returns a `setStatus(error,'error')` **before any PUT** on invalid input; on valid input it sets `settingsLoading`, builds a payload containing **only** `{ makeupPunchPolicy: {…} }` with full `cycle`/`quota`/`submitWindow` sub-objects, and `apiFetch('/api/attendance/settings', { method:'PUT', body })`. A `403` sets `adminForbidden.value = true` and throws; on success it re-hydrates via `applyMakeupPunchPolicyToForm(savedSettings)`.

**Deep-merge discipline:** the frontend PUTs only the `makeupPunchPolicy` key; backend `mergeSettings` (`index.cjs:13116-13129`) deep-merges `cycle`/`quota`/`submitWindow` per sub-object, so sending full sub-objects is safe and leaves siblings untouched. Never PUT a partial sub-object expecting the rest to persist unchanged within that sub-object — send the full sub-object.

**Admin-capability gate (identical to RD-4):** the card renders only under `showAdmin` (`mode==='admin'`, `AttendanceView.vue:13115`) and `shouldShowAdminSection(id)` (`:13345`); a `403` from GET or PUT flips `adminForbidden` (`:10597`). It does **not** gate on `provisionUserIsAdmin` (that ref is a provisioning-status chip, not the section gate).

---

## §5 Enablement preconditions — RBAC single-tenant posture (first-class)

The card writes via the `PUT /api/attendance/settings` route (`index.cjs` ~L41408), an `attendance:admin`-gated surface — the GET route (~L41083) is gated identically. `attendance:admin` is a **global** permission: `getOrgId` (~L5823) trusts the body `orgId`, `withPermission` (~L19911) checks the grant with no org context, and the RBAC tables carry no org column — so `WHERE org_id = $2` is a **partition filter, not an auth boundary**. (Symbol names are the stable anchors; line numbers are approximate to the current `origin/main` and may drift.)

Because MP-4 turns this into a **live admin write surface a customer can enable**, this posture must be **elevated out of the issue comment into the release / operator note** at any customer enablement — not left as an issue-comment-only record. Line to carry:

> The makeup-punch policy config card writes via `PUT /api/attendance/settings`, an `attendance:admin`-gated surface. `attendance:admin` is a global permission and `org_id` is a partition key, not an auth boundary — so this card must be enabled only under a single-tenant / per-customer deployment posture. Enabling it under a multi-tenant assumption is unsafe until the separate org-scoped-authorization initiative lands.

Standing constraint (unchanged, tenancy-wide): until the tenancy model is decided, no `attendance:admin` write should be enabled under a multi-tenant assumption. This is a pre-existing repo-wide posture; MP-4 introduces no new auth-model weakness — it inherits the existing global posture and is called out here only because it makes the surface customer-facing.

---

## §6 Test plan (for the deferred runtime slice)

Mirror RD-4 exactly, so no CI-wiring gap:
- Put the behavioral test **inside the already-guarded** `apps/web/tests/attendance-admin-regressions.spec.ts` (an `it(...)` like RD-4's at `:3120`): click `[data-admin-anchor="attendance-admin-makeup-punch-policy"]`, scope to `[data-attendance-makeup-punch-policy]`, assert first-screen hydration of every §2 field, assert an invalid state (e.g. empty `allowedRequestTypes`, `submitWindow.days` out of 0..180) produces **zero** PUTs, then assert the successful PUT body `.toEqual({ makeupPunchPolicy: {…} })` (single key only, full sub-objects).
- Because that spec **and** `attendance-admin-anchor-nav.spec.ts` are already in the `attendance-web-guard` run-list + path filters, **no workflow edit is needed** — the tests run automatically. Update the anchor-nav counts per §3.
- **Only if** the runtime slice instead creates a **new** spec file must it also be added to the guard's `vitest run` filter and **both** path-filter blocks (`.github/workflows/attendance-web-guard.yml`), else it is skip-shaped-green. Prefer the in-place approach above.

---

## §7 Deferrals + open questions

- **Runtime is a separate opt-in.** This lock is docs-only. The Vue card + rail registration + the two test edits are the MP-4 runtime slice, authored only after ratification (one PR, frontend-only, `git`-clean 4-file set mirroring `97b363977`).
- **Single-valued enum controls** (`cycle.type`, `quota.principal`, `submitWindow.unit`) render read-only in v1. If a future MP-v2 adds enum values (e.g. a workday-based submit window), the controls become editable then — not now.
- **`allowedRequestTypes` is not org-configurable in v1 → a separate BACKEND slice, not part of MP-4.** Enforcement hardcodes the frozen `MAKEUP_PUNCH_ALLOWED_REQUEST_TYPES` constant (`index.cjs` ~L12650) at every request-type gate (~L12882/26737/27940/27979/28562); the stored `policy.allowedRequestTypes` field is normalized + zod-validated but never read. MP-4 therefore renders it read-only (§3). Making it org-editable is a distinct, owner-gated runtime slice — wire `policy.allowedRequestTypes` into `enforceMakeupPunchPolicy`'s type gate (and the sibling request-write hooks that reference the constant), with real-DB tests proving a de-selected type is actually rejected — and is deliberately NOT bundled into this frontend-only UI slice, because it changes accept/reject behavior, not just the UI. (This is the owner's "wire the backend first" alternative to the read-only approach; MP-4 as locked takes the read-only path.)
- **`normal` anomaly type** is offerable in the allow-list checkbox group but unchecked by default (ratified normal-correction-off); enabling it is an explicit admin action, consistent with the runtime.
- **MP-5 / MP-6 remain gated.** The request-side UX (MP-5) and staging smoke (MP-6) are not unlocked by ratifying MP-4.
