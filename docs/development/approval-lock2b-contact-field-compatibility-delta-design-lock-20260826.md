# Approval Lock-2B contact-field compatibility delta design lock

Status: **PROPOSED - design only; no runtime authorization**  
Date: 2026-08-26  
Baseline: `origin/main@2162925cecb30e211affcc58096d8d50ec67e9b8`  
Parent: `approval-lock2-org-controls-field-routing-20260817.md` (RATIFIED)  
Scope: only the remaining L2-B `user`-field properties and their interaction with already-shipped field-derived assignee sources

## 0. Why this delta is required

The parent lock correctly identifies the shipped `user` field as the contact control and correctly requires one slice to carry both multi-value validation and assignee resolution. Three current-main facts make its L2-B text unsafe to implement literally:

1. **Legacy self-selection is currently allowed.** `ApprovalNewView.vue` mounts `ApprovalUserPicker` without filtering the requester, and the create path has no server-side self-selection check. The parent says absent `allowSelf` means `false` and also says absence preserves today's behavior. Those statements cannot both be true: interpreting every absent key as `false` would reject a request that current templates accept.
2. **A bounded UNION has no carrier.** The parent requires multi-valued field-derived approvers to use UNION and requires a publish-time `maxSelections` pin, but L2-B's listed `user` props omit `maxSelections`. Implementing `selection: 'multi'` as written would either create an unbounded approval-seat fan-out or make every routed multi-user field permanently unpublishable.
3. **L2-C is no longer wholly future work.** `form_field_user_manager` and `form_field_user_dept_head`, their create-frozen `fieldDerivedAssigneeIds`, and the defensive multi-field publish pin are already on main. L2-B therefore modifies shipped resolution code, not an unlanded sibling.

The delta changes no current behavior by itself. It replaces the contradictory portions of L2-B only after owner ratification. All unaffected Lock-2 decisions remain authoritative.

The supersession is exact, not a general reopening of Lock-2:

| Parent text | Delta disposition after ratification |
|---|---|
| L2-B: absent `allowSelf` is `false` and also preserves current behavior | replaced by §3.2: absence is the shipped legacy-allow state; only newly authored/retyped UI fields write explicit `false` |
| L2-B props list with no `maxSelections` | replaced by §3.1 and §3.3: multi requires the explicit bounded carrier |
| Gate B-1: absent and `false` both reject requester self-selection | replaced by G1-G3: absence accepts for compatibility, explicit `false` rejects, explicit `true` accepts |
| OD-L2-7 same-slice rule | retained; this delta supplies the missing field-aware array reader and direct-source UNION in that same slice |

OD-L2-4/5's required plus no-visibility retrofit remains authoritative for a direct `form_field_user` source at the next save/publish/restore. It is not retroactively applied to an already-published definition or an in-flight instance.

## 1. Current-main facts

| Fact | Current source of truth | Consequence |
|---|---|---|
| `user` values are single-valued | `ApprovalGraphExecutor.validateFieldType`; `ApprovalAssigneeResolver.resolveFormUserValue` | arrays are rejected at create and otherwise resolve to `null` |
| `user` props are free-form | `ApprovalProductService.normalizeFormField` generic props spread | a strict allowlist is a narrowing and needs the ratified persisted-corpus census |
| the participant picker is single-select and does not remove the requester | `ApprovalUserPicker.vue`; the `user` arm in `ApprovalNewView.vue` | absent `allowSelf` currently behaves as allowed, not denied |
| `form_field_user` consumes the selected contact directly | `ApprovalAssigneeResolver.resolveApprovalAssignees` | multi support must preserve all selected ids or reject the template before runtime |
| two contact-derived kinds are live | `ApprovalProductService.resolveAndFreezeFieldDerivedAssignees` | their existing `selection === 'multi'` publish pin remains load-bearing until their freeze supports arrays |
| the wire contract models non-record-link props as generic | `packages/openapi/src/base.yml` FormField discriminator | strict user props require either a new OpenAPI branch or an explicitly recorded generic-wire exception |
| top-level `user.defaultValue` already prefills | `ApprovalNewView.vue`; `prefillFromSnapshot.ts`; generic normalization | `defaultMode/defaultUserIds` cannot coexist as a second carrier without an explicit precedence and census |
| display and resubmit paths assume one user id | `detailField.ts:formatDisplayValue`; `prefillFromSnapshot.ts` | widening only create validation would leak raw ids and drop arrays on resubmit |
| conditions model `user` as scalar string | `ApprovalConditionFormula.formFieldTypeToFormulaType`; visibility evaluators | a multi-user field needs an explicit v1 operand policy; array/scalar equality cannot be inferred |

