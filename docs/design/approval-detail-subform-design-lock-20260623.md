# Design-lock: Approval detail / sub-form fields (明细/子表单)

**Status:** PROPOSED (owner-sequenced 2026-06-22 via /goal — "先做设计锁"). The first and
most visible gap vs mainstream approval products: an approval form cannot carry a
**repeatable line-items group** (e.g. a purchase request with N rows, each product / qty /
price). This locks the field model, submission shape, snapshot + hidden-field rules, detail
display, and read/export boundary, then phases contract → runtime → UI as separate opt-ins.
Brand-neutral: benchmarked against external OA / mainstream approval platforms; no vendor
names in code or docs.

Grounded in code (3-explorer verified, 2026-06-23):
- Field model — `FormFieldType` (9 types) + `FormField` in `apps/web/src/types/approval.ts`
  and `packages/core-backend/src/types/approval-product.ts:54`; server type allow-list
  `FORM_FIELD_TYPES` (`ApprovalProductService.ts:261`).
- Schema persistence — `approval_template_versions.form_schema` JSONB (**immutable per
  version**, `UNIQUE(template_id, version)`); `approval_published_definitions` stores only
  `runtime_graph` (NOT a schema copy); an instance pins `template_version_id`.
- Author-time validation — `assertFormSchema` / `normalizeFormField` (`ApprovalProductService.ts:468–542`).
- Submit + freeze — `createApproval` (`ApprovalProductService.ts:2463–2639`): `pruneHiddenFormData`
  → `validateApprovalFormData` (`ApprovalGraphExecutor.ts:311–457`) → `form_snapshot` JSONB.
- Display — fill-form type→component map `ApprovalNewView.vue` (9 + fallback); detail view
  `ApprovalDetailView.vue` stringifies (`formatFieldValue`). Read DTO `UnifiedApprovalDTO`
  (`GET /api/approvals/:id`) carries `formSnapshot` **values only — no schema**.

## 0. Problem + two facts the design must respect
- Today a form is a flat list of scalar fields; there is **no repeatable container** (no
  `children`/`rows`/`items` on `FormField`) — clean greenfield, nothing to conflict with.
- **Fact A — there is NO field redaction (the "P1-C" surface is gated/unimplemented).**
  Hidden fields use a data-driven `visibilityRule` (`eq|neq|in|isEmpty|notEmpty`);
  `pruneHiddenFormData` drops hidden values **on write** before validation + freeze; there is
  **no read-time masking**. Detail reuses THIS mechanism, not an invented redaction layer.
- **Fact B — the instance read DTO does not carry the formSchema** (the FE fetches it
  separately, today from the *live* template). Detail rows only render correctly against the
  **frozen** columns, so the read path must surface the frozen detail columns (§5).

## 1. Field model
- New `FormFieldType` member **`detail`** (top-level only) — added to the FE union, the BE
  union, and the server `FORM_FIELD_TYPES` allow-list. Shape extends `FormField`:
  ```jsonc
  {
    "id": "items", "type": "detail", "label": "明细", "required": true,
    "minRows": 1, "maxRows": 200,          // optional; maxRows = v1 hard ceiling (§7)
    "columns": [                            // ordered leaf sub-fields = the row schema
      { "id": "product", "type": "text",   "label": "品名", "required": true },
      { "id": "qty",     "type": "number", "label": "数量", "required": true },
      { "id": "price",   "type": "number", "label": "单价" }
    ]
  }
  ```
- **Sub-field (`columns[]`) = leaf types only.** v1 authorable leaf set = the **8 authorable
  scalar types** (`text, textarea, number, date, datetime, select, multi-select, user` —
  i.e. `AUTHORABLE_FIELD_TYPES`, which already excludes `attachment`), and never `detail`
  (no nesting). Sub-field constraints (min/max/pattern) ride the existing `props` bag
  (already read by `getFieldPropNumber`/`getFieldPropString` for leaf validation) — no new
  per-field knobs invented.
- Sub-field ids unique **within** their group; value path is `items[].product`.
- A sub-field may carry its own `visibilityRule`, evaluated **per row** (§3); its `fieldId`
  resolves to a **same-row sub-field only**. A **top-level** field's rule may NOT target a
  `detail` field (array value → ill-defined). Both are rejected at author-time — the existing
  `normalizeFormFieldVisibilityRule` ("fieldId exists + no cycles") extends to the nested scope.
- **Sub-fields are NOT valid approver sources.** The `form_field_user` assignee source
  (`ApprovalAssigneeResolver` / `validateApprovalAssigneeSourcesAgainstFormSchema`) resolves a
  **single** user, but a `user` sub-field has N row-values → ambiguous. Author-time validation
  restricts `form_field_user.fieldId` to **top-level `user` fields**; the assignee picker never
  lists sub-fields. (Owner-decision (e).)

## 2. Submission data structure + two validation layers
- A `detail` value is an **array of row objects** keyed by sub-field id. `form_snapshot`
  already permits array values, so **no DB/DTO change for the data**:
  ```jsonc
  { "items": [ { "product": "A", "qty": 2, "price": 10 },
               { "product": "B", "qty": 1, "price": 99 } ] }
  ```
- **Author-time (schema) validation** — extend `normalizeFormField` / `assertFormSchema`: a
  `detail` must have a non-empty `columns` array; each sub-field is a valid leaf type (reject
  `detail` and unknown types — nesting blocked one level); sub-field ids unique within the
  group; `minRows ≤ maxRows`.
