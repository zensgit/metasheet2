import { apiFetch } from '../../utils/api'

export interface IntegrationApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: {
    code?: string
    message?: string
    details?: Record<string, unknown>
  }
}

export interface IntegrationScope {
  tenantId?: string
  workspaceId?: string | null
}

export interface IntegrationAdapterMetadata {
  kind: string
  label: string
  roles: Array<'source' | 'target' | 'bidirectional' | string>
  supports: string[]
  advanced: boolean
  guardrails?: {
    read?: Record<string, unknown>
    write?: Record<string, unknown>
    ui?: Record<string, unknown>
    [key: string]: unknown
  }
}

export interface WorkbenchExternalSystem {
  id: string
  tenantId: string
  workspaceId: string | null
  /** Opaque data_sources.id for canonical data-source:sql-readonly bindings. */
  connectionId?: string | null
  name: string
  kind: string
  role: 'source' | 'target' | 'bidirectional'
  status: 'active' | 'inactive' | 'error'
  config?: Record<string, unknown>
  capabilities?: Record<string, unknown>
  hasCredentials?: boolean
  lastTestedAt?: string | null
  lastError?: string | null
}

export interface PlmIntegrationCapabilityFeature {
  supported: boolean
  api_version?: string | null
  entitled?: boolean
  cache_scope?: Record<string, unknown>
  scenarios?: string[]
  actions?: string[]
  action_status?: string | null
  [key: string]: unknown
}

export interface PlmIntegrationCapabilitiesManifest {
  schema_version: string
  provider: string
  advisory: boolean
  features: Record<string, PlmIntegrationCapabilityFeature>
}

export type PlmIntegrationCapabilitiesResult =
  | {
    data_source_id: string
    available: true
    manifest: PlmIntegrationCapabilitiesManifest
  }
  | {
    data_source_id: string
    available: false
    reason?: string
  }

// PLM-COLLAB P3-C: the governed READ-ONLY BOM multi-table review context (provider's P3-A
// surface, relayed by the metasheet2 backend behind the advisory capability gate).
export interface PlmBomMultitableLine {
  bom_line_id: string
  part_id: string
  item_number: string | null
  name: string | null
  state: string | null
  generation: number | null
  quantity: number | null
  uom: string | null
  find_num: string | null
  refdes: string | null
  level: number
  path: string[]
  path_labels: string[]
  source_version: number | null
  source_updated_at: string | null
  sync_status: string
  // Provider optimistic-concurrency tag (may be absent from an older provider).
  write_etag?: string | null
}

export interface PlmBomMultitablePart {
  part_id: string
  item_number: string | null
  name: string | null
  state: string | null
  generation: number | null
}

export interface PlmBomMultitableContext {
  part: PlmBomMultitablePart
  lines: PlmBomMultitableLine[]
  source_version: number | null
  source_updated_at: string | null
  sync_status: string
  template_key: string
}

export type PlmBomMultitableResult =
  | {
    data_source_id: string
    available: true
    entitled: boolean
    context: PlmBomMultitableContext | null
    // a relayed reason on an available+entitled+null-context result means a TRANSIENT
    // provider fetch failure (retry), NOT "this part has no BOM" -- the UI distinguishes them.
    reason?: string
  }
  | {
    data_source_id: string
    available: false
    reason?: string
  }

export interface PlmBomMultitableLinePatch {
  quantity?: number | string | null
  uom?: string | null
  find_num?: string | null
  refdes?: string | null
}

export type PlmBomMultitableLineUpdateResult =
  | {
    ok: true
    bom_line_id: string
  }
  | {
    ok: false
    status: number
    reason: string
    message: string
  }

// ECO Phase 3: result of the locked-BOM revision-intent CTA. `attached: true` = an already-open
// bom-ECO for this part was reused (provider attach-before-create; a repeat click attaches
// instead of spawning a second ECO — that is the idempotency story, no Idempotency-Key).
export type PlmBomEcoRevisionIntentResult =
  | {
    ok: true
    eco_id: string
    state: string
    attached: boolean
  }
  | {
    ok: false
    status: number
    reason: string
    message: string
  }

export interface WorkbenchExternalSystemUpsertRequest extends IntegrationScope {
  id?: string
  projectId?: string | null
  /** Opaque data_sources.id; only used by data-source:sql-readonly. */
  connectionId?: string | null
  name: string
  kind: string
  role: 'source' | 'target' | 'bidirectional'
  status?: 'active' | 'inactive' | 'error'
  config?: Record<string, unknown>
  capabilities?: Record<string, unknown>
  credentials?: unknown
}

export interface WorkbenchExternalSystemDeleteResult {
  deleted: true
  system: WorkbenchExternalSystem
}

export interface IntegrationConnectionTestResult {
  ok: boolean
  status?: string | number
  code?: string
  message?: string
  authenticated?: boolean
  connected?: boolean
  system?: WorkbenchExternalSystem
}

export interface IntegrationObjectSchemaField {
  name: string
  label?: string
  type?: string
  required?: boolean
  [key: string]: unknown
}

export interface IntegrationSystemObject {
  name: string
  object?: string
  label?: string
  operations?: string[]
  source?: string
  target?: string
  schema?: IntegrationObjectSchemaField[]
  template?: Record<string, unknown>
  advanced?: boolean
  // BA-UI-1 (additive TYPING of the existing wire shape — not a wire change): the readonly Bridge
  // Agent adapter's listObjects() has always emitted fieldCount/readonly
  // (bridge-agent-readonly-adapter.cjs normalizeObjectsResponse); the observability section renders
  // fieldCount. Optional — other adapters' object lists don't carry them.
  fieldCount?: number
  readonly?: boolean
}

export interface IntegrationObjectSchema {
  object: string
  fields: IntegrationObjectSchemaField[]
  template?: Record<string, unknown>
  raw?: unknown
}

export interface IntegrationFieldMapping {
  sourceField: string
  targetField: string
  transform?: unknown
  validation?: Array<Record<string, unknown>>
  defaultValue?: unknown
  sortOrder?: number
}

export type IntegrationPipelineMode = 'manual' | 'incremental' | 'full'
export type IntegrationPipelineRunStatus = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type IntegrationDeadLetterStatus = 'open' | 'replayed' | 'discarded'

export interface IntegrationPipeline {
  id: string
  tenantId: string
  workspaceId: string | null
  projectId?: string | null
  name: string
  description?: string | null
  sourceSystemId: string
  sourceObject: string
  targetSystemId: string
  targetObject: string
  stagingSheetId?: string | null
  mode: IntegrationPipelineMode
  idempotencyKeyFields: string[]
  options: Record<string, unknown>
  status: 'draft' | 'active' | 'paused' | 'disabled'
  fieldMappings?: IntegrationFieldMapping[]
  createdAt?: string | null
  updatedAt?: string | null
}

export interface IntegrationPipelineUpsertRequest extends IntegrationScope {
  id?: string
  projectId?: string | null
  name: string
  description?: string
  sourceSystemId: string
  sourceObject: string
  targetSystemId: string
  targetObject: string
  stagingSheetId?: string | null
  mode: IntegrationPipelineMode
  idempotencyKeyFields: string[]
  options: Record<string, unknown>
  status: 'draft' | 'active' | 'paused' | 'disabled'
  fieldMappings: IntegrationFieldMapping[]
}

export interface IntegrationPipelineRunPayload extends IntegrationScope {
  mode: IntegrationPipelineMode
  cursor?: string
  sampleLimit?: number
}

export interface IntegrationPipelineRunResult {
  id?: string
  runId?: string
  pipelineId?: string
  status?: string
  dryRun?: boolean
  metrics?: Record<string, unknown>
  preview?: Record<string, unknown>
  [key: string]: unknown
}

export interface IntegrationExternalWriteDryRunPayload extends IntegrationScope {
  maxRows?: number
}

export interface IntegrationExternalWriteDryRunResult {
  pipelineId?: string
  status?: string
  canApply?: boolean
  dryRunToken?: string | null
  revision?: string
  counts?: Record<string, number>
  evidence?: Record<string, unknown>
  [key: string]: unknown
}