## 2. Scope and non-goals

This delta authorizes a later implementation PR to:

- add typed, canonical `user`-field props;
- preserve legacy self-selection while making newly authored fields default to self-selection disabled;
- add bounded multi-selection for form entry;
- apply the enhanced props to top-level `user` fields only in this v1 slice;
- resolve every selected contact for the shipped direct `form_field_user` assignee source;
- keep the two already-shipped contact-derived kinds fail-closed on multi fields until their create-freeze path is widened in a separate slice;
- add the persisted-props/default-carrier census and required CI gates;
- close viewer-facing raw-id rendering for both shipped single values and new multi values.

This delta does **not** authorize:

- the L2-A `department` field or `form_field_dept_head`;
- changing the global participant-directory authorization or organization scope;
- silently accepting inactive, unknown, or cross-organization user ids as a newly claimed capability;
- lifting the existing multi-field pin for `form_field_user_manager` or `form_field_user_dept_head`;
- adding multi/default/self-policy props to a `user` column nested inside `detail`;
- any deployment, feature-flag change, migration, or production census run.

The existing participant directory is global-active-user scoped. That is pre-existing behavior, not closed by this delta. Product parity must not claim organization-scoped contact selection until a separately ratified directory-scoping contract lands.

Nested `detail` user columns keep their shipped single-value picker and free-form historical props behavior in this slice. Treating top-level and nested carriers as one change would multiply the payload bound by `detail.maxRows`, require per-row default semantics, and change `FormFieldDetailLeaf`'s separate OpenAPI contract. That is a distinct, measured follow-up rather than an implicit side effect of top-level L2-B.

## 3. Canonical L2-B contract

### 3.1 Typed props

The allowed top-level `user` props are:

```ts
interface ApprovalUserFieldProps {
  allowSelf?: boolean
  selection?: 'single' | 'multi'
  maxSelections?: number
  defaultMode?: 'requester' | 'designated'
  defaultUserIds?: string[]
}
```

For a top-level `user` field, no residual spread is permitted. Unknown keys fail save, publish, clone, and restore with a values-free validation code. `FormField.defaultValue` is also forbidden for top-level `user`: §3.4 owns the single default carrier. Canonicalization preserves original key order for retained keys so an unchanged historical template does not acquire a spurious version diff. A nested detail-column `user` field stays on the pre-delta generic branch and may not author the new keys.

### 3.2 Legacy-compatible self-selection

Two populations intentionally have different serialized shapes:

- **Existing/API fields with `allowSelf` absent:** effective `allowSelf = true`, preserving current behavior and byte identity.
- **New fields created by the product authoring UI:** write `allowSelf: false` explicitly. The UI's unchecked default therefore matches the new product default without retroactively narrowing old templates.

Loading an old field must display its effective state honestly as self-selection allowed. Saving an unrelated edit must not materialize `allowSelf: false` behind the author's back. An author who explicitly turns the setting off writes `false`; from that version onward the server rejects a requester selecting themself.

The authoring draft therefore cannot carry this setting as a bare boolean. It carries the serialized-state distinction, for example:

```ts
type UserAllowSelfDraft = 'legacy_absent' | 'enabled' | 'disabled'
```

`legacy_absent` renders as checked but emits no key; `enabled` emits `true`; `disabled` emits `false`. Emission is keyed to the original serialized state, not merely the checkbox value:

- a newly added top-level UI field has no original and emits `allowSelf: false`;
- an original field with the key absent, left untouched by the author, continues to omit it;
- an explicit author toggle emits the selected `true` or `false` value.

Always serializing the displayed checkbox state would turn an unrelated edit of a legacy field into `allowSelf: true`, violating G1. The command/undo snapshot therefore includes the exact tri-state, so undoing an explicit toggle can restore absence rather than manufacturing `true`.

