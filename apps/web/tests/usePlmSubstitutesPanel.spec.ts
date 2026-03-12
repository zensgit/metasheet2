import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { usePlmSubstitutesPanel } from '../src/views/plm/usePlmSubstitutesPanel'

describe('usePlmSubstitutesPanel', () => {
  function createPanel() {
    const scheduleQuerySync = vi.fn()
    const setDeepLinkMessage = vi.fn()
    const copyToClipboard = vi.fn().mockResolvedValue(true)

    return {
      ...usePlmSubstitutesPanel({
        productLoading: ref(false),
        whereUsedLoading: ref(false),
        copyToClipboard,
        setDeepLinkMessage,
        scheduleQuerySync,
        bomLineOptions: computed(() => [
          { key: 'bom-line:1', value: 'LINE-1', label: 'BOM 行 / A / LINE-1' },
        ]),
        substituteQuickOptions: computed(() => [
          { key: 'sub:1', value: 'SUB-1', label: '替代件 / SUB-1' },
        ]),
        bomItems: ref([
          {
            id: 'LINE-1',
            component_code: 'C-1',
            component_name: 'Child Part',
            quantity: 2,
            unit: 'EA',
            sequence: '10',
          },
        ]),
        getSubstituteNumber: (entry) => String(entry.number || entry.id || ''),
        getSubstituteName: (entry) => String(entry.name || ''),
        getSubstituteStatus: (entry) => String(entry.status || ''),
        formatSubstituteRank: (entry) => String(entry.rank || ''),
        formatSubstituteNote: (entry) => String(entry.note || ''),
        copyDeepLink: vi.fn().mockResolvedValue(undefined),
        loadSubstitutes: vi.fn().mockResolvedValue(undefined),
        addSubstitute: vi.fn().mockResolvedValue(undefined),
        removeSubstitute: vi.fn().mockResolvedValue(undefined),
        applyWhereUsedFromBom: vi.fn(),
        resolveSubstituteTargetKey: (entry, target) =>
          String(target === 'substitute' ? entry.id || '' : entry.part?.id || ''),
        applyProductFromSubstitute: vi.fn(),
        getSubstituteId: (entry) => String(entry.id || ''),
        getItemNumber: (item) => String(item?.item_number || item?.component_code || item?.id || '-'),
        getItemName: (item) => String(item?.name || item?.component_name || '-'),
        itemStatusClass: (value) => `status-${value || 'unknown'}`,
        exportSubstitutesCsv: vi.fn(),
        formatJson: (payload) => JSON.stringify(payload),
      }),
      scheduleQuerySync,
      setDeepLinkMessage,
      copyToClipboard,
    }
  }

  it('applies substitute quick picks and bom line quick picks through local state module', () => {
    const panel = createPanel()

    panel.bomLineQuickPick.value = 'LINE-1'
    panel.substitutesActionStatus.value = 'old'
    panel.substitutesPanel.applyBomLineQuickPick()
    panel.substituteQuickPick.value = 'SUB-1'
    panel.substitutesPanel.applySubstituteQuickPick()

    expect(panel.bomLineId.value).toBe('LINE-1')
    expect(panel.bomLineQuickPick.value).toBe('')
    expect(panel.substituteItemId.value).toBe('SUB-1')
    expect(panel.substituteQuickPick.value).toBe('')
    expect(panel.scheduleQuerySync).toHaveBeenCalledWith({ bomLineId: 'LINE-1' })
  })

  it('filters substitutes rows and can copy current bom line id', async () => {
    const panel = createPanel()
    panel.bomLineId.value = 'LINE-1'
    panel.substitutes.value = {
      bom_line_id: 'LINE-1',
      count: 2,
      substitutes: [
        { id: 'SUB-1', number: 'PN-1', name: 'Primary Alt', status: 'Released', rank: 1, note: 'hot' },
        { id: 'SUB-2', number: 'PN-2', name: 'Backup Alt', status: 'Draft', rank: 2, note: 'cold' },
      ],
    }
    panel.substitutesFilter.value = 'backup'

    await panel.substitutesPanel.copyBomLineId()

    expect(panel.substitutesRows.value).toHaveLength(1)
    expect(panel.substitutesRows.value[0]?.id).toBe('SUB-2')
    expect(panel.copyToClipboard).toHaveBeenCalledWith('LINE-1')
  })
})
