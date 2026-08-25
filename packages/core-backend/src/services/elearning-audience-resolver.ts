/**
 * Authoritative e-learning audience resolution.
 *
 * Audience rules carry selectors, never membership claims. Every match is
 * derived from current, same-org database state. RBAC token claims are not an
 * input to this module.
 */

export const ELEARNING_AUDIENCE_SUBJECT_TYPES = [
  'all',
  'department',
  'position',
  'role',
  'user',
] as const

export type ElearningAudienceSubjectType =
  (typeof ELEARNING_AUDIENCE_SUBJECT_TYPES)[number]

export const ELEARNING_AUDIENCE_RULE_SCAN_LIMIT = 10_000 as const

export type ElearningAudienceRuleInput =
  | { subjectType: 'all'; subjectRef?: null; includeChildren?: false }
  | { subjectType: 'department'; subjectRef: string; includeChildren?: boolean }
  | { subjectType: 'position'; subjectRef: string; includeChildren?: false }
  | { subjectType: 'user'; subjectRef: string; includeChildren?: false }

export type ElearningAudienceRule =
  | { subjectType: 'all'; subjectRef: null; includeChildren: false }
  | {
      subjectType: Exclude<ElearningAudienceSubjectType, 'all'>
      subjectRef: string
      includeChildren: boolean
    }

export type ElearningAudienceResolverErrorCode =
  | 'invalid_input'
  | 'subject_not_found'
  | 'unsupported_subject'
  | 'unavailable'

export class ElearningAudienceResolverError extends Error {
  constructor(readonly code: ElearningAudienceResolverErrorCode) {
    super(code)
    this.name = 'ElearningAudienceResolverError'
  }
}

export interface ElearningAudienceQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningAudienceRuleMatch {
  ruleId: string
  scopeRevisionId: string
}

export interface ElearningAudienceCourseMatch extends ElearningAudienceRuleMatch {
  courseId: string
  courseVersionId: string
}

type StoredRule = ElearningAudienceRule & {
  ruleId: string
  scopeRevisionId: string
}

