import { WeldingError, signWeldingAssertion, weldingAvailable, weldingWriteAvailable, type WeldingProvider } from './provider'
import { requireWeldingSession } from './session'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export interface WeldingAuthority {
  schema: 'yuantus.welding_generation_authority/1'
  owner: { tenant_id: string; org_id: string; auth_user_id: number; rbac_user_id: number }
}

const TIMEOUT_MS = 5000
const MAX_BYTES = 32768
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}
function text(value: unknown, max = 255): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value)
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

// Only three fixed operations call this transport. No caller-provided path or URL enters it.
async function upstream(config: WeldingProvider, path: string, body?: object, token?: string): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error()) }, TIMEOUT_MS)
      }),
      (async () => {
        const response = await fetch(`${config.origin}${path}`, {
          method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!response.ok || response.redirected || !response.body || Number(response.headers.get('content-length') || 0) > MAX_BYTES) throw new Error()
        reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > MAX_BYTES) throw new Error()
          chunks.push(chunk.value)
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      })(),
    ])
  } catch {
    throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
}

function activeDownload(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
}

async function waitForDownload<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  activeDownload(signal)
  if (!signal) return work()
  let rejectAbort!: (reason: WeldingError) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const abort = () => rejectAbort(new WeldingError('WELDING_UPSTREAM_REJECTED', 502))
  signal.addEventListener('abort', abort, { once: true })
  try {
    const result = await Promise.race([work(), aborted])
    activeDownload(signal)
    return result
  } finally { signal.removeEventListener('abort', abort) }
}

async function withWeldingPrincipal<T>(config: WeldingProvider, token: string, authenticatedTenantId: string | undefined,
  action: (bearer: string, authority: WeldingAuthority, recheck: () => Promise<unknown>) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const session = await waitForDownload(signal, () => requireWeldingSession(token, authenticatedTenantId, config))
  const recheck = () => waitForDownload(signal, () => requireWeldingSession(token, authenticatedTenantId, config, session))
  const challenge = await waitForDownload(signal, () => upstream(config, '/api/v1/auth/sso/challenge', { provider: config.provider }))
  if (!object(challenge, ['state', 'nonce', 'expires_in']) || !text(challenge.state, 512) || !text(challenge.nonce, 512) || !integer(challenge.expires_in) || challenge.expires_in > 3600) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  await recheck()
  const nonce = challenge.nonce
  const assertion = await waitForDownload(signal, () => signWeldingAssertion(config, session, nonce))
  // Key-file IO is also a wait boundary; do not dispatch login after a revocation during it.
  await recheck()
  const login = await waitForDownload(signal, () => upstream(config, '/api/v1/auth/sso/login', { state: challenge.state, id_token: assertion }))
  if (!object(login, ['access_token', 'token_type', 'expires_in', 'tenant_id', 'user_id']) || !text(login.access_token, 16384) || login.token_type !== 'bearer' || !integer(login.expires_in) || login.tenant_id !== config.tenantId || !integer(login.user_id)) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  await recheck()
  const bearer = login.access_token
  const authority = await waitForDownload(signal, () => upstream(config, '/api/v1/plugins/welding/generation-authority', undefined, bearer))
  if (!object(authority, ['schema', 'owner']) || authority.schema !== 'yuantus.welding_generation_authority/1' || !object(authority.owner, ['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id']) ||
    authority.owner.tenant_id !== config.tenantId || authority.owner.org_id !== config.orgId || authority.owner.auth_user_id !== login.user_id || !integer(authority.owner.rbac_user_id)) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  await recheck()
  activeDownload(signal)
  return action(bearer, authority as unknown as WeldingAuthority, recheck)
}

export async function weldingAuthority(config: WeldingProvider, token: string, authenticatedTenantId: string | undefined): Promise<WeldingAuthority> {
  return withWeldingPrincipal(config, token, authenticatedTenantId, async (_bearer, authority) => authority)
}

export interface WeldingPlanOperation {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  write: boolean
  body?: Buffer
  result: 'list' | 'candidates' | 'product-context' | 'recovery' | 'record' | 'resource-record' | 'resource-catalog' | 'resource-version-catalog' | 'reference-catalog' | 'source-review' | 'source-changes' | 'source-change' | 'source-document' | 'source-preparation' | 'cad-context' | 'empty' | 'templates' | 'generation-create' | 'generation-list' | 'generation-status' | 'generation-retry' | 'generation-file' | 'workflow-state' | 'workflow-history' | 'workflow-validate' | 'workflow-ack' | 'workflow-final' | 'workflow-revision' | 'workflow-resolution' | 'publication' | 'publication-file' | 'publication-directory' | 'publication-comparison' | 'reuse-ack' | 'reuse-resolution' | 'reuse-provenance'
    | 'reuse-product-candidates' | 'reuse-product-context' | 'reuse-bom-candidates' | 'bom-candidates' | 'assembly-preview' | 'assembly-apply' | 'resource-diagram'
  planId?: string
  versionId?: string
  productId?: string
  productVersionId?: string
  changeId?: string
  side?: string
  contextId?: string
  generationId?: string
  purpose?: string
  command?: string
  fromVersionId?: string
  toVersionId?: string
  format?: 'pdf' | 'docx'
  resourceId?: string
  resourceVersionId?: string
  catalogLimit?: number
}

const DOMAIN_TIMEOUT_MS = 60000
const DOMAIN_MAX_BYTES = 11 * 1024 * 1024
const BOM_CANDIDATES_MAX_BYTES = 21 * 1024 * 1024
const RESOURCE_RECORD_MAX_BYTES = 32 * 1024 * 1024
const RESOURCE_CATALOG_MAX_BYTES = 2 * 1024 * 1024
const PREPARATION_MAX_BYTES = 24 * 1024 * 1024
const GENERATION_LIST_MAX_BYTES = 2 * 1024 * 1024
const GENERATION_STATUS_MAX_BYTES = 128 * 1024
const GENERATION_ACK_MAX_BYTES = 64 * 1024
const WORKFLOW_ACK_MAX_BYTES = 64 * 1024
const WORKFLOW_STATE_MAX_BYTES = 24 * 1024 * 1024
const WORKFLOW_HISTORY_MAX_BYTES = 64 * 1024 * 1024
const PUBLICATION_MAX_BYTES = 2 * 1024 * 1024
const BINARY_MAX_BYTES = 128 * 1024 * 1024
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const shape = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const page = (value: Record<string, unknown>): boolean => Array.isArray(value.items) && count(value.total) && count(value.offset) &&
  count(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= 100
function boundPage(value: Record<string, unknown>, operation: WeldingPlanOperation, defaultLimit = 50, maxLimit = 100): boolean {
  const query = new URLSearchParams(operation.path.split('?', 2)[1] || '')
  return page(value) && (value.limit as number) <= maxLimit && value.limit === Number(query.get('limit') || defaultLimit) && value.offset === Number(query.get('offset') || 0)
}

function originalRequest(operation: WeldingPlanOperation): Record<string, unknown> | null {
  if (!operation.body) return null
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(operation.body))
    return shape(value) ? value : null
  } catch { return null }
}

function validOrigin(value: unknown, authority: WeldingAuthority): value is Record<string, unknown> {
  if (!shape(value) || value.schema !== 'yuantus.welding_plan_cad_origin/1' ||
    value.owner_auth_user_id !== authority.owner.auth_user_id || value.rbac_user_id !== authority.owner.rbac_user_id ||
    !hash(value.bundle_sha256) || !shape(value.input) || !hash(value.input.sha256) || !count(value.input.bytes) ||
    !shape(value.document) || !hash(value.document.sha256) || !count(value.document.bytes) ||
    !shape(value.basis) || !shape(value.source) || !text(value.unit, 64)) return false
  return true
}

function sourceMatches(source: unknown, drawing: unknown): boolean {
  return shape(source) && shape(drawing) && typeof source.checksum === 'string' && /^[0-9a-fA-F]{64}$/.test(source.checksum) &&
    hash(drawing.expected_checksum) && source.checksum.toLowerCase() === drawing.expected_checksum &&
    ['item_id', 'version_id', 'file_id', 'file_role'].every(key => text(drawing[key], 64) && source[key] === drawing[key])
}

function validPreparationSide(side: unknown, viewerPin: unknown, allowHistoricalProductVersion = false): boolean {
  if (!shape(side) || !shape(side.payload) || !shape(side.sources) || !shape(side.document) ||
    !shape(side.document.cadgf_document) || !shape(side.document.origin)) return false
  const payload = side.payload
  const sources = side.sources
  const witness = side.document.origin
  if (!shape(payload.product) || !shape(payload.drawing) || !shape(sources.product) || !shape(sources.drawing) ||
    !shape(witness.basis) || !shape(witness.basis.product) || !shape(witness.basis.drawing) ||
    !shape(witness.input) || !shape(witness.document) || !shape(witness.source) ||
    !['yuantus.welding_plan_cad_origin/1', 'yuantus.welding_plan_cad_review_origin/1'].includes(String(witness.schema)) ||
    !hash(witness.bundle_sha256) || !hash(witness.input.sha256) || !count(witness.input.bytes) ||
    !hash(witness.document.sha256) || !count(witness.document.bytes) || !hash(witness.source.fingerprint) ||
    side.document.view_bundle_sha256 !== viewerPin ||
    !(isDeepStrictEqual(witness.basis.product, payload.product) ||
      allowHistoricalProductVersion && witness.schema === 'yuantus.welding_plan_cad_origin/1' &&
      shape(sources.overlay_origin) &&
      text(witness.basis.product.item_id, 64) && witness.basis.product.item_id === payload.product.item_id &&
      text(witness.basis.product.version_id, 64) && text(payload.product.version_id, 64)) ||
    !isDeepStrictEqual(witness.basis.drawing, payload.drawing) ||
    !['item_id', 'version_id'].every(key => sources.product[key] === payload.product[key]) ||
    !sourceMatches(sources.drawing, payload.drawing) || !sourceMatches(witness.source, payload.drawing) ||
    witness.input.sha256 !== payload.drawing.expected_checksum) return false
  if (sources.overlay_origin !== undefined && sources.overlay_origin !== null)
    return isDeepStrictEqual(sources.overlay_origin, witness)
  return witness.schema === 'yuantus.welding_plan_cad_review_origin/1'
}

