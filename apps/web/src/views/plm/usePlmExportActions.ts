import type {
  ApprovalEntry,
  BomLineRecord,
  BomTreeRowModel,
  CompareDetailRow,
  CompareEntry,
  DocumentEntry,
  PlmProductViewModel,
  SubstituteEntry,
  SubstitutePartRecord,
  SubstitutesPayload,
  WhereUsedEntry,
} from './plmPanelModels'

type UsePlmExportActionsOptions = {
  setDeepLinkMessage: (message: string, isError?: boolean) => void
  copyToClipboard: (value: string) => Promise<boolean>
  downloadCsv: (filename: string, headers: string[], rows: Array<string[]>) => void
  getWhereUsedFilteredRows: () => WhereUsedEntry[]
  formatWhereUsedEntryPathIds: (entry: WhereUsedEntry) => string
  getWhereUsedLineValue: (entry: WhereUsedEntry, key: string) => string
  getWhereUsedRefdes: (entry: WhereUsedEntry) => string
  getItemNumber: (item: Record<string, unknown> | null | undefined) => string
  getItemName: (item: Record<string, unknown> | null | undefined) => string
  getCompareAddedFiltered: () => CompareEntry[]
  getCompareRemovedFiltered: () => CompareEntry[]
  getCompareChangedFiltered: () => CompareEntry[]
  getCompareProp: (entry: CompareEntry, key: string) => string
  formatEffectivity: (entry: CompareEntry) => string
  formatSubstituteCount: (entry: CompareEntry) => string
  getCompareDetailRows: () => CompareDetailRow[]
  getBomView: () => 'table' | 'tree'
  getBomTreeRows: () => BomTreeRowModel[]
  getBomTreeFilteredKeys: () => Set<string>
  getBomFilteredItems: () => BomLineRecord[]
  getProductId: () => string
  getProductView: () => PlmProductViewModel
  resolveBomChildId: (item: BomLineRecord) => string
  resolveBomLineId: (item: BomLineRecord) => string
  formatBomFindNum: (item: BomLineRecord | null | undefined) => string
  formatBomRefdes: (item: BomLineRecord | null | undefined) => string
  formatBomTablePathIds: (item: BomLineRecord) => string
  getSubstitutesRows: () => SubstituteEntry[]
  getSubstitutesPayload: () => SubstitutesPayload | null
  getSubstituteSourcePart: (entry: SubstituteEntry) => SubstitutePartRecord
  getSubstituteId: (entry: SubstituteEntry) => string
  getSubstituteNumber: (entry: SubstituteEntry) => string
  getSubstituteName: (entry: SubstituteEntry) => string
  getSubstituteStatus: (entry: SubstituteEntry) => string
  formatSubstituteRank: (entry: SubstituteEntry) => string
  formatSubstituteNote: (entry: SubstituteEntry) => string
  getDocumentsSorted: () => DocumentEntry[]
  getDocumentName: (doc: DocumentEntry) => string
  getDocumentType: (doc: DocumentEntry) => string
  getDocumentRevision: (doc: DocumentEntry) => string
  getDocumentRole: (doc: DocumentEntry) => string
  getDocumentAuthor: (doc: DocumentEntry) => string
  getDocumentSourceSystem: (doc: DocumentEntry) => string
  getDocumentSourceVersion: (doc: DocumentEntry) => string
  getDocumentMime: (doc: DocumentEntry) => string
  getDocumentSize: (doc: DocumentEntry) => number | undefined
  getDocumentCreatedAt: (doc: DocumentEntry) => string
  getDocumentUpdatedAt: (doc: DocumentEntry) => string
  getDocumentPreviewUrl: (doc: DocumentEntry) => string
  getDocumentDownloadUrl: (doc: DocumentEntry) => string
  getApprovalsSorted: () => ApprovalEntry[]
  getApprovalTitle: (entry: ApprovalEntry) => string
  getApprovalStatus: (entry: ApprovalEntry) => string
  getApprovalType: (entry: ApprovalEntry) => string
  getApprovalRequester: (entry: ApprovalEntry) => string
  getApprovalRequesterId: (entry: ApprovalEntry) => string
  getApprovalCreatedAt: (entry: ApprovalEntry) => string
  getApprovalProductNumber: (entry: ApprovalEntry) => string
  getApprovalProductName: (entry: ApprovalEntry) => string
  getApprovalProductId: (entry: ApprovalEntry) => string
}

