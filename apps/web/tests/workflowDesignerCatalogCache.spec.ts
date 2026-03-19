import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateWorkflowDraftCatalogCache,
  invalidateWorkflowTemplateCatalogCache,
  invalidateWorkflowTemplateDetailCache,
  listWorkflowDraftsCached,
  listWorkflowTemplatesCached,
  loadWorkflowTemplateCached,
  resetWorkflowDesignerCatalogCache,
} from '../src/views/workflowDesignerCatalogCache'

describe('workflowDesignerCatalogCache', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetWorkflowDesignerCatalogCache()
  })

  it('reuses cached template catalog results for identical queries', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: 'tmpl-1',
            name: '审批模板',
            description: '模板说明',
            category: 'approval',
            required_variables: [],
            optional_variables: [],
            tags: [],
            is_featured: true,
            source: 'builtin',
            usage_count: 1,
          },
        ],
        metadata: { total: 1, limit: 6, offset: 0, returned: 1 },
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    await listWorkflowTemplatesCached({ source: 'all', limit: 6, offset: 0 })
    await listWorkflowTemplatesCached({ source: 'all', limit: 6, offset: 0 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('can invalidate workflow draft caches after mutations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
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
          },
        ],
        metadata: { total: 1, limit: 8, offset: 0, returned: 1 },
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    await listWorkflowDraftsCached({ status: 'draft', limit: 8, offset: 0 })
    await listWorkflowDraftsCached({ status: 'draft', limit: 8, offset: 0 })
    invalidateWorkflowDraftCatalogCache()
    await listWorkflowDraftsCached({ status: 'draft', limit: 8, offset: 0 })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('reuses cached template detail until explicitly invalidated', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          id: 'tmpl-1',
          name: '审批模板',
          description: '模板说明',
          category: 'approval',
          required_variables: ['requestId'],
          optional_variables: ['comment'],
          tags: ['builtin'],
          source: 'builtin',
          usage_count: 1,
          template_definition: { xml: '<bpmn />' },
        },
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    await loadWorkflowTemplateCached('tmpl-1')
    await loadWorkflowTemplateCached('tmpl-1')
    invalidateWorkflowTemplateDetailCache('tmpl-1')
    await loadWorkflowTemplateCached('tmpl-1')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('supports forced reloads for template and workflow catalogs', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [],
        metadata: { total: 0, limit: 6, offset: 0, returned: 0 },
      }),
    })

    vi.stubGlobal('fetch', fetchMock)

    await listWorkflowTemplatesCached({ source: 'all', limit: 6, offset: 0 })
    await listWorkflowTemplatesCached({ source: 'all', limit: 6, offset: 0 }, { force: true })
    invalidateWorkflowTemplateCatalogCache()
    await listWorkflowDraftsCached({ limit: 8, offset: 0 })
    await listWorkflowDraftsCached({ limit: 8, offset: 0 }, { force: true })

    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