function validContext(value: Record<string, unknown>, operation: WeldingPlanOperation, authority: WeldingAuthority): boolean {
  if (!validOrigin(value.origin, authority)) return false
  const origin = value.origin
  const input = origin.input as Record<string, unknown>
  const document = origin.document as Record<string, unknown>
  const basis = origin.basis as Record<string, unknown>
  if (!text(value.context_id, 64) || value.plan_id !== operation.planId || value.item_version_id !== operation.versionId ||
    operation.contextId && value.context_id !== operation.contextId || !integer(value.draft_seq) ||
    !text(value.expires_at, 64) || !shape(value.source) || !shape(value.cadgf_document) ||
    origin.context_id !== value.context_id || value.input_sha256 !== input.sha256 || value.document_sha256 !== document.sha256 ||
    value.unit !== origin.unit || !shape(basis.product) || !shape(basis.drawing) ||
    !sourceMatches(value.source, basis.drawing) || !hash((value.source as Record<string, unknown>).fingerprint) ||
    !isDeepStrictEqual(value.source, origin.source) || input.sha256 !== basis.drawing.expected_checksum ||
    value.editor_url !== `/welding-cad/${origin.bundle_sha256}/welding-frame.html`) return false
  if (operation.result === 'source-preparation') {
    const change = value.source_change
    if (!shape(change) || !hash(change.expected_content_hash) || !hash(change.preparation_digest) ||
      !validPreparationSide(change.before, origin.bundle_sha256, true) ||
      !validPreparationSide(change.after, origin.bundle_sha256)) return false
    const before = change.before as Record<string, unknown>
    const after = change.after as Record<string, unknown>
    const beforePayload = before.payload as Record<string, unknown>
    const afterPayload = after.payload as Record<string, unknown>
    const afterDocument = after.document as Record<string, unknown>
    const afterSources = after.sources as Record<string, unknown>
    if (!isDeepStrictEqual(beforePayload.product, basis.product) ||
      !isDeepStrictEqual(afterPayload, { ...beforePayload, drawing: basis.drawing }) ||
      !isDeepStrictEqual(afterDocument.origin, origin) ||
      !isDeepStrictEqual(afterSources.overlay_origin, origin)) return false
  }
  if (operation.method === 'POST') {
    const request = originalRequest(operation)
    if (!request || !text(request.open_id, 64) || !integer(request.expected_draft_seq) || value.draft_seq !== request.expected_draft_seq) return false
    if (operation.result === 'source-preparation') {
      if (!hash(request.expected_content_hash) || !shape(request.drawing) || !shape(value.source_change)) return false
      const drawing = request.drawing
      if (!shape(basis.drawing) || !text(drawing.expected_checksum, 64) ||
        basis.drawing.expected_checksum !== drawing.expected_checksum.toLowerCase() ||
        !['item_id', 'version_id', 'file_id', 'file_role'].every(key => basis.drawing[key] === drawing[key])) return false
      const change = value.source_change
      if (change.expected_content_hash !== request.expected_content_hash) return false
    }
  }
  return true
}

const generationId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
function generationFixed(value: Record<string, unknown>, purpose: 'review' | 'final'): boolean {
  return generationId(value.generation_id) && hash(value.render_key) && text(value.plan_id, 64) &&
    text(value.item_version_id, 64) && integer(value.draft_seq) && hash(value.plan_content_hash) &&
    hash(value.generation_content_hash) && value.purpose === purpose && shape(value.template) &&
    text(value.template.id, 64) && text(value.template.version, 64) && hash(value.template.digest) &&
    (purpose === 'review' || text(value.approval_request_id, 64) && hash(value.submission_hash) && hash(value.decision_hash))
}

