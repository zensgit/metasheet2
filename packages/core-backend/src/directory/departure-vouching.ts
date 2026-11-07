/**
 * Departure vouching — the single definition of "another source still vouches for this person".
 *
 * A person is vouched for when another directory account is linked to them
 * (`directory_account_links.link_status = 'linked'`), is active (`directory_accounts.is_active`),
 * and is not in the exclusion set the caller names. Only directory accounts vouch: identities,
 * login grants, sessions and tokens never do. The scope decides which accounts are counted:
 *
 *   - global       every account;
 *   - org          accounts whose integration belongs to one organization;
 *   - legacy login accounts whose integration has one `(provider, corp_id)`;
 *   - strict login accounts whose integration is in a set of connection ids.
 *
 * Every variant can additionally be restricted to non-local accounts (`provider <> 'local'`);
 * that restriction exists for observability only and never takes part in a decision.
 *
 * Each builder returns a complete `EXISTS (…)` expression. Callers write `NOT <expression>`
 * where they need "nobody vouches". Placeholder ordinals are always passed in explicitly — the
 * builders never count — so a caller's statement stays densely numbered and binds exactly the
 * parameters it references. The exclusion set is bound on every statement, as a non-NULL
 * `uuid[]`; `x <> ALL(NULL)` is NULL and would make the whole expression silently false.
 * `bindProspectiveAccountIds` produces that value and refuses anything that is not an array.
 *
 * Source authority (which integration is the primary source of an organization) is added here
 * as one more clause when it exists, so no caller changes.
 */

type VouchingCommon = {
  /**
   * SQL reference to the person: a qualified column (`l.local_user_id`) or a typed placeholder
   * (`$1::text`).
   */
  user: string
  /** Ordinal of the placeholder bound to the exclusion set (`uuid[]`). */
  prospectiveParam: number
  /** Count only accounts whose integration provider is not `local`. Observability only. */
  nonLocalOnly?: boolean
}

export type OrgVouchingInput = VouchingCommon & { orgParam: number }
export type LegacyLoginVouchingInput = VouchingCommon & { providerParam: number; corpParam: number }
export type StrictLoginVouchingInput = VouchingCommon & { connectionIdsParam: number }
export type GlobalVouchingInput = VouchingCommon

/** Aliases are fixed; callers' own statements never use these names, so a correlated reference stays unambiguous. */
const LINK_ALIAS = 'sibling_link'
const ACCOUNT_ALIAS = 'sibling'
const INTEGRATION_ALIAS = 'sibling_integration'

const USER_REFERENCE = /^(?:\$([1-9][0-9]{0,2})::text|[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)$/

function vouchingError(message: string): Error {
  const error = new Error(message)
  ;(error as Error & { code?: string }).code = 'DEPARTURE_VOUCHING_INVALID_INPUT'
  return error
}

function ordinal(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 999) {
    throw vouchingError(`departure vouching ${label} must be a placeholder ordinal`)
  }
  return value
}

function userReference(value: unknown): { sql: string; ordinal: number | null } {
  if (typeof value !== 'string') {
    throw vouchingError('departure vouching user reference must be a column or typed placeholder')
  }
  const match = USER_REFERENCE.exec(value)
  if (!match) {
    throw vouchingError('departure vouching user reference must be a column or typed placeholder')
  }
  return { sql: value, ordinal: match[1] ? Number(match[1]) : null }
}

function assertDistinct(ordinals: number[]): void {
  if (new Set(ordinals).size !== ordinals.length) {
    throw vouchingError('departure vouching placeholder ordinals must be distinct')
  }
}

function build(
  common: VouchingCommon,
  scopeOrdinals: number[],
  scopeClause: (ordinals: number[]) => string | null,
): string {
  const user = userReference(common.user)
  const prospective = ordinal(common.prospectiveParam, 'exclusion-set ordinal')
  const scope = scopeOrdinals.map((value) => ordinal(value, 'scope ordinal'))
  assertDistinct([
    ...(user.ordinal === null ? [] : [user.ordinal]),
    prospective,
    ...scope,
  ])
  const clauses = [
    `${LINK_ALIAS}.local_user_id = ${user.sql}`,
    `${LINK_ALIAS}.link_status = 'linked'`,
    `${ACCOUNT_ALIAS}.is_active = TRUE`,
    `${ACCOUNT_ALIAS}.id <> ALL($${prospective}::uuid[])`,
  ]
  const scoped = scopeClause(scope)
  if (scoped) clauses.push(scoped)
  if (common.nonLocalOnly === true) clauses.push(`${INTEGRATION_ALIAS}.provider <> 'local'`)
  return `EXISTS (
         SELECT 1
           FROM directory_account_links ${LINK_ALIAS}
           JOIN directory_accounts ${ACCOUNT_ALIAS}
             ON ${ACCOUNT_ALIAS}.id = ${LINK_ALIAS}.directory_account_id
           JOIN directory_integrations ${INTEGRATION_ALIAS}
             ON ${INTEGRATION_ALIAS}.id = ${ACCOUNT_ALIAS}.integration_id
          WHERE ${clauses.join('\n            AND ')}
       )`
}

/** Any other active linked account, anywhere. */
export function globalVouchExists(input: GlobalVouchingInput): string {
  return build(input, [], () => null)
}

/** Another active linked account whose integration belongs to organization `orgParam`. */
export function orgVouchExists(input: OrgVouchingInput): string {
  return build(input, [input.orgParam], ([org]) => `${INTEGRATION_ALIAS}.org_id = $${org}::text`)
}

/** Another active linked account on an integration with this `(provider, corp_id)`. */
export function legacyLoginScopeVouchExists(input: LegacyLoginVouchingInput): string {
  return build(
    input,
    [input.providerParam, input.corpParam],
    ([provider, corp]) =>
      `${INTEGRATION_ALIAS}.provider = $${provider}::text\n            AND ${INTEGRATION_ALIAS}.corp_id = $${corp}::text`,
  )
}

/** Another active linked account on one of the integrations in `connectionIdsParam`. */
export function strictLoginScopeVouchExists(input: StrictLoginVouchingInput): string {
  return build(
    input,
    [input.connectionIdsParam],
    ([connectionIds]) => `${INTEGRATION_ALIAS}.id = ANY($${connectionIds}::uuid[])`,
  )
}

/**
 * The value bound to the exclusion-set placeholder. Accounts the caller treats as deactivated
 * together; ids are trimmed, de-duplicated and blanks dropped. Anything that is not an array is
 * refused (a NULL here would turn every vouching expression false).
 */
export function bindProspectiveAccountIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw vouchingError('departure vouching exclusion set must be an array of account ids')
  }
  return Array.from(
    new Set(
      value
        .map((accountId) => String(accountId ?? '').trim())
        .filter(Boolean),
    ),
  )
}

/** The exclusion set of a statement that excludes no account. */
export function noProspectiveDeactivation(): string[] {
  return bindProspectiveAccountIds([])
}
