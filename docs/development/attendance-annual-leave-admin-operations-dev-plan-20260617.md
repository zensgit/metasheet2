# L5c — Annual-leave admin operations UI · development plan (gated TODO-checklist)

**Status:** ⬜ UNBLOCKED — build authorized. Design-lock `docs/development/attendance-annual-leave-admin-operations-design-lock-20260617.md` is MERGED on `origin/main` (at commit `619fab564`, #2795) and is the authority for every field, code, and 拍板 below. The L6 staging runbook `docs/development/attendance-annual-leave-l6-staging-smoke-runbook-20260617.md` is also merged (#2796) but is a **downstream owner-run gate** (§Dependencies), not part of this build.

**One-line scope:** put the three existing **balance-mutating** annual-leave endpoints behind buttons inside **one** new admin nav section, in **one** PR, with the five locked dimensions (preview / confirm / idempotency / failure-code / permission-audit) instantiated three times — **without flattening the three different back-ends**.

---

## 0. Verified ground truth (read before editing)

All confirmed against `origin/main` this session:

| Fact | Value on `main` |
|---|---|
| SFC | `apps/web/src/views/AttendanceView.vue` (26,084 lines) |
| Admin rail section registry | `apps/web/src/views/attendance/useAttendanceAdminRail.ts` (under `views/attendance/`, **not** `src/composables/`; 570 lines) |
| Section-ID registry | `ATTENDANCE_ADMIN_SECTION_IDS` (rail line ~12); last two = `annualLeaveBalance` (40), `annualLeavePolicy` (41) |
| Annual-leave nav group | rail line ~244: `{ id: 'annual-leave', label: tr('Annual leave', '年假/法定假'), itemIds: [annualLeaveBalance, annualLeavePolicy] }` — **L5c appends a 3rd item here; do NOT add a 7th group** |
| Section render convention | `v-show="shouldShowAdminSection(ID)"` + `v-bind="adminSectionBinding(ID)"` + `.attendance__admin-section`; inline `tr(en,zh)`; anchor click target `[data-admin-anchor="<id>"]`; container `#<id>` |
| policy.enabled hydration | `applyAnnualPolicyToForm()` (line ~19802) sets `annualPolicyForm.enabled`; called from **both** `loadSettings()` (line ~18654, first-screen) and `loadAnnualPolicy()` (line ~19834). `annualPolicyForm.enabled` is the §6 gate — already hydrated on first screen. |
| Existing confirm primitive | **Only `window.confirm(tr(...))`** (16 delete sites) + 3 in-DOM `role="dialog"` panels (lines 4545/4631/4762, scheduling). `window.confirm` is **not in-DOM UI** — it can't render a structured preview/restatement and is **not suitable for this two-step-confirm + readable-summary flow** (its argument is mockable/assertable in jsdom, so the issue is fit, not assertability) → **L5c builds an in-DOM confirm panel mirroring the `role="dialog"` pattern.** These are the **first structured two-step confirms** in the annual-leave area. |
| Anchor-nav literals (the web-guard) | `apps/web/tests/attendance-admin-anchor-nav.spec.ts` line **127** `expect(labels).toHaveLength(29)` and line **832** `expect(...querySelectorAll('option')).length).toBe(29)` — bump **both to 30**. `groupLabels` `toEqual([6 groups])` (line 126) is **unchanged**; `labels` is `arrayContaining` so adding the new label is optional but recommended. |
| Regression-test pattern | `apps/web/tests/attendance-admin-regressions.spec.ts` (6,448 lines): `vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))`, then `vi.mocked(apiFetch).mockImplementation(async (input, init) => { … })` URL-keyed; mount via `createApp(AttendanceView, { mode: 'admin' })`; drive via `[data-admin-anchor="<id>"].click()` then read `#<id>`. Existing annual tests at lines 937 (balance) and 991 (policy hydration) are the templates to mirror. |
| Backend (read-only reference, NOT touched) | `plugins/plugin-attendance/index.cjs`: accrual run summary line ~15611, manual-adjust codes ~15672/15689/15730/15762, route registration ~37872/37928/37958. Codes/keys match the design-lock exactly. |
| Typecheck | `vue-tsc -b` (project-references build — **NOT** `vue-tsc --noEmit`, which false-greens cross-file union errors) |

---

## 1. Scope, the one-PR / one-section constraint, and build order

### 1.1 What ships
Three operation cards, one section, one PR (拍板 A + B):
- **Manual adjustment** — `POST /api/attendance/annual-leave-manual-adjustment` (± one user's balance).
- **Expiry backfill** — `POST /api/attendance/annual-leave-expiry-backfill` (stamp `expires_at` on pre-L4 lots).
- **Accrual run** — `POST /api/attendance/annual-leave-accrual/run` (grant the period entitlement to the active population).

All inside one new section **年假操作 / Annual leave operations**, the 30th anchored admin section, nested as the 3rd item in the existing `annual-leave` group.

### 1.2 WHY splitting fails (拍板 B — record this, it is the rationale the owner locked)
- **Shared scaffolding ×3.** The five dimensions are one confirm/preview/result interaction model instantiated three times. Split across PRs, the scaffold is either duplicated or stranded behind a merge ordering.
- **Hard file collisions.** All three cards are template fragments + state refs + handlers in the **same** SFC; the nav-group `itemIds` array gets one append per card; the two anchor-nav literals bump by the section count. Three PRs touching the same `itemIds` line + the same two literal lines → guaranteed rebase/AA conflicts and a half-counted anchor-nav between merges (29→30 only makes sense once, when the whole section lands).
- **The anchor-nav web-guard is atomic.** The section is one nav entry (count 29→30); you cannot land "one card" and have the count be self-consistent.

### 1.3 Build order INSIDE the one PR (拍板, smallest blast radius first — design-lock §10)
1. **Manual adjustment** first — smallest blast radius (one user, ±one balance), and it's the **client-preview** card. It establishes the confirm panel + result panel + `error.code→human-line` mapper scaffold.
2. **Expiry backfill** second — establishes the **server-dryRun** pattern (`dryRun:true` → auditable `{scanned,updated,skipped,reasons}` table) on an idempotent-by-nature action; lowest stakes among the server-dryRun pair.
3. **Accrual run** third — highest stakes (grants the whole active population); reuses the server-dryRun pattern, adds the period guardrail (§7) and the `alreadyGranted` idempotency surface.

---

## 2. SHARED SCAFFOLD (build FIRST, inside the SFC — NOT new `.vue` files)

> **Anti-flatten rule (design-lock §1, the #1 codebase-fit trap):** the shared scaffold is the **interaction model** (preview → confirm → result) plus two helpers that do **NOT** apply uniformly. The three back-ends differ — keep the asymmetries explicit. A result panel that assumes all three return a `{code→count}` map is the flatten bug: **manual-adjust returns `{id,delta,applied,alreadyApplied}` with NO reasons map.**

### 2.1 Section registration (rail) — ⬜
- **`apps/web/src/views/attendance/useAttendanceAdminRail.ts`:**
  - Add `annualLeaveOperations: 'attendance-admin-annual-leave-operations'` to `ATTENDANCE_ADMIN_SECTION_IDS` (after `annualLeavePolicy`, line ~41).
  - Add nav-link label after line ~193: `{ id: ATTENDANCE_ADMIN_SECTION_IDS.annualLeaveOperations, label: tr('Annual leave operations', '年假操作') }`.
  - **Append** `ATTENDANCE_ADMIN_SECTION_IDS.annualLeaveOperations` to the existing `annual-leave` group `itemIds` (line ~248), after `annualLeavePolicy`. **Do NOT create a new group** — `groupLabels` must stay the 6 locked labels.

### 2.2 Anchor-nav literal bump (the web-guard gate) — ⬜
- **`apps/web/tests/attendance-admin-anchor-nav.spec.ts`:**
  - Line **127**: `expect(labels).toHaveLength(29)` → `30`.
  - Line **832**: `expect(Array.from(jumpSelect!.querySelectorAll('option')).length).toBe(29)` → `30`.
  - Add `'Annual leave operations'` to the line-130 `arrayContaining([...])` list (optional but recommended — proves the new label renders).
  - **Leave line-126 `groupLabels` `toEqual([...6 groups...])` untouched.**

### 2.3 Section shell in the SFC — ⬜
- **`apps/web/src/views/AttendanceView.vue`**, insert a new `<section v-show="shouldShowAdminSection(ATTENDANCE_ADMIN_SECTION_IDS.annualLeaveOperations)" class="attendance__admin-section" v-bind="adminSectionBinding(...)">` immediately after the `annualLeavePolicy` section (ends ~line 6230). One `<h4>{{ tr('Annual leave operations', '年假操作') }}</h4>` header, then the three cards stacked.

### 2.4 Shared confirm panel (in-DOM, NOT `window.confirm`) — ⬜
- One reactive `annualOpsConfirm` ref: `{ open: boolean; card: 'adjust'|'backfill'|'accrual'; title: string; lines: Array<{label,value}>; extraConfirmRequired?: boolean; onConfirm: () => void }`.
- Template: an in-DOM `role="dialog"` panel (mirror the line-4545 pattern) with a **restatement table** built from `lines` (target user / period / delta / `dryRun=false` / and, for accrual+backfill, the dry-run counts just seen — 拍板 dimension 2). Buttons: 取消 / 确认提交. Accrual off-year (拍板 C) adds a second explicit checkbox/confirm gated by `extraConfirmRequired`.
- Helper `openAnnualOpsConfirm(payload)` / `closeAnnualOpsConfirm()`. **Stable selector** `[data-annual-ops-confirm]` for tests.

### 2.5 Shared result panels — TWO shapes, NOT one — ⬜
- **`renderReasonTable(map: Record<string,number>)`** — a `code → count` `<table>` fragment. Used by **backfill (`reasons`)** and **accrual (`skipReasons`)** ONLY. Renders unexpected keys gracefully (iterate `Object.entries`).
- **Manual-adjust result is a DIFFERENT shape**: before/after numbers + `applied` / `alreadyApplied` badges + the returned adjustment **`id`**; **no reasons table**. Do not route it through `renderReasonTable`.
- **Provenance IDs (design-lock §5 — traceability):** each result panel surfaces the returned identifier(s) so an action is auditable from the UI — manual-adjust's **`id`**, accrual's **`runId` + `periodKey`**, backfill's **`scanned/updated/skipped`** audit — rendered alongside the counts/badges, not hidden.
- Stable selectors `[data-annual-ops-result-<card>]`.

### 2.6 Shared failure-code mapper — ⬜
- `annualOpsErrorLine(code: string, card): string` returning a `tr(en,zh)` human line. Shared function, **per-card code sets** (§3 lists). Accrual's map **must carry a default/fallback line** for the `UNKNOWN` skip bucket and any unlisted code — do NOT hardcode only the seven reason codes.
- On `apiFetch` reject, read `error.code` (the routes return `{ ok:false, error:{ code, message } }`); render `annualOpsErrorLine(code)`, falling back to the raw code + message if unmapped.

### 2.7 policy.enabled proactive gating (§6) — ⬜
- Computed `annualOpsPolicyEnabled = computed(() => annualPolicyForm.enabled === true)` (hydrated on first screen via `loadSettings → applyAnnualPolicyToForm`).
- When `false`: **disable all three cards' commit buttons** + show an informational hint linking to the L5b Policy block (`#attendance-admin-annual-leave-policy`).
- **Asymmetry to keep explicit:** the disable is **load-bearing for accrual** (backend hard-422s `ANNUAL_LEAVE_NOT_ENABLED`) but **UX-consistency-only for adjust/backfill** (backend stays callable). The hint is informational, not a hard client block layered on top of the server contract.

---

## 3. PER-CARD breakdown

> Each card = (state refs) + (handlers) + (template) + (regression test). Concrete `file:symbol` targets below. All POSTs via `apiFetch`. SFC hazards (§4) apply to every numeric input.

### 3.1 Card 1 — Manual adjustment (client-preview) — ⬜

**Endpoint:** `POST /api/attendance/annual-leave-manual-adjustment`, body `{ userId, deltaMinutes:int32 nonzero, reason:1-500, idempotencyKey?:1-200, runId?:uuid }` → `{ id, delta, applied, alreadyApplied }`.

> **v1 scope decision — `runId` is NOT exposed in the card.** `runId` is an optional API-level provenance back-link (tie a correction to a specific accrual run); v1 ships **standalone adjustments only**, so the card sends no `runId`. Because of that, `ANNUAL_LEAVE_ADJUST_RUN_NOT_FOUND` is **unreachable from the UI** and is omitted from the rendered codes below (the endpoint still returns it for direct API callers). If a run-linked correction is wanted later, it is a small additive input — re-open the design-lock first.

**State refs (AttendanceView.vue `<script setup>`):**
- `annualAdjustForm = reactive({ userId:'', deltaMinutes: 0, reason:'', idempotencyKey:'' })`
- `annualAdjustSubmitting = ref(false)`, `annualAdjustResult = ref<...|null>(null)`, `annualAdjustError = ref<string|null>(null)`
- `annualAdjustPreview = computed(...)` — derives `current → resulting` from the **L5a balance read** (`annualBalanceData`) for the entered user; for negative delta, hints available balance. **Labelled "Preview (client)", never "dry-run".**

**Handlers:**
- `previewAnnualAdjust()` — (re)load the L5a balance for `userId` if not loaded, compute before/after.
- `requestAnnualAdjust()` — validate (nonzero int delta, reason 1–500), open the shared confirm panel restating user/delta/reason.
- `submitAnnualAdjust()` (confirm callback) — POST; on success set `annualAdjustResult`; on reject map `error.code`.

**Preview 口径:** **client-preview only.** The before/after is advisory. **The backend `422 ANNUAL_LEAVE_BALANCE_INSUFFICIENT` is final** — render it as the authoritative failure; the client hint never claims server authority.

**Confirm content:** target user · current → resulting · delta (±min) · reason. `dryRun` N/A (no server dry-run for this card).

**Idempotency surfacing:** offer a stable per-attempt `idempotencyKey` so a double-submit can't double-adjust. On `alreadyApplied:true` (with `applied:false`) → result panel states **"already applied (no change)"** (idempotent replay). On `409 ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT` → "this idempotency key already names a *different* adjustment," NOT a generic conflict.

**Failure codes to render:** `VALIDATION_ERROR`, `ANNUAL_LEAVE_ADJUST_DELTA_INVALID` (delta=0), `USER_NOT_IN_ORG` (404 — not an *active* org member), `ANNUAL_LEAVE_BALANCE_INSUFFICIENT` (422, final authority), `ANNUAL_LEAVE_ADJUST_IDEMPOTENCY_CONFLICT` (409), `DB_NOT_READY`/`INTERNAL_ERROR`. (`ANNUAL_LEAVE_ADJUST_RUN_NOT_FOUND` is omitted — the card sends no `runId`, per the v1 scope note above.)

**Regression test (`attendance-admin-regressions.spec.ts`):**
- Mount admin, click `[data-admin-anchor="attendance-admin-annual-leave-operations"]`, read `#attendance-admin-annual-leave-operations`.
- (a) happy commit: mock POST → `{applied:true,alreadyApplied:false}`; assert the POST body (find the call by `url.includes('annual-leave-manual-adjustment')`, assert `init.method==='POST'` and parsed body fields), assert result panel shows applied.
- (b) idempotent replay: mock → `{applied:false,alreadyApplied:true}`; assert "already applied (no change)".
- (c) insufficient: mock reject `{error:{code:'ANNUAL_LEAVE_BALANCE_INSUFFICIENT'}}`; assert the mapped human line renders.
- (d) 409 conflict: assert the key-reuse line (not generic).
- (e) disabled when `annualPolicyForm.enabled=false` (mock first-screen settings with `annualLeavePolicy.enabled:false`).
- **Assert the request by type/URL match, never by call index** (§4 flake rule).

### 3.2 Card 2 — Expiry backfill (server dry-run) — ⬜

**Endpoint:** `POST /api/attendance/annual-leave-expiry-backfill`, body `{ dryRun?:bool }` (card sends only `dryRun`; `getOrgId` resolves org) → `{ scanned, updated, skipped, dryRun, reasons }` where `reasons` is an **object/map**.

**State refs:** `annualBackfillRunning = ref(false)`, `annualBackfillDryResult = ref<...|null>(null)`, `annualBackfillCommitResult = ref<...|null>(null)`, `annualBackfillError = ref<string|null>(null)`.

**Handlers:**
- `runAnnualBackfillDryRun()` — POST `{dryRun:true}`; store `annualBackfillDryResult` (default action of the card).
- `requestAnnualBackfillCommit()` — open shared confirm restating the dry-run counts just seen.
- `submitAnnualBackfillCommit()` — POST `{dryRun:false}`; store result.

**Preview 口径:** **server dry-run** — authoritative `{scanned,updated,skipped,reasons}` with no writes. Commit is a second deliberate step seeded with the dry-run numbers.

**Confirm content:** "commit backfill" · scanned/updated/skipped from the dry-run · `dryRun=false`.

**Idempotency surfacing:** **idempotent by nature** — the scan only selects `WHERE expires_at IS NULL`, so a prior-run lot is simply **out of scope** (absent, not reported). Frame `ALREADY_SET` as a **concurrent-write no-op** (select-then-update race), NOT a failure.

**Failure / reason codes (render via `renderReasonTable`):** `NON_ACCRUAL_SOURCE`, `MISSING_RUN_ITEM`, `INVALID_RUN_ITEM`, `MISSING_RUN`, `INVALID_RUN`, `UNPARSEABLE_POLICY_VERSION`, `MISSING_TIMEZONE`, `UNPARSEABLE_PERIOD_KEY`, `ALREADY_SET`. Top-level errors: `VALIDATION_ERROR`, `DB_NOT_READY`, `INTERNAL_ERROR`.

**Regression test:**
- (a) dry-run: mock POST `{dryRun:true}` → `{scanned:10,updated:7,skipped:3,dryRun:true,reasons:{ALREADY_SET:2,NON_ACCRUAL_SOURCE:1}}`; assert the **code→count table** renders both rows; assert the body sent `dryRun:true`.
- (b) commit: after dry-run, confirm + commit; assert second POST sent `dryRun:false`.
- (c) reasons-as-map: assert the result reads the map (not an array) — guards the flatten bug.
- (d) disabled-when-policy-off.

### 3.3 Card 3 — Accrual run (server dry-run + period guardrail) — ⬜

**Endpoint:** `POST /api/attendance/annual-leave-accrual/run`, body `{ period:int 2000-2100, asOf?:'YYYY-MM-DD', dryRun?:bool }` → `{ runId, periodKey, asOf, dryRun, granted, skipped, grantedMinutes, lotsCreated, alreadyGranted, skipReasons }` (`skipReasons` an **object/map**).

**State refs:** `annualAccrualForm = reactive({ period: <currentYear>, asOf:'' })`, `annualAccrualRunning = ref(false)`, `annualAccrualDryResult = ref<...|null>(null)`, `annualAccrualCommitResult = ref<...|null>(null)`, `annualAccrualError = ref<string|null>(null)`, and `annualAccrualPeriodOffYear = computed(() => form.period !== currentYear && form.period !== currentYear+1)`.

**Handlers:**
- `runAnnualAccrualDryRun()` — POST `{period,asOf?,dryRun:true}`.
- `requestAnnualAccrualCommit()` — if `annualAccrualPeriodOffYear`, open confirm with `extraConfirmRequired:true` + the off-year warning naming the period (拍板 C); else normal confirm restating dry-run counts.
- `submitAnnualAccrualCommit()` — POST `{dryRun:false}`.

**Preview 口径:** **server dry-run** — persists run + run_items but **no lots/events**, consumes no `source_key`, returns full summary. Commit seeded from it.

**Confirm content:** period · asOf · granted / grantedMinutes / lotsCreated / alreadyGranted (from dry-run) · `dryRun=false`. Off-year → second explicit confirm naming the off-year period.

**Period soft-warn (拍板 C):** off current/next year → **soft-warn + explicit extra confirm; do NOT hard-block.** Warning text names the off-year period; confirm dialog restates it.

**Idempotency surfacing:** **natural (org, period) key** — `ON CONFLICT DO NOTHING`. A second real run grants nothing new and surfaces **`alreadyGranted`** — state plainly "safe to re-run; reports alreadyGranted, does not double-grant." Note the snapshot limitation (a re-run does not top-up a tenure-boundary change — corrections go through manual adjustment; the card links to Card 1).

**Failure / skip codes:** top-level `VALIDATION_ERROR`, `ANNUAL_LEAVE_INVALID_ASOF`, **`ANNUAL_LEAVE_NOT_ENABLED`** (422, the load-bearing gate), `ANNUAL_LEAVE_TIMEZONE_REQUIRED`/`ANNUAL_LEAVE_TIMEZONE_INVALID`, `DB_NOT_READY`/`INTERNAL_ERROR`. `skipReasons` (via `renderReasonTable`): `NOT_YET_HIRED`, `HIRED_AFTER_PERIOD`, `MISSING_HIRE_DATE`, `MISSING_SERVICE_START_DATE`, `NOT_ELIGIBLE_UNDER_ONE_YEAR`, `NO_MATCHING_TIER`, `PRORATION_BELOW_ONE_DAY`, **plus a default/fallback line for `UNKNOWN` / unlisted keys**.

**Regression test:**
- (a) dry-run: mock → full summary with `skipReasons:{NOT_YET_HIRED:2,UNKNOWN:1}`; assert table renders **including the UNKNOWN/fallback row**; assert body sent `dryRun:true`.
- (b) commit current-year: confirm (single) + commit; assert `dryRun:false`; assert `alreadyGranted` surfaced.
- (c) off-year guardrail: set `period` to currentYear-2; assert the soft-warn renders and commit requires the extra confirm (the panel exposes `[data-annual-ops-confirm]` with the off-year line); assert it does **not** hard-block.
- (d) `ANNUAL_LEAVE_NOT_ENABLED`: with policy disabled assert the card is proactively disabled (load-bearing) and, if forced, the 422 maps to the human line.

---

## 4. Cross-cutting engineering — ⬜

- **Typecheck:** run `pnpm -C apps/web exec vue-tsc -b` (project-references build). **NOT `vue-tsc --noEmit`** — that false-greens cross-file union/ref errors (burned on a prior condition_branch FE union miss).
- **Local vitest, NOT CI roulette:** debug in the worktree — `pnpm install` (warm store ≈3s) then `pnpm -C apps/web exec vitest run -t '<test name>'` and `vitest run apps/web/tests/attendance-admin-regressions.spec.ts apps/web/tests/attendance-admin-anchor-nav.spec.ts`. A 26k-line SFC test must be iterated locally, not by pushing and watching CI.
- **attendance-web-guard gate:** the anchor-nav spec **is** the web-guard. Both literal bumps (§2.2) must land in this PR or the guard goes red. Run it locally before push.
- **CI (the gate that matters):** the apps/web specs are gated by `.github/workflows/attendance-web-guard.yml`, which pins a **single `node-version: 20.x`** (no matrix). The 18.x+20.x matrix is `plugin-tests.yml` (plugin tests, not these specs), so a Node-18 constraint on `apps/web` is NOT enforced here — target Node 20.x.
- **SFC hazard — numeric `v-model` coercion:** `<input type="number" v-model.number="...">` yields a **number**; a string-only helper (`.trim()`) on it throws, and the handler's own `catch` can silently swallow it → no-op save (the exact ③-caps bug). Use `v-model.number` for `deltaMinutes`/`period`/`asOf`-numeric and guard handlers for both string and number inputs. Validate `deltaMinutes` is a nonzero **integer** before POST.
- **SFC hazard — event-order flakes:** assert mocked requests **by URL/method match** (`mock.calls.find(([url,init]) => url.includes(...) && init?.method==='POST')`), **never by call index** — first-screen `loadSettings` + balance reads fire ahead of the action POST, so positional assertions flake.
- **No backend change:** L5c touches `apps/web/**` only. Before claiming "won't trigger Build / no 142 impact," confirm the workflow path-filters don't include `apps/web/**` in the Build/deploy trigger (PR prefix is not evidence).

---

## 5. Review loop — ⬜ (per-card, gated)

Per the L0–L4 precedent, **happy-path adversarial passes miss codebase-fit and RBAC issues** — the review must hunt those specifically, not just "does the button click."

- **🔒 → ⬜ Adversarial sub-agent review, per card** (after each card is locally green; do not batch all three blind):
  - **Flatten check:** does the result panel route manual-adjust through the reasons-table? (must NOT). Does any card label a client preview as a "dry-run"? (must NOT for manual-adjust).
  - **RBAC / codebase-fit:** is every commit behind `adminForbidden` + the policy-enabled gate? Does the section use `shouldShowAdminSection`/`adminSectionBinding` (not a bespoke `v-if`)? Does `getOrgId` resolution stay server-side (card sends no `orgId`)?
  - **Failure-surface completeness:** every §3 code mapped; accrual fallback line present; `409`/`422`/`404` distinguished (not collapsed to "failed").
  - **Idempotency legibility:** `alreadyApplied` / `alreadyGranted` / `ALREADY_SET` each rendered as a no-op, not a zero-change blank.
  - **Test honesty:** assertions on real wire (body fields), by-type not by-index; not a vacuous mount.
- **⬜ Owner-review-fix rounds:** fold owner comments per card; re-run local vitest + `vue-tsc -b` after each round. Do not declare a card done until its regression test + the anchor-nav guard are green locally.

---

## 6. L5c dev + verification closeout MD — ⬜ (final L5c deliverable, AFTER the build)

After all three cards land and CI is green, write an **L5c development + verification closeout** `docs/development/attendance-annual-leave-admin-operations-dev-verification-<date>.md` recording: the per-card 口径 as built, the exact state refs/handlers/selectors shipped, the local-vitest + `vue-tsc -b` evidence, the anchor-nav 29→30 diff, notes of each card's preview→confirm→result flow, and an explicit **L6-readiness handoff** (what the staging smoke can now drive). **Scope note:** this is the **L5c slice** closeout, **not** the whole annual-leave engine's final capstone — the engine track (§0.4) only flips to ✅ after the **L6 staging smoke** passes. This MD is described here but is **NOT produced by this planning step** — it is the closing checklist item of the build.

---

## 7. Dependencies / gates

- **Upstream: ✅ UNBLOCKED.** Design-lock merged (`619fab564`); L5a (balance read) + L5b (policy config) on `main`; the three endpoints exist and are verified. Build branch fresh off `origin/main`.
- **🔒 Downstream (owner-run, NOT parallel): L6 staging smoke.** The L6 runbook is merged but **depends on L5c being merged + deployed** — it smokes the *buttons*. It is genuinely sequential, not parallel, because (a) it drives the three operation endpoints **through the UI** and (b) it must additionally exercise the **L1 year-end reaper** path `packages/core-backend/src/services/AttendanceExpiryService.ts` (lots with `expires_at <= now()` reaped + `annual_leave_expiry` event) by advancing time / triggering the scheduler — not just the plugin routes. L6 is owner-run on a **disposable single-member org** with a **staging-realm `attendance:admin` JWT** (a prod token 401s on staging), asserts **residue=0**, and is out of L5c scope. **Do not start L6 until L5c is merged and deployed.**

---

## 8. Effort estimate

| Workstream | Estimate |
|---|---|
| Shared scaffold (rail reg + anchor-nav bump + section shell + confirm panel + 2 result shapes + error mapper + policy gate) | 0.75–1.0 day |
| Card 1 — manual adjustment (client preview, confirm, idempotency, 7 codes, test) | 0.75 day |
| Card 2 — expiry backfill (server dry-run pattern, reasons table, test) | 0.5 day |
| Card 3 — accrual run (server dry-run reuse + period guardrail + alreadyGranted, test) | 0.75 day |
| Cross-cutting (typecheck, local vitest debug, web-guard, matrix, SFC-hazard hardening) | 0.5 day |
| Review loop (3× adversarial + owner-fix rounds) | 0.5–1.0 day |
| L5c dev+verification closeout MD | 0.25 day |
| **Total** | **~4–4.75 days** (one PR) |

---

## 9. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Flatten the 3 back-ends** (manual-adjust forced through reasons-table; client preview labelled "dry-run") | Med | High (contract-wrong UI) | §2.5 two result shapes; per-card review check; test (c) asserts reasons-as-map only on backfill/accrual |
| R2 | **Anchor-nav left half-counted** (one literal bumped, not both; or a 7th group added) | Med | High (web-guard red / wrong nav) | §2.2 bumps **both** 127 + 832, leaves `groupLabels` `toEqual` untouched; run guard locally |
| R3 | **Numeric `v-model` coercion** throws in a swallowed catch → silent no-op | Med | Med | `v-model.number` + handlers tolerate number+string; integer-nonzero validation on delta |
| R4 | **Position-based mock assertions flake** (loadSettings/balance fire first) | High | Med | assert by URL+method match, never by call index |
| R5 | **Accrual skipReasons missing fallback** (only 7 hardcoded; `UNKNOWN` bucket blank) | Med | Med | §2.6 default line; test (a) includes an `UNKNOWN` row |
| R6 | **policy-enabled gate over-reaches** (hard client block layered on server contract for adjust/backfill) | Low | Med | gate is informational hint for adjust/backfill; load-bearing only for accrual |
| R7 | **`vue-tsc --noEmit` false-green** on a cross-file union | Low | Med | mandate `vue-tsc -b` in §4 |
| R8 | **window.confirm reused** (not in-DOM; can't show a structured preview/restatement — unfit for this confirm flow) | Low | Med | §2.4 in-DOM `role="dialog"` confirm panel with restatement table + stable selector |
| R9 | **L6 started before L5c merged/deployed** | Low | Med | §7 marks L6 🔒 downstream; do not run until merged+deployed |

---

## 10. Consolidated TODO-checklist

**Shared scaffold (FIRST)**
- ⬜ S1 — rail: add `annualLeaveOperations` to `ATTENDANCE_ADMIN_SECTION_IDS` + nav label + append to existing `annual-leave` group `itemIds` (no new group)
- ⬜ S2 — anchor-nav spec: bump line 127 `toHaveLength(29)→30` AND line 832 `toBe(29)→30`; add label to `arrayContaining`; leave `groupLabels` `toEqual` untouched
- ⬜ S3 — SFC section shell after `annualLeavePolicy` (`shouldShowAdminSection`/`adminSectionBinding`/`.attendance__admin-section`, `tr` header)
- ⬜ S4 — shared in-DOM confirm panel (`role="dialog"`, restatement table, off-year extra-confirm slot, `[data-annual-ops-confirm]`) — NOT `window.confirm`
- ⬜ S5 — TWO result shapes: `renderReasonTable(map)` (backfill+accrual only) + manual-adjust before/after+applied/alreadyApplied panel
- ⬜ S6 — `annualOpsErrorLine(code,card)` shared mapper, per-card code sets, accrual default/fallback line
- ⬜ S7 — `annualOpsPolicyEnabled` proactive gate (hydrated via `loadSettings→applyAnnualPolicyToForm`); load-bearing for accrual, UX-only hint for adjust/backfill

**Card 1 — manual adjustment (client preview)**
- ⬜ C1.1 — state refs + client-preview computed off L5a balance read
- ⬜ C1.2 — preview/request/submit handlers; idempotencyKey surfacing; 422-final note
- ⬜ C1.3 — template + 6 failure codes (runId/RUN_NOT_FOUND scoped out of v1) + alreadyApplied/409 wording + surface returned adjustment `id`
- ⬜ C1.4 — regression tests (commit / replay / insufficient / 409 / disabled), assert-by-type

**Card 2 — expiry backfill (server dry-run)**
- ⬜ C2.1 — state refs; dry-run-default + commit handlers
- ⬜ C2.2 — reasons code→count table; ALREADY_SET-as-no-op framing
- ⬜ C2.3 — regression tests (dry-run table / commit dryRun:false / reasons-as-map / disabled)

**Card 3 — accrual run (server dry-run + guardrail)**
- ⬜ C3.1 — state refs incl off-year computed; dry-run + commit handlers
- ⬜ C3.2 — period soft-warn + extra confirm (拍板 C, no hard block); alreadyGranted surface + link to Card 1
- ⬜ C3.3 — skipReasons table incl UNKNOWN fallback; `ANNUAL_LEAVE_NOT_ENABLED` gate
- ⬜ C3.4 — regression tests (dry-run+UNKNOWN row / commit / off-year extra-confirm / not-enabled)

**Cross-cutting**
- ⬜ X1 — `vue-tsc -b` green (not `--noEmit`)
- ⬜ X2 — local vitest green: regressions + anchor-nav specs
- ⬜ X3 — attendance-web-guard green; SFC hazards (numeric coercion, assert-by-type) hardened
- ⬜ X4 — attendance-web-guard green on Node 20.x (the single pinned version); path-filter check (apps/web-only)

**Review + close**
- 🔒 R1 — adversarial sub-agent review per card (flatten / RBAC / failure-surface / idempotency-legibility / test-honesty) — gated on each card local-green
- ⬜ R2 — owner-review-fix rounds folded, re-verified
- ⬜ M1 — L5c dev+verification CLOSEOUT MD (built 口径 + evidence + L6-readiness handoff; NOT the whole-engine capstone — engine ✅ awaits L6)

**Dependencies**
- ✅ G0 — upstream unblocked (design-lock merged, L5a/L5b on main, endpoints verified)
- 🔒 G1 — **L6 staging smoke (owner-run, downstream): DEPENDS on L5c merged + deployed; also drives the L1 reaper (`AttendanceExpiryService`); residue=0; staging-realm JWT + disposable single-member org. NOT parallel — do not start until L5c ships.**

Plan authority: `docs/development/attendance-annual-leave-admin-operations-design-lock-20260617.md` (拍板 A/B/C + the 5 dimensions). All file:symbol targets verified against `origin/main` @ `619fab564`.