function generationStatus(value: unknown, purpose: 'review' | 'final'): boolean {
  if (!shape(value) || value.schema !== (purpose === 'review' ? 'yuantus.welding_plan_generation/1' : 'yuantus.welding_final_generation/1') ||
    !generationFixed(value, purpose) || !['Queued', 'Running', 'Ready', 'Failed'].includes(String(value.status)) ||
    !count(value.attempt) || !text(value.created_at, 64) || !shape(value.files) ||
    value.error !== null && (!shape(value.error) || !text(value.error.stage, 128) || !text(value.error.code, 128) || !text(value.error.message, 2000))) return false
  if (purpose === 'review') {
    if (!shape(value.review) || !count(value.review.pending_count) || !count(value.review.unbound_count)) return false
  } else if (!text(value.state, 64)) return false
  for (const format of ['pdf', 'docx'] as const) {
    const file = value.files[format]
    if (value.status !== 'Ready') { if (file !== null) return false; continue }
    if (!shape(file) || file.format !== format || file.mime_type !== (format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
      !integer(file.byte_size) || file.byte_size > 128 * 1024 * 1024 || !hash(file.artifact_sha256)) return false
  }
  return true
}

const workflowCommands = ['submit', 'review', 'withdraw', 'reopen', 'final-render', 'release', 'final-retry', 'revise']
export const pythonWhitespace = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/
export function sourceSafeId(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  const chars = Array.from(value)
  if (chars.length > 64 || pythonWhitespace.test(chars[0]) || pythonWhitespace.test(chars[chars.length - 1]) ||
    /[\r\n\0]/.test(value)) return false
  try { encodeURIComponent(value) } catch { return false }
  return true
}
function sourceLongText(value: unknown): value is string {
  if (typeof value !== 'string' || Array.from(value).length > 4000 || value.includes('\0')) return false
  try { encodeURIComponent(value) } catch { return false }
  return true
}
const sourceHash = (value: unknown): value is string => hash(value) && value.length === 64
const meaningfulSourceText = (value: string): boolean => Array.from(value).some(char => !pythonWhitespace.test(char))
function workflowOriginal(command: string, body: unknown): body is Record<string, unknown> {
  if (!shape(body)) return false
  if (command === 'final-retry') return object(body, ['request_id', 'expected_attempt']) &&
    sourceSafeId(body.request_id) && count(body.expected_attempt) && body.expected_attempt <= 2147483647
  const basis = ['expected_draft_seq', 'expected_content_hash']
  const request = ['request_id', ...basis]
  const submission = [...request, 'approval_request_id', 'expected_submission_hash']
  const keys = command === 'validate' ? basis : command === 'submit' ?
    [...request, 'review_generation_id', 'reviewer_rbac_id'] : command === 'review' ?
    [...submission, 'decision', 'opinion'] : command === 'withdraw' || command === 'reopen' ?
    [...submission, 'reason'] : command === 'final-render' ?
    [...submission, 'expected_decision_hash', 'template_id', 'template_version', 'template_digest'] :
    command === 'release' ? [...submission, 'expected_decision_hash', 'final_generation_id',
      'expected_final_pdf_sha256', 'expected_final_docx_sha256'] : command === 'revise' ?
    [...request, 'source_publication_id', 'reason'] : null
  if (!keys || !object(body, keys) || !integer(body.expected_draft_seq) || body.expected_draft_seq > 2147483647 ||
    !sourceHash(body.expected_content_hash)) return false
  if (command === 'validate') return true
  if (!sourceSafeId(body.request_id)) return false
  if (command === 'submit') return sourceSafeId(body.review_generation_id) && integer(body.reviewer_rbac_id)
  if (command === 'revise') return sourceSafeId(body.source_publication_id) &&
    sourceLongText(body.reason) && meaningfulSourceText(body.reason)
  if (!sourceSafeId(body.approval_request_id) || !sourceHash(body.expected_submission_hash)) return false
  if (command === 'review') return (body.decision === 'approve' || body.decision === 'reject') &&
    sourceLongText(body.opinion) && (body.decision !== 'reject' || meaningfulSourceText(body.opinion))
  if (command === 'withdraw' || command === 'reopen') return sourceLongText(body.reason) && meaningfulSourceText(body.reason)
  if (!sourceHash(body.expected_decision_hash)) return false
  if (command === 'final-render') return body.template_id === 'welding-approval-appendix' &&
    body.template_version === '1' && sourceHash(body.template_digest)
  return sourceSafeId(body.final_generation_id) && sourceHash(body.expected_final_pdf_sha256) &&
    sourceHash(body.expected_final_docx_sha256)
}
const safeResultId = (value: unknown): value is string => text(value, 64) && Array.from(value).length <= 64 &&
  !/[/\\%]/.test(value) && value !== '.' && value !== '..'
const resourceRouteId = (value: unknown): value is string => sourceSafeId(value) && value.trim() === value &&
  !/[/\\%]/.test(value) && value !== '.' && value !== '..'

const resourceKinds = ['wps', 'pqr', 'parameter_reference', 'requirements', 'material', 'filler', 'joint_diagram']
const suggestedNames = ['method', 'material_a', 'material_b', 'filler', 'joint_type', 'thickness_a', 'thickness_b',
  'welding_requirements', 'inspection_requirements', 'passes']
const kindFields: Record<string, string[]> = {
  parameter_reference: ['method', 'material_a', 'material_b', 'filler', 'joint_type', 'thickness_a', 'thickness_b', 'passes'],
  requirements: ['welding_requirements', 'inspection_requirements'], material: ['material_a', 'material_b'],
  filler: ['filler'], joint_diagram: ['joint_type'],
}
const resourceText = (value: unknown, max: number): value is string => typeof value === 'string' &&
  Array.from(value).length <= max && !value.includes('\0') && !/[\ud800-\udfff]/u.test(value)
const resourceName = (value: unknown): value is string => resourceText(value, 128) && value.length > 0 &&
  !pythonWhitespace.test(Array.from(value)[0]) && !pythonWhitespace.test(Array.from(value).at(-1)!) && !/[\r\n]/.test(value)
const exactKeys = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  shape(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
const resourceNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const resourceMeasure = (value: unknown, units: string[]): boolean => exactKeys(value, ['value', 'unit']) &&
  resourceNumber(value.value) && units.includes(String(value.unit))
const resourceSnapshotText = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') &&
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)
const bomId = (value: unknown): value is string => resourceText(value, 64) && value.length > 0 &&
  !pythonWhitespace.test(Array.from(value)[0]) && !pythonWhitespace.test(Array.from(value).at(-1)!)
const bomPath = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 20 && value.every(bomId)
function bomProjection(value: unknown, operation: WeldingPlanOperation): boolean {
  if (!exactKeys(value, ['baseline_id', 'fingerprint', 'name', 'number', 'captured_depth', 'root', 'occurrences']) ||
    !bomId(value.baseline_id) || !hash(value.fingerprint) || !resourceText(value.name, 256) || !resourceText(value.number, 256) ||
    !Number.isSafeInteger(value.captured_depth) || !Array.isArray(value.occurrences) || value.occurrences.length > 999 ||
    Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) return false
  const paths = new Set<string>()
  for (const [index, row] of [value.root, ...value.occurrences].entries()) {
    if (!exactKeys(row, ['path', 'item_id', 'version_id', 'name', 'number', 'version_label', ...(index ? ['quantity', 'uom', 'find_number'] : [])]) ||
      !bomPath(row.path) || !bomId(row.item_id) || !bomId(row.version_id) || !resourceText(row.name, 256) ||
      !resourceText(row.number, 256) || !resourceText(row.version_label, 64) || (index ? row.path.length === 0 : row.path.length !== 0)) return false
    if (index && (!resourceText(row.quantity, 64) || !row.quantity.length || !resourceText(row.uom, 256) || !resourceText(row.find_number, 256))) return false
    const key = JSON.stringify(row.path)
    if (paths.has(key) || index && !paths.has(JSON.stringify(row.path.slice(0, -1)))) return false
    paths.add(key)
  }
  return shape(value.root) && value.root.item_id === operation.productId && value.root.version_id === operation.productVersionId
}
function assemblySide(value: unknown): boolean {
  if (!exactKeys(value, ['role', 'path', 'item_id', 'version_id'], ['witness']) || !resourceName(value.role) ||
    !Array.isArray(value.path) || value.path.length > 20 || !value.path.every(sourceSafeId) ||
    !sourceSafeId(value.item_id) || !sourceSafeId(value.version_id)) return false
  if (!Object.hasOwn(value, 'witness')) return true
  const witness = value.witness
  return exactKeys(witness, ['witness_id', 'source'], ['material', 'thickness']) && sourceSafeId(witness.witness_id) && witness.source === 'manual' &&
    (!Object.hasOwn(witness, 'material') || resourceText(witness.material, 256) && meaningfulSourceText(witness.material)) &&
    (!Object.hasOwn(witness, 'thickness') || resourceMeasure(witness.thickness, ['mm', 'in']) && shape(witness.thickness) && typeof witness.thickness.unit === 'string' && (witness.thickness.value as number) > 0)
}
const assemblyCodes = (value: unknown): value is string[] => Array.isArray(value) && value.every(code => resourceText(code, 128) && code.length > 0) && new Set(value).size === value.length
function assemblyView(value: unknown): boolean {
  if (value === null) return true
  if (!exactKeys(value, ['sides', 'unknown']) || !exactKeys(value.sides, ['a', 'b']) || !assemblyCodes(value.unknown)) return false
  const unknown = new Set<string>()
  for (const name of ['a', 'b']) {
    const side = value.sides[name]
    if (!exactKeys(side, ['selection', 'facts', 'provenance', 'unknown']) || !assemblySide(side.selection) || !assemblyCodes(side.unknown)) return false
    side.unknown.forEach(code => unknown.add(code))
    if (side.facts !== null) {
      if (!exactKeys(side.facts, ['path', 'item_id', 'version_id'], ['quantity', 'uom', 'find_number']) ||
        !bomPath(side.facts.path) || !bomId(side.facts.item_id) || !bomId(side.facts.version_id) ||
        !shape(side.selection) || !isDeepStrictEqual(side.facts.path, side.selection.path)) return false
      const nested = side.facts.path.length > 0
      if (!['quantity', 'uom', 'find_number'].every(key => Object.hasOwn(side.facts as object, key) === nested)) return false
      for (const key of ['quantity', 'uom', 'find_number']) if (Object.hasOwn(side.facts, key) && !resourceText(side.facts[key], key === 'quantity' ? 64 : 256)) return false
    }
    if (side.provenance !== null && (!exactKeys(side.provenance, ['auth_actor_id', 'rbac_actor_id', 'draft_seq', 'item_version_id']) ||
      !integer(side.provenance.auth_actor_id) || !integer(side.provenance.rbac_actor_id) || !integer(side.provenance.draft_seq) || !safeResultId(side.provenance.item_version_id))) return false
  }
  const a = value.sides.a, b = value.sides.b
  return shape(a) && shape(b) && shape(a.selection) && shape(b.selection) && !isDeepStrictEqual(a.selection.path, b.selection.path) &&
    isDeepStrictEqual([...unknown].sort(), [...value.unknown].sort())
}
function assemblyAfterMatches(after: unknown, weldId: unknown, payload: unknown): boolean {
  if (!shape(payload) || !Array.isArray(payload.welds)) return false
  const weld = payload.welds.find(row => shape(row) && row.weld_id === weldId)
  const assembly = shape(weld) && shape(weld.assembly) ? weld.assembly : null
  if (after === null) return assembly === null
  if (!assembly || !shape(after) || !shape(after.sides)) return false
  const sides = after.sides
  return ['a', 'b'].every(name => {
    const side = sides[name]
    return shape(side) && isDeepStrictEqual(side.selection, assembly[name])
  })
}
function assemblyRequest(operation: WeldingPlanOperation): Record<string, unknown> | null {
  const request = originalRequest(operation)
  if (!exactKeys(request, ['expected_draft_seq', 'save_id', 'payload', 'assembly_change'], ['overlay_context_id', 'measure_geometry']) ||
    !integer(request.expected_draft_seq) || request.expected_draft_seq > 2147483646 || !sourceSafeId(request.save_id) || !shape(request.payload) ||
    !exactKeys(request.assembly_change, ['expected_content_hash', 'from_fingerprint', 'to_fingerprint']) ||
    !Object.values(request.assembly_change).every(hash) || Object.hasOwn(request, 'overlay_context_id') && !resourceRouteId(request.overlay_context_id) ||
    Object.hasOwn(request, 'measure_geometry') && typeof request.measure_geometry !== 'boolean') return null
  return request
}
function validResourcePayload(value: unknown): value is Record<string, unknown> {
  if (!exactKeys(value, ['schema_version', 'kind', 'suggested_fields'], ['document']) ||
    value.schema_version !== 1 || !resourceKinds.includes(String(value.kind)) || !shape(value.suggested_fields)) return false
  const fields = value.suggested_fields
  if (Object.keys(fields).some(key => !(kindFields[String(value.kind)] || suggestedNames).includes(key))) return false
  for (const [key, field] of Object.entries(fields)) {
    if (['method', 'material_a', 'material_b', 'filler', 'joint_type', 'welding_requirements', 'inspection_requirements'].includes(key)) {
      if (!resourceText(field, key.endsWith('requirements') ? 4000 : 256)) return false
    } else if (key === 'thickness_a' || key === 'thickness_b') {
      if (!resourceMeasure(field, ['mm', 'in'])) return false
    } else if (key === 'passes') {
      if (!Array.isArray(field) || field.length > 100 || new Set(field.map(pass => shape(pass) ? pass.sequence : null)).size !== field.length ||
        !field.every(pass => exactKeys(pass, ['sequence'], ['method', 'filler', 'current', 'voltage', 'speed']) &&
          integer(pass.sequence) && ['method', 'filler'].every(name => pass[name] === undefined || resourceText(pass[name], 256)) &&
          (pass.current === undefined || pass.current === null || resourceMeasure(pass.current, ['A'])) &&
          (pass.voltage === undefined || pass.voltage === null || resourceMeasure(pass.voltage, ['V'])) &&
          (pass.speed === undefined || pass.speed === null || resourceMeasure(pass.speed, ['mm/min', 'in/min'])))) return false
    }
  }
  if (value.document !== undefined && (!exactKeys(value.document, ['item_id', 'version_id', 'file_id', 'file_role', 'expected_fingerprint']) ||
    !['item_id', 'version_id', 'file_id'].every(key => sourceSafeId(value.document![key])) ||
    !['attachment', 'reference'].includes(String(value.document.file_role)) ||
    typeof value.document.expected_fingerprint !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.document.expected_fingerprint))) return false
  return !['wps', 'pqr', 'joint_diagram'].includes(String(value.kind)) || value.document !== undefined
}
function resourceRequest(operation: WeldingPlanOperation): Record<string, unknown> | null {
  const value = originalRequest(operation)
  if (!value || !validResourcePayload(value.payload)) return null
  if (operation.path === '/resources') {
    return exactKeys(value, ['resource_id', 'name', 'number', 'request_id', 'payload']) &&
      resourceRouteId(value.resource_id) && resourceName(value.name) && resourceName(value.number) && sourceSafeId(value.request_id) ? value : null
  }
  return exactKeys(value, ['request_id', 'source_version_id', 'expected_current_version_id', 'expected_content_hash', 'name', 'payload']) &&
    sourceSafeId(value.request_id) && safeResultId(value.source_version_id) && safeResultId(value.expected_current_version_id) &&
    hash(value.expected_content_hash) && resourceName(value.name) ? value : null
}
function validResourceRecord(value: Record<string, unknown>, operation: WeldingPlanOperation,
  sourceRecord?: Record<string, unknown>): boolean {
  if (!exactKeys(value, ['resource_id', 'item_version_id', 'version_label', 'state', 'name', 'number', 'kind', 'payload', 'sources', 'content_hash'],
    ['predecessor_version_id', 'predecessor_content_hash']) ||
    value.resource_id !== operation.resourceId || !safeResultId(value.item_version_id) || !resourceText(value.version_label, 128) ||
    !resourceText(value.state, 128) || !resourceName(value.name) || !resourceName(value.number) ||
    !validResourcePayload(value.payload) || value.kind !== value.payload.kind || !hash(value.content_hash) || !shape(value.sources)) return false
  const payload = value.payload
  const sources = value.sources
  const document = payload.document
  if (document === undefined) {
    if (!object(sources, [])) return false
  } else {
    if (!exactKeys(sources, value.kind === 'joint_diagram' ? ['document', 'diagram'] : ['document']) ||
      !exactKeys(sources.document, ['item_id', 'version_id', 'file_id', 'file_role', 'title', 'version_label', 'state',
        'is_released', 'file_name', 'checksum', 'fingerprint'])) return false
    if (!shape(document)) return false
    const source = sources.document
    if (!['item_id', 'version_id', 'file_id', 'file_role'].every(key => source[key] === document[key]) ||
      source.fingerprint !== String(document.expected_fingerprint).toLowerCase() || !hash(source.fingerprint) ||
      !hash(source.checksum) || !resourceSnapshotText(source.title) || !resourceSnapshotText(source.file_name) ||
      source.version_label !== null && !resourceSnapshotText(source.version_label) ||
      source.state !== null && !resourceSnapshotText(source.state) || typeof source.is_released !== 'boolean') return false
    if (value.kind === 'joint_diagram') {
      const diagram = sources.diagram
      if (!exactKeys(diagram, ['schema', 'actual_sha256', 'byte_size', 'mime_type', 'format', 'width', 'height', 'exif_orientation']) ||
        diagram.schema !== 'yuantus.welding_joint_diagram/1' || !hash(diagram.actual_sha256) ||
        diagram.actual_sha256 !== source.checksum ||
        !integer(diagram.byte_size) || diagram.byte_size > 5 * 1024 * 1024 ||
        ![['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']].some(([format, mime]) => diagram.format === format && diagram.mime_type === mime) ||
        !integer(diagram.width) || diagram.width > 4096 || !integer(diagram.height) || diagram.height > 4096 ||
        !integer(diagram.exif_orientation) || diagram.exif_orientation > 8) return false
    }
  }
  if ((value.predecessor_version_id === undefined) !== (value.predecessor_content_hash === undefined) ||
    value.predecessor_version_id !== undefined && (!safeResultId(value.predecessor_version_id) || !hash(value.predecessor_content_hash))) return false
  if (operation.method === 'GET') return value.item_version_id === operation.resourceVersionId
  const request = resourceRequest(operation)
  if (!request || !isDeepStrictEqual(value.payload, request.payload) || value.name !== request.name) return false
  if (operation.path === '/resources') return value.number === request.number && value.state === 'Draft' &&
    value.predecessor_version_id === undefined && value.predecessor_content_hash === undefined
  return !!sourceRecord && request.source_version_id === request.expected_current_version_id &&
    sourceRecord.content_hash === request.expected_content_hash &&
    sourceRecord.number === value.number && sourceRecord.kind === value.kind && shape(request.payload) &&
    request.payload.kind === sourceRecord.kind &&
    value.item_version_id !== request.source_version_id && value.predecessor_version_id === request.source_version_id &&
    value.predecessor_content_hash === request.expected_content_hash && value.state === 'Draft'
}

function publicationEntry(value: unknown): value is Record<string, unknown> {
  return shape(value) && object(value, ['publication_id', 'item_version_id', 'version_label', 'state', 'published_at', 'content_hash']) &&
    safeResultId(value.publication_id) && safeResultId(value.item_version_id) &&
    text(value.version_label, 128) && ['Released', 'Superseded'].includes(String(value.state)) &&
    text(value.published_at, 64) && hash(value.content_hash)
}
function comparisonSide(value: unknown): value is Record<string, unknown> {
  return shape(value) && object(value, ['item_version_id', 'version_label', 'publication_id', 'content_hash']) &&
    safeResultId(value.item_version_id) && safeResultId(value.publication_id) &&
    text(value.version_label, 128) && hash(value.content_hash)
}

