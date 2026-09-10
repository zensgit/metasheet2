import { createHash, randomUUID } from 'node:crypto'

import {
  ElearningTitlePolicyError,
  normalizeElearningTitleThresholdSnapshot,
  resolveElearningTitle,
  type ElearningTitleThresholdRow,
} from './elearning-title-policy'

export const ELEARNING_TITLE_REQUEST_DOMAIN = 'elearning.title.snapshot.request.v1' as const
export const ELEARNING_TITLE_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_TITLE_SNAPSHOT_MAX_ROWS = 100 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const POSTGRES_INT4_MAX = 2_147_483_647

export type ElearningTitleSurfaceErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'unavailable'

export class ElearningTitleSurfaceError extends Error {
  constructor(readonly code: ElearningTitleSurfaceErrorCode) {
    super(code)
    this.name = 'ElearningTitleSurfaceError'
  }
}

export interface ElearningTitleQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningTitleDb extends ElearningTitleQueryable {
  transaction<T>(handler: (tx: ElearningTitleQueryable) => Promise<T>): Promise<T>
}

export interface ElearningTitleSnapshot {
  revisionId: string | null
  version: number
  titles: ElearningTitleThresholdRow[]
  createdAt: string | null
}

export interface PublishElearningTitleSnapshotInput {
  orgId: string
  actorId: string
  requestId: string
  titles: unknown
}

export interface PublishElearningTitleSnapshotResult extends ElearningTitleSnapshot {
  duplicate: boolean
}

function fail(code: ElearningTitleSurfaceErrorCode): never {
  throw new ElearningTitleSurfaceError(code)
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input')
  return text
}

function normalizeTitles(value: unknown): ElearningTitleThresholdRow[] {
  try {
    const snapshot = normalizeElearningTitleThresholdSnapshot(value)
    if (snapshot.length > ELEARNING_TITLE_SNAPSHOT_MAX_ROWS) fail('invalid_input')
    return snapshot.map((row) => ({ ...row }))
  } catch (error) {
    if (error instanceof ElearningTitleSurfaceError) throw error
    if (error instanceof ElearningTitlePolicyError) fail('invalid_input')
    fail('invalid_input')
  }
}

function canonicalize(value: unknown): string {
  const walk = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(walk)
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(
        Object.keys(candidate as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((candidate as Record<string, unknown>)[key])]),
      )
    }
    return candidate
  }
  return JSON.stringify(walk(value ?? null))
}

export function hashElearningTitleSnapshotRequest(
  titles: readonly ElearningTitleThresholdRow[],
): string {
  return createHash('sha256')
    .update(canonicalize({
      domain: ELEARNING_TITLE_REQUEST_DOMAIN,
      titles,
      version: ELEARNING_TITLE_REQUEST_HASH_VERSION,
    }), 'utf8')
    .digest('hex')
}

function storedText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function storedUuid(value: unknown): string | null {
  const text = storedText(value)
  return text && UUID_RE.test(text) ? text.toLowerCase() : null
}

function storedInt(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  return Number.isSafeInteger(parsed) ? parsed : null
}

