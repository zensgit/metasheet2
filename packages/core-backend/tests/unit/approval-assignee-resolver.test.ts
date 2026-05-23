import { describe, expect, it } from 'vitest'
import { resolveApprovalAssignees } from '../../src/services/ApprovalAssigneeResolver'
import type { ApprovalNodeConfig, FormSchema } from '../../src/types/approval-product'

const userFieldSchema: FormSchema = {
  fields: [
    { id: 'approver', type: 'user', label: 'Approver' },
    { id: 'notes', type: 'text', label: 'Notes' },
  ],
}

function resolve(config: ApprovalNodeConfig, formSnapshot: Record<string, unknown> = {}) {
  return resolveApprovalAssignees({
    nodeKey: 'review',
    sourceStep: 2,
    config,
    formSchema: userFieldSchema,
    formSnapshot,
    requesterSnapshot: { id: 'requester-1', name: 'Requester One' },
  })
}

describe('ApprovalAssigneeResolver', () => {
  it('keeps legacy static user and role assignments metadata-free', () => {
    expect(resolve({ assigneeType: 'user', assigneeIds: ['user-1', 'user-2'] })).toEqual([
      { assignmentType: 'user', assigneeId: 'user-1', nodeKey: 'review', sourceStep: 2 },
      { assignmentType: 'user', assigneeId: 'user-2', nodeKey: 'review', sourceStep: 2 },
    ])

    expect(resolve({ assigneeType: 'role', assigneeIds: ['finance'] })).toEqual([
      { assignmentType: 'role', assigneeId: 'finance', nodeKey: 'review', sourceStep: 2 },
    ])
  })

  it('resolves requester and static sources with source metadata', () => {
    expect(resolve({
      assigneeSources: [
        { kind: 'requester' },
        { kind: 'static_user', userIds: ['manager-1'] },
        { kind: 'static_role', roleIds: ['finance'] },
      ],
    })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'requester-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      },
      {
        assignmentType: 'user',
        assigneeId: 'manager-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'static_user', sourceIndex: 1 } },
      },
      {
        assignmentType: 'role',
        assigneeId: 'finance',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'static_role', sourceIndex: 2 } },
      },
    ])
  })

  it('resolves user form fields from string and object values', () => {
    expect(resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'approver' }],
    }, { approver: 'form-user-1' })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'form-user-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'form_field_user', sourceIndex: 0, fieldId: 'approver' } },
      },
    ])

    expect(resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'approver' }],
    }, { approver: { id: 'form-user-2', name: 'Form User' } })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'form-user-2',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'form_field_user', sourceIndex: 0, fieldId: 'approver' } },
      },
    ])
  })

  it('returns no assignments for missing dynamic values so the node policy decides', () => {
    expect(resolve({
      assigneeSources: [
        { kind: 'form_field_user', fieldId: 'approver' },
      ],
    }, { approver: null })).toEqual([])

    expect(resolveApprovalAssignees({
      nodeKey: 'review',
      sourceStep: 2,
      config: { assigneeSources: [{ kind: 'requester' }] },
      formSchema: userFieldSchema,
      formSnapshot: {},
      requesterSnapshot: null,
    })).toEqual([])
  })

  it('rejects form_field_user sources that do not point at user fields when schema is available', () => {
    expect(() => resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'notes' }],
    }, { notes: 'user-1' })).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_INVALID_SOURCE',
      statusCode: 400,
    }))

    expect(() => resolve({
      assigneeSources: [{ kind: 'form_field_user', fieldId: 'missing' }],
    })).toThrowError(expect.objectContaining({
      code: 'APPROVAL_ASSIGNEE_INVALID_SOURCE',
      statusCode: 400,
    }))
  })

  it('dedupes duplicate resolved assignees and keeps the first source metadata', () => {
    expect(resolve({
      assigneeSources: [
        { kind: 'requester' },
        { kind: 'static_user', userIds: ['requester-1', 'manager-1'] },
      ],
    })).toEqual([
      {
        assignmentType: 'user',
        assigneeId: 'requester-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'requester', sourceIndex: 0 } },
      },
      {
        assignmentType: 'user',
        assigneeId: 'manager-1',
        nodeKey: 'review',
        sourceStep: 2,
        metadata: { resolvedFrom: { kind: 'static_user', sourceIndex: 1 } },
      },
    ])
  })
})