function publication(value: unknown, planId?: string, versionId?: string): value is Record<string, unknown> {
  if (!shape(value) || !object(value, ['schema', 'publication_id', 'plan_id', 'item_version_id', 'state', 'draft_seq',
    'content_hash', 'version_label', 'name', 'number', 'approval_request_id', 'submission_hash', 'decision_hash',
    'review_generation_id', 'final_generation_id', 'generation_content_hash', 'requester', 'reviewer', 'opinion',
    'approved_at', 'published_at', 'publisher', 'files']) ||
    value.schema !== 'yuantus.welding_plan_publication/1' ||
    !safeResultId(value.publication_id) || !safeResultId(value.plan_id) || !safeResultId(value.item_version_id) ||
    planId !== undefined && value.plan_id !== planId || versionId !== undefined && value.item_version_id !== versionId ||
    !['Released', 'Superseded'].includes(String(value.state)) || !integer(value.draft_seq) ||
    !hash(value.content_hash) || !safeResultId(value.approval_request_id) ||
    !hash(value.submission_hash) || !hash(value.decision_hash) ||
    !safeResultId(value.review_generation_id) || !safeResultId(value.final_generation_id) ||
    !hash(value.generation_content_hash) || !text(value.version_label, 128) ||
    !text(value.published_at, 64) || !text(value.approved_at, 64) ||
    typeof value.name !== 'string' || value.name.length > 256 || typeof value.number !== 'string' || value.number.length > 256 ||
    typeof value.opinion !== 'string' || value.opinion.length > 4000 ||
    ![value.requester, value.reviewer, value.publisher].every(actor => shape(actor) &&
      object(actor, ['auth_user_id', 'rbac_user_id', 'display_name']) &&
      integer(actor.auth_user_id) && integer(actor.rbac_user_id) && typeof actor.display_name === 'string' &&
      actor.display_name.length <= 256) || !shape(value.files) || !object(value.files, ['pdf', 'docx'])) return false
  for (const format of ['pdf', 'docx'] as const) {
    const file = value.files[format]
    if (!shape(file) || !object(file, ['format', 'mime_type', 'byte_size', 'artifact_sha256']) || file.format !== format ||
      file.mime_type !== (format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
      !integer(file.byte_size) || file.byte_size > 128 * 1024 * 1024 || !hash(file.artifact_sha256)) return false
  }
  return true
}

function normalWorkflowAck(value: unknown, request: Record<string, unknown>, operation: WeldingPlanOperation, command: string): boolean {
  if (!workflowOriginal(command, request) || !shape(value) || !object(value, ['schema', 'request_id', 'action', 'plan_id', 'item_version_id', 'draft_seq',
    'content_hash', 'state', 'approval_request_id', 'publication_id']) ||
    value.schema !== 'yuantus.welding_plan_workflow_ack/1' || !sourceSafeId(request.request_id) ||
    value.request_id !== request.request_id || value.plan_id !== operation.planId || value.item_version_id !== operation.versionId ||
    !integer(request.expected_draft_seq) || !hash(request.expected_content_hash) ||
    value.content_hash !== request.expected_content_hash ||
    value.draft_seq !== (request.expected_draft_seq as number) + (command === 'reopen' ? 1 : 0) ||
    !safeResultId(value.approval_request_id)) return false
  const action = command === 'review' ? request.decision : command
  const states: Record<string, string> = { submit: 'InReview', approve: 'Approved', reject: 'Draft',
    withdraw: 'Draft', reopen: 'Draft', release: 'Released' }
  if (!['submit', 'review', 'withdraw', 'reopen', 'release'].includes(command) ||
    typeof action !== 'string' || value.action !== action || value.state !== states[action]) return false
  if (command !== 'submit' && value.approval_request_id !== request.approval_request_id) return false
  return command === 'release' ? safeResultId(value.publication_id) : value.publication_id === null
}

function revisionAck(value: unknown, request: Record<string, unknown>, operation: WeldingPlanOperation): boolean {
  return workflowOriginal('revise', request) && shape(value) && object(value, ['schema', 'request_id', 'action', 'plan_id', 'source_version_id',
    'source_publication_id', 'source_draft_seq', 'source_content_hash', 'target_version_id',
    'target_version_label', 'target_draft_seq', 'target_content_hash', 'inheritance_id', 'inheritance_sha256', 'state']) &&
    value.schema === 'yuantus.welding_plan_revision_ack/1' && value.action === 'revise' &&
    sourceSafeId(request.request_id) && value.request_id === request.request_id &&
    value.plan_id === operation.planId && value.source_version_id === operation.versionId &&
    safeResultId(request.source_publication_id) && value.source_publication_id === request.source_publication_id &&
    integer(request.expected_draft_seq) && value.source_draft_seq === request.expected_draft_seq &&
    hash(request.expected_content_hash) && value.source_content_hash === request.expected_content_hash &&
    safeResultId(value.target_version_id) && value.target_version_id !== operation.versionId &&
    text(value.target_version_label, 128) && value.target_draft_seq === 1 &&
    value.target_content_hash === request.expected_content_hash && safeResultId(value.inheritance_id) &&
    hash(value.inheritance_sha256) && value.state === 'Draft'
}

function reuseName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || Array.from(value).length > 128 || /[\r\n\0]/.test(value)) return false
  const chars = Array.from(value)
  if (pythonWhitespace.test(chars[0]) || pythonWhitespace.test(chars[chars.length - 1])) return false
  try { encodeURIComponent(value) } catch { return false }
  return true
}

function reuseOriginal(value: unknown): value is Record<string, unknown> {
  if (!shape(value) || !object(value, ['request_id', 'source_publication_id', 'expected_draft_seq',
    'expected_content_hash', 'selected_weld_ids', 'target_plan_id', 'name', 'number', 'product', 'drawing',
    'reason', ...(value.bom !== undefined ? ['bom'] : [])]) ||
    !sourceSafeId(value.request_id) || !sourceSafeId(value.source_publication_id) ||
    !integer(value.expected_draft_seq) || value.expected_draft_seq > 2147483647 || !hash(value.expected_content_hash) ||
    !resourceRouteId(value.target_plan_id) || !reuseName(value.name) || !reuseName(value.number) ||
    !sourceLongText(value.reason) || !meaningfulSourceText(value.reason) ||
    !Array.isArray(value.selected_weld_ids) || value.selected_weld_ids.length < 1 || value.selected_weld_ids.length > 500 ||
    !value.selected_weld_ids.every(sourceSafeId) || new Set(value.selected_weld_ids).size !== value.selected_weld_ids.length ||
    !shape(value.product) || !object(value.product, ['item_id', 'version_id']) ||
    !sourceSafeId(value.product.item_id) || !sourceSafeId(value.product.version_id) ||
    !shape(value.drawing) || !object(value.drawing, ['item_id', 'version_id', 'file_id', 'file_role', 'expected_checksum']) ||
    !['item_id', 'version_id', 'file_id'].every(key => sourceSafeId((value.drawing as Record<string, unknown>)[key])) ||
    !['drawing', 'native_cad'].includes(String(value.drawing.file_role)) ||
    typeof value.drawing.expected_checksum !== 'string' || !/^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{64})$/.test(value.drawing.expected_checksum)) return false
  return value.bom === undefined || value.bom === null || shape(value.bom) &&
    object(value.bom, ['baseline_id', 'expected_fingerprint']) && sourceSafeId(value.bom.baseline_id) && hash(value.bom.expected_fingerprint)
}

function reuseAck(value: unknown, request: Record<string, unknown>, operation: WeldingPlanOperation): boolean {
  return reuseOriginal(request) && shape(value) && object(value, ['schema', 'action', 'request_id', 'reuse_id',
    'source_plan_id', 'source_version_id', 'source_publication_id', 'source_draft_seq', 'source_content_hash',
    'target_plan_id', 'target_version_id', 'target_version_label', 'target_draft_seq', 'target_content_hash',
    'state', 'reuse_provenance_sha256']) && value.schema === 'yuantus.welding_plan_reuse_ack/1' && value.action === 'reuse' &&
    value.request_id === request.request_id && safeResultId(value.reuse_id) &&
    value.source_plan_id === operation.planId && value.source_version_id === operation.versionId &&
    value.source_publication_id === request.source_publication_id && value.source_draft_seq === request.expected_draft_seq &&
    value.source_content_hash === request.expected_content_hash && value.target_plan_id === request.target_plan_id &&
    value.target_plan_id !== operation.planId && safeResultId(value.target_version_id) &&
    value.target_version_id !== operation.versionId && text(value.target_version_label, 128) &&
    value.target_draft_seq === 1 && hash(value.target_content_hash) && value.state === 'Draft' && hash(value.reuse_provenance_sha256)
}

function reuseResult(value: Record<string, unknown>, operation: WeldingPlanOperation, authority: WeldingAuthority): boolean {
  const request = originalRequest(operation)
  if (operation.result === 'reuse-ack') return !!request && reuseAck(value, request, operation)
  if (operation.result === 'reuse-resolution') return !!request && reuseOriginal(request) &&
    object(value, ['schema', 'command', 'request_id', 'status', 'ack']) &&
    value.schema === 'yuantus.welding_reuse_resolution/1' && value.command === 'reuse' && value.request_id === request.request_id &&
    (value.status === 'unknown' ? value.ack === null : value.status === 'committed' && reuseAck(value.ack, request, operation))
  if (!object(value, ['schema', 'reuse_id', 'reuse_provenance_sha256', 'basis']) ||
    value.schema !== 'yuantus.welding_reuse_provenance/1' || !safeResultId(value.reuse_id) || !hash(value.reuse_provenance_sha256) ||
    !shape(value.basis) || !object(value.basis, ['schema', 'metadata', 'request', 'source', 'target', 'mappings'])) return false
  const { metadata, request: original, source, target, mappings } = value.basis
  if (value.basis.schema !== 'yuantus.welding_reuse/1' || !shape(metadata) || !object(metadata, ['id', 'tenant_id', 'org_id',
    'source_plan_id', 'source_version_id', 'source_publication_id', 'target_plan_id', 'target_version_id',
    'request_id', 'request_digest', 'reason', 'actor', 'created_at']) ||
    metadata.id !== value.reuse_id || metadata.tenant_id !== authority.owner.tenant_id || metadata.org_id !== authority.owner.org_id ||
    metadata.target_plan_id !== operation.planId || !safeResultId(metadata.target_version_id) ||
    !safeResultId(metadata.source_plan_id) || !safeResultId(metadata.source_version_id) || metadata.source_plan_id === operation.planId ||
    !hash(metadata.request_digest) || !text(metadata.created_at, 64) ||
    !shape(metadata.actor) || !object(metadata.actor, ['auth_user_id', 'rbac_user_id', 'display_name']) ||
    !integer(metadata.actor.auth_user_id) || !integer(metadata.actor.rbac_user_id) ||
    typeof metadata.actor.display_name !== 'string' || Array.from(metadata.actor.display_name).length > 256 || metadata.actor.display_name.includes('\0') ||
    !reuseOriginal(original) || original.target_plan_id !== operation.planId || original.request_id !== metadata.request_id ||
    original.source_publication_id !== metadata.source_publication_id || original.reason !== metadata.reason ||
    !shape(source) || !object(source, ['draft_seq', 'content_hash']) || source.draft_seq !== original.expected_draft_seq ||
    source.content_hash !== original.expected_content_hash || !shape(target) ||
    !object(target, ['version_label', 'payload', 'sources', 'content_hash']) || !text(target.version_label, 128) || !hash(target.content_hash) ||
    !shape(target.payload) || !isDeepStrictEqual(target.payload.product, original.product) ||
    !isDeepStrictEqual(target.payload.drawing, original.drawing) || !isDeepStrictEqual(target.payload.bom, original.bom ?? null) ||
    !shape(target.sources) || !isDeepStrictEqual(target.sources.reuse, { schema: 'yuantus.welding_reuse/1', reuse_id: value.reuse_id }) ||
    !Array.isArray(mappings) || mappings.length !== (original.selected_weld_ids as string[]).length) return false
  return mappings.every((mapping, index) => shape(mapping) &&
    object(mapping, ['source_weld_id', 'target_weld_id', 'source_values', 'copy_values', 'process_associations', 'resource_associations']) &&
    mapping.source_weld_id === (original.selected_weld_ids as string[])[index] && sourceSafeId(mapping.target_weld_id) &&
    shape(mapping.source_values) && shape(mapping.copy_values) && Array.isArray(mapping.process_associations) && Array.isArray(mapping.resource_associations))
}

