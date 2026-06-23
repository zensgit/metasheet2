# Approval detail / sub-form (明细/子表单) — gated TODO

> Date: 2026-06-23 · Status: **TRACKER** · 配套设计锁:
> `docs/design/approval-detail-subform-design-lock-20260623.md`
> 标记:✅ done · ⬜ todo(opt-in 后可动手)· 🔒 gated(被决策/前置阻塞)
> 纪律:每个 phase 独立 opt-in(staged-lineage)。设计锁未 ACCEPT 前,C-1..C-3 全部 🔒。

## Phase D — design-lock
- ✅ Design-lock doc landed (#3082).
- ✅ Decisions finalized via §8 defaults (a–e) under the /goal autonomy directive
  (owner-override-welcome). **C-1 unblocked.**

## Phase C-1 — contract ✅ (shipped; types + author-time validation + tests; not wired to runtime)
- ✅ `FormFieldType += 'detail'` in FE (`types/approval.ts`) + BE (`approval-product.ts`) +
  server allow-list `FORM_FIELD_TYPES` + derived `DETAIL_LEAF_FIELD_TYPES`.
- ✅ Sub-schema: `columns?: FormField[]` (reused `FormField` for sub-fields) + `minRows?` / `maxRows?`.
- ✅ Author-time validation (`normalizeFormField` / `assertFormSchema` /
  `validateFormFieldVisibilityRules`): non-empty leaf-only columns (no nesting), unique sub-ids,
  `minRows ≤ maxRows` (non-negative ints), detail-only keys rejected on a non-detail field,
  top-level rule can't target a `detail`, sub-field rule stays in-group, and the
  `form_field_user`-can't-target-a-sub-field invariant (locked by test + a code comment).
- ✅ Contract tests (11) in `approval-product-service.test.ts` — 8 reject + assignee-source +
  negative-bound + accept round-trip (columns / minRows / maxRows + sibling rule preserved).
- ➡️ Frozen-columns READ shape (§5) folded into **C-2** (the instance read-DTO change *is* the
  runtime read path; the type-level contract — `columns` on the frozen formSchema — ships here).

## Phase C-2 — runtime ✅ (shipped; submit-time validation + per-row prune + freeze; not the read/UI)
- ✅ Submit-time row validation: `validateApprovalFormData` gains a `detail` branch →
  `validateDetailFieldValue` (array → minRows/maxRows → per-row required + leaf
  `validateFieldType`/`validateFieldConstraints`; row-addressed `items[i].cell` messages).
- ✅ Freeze: the row array rides `form_snapshot` (no new column) via the existing createApproval path.
- ✅ Per-row `visibilityRule`: `pruneHiddenFormData` drops hidden + unknown cells per row on
  write (recurses the same prune over each row). No read-time masking.
- ✅ Real-DB round-trip (`approval-detail-subform.db.test.ts`, wired into the approval PG lane +
  vitest no-DB exclude): columns JSONB round-trip on the version; submit→validate→prune→freeze
  into form_snapshot; invalid-row 400. + 8 unit tests. Whole approval lane green (10 files / 49).
- ➡️ Read path surfaces the **frozen** detail columns — folded into **C-3** (the renderer consumes
  them; exposing columns without a renderer is untestable/unused).

## Phase C-3 — UI (🔒 until C-2 merged; the form-schema stability point for complex-graph node UI)
- 🔒 Template author: configure detail `columns` (reuse leaf-field authoring +
  `AUTHORABLE_FIELD_TYPES`) in `TemplateAuthoringView.vue`.
- 🔒 Fill view: `detail → DetailTable` editable branch in `ApprovalNewView.vue` (add/remove
  row; per-cell leaf editor; inline validation; per-row visibility).
- 🔒 Read path (moved from C-2): expose the **frozen** detail `columns` on the instance read
  (the version's `form_schema` or a projected `detailColumns` on the read DTO) so the detail
  view renders from the frozen schema, not the live template (closes design-lock Fact B).
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
