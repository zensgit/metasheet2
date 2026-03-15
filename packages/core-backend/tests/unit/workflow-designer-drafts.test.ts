import { describe, expect, it } from 'vitest'
import {
  appendWorkflowDraftExecution,
  buildStoredWorkflowDefinition,
  canDeployWorkflowDraft,
  canEditWorkflowDraft,
  canShareWorkflowDraft,
  getWorkflowDraftRole,
  hasWorkflowDraftAccess,
  parseStoredWorkflowDefinition,
  toWorkflowDraftRecord,
  upsertWorkflowDraftShare,
} from '../../src/workflow/workflowDesignerDrafts'

describe('workflowDesignerDrafts helpers', () => {
  it('builds bpmn-only stored payloads', () => {
    expect(
      buildStoredWorkflowDefinition({
        bpmnXml: '<bpmn />',
        description: 'draft',
        category: 'approval',
        tags: ['demo'],
      }),
    ).toEqual({
      visual: null,
      bpmn: '<bpmn />',
      description: 'draft',
      category: 'approval',
      tags: ['demo'],
      shares: [],
      executions: [],
      format: 'bpmn-only',
    })
  })

  it('parses stored payloads from strings', () => {
    expect(
      parseStoredWorkflowDefinition(
        JSON.stringify({
          visual: { id: 'wf-1', name: '审批流', nodes: [], edges: [] },
          bpmn: '<xml />',
          category: 'approval',
          tags: ['draft'],
          format: 'visual+bpmn',
        }),
      ),
    ).toMatchObject({
      bpmn: '<xml />',
      category: 'approval',
      tags: ['draft'],
      format: 'visual+bpmn',
      visual: {
        id: 'wf-1',
        name: '审批流',
      },
    })
  })

  it('maps workflow definition rows into bpmn draft records', () => {
    const record = toWorkflowDraftRecord({
      id: 'wf-1',
      name: '审批流',
      description: null,
      version: 3,
      status: 'draft',
      created_by: 'user-1',
      created_at: new Date('2026-03-08T00:00:00.000Z'),
      updated_at: new Date('2026-03-08T01:00:00.000Z'),
      definition: {
        bpmn: '<xml />',
        category: 'approval',
        tags: ['demo'],
      },
    })

    expect(record).toMatchObject({
      id: 'wf-1',
      name: '审批流',
      description: '',
      version: 3,
      status: 'draft',
      createdBy: 'user-1',
      category: 'approval',
      tags: ['demo'],
      bpmnXml: '<xml />',
      visual: null,
      shares: [],
      executions: [],
    })
  })

  it('preserves shares and executions from stored metadata', () => {
    const record = toWorkflowDraftRecord({
      id: 'wf-2',
      name: '共享流',
      description: 'x',
      version: 1,
      status: 'published',
      created_by: 'owner-1',
      created_at: new Date('2026-03-08T00:00:00.000Z'),
      updated_at: new Date('2026-03-08T01:00:00.000Z'),
      definition: {
        bpmn: '<xml />',
        shares: [
          {
            userId: 'editor-1',
            role: 'editor',
            canEdit: true,
            canDeploy: true,
            canShare: false,
          },
        ],
        executions: [
          {
            id: 'exec-1',
            executionType: 'test',
            triggeredBy: 'owner-1',
            triggerContext: { amount: 1 },
            status: 'completed',
            startTime: '2026-03-08T00:00:00.000Z',
          },
        ],
      },
    })

    expect(record.shares).toHaveLength(1)
    expect(record.executions).toHaveLength(1)
    expect(getWorkflowDraftRole(record, 'owner-1')).toBe('owner')
    expect(getWorkflowDraftRole(record, 'editor-1')).toBe('editor')
    expect(hasWorkflowDraftAccess(record, 'editor-1')).toBe(true)
    expect(canEditWorkflowDraft(record, 'editor-1')).toBe(true)
    expect(canDeployWorkflowDraft(record, 'editor-1')).toBe(true)
    expect(canShareWorkflowDraft(record, 'editor-1')).toBe(false)
  })

  it('upserts shares and prepends executions', () => {
    const shares = upsertWorkflowDraftShare([], {
      userId: 'viewer-1',
      role: 'viewer',
      canEdit: false,
      canDeploy: false,
      canShare: false,
      sharedBy: 'owner-1',
      sharedAt: '2026-03-08T00:00:00.000Z',
    })

    const updatedShares = upsertWorkflowDraftShare(shares, {
      userId: 'viewer-1',
      role: 'editor',
      canEdit: true,
      canDeploy: false,
      canShare: true,
      sharedBy: 'owner-1',
      sharedAt: '2026-03-08T01:00:00.000Z',
    })

    expect(updatedShares).toEqual([
      expect.objectContaining({
        userId: 'viewer-1',
        role: 'editor',
        canEdit: true,
        canShare: true,
      }),
    ])

    const executions = appendWorkflowDraftExecution([], {
      id: 'exec-2',
      executionType: 'test',
      triggeredBy: 'owner-1',
      triggerContext: {},
      status: 'completed',
      startTime: '2026-03-08T01:00:00.000Z',
      endTime: null,
      resultData: null,
      errorData: null,
    })

    expect(executions[0]?.id).toBe('exec-2')
  })
})
