import { createHash, randomUUID } from 'node:crypto'

import {
  ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION,
  ElearningCertificatePolicyError,
  normalizeElearningCertificateIssue,
  parseElearningCertificateTemplateParameters,
} from './elearning-certificate-policy'

const POSTGRES_INT4_MAX = 2_147_483_647
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH_RE = /^[0-9a-f]{64}$/
const TEMPLATE_REQUEST_DOMAIN = 'elearning.certificate.template.request.v1'
const TEMPLATE_REQUEST_HASH_VERSION = 1
const TEMPLATE_NAME_MAX = 512
const TEMPLATE_TEXT_MAX = 16 * 1024
const BACKGROUND_URL_MAX = 2_048

export type ElearningCertificateSurfaceErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'not_found'
  | 'unavailable'

export class ElearningCertificateSurfaceError extends Error {
  constructor(readonly code: ElearningCertificateSurfaceErrorCode) {
    super(code)
    this.name = 'ElearningCertificateSurfaceError'
  }
}

export interface ElearningCertificateQueryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface ElearningCertificateDb extends ElearningCertificateQueryable {
  transaction<T>(handler: (tx: ElearningCertificateQueryable) => Promise<T>): Promise<T>
}

export interface ElearningCertificateTemplate {
  certificateId: string
  revisionId: string
  version: number
  name: string
  templateText: string
  backgroundImageUrl: string | null
  placeholders: string[]
  createdAt: string
}

export interface PublishElearningCertificateTemplateInput {
  orgId: string
  actorId: string
  requestId: unknown
  certificateId: unknown
  name: unknown
  templateText: unknown
  backgroundImageUrl: unknown
}

export interface ElearningCertificateIssue {
  issueId: string
  certificateId: string
  templateRevisionId: string
  templateName: string
  serialNumber: string
  parameters: Record<string, string>
  backgroundImageUrl: string | null
  issuedAt: string
}

export interface IssueElearningCertificateInput {
  orgId: string
  actorId: string
  requestId: unknown
  certificateId: unknown
  userId: unknown
  parameters: unknown
}

function fail(code: ElearningCertificateSurfaceErrorCode): never {
  throw new ElearningCertificateSurfaceError(code)
}

function requireText(value: unknown, max = 512): string {
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > max || text.includes('\0')) fail('invalid_input')
  for (let index = 0; index < text.length; index += 1) {
    const point = text.charCodeAt(index)
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) fail('invalid_input')
      index += 1
    } else if (point >= 0xdc00 && point <= 0xdfff) fail('invalid_input')
  }
  return text
}

function requireTemplateText(value: unknown): string {
  if (typeof value !== 'string' || value.length > TEMPLATE_TEXT_MAX) fail('invalid_input')
  try {
    parseElearningCertificateTemplateParameters(value)
  } catch {
    fail('invalid_input')
  }
  return value
}

