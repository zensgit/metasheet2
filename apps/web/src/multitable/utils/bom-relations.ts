// 备料 「查看子件」 / 「查看所有使用位置」 (owner question 2026-11-07) — the PURE rules the workbench and the record drawer
// share. No IO, no component state.
//
// WHERE THE GATE IS. Only /context's `stockPreparationBomRelations` block says the sheet is a stock-preparation
// main-template sheet and which physical columns hold the PLM material id / the parent's PLM material id
// (multitable/stock-preparation-bom-relations-context.ts on the host: derived exactly as provisioning derives the ids,
// each column checked for the plugin's stanza and the actor's read permission). Column NAMES are never consulted — they
// differ by install and era. A block that is absent or not well formed ⇒ no buttons (fail closed).
//
// WHAT THE TWO BUTTONS ASK FOR — equality on the PLM ids, never on 图号 (a drawing number can repeat across parts):
//   子件      parentSourceId  is <this row's componentSourceId>  — this part's direct children; a sub-assembly used at
//             several positions lists its children once per position (each position is its own row on the sheet).
//   使用位置  componentSourceId is <this row's componentSourceId> — every position of this material on this sheet, each
//             row carrying its own parent.
// Both are VIEWER filters (useMultitableGrid ViewerFilterState): ANDed with the view's own stored filter by GET /view for
// this viewer's reads only, never written to the shared view or the personal overlay.

import type { ViewerFilterState } from '../composables/useMultitableGrid'
import type { MetaBomRelationsBlock, MetaRecord } from '../types'

export const BOM_RELATIONS_CONTEXT_KEY = 'stockPreparationBomRelations' as const

export type BomRelationKind = 'children' | 'whereUsed'

const BLOCK_KEYS: ReadonlyArray<keyof MetaBomRelationsBlock> = Object.freeze([
  'componentSourceFieldId',
  'parentSourceFieldId',
  'activeFieldId',
  'componentCodeFieldId',
  'componentNameFieldId',
])

/** Fail closed: every id a non-blank string, the two id columns distinct — else null (no buttons). */
export function readBomRelationsBlock(capabilities: unknown): MetaBomRelationsBlock | null {
  if (!capabilities || typeof capabilities !== 'object') return null
  const raw = (capabilities as Record<string, unknown>)[BOM_RELATIONS_CONTEXT_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Partial<MetaBomRelationsBlock> = {}
  for (const key of BLOCK_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value !== 'string' || value.trim() === '') return null
    out[key] = value
  }
  if (out.componentSourceFieldId === out.parentSourceFieldId) return null
  return out as MetaBomRelationsBlock
}

/** The row's own PLM material id as the filter value, or null when it has none (the buttons are then disabled). */
export function bomRelationsSourceValue(block: MetaBomRelationsBlock, record: MetaRecord | null | undefined): string | null {
  const value = record?.data?.[block.componentSourceFieldId]
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string' || value.trim() === '') return null
  return value
}

/** What the banner calls the part: 图号, else 名称, else a neutral word. Display only. */
export function bomRelationsPartLabel(block: MetaBomRelationsBlock, record: MetaRecord | null | undefined, isZh: boolean): string {
  for (const fieldId of [block.componentCodeFieldId, block.componentNameFieldId]) {
    const value = record?.data?.[fieldId]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return isZh ? '这个物料' : 'this part'
}

/** The viewer filter for one button, or null when the row has no PLM material id. */
export function buildBomRelationsViewerFilter(
  kind: BomRelationKind,
  block: MetaBomRelationsBlock,
  record: MetaRecord | null | undefined,
  isZh: boolean,
): ViewerFilterState | null {
  const source = bomRelationsSourceValue(block, record)
  if (source === null) return null
  const part = bomRelationsPartLabel(block, record, isZh)
  const fieldId = kind === 'children' ? block.parentSourceFieldId : block.componentSourceFieldId
  return {
    label: bomRelationsLabel(kind === 'children' ? 'banner.children' : 'banner.whereUsed', isZh, { part }),
    conditions: [{ fieldId, operator: 'is', value: source }],
  }
}

const LABELS = {
  'action.children': { zh: '查看子件', en: 'View children' },
  'action.childrenTitle': {
    zh: '只显示这个部件的直接子件。同一个部件用在几处，它的子件按每处各列一次。只对你生效，不改视图。',
    en: "Shows this part's direct children. A sub-assembly used at several positions lists its children once per position. Only for you; the view is not changed.",
  },
  'action.whereUsed': { zh: '查看所有使用位置', en: 'View all positions' },
  'action.whereUsedTitle': {
    zh: '列出这个物料在本表里的每一处位置，每行带着它的父件。只对你生效，不改视图。',
    en: 'Lists every position of this material on this sheet, each with its parent. Only for you; the view is not changed.',
  },
  'action.hint': {
    zh: '只对你生效，不改视图。同一个部件用在几处，它的子件按每处各列一次。',
    en: 'Only for you; the view is not changed. A sub-assembly used at several positions lists its children once per position.',
  },
  'action.noSource': { zh: '这一行没有 PLM 物料ID，无法查找子件或使用位置。', en: 'This row has no PLM material id, so it has no children or positions to look up.' },
  'banner.children': { zh: '正在查看：{part} 的子件（只对你生效）', en: 'Viewing: children of {part} (only for you)' },
  'banner.whereUsed': { zh: '正在查看：{part} 的所有使用位置（只对你生效）', en: 'Viewing: all positions of {part} (only for you)' },
  'banner.note': {
    zh: '只显示当前视图筛出的行（备料填写视图只含有效行）；要看已失效的位置，切到「全部记录」视图后再点一次。换视图或清除后回到原来的视图，视图本身没有被改动。',
    en: 'Only rows the current view shows are listed (the fill view keeps active rows only); to see inactive positions, switch to the All Records view and press the button again. Switching views or clearing returns to the view as it was — the view itself was not changed.',
  },
  'banner.clear': { zh: '清除，回到视图', en: 'Clear' },
} as const

export type BomRelationsLabelKey = keyof typeof LABELS

export function bomRelationsLabel(key: BomRelationsLabelKey, isZh: boolean, vars: Record<string, string> = {}): string {
  const text: string = isZh ? LABELS[key].zh : LABELS[key].en
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? vars[name] : match))
}
