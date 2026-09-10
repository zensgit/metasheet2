import { createHash, randomUUID } from 'node:crypto'

import {
  createElearningContentRevision,
  type ElearningContentRevision,
  type ElearningContentRevisionItemType,
} from './elearning-content-revision-policy'

export const ELEARNING_CONTENT_REVISION_REQUEST_DOMAIN =
  'elearning.content.revision.request.v1' as const
export const ELEARNING_CONTENT_REVISION_REQUEST_HASH_VERSION = 1 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NIL_REVISION_ID = '00000000-0000-4000-8000-000000000000'
const ACTOR_MAX = 256
const REQUEST_KEYS = [
  'actorId',
  'articleHtml',
  'externalUrl',
  'itemType',
  'orgId',
  'requestId',
  'title',
] as const

export type ElearningContentRevisionStoreErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'unavailable'

export class ElearningContentRevisionStoreError extends Error {
  constructor(readonly code: ElearningContentRevisionStoreErrorCode) {
    super(code)
    this.name = 'ElearningContentRevisionStoreError'
  }
}

export interface ElearningContentRevisionQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningContentRevisionDb {
  transaction<T>(
    handler: (tx: ElearningContentRevisionQueryable) => Promise<T>,
  ): Promise<T>
}

export interface CreateElearningContentRevisionInput {
  orgId: string
  actorId: string
  requestId: string
  itemType: ElearningContentRevisionItemType
  title: string
  articleHtml: string | null
  externalUrl: string | null
}

interface CanonicalRevisionRequest {
  orgId: string
  actorId: string
  requestId: string
  itemType: ElearningContentRevisionItemType
  title: string
  articleHtml: string | null
  externalUrl: string | null
}

function fail(code: ElearningContentRevisionStoreErrorCode): never {
  throw new ElearningContentRevisionStoreError(code)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireExactKeys(value: Record<string, unknown>): void {
  const keys = Object.keys(value).sort()
  if (
    keys.length !== REQUEST_KEYS.length
    || keys.some((key, index) => key !== REQUEST_KEYS[index])
  ) fail('invalid_input')
}

function requireActor(value: unknown): string {
  if (typeof value !== 'string') fail('invalid_input')
  const actor = value.trim()
  if (actor === '' || actor.length > ACTOR_MAX || actor.includes('\0')) {
    fail('invalid_input')
  }
  return actor
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_input')
  return value.toLowerCase()
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asSmallPositiveInt(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : null
  return number !== null && Number.isSafeInteger(number) && number > 0
    ? number
    : null
}

export function canonicalizeElearningContentRevisionRequest(
  input: unknown,
): CanonicalRevisionRequest {
  if (!isPlainObject(input)) fail('invalid_input')
  requireExactKeys(input)
  const orgId = requireActor(input.orgId)
  const actorId = requireActor(input.actorId)
  const requestId = requireUuid(input.requestId)
  let revision: ElearningContentRevision
  try {
    revision = createElearningContentRevision({
      articleHtml: input.articleHtml,
      contentRevisionId: NIL_REVISION_ID,
      externalUrl: input.externalUrl,
      itemType: input.itemType,
      title: input.title,
    })
  } catch {
    fail('invalid_input')
  }
  return {
    orgId,
    actorId,
    requestId,
    itemType: revision.itemType,
    title: revision.title,
    articleHtml: revision.articleHtml,
    externalUrl: revision.externalUrl,
  }
}

function canonicalRequestJson(input: CanonicalRevisionRequest): string {
  return JSON.stringify({
    actorId: input.actorId,
    articleHtml: input.articleHtml,
    domain: ELEARNING_CONTENT_REVISION_REQUEST_DOMAIN,
    externalUrl: input.externalUrl,
    itemType: input.itemType,
    title: input.title,
    version: ELEARNING_CONTENT_REVISION_REQUEST_HASH_VERSION,
  })
}

export function hashElearningContentRevisionRequestAtVersion(
  input: CanonicalRevisionRequest,
  version: number,
): string {
  if (version !== ELEARNING_CONTENT_REVISION_REQUEST_HASH_VERSION) {
    fail('unavailable')
  }
  return createHash('sha256').update(canonicalRequestJson(input), 'utf8').digest('hex')
}

function mapRevision(row: Record<string, unknown>): ElearningContentRevision {
  const contentRevisionId = asText(row.content_revision_id ?? row.id)
  const itemType = asText(row.item_type)
  const title = asText(row.title)
  const contentDigest = asText(row.content_digest)
  if (!contentRevisionId || !itemType || !title || !contentDigest) fail('unavailable')
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
    fail('unavailable')
  }
  if (revision.contentDigest !== contentDigest) fail('unavailable')
  return revision
}

function isUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; constraint?: unknown }
  return candidate.code === '23505'
    && candidate.constraint === 'elearning_content_revision_requests_org_source_uniq'
}

