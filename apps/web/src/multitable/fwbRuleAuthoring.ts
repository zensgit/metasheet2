/**
 * FWB production authoring helpers for the automation rule editor.
 *
 * The reusable ApprovalFwbMappingEditor never owns confirmationHash; this module converts between
 * the persisted write_approval_form_values actionConfig and the editor draft, and keeps flag/trigger
 * selection rules pure so the Vue host stays thin.
 */
import {
  toExecutorMappings,
  type FwbMappingDraft,
  type TargetFieldInfo,
  type TemplateFieldInfo,
} from '../approvals/fwbMappingConfig'
import type { AutomationActionType } from './types'

export const FWB_ACTION_TYPE = 'write_approval_form_values' as const
export type FwbActionType = typeof FWB_ACTION_TYPE

/** Parent-owned confirmation lifecycle; mirrors ApprovalFwbMappingEditor's confirmationState. */
export type FwbMappingConfirmationState = 'unconfirmed' | 'confirming' | 'confirmed'

export type FwbExecutorMapping = ReturnType<typeof toExecutorMappings>[number]

export interface FwbPersistedActionConfig {
  mappings: FwbExecutorMapping[]
  sourceTemplateVersionId: string
  confirmationHash: string
}

export interface FwbDraftActionConfig {
  /** UI mapping rows (form field → target field ids only). */
  fwbMappings: FwbMappingDraft[]
  /** Active template version the author confirmed against (bound into the server hash). */
  sourceTemplateVersionId: string
  /** Server-owned confirmation hash; empty until the confirm round-trip succeeds. */
  confirmationHash: string
  /** Parent-owned confirmation lifecycle state for the mapping editor chrome. */
  fwbConfirmationState: FwbMappingConfirmationState
  /**
   * Lossless executor-shaped mappings from a loaded rule. Used when the flag is OFF so a
   * read-only re-save never rewrites or drops the persisted mapping contract.
   */
  fwbPersistedMappings: FwbExecutorMapping[] | null
  /** True when this action was loaded from a saved rule (not freshly selected in the editor). */
  fwbWasPersisted: boolean
}

export function isFwbActionType(type: string | null | undefined): type is FwbActionType {
  return type === FWB_ACTION_TYPE
}

/** New FWB selection is allowed only when the runtime flag is ON and the trigger is approval.completed. */
export function canSelectNewFwbAction(flagEnabled: boolean, triggerType: string): boolean {
  return flagEnabled && triggerType === 'approval.completed'
}

/**
 * Keep a persisted FWB action visible even when the flag is OFF or the trigger drifted, so the
 * author can see it as blocked/read-only instead of having it vanish from the type dropdown.
 */
export function isFwbActionSelectable(
  flagEnabled: boolean,
  triggerType: string,
  currentType: AutomationActionType,
): boolean {
  if (isFwbActionType(currentType)) return true
  return canSelectNewFwbAction(flagEnabled, triggerType)
}

/** Read-only when the flag is OFF or the trigger is no longer approval.completed. */
export function isFwbActionReadOnly(
  flagEnabled: boolean,
  triggerType: string,
  _wasPersisted = false,
): boolean {
  if (!flagEnabled) return true
  return triggerType !== 'approval.completed'
}

export function fwbReadOnlyStatusMessage(isZh: boolean, flagEnabled: boolean, triggerType: string): string {
  if (!flagEnabled) {
    return isZh
      ? '审批回写未启用：已保存的回写动作只读保留，不会被静默删除。'
      : 'Approval writeback is disabled: the saved action is kept read-only and will not be removed silently.'
  }
  if (triggerType !== 'approval.completed') {
    return isZh
      ? '审批回写仅可用于「审批完成」触发器。'
      : 'Approval writeback is only available on the approval.completed trigger.'
  }
  return isZh ? '审批回写当前不可编辑。' : 'Approval writeback is currently not editable.'
}

