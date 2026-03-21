import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import {
  buildPlmAuditRouteStateFromTeamView,
  hasExplicitPlmAuditFilters,
  type PlmAuditRouteState,
} from './plmAuditQueryState'
import { buildPlmAuditTeamViewLogState } from './plmAuditTeamViewAudit'

type PlmAuditTeamViewRouteCandidate = Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'isArchived' | 'state'>

export type PlmAuditRequestedTeamViewRouteResolution =
  | {
    kind: 'apply-view'
    viewId: string
    nextState: PlmAuditRouteState
  }
  | {
    kind: 'clear-selection'
    nextState: PlmAuditRouteState
  }
  | {
    kind: 'noop'
  }

export function buildPlmAuditSelectedTeamViewRouteState(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'state'>,
): PlmAuditRouteState {
  return buildPlmAuditRouteStateFromTeamView(view.id, view.state)
}

export function buildPlmAuditPersistedTeamViewRouteState(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind' | 'state'>,
  currentState: Pick<PlmAuditRouteState, 'windowMinutes'>,
  options?: {
    isDefault?: boolean
  },
): PlmAuditRouteState {
  if (options?.isDefault) {
    return buildPlmAuditTeamViewLogState(view, 'set-default', currentState)
  }

  return buildPlmAuditSelectedTeamViewRouteState(view)
}

export function resolvePlmAuditRequestedTeamViewRouteState(
  requestedState: PlmAuditRouteState,
  views: readonly PlmAuditTeamViewRouteCandidate[],
  defaultView: PlmAuditTeamViewRouteCandidate | null,
): PlmAuditRequestedTeamViewRouteResolution {
  const requestedViewId = requestedState.teamViewId.trim()
  const requestedView = requestedViewId
    ? views.find((view) => view.id === requestedViewId && !view.isArchived) || null
    : null

  if (requestedView) {
    return {
      kind: 'apply-view',
      viewId: requestedView.id,
      nextState: buildPlmAuditSelectedTeamViewRouteState(requestedView),
    }
  }

  if (requestedViewId) {
    return {
      kind: 'clear-selection',
      nextState: {
        ...requestedState,
        teamViewId: '',
      },
    }
  }

  if (defaultView && !defaultView.isArchived && !hasExplicitPlmAuditFilters(requestedState)) {
    return {
      kind: 'apply-view',
      viewId: defaultView.id,
      nextState: buildPlmAuditSelectedTeamViewRouteState(defaultView),
    }
  }

  return {
    kind: 'noop',
  }
}
