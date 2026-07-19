import type { Request, Response } from 'express'
import { Router } from 'express'
import { auditLog } from '../audit/audit'
import { Logger } from '../core/logger'
import { ensurePlatformAdmin } from './admin-directory'
import { query, transaction } from '../db/pg'
import { resolveApprovalRequesterOrgRelations } from '../services/ApprovalDirectoryOrg'
import { jsonError, jsonOk } from '../util/response'

const logger = new Logger('AdminDirectoryRoutingPolicyRoutes')

// Same single-tenant org resolution convention as admin-directory-local.ts (see the long comment
// there): org identity is NEVER read from the request — this is what makes org_id unspoofable.
const DEFAULT_ORG_ID = 'default'
function resolveOrgId(_req: Request): string {
  return DEFAULT_ORG_ID
}

/** Mirrors the `orp_purpose_chk` CHECK — the §6 closed purpose set. */
const PURPOSES = [
  'approval_routing',
  'permission_scope',
  'attendance_expansion',
  'member_group_projection',
  'automation_recipient_resolution',
] as const
type Purpose = (typeof PURPOSES)[number]

function isPurpose(value: string): value is Purpose {
  return (PURPOSES as readonly string[]).includes(value)
}

/** Owner review (#4431): default-OFF capability gate for canonical=local (staged opt-in pattern). */
function isLocalCanonicalEnabled(): boolean {
  const v = process.env.DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED
  return v === '1' || v === 'true'
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuidShaped(value: string): boolean {
  return UUID_SHAPE.test(value)
}

interface PolicyRow {
  purpose: string
  canonical_integration_id: string
  canonical_provider: string
  canonical_status: string
  fallback_integration_id: string | null
  updated_at: string
}

interface IntegrationRow {
  id: string
  provider: string
  status: string
}

async function loadOrgIntegration(orgId: string, integrationId: string): Promise<IntegrationRow | null> {
  const r = await query<IntegrationRow>(
    `SELECT id::text AS id, provider, status FROM directory_integrations WHERE id = $1::uuid AND org_id = $2`,
    [integrationId, orgId],
  )
  return r.rows[0] ?? null
}

/**
 * B5-c (design lock Lock 3 + §7): the routing-policy admin surface.
 *
 *   GET   /                       — every §6 purpose with its EFFECTIVE source: the stored policy
 *                                   (canonical integration + provider/status) or 'legacy-default'
 *                                   (no policy row → the resolver's byte-identical legacy path).
 *   PATCH /:purpose               — the ONLY write point. `{ canonicalIntegrationId: uuid }` sets
 *                                   (upsert; target must exist in THIS org and be 'active' — a
 *                                   policy pointing at a broken target is rejected 409 at write
 *                                   time instead of failing approvals later); `null` clears (back
 *                                   to legacy). Values-free audit on both.
 *   GET   /:purpose/preview       — READ-ONLY switch preview (v1: approval_routing only):
 *                                   `?candidate=<integrationId>` resolves a sample of linked users
 *                                   under the CURRENT effective source and AS-IF the candidate
 *                                   were canonical (the resolver's preview override — the same
 *                                   resolver both legs, so preview cannot drift from production),
 *                                   and reports per-user dept/title/manager/dept-head diffs.
 *                                   No writes, no policy row, no audit (design-lock Q5).
 *
 * All routes are platform-admin-only. Org identity is server-resolved (never from the request).
 */
export function adminDirectoryRoutingPolicyRouter(): Router {
  const router = Router()

  router.get('/', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return
    try {
      const orgId = resolveOrgId(req)
      const rows = await query<PolicyRow>(
        `SELECT p.purpose,
                p.canonical_integration_id::text AS canonical_integration_id,
                i.provider                       AS canonical_provider,
                i.status                         AS canonical_status,
                p.fallback_integration_id::text  AS fallback_integration_id,
                p.updated_at::text               AS updated_at
           FROM org_directory_routing_policy p
           JOIN directory_integrations i ON i.id = p.canonical_integration_id
          WHERE p.org_id = $1`,
        [orgId],
      )
      const byPurpose = new Map(rows.rows.map((r) => [r.purpose, r]))
      const purposes = PURPOSES.map((purpose) => {
        const p = byPurpose.get(purpose)
        return p
          ? {
              purpose,
              source: 'policy' as const,
              canonicalIntegrationId: p.canonical_integration_id,
              canonicalProvider: p.canonical_provider,
              canonicalStatus: p.canonical_status,
              fallbackIntegrationId: p.fallback_integration_id,
              updatedAt: p.updated_at,
            }
          : { purpose, source: 'legacy-default' as const }
      })
      jsonOk(res, { orgId, purposes })
    } catch (error) {
      logger.error(`Failed to list routing policies: ${error instanceof Error ? error.message : 'unknown'}`)
      jsonError(res, 500, 'ROUTING_POLICY_LIST_FAILED', 'Failed to list routing policies')
    }
  })

  router.patch('/:purpose', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    const purpose = String(req.params.purpose ?? '')
    if (!isPurpose(purpose)) {
      jsonError(res, 400, 'ROUTING_POLICY_INVALID_PURPOSE', 'Unknown routing purpose')
      return
    }
    // Owner review (#4431): v1 has exactly ONE consumer — approval_routing (B6 parity). Writing a
    // policy for the other four §6 purposes would create DEAD CONFIG no resolver reads (and imply
    // governance that does not exist). The schema CHECK keeps the full closed set for the future;
    // the WRITE surface only opens a purpose when its consumer + parity proof land (§10.2+).
    if (purpose !== 'approval_routing') {
      jsonError(res, 400, 'ROUTING_POLICY_PURPOSE_UNSUPPORTED', 'v1 supports approval_routing only; other purposes have no consumer yet')
      return
    }

    // Field allowlist (B2 convention): ONLY canonicalIntegrationId; anything else — org/corp
    // identity especially — is rejected loudly, never silently dropped.
    const body = (req.body ?? {}) as Record<string, unknown>
    const extraKeys = Object.keys(body).filter((k) => k !== 'canonicalIntegrationId')
    if (extraKeys.length > 0) {
      jsonError(res, 400, 'ROUTING_POLICY_INVALID_INPUT', `Unexpected field(s): ${extraKeys.join(', ')}`)
      return
    }
    if (!('canonicalIntegrationId' in body)) {
      jsonError(res, 400, 'ROUTING_POLICY_INVALID_INPUT', 'canonicalIntegrationId is required (uuid to set, null to clear)')
      return
    }
    const canonical = body.canonicalIntegrationId

    try {
      const orgId = resolveOrgId(req)

      if (canonical === null) {
        const deleted = await query<{ id: string }>(
          `DELETE FROM org_directory_routing_policy WHERE org_id = $1 AND purpose = $2 RETURNING id`,
          [orgId, purpose],
        )
        const cleared = deleted.rows.length > 0
        if (cleared) {
          await auditLog({
            actorId: adminUserId,
            actorType: 'user',
            action: 'directory.routing_policy.clear',
            resourceType: 'directory-routing-policy',
            resourceId: `${orgId}:${purpose}`,
            meta: { orgId, purpose },
          })
        }
        jsonOk(res, { cleared })
        return
      }

      if (typeof canonical !== 'string' || !isUuidShaped(canonical)) {
        jsonError(res, 400, 'ROUTING_POLICY_INVALID_INPUT', 'canonicalIntegrationId must be a UUID or null')
        return
      }

      // TOCTOU close (write-point): active-target validation and the policy upsert MUST share one
      // transaction, and the target integration row is locked `FOR SHARE` at the write point
      // through commit. A concurrent disable that commits between a separate SELECT and INSERT
      // would otherwise accept a policy pointing at a now-inactive target (B5-b would then
      // fail-close every consuming approval). `FOR SHARE` conflicts with the exclusive row lock
      // a status UPDATE takes, so the two serialize: disable-first → PATCH re-reads inactive →
      // 409 with zero write; set-first → set commits, then disable, resolver fails closed.
      // Audit is deliberately POST-commit (and values-free) so a rolled-back / rejected write
      // never leaves a partial audit trail.
      type WriteOutcome =
        | { kind: 'not_found' }
        | { kind: 'not_active' }
        | { kind: 'local_not_enabled' }
        | { kind: 'ok'; provider: string }

      const outcome = await transaction(async (client) => {
        const locked = await client.query(
          `SELECT id::text AS id, provider, status
             FROM directory_integrations
            WHERE id = $1::uuid AND org_id = $2
            FOR SHARE`,
          [canonical, orgId],
        )
        const integration = (locked.rows[0] as IntegrationRow | undefined) ?? null
        if (!integration) return { kind: 'not_found' } satisfies WriteOutcome
        if (integration.status !== 'active') {
          // fail at WRITE time — a policy pointing at a broken target would fail-close every
          // policy-consuming approval later (B5-b), which is strictly worse than rejecting here.
          return { kind: 'not_active' } satisfies WriteOutcome
        }
        // Owner review (#4431): switching approval routing to the LOCAL provider is a capability
        // decision, not a config edit — it must be explicitly enabled (env-gate, default OFF, the
        // repo's staged-opt-in pattern) after the owner accepts the B6 parity evidence for the
        // deployment. Until then a local canonical is rejected at the WRITE surface. (Preview stays
        // available for local candidates on purpose — it is the read-only evidence tool for making
        // exactly this decision.)
        if (integration.provider === 'local' && !isLocalCanonicalEnabled()) {
          return { kind: 'local_not_enabled' } satisfies WriteOutcome
        }
        await client.query(
          `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id)
           VALUES ($1, $2, $3)
           ON CONFLICT ON CONSTRAINT orp_org_purpose_uniq
           DO UPDATE SET canonical_integration_id = EXCLUDED.canonical_integration_id, updated_at = NOW()`,
          [orgId, purpose, canonical],
        )
        return { kind: 'ok', provider: integration.provider } satisfies WriteOutcome
      })

      if (outcome.kind === 'not_found') {
        jsonError(res, 404, 'ROUTING_POLICY_INTEGRATION_NOT_FOUND', 'Integration not found in this organization')
        return
      }
      if (outcome.kind === 'not_active') {
        jsonError(res, 409, 'ROUTING_POLICY_TARGET_NOT_ACTIVE', 'The target integration is not active')
        return
      }
      if (outcome.kind === 'local_not_enabled') {
        jsonError(res, 409, 'ROUTING_POLICY_LOCAL_NOT_ENABLED', 'Routing to the local provider is not enabled (set DIRECTORY_ROUTING_LOCAL_CANONICAL_ENABLED=1 after accepting parity evidence)')
        return
      }

      await auditLog({
        actorId: adminUserId,
        actorType: 'user',
        action: 'directory.routing_policy.set',
        resourceType: 'directory-routing-policy',
        resourceId: `${orgId}:${purpose}`,
        // values-free: ids only, no config echo
        meta: { orgId, purpose, integrationId: canonical },
      })
      jsonOk(res, { policy: { purpose, canonicalIntegrationId: canonical, canonicalProvider: outcome.provider } })
    } catch (error) {
      logger.error(`Failed to set routing policy: ${error instanceof Error ? error.message : 'unknown'}`)
      jsonError(res, 500, 'ROUTING_POLICY_WRITE_FAILED', 'Failed to update the routing policy')
    }
  })

  router.get('/:purpose/preview', async (req: Request, res: Response) => {
    const adminUserId = await ensurePlatformAdmin(req, res)
    if (!adminUserId) return

    const purpose = String(req.params.purpose ?? '')
    if (purpose !== 'approval_routing') {
      // v1 previews the FIRST consumer only (B6 scope); other purposes stay legacy until their own
      // parity proofs exist (§10.2+).
      jsonError(res, 400, 'ROUTING_POLICY_PREVIEW_UNSUPPORTED', 'v1 preview supports approval_routing only')
      return
    }
    const candidate = typeof req.query.candidate === 'string' ? req.query.candidate : ''
    if (!isUuidShaped(candidate)) {
      jsonError(res, 400, 'ROUTING_POLICY_INVALID_INPUT', 'candidate must be an integration UUID')
      return
    }

    try {
      const orgId = resolveOrgId(req)
      const integration = await loadOrgIntegration(orgId, candidate)
      if (!integration) {
        jsonError(res, 404, 'ROUTING_POLICY_INTEGRATION_NOT_FOUND', 'Candidate integration not found in this organization')
        return
      }
      if (integration.status !== 'active') {
        jsonError(res, 409, 'ROUTING_POLICY_TARGET_NOT_ACTIVE', 'The candidate integration is not active')
        return
      }

      // Current effective source (for the report header + broken-current guard).
      const current = await query<{ canonical_integration_id: string; status: string }>(
        `SELECT p.canonical_integration_id::text AS canonical_integration_id, i.status
           FROM org_directory_routing_policy p
           JOIN directory_integrations i ON i.id = p.canonical_integration_id
          WHERE p.org_id = $1 AND p.purpose = 'approval_routing'`,
        [orgId],
      )
      const currentPolicy = current.rows[0] ?? null
      if (currentPolicy && currentPolicy.status !== 'active') {
        jsonError(res, 409, 'ROUTING_POLICY_MISCONFIGURED', 'The CURRENT routing policy points at a non-active integration; fix it before previewing a switch')
        return
      }

      // Deterministic sample: users linked to any account in THIS org's integrations.
      const sample = await query<{ local_user_id: string }>(
        `SELECT DISTINCT l.local_user_id
           FROM directory_account_links l
           JOIN directory_accounts a ON a.id = l.directory_account_id AND a.is_active = true
           JOIN directory_integrations i ON i.id = a.integration_id
          WHERE l.link_status = 'linked' AND i.org_id = $1
          ORDER BY l.local_user_id ASC
          LIMIT 20`,
        [orgId],
      )

      const rows = []
      let changedCount = 0
      for (const { local_user_id: userId } of sample.rows) {
        // both legs run the REAL resolver — current = real probe; candidate = preview override
        const before = await resolveApprovalRequesterOrgRelations(userId, query)
        const after = await resolveApprovalRequesterOrgRelations(userId, query, {
          overrideCanonicalIntegrationId: candidate,
        })
        const pick = (r: typeof before) => ({
          departmentName: r.primaryDepartmentName ?? null,
          title: r.primaryTitle ?? null,
          managerId: r.managerId ?? null,
          deptHeadId: r.deptHeadId ?? null,
        })
        const b = pick(before)
        const a = pick(after)
        const changed = JSON.stringify(b) !== JSON.stringify(a)
        if (changed) changedCount++
        rows.push({ userId, changed, before: b, after: a })
      }

      // READ-ONLY by design (Lock 3 / Q5): no policy write, no audit — a pure GET report.
      jsonOk(res, {
        orgId,
        purpose,
        current: currentPolicy
          ? { source: 'policy', canonicalIntegrationId: currentPolicy.canonical_integration_id }
          : { source: 'legacy-default' },
        candidate: { integrationId: candidate, provider: integration.provider },
        sampleSize: rows.length,
        changedCount,
        rows,
      })
    } catch (error) {
      logger.error(`Failed to preview routing policy: ${error instanceof Error ? error.message : 'unknown'}`)
      jsonError(res, 500, 'ROUTING_POLICY_PREVIEW_FAILED', 'Failed to compute the routing preview')
    }
  })

  return router
}
