import { describe, expect, it } from 'vitest'
import { createDelegation, listDelegations, disableDelegation, updateDelegation } from '../../src/services/ApprovalDelegationConfig'

const WINDOW = { startAt: '2026-06-22T00:00:00Z', endAt: '2026-06-23T00:00:00Z' }
const okRow = {
  id: 'd1', delegator_user_id: 'A', delegatee_user_id: 'B', scope: 'all',
  scope_template_id: null, start_at: '2026-06-22T00:00:00.000Z', end_at: '2026-06-23T00:00:00.000Z', active: true,
}
const rowsQuery =
  (rows: unknown[]) =>
  async <Row>(): Promise<{ rows: Row[] }> => ({ rows: rows as Row[] })

describe('ApprovalDelegationConfig.createDelegation — validation', () => {
  const base = { delegatorUserId: 'A', delegateeUserId: 'B', scope: 'all' as const, ...WINDOW }

  it('rejects self-delegation', async () => {
    await expect(createDelegation(rowsQuery([]), { ...base, delegateeUserId: 'A' })).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' })
  })
  it('rejects endAt <= startAt', async () => {
    await expect(createDelegation(rowsQuery([]), { ...base, startAt: '2026-06-23T00:00:00Z', endAt: '2026-06-22T00:00:00Z' })).rejects.toMatchObject({ statusCode: 400 })
  })
  it('rejects an invalid scope', async () => {
    await expect(createDelegation(rowsQuery([]), { ...base, scope: 'bogus' as never })).rejects.toMatchObject({ statusCode: 400 })
  })
  it("rejects scope='template' with no scopeTemplateId", async () => {
    await expect(createDelegation(rowsQuery([]), { ...base, scope: 'template' })).rejects.toMatchObject({ statusCode: 400 })
  })
  it('maps a unique-violation (23505) to a 409 conflict', async () => {
    const q = async () => { throw Object.assign(new Error('dup'), { code: '23505' }) }
    await expect(createDelegation(q, base)).rejects.toMatchObject({ statusCode: 409, code: 'DELEGATION_CONFLICT' })
  })

  it("nulls scope_template_id for scope='all' even if a target is passed, and returns the record", async () => {
    let params: unknown[] = []
    const q = async <Row>(_text: string, p?: unknown[]): Promise<{ rows: Row[] }> => {
      params = p ?? []
      return { rows: [okRow] as Row[] }
    }
    const rec = await createDelegation(q, { ...base, delegatorUserId: '  A  ', scopeTemplateId: 't1' })
    expect(params[4]).toBeNull() // scope_template_id INSERT param
    expect(params[1]).toBe('A') // delegator trimmed
    expect(rec).toMatchObject({ id: 'd1', delegatorUserId: 'A', delegateeUserId: 'B', scope: 'all', scopeTemplateId: null, active: true })
  })
})

describe('ApprovalDelegationConfig.disableDelegation', () => {
  it('returns false when no row matched (unknown or already-inactive id)', async () => {
    expect(await disableDelegation(rowsQuery([]), 'd1')).toBe(false)
  })
  it('returns true when the row was disabled', async () => {
    expect(await disableDelegation(rowsQuery([{ id: 'd1' }]), 'd1')).toBe(true)
  })
})

describe('ApprovalDelegationConfig.listDelegations', () => {
  it('maps rows to camelCase records (admin view, all delegators)', async () => {
    const list = await listDelegations(rowsQuery([{ ...okRow, scope: 'template', scope_template_id: 't1' }]))
    expect(list).toEqual([
      { id: 'd1', delegatorUserId: 'A', delegateeUserId: 'B', scope: 'template', scopeTemplateId: 't1', startAt: '2026-06-22T00:00:00.000Z', endAt: '2026-06-23T00:00:00.000Z', active: true },
    ])
  })
})

describe('ApprovalDelegationConfig.updateDelegation', () => {
  const existing = { ...okRow, delegator_user_id: 'A', delegatee_user_id: 'B' }

  it('returns null for an unknown id', async () => {
    expect(await updateDelegation(rowsQuery([]), 'nope', { active: false })).toBeNull()
  })
  it('rejects a patch that makes delegatee == delegator', async () => {
    await expect(updateDelegation(rowsQuery([existing]), 'd1', { delegateeUserId: 'A' })).rejects.toMatchObject({ statusCode: 400 })
  })
  it('rejects a patch with an inverted window', async () => {
    await expect(updateDelegation(rowsQuery([existing]), 'd1', { startAt: '2026-06-23T00:00:00Z', endAt: '2026-06-22T00:00:00Z' })).rejects.toMatchObject({ statusCode: 400 })
  })
  it('disables via active=false and returns the updated record (SELECT then UPDATE)', async () => {
    let call = 0
    const q = async <Row>(): Promise<{ rows: Row[] }> => {
      call += 1
      return { rows: [(call === 1 ? existing : { ...existing, active: false })] as Row[] }
    }
    const rec = await updateDelegation(q, 'd1', { active: false })
    expect(rec?.active).toBe(false)
  })
})
