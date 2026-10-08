import type { Request } from 'express'
import type { QueryFn } from '../multitable/record-write-service'
import { requireRecordReadable } from './univer-meta'

export interface ReadableAutomationSampleRecord {
  recordId: string
  data: Record<string, unknown>
  actorId: string
}

export type ReadableAutomationSampleRecordResult =
  | { ok: true; sampleRecord: ReadableAutomationSampleRecord }
  | { ok: false; status: number; body: unknown }

function isRecordData(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Resolve one sample record for an automation simulation after the ordinary
 * row-level read gate. The actor id is derived from that gate, never from the
 * request body. A deletion between the gate and data load fails closed.
 */
export async function loadReadableAutomationSampleRecord(
  req: Request,
  query: QueryFn,
  sheetId: string,
  recordId: string,
): Promise<ReadableAutomationSampleRecordResult> {
  const readable = await requireRecordReadable(req, query, sheetId, recordId)
  if ('status' in readable) {
    if (readable.status === 401) {
      return {
        ok: false,
        status: 401,
        body: { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } },
      }
    }
    if (readable.status === 403) {
      return {
        ok: false,
        status: 403,
        body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
      }
    }
    return {
      ok: false,
      status: readable.status === 404 ? 404 : 500,
      body: readable.status === 404
        ? { ok: false, error: { code: 'NOT_FOUND', message: 'Sample record not found' } }
        : { ok: false, error: { code: 'SAMPLE_RECORD_READ_FAILED', message: 'Failed to read sample record' } },
    }
  }

  const result = await query(
    'SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [recordId, sheetId],
  )
  const data = (result.rows[0] as { data?: unknown } | undefined)?.data
  if (data === undefined) {
    return {
      ok: false,
      status: 404,
      body: { ok: false, error: { code: 'NOT_FOUND', message: 'Sample record not found' } },
    }
  }
  if (!isRecordData(data)) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: { code: 'INVALID_SAMPLE_RECORD_DATA', message: 'Sample record data is unavailable' } },
    }
  }

  return {
    ok: true,
    sampleRecord: {
      recordId,
      data,
      actorId: readable.access.userId,
    },
  }
}