Retyping another field to top-level `user` is equivalent to creating a new user field for policy state: it starts `disabled`, drops the prior type's props instead of feeding them into the user allowlist, and preserves only field identity plus type-neutral properties. The schema emitter rebuilds `user` props from the typed draft; it never preserves-then-overlays `original.props`. Retyping away from `user` removes all five user-prop draft carriers. Undo restores the complete pre-retype state; a later fresh retype back to `user` must not resurrect stale defaults or a stale `allowSelf: true`.

The command substrate is part of this contract, not an incidental UI detail. `FormFieldPropertyPatch` gains typed slots for all five keys, and each user-property edit is one command. The existing `retypeFormField` implementation preserves source props, so its user arm must be changed explicitly; merely wiring the inspector onto today's retype path is forbidden.

This is a compatibility exception, not a claim that absence and `false` are equivalent. Any future removal of the exception requires a separately measured migration and owner decision.

### 3.3 Selection and capacity

- absent `selection` means `'single'`;
- `'single'` forbids `maxSelections` and accepts exactly one legacy-compatible user value;
- `'multi'` requires an explicit integer `maxSelections` in `[2, 50]`;
- the product authoring UI writes `maxSelections: 50` when an author first changes a field to multi, and allows lowering it within the same range;
- submitted multi values above the field limit are rejected atomically; they are never truncated;
- ids must be non-blank and unique. Duplicate ids are invalid input, not silently deduplicated evidence.

The numeric ceiling is one contract value, `MAX_APPROVAL_USER_FIELD_SELECTIONS = 50`. Because the web and backend currently have no runtime-safe shared package, the first implementation may use identically named FE/BE mirrors only when an exact-equality canary reads both definitions and fails on drift. Creating a new package solely for this constant is not required. The cap bounds one field's payload cost and one direct `form_field_user` source's contribution. It is not a node-wide seat cap: a node may combine multiple existing assignee sources, and this delta neither adds nor claims a total-source/total-seat limit.

### 3.4 Default-value cross constraints

Defaults are client prefill only. The server never inserts them into an omitted payload. `props.defaultMode/defaultUserIds` are the only top-level `user` default carrier after this delta; a top-level `user.defaultValue` fails save, publish, clone, and restore. The pre-merge census in §3.8 counts historical `user.defaultValue` separately, and a non-zero count stops the slice for an owner-approved compatibility disposition rather than silently deleting or reinterpreting it.

Client precedence is total: a valid resubmit snapshot value wins; otherwise the field's props-derived default seeds the browser; otherwise the field stays empty. There is no merge between the snapshot and configured defaults.

- absent `defaultMode` forbids `defaultUserIds`;
- `defaultMode: 'requester'` requires effective `allowSelf = true` and forbids `defaultUserIds`;
- `defaultMode: 'designated'` requires a non-empty, unique `defaultUserIds` list of non-blank strings; object entries and extra-key objects are not accepted in this typed carrier;
- under `'single'`, `defaultUserIds` has exactly one entry;
- under `'multi'`, its length is at most `maxSelections`;
- a required field with an omitted payload still fails required validation even when a default is configured;
- picker filtering is convenience only. Every server-side write path is authoritative for the `allowSelf` decision.

`allowSelf` always means the approval requester's frozen identity, not the actor currently writing the field. Create and route-preview derive that identity from the same `assembleCreationContext` requester (`actor.userId` or `requesterOverride.userId`), so try-run cannot disagree with live create. It is enforced both at create and on handler-node `fieldWrites`: a handler cannot write the instance's frozen requester id into a non-driver user field whose effective policy disallows it. The handler transaction validates before its `form_snapshot` update, so a refusal leaves the snapshot, field revisions, audit rows, node state, and assignments unchanged. Existing routing-driver fields remain non-writable through `collectRoutingDriverFieldIds`; this check does not weaken that broader prohibition.

### 3.5 Wire values and parser mirrors

One authoritative backend parser returns the normalized selected ids:

```ts
resolveFormUserValues(field, value): string[] | validation error
```

It is consumed by top-level form validation, handler field-write validation, create/try-run, and assignee resolution. A non-blank id string or an exact `{ id: nonBlankString }` object remains legal under both selection modes and normalizes to a one-id list. Arrays are legal only under multi; every array entry follows those same exact shapes. Object values in both the single and array forms reject extra keys. Blank ids, duplicates, malformed values, and over-limit arrays are validation errors.

