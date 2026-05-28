# Data Factory Template Composition — execution plan + gated TODO (2026-05-27)

> Companion to `data-factory-template-composition-open-source-design-20260527.md` (the design).
> This file is the **execution ordering + trackable checklist**, not an authorization to build.
> Markers: ✅ done · ⬜ open / ready (still needs its own opt-in) · 🔒 gated (blocked on a prior gate AND a separate explicit opt-in).
>
> **Constraints (non-negotiable):** K3 PoC Stage-1 lock holds; every phase below is a **separate explicit opt-in** — never auto-start the next one. Any phase that edits `plugin-integration-core` (adapter or HTTP route), even no-write, is integration-core and gated like #1912. Formal docs state our own product principles, not external brand names (external benchmarking lives in internal research MDs).

## The one hard rule: payload trust before UI

**Make the payload trustworthy first; make the flow easier to understand second. The order cannot reverse.** A polished preview/help UX over a preview that does not equal the real Save body is worse than no preview — it is a blind Save with extra confidence. Today the preview path (`http-routes.cjs` `applyPreviewReferenceShape` / `projectRecordForTemplate`) is a **divergent duplicate** of the adapter Save composition (`applyReferenceShape` / `projectRecordForBody` / `buildSaveBody`), and #1912's fail-closed-placeholder + customer-preset live **only in the adapter**. So **DF-T1-0 (composition parity) is the gate that unlocks the whole track.**

