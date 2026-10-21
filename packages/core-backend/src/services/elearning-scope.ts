import { randomUUID } from 'node:crypto'
import {
  ElearningAudienceResolverError,
  validateElearningAudienceRules,
  type ElearningAudienceRuleInput,
} from './elearning-audience-resolver'

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

export type ElearningScopeRuleInput = ElearningAudienceRuleInput

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

export async function setElearningCourseScope(
  db: ElearningScopeDb,
  input: SetElearningCourseScopeInput,
): Promise<SetElearningCourseScopeResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const courseId = requireUuid(input.courseId)
  const reason = requireText(input.reason)

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

      const rules = await validateElearningAudienceRules(tx, {
        orgId,
        rules: input.rules,
      })

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
           ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ruleId,
            orgId,
            revisionId,
            rule.subjectType,
            rule.subjectRef,
            rule.includeChildren,
          ],
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
      if (error instanceof ElearningAudienceResolverError) {
        if (error.code === 'invalid_input') fail('invalid_input')
        if (error.code === 'subject_not_found') fail('subject_not_found')
        if (error.code === 'unsupported_subject') fail('unsupported_subject')
      }
      fail('unavailable')
    }
  })
}