type MatchInputRule = ElearningAudienceRule & {
  ruleKey: string
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(code: ElearningAudienceResolverErrorCode): never {
  throw new ElearningAudienceResolverError(code)
}

function requireText(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '') fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function storedText(value: unknown): string {
  if (typeof value !== 'string') fail('unavailable')
  const trimmed = value.trim()
  if (trimmed === '') fail('unavailable')
  return trimmed
}

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function isSubjectType(value: unknown): value is ElearningAudienceSubjectType {
  return typeof value === 'string'
    && (ELEARNING_AUDIENCE_SUBJECT_TYPES as readonly string[]).includes(value)
}

function normalizeRules(rules: unknown): ElearningAudienceRule[] {
  // An empty revision is the explicit, auditable "visible to nobody" state.
  if (!Array.isArray(rules) || rules.length > 100) fail('invalid_input')
  const normalized = rules.map((raw): ElearningAudienceRule => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_input')
    const row = raw as Record<string, unknown>
    if (Object.keys(row).some(
      (key) => !['subjectType', 'subjectRef', 'includeChildren'].includes(key),
    )) {
      fail('invalid_input')
    }
    if (!isSubjectType(row.subjectType)) fail('invalid_input')
    // The platform user_roles/roles store has no org_id. A global role row
    // cannot prove the contract's same-org audience semantics.
    if (row.subjectType === 'role') fail('unsupported_subject')
    if (row.subjectType === 'all') {
      if (row.subjectRef !== undefined && row.subjectRef !== null) fail('invalid_input')
      if (row.includeChildren !== undefined && row.includeChildren !== false) {
        fail('invalid_input')
      }
      return { subjectType: 'all', subjectRef: null, includeChildren: false }
    }

    const subjectRef = row.subjectType === 'department'
      ? requireUuid(row.subjectRef)
      : requireText(row.subjectRef)
    if (row.subjectType === 'department') {
      if (row.includeChildren !== undefined && typeof row.includeChildren !== 'boolean') {
        fail('invalid_input')
      }
      return {
        subjectType: 'department',
        subjectRef,
        includeChildren: row.includeChildren === true,
      }
    }
    if (row.includeChildren !== undefined && row.includeChildren !== false) fail('invalid_input')
    return {
      subjectType: row.subjectType,
      subjectRef,
      includeChildren: false,
    }
  })

  normalized.sort((left, right) => {
    const leftKey = `${left.subjectType}:${left.subjectRef ?? ''}`
    const rightKey = `${right.subjectType}:${right.subjectRef ?? ''}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const seen = new Set<string>()
  for (const rule of normalized) {
    const key = `${rule.subjectType}:${rule.subjectRef ?? ''}`
    if (seen.has(key)) fail('invalid_input')
    seen.add(key)
  }
  return normalized
}

function storedRules(rows: Array<Record<string, unknown>>): StoredRule[] {
  return rows.map((row) => {
    const subjectType = row.subject_type
    if (!isSubjectType(subjectType)) fail('unavailable')
    const ruleId = storedUuid(row.rule_id)
    const scopeRevisionId = storedUuid(row.scope_revision_id)
    if (subjectType === 'all') {
      if (row.subject_ref != null || row.include_children !== false) fail('unavailable')
      return {
        ruleId,
        scopeRevisionId,
        subjectType,
        subjectRef: null,
        includeChildren: false,
      }
    }
    if (typeof row.include_children !== 'boolean') fail('unavailable')
    if (subjectType !== 'department' && row.include_children) fail('unavailable')
    const subjectRef = subjectType === 'department'
      ? storedUuid(row.subject_ref)
      : storedText(row.subject_ref)
    return {
      ruleId,
      scopeRevisionId,
      subjectType,
      subjectRef,
      includeChildren: row.include_children,
    }
  })
}

function matchPayload(rules: MatchInputRule[]): string {
  return JSON.stringify(rules.map((rule) => ({
    rule_key: rule.ruleKey,
    subject_type: rule.subjectType,
    subject_ref: rule.subjectRef,
    include_children: rule.includeChildren,
  })))
}

async function resolveMatches(
  db: ElearningAudienceQueryable,
  orgId: string,
  rules: MatchInputRule[],
  userIds?: readonly string[],
): Promise<Map<string, Set<string>>> {
  if (rules.length === 0) return new Map()
  const result = await db.query(
    `/* elearning-audience:resolve-membership */
     WITH RECURSIVE input_rules AS (
       SELECT rule_key, subject_type, subject_ref, include_children
       FROM jsonb_to_recordset($2::jsonb) AS input(
         rule_key text,
         subject_type text,
         subject_ref text,
         include_children boolean
       )
     ),
     eligible_users AS (
       SELECT u.id AS user_id
       FROM users u
       JOIN user_orgs uo
         ON uo.user_id = u.id
        AND uo.org_id = $1
        AND uo.is_active = TRUE
       WHERE u.is_active = TRUE
         AND ($3::text[] IS NULL OR u.id = ANY($3::text[]))
     ),
     department_tree AS (
       SELECT
         input.rule_key,
         input.include_children,
         d.id AS department_id,
         d.integration_id,
         d.external_department_id,
         ARRAY[d.id]::uuid[] AS path
       FROM input_rules input
       JOIN directory_departments d
         ON d.id::text = input.subject_ref
        AND d.is_active = TRUE
       JOIN directory_integrations integration
         ON integration.id = d.integration_id
        AND integration.org_id = $1
        AND integration.status = 'active'
       WHERE input.subject_type = 'department'
       UNION ALL
       SELECT
         parent.rule_key,
         parent.include_children,
         child.id,
         child.integration_id,
         child.external_department_id,
         parent.path || child.id
       FROM department_tree parent
       JOIN directory_departments child
         ON child.integration_id = parent.integration_id
        AND child.external_parent_department_id = parent.external_department_id
        AND child.is_active = TRUE
       WHERE parent.include_children = TRUE
         AND NOT child.id = ANY(parent.path)
     ),
     active_directory_accounts AS (
       SELECT
         link.local_user_id AS user_id,
         account.id AS account_id,
         account.integration_id,
         account.title
       FROM directory_account_links link
       JOIN directory_accounts account
         ON account.id = link.directory_account_id
        AND account.is_active = TRUE
       JOIN directory_integrations integration
         ON integration.id = account.integration_id
        AND integration.org_id = $1
        AND integration.status = 'active'
       JOIN eligible_users eligible ON eligible.user_id = link.local_user_id
       WHERE link.link_status = 'linked'
     ),
     matches AS (
       SELECT input.rule_key, eligible.user_id
       FROM input_rules input
       JOIN eligible_users eligible ON TRUE
       WHERE
         input.subject_type = 'all'
         OR (
           input.subject_type = 'user'
           AND input.subject_ref = eligible.user_id
         )
         OR (
           input.subject_type = 'position'
           AND EXISTS (
             SELECT 1
             FROM active_directory_accounts account
             WHERE account.user_id = eligible.user_id
               AND btrim(account.title) = input.subject_ref
           )
         )
         OR (
           input.subject_type = 'department'
           AND EXISTS (
             SELECT 1
             FROM department_tree department
             JOIN directory_account_departments account_department
               ON account_department.directory_department_id = department.department_id
             JOIN active_directory_accounts account
               ON account.account_id = account_department.directory_account_id
              AND account.integration_id = department.integration_id
             WHERE department.rule_key = input.rule_key
               AND account.user_id = eligible.user_id
           )
         )
     )
     SELECT DISTINCT rule_key, user_id
     FROM matches
     ORDER BY rule_key ASC, user_id ASC`,
    [orgId, matchPayload(rules), userIds ? [...userIds] : null],
  )

  const matches = new Map<string, Set<string>>()
  for (const row of result.rows) {
    const ruleKey = storedText(row.rule_key)
    const userId = storedText(row.user_id)
    const users = matches.get(ruleKey) ?? new Set<string>()
    users.add(userId)
    matches.set(ruleKey, users)
  }
  return matches
}

function asMatchRules(rules: ElearningAudienceRule[]): MatchInputRule[] {
  return rules.map((rule, index) => ({ ...rule, ruleKey: `rule-${index}` }))
}

export async function validateElearningAudienceRules(
  db: ElearningAudienceQueryable,
  input: { orgId: string; rules: unknown },
): Promise<ElearningAudienceRule[]> {
  const orgId = requireText(input.orgId)
  const rules = normalizeRules(input.rules)
  try {
    const userRefs = rules.flatMap((rule) => rule.subjectType === 'user' ? [rule.subjectRef] : [])
    if (userRefs.length > 0) {
      const users = await db.query(
        `/* elearning-audience:validate-users */
         SELECT u.id
         FROM users u
         JOIN user_orgs membership
           ON membership.user_id = u.id
          AND membership.org_id = $1
          AND membership.is_active = TRUE
         WHERE u.id = ANY($2::text[])
           AND u.is_active = TRUE
         ORDER BY u.id ASC
         FOR SHARE OF u, membership`,
        [orgId, userRefs],
      )
      const found = new Set(users.rows.map((row) => storedText(row.id)))
      if (userRefs.some((userRef) => !found.has(userRef))) fail('subject_not_found')
    }

    const departmentRefs = rules.flatMap(
      (rule) => rule.subjectType === 'department' ? [rule.subjectRef] : [],
    )
    if (departmentRefs.length > 0) {
      const departments = await db.query(
        `/* elearning-audience:validate-departments */
         SELECT department.id::text AS id
         FROM directory_departments department
         JOIN directory_integrations integration
           ON integration.id = department.integration_id
          AND integration.org_id = $1
          AND integration.status = 'active'
         WHERE department.id = ANY($2::uuid[])
           AND department.is_active = TRUE
         ORDER BY department.id ASC
         FOR SHARE OF department, integration`,
        [orgId, departmentRefs],
      )
      const found = new Set(departments.rows.map((row) => storedUuid(row.id)))
      if (departmentRefs.some((departmentRef) => !found.has(departmentRef))) {
        fail('subject_not_found')
      }
    }

    const matchRules = asMatchRules(rules.filter(
      (rule) => rule.subjectType === 'position',
    ))
    const matches = await resolveMatches(db, orgId, matchRules)
    for (const rule of matchRules) {
      if (
        rule.subjectType === 'position' && !matches.has(rule.ruleKey)
      ) {
        fail('subject_not_found')
      }
    }
    return rules
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) throw error
    fail('unavailable')
  }
}

export async function resolveElearningAudienceMembers(
  db: ElearningAudienceQueryable,
  input: { orgId: string; rules: unknown },
): Promise<string[]> {
  const orgId = requireText(input.orgId)
  const rules = await validateElearningAudienceRules(db, { orgId, rules: input.rules })
  try {
    const matchRules = asMatchRules(rules)
    const matches = await resolveMatches(db, orgId, matchRules)
    const members = new Set<string>()
    for (const users of matches.values()) {
      for (const userId of users) members.add(userId)
    }
    return [...members].sort()
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) throw error
    fail('unavailable')
  }
}

async function matchStoredRules(
  db: ElearningAudienceQueryable,
  orgId: string,
  userId: string,
  rules: StoredRule[],
  lockDependencies = false,
): Promise<StoredRule[]> {
  if (lockDependencies) {
    await lockAudienceDependencies(db, orgId, userId, rules)
  }
  const matches = await resolveMatches(
    db,
    orgId,
    rules.map((rule) => ({ ...rule, ruleKey: rule.ruleId })),
    [userId],
  )
  return rules.filter((rule) => matches.get(rule.ruleId)?.has(userId))
}

async function lockAudienceDependencies(
  db: ElearningAudienceQueryable,
  orgId: string,
  userId: string,
  rules: StoredRule[],
): Promise<void> {
  await db.query(
    `/* elearning-audience:lock-principal */
     SELECT user_row.id
     FROM users user_row
     JOIN user_orgs membership
       ON membership.user_id = user_row.id
      AND membership.org_id = $1
     WHERE user_row.id = $2
     ORDER BY user_row.id
     FOR SHARE OF user_row, membership`,
    [orgId, userId],
  )

  const dynamicRules = rules.filter(
    (rule) => rule.subjectType === 'department' || rule.subjectType === 'position',
  )
  if (dynamicRules.length === 0) return

  await db.query(
    `/* elearning-audience:lock-directory-accounts */
     SELECT account.id
     FROM directory_account_links link
     JOIN directory_accounts account
       ON account.id = link.directory_account_id
     JOIN directory_integrations integration
       ON integration.id = account.integration_id
      AND integration.org_id = $1
     WHERE link.local_user_id = $2
     ORDER BY account.id
     FOR SHARE OF link, account, integration`,
    [orgId, userId],
  )

  const departmentRules = dynamicRules.filter(
    (rule) => rule.subjectType === 'department',
  )
  if (departmentRules.length === 0) return

  await db.query(
    `/* elearning-audience:lock-departments */
     WITH RECURSIVE input_rules AS (
       SELECT rule_key, subject_ref, include_children
       FROM jsonb_to_recordset($2::jsonb) AS input(
         rule_key text,
         subject_type text,
         subject_ref text,
         include_children boolean
       )
     ),
     department_tree AS (
       SELECT
         input.rule_key,
         input.include_children,
         department.id AS department_id,
         department.integration_id,
         department.external_department_id,
         ARRAY[department.id]::uuid[] AS path
       FROM input_rules input
       JOIN directory_departments department
         ON department.id::text = input.subject_ref
       JOIN directory_integrations integration
         ON integration.id = department.integration_id
        AND integration.org_id = $1
       UNION ALL
       SELECT
         parent.rule_key,
         parent.include_children,
         child.id,
         child.integration_id,
         child.external_department_id,
         parent.path || child.id
       FROM department_tree parent
       JOIN directory_departments child
         ON child.integration_id = parent.integration_id
        AND child.external_parent_department_id = parent.external_department_id
       WHERE parent.include_children = TRUE
         AND NOT child.id = ANY(parent.path)
     )
     SELECT locked_department.id
     FROM department_tree tree
     JOIN directory_departments locked_department
       ON locked_department.id = tree.department_id
     JOIN directory_integrations integration
       ON integration.id = locked_department.integration_id
      AND integration.org_id = $1
     ORDER BY locked_department.id
     FOR SHARE OF locked_department, integration`,
    [
      orgId,
      matchPayload(departmentRules.map((rule) => ({
        ...rule,
        ruleKey: rule.ruleId,
      }))),
    ],
  )
  await db.query(
    `/* elearning-audience:lock-account-departments */
     SELECT account_department.directory_account_id
     FROM directory_account_links link
     JOIN directory_accounts account
       ON account.id = link.directory_account_id
     JOIN directory_integrations integration
       ON integration.id = account.integration_id
      AND integration.org_id = $1
     JOIN directory_account_departments account_department
       ON account_department.directory_account_id = account.id
     WHERE link.local_user_id = $2
     ORDER BY account_department.directory_account_id,
              account_department.directory_department_id
     FOR SHARE OF link, account, integration, account_department`,
    [orgId, userId],
  )
}

export async function matchElearningAudienceRule(
  db: ElearningAudienceQueryable,
  input: { orgId: string; userId: string; scopeRevisionId: string },
): Promise<ElearningAudienceRuleMatch | null> {
  const orgId = requireText(input.orgId)
  const userId = requireText(input.userId)
  const scopeRevisionId = requireUuid(input.scopeRevisionId)
  try {
    const result = await db.query(
      `/* elearning-audience:load-revision-rules */
       SELECT
         rule.id::text AS rule_id,
         rule.scope_revision_id::text AS scope_revision_id,
         rule.subject_type,
         rule.subject_ref,
         rule.include_children
       FROM elearning_scope_revision_rules rule
       WHERE rule.org_id = $1 AND rule.scope_revision_id = $2
       ORDER BY rule.id ASC
       FOR SHARE OF rule`,
      [orgId, scopeRevisionId],
    )
    const rules = storedRules(result.rows)
    const matches = await matchStoredRules(db, orgId, userId, rules, true)
    const first = matches[0]
    return first ? { ruleId: first.ruleId, scopeRevisionId: first.scopeRevisionId } : null
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) throw error
    fail('unavailable')
  }
}

export async function listElearningAudienceCourseMatches(
  db: ElearningAudienceQueryable,
  input: {
    orgId: string
    userId: string
    excludedCourseVersionIds: readonly string[]
    limit: number
  },
): Promise<ElearningAudienceCourseMatch[]> {
  const orgId = requireText(input.orgId)
  const userId = requireText(input.userId)
  const excludedCourseVersionIds = [
    ...new Set(input.excludedCourseVersionIds.map(requireUuid)),
  ].sort()
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
    fail('invalid_input')
  }
  try {
    const result = await db.query(
      `/* elearning-audience:list-course-matches */
       WITH RECURSIVE eligible_user AS (
         SELECT user_row.id AS user_id
         FROM users user_row
         JOIN user_orgs membership
           ON membership.user_id = user_row.id
          AND membership.org_id = $1
          AND membership.is_active = TRUE
         WHERE user_row.id = $2
           AND user_row.is_active = TRUE
       ),
       bounded_course_rules AS (
         SELECT
           course.id AS course_id,
           version.id AS course_version_id,
           rule.id AS rule_id,
           rule.scope_revision_id,
           rule.subject_type,
           rule.subject_ref,
           rule.include_children
         FROM elearning_courses course
         JOIN elearning_course_versions version
           ON version.org_id = course.org_id
          AND version.id = course.active_version_id
          AND version.status = 'published'
         JOIN elearning_scopes scope
           ON scope.org_id = course.org_id
          AND scope.id = course.scope_id
         JOIN elearning_scope_revision_rules rule
           ON rule.org_id = scope.org_id
          AND rule.scope_revision_id = scope.active_revision_id
         WHERE course.org_id = $1
           AND course.status = 'active'
           AND NOT (version.id = ANY($3::uuid[]))
         ORDER BY version.id ASC, rule.id ASC
         LIMIT ${ELEARNING_AUDIENCE_RULE_SCAN_LIMIT + 1}
       ),
       scan_state AS (
         SELECT count(*) > ${ELEARNING_AUDIENCE_RULE_SCAN_LIMIT} AS overflow
         FROM bounded_course_rules
       ),
       active_course_rules AS (
         SELECT *
         FROM bounded_course_rules
         ORDER BY course_version_id ASC, rule_id ASC
         LIMIT ${ELEARNING_AUDIENCE_RULE_SCAN_LIMIT}
       ),
       department_tree AS (
         SELECT
           active.rule_id,
           active.include_children,
           department.id AS department_id,
           department.integration_id,
           department.external_department_id,
           ARRAY[department.id]::uuid[] AS path
         FROM active_course_rules active
         JOIN directory_departments department
           ON department.id::text = active.subject_ref
          AND department.is_active = TRUE
         JOIN directory_integrations integration
           ON integration.id = department.integration_id
          AND integration.org_id = $1
          AND integration.status = 'active'
         WHERE active.subject_type = 'department'
         UNION ALL
         SELECT
           parent.rule_id,
           parent.include_children,
           child.id,
           child.integration_id,
           child.external_department_id,
           parent.path || child.id
         FROM department_tree parent
         JOIN directory_departments child
           ON child.integration_id = parent.integration_id
          AND child.external_parent_department_id = parent.external_department_id
          AND child.is_active = TRUE
         WHERE parent.include_children = TRUE
           AND NOT child.id = ANY(parent.path)
       ),
       active_directory_accounts AS (
         SELECT
           link.local_user_id AS user_id,
           account.id AS account_id,
           account.integration_id,
           account.title
         FROM directory_account_links link
         JOIN directory_accounts account
           ON account.id = link.directory_account_id
          AND account.is_active = TRUE
         JOIN directory_integrations integration
           ON integration.id = account.integration_id
          AND integration.org_id = $1
          AND integration.status = 'active'
         JOIN eligible_user eligible ON eligible.user_id = link.local_user_id
         WHERE link.link_status = 'linked'
       ),
       matched_rules AS (
         SELECT active.*
         FROM active_course_rules active
         JOIN eligible_user eligible ON TRUE
         WHERE
           active.subject_type = 'all'
           OR (
             active.subject_type = 'user'
             AND active.subject_ref = eligible.user_id
           )
           OR (
             active.subject_type = 'position'
             AND EXISTS (
               SELECT 1
               FROM active_directory_accounts account
               WHERE account.user_id = eligible.user_id
                 AND btrim(account.title) = active.subject_ref
             )
           )
           OR (
             active.subject_type = 'department'
             AND EXISTS (
               SELECT 1
               FROM department_tree department
               JOIN directory_account_departments account_department
                 ON account_department.directory_department_id = department.department_id
               JOIN active_directory_accounts account
                 ON account.account_id = account_department.directory_account_id
                AND account.integration_id = department.integration_id
               WHERE department.rule_id = active.rule_id
                 AND account.user_id = eligible.user_id
             )
           )
       ),
       first_rule_per_version AS (
         SELECT DISTINCT ON (course_version_id)
           course_id,
           course_version_id,
           rule_id,
           scope_revision_id
         FROM matched_rules
         ORDER BY course_version_id ASC, rule_id ASC
       ),
       course_results AS (
         SELECT
           course_id,
           course_version_id,
           rule_id,
           scope_revision_id
         FROM first_rule_per_version
         ORDER BY course_version_id ASC
         LIMIT $4
       )
       SELECT
         FALSE AS scan_overflow,
         course_id::text AS course_id,
         course_version_id::text AS course_version_id,
         rule_id::text AS rule_id,
         scope_revision_id::text AS scope_revision_id
       FROM course_results
       UNION ALL
       SELECT
         TRUE AS scan_overflow,
         NULL::text AS course_id,
         NULL::text AS course_version_id,
         NULL::text AS rule_id,
         NULL::text AS scope_revision_id
       FROM scan_state
       WHERE overflow = TRUE
       ORDER BY scan_overflow DESC, course_version_id ASC NULLS FIRST`,
      [orgId, userId, excludedCourseVersionIds, input.limit],
    )
    if (result.rows.some((row) => row.scan_overflow === true)) fail('unavailable')
    return result.rows.map((row) => ({
      courseId: storedUuid(row.course_id),
      courseVersionId: storedUuid(row.course_version_id),
      ruleId: storedUuid(row.rule_id),
      scopeRevisionId: storedUuid(row.scope_revision_id),
    }))
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) throw error
    fail('unavailable')
  }
}

export async function matchElearningAudienceRuleIds(
  db: ElearningAudienceQueryable,
  input: { orgId: string; userId: string; ruleIds: readonly string[] },
): Promise<string[]> {
  const orgId = requireText(input.orgId)
  const userId = requireText(input.userId)
  const ruleIds = [...new Set(input.ruleIds.map(requireUuid))].sort()
  if (ruleIds.length === 0) return []
  try {
    const result = await db.query(
      `/* elearning-audience:load-rule-ids */
       SELECT
         rule.id::text AS rule_id,
         rule.scope_revision_id::text AS scope_revision_id,
         rule.subject_type,
         rule.subject_ref,
         rule.include_children
       FROM elearning_scope_revision_rules rule
       WHERE rule.org_id = $1 AND rule.id = ANY($2::uuid[])
       ORDER BY rule.id ASC
       FOR SHARE OF rule`,
      [orgId, ruleIds],
    )
    const matches = await matchStoredRules(db, orgId, userId, storedRules(result.rows))
    return matches.map((rule) => rule.ruleId)
  } catch (error) {
    if (error instanceof ElearningAudienceResolverError) throw error
    fail('unavailable')
  }
}
