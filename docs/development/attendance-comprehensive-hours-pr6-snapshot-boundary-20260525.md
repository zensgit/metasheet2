# Comprehensive-Hours PR6 — Reporting Snapshot Boundary Contract — 2026-05-25

**Status:** boundary contract (docs-only). This document does **not** decide product
shape and does **not** implement a writer. It locks the boundaries that any future
comprehensive-hours PR6 implementation must hold, expressed as forward commitments
against the report-records snapshot substrate that **already exists** in
`plugins/plugin-attendance/index.cjs`.

**This is not a product plan.** It does not decide what the report page looks like,
which multitable view is used, which metrics are surfaced first, or whether a new UI
entry is added. Those are listed as Open Questions (§7) and require a separate opt-in.

**Reading note — doc-PR vs PR6-impl.** Every "Hard Boundary" below (no writer / no
migration / no `meta_*` write / etc.) is *trivially* satisfied by this docs-only PR —
it changes one Markdown file. The boundaries are **forward commitments for the PR6
implementation**, if and when it lands. A reviewer should not check `migrations/` for
evidence in *this* PR; the evidence gate applies to the future impl PR.

---

## 1. Scope

Lock the boundaries for comprehensive-hours PR6: surfacing the comprehensive-hours
computed metrics (the aggregate produced by the PR0–PR5 preview/control chain) into
the **existing** attendance report-records snapshot, for read-only multitable analysis.

- Docs-only. No runtime change in this PR.
- In scope: the data-flow lock, the inheritance relationship to the existing snapshot
  machinery, the only genuinely-new surface (a comprehensive-hours field-catalog
  category), the sync-semantics that must not be weakened, and the test matrix that a
  future impl PR must satisfy.
- Out of scope: writer implementation, migrations, UI, report layout, metric
  prioritization (see §7).

---

## 2. Substrate that already exists (the premise)

The "reporting / multitable snapshot" mechanism is **already shipped** (report-records
sync track, dev docs dated 2026-05-16…19). PR6 must **extend** it, not fork a parallel
channel. Verified against `plugins/plugin-attendance/index.cjs` at `74b736722`:

| Capability | Where (verified) |
| --- | --- |
| Private daily snapshot object `attendance_report_records` | descriptor `index.cjs:1999` (`getAttendanceReportRecordsDescriptor`), object id const `:1985` |
| Private period snapshot object `attendance_report_period_summaries` | fields const `:2125`, boundary discipline stated in the comment `:2120-2123` |
| Snapshot producers | `syncAttendanceReportRecords` `:2427`; `syncAttendanceReportPeriodSummary` `:3509` |
| Sync routes (admin-only) | `POST /api/attendance/report-records/sync` `:27454`; `POST /api/attendance/report-period-summaries/sync` `:27552` |
| Admin-managed value-field catalog | `attendance_report_field_catalog` object `:338`; categories seed `ATTENDANCE_REPORT_FIELD_CATEGORIES` `:361` |
| Dynamic value-columns built from the catalog | `buildAttendanceReportRecordsValueColumns(catalog.items)` (def `:2286`) then `ensureObject({ fields: [...base, ...valueColumns] })` call site `:2453-2457` |
| Governance fields (daily) | `row_key`, `field_fingerprint`, `source_fingerprint`, `synced_at` `:1986-1996` |
| Governance fields (period) | same trio + period dimension `period_type`/`period_key`/`cycle_id`/`period_name`/`period_start`/`period_end` `:2125-2136` |
| Source fingerprint (excludes volatile fields) | `buildAttendanceReportRecordSourceFingerprint` excludes `syncedAt`/`fieldFingerprint`/`sourceFingerprint`, SHA1 of canonical JSON `:2397-2408` |
| Field-config fingerprint | `buildAttendanceReportFieldConfig(...).fieldsFingerprint` `:2449-2450` |
| Idempotency (row-key + fingerprint skip) | row key `${orgId}:${userId}:${workDate}` `:2303`; unchanged → skip `:2549-2551` |
| Degraded handling (no hard fail) | early-return `{ degraded: true, reason: ensured.reason, …empty }` `:2435` and `reason: 'MULTITABLE_RECORDS_API_UNAVAILABLE'` `:2440`; route returns `ok:true, degraded:true, synced:0` `:27524` |
| Duplicate row-key detection | `:2544-2545` |
| Stale-null for disabled fields | "managed but not active → null (stale clear)" `:2519` |
| Retry / resumable cursor | migration `zzzz20260519070000_create_plugin_attendance_report_sync_jobs.ts`; idempotency unique index `:66-70` |
| Documented boundary (sole fact source) | `docs/development/attendance-report-records-sync-pr3-development-20260516.md:17` + descriptor description `index.cjs:2003` |

