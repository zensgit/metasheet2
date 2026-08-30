import { createHash, randomUUID } from 'node:crypto'

export const ELEARNING_PORTAL_REQUEST_DOMAIN = 'elearning.portal.publish.v1' as const
export const ELEARNING_PORTAL_REQUEST_HASH_VERSION = 1 as const
export const ELEARNING_PORTAL_MAX_NAV_ITEMS = 8 as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ElearningPortalSettingsErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'unavailable'

export class ElearningPortalSettingsError extends Error {
  constructor(readonly code: ElearningPortalSettingsErrorCode) {
    super(code)
    this.name = 'ElearningPortalSettingsError'
  }
}

export interface ElearningPortalQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningPortalDb extends ElearningPortalQueryable {
  transaction<T>(handler: (tx: ElearningPortalQueryable) => Promise<T>): Promise<T>
}

export interface ElearningPortalNavigationItem {
  label: string
  href: string
}

export interface ElearningPortalSettings {
  revisionId: string | null
  version: number
  siteName: string | null
  tagline: string | null
  bannerUrl: string | null
  navigation: ElearningPortalNavigationItem[]
  createdAt: string | null
}

export interface PublishElearningPortalSettingsInput {
  orgId: string
  actorId: string
  requestId: string
  siteName: unknown
  tagline: unknown
  bannerUrl: unknown
  navigation: unknown
}

export interface PublishElearningPortalSettingsResult extends ElearningPortalSettings {
  duplicate: boolean
}

interface NormalizedPortalSettings {
  siteName: string
  tagline: string | null
  bannerUrl: string | null
  navigation: ElearningPortalNavigationItem[]
}

function fail(code: ElearningPortalSettingsErrorCode): never {
  throw new ElearningPortalSettingsError(code)
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input')
  return text
}

function requiredUuid(value: unknown): string {
  const text = requiredText(value, 128)
  if (!UUID_RE.test(text)) fail('invalid_input')
  return text.toLowerCase()
}

function nullableText(value: unknown, max: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '') return null
  if (text.length > max || text.includes('\0')) fail('invalid_input')
  return text
}

function internalHref(value: unknown): string {
  const href = requiredText(value, 512)
  if (!/^\/(?!\/)[^\s\\]*$/.test(href)) fail('invalid_input')
  return href
}

function bannerUrl(value: unknown): string | null {
  const candidate = nullableText(value, 512)
  if (candidate === null) return null
  if (/^\/(?!\/)[^\s\\]*$/.test(candidate)) return candidate
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    fail('invalid_input')
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.href !== candidate
  ) fail('invalid_input')
  return candidate
}

function normalizeNavigation(value: unknown): ElearningPortalNavigationItem[] {
  if (!Array.isArray(value) || value.length > ELEARNING_PORTAL_MAX_NAV_ITEMS) {
    fail('invalid_input')
  }
  const seen = new Set<string>()
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('invalid_input')
    }
    const row = candidate as Record<string, unknown>
    const keys = Object.keys(row)
    if (keys.length !== 2 || !keys.includes('label') || !keys.includes('href')) {
      fail('invalid_input')
    }
    const href = internalHref(row.href)
    if (seen.has(href)) fail('invalid_input')
    seen.add(href)
    return {
      label: requiredText(row.label, 40),
      href,
    }
  })
}

