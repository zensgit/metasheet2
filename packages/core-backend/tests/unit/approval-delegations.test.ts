import { describe, expect, it } from 'vitest'
import { resolveActiveDelegationMap } from '../../src/services/ApprovalDelegations'

describe('resolveActiveDelegationMap', () => {
  const fakeQuery =
    (rows: Array<{ delegator_user_id: string; delegatee_user_id: string }>) =>
    async <Row>(): Promise<{ rows: Row[] }> => ({ rows: rows as unknown as Row[] })

  const now = new Date('2026-06-22T00:00:00Z')

  it('builds a delegator->delegatee map from active rows', async () => {
    const map = await resolveActiveDelegationMap(
      fakeQuery([
        { delegator_user_id: 'A', delegatee_user_id: 'B' },
        { delegator_user_id: 'C', delegatee_user_id: 'D' },
      ]),
      { templateId: 't1', now },
    )
    expect(map).toEqual({ A: 'B', C: 'D' })
  })

  it('template scope wins over all scope (SQL ORDER BY applies the template row last)', async () => {
    // The query orders 'all' before 'template'; the map builder's last-write-wins then
    // lets the template row override the all row for the same delegator.
    const map = await resolveActiveDelegationMap(
      fakeQuery([
        { delegator_user_id: 'A', delegatee_user_id: 'B' }, // all (ordered first)
        { delegator_user_id: 'A', delegatee_user_id: 'C' }, // template (ordered last)
      ]),
      { templateId: 't1', now },
    )
    expect(map).toEqual({ A: 'C' })
  })

  it('drops malformed and self rows', async () => {
    const map = await resolveActiveDelegationMap(
      fakeQuery([
        { delegator_user_id: 'A', delegatee_user_id: 'A' }, // self (defensive; table CHECK blocks it)
        { delegator_user_id: '  ', delegatee_user_id: 'B' }, // empty delegator
        { delegator_user_id: 'C', delegatee_user_id: 'D' },
      ]),
      { templateId: 't1', now },
    )
    expect(map).toEqual({ C: 'D' })
  })

  it('passes the create instant + templateId as the window + scope params', async () => {
    let captured: unknown[] = []
    const spyQuery = async <Row>(_text: string, params?: unknown[]): Promise<{ rows: Row[] }> => {
      captured = params ?? []
      return { rows: [] as Row[] }
    }
    await resolveActiveDelegationMap(spyQuery, { templateId: 't1', now: new Date('2026-06-22T03:00:00Z') })
    expect(captured).toEqual(['2026-06-22T03:00:00.000Z', 't1'])
  })
})
