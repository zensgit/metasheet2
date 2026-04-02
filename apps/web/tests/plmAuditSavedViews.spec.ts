import { describe, expect, it } from 'vitest'
import {
  canSavePlmAuditSavedViewName,
  deletePlmAuditSavedView,
  readPlmAuditSavedViews,
  restorePlmAuditSavedViewState,
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
  sceneRecommendationReason: '',
  sceneRecommendationSourceLabel: '',
  returnToPlmPath: '',
}

describe('plmAuditSavedViews', () => {
  it('only allows saving local saved views with a non-empty trimmed name', () => {
    expect(canSavePlmAuditSavedViewName('')).toBe(false)
    expect(canSavePlmAuditSavedViewName('   ')).toBe(false)
    expect(canSavePlmAuditSavedViewName('  Team Snapshot  ')).toBe(true)
  })

  it('does not write local saved views when the name is empty after trimming', () => {
    const storage = createMemoryStorage()

    savePlmAuditSavedView('Documents Archive', sampleState, storage)
    const next = savePlmAuditSavedView('   ', {
      ...sampleState,
      q: 'ignored',
    }, storage)

    expect(next).toHaveLength(1)
    expect(next[0]?.name).toBe('Documents Archive')
    expect(next[0]?.state.q).toBe('documents')
  })

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

  it('keeps team preset default audit filters when saving and reading views', () => {
    const storage = createMemoryStorage()

    savePlmAuditSavedView('BOM Preset Defaults', {
      ...sampleState,
      kind: 'bom',
      action: 'clear-default',
      resourceType: 'plm-team-preset-default',
    }, storage)

    expect(readPlmAuditSavedViews(storage)[0]?.state).toMatchObject({
      kind: 'bom',
      action: 'clear-default',
      resourceType: 'plm-team-preset-default',
    })
  })

  it('keeps scene context when saving and reading views', () => {
    const storage = createMemoryStorage()

    savePlmAuditSavedView('Scene Context', {
      ...sampleState,
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    }, storage)

    expect(readPlmAuditSavedViews(storage)[0]?.state).toMatchObject({
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
      sceneOwnerUserId: 'owner-a',
      sceneRecommendationReason: 'recent-update',
      sceneRecommendationSourceLabel: '近期更新的团队场景',
      returnToPlmPath: '/plm?sceneFocus=scene-1',
    })
  })

  it('stores and reads local saved views as snapshots without team-view links', () => {
    const storage = createMemoryStorage()

    savePlmAuditSavedView('Team Snapshot', {
      ...sampleState,
      teamViewId: 'audit-view-1',
      q: 'team-snapshot',
      kind: 'workbench',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
    }, storage)

    expect(readPlmAuditSavedViews(storage)[0]?.state).toMatchObject({
      teamViewId: '',
      q: 'team-snapshot',
      kind: 'workbench',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
    })
  })

  it('backfills new scene audit fields when reading legacy saved views', () => {
    const storage = createMemoryStorage()
    storage.setItem('metasheet_plm_audit_saved_views', JSON.stringify([
      {
        id: 'saved-legacy',
        name: 'Legacy Scene Context',
        updatedAt: '2026-03-21T00:00:00.000Z',
        state: {
          page: 1,
          q: 'scene-legacy',
          actorId: '',
          kind: 'workbench',
          action: '',
          resourceType: '',
          from: '',
          to: '',
          windowMinutes: 180,
          sceneId: 'scene-legacy',
          sceneName: '旧版场景',
          sceneOwnerUserId: 'owner-legacy',
        },
      },
    ]))

    expect(readPlmAuditSavedViews(storage)[0]?.state).toMatchObject({
      sceneId: 'scene-legacy',
      sceneName: '旧版场景',
      sceneOwnerUserId: 'owner-legacy',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '',
    })
  })

  it('restores saved views as local snapshots instead of live team-view links', () => {
    expect(restorePlmAuditSavedViewState({
      ...sampleState,
      teamViewId: 'audit-view-1',
      q: 'team-view-snapshot',
      kind: 'workbench',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
    })).toEqual({
      ...sampleState,
      teamViewId: '',
      q: 'team-view-snapshot',
      kind: 'workbench',
      action: 'archive',
      resourceType: 'plm-team-view-batch',
      sceneId: 'scene-1',
      sceneName: '采购团队场景',
    })
  })

})
