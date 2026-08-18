/**
 * Wave-3 PR8 — Form palette focus-return after add.
 * Pure structural source-scan (G5-C style): no full TemplateAuthoringView mount.
 *
 * Pins: addFieldOfType / addField push new field localId into form history focus,
 * UI selection follows formFieldFocusLocalId, and DOM focus lands on the new row.
 * Structural mutations still go through applyFormFieldsStructural (#4815 undo/redo).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const VIEW_SRC = readFileSync(
  join(__dirname, '../src/views/approval/TemplateAuthoringView.vue'),
  'utf8',
)

// F0 extraction (docs/development/approval-form-builder-parity-delta-design-20260811.md §5 F0):
// the three-region shell markup this file pins (palette/preview/field-row DOM, moved verbatim,
// byte/behavior-equivalent) now lives in the extracted ApprovalFormInlineEditor.vue. Assertions
// below that target that markup specifically are re-pointed at the SAME regex text against the
// new file's source, following this repo's existing PR4 extraction precedent
// (approval-g5c-authoring-scenarios.test.ts already does this for ApprovalFlowCanvas /
// ApprovalCanvasNodeInspector). Assertions over script-level ownership (add/select/undo/redo
// functions, form history, record-link catalog state) are unchanged: Gate F0 keeps that logic
// parent-owned in TemplateAuthoringView.vue.
const CHILD_SRC = readFileSync(
  join(__dirname, '../src/approvals/components/ApprovalFormInlineEditor.vue'),
  'utf8',
)

describe('TemplateAuthoringView form palette focus-return (structural)', () => {
  it('addFieldOfType sets form history focus to the new field localId', () => {
    // Palette add must pass next.localId as nextFocus into structural push.
    expect(VIEW_SRC).toMatch(/function addFieldOfType\s*\(/)
    expect(VIEW_SRC).toMatch(
      /applyFormFieldsStructural\(\[\.\.\.draft\.value\.fields,\s*next\],\s*next\.localId\)/,
    )
    // DOM focus-return after structural push (keyboard authors land on created field).
    expect(VIEW_SRC).toMatch(
      /applyFormFieldsStructural\(\[\.\.\.draft\.value\.fields,\s*next\],\s*next\.localId\)\s*\n\s*void focusFormFieldRow\(next\.localId\)/,
    )
  })

  it('addField also focuses the newly added field', () => {
    expect(VIEW_SRC).toMatch(
      /applyFormFieldsStructural\(\[\.\.\.draft\.value\.fields,\s*added\],\s*added\.localId\)/,
    )
    expect(VIEW_SRC).toMatch(
      /applyFormFieldsStructural\(\[\.\.\.draft\.value\.fields,\s*added\],\s*added\.localId\)\s*\n\s*void focusFormFieldRow\(added\.localId\)/,
    )
  })

  it('field row UI selection follows formFieldFocusLocalId (data-selected / aria-current)', () => {
    expect(CHILD_SRC).toMatch(/data-testid="approval-template-field-row"/)
    expect(CHILD_SRC).toMatch(
      /:data-selected="formFieldFocusLocalId === field\.localId \? 'true' : undefined"/,
    )
    expect(CHILD_SRC).toMatch(
      /:aria-current="formFieldFocusLocalId === field\.localId \? 'true' : undefined"/,
    )
    expect(CHILD_SRC).toMatch(
      /'template-authoring__item--focused': formFieldFocusLocalId === field\.localId/,
    )
    expect(CHILD_SRC).toMatch(/:id="`approval-field-row-\$\{field\.localId\}`"/)
  })

  it('focusFormFieldRow lands keyboard focus on the new row / label input', () => {
    expect(VIEW_SRC).toMatch(/async function focusFormFieldRow\s*\(\s*localId:\s*string\s*\)/)
    expect(VIEW_SRC).toMatch(/getElementById\(`approval-field-row-\$\{localId\}`\)/)
    expect(VIEW_SRC).toMatch(/labelInput\.focus\(\)/)
    // Selection sync without structural history stack pollution.
    expect(VIEW_SRC).toMatch(/function selectFormFieldFocus\s*\(\s*localId:\s*string\s*\)/)
    // The row's `@focusin` binding is F0-extracted onto ApprovalFormInlineEditor.vue; it forwards
    // to the parent's (unchanged) selectFormFieldFocus via a same-name emit wrapper.
    expect(CHILD_SRC).toMatch(/@focusin="selectFormFieldFocus\(field\.localId\)"/)
  })

  it('form designer uses grouped palette + preview without inventing field kinds', () => {
    expect(VIEW_SRC).toMatch(/data-testid="approval-form-designer"/)
    expect(CHILD_SRC).toMatch(/data-testid="approval-form-preview"/)
    expect(VIEW_SRC).toMatch(/fieldPaletteGroups/)
    expect(CHILD_SRC).toMatch(/点击或拖拽左侧控件至此处/)
    expect(CHILD_SRC).not.toMatch(/金额/)
    expect(CHILD_SRC).not.toMatch(/计算公式/)
    expect(CHILD_SRC).not.toMatch(/控件组/)
    expect(CHILD_SRC).not.toMatch(/approval-field-palette-attachment/)
    // Parent still OWNS the palette constants (FIELD_PALETTE_LABELS / FIELD_PALETTE_MARKS /
    // fieldPaletteGroups, TemplateAuthoringView.vue ~:2475/:2490/:2503) — the extraction only moved
    // the rendering markup to the child. These field kinds must stay out of scope in BOTH files.
    expect(VIEW_SRC).not.toMatch(/金额/)
    expect(VIEW_SRC).not.toMatch(/计算公式/)
    expect(VIEW_SRC).not.toMatch(/控件组/)
    expect(VIEW_SRC).not.toMatch(/approval-field-palette-attachment/)
  })

  it('structural field mutations still go through form history (undo/redo safe)', () => {
    expect(VIEW_SRC).toMatch(/function applyFormFieldsStructural\s*\(/)
    expect(VIEW_SRC).toMatch(/pushFormSnapshot\(/)
    expect(VIEW_SRC).toMatch(/formFieldFocusLocalId\.value = next\.focusLocalId/)
    // Undo/redo restore focusLocalId from history tip.
    expect(VIEW_SRC).toMatch(/formFieldFocusLocalId\.value = result\.focusLocalId/)
    expect(VIEW_SRC).toMatch(/data-testid="approval-form-undo"/)
    expect(VIEW_SRC).toMatch(/data-testid="approval-form-redo"/)
  })
})
