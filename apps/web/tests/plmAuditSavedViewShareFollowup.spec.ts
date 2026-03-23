import { describe, expect, it } from 'vitest'
import {
  buildPlmAuditSavedViewShareFollowupNotice,
  resolvePlmAuditSavedViewLocalSaveFollowupSource,
  resolvePlmAuditSavedViewLocalSaveState,
} from '../src/views/plmAuditSavedViewShareFollowup'

function tr(en: string, zh: string) {
  return `${en}|${zh}`
}

describe('plmAuditSavedViewShareFollowup', () => {
  it('resolves the generic local-save followup source from shared-entry or scene-context ownership', () => {
    expect(resolvePlmAuditSavedViewLocalSaveFollowupSource({
      sharedEntryTeamViewId: 'audit-view-1',
      routeTeamViewId: 'audit-view-1',
      sceneContextActive: true,
    })).toBe('shared-entry')

    expect(resolvePlmAuditSavedViewLocalSaveFollowupSource({
      sharedEntryTeamViewId: '',
      routeTeamViewId: 'audit-view-2',
      sceneContextActive: true,
    })).toBe('scene-context')

    expect(resolvePlmAuditSavedViewLocalSaveFollowupSource({
      sharedEntryTeamViewId: 'audit-view-1',
      routeTeamViewId: 'audit-view-1',
      sceneContextActive: false,
    })).toBe('shared-entry')

    expect(resolvePlmAuditSavedViewLocalSaveFollowupSource({
      sharedEntryTeamViewId: 'audit-view-1',
      routeTeamViewId: 'audit-view-2',
      sceneContextActive: false,
    })).toBeNull()
  })

  it('uses the canonical route state for shared-entry local saves', () => {
    expect(resolvePlmAuditSavedViewLocalSaveState({
      source: 'shared-entry',
      currentState: {
        page: 1,
        q: 'draft-filter',
        actorId: '',
        kind: '',
        action: '',
        resourceType: '',
        from: '',
        to: '',
        windowMinutes: 180,
        teamViewId: 'audit-view-2',
        sceneId: '',
        sceneName: '',
        sceneOwnerUserId: '',
        sceneRecommendationReason: '',
        sceneRecommendationSourceLabel: '',
        returnToPlmPath: '/plm/workbench',
      },
      canonicalRouteState: {
        page: 1,
        q: 'shared-entry-filter',
        actorId: '',
        kind: '',
        action: '',
        resourceType: '',
        from: '',
        to: '',
        windowMinutes: 180,
        teamViewId: 'audit-view-1',
        sceneId: '',
        sceneName: '',
        sceneOwnerUserId: '',
        sceneRecommendationReason: '',
        sceneRecommendationSourceLabel: '',
        returnToPlmPath: '/plm/workbench',
      },
    })).toEqual({
      page: 1,
      q: 'shared-entry-filter',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
      teamViewId: 'audit-view-1',
      sceneId: '',
      sceneName: '',
      sceneOwnerUserId: '',
      sceneRecommendationReason: '',
      sceneRecommendationSourceLabel: '',
      returnToPlmPath: '/plm/workbench',
    })

    expect(resolvePlmAuditSavedViewLocalSaveState({
      source: 'scene-context',
      currentState: {
        page: 1,
        q: 'scene-77',
        actorId: '',
        kind: '',
        action: '',
        resourceType: '',
        from: '',
        to: '',
        windowMinutes: 180,
        teamViewId: 'audit-view-2',
        sceneId: 'scene-77',
        sceneName: '采购延迟',
        sceneOwnerUserId: 'owner-7',
        sceneRecommendationReason: 'Late orders',
        sceneRecommendationSourceLabel: 'Planner',
        returnToPlmPath: '/plm/workbench',
      },
      canonicalRouteState: {
        page: 1,
        q: 'shared-entry-filter',
        actorId: '',
        kind: '',
        action: '',
        resourceType: '',
        from: '',
        to: '',
        windowMinutes: 180,
        teamViewId: 'audit-view-1',
        sceneId: '',
        sceneName: '',
        sceneOwnerUserId: '',
        sceneRecommendationReason: '',
        sceneRecommendationSourceLabel: '',
        returnToPlmPath: '/plm/workbench',
      },
    })).toEqual({
      page: 1,
      q: 'scene-77',
      actorId: '',
      kind: '',
      action: '',
      resourceType: '',
      from: '',
      to: '',
      windowMinutes: 180,
      teamViewId: 'audit-view-2',
      sceneId: 'scene-77',
      sceneName: '采购延迟',
      sceneOwnerUserId: 'owner-7',
      sceneRecommendationReason: 'Late orders',
      sceneRecommendationSourceLabel: 'Planner',
      returnToPlmPath: '/plm/workbench',
    })
  })

  it('builds local-save follow-up actions for the matching saved view', () => {
    expect(buildPlmAuditSavedViewShareFollowupNotice({
      id: 'saved-1',
      name: 'Shared supplier audit · Local view',
    }, {
      savedViewId: 'saved-1',
      source: 'shared-entry',
    }, tr)).toEqual({
      sourceLabel: 'Shared team view link|团队视图分享链接',
      title: 'Shared audit setup saved locally.|分享的审计配置已保存到本地。',
      description:
        'You can keep "Shared supplier audit · Local view" as a personal saved view, or immediately promote it into the audit team views.|你可以将“Shared supplier audit · Local view”继续保留为个人已保存视图，或立即将其提升到审计团队视图。',
      actions: [
        {
          kind: 'promote-team',
          label: 'Save to team|保存到团队',
          emphasis: 'primary',
        },
        {
          kind: 'promote-default',
          label: 'Save as default team view|保存为团队默认视图',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })

  it('returns null when the follow-up targets another saved view', () => {
    expect(buildPlmAuditSavedViewShareFollowupNotice({
      id: 'saved-1',
      name: 'Shared supplier audit · Local view',
    }, {
      savedViewId: 'saved-2',
      source: 'shared-entry',
    }, tr)).toBeNull()
  })

  it('builds scene-save follow-up copy for locally saved scene audits', () => {
    expect(buildPlmAuditSavedViewShareFollowupNotice({
      id: 'saved-2',
      name: '采购团队场景 · audit scene',
    }, {
      savedViewId: 'saved-2',
      source: 'scene-context',
    }, tr)).toEqual({
      sourceLabel: 'Scene save shortcut|场景快捷保存',
      title: 'Scene audit saved locally.|场景审计已保存到本地。',
      description:
        'You can keep "采购团队场景 · audit scene" as a personal saved view, or immediately promote this scene-focused audit into the audit team views.|你可以将“采购团队场景 · audit scene”继续保留为个人已保存视图，或立即将这个场景审计提升到审计团队视图。',
      actions: [
        {
          kind: 'promote-team',
          label: 'Save to team|保存到团队',
          emphasis: 'primary',
        },
        {
          kind: 'promote-default',
          label: 'Save as default team view|保存为团队默认视图',
          emphasis: 'secondary',
        },
        {
          kind: 'dismiss',
          label: 'Done|完成',
          emphasis: 'secondary',
        },
      ],
    })
  })
})