export interface IntegrationExternalWriteApplyPayload extends IntegrationScope {
  confirm: {
    dryRunToken: string
  }
}

export interface IntegrationExternalWriteApplyResult {
  pipelineId?: string
  status?: string
  dryRunRevision?: string
  counts?: Record<string, number>
  rowErrors?: unknown[]
  deadLetters?: Record<string, unknown>
  evidence?: Record<string, unknown>
  run?: {
    id?: string
    status?: string
    provenanceEventsPersisted?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface IntegrationPipelineObservationQuery extends IntegrationScope {
  pipelineId: string
  status?: string
  limit?: number
  offset?: number
}

// One per-record target-write business response (sanitized + capped at 50
// server-side). This is the concrete present-day grain of #1839's RowResult.
export interface IntegrationTargetWriteSummary {
  [key: string]: unknown
}

// Forward-compatible: the runner records `targetWriteSummaries` (row-level write
// results, #1813) and `watermarkAdvanced` inside `run.details` today; unknown
// keys are preserved so new detail fields don't require a type bump.
export interface IntegrationPipelineRunDetails {
  targetWriteSummaries?: IntegrationTargetWriteSummary[]
  watermarkAdvanced?: boolean
  [key: string]: unknown
}

export interface IntegrationPipelineRun {
  id: string
  tenantId: string
  workspaceId: string | null
  pipelineId: string
  mode: IntegrationPipelineMode | string
  triggeredBy?: string | null
  status: IntegrationPipelineRunStatus | string
  rowsRead: number
  rowsCleaned: number
  rowsWritten: number
  rowsFailed: number
  startedAt?: string | null
  finishedAt?: string | null
  durationMs?: number | null
  errorSummary?: string | null
  details?: IntegrationPipelineRunDetails
  createdAt?: string | null
}

export interface IntegrationDeadLetter {
  id: string
  tenantId: string
  workspaceId: string | null
  runId: string
  pipelineId: string
  idempotencyKey?: string | null
  errorCode: string
  errorMessage: string
  retryCount?: number
  status: IntegrationDeadLetterStatus | string
  lastReplayRunId?: string | null
  payloadRedacted?: boolean
  createdAt?: string | null
  updatedAt?: string | null
}

export interface IntegrationStagingDescriptor {
  id: string
  name: string
  fields: string[]
  fieldDetails?: Array<{
    id: string
    name: string
    type: string
    options?: string[]
  }>
}

export interface IntegrationStagingOpenTarget {
  id: string
  name: string
  sheetId: string
  viewId: string
  baseId?: string | null
  openLink: string
}

export interface IntegrationStagingInstallPayload extends IntegrationScope {
  projectId?: string | null
  baseId?: string | null
}

export interface IntegrationStagingInstallResult {
  projectId?: string | null
  sheetIds: Record<string, string>
  viewIds?: Record<string, string>
  openLinks?: Record<string, string>
  targets?: IntegrationStagingOpenTarget[]
  warnings: string[]
}

// DF-T3b-2b UI-wire: binds a from_reference_table domain to the staging system/object that holds its
// mapping sheet. The preview route (DF-T3b-2b) live-bulk-reads each via the staging source-adapter.
export interface IntegrationReferenceMappingSource {
  domain: string
  systemId: string
  object: string
}

export interface IntegrationTemplatePreviewRequest {
  sourceRecord: Record<string, unknown>
  fieldMappings: IntegrationFieldMapping[]
  template?: {
    id?: string
    version?: string
    documentType?: string
    bodyKey?: string
    endpointPath?: string
    schema?: IntegrationObjectSchemaField[]
  }
  // DF-T1.5 reachability wire: when payloadTemplate is a plain object the backend runs the DF-T1
  // no-write preview and returns targetPayloadPreview; omitted = legacy preview (byte-compatible).
  payloadTemplate?: Record<string, unknown>
  fieldRules?: Array<Record<string, unknown>>
  // DF-T3b-2b UI-wire: when present, the preview route live-bulk-reads each domain's mapping sheet so
  // from_reference_table resolves per-material. Omitted = no live resolution (byte-compatible).
  referenceMappingSources?: IntegrationReferenceMappingSource[]
}

// DF-T1.5 reachability wire: derive a minimal DF-T1 fieldRules set from the legacy preview's field
// mappings — each mapped target becomes a from_staging scalar rule (the operator-supplied
// payloadTemplate carries the rest; reference objects stay preserved by the template).
export function deriveFieldRulesFromMappings(
  fieldMappings: IntegrationFieldMapping[],
): Array<Record<string, unknown>> {
  return (Array.isArray(fieldMappings) ? fieldMappings : [])
    .filter((mapping) => typeof mapping?.targetField === 'string' && mapping.targetField.trim()
      && typeof mapping?.sourceField === 'string' && mapping.sourceField.trim())
    .map((mapping) => {
      // The DF-T1 backend transforms the staging record via fieldMappings first, so the transformed
      // record is keyed by TARGET field — from_staging reads by targetField (not the raw sourceField),
      // giving the preview the same transformed value the pipeline would Save.
      const rule: Record<string, unknown> = {
        targetField: mapping.targetField,
        sourceType: 'from_staging',
        sourceField: mapping.targetField,
        shape: 'scalar',
      }
      // Preserve required semantics from the mapping's validation.
      const validation = (mapping as { validation?: Array<{ type?: string }> }).validation
      if (Array.isArray(validation) && validation.some((entry) => entry && entry.type === 'required')) {
        rule.required = true
      }
      return rule
    })
}

// DF-T2b: a typed DF-T1 field rule (produced by the DF-T2a derive helper, edited by the
// authoring UI). Vocabulary mirrors http-routes.cjs DF_T1_* (route-local on the backend).
export interface IntegrationFieldRule {
  targetField: string
  sourceType: 'from_staging' | 'from_constant' | 'preserve_template' | 'from_reference_table'
  sourceField?: string
  value?: unknown
  shape: 'scalar' | 'object-passthrough' | 'by-fnumber' | 'by-fid'
  completeness?: 'none' | 'require-fnumber-fname' | 'require-fid-fname'
  required?: boolean
  // DF-T3b-2d: the reference-mapping domain a from_reference_table rule resolves against.
  domain?: string
}

// DF-T3b-2d: the reference-mapping domains an operator may bind a from_reference_table field to.
// Mirrors the backend built-in templates (K3_REFERENCE_MAPPING_TEMPLATES, #2043). The backend
// validates the domain (unknown → 400), so a stale list here is a non-correctness gap, not a bug.
export const DF_T3_REFERENCE_DOMAINS = [
  'unit', 'unit-group', 'account', 'warehouse', 'manager', 'category',
  'use-state', 'track', 'planning-strategy', 'order-strategy', 'inspection-level', 'inspection-mode',
] as const

export interface IntegrationFieldRuleEditability {
  editable: boolean
  locked: boolean
  reason: 'gated' | 'reference' | null
  isReference: boolean
}

// Whether a field's mode may be edited, and how. The durable REFERENCE identity is the SHAPE
// (object-passthrough / by-* — set by DF-T2a for object values), NOT the sourceType: a *scalar* may
// legitimately be `from_staging` (replace) OR `preserve_template` (preserve). DF-T3b-2d: a reference is
// now **reference-editable** — it may flip between preserve_template and from_reference_table(+domain),
// but is STILL never downgradable to a scalar replace (the v1 no-downgrade rule holds; from_reference_table
// keeps a full reference object, resolved per-material). Gated fields are locked outright and win over
// reference-editability (the gated check is first — e.g. FBaseUnitID stays closed even though it's a reference).
export function fieldRuleEditability(
  rule: Pick<IntegrationFieldRule, 'targetField' | 'shape'>,
  gatedFields: string[] = [],
): IntegrationFieldRuleEditability {
  if (gatedFields.includes(rule.targetField)) {
    return { editable: false, locked: true, reason: 'gated', isReference: false }
  }
  if (rule.shape !== 'scalar') {
    return { editable: true, locked: false, reason: 'reference', isReference: true }
  }
  return { editable: true, locked: false, reason: null, isReference: false }
}

// Pure SCALAR mode setters — called only on an editable scalar field. Shape stays 'scalar'; only the
// replace/preserve mode flips. These never run on a reference/gated field (the UI routes those elsewhere).
export function setFieldRuleReplace(rule: IntegrationFieldRule, sourceField: string): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'from_staging', shape: 'scalar', sourceField }
  delete next.completeness
  delete next.domain
  return next
}