function finalWorkflowAck(value: unknown, request: Record<string, unknown>, operation: WeldingPlanOperation, generation?: unknown): boolean {
  const retry = generation !== undefined
  return workflowOriginal(retry ? 'final-retry' : 'final-render', request) &&
    shape(value) && value.schema === 'yuantus.welding_final_generation_ack/1' &&
    generationFixed(value, 'final') && sourceSafeId(request.request_id) && value.request_id === request.request_id &&
    (!retry || value.generation_id === generation) &&
    (operation.planId === undefined || value.plan_id === operation.planId) &&
    (operation.versionId === undefined || value.item_version_id === operation.versionId) &&
    (retry || value.draft_seq === request.expected_draft_seq &&
      value.plan_content_hash === request.expected_content_hash &&
      value.approval_request_id === request.approval_request_id &&
      value.submission_hash === request.expected_submission_hash &&
      value.decision_hash === request.expected_decision_hash &&
      isDeepStrictEqual(value.template,
        { id: request.template_id, version: request.template_version, digest: request.template_digest }))
}

function workflowResolutionRequest(request: Record<string, unknown>): boolean {
  if (typeof request.command !== 'string' || !workflowCommands.includes(request.command) ||
    !object(request, request.command === 'final-retry' ? ['command', 'body', 'generation_id'] : ['command', 'body']) ||
    !workflowOriginal(request.command, request.body)) return false
  return request.command !== 'final-retry' || sourceSafeId(request.generation_id)
}

function workflowResult(value: Record<string, unknown>, operation: WeldingPlanOperation): boolean {
  if (operation.result === 'publication') return publication(value, operation.planId, operation.versionId)
  if (operation.result === 'publication-directory') {
    if (value.schema !== 'yuantus.welding_publication_directory/1' || value.plan_id !== operation.planId ||
      !boundPage(value, operation, 20, 50) || (value.items as unknown[]).length > (value.limit as number) ||
      (value.items as unknown[]).length > (value.total as number) ||
      !(value.items as unknown[]).every(publicationEntry)) return false
    return value.current_publication === null || publicationEntry(value.current_publication)
  }
  if (operation.result === 'publication-comparison') return value.schema === 'yuantus.welding_publication_comparison/1' &&
    value.plan_id === operation.planId && comparisonSide(value.from) && comparisonSide(value.to) &&
    value.from.item_version_id === operation.fromVersionId && value.to.item_version_id === operation.toVersionId &&
    shape(value.summary) && ['added', 'removed', 'changed', 'unchanged'].every(key => count((value.summary as Record<string, unknown>)[key])) &&
    Array.isArray(value.welds) && value.welds.every(item => shape(item) && text(item.weld_id, 64) &&
      ['added', 'removed', 'changed', 'unchanged'].includes(String(item.kind)) && Array.isArray(item.changed_fields) &&
      item.changed_fields.every((field: unknown) => ['display_no', 'group_name', 'classification', 'included',
        'parameters', 'welding_steps', 'geometry', 'process_refs', 'resource_refs', 'order'].includes(String(field)))) &&
    Array.isArray(value.plan_changes) && value.plan_changes.every(item =>
      ['drawing', 'product', 'bom', 'preparation_notes', 'overlay'].includes(String(item)))
  if (operation.result === 'workflow-state') return value.schema === 'yuantus.welding_review_state/1' &&
    value.plan_id === operation.planId && value.item_version_id === operation.versionId &&
    ['Draft', 'InReview', 'Approved', 'Released', 'Superseded'].includes(String(value.state)) &&
    integer(value.draft_seq) && hash(value.content_hash) &&
    typeof value.is_current === 'boolean' && Array.isArray(value.allowed_actions) &&
    value.allowed_actions.every(item => ['submit', 'approve', 'reject', 'withdraw', 'reopen',
      'final-render', 'final-retry', 'release', 'revise'].includes(String(item))) && Array.isArray(value.issues) &&
    value.issues.every(item => typeof item === 'string') &&
    (value.approval === null || shape(value.approval) && safeResultId(value.approval.approval_request_id) && hash(value.approval.submission_hash)) &&
    (value.final_generation === null || generationStatus(value.final_generation, 'final') &&
      (value.final_generation as Record<string, unknown>).plan_id === operation.planId &&
      (value.final_generation as Record<string, unknown>).item_version_id === operation.versionId) &&
    (value.publication === null || publication(value.publication, operation.planId, operation.versionId)) &&
    (value.final_profile === null || shape(value.final_profile))
  if (operation.result === 'workflow-history') return value.schema === 'yuantus.welding_review_history/1' &&
    value.plan_id === operation.planId && value.item_version_id === operation.versionId &&
    boundPage(value, operation) && (value.items as unknown[]).length <= (value.limit as number) &&
    (value.items as unknown[]).length <= (value.total as number) && (value.items as unknown[]).every(item =>
      shape(item) && safeResultId(item.event_id) &&
      ['created', 'submit', 'approve', 'reject', 'withdraw', 'reopen', 'revise', 'release'].includes(String(item.action)) &&
      text(item.created_at, 64) &&
      (item.publication === undefined || publication(item.publication, operation.planId, operation.versionId)) &&
      (item.revision === undefined || shape(item.revision) && item.revision.plan_id === operation.planId &&
        item.revision.target_version_id === operation.versionId))
  const request = originalRequest(operation)
  if (!request) return false
  if (operation.result === 'workflow-validate') return workflowOriginal('validate', request) &&
    value.schema === 'yuantus.welding_plan_validation/1' &&
    value.plan_id === operation.planId && value.item_version_id === operation.versionId &&
    value.draft_seq === request.expected_draft_seq && value.content_hash === request.expected_content_hash &&
    typeof value.ready === 'boolean' && Array.isArray(value.issues) && value.issues.every(item => typeof item === 'string')
  if (operation.result === 'workflow-ack') return normalWorkflowAck(value, request, operation, operation.command || '')
  if (operation.result === 'workflow-final') return finalWorkflowAck(value, request, operation)
  if (operation.result === 'workflow-revision') return revisionAck(value, request, operation)
  if (operation.result !== 'workflow-resolution' || !workflowResolutionRequest(request) ||
    value.schema !== 'yuantus.welding_workflow_resolution/1' || value.command !== request.command ||
    value.request_id !== (request.body as Record<string, unknown>).request_id) return false
  if (value.status === 'unknown') return value.ack === null
  if (value.status !== 'committed') return false
  const nested = request.body as Record<string, unknown>
  if (request.command === 'final-retry') return finalWorkflowAck(value.ack, nested, operation, request.generation_id)
  if (request.command === 'final-render') return finalWorkflowAck(value.ack, nested, operation)
  if (request.command === 'revise') return revisionAck(value.ack, nested, operation)
  return normalWorkflowAck(value.ack, nested, operation, String(request.command))
}

function reuseProductMetadata(value: unknown): value is Record<string, unknown> {
  return shape(value) && object(value, ['item_id', 'version_id', 'version_label', 'name', 'number']) &&
    sourceSafeId(value.item_id) && sourceSafeId(value.version_id) &&
    (value.version_label === null || resourceText(value.version_label, 64)) &&
    resourceText(value.name, 256) && resourceText(value.number, 128)
}

function validResourceCatalog(value: Record<string, unknown>, operation: WeldingPlanOperation): boolean {
  const history = operation.result === 'resource-version-catalog', documents = operation.result === 'reference-catalog'
  const schema = documents ? 'yuantus.welding_process_reference_catalog/1' : history ? 'yuantus.welding_resource_versions/1' : 'yuantus.welding_resource_catalog/1'
  const keys = ['schema', 'items', 'next_cursor', ...(history ? ['resource_id', 'current_version_id'] : documents ? ['limit'] : [])]
  const limit = operation.catalogLimit ?? 20
  if (!exactKeys(value, keys) || value.schema !== schema || !Array.isArray(value.items) || value.items.length > limit ||
    value.next_cursor !== null && (typeof value.next_cursor !== 'string' || value.next_cursor.length > 4096 ||
      !/^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(value.next_cursor) || value.items.length !== limit)) return false
  if (typeof value.next_cursor === 'string') {
    const prefix = value.next_cursor.slice(0, value.next_cursor.indexOf('.'))
    if (Buffer.from(prefix, 'base64url').toString('base64url') !== prefix) return false
  }
  if (history && (value.resource_id !== operation.resourceId || value.current_version_id !== null && !safeResultId(value.current_version_id))) return false
  if (documents && value.limit !== 20) return false
  const identities = new Set<string>()
  for (const row of value.items) {
    if (documents) {
      if (!exactKeys(row, ['item_id', 'version_id', 'file_id', 'file_role', 'title', 'version_label', 'state', 'is_released', 'file_name', 'checksum', 'fingerprint']) ||
        !['item_id', 'version_id', 'file_id'].every(key => sourceSafeId(row[key])) || typeof row.file_role !== 'string' || !['attachment', 'reference'].includes(row.file_role) ||
        !resourceSnapshotText(row.title) || !resourceSnapshotText(row.file_name) || typeof row.is_released !== 'boolean' ||
        row.version_label !== null && !resourceSnapshotText(row.version_label) || row.state !== null && !resourceSnapshotText(row.state) ||
        !hash(row.checksum) || !hash(row.fingerprint)) return false
    } else if (!exactKeys(row, ['resource_id', 'item_version_id', 'version_label', 'state', 'name', 'number', 'kind', 'content_hash']) ||
      !resourceRouteId(row.resource_id) || !safeResultId(row.item_version_id) || !resourceName(row.name) || !resourceName(row.number) ||
      !resourceText(row.version_label, 128) || !resourceText(row.state, 128) || typeof row.kind !== 'string' || !resourceKinds.includes(row.kind) || !hash(row.content_hash) ||
      history && row.resource_id !== operation.resourceId) return false
    const key = JSON.stringify(documents ? [row.item_id, row.version_id, row.file_id, row.file_role] : [row.resource_id, row.item_version_id])
    if (identities.has(key)) return false
    identities.add(key)
  }
  return true
}