function storedDate(value: unknown): string | null {
  const date = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

async function loadRevision(
  db: ElearningTitleQueryable,
  orgId: string,
  revisionId: string,
): Promise<ElearningTitleSnapshot> {
  const result = await db.query(
    `/* elearning-title:load-revision */
     SELECT
       revision.id::text AS revision_id,
       revision.version,
       revision.created_at,
       row.title_key,
       row.name,
       row.threshold,
       row.position
     FROM elearning_title_revisions revision
     LEFT JOIN elearning_title_revision_rows row
       ON row.org_id = revision.org_id
      AND row.revision_id = revision.id
     WHERE revision.org_id = $1 AND revision.id = $2::uuid
     ORDER BY row.position ASC NULLS FIRST`,
    [orgId, revisionId],
  )
  if (result.rows.length === 0) fail('unavailable')
  const first = result.rows[0]
  const storedRevisionId = storedUuid(first?.revision_id)
  const version = storedInt(first?.version)
  const createdAt = storedDate(first?.created_at)
  if (!storedRevisionId || storedRevisionId !== revisionId || !version || !createdAt) {
    fail('unavailable')
  }
  const titles: ElearningTitleThresholdRow[] = []
  for (const [index, row] of result.rows.entries()) {
    if (
      storedUuid(row.revision_id) !== revisionId
      || storedInt(row.version) !== version
      || storedDate(row.created_at) !== createdAt
    ) fail('unavailable')
    if (row.title_key === null && row.name === null && row.threshold === null && row.position === null) {
      if (result.rows.length !== 1) fail('unavailable')
      continue
    }
    const id = storedText(row.title_key)
    const name = storedText(row.name)
    const threshold = storedInt(row.threshold)
    const position = storedInt(row.position)
    if (
      !id
      || !name
      || threshold === null
      || threshold < 0
      || threshold > POSTGRES_INT4_MAX
      || position !== index + 1
    ) fail('unavailable')
    titles.push({ id, name, threshold })
  }
  try {
    const normalized = normalizeElearningTitleThresholdSnapshot(titles)
    if (normalized.length !== titles.length) fail('unavailable')
    if (normalized.some((row, index) => (
      row.id !== titles[index]?.id
      || row.name !== titles[index]?.name
      || row.threshold !== titles[index]?.threshold
    ))) fail('unavailable')
    return {
      revisionId,
      version,
      titles: normalized.map((row) => ({ ...row })),
      createdAt,
    }
  } catch {
    fail('unavailable')
  }
}

export async function getActiveElearningTitleSnapshot(
  db: ElearningTitleQueryable,
  orgIdInput: string,
): Promise<ElearningTitleSnapshot> {
  const orgId = requireText(orgIdInput)
  try {
    const head = await db.query(
      `/* elearning-title:load-head */
       SELECT active_revision_id::text
       FROM elearning_title_heads
       WHERE org_id = $1`,
      [orgId],
    )
    if (head.rows.length > 1) fail('unavailable')
    if (head.rows.length === 0) {
      return { revisionId: null, version: 0, titles: [], createdAt: null }
    }
    const revisionId = storedUuid(head.rows[0]?.active_revision_id)
    if (!revisionId) fail('unavailable')
    return await loadRevision(db, orgId, revisionId)
  } catch (error) {
    if (error instanceof ElearningTitleSurfaceError) throw error
    fail('unavailable')
  }
}

export async function resolveActiveElearningTitle(
  db: ElearningTitleQueryable,
  orgId: string,
  balancePoints: number,
): Promise<ElearningTitleThresholdRow | null> {
  try {
    const snapshot = await getActiveElearningTitleSnapshot(db, orgId)
    return resolveElearningTitle(
      normalizeElearningTitleThresholdSnapshot(snapshot.titles),
      balancePoints,
    )
  } catch (error) {
    if (error instanceof ElearningTitleSurfaceError) throw error
    fail('unavailable')
  }
}

export async function publishElearningTitleSnapshot(
  db: ElearningTitleDb,
  input: PublishElearningTitleSnapshotInput,
): Promise<PublishElearningTitleSnapshotResult> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const requestId = requireText(input.requestId)
  const titles = normalizeTitles(input.titles)
  const requestHash = hashElearningTitleSnapshotRequest(titles)

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-title:request-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-title-request', `${orgId}:${requestId}`],
      )
      const existing = await tx.query(
        `/* elearning-title:load-request */
         SELECT request_hash, request_hash_version, revision_id::text
         FROM elearning_title_publish_requests
         WHERE org_id = $1 AND source_key = $2
         FOR SHARE`,
        [orgId, requestId],
      )
      if (existing.rows.length > 1) fail('unavailable')
      if (existing.rows[0]) {
        const revisionId = storedUuid(existing.rows[0].revision_id)
        if (
          storedText(existing.rows[0].request_hash) !== requestHash
          || storedInt(existing.rows[0].request_hash_version)
            !== ELEARNING_TITLE_REQUEST_HASH_VERSION
        ) fail('conflict')
        if (!revisionId) fail('unavailable')
        return { ...await loadRevision(tx, orgId, revisionId), duplicate: true }
      }

      await tx.query(
        `/* elearning-title:head-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-title-head', orgId],
      )
      const headId = randomUUID()
      await tx.query(
        `/* elearning-title:ensure-head */
         INSERT INTO elearning_title_heads (org_id, id, latest_version)
         VALUES ($1, $2::uuid, 0)
         ON CONFLICT (org_id) DO NOTHING`,
        [orgId, headId],
      )
      const head = await tx.query(
        `/* elearning-title:lock-head */
         SELECT id::text, latest_version
         FROM elearning_title_heads
         WHERE org_id = $1
         FOR UPDATE`,
        [orgId],
      )
      const storedHeadId = storedUuid(head.rows[0]?.id)
      const latestVersion = storedInt(head.rows[0]?.latest_version)
      if (head.rows.length !== 1 || !storedHeadId || latestVersion === null || latestVersion < 0) {
        fail('unavailable')
      }
      const version = latestVersion + 1
      if (!Number.isSafeInteger(version) || version <= 0 || version > POSTGRES_INT4_MAX) {
        fail('unavailable')
      }
      const revisionId = randomUUID()
      const revision = await tx.query(
        `/* elearning-title:insert-revision */
         INSERT INTO elearning_title_revisions (
           id, org_id, head_id, version, actor_id
         ) VALUES ($1::uuid, $2, $3::uuid, $4, $5)
         RETURNING created_at`,
        [revisionId, orgId, storedHeadId, version, actorId],
      )
      const createdAt = storedDate(revision.rows[0]?.created_at)
      if (revision.rows.length !== 1 || !createdAt) fail('unavailable')

      for (const [index, title] of titles.entries()) {
        await tx.query(
          `/* elearning-title:insert-row */
           INSERT INTO elearning_title_revision_rows (
             id, org_id, revision_id, title_key, name, threshold, position
           ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)`,
          [randomUUID(), orgId, revisionId, title.id, title.name, title.threshold, index + 1],
        )
      }
      await tx.query(
        `/* elearning-title:balance-org-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-title-balance-org', orgId],
      )
      const moved = await tx.query(
        `/* elearning-title:activate-revision */
         UPDATE elearning_title_heads
         SET active_revision_id = $2::uuid, latest_version = $3, updated_at = now()
         WHERE org_id = $1`,
        [orgId, revisionId, version],
      )
      if (moved.rowCount !== 1) fail('unavailable')
      await tx.query(
        `/* elearning-title:record-request */
         INSERT INTO elearning_title_publish_requests (
           org_id, source_key, request_hash, request_hash_version,
           actor_id, revision_id
         ) VALUES ($1, $2, $3, $4, $5, $6::uuid)`,
        [
          orgId,
          requestId,
          requestHash,
          ELEARNING_TITLE_REQUEST_HASH_VERSION,
          actorId,
          revisionId,
        ],
      )
      await tx.query(
        `/* elearning-title:backfill-awards */
         INSERT INTO elearning_title_awards (
           id, org_id, user_id, title_key, title_revision_id,
           title_row_id, threshold, balance_points
         )
         SELECT
           gen_random_uuid(), balance.org_id, balance.user_id, row.title_key,
           row.revision_id, row.id, row.threshold, balance.balance_points
         FROM elearning_credit_balances balance
         JOIN elearning_title_revision_rows row
           ON row.org_id = balance.org_id
          AND row.revision_id = $2::uuid
          AND row.threshold <= balance.balance_points
         WHERE balance.org_id = $1
         ON CONFLICT (org_id, user_id, title_key) DO NOTHING`,
        [orgId, revisionId],
      )
      return {
        revisionId,
        version,
        titles: titles.map((row) => ({ ...row })),
        createdAt,
        duplicate: false,
      }
    })
  } catch (error) {
    if (error instanceof ElearningTitleSurfaceError) throw error
    fail('unavailable')
  }
}
