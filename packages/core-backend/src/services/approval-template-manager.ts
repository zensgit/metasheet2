/**
 * Single source of truth for "is this actor a template manager for createApproval
 * visibility bypass?" Used by:
 *   - ApprovalProductService.assembleCreationContext (create + route-preview)
 *   - resolveCreateApprovalActorFromRequest (attachment upload target gate)
 *
 * Dependency-neutral (no Express, no DB) so routes and services can share without
 * import cycles. Do NOT treat `approvals:admin` alone as a bypass — that is
 * operational admin, not template-manager.
 */
export function isCreateApprovalTemplateManager(actor: {
  roles?: readonly string[]
  permissions?: readonly string[]
}): boolean {
  const permissions = actor.permissions ?? []
  const roles = actor.roles ?? []
  return permissions.includes('approval-templates:manage')
    || permissions.includes('approvals:admin-templates')
    || permissions.includes('approvals:*')
    || permissions.includes('*:*')
    || roles.includes('admin')
}