This is also on the **live critical path**: the customer GATE (#1792) is stuck on reference-object payload composition (the 2nd Save-only failed-safe; #1928 is diagnosing). A trustworthy, byte-identical preview is the concrete unblock — it lets an operator verify the exact payload **before** a 3rd Save attempt instead of attempting blind.

## Current code anchors to verify before DF-T1-0

Re-check these paths at implementation time. They are the current source-of-truth
anchors this TODO is based on:

| Area | Current anchor | Why it matters |
|---|---|---|
| Preview route | `plugins/plugin-integration-core/lib/http-routes.cjs` `buildTemplatePreview()` | Existing no-write preview entrypoint; must not fork a parallel route. |
| Preview shaper copy | `http-routes.cjs` `applyPreviewReferenceShape()` / `projectRecordForTemplate()` | Known divergent duplicate that DF-T1-0 must remove or bypass for K3. |
| Real Save body | `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs` `buildSaveBody()` | Current adapter Save composition path. |
| Real Save projection | `k3-wise-webapi-adapter.cjs` `projectRecordForBody()` | Drops blanks and applies object config; preview must match this for K3. |
| Real Save reference shape | `k3-wise-webapi-adapter.cjs` `applyReferenceShape()` | Must be shared by preview or covered by parity tests. |
| Placeholder fail-closed | `k3-wise-webapi-adapter.cjs` `K3_WISE_PRESET_PLACEHOLDER_UNFILLED` | Preview must fail on the same unresolved placeholders. |
| Customer profile | `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs` | `material-k3wise-customer-profile-v1` stays explicit opt-in only. |
| Redaction | shared integration payload redaction helpers | Preview output and diagnostics must stay sanitized. |

Do not rely on stale local checkout line numbers. Use `origin/main` or the PR
branch under review when validating these anchors.

## Phase ladder (gated)

### ✅ DF-T0 — Contract / design (done)
- [x] Template layers defined; K3 = a built-in template package, not the product center.
- [x] Customer supplies/approves target fields; MetaSheet provides authoring/rules/validation/preview/redaction/evidence.
- [x] **Parity recorded as a hard prerequisite** (design §"K3 composition single source of truth").

### ✅ DF-T1-0 — K3 composition parity (DONE — PR #1936, squash `a10bb0d8c`, 2026-05-28)
The gate for everything else. **Shipped via seam B** (shared `lib/adapters/k3-save-body-composer.cjs`); owner review added 3 patches (P1 nested-path projection preserved, P2 reference-identifier `''` fallback, P2 placeholder code aligned).
- [x] **Converge composition to one source of truth** — seam **B**: `k3-save-body-composer.cjs` owns shaping/projection/placeholder-DETECTION; adapter `buildSaveBody` AND preview `buildTemplatePreview` both compose through it.
- [x] **Seam B chosen** (reviewer agreed).
- [x] Adapter public behavior byte-stable (k3-wise-adapters / presets / e2e / pipeline / http-routes all green).
- [x] **Parity test (preset):** preview payload ≡ adapter Save body for the `material-k3wise-customer-profile-v1` profile.
- [x] **Parity test (placeholder):** same `<…>` fails closed identically (Save throws `K3_WISE_PRESET_PLACEHOLDER_UNFILLED`, preview reports `valid:false` with the same code).
- [x] **Parity test (object passthrough):** `{FNumber,FName}` / `{FID,FName}` preserved verbatim both sides.
- [x] **No-write test:** preview composes with zero login/fetch/Submit/Audit/BOM/list/search.
- [x] **Opt-in test:** generic Material preview never auto-applies the customer profile.
- [x] **Grep gate** blocks a divergent shaper/projector copy reappearing.
- [x] No new write capability; no external call; integration-core (landed under explicit opt-in). Negative controls verified for every fix.

P1/P2 nuances carried forward: the composer uses `getPath/setPath` (nested-path schema like `nested.code` projects; flat K3 names unchanged → adapter parity holds); `normalizeReferenceIdentifier` treats `''` as absent and falls back to identifierField/key.

Implementation notes:

- Keep `http-routes.cjs` as the public preview route. DF-T1-0 changes what it
  calls for K3 composition; it does not add a new route.
- If the shared composer needs object config normalization, pass already
  normalized object config into it; do not make the composer own auth, HTTP,
  RBAC, or route concerns.
- Keep fail-closed placeholder scanning anchored and conservative. Values like
  `<M6>` inside a legitimate non-placeholder business field must not be
  over-matched unless the whole value is a bare sentinel.
- If the implementation cannot keep generic preview behavior byte-stable, split
  K3-specific parity into its own explicit preview mode instead of broadening
  all adapters accidentally. That mode must still call the DF-T1-0 shared
  composer or adapter dry-build seam; it must not introduce a third K3-specific
  shaper/projector.
- Keep shaping and completeness separate. The composer owns scalar wrapping and
  object passthrough. Readiness/completeness checks own requirements such as
  "must include both FNumber and FName"; do not make byte-parity tests imply
  that adapter Save composition enforces two-component completeness.

### ✅ DF-T1 — Target payload template preview (DONE — PR #1945, squash `9c780d90a`, 2026-05-28)
Shape B (legacy preview fields compatible; DF-T1 evidence under `targetPayloadPreview`, only when `payloadTemplate` is present). Owner review added 2 patches (P2-1 bodyKey reuses `normalizePreviewBodyKey` guard; P2-2 keeps legacy `transformErrors/validationErrors/schemaErrors` empty arrays).
- [x] Extended the **existing** `/api/integration/templates/preview` with `payloadTemplate` + `fieldRules` (no new route).
- [x] No-write merge `payloadTemplate + fieldRules + staging record → final payload`, composed **through the DF-T1-0 shared composer** (shaping via `applyReferenceShape`, detection via `findUnfilledPlaceholders`; no new shaper — grep-gated).
- [x] Whole-object `payloadTemplate` defaults preserved; rules replace only declared fields.
- [x] Fail-closed on unresolved placeholders (same `K3_WISE_PRESET_PLACEHOLDER_UNFILLED` code the Save throws; negative-controlled).
- [x] Zero external calls; output passes shared redaction (`redactionSelfCheck.clean`).
- [x] Evidence emitted: `eligibleForSaveOnly` / `unresolvedPlaceholders` / `unresolvedReferenceComponents` / `missingRequiredFields` / `fieldProvenance` / `redactionSelfCheck` / `compositionSource`.
- [x] bodyKey routed through `normalizePreviewBodyKey` (rejects `__proto__`/control chars); shape-vs-completeness layered (require-both = readiness, not Save-body). `k3-df-t1-target-payload-preview.test.cjs` covers all of the above.

Closeout-verified on `main`: targetPayloadPreview + legacy arrays present; bodyKey guard active; no-write/fail-closed/redaction/grep-gate tests in place.

### ✅ DF-T1.5 — Preview provenance display (DONE — 2026-05-28)
Read-only display over the `targetPayloadPreview.fieldProvenance` DF-T1 emits; no new runtime. Frontend-only (`IntegrationWorkbenchView.vue` panel + pure `summarizeFieldProvenance` helper in `workbench.ts`); shows field name + source badge + per-source stats, gated on fieldProvenance presence (legacy preview unaffected), **never raw payload values**. Verification: `data-factory-df-t1_5-preview-provenance-display-verification-20260528.md`.
- [x] Per-field provenance (staging / template / constant / reference-table), derived read-only from the DF-T1 merge.
- [x] No new persisted provenance runtime field in this slice.
- [x] **Reachability wired** (follow-up): the preview panel sends an optional `payloadTemplate` (+ derived `fieldRules`) so the DF-T1 backend returns `targetPayloadPreview` — the panel is live-triggerable, not just display-capable. Locks a request-body wire assertion. Verification: `data-factory-df-t1_5-reachability-wire-verification-20260528.md`.

### 🔒 DF-T1A — Connector action metadata
Gated on: DF-T1 + opt-in.
- [ ] Action metadata around existing adapter methods (no generic HTTP client / no user JS / no SQL / no new connector runtime).
- [ ] Inputs grouped `path` / `query` / `header` / `body`; response unwrap (success/error/record path).
- [ ] Save-only and write actions hidden/disabled unless their explicit gate is satisfied.

Minimum action contract:

- `actionId`
- `operation`: `read` / `preview` / `upsert` / `export`
- `inputGroups`: `path` / `query` / `header` / `body`
- `output`: `recordPath`, `successPath`, `errorPath`
- `safety`: `readOnly`, `allowBatch`, `maxRowsPreview`, `requiresApproval`
- `help`: current step, required evidence, locked boundaries

This contract wraps existing adapter methods first. It must not become a user
authored HTTP client in this phase.

### 🔒 DF-T2 — K3 customer-profile authoring surface
Gated on: DF-T1 (+ DF-T1.5 helpful) + opt-in; **and the live K3 GATE should have a proven Save** before investing heavily here (else risk reworking UX for a still-changing profile).
- [ ] Operator turns a sanitized `GetDetail` body sample into `payloadTemplate`.
- [ ] Operator chooses replace/preserve per field; validates full reference-object shapes.
- [ ] Shows why a row is not ready before Save. Customer profile stays opt-in; default template never silently switched.

### 🔒 DF-T3 — Multitable reference-mapping sheet templates
Gated on: DF-T2 + opt-in.
- [ ] "Create from template" for reference-mapping sheets (unit / unit-group / account / warehouse / category).
- [ ] Dictionary content stays customer-owned; manifest import/export without secrets.

### 🔒 DF-T4 — Pipeline template binding
Gated on: DF-T3 + opt-in.
- [ ] Bind connector + staging object + field mappings + target payload template into a pipeline template; persist version metadata.
- [ ] Dry-run mandatory before Save-only; record run provenance + row-level results.

### 🔒 DF-T5 — Template center
Gated on: DF-T4 + opt-in.
- [ ] Built-in + copied customer templates; non-secret manifest import/export; diff-before-apply; package verification markers.

### 🔒 DF-T6 — Contextual next-reading / help panel (LAST)
Gated on: a trustworthy preview path (DF-T1) + opt-in. **Comprehension polish — explicitly after payload is trustworthy.**
- [ ] Right-side help panel driven by template metadata (current step / required evidence / related setup / troubleshooting / locked boundaries / next reading).
- [ ] Read-only; never triggers actions or hides approval gates.
- [ ] Test: gated pages show Save-only boundaries and do **not** present Submit/Audit as available next actions.

## Cross-cutting invariants (every phase must hold)

- **Composition parity** — any surface that shows or builds a target payload composes through the DF-T1-0 single source of truth; preview ≡ Save (incl. fail-closed).
- **Trust model** — our preview must be byte-identical to what we will Save, fail-closed on mismatch. We write ERP master data; we cannot afford "approximate, will retry."
- No secrets in template manifests; relative endpoint paths only; no raw SQL editor; no user JavaScript transforms; no visual ETL canvas / arbitrary workflow engine.
- Preview + run details pass shared redaction.
- Save-only / Submit / Audit / BOM / list-search / pagination / production multi-record are **separate** approvals.
- Formal docs state our own principles, not external brand names.

## Flow-kernel governance backlog

These items borrow operating discipline from mature data-flow systems but should
stay mostly invisible to business users. They are not a separate product lane;
they are kernel hardening tasks that support the multitable-first Data Factory.

| Kernel concept | TODO | Earliest phase |
|---|---|---|
| Environment parameters | Add explicit parameter placeholders and runtime resolution metadata for connector profiles; never store secrets in template manifests. | DF-T1A / DF-T4 |
| Connection profile reuse | Make connector profile id visible in preview/run evidence. | DF-T1 / DF-N2-2 |
| Named action | Bind dataset templates to `actionId` instead of duplicating request semantics. | DF-T1A |
| Row work unit | Treat one staging row + one target payload as the unit of preview/run evidence. | DF-T1 |
| Row attributes | Preserve source row id, mapping version, template id, connector profile id, action id, and target object in redacted evidence. | DF-N2-2 |
| Failure route | Keep row failures in dead letters with code/message/retry state, not as whole-run aborts. | Existing / DF-N2-2 |
| Backpressure | Add explicit max-row and approval gates before broad Save-only expansion. | DF-T4+ |
| Replay safety | Manual single-row replay only unless idempotency and stop rules are proven. | Existing DF-N1.5 / future DF-N3 |

Do not build a general node graph, arbitrary scheduling surface, user-authored
processors, or streaming cluster in this track.

## Review checklist for every PR in this track

- [ ] States which phase it implements and which phases remain locked.
- [ ] Touches only the named files for that phase.
- [ ] Includes a negative control for each safety invariant it claims.
- [ ] Includes secret-shape / redaction verification if payloads or diagnostics
  are involved.
- [ ] Does not introduce external calls in no-write preview paths.
- [ ] Does not make Submit/Audit/BOM/list/search/pagination reachable.
- [ ] Does not introduce formal-doc dependency on external product names.
- [ ] Leaves customer dictionary values out of Git.

## Sequencing rule

One explicit opt-in per phase. Do not auto-start the next. **DF-T1-0 (#1936), DF-T1 (#1945), and DF-T1.5 (preview provenance display) are DONE.** The next step is a separate explicit opt-in — either **DF-N2-2 (provenance runtime)** or **DF-T1A (connector action metadata)**; everything below stays 🔒 until its predecessor gate is green and it is separately opted in.

## Definition of done — DF-T1-0 (the immediate gate)

- Preview and Save compose through one code path (seam A or B), proven by the two parity tests (preset + placeholder), green in CI.
- Object passthrough and scalar wrapping parity are covered by composer tests;
  required-component completeness, such as `FNumber + FName`, is covered by
  validation/readiness tests.
- If seam B: a grep/lint gate prevents re-introducing a parallel composer.
- No new write capability, no external call, no scope expansion; landed under an explicit integration-core opt-in (or folded into #1928's).
