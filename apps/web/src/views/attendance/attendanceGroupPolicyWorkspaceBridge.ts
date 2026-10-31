import type { AttendanceGroupRouteStep, AttendanceGroupRouteSurface } from '../../router/attendanceGroupContextRoute'
import {
  parseAttendanceGroupEffectivePolicyEditorRefV1,
  resolveAttendanceGroupEffectivePolicyEditorTargetV1,
  type AttendanceGroupEffectivePolicyEditorRefV1,
  type AttendanceGroupEffectivePolicyStageActionV1,
} from './attendanceGroupEffectivePolicyLabels'

export interface AttendanceGroupPolicyWorkspaceSource {
  readonly groupId: string
  readonly orgId: string
  readonly revision: number
}

export interface AttendanceGroupPolicyWorkspaceNavigation {
  readonly groupId: string
  readonly editorRef: AttendanceGroupEffectivePolicyEditorRefV1
}

export function navigateAttendanceGroupPolicyWorkspace(
  target: AttendanceGroupPolicyWorkspaceNavigation,
  source: AttendanceGroupPolicyWorkspaceSource,
  current: AttendanceGroupPolicyWorkspaceSource | null,
  isCurrent: boolean,
  openRoute: (step: AttendanceGroupRouteStep, surface: AttendanceGroupRouteSurface | null) => void,
  openStage: (target: AttendanceGroupEffectivePolicyStageActionV1) => void,
): void {
  // Object identity is intentional: an earlier A must stay old after A -> B -> A.
  if (!isCurrent || source !== current || !source.orgId || target.groupId !== source.groupId) return
  const editorRef = parseAttendanceGroupEffectivePolicyEditorRefV1(target.editorRef)
  if (!editorRef) return
  const destination = resolveAttendanceGroupEffectivePolicyEditorTargetV1(editorRef, { groupId: source.groupId })
  if (destination.kind === 'group-stage') {
    openStage({ groupId: destination.groupId, stage: destination.stage })
    return
  }
  openRoute(destination.step, destination.surface)
}
