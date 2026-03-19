import { describe, expect, it } from 'vitest'
import {
  buildRecentWorkflowTemplateItem,
  readRecentWorkflowTemplates,
  rememberRecentWorkflowTemplate,
} from '../src/views/workflowDesignerRecentTemplates'

function createMemoryStorage() {
  const store = new Map<string, string>()
  return {
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    get length() {
      return store.size
    },
  } as Storage
}

describe('workflowDesignerRecentTemplates', () => {
  it('deduplicates recent templates and keeps most recent first', () => {
    const storage = createMemoryStorage()

    rememberRecentWorkflowTemplate({
      id: 'tmpl-1',
      name: '审批模板',
      description: '审批',
      category: 'approval',
      source: 'builtin',
    }, storage)

    rememberRecentWorkflowTemplate({
      id: 'tmpl-2',
      name: '评审模板',
      description: '评审',
      category: 'review',
      source: 'database',
    }, storage)

    const afterDuplicate = rememberRecentWorkflowTemplate({
      id: 'tmpl-1',
      name: '审批模板',
      description: '审批',
      category: 'approval',
      source: 'builtin',
    }, storage)

    expect(afterDuplicate).toHaveLength(2)
    expect(afterDuplicate[0]?.id).toBe('tmpl-1')
    expect(afterDuplicate[1]?.id).toBe('tmpl-2')
  })

  it('reads invalid localStorage payloads defensively', () => {
    const storage = createMemoryStorage()
    storage.setItem('metasheet_workflow_recent_templates', '{bad')
    expect(readRecentWorkflowTemplates(storage)).toEqual([])
  })

  it('builds recent template items from typed template payloads', () => {
    expect(buildRecentWorkflowTemplateItem({
      id: 'tmpl-1',
      name: '审批模板',
      description: '模板说明',
      category: 'approval',
      requiredVariables: [],
      optionalVariables: [],
      tags: [],
      featured: true,
      source: 'builtin',
      usageCount: 3,
      raw: {},
    })).toEqual({
      id: 'tmpl-1',
      name: '审批模板',
      description: '模板说明',
      category: 'approval',
      source: 'builtin',
    })
  })
})