export function setFieldRulePreserve(rule: IntegrationFieldRule): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'preserve_template', shape: 'scalar' }
  delete next.sourceField
  delete next.domain
  return next
}

// DF-T3b-2d: pure REFERENCE mode setters — keep the reference SHAPE (object-passthrough / by-*) and
// completeness; flip only between preserve_template and from_reference_table (+domain). NEVER scalar.
// `setFieldRuleFromReferenceTable(rule, '')` yields the half-state (from_reference_table, no domain) —
// safe: the backend resolver fail-closes a domain-less rule (no index → unresolved), never silently picks.
export function setFieldRuleFromReferenceTable(rule: IntegrationFieldRule, domain: string): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'from_reference_table' }
  if (domain) next.domain = domain
  else delete next.domain
  return next
}

export function setFieldRuleReferencePreserve(rule: IntegrationFieldRule): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule, sourceType: 'preserve_template' }
  delete next.domain
  delete next.sourceField
  return next
}

// DF-T3b dual-binding picker: set the sourceCode COLUMN (rule.sourceField) the resolver reads for a
// from_reference_table reference — the SECOND binding (the sheet binding is referenceMappingSources).
// The preview path reads getPath(sourceRecord, rule.sourceField) (http-routes.cjs), so without this the
// resolver would default to the targetField column and read the wrong value. Empty → drop sourceField.
export function setFieldRuleReferenceSourceField(rule: IntegrationFieldRule, sourceField: string): IntegrationFieldRule {
  const next: IntegrationFieldRule = { ...rule }
  if (sourceField) next.sourceField = sourceField
  else delete next.sourceField
  return next
}

export type IntegrationFieldProvenanceSource = 'staging' | 'template' | 'constant' | 'reference_table'

// DF-T1 target-payload preview evidence — present only when the request carried a payloadTemplate.
// All fields are sanitized metadata (names, counts, provenance sources); never raw payload values.
export interface IntegrationTargetPayloadPreview {
  eligibleForSaveOnly?: boolean
  unresolvedPlaceholders?: string[]
  unresolvedReferenceComponents?: Array<Record<string, unknown>>
  missingRequiredFields?: string[]
  // target field name -> provenance source (string keeps this additive for backend-introduced sources).
  fieldProvenance?: Record<string, IntegrationFieldProvenanceSource | string>
  compositionSource?: string
  redactionSelfCheck?: { applied?: boolean; clean?: boolean }
}

export interface IntegrationTemplatePreviewResult {
  valid: boolean
  payload: Record<string, unknown>
  targetRecord: Record<string, unknown>
  errors: Array<Record<string, unknown>>
  transformErrors: Array<Record<string, unknown>>
  validationErrors: Array<Record<string, unknown>>
  schemaErrors: Array<Record<string, unknown>>
  template?: Record<string, unknown>
  // DF-T1.5: present only in the DF-T1 payloadTemplate preview mode; the legacy preview omits it.
  targetPayloadPreview?: IntegrationTargetPayloadPreview
}

export interface IntegrationFieldProvenanceEntry {
  field: string
  source: string
}

export interface IntegrationFieldProvenanceSummary {
  entries: IntegrationFieldProvenanceEntry[]
  stats: Array<{ source: string; count: number }>
}

// Canonical source order for the DF-T1.5 provenance stats badges.
const FIELD_PROVENANCE_SOURCE_ORDER: IntegrationFieldProvenanceSource[] = ['staging', 'template', 'constant', 'reference_table']

// DF-T1.5 (read-only): derive a names-only provenance view from a DF-T1 targetPayloadPreview.
// Returns null when there is no fieldProvenance (legacy preview) so the UI renders nothing.
// NEVER reads payload values — only field names and their declared source.
export function summarizeFieldProvenance(
  preview: IntegrationTargetPayloadPreview | null | undefined,
): IntegrationFieldProvenanceSummary | null {
  const provenance = preview?.fieldProvenance
  if (!provenance || typeof provenance !== 'object') return null
  const entries: IntegrationFieldProvenanceEntry[] = Object.keys(provenance)
    .sort((a, b) => a.localeCompare(b))
    .map((field) => ({ field, source: String(provenance[field]) }))
  if (entries.length === 0) return null
  const counts = new Map<string, number>()
  for (const { source } of entries) counts.set(source, (counts.get(source) || 0) + 1)
  const stats: Array<{ source: string; count: number }> = []
  for (const source of FIELD_PROVENANCE_SOURCE_ORDER) {
    if (counts.has(source)) {
      stats.push({ source, count: counts.get(source) as number })
      counts.delete(source)
    }
  }
  for (const source of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    stats.push({ source, count: counts.get(source) as number })
  }
  return { entries, stats }
}

// 机器可读的错误码只允许这一种形状（与 stockPreparation/confirmApi.ts 的 ERROR_CODE_PATTERN 同一口径）：
// 值面字符串（物料号、连接串、驱动原文）不可能长成这样，所以从响应体抬到 Error 上的 code 是 values-free 的。
const INTEGRATION_ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/

/**
 * `parseIntegrationResponse` 在非 2xx / `ok:false` 时抛出的 Error 附带的机器可读字段。
 *
 * 为什么要有它：服务端答的是 `{ ok:false, error:{ code, message, details } }`，而这里以前只留
 * `error.message`、把 `code` 丢了 —— 于是调用点只能去匹配英文散文（"external system belongs to the
 * tenant-wide scope" 那种），那是 PG 中文 locale 一类坑的同款脆弱守卫：服务端换一句话、换个语言，
 * 分支就静默失效。现在 code / status / details 一并挂到同一个 Error 上。
 *
 * 兼容性：仍然是 `new Error(message)`，`message` 一字未改、`instanceof Error` 不变，
 * 所有只读 `.message` 的既有调用点行为完全不变；新字段是可选的加法。
 * 不新造错误类：本模块的错误在几十个调用点被 `error instanceof Error` 判着，换类型是无谓的爆炸半径；
 * 也不复用 `StockPreparationConfirmApiError`（那是备料确认专用、且刻意丢掉 message）。
 */
export interface IntegrationApiErrorFields {
  /** 服务端错误码，已按 enum 形状夹紧；响应体没有合法 code 时不存在。取值位置见 `integrationEnvelopeErrorCode`。 */
  code?: string
  /** 失败响应的 HTTP 状态码（例如作用域不匹配的 409）。 */
  status?: number
  /** 服务端 `error.details`（仅当它是普通对象时）。只供判据使用，不直接渲染。 */
  details?: Record<string, unknown>
}

export type IntegrationApiError = Error & IntegrationApiErrorFields

/**
 * 从任意 catch 到的东西里取出集成错误码；不是本模块抛的、或 code 形状不合法时返回 null。
 * 调用点用它代替「按 message 文本判断」，这样服务端换文案不会让分支静默失效。
 */
export function integrationApiErrorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const code = (error as IntegrationApiError).code
  return typeof code === 'string' && INTEGRATION_ERROR_CODE_PATTERN.test(code) ? code : null
}

