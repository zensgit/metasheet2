import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { PlmCollaborativeAuditAction, PlmCollaborativeAuditResourceType } from '../services/plm/plmWorkbenchClient'

export interface PlmAuditTeamViewState {
  page: number
  q: string
  actorId: string
  kind: string
  action: PlmCollaborativeAuditAction | ''
  resourceType: PlmCollaborativeAuditResourceType | ''
  from: string
  to: string
  windowMinutes: number
}

export interface PlmAuditRouteState {
  page: number
  q: string
  actorId: string
  kind: string
  action: PlmCollaborativeAuditAction | ''
  resourceType: PlmCollaborativeAuditResourceType | ''
  from: string
  to: string
  windowMinutes: number
  teamViewId: string
  sceneId: string
  sceneName: string
  sceneOwnerUserId: string
  sceneRecommendationReason: string
  sceneRecommendationSourceLabel: string
  returnToPlmPath: string
}

export const DEFAULT_PLM_AUDIT_ROUTE_STATE: PlmAuditRouteState = {
  page: 1,
  q: '',
  actorId: '',
  kind: '',
  action: '',
  resourceType: '',
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

function readString(value: unknown) {
  return typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : ''
}

function normalizePositiveInt(value: unknown, fallback: number) {
  const numeric = Number.parseInt(readString(value), 10)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback
}

function normalizeWindowMinutes(value: unknown) {
  const numeric = normalizePositiveInt(value, DEFAULT_PLM_AUDIT_ROUTE_STATE.windowMinutes)
  if (numeric <= 60) return 60
  if (numeric <= 180) return 180
  if (numeric <= 720) return 720
  return 1440
}

export function parsePlmAuditRouteState(query: LocationQuery): PlmAuditRouteState {
  const action = readString(query.auditAction)
  const resourceType = readString(query.auditType)

  return {
    page: normalizePositiveInt(query.auditPage, DEFAULT_PLM_AUDIT_ROUTE_STATE.page),
    q: readString(query.auditQ),
    actorId: readString(query.auditActor),
    kind: readString(query.auditKind),
    action:
      action === 'archive'
      || action === 'restore'
      || action === 'delete'
      || action === 'set-default'
      || action === 'clear-default'
        ? action
        : '',
    resourceType:
      resourceType === 'plm-team-preset-batch'
      || resourceType === 'plm-team-view-batch'
      || resourceType === 'plm-team-view-default'
        ? resourceType
        : '',
    from: readString(query.auditFrom),
    to: readString(query.auditTo),
    windowMinutes: normalizeWindowMinutes(query.auditWindow),
    teamViewId: readString(query.auditTeamView),
    sceneId: readString(query.auditSceneId),
    sceneName: readString(query.auditSceneName),
    sceneOwnerUserId: readString(query.auditSceneOwner),
    sceneRecommendationReason: readString(query.auditSceneReason),
    sceneRecommendationSourceLabel: readString(query.auditSceneSource),
    returnToPlmPath: readString(query.auditReturnTo),
  }
}

export function buildPlmAuditRouteQuery(state: PlmAuditRouteState): LocationQueryRaw {
  const query: LocationQueryRaw = {}

  if (state.page > DEFAULT_PLM_AUDIT_ROUTE_STATE.page) query.auditPage = String(state.page)
  if (state.q) query.auditQ = state.q
  if (state.actorId) query.auditActor = state.actorId
  if (state.kind) query.auditKind = state.kind
  if (state.action) query.auditAction = state.action
  if (state.resourceType) query.auditType = state.resourceType
  if (state.from) query.auditFrom = state.from
  if (state.to) query.auditTo = state.to
  if (state.windowMinutes !== DEFAULT_PLM_AUDIT_ROUTE_STATE.windowMinutes) {
    query.auditWindow = String(state.windowMinutes)
  }
  if (state.teamViewId) query.auditTeamView = state.teamViewId
  if (state.sceneId) query.auditSceneId = state.sceneId
  if (state.sceneName) query.auditSceneName = state.sceneName
  if (state.sceneOwnerUserId) query.auditSceneOwner = state.sceneOwnerUserId
  if (state.sceneRecommendationReason) query.auditSceneReason = state.sceneRecommendationReason
  if (state.sceneRecommendationSourceLabel) {
    query.auditSceneSource = state.sceneRecommendationSourceLabel
  }
  if (state.returnToPlmPath) query.auditReturnTo = state.returnToPlmPath

  return query
}

export function buildPlmAuditTeamViewState(state: PlmAuditRouteState): PlmAuditTeamViewState {
  return {
    page: state.page,
    q: state.q,
    actorId: state.actorId,
    kind: state.kind,
    action: state.action,
    resourceType: state.resourceType,
    from: state.from,
    to: state.to,
    windowMinutes: state.windowMinutes,
  }
}

export function buildPlmAuditRouteStateFromTeamView(
  teamViewId: string,
  state: PlmAuditTeamViewState,
): PlmAuditRouteState {
  return {
    ...DEFAULT_PLM_AUDIT_ROUTE_STATE,
    ...state,
    teamViewId,
  }
}

export function hasExplicitPlmAuditFilters(state: PlmAuditRouteState) {
  return state.page !== DEFAULT_PLM_AUDIT_ROUTE_STATE.page
    || state.q !== DEFAULT_PLM_AUDIT_ROUTE_STATE.q
    || state.actorId !== DEFAULT_PLM_AUDIT_ROUTE_STATE.actorId
    || state.kind !== DEFAULT_PLM_AUDIT_ROUTE_STATE.kind
    || state.action !== DEFAULT_PLM_AUDIT_ROUTE_STATE.action
    || state.resourceType !== DEFAULT_PLM_AUDIT_ROUTE_STATE.resourceType
    || state.from !== DEFAULT_PLM_AUDIT_ROUTE_STATE.from
    || state.to !== DEFAULT_PLM_AUDIT_ROUTE_STATE.to
    || state.windowMinutes !== DEFAULT_PLM_AUDIT_ROUTE_STATE.windowMinutes
}

export function isPlmAuditRouteStateEqual(left: PlmAuditRouteState, right: PlmAuditRouteState) {
  return left.page === right.page
    && left.q === right.q
    && left.actorId === right.actorId
    && left.kind === right.kind
    && left.action === right.action
    && left.resourceType === right.resourceType
    && left.from === right.from
    && left.to === right.to
    && left.windowMinutes === right.windowMinutes
    && left.teamViewId === right.teamViewId
    && left.sceneId === right.sceneId
    && left.sceneName === right.sceneName
    && left.sceneOwnerUserId === right.sceneOwnerUserId
    && left.sceneRecommendationReason === right.sceneRecommendationReason
    && left.sceneRecommendationSourceLabel === right.sceneRecommendationSourceLabel
    && left.returnToPlmPath === right.returnToPlmPath
}
