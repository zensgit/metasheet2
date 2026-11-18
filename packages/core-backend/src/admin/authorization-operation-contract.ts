/** Wire types shared by the authorization-operation HTTP handlers and clients. */
export type AuthorizationOperationAction =
  | { kind: 'role.assign' | 'role.revoke'; roleId: string }
  | { kind: 'admission.set' }
  | { kind: 'direct.grant' | 'direct.revoke' | 'legacy.revoke'; code: string }
  | { kind: 'template.apply'; templateId: string }

export function isRoleAction(action: AuthorizationOperationAction): action is Extract<AuthorizationOperationAction, {roleId:string}> { return action.kind==='role.assign' || action.kind==='role.revoke' }
export function isExceptionAction(action: AuthorizationOperationAction): action is Extract<AuthorizationOperationAction, {code:string} | {templateId:string}> { return action.kind==='direct.grant' || action.kind==='direct.revoke' || action.kind==='legacy.revoke' || action.kind==='template.apply' }

export type AuthorizationOperationAdmissionChange = { namespace: string; enabled: boolean }
export type AuthorizationOperationRequest = {
  targetUserId: string
  action: AuthorizationOperationAction
  admissionChanges: AuthorizationOperationAdmissionChange[]
  reason?: string
}
export type AuthorizationOperationCommitRequest = AuthorizationOperationRequest & {
  clientOperationId: string
  expectedVersion: string
}
export type AuthorizationOperationSourceChange = {
  source: 'role' | 'direct' | 'legacy'
  id: string
  operation: 'assign' | 'revoke'
  changed: boolean
}
export type AuthorizationOperationAdmissionImpact = {
  namespace: string
  before: boolean | null
  after: boolean
  cause: 'explicit' | 'role_revoke'
}
export type AuthorizationOperationPermission = {
  code: string
  sources: Array<{ kind: 'role' | 'direct' | 'legacy' | 'profile'; id: string | null }>
  effective: boolean
}
export type AuthorizationOperationImpact = {
  sourceChanges: AuthorizationOperationSourceChange[]
  admissionChanges: AuthorizationOperationAdmissionImpact[]
  scopeCleanup: Array<{ namespace: string; kind: 'department' | 'member_group'; id: string }>
  effectiveBefore: AuthorizationOperationPermission[]
  effectiveAfter: AuthorizationOperationPermission[]
  retainedOtherGrants: AuthorizationOperationPermission[]
  warnings: string[]
}
export type AuthorizationOperationPreview = {
  expectedVersion: string
  impact: AuthorizationOperationImpact
}
export type AuthorizationOperationReceipt = {
  targetUserId: string
  action: AuthorizationOperationAction
  impact: AuthorizationOperationImpact
  resultVersion: string
}
export type AuthorizationOperationLookup =
  | { status: 'committed'; clientOperationId: string; receipt: AuthorizationOperationReceipt }
  | { status: 'unknown_or_pending'; clientOperationId: string }
