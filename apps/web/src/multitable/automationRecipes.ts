import type { AutomationAction, AutomationActionType, AutomationTriggerType } from './types'
import { automationLabel, type AutomationLabelKey } from './utils/meta-automation-labels'
import { INTEGRATION_RUN_FINISHED_TRIGGER_TYPE } from './integrationRunFinishedAuthoring'
import {
  RUN_INTEGRATION_JOB_ACTION_TYPE,
  RUN_INTEGRATION_JOB_AUTHORABLE_APPLY_MODE,
  RUN_INTEGRATION_JOB_AUTHORABLE_KIND,
  RUN_INTEGRATION_JOB_TRIGGER_TYPE,
} from './runIntegrationJobAuthoring'

/**
 * G-B2-26 — empty-state recipe cards. The manager's empty state used to be a bare "no automations
 * yet" line at the exact moment a user most needs guidance. A recipe is a named starting point that
 * pre-fills the quick-form draft with a common trigger→action pair, so the first rule is one click
 * plus a little editing instead of a blank form.
 *
 * Each recipe uses ONLY trigger/action values the quick form actually offers (record.created /
 * record.updated / field.changed × send_notification / update_record), so applying one always yields a draft
 * the existing form can render and save. Kept as a pure data table + a pure applier so the mapping
 * is unit-testable without mounting the 2200-line manager. No external product names.
 */
