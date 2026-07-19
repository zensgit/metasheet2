/**
 * Download participation matrix — requester / user-assignee / role-assignee / CC user / CC role / admin.
 * Unit lane with a SQL-shape-aware fake db (real-DB matrix is separate).
 */
import { describe, expect, test } from 'vitest'

import { isApprovalInstanceParticipant } from '../../src/services/approval-attachment-runtime'
import { authorizeAttachmentDownload } from '../../src/services/approval-attachment-storage'

function fakeDb(match: (sql: string, params: unknown[]) => boolean) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const ok = match(sql, params ?? [])
      return { rows: [{ exists: ok }], rowCount: 1 }
    },
  }
}

describe('isApprovalInstanceParticipant', () => {
  test('admin bypasses participation without needing a row match', async () => {
    const db = fakeDb(() => false) // would deny non-admin
    expect(
      await isApprovalInstanceParticipant(db, { id: 'admin1', roles: ['admin'], isAdmin: true }, 'inst_1'),
    ).toBe(true)
  })

  test('SQL includes CC metadata targetType/targetId (not actor_id alone)', async () => {
    let seenSql = ''
    const db = {
      query: async (sql: string) => {
        seenSql = sql
        return { rows: [{ exists: true }], rowCount: 1 }
      },
    }
    await isApprovalInstanceParticipant(db, { id: 'cc_user', roles: [], isAdmin: false }, 'inst_1')
    expect(seenSql).toMatch(/action = 'cc'/)
    expect(seenSql).toMatch(/targetType/)
    expect(seenSql).toMatch(/targetId/)
    expect(seenSql).toMatch(/assignment_type = 'role'/)
  })

  test('role assignee passes roles array into the query', async () => {
    let seenParams: unknown[] = []
    const db = {
      query: async (_sql: string, params?: unknown[]) => {
        seenParams = params ?? []
        return { rows: [{ exists: true }], rowCount: 1 }
      },
    }
    await isApprovalInstanceParticipant(
      db,
      { id: 'u1', roles: ['finance_mgr'], isAdmin: false },
      'inst_1',
    )
    expect(seenParams[2]).toEqual(['finance_mgr'])
  })
})

describe('authorizeAttachmentDownload — admin + hidden', () => {
  test('admin participant bypass still refused when field is hidden (G7)', async () => {
    const r = await authorizeAttachmentDownload(
      { status: 'bound', uploaderId: 'up', instanceId: 'i1', fieldId: 'secret' },
      { id: 'admin', roles: ['admin'], isAdmin: true },
      {
        isInstanceParticipant: async () => true, // admin would pass
        isFieldHiddenAtActiveNode: async () => true,
      },
    )
    expect(r).toEqual({ ok: false, code: 'hidden' })
  })

  test('admin non-hidden bound → ok; outsider → not_participant', async () => {
    expect(
      await authorizeAttachmentDownload(
        { status: 'bound', uploaderId: 'up', instanceId: 'i1', fieldId: 'open' },
        { id: 'admin', roles: [], isAdmin: true },
        {
          isInstanceParticipant: async (v) => v.isAdmin,
          isFieldHiddenAtActiveNode: async () => false,
        },
      ),
    ).toEqual({ ok: true })

    expect(
      await authorizeAttachmentDownload(
        { status: 'bound', uploaderId: 'up', instanceId: 'i1', fieldId: 'open' },
        { id: 'outsider', roles: [], isAdmin: false },
        {
          isInstanceParticipant: async () => false,
          isFieldHiddenAtActiveNode: async () => false,
        },
      ),
    ).toEqual({ ok: false, code: 'not_participant' })
  })
})
