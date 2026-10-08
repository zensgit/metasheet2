/**
 * Residual sweep (NIT-2, gate finding `/tmp/lock9-gate-20260822.md` §NIT-2) — the ONE
 * actor-roles resolver, shared by `routes/approvals.ts` and `approval-attachment-runtime.ts`.
 *
 * Prior to this extraction, the SAME body (a `req.user.role` singular claim unioned with the
 * `req.user.roles` array claim, deduplicated) was defined twice — once in `routes/approvals.ts`
 * (`resolveApprovalActorRoles`, 18 call sites) and once in `approval-attachment-runtime.ts`
 * (`resolveActorRolesFromRequest`, 1 call site, whose own docblock recorded the duplication as
 * deliberate "to avoid a new cross-module export"). The two bodies had already drifted lexically
 * (`(role)` vs `(r)` as the filter-callback parameter name) though never behaviourally — the
 * residual-sweep judgement is that a text-parity test would itself be a source-text assertion
 * (`feedback_source_text_assertions_are_not_behaviour`: the normaliser can be deleted along with
 * the drift it polices), so this extraction removes the SECOND definition instead, making drift
 * impossible by construction rather than merely detected.
 *
 * Leaf on purpose: a `services/` module must not import from `routes/`, and `routes/approvals.ts`
 * already imports from `services/` (e.g. `ApprovalProductService`), so placing the shared helper
 * here keeps the existing edge direction and introduces no import cycle.
 */
import type { Request } from 'express'

/** Deduplicated actor role set — the `req.user.role` singular claim (if present) unioned with the
 *  `req.user.roles` array claim (string entries only, trimmed, non-empty). */
export function resolveApprovalActorRoles(req: Request): string[] {
  const role = typeof req.user?.role === 'string' && req.user.role.trim().length > 0
    ? [req.user.role.trim()]
    : []
  const roles = Array.isArray(req.user?.roles)
    ? req.user!.roles.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
    : []
  return Array.from(new Set([...role, ...roles]))
}
