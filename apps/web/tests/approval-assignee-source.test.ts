import { describe, expect, it } from 'vitest'
import type { ApprovalAssigneeSource, ApprovalNode } from '../src/types/approval'
import { assigneeSourceSummary, nodeAssigneeSourceSummary } from '../src/approvals/assigneeSource'

// UX B2-08 — `assigneeSourceSummary` moved here (byte-identical) from
// `TemplateAuthoringView.vue`'s private `nodeConfigSummary` helper so the approval detail view's
// "upcoming nodes" preview can reuse the exact same wording. This is its first dedicated test
// coverage (it shipped untested as part of the G-1 read-only graph preview).

describe('assigneeSourceSummary (single source)', () => {
  it('static_user: joins userIds with 、, falls back to （无） when empty', () => {
    expect(assigneeSourceSummary({ kind: 'static_user', userIds: ['alice', 'bob'] })).toBe('指定用户：alice、bob')
    expect(assigneeSourceSummary({ kind: 'static_user', userIds: [] })).toBe('指定用户：（无）')
  })

  it('static_role: joins roleIds with 、, falls back to （无） when empty', () => {
    expect(assigneeSourceSummary({ kind: 'static_role', roleIds: ['role_manager', 'role_finance'] })).toBe('指定角色：role_manager、role_finance')
    expect(assigneeSourceSummary({ kind: 'static_role', roleIds: [] })).toBe('指定角色：（无）')
  })

  it('requester: fixed label', () => {
    expect(assigneeSourceSummary({ kind: 'requester' })).toBe('发起人')
  })

  it('form_field_user: names the field id', () => {
    expect(assigneeSourceSummary({ kind: 'form_field_user', fieldId: 'fld_assignee' })).toBe('表单用户字段：fld_assignee')
  })

  it('direct_manager: fixed label', () => {
    expect(assigneeSourceSummary({ kind: 'direct_manager' })).toBe('直属上级')
  })

  it('dept_head: fixed label', () => {
    expect(assigneeSourceSummary({ kind: 'dept_head' })).toBe('部门主管')
  })

  it('continuous_managers: includes the level count', () => {
    expect(assigneeSourceSummary({ kind: 'continuous_managers', levels: 3 })).toBe('连续多级上级（3 级）')
  })

  it('manager_at_level: includes the specific level', () => {
    expect(assigneeSourceSummary({ kind: 'manager_at_level', level: 2 })).toBe('指定层级上级（第 2 级）')
  })

  it('falls back to a JSON dump for an unrecognized kind (defensive default)', () => {
    const unknown = { kind: 'unknown_kind' } as unknown as ApprovalAssigneeSource
    expect(assigneeSourceSummary(unknown)).toBe(JSON.stringify(unknown))
  })
})

describe('nodeAssigneeSourceSummary (node-level)', () => {
  it('approval node with assigneeSources: joins every source with 、', () => {
    const node: ApprovalNode = {
      key: 'a1',
      type: 'approval',
      name: '部门主管审批',
      config: { assigneeSources: [{ kind: 'direct_manager' }, { kind: 'dept_head' }] },
    }
    expect(nodeAssigneeSourceSummary(node)).toBe('直属上级、部门主管')
  })

  it('approval node with ONLY the legacy assigneeType/assigneeIds shape: still gets a real summary', () => {
    const node: ApprovalNode = {
      key: 'a2',
      type: 'approval',
      name: '财务审批',
      config: { assigneeType: 'user', assigneeIds: ['user_finance'] },
    }
    expect(nodeAssigneeSourceSummary(node)).toBe('指定成员：user_finance')

    const roleNode: ApprovalNode = {
      key: 'a3',
      type: 'approval',
      name: '角色审批',
      config: { assigneeType: 'role', assigneeIds: ['role_manager', 'role_finance'] },
    }
    expect(nodeAssigneeSourceSummary(roleNode)).toBe('指定角色：role_manager、role_finance')
  })

  it('approval node with neither shape configured: falls back to unconfigured', () => {
    const node: ApprovalNode = { key: 'a4', type: 'approval', config: {} }
    expect(nodeAssigneeSourceSummary(node)).toBe('（未配置审批人）')
  })

  it('assigneeSources takes precedence over a co-present legacy shape', () => {
    const node: ApprovalNode = {
      key: 'a5',
      type: 'approval',
      config: {
        assigneeType: 'user',
        assigneeIds: ['user_legacy'],
        assigneeSources: [{ kind: 'requester' }],
      },
    }
    expect(nodeAssigneeSourceSummary(node)).toBe('发起人')
  })

  it('cc node: names the target type (成员 vs 角色)', () => {
    const userCc: ApprovalNode = { key: 'cc1', type: 'cc', config: { targetType: 'user', targetIds: ['user_1'] } }
    const roleCc: ApprovalNode = { key: 'cc2', type: 'cc', config: { targetType: 'role', targetIds: ['role_1'] } }
    expect(nodeAssigneeSourceSummary(userCc)).toBe('抄送成员')
    expect(nodeAssigneeSourceSummary(roleCc)).toBe('抄送角色')
  })

  it('condition node: the honest "按条件进入后续分支" label (no fabricated branch)', () => {
    const node: ApprovalNode = {
      key: 'cond1',
      type: 'condition',
      config: { branches: [{ edgeKey: 'e-high', rules: [] }], defaultEdgeKey: 'e-low' },
    }
    expect(nodeAssigneeSourceSummary(node)).toBe('按条件进入后续分支')
  })

  it('parallel node: the honest "进入并行分支" label', () => {
    const node: ApprovalNode = {
      key: 'par1',
      type: 'parallel',
      config: { branches: ['b1', 'b2'], joinMode: 'all', joinNodeKey: 'join1' },
    }
    expect(nodeAssigneeSourceSummary(node)).toBe('进入并行分支')
  })

  it('end node: a friendly "流程结束" label', () => {
    const node: ApprovalNode = { key: 'end', type: 'end', config: {} }
    expect(nodeAssigneeSourceSummary(node)).toBe('流程结束')
  })

  it('start node: empty string (never an "upcoming" node in a valid DAG, but stays defensive)', () => {
    const node: ApprovalNode = { key: 'start', type: 'start', config: {} }
    expect(nodeAssigneeSourceSummary(node)).toBe('')
  })
})
