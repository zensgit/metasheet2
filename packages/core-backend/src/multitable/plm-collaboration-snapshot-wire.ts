import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Finite Native ECO collaboration source wire.
 * Readiness is not represented here. Persistence, consent, and database guards are not accepted.
 * `ecoCollaborationBusinessHash` digests one ECO row. It is not a collection CAS.
 *
 * Whitelist nullability and lengths follow the fixed Native `ECO` columns:
 * id is the primary key; name String(100) and eco_type String(20) are non-null;
 * product_id, source_version_id, target_version_id, stage_id, state String(20),
 * kanban_state String(20), priority String(10), and updated_at DateTime are nullable.
 * Tenant and org ids follow auth Tenant/Organization String(64). Item, ECO, and version
 * request ids follow the Native collaboration parser limit of 128.
 * Those limits count Unicode code points, matching Python str len. The text is not normalized.
 * Timestamps keep the Native four-digit year and microsecond Z text. Year 0001 is legal.
 * Year 0000 is not. An accepted snapshot still requires product_id to equal the fixed item id.
 */
export class EcoCollaborationSourceError extends Error {
  readonly name = 'EcoCollaborationSourceError'
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export const ECO_COLLABORATION_PROJECTION_CONTRACT = 'eco_collaboration_source.v1'
export const ECO_COLLABORATION_FEATURE_KEY = 'collaboration_source_read'
export const ECO_COLLABORATION_SOURCE_FIELDS = [
  'tenant_id',
  'org_id',
  'item_id',
  'current_version_id',
] as const
export const ECO_COLLABORATION_ECO_FIELDS = [
  'id',
  'name',
  'eco_type',
  'product_id',
  'source_version_id',
  'target_version_id',
  'stage_id',
  'state',
  'kanban_state',
  'priority',
  'updated_at',
] as const
export const ECO_COLLABORATION_LOCAL_FIELDS = [
  { key: 'collaboration_owner', type: 'person' },
  { key: 'followup_due_at', type: 'dateTime' },
  { key: 'review_note', type: 'longText' },
] as const

const REQUEST_ID_MAX = 128
const SCOPE_ID_MAX = 64
const NATIVE_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/

function codePointLength(value: string): number {
  // Python str len and the ORM string lengths count code points, not UTF-16 units.
  let count = 0
  for (let index = 0; index < value.length;) {
    count += 1
    index += (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
  }
  return count
}

export function isEcoCollaborationId(value: unknown, max: number): value is string {
  return typeof value === 'string'
    && codePointLength(value) > 0
    && codePointLength(value) <= max
    && value === value.trim()
    && !value.includes('\0')
}

function isRequestId(value: string): boolean {
  return isEcoCollaborationId(value, REQUEST_ID_MAX)
}

function isScopeId(value: string): boolean {
  return isEcoCollaborationId(value, SCOPE_ID_MAX) && !/[\r\n]/.test(value)
}

function isNativeUtcTimestamp(value: string): boolean {
  const match = NATIVE_UTC_TIMESTAMP.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  // Date.UTC maps years 0 through 99 onto 1900 through 1999.
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}

const requestId = z.string().refine(isRequestId)
const scopeId = z.string().refine(isScopeId)
const nativeText = (max?: number) => z.string().refine((value) =>
  !value.includes('\0') && (max === undefined || codePointLength(value) <= max))
const nativeTimestamp = z.string().refine(isNativeUtcTimestamp)

const sourceSchema = z.object({
  tenant_id: scopeId,
  org_id: scopeId,
  item_id: requestId,
  current_version_id: requestId.nullable(),
}).strict()

const ecoSchema = z.object({
  id: requestId,
  name: nativeText(100),
  eco_type: nativeText(20),
  product_id: nativeText().nullable(),
  source_version_id: nativeText().nullable(),
  target_version_id: nativeText().nullable(),
  stage_id: nativeText().nullable(),
  state: nativeText(20).nullable(),
  kanban_state: nativeText(20).nullable(),
  priority: nativeText(10).nullable(),
  updated_at: nativeTimestamp.nullable(),
}).strict()

const successSchema = z.object({
  projection_contract: z.literal(ECO_COLLABORATION_PROJECTION_CONTRACT),
  feature_key: z.literal(ECO_COLLABORATION_FEATURE_KEY),
  entitled: z.literal(true),
  source: sourceSchema,
  snapshot_at: nativeTimestamp,
  eco: ecoSchema,
}).strict()

export interface EcoCollaborationSourceInput {
  itemId: string
  ecoId: string
  currentVersionId: string | null
}

export interface EcoCollaborationAnchor {
  tenantId: string
  orgId: string
  itemId: string
  ecoId: string
  currentVersionId: string | null
}

export interface EcoCollaborationSource {
  projection_contract: typeof ECO_COLLABORATION_PROJECTION_CONTRACT
  feature_key: typeof ECO_COLLABORATION_FEATURE_KEY
  entitled: true
  source: {
    tenant_id: string
    org_id: string
    item_id: string
    current_version_id: string | null
  }
  snapshot_at: string
  eco: {
    id: string
    name: string
    eco_type: string
    product_id: string
    source_version_id: string | null
    target_version_id: string | null
    stage_id: string | null
    state: string | null
    kanban_state: string | null
    priority: string | null
    updated_at: string | null
  }
}

const inputSchema = z.object({
  itemId: requestId,
  ecoId: requestId,
  currentVersionId: requestId.nullable(),
}).strict()

export function parseEcoCollaborationSourceInput(value: unknown): EcoCollaborationSourceInput {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) throw new EcoCollaborationSourceError(422, 'ECO_SOURCE_INPUT_INVALID')
  return {
    itemId: parsed.data.itemId,
    ecoId: parsed.data.ecoId,
    currentVersionId: parsed.data.currentVersionId,
  }
}

function entitledFalse(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { entitled?: unknown }).entitled === false
}