The web cannot import this backend module. Its picker/resubmit mirror uses the same checked-in fixture corpus, and parity tests assert the exact accepted/rejected shapes and normalized id order. This is a mirrored protocol parser, not a false cross-bundle "shared function" claim.

An empty array under multi is a well-shaped empty value, not malformed input. It normalizes to `[]` so the ordinary required validator or, for an old/optional routing definition, the existing `emptyAssigneePolicy` decides it. This distinction prevents the parser from retroactively converting a shipped empty-routing policy into a 400 response.

`resolveFormUserValue` remains as a single-value compatibility wrapper only if existing callers still require it; it must delegate to the authoritative parser rather than retain a second top-level interpretation.

Dispatch is carrier-aware, not props-only. `ApprovalFormValidationOptions` gains an explicit user carrier mode: top-level validation/handler writes use the policy parser, while `validateDetailFieldValue` passes a legacy-detail-single mode and keeps accepting only the shipped string/exact-`{id}` shapes even if historical nested props contain `selection:'multi'`. `retypeFormDetailColumn` may not write any of the five top-level keys. Without this discriminator, today's `validateDetailFieldValue -> validateFieldType(column, cell)` call would accidentally widen nested cells.

### 3.6 Assignee-source behavior

For a multi `user` field referenced by `form_field_user`:

- every selected id becomes one candidate seat;
- the existing resolver's dedup across sources and the node's `approvalMode` remain authoritative;
- no first-only rule and no runtime truncation are permitted;
- at the next save/publish/restore, the parent lock's OD-L2-4 retrofit requires the referenced field to be `required: true` and carry no `visibilityRule`, with author-facing compatibility copy;
- for a definition published under that contract, an empty list is rejected by form validation before `emptyAssigneePolicy` can run.

An optional `user` field that is not an assignee source may remain empty. A definition published before this retrofit and an in-flight instance keep their frozen runtime behavior: an empty historical snapshot still follows the existing `emptyAssigneePolicy`; this slice does not retroactively reinterpret it.

For `form_field_user_manager` and `form_field_user_dept_head`, the existing publish-time multi-field rejection remains. Their create-freeze path currently expects one contact anchor; lifting that pin requires a separate L2-C multi-anchor delta with bounded Cartesian/union semantics and real-directory tests.

### 3.7 Visibility and condition operands

A multi-user value is not a scalar string. In v1:

- another field's `visibilityRule` may reference a multi-user field only with `isEmpty` or `notEmpty`;
- `eq`, `neq`, and `in` references to a multi-user field fail save/publish/restore, even though one current evaluator happens to accept arrays for `in`;
- no graph condition-node rule may reference a multi-user field in v1, including `isEmpty/notEmpty`; `validateNonScalarFieldsNotUsedInConditions` and the FE `conditionEdit.ts` denylist become props-aware so the rule editor and backend reject the same shape;
- approval condition formulas may not reference a multi-user field, because `formFieldTypeToFormulaType` currently declares every `user` field as `string` and there is no ratified set-comparison algebra;
- a multi-user field may itself carry a visibility rule whose dependency is otherwise legal, except when OD-L2-4 forbids that rule because the field is a routing driver.

This is a conservative type boundary, not a claim that set predicates are impossible. Equality, membership, and formula semantics for user sets require a later design delta with matched FE/BE evaluation and frozen-snapshot tests.

### 3.8 Persisted-props census

Before the allowlist implementation may merge, a read-only census tool must inspect both JSONB columns on every `approval_template_versions` row:

- `form_schema.fields[]` supplies top-level `user` declarations and `visibilityRule` references;
- the separate `approval_graph.nodes[].config.branches[].rules[].fieldId` paths supply simple condition rules;
- each branch's `formula.expression` is parsed with the production formula parser/`extractApprovalConditionFormulaFieldIds`, never a regex or SQL substring search. Because that helper throws on malformed expressions, the census catches parse/validation errors per branch and counts the whole version as blocking-malformed; it never aborts the run or silently skips the formula.

The tool then reports only:

