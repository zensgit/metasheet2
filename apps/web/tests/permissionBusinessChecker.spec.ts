import { describe, expect, it } from 'vitest'
import {
  buildBusinessCheckRequest,
  businessCheckConditionKey,
  businessCheckStillCurrent,
  normalizeResourceId,
  readBusinessCheckResponse,
} from '../src/views/permissionBusinessChecker'

function payload(
  policyId: string,
  result: 'allow' | 'deny' | 'unknown',
  extras: Record<string, unknown> = {},
) {
  return {
    policyId,
    result,
    layers: [{ layer: 'business_guard', result }],
    evaluatedAt: '2026-11-17T00:00:00.000Z',
    semantics: 'guard_snapshot',
    ...extras,
  }
}

describe('permissionBusinessChecker', () => {
  it('builds guard requests in the registered key and permission order', () => {
    const attendance = buildBusinessCheckRequest('user-1', 'attendance.decision-trace', { baseId: 'ignored' })
    expect(JSON.stringify(attendance)).toBe(JSON.stringify({
      subject: { kind: 'target', userId: 'user-1' },
      policyId: 'attendance.decision-trace',
      mode: 'single',
      permissions: ['attendance:read'],
    }))
    expect(attendance).not.toHaveProperty('resource')

    const directory = buildBusinessCheckRequest('user-1', 'approval-templates.directory.roles')
    expect(directory).toEqual({
      subject: { kind: 'target', userId: 'user-1' },
      policyId: 'approval-templates.directory.roles',
      mode: 'any',
      permissions: ['approval-templates:manage', 'approvals:admin-templates'],
    })
    expect(Object.keys(directory || {})).toEqual(['subject', 'policyId', 'mode', 'permissions'])
  })

  it('builds resource requests from trimmed ids and omits mode and permissions', () => {
    expect(buildBusinessCheckRequest('user-1', 'multitable.context.sheet', {
      baseId: ' base_1 ',
      sheetId: 'sheet.1',
      viewId: 'should-not-send',
    })).toEqual({
      subject: { kind: 'target', userId: 'user-1' },
      policyId: 'multitable.context.sheet',
      resource: { kind: 'sheet', baseId: 'base_1', sheetId: 'sheet.1' },
    })
    const viewAccess = buildBusinessCheckRequest('user-1', 'multitable.context.view-access', {
      baseId: 'base_1',
      sheetId: 'sheet.1',
      viewId: 'view:1',
    })
    expect(Object.keys((viewAccess as { resource: object }).resource)).toEqual(['kind', 'baseId', 'sheetId', 'viewId'])
    const fieldRead = buildBusinessCheckRequest('user-1', 'multitable.record.field-read', {
      baseId: 'base_1',
      sheetId: 'sheet.1',
      recordId: 'record-1',
      fieldId: 'field_1',
    })
    expect(fieldRead).toEqual({
      subject: { kind: 'target', userId: 'user-1' },
      policyId: 'multitable.record.field-read',
      resource: { kind: 'sheet', baseId: 'base_1', sheetId: 'sheet.1', recordId: 'record-1', fieldId: 'field_1' },
    })
    expect(fieldRead).not.toHaveProperty('mode')
    expect(fieldRead).not.toHaveProperty('permissions')
  })

  it('rejects incomplete, overlong, and non-identifier resource values', () => {
    expect(normalizeResourceId('  ab.1:c_d-e  ')).toBe('ab.1:c_d-e')
    expect(normalizeResourceId('a'.repeat(128))).toHaveLength(128)
    expect(normalizeResourceId('a'.repeat(129))).toBeNull()
    expect(normalizeResourceId('   ')).toBeNull()
    expect(normalizeResourceId('sheet/1')).toBeNull()
    expect(normalizeResourceId('has space')).toBeNull()
    expect(buildBusinessCheckRequest('', 'attendance.decision-trace')).toBeNull()
    expect(buildBusinessCheckRequest('user-1', 'missing.policy')).toBeNull()
    expect(buildBusinessCheckRequest('user-1', 'multitable.record.read', {
      baseId: 'base_1',
      sheetId: 'sheet.1',
    })).toBeNull()
  })

  it('treats a member, condition, or generation change as stale', () => {
    const key = businessCheckConditionKey('multitable.context.sheet', { baseId: 'base_1', sheetId: 'sheet.1' })
    expect(businessCheckStillCurrent({
      startedGeneration: 2,
      currentGeneration: 2,
      startedUserId: 'user-1',
      currentUserId: 'user-1',
      startedKey: key,
      currentKey: key,
    })).toBe(true)
    expect(businessCheckStillCurrent({
      startedGeneration: 2,
      currentGeneration: 3,
      startedUserId: 'user-1',
      currentUserId: 'user-1',
      startedKey: key,
      currentKey: key,
    })).toBe(false)
    expect(businessCheckStillCurrent({
      startedGeneration: 2,
      currentGeneration: 2,
      startedUserId: 'user-1',
      currentUserId: 'user-2',
      startedKey: key,
      currentKey: key,
    })).toBe(false)
    expect(businessCheckStillCurrent({
      startedGeneration: 2,
      currentGeneration: 2,
      startedUserId: 'user-1',
      currentUserId: 'user-1',
      startedKey: key,
      currentKey: businessCheckConditionKey('multitable.context.sheet', { baseId: 'base_1', sheetId: 'sheet-2' }),
    })).toBe(false)
  })

  it('limits an allow to this check and does not promote unknown or broken receipts', () => {
    const allow = readBusinessCheckResponse({
      httpStatus: 200,
      payload: payload('attendance.decision-trace', 'allow', { allowed: false, permissions: ['attendance:read'] }),
      requestedPolicyId: 'attendance.decision-trace',
    })
    expect(allow.phase).toBe('allow')
    expect(allow.detail).toContain('通过此权限检查')
    expect(allow.detail).toContain('不保证业务动作成功')

    const viewAllow = readBusinessCheckResponse({
      httpStatus: 200,
      payload: {
        ...payload('multitable.context.view-access', 'allow'),
        layers: [{ layer: 'resource_context', result: 'allow' }],
      },
      requestedPolicyId: 'multitable.context.view-access',
    })
    expect(viewAllow.detail).toContain('上下文返回的配置能力')
    expect(viewAllow.detail).not.toContain('不保证业务动作成功')

    const cases = [
      readBusinessCheckResponse({
        httpStatus: 200,
        payload: payload('attendance.decision-trace', 'unknown', { allowed: true }),
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 200,
        payload: payload('attendance.decision-trace', 'deny', { allowed: true }),
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 403,
        payload: payload('attendance.decision-trace', 'allow'),
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 503,
        payload: payload('attendance.decision-trace', 'allow'),
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 404,
        payload: payload('attendance.decision-trace', 'allow'),
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 200,
        payload: { result: 'allow', allowed: true, policyId: 'attendance.decision-trace' },
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 200,
        payload: payload('other.policy', 'allow'),
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 200,
        payload: {
          ...payload('attendance.decision-trace', 'allow'),
          layers: [{ layer: 'navigation', result: 'allow' }],
        },
        requestedPolicyId: 'attendance.decision-trace',
      }),
      readBusinessCheckResponse({
        httpStatus: 200,
        payload: { ...payload('attendance.decision-trace', 'allow'), layers: [] },
        requestedPolicyId: 'attendance.decision-trace',
      }),
    ]
    expect(cases.map((entry) => entry.phase)).toEqual([
      'unknown',
      'deny',
      'forbidden',
      'unavailable',
      'missing',
      'error',
      'error',
      'error',
      'error',
    ])
    for (const entry of cases) {
      expect(entry.detail).not.toContain('通过此权限检查')
      expect(entry.detail).not.toContain('允许')
    }
  })
})
