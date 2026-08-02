import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  appendApprovedLeaveCancellationCalculationV1,
  type W4c3bApprovedLeaveCancellationQueryClient,
} from '../w4c3b-approved-leave-cancellation'

function uuid(): string {
  return crypto.randomUUID()
}

function input(client: W4c3bApprovedLeaveCancellationQueryClient) {
  return {
    client,
    orgId: 'w4c3b-p14-unit-org',
    userId: 'w4c3b-p14-unit-user',
    workDate: '2026-08-01',
    requestId: uuid(),
    operationId: uuid(),
    actorId: 'w4c3b-p14-unit-actor',
    correlationId: 'w4c3b-p14-unit-correlation',
    mode: 'shadow' as const,
  }
}

describe('W4C-3b P14 approved leave cancellation boundary', () => {
  it('returns review/no-parent for a record without a frozen calculation and writes nothing', async () => {
    const sql: string[] = []
    const client: W4c3bApprovedLeaveCancellationQueryClient = {
      query: async (text) => {
        sql.push(text)
        if (text.includes('FROM attendance_records')) {
          return {
            rows: [{
              id: uuid(),
              org_id: 'w4c3b-p14-unit-org',
              user_id: 'w4c3b-p14-unit-user',
              work_date: '2026-08-01',
              current_calculation_id: null,
              visibility_state: 'active',
              visibility_reason: 'active',
            }],
          }
        }
        return { rows: [] }
      },
    }

    await expect(appendApprovedLeaveCancellationCalculationV1(input(client))).resolves.toEqual({
      kind: 'review_required',
      reason: 'no_current_calculation',
    })
    expect(sql.some((text) => /^\s*INSERT\s+INTO/i.test(text))).toBe(false)
    expect(sql.some((text) => /^\s*UPDATE\s+attendance_records/i.test(text))).toBe(false)
  })

  it('recognizes the immutable operation replay before touching frozen inputs', async () => {
    const replayId = uuid()
    const sql: string[] = []
    const client: W4c3bApprovedLeaveCancellationQueryClient = {
      query: async (text) => {
        sql.push(text)
        if (text.includes('FROM attendance_records')) {
          return {
            rows: [{
              id: uuid(),
              org_id: 'w4c3b-p14-unit-org',
              user_id: 'w4c3b-p14-unit-user',
              work_date: '2026-08-01',
              current_calculation_id: uuid(),
              visibility_state: 'retired',
              visibility_reason: 'operator_retirement',
            }],
          }
        }
        if (text.includes("entrypoint = 'approval_reversal'")) return { rows: [{ id: replayId }] }
        throw new Error(`unexpected query after replay: ${text}`)
      },
    }

    await expect(appendApprovedLeaveCancellationCalculationV1(input(client))).resolves.toEqual({
      kind: 'replay',
      calculationId: replayId,
    })
    expect(sql).toHaveLength(2)
  })

  it('operator-retired approval target fails before calculation or result DML', async () => {
    const sql: string[] = []
    const client: W4c3bApprovedLeaveCancellationQueryClient = {
      query: async (text) => {
        sql.push(text)
        if (text.includes('FROM attendance_records')) {
          return {
            rows: [{
              id: uuid(),
              org_id: 'w4c3b-p14-unit-org',
              user_id: 'w4c3b-p14-unit-user',
              work_date: '2026-08-01',
              current_calculation_id: uuid(),
              visibility_state: 'retired',
              visibility_reason: 'operator_retirement',
            }],
          }
        }
        if (text.includes("entrypoint = 'approval_reversal'")) return { rows: [] }
        throw new Error(`unexpected query after retirement guard: ${text}`)
      },
    }

    await expect(appendApprovedLeaveCancellationCalculationV1(input(client))).rejects.toMatchObject({
      code: 'ATTENDANCE_RECORD_OPERATOR_RETIRED',
    })
    expect(sql).toHaveLength(2)
    expect(sql.some((text) => /^\s*(INSERT|UPDATE|DELETE|MERGE|COPY)\b/i.test(text))).toBe(false)
  })
})