- total user fields;
- user fields with any props;
- user fields whose props are present but not an object;
- fields containing at least one key outside this delta's allowlist;
- fields carrying the existing top-level `defaultValue` carrier;
- fields whose props already claim `selection: 'multi'` or any of the new default keys;
- fields whose known keys have an invalid type or violate any §3.3-3.4 cross-key constraint, including `selection:'multi'` without a valid `maxSelections`;
- multi-user fields referenced by a forbidden visibility operator, graph condition rule, or condition formula;
- versions affected by any blocking shape.

The blocking set is exact: malformed schema/props/graph, unknown keys, top-level `user.defaultValue`, an invalid known-key type or §3.3-3.4 combination, or a §3.7-illegal reference. A well-formed already-multi/default field that satisfies the final contract is informational and does not block. `L2B_CENSUS_BLOCKING_COUNT > 0` stops the implementation PR and returns to the owner; checking only the unknown-key count or only walking `form_schema` is forbidden.

Evidence output is values-free: no template id, field id, label, prop key, prop value, rule value, or formula text. Blocking rows are not auto-rewritten. If the owner needs remediation targets after such a stop, a separate owner-authorized secure-console inspect may return identifiers locally; it must not enter CI logs, PR text, committed artifacts, or the default census report. The SQL read layer guards `jsonb_typeof` before every `jsonb_array_elements` / `jsonb_object_keys` call so malformed historical JSON is measured rather than crashing or disappearing; the TypeScript layer validates/parses the graph with production helpers and converts parser exceptions into blocking counts. Real-DB fixtures cover absent/non-array `fields`, non-object field entries, empty fields, non-object props, known-only props, unknown props, existing `defaultValue`, valid/invalid claimed multi/default props, and every forbidden reference class. One discriminating fixture has a fully valid multi field plus only an illegal graph `eq` rule; a fields-only scan would report zero but the complete census must block it. A second has a valid multi field plus only an unparseable formula; the tool must finish with a non-zero blocking count rather than throw.

The census must cover all versions, not only the active pointer, because `restoreTemplateVersion` revalidates historical `form_schema` and the non-scalar condition pin revalidates the corresponding `approval_graph`.

## 4. Required implementation seams

The runtime slice is one PR because splitting these seams would create a live partial state:

