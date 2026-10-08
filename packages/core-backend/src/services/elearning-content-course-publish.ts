import { createHash, randomUUID } from 'node:crypto'

import {
  planElearningCourseDraftPointers,
  planElearningCoursePublishPointers,
  validateElearningCourseVersionTransition,
} from './elearning-course-lifecycle-policy'
import { assertElearningCoursePublishReadiness } from './elearning-course-publish-readiness-policy'
import {
  ELEARNING_COURSE_VERSION_MAX_ITEMS,
  normalizeElearningCourseVersionItems,
  type ElearningCourseVersionItem,
} from './elearning-course-version-items-policy'
import {
  createElearningContentRevision,
  type ElearningContentRevision,
  type ElearningContentRevisionItemType,
} from './elearning-content-revision-policy'
import {
  ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION,
  ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
} from './elearning-open-completion-policy'

export const ELEARNING_CONTENT_COURSE_REQUEST_DOMAIN =
  'elearning.content.course.publish.request.v1' as const
export const ELEARNING_CONTENT_COURSE_REQUEST_HASH_VERSION = 1 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTOR_MAX = 256
const TITLE_MAX = 200
const INPUT_KEYS = ['actorId', 'items', 'orgId', 'requestId', 'title'] as const
const ITEM_KEYS = ['contentRevisionId', 'itemType'] as const

export type ElearningContentCoursePublishErrorCode =
  | 'invalid_input'
  | 'reference_unavailable'
  | 'conflict'
  | 'unavailable'

export class ElearningContentCoursePublishError extends Error {
  constructor(readonly code: ElearningContentCoursePublishErrorCode) {
    super(code)
    this.name = 'ElearningContentCoursePublishError'
  }
}

export interface ElearningContentCoursePublishQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningContentCoursePublishDb {
  transaction<T>(
    handler: (tx: ElearningContentCoursePublishQueryable) => Promise<T>,
  ): Promise<T>
}

export interface PublishElearningContentCourseItemInput {
  itemType: ElearningContentRevisionItemType
  contentRevisionId: string
}

export interface PublishElearningContentCourseInput {
  orgId: string
  actorId: string
  requestId: string
  title: string
  items: PublishElearningContentCourseItemInput[]
}

export interface ElearningContentCoursePublishedItem {
  itemId: string
  itemType: ElearningContentRevisionItemType
  contentRevisionId: string
  position: number
}

export interface ElearningContentCoursePublishResult {
  courseId: string
  courseVersionId: string
  status: 'published'
  itemCount: number
  items: ElearningContentCoursePublishedItem[]
}

interface CanonicalContentCourseInput {
  orgId: string
  actorId: string
  requestId: string
  title: string
  items: Array<{
    itemType: ElearningContentRevisionItemType
    contentRevisionId: string
    position: number
  }>
}

function fail(code: ElearningContentCoursePublishErrorCode): never {
  throw new ElearningContentCoursePublishError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail('invalid_input')
  }
}

