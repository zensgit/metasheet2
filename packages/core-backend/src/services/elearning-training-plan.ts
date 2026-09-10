import { createHash, randomUUID } from 'node:crypto'

export const ELEARNING_TRAINING_PLAN_REQUEST_DOMAIN =
  'elearning.training-plan.publish.request.v1' as const
export const ELEARNING_TRAINING_PLAN_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_TRAINING_PLAN_TITLE_MAX = 200
export const ELEARNING_TRAINING_PLAN_ITEM_MAX = 100
export const ELEARNING_TRAINING_PLAN_ACTOR_MAX = 256

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INPUT_KEYS = ['orgId', 'actorId', 'requestId', 'title', 'items'] as const
const ITEM_KEYS = ['courseVersionId', 'required'] as const
const REQUEST_SOURCE_KEY_UNIQ = 'elearning_training_plan_requests_org_source_uniq'

export type ElearningTrainingPlanErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'course_unavailable'
  | 'conflict'
  | 'unavailable'

export class ElearningTrainingPlanError extends Error {
  constructor(readonly code: ElearningTrainingPlanErrorCode) {
    super(code)
    this.name = 'ElearningTrainingPlanError'
  }
}

export interface ElearningTrainingPlanQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningTrainingPlanDb extends ElearningTrainingPlanQueryable {
  transaction<T>(
    handler: (tx: ElearningTrainingPlanQueryable) => Promise<T>,
  ): Promise<T>
}

export interface PublishElearningTrainingPlanItem {
  courseVersionId: string
  required: boolean
}

export interface PublishElearningTrainingPlanInput {
  orgId: string
  actorId: string
  requestId: string
  title: string
  items: PublishElearningTrainingPlanItem[]
}

export interface ElearningTrainingPlanPublishResult {
  planId: string
  planVersionId: string
  status: 'published'
  itemCount: number
  duplicate: boolean
}

export interface GetElearningTrainingPlanInput {
  orgId: string
  planId: string
}

export interface ElearningTrainingPlanItem {
  courseVersionId: string
  position: number
  required: boolean
}

export interface ElearningTrainingPlan {
  planId: string
  title: string
  status: 'active' | 'archived'
  activeVersion: {
    planVersionId: string
    version: number
    status: 'published'
    items: ElearningTrainingPlanItem[]
  }
}

interface CanonicalTrainingPlanInput {
  orgId: string
  actorId: string
  requestId: string
  title: string
  items: PublishElearningTrainingPlanItem[]
}

function fail(code: ElearningTrainingPlanErrorCode): never {
  throw new ElearningTrainingPlanError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  const allowed = new Set(required)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid_input')
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail('invalid_input')
  }
}

function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('invalid_input')
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > max) fail('invalid_input')
  return trimmed
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asSafeInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null
    }
    return Number(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function deepSortedJson(value: unknown): string {
  const walk = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(walk)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.keys(entry as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((entry as Record<string, unknown>)[key])]),
      )
    }
    return entry
  }
  return JSON.stringify(walk(value))
}

export function canonicalizeElearningTrainingPlanInput(
  input: unknown,
): CanonicalTrainingPlanInput {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input, INPUT_KEYS)
  const orgId = requireText(input.orgId, ELEARNING_TRAINING_PLAN_ACTOR_MAX)
  const actorId = requireText(input.actorId, ELEARNING_TRAINING_PLAN_ACTOR_MAX)
  const requestId = requireUuid(input.requestId)
  const title = requireText(input.title, ELEARNING_TRAINING_PLAN_TITLE_MAX)
  if (
    !Array.isArray(input.items)
    || input.items.length < 1
    || input.items.length > ELEARNING_TRAINING_PLAN_ITEM_MAX
  ) {
    fail('invalid_input')
  }
  const seen = new Set<string>()
  const items = input.items.map((raw) => {
    if (!isPlainObject(raw)) fail('invalid_input')
    requireExactKeys(raw, ITEM_KEYS)
    const courseVersionId = requireUuid(raw.courseVersionId)
    if (seen.has(courseVersionId) || typeof raw.required !== 'boolean') {
      fail('invalid_input')
    }
    seen.add(courseVersionId)
    return { courseVersionId, required: raw.required }
  })
  return { orgId, actorId, requestId, title, items }
}

