import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import {
  AttendanceW4RequestBoundaryError,
  createAttendanceRequestOperationBoundaryV1,
  type AttendanceRequestOperationAdapterV1,
} from '../w4c3b-request-operation-boundary'

const ORG_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const OPERATION_ID = '44444444-4444-4444-8444-444444444444'

interface CapturedCall {
  sqlText: string
  params: unknown[]
}

function fakeClient(rolloutState: 'shadow' | 'suspended' | null): AttendanceW4TransactionClientV1 & {
  calls: CapturedCall[]
} {
  const calls: CapturedCall[] = []
  return {
    calls,
    async query(sqlText: string, params: unknown[] = []) {
      calls.push({ sqlText, params })
      if (sqlText.includes('FROM users WHERE id = $1')) return { rows: [{ ok: 1 }] }
      if (sqlText.includes('FROM user_orgs WHERE user_id = $1')) return { rows: [{ ok: 1 }] }
      if (sqlText.startsWith('SELECT state, scope FROM attendance_calculation_rollout_state')) {
        return {
          rows: rolloutState === null ? [] : [{ state: rolloutState, scope: 'synthetic_staging' }],
        }
      }
      if (sqlText.startsWith('UPDATE attendance_result_operations')) {
        return { rows: [{ operation_id: OPERATION_ID }] }
      }
      return { rows: [] }
    },
  }
}

function preparedState() {
  return {
    orgId: ORG_ID,
    actorId: USER_ID,
    actorPosture: 'self' as const,
    tokenSubjectUserId: USER_ID,
    subjectUserId: USER_ID,
    subjectScope: { kind: 'self' as const, userId: USER_ID },
    commandPayload: { requestType: 'leave', requestWrite: { reason: 'test' } },
    state: Object.freeze({ requestId: REQUEST_ID }),
  }
}

function adapters(events: string[]): Record<'request_create' | 'request_pending_edit' | 'request_decision' | 'request_cancel', AttendanceRequestOperationAdapterV1> {
  const adapter: AttendanceRequestOperationAdapterV1 = {
    async prepare(trx, routeInput) {
      events.push('prepare')
      expect(Object.isFrozen(routeInput)).toBe(true)
      await trx.query('SELECT 1 AS request_prepare_marker')
      return preparedState()
    },
    async execute(trx) {
      events.push('execute')
      await trx.query('INSERT INTO request_execution_marker(id) VALUES ($1)', [REQUEST_ID])
      return {
        response: { id: REQUEST_ID },
        resolvedRequestId: REQUEST_ID,
        lifecycleEvents: [{
          eventKind: 'attendance.requested' as const,
          payload: { requestId: REQUEST_ID },
        }],
      }
    },
  }
  return {
    request_create: adapter,
    request_pending_edit: adapter,
    request_decision: adapter,
    request_cancel: adapter,
  }
}

const priorAllowlist = process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED

afterEach(() => {
  if (priorAllowlist === undefined) delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
  else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = priorAllowlist
})

describe('W4C-3b request operation boundary', () => {
  it('keeps null-ID legacy execution ahead of the new liveness recheck', async () => {
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const events: string[] = []
    const client = fakeClient(null)
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: vi.fn() }),
      adapters: adapters(events),
    })

    await expect(boundary.execute({
      kind: 'request_create',
      operationId: null,
      correlationId: 'request-create:legacy',
      routeInput: { requestType: 'leave' },
    })).resolves.toEqual({ kind: 'legacy', response: { id: REQUEST_ID } })

    expect(events).toEqual(['prepare', 'execute'])
    expect(client.calls.some(({ sqlText }) => sqlText.includes('FROM users WHERE id = $1'))).toBe(false)
    expect(client.calls.some(({ sqlText }) => sqlText.includes('attendance_result_operations'))).toBe(false)
    expect(client.calls.some(({ sqlText }) => sqlText.includes('attendance_result_event_outbox'))).toBe(false)
  })

  it('rejects extra top-level keys and nested callbacks before acquiring a connection', async () => {
    const acquireConnection = vi.fn()
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection,
      adapters: adapters([]),
    })
    const base = {
      kind: 'request_create' as const,
      operationId: OPERATION_ID,
      correlationId: 'request-create:test',
      routeInput: { body: { requestType: 'leave' } },
    }

    await expect(boundary.execute({ ...base, execute: () => undefined } as never)).rejects.toBeInstanceOf(
      AttendanceW4RequestBoundaryError,
    )
    await expect(
      boundary.execute({ ...base, routeInput: { body: { callback: () => undefined } } }),
    ).rejects.toBeInstanceOf(AttendanceW4RequestBoundaryError)
    expect(acquireConnection).not.toHaveBeenCalled()
  })

  it('blocks a suspended org before adapter source DML', async () => {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const events: string[] = []
    const client = fakeClient('suspended')
    const release = vi.fn()
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release }),
      adapters: adapters(events),
    })

    await expect(
      boundary.execute({
        kind: 'request_create',
        operationId: OPERATION_ID,
        correlationId: 'request-create:suspended',
        routeInput: { requestType: 'leave' },
      }),
    ).rejects.toMatchObject({ code: 'SEGMENT_CALCULATION_SUSPENDED' })

    expect(events).toEqual(['prepare'])
    expect(client.calls.some(({ sqlText }) => sqlText.includes('request_execution_marker'))).toBe(false)
    expect(client.calls.at(-1)?.sqlText).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })

  it('claims a shadow operation before the fixed adapter performs source DML', async () => {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const events: string[] = []
    const client = fakeClient('shadow')
    const release = vi.fn()
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release }),
      adapters: adapters(events),
    })

    await expect(
      boundary.execute({
        kind: 'request_create',
        operationId: OPERATION_ID,
        correlationId: 'request-create:shadow',
        routeInput: { requestType: 'leave' },
      }),
    ).resolves.toEqual({ kind: 'executed', response: { id: REQUEST_ID } })

    const claim = client.calls.findIndex(({ sqlText }) => sqlText.includes('INSERT INTO attendance_result_operations'))
    const sourceDml = client.calls.findIndex(({ sqlText }) => sqlText.includes('request_execution_marker'))
    const outbox = client.calls.findIndex(({ sqlText }) => sqlText.includes('attendance_result_event_outbox'))
    const seal = client.calls.findIndex(({ sqlText }) => sqlText.startsWith('UPDATE attendance_result_operations'))
    expect(events).toEqual(['prepare', 'execute'])
    expect(claim).toBeGreaterThan(-1)
    expect(sourceDml).toBeGreaterThan(claim)
    expect(outbox).toBeGreaterThan(sourceDml)
    expect(seal).toBeGreaterThan(outbox)
    expect(client.calls.at(-1)?.sqlText).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })
})
