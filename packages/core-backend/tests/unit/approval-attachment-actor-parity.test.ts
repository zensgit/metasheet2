/**
 * Upload actor parity with createApproval — departmentIds inputs + isTemplateManager formula.
 * Mutations: omitting departments arrays or treating approvals:admin as manager must RED.
 */
import { describe, expect, test } from 'vitest'
import type { Request } from 'express'

import {
  isCreateApprovalTemplateManager,
  resolveApprovalActorDepartmentIds,
  resolveCreateApprovalActorFromRequest,
} from '../../src/routes/approvals'
import { authorizeUploadTarget } from '../../src/services/approval-attachment-runtime'

function fakeReq(user: Record<string, unknown>): Request {
  return { user } as unknown as Request
}

describe('createApproval actor resolver parity (export from approvals route)', () => {
  test('departmentIds includes department, departmentId, deptId, dept, departmentIds, departments', () => {
    const ids = resolveApprovalActorDepartmentIds(
      fakeReq({
        id: 'u1',
        department: 'd1',
        departmentId: 'd2',
        deptId: 'd3',
        dept: 'd4',
        departmentIds: ['d5', 'd6'],
        departments: ['d7'],
      }),
    )
    expect(ids.sort()).toEqual(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'].sort())
  })

  test('resolveCreateApprovalActorFromRequest carries full departmentIds set', () => {
    const actor = resolveCreateApprovalActorFromRequest(
      fakeReq({
        id: 'u1',
        departmentIds: ['eng'],
        departments: ['sales'],
        dept: 'ops',
        roles: ['member'],
        permissions: ['approvals:write'],
      }),
    )
    expect(actor).not.toBeNull()
    expect(actor!.departmentIds.sort()).toEqual(['eng', 'ops', 'sales'].sort())
    expect(actor!.isTemplateManager).toBe(false)
  })

  test('isCreateApprovalTemplateManager: approvals:admin does NOT bypass; admin role / manage does', () => {
    // Negative: operational admin without template-manager perms
    expect(isCreateApprovalTemplateManager({ roles: [], permissions: ['approvals:admin'] })).toBe(false)
    expect(isCreateApprovalTemplateManager({ roles: [], permissions: ['approvals:write'] })).toBe(false)
    // Positive controls — same as assembleCreationContext
    expect(isCreateApprovalTemplateManager({ roles: ['admin'], permissions: [] })).toBe(true)
    expect(isCreateApprovalTemplateManager({ roles: [], permissions: ['approval-templates:manage'] })).toBe(true)
    expect(isCreateApprovalTemplateManager({ roles: [], permissions: ['approvals:admin-templates'] })).toBe(true)
    expect(isCreateApprovalTemplateManager({ roles: [], permissions: ['approvals:*'] })).toBe(true)
    expect(isCreateApprovalTemplateManager({ roles: [], permissions: ['*:*'] })).toBe(true)
  })
})

describe('authorizeUploadTarget uses departmentIds for dept-scoped visibility', () => {
  test('dept-scoped template visible only when actor.departmentIds intersect scope', async () => {
    let seenParams: unknown[] = []
    const db = {
      query: async (_sql: string, params?: unknown[]) => {
        seenParams = params ?? []
        // Simulate: only return a row when dept param includes 'dept_eng'
        const depts = params?.[2] as string[] | undefined
        if (Array.isArray(depts) && depts.includes('dept_eng')) {
          return {
            rows: [{
              template_status: 'published',
              form_schema: { fields: [{ id: 'proof', type: 'attachment', label: 'P' }] },
              published_id: 'pd1',
              published_active: true,
            }],
            rowCount: 1,
          }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    const miss = await authorizeUploadTarget(db, 'tpl1', 'proof', {
      userId: 'u1',
      departmentIds: ['other'],
      roles: [],
      isTemplateManager: false,
    })
    expect(miss).toEqual({ ok: false, code: 'not_found' })
    expect(seenParams[2]).toEqual(['other'])

    const hit = await authorizeUploadTarget(db, 'tpl1', 'proof', {
      userId: 'u1',
      departmentIds: ['dept_eng'],
      roles: [],
      isTemplateManager: false,
    })
    expect(hit).toEqual({ ok: true })
  })

  test('approvals:admin with isTemplateManager=false does NOT bypass visibility (not_found)', async () => {
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }), // invisible
    }
    const r = await authorizeUploadTarget(db, 'tpl_secret', 'proof', {
      userId: 'admin_ops',
      departmentIds: [],
      roles: [],
      permissions: ['approvals:admin'],
      isTemplateManager: false, // create-path formula: approvals:admin alone is false
    })
    expect(r).toEqual({ ok: false, code: 'not_found' })
  })

  test('positive: isTemplateManager=true bypasses visibility SQL filter', async () => {
    let sql = ''
    const db = {
      query: async (s: string) => {
        sql = s
        return {
          rows: [{
            template_status: 'published',
            form_schema: { fields: [{ id: 'proof', type: 'attachment' }] },
            published_id: 'pd1',
            published_active: true,
          }],
          rowCount: 1,
        }
      },
    }
    const r = await authorizeUploadTarget(db, 'tpl1', 'proof', {
      userId: 'mgr',
      departmentIds: [],
      roles: ['admin'],
      isTemplateManager: true,
    })
    expect(r).toEqual({ ok: true })
    // Manager path should not inject visibility_scope SQL
    expect(sql).not.toMatch(/visibility_scope/)
  })
})