function canonicalizeRequestV1(input: CanonicalTrainingPlanInput): string {
  return deepSortedJson({
    domain: ELEARNING_TRAINING_PLAN_REQUEST_DOMAIN,
    items: input.items,
    title: input.title,
    version: 1,
  })
}

export function canonicalizeElearningTrainingPlanRequest(
  input: CanonicalTrainingPlanInput,
): string {
  return canonicalizeRequestV1(input)
}

export function hashElearningTrainingPlanRequestAtVersion(
  input: CanonicalTrainingPlanInput,
  version: number,
): string {
  if (version !== 1) fail('unavailable')
  return createHash('sha256')
    .update(canonicalizeRequestV1(input), 'utf8')
    .digest('hex')
}

export function hashElearningTrainingPlanRequest(
  input: CanonicalTrainingPlanInput,
): string {
  return hashElearningTrainingPlanRequestAtVersion(
    input,
    ELEARNING_TRAINING_PLAN_REQUEST_HASH_VERSION,
  )
}

export function elearningTrainingPlanLockKey(
  orgId: string,
  requestId: string,
): string {
  return `elearning-training-plan:${orgId}:${requestId}`
}

function isSourceKeyUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === '23505'
    && (error as { constraint?: unknown }).constraint === REQUEST_SOURCE_KEY_UNIQ,
  )
}

function publishResultFromLedger(
  row: Record<string, unknown>,
  duplicate: boolean,
): ElearningTrainingPlanPublishResult {
  const planId = asText(row.training_plan_id)
  const planVersionId = asText(row.training_plan_version_id)
  const itemCount = asSafeInt(row.item_count)
  if (!planId || !planVersionId || itemCount === null || itemCount < 1) {
    fail('unavailable')
  }
  return {
    planId,
    planVersionId,
    status: 'published',
    itemCount,
    duplicate,
  }
}

export async function publishElearningTrainingPlan(
  db: ElearningTrainingPlanDb,
  input: PublishElearningTrainingPlanInput,
): Promise<ElearningTrainingPlanPublishResult> {
  const canonical = canonicalizeElearningTrainingPlanInput(input)
  const requestHash = hashElearningTrainingPlanRequest(canonical)
  const planId = randomUUID()
  const planVersionId = randomUUID()
  const requestRowId = randomUUID()

  return db.transaction(async (tx) => {
    try {
      await tx.query(
        `/* elearning-training-plan:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [elearningTrainingPlanLockKey(canonical.orgId, canonical.requestId)],
      )

      const existing = await tx.query(
        `/* elearning-training-plan:load-request */
         SELECT training_plan_id, training_plan_version_id, item_count,
                request_hash, request_hash_version
           FROM elearning_training_plan_publish_requests
          WHERE org_id = $1 AND source_key = $2
          FOR UPDATE`,
        [canonical.orgId, canonical.requestId],
      )
      const existingRow = existing.rows[0]
      if (existingRow) {
        const storedHash = asText(existingRow.request_hash)
        const storedVersion = asSafeInt(existingRow.request_hash_version)
        if (!storedHash || storedVersion === null) fail('unavailable')
        if (
          hashElearningTrainingPlanRequestAtVersion(canonical, storedVersion)
          !== storedHash
        ) {
          fail('conflict')
        }
        return publishResultFromLedger(existingRow, true)
      }

      const courseVersionIds = canonical.items.map((item) => item.courseVersionId)
      const available = await tx.query(
        `/* elearning-training-plan:lock-course-versions */
         SELECT cv.id
           FROM elearning_course_versions cv
           JOIN elearning_courses c
             ON c.org_id = cv.org_id AND c.id = cv.course_id
          WHERE cv.org_id = $1
            AND cv.id = ANY($2::uuid[])
            AND cv.status = 'published'
            AND c.status = 'active'
          ORDER BY cv.id
          FOR SHARE OF cv, c`,
        [canonical.orgId, courseVersionIds],
      )
      if ((available.rowCount ?? available.rows.length) !== courseVersionIds.length) {
        fail('course_unavailable')
      }

      await tx.query(
        `/* elearning-training-plan:insert-head */
         INSERT INTO elearning_training_plans
           (id, org_id, title, status, created_by)
         VALUES ($1, $2, $3, 'active', $4)`,
        [planId, canonical.orgId, canonical.title, canonical.actorId],
      )
      await tx.query(
        `/* elearning-training-plan:insert-version */
         INSERT INTO elearning_training_plan_versions
           (id, org_id, training_plan_id, version, status, title, created_by)
         VALUES ($1, $2, $3, 1, 'draft', $4, $5)`,
        [planVersionId, canonical.orgId, planId, canonical.title, canonical.actorId],
      )
      for (const [index, item] of canonical.items.entries()) {
        await tx.query(
          `/* elearning-training-plan:insert-item */
           INSERT INTO elearning_training_plan_items
             (id, org_id, training_plan_version_id, course_version_id, position, required)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            canonical.orgId,
            planVersionId,
            item.courseVersionId,
            index + 1,
            item.required,
          ],
        )
      }

      const published = await tx.query(
        `/* elearning-training-plan:publish-version */
         UPDATE elearning_training_plan_versions
            SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
        [canonical.orgId, planVersionId],
      )
      if ((published.rowCount ?? 0) !== 1) fail('unavailable')

      const pointers = await tx.query(
        `/* elearning-training-plan:set-pointers */
         UPDATE elearning_training_plans
            SET active_version_id = $1,
                latest_version_id = $1,
                updated_at = now()
          WHERE org_id = $2
            AND id = $3
            AND active_version_id IS NULL
            AND latest_version_id IS NULL`,
        [planVersionId, canonical.orgId, planId],
      )
      if ((pointers.rowCount ?? 0) !== 1) fail('unavailable')

      await tx.query(
        `/* elearning-training-plan:insert-request */
         INSERT INTO elearning_training_plan_publish_requests (
           id, org_id, source_key, request_hash, request_hash_version,
           training_plan_id, training_plan_version_id, item_count
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          requestRowId,
          canonical.orgId,
          canonical.requestId,
          requestHash,
          ELEARNING_TRAINING_PLAN_REQUEST_HASH_VERSION,
          planId,
          planVersionId,
          canonical.items.length,
        ],
      )

      return {
        planId,
        planVersionId,
        status: 'published',
        itemCount: canonical.items.length,
        duplicate: false,
      }
    } catch (error) {
      if (error instanceof ElearningTrainingPlanError) throw error
      if (isSourceKeyUniqueViolation(error)) fail('conflict')
      fail('unavailable')
    }
  })
}

