// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'

import RecoveryArchiveModal from '../src/multitable/components/RecoveryArchiveModal.vue'
import type {
  RecoveryArchiveCatalogPage,
  RecoveryArchiveExecuteResult,
  RecoveryArchiveJobPage,
  RecoveryArchiveJobSnapshot,
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
  ...syncPreview(), executionKind: 'async', executable: true, previewIdentity: 'server-async-identity', blockedReason: null,
})
const identityMissingPreview = (): RecoveryArchivePreview => ({
  ...syncPreview(), previewIdentity: null,
})
const asyncIdentityMissingPreview = (): RecoveryArchivePreview => ({
  ...asyncPreview(), previewIdentity: null,
})
const executeResult: RecoveryArchiveExecuteResult = {
  mode: 'reset', anchorSeq: '12', checkpointId: 'checkpoint', revertedCount: 1, resurrectedCount: 1, deletedCount: 1, keptCreatedAfterAnchor: 0,
}
const jobSnapshot = (state: RecoveryArchiveJobSnapshot['state'], completedCount = '0'): RecoveryArchiveJobSnapshot => ({
  jobId: '55555555-5555-4555-8555-555555555555', state, totalCount: '6001', completedCount,
  resumeDeadline: '2026-08-30T00:00:00.000Z', terminalAt: state === 'done' ? '2026-08-29T01:00:00.000Z' : null, rowVersion: '3',
})

const mounted: Array<{ unmount: () => void }> = []
const flush = async () => {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}
const q = (selector: string) => document.body.querySelector(selector) as HTMLElement | null
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); document.body.innerHTML = ''; vi.useRealTimers() })

function mount(over: Partial<Record<string, unknown>> = {}) {
  const listCatalog = vi.fn(async () => catalog)
  const listJobs = vi.fn(async (): Promise<RecoveryArchiveJobPage> => ({ entries: [], nextCursor: null }))
  const previewArchive = vi.fn(async () => syncPreview())
  const executeArchive = vi.fn(async () => executeResult)
  const acceptJob = vi.fn(async () => jobSnapshot('planned'))
  const readJob = vi.fn(async () => jobSnapshot('applying', '2500'))
  const resumeJob = vi.fn(async () => jobSnapshot('planned', '2500'))
  const cancelJob = vi.fn(async () => jobSnapshot('abandoned_partial', '2500'))
  const effectiveListCatalog = (over.listCatalog as typeof listCatalog | undefined) ?? listCatalog
  const effectiveListJobs = (over.listJobs as typeof listJobs | undefined) ?? listJobs
  const effectivePreviewArchive = (over.previewArchive as typeof previewArchive | undefined) ?? previewArchive
  const effectiveExecuteArchive = (over.executeArchive as typeof executeArchive | undefined) ?? executeArchive
  const effectiveAcceptJob = (over.acceptJob as typeof acceptJob | undefined) ?? acceptJob
  const effectiveReadJob = (over.readJob as typeof readJob | undefined) ?? readJob
  const effectiveResumeJob = (over.resumeJob as typeof resumeJob | undefined) ?? resumeJob
  const effectiveCancelJob = (over.cancelJob as typeof cancelJob | undefined) ?? cancelJob
  const onExecuted = vi.fn()
  const onRefresh = vi.fn()
  const sheetId = ref('sheet_1')
  const visible = ref(true)
  const Root = defineComponent({
    setup: () => () => h(RecoveryArchiveModal, {
      isZh: false,
      fields: [{ id: 'fld_1', name: 'Name' }, { id: 'fld_2', name: 'Status' }],
      selectedRecordIds: ['rec_1', 'rec_2'],
      onExecuted, onRefresh, ...over,
      visible: visible.value,
      sheetId: sheetId.value,
      listCatalog: effectiveListCatalog,
      listJobs: effectiveListJobs,
      previewArchive: effectivePreviewArchive,
      executeArchive: effectiveExecuteArchive,
      acceptJob: effectiveAcceptJob,
      readJob: effectiveReadJob,
      resumeJob: effectiveResumeJob,
      cancelJob: effectiveCancelJob,
    }),
  })
  const app = createApp(Root)
  const container = document.createElement('div')
  document.body.appendChild(container)
  app.mount(container)
  const mountedApp = { unmount: () => app.unmount() }
  mounted.push(mountedApp)
  return {
    listCatalog: effectiveListCatalog,
    listJobs: effectiveListJobs,
    previewArchive: effectivePreviewArchive,
    executeArchive: effectiveExecuteArchive,
    acceptJob: effectiveAcceptJob,
    readJob: effectiveReadJob,
    resumeJob: effectiveResumeJob,
    cancelJob: effectiveCancelJob,
    onExecuted,
    onRefresh,
    sheetId,
    visible,
    unmount: () => {
      const index = mounted.indexOf(mountedApp)
      if (index >= 0) mounted.splice(index, 1)
      mountedApp.unmount()
    },
  }
}

