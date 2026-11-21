import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttendanceW4TransactionClientV1 } from '../w4c0-identity'
import {
  AttendanceW4RequestBoundaryError,
  ATTENDANCE_REQUEST_CREATE_SOURCE_REFS_V1,
  createAttendanceRequestOperationBoundaryV1,
  requireAttendanceRequestDecisionCalculationWitnessV1,
  recordAttendanceRequestDecisionCalculationResultV1,
  type AttendanceRequestPluginTrxV1,
  type AttendanceRequestOperationContextV1,
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
      // This is a freshly-acquired (idle) connection — the SAME affirmative-proof contract the
      // real driver gives `assertConnectionIsIdleV1`'s own `SAVEPOINT w4c5_idle_probe`
      // (SQLSTATE 25P01, no active transaction).
      if (sqlText === 'SAVEPOINT w4c5_idle_probe') {
        throw Object.assign(new Error('no_active_sql_transaction'), { code: '25P01' })
      }
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

    expect(events).toEqual(['prepareIdentity', 'prepare', 'execute'])
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


function ep01DecisionAdapters() {
  const configured = adapters([])
  const original = configured.request_decision
  const withDecisionPayload = (prepared: ReturnType<typeof preparedState>) => ({
    ...prepared,
    commandPayload: {
      requestId: REQUEST_ID, approvalRef: REQUEST_ID, expectedApprovalVersion: 0,
      expectedApprovalNode: 'node-1', action: 'approve', decisionChannel: 'web',
      comment: null, meta: null,
    },
  })
  configured.request_decision = {
    ...original,
    async prepareIdentity(trx, routeInput, operation) {
      return withDecisionPayload(await original.prepareIdentity(trx, routeInput, operation) as ReturnType<typeof preparedState>)
    },
    async prepare(trx, routeInput, operation) {
      return withDecisionPayload(await original.prepare(trx, routeInput, operation) as ReturnType<typeof preparedState>)
    },
  }
  return configured
}

describe('EP01 decision calculation execution authority', () => {
  it.each(['success', 'throw'] as const)('admits only the live matching decision and expires on %s', async (ending) => {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const client = fakeClient('shadow')
    const configured = ep01DecisionAdapters()
    const original = configured.request_decision.execute
    let saved: { trx: AttendanceRequestPluginTrxV1; operation: AttendanceRequestOperationContextV1 } | undefined
    configured.request_decision = {
      ...configured.request_decision,
      async execute(trx, prepared, operation) {
        saved = { trx, operation }
        const witness = requireAttendanceRequestDecisionCalculationWitnessV1(trx, operation)
        expect(witness.trx).toBe(client)
        expect(witness.org.orgId).toBe(ORG_ID)
        expect(witness.org.acceptedWritePosture).toBe('shadow')
        expect(witness.subjectUserId).toBe(USER_ID)
        expect(witness.actorId).toBe(USER_ID)
        expect(witness.identity.id).toBe(OPERATION_ID)
        expect(Object.isFrozen(witness)).toBe(true)
        const before = client.calls.length
        for (const [facade, context] of [[{ ...trx }, operation], [trx, { ...operation }]] as const) {
          expect(() => requireAttendanceRequestDecisionCalculationWitnessV1(facade, context))
            .toThrowError('W4C3B_REQUEST_CALCULATION_WITNESS_REQUIRED')
        }
        expect(client.calls).toHaveLength(before)
        if (ending === 'throw') throw new Error('EP01_SYNTHETIC_EXECUTION_FAILURE')
        return original(trx, prepared, operation)
      },
    }
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: vi.fn() }), adapters: configured,
    })
    const result = boundary.execute({
      kind: 'request_decision', operationId: OPERATION_ID,
      correlationId: 'ep01-witness', routeVariant: null, routeInput: {},
    })
    if (ending === 'throw') await expect(result).rejects.toThrow('EP01_SYNTHETIC_EXECUTION_FAILURE')
    else await expect(result).resolves.toEqual({ kind: 'executed', response: { id: REQUEST_ID } })
    expect(saved).toBeDefined()
    const before = client.calls.length
    expect(() => requireAttendanceRequestDecisionCalculationWitnessV1(saved!.trx, saved!.operation))
      .toThrowError('W4C3B_REQUEST_CALCULATION_WITNESS_REQUIRED')
    expect(client.calls).toHaveLength(before)
  })

  it.each(['legacy', 'non_decision'] as const)('does not mint authority for %s', async (caseKind) => {
    if (caseKind === 'legacy') delete process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED
    else process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const client = fakeClient(caseKind === 'legacy' ? null : 'shadow')
    const configured = ep01DecisionAdapters()
    const kind = caseKind === 'legacy' ? 'request_decision' : 'request_create'
    const original = configured[kind].execute
    configured[kind] = {
      ...configured[kind],
      async execute(trx, prepared, operation) {
        const before = client.calls.length
        expect(() => requireAttendanceRequestDecisionCalculationWitnessV1(trx, operation))
          .toThrowError('W4C3B_REQUEST_CALCULATION_WITNESS_REQUIRED')
        expect(client.calls).toHaveLength(before)
        return original(trx, prepared, operation)
      },
    }
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: vi.fn() }), adapters: configured,
    })
    await expect(boundary.execute({
      kind, operationId: OPERATION_ID, correlationId: 'ep01-witness-negative',
      routeVariant: kind === 'request_create' ? 'generic' : null, routeInput: {},
    })).resolves.toEqual({
      kind: caseKind === 'legacy' ? 'legacy_compat' : 'executed',
      response: { id: REQUEST_ID },
    })
  })
})