**The only thing that does NOT yet exist:** a comprehensive-hours category in the
field catalog. Categories today are `fixed / basic / attendance / anomaly / leave /
overtime` (`:361-368`); there is no `comprehensive_hours`. Comprehensive-hours code
today is preview/enforcement only (`:11687`, `:26696`) — its computed values do **not**
flow into the snapshot. That gap is exactly what PR6 closes.

---

## 3. Hard Boundaries (forward commitments for PR6 impl)

PR6 implementation, when it lands, MUST hold all of these:

1. **No new writer.** Reuse `syncAttendanceReportRecords` / `syncAttendanceReportPeriodSummary`. Forbid any new producer function (e.g. `sync*Comprehensive*`) that writes the snapshot on a separate path.
2. **No new migration at all.** This covers `attendance_*` fact tables, plugin operational tables, report/snapshot tables, and any other DB migration — none are in PR6's scope unless authorized by a separate explicit opt-in. The extend-existing scope does not require one: comprehensive-hours facts already live in `attendance_*` (PR6 only reads them), and catalog entries + value columns are created via multitable provisioning, not SQL.
3. **No raw `meta_*` write.** All snapshot writes go through `context.api.multitable.provisioning.*` and `context.api.multitable.records.*`, exactly as the existing producer does (`:2540`, `:2553`).
4. **Snapshot is a rebuildable projection, never a second fact source.** `attendance_*` remains the sole source of truth; the snapshot may be dropped and rebuilt from facts with no data loss.
5. **Attendance compute logic must not read from the report snapshot.** Data flow is strictly unidirectional: `attendance_* fact/calculator → snapshot producer → private multitable object → read-only analysis`. No comprehensive-hours computation may read its own snapshot back (forbids a snapshot-backed compute cache).
6. **No multitable-as-input.** Multitable is never an upstream input to attendance facts.
7. **No K3 / Data Factory / integration-core touch.** PR6 stays in the attendance kernel-polish lane.
8. **No final UI / report layout / field-presentation decision.** PR6 impl adds catalog entries + value plumbing only. Presentation is a later, separate opt-in (§7).

---

## 4. Data Contract

**Inherit, do not redefine.** The five governance/identity guarantees already exist;
PR6 inherits them verbatim and adds only value-fields.

- **Daily** rows keyed by `row_key = ${orgId}:${userId}:${workDate}` (`:2303`), carrying `field_fingerprint` + `source_fingerprint` + `synced_at` (`:1986-1996`).
- **Period** rows keyed by the period dimension (`period_type`/`period_key`/`cycle_id`/…) (`:2125-2136`) — relevant if comprehensive-hours is surfaced at period granularity.
- **The only new surface:** a comprehensive-hours **category** in `ATTENDANCE_REPORT_FIELD_CATEGORIES` (`:361`) plus catalog entries for the comprehensive-hours computed metrics. These ride the existing dynamic value-column path (`buildAttendanceReportRecordsValueColumns` def `:2286`, call `:2453`) — no new schema field is hand-coded into the descriptor.
- Catalog entries reuse the existing option vocabularies: `source ∈ {system, dingtalk, multitable, custom}` (`:370`), `unit ∈ {text, dateTime, days, minutes, count, hours}` (`:371`). Comprehensive-hours metrics are `source: 'system'` with units from this set.
- **Value-field naming is by category, not product form.** This doc commits to "comprehensive-hours computed metrics belong to a dedicated catalog category"; it does **not** enumerate or freeze the specific metric set, labels, or which are `reportVisible` (those are Open Questions).
- The comprehensive-hours values MUST be included in `source_fingerprint` (so a change in computed hours re-syncs the row) and MUST NOT include volatile fields (`synced_at`, the fingerprints themselves) — i.e. they follow the existing exclusion rule at `:2398-2402`.

---

## 5. Sync Semantics (inherited; must not weaken)

PR6 MUST ride the existing semantics, not re-implement or relax them:

| Semantic | Existing behavior PR6 inherits | Verified |
| --- | --- | --- |
| Idempotency | unchanged source+field fingerprint → skip | `:2549-2551` |
| Fingerprint excludes volatile | `syncedAt`/fingerprints excluded from SHA1 | `:2398-2408` |
| Degraded | multitable unavailable → `degraded:true`, `synced:0`, request still `ok` | `:2435`, `:27524` |
| Duplicate row-key | counted + reported, not silently merged | `:2544-2545` |
| Stale-null | disabled catalog field → value cleared to `null` | `:2518-2523` |
| Resumable retry | sync-job cursor + idempotency unique index | `zzzz20260519070000` |

