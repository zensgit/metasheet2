import { describe, expect, it } from 'vitest'
import {
  deletePlmAuditSavedView,
  readPlmAuditSavedViews,
  savePlmAuditSavedView,
} from '../src/views/plmAuditSavedViews'
import type { PlmAuditRouteState } from '../src/views/plmAuditQueryState'

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

const sampleState: PlmAuditRouteState = {
  page: 1,
  q: 'documents',
  actorId: 'dev-user',
  kind: 'documents',
  action: 'archive',
  resourceType: 'plm-team-view-batch',
  from: '',
  to: '',
  windowMinutes: 180,
  teamViewId: '',
  sceneId: '',
  sceneName: '',
  sceneOwnerUserId: '',
}

describe('plmAuditSavedViews', () => {
  it('stores and sorts saved views by updated time', () => {
    const storage = createMemoryStorage()

    savePlmAuditSavedView('Documents Archive', sampleState, storage)
    savePlmAuditSavedView('BOM Restore', {
      ...sampleState,
      q: 'bom',
      kind: 'bom',
      action: 'restore',
      resourceType: 'plm-team-preset-batch',
    }, storage)

    const views = readPlmAuditSavedViews(storage)
    expect(views).toHaveLength(2)
    expect(views[0]?.name).toBe('BOM Restore')
    expect(views[1]?.name).toBe('Documents Archive')
  })

  it('updates an existing saved view when the name matches', () => {
    const storage = createMemoryStorage()

    const first = savePlmAuditSavedView('Documents Archive', sampleState, storage)
    const second = savePlmAuditSavedView('documents archive', {
      ...sampleState,
      actorId: 'plm-user',
      page: 3,
    }, storage)

    expect(first[0]?.id).toBe(second[0]?.id)
    expect(second).toHaveLength(1)
    expect(second[0]?.state.actorId).toBe('plm-user')
    expect(second[0]?.state.page).toBe(3)
  })

  it('deletes saved views by id', () => {
    const storage = createMemoryStorage()
    const saved = savePlmAuditSavedView('Documents Archive', sampleState, storage)

    const next = deletePlmAuditSavedView(saved[0]!.id, storage)
    expect(next).toEqual([])
  })

  it('keeps default-scene audit filters when saving and reading views', () => {
    const storage = createMemoryStorage()

    savePlmAuditSavedView('Workbench Defaults', {
      ...sampleState,
      kind: 'workbench',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
    }, storage)

    expect(readPlmAuditSavedViews(storage)[0]?.state).toMatchObject({
      kind: 'workbench',
      action: 'set-default',
      resourceType: 'plm-team-view-default',
    })
  })

  it('keeps scene context when saving and reading views', () => {
    const storage = createMemoryStorage()

    savePlmAuditSavedView('Scene Context', {
      ...sampleState,
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    }, storage)

    expect(readPlmAuditSavedViews(storage)[0]?.state).toMatchObject({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
    })
  })

})
