import type { AutomationLabelKey } from './utils/meta-automation-labels'

/**
 * G-B2-26 — empty-state recipe cards. The manager's empty state used to be a bare "no automations
 * yet" line at the exact moment a user most needs guidance. A recipe is a named starting point that
 * pre-fills the quick-form draft with a common trigger→action pair, so the first rule is one click
 * plus a little editing instead of a blank form.
 *
 * Each recipe uses ONLY trigger/action values the quick form actually offers (record.created /
 * record.updated / field.changed × notify / update_field), so applying one always yields a draft
 * the existing form can render and save. Kept as a pure data table + a pure applier so the mapping
 * is unit-testable without mounting the 2200-line manager. No external product names.
 */
export type RecipeTriggerType = 'record.created' | 'record.updated' | 'field.changed'
export type RecipeActionType = 'notify' | 'update_field'

export interface AutomationRecipe {
  /** Stable key → `data-automation-recipe="<key>"` and the label lookups. */
  key: string
  triggerType: RecipeTriggerType
  actionType: RecipeActionType
  titleKey: AutomationLabelKey
  descriptionKey: AutomationLabelKey
}

export const AUTOMATION_RECIPES: readonly AutomationRecipe[] = [
  {
    key: 'created-notify',
    triggerType: 'record.created',
    actionType: 'notify',
    titleKey: 'recipe.createdNotifyTitle',
    descriptionKey: 'recipe.createdNotifyDesc',
  },
  {
    key: 'updated-notify',
    triggerType: 'record.updated',
    actionType: 'notify',
    titleKey: 'recipe.updatedNotifyTitle',
    descriptionKey: 'recipe.updatedNotifyDesc',
  },
  {
    key: 'field-changed-update',
    triggerType: 'field.changed',
    actionType: 'update_field',
    titleKey: 'recipe.fieldChangedUpdateTitle',
    descriptionKey: 'recipe.fieldChangedUpdateDesc',
  },
]

export function findAutomationRecipe(key: string): AutomationRecipe | undefined {
  return AUTOMATION_RECIPES.find((recipe) => recipe.key === key)
}

/**
 * Overlay a recipe's trigger/action onto a base (empty) draft. Generic over the draft shape (the
 * manager owns DraftState) so this module stays free of that heavy type; the only fields a recipe
 * sets are triggerType + actionType. Everything else is left to the base draft's defaults, so the
 * result is still a complete, form-renderable draft the author then fills in.
 */
export function applyRecipeToDraft<T extends { triggerType: string; actionType: string }>(
  base: T,
  recipe: AutomationRecipe,
): T {
  return { ...base, triggerType: recipe.triggerType, actionType: recipe.actionType }
}
