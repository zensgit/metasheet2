import { nextTick } from 'vue'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { usePlmDeepLinkState } from '../src/views/plm/usePlmDeepLinkState'

describe('usePlmDeepLinkState', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createState() {
    const syncQueryParams = vi.fn()
    const copyText = vi.fn().mockResolvedValue(true)

    const state = usePlmDeepLinkState({
      builtInPresets: [{ key: 'docs', label: '文档', panels: ['documents'] }],
      panelLabels: {
        all: '全部',
        product: '产品',
        documents: '文档',
        compare: 'BOM 对比',
      },
      syncQueryParams,
      buildDeepLinkUrl: (panel) => `http://example.test/plm${panel ? `?panel=${panel}` : ''}`,
      formatDeepLinkTargets: (panel) => panel || '全部',
      applyPresetParams: vi.fn(),
      copyText,
    })

    return { state, syncQueryParams, copyText }
  }

  it('saves presets, clears active preset on manual scope edits, and persists them', async () => {
    const { state } = createState()

    state.customPresetName.value = '我的预设'
    state.deepLinkScope.value = ['product', 'compare']
    state.saveDeepLinkPreset()

    expect(state.deepLinkPresets.value.some((entry) => entry.label === '我的预设')).toBe(true)
    expect(state.deepLinkPreset.value.startsWith('custom:')).toBe(true)

    vi.runAllTimers()
    state.deepLinkScope.value = ['documents']
    await nextTick()

    expect(state.deepLinkPreset.value).toBe('')
    expect(localStorage.getItem('plm_deep_link_presets')).toContain('我的预设')
  })

  it('debounces query sync and copies deep links through the shared helper', async () => {
    const { state, syncQueryParams, copyText } = createState()

    state.scheduleQuerySync({ productId: 'P-1' })
    state.scheduleQuerySync({ compareLeftId: 'L-1' })

    expect(syncQueryParams).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(syncQueryParams).toHaveBeenCalledWith({ productId: 'P-1', compareLeftId: 'L-1' })

    state.deepLinkScope.value = ['product', 'compare']
    await state.copyDeepLink()

    expect(copyText).toHaveBeenCalledWith('http://example.test/plm?panel=product,compare')
    expect(state.deepLinkStatus.value).toContain('product,compare')
  })

  it('cancels pending query sync patches before the debounce flushes', () => {
    const { state, syncQueryParams } = createState()

    state.scheduleQuerySync({ productId: 'P-1' })
    state.scheduleQuerySync({ compareLeftId: 'L-1' })
    state.cancelScheduledQuerySync()

    vi.advanceTimersByTime(250)

    expect(syncQueryParams).not.toHaveBeenCalled()
  })
})
