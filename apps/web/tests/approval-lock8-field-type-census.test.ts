import { describe, expect, it } from 'vitest'
import { AUTHORABLE_FIELD_TYPES } from '../src/approvals/templateAuthoring'
import { isDetailLeafFieldType } from '../src/approvals/detailField'
import { isSelectableConditionOrVisibilityDependencyType } from '../src/approvals/recordLinkField'

// Lock-8 L8-A §2.1 N-1 — mechanical census, FRONTEND half. See the backend sibling
// (packages/core-backend/tests/unit/approval-lock8-field-type-census.test.ts) for the full scope
// note on what MS-1..MS-13 this repo can and cannot anchor mechanically; this file covers:
//
//   COVERED here, anchored on the REAL exported set/predicate:
//     - MS-5  FE detail-leaf explicit list (`isDetailLeafFieldType`) — one call per canonical
//             AUTHORABLE type, hand-authored expectation table, completeness meta-check
//     - MS-9  FE selectable condition/visibility dependency predicate
//             (`isSelectableConditionOrVisibilityDependencyType`) — same shape
//
//   NOT a runtime row here (see the backend file's note for the full reasoning):
//     - MS-1  FE/BE union sync — no runtime footprint; compiler-forced via Record<FormFieldType,…>
//             maps (MS-11) plus this file's own `AUTHORABLE_FIELD_TYPES` import, which would fail
//             to TYPECHECK before ever running if a member were absent from its declaring array.
//     - MS-6  AUTHORABLE_FIELD_TYPES / approvalFormCommands.ts FIELD_LABELS — FIELD_LABELS is a
//             `Record<AuthorableFieldType,string>` LITERAL and AUTHORABLE_FIELD_TYPES here derives
//             from `Object.keys(FIELD_LABELS)` — compile-forced, verified by `vue-tsc -b`, not a
//             vitest row. approval-explanation-field.test.ts pins the BEHAVIOURAL side (addFormField
//             admits it).
//     - MS-11 four label/mark maps — all `Record<AuthorableFieldType|FormFieldType,…>` literals,
//             compile-forced the same way.
//     - MS-13 palette GROUPING (the one non-compile-forced part of MS-13 — plain string arrays, not
//             a Record) has TWO independent registration sites, NOT one: the F2
//             `ApprovalFormPalette.vue` component's exported `APPROVAL_FORM_PALETTE_GROUPS`, and
//             `TemplateAuthoringView.vue`'s own separate `fieldPaletteGroups` local (the array
//             actually shipped into the live inline editor). The PRE-EXISTING forcing function
//             `approval-form-palette-chips.spec.ts:107` (`[...groupedTypes].sort() ===
//             [...AUTHORABLE_FIELD_TYPES].sort()`) and approval-explanation-field.test.ts's own
//             registration-completeness describe block BOTH read only `APPROVAL_FORM_PALETTE_GROUPS`
//             — neither one is reachable from `TemplateAuthoringView.vue`'s copy (correction, gate
//             P2-1: an earlier draft of this comment claimed :107 was "generalized" to cover it;
//             that was false — deleting `explanation` from the view's own array alone left every
//             then-reachable spec green). The view's own copy is covered separately, by a REAL
//             mount (not a duplicated literal): `approval-form-inline-editor-extract.spec.ts`'s "(o)
//             MS-13 completeness" test queries the rendered `approval-field-palette-*` chip DOM and
//             asserts it against `AUTHORABLE_FIELD_TYPES` directly. The inline-editor's per-type
//             property block (the other half of MS-13) is a MOUNTED-component concern — see
//             approval-explanation-inline-editor.spec.ts.
//     - MS-3/MS-12 are pinned by approval-explanation-field.test.ts's dedicated describe blocks
//             (prefill / buildDisplayFields / summaryFields), not a type-indexed table — their
//             shape ("does X have an arm", "is X's render source correct") does not fit the
//             exact-equality census style as cleanly as a dedicated positive/negative pair does.

// MS-5 expectation table — mirrors the backend MS-4 table's boundary (detail/record-link/
// date_range/explanation excluded; attachment is EXCLUDED here too, unlike the backend's
// DETAIL_LEAF_FIELD_TYPES — the FE list is the 8-member explicit array documented at
// detailField.ts:20-24, deliberately narrower than the backend's flag-gated 9-member set).
const MS5_DETAIL_LEAF_ADMITTED: Readonly<Record<string, boolean>> = {
  text: true,
  textarea: true,
  number: true,
  date: true,
  datetime: true,
  select: true,
  'multi-select': true,
  user: true,
  detail: false,
  'record-link': false,
  date_range: false,
  explanation: false,
  department: false,
}

// MS-9 expectation table — the FE selectable condition/visibility dependency predicate.
const MS9_SELECTABLE_DEPENDENCY: Readonly<Record<string, boolean>> = {
  text: true,
  textarea: true,
  number: true,
  date: true,
  datetime: true,
  select: true,
  'multi-select': true,
  user: true,
  detail: false,
  'record-link': false,
  date_range: false,
  explanation: false,
  department: false,
}

describe('Lock-8 L8-A field-type census (N-1) — frontend sites', () => {
  it('MS-5: completeness — the expectation table covers EXACTLY AUTHORABLE_FIELD_TYPES', () => {
    // Adding a 13th authorable type with no row here reds THIS assertion first.
    expect(Object.keys(MS5_DETAIL_LEAF_ADMITTED).sort()).toEqual([...AUTHORABLE_FIELD_TYPES].sort())
  })

  for (const type of [...AUTHORABLE_FIELD_TYPES].sort()) {
    const admitted = MS5_DETAIL_LEAF_ADMITTED[type]
    it(`MS-5: ${type} is ${admitted ? 'a valid' : 'NOT a valid'} detail-leaf sub-field type`, () => {
      expect(isDetailLeafFieldType(type)).toBe(admitted)
    })
  }

  it('MS-9: completeness — the expectation table covers EXACTLY AUTHORABLE_FIELD_TYPES', () => {
    expect(Object.keys(MS9_SELECTABLE_DEPENDENCY).sort()).toEqual([...AUTHORABLE_FIELD_TYPES].sort())
  })

  for (const type of [...AUTHORABLE_FIELD_TYPES].sort()) {
    const admitted = MS9_SELECTABLE_DEPENDENCY[type]
    it(`MS-9: ${type} is ${admitted ? 'ADMITTED' : 'REFUSED'} as a condition/visibility dependency`, () => {
      expect(isSelectableConditionOrVisibilityDependencyType(type)).toBe(admitted)
    })
  }
})