- **Submit-time (value) validation** — extend `validateApprovalFormData` /
  `validateFieldType` / `validateFieldConstraints`: the value is an array → row count within
  `minRows`/`maxRows` → each row's required sub-fields present → each cell through the SAME
  leaf `validateFieldType`/`validateFieldConstraints`. Unknown sub-keys rejected (fail-closed).
  Reuses the current error contract — `400 { error:{ code:"VALIDATION_ERROR", details:{
  errors: string[] } } }` — with row-addressed messages (`items[1].qty is required`).

## 3. Snapshot + hidden sub-fields (reuse existing mechanics)
- **Values freeze** into `form_snapshot` at `createApproval` (the detail value is the row
  array), exactly like scalar fields.
- **Column schema is frozen** via the **template version** (`approval_template_versions.form_schema`,
  immutable per version, pinned by the instance's `template_version_id`). Rendering MUST
  resolve detail `columns` from the **frozen version**, never the live template — else a later
  column rename/reorder/removal mis-renders frozen rows. (`published_definitions` holds only
  `runtime_graph`, so the version is the schema source.)
- **Hidden sub-fields:** a sub-field `visibilityRule` is evaluated **per row**, and
  `pruneHiddenFormData` extends to drop hidden **cells per row on write** (never entering the
  snapshot) — consistent with the current prune-on-write / no-read-masking model. No new
  redaction layer (would couple to the gated P1-C work — explicitly avoided).

## 4. Fill + detail display
- **Fill view** (`ApprovalNewView.vue` type→component map): add a `detail → DetailTable`
  editable branch — add/remove row; each cell reuses the existing leaf editor for its
  sub-field type; per-row required/type errors inline; sub-field `visibilityRule` hides cells live.
- **Detail view** (`ApprovalDetailView.vue`, today JSON-stringifies via `formatFieldValue`):
  add a read-only `DetailTable` (rows × columns) driven by the **frozen** version columns
  (§3), replacing the stringify fallback for `detail` values. Scalar rendering unchanged.

## 5. Read / export boundary
- **Read** (`GET /api/approvals/:id` → `UnifiedApprovalDTO`): values already travel in
  `formSnapshot` as a nested array. C-2 adds the **frozen detail columns** to the read
  (return the version's `form_schema`, or a projected `detailColumns`, with the instance) so
  any consumer renders the table without re-fetching — closing Fact B for detail.
- **No read-time masking** (consistent with the rest of the read path).
- **Flattened CSV/Excel export is a v1 NON-GOAL.** No approval export exists today, so v1
  builds none — the **structured read API is the boundary**. A repeatable group has no 1:1
  row mapping; true flattening (tall / wide / JSON-cell) is a later, separately-gated slice,
  decided once the field model is proven rather than over-fit up front.

## 6. Phasing (each a separate opt-in — staged-lineage discipline)
- **D · design-lock (this doc).** Owner review → accept.
- **C-1 · contract.** `FormFieldType += 'detail'` (FE + BE + `FORM_FIELD_TYPES`); sub-schema
  types; author-time schema validation (reject nesting / unknown sub-type / bad rows /
  min>max; reject a `form_field_user` source pointing at a sub-field; reject a visibilityRule
  that crosses row scope or targets a `detail`); the frozen-columns read shape (§5). Contract +
  OpenAPI-parity tests. **Not wired to runtime.**
- **C-2 · runtime.** `createApproval` submit-time row validation + freeze of the array;
  per-row `visibilityRule` prune-on-write; read exposes frozen columns. Real-DB tests:
  submit→freeze→read round-trip; required-row reject; hidden-cell pruned-not-frozen.
- **C-3 · UI.** Author configures `columns` (reusing leaf-field authoring + `AUTHORABLE_FIELD_TYPES`);
  requester fills the table; detail view renders read-only from frozen columns. FE tests:
  author round-trip, fill validation, render-from-frozen-snapshot.
- The **C-2→C-3 boundary is the form-schema stability point** the later complex-graph
  node-author UI phase waits on (goal sequencing: stabilize forms before graph-node authoring).

## 7. Boundaries / non-goals (v1 — all reopen-only)
- **No detail-in-detail** (one nesting level, enforced at author-time).
- **No cross-row aggregation / formulas** (sum of line totals, count) — owner-decision (d).
- **No flattened CSV/Excel export** (§5) — structured read API is the boundary.
- **No per-node field permissions / read-time redaction** (the gated P1-C surface) — detail
  uses only the existing data-driven `visibilityRule`.
- **No `attachment` sub-fields** in v1 (per-row file upload) — leaf set is the 8 authorable.
- **Sub-fields are not `form_field_user` approver sources** (ambiguous N-row value) — assignee
  sources stay top-level-only (§1).
- **No W7 write-back** of detail values (W7 stays behind its own scope-gate doc).
- `maxRows` is a hard ceiling (snapshot-size / DOS guard), not pagination.

## 8. Owner decisions needed (defaults chosen; flag to override)
- (a) v1 leaf sub-field types = the 8 `AUTHORABLE_FIELD_TYPES` (scalar, minus `attachment` +
  `detail`). Override if a narrower v1 set is wanted.
- (b) Export boundary = defer flattening; structured read API is the boundary (§5).
- (c) `maxRows` default ceiling (proposed **200**) + whether `minRows` authoring ships in C-3.
- (d) Cross-row sum/total = deferred by default. If line-item totals are a v1 must, it becomes
  a small **C-4 "summary sub-field"** slice (read-only computed cell) — confirm.
- (e) Sub-fields as approver sources = **not allowed** in v1 (default; `form_field_user` stays
  top-level-only, §1). Confirm, or name the disambiguation rule if row-sourced approvers are
  wanted later.
