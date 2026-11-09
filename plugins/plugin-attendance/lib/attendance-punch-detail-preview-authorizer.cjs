/** Reuse the existing import-target policy with the host's current transaction. */
function createAttendancePunchDetailPreviewAuthorizerV1(deps) {
  return async (client, { scope, envelope }) => {
    const rbac = deps.createRbacHelpers(client, deps.logger)
    if (await rbac.hasAttendanceAdminAccess(scope.actorId) || await rbac.hasAttendanceImportAccess(scope.actorId)) return true
    const actor = await deps.loadAttendanceScopeContextForUser(client, scope.orgId, scope.actorId, { strictSources: true })
    const scopes = await deps.loadActiveAttendanceSchedulerScopesForActor(scope.orgId, actor, client)
    const input = envelope.__punchDetailInput
    const facts = await deps.resolveAttendanceUserSchedulerScopeFacts(client, scope.orgId, input.userId, { workDate: input.workDate })
    return scopes.some(item => deps.attendanceSchedulerScopeAllowsActorActionFacts(item, actor, 'import', facts))
  }
}
module.exports = { createAttendancePunchDetailPreviewAuthorizerV1 }