function normalizeBackgroundImageUrl(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') fail('invalid_input')
  const text = value.trim()
  if (text === '' || text.length > BACKGROUND_URL_MAX) fail('invalid_input')
  try {
    const url = new URL(text)
    if (
      url.protocol !== 'https:'
      || url.username !== ''
      || url.password !== ''
      || url.hash !== ''
      || url.toString() !== text
    ) fail('invalid_input')
    return text
  } catch (error) {
    if (error instanceof ElearningCertificateSurfaceError) throw error
    fail('invalid_input')
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

function hashTemplateRequest(input: {
  certificateId: string
  name: string
  templateText: string
  backgroundImageUrl: string | null
}): string {
  return createHash('sha256').update(canonicalize({
    ...input,
    domain: TEMPLATE_REQUEST_DOMAIN,
    version: TEMPLATE_REQUEST_HASH_VERSION,
  }), 'utf8').digest('hex')
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

function storedParameters(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('unavailable')
  const result = Object.create(null) as Record<string, string>
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const stored = (value as Record<string, unknown>)[key]
    if (typeof stored !== 'string') fail('unavailable')
    Object.defineProperty(result, key, { enumerable: true, value: stored })
  }
  return result
}

function templateFromRow(row: Record<string, unknown>): ElearningCertificateTemplate {
  const certificateId = storedText(row.certificate_key)
  const revisionId = storedUuid(row.revision_id)
  const version = storedInt(row.version)
  const name = storedText(row.name)
  const templateText = typeof row.template_text === 'string' ? row.template_text : null
  const backgroundImageUrl = row.background_image_url === null
    ? null
    : storedText(row.background_image_url)
  const createdAt = storedDate(row.created_at)
  if (
    !certificateId
    || !revisionId
    || version === null
    || version < 1
    || version > POSTGRES_INT4_MAX
    || !name
    || templateText === null
    || !createdAt
    || (row.background_image_url !== null && !backgroundImageUrl)
  ) fail('unavailable')
  let placeholders: readonly string[]
  try {
    placeholders = parseElearningCertificateTemplateParameters(templateText)
  } catch {
    fail('unavailable')
  }
  return {
    certificateId,
    revisionId,
    version,
    name,
    templateText,
    backgroundImageUrl,
    placeholders: [...placeholders],
    createdAt,
  }
}

function issueFromRow(row: Record<string, unknown>): ElearningCertificateIssue {
  const issueId = storedUuid(row.issue_id)
  const certificateId = storedText(row.certificate_key)
  const templateRevisionId = storedUuid(row.template_revision_id)
  const templateName = storedText(row.template_name)
  const serialNumber = storedUuid(row.serial_number)
  const backgroundImageUrl = row.background_image_url === null
    ? null
    : storedText(row.background_image_url)
  const issuedAt = storedDate(row.issued_at)
  if (
    !issueId
    || !certificateId
    || !templateRevisionId
    || !templateName
    || !serialNumber
    || !issuedAt
    || (row.background_image_url !== null && !backgroundImageUrl)
  ) fail('unavailable')
  return {
    issueId,
    certificateId,
    templateRevisionId,
    templateName,
    serialNumber,
    parameters: storedParameters(row.parameter_snapshot),
    backgroundImageUrl,
    issuedAt,
  }
}

export async function listActiveElearningCertificateTemplates(
  db: ElearningCertificateQueryable,
  orgIdInput: string,
): Promise<ElearningCertificateTemplate[]> {
  const orgId = requireText(orgIdInput)
  try {
    const result = await db.query(
      `/* elearning-certificate:list-templates */
       SELECT head.certificate_key, revision.id::text AS revision_id,
              revision.version, revision.name, revision.template_text,
              revision.background_image_url, revision.created_at
       FROM elearning_certificate_heads head
       JOIN elearning_certificate_revisions revision
         ON revision.org_id = head.org_id
        AND revision.head_id = head.id
        AND revision.id = head.active_revision_id
       WHERE head.org_id = $1
       ORDER BY head.certificate_key`,
      [orgId],
    )
    return result.rows.map(templateFromRow)
  } catch (error) {
    if (error instanceof ElearningCertificateSurfaceError) throw error
    fail('unavailable')
  }
}

export async function publishElearningCertificateTemplate(
  db: ElearningCertificateDb,
  input: PublishElearningCertificateTemplateInput,
): Promise<ElearningCertificateTemplate> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const requestId = requireText(input.requestId)
  const certificateId = requireText(input.certificateId)
  const name = requireText(input.name, TEMPLATE_NAME_MAX)
  const templateText = requireTemplateText(input.templateText)
  const backgroundImageUrl = normalizeBackgroundImageUrl(input.backgroundImageUrl)
  const requestHash = hashTemplateRequest({
    certificateId,
    name,
    templateText,
    backgroundImageUrl,
  })

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-certificate:template-request-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-certificate-template-request', `${orgId}:${requestId}`],
      )
      const existing = await tx.query(
        `/* elearning-certificate:load-template-request */
         SELECT request.request_hash, request.request_hash_version,
                head.certificate_key, revision.id::text AS revision_id,
                revision.version, revision.name, revision.template_text,
                revision.background_image_url, revision.created_at
         FROM elearning_certificate_template_requests request
         JOIN elearning_certificate_revisions revision
           ON revision.org_id = request.org_id
          AND revision.id = request.revision_id
         JOIN elearning_certificate_heads head
           ON head.org_id = revision.org_id
          AND head.id = revision.head_id
         WHERE request.org_id = $1 AND request.source_key = $2
         FOR SHARE`,
        [orgId, requestId],
      )
      if (existing.rows.length > 1) fail('unavailable')
      if (existing.rows[0]) {
        if (
          storedText(existing.rows[0].request_hash) !== requestHash
          || storedInt(existing.rows[0].request_hash_version) !== TEMPLATE_REQUEST_HASH_VERSION
        ) fail('conflict')
        return templateFromRow(existing.rows[0])
      }

      await tx.query(
        `/* elearning-certificate:template-head-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-certificate-template-head', `${orgId}:${certificateId}`],
      )
      const proposedHeadId = randomUUID()
      await tx.query(
        `/* elearning-certificate:ensure-template-head */
         INSERT INTO elearning_certificate_heads (
           org_id, certificate_key, id, latest_version
         ) VALUES ($1, $2, $3::uuid, 0)
         ON CONFLICT (org_id, certificate_key) DO NOTHING`,
        [orgId, certificateId, proposedHeadId],
      )
      const head = await tx.query(
        `/* elearning-certificate:lock-template-head */
         SELECT id::text, latest_version
         FROM elearning_certificate_heads
         WHERE org_id = $1 AND certificate_key = $2
         FOR UPDATE`,
        [orgId, certificateId],
      )
      const headId = storedUuid(head.rows[0]?.id)
      const latestVersion = storedInt(head.rows[0]?.latest_version)
      if (!headId || latestVersion === null || latestVersion < 0 || head.rows.length !== 1) {
        fail('unavailable')
      }
      const version = latestVersion + 1
      if (version > POSTGRES_INT4_MAX) fail('unavailable')
      const revisionId = randomUUID()
      const revision = await tx.query(
        `/* elearning-certificate:insert-template-revision */
         INSERT INTO elearning_certificate_revisions (
           id, org_id, head_id, certificate_key, version, actor_id, name,
           template_text, background_image_url
         ) VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9)
         RETURNING created_at`,
        [
          revisionId,
          orgId,
          headId,
          certificateId,
          version,
          actorId,
          name,
          templateText,
          backgroundImageUrl,
        ],
      )
      const createdAt = storedDate(revision.rows[0]?.created_at)
      if (!createdAt || revision.rows.length !== 1) fail('unavailable')
      const moved = await tx.query(
        `/* elearning-certificate:activate-template-revision */
         UPDATE elearning_certificate_heads
         SET active_revision_id = $3::uuid, latest_version = $4, updated_at = now()
         WHERE org_id = $1 AND certificate_key = $2`,
        [orgId, certificateId, revisionId, version],
      )
      if (moved.rowCount !== 1) fail('unavailable')
      await tx.query(
        `/* elearning-certificate:record-template-request */
         INSERT INTO elearning_certificate_template_requests (
           org_id, source_key, request_hash, request_hash_version,
           actor_id, revision_id
         ) VALUES ($1, $2, $3, $4, $5, $6::uuid)`,
        [
          orgId,
          requestId,
          requestHash,
          TEMPLATE_REQUEST_HASH_VERSION,
          actorId,
          revisionId,
        ],
      )
      return {
        certificateId,
        revisionId,
        version,
        name,
        templateText,
        backgroundImageUrl,
        placeholders: [...parseElearningCertificateTemplateParameters(templateText)],
        createdAt,
      }
    })
  } catch (error) {
    if (error instanceof ElearningCertificateSurfaceError) throw error
    fail('unavailable')
  }
}

function normalizeIssueOrFail(input: Parameters<typeof normalizeElearningCertificateIssue>[0]) {
  try {
    return normalizeElearningCertificateIssue(input)
  } catch (error) {
    if (error instanceof ElearningCertificatePolicyError) fail('invalid_input')
    fail('invalid_input')
  }
}

export async function issueElearningCertificate(
  db: ElearningCertificateDb,
  input: IssueElearningCertificateInput,
): Promise<ElearningCertificateIssue> {
  const orgId = requireText(input.orgId)
  const actorId = requireText(input.actorId)
  const requestId = requireText(input.requestId)
  const certificateId = requireText(input.certificateId)
  const userId = requireText(input.userId)

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `/* elearning-certificate:issue-request-lock */
         SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        ['elearning-certificate-issue-request', `${orgId}:${requestId}`],
      )
      const existing = await tx.query(
        `/* elearning-certificate:load-issue-request */
         SELECT issue.id::text AS issue_id, issue.certificate_key,
                issue.template_revision_id::text, issue.serial_number::text,
                issue.parameter_snapshot, issue.issued_at,
                issue.effect_key, issue.request_hash, issue.request_hash_version,
                issue.user_id, revision.name AS template_name,
                revision.template_text, revision.background_image_url
         FROM elearning_certificate_issues issue
         JOIN elearning_certificate_revisions revision
           ON revision.org_id = issue.org_id
          AND revision.id = issue.template_revision_id
         WHERE issue.org_id = $1 AND issue.source_key = $2
         FOR SHARE`,
        [orgId, requestId],
      )
      if (existing.rows.length > 1) fail('unavailable')
      if (existing.rows[0]) {
        const row = existing.rows[0]
        const templateRevisionId = storedUuid(row.template_revision_id)
        const templateText = typeof row.template_text === 'string' ? row.template_text : null
        const issuedAt = storedDate(row.issued_at)
        if (!templateRevisionId || templateText === null || !issuedAt) fail('unavailable')
        const normalized = normalizeIssueOrFail({
          certificateId,
          effectKey: requestId,
          issuedAt,
          orgId,
          parameters: input.parameters,
          templateRevisionId,
          templateText,
          userId,
        })
        if (
          storedText(row.effect_key) !== requestId
          || storedText(row.request_hash) !== normalized.requestHash
          || storedInt(row.request_hash_version) !== ELEARNING_CERTIFICATE_ISSUE_HASH_VERSION
        ) fail('conflict')
        return issueFromRow(row)
      }

      const template = await tx.query(
        `/* elearning-certificate:load-active-template */
         SELECT head.certificate_key, revision.id::text AS revision_id,
                revision.name, revision.template_text,
                revision.background_image_url
         FROM elearning_certificate_heads head
         JOIN elearning_certificate_revisions revision
           ON revision.org_id = head.org_id
          AND revision.head_id = head.id
          AND revision.id = head.active_revision_id
         WHERE head.org_id = $1 AND head.certificate_key = $2
         FOR SHARE`,
        [orgId, certificateId],
      )
      if (template.rows.length !== 1) fail('not_found')
      const member = await tx.query(
        `/* elearning-certificate:target-membership */
         SELECT 1 AS ok
         FROM user_orgs membership
         JOIN users account ON account.id = membership.user_id
         WHERE membership.org_id = $1
           AND membership.user_id = $2
           AND membership.is_active = true
           AND account.is_active = true
         FOR SHARE OF membership, account`,
        [orgId, userId],
      )
      if (member.rows.length !== 1) fail('not_found')
      const templateRevisionId = storedUuid(template.rows[0]?.revision_id)
      const templateName = storedText(template.rows[0]?.name)
      const templateText = typeof template.rows[0]?.template_text === 'string'
        ? template.rows[0].template_text
        : null
      const backgroundImageUrl = template.rows[0]?.background_image_url === null
        ? null
        : storedText(template.rows[0]?.background_image_url)
      if (
        !templateRevisionId
        || !templateName
        || templateText === null
        || (template.rows[0]?.background_image_url !== null && !backgroundImageUrl)
      ) fail('unavailable')
      const normalized = normalizeIssueOrFail({
        certificateId,
        effectKey: requestId,
        issuedAt: new Date().toISOString(),
        orgId,
        parameters: input.parameters,
        templateRevisionId,
        templateText,
        userId,
      })
      const issueId = randomUUID()
      const serialNumber = randomUUID()
      const inserted = await tx.query(
        `/* elearning-certificate:insert-issue */
         INSERT INTO elearning_certificate_issues (
           id, org_id, user_id, certificate_key, template_revision_id,
           actor_id, source_key, effect_key, request_hash,
           request_hash_version, serial_number, parameter_snapshot, issued_at
         ) VALUES (
           $1::uuid, $2, $3, $4, $5::uuid,
           $6, $7, $8, $9, $10, $11::uuid, $12::jsonb, $13::timestamptz
         )
         RETURNING issued_at`,
        [
          issueId,
          orgId,
          userId,
          certificateId,
          templateRevisionId,
          actorId,
          requestId,
          requestId,
          normalized.requestHash,
          normalized.requestHashVersion,
          serialNumber,
          JSON.stringify(normalized.parameterSnapshot),
          normalized.issuedAt,
        ],
      )
      const issuedAt = storedDate(inserted.rows[0]?.issued_at)
      if (!issuedAt || inserted.rows.length !== 1) fail('unavailable')
      return {
        issueId,
        certificateId,
        templateRevisionId,
        templateName,
        serialNumber,
        parameters: { ...normalized.parameterSnapshot },
        backgroundImageUrl,
        issuedAt,
      }
    })
  } catch (error) {
    if (error instanceof ElearningCertificateSurfaceError) throw error
    fail('unavailable')
  }
}

