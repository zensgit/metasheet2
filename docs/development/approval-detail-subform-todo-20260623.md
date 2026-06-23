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

## Phase C-3 — UI (the form-schema stability point for complex-graph node UI)
### C-3a — read-path ✅ (shipped #3090, squash c330dfb03)
- ✅ Read path: the instance read DTO `UnifiedApprovalDTO` now carries `formSchema?: FormSchema | null`,
  resolved from the instance's pinned **frozen** template version (`getApproval` reads
  `approval_template_versions.form_schema`) so the detail view renders against frozen columns, not
  the live template (closes design-lock Fact B). Real-DB read round-trip test.
### C-3b — author + fill + detail view ✅ (this PR)
- ✅ Template author: configure detail `columns` (reuse leaf-field authoring + `AUTHORABLE_FIELD_TYPES`,
  which now includes `detail`; sub-field type restricted to `DETAIL_LEAF_FIELD_TYPES` so the picker
  can never offer `detail`) + minRows/maxRows inputs in `TemplateAuthoringView.vue`. `buildFormSchema`
  emits `columns`/`minRows`/`maxRows` (and deletes them when a field is no longer a `detail`);
  `draftFromTemplate` hydrates them (round-trip). `validateTemplateDraft` mirrors the backend
  `normalizeDetailFieldParts` reject-set client-side (non-empty leaf-only unique-id columns, no
  nesting, minRows ≤ maxRows non-negative ints).
- ✅ Fill view: `detail` editable `el-table` branch in `ApprovalNewView.vue` (add/remove row;
  per-cell leaf editor per column type; respects minRows/maxRows — add disabled at maxRows, remove
  disabled at minRows). `formData[field.id]` is the row array (init `[]`); only DEFINED column keys
  are emitted (no unknown sub-keys); backend re-validates row count / required / per-cell types.
- ✅ Detail view: read-only `el-table` in `ApprovalDetailView.vue` driven by the FROZEN
  `approval.formSchema` columns (replaces the `formatFieldValue` JSON-stringify fallback for
  `detail`; falls back to stringify when formSchema/columns absent or value is not an array).
- ✅ Pure (Element-Plus-free) logic extracted to `approvals/detailField.ts` (frozen-schema render,
  fill-row seeding, column-draft validation, round-trip) so it is vitest-testable without Element Plus.
- ✅ FE tests (36): `approval-detail-field.test.ts` (25 — render-from-frozen-snapshot, leaf guard,
  fill seeding, column validation, round-trip) + `approval-template-authoring-detail.test.ts` (11 —
  buildFormSchema detail emit/delete, validateTemplateDraft detail branch, draftFromTemplate hydrate).
  Wired into CI via `approval-web-guard.yml` (the main gate runs only core-backend vitest + a web
  build, so without this guard the FE specs would never run).

## Phase C-4 — cross-row summary sub-field (🔒 OPTIONAL — only if owner-decision (d) = v1 must)
- 🔒 Read-only computed cell (e.g. `sum(items[].price)`) — a leaf "summary" sub-field; design
  its own mini-lock first. Deferred by default.

## Out of scope (v1 — reopen-only, see design-lock §7)
- 🔒 Detail-in-detail nesting · cross-row formulas (beyond C-4) · flattened CSV/Excel export ·
  per-node field permissions / read-time redaction (gated P1-C) · `attachment` sub-fields ·
  W7 write-back of detail (own scope-gate doc).