1. `ApprovalProductService.normalizeFormField`: top-level-only strict allowlist, `defaultValue` refusal, type checks, cross-key checks, order-preserving canonicalization; the nested path remains byte-identical.
2. `ApprovalGraphExecutor.validateFieldType`, `validateDetailFieldValue`, and `prefillFromSnapshot.ts`: use explicit top-level versus legacy-detail user carrier modes; retain the generic fail-open default for unrelated field kinds unchanged; the FE protocol mirror preserves resubmit arrays rather than dropping them.
3. `ApprovalAssigneeResolver`: direct `form_field_user` consumes every normalized id.
4. `ApprovalProductService` publish/create/handler contexts: shared server-side effective-`allowSelf` enforcement before any write, using `assembleCreationContext`'s requester for create/preview and the instance's frozen requester on handler writes; the OD-L2-4 required/no-visibility retrofit for direct `form_field_user`; props-aware multi-user pins in visibility validation, graph condition rules, and formulas; preserve the two L2-C multi pins and all already-published runtime definitions. `validateNonScalarFieldsNotUsedInConditions` is invoked by create, update, publish, clone, and restore; adding the props-aware predicate without adding both missing restore/clone calls is incomplete.
5. `templateAuthoring.ts`, `ApprovalFormFieldInspector.vue`, `ApprovalFormInlineEditor.vue`, `approvalFormCommands.ts`, `conditionEdit.ts`, `TemplateAuthoringView.vue:conditionFieldOptions`, the inspector's condition-options unwrap, formula insertion options, and the form-command adapter: tri-state `allowSelf` draft carrier, five typed property-patch slots, hydration, schema emission, undo/redo, explicit defaults in both top-level field-creation paths, props-aware condition affordances, and security-clean retype-to/from-user behavior. User props are rebuilt, not spread from `original.props`; `retypeFormDetailColumn` never writes them. Multi-user fields are absent from the live simple-rule dropdown and formula-field insertion menu rather than being offered and rejected only after save. The visibility dependency remains available, but both Canvas and flag-off editors offer only `isEmpty/notEmpty` when that dependency is multi.
6. `ApprovalUserPicker.vue`: opt-in multi mode without changing transfer/add-sign/delegation call sites; requester exclusion is an input prop, not store coupling.
7. `ApprovalNewView.vue` and the authoring try-run sample form: snapshot-first prefill, then requester identity resolution, then props-derived defaults; effective self filtering, opt-in multi picker/payload, and submit-time error copy. A bare string remains a valid one-id multi payload for non-upgraded clients.
8. `detailField.ts:formatDisplayValue`, `ApprovalDetailView.vue:formatFieldValue` for detail rows/print, history/summary consumers, and `directoryResolve.ts`: shipped single user values and new arrays resolve through the authorized user-name batch path; unresolved entries render a values-free placeholder or count, never `String(id)` or a joined raw-id list.
9. OpenAPI: add `FormFieldUser` and a strict `UserFieldProps` discriminator branch. `FormFieldUser` is `additionalProperties: false`, has `type.enum: [user]`, requires only `id/type/label`, keeps optional outer `required`, `placeholder`, `options`, `visibilityRule`, and `props`, omits `defaultValue` and `columns`, and points optional `props` to `UserFieldProps`. `UserFieldProps` is `additionalProperties: false`. Remove `user` from `FormFieldGeneric.type` and map it to `FormFieldUser`; retain `user` on nested `FormFieldDetailLeaf`'s legacy generic contract. `UserFieldProps.maxSelections` carries minimum 2 and maximum 50; generic `CreateApprovalRequest.formData` is not falsely claimed to provide an array `maxItems` boundary. Update `packages/openapi/tools/guard-codegen.mjs` and generated-schema tests to assert all four facts independently: `FormField.oneOf` refs are the exact set `{FormFieldRecordLink, FormFieldUser, FormFieldGeneric}`; `FormFieldGeneric.type.enum` excludes both `record-link` and `user`; `discriminator.mapping.user` points to `FormFieldUser`; and generated `FormField` names all three union members. Existing length-`<2`/`.some()` checks are not sufficient and must be replaced or supplemented with these exact-set negatives before regeneration.
10. Assignee-source authoring: define two field sets at both linear and Canvas sites. `allTopLevelUserFields` feeds direct `form_field_user`; `singleAnchorUserFields` filters out effective `selection:'multi'` and feeds `form_field_user_manager`, `form_field_user_dept_head`, and their C-7 availability checks. Extend `ApprovalNodeConfigEditorApi` to carry both named sets and inject both through `TemplateAuthoringView.nodeConfigEditorApi`; the Canvas inspector must not keep receiving today's single unqualified `userFields` list. At both sites, a derived picker renders `singleAnchorUserFields` plus one values-free disabled repair option when its currently configured `fieldId` is no longer eligible, so the stored selection remains visible but cannot be newly chosen. Direct pickers and the Canvas source-summary label lookup use `allTopLevelUserFields`, preventing a configured-but-ineligible derived source from being mislabeled as unselected. `isAssigneeSourceValid`, `validateApprovalNodeEdits`, and the linear authoring validator use the same eligibility rule, making the orphan save-invalid before the authoritative server publish check; their field parameter type carries the draft's effective `selection` slot rather than only `{ id, type }`, so a type-only implementation cannot compile. The editor does not silently clear the source. Do not filter the one shared current-main `userFields` computed in place: that would incorrectly remove multi from the direct source.
11. CI: every new mounted frontend spec enters both `approval-web-guard.yml` paths and `apps/web/scripts/run-required-web-tests.sh`; backend behavior uses real Postgres where persistence/rollback is claimed.

The flag-off `ApprovalFormInlineEditor` fallback is not an authoring surface for the five L2-B props. It must preserve untouched serialized props and apply the secure new-field defaults, but it does not gain inspector controls in this slice. Product authoring of these properties requires Canvas V2; this limitation is stated in release/UAT copy rather than hidden behind an inert control.

## 5. Acceptance gates

