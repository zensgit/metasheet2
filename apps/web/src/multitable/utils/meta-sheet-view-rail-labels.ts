// Sheet/view tree rail string table (UI-P2-2b, design
// docs/development/multitable-ui-p2-2b-vertical-tree-design-20260713.md §5.4).
//
// Scope: MetaSheetViewRail.vue static chrome only (the tree's own aria-label + the "add sheet"
// row). The personal-view-toggle's inline label ('个人视图' / 'My view') is deliberately NOT here
// — §5.4 keeps it inline (minimal diff, pre-existing string, byte-unchanged).

export type MetaSheetViewRailLabelKey =
  | 'rail.treeLabel'
  | 'rail.addSheet'
  // Rename affordance (feat/multitable-rename): pencil button + inline confirm/cancel, gated
  // server-side on canManageFields — see MultitableWorkbench.vue's onRenameSheet.
  | 'rail.renameSheet' | 'rail.confirmRenameSheet' | 'rail.cancelRenameSheet'
  // Delete affordance: trash button on the SELECTED sheet row only, gated on the server-derived
  // canDeleteSheet bit — see MultitableWorkbench.vue's onDeleteSheet (confirm lives there, not here).
  | 'rail.deleteSheet'
  // 复制数据表 S1 (ADR multitable-copy-sheet-with-data-adr-20260926.md CS-2 entry ①, CS-14 badges): copy
  // button on the SELECTED sheet row only, gated on the server-derived canCopySheet bit; provenance
  // badges next to the sheet name, driven only by the server's copiedFrom (readSheetCopiedFrom).
  | 'rail.copySheet'
  | 'rail.badgeSnapshotCopy' | 'rail.badgeSnapshotCopyTitle'
  | 'rail.badgeNoPlmRefresh' | 'rail.badgeNoPlmRefreshTitle'

const META_SHEET_VIEW_RAIL_LABELS: Record<MetaSheetViewRailLabelKey, { en: string; zh: string }> = {
  'rail.treeLabel': { en: 'Tables and views', zh: '数据表与视图' },
  'rail.addSheet': { en: 'New table', zh: '新建数据表' },
  'rail.renameSheet': { en: 'Rename', zh: '重命名' },
  'rail.confirmRenameSheet': { en: 'Confirm rename', zh: '确认重命名' },
  'rail.cancelRenameSheet': { en: 'Cancel rename', zh: '取消重命名' },
  'rail.deleteSheet': { en: 'Delete table', zh: '删除数据表' },
  'rail.copySheet': { en: 'Copy table', zh: '复制数据表' },
  'rail.badgeSnapshotCopy': { en: 'Snapshot copy', zh: '快照副本' },
  'rail.badgeSnapshotCopyTitle': {
    en: 'A snapshot of another table at the moment it was copied; it does not follow later changes to that table.',
    zh: '这是另一张数据表在复制时刻的快照，不会随源表后续变化而更新。',
  },
  'rail.badgeNoPlmRefresh': { en: 'Not refreshed from PLM', zh: '不随 PLM 刷新' },
  'rail.badgeNoPlmRefreshTitle': {
    en: 'Copied from a plugin-managed table; PLM refreshes do not update this copy.',
    zh: '复制自插件托管的数据表；PLM 刷新不会更新这份副本。',
  },
}

export function railLabel(key: MetaSheetViewRailLabelKey, isZh: boolean): string {
  const entry = META_SHEET_VIEW_RAIL_LABELS[key]
  return isZh ? entry.zh : entry.en
}
