import { createHash } from 'node:crypto'
import { z } from 'zod'

/**
 * Finite Native release-readiness collaboration source wire.
 * Transport, persistence, and database guards are not in this module.
 * `readinessCollaborationBusinessHash` digests one readiness row. It is not a collection CAS.
 *
 * Item, ruleset, and version ids follow Native `_bounded_id` (`ID_LIMIT` 128): one to 128
 * Unicode code points, no NUL, and no UUID shape. Boundary whitespace is the Python 3.11
 * `str.strip` set measured for that helper. U+FEFF is not in that set. Tenant and org ids
 * follow the existing 64-code-point header-safe scope contract (`Tenant`/`Organization`
 * `String(64)`) and do not use the Python strip set.
 * Resource name, state, issue code, and rule_id take no added 64/128/200 cap. Native projects
 * those strings as-is, item state is an unbounded `String`, and the item resource name is
 * `get_item_number`, not the MBOM/Routing/Baseline `String(200)` / `String(50)` columns.
 * Those strings still reject NUL. Name and state may be null. Timestamps keep the Native
 * four-digit year and microsecond Z text. Year 0001 is legal. Year 0000 is not.
 */
export class ReadinessCollaborationSourceError extends Error {
  readonly name = 'ReadinessCollaborationSourceError'
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export const READINESS_COLLABORATION_PROJECTION_CONTRACT = 'release_readiness_collaboration_source.v1'
export const READINESS_COLLABORATION_FEATURE_KEY = 'collaboration_source_read'
export const READINESS_COLLABORATION_COVERAGE_STATUS = 'bounded_not_proven_complete'
export const READINESS_COLLABORATION_SOURCE_FIELD_TYPE = 'string' as const
export const READINESS_COLLABORATION_SOURCE_FIELDS = [
  'item_id',
  'ruleset_id',
  'generated_at',
  'coverage_status',
  'resources_count',
  'ok_resources',
  'error_count',
  'warning_count',
  'resources',
] as const
export const READINESS_COLLABORATION_LOCAL_FIELDS = [
  { key: 'collaboration_owner', type: 'person' },
  { key: 'followup_due_at', type: 'dateTime' },
  { key: 'review_note', type: 'longText' },
] as const
export const READINESS_COLLABORATION_RESOURCE_CAPS = [
  { kind: 'mbom_release', resource_type: 'mbom', cap: 20 },
  { kind: 'routing_release', resource_type: 'routing', cap: 20 },
  { kind: 'baseline_release', resource_type: 'baseline', cap: 20 },
  { kind: 'item_release', resource_type: 'item', cap: 1 },
] as const

const REQUEST_ID_MAX = 128
const SCOPE_ID_MAX = 64
const NATIVE_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/

type ResourceKind = (typeof READINESS_COLLABORATION_RESOURCE_CAPS)[number]['kind']
type ResourceType = (typeof READINESS_COLLABORATION_RESOURCE_CAPS)[number]['resource_type']

const RESOURCE_TYPE_BY_KIND: Record<ResourceKind, ResourceType> = {
  mbom_release: 'mbom',
  routing_release: 'routing',
  baseline_release: 'baseline',
  item_release: 'item',
}
const RESOURCE_CAP_BY_KIND: Record<ResourceKind, number> = {
  mbom_release: 20,
  routing_release: 20,
  baseline_release: 20,
  item_release: 1,
}

function codePointLength(value: string): number {
  let count = 0
  for (let index = 0; index < value.length;) {
    count += 1
    index += (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
  }
  return count
}

// Python 3.11 str.strip characters from the Native `_bounded_id` oracle. U+FEFF is absent.
const PYTHON_311_STRIP = new Set<number>([
  9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288,
])

function hasPython311BoundaryWhitespace(value: string): boolean {
  // All 29 Native whitespace characters are BMP; boundary code units are sufficient.
  return PYTHON_311_STRIP.has(value.charCodeAt(0)) || PYTHON_311_STRIP.has(value.charCodeAt(value.length - 1))
}

function isRequestId(value: string): boolean {
  const length = codePointLength(value)
  return length > 0
    && length <= REQUEST_ID_MAX
    && !value.includes('\0')
    && !hasPython311BoundaryWhitespace(value)
}

function isScopeId(value: string): boolean {
  return codePointLength(value) > 0
    && codePointLength(value) <= SCOPE_ID_MAX
    && value === value.trim()
    && !value.includes('\0')
    && !/[\r\n]/.test(value)
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
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}

function isUnboundedNativeText(value: string): boolean {
  return !value.includes('\0')
}

function isResourceId(value: string): boolean {
  return codePointLength(value) > 0 && !value.includes('\0')
}

function isSafeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

const requestId = z.string().refine(isRequestId)
const scopeId = z.string().refine(isScopeId)
const nativeTimestamp = z.string().refine(isNativeUtcTimestamp)
const unboundedText = z.string().refine(isUnboundedNativeText)
const resourceId = z.string().refine(isResourceId)
const safeCount = z.number().refine(isSafeCount)

const issueSchema = z.object({
  code: unboundedText,
  rule_id: unboundedText,
}).strict()

const resourceSchema = z.object({
  kind: z.enum(['mbom_release', 'routing_release', 'baseline_release', 'item_release']),
  name: unboundedText.nullable(),
  state: unboundedText.nullable(),
  resource_type: z.enum(['mbom', 'routing', 'baseline', 'item']),
  resource_id: resourceId,
  errors: z.array(issueSchema),
  warnings: z.array(issueSchema),
}).strict().superRefine((resource, ctx) => {
  if (resource.resource_type !== RESOURCE_TYPE_BY_KIND[resource.kind]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'resource pair' })
  }
})

