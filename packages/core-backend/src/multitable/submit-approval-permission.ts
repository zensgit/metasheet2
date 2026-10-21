/**
 * `multitable:submit-approval` — RECORD-LEVEL SUBMIT FOR APPROVAL, separated from record writing.
 *
 * Phase 2 of multitable x approval (design: multitable-approval-phase2-record-submit-design-20260915.md
 * §4.2). Submitting a record for approval is a CROSS-PRODUCT action: it creates an approval-product
 * instance on behalf of the caller. It is therefore NOT implied by `multitable:write` (filling a cell and
 * starting a company approval flow are not the same authority), and it is NOT implied by the automation
 * capability either (the whole point of phase 2 is that no automation rule is required).
 *
 * ── Semantics ──
 * `canSubmitApproval := isAdminRole || hasPermission(permissions, 'multitable:submit-approval')`
 *
 * `hasPermission`'s existing wildcard semantics still apply (`multitable:*` / `*:*` satisfy the code —
 * those grants are superuser-shaped by construction). This module neither widens nor narrows that.
 *
 * ── This is only the MULTITABLE-side door ──
 * `ApprovalProductService.createApproval` re-checks `approvals:write` itself, against the DATABASE (not
 * the JWT), inside its own transaction. So a holder of `multitable:submit-approval` who lacks
 * `approvals:write` is refused by the approval product — by design. Both codes are required; this one is
 * seeded to `admin` by
 * `db/migrations/zzzz20260915121000_add_multitable_submit_approval_permission.ts`, every other holder is
 * an explicit operational grant.
 *
 * Extracted as its own module (mirroring `manage-schema-permission.ts`) because `deriveCapabilities`
 * exists TWICE — `multitable/access.ts` (REST) and `multitable/sheet-capabilities.ts` (Yjs bridge /
 * OAPI tokens). Both call THIS function, so the two clones cannot drift apart.
 */

/** The permission code that grants record-level "submit for approval". */
export const MULTITABLE_SUBMIT_APPROVAL_PERMISSION = 'multitable:submit-approval'

/**
 * The single policy implementation behind `canSubmitApproval`, shared by the REST derivation
 * (multitable/access.ts) and the Yjs-bridge/OAPI derivation (multitable/sheet-capabilities.ts).
 *
 * `hasPermissionFn` is injected because the two callers each carry their own (identical) wildcard-aware
 * `hasPermission`; passing it keeps this module free of a cross-import between them.
 */
export function deriveCanSubmitApproval(
  permissions: string[],
  isAdminRole: boolean,
  hasPermissionFn: (permissions: string[], code: string) => boolean,
): boolean {
  if (isAdminRole) return true
  return hasPermissionFn(permissions, MULTITABLE_SUBMIT_APPROVAL_PERMISSION)
}
