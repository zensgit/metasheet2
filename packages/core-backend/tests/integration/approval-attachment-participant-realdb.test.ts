/**
 * Download participation matrix (real DB) — requester, user assignee, role assignee, CC user,
 * CC role, admin positive; outsider + hidden-field negatives. Two-point wired.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  createDownloadAuthChecks,
  isApprovalInstanceParticipant,
} from '../../src/services/approval-attachment-runtime'
import { authorizeAttachmentDownload } from '../../src/services/approval-attachment-storage'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const INST = `apr_part_${RUN}`
const ATT = `att_part_${RUN}`

describeIfDatabase('approval attachment participation matrix (real DB)', () => {
  afterAll(async () => {
    await db().query('DELETE FROM approval_attachments WHERE id = $1', [ATT]).catch(() => {})
    await db().query('DELETE FROM approval_records WHERE instance_id = $1', [INST]).catch(() => {})
    await db().query('DELETE FROM approval_assignments WHERE instance_id = $1', [INST]).catch(() => {})
    await db().query('DELETE FROM approval_instances WHERE id = $1', [INST]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('matrix: requester/user-assignee/role-assignee/CC-user/CC-role/admin yes; outsider no', async () => {
    await db().query(
      `INSERT INTO approval_instances (id, status, requester_snapshot)
       VALUES ($1, 'pending', $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET requester_snapshot = EXCLUDED.requester_snapshot`,
      [INST, JSON.stringify({ id: 'requester_1' })],
    )
    await db().query(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, is_active, source_step)
       VALUES
         ($1, 'user', 'assignee_user', true, 0),
         ($1, 'role', 'finance_role', true, 0)
       ON CONFLICT DO NOTHING`,
      [INST],
    )
    await db().query(
      `INSERT INTO approval_records (
         instance_id, action, actor_id, actor_name, to_status, to_version, metadata
       )
       VALUES
         ($1, 'cc', 'system', 'System', 'pending', 0, $2::jsonb),
         ($1, 'cc', 'system', 'System', 'pending', 0, $3::jsonb)`,
      [
        INST,
        JSON.stringify({ targetType: 'user', targetId: 'cc_user_1', nodeKey: 'cc1' }),
        JSON.stringify({ targetType: 'role', targetId: 'cc_role_1', nodeKey: 'cc1' }),
      ],
    )

    const yes = async (viewer: { id: string; roles: string[]; isAdmin: boolean }) =>
      isApprovalInstanceParticipant(db(), viewer, INST)

    expect(await yes({ id: 'requester_1', roles: [], isAdmin: false })).toBe(true)
    expect(await yes({ id: 'assignee_user', roles: [], isAdmin: false })).toBe(true)
    expect(await yes({ id: 'anyone', roles: ['finance_role'], isAdmin: false })).toBe(true)
    expect(await yes({ id: 'cc_user_1', roles: [], isAdmin: false })).toBe(true)
    expect(await yes({ id: 'anyone', roles: ['cc_role_1'], isAdmin: false })).toBe(true)
    expect(await yes({ id: 'admin_x', roles: [], isAdmin: true })).toBe(true)
    // Negatives
    expect(await yes({ id: 'outsider', roles: [], isAdmin: false })).toBe(false)
    expect(await yes({ id: 'outsider', roles: ['other_role'], isAdmin: false })).toBe(false)
  })

  test('hidden field refuses even admin; non-hidden admin ok (positive control)', async () => {
    // Minimal checks stub that uses real participant + synthetic hidden
    const checks = {
      isInstanceParticipant: async (
        viewer: { id: string; roles: readonly string[]; isAdmin: boolean },
        instanceId: string,
      ) => isApprovalInstanceParticipant(db(), viewer, instanceId),
      isFieldHiddenAtActiveNode: async (_instanceId: string, fieldId: string) => fieldId === 'secret',
    }
    const row = {
      status: 'bound' as const,
      uploaderId: 'requester_1',
      instanceId: INST,
      fieldId: 'secret',
    }
    const admin = { id: 'admin_x', roles: [] as string[], isAdmin: true }
    expect(await authorizeAttachmentDownload(row, admin, checks)).toEqual({ ok: false, code: 'hidden' })
    expect(
      await authorizeAttachmentDownload({ ...row, fieldId: 'open' }, admin, checks),
    ).toEqual({ ok: true })
  })
})
