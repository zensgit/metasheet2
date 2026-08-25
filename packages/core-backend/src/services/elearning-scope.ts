import { randomUUID } from 'node:crypto'

export type ElearningScopeErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'subject_not_found'
  | 'unsupported_subject'
  | 'unavailable'

export class ElearningScopeError extends Error {
  constructor(readonly code: ElearningScopeErrorCode) {
    super(code)
    this.name = 'ElearningScopeError'
  }
}

export interface ElearningScopeQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningScopeDb extends ElearningScopeQueryable {
  transaction<T>(fn: (tx: ElearningScopeQueryable) => Promise<T>): Promise<T>
}

export type ElearningScopeRuleInput =
  | { subjectType: 'all'; subjectRef?: null; includeChildren?: false }
  | { subjectType: 'user'; subjectRef: string; includeChildren?: false }

export interface SetElearningCourseScopeInput {
  orgId: string
  actorId: string
  courseId: string
  reason: string
  rules: ElearningScopeRuleInput[]
}

export interface SetElearningCourseScopeResult {
  courseId: string
  scopeId: string
  revisionId: string
  revision: number
  ruleIds: string[]
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function fail(code: ElearningScopeErrorCode): never {
  throw new ElearningScopeError(code)
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

function storedUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('unavailable')
  return value.toLowerCase()
}

function normalizeRules(rules: unknown): ElearningScopeRuleInput[] {
  // An empty revision is the explicit, auditable "visible to nobody" state.
  if (!Array.isArray(rules) || rules.length > 100) fail('invalid_input')
  const normalized = rules.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_input')
    const row = raw as Record<string, unknown>
    const keys = Object.keys(row)
    if (keys.some((key) => !['subjectType', 'subjectRef', 'includeChildren'].includes(key))) {
      fail('invalid_input')
    }
    if (row.includeChildren !== undefined && row.includeChildren !== false) fail('invalid_input')
    if (row.subjectType === 'all') {
      if (row.subjectRef !== undefined && row.subjectRef !== null) fail('invalid_input')
      return { subjectType: 'all' as const, subjectRef: null, includeChildren: false as const }
    }
    if (row.subjectType === 'user') {
      return {
        subjectType: 'user' as const,
        subjectRef: requireText(row.subjectRef),
        includeChildren: false as const,
      }
    }
    if (['department', 'position', 'role'].includes(String(row.subjectType))) {
      fail('unsupported_subject')
    }
    fail('invalid_input')
  })

  normalized.sort((left, right) => {
    const leftKey = `${left.subjectType}:${left.subjectRef ?? ''}`
    const rightKey = `${right.subjectType}:${right.subjectRef ?? ''}`
    return leftKey.localeCompare(rightKey)
  })
  const seen = new Set<string>()
  for (const rule of normalized) {
    const key = `${rule.subjectType}:${rule.subjectRef ?? ''}`
    if (seen.has(key)) fail('invalid_input')
    seen.add(key)
  }
  return normalized
}

export async function setElearningCourseScope(
  db: ElearningScopeDb,
  input: SetElearningCourseScopeInput,
): Promise<SetElearningCourseScopeResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const courseId = requireUuid(input.courseId)
  const reason = requireText(input.reason)
  const rules = normalizeRules(input.rules)

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-scope:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`elearning-scope:${orgId}:${courseId}`],
      )
      const course = await tx.query(
        `/* elearning-scope:lock-course */
         SELECT scope_id
           FROM elearning_courses
          WHERE org_id = $1 AND id = $2
          FOR UPDATE`,
        [orgId, courseId],
      )
      if (!course.rows[0]) fail('not_found')

      const userRefs = rules.flatMap((rule) =>
        rule.subjectType === 'user' ? [rule.subjectRef] : [],
      )
      if (userRefs.length > 0) {
        const memberships = await tx.query(
          `/* elearning-scope:load-user-subjects */
           SELECT uo.user_id
             FROM user_orgs uo
             JOIN users u ON u.id = uo.user_id
            WHERE uo.org_id = $1
              AND uo.user_id = ANY($2::text[])
              AND uo.is_active = TRUE
              AND u.is_active = TRUE
            ORDER BY uo.user_id
            FOR SHARE OF u, uo`,
          [orgId, userRefs],
        )
        const resolved = new Set(memberships.rows.map((row) => row.user_id))
        if (
          resolved.size !== userRefs.length
          || userRefs.some((userRef) => !resolved.has(userRef))
        ) {
          fail('subject_not_found')
        }
      }

      let scopeId: string
      if (course.rows[0].scope_id == null) {
        scopeId = randomUUID()
        await tx.query(
          `/* elearning-scope:insert-head */
           INSERT INTO elearning_scopes (id, org_id, created_by)
           VALUES ($1, $2, $3)`,
          [scopeId, orgId, actorId],
        )
        const attached = await tx.query(
          `/* elearning-scope:attach-course */
           UPDATE elearning_courses
              SET scope_id = $1,
                  updated_at = clock_timestamp()
            WHERE org_id = $2 AND id = $3 AND scope_id IS NULL`,
          [scopeId, orgId, courseId],
        )
        if (attached.rowCount !== 1) fail('unavailable')
      } else {
        scopeId = storedUuid(course.rows[0].scope_id)
        const locked = await tx.query(
          `/* elearning-scope:lock-head */
           SELECT id
             FROM elearning_scopes
            WHERE org_id = $1 AND id = $2
            FOR UPDATE`,
          [orgId, scopeId],
        )
        if (!locked.rows[0]) fail('unavailable')
      }

      const latest = await tx.query(
        `/* elearning-scope:next-revision */
         SELECT COALESCE(MAX(revision), 0)::integer AS revision
           FROM elearning_scope_revisions
          WHERE org_id = $1 AND scope_id = $2`,
        [orgId, scopeId],
      )
      const previous = latest.rows[0]?.revision
      if (typeof previous !== 'number' || !Number.isSafeInteger(previous) || previous < 0) {
        fail('unavailable')
      }
      const revision = previous + 1
      const revisionId = randomUUID()
      await tx.query(
        `/* elearning-scope:insert-revision */
         INSERT INTO elearning_scope_revisions (
           id, org_id, scope_id, revision, actor_id, reason
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [revisionId, orgId, scopeId, revision, actorId, reason],
      )

      const ruleIds: string[] = []
      for (const rule of rules) {
        const ruleId = randomUUID()
        ruleIds.push(ruleId)
        await tx.query(
          `/* elearning-scope:insert-rule */
           INSERT INTO elearning_scope_revision_rules (
             id, org_id, scope_revision_id, subject_type, subject_ref, include_children
           ) VALUES ($1, $2, $3, $4, $5, FALSE)`,
          [ruleId, orgId, revisionId, rule.subjectType, rule.subjectRef ?? null],
        )
      }

      const activated = await tx.query(
        `/* elearning-scope:activate */
         UPDATE elearning_scopes
            SET active_revision_id = $1,
                latest_revision_id = $1,
                updated_at = clock_timestamp()
          WHERE org_id = $2 AND id = $3`,
        [revisionId, orgId, scopeId],
      )
      if (activated.rowCount !== 1) fail('unavailable')
      return { courseId, scopeId, revisionId, revision, ruleIds }
    } catch (error) {
      if (error instanceof ElearningScopeError) throw error
      fail('unavailable')
    }
  })
}