export type RecipeTriggerType = 'record.created' | 'record.updated' | 'field.changed'
// F9: canonical action types only. The cards used to seed the v0 aliases (notify / update_field),
// which the executor has no dispatch case for — every rule created from a card failed at run time.
export type RecipeActionType = 'send_notification' | 'update_record'

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
    actionType: 'send_notification',
    titleKey: 'recipe.createdNotifyTitle',
    descriptionKey: 'recipe.createdNotifyDesc',
  },
  {
    key: 'updated-notify',
    triggerType: 'record.updated',
    actionType: 'send_notification',
    titleKey: 'recipe.updatedNotifyTitle',
    descriptionKey: 'recipe.updatedNotifyDesc',
  },
  {
    key: 'field-changed-update',
    triggerType: 'field.changed',
    actionType: 'update_record',
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

// ── Integration assistant 1d (register R-99 ③; plan integration-assistant-n8n-plan-20261119.md §7): rule
// templates A / B for the ADVANCED editor. The quick-form recipes above stay quick-form-only (their spec pins
// that); these two need trigger/action types only the advanced editor authors (schedule.cron +
// run_integration_job; integration.run_finished), so they seed THAT editor's draft instead.
//
// A template is a starting draft and nothing more: it never saves, never enables, never flips a switch. Each one
// is OPEN only while the session feature the editor itself gates the same trigger/action on is on (the editor's
// integrationRunActionEnabled / integrationRunEventEnabled — MetaAutomationRuleEditor.vue). While that feature is
// off the template is LISTED LOCKED with its reason (the 1c node-library posture: show it, say why), never
// silently hidden and never clickable. The seed uses the editor's own saved-rule shape, so the editor loads it
// through the same draftFromRule() it loads a stored rule with — no second draft model.

/** The two session features the editor already gates run_integration_job / integration.run_finished on. */
export type AutomationTemplateFeature = 'integrationAutomationRunAction' | 'integrationAutomationRunEvent'

export interface AutomationRuleTemplate {
  /** Stable key → `data-automation-template="<key>"`. */
  key: 'stock-prep-daily-pull' | 'stock-prep-pull-failed-alert'
  requiredFeature: AutomationTemplateFeature
  titleKey: AutomationLabelKey
  descriptionKey: AutomationLabelKey
  lockedReasonKey: AutomationLabelKey
}

/** What a template hands the editor: the saved-rule fields its draft is built from (no id = a NEW rule). */
export interface AutomationRuleTemplateSeed {
  name: string
  triggerType: AutomationTriggerType
  triggerConfig: Record<string, unknown>
  actionType: AutomationActionType
  actionConfig: Record<string, unknown>
  actions: AutomationAction[]
}

export interface AutomationRuleTemplateOffer {
  template: AutomationRuleTemplate
  open: boolean
}

export const AUTOMATION_RULE_TEMPLATES: readonly AutomationRuleTemplate[] = [
  {
    key: 'stock-prep-daily-pull',
    requiredFeature: 'integrationAutomationRunAction',
    titleKey: 'recipe.stockPrepDailyPullTitle',
    descriptionKey: 'recipe.stockPrepDailyPullDesc',
    lockedReasonKey: 'recipe.stockPrepDailyPullLocked',
  },
  {
    key: 'stock-prep-pull-failed-alert',
    requiredFeature: 'integrationAutomationRunEvent',
    titleKey: 'recipe.stockPrepPullFailedAlertTitle',
    descriptionKey: 'recipe.stockPrepPullFailedAlertDesc',
    lockedReasonKey: 'recipe.stockPrepPullFailedAlertLocked',
  },
]

/** Every template, in order, with whether it is open under the given session features. */
export function automationRuleTemplateOffers(
  hasFeature: (feature: AutomationTemplateFeature) => boolean,
): AutomationRuleTemplateOffer[] {
  return AUTOMATION_RULE_TEMPLATES.map((template) => ({ template, open: hasFeature(template.requiredFeature) === true }))
}

/** Template A's schedule: 06:00 every day on the business clock. */
export const STOCK_PREP_DAILY_PULL_CRON = '0 6 * * *'
export const STOCK_PREP_DAILY_PULL_TIMEZONE = 'Asia/Shanghai'

function seedWithSoleAction(
  name: string,
  triggerType: AutomationTriggerType,
  triggerConfig: Record<string, unknown>,
  action: AutomationAction,
): AutomationRuleTemplateSeed {
  // The rule's ONE action travels in `actions` and is mirrored into the legacy pair — the shape the API returns.
  return { name, triggerType, triggerConfig, actionType: action.type, actionConfig: action.config, actions: [action] }
}

/**
 * The starting draft of a template. Fresh objects on every call (the editor mutates its draft in place).
 *   A: schedule.cron 06:00 Asia/Shanghai → run_integration_job { stock_prep_pull, projectNos: [], dry_run_only }.
 *      The project list is left EMPTY for the author; the editor's existing save gate refuses it until filled.
 *   B: integration.run_finished { job: stock_prep_pull, statuses: ['failed'] } → send_notification with NO
 *      recipient (the author picks them; the editor's save gate refuses an empty list as it does today).
 */
export function buildAutomationTemplateSeed(template: AutomationRuleTemplate, isZh: boolean): AutomationRuleTemplateSeed {
  const name = automationLabel(template.titleKey, isZh)
  if (template.key === 'stock-prep-daily-pull') {
    return seedWithSoleAction(
      name,
      RUN_INTEGRATION_JOB_TRIGGER_TYPE,
      { cron: STOCK_PREP_DAILY_PULL_CRON, timezone: STOCK_PREP_DAILY_PULL_TIMEZONE },
      {
        type: RUN_INTEGRATION_JOB_ACTION_TYPE,
        config: {
          job: {
            kind: RUN_INTEGRATION_JOB_AUTHORABLE_KIND,
            projectNos: [],
            applyMode: RUN_INTEGRATION_JOB_AUTHORABLE_APPLY_MODE,
          },
        },
      },
    )
  }
  return seedWithSoleAction(
    name,
    INTEGRATION_RUN_FINISHED_TRIGGER_TYPE,
    { job: { kind: RUN_INTEGRATION_JOB_AUTHORABLE_KIND }, statuses: ['failed'] },
    {
      type: 'send_notification',
      config: { userIds: [], message: automationLabel('recipe.stockPrepPullFailedAlertMessage', isZh) },
    },
  )
}