export async function listMyElearningCertificates(
  db: ElearningCertificateQueryable,
  orgIdInput: string,
  userIdInput: string,
): Promise<ElearningCertificateIssue[]> {
  const orgId = requireText(orgIdInput)
  const userId = requireText(userIdInput)
  try {
    const member = await db.query(
      `/* elearning-certificate:list-membership */
       SELECT 1 AS ok
       FROM user_orgs membership
       JOIN users account ON account.id = membership.user_id
       WHERE membership.org_id = $1 AND membership.user_id = $2
         AND membership.is_active = true AND account.is_active = true`,
      [orgId, userId],
    )
    if (member.rows.length !== 1) fail('not_found')
    const result = await db.query(
      `/* elearning-certificate:list-issues */
       SELECT issue.id::text AS issue_id, issue.certificate_key,
              issue.template_revision_id::text, issue.serial_number::text,
              issue.parameter_snapshot, issue.issued_at,
              revision.name AS template_name, revision.background_image_url
       FROM elearning_certificate_issues issue
       JOIN elearning_certificate_revisions revision
         ON revision.org_id = issue.org_id
        AND revision.id = issue.template_revision_id
       WHERE issue.org_id = $1 AND issue.user_id = $2
       ORDER BY issue.issued_at DESC, issue.id DESC
       LIMIT 100`,
      [orgId, userId],
    )
    return result.rows.map(issueFromRow)
  } catch (error) {
    if (error instanceof ElearningCertificateSurfaceError) throw error
    fail('unavailable')
  }
}

export function isElearningCertificateHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value)
}
