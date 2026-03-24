import { describe, expect, it } from 'vitest'
import {
  buildRecommendedWorkbenchScenes,
  buildWorkbenchSceneCatalogOwnerOptions,
  buildWorkbenchSceneSummaryChips,
  buildWorkbenchSceneSummaryHint,
} from '../src/views/plm/plmWorkbenchSceneCatalog'
import type { PlmWorkbenchTeamView } from '../src/views/plm/plmPanelModels'

function createView(overrides: Partial<PlmWorkbenchTeamView<'workbench'>>): PlmWorkbenchTeamView<'workbench'> {
  return {
    id: 'view-1',
    kind: 'workbench',
    scope: 'team',
    name: '默认场景',
    ownerUserId: 'owner-a',
    canManage: true,
    permissions: {
      canManage: true,
      canApply: true,
      canDuplicate: true,
      canShare: true,
      canDelete: true,
      canArchive: true,
      canRestore: false,
      canRename: true,
      canTransfer: true,
      canSetDefault: true,
      canClearDefault: false,
    },
    isDefault: false,
    state: {
      query: {},
    },
    createdAt: '2026-03-18T08:00:00.000Z',
    updatedAt: '2026-03-18T08:00:00.000Z',
    ...overrides,
  }
}

describe('plmWorkbenchSceneCatalog', () => {
  it('builds owner options in zh-CN order', () => {
    const options = buildWorkbenchSceneCatalogOwnerOptions([
      createView({ id: 'a', ownerUserId: 'owner-b' }),
      createView({ id: 'b', ownerUserId: 'owner-a' }),
      createView({ id: 'c', ownerUserId: 'owner-b' }),
      createView({ id: 'd', ownerUserId: '' }),
    ])

    expect(options).toEqual(['owner-a', 'owner-b'])
  })

  it('sorts scenes by default, recent default, then updated time', () => {
    const scenes = buildRecommendedWorkbenchScenes([
      createView({
        id: 'default-now',
        name: '当前默认',
        isDefault: true,
        lastDefaultSetAt: '2026-03-19T10:00:00.000Z',
        updatedAt: '2026-03-19T10:00:00.000Z',
      }),
      createView({
        id: 'recent-default',
        name: '近期默认',
        lastDefaultSetAt: '2026-03-19T09:00:00.000Z',
        updatedAt: '2026-03-18T08:00:00.000Z',
      }),
      createView({
        id: 'recent-update',
        name: '近期更新',
        updatedAt: '2026-03-19T08:30:00.000Z',
      }),
      createView({
        id: 'older-update',
        name: '较早更新',
        updatedAt: '2026-03-18T07:00:00.000Z',
      }),
    ])

    expect(scenes.map((scene) => scene.id)).toEqual([
      'default-now',
      'recent-default',
      'recent-update',
      'older-update',
    ])
    expect(scenes[0].recommendationReason).toBe('default')
    expect(scenes[1].recommendationReason).toBe('recent-default')
    expect(scenes[2].recommendationReason).toBe('recent-update')
    expect(scenes[0].recommendationSourceLabel).toBe('当前团队默认场景')
    expect(scenes[1].recommendationSourceLabel).toBe('近期被设为团队默认场景')
    expect(scenes[2].recommendationSourceLabel).toBe('近期更新的团队场景')
    expect(scenes[0].primaryActionKind).toBe('apply-scene')
    expect(scenes[0].primaryActionLabel).toBe('进入默认场景')
    expect(scenes[0].primaryActionDisabled).toBe(false)
    expect(scenes[0].secondaryActionKind).toBe('copy-link')
    expect(scenes[0].secondaryActionLabel).toBe('复制默认链接')
    expect(scenes[0].secondaryActionDisabled).toBe(false)
    expect(scenes[0].actionNote).toContain('稳定入口')
    expect(scenes[1].primaryActionLabel).toBe('查看近期默认')
    expect(scenes[1].secondaryActionKind).toBe('open-audit')
    expect(scenes[2].secondaryActionLabel).toBe('查看更新记录')
    expect(scenes[2].actionNote).toContain('更新记录')
  })

  it('applies owner filter before ranking and truncates to 6 scenes', () => {
    const views = Array.from({ length: 8 }, (_, index) =>
      createView({
        id: `view-${index + 1}`,
        name: `场景 ${index + 1}`,
        ownerUserId: index < 7 ? 'owner-a' : 'owner-b',
        updatedAt: `2026-03-1${index}T08:00:00.000Z`,
      }),
    )

    const scenes = buildRecommendedWorkbenchScenes(views, { ownerUserId: 'owner-a' })
    expect(scenes).toHaveLength(6)
    expect(scenes.every((scene) => scene.ownerUserId === 'owner-a')).toBe(true)
  })

  it('filters by recommendation reason after owner filtering', () => {
    const scenes = buildRecommendedWorkbenchScenes([
      createView({
        id: 'default-scene',
        isDefault: true,
        lastDefaultSetAt: '2026-03-19T10:00:00.000Z',
      }),
      createView({
        id: 'recent-default-scene',
        isDefault: false,
        lastDefaultSetAt: '2026-03-19T09:00:00.000Z',
      }),
      createView({
        id: 'recent-update-scene',
        isDefault: false,
        lastDefaultSetAt: undefined,
        updatedAt: '2026-03-19T08:00:00.000Z',
      }),
    ], {
      recommendationFilter: 'recent-default',
    })

    expect(scenes).toHaveLength(1)
    expect(scenes[0]).toMatchObject({
      id: 'recent-default-scene',
      recommendationReason: 'recent-default',
      recommendationSourceLabel: '近期被设为团队默认场景',
      recommendationSourceTimestamp: '2026-03-19T09:00:00.000Z',
      primaryActionKind: 'apply-scene',
      primaryActionLabel: '查看近期默认',
      secondaryActionKind: 'open-audit',
      secondaryActionLabel: '查看近期默认变更',
      actionNote: '该场景近期被提升为默认入口，建议先查看默认变更再继续扩散。',
    })
  })

  it('builds summary chips with counts and active state after owner filtering', () => {
    const chips = buildWorkbenchSceneSummaryChips([
      createView({
        id: 'default-scene',
        isDefault: true,
        ownerUserId: 'owner-a',
        lastDefaultSetAt: '2026-03-19T10:00:00.000Z',
      }),
      createView({
        id: 'recent-default-scene',
        ownerUserId: 'owner-a',
        lastDefaultSetAt: '2026-03-19T09:00:00.000Z',
      }),
      createView({
        id: 'recent-update-scene',
        ownerUserId: 'owner-a',
        updatedAt: '2026-03-19T08:00:00.000Z',
      }),
      createView({
        id: 'other-owner',
        ownerUserId: 'owner-b',
        updatedAt: '2026-03-19T07:00:00.000Z',
      }),
    ], {
      ownerUserId: 'owner-a',
      recommendationFilter: 'recent-default',
    })

    expect(chips).toEqual([
      { value: '', label: '全部推荐', count: 3, active: false },
      { value: 'default', label: '当前默认', count: 1, active: false },
      { value: 'recent-default', label: '近期默认', count: 1, active: true },
      { value: 'recent-update', label: '近期更新', count: 1, active: false },
    ])
  })

  it('builds active summary hint from chips', () => {
    const hint = buildWorkbenchSceneSummaryHint([
      { value: '', label: '全部推荐', count: 6, active: false },
      { value: 'default', label: '当前默认', count: 2, active: true },
      { value: 'recent-default', label: '近期默认', count: 1, active: false },
      { value: 'recent-update', label: '近期更新', count: 3, active: false },
    ])

    expect(hint).toEqual({
      value: 'default',
      label: '当前默认',
      count: 2,
      description: '只看当前团队默认场景，适合快速进入标准作业入口。',
    })
  })

  it('disables default-scene copy-link when the underlying team view cannot be shared', () => {
    const [scene] = buildRecommendedWorkbenchScenes([
      createView({
        id: 'default-scene',
        isDefault: true,
        permissions: {
          ...createView({}).permissions,
          canShare: false,
        },
      }),
    ])

    expect(scene).toMatchObject({
      secondaryActionKind: 'copy-link',
      secondaryActionLabel: '复制默认链接',
      secondaryActionDisabled: true,
    })
  })

  it('disables recommended apply actions when the underlying team view cannot be applied', () => {
    const [scene] = buildRecommendedWorkbenchScenes([
      createView({
        id: 'default-scene',
        isDefault: true,
        permissions: {
          ...createView({}).permissions,
          canApply: false,
        },
      }),
    ])

    expect(scene).toMatchObject({
      primaryActionKind: 'apply-scene',
      primaryActionLabel: '进入默认场景',
      primaryActionDisabled: true,
    })
  })
})