function normalizeDash(value: string): string {
  return value === '-' ? '' : value
}

export function usePlmExportActions(options: UsePlmExportActionsOptions) {
  function exportWhereUsedCsv() {
    const headers = [
      'level',
      'parent_id',
      'parent_number',
      'parent_name',
      'path',
      'path_ids',
      'quantity',
      'uom',
      'find_num',
      'refdes',
      'relationship_id',
    ]
    const rows = options.getWhereUsedFilteredRows().map((entry) => [
      String(entry.level ?? ''),
      String(entry.parent?.id || entry.relationship?.source_id || ''),
      options.getItemNumber(entry.parent),
      options.getItemName(entry.parent),
      entry.pathLabel || '',
      options.formatWhereUsedEntryPathIds(entry),
      normalizeDash(options.getWhereUsedLineValue(entry, 'quantity')),
      normalizeDash(options.getWhereUsedLineValue(entry, 'uom')),
      normalizeDash(options.getWhereUsedLineValue(entry, 'find_num')),
      normalizeDash(options.getWhereUsedRefdes(entry)),
      String(entry.relationship?.id || ''),
    ])
    options.downloadCsv(`plm-where-used-${Date.now()}.csv`, headers, rows)
  }

  function exportBomCompareCsv() {
    const headers = [
      'change_type',
      'severity',
      'parent_id',
      'parent_number',
      'parent_name',
      'child_id',
      'child_number',
      'child_name',
      'quantity',
      'uom',
      'find_num',
      'refdes',
      'effectivity',
      'substitutes',
      'line_key',
      'relationship_id',
      'changes',
    ]
    const buildRow = (entry: CompareEntry, type: string) => [
      type,
      String(entry.severity || ''),
      String(entry.parent?.id || entry.parent_id || ''),
      options.getItemNumber(entry.parent),
      options.getItemName(entry.parent),
      String(entry.child?.id || entry.child_id || ''),
      options.getItemNumber(entry.child),
      options.getItemName(entry.child),
      options.getCompareProp(entry, 'quantity'),
      options.getCompareProp(entry, 'uom'),
      options.getCompareProp(entry, 'find_num'),
      options.getCompareProp(entry, 'refdes'),
      options.formatEffectivity(entry),
      options.formatSubstituteCount(entry),
      String(entry.line_key || ''),
      String(entry.relationship_id || ''),
      Array.isArray(entry.changes)
        ? entry.changes.map((change) => `${change.field}:${change.left ?? ''}->${change.right ?? ''}`).join('; ')
        : '',
    ]
    const rows = [
      ...options.getCompareAddedFiltered().map((entry) => buildRow(entry, 'added')),
      ...options.getCompareRemovedFiltered().map((entry) => buildRow(entry, 'removed')),
      ...options.getCompareChangedFiltered().map((entry) => buildRow(entry, 'changed')),
    ]
    options.downloadCsv(`plm-bom-compare-${Date.now()}.csv`, headers, rows)
  }

  async function copyCompareDetailRows() {
    const detailRows = options.getCompareDetailRows()
    if (!detailRows.length) {
      options.setDeepLinkMessage('暂无字段对照', true)
      return
    }
    const headers = [
      'field_key',
      'field_label',
      'description',
      'left',
      'right',
      'severity',
      'normalized_left',
      'normalized_right',
    ]
    const rows = detailRows.map((row) => [
      row.key,
      row.label,
      row.description || '',
      normalizeDash(row.left),
      normalizeDash(row.right),
      row.severity || '',
      row.normalizedLeft || '',
      row.normalizedRight || '',
    ])
    const lines = [headers, ...rows].map((line) => line.join('\t')).join('\n')
    const ok = await options.copyToClipboard(lines)
    if (!ok) {
      options.setDeepLinkMessage('复制字段对照失败', true)
      return
    }
    options.setDeepLinkMessage(`已复制字段对照：${rows.length} 行`)
  }

  function exportCompareDetailCsv() {
    const detailRows = options.getCompareDetailRows()
    if (!detailRows.length) {
      options.setDeepLinkMessage('暂无字段对照', true)
      return
    }
    const headers = [
      'field_key',
      'field_label',
      'description',
      'left',
      'right',
      'severity',
      'normalized_left',
      'normalized_right',
    ]
    const rows = detailRows.map((row) => [
      row.key,
      row.label,
      row.description || '',
      normalizeDash(row.left),
      normalizeDash(row.right),
      row.severity || '',
      row.normalizedLeft || '',
      row.normalizedRight || '',
    ])
    options.downloadCsv(`plm-bom-compare-detail-${Date.now()}.csv`, headers, rows)
    options.setDeepLinkMessage('已导出字段对照。')
  }

  function exportBomCsv() {
    if (options.getBomView() === 'tree') {
      const headers = [
        'root_product_id',
        'depth',
        'path',
        'path_ids',
        'component_code',
        'component_name',
        'component_id',
        'quantity',
        'unit',
        'find_num',
        'refdes',
        'bom_line_id',
        'parent_component_id',
        'parent_line_id',
      ]
      const treeRows = options.getBomTreeRows()
      const rowMap = new Map(treeRows.map((row) => [row.key, row]))
      const included = options.getBomTreeFilteredKeys()
      const productView = options.getProductView()
      const rootProductId = String(options.getProductId() || productView.id || '')
      const rows = treeRows
        .filter((row) => row.line && included.has(row.key))
        .map((row) => {
          const line = row.line || {}
          const labels = row.pathLabels?.length
            ? row.pathLabels
            : [String(row.label || row.componentId || row.key)]
          const idChain = row.pathIds?.length
            ? row.pathIds
            : [String(row.componentId || row.label || row.key)]
          const parentRow = row.parentKey ? rowMap.get(row.parentKey) : undefined
          const parentComponentId = parentRow?.componentId || ''
          const parentLineId = parentRow?.line ? options.resolveBomLineId(parentRow.line) : ''
          return [
            rootProductId,
            String(row.depth ?? ''),
            labels.join(' / '),
            idChain.join(' / '),
            normalizeDash(String(line.component_code ?? line.componentCode ?? '')),
            normalizeDash(String(line.component_name ?? line.componentName ?? '')),
            String(options.resolveBomChildId(line) || row.componentId || ''),
            normalizeDash(String(line.quantity ?? '')),
            normalizeDash(String(line.unit ?? line.uom ?? '')),
            normalizeDash(options.formatBomFindNum(line)),
            normalizeDash(options.formatBomRefdes(line)),
            String(options.resolveBomLineId(line) || ''),
            String(parentComponentId || ''),
            String(parentLineId || ''),
          ]
        })
      options.downloadCsv(`plm-bom-tree-${Date.now()}.csv`, headers, rows)
      return
    }

    const headers = [
      'level',
      'component_code',
      'component_name',
      'component_id',
      'quantity',
      'unit',
      'find_num',
      'refdes',
      'path_ids',
      'bom_line_id',
      'parent_item_id',
    ]
    const rows = options.getBomFilteredItems().map((item) => [
      String(item.level ?? ''),
      normalizeDash(String(item.component_code ?? item.componentCode ?? '')),
      normalizeDash(String(item.component_name ?? item.componentName ?? '')),
      String(options.resolveBomChildId(item) || ''),
      normalizeDash(String(item.quantity ?? '')),
      normalizeDash(String(item.unit ?? '')),
      normalizeDash(options.formatBomFindNum(item)),
      normalizeDash(options.formatBomRefdes(item)),
      String(options.formatBomTablePathIds(item) || ''),
      String(options.resolveBomLineId(item) || ''),
      String(item.parent_item_id ?? item.parentItemId ?? ''),
    ])
    options.downloadCsv(`plm-bom-${Date.now()}.csv`, headers, rows)
  }

  function exportSubstitutesCsv() {
    const headers = [
      'bom_line_id',
      'substitute_id',
      'substitute_number',
      'substitute_name',
      'substitute_status',
      'part_id',
      'part_number',
      'part_name',
      'part_status',
      'rank',
      'note',
      'relationship_id',
    ]
    const payload = options.getSubstitutesPayload()
    const rows = options.getSubstitutesRows().map((entry) => {
      const sourcePart = options.getSubstituteSourcePart(entry)
      return [
        String(payload?.bom_line_id || ''),
        normalizeDash(options.getSubstituteId(entry)),
        normalizeDash(options.getSubstituteNumber(entry)),
        normalizeDash(options.getSubstituteName(entry)),
        normalizeDash(options.getSubstituteStatus(entry)),
        String(sourcePart.id || ''),
        String(sourcePart.item_number || sourcePart.itemNumber || sourcePart.code || ''),
        String(sourcePart.name || sourcePart.label || sourcePart.title || ''),
        String(sourcePart.state || sourcePart.status || sourcePart.lifecycle_state || ''),
        normalizeDash(options.formatSubstituteRank(entry)),
        normalizeDash(options.formatSubstituteNote(entry)),
        String(entry.relationship?.id || ''),
      ]
    })
    options.downloadCsv(`plm-substitutes-${Date.now()}.csv`, headers, rows)
  }

  function exportDocumentsCsv() {
    const headers = [
      'id',
      'name',
      'document_type',
      'revision',
      'role',
      'author',
      'source_system',
      'source_version',
      'mime_type',
      'file_size',
      'created_at',
      'updated_at',
      'preview_url',
      'download_url',
    ]
    const rows = options.getDocumentsSorted().map((doc) => [
      String(doc.id || ''),
      String(options.getDocumentName(doc) || ''),
      String(options.getDocumentType(doc) || ''),
      String(options.getDocumentRevision(doc) || ''),
      String(options.getDocumentRole(doc) || ''),
      String(options.getDocumentAuthor(doc) || ''),
      String(options.getDocumentSourceSystem(doc) || ''),
      String(options.getDocumentSourceVersion(doc) || ''),
      String(options.getDocumentMime(doc) || ''),
      String(options.getDocumentSize(doc) ?? ''),
      String(options.getDocumentCreatedAt(doc) || ''),
      String(options.getDocumentUpdatedAt(doc) || ''),
      String(options.getDocumentPreviewUrl(doc) || ''),
      String(options.getDocumentDownloadUrl(doc) || ''),
    ])
    options.downloadCsv(`plm-documents-${Date.now()}.csv`, headers, rows)
  }

  function exportApprovalsCsv() {
    const headers = [
      'id',
      'title',
      'status',
      'type',
      'requester',
      'requester_id',
      'created_at',
      'product_number',
      'product_name',
      'product_id',
    ]
    const rows = options.getApprovalsSorted().map((entry) => [
      String(entry.id || ''),
      String(options.getApprovalTitle(entry) || ''),
      String(options.getApprovalStatus(entry) || ''),
      String(options.getApprovalType(entry) || ''),
      String(options.getApprovalRequester(entry) || ''),
      String(options.getApprovalRequesterId(entry) || ''),
      String(options.getApprovalCreatedAt(entry) || ''),
      String(options.getApprovalProductNumber(entry) || ''),
      String(options.getApprovalProductName(entry) || ''),
      String(options.getApprovalProductId(entry) || ''),
    ])
    options.downloadCsv(`plm-approvals-${Date.now()}.csv`, headers, rows)
  }

  return {
    exportWhereUsedCsv,
    exportBomCompareCsv,
    copyCompareDetailRows,
    exportCompareDetailCsv,
    exportBomCsv,
    exportSubstitutesCsv,
    exportDocumentsCsv,
    exportApprovalsCsv,
  }
}
