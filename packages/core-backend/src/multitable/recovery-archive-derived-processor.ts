import type { QueryFn } from './permission-service'
import type { RecoveryArchiveDerivedWork } from './recovery-archive-derived-effects'
import type { RecoverySheetAuthority } from './recovery-authorization-stability'
import type { RecordWriteHelpers, UniverMetaField, UniverMetaRecord, RelationalLinkField } from './record-write-service'
import { loadFieldsForSheet } from './loaders'

type ComputedHelpers = Pick<RecordWriteHelpers,
  'applyLookupRollup' | 'computeDependentLookupRollupRecords' | 'recalculateFormulaFields' |
  'loadLinkValuesByRecord' | 'parseLinkFieldConfig' | 'normalizeJson'>

/** Internal assembly only: the route factory binds canonical authority and strict computed helpers. */
export function bindRecoveryArchiveDerivedProcessor(deps: {
  query: QueryFn
  authorize: (work: RecoveryArchiveDerivedWork) => Promise<boolean>
  resolveAuthority: (sheetId: string, identity: RecoveryArchiveDerivedWork['identity']) => Promise<RecoverySheetAuthority | null>
  helpers: (authority: RecoverySheetAuthority) => ComputedHelpers
  invalidate: (groups: Array<{ sheetId: string; recordIds: string[]; fieldIds: string[] }>) => Promise<void>
}): (work: RecoveryArchiveDerivedWork) => Promise<boolean> {
  return async (work) => {
    if (!(await deps.authorize(work))) return false
    const groups = new Map<string, { records: Set<string>; fields: Set<string> }>()
    const add = (sheetId: string, recordIds: string[], fieldIds: string[]) => {
      const group = groups.get(sheetId) ?? { records: new Set<string>(), fields: new Set<string>() }
      for (const id of recordIds) group.records.add(id)
      for (const id of fieldIds) group.fields.add(id)
      groups.set(sheetId, group)
    }
    add(work.identity.sheetId, [work.recordId], work.fieldIds)
    for (const link of work.linkInvalidations) add(link.sheetId, link.recordIds, link.fieldIds)
    const authorities = new Map<string, RecoverySheetAuthority>()
    // Reject missing scope before any materialization; do not infer a system actor for foreign sheets.
    for (const sheetId of groups.keys()) {
      const authority = await deps.resolveAuthority(sheetId, work.identity)
      if (!authority || authority.access.userId !== work.identity.actorId) return false
      authorities.set(sheetId, authority)
    }
    const notifications = new Map<string, { records: Set<string>; fields: Set<string> }>()
    const notify = (sheetId: string, recordIds: string[], fieldIds: string[]) => {
      const group = notifications.get(sheetId) ?? { records: new Set<string>(), fields: new Set<string>() }
      for (const id of recordIds) group.records.add(id)
      for (const id of fieldIds) group.fields.add(id)
      notifications.set(sheetId, group)
    }
    for (const [sheetId, group] of groups) {
      const helpers = deps.helpers(authorities.get(sheetId)!)
      const fields = await loadFieldsForSheet(deps.query, sheetId) as UniverMetaField[]
      const fieldIds = [...group.fields]
      const recordIds = [...group.records]
      const result = await deps.query('SELECT id,version,data FROM meta_records WHERE sheet_id=$1 AND id=ANY($2::text[])', [sheetId, recordIds])
      const rows: UniverMetaRecord[] = (result.rows as Array<{ id: string; version: number; data: unknown }>).map(row => ({
        id: row.id, version: Number(row.version), data: helpers.normalizeJson(row.data),
      }))
      const links = fields.map(field => field.type === 'link'
        ? { fieldId: field.id, cfg: helpers.parseLinkFieldConfig(field.property) } : null)
        .filter((link): link is RelationalLinkField => link !== null && link.cfg !== null)
      const values = await helpers.loadLinkValuesByRecord(deps.query, rows.map(row => row.id), links)
      await helpers.applyLookupRollup(deps.query, sheetId, fields, rows, links, values)
      const formulas = await helpers.recalculateFormulaFields(deps.query, sheetId, fields,
        rows.map(row => row.id), fieldIds, new Map(rows.map(row => [row.id, row.data])))
      notify(sheetId, recordIds, [...fieldIds, ...formulas.flatMap(row => Object.keys(row.data))])
      if (sheetId === work.identity.sheetId && fieldIds.length) {
        const related = await helpers.computeDependentLookupRollupRecords(deps.query, sheetId, recordIds, fieldIds)
        for (const row of related) notify(row.sheetId, [row.recordId], row.affectedFieldIds ?? [])
      }
    }
    await deps.invalidate([...notifications].map(([sheetId, group]) => ({
      sheetId, recordIds: [...group.records], fieldIds: [...group.fields],
    })))
    return true
  }
}
