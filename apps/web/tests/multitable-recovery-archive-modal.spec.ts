// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'

import RecoveryArchiveModal from '../src/multitable/components/RecoveryArchiveModal.vue'
import type {
  RecoveryArchiveCatalogPage,
  RecoveryArchiveExecuteResult,
  RecoveryArchivePreview,
} from '../src/multitable/api/client'

const generationId = '4e3ecbc9-62d8-443d-8bc7-56f7d7bd12f9'
const catalog: RecoveryArchiveCatalogPage = {
  entries: [{
    generationId, recoveryPointAt: '2026-08-29T00:00:00Z', archivedAt: '2026-08-29T00:01:00Z',
    expiresAt: '2026-08-30T00:00:00Z', anchorSeq: '12', coverageRowCount: '7', superseded: false,
  }],
  nextCursor: null,
}
const syncPreview = (): RecoveryArchivePreview => ({
  generationId, mode: 'reset', scopeKind: 'whole_sheet', executionKind: 'sync', executable: true, blockedReason: null,
  previewIdentity: 'server-preview-identity',
  summary: { reverts: [{ recordId: 'rec_1', fieldIds: ['fld_1'] }], resurrectIds: ['rec_2'], deleteIds: ['rec_3'], effectiveWriteCount: 3, keptCreatedAfterAnchorCount: 0, driftCount: 0 },
})
const asyncPreview = (): RecoveryArchivePreview => ({
  ...syncPreview(), executionKind: 'async', executable: false, previewIdentity: null, blockedReason: 'async_plan_required',
})
const identityMissingPreview = (): RecoveryArchivePreview => ({
  ...syncPreview(), previewIdentity: null,
})
const executeResult: RecoveryArchiveExecuteResult = {
  mode: 'reset', anchorSeq: '12', checkpointId: 'checkpoint', revertedCount: 1, resurrectedCount: 1, deletedCount: 1, keptCreatedAfterAnchor: 0,
}

const mounted: Array<{ unmount: () => void }> = []
const flush = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
const q = (selector: string) => document.body.querySelector(selector) as HTMLElement | null
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = '' })

function mount(over: Partial<Record<string, unknown>> = {}) {
  const listCatalog = vi.fn(async () => catalog)
  const previewArchive = vi.fn(async () => syncPreview())
  const executeArchive = vi.fn(async () => executeResult)
  const onExecuted = vi.fn()
  const app = createApp(RecoveryArchiveModal, {
    visible: true, sheetId: 'sheet_1', isZh: false, listCatalog, previewArchive, executeArchive, onExecuted, ...over,
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  mounted.push(app)
  return { listCatalog, previewArchive, executeArchive, onExecuted }
}

describe('RecoveryArchiveModal', () => {
  it('executes only a server-executable whole-sheet preview after explicit confirmation', async () => {
    const props = mount()
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-mode-reset"]') as HTMLButtonElement).click()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()

    expect(props.previewArchive).toHaveBeenCalledWith('sheet_1', {
      generationId, mode: 'reset', scope: { kind: 'whole_sheet' },
    })
    const executeButton = q('[data-test="archive-recovery-execute"]') as HTMLButtonElement
    expect(executeButton.disabled).toBe(true)
    expect(document.body.textContent).not.toContain('server-preview-identity')

    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    executeButton.click()
    await flush()

    expect(props.executeArchive).toHaveBeenCalledWith('sheet_1', {
      previewIdentity: 'server-preview-identity', scope: { kind: 'whole_sheet' },
    })
    expect(props.onExecuted).toHaveBeenCalledTimes(1)
    expect(q('[data-test="archive-recovery-result"]')?.textContent).toContain('1 reverted, 1 restored, 1 deleted')
  })

  it('renders an async preview as requiring a job path and never calls execute', async () => {
    const props = mount({ previewArchive: vi.fn(async () => asyncPreview()) })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="archive-recovery-async-required"]')).toBeTruthy()
    expect(q('[data-test="archive-recovery-execute"]')).toBeFalsy()
    expect(props.executeArchive).not.toHaveBeenCalled()
  })

  it('does not offer execution when the server withholds the preview identity', async () => {
    const props = mount({ previewArchive: vi.fn(async () => identityMissingPreview()) })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="archive-recovery-blocked"]')).toBeTruthy()
    expect(q('[data-test="archive-recovery-execute"]')).toBeFalsy()
    expect(props.executeArchive).not.toHaveBeenCalled()
  })
})