// F01 —— 产品码不一定在信封顶层。
//
// plugin-integration-core 的 `sendError`（lib/http-routes.cjs）用 `inferErrorCode` 推顶层码，
// 它是 `error.code || error.name || 'INTERNAL_ERROR'`：任何**自己没带 `.code`** 的错误，顶层报的是它的
// **类名**。`PipelineRunnerError`（lib/pipeline-runner.cjs）正是这种形状 —— 只设 `this.details = details`，
// 而它每一条拒绝都把产品码放在 `details.code` 里。于是 K3 `/run` 的拒绝到达前端时长这样：
//
//   422 { ok:false, error:{ code:'PipelineRunnerError',
//                           details:{ code:'K3_WISE_PIPELINE_RUN_DISABLED', pipelineId } } }
//
// （服务端由 plugins/plugin-integration-core/__tests__/http-routes-plm-k3wise-poc.test.cjs 钉死这对
// status + 码。）只读顶层的话，`K3_WISE_PIPELINE_RUN_DISABLED` 永远查不到，人话码表对这一族就是死代码：
// 顶层的 `PipelineRunnerError` 本来就过不了 `INTEGRATION_ERROR_CODE_PATTERN`（大小写混排），
// 夹紧后 code 直接不存在，调用点只能把服务端英文散文直出。
//
// 自己带 `.code` 的错误（`HttpRouteError`、`ExternalWriteDryRunError`）不受影响：顶层合形状就顶层赢，
// 回退只在顶层**不是**合法码时才发生。回退值同样要过同一条 pattern —— 这里不放宽 main 的 values-free 夹紧，
// 只是多看一个位置。它改变的只有「拿哪个字符串去查人话标签」，不能放宽作用域、不能软化守卫，
// 也不会把失败的响应说成成功。
function integrationEnvelopeErrorCode(payload: IntegrationApiEnvelope<unknown> | null): string | undefined {
  const rawTopCode = payload?.error?.code
  if (typeof rawTopCode === 'string' && INTEGRATION_ERROR_CODE_PATTERN.test(rawTopCode)) return rawTopCode
  const rawDetailsCode = (payload?.error?.details as { code?: unknown } | undefined)?.code
  if (typeof rawDetailsCode === 'string' && INTEGRATION_ERROR_CODE_PATTERN.test(rawDetailsCode)) return rawDetailsCode
  return undefined
}

export async function parseIntegrationResponse<T>(response: Response): Promise<T> {
  let payload: IntegrationApiEnvelope<T> | null = null
  try {
    payload = await response.json() as IntegrationApiEnvelope<T>
  } catch {
    payload = null
  }
  if (!response.ok || payload?.ok === false) {
    const message = payload?.error?.message || `${response.status} ${response.statusText}`.trim()
    const rawDetails = payload?.error?.details
    const error = new Error(message || 'Integration API request failed') as IntegrationApiError
    const code = integrationEnvelopeErrorCode(payload)
    if (code) error.code = code
    error.status = response.status
    if (rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails)) error.details = rawDetails
    throw error
  }
  return payload?.data as T
}

function isPlmCapabilitiesManifest(value: unknown): value is PlmIntegrationCapabilitiesManifest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.schema_version === 'string'
    && record.schema_version.length > 0
    && record.provider === 'yuantus-plm'
    && record.advisory === true
    && Boolean(record.features && typeof record.features === 'object' && !Array.isArray(record.features))
  )
}

function normalizePlmCapabilitiesResult(
  dataSourceId: string,
  value: unknown,
): PlmIntegrationCapabilitiesResult {
  if (!value || typeof value !== 'object') {
    return { data_source_id: dataSourceId, available: false, reason: 'unavailable' }
  }
  const record = value as Record<string, unknown>
  const resultDataSourceId = typeof record.data_source_id === 'string' && record.data_source_id.trim()
    ? record.data_source_id.trim()
    : dataSourceId
  if (record.available === true && isPlmCapabilitiesManifest(record.manifest)) {
    return {
      data_source_id: resultDataSourceId,
      available: true,
      manifest: record.manifest,
    }
  }
  return {
    data_source_id: resultDataSourceId,
    available: false,
    reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'unavailable',
  }
}

// P3-C: a DEDICATED normalizer for the BOM multi-table relay (its own shape, not the
// capability manifest). Validates only the envelope + that `context`, when present, is a
// part+lines object; the rows are passed through (forward-compatible with provider additions).
export function isPlmBomMultitableContext(value: unknown): value is PlmBomMultitableContext {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    Boolean(record.part && typeof record.part === 'object' && !Array.isArray(record.part))
    && Array.isArray(record.lines)
  )
}

function normalizePlmBomMultitableResult(
  dataSourceId: string,
  value: unknown,
): PlmBomMultitableResult {
  if (!value || typeof value !== 'object') {
    return { data_source_id: dataSourceId, available: false, reason: 'unavailable' }
  }
  const record = value as Record<string, unknown>
  const resolvedId = typeof record.data_source_id === 'string' && record.data_source_id.trim()
    ? record.data_source_id.trim()
    : dataSourceId
  if (record.available !== true) {
    return {
      data_source_id: resolvedId,
      available: false,
      reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : 'unavailable',
    }
  }
  const entitled = record.entitled === true
  const context = entitled && isPlmBomMultitableContext(record.context) ? record.context : null
  // keep a relayed reason (e.g. 'unavailable' on a transient provider failure) so the UI can
  // tell a transient error apart from a genuinely empty/absent part.
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : undefined
  return { data_source_id: resolvedId, available: true, entitled, context, ...(reason ? { reason } : {}) }
}

export function buildQueryString(input: Record<string, unknown>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  return params.toString()
}

// buildQueryString returns a BARE `a=1&b=2` — no leading `?` — so every call site must remember to
// guard it in with `query ? `?${query}` : ''` before appending it to a path (get this wrong and the
// query string merges straight into the path with no separator, e.g.
// `/api/foo${query}` → `/api/fooa=1&b=2`, a guaranteed 404; see confirmationQueue.ts's O1 fix).
// buildQuerySuffix makes that guard the caller's ONLY option: it always returns either `''` or a
// leading-`?` string, so there is no bare form left to misuse.
export function buildQuerySuffix(input: Record<string, unknown>): string {
  const query = buildQueryString(input)
  return query ? `?${query}` : ''
}

function buildObservationQueryString(query: IntegrationPipelineObservationQuery): string {
  return buildQueryString({
    tenantId: query.tenantId,
    workspaceId: query.workspaceId,
    pipelineId: query.pipelineId,
    status: query.status,
    limit: query.limit,
    offset: query.offset,
  })
}

function getLocalStorageValue(key: string): string {
  if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return ''
  return localStorage.getItem(key) || ''
}

export function getDefaultIntegrationScope(): Required<IntegrationScope> {
  return {
    tenantId: getLocalStorageValue('tenantId') || 'default',
    workspaceId: getLocalStorageValue('workspaceId') || null,
  }
}

// Staging install project IDs are scoped to the integration-core plugin. The
// backend (assertProjectIdAllowedForPlugin) only inspects the final ":"-segment
// and requires it to be exactly one of these namespaces.
const INTEGRATION_PROJECT_NAMESPACES = ['integration-core', 'plugin-integration-core']

export function isIntegrationScopedProjectId(projectId: string): boolean {
  const trimmed = typeof projectId === 'string' ? projectId.trim() : ''
  if (!trimmed) return false
  const suffix = trimmed.split(':').pop()?.trim() ?? ''
  return INTEGRATION_PROJECT_NAMESPACES.includes(suffix)
}

// Deterministic, backend-correct normalize: empty -> tenant-scoped default
// (matches the server auto-scope used when projectId is omitted); already
// scoped -> returned untouched; otherwise the user's input is preserved as a
// prefix and the required ":integration-core" suffix is appended.
export function normalizeIntegrationProjectId(projectId: string, tenantId: string): string {
  const trimmedTenant = (typeof tenantId === 'string' && tenantId.trim()) || 'default'
  const trimmed = typeof projectId === 'string' ? projectId.trim() : ''
  if (!trimmed) return `${trimmedTenant}:integration-core`
  if (isIntegrationScopedProjectId(trimmed)) return trimmed
  return `${trimmed}:integration-core`
}

export async function listIntegrationAdapters(): Promise<IntegrationAdapterMetadata[]> {
  const response = await apiFetch('/api/integration/adapters')
  const data = await parseIntegrationResponse<IntegrationAdapterMetadata[]>(response)
  return Array.isArray(data) ? data : []
}

