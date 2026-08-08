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
    expect(VIEW_SRC).toMatch(/data-testid="approval-template-field-row"/)
    expect(VIEW_SRC).toMatch(
      /:data-selected="formFieldFocusLocalId === field\.localId \? 'true' : undefined"/,
    )
    expect(VIEW_SRC).toMatch(
      /:aria-current="formFieldFocusLocalId === field\.localId \? 'true' : undefined"/,
    )
    expect(VIEW_SRC).toMatch(
      /'template-authoring__item--focused': formFieldFocusLocalId === field\.localId/,
    )
    expect(VIEW_SRC).toMatch(/:id="`approval-field-row-\$\{field\.localId\}`"/)
  })

  it('focusFormFieldRow lands keyboard focus on the new row / label input', () => {
    expect(VIEW_SRC).toMatch(/async function focusFormFieldRow\s*\(\s*localId:\s*string\s*\)/)
    expect(VIEW_SRC).toMatch(/getElementById\(`approval-field-row-\$\{localId\}`\)/)
    expect(VIEW_SRC).toMatch(/labelInput\.focus\(\)/)
    // Selection sync without structural history stack pollution.
    expect(VIEW_SRC).toMatch(/function selectFormFieldFocus\s*\(\s*localId:\s*string\s*\)/)
    expect(VIEW_SRC).toMatch(/@focusin="selectFormFieldFocus\(field\.localId\)"/)
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
