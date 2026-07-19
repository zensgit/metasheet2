/**
 * FWB-1 config UI — the mapping-config MODEL (fail-closed validation the editor binds to).
 *
 * A saved config maps template form fields → target sheet fields for `write_approval_form_values`.
 * The editor may only offer valid choices, but the model re-validates the WHOLE draft before save
 * (edit-safety = fail-closed allowlist, same doctrine as template authoring):
 *   - every mapping must reference an EXISTING template field and an EXISTING target field;
 *   - source fields are limited to the ratified scalar surface;
 *   - the target field's normalized type must be one of the ratified v1 types;
 *   - no two mappings may write the same target field (last-write ambiguity is a config bug);
 *   - an empty mapping list is invalid (a no-op rule must not be saveable as if it did something).
 *
 * Values-free error codes; the server re-validates on save AND the executor re-checks at run time
 * (§11 Q6 gates + fail-closed mapping) — this model is UX, not the security boundary.
 */
export interface FwbMappingDraft {
  formFieldId: string
  targetFieldId: string
}

export interface TemplateFieldInfo {
  id: string
  label: string
  type?: string
}

export interface TargetFieldInfo {
  id: string
  label: string
  type: string
}

export type FwbConfigIssue =
  | { code: 'empty_config' }
  | { code: 'unknown_form_field' | 'unsupported_source_type' | 'unknown_target_field' | 'unsupported_target_type' | 'duplicate_target'; index: number }

export const FWB_V1_SOURCE_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text', 'textarea', 'number', 'date', 'datetime', 'select',
])

export const FWB_V1_TARGET_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text', 'number', 'date', 'dateTime', 'select',
])

export function isFwbV1SourceFieldType(type: string): boolean {
  return FWB_V1_SOURCE_FIELD_TYPES.has(type)
}

export function normalizeFwbTargetFieldType(type: string): string {
  if (type === 'singleLineText' || type === 'longText' || type === 'string') return 'text'
  if (type === 'datetime') return 'dateTime'
  if (type === 'singleSelect') return 'select'
  return type
}

export function isFwbV1TargetFieldType(type: string): boolean {
  return FWB_V1_TARGET_FIELD_TYPES.has(normalizeFwbTargetFieldType(type))
}

/** Validate the whole draft; [] = saveable. Editor disables save while non-empty. */
export function validateFwbMappingConfig(
  draft: readonly FwbMappingDraft[],
  templateFields: readonly TemplateFieldInfo[],
  targetFields: readonly TargetFieldInfo[],
): FwbConfigIssue[] {
  if (!draft || draft.length === 0) return [{ code: 'empty_config' }]
  const issues: FwbConfigIssue[] = []
  const tpl = new Map(templateFields.map((f) => [f.id, f]))
  const tgt = new Map(targetFields.map((f) => [f.id, f]))
  const seenTargets = new Set<string>()
  draft.forEach((m, index) => {
    const source = tpl.get(m.formFieldId)
    if (!source) issues.push({ code: 'unknown_form_field', index })
    else if (source.type && !isFwbV1SourceFieldType(source.type)) {
      issues.push({ code: 'unsupported_source_type', index })
    }
    const t = tgt.get(m.targetFieldId)
    if (!t) {
      issues.push({ code: 'unknown_target_field', index })
      return
    }
    if (!isFwbV1TargetFieldType(t.type)) issues.push({ code: 'unsupported_target_type', index })
    if (seenTargets.has(m.targetFieldId)) issues.push({ code: 'duplicate_target', index })
    seenTargets.add(m.targetFieldId)
  })
  return issues
}