describe('EP01 private calculation result seal', () => {
  it.each(['success', 'throw'] as const)('keeps proof private and cleans up on %s', async (ending) => {
    process.env.ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED = ORG_ID
    const client = fakeClient('shadow')
    const configured = ep01DecisionAdapters()
    const original = configured.request_decision.execute
    const proof = {
      resolvedRecordId: '55555555-5555-4555-8555-555555555555',
      resolvedCalculationId: '66666666-6666-4666-8666-666666666666',
      resultSemanticFingerprint: 'a'.repeat(64),
      resultProvenanceFingerprint: 'b'.repeat(64),
    }
    let saved: { trx: AttendanceRequestPluginTrxV1; operation: AttendanceRequestOperationContextV1 } | undefined
    configured.request_decision = {
      ...configured.request_decision,
      async execute(trx, prepared, operation) {
        saved = { trx, operation }
        const copy = { ...proof }
        const before = client.calls.length
        for (const [facade, context] of [[{ ...trx }, operation], [trx, { ...operation }]] as const) {
          expect(() => recordAttendanceRequestDecisionCalculationResultV1(facade, context, copy))
            .toThrowError('W4C3B_REQUEST_CALCULATION_WITNESS_REQUIRED')
        }
        expect(client.calls).toHaveLength(before)
        recordAttendanceRequestDecisionCalculationResultV1(trx, operation, copy)
        copy.resolvedCalculationId = OPERATION_ID
        expect(() => recordAttendanceRequestDecisionCalculationResultV1(trx, operation, copy))
          .toThrowError('W4C3B_REQUEST_CALCULATION_RESULT_ALREADY_RECORDED')
        if (ending === 'throw') throw new Error('EP01_SYNTHETIC_AFTER_CALCULATION')
        return original(trx, prepared, operation)
      },
    }
    const boundary = createAttendanceRequestOperationBoundaryV1({
      acquireConnection: async () => ({ client, release: vi.fn() }), adapters: configured,
    })
    const result = boundary.execute({
      kind: 'request_decision', operationId: OPERATION_ID, correlationId: 'ep01-private-seal',
      routeVariant: null, routeInput: {},
    })
    if (ending === 'throw') await expect(result).rejects.toThrow('EP01_SYNTHETIC_AFTER_CALCULATION')
    else await expect(result).resolves.toEqual({ kind: 'executed', response: { id: REQUEST_ID } })
    const seals = client.calls.filter(({ sqlText }) =>
      sqlText.startsWith('UPDATE attendance_result_operations') && sqlText.includes("state = 'completed'"))
    if (ending === 'throw') {
      expect(seals).toEqual([])
      expect(client.calls.some(({ sqlText }) => sqlText.includes('INSERT INTO attendance_result_event_outbox'))).toBe(false)
    } else {
      expect(seals).toHaveLength(1)
      expect(seals[0]!.params.slice(4, 9)).toEqual([
        proof.resolvedRecordId, proof.resolvedCalculationId, REQUEST_ID,
        proof.resultSemanticFingerprint, proof.resultProvenanceFingerprint,
      ])
    }
    const before = client.calls.length
    expect(() => recordAttendanceRequestDecisionCalculationResultV1(saved!.trx, saved!.operation, proof))
      .toThrowError('W4C3B_REQUEST_CALCULATION_WITNESS_REQUIRED')
    expect(client.calls).toHaveLength(before)
  })
})
