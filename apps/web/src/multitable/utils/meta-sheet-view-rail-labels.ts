// Sheet/view tree rail string table (UI-P2-2b, design
// docs/development/multitable-ui-p2-2b-vertical-tree-design-20260713.md §5.4).
//
// Scope: MetaSheetViewRail.vue static chrome only (the tree's own aria-label + the "add sheet"
// row). The personal-view-toggle's inline label ('个人视图' / 'My view') is deliberately NOT here
// — §5.4 keeps it inline (minimal diff, pre-existing string, byte-unchanged).

export type MetaSheetViewRailLabelKey =
  | 'rail.treeLabel'
  | 'rail.addSheet'

const META_SHEET_VIEW_RAIL_LABELS: Record<MetaSheetViewRailLabelKey, { en: string; zh: string }> = {
  'rail.treeLabel': { en: 'Tables and views', zh: '数据表与视图' },
  'rail.addSheet': { en: 'New table', zh: '新建数据表' },
}

export function railLabel(key: MetaSheetViewRailLabelKey, isZh: boolean): string {
  const entry = META_SHEET_VIEW_RAIL_LABELS[key]
  return isZh ? entry.zh : entry.en
}
