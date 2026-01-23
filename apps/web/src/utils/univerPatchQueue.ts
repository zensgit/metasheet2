import { apiFetch } from './api'

type ChangeEntry = {
  recordId: string
  fieldId: string
  value: unknown
  expectedVersion?: number
}

type PatchResponse = {
  ok?: boolean
  data?: {
    updated?: Array<{ recordId: string; version: number }>
    records?: Array<{ recordId: string; data: Record<string, unknown> }>
    relatedRecords?: Array<{ recordId: string; sheetId: string; data: Record<string, unknown> }>
  }
  error?: { code?: string; message?: string; serverVersion?: number }
}

export type UniverPatchQueue = {
  stageChange: (recordId: string, fieldId: string, value: unknown) => void
  requestFlush: (delayMs?: number) => void
  flushNow: () => Promise<void>
  dispose: () => void
}

type PatchQueueOptions = {
  getViewId: () => string
  getApiPrefix: () => string
  mapping: {
    recordIdToVersion: Record<string, number>
    recordIdToData: Record<string, Record<string, unknown>>
  }
  setStatus?: (text: string, kind: 'ok' | 'error') => void
  onUpdated?: (updates: Array<{ recordId: string; version: number }>) => void
  onRecords?: (records: Array<{ recordId: string; data: Record<string, unknown> }>) => void
  onRelatedRecords?: (records: Array<{ recordId: string; sheetId: string; data: Record<string, unknown> }>) => void
  onConflict?: (serverVersion: number) => void
  flushDelayMs?: number
}

export function createUniverPatchQueue(options: PatchQueueOptions): UniverPatchQueue {
  const queue: ChangeEntry[] = []
  let timeoutId: number | undefined
  let disposed = false

  const buildExpectedVersion = (recordId: string) => {
    const version = options.mapping.recordIdToVersion[recordId]
    return typeof version === 'number' ? version : undefined
  }

  const scheduleFlush = (delayMs: number) => {
    if (timeoutId) window.clearTimeout(timeoutId)
    timeoutId = window.setTimeout(() => {
      timeoutId = undefined
      void flushNow()
    }, delayMs)
  }

  const stageChange = (recordId: string, fieldId: string, value: unknown) => {
    if (disposed) return
    const expectedVersion = buildExpectedVersion(recordId)
    queue.push({ recordId, fieldId, value, expectedVersion })
  }

  const requestFlush = (delayMs = options.flushDelayMs ?? 160) => {
    if (disposed) return
    if (queue.length === 0) return
    scheduleFlush(delayMs)
  }

  const flushNow = async () => {
    if (disposed) return
    if (queue.length === 0) return

    const apiPrefix = options.getApiPrefix()
    if (!apiPrefix.includes('/api/univer-meta')) {
      queue.length = 0
      return
    }

    const payload = {
      viewId: options.getViewId(),
      changes: queue.splice(0, queue.length),
    }

    try {
      options.setStatus?.('Saving...', 'ok')
      const res = await apiFetch(`${apiPrefix}/patch`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const json = (await res.json().catch(() => ({}))) as PatchResponse
      if (!res.ok || !json.ok) {
        const serverVersion = json.error?.serverVersion
        if (typeof serverVersion === 'number') {
          options.onConflict?.(serverVersion)
        }
        options.setStatus?.(json.error?.message || `Save failed (${res.status})`, 'error')
        return
      }

      const updates = json.data?.updated ?? []
      for (const update of updates) {
        options.mapping.recordIdToVersion[update.recordId] = update.version
      }
      if (updates.length > 0) {
        options.onUpdated?.(updates)
      }

      if (json.data?.records && json.data.records.length > 0) {
        options.onRecords?.(json.data.records)
      }

      if (json.data?.relatedRecords && json.data.relatedRecords.length > 0) {
        options.onRelatedRecords?.(json.data.relatedRecords)
      }

      options.setStatus?.('Saved', 'ok')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.setStatus?.(`Save failed: ${message}`, 'error')
    }
  }

  const dispose = () => {
    disposed = true
    if (timeoutId) window.clearTimeout(timeoutId)
    queue.length = 0
  }

  return { stageChange, requestFlush, flushNow, dispose }
}