const summarySchema = z.object({
  resources: safeCount,
  ok_resources: safeCount,
  error_count: safeCount,
  warning_count: safeCount,
}).strict()

const readinessSchema = z.object({
  item_id: requestId,
  ruleset_id: requestId,
  generated_at: nativeTimestamp,
  coverage_status: z.literal(READINESS_COLLABORATION_COVERAGE_STATUS),
  summary: summarySchema,
  resources: z.array(resourceSchema),
}).strict().superRefine((readiness, ctx) => {
  const counts: Record<ResourceKind, number> = {
    mbom_release: 0,
    routing_release: 0,
    baseline_release: 0,
    item_release: 0,
  }
  const seen = new Set<string>()
  let errorCount = 0
  let warningCount = 0
  let okResources = 0
  for (const resource of readiness.resources) {
    counts[resource.kind] += 1
    const identity = JSON.stringify([resource.kind, resource.resource_type, resource.resource_id])
    if (seen.has(identity)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate resource' })
      return
    }
    seen.add(identity)
    errorCount += resource.errors.length
    warningCount += resource.warnings.length
    if (resource.errors.length === 0) okResources += 1
  }
  for (const kind of Object.keys(counts) as ResourceKind[]) {
    if (counts[kind] > RESOURCE_CAP_BY_KIND[kind]) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'resource cap' })
      return
    }
  }
  const summary = readiness.summary
  if (
    summary.resources !== readiness.resources.length
    || summary.ok_resources !== okResources
    || summary.error_count !== errorCount
    || summary.warning_count !== warningCount
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'summary' })
  }
})

const successSchema = z.object({
  projection_contract: z.literal(READINESS_COLLABORATION_PROJECTION_CONTRACT),
  feature_key: z.literal(READINESS_COLLABORATION_FEATURE_KEY),
  entitled: z.literal(true),
  source: z.object({
    tenant_id: scopeId,
    org_id: scopeId,
    item_id: requestId,
    current_version_id: requestId.nullable(),
  }).strict(),
  snapshot_at: nativeTimestamp,
  readiness: readinessSchema,
}).strict()

export interface ReadinessCollaborationIssue {
  code: string
  rule_id: string
}

export interface ReadinessCollaborationResource {
  kind: ResourceKind
  name: string | null
  state: string | null
  resource_type: ResourceType
  resource_id: string
  errors: ReadinessCollaborationIssue[]
  warnings: ReadinessCollaborationIssue[]
}

export interface ReadinessCollaborationSourceInput {
  itemId: string
  rulesetId: string
  currentVersionId: string | null
}

export interface ReadinessCollaborationAnchor {
  tenantId: string
  orgId: string
  itemId: string
  rulesetId: string
  currentVersionId: string | null
}

export interface ReadinessCollaborationSource {
  projection_contract: typeof READINESS_COLLABORATION_PROJECTION_CONTRACT
  feature_key: typeof READINESS_COLLABORATION_FEATURE_KEY
  entitled: true
  source: {
    tenant_id: string
    org_id: string
    item_id: string
    current_version_id: string | null
  }
  snapshot_at: string
  readiness: {
    item_id: string
    ruleset_id: string
    generated_at: string
    coverage_status: typeof READINESS_COLLABORATION_COVERAGE_STATUS
    summary: {
      resources: number
      ok_resources: number
      error_count: number
      warning_count: number
    }
    resources: ReadinessCollaborationResource[]
  }
}

export interface ReadinessCollaborationBusinessMaterial {
  row_key: readonly [string, string, string, string, string]
  item_id: string
  current_version_id: string | null
  coverage_status: typeof READINESS_COLLABORATION_COVERAGE_STATUS
  summary: ReadinessCollaborationSource['readiness']['summary']
  resources: ReadinessCollaborationResource[]
}

export interface ReadinessCollaborationSourceCells {
  item_id: string
  ruleset_id: string
  generated_at: string
  coverage_status: string
  resources_count: string
  ok_resources: string
  error_count: string
  warning_count: string
  resources: string
}

const inputSchema = z.object({
  itemId: requestId,
  rulesetId: requestId,
  currentVersionId: requestId.nullable(),
}).strict()

function entitledFalse(value: unknown): boolean {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as { entitled?: unknown }).entitled === false
}

function reject(status: number, code: string): never {
  throw new ReadinessCollaborationSourceError(status, code)
}