export function parseEcoCollaborationSource(
  value: unknown,
  expected: EcoCollaborationAnchor,
): EcoCollaborationSource {
  if (entitledFalse(value)) throw new EcoCollaborationSourceError(403, 'ECO_SOURCE_UNLICENSED')
  const parsed = successSchema.safeParse(value)
  if (!parsed.success) throw new EcoCollaborationSourceError(502, 'ECO_SOURCE_REJECTED')
  const snapshot = parsed.data
  const productId = snapshot.eco.product_id
  if (
    snapshot.source.tenant_id !== expected.tenantId
    || snapshot.source.org_id !== expected.orgId
    || snapshot.source.item_id !== expected.itemId
    || snapshot.source.current_version_id !== expected.currentVersionId
    || snapshot.eco.id !== expected.ecoId
    || productId !== expected.itemId
  ) {
    throw new EcoCollaborationSourceError(409, 'ECO_SOURCE_ANCHOR_MISMATCH')
  }
  return {
    projection_contract: snapshot.projection_contract,
    feature_key: snapshot.feature_key,
    entitled: true,
    source: {
      tenant_id: snapshot.source.tenant_id,
      org_id: snapshot.source.org_id,
      item_id: snapshot.source.item_id,
      current_version_id: snapshot.source.current_version_id,
    },
    snapshot_at: snapshot.snapshot_at,
    eco: {
      id: snapshot.eco.id,
      name: snapshot.eco.name,
      eco_type: snapshot.eco.eco_type,
      product_id: productId,
      source_version_id: snapshot.eco.source_version_id,
      target_version_id: snapshot.eco.target_version_id,
      stage_id: snapshot.eco.stage_id,
      state: snapshot.eco.state,
      kanban_state: snapshot.eco.kanban_state,
      priority: snapshot.eco.priority,
      updated_at: snapshot.eco.updated_at,
    },
  }
}

export function ecoCollaborationRowKey(input: {
  dataSourceId: string
  tenantId: string
  orgId: string
  ecoId: string
}): readonly [string, string, string, string] {
  if (
    !isEcoCollaborationId(input.dataSourceId, REQUEST_ID_MAX)
    || !isScopeId(input.tenantId)
    || !isScopeId(input.orgId)
    || !isRequestId(input.ecoId)
  ) {
    throw new EcoCollaborationSourceError(422, 'ECO_SOURCE_INPUT_INVALID')
  }
  return [input.dataSourceId, input.tenantId, input.orgId, input.ecoId]
}

export interface EcoCollaborationBusinessMaterial {
  row_key: readonly [string, string, string, string]
  item_id: string
  current_version_id: string | null
  eco: EcoCollaborationSource['eco']
}

export function ecoCollaborationBusinessMaterial(
  dataSourceId: string,
  snapshot: EcoCollaborationSource,
): EcoCollaborationBusinessMaterial {
  return {
    row_key: ecoCollaborationRowKey({
      dataSourceId,
      tenantId: snapshot.source.tenant_id,
      orgId: snapshot.source.org_id,
      ecoId: snapshot.eco.id,
    }),
    item_id: snapshot.source.item_id,
    current_version_id: snapshot.source.current_version_id,
    eco: {
      id: snapshot.eco.id,
      name: snapshot.eco.name,
      eco_type: snapshot.eco.eco_type,
      product_id: snapshot.eco.product_id,
      source_version_id: snapshot.eco.source_version_id,
      target_version_id: snapshot.eco.target_version_id,
      stage_id: snapshot.eco.stage_id,
      state: snapshot.eco.state,
      kanban_state: snapshot.eco.kanban_state,
      priority: snapshot.eco.priority,
      updated_at: snapshot.eco.updated_at,
    },
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function ecoCollaborationBusinessHash(
  dataSourceId: string,
  snapshot: EcoCollaborationSource,
): string {
  return createHash('sha256')
    .update(canonical(ecoCollaborationBusinessMaterial(dataSourceId, snapshot)))
    .digest('hex')
}
