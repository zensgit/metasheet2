import { describe, expect, it } from 'vitest'
import {
  deleteWorkflowHubSavedView,
  readWorkflowHubSavedViews,
  saveWorkflowHubSavedView,
} from '../src/views/workflowHubSavedViews'
import type { WorkflowHubRouteState } from '../src/views/workflowHubQueryState'

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

const sampleState: WorkflowHubRouteState = {
  workflowSearch: '',
  workflowStatus: '',
  workflowSortBy: 'updated_at',
  workflowOffset: 0,
  templateSearch: 'parallel',
  templateSource: 'all',
  templateSortBy: 'usage_count',
  templateOffset: 0,
}

describe('workflowHubSavedViews', () => {
  it('stores and sorts saved views by updated time', () => {
    const storage = createMemoryStorage()

    saveWorkflowHubSavedView('Parallel Templates', sampleState, storage)
    saveWorkflowHubSavedView('Drafts Only', {
      ...sampleState,
      workflowStatus: 'draft',
    }, storage)

    const views = readWorkflowHubSavedViews(storage)
    expect(views).toHaveLength(2)
    expect(views[0]?.name).toBe('Drafts Only')
    expect(views[1]?.name).toBe('Parallel Templates')
  })

  it('updates an existing saved view when the name matches', () => {
    const storage = createMemoryStorage()

    const first = saveWorkflowHubSavedView('Parallel Templates', sampleState, storage)
    const second = saveWorkflowHubSavedView('parallel templates', {
      ...sampleState,
      templateSource: 'builtin',
    }, storage)

    expect(first[0]?.id).toBe(second[0]?.id)
    expect(second).toHaveLength(1)
    expect(second[0]?.state.templateSource).toBe('builtin')
  })

  it('deletes saved views by id', () => {
    const storage = createMemoryStorage()
    const saved = saveWorkflowHubSavedView('Parallel Templates', sampleState, storage)

    const next = deleteWorkflowHubSavedView(saved[0]!.id, storage)
    expect(next).toEqual([])
  })
})