export function parseReadinessCollaborationSourceInput(value: unknown): ReadinessCollaborationSourceInput {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) reject(422, 'READINESS_SOURCE_INPUT_INVALID')
  return {
    itemId: parsed.data.itemId,
    rulesetId: parsed.data.rulesetId,
    currentVersionId: parsed.data.currentVersionId,
  }
}

function copyIssue(issue: ReadinessCollaborationIssue): ReadinessCollaborationIssue {
  return { code: issue.code, rule_id: issue.rule_id }
}

function copyResource(resource: ReadinessCollaborationResource): ReadinessCollaborationResource {
  return {
    kind: resource.kind,
    name: resource.name,
    state: resource.state,
    resource_type: resource.resource_type,
    resource_id: resource.resource_id,
    errors: resource.errors.map(copyIssue),
    warnings: resource.warnings.map(copyIssue),
  }
}

export function parseReadinessCollaborationSource(
  value: unknown,
  expected: ReadinessCollaborationAnchor,
): ReadinessCollaborationSource {
  if (entitledFalse(value)) reject(403, 'READINESS_SOURCE_UNLICENSED')
  const parsed = successSchema.safeParse(value)
  if (!parsed.success) reject(502, 'READINESS_SOURCE_REJECTED')
  const snapshot = parsed.data
  const itemResources = snapshot.readiness.resources.filter((resource) => resource.kind === 'item_release')
  if (
    snapshot.source.tenant_id !== expected.tenantId
    || snapshot.source.org_id !== expected.orgId
    || snapshot.source.item_id !== expected.itemId
    || snapshot.source.current_version_id !== expected.currentVersionId
    || snapshot.readiness.item_id !== expected.itemId
    || snapshot.readiness.ruleset_id !== expected.rulesetId
    || itemResources.some((resource) => resource.resource_id !== expected.itemId)
  ) {
    reject(409, 'READINESS_SOURCE_ANCHOR_MISMATCH')
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
    readiness: {
      item_id: snapshot.readiness.item_id,
      ruleset_id: snapshot.readiness.ruleset_id,
      generated_at: snapshot.readiness.generated_at,
      coverage_status: snapshot.readiness.coverage_status,
      summary: {
        resources: snapshot.readiness.summary.resources,
        ok_resources: snapshot.readiness.summary.ok_resources,
        error_count: snapshot.readiness.summary.error_count,
        warning_count: snapshot.readiness.summary.warning_count,
      },
      resources: snapshot.readiness.resources.map(copyResource),
    },
  }
}

export function readinessCollaborationRowKey(input: {
  dataSourceId: string
  tenantId: string
  orgId: string
  itemId: string
  rulesetId: string
}): readonly [string, string, string, string, string] {
  if (
    !isRequestId(input.dataSourceId)
    || !isScopeId(input.tenantId)
    || !isScopeId(input.orgId)
    || !isRequestId(input.itemId)
    || !isRequestId(input.rulesetId)
  ) {
    reject(422, 'READINESS_SOURCE_INPUT_INVALID')
  }
  return [input.dataSourceId, input.tenantId, input.orgId, input.itemId, input.rulesetId]
}

export function readinessCollaborationBusinessMaterial(
  dataSourceId: string,
  snapshot: ReadinessCollaborationSource,
): ReadinessCollaborationBusinessMaterial {
  return {
    row_key: readinessCollaborationRowKey({
      dataSourceId,
      tenantId: snapshot.source.tenant_id,
      orgId: snapshot.source.org_id,
      itemId: snapshot.source.item_id,
      rulesetId: snapshot.readiness.ruleset_id,
    }),
    item_id: snapshot.source.item_id,
    current_version_id: snapshot.source.current_version_id,
    coverage_status: snapshot.readiness.coverage_status,
    summary: {
      resources: snapshot.readiness.summary.resources,
      ok_resources: snapshot.readiness.summary.ok_resources,
      error_count: snapshot.readiness.summary.error_count,
      warning_count: snapshot.readiness.summary.warning_count,
    },
    resources: snapshot.readiness.resources.map(copyResource),
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function readinessCollaborationBusinessHash(
  dataSourceId: string,
  snapshot: ReadinessCollaborationSource,
): string {
  return createHash('sha256')
    .update(canonicalJson(readinessCollaborationBusinessMaterial(dataSourceId, snapshot)))
    .digest('hex')
}

function canonicalDecimal(value: number): string {
  if (!isSafeCount(value)) reject(502, 'READINESS_SOURCE_REJECTED')
  return String(value)
}

export function readinessCollaborationSourceCells(
  snapshot: ReadinessCollaborationSource,
): ReadinessCollaborationSourceCells {
  return {
    item_id: snapshot.readiness.item_id,
    ruleset_id: snapshot.readiness.ruleset_id,
    generated_at: snapshot.readiness.generated_at,
    coverage_status: snapshot.readiness.coverage_status,
    resources_count: canonicalDecimal(snapshot.readiness.summary.resources),
    ok_resources: canonicalDecimal(snapshot.readiness.summary.ok_resources),
    error_count: canonicalDecimal(snapshot.readiness.summary.error_count),
    warning_count: canonicalDecimal(snapshot.readiness.summary.warning_count),
    resources: canonicalJson(snapshot.readiness.resources),
  }
}