| Gate | Required proof | Discriminating negative |
|---|---|---|
| G1 legacy self compatibility | an absent-key legacy field accepts requester self-selection and round-trips byte-identically through load + unrelated edit + save | always serializing the displayed checkbox value either materializes `true` or rejects submit and makes this test red |
| G2 new default | a newly added UI field serializes `allowSelf: false` | removing the explicit authoring default makes only the new-field assertion red |
| G3 server authority | explicit `allowSelf: false` rejects the assembled requester, including `requesterOverride` in preview/try-run, with zero instance/assignment/event rows; absent/true controls succeed | checking the current actor instead of the assembled requester makes the override negative green |
| G3b handler authority | a handler write selecting the frozen requester under explicit false rolls back snapshot/revision/audit/node changes; explicit true succeeds | enforcing only the create path makes the handler negative green |
| G4 strict props/default carrier | unknown key and top-level `user.defaultValue` fail save/publish/clone/restore; all five allowed keys survive | restoring the generic spread or old default carrier turns its named negative green |
| G5 cross-key constraints | every invalid combination in §3.3-3.4 fails with no write; `defaultUserIds` are non-blank unique strings | removing one constraint reds its paired case while positive controls stay green |
| G6 multi validation | two distinct ids and a one-id legacy string under multi succeed; array under single, duplicate, blank, over-limit, extra-key object, and malformed value fail; optional empty multi remains `[]` | restoring the old single-value arm reds the multi positives; treating `[]` as malformed breaks the compatibility control |
| G7 direct routing | N selected ids through `form_field_user` create N distinct candidates and obey the node approval mode | restoring arrays-to-null reaches NOBODY and reds this test |
| G8 derived-kind pin | both shipped contact-derived kinds reject a multi field in client validation and at publish; `ApprovalNodeConfigEditorApi` carries both named sets; linear/Canvas derived pickers and C-7 use `singleAnchorUserFields`; direct `form_field_user` uses `allTopLevelUserFields` and still offers multi; a stored derived source that became multi remains visible through one disabled values-free repair option, keeps its label in the Canvas summary, and is save-invalid | independent negatives (a) restore the one-list Canvas API or filter the shared set in place, (b) remove either site's derived filter, (c) omit the disabled current-id repair option so Element Plus blanks the stored selection, (d) leave `isAssigneeSourceValid`/linear validation accepting derived-plus-multi, and (e) make the Canvas summary lookup use `singleAnchorUserFields` so the stored source renders as unselected; each reds its named context, mounted, or validation case while the other surfaces remain correct |
| G9 prefill/resubmit precedence | valid resubmit arrays survive; otherwise requester/designated defaults populate the browser; an omitted required API payload still fails server validation | retaining `prefillFromSnapshot`'s string-only user arm or injecting server defaults reds a named case |
| G9b required-pin compatibility | a new/republished direct source rejects optional or visibility-controlled user fields, while a pre-delta published definition still follows its frozen empty policy | applying the pin to active runtime reads breaks the historical control; omitting the publish pin makes the new negative green |
| G10 authoring history | all five property edits are expressible by `FormFieldPropertyPatch`, one undoable command each; undo restores exact key absence as well as true/false | deleting a patch slot or directly mutating the draft breaks its named command test |
| G10b retype hygiene | another type -> user emits explicit false and no stale source props; user -> other -> user does not resurrect user policy/defaults; undo restores the exact prior state | preserving `original.props` across either direction makes the named retype tests red |
| G11 viewer privacy | top-level single/multi and nested single user values render resolved names; unresolved values render only placeholders/counts in detail, summary, history, and print | two independent mutations restore `detailField.ts:formatDisplayValue` and `ApprovalDetailView.vue:formatFieldValue` scalar `String(value)` fallbacks; each exposes a sentinel id and reds its own mounted/print case |
| G12 census | fixture corpus reads both `form_schema` and `approval_graph`, with exact counts for known-only, unknown-key, malformed, `defaultValue`, valid known props, invalid cross-key props, and illegal references; parser errors become counts and only `L2B_CENSUS_BLOCKING_COUNT === 0` permits implementation | a valid multi field plus only an illegal graph rule and another plus only an unparseable formula must each finish and block; dropping either JSONB column, catch, predicate, or reverting delivery to `unknown_count === 0` makes its paired real-DB fixture red |
| G13 CI collection | mounted editor/fill specs are collected by both required lanes | removing either token makes the corresponding workflow-selection test red |
| G14 legacy call sites | transfer, add-sign, and delegation pickers remain single-select and byte-equivalent | globally enabling picker multi mode breaks their mounted specs |
| G15 nested boundary | a detail user column remains single-select and round-trips its pre-delta props byte-identically, including a historical stray `selection:'multi'` prop | removing the explicit legacy-detail carrier mode or writing top-level keys from `retypeFormDetailColumn` breaks the control |
| G16 condition boundary | multi user dependencies allow only visibility `isEmpty/notEmpty`; scalar visibility operators, every graph condition rule, and formula references fail create/update/publish/clone/restore; single user controls remain legal, both Canvas/flag-off visibility editors offer only the legal pair, and multi fields are absent from both live condition insertion menus | restore a stored version whose only illegal bit is one `eq` rule on a valid multi field; independent mutations remove only `conditionFieldOptions`, formula insertion, Canvas visibility, or flag-off visibility filtering, each exposing one inert control while the others remain correct |
| G17 cap/OpenAPI parity | FE and BE named cap constants equal `UserFieldProps.maxSelections.maximum === 50` and minimum 2; `FormFieldUser` omits `defaultValue`, disallows unknown outer/props keys, and accepts a legacy no-props field plus a field carrying only `visibilityRule`; oneOf/generic enum/mapping/generated union are exact | independent negatives leave `user` on Generic, leave mapping.user on Generic, keep only two oneOf members, omit FormFieldUser from generated types, change one bound, require props, drop an allowed outer key, or copy `defaultValue`; each must red a named contract case |
| G18 try-run and resubmit surfaces | authoring try-run selects multi users and applies requester filtering; re-submit keeps every selected id | leaving either picker/prefill path single-string-only makes its mounted case red |

