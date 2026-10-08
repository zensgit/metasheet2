import type { ApprovalAssigneeSource, ApprovalNodeConfig, RuntimeGraph } from '../types/approval-product'
import type { ApprovalGraphAssignmentResolver } from './ApprovalGraphExecutor'

export interface ApprovalDesignatedFallbackTargets {
  userIds: Set<string>
  roleIds: Set<string>
}

export interface ApprovalDesignatedFallbackEligibility {
  userIds: ReadonlySet<string>
  roleIds: ReadonlySet<string>
}

export interface ApprovalDesignatedFallbackEligibilitySnapshot {
  userIds: string[]
  roleIds: string[]
}

const DESIGNATED_FALLBACK_ELIGIBILITY_KEY = 'designatedFallbackEligibility'

interface ApprovalEligibilityQuery {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
}

/** Collect only the ids used by Lock-4's designated empty-assignee fallback. */
export function collectApprovalDesignatedFallbackTargets(
  runtimeGraph: RuntimeGraph,
): ApprovalDesignatedFallbackTargets {
  const userIds = new Set<string>()
  const roleIds = new Set<string>()

  for (const node of runtimeGraph.nodes) {
    if (node.type !== 'approval') continue
    const config = node.config as ApprovalNodeConfig
    if (config.emptyAssigneePolicy !== 'designated') continue
    const fallback = config.emptyAssigneeFallback
    for (const userId of fallback?.userIds ?? []) {
      const normalized = userId.trim()
      if (normalized) userIds.add(normalized)
    }
    for (const roleId of fallback?.roleIds ?? []) {
      const normalized = roleId.trim()
      if (normalized) roleIds.add(normalized)
    }
  }

  return { userIds, roleIds }
}

/**
 * Resolve eligibility once at create/preview assembly, before entering the pure graph executor.
 * An unknown database state rejects the surrounding operation; it is never interpreted as an
 * empty or eligible directory.
 */
export async function loadApprovalDesignatedFallbackEligibility(
  queryable: ApprovalEligibilityQuery,
  runtimeGraph: RuntimeGraph,
): Promise<ApprovalDesignatedFallbackEligibility | undefined> {
  const targets = collectApprovalDesignatedFallbackTargets(runtimeGraph)
  if (targets.userIds.size === 0 && targets.roleIds.size === 0) return undefined

  const eligibleUserIds = new Set<string>()
  if (targets.userIds.size > 0) {
    const result = await queryable.query(
      `SELECT id
         FROM users
        WHERE id = ANY($1::text[])
          AND is_active = TRUE`,
      [[...targets.userIds]],
    )
    for (const row of result.rows) {
      if (typeof row.id === 'string') eligibleUserIds.add(row.id)
    }
  }

  const eligibleRoleIds = new Set<string>()
  if (targets.roleIds.size > 0) {
    const result = await queryable.query(
      `SELECT DISTINCT ur.role_id
         FROM user_roles ur
         JOIN users u ON u.id = ur.user_id
        WHERE ur.role_id = ANY($1::text[])
          AND u.is_active = TRUE`,
      [[...targets.roleIds]],
    )
    for (const row of result.rows) {
      if (typeof row.role_id === 'string') eligibleRoleIds.add(row.role_id)
    }
  }

  return { userIds: eligibleUserIds, roleIds: eligibleRoleIds }
}

export function serializeApprovalDesignatedFallbackEligibility(
  eligibility: ApprovalDesignatedFallbackEligibility | undefined,
): ApprovalDesignatedFallbackEligibilitySnapshot | undefined {
  if (!eligibility) return undefined
  return {
    userIds: [...eligibility.userIds].sort(),
    roleIds: [...eligibility.roleIds].sort(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFrozenIds(value: unknown, allowedIds: ReadonlySet<string>): Set<string> | null {
  if (!Array.isArray(value)) return null
  const ids = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !candidate || candidate !== candidate.trim()) return null
    if (!allowedIds.has(candidate)) return null
    ids.add(candidate)
  }
  return ids
}

/**
 * Read the create-time eligibility snapshot used by every later node activation. Missing,
 * malformed, or graph-inconsistent snapshots fail closed to an empty eligible set. This protects
 * legacy rows without the snapshot and prevents metadata tampering from authorizing a new target.
 */
export function readApprovalDesignatedFallbackEligibilitySnapshot(
  runtimeGraph: RuntimeGraph,
  metadata: Record<string, unknown> | null | undefined,
): ApprovalDesignatedFallbackEligibility | undefined {
  const targets = collectApprovalDesignatedFallbackTargets(runtimeGraph)
  if (targets.userIds.size === 0 && targets.roleIds.size === 0) return undefined

  const empty = (): ApprovalDesignatedFallbackEligibility => ({
    userIds: new Set<string>(),
    roleIds: new Set<string>(),
  })
  if (!metadata) return empty()
  const rawSnapshot = metadata[DESIGNATED_FALLBACK_ELIGIBILITY_KEY]
  if (!isRecord(rawSnapshot)) return empty()

  const userIds = readFrozenIds(rawSnapshot.userIds, targets.userIds)
  const roleIds = readFrozenIds(rawSnapshot.roleIds, targets.roleIds)
  if (!userIds || !roleIds) return empty()
  return { userIds, roleIds }
}

/**
 * Filter the synthetic designated sources before the existing resolver applies delegation,
 * same-person policy, metadata, and deduplication. Ordinary static sources never use this wrapper.
 */
export function buildApprovalDesignatedFallbackResolver(
  baseResolver: ApprovalGraphAssignmentResolver,
  eligibility: ApprovalDesignatedFallbackEligibility | undefined,
): ApprovalGraphAssignmentResolver | undefined {
  if (!eligibility) return undefined

  return (input) => {
    const assigneeSources: ApprovalAssigneeSource[] = []
    for (const source of input.config.assigneeSources ?? []) {
      if (source.kind === 'static_user') {
        const userIds = source.userIds.filter((userId) => eligibility.userIds.has(userId))
        if (userIds.length > 0) assigneeSources.push({ ...source, userIds })
        continue
      }
      if (source.kind === 'static_role') {
        const roleIds = source.roleIds.filter((roleId) => eligibility.roleIds.has(roleId))
        if (roleIds.length > 0) assigneeSources.push({ ...source, roleIds })
      }
    }
    return baseResolver({
      ...input,
      config: { ...input.config, assigneeSources },
    })
  }
}
