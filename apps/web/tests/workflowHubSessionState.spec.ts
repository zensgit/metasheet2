import { describe, expect, it } from 'vitest'
import {
  clearWorkflowHubSessionState,
  readWorkflowHubSessionState,
  shouldRestoreWorkflowHubSessionState,
  writeWorkflowHubSessionState,
} from '../src/views/workflowHubSessionState'
import { DEFAULT_WORKFLOW_HUB_ROUTE_STATE, type WorkflowHubRouteState } from '../src/views/workflowHubQueryState'

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
  ...DEFAULT_WORKFLOW_HUB_ROUTE_STATE,
  templateSearch: 'parallel',
}

describe('workflowHubSessionState', () => {
  it('stores and reads the latest session state', () => {
    const storage = createMemoryStorage()

    writeWorkflowHubSessionState(sampleState, storage)
    const saved = readWorkflowHubSessionState(storage)

    expect(saved?.state).toEqual(sampleState)
    expect(saved?.updatedAt).toEqual(expect.any(String))
  })

  it('restores only when the current route is still default', () => {
    const storage = createMemoryStorage()
    const saved = writeWorkflowHubSessionState(sampleState, storage)

    expect(shouldRestoreWorkflowHubSessionState(DEFAULT_WORKFLOW_HUB_ROUTE_STATE, saved)).toBe(true)
    expect(shouldRestoreWorkflowHubSessionState(
      { ...DEFAULT_WORKFLOW_HUB_ROUTE_STATE, templateSearch: 'simple' },
      saved,
    )).toBe(false)
  })

  it('clears the stored session snapshot', () => {
    const storage = createMemoryStorage()

    writeWorkflowHubSessionState(sampleState, storage)
    clearWorkflowHubSessionState(storage)

    expect(readWorkflowHubSessionState(storage)).toBeNull()
  })
})