describe('RecoveryArchiveModal', () => {
  it.each([
    ['RECOVERY_ARCHIVE_CATALOG_DISABLED', 'Archive recovery is not enabled.'],
    ['RECOVERY_ARCHIVE_PREVIEW_DISABLED', 'Archive recovery is not enabled.'],
    ['RECOVERY_ARCHIVE_RESTORE_JOB_DISABLED', 'Archive recovery is not enabled.'],
    ['RECOVERY_ARCHIVE_RUNTIME_UNAVAILABLE', 'The archive recovery service is not ready.'],
    ['RECOVERY_ARCHIVE_PREVIEW_RUNTIME_UNAVAILABLE', 'The archive recovery service is not ready.'],
    ['RECOVERY_ARCHIVE_SCOPE_UNAVAILABLE', 'Archive recovery scope is not configured for this sheet.'],
    ['RECOVERY_ARCHIVE_PREVIEW_SUBSTRATE_INVALID', 'Archive recovery data is currently unavailable.'],
    ['RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID', 'Archive recovery data is currently unavailable.'],
    ['RECOVERY_ARCHIVE_RESTORE_JOB_PERSISTENCE_INVALID', 'Archive recovery data is currently unavailable.'],
    ['UNRECOGNIZED_DISABLED', 'Archive recovery is currently unavailable.'],
  ])('classifies %s without rendering raw server evidence', async (code, expected) => {
    const props = mount({ listJobs: vi.fn().mockRejectedValue({ status: 503, code, message: 'PRIVATE_PROVIDER_DETAIL' }) })
    await flush()
    expect(q('[data-test="archive-recovery-discovery-error"]')?.textContent).toBe(expected)
    expect(document.body.textContent).not.toContain('PRIVATE_PROVIDER_DETAIL')
    expect(document.body.textContent).not.toContain(code)
    expect(props.listCatalog).not.toHaveBeenCalled()
    expect(props.executeArchive).not.toHaveBeenCalled()
    expect(props.acceptJob).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'Sign in again to access archive recovery.'],
    [403, 'You do not have archive recovery permission.'],
    [404, 'The recovery point or job was not found.'],
    [409, 'Recovery state changed. Refresh and try again.'],
  ])('preserves HTTP %s precedence over an archive diagnostic', async (status, expected) => {
    mount({ listJobs: vi.fn().mockRejectedValue({ status, code: 'RECOVERY_ARCHIVE_CATALOG_DISABLED' }) })
    await flush()
    expect(q('[data-test="archive-recovery-discovery-error"]')?.textContent).toBe(expected)
  })

  it('does not classify arbitrary code substrings as archive readiness facts', async () => {
    mount({ listJobs: vi.fn().mockRejectedValue({ code: 'HOST_PRIVATE_UNAVAILABLE', message: 'PRIVATE_PROVIDER_DETAIL' }) })
    await flush()
    expect(q('[data-test="archive-recovery-discovery-error"]')?.textContent).toBe('Archive recovery request failed.')
  })

  it('shows localized disabled copy and an accessible read-only refresh control', async () => {
    mount({ isZh: true, listJobs: vi.fn().mockRejectedValue({ status: 503, code: 'RECOVERY_ARCHIVE_RESTORE_JOB_DISABLED' }) })
    await flush()
    expect(q('[data-test="archive-recovery-discovery-error"]')?.textContent).toBe('归档恢复尚未启用。')
    const refresh = q('[data-test="archive-recovery-recheck"]')!
    expect(refresh.getAttribute('aria-label')).toBe('重新检查归档恢复')
    expect(refresh.getAttribute('title')).toBe('重新检查归档恢复')
  })

  it('rechecks discovery after failure, serializes clicks, and never starts a recovery write', async () => {
    let resolveRetry!: (value: RecoveryArchiveJobPage) => void
    const listJobs = vi.fn()
      .mockRejectedValueOnce({ status: 503, code: 'RECOVERY_ARCHIVE_RESTORE_JOB_DISABLED' })
      .mockImplementationOnce(() => new Promise<RecoveryArchiveJobPage>((resolve) => { resolveRetry = resolve }))
    const props = mount({ listJobs })
    await flush()
    const refresh = q('[data-test="archive-recovery-recheck"]') as HTMLButtonElement
    refresh.click()
    refresh.click()
    await flush()
    expect(refresh.disabled).toBe(true)
    expect(listJobs).toHaveBeenCalledTimes(2)
    expect(props.listCatalog).not.toHaveBeenCalled()
    resolveRetry({ entries: [jobSnapshot('paused_retryable')], nextCursor: null })
    await flush()
    expect(q('[data-test="archive-recovery-job-state"]')?.textContent).toBe('Paused and resumable')
    expect(props.listCatalog).not.toHaveBeenCalled()
    expect(props.previewArchive).not.toHaveBeenCalled()
    expect(props.executeArchive).not.toHaveBeenCalled()
    expect(props.acceptJob).not.toHaveBeenCalled()
    expect(props.resumeJob).not.toHaveBeenCalled()
    expect(props.cancelJob).not.toHaveBeenCalled()
  })

  it('rechecks jobs before retrying a failed catalog and distinguishes an empty result', async () => {
    const listCatalog = vi.fn().mockRejectedValueOnce({ status: 503, code: 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID' })
      .mockResolvedValueOnce({ entries: [], nextCursor: null })
    const props = mount({ listCatalog })
    await flush()
    expect(q('[data-test="archive-recovery-catalog-error"]')?.textContent).toBe('Archive recovery data is currently unavailable.')
    ;(q('[data-test="archive-recovery-recheck"]') as HTMLButtonElement).click()
    await flush()
    expect(props.listJobs).toHaveBeenCalledTimes(2)
    expect(listCatalog).toHaveBeenCalledTimes(2)
    expect(props.listJobs.mock.invocationCallOrder[1]).toBeLessThan(listCatalog.mock.invocationCallOrder[1])
    expect(q('[data-test="archive-recovery-empty"]')?.textContent).toBe('No archive recovery points are available.')
    expect(q('[data-test="archive-recovery-catalog-error"]')).toBeFalsy()
  })

  it('invalidates an executable preview and confirmation before rediscovering a job', async () => {
    const listJobs = vi.fn().mockResolvedValueOnce({ entries: [], nextCursor: null })
      .mockResolvedValueOnce({ entries: [jobSnapshot('planned')], nextCursor: null })
    const props = mount({ listJobs })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-recheck"]') as HTMLButtonElement).click()
    await flush()
    expect(q('[data-test="archive-recovery-execute"]')).toBeFalsy()
    expect(q('[data-test="archive-recovery-preview-area"]')).toBeFalsy()
    expect(q('[data-test="archive-recovery-job-state"]')?.textContent).toBe('Queued')
    expect(props.executeArchive).not.toHaveBeenCalled()
  })

  it('discards an old refresh reply after switching sheets', async () => {
    let resolveRetry!: (page: RecoveryArchiveJobPage) => void
    const listJobs = vi.fn().mockRejectedValueOnce({ status: 503 })
      .mockImplementationOnce(() => new Promise<RecoveryArchiveJobPage>((resolve) => { resolveRetry = resolve }))
      .mockResolvedValue({ entries: [], nextCursor: null })
    const props = mount({ listJobs })
    await flush()
    ;(q('[data-test="archive-recovery-recheck"]') as HTMLButtonElement).click()
    await flush()
    props.sheetId.value = 'sheet_2'
    await flush()
    resolveRetry({ entries: [jobSnapshot('planned')], nextCursor: null })
    await flush()
    expect(q('[data-test="archive-recovery-job"]')).toBeFalsy()
    expect(props.listCatalog).toHaveBeenCalledTimes(1)
    expect(props.listCatalog).toHaveBeenCalledWith('sheet_2', { limit: 50 })
    expect(props.acceptJob).not.toHaveBeenCalled()
  })

  it('ignores a late catalog error after closing and reopens through job discovery', async () => {
    let rejectCatalog!: (error: unknown) => void
    const listCatalog = vi.fn().mockImplementationOnce(() => new Promise<RecoveryArchiveCatalogPage>((_resolve, reject) => { rejectCatalog = reject }))
      .mockResolvedValueOnce({ entries: [], nextCursor: null })
    const props = mount({ listCatalog })
    await flush()
    expect((q('[data-test="archive-recovery-recheck"]') as HTMLButtonElement).disabled).toBe(true)
    ;(q('.archive-recovery__close') as HTMLButtonElement).click()
    await flush()
    rejectCatalog({ status: 503, code: 'RECOVERY_ARCHIVE_CATALOG_PERSISTENCE_INVALID' })
    await flush()
    expect(q('[data-test="archive-recovery-catalog-error"]')).toBeFalsy()
    props.visible.value = false
    await flush()
    props.visible.value = true
    await flush()
    expect(props.listJobs).toHaveBeenCalledTimes(2)
    expect(q('[data-test="archive-recovery-empty"]')?.textContent).toBe('No archive recovery points are available.')
  })

  it('rediscovers the newest durable job after a full reload and resumes status polling without an action', async () => {
    vi.useFakeTimers()
    const listJobs = vi.fn(async (): Promise<RecoveryArchiveJobPage> => ({
      entries: [jobSnapshot('applying', '2500')],
      nextCursor: null,
    }))
    const readJob = vi.fn(async () => jobSnapshot('applying', '5000'))
    const props = mount({ listJobs, readJob })
    await flush()

    expect(listJobs).toHaveBeenCalledWith('sheet_1', { limit: 1 })
    expect(q('[data-test="archive-recovery-job-state"]')?.textContent).toBe('Applying')
    expect(q('[data-test="archive-recovery-empty"]')).toBeFalsy()
    expect(props.acceptJob).not.toHaveBeenCalled()
    expect(props.resumeJob).not.toHaveBeenCalled()
    expect(props.cancelJob).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(readJob).toHaveBeenCalledWith('sheet_1', '55555555-5555-4555-8555-555555555555')
  })

  it('does not apply a stale job-discovery response after changing sheets', async () => {
    let resolveSheetOne!: (page: RecoveryArchiveJobPage) => void
    const listJobs = vi.fn((sheetId: string): Promise<RecoveryArchiveJobPage> => {
      if (sheetId === 'sheet_1') {
        return new Promise((resolve) => { resolveSheetOne = resolve })
      }
      return Promise.resolve({ entries: [], nextCursor: null })
    })
    const props = mount({ listJobs })
    await flush()

    props.sheetId.value = 'sheet_2'
    await flush()
    resolveSheetOne({ entries: [jobSnapshot('applying', '2500')], nextCursor: null })
    await flush()

    expect(listJobs).toHaveBeenCalledWith('sheet_2', { limit: 1 })
    expect(q('[data-test="archive-recovery-job"]')).toBeFalsy()

    props.sheetId.value = 'sheet_1'
    await flush()
    expect(q('[data-test="archive-recovery-job"]')).toBeFalsy()
  })

  it('blocks catalog and actions when durable-job discovery fails', async () => {
    const listJobs = vi.fn(async (): Promise<RecoveryArchiveJobPage> => {
      throw { status: 503 }
    })
    const props = mount({ listJobs })
    await flush()

    expect(q('[data-test="archive-recovery-discovery-error"]')?.textContent).toBe('Archive recovery is currently unavailable.')
    expect(props.listCatalog).not.toHaveBeenCalled()
    expect(q(`[data-test="archive-recovery-entry-${generationId}"]`)).toBeFalsy()
    expect(props.previewArchive).not.toHaveBeenCalled()
    expect(props.acceptJob).not.toHaveBeenCalled()
  })

  it('does not cache a late discovery response after the modal closes', async () => {
    let resolveDiscovery!: (page: RecoveryArchiveJobPage) => void
    const listJobs = vi.fn(() => new Promise<RecoveryArchiveJobPage>((resolve) => { resolveDiscovery = resolve }))
    mount({ listJobs })
    await flush()

    ;(q('.archive-recovery__close') as HTMLButtonElement).click()
    await flush()
    resolveDiscovery({ entries: [jobSnapshot('applying', '2500')], nextCursor: null })
    await flush()

    expect(listJobs).toHaveBeenCalledTimes(1)
    expect(q('[data-test="archive-recovery-job"]')).toBeFalsy()
  })

  it('does not schedule polling from a late discovery response after unmount', async () => {
    vi.useFakeTimers()
    let resolveDiscovery!: (page: RecoveryArchiveJobPage) => void
    const listJobs = vi.fn(() => new Promise<RecoveryArchiveJobPage>((resolve) => { resolveDiscovery = resolve }))
    const readJob = vi.fn(async () => jobSnapshot('applying', '5000'))
    const props = mount({ listJobs, readJob })
    await flush()

    props.unmount()
    resolveDiscovery({ entries: [jobSnapshot('applying', '2500')], nextCursor: null })
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()

    expect(readJob).not.toHaveBeenCalled()
  })

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

  it('accepts an executable async preview as a durable job and never calls sync execute', async () => {
    const acceptJob = vi.fn(async () => jobSnapshot('planned'))
    const props = mount({ previewArchive: vi.fn(async () => asyncPreview()), acceptJob })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="archive-recovery-async-required"]')).toBeTruthy()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()

    expect(acceptJob).toHaveBeenCalledWith('sheet_1', 'server-async-identity')
    expect(q('[data-test="archive-recovery-job-state"]')?.textContent).toBe('Queued')
    expect(q('[data-test="archive-recovery-job-counts"]')?.textContent).toContain('0 / 6001')
    expect(props.executeArchive).not.toHaveBeenCalled()
  })

  it('keeps a late async acceptance bound to its originating sheet', async () => {
    let resolveAccept!: (snapshot: RecoveryArchiveJobSnapshot) => void
    const acceptJob = vi.fn(() => new Promise<RecoveryArchiveJobSnapshot>((resolve) => { resolveAccept = resolve }))
    const props = mount({ previewArchive: vi.fn(async () => asyncPreview()), acceptJob })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()

    props.sheetId.value = 'sheet_2'
    await flush()
    resolveAccept(jobSnapshot('planned'))
    await flush()

    expect(q('[data-test="archive-recovery-job"]')).toBeFalsy()
    expect(props.onExecuted).not.toHaveBeenCalled()

    props.sheetId.value = 'sheet_1'
    await flush()
    expect(q('[data-test="archive-recovery-job"]')).toBeTruthy()
    expect(props.readJob).toHaveBeenCalledWith('sheet_1', '55555555-5555-4555-8555-555555555555')
  })

  it('does not apply a late synchronous result to a different sheet', async () => {
    let resolveExecute!: (result: RecoveryArchiveExecuteResult) => void
    const executeArchive = vi.fn(() => new Promise<RecoveryArchiveExecuteResult>((resolve) => { resolveExecute = resolve }))
    const props = mount({ executeArchive })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()

    props.sheetId.value = 'sheet_2'
    await flush()
    resolveExecute(executeResult)
    await flush()

    expect(props.onExecuted).not.toHaveBeenCalled()
    expect(q('[data-test="archive-recovery-result"]')).toBeFalsy()
  })

  it('finishes an in-flight synchronous restore after closing and reopening the same sheet', async () => {
    let resolveExecute!: (result: RecoveryArchiveExecuteResult) => void
    const executeArchive = vi.fn(() => new Promise<RecoveryArchiveExecuteResult>((resolve) => { resolveExecute = resolve }))
    const props = mount({ executeArchive })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()

    props.visible.value = false
    await flush()
    props.visible.value = true
    await flush()
    resolveExecute(executeResult)
    await flush()

    expect(props.onExecuted).toHaveBeenCalledTimes(1)
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    expect((q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).disabled).toBe(false)
  })

  it('continues automatic polling after a transient status failure', async () => {
    const readJob = vi.fn()
      .mockRejectedValueOnce(new Error('transient-customer-sentinel'))
      .mockResolvedValueOnce(jobSnapshot('applying', '2500'))
    const _props = mount({ previewArchive: vi.fn(async () => asyncPreview()), readJob })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()
    vi.useFakeTimers()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(q('[data-test="archive-recovery-job-error"]')?.textContent).toBe('Archive recovery request failed.')
    expect(document.body.textContent).not.toContain('transient-customer-sentinel')

    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(readJob).toHaveBeenCalledTimes(2)
    expect(q('[data-test="archive-recovery-job-state"]')?.textContent).toBe('Applying')
  })

  it('continues automatic polling after a transient resume failure', async () => {
    const resumeJob = vi.fn(async () => { throw new Error('resume-customer-sentinel') })
    const readJob = vi.fn(async () => jobSnapshot('applying', '2500'))
    mount({ previewArchive: vi.fn(async () => asyncPreview()), acceptJob: vi.fn(async () => jobSnapshot('paused_retryable', '2500')), resumeJob, readJob })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()
    vi.useFakeTimers()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-job-resume"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="archive-recovery-job-error"]')?.textContent).toBe('Archive recovery request failed.')
    expect(document.body.textContent).not.toContain('resume-customer-sentinel')
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(readJob).toHaveBeenCalledTimes(1)
  })

  it('continues automatic polling after a transient cancel failure', async () => {
    const cancelJob = vi.fn(async () => { throw new Error('cancel-customer-sentinel') })
    const readJob = vi.fn(async () => jobSnapshot('applying', '2500'))
    mount({ previewArchive: vi.fn(async () => asyncPreview()), acceptJob: vi.fn(async () => jobSnapshot('planned', '2500')), cancelJob, readJob })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()
    vi.useFakeTimers()
    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-job-cancel"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="archive-recovery-job-error"]')?.textContent).toBe('Archive recovery request failed.')
    expect(document.body.textContent).not.toContain('cancel-customer-sentinel')
    await vi.advanceTimersByTimeAsync(2_000)
    await flush()
    expect(readJob).toHaveBeenCalledTimes(1)
  })

  it('previews the chosen record-and-field scope and exposes paused resume plus partial cancel', async () => {
    const acceptJob = vi.fn(async () => jobSnapshot('paused_retryable', '2500'))
    const resumeJob = vi.fn(async () => jobSnapshot('planned', '2500'))
    const cancelJob = vi.fn(async () => jobSnapshot('abandoned_partial', '2500'))
    const props = mount({ previewArchive: vi.fn(async () => asyncPreview()), acceptJob, resumeJob, cancelJob })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()

    const scope = document.body.querySelector('input[value="selected_fields"]') as HTMLInputElement
    scope.checked = true
    scope.dispatchEvent(new Event('change'))
    await flush()
    const fieldCheckboxes = [...document.body.querySelectorAll('[data-test="archive-recovery-fields"] input[type="checkbox"]')] as HTMLInputElement[]
    fieldCheckboxes[1]!.checked = false
    fieldCheckboxes[1]!.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()

    expect(props.previewArchive).toHaveBeenCalledWith('sheet_1', {
      generationId,
      mode: 'revert',
      scope: { kind: 'selected_fields', recordIds: ['rec_1', 'rec_2'], fieldIds: ['fld_1'] },
    })
    expect(document.body.querySelector('[data-test="archive-recovery-summary"]')).toBeTruthy()

    const confirmation = q('[data-test="archive-recovery-confirm-input"]') as HTMLInputElement
    confirmation.checked = true
    confirmation.dispatchEvent(new Event('change'))
    await flush()
    ;(q('[data-test="archive-recovery-execute"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-job-resume"]') as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-job-cancel"]') as HTMLButtonElement).click()
    await flush()

    expect(resumeJob).toHaveBeenCalledWith('sheet_1', '55555555-5555-4555-8555-555555555555')
    expect(cancelJob).toHaveBeenCalledWith('sheet_1', '55555555-5555-4555-8555-555555555555')
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(q('[data-test="archive-recovery-job-outcome"]')?.textContent).toContain('Only part of the job was applied')
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

  it('does not offer async job acceptance when the server withholds the preview identity', async () => {
    const props = mount({ previewArchive: vi.fn(async () => asyncIdentityMissingPreview()) })
    await flush()
    ;(q(`[data-test="archive-recovery-entry-${generationId}"]`) as HTMLButtonElement).click()
    await flush()
    ;(q('[data-test="archive-recovery-request-preview"]') as HTMLButtonElement).click()
    await flush()

    expect(q('[data-test="archive-recovery-async-required"]')).toBeTruthy()
    expect(q('[data-test="archive-recovery-blocked"]')).toBeTruthy()
    expect(q('[data-test="archive-recovery-execute"]')).toBeFalsy()
    expect(props.acceptJob).not.toHaveBeenCalled()
  })

  it('renders fixed values-free errors instead of throwable contents', async () => {
    mount({ listCatalog: vi.fn(async () => { throw new Error('customer-value-sentinel') }) })
    await flush()

    expect(q('[data-test="archive-recovery-catalog-error"]')?.textContent).toBe('Archive recovery request failed.')
    expect(document.body.textContent).not.toContain('customer-value-sentinel')
  })
})
