/**
 * FWB-1 config UI — the mapping-config MODEL (fail-closed validation the editor binds to).
 *
 * A saved config maps template form fields → target sheet fields for `write_approval_form_values`.
 * The editor may only offer valid choices, but the model re-validates the WHOLE draft before save
 * (edit-safety = fail-closed allowlist, same doctrine as template authoring):
 *   - every mapping must reference an EXISTING template field and an EXISTING target field;
 *   - text/date/select are authorable; number remains unavailable until the
 *     exact-decimal D0-D4 contract is implemented end to end;
 *   - a select target must carry a non-empty option set (the executor enforces the closed vocabulary);
 *   - no two mappings may write the same target field (last-write ambiguity is a config bug);
 *   - an empty mapping list is invalid (a no-op rule must not be saveable as if it did something).
 *
 * Values-free error codes; the server re-validates on save AND the executor re-checks at run time
 * (§11 Q6 gates + fail-closed mapping) — this model is UX, not the security boundary.
 */
export type FwbTargetType = 'text' | 'number' | 'date' | 'select'

export interface FwbMappingDraft {
  formFieldId: string
  targetFieldId: string
}

export interface TemplateFieldInfo {
  id: string
  label: string
}

export interface TargetFieldInfo {
  id: string
  label: string
  type: string
  selectOptions?: readonly string[]
}

export type FwbConfigIssue =
  | { code: 'empty_config' }
  | { code: 'unknown_form_field' | 'unknown_target_field' | 'unsupported_target_type' | 'exact_number_mapping_unavailable' | 'select_options_missing' | 'duplicate_target'; index: number }

const V1_TYPES: readonly string[] = ['text', 'number', 'date', 'select']

function toFwbTargetType(type: string): FwbTargetType | null {
  if (type === 'string' || type === 'text') return 'text'
  return V1_TYPES.includes(type) ? type as FwbTargetType : null
}

/** Validate the whole draft; [] = saveable. Editor disables save while non-empty. */
export function validateFwbMappingConfig(
  draft: readonly FwbMappingDraft[],
  templateFields: readonly TemplateFieldInfo[],
  targetFields: readonly TargetFieldInfo[],
): FwbConfigIssue[] {
  if (!draft || draft.length === 0) return [{ code: 'empty_config' }]
  const issues: FwbConfigIssue[] = []
  const tpl = new Set(templateFields.map((f) => f.id))
  const tgt = new Map(targetFields.map((f) => [f.id, f]))
  const seenTargets = new Set<string>()
  draft.forEach((m, index) => {
    if (!tpl.has(m.formFieldId)) issues.push({ code: 'unknown_form_field', index })
    const t = tgt.get(m.targetFieldId)
    if (!t) {
      issues.push({ code: 'unknown_target_field', index })
      return
    }
    const targetType = toFwbTargetType(t.type)
    if (!targetType) issues.push({ code: 'unsupported_target_type', index })
    if (targetType === 'number') issues.push({ code: 'exact_number_mapping_unavailable', index })
    if (targetType === 'select' && (!t.selectOptions || t.selectOptions.length === 0)) issues.push({ code: 'select_options_missing', index })
    if (seenTargets.has(m.targetFieldId)) issues.push({ code: 'duplicate_target', index })
    seenTargets.add(m.targetFieldId)
  })
  return issues
}

/** Executor-shaped mappings from a VALIDATED draft (throws if called on an invalid one — programmer error). */
export function toExecutorMappings(
  draft: readonly FwbMappingDraft[],
  targetFields: readonly TargetFieldInfo[],
): Array<{ formFieldId: string; targetFieldId: string; targetType: FwbTargetType; selectOptions?: readonly string[] }> {
  const tgt = new Map(targetFields.map((f) => [f.id, f]))
  return draft.map((m) => {
    const t = tgt.get(m.targetFieldId)
    const targetType = t ? toFwbTargetType(t.type) : null
    if (!t || !targetType || targetType === 'number') throw new RangeError('toExecutorMappings called on an unvalidated draft')
    return {
      formFieldId: m.formFieldId,
      targetFieldId: m.targetFieldId,
      targetType,
      ...(targetType === 'select' ? { selectOptions: t.selectOptions } : {}),
    }
  })
}