export async function listWorkbenchExternalSystems(scope: IntegrationScope = {}): Promise<WorkbenchExternalSystem[]> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems${query ? `?${query}` : ''}`)
  const data = await parseIntegrationResponse<WorkbenchExternalSystem[]>(response)
  return Array.isArray(data) ? data : []
}

// ---------------------------------------------------------------------------
// 对接总览 (GET /api/integration/hub/overview)
//
// ONE read-tier call answering "对接了哪些系统、各用哪个连接、谁在用、状态如何". The backend does the
// join and enforces the values-free boundary; these types mirror its response EXACTLY, and
// deliberately have no field for a host, port, connection string, credential or error text —
// if such a field ever appeared here it would mean the backend regressed.
// ---------------------------------------------------------------------------
export interface IntegrationHubBilingualLabel {
  zh: string
  en: string
}

export type IntegrationHubConnectionModel = 'data-source' | 'self-contained' | 'internal'
export type IntegrationHubConnectionUnresolvedReason = 'not_bound' | 'not_visible' | 'directory_unavailable' | null
export type IntegrationHubWriteCapability = 'none' | 'internal' | 'gated' | 'fenced' | 'unregistered'
export type IntegrationHubConsumerType = 'table-action' | 'pipeline' | 'read-source-config' | 'read-source-composition'

export interface IntegrationHubConnection {
  model: IntegrationHubConnectionModel
  bound: boolean
  dataSourceId: string | null
  resolved: boolean
  name: string | null
  type: string | null
  status: string | null
  unresolvedReason: IntegrationHubConnectionUnresolvedReason
}

export interface IntegrationHubConsumer {
  type: IntegrationHubConsumerType
  id: string | null
  name: string | null
  label: IntegrationHubBilingualLabel
  role: string
  count: number
}

export interface IntegrationHubSystem {
  id: string
  name: string | null
  kind: string
  kindLabel: IntegrationHubBilingualLabel
  kindRegistered: boolean
  role: string | null
  status: string | null
  lastTestedAt: string | null
  /** A BOOLEAN, never the failure text — the backend refuses to send the string. */
  hasLastError: boolean
  connection: IntegrationHubConnection
  writeCapability: {
    reads: string
    writes: IntegrationHubWriteCapability
    fenced: boolean
    notice: IntegrationHubBilingualLabel
  }
  consumers: IntegrationHubConsumer[]
  technical: {
    systemId: string
    kind: string
    role: string | null
    status: string | null
    dataSourceId: string | null
    workspaceId: string | null
    createdAt: string | null
    updatedAt: string | null
  }
}

export interface IntegrationHubOverview {
  systemCount: number
  systems: IntegrationHubSystem[]
  dataSourceDirectory: { available: boolean }
}

export async function fetchIntegrationHubOverview(scope: IntegrationScope = {}): Promise<IntegrationHubOverview> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/hub/overview${query ? `?${query}` : ''}`)
  const data = await parseIntegrationResponse<IntegrationHubOverview>(response)
  return {
    systemCount: typeof data?.systemCount === 'number' ? data.systemCount : 0,
    systems: Array.isArray(data?.systems) ? data.systems : [],
    dataSourceDirectory: { available: data?.dataSourceDirectory?.available === true },
  }
}

export async function getPlmDataSourceCapabilities(dataSourceId: string): Promise<PlmIntegrationCapabilitiesResult> {
  const normalizedId = dataSourceId.trim()
  if (!normalizedId) {
    return { data_source_id: '', available: false, reason: 'unavailable' }
  }
  const response = await apiFetch(`/api/plm-workbench/data-sources/${encodeURIComponent(normalizedId)}/capabilities`)
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    return { data_source_id: normalizedId, available: false, reason: 'unavailable' }
  }
  return normalizePlmCapabilitiesResult(normalizedId, payload)
}

// P3-C: the backend relay (/api/plm-workbench/.../bom-multitable/.../context) returns a BARE
// object (NOT the {ok,data} integration envelope), so read response.json() directly + a
// dedicated normalizer -- do NOT route this through parseIntegrationResponse. The relay has
// already done the advisory gate (unsupported -> available:false; unentitled -> available:true
// + entitled:false + context:null without querying the resource).
export async function getPlmBomMultitableContext(
  dataSourceId: string,
  partId: string,
): Promise<PlmBomMultitableResult> {
  const dsId = dataSourceId.trim()
  const pid = partId.trim()
  if (!dsId || !pid) {
    return { data_source_id: dsId, available: false, reason: 'unavailable' }
  }
  const response = await apiFetch(
    `/api/plm-workbench/data-sources/${encodeURIComponent(dsId)}/bom-multitable/${encodeURIComponent(pid)}/context`,
  )
  const payload = await response.json().catch(() => null) as unknown
  if (!response.ok) {
    return { data_source_id: dsId, available: false, reason: 'unavailable' }
  }
  return normalizePlmBomMultitableResult(dsId, payload)
}

export async function updatePlmBomMultitableLine(
  dataSourceId: string,
  partId: string,
  bomLineId: string,
  patch: PlmBomMultitableLinePatch,
  idempotencyKey: string,
  writeEtag?: string | null,
): Promise<PlmBomMultitableLineUpdateResult> {
  const dsId = dataSourceId.trim()
  const pid = partId.trim()
  const lineId = bomLineId.trim()
  const idem = idempotencyKey.trim()
  if (!dsId || !pid || !lineId || !idem) {
    return { ok: false, status: 400, reason: 'invalid-request', message: 'BOM write-back request is incomplete' }
  }

  const payload: PlmBomMultitableLinePatch = {}
  if (patch.quantity !== undefined) payload.quantity = patch.quantity
  if (patch.uom !== undefined) payload.uom = patch.uom
  if (patch.find_num !== undefined) payload.find_num = patch.find_num
  if (patch.refdes !== undefined) payload.refdes = patch.refdes
  if (Object.keys(payload).length === 0) {
    return { ok: false, status: 400, reason: 'empty-patch', message: 'No changed BOM cells to submit' }
  }

  const response = await apiFetch(
    `/api/plm-workbench/data-sources/${encodeURIComponent(dsId)}/bom-multitable/${encodeURIComponent(pid)}/lines/${encodeURIComponent(lineId)}`,
    {
      method: 'PATCH',
      headers: {
        'Idempotency-Key': idem,
        // Send the write_etag verbatim as If-Match when present (optimistic concurrency).
        ...(typeof writeEtag === 'string' && writeEtag ? { 'If-Match': writeEtag } : {}),
      },
      body: JSON.stringify(payload),
      suppressUnauthorizedRedirect: true,
    },
  )
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'writeback-failed',
      message: typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : `BOM write-back failed (${response.status})`,
    }
  }
  if (body?.ok === true && typeof body.bom_line_id === 'string' && body.bom_line_id.trim()) {
    return { ok: true, bom_line_id: body.bom_line_id.trim() }
  }
  return {
    ok: false,
    status: 502,
    reason: 'malformed-response',
    message: 'BOM write-back returned a malformed response',
  }
}

// ECO Phase 3 consumer CTA: request an ECO revision intent for a lifecycle-locked part.
// Bare relay object (NOT parseIntegrationResponse — /api/plm-workbench/* returns bare, like
// getPlmBomMultitableContext). Actionable errors return {ok:false, status, reason, message}
// instead of throwing; reason surfaces the relay's vocabulary (not_locked / eco_intent_rejected /
// unsupported / not-entitled / unavailable / provider-rejected / malformed-response).
export async function requestPlmBomEcoRevisionIntent(
  dataSourceId: string,
  partId: string,
): Promise<PlmBomEcoRevisionIntentResult> {
  const dsId = dataSourceId.trim()
  const pid = partId.trim()
  if (!dsId || !pid) {
    return { ok: false, status: 400, reason: 'invalid-request', message: 'ECO revision request is incomplete' }
  }
  const response = await apiFetch(
    `/api/plm-workbench/data-sources/${encodeURIComponent(dsId)}/bom-multitable/${encodeURIComponent(pid)}/eco-intent`,
    {
      method: 'POST',
      suppressUnauthorizedRedirect: true,
    },
  )
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      reason: typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'intent-failed',
      message: typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : `ECO revision intent failed (${response.status})`,
    }
  }
  if (
    body
    && typeof body.eco_id === 'string' && body.eco_id.trim()
    && typeof body.state === 'string'
    && typeof body.attached === 'boolean'
  ) {
    return { ok: true, eco_id: body.eco_id.trim(), state: body.state, attached: body.attached }
  }
  return {
    ok: false,
    status: 502,
    reason: 'malformed-response',
    message: 'ECO revision intent returned a malformed response',
  }
}

