import { describe, expect, it, vi } from 'vitest'
import { usePlmExportActions } from '../src/views/plm/usePlmExportActions'

describe('usePlmExportActions', () => {
  function createActions(overrides: Partial<ReturnType<typeof createDefaults>> = {}) {
    const defaults = createDefaults()
    const options = { ...defaults, ...overrides }
    return {
      actions: usePlmExportActions(options),
      downloadCsv: options.downloadCsv,
      copyToClipboard: options.copyToClipboard,
      setDeepLinkMessage: options.setDeepLinkMessage,
    }
  }

  function createDefaults() {
    const downloadCsv = vi.fn()
    const copyToClipboard = vi.fn().mockResolvedValue(true)
    const setDeepLinkMessage = vi.fn()

    return {
      setDeepLinkMessage,
      copyToClipboard,
      downloadCsv,
      getWhereUsedFilteredRows: () => [],
      formatWhereUsedEntryPathIds: () => '',
      getWhereUsedLineValue: () => '-',
      getWhereUsedRefdes: () => '-',
      getItemNumber: (item: Record<string, unknown> | null | undefined) =>
        String(item?.item_number || item?.code || item?.id || '-'),
      getItemName: (item: Record<string, unknown> | null | undefined) => String(item?.name || '-'),
      getCompareAddedFiltered: () => [],
      getCompareRemovedFiltered: () => [],
      getCompareChangedFiltered: () => [],
      getCompareProp: () => '-',
      formatEffectivity: () => '-',
      formatSubstituteCount: () => '-',
      getCompareDetailRows: () => [],
      getBomView: () => 'table' as const,
      getBomTreeRows: () => [],
      getBomTreeFilteredKeys: () => new Set<string>(),
      getBomFilteredItems: () => [],
      getProductId: () => '',
      getProductView: () => ({
        id: '',
        name: '',
        partNumber: '',
        revision: '',
        status: '',
        itemType: '',
        description: '',
        createdAt: '',
        updatedAt: '',
      }),
      resolveBomChildId: (item: Record<string, unknown>) => String(item.component_id || ''),
      resolveBomLineId: (item: Record<string, unknown>) => String(item.id || ''),
      formatBomFindNum: () => '-',
      formatBomRefdes: () => '-',
      formatBomTablePathIds: () => '',
      getSubstitutesRows: () => [],
      getSubstitutesPayload: () => null,
      getSubstituteSourcePart: (entry: Record<string, unknown>) => (entry.part || {}) as Record<string, unknown>,
      getSubstituteId: (entry: Record<string, unknown>) => String(entry.id || '-'),
      getSubstituteNumber: (entry: Record<string, unknown>) => String(entry.number || '-'),
      getSubstituteName: (entry: Record<string, unknown>) => String(entry.name || '-'),
      getSubstituteStatus: (entry: Record<string, unknown>) => String(entry.status || '-'),
      formatSubstituteRank: (entry: Record<string, unknown>) => String(entry.rank || '-'),
      formatSubstituteNote: (entry: Record<string, unknown>) => String(entry.note || '-'),
      getDocumentsSorted: () => [],
      getDocumentName: () => '-',
      getDocumentType: () => '-',
      getDocumentRevision: () => '-',
      getDocumentRole: () => '-',
      getDocumentAuthor: () => '-',
      getDocumentSourceSystem: () => '-',
      getDocumentSourceVersion: () => '-',
      getDocumentMime: () => '-',
      getDocumentSize: () => undefined,
      getDocumentCreatedAt: () => '-',
      getDocumentUpdatedAt: () => '-',
      getDocumentPreviewUrl: () => '',
      getDocumentDownloadUrl: () => '',
      getApprovalsSorted: () => [],
      getApprovalTitle: () => '-',
      getApprovalStatus: () => '-',
      getApprovalType: () => '-',
      getApprovalRequester: () => '-',
      getApprovalRequesterId: () => '-',
      getApprovalCreatedAt: () => '-',
      getApprovalProductNumber: () => '-',
      getApprovalProductName: () => '-',
      getApprovalProductId: () => '-',
    }
  }

  it('copies compare detail rows as tab-delimited text', async () => {
    const panel = createActions({
      getCompareDetailRows: () => [
        {
          key: 'quantity',
          label: '数量',
          description: 'line',
          left: '1',
          right: '2',
          severity: 'major',
          normalizedLeft: '1',
          normalizedRight: '2',
          changed: true,
        },
      ],
    })

    await panel.actions.copyCompareDetailRows()

    expect(panel.copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('field_key\tfield_label\tdescription\tleft\tright\tseverity\tnormalized_left\tnormalized_right'),
    )
    expect(panel.setDeepLinkMessage).toHaveBeenCalledWith('已复制字段对照：1 行')
  })

  it('exports substitutes with explicit source part fields', () => {
    const panel = createActions({
      getSubstitutesPayload: () => ({ bom_line_id: 'LINE-1' }),
      getSubstitutesRows: () => [
        {
          id: 'SUB-1',
          relationship: { id: 'REL-1' },
          substitute_part: { id: 'ALT-1', item_number: 'ALT-PN', name: 'Alt Part', state: 'released' },
          part: { id: 'SRC-1', item_number: 'SRC-PN', name: 'Source Part', state: 'active' },
        },
      ],
      getSubstituteSourcePart: (entry) => (entry.part || {}) as Record<string, unknown>,
      getSubstituteId: () => 'ALT-1',
      getSubstituteNumber: () => 'ALT-PN',
      getSubstituteName: () => 'Alt Part',
      getSubstituteStatus: () => 'released',
      formatSubstituteRank: () => '1',
      formatSubstituteNote: () => 'preferred',
    })

    panel.actions.exportSubstitutesCsv()

    expect(panel.downloadCsv).toHaveBeenCalledWith(
      expect.stringMatching(/^plm-substitutes-\d+\.csv$/),
      expect.arrayContaining(['bom_line_id', 'substitute_id', 'substitute_number']),
      [
        ['LINE-1', 'ALT-1', 'ALT-PN', 'Alt Part', 'released', 'SRC-1', 'SRC-PN', 'Source Part', 'active', '1', 'preferred', 'REL-1'],
      ],
    )
  })
})