If a comprehensive-hours metric is disabled in the catalog, its column MUST stale-null
exactly like any other value-field — no special-case retention.

---

## 6. Test Matrix (boundary → enforcement mechanism → test)

Enforcement mechanism is stated honestly: `integration test` (real wire), `guard test`
(asserts a structural invariant), `unit test`, or `review checklist` (cannot be
mechanized). Where the only enforcement is review, it says so.

| # | Boundary / property | Enforcement mechanism | Test the impl PR must add |
| --- | --- | --- | --- |
| T1 | Comprehensive-hours value round-trips through the real sync wire | **integration test** | Sync a row with a known comprehensive-hours metric; query the multitable record back; assert the value column is present and equal. Guards the field-copy / whitelist drift class (`[[skip-when-unreachable-blind-spot]]`). |
| T2 | Test must not pass when the stack/multitable is unreachable | **integration test (no early-return)** | Assert the test fails (not skips/returns) if `baseUrl`/multitable is down — no "skip-when-unreachable" green. |
| T3 | Comprehensive-hours value is included in `source_fingerprint`; volatile fields excluded | **unit test** | Changing a comprehensive-hours computed value changes `source_fingerprint`; changing only `synced_at` does not. |
| T4 | Disabled comprehensive-hours field stale-nulls | **integration test** | Disable the catalog entry → re-sync → column is `null`, not stale value. |
| T5 | No parallel producer introduced | **guard test** | Assert no exported function name matching `sync.*[Cc]omprehensive` writes the snapshot outside `syncAttendanceReportRecords`/`syncAttendanceReportPeriodSummary`. |
| T6 | No new migration (any table); no raw `meta_*` write | **review checklist** (no CI grep wired in this track) | Reviewer confirms the impl PR's `migrations/` diff is empty (no `attendance_*` fact table, no plugin operational table, no report/snapshot table, no migration of any kind absent a separate opt-in) and all writes go via `context.api.multitable.*`. Honest note: this is review-enforced, not machine-enforced, unless a CI guard is added as a separate decision. |
| T7 | Private-object-only: snapshot lands in the org's private attendance report project, admin-gated | **integration test** | Assert the synced object resolves under `getAttendanceReportFieldProjectId(orgId)` (`:1056`) and the route requires `attendance:admin` (`:27455`). |
| T8 | Attendance compute does not read the snapshot | **review checklist** | Reviewer confirms no comprehensive-hours calculator imports/reads the report object. Hard to mechanize; flagged as review-only. |
| T9 | Degraded does not hard-fail | **integration test** | Multitable-unavailable path returns `ok:true, degraded:true, synced:0`. |

---

## 7. Open Questions (NOT decided here; each needs a separate opt-in)

- What the report page looks like; whether a new UI entry is added at all.
- Which multitable view/layout presents comprehensive-hours metrics.
- Which comprehensive-hours metrics are surfaced first, their labels, and which are `reportVisible`.
- Granularity: daily (`attendance_report_records`) vs period (`attendance_report_period_summaries`) vs both.
- **Endpoint shape** — the existing routes already accept `allUsers` / `userIds[]` / `page` / `pageSize` (`:27454+`), so the open question is *not* "support batch/allUsers" (already supported) but: ride the existing generic sync routes vs expose a comprehensive-hours-specific endpoint/UI.
- Whether comprehensive-hours reporting binds to a payroll cycle (the period-summary route already accepts `cycleId` `:27552+` — same reframe: reuse vs new surface).

---

## 8. Cross-references

- `[[attendance-multitable-report-boundary]]` — attendance computes facts → private multitable report object → multitable analyzes; never reverse.
- `[[k3-poc-stage1-lock-no-new-fronts]]` — PR6 stays kernel-polish; no new front.
- `[[staged-opt-in-lineage]]` — this doc is one link; the PR6 impl is a separate opt-in.
- `[[skip-when-unreachable-blind-spot]]` — wire-vs-fixture drift + skip-when-unreachable, addressed by T1/T2/T4.
- `docs/development/attendance-report-records-sync-pr3-development-20260516.md` — the existing snapshot substrate PR6 extends.
- `docs/development/attendance-comprehensive-hours-pr0-pr5-closeout-20260523.md` — the chain whose computed metrics PR6 would surface.

---

## 9. Boundary reaffirmation (this PR)

- ❌ No runtime code, no migration, no `meta_*`, no `attendance_*` change in this PR.
- ❌ No product/UI/layout decision made.
- ✅ Single new Markdown file; all citations verified against `index.cjs` at `74b736722`.
- ✅ PR6 implementation remains explicitly deferred behind a separate opt-in.