## 6. Delivery order

1. Ratify this delta.
2. Land the values-free census tool and run it only in environments explicitly authorized by the owner.
3. Implement the single runtime PR in §4 only when `L2B_CENSUS_BLOCKING_COUNT === 0`. Any malformed/unknown/defaultValue/invalid-combination/illegal-reference count stops and requires an amended compatibility or migration policy first; an unknown-key-only gate is insufficient.
4. Run focused unit/mounted tests, both required web lanes, backend real-DB tests, type checks, OpenAPI generation/guard, and the G1-G18 mutations.
5. Rebase on current main and re-run exact-head required checks.
6. Merge only with explicit owner authorization. No deployment or flag action is implied.

## 7. Owner decisions

| Decision | Recommended arm | Alternative and consequence |
|---|---|---|
| OD-L2B-D1 legacy absent `allowSelf` | **(a) absence remains legacy-allow; new UI fields write explicit false** | (b) absence=false globally: simpler but immediately narrows every existing template and requires usage telemetry/migration acceptance |
| OD-L2B-D2 multi capacity | **(a) require `maxSelections` 2..50 for every multi field; one FE/BE constant** | (b) cap only routed fields: leaves unbounded form payloads; (c) runtime truncation: forbidden silent approver loss |
| OD-L2B-D3 already-shipped derived kinds | **(a) keep their multi publish pin; widen only direct `form_field_user`** | (b) lift all pins now: requires a separate multi-anchor directory-resolution design and is not this slice |
| OD-L2B-D4 wire contract | **(a) strict OpenAPI `UserFieldProps` branch + regenerated SDK** | (b) generic props: backend stays strict but clients cannot discover or type-check the contract |
| OD-L2B-D5 detail user columns | **(a) keep nested user columns on shipped single-value behavior; design their bounded multi/default semantics separately** | (b) include them now: requires a form-wide rows x selections capacity contract and a second authoring surface, not priced by the parent lock |
| OD-L2B-D6 default carrier | **(a) forbid top-level `user.defaultValue`; use only `defaultMode/defaultUserIds`, census-gated** | (b) retain two carriers with precedence: preserves more legacy shapes but doubles authoring/restore semantics and requires a migration-visible conflict rule |
| OD-L2B-D7 multi conditions | **(a) only field-visibility `isEmpty/notEmpty`; no scalar visibility, graph condition rule, or formula operand in v1** | (b) define set equality/membership/formula semantics now: a separate evaluation-language expansion not priced by L2-B |

## 8. Ratification record

```text
Decision: PROPOSED
Owner:
Date:
Document SHA:
Decisions: OD-L2B-D1 / D2 / D3 / D4 / D5 / D6 / D7
Runtime authorization: NONE - design only
```
