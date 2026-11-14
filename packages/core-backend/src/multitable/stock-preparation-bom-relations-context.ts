/**
 * 备料 BOM relations — the /context block that tells the workbench WHICH physical columns of a stock-preparation
 * main-template sheet hold the PLM material id, the parent's PLM material id, 有效, 图号 and 名称, so the record
 * drawer can offer 「查看子件」 / 「查看所有使用位置」 (owner question 2026-11-07). Read-only: it never writes.
 *
 * WHY THE HOST HAS TO SAY IT. Physical field ids are `getObjectFieldId(projectId, objectId, logicalId)` — a sha1 the
 * web cannot recompute (it never sees the registry's project / object), and the field property carries only the
 * plugin's `stockPreparation` stanza `{ ownership, preserveOnRefresh, required, key }`, no logical id. Column NAMES
 * differ by install and era (`Component Source ID` / `部件源ID` / `PLM 物料ID`), so name matching would be a guess.
 *
 * THE RULE — every half must hold, otherwise no block (fail closed; the drawer shows no buttons):
 *   (1) the HOST registry row (`plugin_multitable_object_registry`, server-owned, written only inside a plugin's
 *       provisioning transaction) names the stock-preparation plugin;
 *   (2) each of the five logical columns, derived exactly as provisioning derives it from that row's project and
 *       object, EXISTS on the sheet and carries the exact `stockPreparation` stanza with `ownership: 'plm_system'`
 *       (so another plugin object, the MVP tables or a ledger — none of which have these columns — issue nothing);
 *   (3) the actor may READ each of them (`allowedFieldIds`, layer-2 ∧ layer-3) — a column the actor cannot read
 *       would make every button a 400, so they are simply not offered.
 * A thrown registry read is caught by the caller and treated as "no block".
 *
 * VALUES-FREE. The block carries field ids only — never a value, project, sheet or object id. Its reader can
 * already read the sheet and these columns.
 */
import { getObjectFieldId } from './provisioning'
import { normalizeProperty } from './record-duplicate-guard'
import { readManualRowsHostRegistry, type ManualRowsQueryFn } from './stock-preparation-manual-rows-gate'
import { STOCK_PREPARATION_PROJECT_SHEET_PLUGIN } from './stock-preparation-project-sheet-schema-clamp'

/** The main template's logical ids (plugins/plugin-integration-core/lib/stock-preparation-templates.cjs). */
export const BOM_RELATIONS_LOGICAL_FIELD_IDS = Object.freeze({
  componentSourceFieldId: 'componentSourceId',
  parentSourceFieldId: 'parentSourceId',
  activeFieldId: 'active',
  componentCodeFieldId: 'componentCode',
  componentNameFieldId: 'componentName',
} as const)

export type BomRelationsContextBlock = Readonly<{
  componentSourceFieldId: string
  parentSourceFieldId: string
  activeFieldId: string
  componentCodeFieldId: string
  componentNameFieldId: string
}>

type FieldLike = { id?: unknown; property?: unknown }

function isPlmSystemStanzaField(field: FieldLike | undefined): boolean {
  const property = normalizeProperty(field?.property)
  if (!property || !Object.prototype.hasOwnProperty.call(property, 'stockPreparation')) return false
  const stanza = normalizeProperty(property.stockPreparation)
  return !!stanza && stanza.ownership === 'plm_system'
}

/** Pure: the block for a host registry row, or null when any half of the rule fails. */
export function bomRelationsContextBlockOf(input: {
  pluginName: unknown
  projectId: unknown
  objectId: unknown
  fields: ReadonlyArray<FieldLike>
  readableFieldIds: ReadonlySet<string>
}): BomRelationsContextBlock | null {
  if (input.pluginName !== STOCK_PREPARATION_PROJECT_SHEET_PLUGIN) return null
  if (typeof input.projectId !== 'string' || !input.projectId) return null
  if (typeof input.objectId !== 'string' || !input.objectId) return null
  const byId = new Map<string, FieldLike>()
  for (const field of input.fields) {
    if (typeof field?.id === 'string' && field.id) byId.set(field.id, field)
  }
  const block: Record<string, string> = {}
  for (const [key, logical] of Object.entries(BOM_RELATIONS_LOGICAL_FIELD_IDS)) {
    const physical = getObjectFieldId(input.projectId, input.objectId, logical)
    if (!isPlmSystemStanzaField(byId.get(physical))) return null
    if (!input.readableFieldIds.has(physical)) return null
    block[key] = physical
  }
  return Object.freeze(block) as BomRelationsContextBlock
}

/** IO: reads the host registry row (fixed SQL, shared with the manual-rows gate). Unreadable or absent ⇒ null. */
export async function resolveBomRelationsContextBlock(
  query: ManualRowsQueryFn,
  sheetId: string,
  fields: ReadonlyArray<FieldLike>,
  readableFieldIds: ReadonlySet<string>,
): Promise<BomRelationsContextBlock | null> {
  const read = await readManualRowsHostRegistry(query, sheetId)
  if (read.kind !== 'present') return null
  return bomRelationsContextBlockOf({
    pluginName: read.row.pluginName,
    projectId: read.row.projectId,
    objectId: read.row.objectId,
    fields,
    readableFieldIds,
  })
}
