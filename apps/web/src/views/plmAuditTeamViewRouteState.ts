import type { PlmWorkbenchTeamView } from './plm/plmPanelModels'
import {
  buildPlmAuditRouteStateFromTeamView,
  hasExplicitPlmAuditFilters,
  hasPlmAuditSceneContext,
  type PlmAuditRouteState,
} from './plmAuditQueryState'
import { canApplyPlmAuditTeamView } from './plmAuditTeamViewManagement'
import { buildPlmAuditTeamViewLogState } from './plmAuditTeamViewAudit'

type PlmAuditTeamViewRouteCandidate = Pick<
  PlmWorkbenchTeamView<'audit'>,
  'id' | 'isArchived' | 'permissions' | 'state'
>

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
  currentState?: Pick<PlmAuditRouteState, 'returnToPlmPath'>,
): PlmAuditRouteState {
  return {
    ...buildPlmAuditRouteStateFromTeamView(view.id, view.state),
    returnToPlmPath: currentState?.returnToPlmPath || '',
  }
}

export function buildPlmAuditPersistedTeamViewRouteState(
  view: Pick<PlmWorkbenchTeamView<'audit'>, 'id' | 'kind' | 'state'>,
  currentState: Pick<PlmAuditRouteState, 'windowMinutes' | 'returnToPlmPath'>,
  options?: {
    isDefault?: boolean
  },
): PlmAuditRouteState {
  if (options?.isDefault) {
    return buildPlmAuditTeamViewLogState(view, 'set-default', currentState)
  }

  return buildPlmAuditSelectedTeamViewRouteState(view, currentState)
}

export function buildPlmAuditClearedTeamViewSelectionState(
  currentState: PlmAuditRouteState,
  clearedViewIds: readonly string[],
): PlmAuditRouteState {
  const selectedViewId = currentState.teamViewId.trim()
  if (!selectedViewId || !clearedViewIds.includes(selectedViewId)) {
    return currentState
  }

  return {
    ...currentState,
    teamViewId: '',
  }
}

export function resolvePlmAuditRequestedTeamViewRouteState(
  requestedState: PlmAuditRouteState,
  views: readonly PlmAuditTeamViewRouteCandidate[],
  defaultView: PlmAuditTeamViewRouteCandidate | null,
): PlmAuditRequestedTeamViewRouteResolution {
  const requestedViewId = requestedState.teamViewId.trim()
  const requestedView = requestedViewId
    ? views.find((view) => (
      view.id === requestedViewId
      && !view.isArchived
      && canApplyPlmAuditTeamView(view)
    )) || null
    : null

  if (requestedView) {
    return {
      kind: 'apply-view',
      viewId: requestedView.id,
      nextState: buildPlmAuditSelectedTeamViewRouteState(requestedView, requestedState),
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

  if (
    defaultView
    && !defaultView.isArchived
    && canApplyPlmAuditTeamView(defaultView)
    && !hasExplicitPlmAuditFilters(requestedState)
    && !hasPlmAuditSceneContext(requestedState)
  ) {
    return {
      kind: 'apply-view',
      viewId: defaultView.id,
      nextState: buildPlmAuditSelectedTeamViewRouteState(defaultView, requestedState),
    }
  }

  return {
    kind: 'noop',
  }
}