function validPlanResult(value: Record<string, unknown>, operation: WeldingPlanOperation, authority: WeldingAuthority,
  resourceSource?: Record<string, unknown>): boolean {
  if (['reuse-ack', 'reuse-resolution', 'reuse-provenance'].includes(operation.result)) return reuseResult(value, operation, authority)
  if (operation.result === 'resource-record') return validResourceRecord(value, operation, resourceSource)
  if (['resource-catalog', 'resource-version-catalog', 'reference-catalog'].includes(operation.result)) return validResourceCatalog(value, operation)
  if (['publication', 'publication-directory', 'publication-comparison', 'workflow-state', 'workflow-history',
    'workflow-validate', 'workflow-ack', 'workflow-final', 'workflow-revision', 'workflow-resolution'].includes(operation.result))
    return workflowResult(value, operation)
  if (operation.result === 'templates') return value.schema === 'yuantus.welding_instruction_templates/1' &&
    Array.isArray(value.items) && value.items.length <= 20 && value.items.every(item => shape(item) &&
      text(item.id, 64) && text(item.version, 64) && hash(item.digest) && text(item.name, 256) &&
      typeof item.available === 'boolean' && (item.unavailable_reason === null || text(item.unavailable_reason, 256)) &&
      shape(item.default_options) && shape(item.options_schema))
  if (operation.result === 'generation-create' || operation.result === 'generation-retry') {
    const request = originalRequest(operation)
    if (!request || !text(request.request_id, 64) || value.request_id !== request.request_id ||
      operation.result === 'generation-create' && value.purpose !== 'review' ||
      !generationFixed(value, operation.result === 'generation-create' ? 'review' : value.purpose === 'final' ? 'final' : 'review') ||
      value.schema !== (value.purpose === 'final' ? 'yuantus.welding_final_generation_ack/1' : 'yuantus.welding_generation_ack/1')) return false
    if (operation.result === 'generation-retry') return value.generation_id === operation.generationId &&
      count(request.expected_attempt) && request.expected_attempt <= 2147483647
    return value.plan_id === operation.planId && value.item_version_id === operation.versionId &&
      value.draft_seq === request.expected_draft_seq && value.plan_content_hash === request.expected_content_hash &&
      request.purpose === 'review' && shape(request.template_options) &&
      isDeepStrictEqual(value.template, { id: request.template_id, version: request.template_version, digest: request.template_digest })
  }
  if (operation.result === 'generation-status') return value.generation_id === operation.generationId &&
    (generationStatus(value, 'review') || generationStatus(value, 'final'))
  if (operation.result === 'generation-list') return boundPage(value, operation) &&
    (value.total as number) >= (value.items as unknown[]).length && (value.items as unknown[]).length <= (value.limit as number) &&
    (value.items as unknown[]).every(item => generationStatus(item, operation.purpose === 'final' ? 'final' : 'review') &&
      (item as Record<string, unknown>).plan_id === operation.planId && (item as Record<string, unknown>).item_version_id === operation.versionId)
  const record = (item: unknown, planId?: string, versionId?: string): boolean => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false
    const row = item as Record<string, unknown>
    return text(row.plan_id, 64) && text(row.item_version_id, 64) &&
      (!planId || row.plan_id === planId) && (!versionId || row.item_version_id === versionId) &&
      integer(row.draft_seq) && typeof row.content_hash === 'string' && /^[0-9a-f]{64}$/.test(row.content_hash) &&
      row.payload !== null && typeof row.payload === 'object' && !Array.isArray(row.payload) &&
      row.sources !== null && typeof row.sources === 'object' && !Array.isArray(row.sources)
  }
  if (operation.result === 'record' || operation.result === 'assembly-apply') {
    if (operation.method === 'POST' && !text(operation.planId, 64)) return false
    if (!record(value, operation.planId, operation.versionId)) return false
    if (operation.result === 'assembly-apply') {
      const request = assemblyRequest(operation)
      return Boolean(request && value.draft_seq === (request.expected_draft_seq as number) + 1 && value.state === 'Draft')
    }
    return true
  }
  if (operation.result === 'assembly-preview') {
    const request = assemblyRequest(operation)
    if (!request || !shape(request.assembly_change) || !exactKeys(value, ['schema', 'plan_id', 'item_version_id', 'draft_seq', 'content_hash', 'from_fingerprint', 'to_fingerprint', 'affected_welds']) ||
      value.schema !== 'yuantus.welding_assembly_preview/1' || value.plan_id !== operation.planId || value.item_version_id !== operation.versionId ||
      value.draft_seq !== request.expected_draft_seq || value.content_hash !== request.assembly_change.expected_content_hash ||
      value.from_fingerprint !== request.assembly_change.from_fingerprint || value.to_fingerprint !== request.assembly_change.to_fingerprint ||
      !Array.isArray(value.affected_welds) || value.affected_welds.length > 1000) return false
    return value.affected_welds.every(row => exactKeys(row, ['weld_id', 'reason_codes', 'before', 'after', 'state']) &&
      sourceSafeId(row.weld_id) && assemblyCodes(row.reason_codes) && row.reason_codes.length > 0 && assemblyView(row.before) && assemblyView(row.after) &&
      assemblyAfterMatches(row.after, row.weld_id, request.payload) &&
      (row.state === 'known' || row.state === 'unknown') && !(shape(row.after) && Array.isArray(row.after.unknown) && row.after.unknown.length && row.state !== 'unknown')) &&
      new Set(value.affected_welds.map(row => row.weld_id)).size === value.affected_welds.length
  }
  if (operation.result === 'cad-context' || operation.result === 'source-preparation')
    return validContext(value, operation, authority)
  if (operation.result === 'source-review') {
    if (value.schema !== 'yuantus.welding_source_review/1' || value.plan_id !== operation.planId ||
      value.item_version_id !== operation.versionId || !integer(value.draft_seq) || !hash(value.content_hash) ||
      typeof value.can_write !== 'boolean' || !shape(value.summary) ||
      value.summary.schema !== 'yuantus.welding_source_review/1' || !hash(value.summary.state_sha256) ||
      !count(value.summary.pending_count) || !count(value.summary.confirmed_count) ||
      !count(value.summary.removed_pending_count)) return false
    return boundPage(value, operation) && (value.items as unknown[]).every(item => shape(item) && text(item.weld_id, 64) &&
      typeof item.present === 'boolean' && (item.state === 'pending' || item.state === 'confirmed') && hash(item.expected_review_digest))
  }
  if (operation.result === 'source-changes') return boundPage(value, operation) && (value.items as unknown[]).every(item =>
    shape(item) && text(item.change_id, 64) && integer(item.draft_seq) && hash(item.before_hash) && hash(item.after_hash))
  if (operation.result === 'source-change') return value.schema === 'yuantus.welding_source_change/1' &&
    value.change_id === operation.changeId && integer(value.draft_seq) && hash(value.before_hash) && hash(value.after_hash) &&
    shape(value.before) && shape(value.before.payload) && shape(value.before.sources) &&
    shape(value.after) && shape(value.after.payload) && shape(value.after.sources) && Array.isArray(value.events)
  if (operation.result === 'source-document') {
    if (value.schema !== 'yuantus.welding_source_document/1' || value.change_id !== operation.changeId ||
      value.side !== operation.side || !shape(value.payload) || !shape(value.cadgf_document) ||
      !shape(value.origin) || !shape(value.origin.input) || !shape(value.origin.document) ||
      !hash(value.origin.input.sha256) || !hash(value.origin.document.sha256) ||
      !hash(value.view_bundle_sha256) || !hash(value.origin.bundle_sha256)) return false
    const drawing = value.payload.drawing
    return shape(drawing) && drawing.expected_checksum === value.origin.input.sha256
  }
  if (operation.result === 'list') return Array.isArray(value.items) && value.items.every(item => record(item)) &&
    Number.isSafeInteger(value.total) && (value.total as number) >= 0 &&
    Number.isSafeInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= 100 &&
    Number.isSafeInteger(value.offset) && (value.offset as number) >= 0
  if (operation.result === 'reuse-product-context') return object(value, ['schema', 'product']) &&
    value.schema === 'yuantus.welding_plan_entry/1' && reuseProductMetadata(value.product) &&
    value.product.item_id === operation.productId && value.product.version_id === operation.productVersionId
  if (operation.result === 'reuse-product-candidates') {
    const limit = Number(new URLSearchParams(operation.path.split('?', 2)[1]).get('limit') || 20)
    return object(value, ['items']) && Array.isArray(value.items) && value.items.length <= Math.min(limit, 20) &&
      value.items.every(reuseProductMetadata) &&
      new Set(value.items.map(item => JSON.stringify([item.item_id, item.version_id]))).size === value.items.length
  }
  if (operation.result === 'reuse-bom-candidates') return object(value, ['items']) && Array.isArray(value.items) &&
    value.items.length <= 20 && value.items.every(item => object(item, ['baseline_id', 'fingerprint', 'name', 'number']) &&
      sourceSafeId(item.baseline_id) && hash(item.fingerprint) && resourceText(item.name, 256) && resourceText(item.number, 256)) &&
    new Set(value.items.map(item => item.baseline_id)).size === value.items.length
  if (operation.result === 'bom-candidates') return exactKeys(value, ['items']) && Array.isArray(value.items) && value.items.length <= 20 &&
    value.items.every(item => bomProjection(item, operation)) && new Set(value.items.map(item => item.baseline_id)).size === value.items.length
  if (operation.result === 'candidates') return Array.isArray(value.items)
  if (operation.result === 'product-context') {
    if (value.schema !== 'yuantus.welding_plan_entry/1' || value.product === null || typeof value.product !== 'object' || Array.isArray(value.product)) return false
    const product = value.product as Record<string, unknown>
    return product.item_id === operation.productId && product.version_id === operation.productVersionId
  }
  if (operation.result === 'recovery') {
    if (value.schema !== 'yuantus.welding_plan_recovery_authority/1' || !object(value.owner, ['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id'])) return false
    if (!Object.keys(authority.owner).every(key => value.owner[key] === authority.owner[key])) return false
    if (operation.method === 'GET') return object(value, ['schema', 'owner'])
    if (!object(value, ['schema', 'owner', 'record_id', 'current', 'can_write', 'conflict']) ||
      typeof value.can_write !== 'boolean' || typeof value.conflict !== 'boolean' ||
      value.current !== null && !record(value.current) || !operation.body) return false
    try {
      const request: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(operation.body))
      if (request === null || typeof request !== 'object' || Array.isArray(request)) return false
      const rawRecord = (request as Record<string, unknown>).record
      if (rawRecord === null || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) return false
      const submitted = rawRecord as Record<string, unknown>
      if (!text(submitted.recovery_id, 64) || value.record_id !== submitted.recovery_id) return false
      if (value.current === null) return true
      const draft = submitted.draft
      if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) return false
      const expected = draft as Record<string, unknown>
      if (!text(expected.plan_id, 64) || expected.version_id !== null && !text(expected.version_id, 64)) return false
      return record(value.current, expected.plan_id, expected.version_id === null ? undefined : expected.version_id as string)
    } catch { return false }
  }
  return false
}

