import { describe, expect, it } from 'vitest'
import {
  buildDuplicatedWorkflowName,
  buildWorkflowDesignerTemplateItems,
  buildWorkflowDraftListItems,
  extractWorkflowTemplateDefinition,
  mapWorkflowDesignerNodeLibraryRow,
} from '../../src/workflow/workflowDesignerRouteModels'

describe('workflowDesignerRouteModels helpers', () => {
  it('builds workflow list items from draft rows without extra loading', () => {
    const result = buildWorkflowDraftListItems({
      userId: 'editor-1',
      filters: {
        category: 'approval',
        status: 'draft',
        search: '审批',
        sortBy: 'updated_at',
        sortOrder: 'desc',
        limit: 10,
        offset: 0,
      },
      rows: [
        {
          id: 'wf-hidden',
          name: '隐藏流程',
          description: '不共享',
          version: 1,
          status: 'draft',
          created_by: 'owner-1',
          created_at: new Date('2026-03-08T00:00:00.000Z'),
          updated_at: new Date('2026-03-08T00:00:00.000Z'),
          definition: {
            category: 'approval',
            shares: [],
          },
        },
        {
          id: 'wf-visible',
          name: '审批流',
          description: '共享给编辑者',
          version: 2,
          status: 'draft',
          created_by: 'owner-1',
          created_at: new Date('2026-03-08T00:00:00.000Z'),
          updated_at: new Date('2026-03-08T01:00:00.000Z'),
          definition: {
            category: 'approval',
            shares: [
              {
                userId: 'editor-1',
                role: 'editor',
                canEdit: true,
                canDeploy: false,
                canShare: false,
              },
            ],
          },
        },
      ],
    })

    expect(result.total).toBe(1)
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'wf-visible',
        name: '审批流',
        role: 'editor',
        category: 'approval',
      }),
    ])
  })

  it('merges builtin templates with database overrides and filters featured items', () => {
    const result = buildWorkflowDesignerTemplateItems({
      builtinTemplates: [
        {
          id: 'simple-approval',
          name: '内建审批',
          description: 'builtin',
          category: 'approval',
          nodes: [],
          edges: [],
          tags: ['builtin'],
          variables: {
            applicant: { type: 'string', required: true },
            amount: { type: 'number' },
          },
        },
      ],
      databaseTemplates: [
        {
          id: 'simple-approval',
          name: '数据库审批',
          description: 'db override',
          category: 'approval',
          template_definition: JSON.stringify({ source: 'database' }),
          required_variables: JSON.stringify(['requestId']),
          optional_variables: JSON.stringify(['comment']),
          tags: JSON.stringify(['db']),
          is_public: true,
          is_featured: true,
          usage_count: 5,
          created_by: 'user-1',
          created_at: new Date('2026-03-08T00:00:00.000Z'),
          updated_at: new Date('2026-03-08T00:00:00.000Z'),
        },
        {
          id: 'archived-template',
          name: '非精选模板',
          description: 'db only',
          category: 'approval',
          template_definition: JSON.stringify({ source: 'database' }),
          required_variables: JSON.stringify([]),
          optional_variables: JSON.stringify([]),
          tags: JSON.stringify([]),
          is_public: true,
          is_featured: false,
          usage_count: 2,
          created_by: 'user-1',
          created_at: new Date('2026-03-08T00:00:00.000Z'),
          updated_at: new Date('2026-03-08T00:00:00.000Z'),
        },
      ],
      filters: {
        category: 'approval',
        featured: true,
        source: 'all',
        sortBy: 'usage_count',
        sortOrder: 'desc',
        limit: 10,
        offset: 0,
      },
    })

    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      id: 'simple-approval',
      name: '数据库审批',
      source: 'database',
      required_variables: ['requestId'],
      optional_variables: ['comment'],
    })
  })

  it('supports source filtering and pagination for templates', () => {
    const result = buildWorkflowDesignerTemplateItems({
      builtinTemplates: [
        {
          id: 'a-template',
          name: 'A 模板',
          description: 'builtin',
          category: 'approval',
          nodes: [],
          edges: [],
        },
        {
          id: 'b-template',
          name: 'B 模板',
          description: 'builtin',
          category: 'approval',
          nodes: [],
          edges: [],
        },
      ],
      databaseTemplates: [
        {
          id: 'db-template',
          name: 'DB 模板',
          description: 'db',
          category: 'approval',
          template_definition: JSON.stringify({ source: 'database' }),
          required_variables: JSON.stringify([]),
          optional_variables: JSON.stringify([]),
          tags: JSON.stringify([]),
          is_public: true,
          is_featured: true,
          usage_count: 8,
          created_by: 'user-1',
          created_at: new Date('2026-03-08T00:00:00.000Z'),
          updated_at: new Date('2026-03-08T00:00:00.000Z'),
        },
      ],
      filters: {
        source: 'builtin',
        sortBy: 'name',
        sortOrder: 'asc',
        limit: 1,
        offset: 1,
      },
    })

    expect(result.total).toBe(2)
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'b-template',
        source: 'builtin',
      }),
    ])
  })

  it('parses node library JSON fields defensively', () => {
    const nodeType = mapWorkflowDesignerNodeLibraryRow({
      id: 'custom-1',
      node_type: 'customTask',
      display_name: 'Custom Task',
      category: 'tasks',
      description: 'custom',
      properties_schema: '{"timeout":{"type":"number"}}',
      default_properties: '{"timeout":3000}',
      validation_rules: '{invalid',
      visual_config: null,
      is_active: true,
      created_at: new Date('2026-03-08T00:00:00.000Z'),
      updated_at: new Date('2026-03-08T00:00:00.000Z'),
    })

    expect(nodeType.properties_schema).toEqual({
      timeout: { type: 'number' },
    })
    expect(nodeType.default_properties).toEqual({
      timeout: 3000,
    })
    expect(nodeType.validation_rules).toEqual({})
    expect(nodeType.visual_config).toEqual({})
  })

  it('extracts only valid workflow definitions from template payloads', () => {
    expect(extractWorkflowTemplateDefinition({
      id: 'tmpl-valid',
      name: '有效模板',
      description: 'ok',
      category: 'approval',
      template_definition: {
        name: '有效模板',
        nodes: [],
        edges: [],
      },
      required_variables: [],
      optional_variables: [],
      tags: [],
      is_public: true,
      is_featured: true,
      usage_count: 0,
      created_by: 'system',
      created_at: new Date('2026-03-08T00:00:00.000Z'),
      updated_at: new Date('2026-03-08T00:00:00.000Z'),
      source: 'builtin',
    })).toMatchObject({
      name: '有效模板',
      nodes: [],
      edges: [],
    })

    expect(extractWorkflowTemplateDefinition({
      id: 'tmpl-invalid',
      name: '无效模板',
      description: 'bad',
      category: 'approval',
      template_definition: { foo: 'bar' },
      required_variables: [],
      optional_variables: [],
      tags: [],
      is_public: true,
      is_featured: true,
      usage_count: 0,
      created_by: 'system',
      created_at: new Date('2026-03-08T00:00:00.000Z'),
      updated_at: new Date('2026-03-08T00:00:00.000Z'),
      source: 'database',
    })).toBeNull()
  })

  it('increments duplicate workflow names without stacking copy suffixes', () => {
    expect(buildDuplicatedWorkflowName('审批流程')).toBe('审批流程 Copy')
    expect(buildDuplicatedWorkflowName('审批流程 Copy')).toBe('审批流程 Copy 2')
    expect(buildDuplicatedWorkflowName('审批流程 Copy 2')).toBe('审批流程 Copy 3')
    expect(buildDuplicatedWorkflowName('   ')).toBe('Untitled workflow Copy')
  })
})
