import { describe, expect, it } from 'vitest'

import { AUTOMATION_RECIPES, applyRecipeToDraft, findAutomationRecipe } from '../src/multitable/automationRecipes'

// G-B2-26 — recipe cards must only ever produce a draft the quick form can render + save, i.e. only
// trigger/action values the form offers. These pin the table + the overlay semantics.

const QUICK_FORM_TRIGGERS = new Set(['record.created', 'record.updated', 'field.changed'])
const QUICK_FORM_ACTIONS = new Set(['notify', 'update_field'])

describe('automationRecipes', () => {
  it('every recipe uses only quick-form-supported trigger + action values', () => {
    for (const recipe of AUTOMATION_RECIPES) {
      expect(QUICK_FORM_TRIGGERS.has(recipe.triggerType), `${recipe.key} trigger`).toBe(true)
      expect(QUICK_FORM_ACTIONS.has(recipe.actionType), `${recipe.key} action`).toBe(true)
    }
  })

  it('every recipe has a unique key and its own title/description label keys', () => {
    const keys = AUTOMATION_RECIPES.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const recipe of AUTOMATION_RECIPES) {
      expect(recipe.titleKey).toBeTruthy()
      expect(recipe.descriptionKey).toBeTruthy()
      expect(recipe.titleKey).not.toBe(recipe.descriptionKey)
    }
  })

  it('applyRecipeToDraft overlays ONLY trigger + action, preserving every other draft field', () => {
    const base = { name: 'kept', triggerType: 'record.created', actionType: 'notify', notifyMessage: 'hi', extra: 42 }
    const recipe = AUTOMATION_RECIPES.find((r) => r.key === 'field-changed-update')!
    const out = applyRecipeToDraft(base, recipe)
    expect(out.triggerType).toBe('field.changed')
    expect(out.actionType).toBe('update_field')
    // untouched fields survive verbatim
    expect(out.name).toBe('kept')
    expect(out.notifyMessage).toBe('hi')
    expect(out.extra).toBe(42)
    // pure — base not mutated
    expect(base.triggerType).toBe('record.created')
  })

  it('findAutomationRecipe resolves a known key and returns undefined for junk', () => {
    expect(findAutomationRecipe('created-notify')?.triggerType).toBe('record.created')
    expect(findAutomationRecipe('__nope')).toBeUndefined()
  })
})
