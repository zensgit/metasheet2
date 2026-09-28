/**
 * Lookup target fields — 客户反馈 2026-09-24 #4c follow-up (deferred by PR #6083), 裁定见 PR #6074.
 *
 * A `lookup` cell holds the RAW values of a field on the linked (foreign) sheet. When that target is a
 * `dateTime` (or createdTime / modifiedTime), the raw values are UTC ISO instants, so the lookup column showed
 * `2026-09-24T01:00:00.000Z` next to a dateTime column showing `2026-09-24 09:00`. Formatting them needs the
 * TARGET field's type (never guessed from the value's shape — a text field may hold ISO-looking text), which
 * the lookup field itself does not carry: its property names only `foreignSheetId` + `targetFieldId`.
 *
 * This module is the one place that knowledge lives on the client:
 *   - `loadLookupTargetFields(fields, listFields)` resolves, for every lookup field of the current sheet, the
 *     target field's `{ type, property }` through the SAME read-gated `GET /api/multitable/fields?sheetId=`
 *     the field manager's lookup target picker already uses (one request per distinct foreign sheet);
 *   - `getLookupTargetField(lookupFieldId)` is what the display / export formatters read.
 *
 * Reactive for the same reason as the business timezone holder: the answer lands after the grid has rendered,
 * and every computed that formats a lookup cell must re-run when it does. A lookup whose target cannot be
 * resolved (foreign sheet unreadable, request failed, target gone) is simply absent — it keeps today's raw
 * display, never an error. Field ids are globally unique, so entries from different sheets never collide.
 */
import { ref } from 'vue'
import type { MetaField, MetaFieldType } from '../types'
import { resolveLinkFieldProperty, resolveLookupFieldProperty } from './field-config'

export interface LookupTargetField {
  type: MetaFieldType
  property?: Record<string, unknown>
}

const lookupTargetState = ref<Record<string, LookupTargetField>>({})

/** The resolved target field of a lookup field, or `null` when unknown (not a lookup, or not resolved yet). */
export function getLookupTargetField(lookupFieldId: string | null | undefined): LookupTargetField | null {
  if (!lookupFieldId) return null
  return lookupTargetState.value[lookupFieldId] ?? null
}

/** Record resolved targets (merged over what is already known). */
export function setLookupTargetFields(entries: Record<string, LookupTargetField>): void {
  lookupTargetState.value = { ...lookupTargetState.value, ...entries }
}

/** Forget every resolved target (tests). */
export function resetLookupTargetFields(): void {
  lookupTargetState.value = {}
}

interface LookupTargetRef {
  lookupFieldId: string
  foreignSheetId: string
  targetFieldId: string
}

/**
 * Where each lookup field of `fields` reads from: its own `foreignSheetId`, else the foreign sheet of the link
 * field it goes through (the server's rule in `applyLookupRollup`: `cfg.foreignSheetId ?? link.foreignSheetId`).
 */
export function lookupTargetRefs(fields: readonly MetaField[]): LookupTargetRef[] {
  const byId = new Map(fields.map((field) => [field.id, field]))
  const refs: LookupTargetRef[] = []
  for (const field of fields) {
    if (field.type !== 'lookup') continue
    const { linkFieldId, targetFieldId, foreignSheetId } = resolveLookupFieldProperty(field.property)
    if (!targetFieldId) continue
    const linkField = linkFieldId ? byId.get(linkFieldId) : undefined
    const sheetId = foreignSheetId ?? (linkField ? resolveLinkFieldProperty(linkField.property).foreignSheetId : null)
    if (!sheetId) continue
    refs.push({ lookupFieldId: field.id, foreignSheetId: sheetId, targetFieldId })
  }
  return refs
}

/** A stable key of the lookup wiring — callers re-resolve only when it changes. */
export function lookupTargetSignature(fields: readonly MetaField[]): string {
  return lookupTargetRefs(fields)
    .map((ref) => `${ref.lookupFieldId}>${ref.foreignSheetId}.${ref.targetFieldId}`)
    .sort()
    .join('|')
}

/**
 * Resolve the target field of every lookup in `fields` and record it. One `listFields` call per distinct
 * foreign sheet; a sheet whose listing fails is skipped (its lookups keep the raw display). Never throws.
 */
export async function loadLookupTargetFields(
  fields: readonly MetaField[],
  listFields: (sheetId: string) => Promise<MetaField[]>,
): Promise<void> {
  const refs = lookupTargetRefs(fields)
  if (refs.length === 0) return
  const sheetIds = [...new Set(refs.map((ref) => ref.foreignSheetId))]
  const fieldsBySheet = new Map<string, MetaField[]>()
  await Promise.all(sheetIds.map(async (sheetId) => {
    try {
      const listed = await listFields(sheetId)
      if (Array.isArray(listed)) fieldsBySheet.set(sheetId, listed)
    } catch {
      // Unreadable / failed: those lookups keep their raw display.
    }
  }))
  const next: Record<string, LookupTargetField> = { ...lookupTargetState.value }
  for (const ref of refs) {
    const listed = fieldsBySheet.get(ref.foreignSheetId)
    if (!listed) continue
    const target = listed.find((field) => field.id === ref.targetFieldId)
    // The foreign sheet WAS read and no longer has that field: drop any stale answer (raw display again).
    if (!target) {
      delete next[ref.lookupFieldId]
      continue
    }
    next[ref.lookupFieldId] = { type: target.type, ...(target.property ? { property: target.property } : {}) }
  }
  lookupTargetState.value = next
}
