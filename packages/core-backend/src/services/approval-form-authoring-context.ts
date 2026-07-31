import { collectFwbActionConfigs } from '../multitable/approval-fwb-activation'
import type {
  ApprovalFormExternalReferenceDTO,
  FormSchema,
} from '../types/approval-product'

export const FWB_MAPPING_REFERENCE_LOCATION =
  'automation.write_approval_form_values.mappings.formFieldId' as const
export const FWB_RECORD_LINK_REFERENCE_LOCATION =
  'automation.write_approval_form_values.recordLinkFieldId' as const

interface FwbRuleRow {
  action_type: string | null
  action_config: unknown
  actions: unknown
}

type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[] }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null
}

function collectSchemaIds(schema: unknown, output: Set<string>): void {
  if (!isRecord(schema) || !Array.isArray(schema.fields)) {
    throw new Error('approval_form_schema_history_incomplete')
  }

  for (const field of schema.fields) {
    if (!isRecord(field)) {
      throw new Error('approval_form_schema_history_incomplete')
    }
    const fieldId = nonBlankString(field.id)
    if (!fieldId) {
      throw new Error('approval_form_schema_history_incomplete')
    }
    output.add(fieldId)

    if (field.columns === undefined) continue
    if (!Array.isArray(field.columns)) {
      throw new Error('approval_form_schema_history_incomplete')
    }
    for (const column of field.columns) {
      if (!isRecord(column)) {
        throw new Error('approval_form_schema_history_incomplete')
      }
      const columnId = nonBlankString(column.id)
      if (!columnId) {
        throw new Error('approval_form_schema_history_incomplete')
      }
      output.add(columnId)
    }
  }
}

/**
 * Reserve every persisted top-level field and detail-column id ever used by a template.
 * Historical schemas are read as stored instead of being normalized under today's authoring
 * rules: an old-but-readable version must still reserve identities that the latest draft deleted.
 */
export function collectApprovalFormPersistentIds(
  formSchemas: readonly unknown[],
): string[] {
  const ids = new Set<string>()
  for (const schema of formSchemas) collectSchemaIds(schema, ids)
  return [...ids].sort()
}

function asPersistedActions(
  value: unknown,
): ReadonlyArray<{ type?: unknown; config?: unknown }> | null {
  return Array.isArray(value)
    ? value as ReadonlyArray<{ type?: unknown; config?: unknown }>
    : null
}

/**
 * Enumerate FWB references without exposing rule ids, target values, or action config. The shared
 * collectFwbActionConfigs walker is the authority for top-level versus nested action semantics.
 */
export function collectApprovalFormExternalReferences(
  rows: readonly FwbRuleRow[],
): ApprovalFormExternalReferenceDTO[] {
  const references = new Map<string, ApprovalFormExternalReferenceDTO>()
  const addReference = (reference: ApprovalFormExternalReferenceDTO) => {
    references.set(`${reference.fieldId}\u0000${reference.kind}`, reference)
  }

  for (const row of rows) {
    const configs = collectFwbActionConfigs(
      row.action_type,
      row.action_config,
      asPersistedActions(row.actions),
    )
    for (const config of configs) {
      if (Array.isArray(config.mappings)) {
        for (const mapping of config.mappings) {
          if (!isRecord(mapping)) continue
          const fieldId = nonBlankString(mapping.formFieldId)
          if (!fieldId) continue
          addReference({
            fieldId,
            kind: 'fwb_mapping',
            location: FWB_MAPPING_REFERENCE_LOCATION,
          })
        }
      }

      const recordLinkFieldId = nonBlankString(config.recordLinkFieldId)
      if (recordLinkFieldId) {
        addReference({
          fieldId: recordLinkFieldId,
          kind: 'fwb_record_link',
          location: FWB_RECORD_LINK_REFERENCE_LOCATION,
        })
      }
    }
  }

  return [...references.values()].sort((left, right) =>
    left.fieldId.localeCompare(right.fieldId)
      || left.kind.localeCompare(right.kind))
}

export async function loadApprovalFormExternalReferences(
  query: QueryFn,
  templateId: string,
): Promise<ApprovalFormExternalReferenceDTO[]> {
  const result = await query(
    `SELECT action_type, action_config, actions
     FROM automation_rules
     WHERE trigger_config->>'templateId' = $1`,
    [templateId],
  )
  return collectApprovalFormExternalReferences(result.rows as FwbRuleRow[])
}

export function findMissingApprovalFormReferenceIds(
  formSchema: FormSchema,
  references: readonly ApprovalFormExternalReferenceDTO[],
): string[] {
  const available = new Set(collectApprovalFormPersistentIds([formSchema]))
  return [...new Set(
    references
      .map((reference) => reference.fieldId)
      .filter((fieldId) => !available.has(fieldId)),
  )].sort()
}