export async function storeElearningContentRevision(
  db: ElearningContentRevisionDb,
  input: CreateElearningContentRevisionInput,
): Promise<ElearningContentRevision> {
  const canonical = canonicalizeElearningContentRevisionRequest(input)
  const requestHash = hashElearningContentRevisionRequestAtVersion(
    canonical,
    ELEARNING_CONTENT_REVISION_REQUEST_HASH_VERSION,
  )

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-content-revision:lock */
         SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`elearning-content-revision:${canonical.orgId}:${canonical.requestId}`],
      )
      const existing = await tx.query(
        `/* elearning-content-revision:load-request */
         SELECT request.request_hash, request.request_hash_version,
                revision.id AS content_revision_id, revision.item_type,
                revision.title, revision.article_html, revision.external_url,
                revision.content_digest
           FROM elearning_content_revision_requests request
           JOIN elearning_content_revisions revision
             ON revision.org_id = request.org_id
            AND revision.id = request.content_revision_id
          WHERE request.org_id = $1 AND request.source_key = $2
          FOR UPDATE OF request, revision`,
        [canonical.orgId, canonical.requestId],
      )
      const existingRow = existing.rows[0]
      if (existingRow) {
        const storedHash = asText(existingRow.request_hash)
        const storedVersion = asSmallPositiveInt(existingRow.request_hash_version)
        if (!storedHash || storedVersion === null) fail('unavailable')
        if (
          hashElearningContentRevisionRequestAtVersion(canonical, storedVersion)
          !== storedHash
        ) fail('conflict')
        return mapRevision(existingRow)
      }

      const contentRevisionId = randomUUID()
      let revision: ElearningContentRevision
      try {
        revision = createElearningContentRevision({
          articleHtml: canonical.articleHtml,
          contentRevisionId,
          externalUrl: canonical.externalUrl,
          itemType: canonical.itemType,
          title: canonical.title,
        })
      } catch {
        fail('unavailable')
      }
      await tx.query(
        `/* elearning-content-revision:insert-revision */
         INSERT INTO elearning_content_revisions (
           id, org_id, item_type, title, article_html, external_url,
           content_digest, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          revision.contentRevisionId,
          canonical.orgId,
          revision.itemType,
          revision.title,
          revision.articleHtml,
          revision.externalUrl,
          revision.contentDigest,
          canonical.actorId,
        ],
      )
      await tx.query(
        `/* elearning-content-revision:insert-request */
         INSERT INTO elearning_content_revision_requests (
           id, org_id, source_key, request_hash, request_hash_version,
           content_revision_id, actor_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          canonical.orgId,
          canonical.requestId,
          requestHash,
          ELEARNING_CONTENT_REVISION_REQUEST_HASH_VERSION,
          revision.contentRevisionId,
          canonical.actorId,
        ],
      )
      return revision
    })
  } catch (error) {
    if (error instanceof ElearningContentRevisionStoreError) throw error
    if (isUniqueConflict(error)) fail('conflict')
    fail('unavailable')
  }
}