export function normalizeElearningPortalSettings(input: {
  siteName: unknown
  tagline: unknown
  bannerUrl: unknown
  navigation: unknown
}): NormalizedPortalSettings {
  return {
    siteName: requiredText(input.siteName, 80),
    tagline: nullableText(input.tagline, 160),
    bannerUrl: bannerUrl(input.bannerUrl),
    navigation: normalizeNavigation(input.navigation),
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

export function hashElearningPortalSettingsRequest(
  settings: NormalizedPortalSettings,
): string {
  return createHash('sha256')
    .update(canonicalize({
      domain: ELEARNING_PORTAL_REQUEST_DOMAIN,
      settings,
      version: ELEARNING_PORTAL_REQUEST_HASH_VERSION,
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
  db: ElearningPortalQueryable,
  orgId: string,
  revisionId: string,
): Promise<ElearningPortalSettings> {
  const result = await db.query(
    `/* elearning-portal:load-revision */
     SELECT
       revision.id::text AS revision_id,
       revision.version,
       revision.site_name,
       revision.tagline,
       revision.banner_url,
       revision.created_at,
       nav.position,
       nav.label,
       nav.href
     FROM elearning_portal_revisions revision
     LEFT JOIN elearning_portal_revision_navigation nav
       ON nav.org_id = revision.org_id
      AND nav.revision_id = revision.id
     WHERE revision.org_id = $1 AND revision.id = $2::uuid
     ORDER BY nav.position ASC NULLS FIRST`,
    [orgId, revisionId],
  )
  if (result.rows.length === 0) fail('unavailable')
  const first = result.rows[0]
  const storedRevisionId = storedUuid(first?.revision_id)
  const version = storedInt(first?.version)
  const siteName = storedText(first?.site_name)
  const tagline = first?.tagline === null ? null : storedText(first?.tagline)
  const banner = first?.banner_url === null ? null : storedText(first?.banner_url)
  const createdAt = storedDate(first?.created_at)
  if (!storedRevisionId || storedRevisionId !== revisionId || !version || !siteName || !createdAt) {
    fail('unavailable')
  }
  const navigation: ElearningPortalNavigationItem[] = []
  for (const [index, row] of result.rows.entries()) {
    if (
      storedUuid(row.revision_id) !== revisionId
      || storedInt(row.version) !== version
      || storedText(row.site_name) !== siteName
      || (row.tagline === null ? null : storedText(row.tagline)) !== tagline
      || (row.banner_url === null ? null : storedText(row.banner_url)) !== banner
      || storedDate(row.created_at) !== createdAt
    ) fail('unavailable')
    if (row.position === null && row.label === null && row.href === null) {
      if (result.rows.length !== 1) fail('unavailable')
      continue
    }
    const position = storedInt(row.position)
    const label = storedText(row.label)
    const href = storedText(row.href)
    if (position !== index + 1 || !label || !href) fail('unavailable')
    navigation.push({ label, href })
  }
  const normalized = normalizeElearningPortalSettings({
    siteName,
    tagline,
    bannerUrl: banner,
    navigation,
  })
  if (
    normalized.siteName !== siteName
    || normalized.tagline !== tagline
    || normalized.bannerUrl !== banner
    || normalized.navigation.some((item, index) => (
      item.label !== navigation[index]?.label || item.href !== navigation[index]?.href
    ))
  ) fail('unavailable')
  return { revisionId, version, ...normalized, createdAt }
}

export async function getActiveElearningPortalSettings(
  db: ElearningPortalQueryable,
  orgIdInput: string,
): Promise<ElearningPortalSettings> {
  const orgId = requiredText(orgIdInput, 512)
  try {
    const result = await db.query(
      `/* elearning-portal:load-head */
       SELECT active_revision_id::text, latest_version
       FROM elearning_portal_heads
       WHERE org_id = $1`,
      [orgId],
    )
    if (result.rows.length > 1) fail('unavailable')
    if (result.rows.length === 0) {
      return {
        revisionId: null,
        version: 0,
        siteName: null,
        tagline: null,
        bannerUrl: null,
        navigation: [],
        createdAt: null,
      }
    }
    const revisionId = storedUuid(result.rows[0]?.active_revision_id)
    const latestVersion = storedInt(result.rows[0]?.latest_version)
    if (!revisionId || !latestVersion || latestVersion < 1) fail('unavailable')
    const revision = await loadRevision(db, orgId, revisionId)
    if (revision.version !== latestVersion) fail('unavailable')
    return revision
  } catch (error) {
    if (error instanceof ElearningPortalSettingsError) throw error
    fail('unavailable')
  }
}

export async function publishElearningPortalSettings(
  db: ElearningPortalDb,
  input: PublishElearningPortalSettingsInput,
): Promise<PublishElearningPortalSettingsResult> {
  const orgId = requiredText(input.orgId, 512)
  const actorId = requiredText(input.actorId, 512)
  const requestId = requiredUuid(input.requestId)
  const settings = normalizeElearningPortalSettings(input)
  const requestHash = hashElearningPortalSettingsRequest(settings)

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-portal:request-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-portal-request', `${orgId}:${requestId}`],
      )
      const replay = await tx.query(
        `/* elearning-portal:load-request */
         SELECT request_hash, request_hash_version, revision_id::text
         FROM elearning_portal_publish_requests
         WHERE org_id = $1 AND source_key = $2
         FOR SHARE`,
        [orgId, requestId],
      )
      if (replay.rows.length > 1) fail('unavailable')
      if (replay.rows[0]) {
        const revisionId = storedUuid(replay.rows[0].revision_id)
        if (
          storedText(replay.rows[0].request_hash) !== requestHash
          || storedInt(replay.rows[0].request_hash_version)
            !== ELEARNING_PORTAL_REQUEST_HASH_VERSION
        ) fail('conflict')
        if (!revisionId) fail('unavailable')
        return { ...await loadRevision(tx, orgId, revisionId), duplicate: true }
      }

      await tx.query(
        `/* elearning-portal:head-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-portal-head', orgId],
      )
      const head = await tx.query(
        `/* elearning-portal:load-head-for-update */
         SELECT latest_version
         FROM elearning_portal_heads
         WHERE org_id = $1
         FOR UPDATE`,
        [orgId],
      )
      if (head.rows.length > 1) fail('unavailable')
      const latestVersion = head.rows.length === 0
        ? 0
        : storedInt(head.rows[0]?.latest_version)
      if (latestVersion === null || latestVersion < 0 || latestVersion >= 2_147_483_647) {
        fail('unavailable')
      }
      const version = latestVersion + 1
      const revisionId = randomUUID()
      await tx.query(
        `/* elearning-portal:insert-revision */
         INSERT INTO elearning_portal_revisions (
           id, org_id, version, site_name, tagline, banner_url, actor_id
         ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
        [
          revisionId,
          orgId,
          version,
          settings.siteName,
          settings.tagline,
          settings.bannerUrl,
          actorId,
        ],
      )
      for (const [index, item] of settings.navigation.entries()) {
        await tx.query(
          `/* elearning-portal:insert-navigation */
           INSERT INTO elearning_portal_revision_navigation (
             org_id, revision_id, position, label, href
           ) VALUES ($1, $2::uuid, $3, $4, $5)`,
          [orgId, revisionId, index + 1, item.label, item.href],
        )
      }
      await tx.query(
        `/* elearning-portal:insert-request */
         INSERT INTO elearning_portal_publish_requests (
           org_id, source_key, request_hash, request_hash_version,
           actor_id, revision_id
         ) VALUES ($1, $2, $3, $4, $5, $6::uuid)`,
        [
          orgId,
          requestId,
          requestHash,
          ELEARNING_PORTAL_REQUEST_HASH_VERSION,
          actorId,
          revisionId,
        ],
      )
      if (head.rows.length === 0) {
        await tx.query(
          `/* elearning-portal:insert-head */
           INSERT INTO elearning_portal_heads (
             org_id, active_revision_id, latest_version
           ) VALUES ($1, $2::uuid, $3)`,
          [orgId, revisionId, version],
        )
      } else {
        const updated = await tx.query(
          `/* elearning-portal:update-head */
           UPDATE elearning_portal_heads
              SET active_revision_id = $1::uuid,
                  latest_version = $2,
                  updated_at = clock_timestamp()
            WHERE org_id = $3 AND latest_version = $4`,
          [revisionId, version, orgId, latestVersion],
        )
        if (updated.rowCount !== 1) fail('unavailable')
      }
      return {
        revisionId,
        version,
        ...settings,
        createdAt: (await loadRevision(tx, orgId, revisionId)).createdAt,
        duplicate: false,
      }
    })
  } catch (error) {
    if (error instanceof ElearningPortalSettingsError) throw error
    fail('unavailable')
  }
}
