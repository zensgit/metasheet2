import { describe, expect, it } from 'vitest'
import { resolveApprovalRequesterRoleIds } from '../../src/services/ApprovalRequesterRoles'

// A QueryFn-shaped stub returning fixed rows (the resolver issues exactly one SELECT).
function stubRows(rows: Array<{ role_id: string | null }>) {
  return <Row>(_text: string, _params?: unknown[]): Promise<{ rows: Row[] }> =>
    Promise.resolve({ rows: rows as unknown as Row[] })
}

describe('resolveApprovalRequesterRoleIds (RA-1b fresh user_roles resolver)', () => {
  it('dedupes, trims, strips blank/null, preserves order; returns [] for a blank user id', async () => {
    const q = stubRows([{ role_id: 'a' }, { role_id: 'a' }, { role_id: ' ' }, { role_id: null }, { role_id: ' b ' }])
    expect(await resolveApprovalRequesterRoleIds('u-1', q)).toEqual(['a', 'b'])
    expect(await resolveApprovalRequesterRoleIds('   ', q)).toEqual([])
  })

  it('propagates a read failure (so the create-time wedge guard can 503, not silently route on empty)', async () => {
    const boom = <Row>(_t: string, _p?: unknown[]): Promise<{ rows: Row[] }> =>
      Promise.reject(new Error('user_roles read failed'))
    await expect(resolveApprovalRequesterRoleIds('u-1', boom)).rejects.toThrow('user_roles read failed')
  })

  it('RA-1b CURATED-VOCABULARY: filters to approval_usable roles via a JOIN on `roles` (SQL lock)', async () => {
    // The stub ignores the SQL text (real curation lives in the DB), so assert the SQL itself JOINs `roles`
    // and filters approval_usable — the real-DB test proves the runtime behaviour. Without the JOIN, a
    // SYSTEM role the requester holds would leak into directoryRoles.
    let capturedSql = ''
    const q = <Row>(text: string, _params?: unknown[]): Promise<{ rows: Row[] }> => {
      capturedSql = text
      return Promise.resolve({ rows: [{ role_id: 'finance_approver' }] as unknown as Row[] })
    }
    expect(await resolveApprovalRequesterRoleIds('u-1', q)).toEqual(['finance_approver'])
    expect(capturedSql).toMatch(/JOIN\s+roles/i)
    expect(capturedSql).toMatch(/approval_usable\s*=\s*true/i)
  })
})