export async function weldingPlanRequest(config: WeldingProvider, token: string, authenticatedTenantId: string | undefined,
  operation: WeldingPlanOperation, signal?: AbortSignal): Promise<{ status: number; body: Buffer; authority: WeldingAuthority }> {
  if ((operation.result === 'assembly-preview' || operation.result === 'assembly-apply') && !assemblyRequest(operation))
    throw new WeldingError('WELDING_INVALID_REQUEST', 400)
  if (operation.result === 'resource-record' && operation.method === 'POST' && !resourceRequest(operation))
    throw new WeldingError('WELDING_INVALID_REQUEST', 400)
  if (operation.write) weldingWriteAvailable()
  let resourceSource: Record<string, unknown> | undefined
  let resourceSourceAuthority: WeldingAuthority | undefined
  if (operation.result === 'resource-record' && operation.method === 'POST' && operation.path.endsWith('/revisions')) {
    const request = resourceRequest(operation)!
    const sourceVersionId = encodeURIComponent(request.source_version_id as string)
    const source = await weldingPlanRequest(config, token, authenticatedTenantId, {
      method: 'GET', path: `/resources/${encodeURIComponent(operation.resourceId!)}/versions/${sourceVersionId}`,
      result: 'resource-record', write: false, resourceId: operation.resourceId,
      resourceVersionId: request.source_version_id as string,
    }, signal)
    resourceSource = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.body)) as Record<string, unknown>
    resourceSourceAuthority = source.authority
  }
  if (operation.result === 'reuse-resolution') {
    const request = originalRequest(operation)
    if (!request || !reuseOriginal(request)) throw new WeldingError('WELDING_INVALID_REQUEST', 400)
  }
  if (operation.result === 'workflow-resolution') {
    const request = originalRequest(operation)
    if (!request || !workflowResolutionRequest(request)) throw new WeldingError('WELDING_INVALID_REQUEST', 400)
  }
  return withWeldingPrincipal(config, token, authenticatedTenantId, async (bearer, authority, recheck) => {
    await recheck()
    if (operation.write) weldingWriteAvailable()
    if (resourceSourceAuthority && !Object.keys(authority.owner).every(key => authority.owner[key as keyof typeof authority.owner] ===
      resourceSourceAuthority!.owner[key as keyof typeof authority.owner])) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOMAIN_TIMEOUT_MS)
    let dispatched = false
    let knownDomainError = false
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      activeDownload(signal)
      dispatched = true
      const response = await waitForDownload(signal, () => fetch(`${config.origin}/api/v1/plugins/welding${operation.path}`, {
        method: operation.method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}`,
          ...(operation.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(operation.body ? { body: operation.body } : {}),
      }))
      if (response.redirected || response.status >= 300 && response.status < 400) throw new Error()
      if (!response.ok) {
        if (![400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(response.status)) throw new Error()
        await recheck()
        knownDomainError = true
        // A Y bearer failure does not invalidate the native MetaSheet session.
        throw new WeldingError('WELDING_UPSTREAM_REJECTED', response.status === 401 ? 502 : response.status)
      }
      if (operation.result === 'empty') {
        if (response.status !== 204 || response.body !== null || Number(response.headers.get('content-length') || 0) !== 0) throw new Error()
        await recheck()
        return { status: 204, body: Buffer.alloc(0), authority }
      }
      const expectedStatus = operation.result === 'generation-create' || operation.result === 'generation-retry' ||
        operation.result === 'workflow-final' ? 202 :
        operation.method === 'POST' && ['record', 'resource-record', 'cad-context', 'source-preparation'].includes(operation.result) ? 201 : 200
      if (response.status !== expectedStatus) throw new Error()
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error()
      const declared = response.headers.get('content-length')
      const maxBytes = operation.result === 'bom-candidates' ? BOM_CANDIDATES_MAX_BYTES :
        ['resource-catalog', 'resource-version-catalog', 'reference-catalog'].includes(operation.result) ? RESOURCE_CATALOG_MAX_BYTES :
        operation.result === 'resource-record' ? RESOURCE_RECORD_MAX_BYTES :
        operation.result === 'source-preparation' ? PREPARATION_MAX_BYTES :
        operation.result === 'workflow-state' || operation.result === 'publication-comparison' ? WORKFLOW_STATE_MAX_BYTES :
        operation.result === 'workflow-history' ? WORKFLOW_HISTORY_MAX_BYTES :
        operation.result === 'workflow-revision' || operation.result === 'workflow-resolution' ? DOMAIN_MAX_BYTES :
        operation.result === 'publication' || operation.result === 'publication-directory' ? PUBLICATION_MAX_BYTES :
        operation.result === 'workflow-ack' || operation.result === 'workflow-validate' ? WORKFLOW_ACK_MAX_BYTES :
        operation.result === 'workflow-final' ? GENERATION_STATUS_MAX_BYTES :
        operation.result === 'templates' || operation.result === 'generation-list' ? GENERATION_LIST_MAX_BYTES :
        operation.result === 'generation-status' ? GENERATION_STATUS_MAX_BYTES :
        operation.result === 'generation-create' || operation.result === 'generation-retry' ? GENERATION_ACK_MAX_BYTES : DOMAIN_MAX_BYTES
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error()
      reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      while (true) {
        const chunk = await waitForDownload(signal, () => reader!.read())
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > maxBytes) throw new Error()
        chunks.push(chunk.value)
      }
      const body = Buffer.concat(chunks)
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      if (!validPlanResult(value as Record<string, unknown>, operation, authority, resourceSource)) throw new Error()
      await recheck()
      return { status: response.status, body, authority }
    } catch (error) {
      if (knownDomainError && error instanceof WeldingError) throw error
      if (operation.write && dispatched) throw new WeldingError('WELDING_RESULT_UNKNOWN', 502)
      if (error instanceof WeldingError) throw error
      throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
    } finally {
      clearTimeout(timer)
      controller.abort()
      void reader?.cancel().catch(() => {})
    }
  }, signal)
}

export interface WeldingResourceImportOperation {
  kind: 'template' | 'preview' | 'commit'
  format: 'csv' | 'xlsx'
  body?: Buffer
  importId?: string
  previewDigest?: string
}

export class WeldingResourceImportDomainError extends WeldingError {
  constructor(status: number, public readonly safeMessage?: string,
    public readonly issues?: Array<{ row: number | null; column: string; code: string; message: string }>) {
    super('WELDING_UPSTREAM_REJECTED', status === 401 ? 502 : status)
  }
}

const IMPORT_MAX_BYTES = 5 * 1024 * 1024
const IMPORT_TEMPLATE_MAX_BYTES = 1024 * 1024
const IMPORT_PREVIEW_MAX_BYTES = 32 * 1024 * 1024
const IMPORT_RECEIPT_MAX_BYTES = 1024 * 1024
const IMPORT_SCHEMA = 'yuantus.welding_resource_import/1'

function validImportIssue(value: unknown, totalRows = 100): value is { row: number | null; column: string; code: string; message: string } {
  return exactKeys(value, ['row', 'column', 'code', 'message']) &&
    (value.row === null || Number.isSafeInteger(value.row) && (value.row as number) >= 2 && (value.row as number) <= totalRows + 1) &&
    resourceText(value.column, 256) && resourceText(value.code, 128) && value.code.length > 0 &&
    resourceText(value.message, 4000) && value.message.length > 0
}

function validImportPreview(value: unknown, operation: WeldingResourceImportOperation): boolean {
  if (!exactKeys(value, ['schema', 'format', 'raw_sha256', 'normalized_sha256', 'preview_digest', 'total_rows', 'ready', 'rows', 'errors']) ||
    value.schema !== IMPORT_SCHEMA || value.format !== operation.format || !hash(value.raw_sha256) ||
    value.raw_sha256 !== createHash('sha256').update(operation.body!).digest('hex') || !hash(value.normalized_sha256) ||
    !count(value.total_rows) || value.total_rows > 100 || typeof value.ready !== 'boolean' ||
    !Array.isArray(value.rows) || value.rows.length > value.total_rows || !Array.isArray(value.errors) ||
    !value.errors.every(issue => validImportIssue(issue, value.total_rows as number))) return false
  if (value.ready ? !hash(value.preview_digest) || value.errors.length !== 0 || value.total_rows < 1 ||
    value.rows.length !== value.total_rows : value.preview_digest !== null) return false
  const seen = new Set<string>(), rowNumbers = new Set<number>()
  for (const row of value.rows) {
    if (!exactKeys(row, ['row', 'row_key', 'name', 'number', 'payload'], ['sources']) ||
      !count(row.row) || row.row < 2 || row.row > (value.total_rows as number) + 1 ||
      !sourceSafeId(row.row_key) || seen.has(row.row_key) || rowNumbers.has(row.row) ||
      !resourceName(row.name) || !resourceName(row.number) || !validResourcePayload(row.payload)) return false
    seen.add(row.row_key); rowNumbers.add(row.row)
    if (row.sources !== undefined && !validResourceRecord({ resource_id: 'import', item_version_id: 'preview', version_label: '1',
      state: 'Draft', name: row.name, number: row.number, kind: row.payload.kind, payload: row.payload,
      sources: row.sources, content_hash: '0'.repeat(64) },
    { method: 'GET', path: '/resources/import/versions/preview', write: false, result: 'resource-record',
      resourceId: 'import', resourceVersionId: 'preview' })) return false
  }
  return !value.ready || value.rows.every((row: Record<string, unknown>, index: number) => row.row === index + 2)
}

function validImportReceipt(value: unknown, operation: WeldingResourceImportOperation): boolean {
  if (!exactKeys(value, ['schema', 'import_id', 'raw_sha256', 'normalized_sha256', 'preview_digest', 'total_rows', 'items']) ||
    value.schema !== IMPORT_SCHEMA || value.import_id !== operation.importId ||
    value.raw_sha256 !== createHash('sha256').update(operation.body!).digest('hex') ||
    !hash(value.normalized_sha256) || value.preview_digest !== operation.previewDigest ||
    !integer(value.total_rows) || value.total_rows > 100 || !Array.isArray(value.items) ||
    value.items.length !== value.total_rows) return false
  const keys = new Set<string>(), resources = new Set<string>(), versions = new Set<string>()
  for (const [index, item] of value.items.entries()) {
    if (!exactKeys(item, ['row', 'row_key', 'resource_id', 'item_version_id', 'version_label', 'content_hash',
      'name', 'number', 'kind', 'state']) || item.row !== index + 2 || !sourceSafeId(item.row_key) || keys.has(item.row_key) ||
      !resourceRouteId(item.resource_id) || !safeResultId(item.item_version_id) || !resourceText(item.version_label, 128) ||
      item.version_label.length === 0 ||
      !hash(item.content_hash) || !resourceName(item.name) || !resourceName(item.number) ||
      !resourceKinds.includes(String(item.kind)) || item.state !== 'Draft' || resources.has(item.resource_id) ||
      versions.has(item.item_version_id)) return false
    keys.add(item.row_key); resources.add(item.resource_id); versions.add(item.item_version_id)
  }
  return true
}

async function boundedImportBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body || response.headers.has('content-encoding')) throw new Error()
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > maxBytes)) throw new Error()
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await waitForDownload(signal, () => reader.read())
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error()
      chunks.push(chunk.value)
    }
    if (declared !== null && size !== Number(declared)) throw new Error()
    return Buffer.concat(chunks, size)
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function weldingResourceImport(config: WeldingProvider, token: string, authenticatedTenantId: string | undefined,
  operation: WeldingResourceImportOperation, signal: AbortSignal): Promise<{ status: number; body: Buffer; mime: string; disposition?: string }> {
  if (!['csv', 'xlsx'].includes(operation.format) ||
    (operation.kind === 'template' ? operation.body !== undefined || operation.importId !== undefined || operation.previewDigest !== undefined :
      !Buffer.isBuffer(operation.body) || operation.body.length > IMPORT_MAX_BYTES || operation.body.length === 0 ||
      (operation.kind === 'preview' ? operation.importId !== undefined || operation.previewDigest !== undefined :
        operation.kind !== 'commit' || !sourceSafeId(operation.importId) || !hash(operation.previewDigest))))
    throw new WeldingError('WELDING_INVALID_REQUEST', 400)
  return withWeldingPrincipal(config, token, authenticatedTenantId, async (bearer, _authority, recheck) => {
    await recheck()
    weldingAvailable()
    if (operation.kind === 'commit') weldingWriteAvailable()
    const suffix = operation.kind === 'template' ? `/templates/${operation.format}` :
      `/${operation.kind}?format=${operation.format}` + (operation.kind === 'commit' ?
        `&import_id=${encodeURIComponent(operation.importId!)}&preview_digest=${operation.previewDigest}` : '')
    let dispatched = false
    try {
      activeDownload(signal)
      dispatched = true
      const response = await waitForDownload(signal, () => fetch(`${config.origin}/api/v1/plugins/welding/resources/import${suffix}`, {
        method: operation.kind === 'template' ? 'GET' : 'POST', redirect: 'error', signal,
        headers: { Accept: operation.kind === 'template' ? '*/*' : 'application/json', Authorization: `Bearer ${bearer}`,
          ...(operation.body ? { 'Content-Type': 'application/octet-stream' } : {}) },
        ...(operation.body ? { body: operation.body } : {}),
      }))
      if (response.redirected || response.status >= 300 && response.status < 400) throw new Error()
      if (!response.ok) {
        if (![400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(response.status) ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error()
        const body = await boundedImportBody(response, IMPORT_RECEIPT_MAX_BYTES, signal)
        const detail: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
        await recheck()
        if (exactKeys(detail, ['detail']) && exactKeys(detail.detail, ['message', 'errors']) &&
          resourceText(detail.detail.message, 4000) && Array.isArray(detail.detail.errors) &&
          detail.detail.errors.every(issue => validImportIssue(issue)))
          throw new WeldingResourceImportDomainError(response.status, detail.detail.message,
            detail.detail.errors as WeldingResourceImportDomainError['issues'])
        if (exactKeys(detail, ['detail']) && resourceText(detail.detail, 4000) && detail.detail.length > 0)
          throw new WeldingResourceImportDomainError(response.status)
        throw new Error()
      }
      if (response.status !== (operation.kind === 'commit' ? 201 : 200)) throw new Error()
      const mime = response.headers.get('content-type') || ''
      if (operation.kind === 'template') {
        const expected = operation.format === 'csv' ? 'text/csv' :
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        if (mime !== expected && (operation.format !== 'csv' || mime !== 'text/csv; charset=utf-8') ||
          response.headers.get('content-disposition') !==
          `attachment; filename="welding-resource-import-v1.${operation.format}"`) throw new Error()
        const body = await boundedImportBody(response, IMPORT_TEMPLATE_MAX_BYTES, signal)
        await recheck()
        return { status: 200, body, mime, disposition: response.headers.get('content-disposition')! }
      }
      if (!/^application\/json(?:\s*;|$)/i.test(mime)) throw new Error()
      const body = await boundedImportBody(response, operation.kind === 'preview' ? IMPORT_PREVIEW_MAX_BYTES : IMPORT_RECEIPT_MAX_BYTES, signal)
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      if (operation.kind === 'preview' ? !validImportPreview(value, operation) : !validImportReceipt(value, operation)) throw new Error()
      await recheck()
      return { status: response.status, body, mime: 'application/json' }
    } catch (error) {
      if (error instanceof WeldingResourceImportDomainError) throw error
      if (operation.kind === 'commit' && dispatched) throw new WeldingError('WELDING_RESULT_UNKNOWN', 502)
      if (error instanceof WeldingError) throw error
      throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
    }
  }, signal)
}

// Joint diagrams are at most 5 MiB; no PDF/DOCX spool or generalized binary path is used.
export async function weldingResourceDiagram(config: WeldingProvider, token: string, authenticatedTenantId: string | undefined,
  operation: WeldingPlanOperation, signal: AbortSignal): Promise<{ body: Buffer; mime: string; sha256: string }> {
  if (operation.result !== 'resource-diagram' || operation.method !== 'GET' || operation.write || operation.body !== undefined ||
    !resourceRouteId(operation.resourceId) || !resourceRouteId(operation.resourceVersionId) ||
    operation.path !== `/resources/${encodeURIComponent(operation.resourceId)}/versions/${encodeURIComponent(operation.resourceVersionId)}/diagram`)
    throw new WeldingError('WELDING_INVALID_REQUEST', 400)
  const original = await waitForDownload(signal, () => requireWeldingSession(token, authenticatedTenantId, config))
  const descriptor: WeldingPlanOperation = { ...operation, result: 'resource-record', path: operation.path.slice(0, -'/diagram'.length) }
  const first = await waitForDownload(signal, () => weldingPlanRequest(config, token, authenticatedTenantId, descriptor, signal))
  const initial = JSON.parse(first.body.toString('utf8')) as Record<string, unknown>
  const diagram = shape(initial.sources) && shape(initial.sources.diagram) ? initial.sources.diagram : null
  // The fixed resource-record validator already checks all descriptor fields and document linkage.
  if (initial.kind !== 'joint_diagram' || !diagram) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  const byteSize = diagram.byte_size as number, mime = diagram.mime_type as string, sha256 = diagram.actual_sha256 as string
  try {
    const body = await withWeldingPrincipal(config, token, authenticatedTenantId, async (bearer, authority, recheck) => {
      if (!isDeepStrictEqual(authority.owner, first.authority.owner)) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
      await recheck()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await waitForDownload(signal, () => fetch(`${config.origin}/api/v1/plugins/welding${operation.path}`, {
          method: 'GET', redirect: 'error', signal,
          headers: { Accept: mime, Authorization: `Bearer ${bearer}` },
        }))
        reader = response.body?.getReader()
        if (response.status !== 200 || response.redirected || !response.body) {
          if ([400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(response.status)) {
            await recheck()
            throw new WeldingError('WELDING_UPSTREAM_REJECTED', response.status === 401 ? 502 : response.status)
          }
          throw new Error('Invalid joint diagram response')
        }
        if (response.headers.get('content-type') !== mime || response.headers.get('content-length') !== String(byteSize) ||
          response.headers.get('x-content-sha256') !== sha256 || ![null, 'identity'].includes(response.headers.get('content-encoding')))
          throw new Error('Joint diagram headers changed')
        const body = Buffer.alloc(byteSize)
        let size = 0
        while (true) {
          const chunk = await waitForDownload(signal, () => reader!.read())
          if (chunk.done) break
          if (size + chunk.value.byteLength > byteSize || size + chunk.value.byteLength > 5 * 1024 * 1024)
            throw new Error('Joint diagram size exceeded')
          body.set(chunk.value, size)
          size += chunk.value.byteLength
        }
        if (size !== byteSize || createHash('sha256').update(body).digest('hex') !== sha256) throw new Error('Joint diagram digest changed')
        await recheck()
        return body
      } finally { void reader?.cancel().catch(() => {}) }
    }, signal)
    const last = await waitForDownload(signal, () => weldingPlanRequest(config, token, authenticatedTenantId, descriptor, signal))
    if (!isDeepStrictEqual(last.authority.owner, first.authority.owner) || !isDeepStrictEqual(JSON.parse(last.body.toString('utf8')), initial))
      throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
    await waitForDownload(signal, () => requireWeldingSession(token, authenticatedTenantId, config, original))
    activeDownload(signal)
    return { body, mime, sha256 }
  } catch (error) {
    if (error instanceof WeldingError) throw error
    throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  }
}

export interface WeldingPlanDownload {
  path: string
  format: 'pdf' | 'docx'
  mime: string
  byteSize: number
  sha256: string
  cleanup: () => Promise<void>
}

export async function weldingPlanDownload(config: WeldingProvider, token: string, authenticatedTenantId: string | undefined,
  operation: WeldingPlanOperation, signal: AbortSignal): Promise<WeldingPlanDownload> {
  const format = operation.format
  if ((operation.result !== 'generation-file' && operation.result !== 'publication-file') ||
    (format !== 'pdf' && format !== 'docx') || !operation.path.endsWith(`/files/${format}`))
    throw new WeldingError('WELDING_INVALID_REQUEST', 400)
  if (signal.aborted) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  const original = await waitForDownload(signal, () => requireWeldingSession(token, authenticatedTenantId, config))
  const descriptorOperation: WeldingPlanOperation = { ...operation, result: operation.result === 'generation-file' ? 'generation-status' : 'publication',
    path: operation.path.slice(0, -(`/files/${format}`).length) }
  const descriptorValue = (body: Buffer): Record<string, unknown> => JSON.parse(body.toString('utf8')) as Record<string, unknown>
  const first = await weldingPlanRequest(config, token, authenticatedTenantId, descriptorOperation, signal)
  const initial = descriptorValue(first.body)
  if (signal.aborted) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  if (operation.result === 'generation-file' && initial.status !== 'Ready') throw new WeldingError('WELDING_UPSTREAM_REJECTED', 409)
  const file = shape(initial.files) ? initial.files[format] : null
  const mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (!shape(file) || !object(file, ['format', 'mime_type', 'byte_size', 'artifact_sha256']) ||
    file.format !== format || file.mime_type !== mime || !integer(file.byte_size) || file.byte_size > BINARY_MAX_BYTES ||
    !hash(file.artifact_sha256)) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  const byteSize = file.byte_size as number
  const sha256 = file.artifact_sha256 as string
  let directory: string | undefined
  try {
    const path = await withWeldingPrincipal(config, token, authenticatedTenantId, async (bearer, authority, recheck) => {
      if (!isDeepStrictEqual(authority.owner, first.authority.owner)) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
      await recheck()
      const controller = new AbortController()
      let rejectAbort!: (reason: Error) => void
      const abortWait = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
      const abort = () => { controller.abort(); rejectAbort(new Error('Binary download cancelled')) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        const response = await Promise.race([fetch(`${config.origin}/api/v1/plugins/welding${operation.path}`, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { Accept: mime, Authorization: `Bearer ${bearer}` },
        }), abortWait])
        if (response.status !== 200 || response.redirected || !response.body) {
          if ([400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(response.status)) {
            await recheck()
            throw new WeldingError('WELDING_UPSTREAM_REJECTED', response.status === 401 ? 502 : response.status)
          }
          throw new Error('Invalid binary response')
        }
        if (response.headers.get('content-type') !== mime || response.headers.get('content-length') !== String(byteSize) ||
          response.headers.get('x-artifact-sha256') !== sha256 ||
          ![null, 'identity'].includes(response.headers.get('content-encoding'))) throw new Error('Binary headers changed')
        directory = await mkdtemp(join(tmpdir(), 'metasheet-welding-'))
        const path = join(directory, 'artifact')
        const handle = await open(path, 'wx', 0o600)
        try {
          reader = response.body.getReader()
          const digest = createHash('sha256')
          let size = 0
          while (true) {
            const chunk = await Promise.race([reader.read(), abortWait])
            if (chunk.done) break
            size += chunk.value.byteLength
            if (size > byteSize || size > BINARY_MAX_BYTES) throw new Error('Binary size exceeded')
            digest.update(chunk.value)
            await handle.writeFile(chunk.value)
          }
          if (size !== byteSize || digest.digest('hex') !== sha256) throw new Error('Binary digest changed')
        } finally { await handle.close() }
        await recheck()
        return path
      } finally {
        signal.removeEventListener('abort', abort)
        controller.abort()
        void reader?.cancel().catch(() => {})
      }
    }, signal)
    activeDownload(signal)
    const last = await weldingPlanRequest(config, token, authenticatedTenantId, descriptorOperation, signal)
    const latest = descriptorValue(last.body)
    if (!isDeepStrictEqual(last.authority.owner, first.authority.owner) || !isDeepStrictEqual(latest, initial))
      throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
    await waitForDownload(signal, () => requireWeldingSession(token, authenticatedTenantId, config, original))
    activeDownload(signal)
    const spoolDirectory = directory!
    let cleanupPromise: Promise<void> | undefined
    return { path, format, mime, byteSize, sha256,
      cleanup: () => cleanupPromise ??= rm(spoolDirectory, { recursive: true, force: true }) }
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true })
    if (error instanceof WeldingError) throw error
    throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  }
}
