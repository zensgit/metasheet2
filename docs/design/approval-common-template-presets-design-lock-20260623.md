# Common Approval Template Presets — Design Lock

Status: RATIFIED + IMPLEMENTED IN PR

Grounding: origin/main after the detail/sub-form and complex-graph authoring arcs. The approval
authoring surface can now edit linear approval steps, detail fields, org-derived assignee sources,
and load-preserve complex graphs. This slice adds a common-template starting point; it does not add
new runtime semantics.

## Decisions

1. Presets create drafts only.

   Selecting a preset calls the existing template-create API and lands the user in the normal edit
   page. It never publishes automatically and never bypasses the existing
   `approval-templates:manage` gate.

2. V1 presets are linear and fully editable.

   The first presets are `leave`, `reimbursement`, and `purchase`. They intentionally use linear
   approval graphs so the existing authoring UI can edit every approval step. Complex conditional
   or parallel variants are future presets, not hidden in this first slice.

3. Presets prefer portable assignee sources.

   The shipped presets use existing org-derived/user-field sources such as direct manager,
   department head, manager-at-level, and form user fields. They do not assume tenant-specific role
   ids exist.

4. The preset catalog is static product UI, not a new backend catalog.

   No table, migration, seed job, or vendor-specific import is introduced. A future editable/admin
   preset catalog can be designed separately if needed.

5. No approval-result writeback.

   These presets define approval forms and approval graphs only. They do not unlock W7 or any
   record/table write-back behavior.

## Verification Contract

- Preset payloads must round-trip through the existing authoring helpers as editable linear drafts.
- The purchase preset must prove the first user-field approver references an actual `user` field.
- The mounted authoring page must prove the preset button calls the existing create wrapper and does
  not call publish.
- Approval web guard must run the preset tests because the main PR gate does not run web vitest by
  default.
