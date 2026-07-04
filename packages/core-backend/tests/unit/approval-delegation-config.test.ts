import { describe, expect, it } from 'vitest'
import {
  createDelegation,
  listDelegations,
  disableDelegation,
  updateDelegation,
  disableOwnDelegation,
  countDelegatedApprovals,
} from '../../src/services/ApprovalDelegationConfig'

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

  it('default (active-only) filters WHERE active; delegator filter is parameterized', async () => {
    let sql = ''
    let params: unknown[] = []
    const q = async <Row>(text: string, p?: unknown[]): Promise<{ rows: Row[] }> => {
      sql = text
      params = p ?? []
      return { rows: [] as Row[] }
    }
    await listDelegations(q, { delegatorUserId: '  A  ' })
    expect(sql).toMatch(/WHERE active AND delegator_user_id = \$1/)
    expect(params).toEqual(['A'])
  })

  it('includeInactive drops the active predicate (history/audit view)', async () => {
    let sql = ''
    const q = async <Row>(text: string): Promise<{ rows: Row[] }> => {
      sql = text
      return { rows: [] as Row[] }
    }
    await listDelegations(q, { includeInactive: true })
    expect(sql).not.toMatch(/WHERE/)
    await listDelegations(q, { delegatorUserId: 'A', includeInactive: true })
    expect(sql).toMatch(/WHERE delegator_user_id = \$1/)
    expect(sql).not.toMatch(/active/)
  })
})

describe('ApprovalDelegationConfig.disableOwnDelegation (self-service 403-vs-404 discriminator)', () => {
  it('returns not_found for an unknown id (route → 404)', async () => {
    expect(await disableOwnDelegation(rowsQuery([]), 'd1', 'A')).toEqual({ status: 'not_found' })
  })
  it("returns forbidden when the row is owned by someone else (route → 403, NOT a masking 404)", async () => {
    expect(await disableOwnDelegation(rowsQuery([{ delegator_user_id: 'B' }]), 'd1', 'A')).toEqual({ status: 'forbidden' })
  })
  it('returns forbidden when no actor id is supplied', async () => {
    expect(await disableOwnDelegation(rowsQuery([{ delegator_user_id: 'A' }]), 'd1', '   ')).toEqual({ status: 'forbidden' })
  })
  it('returns ok when the caller owns the row, and issues the disabling UPDATE', async () => {
    const seen: string[] = []
    const q = async <Row>(text: string): Promise<{ rows: Row[] }> => {
      seen.push(text)
      return { rows: (seen.length === 1 ? [{ delegator_user_id: 'A' }] : []) as Row[] }
    }
    expect(await disableOwnDelegation(q, 'd1', '  A  ')).toEqual({ status: 'ok' })
    expect(seen[0]).toMatch(/SELECT delegator_user_id/)
    expect(seen[1]).toMatch(/UPDATE approval_delegations SET active = FALSE/)
  })
})

describe('ApprovalDelegationConfig.countDelegatedApprovals (audit derivation)', () => {
  it('parses bigint COUNT strings into a delegator→count map', async () => {
    const map = await countDelegatedApprovals(rowsQuery([
      { delegator: 'A', cnt: '3' },
      { delegator: 'C', cnt: 1 },
    ]))
    expect(map).toEqual({ A: 3, C: 1 })
  })
  it('scopes the query to one delegator when filtered', async () => {
    let params: unknown[] = []
    const q = async <Row>(_text: string, p?: unknown[]): Promise<{ rows: Row[] }> => {
      params = p ?? []
      return { rows: [{ delegator: 'A', cnt: '2' }] as Row[] }
    }
    const map = await countDelegatedApprovals(q, { delegatorUserId: '  A  ' })
    expect(params).toEqual(['A'])
    expect(map).toEqual({ A: 2 })
  })
  it('ignores rows with a null/blank delegator key', async () => {
    const map = await countDelegatedApprovals(rowsQuery([{ delegator: null, cnt: '9' }]))
    expect(map).toEqual({})
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