export async function getElearningTrainingPlan(
  db: ElearningTrainingPlanQueryable,
  input: GetElearningTrainingPlanInput,
): Promise<ElearningTrainingPlan> {
  const orgId = requireText(input.orgId, ELEARNING_TRAINING_PLAN_ACTOR_MAX)
  const planId = requireUuid(input.planId)
  try {
    const head = await db.query(
      `/* elearning-training-plan:get-head */
       SELECT p.id AS plan_id, p.title, p.status,
              v.id AS plan_version_id, v.version, v.status AS version_status
         FROM elearning_training_plans p
         JOIN elearning_training_plan_versions v
           ON v.org_id = p.org_id
          AND v.training_plan_id = p.id
          AND v.id = p.active_version_id
        WHERE p.org_id = $1 AND p.id = $2`,
      [orgId, planId],
    )
    const row = head.rows[0]
    if (!row) fail('not_found')
    const resolvedPlanId = asText(row.plan_id)
    const title = asText(row.title)
    const status = asText(row.status)
    const planVersionId = asText(row.plan_version_id)
    const version = asSafeInt(row.version)
    if (
      !resolvedPlanId
      || !title
      || (status !== 'active' && status !== 'archived')
      || !planVersionId
      || version === null
      || row.version_status !== 'published'
    ) {
      fail('unavailable')
    }

    const itemRows = await db.query(
      `/* elearning-training-plan:get-items */
       SELECT course_version_id, position, required
         FROM elearning_training_plan_items
        WHERE org_id = $1 AND training_plan_version_id = $2
        ORDER BY position`,
      [orgId, planVersionId],
    )
    const items = itemRows.rows.map((item): ElearningTrainingPlanItem => {
      const courseVersionId = asText(item.course_version_id)
      const position = asSafeInt(item.position)
      if (!courseVersionId || position === null || typeof item.required !== 'boolean') {
        fail('unavailable')
      }
      return { courseVersionId, position, required: item.required }
    })
    if (items.length < 1) fail('unavailable')
    return {
      planId: resolvedPlanId,
      title,
      status,
      activeVersion: {
        planVersionId,
        version,
        status: 'published',
        items,
      },
    }
  } catch (error) {
    if (error instanceof ElearningTrainingPlanError) throw error
    fail('unavailable')
  }
}
