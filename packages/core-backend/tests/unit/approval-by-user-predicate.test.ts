/**
 * 按人查单（管理员）— the pure half: the three SQL conditions, the query parser and the row shape
 * (`services/approval-by-user-predicate.ts`). The route and its guard are covered in
 * `approval-admin-by-user.test.ts`; the SQL against real PostgreSQL in
 * `tests/integration/approval-bulk-reassign.api.test.ts`.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_BY_USER_DECISION_ACTIONS,
  APPROVAL_BY_USER_KINDS,
  APPROVAL_BY_USER_MAX_PAGE,
  APPROVAL_BY_USER_MAX_PAGE_SIZE,
  APPROVAL_BY_USER_NON_PARTICIPANT_ACTIONS,
  approvalActiveAssigneeConditionSql,
  approvalByUserConditionSql,
  isApprovalByUserKind,
  parseApprovalByUserQuery,
  toApprovalByUserRow,
  type ApprovalByUserKind,
} from '../../src/services/approval-by-user-predicate'
import type { UnifiedApprovalDTO } from '../../src/services/approval-bridge-types'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = join(here, '../../src')

function placeholders(sql: string): string[] {
  return Array.from(new Set(sql.match(/\$\d+/g) ?? []))
}

describe('approval by-user kinds', () => {
  it('is exactly pending / decided / involved', () => {
    expect([...APPROVAL_BY_USER_KINDS]).toEqual(['pending', 'decided', 'involved'])
  })

  it('accepts only the exact literals', () => {
    for (const kind of APPROVAL_BY_USER_KINDS) expect(isApprovalByUserKind(kind)).toBe(true)
    for (const value of ['PENDING', 'Pending', ' pending', '', 'all', 'processed', undefined, null, 1, ['pending']]) {
      expect(isApprovalByUserKind(value)).toBe(false)
    }
  })
})

describe('approvalActiveAssigneeConditionSql', () => {
  it('is the active-seat conjunct the list assignee filter has always emitted', () => {
    expect(approvalActiveAssigneeConditionSql(3)).toBe(`id IN (
          SELECT instance_id
          FROM approval_assignments
          WHERE assignee_id = $3
            AND is_active = TRUE
        )`)
  })

  it('is what ApprovalBridgeService.buildListWhere emits for `assignee` (shared, not copied)', () => {
    const source = readFileSync(join(srcRoot, 'services/ApprovalBridgeService.ts'), 'utf8')
    expect(source).toMatch(/if \(options\?\.assignee\) \{\s*conditions\.push\(approvalActiveAssigneeConditionSql\(paramIndex\+\+\)\)/)
  })
})

describe('approvalByUserConditionSql', () => {
  it('pending: platform row, pending status, ACTIVE seat — the batch-transfer queue read', () => {
    const sql = approvalByUserConditionSql('pending', 7)
    expect(sql).toContain(`COALESCE(source_system, 'platform') = 'platform'`)
    expect(sql).toContain(`status = 'pending'`)
    expect(sql).toContain(approvalActiveAssigneeConditionSql(7))
    expect(placeholders(sql)).toEqual(['$7'])
  })

  it('decided: decision actions only, any current status', () => {
    const sql = approvalByUserConditionSql('decided', 2)
    expect(sql).toContain(`COALESCE(source_system, 'platform') = 'platform'`)
    expect(sql).toContain(`actor_id = $2`)
    expect(sql).toContain(`action IN ('approve', 'reject', 'return', 'handle')`)
    expect(sql).not.toContain(`status = 'pending'`)
    for (const excluded of ['transfer', 'comment', 'cc', 'revoke', 'created', 'reassign', 'jump', 'remind']) {
      expect(sql).not.toContain(`'${excluded}'`)
    }
    expect(placeholders(sql)).toEqual(['$2'])
  })

  it('involved: requester, any USER seat (active or not), participant actions, USER cc target', () => {
    const sql = approvalByUserConditionSql('involved', 4)
    expect(sql).toContain(`COALESCE(source_system, 'platform') = 'platform'`)
    expect(sql).toContain(`requester_snapshot->>'id' = $4`)
    expect(sql).toMatch(/FROM approval_assignments\s+WHERE assignment_type = 'user'\s+AND assignee_id = \$4\s+\)/)
    expect(sql).toContain(`action NOT IN ('reassign', 'jump')`)
    expect(sql).toContain(`metadata->>'targetType' = 'user' AND metadata->>'targetId' = $4`)
    // User arms only: no role arm, and the seat arm is not narrowed to active seats.
    expect(sql).not.toContain('ANY(')
    expect(sql).not.toContain(`'role'`)
    expect(sql).not.toContain('is_active')
    expect(placeholders(sql)).toEqual(['$4'])
  })

  it('refuses an unknown kind instead of emitting no filter', () => {
    expect(() => approvalByUserConditionSql('all' as ApprovalByUserKind, 1)).toThrow(TypeError)
    expect(() => approvalByUserConditionSql('' as ApprovalByUserKind, 1)).toThrow(TypeError)
  })

  it('every action it names is a member of the approval_records action CHECK', () => {
    const migration = readFileSync(
      join(srcRoot, 'db/migrations/zzzz20260818090000_add_policy_denied_action_to_approval_records.ts'),
      'utf8',
    )
    const block = /const ACTIONS_WITH_POLICY_DENIED = \[([\s\S]*?)\]/.exec(migration)?.[1] ?? ''
    const universe = Array.from(block.matchAll(/'([a-z_]+)'/g)).map((match) => match[1])
    expect(universe.length).toBeGreaterThan(10)
    for (const action of [...APPROVAL_BY_USER_DECISION_ACTIONS, ...APPROVAL_BY_USER_NON_PARTICIPANT_ACTIONS]) {
      expect(universe).toContain(action)
    }
  })
})

describe('parseApprovalByUserQuery', () => {
  it('defaults page 1 / pageSize 20 and trims the user id', () => {
    expect(parseApprovalByUserQuery({ userId: '  u-1 ', kind: 'involved' })).toEqual({
      ok: true,
      value: { userId: 'u-1', kind: 'involved', page: 1, pageSize: 20 },
    })
  })

  it('accepts explicit paging at both bounds', () => {
    expect(parseApprovalByUserQuery({
      userId: 'u-1',
      kind: 'decided',
      page: String(APPROVAL_BY_USER_MAX_PAGE),
      pageSize: String(APPROVAL_BY_USER_MAX_PAGE_SIZE),
    })).toEqual({
      ok: true,
      value: { userId: 'u-1', kind: 'decided', page: 1000, pageSize: 100 },
    })
    expect(parseApprovalByUserQuery({ userId: 'u-1', kind: 'pending', page: '1', pageSize: '1' })).toEqual({
      ok: true,
      value: { userId: 'u-1', kind: 'pending', page: 1, pageSize: 1 },
    })
  })

  it('refuses an unknown query key', () => {
    expect(parseApprovalByUserQuery({ userId: 'u-1', kind: 'pending', tab: 'pending' })).toEqual({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Unsupported query parameter',
    })
  })

  it('refuses a missing, blank, repeated or over-long user id', () => {
    for (const userId of [undefined, '', '   ', ['u-1', 'u-2'], { a: 'b' }, 'x'.repeat(256)]) {
      expect(parseApprovalByUserQuery({ userId, kind: 'pending' })).toEqual({
        ok: false,
        code: 'APPROVAL_BY_USER_USER_REQUIRED',
        message: 'userId must be a single non-empty value',
      })
    }
  })

  it('refuses an unknown, absent or repeated kind (enum-strict)', () => {
    for (const kind of [undefined, '', 'all', 'PENDING', 'processed', ['pending']]) {
      expect(parseApprovalByUserQuery({ userId: 'u-1', kind })).toEqual({
        ok: false,
        code: 'APPROVAL_BY_USER_KIND_INVALID',
        message: 'kind must be one of pending, decided, involved',
      })
    }
  })

  it('refuses out-of-range or malformed paging instead of clamping it', () => {
    const cases: Array<Record<string, unknown>> = [
      { page: '0' },
      { page: '1001' },
      { page: '-1' },
      { page: '1.5' },
      { page: 'abc' },
      { page: '' },
      { page: ['1', '2'] },
      { pageSize: '0' },
      { pageSize: '101' },
      { pageSize: '20x' },
    ]
    for (const paging of cases) {
      expect(parseApprovalByUserQuery({ userId: 'u-1', kind: 'pending', ...paging })).toEqual({
        ok: false,
        code: 'APPROVAL_BY_USER_PAGING_INVALID',
        message: 'page must be 1-1000 and pageSize 1-100',
      })
    }
  })
})

describe('toApprovalByUserRow', () => {
  it('keeps only what identifies and opens the instance', () => {
    const dto = {
      id: 'apr-1',
      sourceSystem: 'platform',
      externalApprovalId: null,
      workflowKey: 'wf',
      businessKey: 'bk',
      title: '采购申请',
      status: 'approved',
      requester: { id: 'u-req', name: '申请人', department: 'd-1' },
      subject: { anything: true },
      policy: { allowRevoke: true },
      currentStep: 1,
      totalSteps: 2,
      templateId: 'tpl-1',
      requestNo: 'AP-0001',
      formSnapshot: { amount: 100 },
      assignments: [{ id: 'a', type: 'user', assigneeId: 'u-x', sourceStep: 0, nodeKey: 'n', isActive: true, metadata: {} }],
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    } as unknown as UnifiedApprovalDTO
    expect(toApprovalByUserRow(dto)).toEqual({
      id: 'apr-1',
      requestNo: 'AP-0001',
      title: '采购申请',
      status: 'approved',
      templateId: 'tpl-1',
      requester: { id: 'u-req', name: '申请人' },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    })
  })

  it('maps absent or blank optional fields to null', () => {
    const dto = {
      id: 'apr-2',
      title: '',
      status: 'pending',
      requester: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    } as unknown as UnifiedApprovalDTO
    expect(toApprovalByUserRow(dto)).toEqual({
      id: 'apr-2',
      requestNo: null,
      title: null,
      status: 'pending',
      templateId: null,
      requester: { id: null, name: null },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
  })
})
