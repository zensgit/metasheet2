import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import {
  AttendanceW4RequestBoundaryError,
  ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1,
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

function adapters(
  events: string[],
  acceptedWritePostures: Array<'legacy_projection_only' | 'shadow' | 'authoritative' | null> = [],
  routeVariants: Array<string | null> = [],
): Record<'request_create' | 'request_pending_edit' | 'request_decision' | 'request_cancel', AttendanceRequestOperationAdapterV1> {
  const adapter: AttendanceRequestOperationAdapterV1 = {
    async prepareIdentity(trx, routeInput, operation) {
      events.push('prepareIdentity')
      routeVariants.push(operation.routeVariant)
      expect(Object.isFrozen(routeInput)).toBe(true)
      await trx.query('SELECT 1 AS request_identity_marker')
      return preparedState()
    },
    async prepare(trx, routeInput, operation) {
      events.push('prepare')
      expect(Object.isFrozen(routeInput)).toBe(true)
      await trx.query('SELECT 1 AS request_prepare_marker')
      return preparedState()
    },
    async execute(trx, _prepared, operation) {
      events.push('execute')
      acceptedWritePostures.push(operation.acceptedWritePosture)
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
    const acceptedWritePostures: Array<'legacy_projection_only' | 'shadow' | 'authoritative' | null> = []
    const client = fakeClient(null)
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: vi.fn() }),
      adapters: adapters(events, acceptedWritePostures),
    })

    await expect(boundary.execute({
      kind: 'request_create',
      operationId: null,
      correlationId: 'request-create:legacy',
      routeVariant: 'generic',
      routeInput: { requestType: 'leave' },
    })).resolves.toEqual({ kind: 'legacy', response: { id: REQUEST_ID } })

    expect(events).toEqual(['prepare', 'execute'])
    expect(acceptedWritePostures).toEqual(['legacy_projection_only'])
    expect(client.calls.some(({ sqlText }) => sqlText.includes('FROM users WHERE id = $1'))).toBe(false)
    expect(client.calls.some(({ sqlText }) => sqlText.includes('attendance_result_operations'))).toBe(false)
    expect(client.calls.some(({ sqlText }) => sqlText.includes('attendance_result_event_outbox'))).toBe(false)
  })

  it('seals stable-ID legacy compatibility without creating an outbox row', async () => {
    delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    const events: string[] = []
    const client = fakeClient(null)
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: vi.fn() }),
      adapters: adapters(events),
    })

    await expect(boundary.execute({
      kind: 'request_create',
      operationId: OPERATION_ID,
      correlationId: 'request-create:legacy-compat',
      routeVariant: 'generic',
      routeInput: { requestType: 'leave' },
    })).resolves.toEqual({ kind: 'legacy_compat', response: { id: REQUEST_ID } })

    expect(events).toEqual(['prepareIdentity', 'prepare', 'execute'])
    expect(client.calls.some(({ sqlText }) => sqlText.includes('INSERT INTO attendance_result_operations'))).toBe(true)
    expect(client.calls.some(({ sqlText }) => sqlText.includes('attendance_result_event_outbox'))).toBe(false)
    expect(client.calls.some(({ sqlText }) => sqlText.startsWith('UPDATE attendance_result_operations'))).toBe(true)
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
      routeVariant: 'generic' as const,
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
        routeVariant: 'generic',
        routeInput: { requestType: 'leave' },
      }),
    ).rejects.toMatchObject({ code: 'SEGMENT_CALCULATION_SUSPENDED' })

    expect(events).toEqual(['prepareIdentity'])
    expect(client.calls.some(({ sqlText }) => sqlText.includes('request_execution_marker'))).toBe(false)
    expect(client.calls.at(-1)?.sqlText).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })

  it('claims a shadow operation before the fixed adapter performs source DML', async () => {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const events: string[] = []
    const acceptedWritePostures: Array<'legacy_projection_only' | 'shadow' | 'authoritative' | null> = []
    const client = fakeClient('shadow')
    const release = vi.fn()
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release }),
      adapters: adapters(events, acceptedWritePostures),
    })

    await expect(
      boundary.execute({
        kind: 'request_create',
        operationId: OPERATION_ID,
        correlationId: 'request-create:shadow',
        routeVariant: 'generic',
        routeInput: { requestType: 'leave' },
      }),
    ).resolves.toEqual({ kind: 'executed', response: { id: REQUEST_ID } })

    const claim = client.calls.findIndex(({ sqlText }) => sqlText.includes('INSERT INTO attendance_result_operations'))
    const sourceDml = client.calls.findIndex(({ sqlText }) => sqlText.includes('request_execution_marker'))
    const outbox = client.calls.findIndex(({ sqlText }) => sqlText.includes('attendance_result_event_outbox'))
    const seal = client.calls.findIndex(({ sqlText }) => sqlText.startsWith('UPDATE attendance_result_operations'))
    expect(events).toEqual(['prepareIdentity', 'prepare', 'execute'])
    expect(acceptedWritePostures).toEqual(['shadow'])
    expect(claim).toBeGreaterThan(-1)
    expect(sourceDml).toBeGreaterThan(claim)
    expect(outbox).toBeGreaterThan(sourceDml)
    expect(seal).toBeGreaterThan(outbox)
    expect(client.calls.at(-1)?.sqlText).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('maps each closed request_create routeVariant to its truthful source_ref', async () => {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const routeVariants: Array<string | null> = []
    const capturedSourceRefs: string[] = []
    const client = fakeClient('shadow')
    // Capture source_ref from the operations INSERT params (column order fixed by registry).
    const originalQuery = client.query.bind(client)
    client.query = async (sqlText: string, params: unknown[] = []) => {
      if (sqlText.includes('INSERT INTO attendance_result_operations')) {
        // source_ref is a fixed column in the claim insert; find its position via SQL text.
        const match = sqlText.match(/INSERT INTO attendance_result_operations\s*\(([^)]+)\)/i)
        if (match) {
          const cols = match[1].split(',').map((c) => c.trim())
          const idx = cols.indexOf('source_ref')
          if (idx >= 0 && typeof params[idx] === 'string') capturedSourceRefs.push(params[idx] as string)
        }
      }
      return originalQuery(sqlText, params)
    }

    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: vi.fn() }),
      adapters: adapters([], [], routeVariants),
    })

    for (const variant of ['generic', 'outdoor', 'schedule_dispatch', 'shift_swap'] as const) {
      await boundary.execute({
        kind: 'request_create',
        operationId: OPERATION_ID,
        correlationId: `request-create:${variant}`,
        routeVariant: variant,
        routeInput: { family: variant },
      })
    }

    expect(routeVariants).toEqual(['generic', 'outdoor', 'schedule_dispatch', 'shift_swap'])
    expect(capturedSourceRefs).toEqual([
      ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1.generic,
      ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1.outdoor,
      ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1.schedule_dispatch,
      ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1.shift_swap,
    ])
  })

  it('fails closed on unknown create variants and non-request_create mismatches before connection', async () => {
    const acquireConnection = vi.fn()
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection,
      adapters: adapters([]),
    })

    await expect(
      boundary.execute({
        kind: 'request_create',
        operationId: OPERATION_ID,
        correlationId: 'bad-variant',
        routeVariant: 'not_a_family' as never,
        routeInput: {},
      }),
    ).rejects.toBeInstanceOf(AttendanceW4RequestBoundaryError)

    await expect(
      boundary.execute({
        kind: 'request_create',
        operationId: OPERATION_ID,
        correlationId: 'null-variant',
        routeVariant: null,
        routeInput: {},
      }),
    ).rejects.toBeInstanceOf(AttendanceW4RequestBoundaryError)

    await expect(
      boundary.execute({
        kind: 'request_decision',
        operationId: OPERATION_ID,
        correlationId: 'decision-with-outdoor',
        routeVariant: 'outdoor' as never,
        routeInput: {},
      }),
    ).rejects.toBeInstanceOf(AttendanceW4RequestBoundaryError)

    await expect(
      boundary.execute({
        kind: 'request_pending_edit',
        operationId: OPERATION_ID,
        correlationId: 'edit-with-schedule',
        routeVariant: 'schedule_dispatch' as never,
        routeInput: {},
      }),
    ).rejects.toBeInstanceOf(AttendanceW4RequestBoundaryError)

    expect(acquireConnection).not.toHaveBeenCalled()
  })

  it('does not accept routeVariant spoofed only inside routeInput — top-level field is required', async () => {
    const acquireConnection = vi.fn()
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection,
      adapters: adapters([]),
    })

    await expect(
      boundary.execute({
        kind: 'request_create',
        operationId: OPERATION_ID,
        correlationId: 'spoof-body',
        // missing top-level routeVariant is invalid even if body pretends
        routeInput: { routeVariant: 'outdoor', body: { routeVariant: 'outdoor' } },
      } as never),
    ).rejects.toBeInstanceOf(AttendanceW4RequestBoundaryError)

    expect(acquireConnection).not.toHaveBeenCalled()
  })
})