function requireText(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input')
  return text
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asPositiveInt(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : null
  return number !== null && Number.isSafeInteger(number) && number > 0
    ? number
    : null
}

function requireItemType(value: unknown): ElearningContentRevisionItemType {
  if (value !== 'article' && value !== 'external_link') fail('invalid_input')
  return value
}

export function canonicalizeElearningContentCoursePublishInput(
  input: unknown,
): CanonicalContentCourseInput {
  if (!isPlainObject(input)) fail('invalid_input')
  requireKeys(input, INPUT_KEYS)
  if (
    !Array.isArray(input.items)
    || input.items.length < 1
    || input.items.length > ELEARNING_COURSE_VERSION_MAX_ITEMS
  ) fail('invalid_input')
  const items = input.items.map((raw, index) => {
    if (!isPlainObject(raw)) fail('invalid_input')
    requireKeys(raw, ITEM_KEYS)
    return {
      itemType: requireItemType(raw.itemType),
      contentRevisionId: requireUuid(raw.contentRevisionId),
      position: index + 1,
    }
  })
  const revisionIds = new Set(items.map((item) => item.contentRevisionId))
  if (revisionIds.size !== items.length) fail('invalid_input')
  return {
    orgId: requireText(input.orgId, ACTOR_MAX),
    actorId: requireText(input.actorId, ACTOR_MAX),
    requestId: requireUuid(input.requestId),
    title: requireText(input.title, TITLE_MAX),
    items,
  }
}

function canonicalRequestJson(input: CanonicalContentCourseInput): string {
  return JSON.stringify({
    actorId: input.actorId,
    domain: ELEARNING_CONTENT_COURSE_REQUEST_DOMAIN,
    items: input.items.map((item) => ({
      contentRevisionId: item.contentRevisionId,
      itemType: item.itemType,
      position: item.position,
    })),
    title: input.title,
    version: ELEARNING_CONTENT_COURSE_REQUEST_HASH_VERSION,
  })
}

export function hashElearningContentCoursePublishRequestAtVersion(
  input: CanonicalContentCourseInput,
  version: number,
): string {
  if (version !== ELEARNING_CONTENT_COURSE_REQUEST_HASH_VERSION) fail('unavailable')
  return createHash('sha256').update(canonicalRequestJson(input), 'utf8').digest('hex')
}

function mapStoredRevision(row: Record<string, unknown>): ElearningContentRevision {
  const contentRevisionId = asText(row.id)
  const itemType = asText(row.item_type)
  const title = asText(row.title)
  const contentDigest = asText(row.content_digest)
  if (!contentRevisionId || !itemType || !title || !contentDigest) {
    fail('reference_unavailable')
  }
  let revision: ElearningContentRevision
  try {
    revision = createElearningContentRevision({
      articleHtml: row.article_html ?? null,
      contentRevisionId,
      externalUrl: row.external_url ?? null,
      itemType,
      title,
    })
  } catch {
    fail('reference_unavailable')
  }
  if (revision.contentDigest !== contentDigest) fail('reference_unavailable')
  return revision
}

function mapPublishedItems(
  rows: Array<Record<string, unknown>>,
): ElearningContentCoursePublishedItem[] {
  return rows.map((row) => {
    const itemId = asText(row.item_id ?? row.id)
    const itemType = asText(row.item_type)
    const articleRevisionId = row.article_revision_id == null
      ? null
      : asText(row.article_revision_id)
    const externalRevisionId = row.external_link_revision_id == null
      ? null
      : asText(row.external_link_revision_id)
    const position = asPositiveInt(row.position)
    if (!itemId || position === null) fail('unavailable')
    if (itemType === 'article' && articleRevisionId && externalRevisionId === null) {
      return { itemId, itemType, contentRevisionId: articleRevisionId, position }
    }
    if (itemType === 'external_link' && externalRevisionId && articleRevisionId === null) {
      return { itemId, itemType, contentRevisionId: externalRevisionId, position }
    }
    fail('unavailable')
  })
}

async function loadPublishedResult(
  tx: ElearningContentCoursePublishQueryable,
  row: Record<string, unknown>,
): Promise<ElearningContentCoursePublishResult> {
  const courseId = asText(row.course_id)
  const courseVersionId = asText(row.course_version_id)
  const itemCount = asPositiveInt(row.item_count)
  if (!courseId || !courseVersionId || itemCount === null) fail('unavailable')
  const itemsResult = await tx.query(
    `/* elearning-content-course:load-result-items */
     SELECT id AS item_id, item_type, position,
            article_revision_id, external_link_revision_id
       FROM elearning_course_version_items
      WHERE org_id = $1 AND course_version_id = $2
        AND item_type IN ('article', 'external_link')
      ORDER BY position ASC, id ASC`,
    [row.org_id, courseVersionId],
  )
  const items = mapPublishedItems(itemsResult.rows)
  if (items.length !== itemCount) fail('unavailable')
  return { courseId, courseVersionId, status: 'published', itemCount, items }
}

function isUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23505'
    && candidate.constraint === 'elearning_content_course_publish_requests_org_source_uniq'
}

