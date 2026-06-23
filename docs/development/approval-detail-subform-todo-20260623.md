# Approval detail / sub-form (明细/子表单) — gated TODO

> Date: 2026-06-23 · Status: **TRACKER** · 配套设计锁:
> `docs/design/approval-detail-subform-design-lock-20260623.md`
> 标记:✅ done · ⬜ todo(opt-in 后可动手)· 🔒 gated(被决策/前置阻塞)
> 纪律:每个 phase 独立 opt-in(staged-lineage)。设计锁未 ACCEPT 前,C-1..C-3 全部 🔒。

## Phase D — design-lock
- ✅ Design-lock doc landed (#3082).
- ✅ Decisions finalized via §8 defaults (a–e) under the /goal autonomy directive
  (owner-override-welcome). **C-1 unblocked.**

## Phase C-1 — contract (⬜ — D accepted via §8 defaults; not wired to runtime)
- ⬜ `FormFieldType += 'detail'` in FE (`types/approval.ts`) + BE (`approval-product.ts`) +
  server allow-list `FORM_FIELD_TYPES` (`ApprovalProductService.ts:261`).
- ⬜ Sub-schema types: `DetailColumn` (leaf-only) + `minRows`/`maxRows` on the detail field.
- ⬜ Author-time schema validation in `normalizeFormField`/`assertFormSchema`: non-empty
  `columns`; each sub-field a valid **leaf** type (reject `detail` = no nesting, reject
  unknown); sub-field id uniqueness within the group; `minRows ≤ maxRows`; reject a
  `form_field_user` source pointing at a sub-field (assignee sources top-level-only); reject a
  sub-field `visibilityRule` crossing row scope or a top-level rule targeting a `detail`.
- ⬜ Frozen-columns read shape (§5) defined in the contract (version `form_schema` or a
  projected `detailColumns` on the instance read DTO).
- ⬜ Contract + OpenAPI-parity tests; **no createApproval/runtime wiring**.

## Phase C-2 — runtime (🔒 until C-1 merged)
- 🔒 Submit-time row validation: extend `validateApprovalFormData`/`validateFieldType`/
  `validateFieldConstraints` to recurse into rows (array → row count → required cells → per-cell
  leaf validation; unknown sub-keys fail-closed; row-addressed error messages).
- 🔒 Freeze the row array into `form_snapshot` (no new column).
- 🔒 Per-row `visibilityRule`: extend `pruneHiddenFormData` to drop hidden cells per row
  **on write** (never frozen). No read-time masking.
- 🔒 Read path surfaces the **frozen** detail columns from the template version (close Fact B).
- 🔒 Real-DB tests: submit→freeze→read round-trip; required-row reject (400);
  hidden-cell pruned-not-frozen; frozen-columns-survive-template-change.

## Phase C-3 — UI (🔒 until C-2 merged; the form-schema stability point for complex-graph node UI)
- 🔒 Template author: configure detail `columns` (reuse leaf-field authoring +
  `AUTHORABLE_FIELD_TYPES`) in `TemplateAuthoringView.vue`.
- 🔒 Fill view: `detail → DetailTable` editable branch in `ApprovalNewView.vue` (add/remove
  row; per-cell leaf editor; inline validation; per-row visibility).
- 🔒 Detail view: read-only `DetailTable` in `ApprovalDetailView.vue` driven by frozen columns
  (replaces the `formatFieldValue` JSON-stringify fallback for `detail`).
- 🔒 FE tests: author round-trip, fill validation, render-from-frozen-snapshot.

## Phase C-4 — cross-row summary sub-field (🔒 OPTIONAL — only if owner-decision (d) = v1 must)
- 🔒 Read-only computed cell (e.g. `sum(items[].price)`) — a leaf "summary" sub-field; design
  its own mini-lock first. Deferred by default.

## Out of scope (v1 — reopen-only, see design-lock §7)
- 🔒 Detail-in-detail nesting · cross-row formulas (beyond C-4) · flattened CSV/Excel export ·
  per-node field permissions / read-time redaction (gated P1-C) · `attachment` sub-fields ·
  W7 write-back of detail (own scope-gate doc).
