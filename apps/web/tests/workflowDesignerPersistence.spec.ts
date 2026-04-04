import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  archiveWorkflowDraft,
  createWorkflowDeploymentPayload,
  deleteWorkflowHubTeamView,
  DEFAULT_WORKFLOW_XML,
  duplicateWorkflowDraft,
  instantiateWorkflowTemplate,
  listWorkflowDrafts,
  listWorkflowHubTeamViews,
  listWorkflowTemplates,
  loadWorkflowTemplate,
  normalizeLoadedWorkflow,
  normalizeSavedWorkflow,
  restoreWorkflowDraft,
  saveWorkflowDraft,
  saveWorkflowHubTeamView,
} from '../src/views/workflowDesignerPersistence'
import type { WorkflowHubRouteState } from '../src/views/workflowHubQueryState'

const sampleTeamViewState: WorkflowHubRouteState = {
  workflowSearch: '',
  workflowStatus: '',
  workflowSortBy: 'updated_at',
  workflowOffset: 0,
  templateSearch: 'parallel',
  templateSource: 'all',
  templateSortBy: 'usage_count',
  templateOffset: 0,
}

describe('workflowDesignerPersistence', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the default BPMN template stable', () => {
    expect(DEFAULT_WORKFLOW_XML).toContain('<bpmn:startEvent')
    expect(DEFAULT_WORKFLOW_XML).toContain('targetNamespace="http://bpmn.io/schema/bpmn"')
  })

  it('normalizes legacy raw workflow payloads', () => {
    const result = normalizeLoadedWorkflow(
      {
        id: 'wf-1',
        name: '审批流',
        description: '测试描述',
        version: 2,
        bpmnXml: '<xml />',
      },
      'wf-1',
    )

    expect(result).toMatchObject({
      id: 'wf-1',
      name: '审批流',
      description: '测试描述',
      version: '2',
      bpmnXml: '<xml />',
    })
  })

  it('normalizes enveloped workflow payloads', () => {
    const result = normalizeLoadedWorkflow(
      {
        success: true,
        data: {
          id: 'wf-2',
          name: '封装流',
          bpmn: '<bpmn />',
        },
      },
      'wf-2',
    )

    expect(result).toMatchObject({
      id: 'wf-2',
      name: '封装流',
      version: '1.0.0',
      bpmnXml: '<bpmn />',
    })
  })

  it('throws a clear error when deployment returns visual-only workflow data', () => {
    expect(() =>
      normalizeLoadedWorkflow(
        {
          success: true,
          data: {
            id: 'wf-3',
            name: '图形流',
            nodes: [],
            edges: [],
          },
        },
        'wf-3',
      ),
    ).toThrow('未包含 BPMN XML')
  })

  it('extracts workflow ids from save responses', () => {
    expect(
      normalizeSavedWorkflow({
        success: true,
        data: {
          workflowId: 'wf-save-1',
          message: 'saved',
        },
      }),
    ).toMatchObject({
      workflowId: 'wf-save-1',
      message: 'saved',
    })
  })

  it('saves workflow drafts with canonical BPMN payloads only', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          workflowId: 'wf-save-2',
          message: 'saved',
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveWorkflowDraft({
      workflowId: null,
      name: '审批流',
      description: ' 说明 ',
      version: '2.0.0',
      bpmnXml: '<bpmn />',
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workflow-designer/workflows',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '审批流',
          description: ' 说明 ',
          version: '2.0.0',
          bpmnXml: '<bpmn />',
        }),
      }),
    )
    expect(result.workflowId).toBe('wf-save-2')
  })

  it('builds deployment payloads with fallback names', () => {
    expect(
      createWorkflowDeploymentPayload({
        name: '   ',
        description: '  测试部署  ',
        key: '  approval-key ',
        category: '',
        bpmnXml: '<xml />',
      }),
    ).toEqual({
      name: '未命名工作流',
      description: '测试部署',
      category: '',
      key: 'approval-key',
      bpmnXml: '<xml />',
    })
  })

  it('lists workflow templates with pagination metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'tmpl-1',
            name: '审批模板',
            description: '模板说明',
            category: 'approval',
            required_variables: ['requestId'],
            optional_variables: ['comment'],
            tags: ['builtin'],
            is_featured: true,
            source: 'builtin',
            usage_count: 3,
            updated_at: '2026-03-08T12:00:00.000Z',
          },
        ],
        metadata: {
          total: 9,
          limit: 5,
          offset: 0,
          returned: 1,
        },
      }),
    }))

    const result = await listWorkflowTemplates({
      search: '审批',
      source: 'builtin',
      limit: 5,
      offset: 0,
    })

    expect(result.pagination).toEqual({
      total: 9,
      limit: 5,
      offset: 0,
      returned: 1,
    })
    expect(result.items[0]).toMatchObject({
      id: 'tmpl-1',
      name: '审批模板',
      requiredVariables: ['requestId'],
      optionalVariables: ['comment'],
      source: 'builtin',
      usageCount: 3,
    })
  })

  it('lists workflow drafts with normalized role and pagination', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'wf-1',
            name: '流程 A',
            description: '共享草稿',
            category: 'approval',
            status: 'draft',
            role: 'editor',
            created_at: '2026-03-08T10:00:00.000Z',
            updated_at: '2026-03-08T12:00:00.000Z',
          },
        ],
        metadata: {
          total: 4,
          limit: 10,
          offset: 0,
          returned: 1,
        },
      }),
    }))

    const result = await listWorkflowDrafts({
      status: 'draft',
      sortBy: 'updated_at',
      sortOrder: 'desc',
      limit: 10,
    })

    expect(result.pagination).toEqual({
      total: 4,
      limit: 10,
      offset: 0,
      returned: 1,
    })
    expect(result.items[0]).toMatchObject({
      id: 'wf-1',
      name: '流程 A',
      status: 'draft',
      role: 'editor',
      category: 'approval',
    })
  })

  it('lists workflow hub team views with normalized state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'team-view-1',
            name: 'Parallel Templates',
            ownerUserId: 'dev-user',
            canManage: true,
            state: {
              templateSearch: 'parallel',
              templateSource: 'database',
            },
            createdAt: '2026-03-09T05:00:00.000Z',
            updatedAt: '2026-03-09T05:10:00.000Z',
          },
        ],
      }),
    }))

    const result = await listWorkflowHubTeamViews()

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: 'team-view-1',
      name: 'Parallel Templates',
      ownerUserId: 'dev-user',
      canManage: true,
      state: expect.objectContaining({
        templateSearch: 'parallel',
        templateSource: 'database',
        workflowSortBy: 'updated_at',
      }),
    })
  })

  it('saves workflow hub team views through the dedicated route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'team-view-2',
          name: 'Parallel Team View',
          ownerUserId: 'dev-user',
          canManage: true,
          state: sampleTeamViewState,
          createdAt: '2026-03-09T05:15:00.000Z',
          updatedAt: '2026-03-09T05:15:00.000Z',
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await saveWorkflowHubTeamView('Parallel Team View', sampleTeamViewState)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workflow-designer/hub-views/team',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'Parallel Team View',
          state: sampleTeamViewState,
        }),
      }),
    )
    expect(result).toMatchObject({
      id: 'team-view-2',
      name: 'Parallel Team View',
      canManage: true,
    })
  })

  it('deletes workflow hub team views through the dedicated route', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'team-view-2',
          message: 'deleted',
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await deleteWorkflowHubTeamView('team-view-2')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workflow-designer/hub-views/team/team-view-2',
      expect.objectContaining({
        method: 'DELETE',
      }),
    )
  })

  it('loads template detail payloads', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'simple-approval',
          name: '审批模板',
          description: '模板详情',
          category: 'approval',
          required_variables: ['requestId'],
          optional_variables: ['comment'],
          tags: ['builtin'],
          is_featured: true,
          source: 'builtin',
          usage_count: 0,
          template_definition: {
            name: '审批模板',
            nodes: [],
            edges: [],
          },
        },
      }),
    }))

    const result = await loadWorkflowTemplate('simple-approval')

    expect(result).toMatchObject({
      id: 'simple-approval',
      name: '审批模板',
      requiredVariables: ['requestId'],
      definition: {
        name: '审批模板',
        nodes: [],
        edges: [],
      },
    })
  })

  it('instantiates workflow templates through the template route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          workflowId: 'wf-template-1',
          message: 'created',
        },
      }),
    }))

    const result = await instantiateWorkflowTemplate({
      templateId: 'simple-approval',
      name: '基于模板的新流程',
    })

    expect(result).toMatchObject({
      workflowId: 'wf-template-1',
      message: 'created',
    })
  })

  it('duplicates workflow drafts through the draft action route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          workflowId: 'wf-copy-1',
          sourceWorkflowId: 'wf-origin',
          message: 'duplicated',
        },
      }),
    }))

    const result = await duplicateWorkflowDraft('wf-origin', '审批流程 Copy')

    expect(result).toMatchObject({
      workflowId: 'wf-copy-1',
      sourceWorkflowId: 'wf-origin',
      message: 'duplicated',
    })
  })

  it('archives workflow drafts through the draft action route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          workflowId: 'wf-archive-1',
          status: 'archived',
          message: 'archived',
        },
      }),
    }))

    const result = await archiveWorkflowDraft('wf-archive-1')

    expect(result).toMatchObject({
      workflowId: 'wf-archive-1',
      status: 'archived',
      message: 'archived',
    })
  })

  it('restores archived workflow drafts through the draft action route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          workflowId: 'wf-restore-1',
          status: 'draft',
          message: 'restored',
        },
      }),
    }))

    const result = await restoreWorkflowDraft('wf-restore-1')

    expect(result).toMatchObject({
      workflowId: 'wf-restore-1',
      status: 'draft',
      message: 'restored',
    })
  })
})