export async function publishElearningContentCourse(
  db: ElearningContentCoursePublishDb,
  input: PublishElearningContentCourseInput,
): Promise<ElearningContentCoursePublishResult> {
  const canonical = canonicalizeElearningContentCoursePublishInput(input)
  const requestHash = hashElearningContentCoursePublishRequestAtVersion(
    canonical,
    ELEARNING_CONTENT_COURSE_REQUEST_HASH_VERSION,
  )
  const courseId = randomUUID()
  const courseVersionId = randomUUID()
  const itemIds = canonical.items.map(() => randomUUID())

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-content-course:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`elearning-content-course:${canonical.orgId}:${canonical.requestId}`],
      )
      const existing = await tx.query(
        `/* elearning-content-course:load-request */
         SELECT org_id, request_hash, request_hash_version,
                course_id, course_version_id, item_count
           FROM elearning_content_course_publish_requests
          WHERE org_id = $1 AND source_key = $2
          FOR UPDATE`,
        [canonical.orgId, canonical.requestId],
      )
      const existingRow = existing.rows[0]
      if (existingRow) {
        const storedHash = asText(existingRow.request_hash)
        const storedVersion = asPositiveInt(existingRow.request_hash_version)
        if (!storedHash || storedVersion === null) fail('unavailable')
        if (
          hashElearningContentCoursePublishRequestAtVersion(canonical, storedVersion)
          !== storedHash
        ) fail('conflict')
        return loadPublishedResult(tx, existingRow)
      }

      const revisions = await tx.query(
        `/* elearning-content-course:load-revisions */
         SELECT id, item_type, title, article_html, external_url, content_digest
           FROM elearning_content_revisions
          WHERE org_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id ASC
          FOR SHARE`,
        [canonical.orgId, canonical.items.map((item) => item.contentRevisionId)],
      )
      const revisionById = new Map(
        revisions.rows.map((row) => {
          const revision = mapStoredRevision(row)
          return [revision.contentRevisionId, revision] as const
        }),
      )
      if (revisionById.size !== canonical.items.length) fail('reference_unavailable')

      const items = normalizeElearningCourseVersionItems(canonical.items.map((item, index) => {
        const revision = revisionById.get(item.contentRevisionId)
        if (!revision || revision.itemType !== item.itemType) fail('reference_unavailable')
        return {
          articleRevisionId: item.itemType === 'article' ? item.contentRevisionId : null,
          completionPolicyVersion: item.itemType === 'article'
            ? ELEARNING_ARTICLE_COMPLETION_POLICY_VERSION
            : ELEARNING_EXTERNAL_LINK_COMPLETION_POLICY_VERSION,
          completionThresholdBps: null,
          examId: null,
          externalLinkRevisionId: item.itemType === 'external_link'
            ? item.contentRevisionId
            : null,
          itemId: itemIds[index],
          itemType: item.itemType,
          mediaId: null,
          position: item.position,
        }
      }))

      await tx.query(
        `/* elearning-content-course:insert-course */
         INSERT INTO elearning_courses (id, org_id, title, status, created_by)
         VALUES ($1, $2, $3, 'active', $4)`,
        [courseId, canonical.orgId, canonical.title, canonical.actorId],
      )
      await tx.query(
        `/* elearning-content-course:insert-version */
         INSERT INTO elearning_course_versions
           (id, org_id, course_id, version, status, title, created_by)
         VALUES ($1, $2, $3, 1, 'draft', $4, $5)`,
        [courseVersionId, canonical.orgId, courseId, canonical.title, canonical.actorId],
      )
      let draftPointers: ReturnType<typeof planElearningCourseDraftPointers>
      try {
        draftPointers = planElearningCourseDraftPointers({
          activeVersionId: null,
          courseId,
          draftVersionId: courseVersionId,
          latestVersionId: null,
        })
      } catch {
        fail('unavailable')
      }
      const drafted = await tx.query(
        `/* elearning-content-course:set-draft-pointer */
         UPDATE elearning_courses
            SET latest_version_id = $1, updated_at = now()
          WHERE org_id = $2 AND id = $3
            AND active_version_id IS NULL AND latest_version_id IS NULL`,
        [draftPointers.latestVersionId, canonical.orgId, draftPointers.courseId],
      )
      if ((drafted.rowCount ?? 0) !== 1) fail('unavailable')

      for (const item of items) {
        await tx.query(
          `/* elearning-content-course:insert-item */
           INSERT INTO elearning_course_version_items (
             id, org_id, course_version_id, item_type, position,
             media_id, exam_id, article_revision_id, external_link_revision_id,
             completion_policy_version, completion_threshold_bps
           ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8, NULL)`,
          [
            item.itemId,
            canonical.orgId,
            courseVersionId,
            item.itemType,
            item.position,
            item.articleRevisionId,
            item.externalLinkRevisionId,
            item.completionPolicyVersion,
          ],
        )
      }

      try {
        assertElearningCoursePublishReadiness({
          items,
          authorities: items.map((item) => ({
            itemId: item.itemId,
            itemType: item.itemType,
            measurementAuthority: null,
            referenceId: item.articleRevisionId ?? item.externalLinkRevisionId,
            referenceState: 'revision_verified',
            serverDurationMs: null,
            serverPageCount: null,
          })),
        })
      } catch {
        fail('reference_unavailable')
      }

      let publishPointers: ReturnType<typeof planElearningCoursePublishPointers>
      try {
        validateElearningCourseVersionTransition({
          fromStatus: 'draft',
          isActiveVersion: false,
          toStatus: 'published',
        })
        publishPointers = planElearningCoursePublishPointers({
          activeVersionId: draftPointers.activeVersionId,
          courseId,
          draftVersionId: courseVersionId,
          draftVersionStatus: 'draft',
          latestVersionId: draftPointers.latestVersionId,
          previousActiveVersionStatus: null,
        })
      } catch {
        fail('unavailable')
      }
      const published = await tx.query(
        `/* elearning-content-course:publish-version */
         UPDATE elearning_course_versions SET status = 'published', updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status = 'draft'`,
        [canonical.orgId, publishPointers.publishVersionId],
      )
      if ((published.rowCount ?? 0) !== 1) fail('unavailable')
      const pointers = await tx.query(
        `/* elearning-content-course:set-pointers */
         UPDATE elearning_courses
            SET active_version_id = $1, latest_version_id = $2, updated_at = now()
          WHERE org_id = $3 AND id = $4
            AND active_version_id IS NULL AND latest_version_id = $5`,
        [
          publishPointers.nextActiveVersionId,
          publishPointers.nextLatestVersionId,
          canonical.orgId,
          publishPointers.courseId,
          draftPointers.latestVersionId,
        ],
      )
      if ((pointers.rowCount ?? 0) !== 1) fail('unavailable')
      await tx.query(
        `/* elearning-content-course:insert-request */
         INSERT INTO elearning_content_course_publish_requests (
           id, org_id, source_key, request_hash, request_hash_version,
           course_id, course_version_id, item_count, actor_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          canonical.orgId,
          canonical.requestId,
          requestHash,
          ELEARNING_CONTENT_COURSE_REQUEST_HASH_VERSION,
          courseId,
          courseVersionId,
          items.length,
          canonical.actorId,
        ],
      )
      return {
        courseId,
        courseVersionId,
        status: 'published',
        itemCount: items.length,
        items: items.map((item) => ({
          itemId: item.itemId,
          itemType: item.itemType as ElearningContentRevisionItemType,
          contentRevisionId:
            item.articleRevisionId ?? item.externalLinkRevisionId ?? fail('unavailable'),
          position: item.position,
        })),
      }
    })
  } catch (error) {
    if (error instanceof ElearningContentCoursePublishError) throw error
    if (isUniqueConflict(error)) fail('conflict')
    fail('unavailable')
  }
}

export type { ElearningCourseVersionItem }
