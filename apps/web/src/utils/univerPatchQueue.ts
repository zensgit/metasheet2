import { apiFetch } from './api'
import { formatApiErrorMessage, type ApiErrorPayload } from './apiErrors'
import { isFormulaValue } from './univerValue'

export type UniverPatchChange = {
  recordId: string
  fieldId: string
  value: unknown
  expectedVersion?: number
}

export type UniverPatchResponse = {
  ok: boolean
  data?: {
    updated: Array<{ recordId: string; version: number }>
    records?: Array<{ recordId: string; data: Record<string, unknown> }>
    relatedRecords?: Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }>
  }
  error?: { code: string; message: string; serverVersion?: number }
}

export type UniverPatchQueueMapping = {
  recordIdToVersion: Record<string, number>
  fieldIdToType: Record<string, string>
  fieldIdToProperty?: Record<string, Record<string, unknown>>
  fieldIdToReadonlyReason?: Record<string, string>
  fieldIdToLabel?: Record<string, string>
}

type StatusKind = 'ok' | 'error'

type UniverPatchQueueOptions = {
  getViewId: () => string
  getApiPrefix: () => string
  mapping: UniverPatchQueueMapping
  setStatus?: (text: string, kind: StatusKind) => void
  onUpdated?: (updated: Array<{ recordId: string; version: number }>) => void
  onRecords?: (records: Array<{ recordId: string; data: Record<string, unknown> }>) => void
  onRelatedRecords?: (records: Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }>) => void
  onConflict?: (serverVersion: number | null) => void
  flushDelayMs?: number
}

export type UniverPatchQueue = {
  stageChange: (recordId: string, fieldId: string, value: unknown) => void
  requestFlush: (delayMs?: number) => void
  flushNow: () => void
  dispose: () => void
}

const READONLY_FIELD_REGEX = /Field is readonly:\s*([^\s]+)/i

function resolveReadonlyMessage(
  error: ApiErrorPayload | undefined,
  mapping: UniverPatchQueueMapping,
): string | null {
  if (!error || error.code !== 'FIELD_READONLY') return null
  const match = error.message?.match(READONLY_FIELD_REGEX)
  const fieldId = match?.[1]
  if (!fieldId) return null
  const reason = mapping.fieldIdToReadonlyReason?.[fieldId]
  if (reason) return reason
  const label = mapping.fieldIdToLabel?.[fieldId]
  if (label && label.trim().length > 0) {
    return `字段【${label}】只读，无法编辑`
  }
  return null
}

export function createUniverPatchQueue(options: UniverPatchQueueOptions): UniverPatchQueue {
  const flushDelayMs = options.flushDelayMs ?? 120

  let flushTimer: number | null = null
  let inFlight = false
  let pendingByRecord = new Map<string, Map<string, unknown>>()

  const schedule = (fn: () => void, delay: number) => {
    if (flushTimer) window.clearTimeout(flushTimer)
    flushTimer = window.setTimeout(() => {
      flushTimer = null
      fn()
    }, delay)
  }

  const flush = () => {
    const viewId = options.getViewId()
    if (!viewId) return
    if (inFlight) return
    if (pendingByRecord.size === 0) return

    const apiPrefix = options.getApiPrefix()
    const isMock = apiPrefix.includes('/api/univer-mock')

    const snapshot = pendingByRecord
    pendingByRecord = new Map()

    const changes: UniverPatchChange[] = []
    for (const [recordId, fields] of snapshot.entries()) {
      const expectedVersion = options.mapping.recordIdToVersion[recordId]
      for (const [fieldId, value] of fields.entries()) {
        const fieldType = options.mapping.fieldIdToType[fieldId]
        if (fieldType === 'formula' && !isFormulaValue(value)) continue

        // For link fields: extract __linkIds if present, otherwise use display text
        let patchValue = value
        let skipChange = false
        if (fieldType === 'link') {
          const property = options.mapping.fieldIdToProperty?.[fieldId]
          const hasLinkConfig = Boolean(
            property &&
              typeof property === 'object' &&
              !Array.isArray(property) &&
              ('foreignSheetId' in property || 'foreignDatasheetId' in property),
          )
          // Check if value is an object with __linkIds (set by applyLink)
          if (value && typeof value === 'object' && '__linkIds' in (value as object)) {
            patchValue = (value as { __linkIds: string[] }).__linkIds
          } else if (typeof value === 'string') {
            // Legacy: if it's a comma-separated string, treat as IDs (meta)
            if (isMock) {
              patchValue = value
            } else {
              if (hasLinkConfig) {
                skipChange = true
              } else {
                patchValue = value
              }
            }
          } else if (Array.isArray(value)) {
            patchValue = isMock ? value.map((v) => String(v)).join(', ') : value
          }
        }
        if (skipChange) continue

        changes.push({ recordId, fieldId, value: patchValue, expectedVersion })
      }
    }

    if (changes.length === 0) return

    inFlight = true
    options.setStatus?.(`Saving... (${changes.length})`, 'ok')

    apiFetch(`${apiPrefix}/patch`, {
      method: 'POST',
      body: JSON.stringify({ viewId, changes }),
    })
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as UniverPatchResponse
        if (res.status === 409) {
          const serverVersion = typeof json.error?.serverVersion === 'number' ? json.error.serverVersion : null
          options.setStatus?.('Version conflict (409) - please refresh', 'error')
          options.onConflict?.(serverVersion)
          return
        }
        if (!json.ok || !json.data) {
          const readonlyMessage = resolveReadonlyMessage(json.error, options.mapping)
          const message = readonlyMessage ?? formatApiErrorMessage(json.error, 'unknown error')
          options.setStatus?.(readonlyMessage ? message : `Save failed: ${message}`, 'error')
          return
        }
        for (const u of json.data.updated) {
          options.mapping.recordIdToVersion[u.recordId] = u.version
        }
        options.onUpdated?.(json.data.updated)
        if (Array.isArray(json.data.records) && json.data.records.length > 0) {
          options.onRecords?.(json.data.records)
        }
        if (Array.isArray(json.data.relatedRecords) && json.data.relatedRecords.length > 0) {
          options.onRelatedRecords?.(json.data.relatedRecords)
        }
        options.setStatus?.(`Saved (${json.data.updated.length})`, 'ok')
      })
      .catch((err) => {
        console.error('[univerPatchQueue] patch failed:', err)
        options.setStatus?.('Save failed (network error)', 'error')

        // Merge snapshot back (best-effort; keep newer staged values).
        for (const [recordId, fields] of snapshot.entries()) {
          let live = pendingByRecord.get(recordId)
          if (!live) {
            live = new Map()
            pendingByRecord.set(recordId, live)
          }
          for (const [fieldId, value] of fields.entries()) {
            if (!live.has(fieldId)) live.set(fieldId, value)
          }
        }
      })
      .finally(() => {
        inFlight = false
        if (pendingByRecord.size > 0) schedule(flush, 50)
      })
  }

  return {
    stageChange(recordId, fieldId, value) {
      let fields = pendingByRecord.get(recordId)
      if (!fields) {
        fields = new Map()
        pendingByRecord.set(recordId, fields)
      }
      fields.set(fieldId, value)
    },
    requestFlush(delayMs = flushDelayMs) {
      schedule(flush, delayMs)
    },
    flushNow() {
      if (flushTimer) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
      flush()
    },
    dispose() {
      if (flushTimer) window.clearTimeout(flushTimer)
      flushTimer = null
      pendingByRecord.clear()
      inFlight = false
    },
  }
}