export function emptyFwbDraftConfig(): FwbDraftActionConfig {
  return {
    fwbMappings: [],
    sourceTemplateVersionId: '',
    confirmationHash: '',
    fwbConfirmationState: 'unconfirmed',
    fwbPersistedMappings: null,
    fwbWasPersisted: false,
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseExecutorMappings(raw: unknown): FwbExecutorMapping[] {
  if (!Array.isArray(raw)) return []
  const out: FwbExecutorMapping[] = []
  for (const entry of raw) {
    if (!isPlainRecord(entry)) continue
    const formFieldId = typeof entry.formFieldId === 'string' ? entry.formFieldId : ''
    const targetFieldId = typeof entry.targetFieldId === 'string' ? entry.targetFieldId : ''
    const targetType = entry.targetType
    if (!formFieldId || !targetFieldId) continue
    if (targetType !== 'text' && targetType !== 'number' && targetType !== 'date' && targetType !== 'select') continue
    const mapping: FwbExecutorMapping = {
      formFieldId,
      targetFieldId,
      targetType,
    }
    if (targetType === 'select' && Array.isArray(entry.selectOptions)) {
      mapping.selectOptions = entry.selectOptions.filter((opt): opt is string => typeof opt === 'string')
    }
    out.push(mapping)
  }
  return out
}

/** Hydrate a draft config from a persisted write_approval_form_values actionConfig. */
export function draftConfigFromFwbAction(
  config: Record<string, unknown>,
  options: { persisted: boolean } = { persisted: true },
): FwbDraftActionConfig {
  const mappings = parseExecutorMappings(config.mappings)
  const confirmationHash = typeof config.confirmationHash === 'string' ? config.confirmationHash : ''
  const sourceTemplateVersionId = typeof config.sourceTemplateVersionId === 'string'
    ? config.sourceTemplateVersionId
    : ''
  return {
    fwbMappings: mappings.map((m) => ({ formFieldId: m.formFieldId, targetFieldId: m.targetFieldId })),
    sourceTemplateVersionId,
    confirmationHash,
    // A loaded confirmed hash starts as confirmed; any later mapping mutation invalidates it.
    fwbConfirmationState: confirmationHash ? 'confirmed' : 'unconfirmed',
    fwbPersistedMappings: mappings.length > 0 ? mappings : null,
    fwbWasPersisted: options.persisted,
  }
}

export function sheetFieldsToFwbTargets(
  fields: ReadonlyArray<{ id: string; name: string; type: string; options?: ReadonlyArray<{ value: string }> }>,
): TargetFieldInfo[] {
  return fields.map((field) => {
    const selectOptions = Array.isArray(field.options)
      ? field.options.map((opt) => opt.value).filter((value): value is string => typeof value === 'string')
      : undefined
    return {
      id: field.id,
      label: field.name,
      type: field.type === 'string' ? 'text' : field.type,
      ...(selectOptions && selectOptions.length > 0 ? { selectOptions } : {}),
    }
  })
}

export function templateSchemaToFwbFields(
  formSchema: { fields?: ReadonlyArray<{ id?: unknown; label?: unknown }> } | null | undefined,
): TemplateFieldInfo[] {
  const fields = Array.isArray(formSchema?.fields) ? formSchema!.fields! : []
  return fields
    .map((field) => {
      const id = typeof field?.id === 'string' ? field.id : ''
      const label = typeof field?.label === 'string' && field.label.trim() ? field.label : id
      return id ? { id, label } : null
    })
    .filter((field): field is TemplateFieldInfo => !!field)
}

/**
 * Build the wire actionConfig for save.
 *
 * Flag OFF + persisted: re-emit the original executor mappings + hash (lossless, no client re-hash).
 * Flag ON: require a server confirmationHash and project the current draft through toExecutorMappings
 * when the draft is currently valid; otherwise fall back to persisted mappings only when still confirmed.
 */
export function buildFwbActionConfigForSave(
  draft: FwbDraftActionConfig,
  targetFields: readonly TargetFieldInfo[],
  options: { flagEnabled: boolean; readOnly: boolean },
): FwbPersistedActionConfig | { error: string } {
  const sourceTemplateVersionId = draft.sourceTemplateVersionId.trim()
  const confirmationHash = draft.confirmationHash.trim()

  if (options.readOnly || !options.flagEnabled) {
    const mappings = draft.fwbPersistedMappings
    if (!mappings || mappings.length === 0) {
      return { error: 'fwb_persisted_mappings_missing' }
    }
    if (!sourceTemplateVersionId || !confirmationHash) {
      return { error: 'fwb_confirmation_missing' }
    }
    return {
      mappings,
      sourceTemplateVersionId,
      confirmationHash,
    }
  }

  if (!confirmationHash || draft.fwbConfirmationState !== 'confirmed') {
    return { error: 'fwb_confirmation_required' }
  }
  if (!sourceTemplateVersionId) {
    return { error: 'fwb_template_version_required' }
  }

  try {
    const mappings = toExecutorMappings(draft.fwbMappings, targetFields)
    return {
      mappings,
      sourceTemplateVersionId,
      confirmationHash,
    }
  } catch {
    // Draft no longer validates — refuse rather than invent mappings.
    return { error: 'fwb_mapping_invalid' }
  }
}

/** Invalidate server confirmation after any subject-affecting edit (mapping / template / version). */
export function invalidateFwbConfirmation(draft: FwbDraftActionConfig): FwbDraftActionConfig {
  return {
    ...draft,
    confirmationHash: '',
    fwbConfirmationState: 'unconfirmed',
  }
}
