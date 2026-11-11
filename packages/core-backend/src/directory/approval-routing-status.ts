/**
 * Read-only approval-routing status of one organisation, for the routing-policy admin view.
 *
 * Invariants:
 *  - Read-only: every statement is a SELECT issued through the injected `query`; nothing is written.
 *  - Values-free: the block carries counts, booleans, integration ids, provider names, operator
 *    labels and statuses. It never carries an enterprise id, an application key, any other part of
 *    an integration's configuration, or anything about an account or a user.
 *  - `policyRequired`, `hasPolicy` and `activePullSourceCount` are pure data judgements taken from
 *    the pull-source rule module; `enforced` is the state of the require-policy switch. The block is
 *    the same shape whether the switch is on or off.
 *  - What counts as a pull-type integration, as a pull source and as a non-active pull-type
 *    integration is defined once, in the pull-source rule module. The statements here are assembled
 *    from its fragments and do not restate those conditions.
 *  - Any failed read (the source count included) rejects: the caller omits the whole block rather
 *    than present a partial one.
 */
import { readDirectoryIdentityStatus, readDirectoryIntegrationAppKey, type DirectoryIdentityStatus } from './integration-identity'
import {
  isApprovalRoutingPolicyRequired,
  isApprovalRoutingRequirePolicyEnabled,
  nonActivePullTypePredicateSql,
  pullTypePredicateSql,
  type PullSourceRuleQuery,
} from './pull-source-rule'

export interface ApprovalRoutingCandidate {
  integrationId: string
  provider: string
  /** Operator-entered label of the integration. */
  name: string
  status: string
}

/** Several integration rows of one provider that name the same external enterprise. */
export interface ApprovalRoutingSameCorpGroup {
  provider: string
  rowCount: number
  /** True when the rows do not all carry the same application key. */
  appKeysDiffer: boolean
  /** Identity status of each row, sorted; one entry per row. */
  identityStatuses: DirectoryIdentityStatus[]
}

export interface ApprovalRoutingStatus {
  /** State of the require-policy switch at the time of the read. */
  enforced: boolean
  hasPolicy: boolean
  activePullSourceCount: number
  /** Two or more active pull sources and no approval-routing policy. Does not depend on the switch. */
  policyRequired: boolean
  /** Active integrations of the organisation: the rows a policy may name as canonical. */
  candidates: ApprovalRoutingCandidate[]
  sameCorpGroups: ApprovalRoutingSameCorpGroup[]
  /**
   * Linked, active accounts under pull-type integrations that are not active. The rule does not
   * count such integrations, while the requester pick still considers these accounts.
   */
  nonActivePullSourceLinkedAccountCount: number
}

export const APPROVAL_ROUTING_CANDIDATES_SQL =
  `SELECT i.id::text AS integration_id, i.provider AS provider, i.name AS name, i.status AS status
     FROM directory_integrations i
    WHERE i.org_id = $1 AND i.status = 'active'
    ORDER BY i.provider ASC, i.name ASC, i.id ASC`

export const APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL =
  `SELECT i.provider AS provider, i.corp_id AS corp_id, i.config AS config
     FROM directory_integrations i
    WHERE i.org_id = $1 AND ${pullTypePredicateSql('i')}
    ORDER BY i.provider ASC, i.corp_id ASC, i.id ASC`

export const NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL =
  `SELECT count(DISTINCT a.id)::int AS linked_account_count
     FROM directory_integrations i
     JOIN directory_accounts a ON a.integration_id = i.id AND a.is_active = true
     JOIN directory_account_links dal ON dal.directory_account_id = a.id AND dal.link_status = 'linked'
    WHERE i.org_id = $1 AND ${nonActivePullTypePredicateSql('i')}`

/** Raised when the account count cannot be read as a non-negative integer; it is never read as zero. */
export class ApprovalRoutingStatusUnavailableError extends Error {
  constructor() {
    super('The approval routing status of this organization is unavailable')
    this.name = 'ApprovalRoutingStatusUnavailableError'
  }
}

function readCount(raw: unknown): number {
  const count = typeof raw === 'number' ? raw : typeof raw === 'string' && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(count) || count < 0) throw new ApprovalRoutingStatusUnavailableError()
  return count
}

/**
 * Groups of two or more pull-type rows with the same `(provider, corp_id)`. Grouping happens here,
 * on rows already read, so the enterprise id and the application key are compared but never leave
 * this function.
 */
export function groupSameCorpRows(
  rows: ReadonlyArray<{ provider: string; corp_id: string; config: unknown }>,
): ApprovalRoutingSameCorpGroup[] {
  const groups = new Map<string, { provider: string; corpId: string; appKeys: Set<string>; statuses: DirectoryIdentityStatus[] }>()
  for (const row of rows) {
    const key = JSON.stringify([row.provider, row.corp_id])
    const group = groups.get(key) ?? { provider: row.provider, corpId: row.corp_id, appKeys: new Set<string>(), statuses: [] }
    group.appKeys.add(readDirectoryIntegrationAppKey(row.config))
    group.statuses.push(readDirectoryIdentityStatus({ corpId: row.corp_id, config: row.config }))
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter((group) => group.statuses.length > 1)
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.corpId.localeCompare(right.corpId))
    .map((group) => ({
      provider: group.provider,
      rowCount: group.statuses.length,
      appKeysDiffer: group.appKeys.size > 1,
      identityStatuses: [...group.statuses].sort(),
    }))
}

export async function readApprovalRoutingStatus(query: PullSourceRuleQuery, orgId: string): Promise<ApprovalRoutingStatus> {
  const rule = await isApprovalRoutingPolicyRequired(query, orgId)
  const candidates = await query(APPROVAL_ROUTING_CANDIDATES_SQL, [orgId])
  const pullTypeRows = await query(APPROVAL_ROUTING_PULL_TYPE_ROWS_SQL, [orgId])
  const linkedAccounts = await query(NON_ACTIVE_PULL_SOURCE_LINKED_ACCOUNT_COUNT_SQL, [orgId])
  return {
    enforced: isApprovalRoutingRequirePolicyEnabled(),
    hasPolicy: rule.hasPolicy,
    activePullSourceCount: rule.sourceCount,
    policyRequired: rule.required,
    candidates: candidates.rows.map((row) => ({
      integrationId: String(row.integration_id),
      provider: String(row.provider),
      name: String(row.name),
      status: String(row.status),
    })),
    sameCorpGroups: groupSameCorpRows(pullTypeRows.rows.map((row) => ({
      provider: String(row.provider),
      corp_id: String(row.corp_id),
      config: row.config,
    }))),
    nonActivePullSourceLinkedAccountCount: readCount(linkedAccounts.rows[0]?.linked_account_count),
  }
}