export async function upsertWorkbenchExternalSystem(
  payload: WorkbenchExternalSystemUpsertRequest,
): Promise<WorkbenchExternalSystem> {
  const response = await apiFetch('/api/integration/external-systems', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<WorkbenchExternalSystem>(response)
}

export async function deleteWorkbenchExternalSystem(
  systemId: string,
  scope: IntegrationScope = {},
): Promise<WorkbenchExternalSystemDeleteResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}${query ? `?${query}` : ''}`, {
    method: 'DELETE',
  })
  return parseIntegrationResponse<WorkbenchExternalSystemDeleteResult>(response)
}

export async function listExternalSystemObjects(
  systemId: string,
  scope: IntegrationScope = {},
): Promise<IntegrationSystemObject[]> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/objects${query ? `?${query}` : ''}`)
  const data = await parseIntegrationResponse<IntegrationSystemObject[]>(response)
  return Array.isArray(data) ? data : []
}

export async function getExternalSystemSchema(
  systemId: string,
  input: IntegrationScope & { object: string },
): Promise<IntegrationObjectSchema> {
  const query = buildQueryString({
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    object: input.object,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/schema?${query}`)
  const data = await parseIntegrationResponse<IntegrationObjectSchema>(response)
  return {
    object: data?.object || input.object,
    fields: Array.isArray(data?.fields) ? data.fields : [],
    template: data?.template,
    raw: data?.raw,
  }
}

export async function testExternalSystemConnection(
  systemId: string,
  scope: IntegrationScope = {},
): Promise<IntegrationConnectionTestResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/external-systems/${encodeURIComponent(systemId)}/test${query ? `?${query}` : ''}`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
  return parseIntegrationResponse<IntegrationConnectionTestResult>(response)
}

export async function previewIntegrationTemplate(
  payload: IntegrationTemplatePreviewRequest,
): Promise<IntegrationTemplatePreviewResult> {
  const response = await apiFetch('/api/integration/templates/preview', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationTemplatePreviewResult>(response)
}

// DF-T2c: a values-free entry in the derive evidence summary (field names + shape presence only).
export interface IntegrationTemplateEvidenceField {
  field: string
  sourceType: string
  shape: string
  completeness?: string
  isReference: boolean
  hasValue: boolean
}

// DF-T2c: the draft returned by the read-only derive route. Deliberately carries NO raw
// payloadTemplate (the operator-local customer values stay off the wire) — only the rules, the
// gated field names, and a values-free evidence summary.
export interface IntegrationTemplateDraft {
  fieldRules: IntegrationFieldRule[]
  gatedFields: string[]
  evidence?: {
    fields: IntegrationTemplateEvidenceField[]
    gatedFields: string[]
  }
}

// DF-T2c: derive a draft { payloadTemplate, fieldRules, gatedFields } from a RAW operator-local
// payloadTemplate via the read-only derive route (which runs the DF-T2a helper server-side — no
// duplication, no write; fails closed on redaction markers / secrets / outer {Data:…} envelopes).
export async function deriveIntegrationTemplate(
  payloadTemplate: Record<string, unknown>,
): Promise<IntegrationTemplateDraft> {
  const response = await apiFetch('/api/integration/templates/derive', {
    method: 'POST',
    body: JSON.stringify({ payloadTemplate }),
  })
  return parseIntegrationResponse<IntegrationTemplateDraft>(response)
}

export async function upsertIntegrationPipeline(
  payload: IntegrationPipelineUpsertRequest,
): Promise<IntegrationPipeline> {
  const response = await apiFetch('/api/integration/pipelines', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationPipeline>(response)
}

export async function runIntegrationPipeline(
  pipelineId: string,
  payload: IntegrationPipelineRunPayload,
  dryRun = false,
): Promise<IntegrationPipelineRunResult> {
  const endpoint = dryRun ? 'dry-run' : 'run'
  const response = await apiFetch(`/api/integration/pipelines/${encodeURIComponent(pipelineId)}/${endpoint}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationPipelineRunResult>(response)
}

export async function dryRunIntegrationExternalWrite(
  pipelineId: string,
  payload: IntegrationExternalWriteDryRunPayload,
): Promise<IntegrationExternalWriteDryRunResult> {
  const response = await apiFetch(`/api/integration/pipelines/${encodeURIComponent(pipelineId)}/external-write/dry-run`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationExternalWriteDryRunResult>(response)
}

export async function applyIntegrationExternalWrite(
  pipelineId: string,
  payload: IntegrationExternalWriteApplyPayload,
): Promise<IntegrationExternalWriteApplyResult> {
  const response = await apiFetch(`/api/integration/pipelines/${encodeURIComponent(pipelineId)}/external-write/apply`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationExternalWriteApplyResult>(response)
}

export async function listIntegrationPipelineRuns(
  query: IntegrationPipelineObservationQuery,
): Promise<IntegrationPipelineRun[]> {
  const response = await apiFetch(`/api/integration/runs?${buildObservationQueryString(query)}`)
  const data = await parseIntegrationResponse<IntegrationPipelineRun[]>(response)
  return Array.isArray(data) ? data : []
}

export async function listIntegrationDeadLetters(
  query: IntegrationPipelineObservationQuery,
): Promise<IntegrationDeadLetter[]> {
  const response = await apiFetch(`/api/integration/dead-letters?${buildObservationQueryString(query)}`)
  const data = await parseIntegrationResponse<IntegrationDeadLetter[]>(response)
  return Array.isArray(data) ? data : []
}

// DF-N2-3 read-only: one redacted provenance event in a row's cross-run timeline.
// Mirrors the DF-N2-2c OpenAPI ProvenanceTimelineEntry (GET /api/integration/provenance).
// attrs were redacted at write (DF-N2-2b scrub gate); this read path does NOT re-redact.
export interface IntegrationProvenanceTimelineEntry {
  runId: string
  pipelineId: string
  rowId: string
  eventType: string
  at: string
  attrs: Record<string, unknown>
  eventIndex: number
  runStatus: string
  runMode: string
  runCreatedAt: string
}

export interface IntegrationProvenanceQuery extends IntegrationScope {
  rowId: string
  // pipelineId is sent to avoid cross-pipeline idempotency-key collisions merging
  // unrelated row timelines; the read route applies it as an extra view filter.
  pipelineId?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

// DF-N2-3 (read-only): a row's cross-run provenance timeline from the DF-N2-2c
// by-rowId route. rowId is the idempotency key the provenance view groups on. No
// write/replay/retry; the route is read-only and 501s on hosts without it.
export async function listIntegrationProvenanceByRow(
  query: IntegrationProvenanceQuery,
): Promise<IntegrationProvenanceTimelineEntry[]> {
  const response = await apiFetch(`/api/integration/provenance?${buildQueryString({
    tenantId: query.tenantId,
    workspaceId: query.workspaceId,
    rowId: query.rowId,
    pipelineId: query.pipelineId,
    from: query.from,
    to: query.to,
    limit: query.limit,
    offset: query.offset,
  })}`)
  const data = await parseIntegrationResponse<IntegrationProvenanceTimelineEntry[]>(response)
  return Array.isArray(data) ? data : []
}

export interface IntegrationDeadLetterReplayPayload extends IntegrationScope {
  mode?: IntegrationPipelineMode
}

// Backend returns 202 with { deadLetter, replay, warning? }. `replay` is the
// re-run result; on full success the deadLetter is marked 'replayed'.
export interface IntegrationDeadLetterReplayResult {
  deadLetter?: IntegrationDeadLetter
  replay?: IntegrationPipelineRunResult
  warning?: { code?: string; message?: string }
  [key: string]: unknown
}

export interface IntegrationTableActionParameter {
  id: string
  label?: string
  type?: string
  required?: boolean
  trim?: boolean
  binding?: Record<string, unknown>
}

export interface IntegrationTableActionMetadata {
  actionId: string
  kind: string
  label: string
  configured: boolean
  display?: {
    genericActionKind?: string
    commandLabel?: string
    commandLabelZh?: string
    targetLabel?: string
    targetLabelZh?: string
    presetLabel?: string
    presetLabelZh?: string
    policyLabel?: string
    policyLabelZh?: string
  }
  parameters: IntegrationTableActionParameter[]
  permissions?: {
    dryRun?: string
    apply?: string
  }
  evidence?: Record<string, unknown>
}

export interface IntegrationTableActionDryRunResult {
  action?: IntegrationTableActionMetadata
  status: string
  largeBom?: boolean
  boundedPreview?: {
    complete?: boolean
    authoritative?: boolean
    rowsExpanded?: number
    readCount?: number
    maxRows?: number
    maxPages?: number
    maxReadCount?: number
    maxElapsedMs?: number
    errorTypes?: string[]
  }
  dryRunToken?: string | null
  revision?: string
  canApply?: boolean
  counts?: Record<string, number>
  evidence?: Record<string, unknown> & {
    plan?: {
      duplicateExpandedKeyDiagnostics?: Record<string, unknown>
      duplicateExpandedKeyResolution?: Record<string, unknown>
      conflictPolicyReview?: Record<string, unknown>
      [key: string]: unknown
    }
  }
}

export interface IntegrationTableActionApplyResult {
  action?: IntegrationTableActionMetadata
  status: string
  permission?: string
  dryRunRevision?: string
  apply?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

export interface IntegrationTableActionRequestPayload {
  parameters: Record<string, unknown>
  conflictPolicyReview?: IntegrationTableActionConflictPolicyRequest
  confirm?: {
    dryRunToken?: string
    acceptManualConfirmHold?: boolean
    acceptDuplicateResolution?: boolean
  }
}

export interface IntegrationTableActionConflictPolicySelection {
  fingerprint: string
  policy: string
}

export interface IntegrationTableActionConflictPolicyRequest {
  conflictType: 'duplicate_expanded_key'
  scope?: 'run_only' | 'table_scope'
  policies: IntegrationTableActionConflictPolicySelection[]
}

export interface IntegrationTableActionConflictPolicyDeleteRequest {
  conflictType: 'duplicate_expanded_key'
  fingerprints?: string[]
}

export interface IntegrationTableActionConflictPolicyResult {
  conflictType: string
  scope: string
  targetScopeFingerprint?: string
  policyCount?: number
  policies: Array<IntegrationTableActionConflictPolicySelection & {
    scope?: string
    approvedAtPresent?: boolean
    approvedByPresent?: boolean
  }>
}

export interface IntegrationStockPreparationOptionSyncPayload extends IntegrationScope {
  projectId?: string | null
  optionSets?: Record<string, unknown>
  optionSources?: Record<string, unknown>
  configInfo?: Record<string, unknown>
}

export interface IntegrationStockPreparationOptionSyncResult {
  ok?: boolean
  target?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

export interface IntegrationStockPreparationTargetScope extends IntegrationScope {
  projectId?: string | null
  baseId?: string | null
}

export interface IntegrationStockPreparationTargetReadinessResult {
  ready: boolean
  mode?: string
  targetBinding?: Record<string, unknown> | null
  evidence?: Record<string, unknown>
}

export async function listIntegrationTableActions(scope: IntegrationScope = {}): Promise<IntegrationTableActionMetadata[]> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions${query ? `?${query}` : ''}`)
  const data = await parseIntegrationResponse<IntegrationTableActionMetadata[]>(response)
  return Array.isArray(data) ? data : []
}

export async function dryRunIntegrationTableAction(
  actionId: string,
  payload: IntegrationScope & Pick<IntegrationTableActionRequestPayload, 'parameters' | 'conflictPolicyReview'>,
): Promise<IntegrationTableActionDryRunResult> {
  const query = buildQueryString({
    tenantId: payload.tenantId,
    workspaceId: payload.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions/${encodeURIComponent(actionId)}/dry-run${query ? `?${query}` : ''}`, {
    method: 'POST',
    body: JSON.stringify({
      parameters: payload.parameters,
      ...(payload.conflictPolicyReview ? { conflictPolicyReview: payload.conflictPolicyReview } : {}),
    }),
  })
  return parseIntegrationResponse<IntegrationTableActionDryRunResult>(response)
}

export async function listIntegrationTableActionConflictPolicies(
  actionId: string,
  scope: IntegrationScope = {},
): Promise<IntegrationTableActionConflictPolicyResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions/${encodeURIComponent(actionId)}/conflict-policies${query ? `?${query}` : ''}`)
  return parseIntegrationResponse<IntegrationTableActionConflictPolicyResult>(response)
}

export async function saveIntegrationTableActionConflictPolicies(
  actionId: string,
  payload: IntegrationScope & IntegrationTableActionConflictPolicyRequest,
): Promise<IntegrationTableActionConflictPolicyResult> {
  const query = buildQueryString({
    tenantId: payload.tenantId,
    workspaceId: payload.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions/${encodeURIComponent(actionId)}/conflict-policies${query ? `?${query}` : ''}`, {
    method: 'PUT',
    body: JSON.stringify({
      conflictType: payload.conflictType,
      policies: payload.policies,
    }),
  })
  return parseIntegrationResponse<IntegrationTableActionConflictPolicyResult>(response)
}

export async function deleteIntegrationTableActionConflictPolicies(
  actionId: string,
  payload: IntegrationScope & IntegrationTableActionConflictPolicyDeleteRequest,
): Promise<IntegrationTableActionConflictPolicyResult> {
  const query = buildQueryString({
    tenantId: payload.tenantId,
    workspaceId: payload.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions/${encodeURIComponent(actionId)}/conflict-policies${query ? `?${query}` : ''}`, {
    method: 'DELETE',
    body: JSON.stringify({
      conflictType: payload.conflictType,
      fingerprints: payload.fingerprints,
    }),
  })
  return parseIntegrationResponse<IntegrationTableActionConflictPolicyResult>(response)
}

export async function applyIntegrationTableAction(
  actionId: string,
  payload: IntegrationScope & IntegrationTableActionRequestPayload,
): Promise<IntegrationTableActionApplyResult> {
  const query = buildQueryString({
    tenantId: payload.tenantId,
    workspaceId: payload.workspaceId,
  })
  const response = await apiFetch(`/api/integration/table-actions/${encodeURIComponent(actionId)}/apply${query ? `?${query}` : ''}`, {
    method: 'POST',
    body: JSON.stringify({
      parameters: payload.parameters,
      confirm: payload.confirm,
    }),
  })
  return parseIntegrationResponse<IntegrationTableActionApplyResult>(response)
}

export async function syncIntegrationStockPreparationOptions(
  payload: IntegrationStockPreparationOptionSyncPayload,
): Promise<IntegrationStockPreparationOptionSyncResult> {
  const response = await apiFetch('/api/integration/stock-preparation/options/sync', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationStockPreparationOptionSyncResult>(response)
}

// Readiness inspects the already-bound canonical target; the server only consumes baseId on
// ensure (create/bind). The plain IntegrationScope parameter keeps callers from passing a baseId
// here, and the query builder no longer reads one at all, so the request always mirrors what the
// server evaluates.
export async function getIntegrationStockPreparationTargetReadiness(
  scope: IntegrationScope = {},
): Promise<IntegrationStockPreparationTargetReadinessResult> {
  const query = buildQueryString({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  })
  const response = await apiFetch(`/api/integration/stock-preparation/target/readiness${query ? `?${query}` : ''}`)
  return parseIntegrationResponse<IntegrationStockPreparationTargetReadinessResult>(response)
}

export async function ensureIntegrationStockPreparationTarget(
  payload: IntegrationStockPreparationTargetScope = {},
): Promise<IntegrationStockPreparationTargetReadinessResult> {
  const response = await apiFetch('/api/integration/stock-preparation/target/ensure', {
    method: 'POST',
    body: JSON.stringify({
      tenantId: payload.tenantId,
      workspaceId: payload.workspaceId,
      projectId: payload.projectId,
      baseId: payload.baseId,
    }),
  })
  return parseIntegrationResponse<IntegrationStockPreparationTargetReadinessResult>(response)
}

// FOS-2/FOS-3: generic, preset-driven field-option-sync. Resolves a FOS-1 preset by presetId and
// patches the mapped fields' option metadata only (no business-row write, no external system,
// no action bindings — actions remain the stock-prep-specific route). The server is admin-gated and
// returns values-free evidence. Mirrors the stock-prep payload shape sans action bindings.
export interface IntegrationFieldOptionSyncPayload extends IntegrationScope {
  projectId?: string | null
  optionSets?: Record<string, unknown>
}

export interface IntegrationFieldOptionSyncResult {
  ok?: boolean
  target?: Record<string, unknown>
  evidence?: Record<string, unknown>
}

export async function syncIntegrationFieldOptions(
  presetId: string,
  payload: IntegrationFieldOptionSyncPayload,
): Promise<IntegrationFieldOptionSyncResult> {
  const response = await apiFetch('/api/integration/field-options/sync', {
    method: 'POST',
    body: JSON.stringify({ ...payload, presetId }),
  })
  return parseIntegrationResponse<IntegrationFieldOptionSyncResult>(response)
}

// Only 'open' letters are replayable — the server enforces the same, but the UI
// must not even offer replay for replayed/discarded letters (a second live ERP
// write). Keep this in lock-step with the backend guard in pipeline-runner.cjs.
export function isDeadLetterReplayable(deadLetter: Pick<IntegrationDeadLetter, 'status'>): boolean {
  return deadLetter.status === 'open'
}

// Surfaces the existing dead-letter replay route (POST .../:id/replay). This is
// a single manual one-record re-enqueue (DF-N1) — NOT bounded retry/back-pressure
// orchestration (DF-N3). Replay re-runs the pipeline with the stored payload,
// i.e. a real target write; callers must gate it behind an explicit confirm.
export async function replayIntegrationDeadLetter(
  deadLetterId: string,
  payload: IntegrationDeadLetterReplayPayload,
): Promise<IntegrationDeadLetterReplayResult> {
  const response = await apiFetch(`/api/integration/dead-letters/${encodeURIComponent(deadLetterId)}/replay`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationDeadLetterReplayResult>(response)
}

export async function listIntegrationStagingDescriptors(): Promise<IntegrationStagingDescriptor[]> {
  const response = await apiFetch('/api/integration/staging/descriptors')
  const data = await parseIntegrationResponse<IntegrationStagingDescriptor[]>(response)
  return Array.isArray(data) ? data : []
}

export async function installIntegrationStaging(
  payload: IntegrationStagingInstallPayload,
): Promise<IntegrationStagingInstallResult> {
  const response = await apiFetch('/api/integration/staging/install', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
  return parseIntegrationResponse<IntegrationStagingInstallResult>(response)
}

export function canReadFromSystem(system: WorkbenchExternalSystem): boolean {
  return system.role === 'source' || system.role === 'bidirectional'
}

export function canWriteToSystem(system: WorkbenchExternalSystem): boolean {
  return system.role === 'target' || system.role === 'bidirectional'
}

const NO_SCOPE_WRITE_BLOCK = ''

function normalizeScopeWorkspaceId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 「这一行连接，我在当前作用域里改得动 / 停得掉 / 删得了吗？」—— 空串表示可以；非空是给人看的原因。
 *
 * 它管的就是四个动作：编辑、停用、启用（三个都是 upsert）、删除。**不包括测试连接**，
 * 见下方 `externalSystemScopeTestWriteNote`。把这种行笼统叫「只读」是假的：置灰的量 ≠ 实际写不动的量。
 *
 * 为什么需要它。GET /api/integration/external-systems 的列表对非 null 的 workspace hint 会回退一步，
 * 把同租户 `workspace_id IS NULL` 的行也列出来（单条读 #5471 早就这么做了，列表这次补上）；而 upsert 的
 * findExisting 与 deleteExternalSystem 没有、也不应该跟着放宽，仍按 (tenant, workspace, id) 精确匹配。
 * 回退来的那一行如果还摆着这四个按钮，真实结果是（插件侧
 * plugins/plugin-integration-core/__tests__/external-systems-list-workspace-fallback.test.cjs 的 L-07/L-10 钉着）：
 *   * 编辑 / 停用 / 启用 —— 请求体带着这行的 id（见 IntegrationWorkbenchView 的 deactivateConnection），
 *     findExisting 在本作用域内找不到，服务端直接拒绝：409 `EXTERNAL_SYSTEM_SCOPE_MISMATCH`。
 *     加这道拒绝之前它会滑到 insert 分支沿用同一个 id，撞迁移 057 的 `id TEXT PRIMARY KEY` 报 23505。
 *     两种都是**报错**，不是静默成功，租户级那行不变；
 *   * 删除 → 404；
 *   * 只有**不带 id** 的 name-only upsert（API/脚本直连，不是这几个按钮）才会 fork 出一条同名的 workspace 行
 *     —— 057 的唯一索引是 (tenant_id, coalesce(workspace_id,''), name)，两条都合法。
 * 也就是说这几个按钮对回退来的行是死按钮，所以在屏幕上就拦住并说明原因。这里只是 UX；
 * 真正的边界在服务端（上述 409 / 404），不经浏览器直调路由也一样被拒。
 *
 * 判据只有一条：行自己的 workspaceId 与**这次写将要带上的** hint 不一致。曾经还有一条服务端打的
 * `scopeFallback` 标记，已去掉：它可从 `workspaceId` 推出来，而且标记钉在「拉列表那一刻」而 hint 是实时的
 * —— 工作台改 workspace 输入框并不重拉列表，陈旧标记会把「请到租户级作用域里做」这条提示自己堵死。
 */
export function externalSystemScopeWriteBlock(
  system: Pick<WorkbenchExternalSystem, 'workspaceId'>,
  scope: IntegrationScope = {},
): string {
  if (!system) return NO_SCOPE_WRITE_BLOCK
  const hint = normalizeScopeWorkspaceId(scope.workspaceId)
  const rowScope = normalizeScopeWorkspaceId(system.workspaceId)
  if (rowScope === hint) return NO_SCOPE_WRITE_BLOCK
  return rowScope === null
    ? '这是租户级连接（未归属当前工作区）：在当前工作区里不能编辑 / 停用 / 启用 / 删除——这几个写按精确作用域匹配，服务端会直接拒绝（409 / 404），请清空上方的工作区、到租户级作用域里做。「测试连接」不受此限：它按连接自身的作用域写入，会改这行的 status / last_tested_at / last_error。'
    : '这条连接属于另一个工作区：在当前工作区里不能编辑 / 停用 / 启用 / 删除。'
}

/**
 * 「点测试连接，会写到哪一行？」—— 空串表示就是当前作用域里的那行，没什么好说；非空是给人看的提示。
 *
 * 为什么它不能和 `externalSystemScopeWriteBlock` 合成一条。服务端的
 * POST /api/integration/external-systems/{id}/test 读到系统后调 `persistExternalSystemTestResult`
 * （plugins/plugin-integration-core/lib/http-routes.cjs，#5534），那里**故意**把写入作用域改成「这行自己的」
 * 而不是调用方的 workspace hint，所以对回退来的租户级行，测试连接是**真的写得进去**的（测失败还会把
 * active 翻成 error，而且这个行对本租户所有工作区可见）。拿「只读」盖过去就是假的，所以这里不拦测试连接，
 * 只在测完之后如实说清写到了哪一行。插件侧 L-11 钉着这个行为。
 */
export function externalSystemScopeTestWriteNote(
  system: Pick<WorkbenchExternalSystem, 'workspaceId'> | null | undefined,
  scope: IntegrationScope = {},
): string {
  if (!system) return ''
  const hint = normalizeScopeWorkspaceId(scope.workspaceId)
  const rowScope = normalizeScopeWorkspaceId(system.workspaceId)
  // Only the ONE shape the list fallback produces: a tenant-wide row surfaced to a hinted caller.
  if (hint === null || rowScope !== null) return ''
  return '（这是租户级连接：测试结果已写入租户级的那一行，不受当前工作区限制）'
}

export function isExternalSystemWritableInScope(
  system: Pick<WorkbenchExternalSystem, 'workspaceId'>,
  scope: IntegrationScope = {},
): boolean {
  return externalSystemScopeWriteBlock(system, scope) === NO_SCOPE_WRITE_BLOCK
}
