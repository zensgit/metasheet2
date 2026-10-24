import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import express, { type RequestHandler } from 'express'
import request from 'supertest'
import { usePinnedServer } from '../utils/pinned-server'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

const mocks = vi.hoisted(() => ({ verifyToken: vi.fn(), readTokenPayload: vi.fn(), resolveSessionTenantId: vi.fn(), query: vi.fn() }))
vi.mock('../../src/auth/AuthService', () => ({ authService: mocks }))
vi.mock('../../src/db/pg', () => ({ query: mocks.query }))
import { weldingPreflight, weldingPlanRawBody, weldingRouter } from '../../src/routes/welding'
import { weldingPlanDownload, weldingResourceDiagram } from '../../src/integrations/welding/client'
import { readWeldingProvider } from '../../src/integrations/welding/provider'

const pinned = usePinnedServer()

const fixture = resolve('../../artifacts/welding-f15b/plan-adapter-unit')
mkdirSync(fixture, { recursive: true })
writeFileSync(`${fixture}/key.pem`, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(fixture, { recursive: true, force: true }) })

const fetchMock = vi.fn()
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const authority = { schema: 'yuantus.welding_generation_authority/1', owner: { tenant_id: 'yt', org_id: 'yo', auth_user_id: 71, rbac_user_id: 102 } }
const recoveryId = '550e8400-e29b-41d4-a716-446655440000'
const recoveryResult = { schema: 'yuantus.welding_plan_recovery_authority/1', owner: authority.owner, record_id: recoveryId, current: null, can_write: true, conflict: false }
const record = (planId = 'p', versionId = 'v', draftSeq = 1) => ({ plan_id: planId, item_version_id: versionId, draft_seq: draftSeq, content_hash: 'a'.repeat(64), payload: {}, sources: {} })
const product = { item_id: 'product', version_id: 'product-v1' }
const oldDrawing = { item_id: 'old-di', version_id: 'old-dv', file_id: 'old-f', file_role: 'drawing', expected_checksum: 'd'.repeat(64) }
const drawing = { item_id: 'di', version_id: 'dv', file_id: 'f', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }
const source = (target = drawing) => ({ item_id: target.item_id, version_id: target.version_id,
  file_id: target.file_id, file_role: target.file_role, checksum: target.expected_checksum,
  fingerprint: 'f'.repeat(64), title: target.item_id, version_label: '1.A', state: 'Released', is_released: true, file_name: `${target.file_id}.dwg` })
const cad = (contextId = 'c') => ({ context_id: contextId, plan_id: 'p', item_version_id: 'v', draft_seq: 1,
  expires_at: '2026-10-09T00:00:00+00:00', source: source(), input_sha256: 'a'.repeat(64),
  document_sha256: 'b'.repeat(64), cadgf_document: {}, unit: 'mm',
  origin: { schema: 'yuantus.welding_plan_cad_origin/1', context_id: contextId, owner_auth_user_id: 71, rbac_user_id: 102,
    basis: { product, drawing }, source: source(), input: { sha256: 'a'.repeat(64), bytes: 42 },
    document: { sha256: 'b'.repeat(64), bytes: 42 }, unit: 'mm', bundle_sha256: 'c'.repeat(64) },
  editor_url: `/welding-cad/${'c'.repeat(64)}/welding-frame.html` })
const projected = (target = drawing) => ({ product: { ...product, version_label: '1.A' },
  drawing: { item_id: target.item_id, version_id: target.version_id, file_id: target.file_id,
    file_role: target.file_role, checksum: target.expected_checksum, version_label: '1.A', file_name: `${target.file_id}.dwg` }, process_refs: [] })
const prepared = () => {
  const context = cad()
  const beforePayload = { schema_version: 1, product, drawing: oldDrawing, bom: null, welds: [], process_refs: [] }
  const afterPayload = { ...beforePayload, drawing }
  const oldOrigin = { schema: 'yuantus.welding_plan_cad_review_origin/1', qualification: 'first_review',
    basis: { product, drawing: oldDrawing }, source: source(oldDrawing), input: { sha256: oldDrawing.expected_checksum, bytes: 42 },
    document: { sha256: 'e'.repeat(64), bytes: 42 }, unit: 'mm', bundle_sha256: 'c'.repeat(64) }
  return { ...context, source_change: { expected_content_hash: 'd'.repeat(64), preparation_digest: 'e'.repeat(64),
    before: { payload: beforePayload, sources: projected(oldDrawing),
      document: { cadgf_document: {}, origin: oldOrigin, view_bundle_sha256: 'c'.repeat(64) } },
    after: { payload: afterPayload, sources: { ...projected(), overlay_origin: context.origin },
      document: { cadgf_document: {}, origin: context.origin, view_bundle_sha256: 'c'.repeat(64) } } } }
}
const preparedAfterProductVersionSwitch = () => {
  const ack = prepared()
  const currentProduct = { ...product, version_id: 'product-v2' }
  ack.origin.basis.product = currentProduct
  ack.source_change.before.payload.product = currentProduct
  ack.source_change.after.payload.product = currentProduct
  ack.source_change.before.sources.product.version_id = currentProduct.version_id
  ack.source_change.after.sources.product.version_id = currentProduct.version_id
  const historical = { ...ack.source_change.before.document.origin, schema: 'yuantus.welding_plan_cad_origin/1',
    context_id: 'old-c', owner_auth_user_id: 88, rbac_user_id: 99, bundle_sha256: '9'.repeat(64) }
  ack.source_change.before.document.origin = historical
  ack.source_change.before.sources = { ...ack.source_change.before.sources, overlay_origin: historical }
  return ack
}
const generationId = '550e8400-e29b-41d4-a716-446655440001'
const generationRequestId = '550e8400-e29b-41d4-a716-446655440002'
const generationTemplate = { id: 'welding-a4', version: '2', digest: 'a'.repeat(64) }
const generationAck = () => ({ schema: 'yuantus.welding_generation_ack/1', request_id: generationRequestId,
  generation_id: generationId, render_key: 'b'.repeat(64), plan_id: 'p', item_version_id: 'v', draft_seq: 2,
  plan_content_hash: 'c'.repeat(64), generation_content_hash: 'd'.repeat(64), purpose: 'review', template: generationTemplate })
const finalGenerationAck = () => ({ ...generationAck(), schema: 'yuantus.welding_final_generation_ack/1', purpose: 'final',
  approval_request_id: 'approval-1', submission_hash: 'e'.repeat(64), decision_hash: 'f'.repeat(64) })
const generationStatus = () => { const { request_id: _requestId, ...fixed } = generationAck(); return {
  ...fixed, schema: 'yuantus.welding_plan_generation/1', status: 'Queued', attempt: 0,
  created_at: '2026-10-08T00:00:00+00:00', review: { pending_count: 1, unbound_count: 2 },
  files: { pdf: null, docx: null }, error: null } }
const finalGenerationStatus = () => { const { request_id: _requestId, ...fixed } = finalGenerationAck(); return {
  ...fixed, schema: 'yuantus.welding_final_generation/1', status: 'Queued', state: 'Approved', attempt: 0,
  created_at: '2026-10-08T00:00:00+00:00', files: { pdf: null, docx: null }, error: null } }
const binaryBytes = Buffer.from('verified welding file')
const binaryHash = createHash('sha256').update(binaryBytes).digest('hex')
const binaryMime = (format: 'pdf' | 'docx') => format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const binaryDescriptor = (format: 'pdf' | 'docx') => ({ format, mime_type: binaryMime(format), byte_size: binaryBytes.length, artifact_sha256: binaryHash })
const readyGeneration = (final = false) => ({ ...(final ? finalGenerationStatus() : generationStatus()), status: 'Ready',
  files: { pdf: binaryDescriptor('pdf'), docx: binaryDescriptor('docx') } })
const readyPublication = () => ({ ...published(), files: { pdf: binaryDescriptor('pdf'), docx: binaryDescriptor('docx') } })
const binaryResponse = (format: 'pdf' | 'docx', bytes = binaryBytes, headers: Record<string, string> = {}) => new Response(bytes, {
  status: 200, headers: { 'Content-Type': binaryMime(format), 'Content-Length': String(binaryBytes.length),
    'X-Artifact-SHA256': binaryHash, ...headers } })
const spools = () => readdirSync(tmpdir()).filter(name => name.startsWith('metasheet-welding-')).sort()
const generationCreateBody = () => JSON.stringify({ request_id: generationRequestId, expected_draft_seq: 2,
  expected_content_hash: 'c'.repeat(64), purpose: 'review', template_id: 'welding-a4', template_version: '2',
  template_digest: 'a'.repeat(64), template_options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null } })
const generationRetryBody = () => JSON.stringify({ request_id: generationRequestId, expected_attempt: 0 })
const workflowBase = () => ({ request_id: 'workflow-request', expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64) })
const workflowOriginal = () => ({
  submit: { ...workflowBase(), review_generation_id: generationId, reviewer_rbac_id: 102 },
  review: { ...workflowBase(), approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64), decision: 'approve', opinion: '' },
  withdraw: { ...workflowBase(), approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64), reason: 'withdraw' },
  reopen: { ...workflowBase(), approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64), reason: 'reopen' },
  'final-render': { ...workflowBase(), approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64),
    expected_decision_hash: 'c'.repeat(64), template_id: 'welding-approval-appendix', template_version: '1', template_digest: 'd'.repeat(64) },
  release: { ...workflowBase(), approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64),
    expected_decision_hash: 'c'.repeat(64), final_generation_id: generationId,
    expected_final_pdf_sha256: 'e'.repeat(64), expected_final_docx_sha256: 'f'.repeat(64) },
  revise: { ...workflowBase(), source_publication_id: 'publication-1', reason: 'next version' },
  'final-retry': { request_id: 'workflow-request', expected_attempt: 0 },
})
const workflowAck = (action: string, state: string, extra: Record<string, unknown> = {}) => ({
  schema: 'yuantus.welding_plan_workflow_ack/1', request_id: 'workflow-request', action,
  plan_id: 'p', item_version_id: 'v', draft_seq: action === 'reopen' ? 2 : 1,
  content_hash: 'a'.repeat(64), state, approval_request_id: 'approval-1', publication_id: action === 'release' ? 'publication-1' : null, ...extra })
const revisionAck = () => ({ schema: 'yuantus.welding_plan_revision_ack/1', request_id: 'workflow-request', action: 'revise',
  plan_id: 'p', source_version_id: 'v', source_publication_id: 'publication-1', source_draft_seq: 1,
  source_content_hash: 'a'.repeat(64), target_version_id: 'new-version', target_version_label: '2.A',
  target_draft_seq: 1, target_content_hash: 'a'.repeat(64), inheritance_id: 'inheritance-1',
  inheritance_sha256: 'b'.repeat(64), state: 'Draft' })
const actor = { auth_user_id: 71, rbac_user_id: 102, display_name: 'Author' }
const published = () => ({ schema: 'yuantus.welding_plan_publication/1', publication_id: 'publication-1',
  plan_id: 'p', item_version_id: 'v', state: 'Released', draft_seq: 1, content_hash: 'a'.repeat(64),
  version_label: '1.A', name: 'Plan', number: 'WP-1', approval_request_id: 'approval-1',
  submission_hash: 'b'.repeat(64), decision_hash: 'c'.repeat(64), review_generation_id: generationId,
  final_generation_id: generationId, generation_content_hash: 'd'.repeat(64), requester: actor,
  reviewer: actor, opinion: '', approved_at: '2026-10-09T00:00:00Z', published_at: '2026-10-09T01:00:00Z',
  publisher: actor, files: { pdf: { format: 'pdf', mime_type: 'application/pdf', byte_size: 42,
    artifact_sha256: 'e'.repeat(64) }, docx: { format: 'docx',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 43,
    artifact_sha256: 'f'.repeat(64) } } })
const publicationRow = () => ({ publication_id: 'publication-1', item_version_id: 'v', version_label: '1.A',
  state: 'Released', published_at: '2026-10-09T01:00:00Z', content_hash: 'a'.repeat(64) })
function upstream(result: unknown = { items: [], total: 0, limit: 50, offset: 0 }, status = 200) {
  fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
    .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
    .mockResolvedValueOnce(json(authority))
    .mockResolvedValueOnce(json(result, status))
}
function binaryUpstream(response: Response) {
  fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
    .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
    .mockResolvedValueOnce(json(authority)).mockResolvedValueOnce(response)
}
function app(beforeRouter?: RequestHandler) {
  const server = express()
  server.use(weldingPreflight)
  server.use(weldingPlanRawBody)
  server.use(express.json({ limit: '10mb' }))
  server.use((req, res, next) => { if (!req.headers.authorization) return res.sendStatus(401); req.authenticatedTenantId = 'mt'; next() })
  if (beforeRouter) server.use(beforeRouter)
  server.use(weldingRouter())
  return server
}
// Keep one listener for the suite so hundreds of requests cannot race ephemeral port reuse.
const relay = createServer(app())
beforeAll(() => new Promise<void>(resolve => { relay.listen(0, '127.0.0.1', resolve) }))
afterAll(() => new Promise<void>((resolve, reject) => {
  relay.closeAllConnections()
  relay.close(error => error ? reject(error) : resolve())
}))
const auth = (method: 'get' | 'post' | 'put' | 'delete', path: string) => request(`http://127.0.0.1:${(relay.address() as AddressInfo).port}`)[method](path).set('Authorization', 'Bearer ms-session')
const resourceHash = 'a'.repeat(64)
const resourcePayload = { schema_version: 1, kind: 'material', suggested_fields: { material_a: 'steel' } }
const resourceCreate = { resource_id: 'resource-1', name: 'Steel', number: 'M-1', request_id: 'create-1', payload: resourcePayload }
const resourceRevision = { request_id: 'revise-1', source_version_id: 'resource-v1', expected_current_version_id: 'resource-v1',
  expected_content_hash: resourceHash, name: 'Steel revised', payload: resourcePayload }
const resourceRecord = (version = 'resource-v1') => ({ resource_id: 'resource-1', item_version_id: version,
  version_label: '1.A', state: 'Draft', name: 'Steel', number: 'M-1', kind: 'material', payload: resourcePayload,
  sources: {}, content_hash: resourceHash })
function probedResourceRecord() {
  const source = { item_id: 'i'.repeat(64), version_id: 'v'.repeat(64), file_id: 'f'.repeat(64),
    file_role: 'attachment', title: 'T'.repeat(12 * 1024 * 1024), version_label: '1.A', state: 'Released',
    is_released: true, file_name: 'F'.repeat(12 * 1024 * 1024), checksum: resourceHash }
  const fingerprint = () => createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
  const fields = { method: '界'.repeat(256), material_a: '界'.repeat(256), material_b: '界'.repeat(256),
    filler: '界'.repeat(256), joint_type: '界'.repeat(256), welding_requirements: '界'.repeat(4000),
    inspection_requirements: '界'.repeat(4000), thickness_a: { value: 1e308, unit: 'mm' },
    thickness_b: { value: 1e308, unit: 'in' }, passes: Array.from({ length: 100 }, (_, i) => ({ sequence: i + 1,
      method: '界'.repeat(256), filler: '界'.repeat(256), current: { value: 1e308, unit: 'A' },
      voltage: { value: 1e308, unit: 'V' }, speed: { value: 1e308, unit: 'mm/min' } })) }
  const record = { resource_id: 'r'.repeat(64), item_version_id: 'new-version', version_label: '1.A', state: 'Draft',
    name: '界'.repeat(128), number: 'N'.repeat(128), kind: 'wps', payload: { schema_version: 1, kind: 'wps',
      suggested_fields: fields, document: { item_id: source.item_id, version_id: source.version_id,
        file_id: source.file_id, file_role: source.file_role, expected_fingerprint: fingerprint() } },
    sources: { document: { ...source, fingerprint: fingerprint() } }, content_hash: resourceHash }
  return { record, source, fingerprint }
}
function documentedResourceRecord(kind: 'wps' | 'joint_diagram' = 'wps') {
  const source = { item_id: 'doc', version_id: 'doc-v1', file_id: 'file', file_role: 'attachment', title: 'Document',
    version_label: '1.A', state: 'Released', is_released: true, file_name: 'source.pdf', checksum: resourceHash }
  const fingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
  const document = { item_id: source.item_id, version_id: source.version_id, file_id: source.file_id,
    file_role: source.file_role, expected_fingerprint: fingerprint }
  const diagram = { schema: 'yuantus.welding_joint_diagram/1', actual_sha256: resourceHash, byte_size: 42,
    mime_type: 'image/png', format: 'png', width: 1, height: 1, exif_orientation: 1 }
  return { ...resourceRecord(), kind, payload: { schema_version: 1, kind,
    suggested_fields: kind === 'joint_diagram' ? { joint_type: 'butt' } : {}, document },
    sources: { document: { ...source, fingerprint }, ...(kind === 'joint_diagram' ? { diagram } : {}) } }
}
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs(); fetchMock.mockReset()
  for (const [name, value] of Object.entries({ WELDING_READ_ENABLED: 'true', WELDING_WRITE_ENABLED: 'true', WELDING_METASHEET_TENANT_ID: 'mt', WELDING_YUANTUS_ORIGIN: 'https://welding.invalid', WELDING_YUANTUS_PROVIDER: 'ms', WELDING_YUANTUS_TENANT_ID: 'yt', WELDING_YUANTUS_ORG_ID: 'yo', WELDING_SSO_ISSUER: 'https://issuer.invalid', WELDING_SSO_CLIENT_ID: 'welding', WELDING_SSO_KID: 'key-1', WELDING_SSO_PRIVATE_KEY_FILE: `${fixture}/key.pem`, RBAC_TOKEN_TRUST: '', RBAC_BYPASS: '' })) vi.stubEnv(name, value)
  mocks.verifyToken.mockResolvedValue({ id: 'u1', tenantId: 'mt' })
  mocks.readTokenPayload.mockReturnValue({ userId: 'u1', tenantId: 'mt', sid: 'sid1', iat: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 300 })
  mocks.resolveSessionTenantId.mockResolvedValue('mt')
  mocks.query.mockResolvedValue({ rows: [{ id: 'sid1' }] })
  vi.stubGlobal('fetch', fetchMock)
})

describe('single enterprise resource relay', () => {
  it('keeps resource reads ON while the exact write flag is OFF', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    upstream(resourceRecord())
    expect((await auth('get', '/api/welding/resources/resource-1/versions/resource-v1')).status).toBe(200)
    expect((await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(JSON.stringify(resourceCreate))).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['/api/welding/resources?limit=1', 'post'], ['/api/welding/resources/resource-1/revisions?x=1', 'post'],
    ['/api/welding/resources/resource-1/versions/resource-v1/extra', 'get'],
    ['/api/welding/resources/resource%2F1/versions/resource-v1', 'get'],
    ['/api/welding/resources/resource-1/versions/resource%ZZ', 'get'],
    ['/api/welding/resources/resource-1/revisions', 'get'],
  ] as const)('closes resource path/query/method %s before identity IO', async (path, method) => {
    const response = await auth(method, path)
    expect([400, 404]).toContain(response.status)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.verifyToken).not.toHaveBeenCalled()
  })

  it.each([
    { ...resourceCreate, request_id: null },
    { ...resourceCreate, extra: 'not allowed' },
    { ...resourceCreate, payload: { ...resourcePayload, suggested_fields: { material_a: null } } },
    { ...resourceCreate, payload: { ...resourcePayload, suggested_fields: { material_a: 'steel', passes: [] } } },
  ])('rejects invalid create DTO before SSO', async body => {
    const response = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(JSON.stringify(body))
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.verifyToken).not.toHaveBeenCalled()
  })

  it('forwards original duplicate-key JSON to the strict Y parser', async () => {
    const raw = '{"resource_id":"resource-1","resource_id":"resource-1","name":"Steel","number":"M-1","request_id":"create-1","payload":{"schema_version":1,"kind":"material","suggested_fields":{}}}'
    upstream({ detail: 'Invalid welding resource' }, 422)
    expect((await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(raw)).status).toBe(422)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(raw)
  })

  it.each(['wps', 'joint_diagram'] as const)('accepts a complete %s fixed document response', async kind => {
    const row = documentedResourceRecord(kind)
    const body = { ...resourceCreate, payload: row.payload }
    upstream(row, 201)
    expect((await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(JSON.stringify(body))).status).toBe(201)
    upstream(row)
    expect((await auth('get', '/api/welding/resources/resource-1/versions/resource-v1')).status).toBe(200)
  })

  it('accepts nullable state/version label and valid astral source snapshot text', async () => {
    const row = documentedResourceRecord()
    const { fingerprint: _oldFingerprint, ...fixed } = row.sources.document
    const source = { ...fixed, title: '😀', file_name: '📄.pdf', state: null, version_label: null }
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
    const valid = { ...row, sources: { document: { ...source, fingerprint } },
      payload: { ...row.payload, document: { ...row.payload.document, expected_fingerprint: fingerprint } } }
    upstream(valid)
    expect((await auth('get', '/api/welding/resources/resource-1/versions/resource-v1')).status).toBe(200)
    upstream(valid, 201)
    expect((await auth('post', '/api/welding/resources').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...resourceCreate, payload: valid.payload }))).status).toBe(201)
  })

  it.each([
    (row: ReturnType<typeof documentedResourceRecord>) => ({ ...row, sources: { ...row.sources, document: { ...row.sources.document, file_id: 'other' } } }),
    (row: ReturnType<typeof documentedResourceRecord>) => ({ ...row, sources: { ...row.sources, document: { ...row.sources.document, fingerprint: 'f'.repeat(64) } } }),
    (row: ReturnType<typeof documentedResourceRecord>) => ({ ...row, payload: { ...row.payload, document: { ...row.payload.document, expected_fingerprint: 'f'.repeat(64) } } }),
    (row: ReturnType<typeof documentedResourceRecord>) => ({ ...row, sources: { document: row.sources.document } }),
  ])('rejects a mismatched joint-diagram source ACK', async mutate => {
    const row = documentedResourceRecord('joint_diagram')
    upstream(mutate(row), 201)
    const response = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...resourceCreate, payload: row.payload }))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('retains Y domain status for 403, 404, 409, 422, and 503', async () => {
    for (const status of [403, 404, 409, 422, 503]) {
      upstream({ detail: 'redacted' }, status)
      const response = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json')
        .send(JSON.stringify(resourceCreate))
      expect(response.status).toBe(status)
      expect(response.text).not.toContain('redacted')
    }
  })

  it('leaves a syntactically valid stale-current revision to Y for its 409 CAS decision', async () => {
    upstream(resourceRecord())
    upstream({ detail: 'Current resource changed' }, 409)
    const raw = JSON.stringify({ ...resourceRevision, expected_current_version_id: 'stale-version' })
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json').send(raw)
    expect(response.status).toBe(409)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/resources/resource-1/versions/resource-v1')
    expect(Buffer.from(fetchMock.mock.calls[7][1].body).toString()).toBe(raw)
  })

  it('does not dispatch revision after fixed source read becomes invisible', async () => {
    upstream({ detail: 'Not Found' }, 404)
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(resourceRevision))
    expect(response.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not dispatch revision when the second verified personal owner differs from the source read', async () => {
    upstream(resourceRecord())
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'second-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json({ ...authority, owner: { ...authority.owner, rbac_user_id: 103 } }))
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(resourceRevision))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('does not dispatch revision after the write gate closes during the fixed source read', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'source-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority))
      .mockImplementationOnce(async () => { vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); return json(resourceRecord()) })
    upstream(resourceRecord())
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(resourceRevision))
    expect(response.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('keeps a fake 201 after a stale source content hash unknown', async () => {
    upstream({ ...resourceRecord(), content_hash: 'c'.repeat(64) })
    upstream({ ...resourceRecord('resource-v2'), name: 'Steel revised', predecessor_version_id: 'resource-v1',
      predecessor_content_hash: resourceHash }, 201)
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(resourceRevision))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('can replay the exact original request and fixed result in a mocked transport', async () => {
    const raw = JSON.stringify(resourceCreate)
    for (let attempt = 0; attempt < 2; attempt++) {
      upstream(resourceRecord(), 201)
      expect((await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(raw)).status).toBe(201)
      expect(Buffer.from(fetchMock.mock.calls[attempt * 4 + 3][1].body).toString()).toBe(raw)
    }
  })

  it('creates, reads, and revises one fixed resource with exact raw request bytes', async () => {
    const raw = JSON.stringify(resourceCreate)
    upstream(resourceRecord(), 201)
    expect((await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(raw)).status).toBe(201)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(raw)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/resources')
    upstream(resourceRecord())
    expect((await auth('get', '/api/welding/resources/resource-1/versions/resource-v1')).status).toBe(200)
    upstream(resourceRecord())
    upstream({ ...resourceRecord('resource-v2'), name: 'Steel revised', predecessor_version_id: 'resource-v1', predecessor_content_hash: resourceHash }, 201)
    expect((await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(resourceRevision))).status).toBe(201)
  })

  it('can create and address a 40-codepoint astral resource ID', async () => {
    const resourceId = '😀'.repeat(40)
    const body = { ...resourceCreate, resource_id: resourceId }
    const row = { ...resourceRecord(), resource_id: resourceId }
    upstream(row, 201)
    expect((await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(JSON.stringify(body))).status).toBe(201)
    upstream(row)
    expect((await auth('get', `/api/welding/resources/${encodeURIComponent(resourceId)}/versions/resource-v1`)).status).toBe(200)
  })

  it.each(['bad/id', 'bad\\id', 'bad%id'])('rejects unaddressable create resource %s before SSO', async resourceId => {
    const response = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...resourceCreate, resource_id: resourceId }))
    expect(response.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves unknown for a wrong post-dispatch revision ACK', async () => {
    upstream(resourceRecord())
    upstream({ ...resourceRecord('resource-v2'), name: 'Steel revised', predecessor_version_id: 'other', predecessor_content_hash: resourceHash }, 201)
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(resourceRevision))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('accepts a fixed Draft revision receipt replay after its readable old source became Released', async () => {
    upstream({ ...resourceRecord(), state: 'Released' })
    upstream({ ...resourceRecord('resource-v2'), name: 'Steel revised', predecessor_version_id: 'resource-v1',
      predecessor_content_hash: resourceHash }, 201)
    const raw = JSON.stringify(resourceRevision)
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json').send(raw)
    expect(response.status).toBe(201)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/resources/resource-1/versions/resource-v1')
    expect(Buffer.from(fetchMock.mock.calls[7][1].body).toString()).toBe(raw)
  })

  it('still rejects a non-Draft revision ACK after a historical-source receipt replay', async () => {
    upstream({ ...resourceRecord(), state: 'Released' })
    upstream({ ...resourceRecord('resource-v2'), name: 'Steel revised', state: 'Released',
      predecessor_version_id: 'resource-v1', predecessor_content_hash: resourceHash }, 201)
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(resourceRevision))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it.each([
    { number: 'DIFFERENT' },
    { kind: 'filler', payload: { schema_version: 1, kind: 'filler', suggested_fields: { filler: 'wire' } } },
  ])('keeps an ACK that changes the fixed original resource number or kind unknown', async change => {
    upstream(resourceRecord())
    upstream({ ...resourceRecord('resource-v2'), name: 'Steel revised', predecessor_version_id: 'resource-v1',
      predecessor_content_hash: resourceHash, ...change }, 201)
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify(change.kind ? { ...resourceRevision, payload: change.payload } : resourceRevision))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('keeps a fake 201 with source-version/current mismatch unknown after Y dispatch', async () => {
    upstream(resourceRecord())
    upstream({ ...resourceRecord('resource-v2'), name: 'Steel revised', predecessor_version_id: 'resource-v1',
      predecessor_content_hash: resourceHash }, 201)
    const response = await auth('post', '/api/welding/resources/resource-1/revisions').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...resourceRevision, expected_current_version_id: 'other-current' }))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('rejects mismatched joint diagram actual checksum on read and after write dispatch', async () => {
    const row = documentedResourceRecord('joint_diagram')
    const invalid = { ...row, sources: { ...row.sources,
      diagram: { ...row.sources.diagram, actual_sha256: 'b'.repeat(64) } } }
    upstream(invalid)
    const read = await auth('get', '/api/welding/resources/resource-1/versions/resource-v1')
    expect(read.status).toBe(502)
    expect(read.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    upstream(invalid, 201)
    const write = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...resourceCreate, payload: row.payload }))
    expect(write.status).toBe(502)
    expect(write.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it.each([
    { state: 'Released\0' }, { version_label: '1.A\0' }, { title: '\ud800' }, { file_name: '\ud800' },
  ])('rejects a document snapshot string Y could not encode', async changed => {
    const row = documentedResourceRecord()
    const invalid = { ...row, sources: { document: { ...row.sources.document, ...changed } } }
    upstream(invalid)
    const read = await auth('get', '/api/welding/resources/resource-1/versions/resource-v1')
    expect(read.status).toBe(502)
    expect(read.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    upstream(invalid, 201)
    const write = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...resourceCreate, payload: row.payload }))
    expect(write.status).toBe(502)
    expect(write.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it.each([
    { ...resourceRecord(), resource_id: 'other' },
    { ...resourceRecord(), item_version_id: 'bad/version' },
    { ...resourceRecord(), name: 'Other' },
    { ...resourceRecord(), payload: { ...resourcePayload, suggested_fields: { material_a: 'other' } } },
    { ...resourceRecord(), content_hash: 'wrong' },
  ])('treats unbound create ACK as unknown', async row => {
    upstream(row, 201)
    const response = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(JSON.stringify(resourceCreate))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('binds every fixed document source field and keeps a wrong source ACK unknown', async () => {
    const { record } = probedResourceRecord()
    const body = { resource_id: record.resource_id, name: record.name, number: record.number,
      request_id: 'create-doc', payload: record.payload }
    upstream({ ...record, sources: { document: { ...record.sources.document, file_id: 'other' } } }, 201)
    const response = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(JSON.stringify(body))
    expect(response.status).toBe(502)
    expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('uses a resource-only 32 MiB receive limit, including a legal 25 MiB source', async () => {
    const { record, source, fingerprint } = probedResourceRecord()
    expect(Buffer.byteLength(JSON.stringify(record))).toBe(25_364_917)
    upstream(record)
    expect((await auth('get', `/api/welding/resources/${record.resource_id}/versions/new-version`)).status).toBe(200)
    const padding = 32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(record))
    source.title += 'T'.repeat(padding)
    record.sources.document.title = source.title
    record.sources.document.fingerprint = fingerprint()
    record.payload.document.expected_fingerprint = fingerprint()
    expect(Buffer.byteLength(JSON.stringify(record))).toBe(32 * 1024 * 1024)
    upstream(record)
    expect((await auth('get', `/api/welding/resources/${record.resource_id}/versions/new-version`)).status).toBe(200)
    const tooLarge = new Response('{}', { status: 200, headers: { 'content-type': 'application/json',
      'content-length': String(32 * 1024 * 1024 + 1) } })
    binaryUpstream(tooLarge)
    const rejected = await auth('get', `/api/welding/resources/${record.resource_id}/versions/new-version`)
    expect(rejected.status).toBe(502)
    expect(rejected.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    binaryUpstream(new Response(new Uint8Array(32 * 1024 * 1024 + 1), { status: 200,
      headers: { 'content-type': 'application/json' } }))
    const streamed = await auth('get', `/api/welding/resources/${record.resource_id}/versions/new-version`)
    expect(streamed.status).toBe(502)
    expect(streamed.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    binaryUpstream(new Response('{}', { status: 201, headers: { 'content-type': 'application/json',
      'content-length': String(32 * 1024 * 1024 + 1) } }))
    const write = await auth('post', '/api/welding/resources').set('Content-Type', 'application/json').send(JSON.stringify(resourceCreate))
    expect(write.status).toBe(502)
    expect(write.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })
})

describe('F02 fixed joint diagram relay', () => {
  const path = '/api/welding/resources/resource-1/versions/resource-v1/diagram'
  const bytes = Buffer.from('fixed joint image bytes for the bounded upstream mock')
  const digest = createHash('sha256').update(bytes).digest('hex')
  const operation = { method: 'GET' as const, path: path.replace('/api/welding', ''), result: 'resource-diagram' as const,
    write: false, resourceId: 'resource-1', resourceVersionId: 'resource-v1' }
  function diagramRecord(format: 'png' | 'jpeg' | 'webp' = 'png') {
    const row = documentedResourceRecord('joint_diagram')
    const source = { ...row.sources.document, checksum: digest, file_name: `joint.${format}` }
    const fingerprint = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(source)
      .filter(([key]) => key !== 'fingerprint').sort(([a], [b]) => a.localeCompare(b))))).digest('hex')
    return { ...row, payload: { ...row.payload, document: { ...row.payload.document, expected_fingerprint: fingerprint } },
      sources: { document: { ...source, fingerprint }, diagram: { ...row.sources.diagram!, actual_sha256: digest,
        byte_size: bytes.length, format, mime_type: `image/${format}` } } }
  }
  function response(body: BodyInit = bytes, headers: Record<string, string> = {}) {
    return new Response(body, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(bytes.length),
      'X-Content-SHA256': digest, ...headers } })
  }
  function queue(image = response(), first = diagramRecord(), last = first) {
    upstream(first); binaryUpstream(image); upstream(last)
  }
  const read = () => weldingResourceDiagram(readWeldingProvider(), 'ms-session', 'mt', operation, new AbortController().signal)

  it.each(['png', 'jpeg', 'webp'] as const)('returns only verified %s bytes with the write gate OFF', async format => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const record = diagramRecord(format)
    queue(response(bytes, { 'Content-Type': `image/${format}` }), record)
    const result = await auth('get', path).buffer(true).parse((incoming, callback) => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.on('end', () => callback(null, Buffer.concat(chunks)))
      incoming.on('error', callback)
    })
    expect(result.status).toBe(200)
    expect(result.body).toEqual(bytes)
    expect(result.headers).toMatchObject({ 'content-type': `image/${format}`, 'content-length': String(bytes.length),
      'x-content-sha256': digest, 'content-disposition': 'inline', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    expect(result.headers.authorization).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(12)
    expect(fetchMock.mock.calls[3][0]).toBe(`https://welding.invalid/api/v1/plugins/welding${operation.path.slice(0, -8)}`)
    expect(fetchMock.mock.calls[7][0]).toBe(`https://welding.invalid/api/v1/plugins/welding${operation.path}`)
    expect(fetchMock.mock.calls[7][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: { Accept: `image/${format}`, Authorization: 'Bearer secret-bearer' } })
    expect(fetchMock.mock.calls[11][0]).toBe(fetchMock.mock.calls[3][0])
  })

  it('reads a historical metadata rename without treating an old fingerprint as a current-source grant', async () => {
    const row = diagramRecord()
    row.name = 'Historical diagram renamed'
    row.sources.document.title = 'Stored source snapshot title'
    queue(response(), row)
    expect((await read()).body).toEqual(bytes)
    expect(fetchMock).toHaveBeenCalledTimes(12)
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('candidate'))).toBe(false)
  })

  it('rejects non-fixed paths, query, body and method before identity or upstream IO', async () => {
    for (const target of [path + '?x=1', path + '?x=1&x=2', path + '/', path + '/extra', path.replace('/diagram', '/Diagram'),
      path.replace('resource-1/', 'resource%2F1/'), path.replace('resource-v1/', '%ZZ/')])
      expect((await auth('get', target)).status).toBe(400)
    for (const method of ['post', 'put', 'delete'] as const) expect((await auth(method, path)).status).toBe(400)
    expect((await (pinned.setApp(app()), request(pinned.url())).head(path).set('Authorization', 'Bearer ms-session')).status).toBe(400)
    expect((await auth('get', path).set('Content-Type', 'text/plain').send('body')).status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    expect((await auth('get', path)).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['non diagram', (row: ReturnType<typeof diagramRecord>) => ({ ...row, kind: 'wps', payload: { ...row.payload, kind: 'wps' }, sources: { document: row.sources.document } })],
    ['extra key', (row: ReturnType<typeof diagramRecord>) => ({ ...row, extra: true })],
    ['wrong version', (row: ReturnType<typeof diagramRecord>) => ({ ...row, item_version_id: 'another' })],
    ['wrong resource', (row: ReturnType<typeof diagramRecord>) => ({ ...row, resource_id: 'another' })],
    ['oversize', (row: ReturnType<typeof diagramRecord>) => ({ ...row, sources: { ...row.sources, diagram: { ...row.sources.diagram, byte_size: 5 * 1024 * 1024 + 1 } } })],
    ['format mismatch', (row: ReturnType<typeof diagramRecord>) => ({ ...row, sources: { ...row.sources, diagram: { ...row.sources.diagram, format: 'jpeg' } } })],
    ['invalid qualification', (row: ReturnType<typeof diagramRecord>) => ({ ...row, sources: { ...row.sources, diagram: { ...row.sources.diagram, width: 4097 } } })],
  ] as const)('rejects %s fixed details before requesting image bytes', async (_label, mutate) => {
    upstream(mutate(diagramRecord()))
    expect((await auth('get', path)).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['MIME', () => response(bytes, { 'Content-Type': 'text/html' })],
    ['MIME parameters', () => response(bytes, { 'Content-Type': 'image/png; charset=utf-8' })],
    ['length', () => response(bytes, { 'Content-Length': '1' })],
    ['missing length', () => { const r = response(); r.headers.delete('Content-Length'); return r }],
    ['missing hash', () => { const r = response(); r.headers.delete('X-Content-SHA256'); return r }],
    ['uppercase hash', () => response(bytes, { 'X-Content-SHA256': digest.toUpperCase() })],
    ['compression', () => response(bytes, { 'Content-Encoding': 'gzip' })],
    ['wrong actual hash', () => response(Buffer.alloc(bytes.length))],
    ['short body', () => response(bytes.subarray(0, -1))],
    ['long body', () => response(Buffer.concat([bytes, Buffer.from('x')]))],
    ['over cap body', () => response(new Uint8Array(5 * 1024 * 1024 + 1))],
    ['redirect status', () => new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid' } })],
    ['redirected flag', () => { const r = response(); Object.defineProperty(r, 'redirected', { value: true }); return r }],
    ['wrong success status', () => new Response(null, { status: 204 })],
  ] as const)('withholds all image bytes for %s', async (_label, image) => {
    queue(image())
    const result = await auth('get', path)
    expect(result.status).toBe(502)
    expect(result.headers['x-content-sha256']).toBeUndefined()
    expect(result.headers['content-type']).toMatch(/^application\/json/)
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it.each([403, 404, 409, 413, 422, 503])('preserves Y diagram refusal %s without returning image bytes', async status => {
    queue(new Response('private detail', { status }))
    const result = await auth('get', path)
    expect(result.status).toBe(status)
    expect(result.body).toEqual({ error: { code: 'WELDING_UPSTREAM_REJECTED' } })
    expect(result.headers['x-content-sha256']).toBeUndefined()
  })

  it('withholds the image when the fixed record changes during delivery', async () => {
    const changed = diagramRecord(); changed.name = 'Changed during read'
    queue(response(), diagramRecord(), changed)
    expect((await auth('get', path)).status).toBe(502)
  })

  it.each([6, 10])('binds the Y owner at SSO authority call %s after acquiring the image descriptor', async call => {
    // Replace only the chosen queued authority response; all three SSO rounds remain real client code.
    let index = 0
    const replies = [json({ state: 'state', nonce: 'nonce', expires_in: 300 }),
      json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }), json(authority), json(diagramRecord()),
      json({ state: 'state', nonce: 'nonce', expires_in: 300 }),
      json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }), json(authority), response(),
      json({ state: 'state', nonce: 'nonce', expires_in: 300 }),
      json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }), json(authority), json(diagramRecord())]
    replies[call] = json({ ...authority, owner: { ...authority.owner, rbac_user_id: 999 } })
    fetchMock.mockImplementation(() => Promise.resolve(replies[index++]))
    expect((await auth('get', path)).status).toBe(502)
  })

  it('checks the original native sid once more after the final fixed detail', async () => {
    queue(); let finalChecks = 0
    mocks.query.mockImplementation(() => Promise.resolve({ rows: fetchMock.mock.calls.length === 12 && ++finalChecks === 2 ? [] : [{ id: 'sid1' }] }))
    const result = await auth('get', path)
    expect(result.status).toBe(401)
    expect(result.headers['x-content-sha256']).toBeUndefined()
    expect(result.body).toEqual({ error: { code: 'WELDING_SESSION_REQUIRED' } })
  })

  it('withholds verified bytes from a changed native subject at the last session check', async () => {
    queue(); let finalChecks = 0
    const payload = mocks.readTokenPayload()
    mocks.query.mockImplementation(() => {
      if (fetchMock.mock.calls.length === 12 && ++finalChecks === 1) {
        mocks.verifyToken.mockResolvedValue({ id: 'another-user', tenantId: 'mt' })
        mocks.readTokenPayload.mockReturnValue({ ...payload, userId: 'another-user', sid: 'another-sid' })
      }
      return Promise.resolve({ rows: [{ id: 'sid1' }] })
    })
    const result = await auth('get', path)
    expect(result.status).toBe(401)
    expect(result.headers['x-content-sha256']).toBeUndefined()
    expect(result.body).toEqual({ error: { code: 'WELDING_SESSION_REQUIRED' } })
  })

  it('rejects only a changed native sid at the final check even when the replacement sid is valid for the same user and tenant', async () => {
    queue(); let finalChecks = 0
    const original = mocks.readTokenPayload()
    mocks.query.mockImplementation((_sql: string, params: unknown[]) => {
      const queriedSid = params[0]
      if (fetchMock.mock.calls.length === 12 && ++finalChecks === 1) mocks.readTokenPayload.mockReturnValue({ ...original, sid: 'sid2' })
      // Both sids have valid rows: only the original-session comparison can reject the replacement.
      return Promise.resolve({ rows: [{ id: queriedSid }] })
    })
    const result = await auth('get', path)
    expect(result.status).toBe(401); expect(finalChecks).toBe(1)
    expect(mocks.readTokenPayload()).toEqual({ ...original, sid: 'sid2' })
    expect(result.headers['x-content-sha256']).toBeUndefined(); expect(result.headers['content-disposition']).toBeUndefined()
    expect(result.headers['content-type']).toMatch(/^application\/json/)
    expect(result.body).toEqual({ error: { code: 'WELDING_SESSION_REQUIRED' } }); expect(fetchMock).toHaveBeenCalledTimes(12)
  })

  it('withholds a fully received image when native access is revoked between stream chunks', async () => {
    let entered!: () => void, resume!: () => void, controller!: ReadableStreamDefaultController<Uint8Array>
    const waiting = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { resume = resolve })
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(bytes.subarray(0, 1)) }, pull() { entered(); return held } }, { highWaterMark: 0 })
    queue(response(stream))
    const pending = auth('get', path), settled = pending.then(value => value)
    try {
      await waiting; expect(fetchMock).toHaveBeenCalledTimes(8)
      mocks.query.mockResolvedValue({ rows: [] })
      controller.enqueue(bytes.subarray(1)); controller.close(); resume()
      const result = await settled
      expect(result.status).toBe(401); expect(result.headers['x-content-sha256']).toBeUndefined(); expect(result.headers['content-disposition']).toBeUndefined()
      expect(result.headers['content-type']).toMatch(/^application\/json/)
      expect(result.body).toEqual({ error: { code: 'WELDING_SESSION_REQUIRED' } }); expect(fetchMock).toHaveBeenCalledTimes(8)
    } finally { resume(); pending.abort() }
  })

  it.each(['SSO challenge', 'final descriptor body'] as const)('terminates by the five-minute HTTP deadline while %s is held and cannot dispatch after late release', async stage => {
    let entered!: () => void, release = () => {}
    const waiting = new Promise<void>(resolve => { entered = resolve }), cancel = vi.fn()
    if (stage === 'SSO challenge') {
      fetchMock.mockImplementationOnce(() => { entered(); return new Promise<Response>(resolve => { release = () => resolve(json({ state: 'state', nonce: 'nonce', expires_in: 300 })) }) })
    } else {
      upstream(diagramRecord()); binaryUpstream(response())
      const stream = new ReadableStream<Uint8Array>({ pull() { entered(); return new Promise<void>(() => {}) }, cancel }, { highWaterMark: 0 })
      fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
        .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
        .mockResolvedValueOnce(json(authority)).mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'application/json' } }))
    }
    const realTimeout = globalThis.setTimeout.bind(globalThis), realClearTimeout = globalThis.clearTimeout.bind(globalThis)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = auth('get', path), settled = pending.then(value => value)
    let entryWatchdog: ReturnType<typeof setTimeout> | undefined, resultWatchdog: ReturnType<typeof setTimeout> | undefined
    try {
      const arrived = await Promise.race([waiting.then(() => true), new Promise<false>(resolve => { entryWatchdog = realTimeout(() => resolve(false), 1000) })])
      expect(arrived).toBe(true); if (entryWatchdog) realClearTimeout(entryWatchdog)
      expect(fetchMock).toHaveBeenCalledTimes(stage === 'SSO challenge' ? 1 : 12)
      // SSO's existing five-second guard may reject sooner; five minutes is the outer ceiling.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      const result = await Promise.race([settled, new Promise<null>(resolve => { resultWatchdog = realTimeout(() => resolve(null), 250) })])
      expect(result?.status).toBe(502); expect(result?.headers['x-content-sha256']).toBeUndefined(); expect(result?.headers['content-disposition']).toBeUndefined()
      expect(result?.headers['content-type']).toMatch(/^application\/json/)
      expect(result?.body).toEqual({ error: { code: 'WELDING_UPSTREAM_REJECTED' } })
      if (stage === 'final descriptor body') expect(cancel).toHaveBeenCalledOnce()
      const dispatched = fetchMock.mock.calls.length; release()
      await new Promise<void>(resolve => realTimeout(resolve, 0)); expect(fetchMock).toHaveBeenCalledTimes(dispatched)
    } finally {
      if (entryWatchdog) realClearTimeout(entryWatchdog); if (resultWatchdog) realClearTimeout(resultWatchdog)
      release(); pending.abort(); vi.useRealTimers()
    }
  })

  it('cancels an incomplete reader on caller abort without awaiting an uncooperative cancel', async () => {
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const stream = new ReadableStream<Uint8Array>({ pull() { entered(); return new Promise<void>(() => {}) }, cancel }, { highWaterMark: 0 })
    queue(response(stream))
    const controller = new AbortController()
    const reading = weldingResourceDiagram(readWeldingProvider(), 'ms-session', 'mt', operation, controller.signal)
    const rejected = expect(reading).rejects.toMatchObject({ status: 502 })
    await waiting; controller.abort(); await rejected
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(['first native', 'binary stream', 'post-image native', 'final SSO native', 'final native'] as const)('bounds a connected diagram request stalled at %s', async stage => {
    let entered!: () => void, release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<{ rows: { id: string }[] }>(resolve => { release = () => resolve({ rows: [{ id: 'sid1' }] }) })
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull() { entered(); return new Promise<void>(() => {}) }, cancel }, { highWaterMark: 0 })
    queue(stage === 'binary stream' ? response(stream) : response())
    let finalChecks = 0
    mocks.query.mockImplementation(() => {
      const calls = fetchMock.mock.calls.length
      if (stage === 'first native' && calls === 0 || stage === 'post-image native' && calls === 8 ||
        stage === 'final SSO native' && calls === 9 || stage === 'final native' && calls === 12 && ++finalChecks === 2) {
        entered(); return held
      }
      return Promise.resolve({ rows: [{ id: 'sid1' }] })
    })
    const realTimeout = globalThis.setTimeout.bind(globalThis), realClearTimeout = globalThis.clearTimeout.bind(globalThis)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = auth('get', path), settled = pending.then(value => value)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      await waiting
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      const result = await Promise.race([settled, new Promise<null>(resolve => { watchdog = realTimeout(() => resolve(null), 150) })])
      expect(result?.status).toBe(502)
      expect(result?.headers['x-content-sha256']).toBeUndefined()
      if (stage === 'binary stream') expect(cancel).toHaveBeenCalledOnce()
      const dispatched = fetchMock.mock.calls.length
      release(); await Promise.resolve(); await Promise.resolve()
      expect(fetchMock).toHaveBeenCalledTimes(dispatched)
    } finally { if (watchdog) realClearTimeout(watchdog); release(); pending.abort(); vi.useRealTimers() }
  })

  it('aborts the upstream image reader on HTTP disconnect before any image bytes are written', async () => {
    let entered!: () => void, closed!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve }), close = new Promise<void>(resolve => { closed = resolve })
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ pull() { entered(); return new Promise<void>(() => {}) }, cancel }, { highWaterMark: 0 })
    queue(response(stream))
    let imageHeaders = false
    const server = createServer(app((_req, res, next) => { res.once('close', () => { imageHeaders = Boolean(res.getHeader('X-Content-SHA256')); closed() }); next() }))
    let pending: ReturnType<typeof auth> | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Owned diagram disconnect test timed out')), 2000) })
    try {
      // Start our server first so Supertest does not claim its automatic-close lifecycle.
      server.listen(0)
      expect(server.listening).toBe(true)
      pending = request(`http://127.0.0.1:${(server.address() as AddressInfo).port}`).get(path).set('Authorization', 'Bearer ms-session')
      const settled = pending.then(() => {}, () => {})
      await Promise.race([waiting, expired]); pending.abort()
      await Promise.race([Promise.all([close, settled]), expired])
      await Promise.race([vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce()), expired])
      expect(imageHeaders).toBe(false)
      expect(server.listening).toBe(true)
    } finally {
      if (timer) clearTimeout(timer)
      pending?.abort()
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Owned diagram HTTP server did not close')), 1000)
        server.close(error => {
          clearTimeout(deadline)
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
          else resolve()
        })
        server.closeAllConnections()
      })
      expect(server.listening).toBe(false)
    }
  }, 5000)
})

describe('F02 authorized catalog relay', () => {
  const cursor = 'eyJhZnRlciI6WyJyIl19.' + 'a'.repeat(64)
  const summary = (version = 'resource-v1') => {
    const row = resourceRecord()
    return { resource_id: row.resource_id, item_version_id: version, version_label: row.version_label,
      state: row.state, name: row.name, number: row.number, kind: row.kind, content_hash: row.content_hash }
  }
  const resources = () => ({ schema: 'yuantus.welding_resource_catalog/1', items: [summary()], next_cursor: null })
  const history = () => ({ schema: 'yuantus.welding_resource_versions/1', resource_id: 'resource-1',
    current_version_id: 'current-not-on-this-page', items: [summary()], next_cursor: null })
  const documents = () => ({ schema: 'yuantus.welding_process_reference_catalog/1',
    items: [documentedResourceRecord().sources.document], limit: 20, next_cursor: null })

  it.each([
    ['/api/welding/resources/catalog?kind=material&thickness_a_value=2.54&thickness_a_unit=mm&limit=1', resources, '/resources/catalog?kind=material&thickness_a_value=2.54&thickness_a_unit=mm&limit=1'],
    ['/api/welding/resources/resource-1/version-catalog?limit=1', history, '/resources/resource-1/version-catalog?limit=1'],
    ['/api/welding/process-references/candidate-catalog?query=WPS', documents, '/process-references/candidate-catalog?query=WPS'],
  ])('relays the closed read through personal SSO while writes are OFF: %s', async (path, result, target) => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const payload = (result as () => unknown)(); upstream(payload)
    const response = await auth('get', path as string)
    expect(response.status).toBe(200); expect(response.body).toEqual(payload)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding' + target)
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer secret-bearer')
  })
  it('forwards a full authorized page and its cursor without changing it', async () => {
    const payload = { ...resources(), items: Array.from({ length: 20 }, (_, i) => summary(`v-${i}`)), next_cursor: cursor }
    upstream(payload)
    expect((await auth('get', `/api/welding/resources/catalog?cursor=${cursor}`)).body).toEqual(payload)
  })
  it.each(['e31', 'A'])('rejects a noncanonical catalog cursor before personal SSO: %s', async prefix => {
    const value = `${prefix}.${'a'.repeat(64)}`
    for (const path of ['/api/welding/resources/catalog?', '/api/welding/resources/resource-1/version-catalog?',
      '/api/welding/process-references/candidate-catalog?query=WPS&']) {
      expect((await auth('get', path + 'cursor=' + value)).status).toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  })
  it.each([
    ['/api/welding/resources/catalog', resources],
    ['/api/welding/resources/resource-1/version-catalog', history],
    ['/api/welding/process-references/candidate-catalog?query=WPS', documents],
  ])('rejects a noncanonical catalog cursor on a full upstream page: %s', async (path, result) => {
    const base = (result as () => ReturnType<typeof resources> | ReturnType<typeof history> | ReturnType<typeof documents>)()
    const items = Array.from({ length: 20 }, (_, i) => path.includes('candidate-catalog')
      ? { ...documents().items[0], version_id: `doc-v${i}` } : summary(`v-${i}`))
    for (const prefix of ['e31', 'A']) {
      upstream({ ...base, items, next_cursor: `${prefix}.${'a'.repeat(64)}` })
      const response = await auth('get', path as string)
      expect(response.status).toBe(502); expect(response.body.items).toBeUndefined()
    }
    const canonical = `e30.${'a'.repeat(64)}`
    upstream({ ...base, items, next_cursor: canonical })
    const response = await auth('get', path as string)
    expect(response.status).toBe(200); expect(response.body.next_cursor).toBe(canonical)
  })
  it('accepts current outside this history page and an undisclosable current null', async () => {
    for (const current of ['current-not-on-this-page', null]) {
      upstream({ ...history(), current_version_id: current })
      const response = await auth('get', '/api/welding/resources/resource-1/version-catalog')
      expect(response.status).toBe(200); expect(response.body.current_version_id).toBe(current)
    }
  })
  it('keeps the same document file in different fixed versions distinct', async () => {
    const payload = documents()
    payload.items.push({ ...payload.items[0], version_id: 'doc-v2' })
    upstream(payload)
    expect((await auth('get', '/api/welding/process-references/candidate-catalog?query=WPS')).status).toBe(200)
  })
  it.each([
    '/api/welding/resources/catalog?limit=0', '/api/welding/resources/catalog?limit=21',
    '/api/welding/resources/catalog?limit=1&limit=2', '/api/welding/resources/catalog?kind=unknown',
    '/api/welding/resources/catalog?actor=other', '/api/welding/resources/catalog?cursor=unsigned',
    '/api/welding/resources/catalog?thickness_a_value=NaN&thickness_a_unit=mm',
    '/api/welding/resources/catalog?thickness_a_value=1e999&thickness_a_unit=mm',
    '/api/welding/resources/catalog?thickness_a_value=-1&thickness_a_unit=mm',
    '/api/welding/resources/catalog?thickness_a_value=1',
    '/api/welding/resources/catalog?thickness_a_unit=mm',
    '/api/welding/resources/catalog?thickness_a_value=1&thickness_a_unit=cm',
    '/api/welding/resources/catalog?method=%00', '/api/welding/resources/catalog?method=%ZZ',
    '/api/welding/resources/resource-1/version-catalog?query=x',
    '/api/welding/process-references/candidate-catalog',
    '/api/welding/process-references/candidate-catalog?query=%1CWPS',
    '/api/welding/process-references/candidate-catalog?query=WPS&query=PQR',
    '/api/welding/process-references/candidate-catalog?query=WPS&limit=1',
    '/api/welding/process-references/candidate-catalog?query=WPS&tenant=other',
  ])('rejects invalid catalog parameters before SSO: %s', async path => {
    expect((await auth('get', path)).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([
    { ...resources(), items: [summary(), summary()] },
    { ...resources(), extra: true },
    { ...resources(), items: [{ ...summary(), payload: {} }] },
    { ...resources(), items: [{ ...summary(), kind: 'unknown' }] },
    { ...resources(), items: [{ ...summary(), kind: ['material'] }] },
    { ...resources(), next_cursor: cursor },
    { ...resources(), items: [], next_cursor: cursor },
    { ...resources(), next_cursor: 'bad' },
  ])('rejects malformed or duplicate resource pages without partial items', async payload => {
    upstream(payload)
    const response = await auth('get', '/api/welding/resources/catalog')
    expect(response.status).toBe(502); expect(response.body.items).toBeUndefined()
  })
  it('rejects another resource in history and results beyond the requested limit', async () => {
    upstream({ ...history(), items: [{ ...summary(), resource_id: 'other' }] })
    expect((await auth('get', '/api/welding/resources/resource-1/version-catalog')).status).toBe(502)
    upstream({ ...resources(), items: [summary(), summary('v2')] })
    expect((await auth('get', '/api/welding/resources/catalog?limit=1')).status).toBe(502)
  })
  it('rejects duplicate document identities and invalid fixed metadata', async () => {
    const payload = documents()
    for (const items of [[payload.items[0], payload.items[0]], [{ ...payload.items[0], file_role: 'drawing' }],
      [{ ...payload.items[0], file_role: ['attachment'] }],
      [{ ...payload.items[0], fingerprint: 'wrong' }]]) {
      upstream({ ...payload, items })
      expect((await auth('get', '/api/welding/process-references/candidate-catalog?query=WPS')).status).toBe(502)
    }
  })
  it.each(['declared', 'chunked'])('fails the entire catalog over its own 2 MiB budget: %s', async mode => {
    const payload = documents()
    payload.items[0].file_name = 'F'.repeat(2 * 1024 * 1024)
    const headers = { 'content-type': 'application/json', ...(mode === 'declared' ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {}) }
    binaryUpstream(new Response(JSON.stringify(payload), { headers }))
    const response = await auth('get', '/api/welding/process-references/candidate-catalog?query=WPS')
    expect(response.status).toBe(502); expect(response.body.items).toBeUndefined()
  })
  it('rechecks the native session after waiting for the complete page', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockImplementationOnce(async () => {
        mocks.query.mockResolvedValue({ rows: [] })
        return json(resources())
      })
    const response = await auth('get', '/api/welding/resources/catalog')
    expect(response.status).toBe(401); expect(response.body.items).toBeUndefined()
  })
})

describe('finite welding plan adapter', () => {
  it('keeps writes default off before session, key, and upstream IO; recovery authority remains read-only', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', '1')
    expect((await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send('{}')).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    upstream(recoveryResult)
    const result = await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(JSON.stringify({ purpose: 'restore', record: { recovery_id: recoveryId } }))
    expect(result.status).toBe(200)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/recovery-authority')
  })

  it.each([undefined, '', '1', 'TRUE', ' true ', 'false'])('requires exact write flag %s without IO', async flag => {
    vi.stubEnv('WELDING_WRITE_ENABLED', flag)
    const result = await auth('put', '/api/welding/plans/p/versions/v/draft').set('Content-Type', 'application/json').send('{}')
    expect(result.status).toBe(503)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires the read flag even when the write flag is true', async () => {
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    expect((await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send('{}')).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.verifyToken).not.toHaveBeenCalled()
  })

  it('forwards exact raw plan JSON bytes, including duplicate keys for Y to reject', async () => {
    upstream({ detail: 'duplicate key' }, 422)
    const body = '{"plan_id":"p","plan_id":"other","payload":{}}'
    const result = await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(422)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans')
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(body)
    expect(result.text).not.toContain('secret-bearer')
  })

  it('accepts a create ACK only for the submitted plan identity', async () => {
    upstream(record('p'), 201)
    expect((await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send('{"plan_id":"p"}')).status).toBe(201)
    upstream(record('other'), 201)
    const mismatch = await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send('{"plan_id":"p"}')
    expect(mismatch.status).toBe(502)
    expect(mismatch.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it.each(['p/other', 'p\\other', 'p%2Fother', 'p%other'])('rejects unaddressable create plan ID %s before identity IO', async planId => {
    const result = await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send(JSON.stringify({ plan_id: planId }))
    expect(result.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['550e8400-e29b-41d4-a716-446655440000', 'plan-natural_1'])('can create and address %s through the fixed detail path', async planId => {
    upstream(record(planId), 201)
    expect((await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send(JSON.stringify({ plan_id: planId }))).status).toBe(201)
    upstream(record(planId))
    expect((await auth('get', `/api/welding/plans/${encodeURIComponent(planId)}/versions/v`)).status).toBe(200)
    expect(fetchMock.mock.calls[7][0]).toBe(`https://welding.invalid/api/v1/plugins/welding/plans/${encodeURIComponent(planId)}/versions/v`)
  })

  it('preserves duplicate-key create bytes for the Y strict parser', async () => {
    upstream({ detail: 'duplicate key' }, 422)
    const body = '{"plan_id":"p","plan_id":"p","payload":{}}'
    const result = await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(422)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(body)
  })

  it.each(['{}', '{"plan_id":1}', '{"plan_id":null}', '{"plan_id":', '{"plan_id":"\\ud800"}'])('rejects missing, nonstring or malformed create plan ID before identity IO', async body => {
    const result = await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends only server-selected method, URL, and Y bearer despite caller headers', async () => {
    upstream()
    const result = await auth('get', '/api/welding/plans').set('x-tenant-id', 'other').set('x-actor-id', '999').set('x-target-url', 'https://evil.invalid')
    expect(result.status).toBe(200)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans')
    expect(fetchMock.mock.calls[3][1].headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer secret-bearer' })
  })

  it('rejects compressed JSON before parsing or SSO because original bytes would change', async () => {
    const result = await auth('post', '/api/welding/plans').set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip').send(gzipSync(Buffer.from('{}')))
    expect(result.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps finite query and path without browser-selected target or authority', async () => {
    upstream({ items: [] })
    const result = await auth('get', '/api/welding/plans/product-candidates?query=steel&limit=2')
    expect(result.status).toBe(200)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/product-candidates?query=steel&limit=2')
    for (const path of ['/api/welding/plans?url=https://evil.invalid', '/api/welding/plans?limit=2&limit=3', '/api/welding/plans/p/versions/v/draft']) {
      const denied = await auth('get', path)
      expect(denied.status).toBe(400)
    }
    expect((await auth('get', '/api/welding/plans/%2E%2E/versions/v')).status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each(['/api/welding/plans/p%2Fother/versions/v', '/api/welding/plans/p/versions/v%5Cother', '/api/welding/plans/p/versions/v%2E%2E%2Fsource-review', '/api/welding/plans/p%252Fother/versions/v'])('rejects encoded path escape %s before identity IO', async path => {
    const result = await auth('get', path)
    expect(result.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['/api/welding/plans', '/plans'],
    ['/api/welding/plans/product-context?product_id=p&product_version_id=v', '/plans/product-context?product_id=p&product_version_id=v'],
    ['/api/welding/plans/drawing-candidates?query=d', '/plans/drawing-candidates?query=d'],
    ['/api/welding/plans/bom-candidates?product_id=p&product_version_id=v', '/plans/bom-candidates?product_id=p&product_version_id=v'],
    ['/api/welding/plans/recovery-authority', '/plans/recovery-authority'],
    ['/api/welding/plans/p/versions/v', '/plans/p/versions/v'],
  ])('maps fixed GET %s', async (path, target) => {
    upstream(path.includes('product-context') ? { schema: 'yuantus.welding_plan_entry/1', product: { item_id: 'p', version_id: 'v' } } :
      path.includes('recovery-authority') ? { schema: 'yuantus.welding_plan_recovery_authority/1', owner: authority.owner } :
      path.endsWith('/versions/v') ? record() : path === '/api/welding/plans' ? { items: [], total: 0, limit: 50, offset: 0 } : { items: [] })
    expect((await auth('get', path)).status).toBe(200)
    expect(fetchMock.mock.calls[3][0]).toBe(`https://welding.invalid/api/v1/plugins/welding${target}`)
    expect(fetchMock.mock.calls[3][1].method).toBe('GET')
  })

  it('accepts a recovery body above the global 10 MiB JSON parser limit as original bytes', async () => {
    upstream(recoveryResult)
    const body = `{"purpose":"restore","record":{"recovery_id":"${recoveryId}","opaque":"${'x'.repeat(10 * 1024 * 1024)}"}}`
    const result = await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(200)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).equals(Buffer.from(body))).toBe(true)
  })

  it('binds a recovery POST result to the original record and requires the Y decision shape', async () => {
    const body = JSON.stringify({ purpose: 'restore', record: { recovery_id: recoveryId } })
    upstream(recoveryResult)
    expect((await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(body)).status).toBe(200)
    upstream({ ...recoveryResult, record_id: 'other' })
    expect((await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(body)).status).toBe(502)
    upstream({ schema: recoveryResult.schema, owner: authority.owner })
    expect((await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(body)).status).toBe(502)
  })

  it('rejects a recovery current record for another plan', async () => {
    const body = JSON.stringify({ purpose: 'restore', record: { recovery_id: recoveryId, draft: { plan_id: 'p', version_id: 'v' } } })
    upstream({ ...recoveryResult, current: record('other', 'v') })
    expect((await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(body)).status).toBe(502)
  })

  it('rejects a recovery current record for another fixed draft version', async () => {
    const body = JSON.stringify({ purpose: 'restore', record: { recovery_id: recoveryId, draft: { plan_id: 'p', version_id: 'v' } } })
    upstream({ ...recoveryResult, current: record('p', 'other') })
    expect((await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(body)).status).toBe(502)
  })

  it('accepts a created version for a matching recovery draft with null version', async () => {
    const body = JSON.stringify({ purpose: 'restore', record: { recovery_id: recoveryId, draft: { plan_id: 'p', version_id: null } } })
    upstream({ ...recoveryResult, current: record('p', 'new-version') })
    expect((await auth('post', '/api/welding/plans/recovery-authority').set('Content-Type', 'application/json').send(body)).status).toBe(200)
  })

  it('preserves Y conflict and denial status without returning upstream detail', async () => {
    for (const status of [403, 404, 409, 503]) {
      upstream({ detail: 'private Y detail' }, status)
      const result = await auth('get', '/api/welding/plans/p/versions/v')
      expect(result.status).toBe(status)
      expect(result.text).not.toContain('private Y detail')
    }
  })

  it('keeps an upstream bearer rejection from logging out the native session', async () => {
    upstream({ detail: 'private Y auth detail' }, 401)
    const result = await auth('get', '/api/welding/plans')
    expect(result.status).toBe(502)
    expect(result.text).not.toContain('private Y auth detail')
    expect(mocks.query).toHaveBeenCalledTimes(7)
  })

  it('reports uncertain write result on transport failure after dispatch and never retries', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockRejectedValueOnce(new Error('lost ACK'))
    const result = await auth('put', '/api/welding/plans/p/versions/v/draft').set('Content-Type', 'application/json').send('{"save_id":"s"}')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('stops a write if the exact write flag turns off during SSO, before domain dispatch', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockImplementationOnce(async () => { vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); return json(authority) })
    const result = await auth('put', '/api/welding/plans/p/versions/v/draft').set('Content-Type', 'application/json').send('{"save_id":"s"}')
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects a wrong detail identity and wrong recovery owner', async () => {
    upstream(record('other'))
    expect((await auth('get', '/api/welding/plans/p/versions/v')).status).toBe(502)
    upstream({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: { ...authority.owner, auth_user_id: 72 } })
    expect((await auth('get', '/api/welding/plans/recovery-authority')).status).toBe(502)
  })

  it('treats a successful save ACK for another version as an unknown write result', async () => {
    upstream(record('p', 'other'))
    const result = await auth('put', '/api/welding/plans/p/versions/v/draft').set('Content-Type', 'application/json').send('{"save_id":"s"}')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('rejects a product context for a different selected version', async () => {
    upstream({ schema: 'yuantus.welding_plan_entry/1', product: { item_id: 'p', version_id: 'other' } })
    expect((await auth('get', '/api/welding/plans/product-context?product_id=p&product_version_id=v')).status).toBe(502)
  })

  it('reports an uncertain write when the original native session is revoked after a Y commit', async () => {
    upstream(record('p', 'v', 2))
    for (let i = 0; i < 6; i++) mocks.query.mockResolvedValueOnce({ rows: [{ id: 'sid1' }] })
    mocks.query.mockResolvedValueOnce({ rows: [] })
    const result = await auth('put', '/api/welding/plans/p/versions/v/draft').set('Content-Type', 'application/json').send('{"save_id":"s"}')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result.text).not.toContain('draft_seq')
  })

  it('maps source review and change history through fixed reads', async () => {
    upstream({ schema: 'yuantus.welding_source_review/1', plan_id: 'p', item_version_id: 'v', draft_seq: 2, content_hash: 'a'.repeat(64), can_write: false, summary: { schema: 'yuantus.welding_source_review/1', pending_count: 0, confirmed_count: 0, removed_pending_count: 0, state_sha256: 'c'.repeat(64) }, items: [], total: 0, limit: 50, offset: 0 })
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-review')).status).toBe(200)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/source-review')
    upstream({ items: [], total: 0, limit: 50, offset: 0 })
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-changes')).status).toBe(200)
    upstream({ schema: 'yuantus.welding_source_change/1', change_id: 'c', draft_seq: 2, before_hash: 'a'.repeat(64), after_hash: 'b'.repeat(64), before: { payload: {}, sources: {} }, after: { payload: {}, sources: {} }, events: [] })
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-changes/c')).status).toBe(200)
    upstream({ schema: 'yuantus.welding_source_document/1', change_id: 'c', side: 'before', payload: { drawing: { expected_checksum: 'c'.repeat(64) } }, cadgf_document: {}, origin: { input: { sha256: 'c'.repeat(64), bytes: 42 }, document: { sha256: 'a'.repeat(64), bytes: 42 }, bundle_sha256: 'b'.repeat(64) }, view_bundle_sha256: 'b'.repeat(64) })
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-changes/c/documents/before')).status).toBe(200)
    expect(fetchMock.mock.calls[15][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/source-changes/c/documents/before')
  })

  it('rejects source-history path and query escape before identity IO', async () => {
    for (const path of ['/api/welding/plans/p/versions/v/source-review?limit=2&limit=3', '/api/welding/plans/p/versions/v/source-changes/c/documents/other', '/api/welding/plans/p/versions/v/source-changes/c%2Fother']) {
      expect((await auth('get', path)).status).toBe(400)
    }
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['before', 'after'])('preserves a historical origin pin with an independent viewer pin on %s', async side => {
    const value = { schema: 'yuantus.welding_source_document/1', change_id: 'c', side,
      payload: { drawing: { expected_checksum: 'c'.repeat(64) } }, cadgf_document: {},
      origin: { input: { sha256: 'c'.repeat(64), bytes: 42 }, document: { sha256: 'a'.repeat(64), bytes: 42 }, bundle_sha256: '9'.repeat(64) }, view_bundle_sha256: 'b'.repeat(64) }
    upstream(value)
    const result = await auth('get', `/api/welding/plans/p/versions/v/source-changes/c/documents/${side}`)
    expect(result.status).toBe(200); expect(result.body).toEqual(value)
  })

  it.each(['origin', 'viewer', 'input', 'change', 'side'])('rejects malformed historical document %s', async damage => {
    const value = { schema: 'yuantus.welding_source_document/1', change_id: 'c', side: 'before',
      payload: { drawing: { expected_checksum: 'c'.repeat(64) } }, cadgf_document: {},
      origin: { input: { sha256: 'c'.repeat(64), bytes: 42 }, document: { sha256: 'a'.repeat(64), bytes: 42 }, bundle_sha256: '9'.repeat(64) }, view_bundle_sha256: 'b'.repeat(64) }
    if (damage === 'origin') value.origin.bundle_sha256 = 'invalid'
    if (damage === 'viewer') value.view_bundle_sha256 = 'invalid'
    if (damage === 'input') value.origin.input.sha256 = 'd'.repeat(64)
    if (damage === 'change') value.change_id = 'other'
    if (damage === 'side') value.side = 'after'
    upstream(value)
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-changes/c/documents/before')).status).toBe(502)
  })

  it('binds review save point and the exact requested history page', async () => {
    const review = { schema: 'yuantus.welding_source_review/1', plan_id: 'p', item_version_id: 'v', draft_seq: 2,
      content_hash: 'a'.repeat(64), can_write: false,
      summary: { schema: 'yuantus.welding_source_review/1', pending_count: 0, confirmed_count: 0, removed_pending_count: 0, state_sha256: 'c'.repeat(64) },
      items: [], total: 0, limit: 2, offset: 3 }
    upstream(review)
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-review?limit=2&offset=3')).status).toBe(200)
    upstream({ ...review, content_hash: 'bad' })
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-review?limit=2&offset=3')).status).toBe(502)
    upstream({ ...review, offset: 4 })
    expect((await auth('get', '/api/welding/plans/p/versions/v/source-review?limit=2&offset=3')).status).toBe(502)
  })

  it('keeps context writes OFF before identity IO', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    expect((await auth('post', '/api/welding/plans/p/versions/v/cad-contexts').set('Content-Type', 'application/json').send('{}')).status).toBe(503)
    expect((await auth('delete', '/api/welding/plans/p/versions/v/cad-contexts/c')).status).toBe(503)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads an existing preparation with writes disabled and preserves its complete two-sided response', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const value = preparedAfterProductVersionSwitch()
    upstream(value)
    const result = await auth('get', '/api/welding/plans/p/versions/v/source-change-preparations/c')
    expect(result.status).toBe(200)
    expect(result.body).toEqual(value)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/source-change-preparations/c')
    expect(fetchMock.mock.calls[3][1].method).toBe('GET')
    expect(fetchMock.mock.calls[3][1].body).toBeUndefined()
  })

  it.each([
    ['context', (v: ReturnType<typeof prepared>) => { v.context_id = 'other' }],
    ['plan', (v: ReturnType<typeof prepared>) => { v.plan_id = 'other' }],
    ['version', (v: ReturnType<typeof prepared>) => { v.item_version_id = 'other' }],
    ['actor', (v: ReturnType<typeof prepared>) => { v.origin.owner_auth_user_id = 72 }],
    ['base hash', (v: ReturnType<typeof prepared>) => { v.source_change.expected_content_hash = 'invalid' }],
    ['digest', (v: ReturnType<typeof prepared>) => { v.source_change.preparation_digest = 'invalid' }],
    ['before source', (v: ReturnType<typeof prepared>) => { v.source_change.before.sources.drawing.checksum = '0'.repeat(64) }],
    ['before viewer', (v: ReturnType<typeof prepared>) => { v.source_change.before.document.view_bundle_sha256 = '0'.repeat(64) }],
    ['after viewer', (v: ReturnType<typeof prepared>) => { v.source_change.after.document.view_bundle_sha256 = '0'.repeat(64) }],
    ['after body', (v: ReturnType<typeof prepared>) => { v.source_change.after.payload.schema_version = 2 }],
    ['after origin', (v: ReturnType<typeof prepared>) => { v.source_change.after.document.origin = { ...v.origin, context_id: 'other' } }],
    ['after stored origin', (v: ReturnType<typeof prepared>) => { v.source_change.after.sources.overlay_origin = { ...v.origin, context_id: 'other' } }],
  ])('rejects a preparation read with mismatched %s', async (_name, mutate) => {
    const value = structuredClone(prepared())
    mutate(value)
    upstream(value)
    const result = await auth('get', '/api/welding/plans/p/versions/v/source-change-preparations/c')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
  })

  it.each([403, 404, 409])('preserves preparation read rejection %s without creating another context', async status => {
    upstream({ detail: 'private' }, status)
    const result = await auth('get', '/api/welding/plans/p/versions/v/source-change-preparations/c')
    expect(result.status).toBe(status)
    expect(result.text).not.toContain('private')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([14, 25])('bounds a preparation read at 24 MiB (%s MiB document)', async size => {
    const value = prepared()
    value.source_change.before.document.cadgf_document = { padding: 'x'.repeat(size * 1024 * 1024) }
    upstream(value)
    const result = await auth('get', '/api/welding/plans/p/versions/v/source-change-preparations/c')
    expect(result.status).toBe(size < 24 ? 200 : 502)
    if (size < 24) expect(result.body.source_change.before.document.cadgf_document.padding.length).toBe(size * 1024 * 1024)
  })

  it.each(['?x=1', '/documents/before', '/extra', '%2Fother'])('rejects unsupported preparation read suffix %s before identity IO', async suffix => {
    const result = await auth('get', '/api/welding/plans/p/versions/v/source-change-preparations/c' + suffix)
    expect([400, 404]).toContain(result.status)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mocks.verifyToken).not.toHaveBeenCalled()
  })

  it('forwards exact source preparation bytes and binds the returned source hash and CAD pin', async () => {
    const body = JSON.stringify({ open_id: 'o', expected_draft_seq: 1, expected_content_hash: 'd'.repeat(64), drawing })
    upstream(prepared(), 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/source-change-preparations').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(201)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(body)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/source-change-preparations')
  })

  it('accepts an authorized prior context origin without imposing current owner or viewer pin on history', async () => {
    const ack = prepared()
    const historical = { ...ack.source_change.before.document.origin, schema: 'yuantus.welding_plan_cad_origin/1',
      context_id: 'old-c', owner_auth_user_id: 88, rbac_user_id: 99, bundle_sha256: '9'.repeat(64) }
    ack.source_change.before.document.origin = historical
    ack.source_change.before.sources = { ...ack.source_change.before.sources, overlay_origin: historical }
    upstream(ack, 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/source-change-preparations').set('Content-Type', 'application/json')
      .send(JSON.stringify({ open_id: 'o', expected_draft_seq: 1, expected_content_hash: 'd'.repeat(64), drawing }))
    expect(result.status).toBe(201)
  })

  it('accepts retained P.v1/D1 origin after the same product moves to P.v2/D1 before preparing D2', async () => {
    upstream(preparedAfterProductVersionSwitch(), 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/source-change-preparations').set('Content-Type', 'application/json')
      .send(JSON.stringify({ open_id: 'o', expected_draft_seq: 1, expected_content_hash: 'd'.repeat(64), drawing }))
    expect(result.status).toBe(201)
  })

  it.each([
    ['product item', (ack: ReturnType<typeof preparedAfterProductVersionSwitch>) => { ack.source_change.before.document.origin.basis.product.item_id = 'other' }],
    ['old drawing', (ack: ReturnType<typeof preparedAfterProductVersionSwitch>) => { ack.source_change.before.document.origin.basis.drawing = drawing }],
    ['old source', (ack: ReturnType<typeof preparedAfterProductVersionSwitch>) => { ack.source_change.before.document.origin.source.checksum = '0'.repeat(64) }],
  ])('rejects retained historical origin with a mismatched %s', async (_label, mutate) => {
    const ack = preparedAfterProductVersionSwitch()
    mutate(ack)
    upstream(ack, 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/source-change-preparations').set('Content-Type', 'application/json')
      .send(JSON.stringify({ open_id: 'o', expected_draft_seq: 1, expected_content_hash: 'd'.repeat(64), drawing }))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('accepts stored uppercase file checksum metadata when qualified CAD source hashes match', async () => {
    const ack = prepared()
    ack.source_change.before.sources.drawing.checksum = oldDrawing.expected_checksum.toUpperCase()
    ack.source_change.after.sources.drawing.checksum = drawing.expected_checksum.toUpperCase()
    upstream(ack, 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/source-change-preparations').set('Content-Type', 'application/json')
      .send(JSON.stringify({ open_id: 'o', expected_draft_seq: 1, expected_content_hash: 'd'.repeat(64), drawing }))
    expect(result.status).toBe(201)
  })

  it('treats a preparation ACK for another source hash as unknown', async () => {
    const resultBody = prepared()
    resultBody.source_change.expected_content_hash = 'e'.repeat(64)
    upstream(resultBody, 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/source-change-preparations').set('Content-Type', 'application/json')
      .send(JSON.stringify({ open_id: 'o', expected_draft_seq: 1, expected_content_hash: 'd'.repeat(64), drawing }))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it.each([
    ['after drawing', (ack: ReturnType<typeof prepared>) => { ack.source_change.after.payload.drawing = oldDrawing }],
    ['before product', (ack: ReturnType<typeof prepared>) => { ack.source_change.before.payload.product = { item_id: 'other', version_id: 'other-v1' } }],
    ['before source', (ack: ReturnType<typeof prepared>) => { ack.source_change.before.sources.drawing.checksum = '0'.repeat(64) }],
    ['after product', (ack: ReturnType<typeof prepared>) => { ack.source_change.after.payload.product = { item_id: 'other', version_id: 'other-v1' } }],
    ['before origin basis', (ack: ReturnType<typeof prepared>) => { ack.source_change.before.document.origin.basis.drawing = drawing }],
    ['before origin input', (ack: ReturnType<typeof prepared>) => { ack.source_change.before.document.origin.input.sha256 = '0'.repeat(64) }],
    ['before viewer pin', (ack: ReturnType<typeof prepared>) => { ack.source_change.before.document.view_bundle_sha256 = '0'.repeat(64) }],
    ['before stored origin', (ack: ReturnType<typeof prepared>) => { ack.source_change.before.sources = { ...ack.source_change.before.sources, overlay_origin: { context_id: 'other' } } }],
    ['after origin source', (ack: ReturnType<typeof prepared>) => { ack.source.checksum = '0'.repeat(64); ack.origin.source.checksum = '0'.repeat(64) }],
  ])('rejects an unrelated %s in a same-owner preparation ACK', async (_label, mutate) => {
    const ack = prepared()
    mutate(ack)
    upstream(ack, 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/source-change-preparations').set('Content-Type', 'application/json')
      .send(JSON.stringify({ open_id: 'o', expected_draft_seq: 1, expected_content_hash: 'd'.repeat(64), drawing }))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('maps CAD context open, fixed read and literal DELETE 204 without a JSON body', async () => {
    upstream(cad(), 201)
    expect((await auth('post', '/api/welding/plans/p/versions/v/cad-contexts').set('Content-Type', 'application/json').send('{"open_id":"o","expected_draft_seq":1}')).status).toBe(201)
    upstream(cad())
    expect((await auth('get', '/api/welding/plans/p/versions/v/cad-contexts/c')).status).toBe(200)
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockResolvedValueOnce(new Response(null, { status: 204 }))
    const removed = await auth('delete', '/api/welding/plans/p/versions/v/cad-contexts/c')
    expect(removed.status).toBe(204)
    expect(removed.text).toBe('')
    expect(fetchMock.mock.calls[11][1].method).toBe('DELETE')
  })

  it('rejects a foreign CAD editor URL as an unknown write receipt', async () => {
    upstream({ ...cad(), editor_url: 'https://evil.invalid/welding-frame.html' }, 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/cad-contexts').set('Content-Type', 'application/json').send('{"open_id":"o","expected_draft_seq":1}')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('rejects a different CAD pin even at the fixed editor path', async () => {
    upstream({ ...cad(), editor_url: `/welding-cad/${'d'.repeat(64)}/welding-frame.html` }, 201)
    const result = await auth('post', '/api/welding/plans/p/versions/v/cad-contexts').set('Content-Type', 'application/json').send('{"open_id":"o","expected_draft_seq":1}')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('stops a context write when the exact write flag turns off during SSO', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockImplementationOnce(async () => { vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); return json(authority) })
    const result = await auth('post', '/api/welding/plans/p/versions/v/cad-contexts').set('Content-Type', 'application/json').send('{"open_id":"o","expected_draft_seq":1}')
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rejects a context for another fixed ID and reports lost DELETE ACK as unknown', async () => {
    upstream(cad('other'))
    expect((await auth('get', '/api/welding/plans/p/versions/v/cad-contexts/c')).status).toBe(502)
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockRejectedValueOnce(new Error('lost ACK'))
    const result = await auth('delete', '/api/welding/plans/p/versions/v/cad-contexts/c')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it('does not accept JSON 200 as a successful context DELETE', async () => {
    upstream({ ok: true })
    const result = await auth('delete', '/api/welding/plans/p/versions/v/cad-contexts/c')
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('reads the fixed Y template catalog with native identity and rejects query escape', async () => {
    upstream({ schema: 'yuantus.welding_instruction_templates/1', items: [{ ...generationTemplate, name: 'A4', available: true,
      unavailable_reason: null, default_options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null }, options_schema: {} }] })
    expect((await auth('get', '/api/welding/render-templates')).status).toBe(200)
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/render-templates')
    expect((await auth('get', '/api/welding/render-templates?url=https://evil.invalid')).status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('requires the read gate and rejects malformed artifact IDs before identity IO', async () => {
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    expect((await auth('get', '/api/welding/render-templates')).status).toBe(503)
    expect((await auth('get', `/api/welding/artifacts/${generationId}`)).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.stubEnv('WELDING_READ_ENABLED', 'true')
    for (const path of ['/api/welding/artifacts/wrong%2Fpath', '/api/welding/artifacts/not-a-uuid',
      `/api/welding/artifacts/${generationId}?url=https://evil.invalid`])
      expect((await auth('get', path)).status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['%ZZ', '%2', '%FF'])('rejects malformed renders ID %s before identity IO', async badId => {
    for (const [method, path] of (['get', 'post'] as const).flatMap(method => [
      [method, `/api/welding/plans/${badId}/versions/v/renders`],
      [method, `/api/welding/plans/p/versions/${badId}/renders`],
    ] as const)) {
      const call = () => method === 'post' ? auth(method, path).set('Content-Type', 'application/json').send('{}') : auth(method, path)
      expect((await call()).status).toBe(400)
      vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
      expect((await call()).status).toBe(400)
      vi.stubEnv('WELDING_READ_ENABLED', 'false')
      expect((await call()).status).toBe(503)
      vi.stubEnv('WELDING_READ_ENABLED', 'true')
      vi.stubEnv('WELDING_WRITE_ENABLED', 'true')
    }
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates one review generation with exact raw body and bound 202 receipt', async () => {
    const body = generationCreateBody()
    upstream(generationAck(), 202)
    const result = await auth('post', '/api/welding/plans/p/versions/v/renders').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(202)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(body)
    upstream({ ...generationAck(), template: { ...generationTemplate, digest: '0'.repeat(64) } }, 202)
    const mismatch = await auth('post', '/api/welding/plans/p/versions/v/renders').set('Content-Type', 'application/json').send(body)
    expect(mismatch.status).toBe(502)
    expect(mismatch.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('rejects unaddressable or cross-request generation ACK after dispatch', async () => {
    for (const ack of [{ ...generationAck(), generation_id: 'wrong/path' }, { ...generationAck(), request_id: 'other' },
      { ...generationAck(), draft_seq: 3 }, { ...generationAck(), plan_content_hash: '0'.repeat(64) },
      { ...generationAck(), purpose: 'final' }, { ...generationAck(), template: { ...generationTemplate, version: '1' } }]) {
      upstream(ack, 202)
      const result = await auth('post', '/api/welding/plans/p/versions/v/renders').set('Content-Type', 'application/json').send(generationCreateBody())
      expect(result.status).toBe(502)
      expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    }
  })

  it('lists authorized review and final generation statuses with exact purpose and pagination', async () => {
    upstream({ items: [generationStatus()], total: 1, limit: 2, offset: 0 })
    expect((await auth('get', '/api/welding/plans/p/versions/v/renders?purpose=review&limit=2')).status).toBe(200)
    upstream({ items: [finalGenerationStatus()], total: 1, limit: 50, offset: 0 })
    expect((await auth('get', '/api/welding/plans/p/versions/v/renders?purpose=final')).status).toBe(200)
    upstream({ items: [generationStatus()], total: 1, limit: 50, offset: 0 })
    expect((await auth('get', '/api/welding/plans/p/versions/v/renders?purpose=final')).status).toBe(502)
    upstream({ items: [{ ...generationStatus(), plan_id: 'other' }], total: 1, limit: 50, offset: 0 })
    expect((await auth('get', '/api/welding/plans/p/versions/v/renders')).status).toBe(502)
    for (const path of ['/api/welding/plans/p/versions/v/renders?purpose=review&purpose=final',
      '/api/welding/plans/p/versions/v/renders?purpose=other', '/api/welding/plans/p/versions/v/renders?limit=101'])
      expect((await auth('get', path)).status).toBe(400)
  })

  it('reads one fixed review or final artifact status without exposing file bytes', async () => {
    upstream(generationStatus())
    expect((await auth('get', `/api/welding/artifacts/${generationId}`)).status).toBe(200)
    upstream(finalGenerationStatus())
    expect((await auth('get', `/api/welding/artifacts/${generationId}`)).status).toBe(200)
    upstream({ ...generationStatus(), generation_id: 'other' })
    expect((await auth('get', `/api/welding/artifacts/${generationId}`)).status).toBe(502)
    upstream(generationStatus())
    expect((await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)).status).toBe(409)
  })

  it('accepts only bounded Ready file descriptors and fixed status identity', async () => {
    const file = (format: 'pdf' | 'docx') => ({ format, mime_type: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byte_size: 42, artifact_sha256: 'f'.repeat(64) })
    const ready = { ...generationStatus(), status: 'Ready', files: { pdf: file('pdf'), docx: file('docx') } }
    upstream(ready)
    expect((await auth('get', `/api/welding/artifacts/${generationId}`)).status).toBe(200)
    upstream({ ...ready, files: { ...ready.files, pdf: { ...file('pdf'), mime_type: 'text/html' } } })
    expect((await auth('get', `/api/welding/artifacts/${generationId}`)).status).toBe(502)
    upstream({ ...finalGenerationStatus(), purpose: 'review' })
    expect((await auth('get', `/api/welding/artifacts/${generationId}`)).status).toBe(502)
  })

  it('retries review and final tasks with original bytes and their distinct Y ACK schemas', async () => {
    for (const ack of [generationAck(), finalGenerationAck()]) {
      upstream(ack, 202)
      const result = await auth('post', `/api/welding/artifacts/${generationId}/retry`).set('Content-Type', 'application/json').send(generationRetryBody())
      expect(result.status).toBe(202)
      expect(Buffer.from(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body).toString()).toBe(generationRetryBody())
    }
    upstream({ ...finalGenerationAck(), decision_hash: 'bad' }, 202)
    const mismatch = await auth('post', `/api/welding/artifacts/${generationId}/retry`).set('Content-Type', 'application/json').send(generationRetryBody())
    expect(mismatch.status).toBe(502)
    expect(mismatch.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('rejects retry ACK for another task or request and preserves Y strict duplicate-key rejection', async () => {
    for (const ack of [{ ...generationAck(), generation_id: '550e8400-e29b-41d4-a716-446655440003' },
      { ...finalGenerationAck(), request_id: 'other' }, { ...finalGenerationAck(), approval_request_id: '' }]) {
      upstream(ack, 202)
      const result = await auth('post', `/api/welding/artifacts/${generationId}/retry`).set('Content-Type', 'application/json').send(generationRetryBody())
      expect(result.status).toBe(502)
      expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    }
    const original = `{"request_id":"${generationRequestId}","expected_attempt":0,"expected_attempt":0}`
    upstream({ detail: 'duplicate key' }, 422)
    const rejected = await auth('post', `/api/welding/artifacts/${generationId}/retry`).set('Content-Type', 'application/json').send(original)
    expect(rejected.status).toBe(422)
    expect(Buffer.from(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body).toString()).toBe(original)
  })

  it('gates generation writes before identity IO and preserves unknown after lost retry ACK', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    expect((await auth('post', '/api/welding/plans/p/versions/v/renders').set('Content-Type', 'application/json').send(generationCreateBody())).status).toBe(503)
    expect((await auth('post', `/api/welding/artifacts/${generationId}/retry`).set('Content-Type', 'application/json').send(generationRetryBody())).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.stubEnv('WELDING_WRITE_ENABLED', 'true')
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockRejectedValueOnce(new Error('lost ACK'))
    const result = await auth('post', `/api/welding/artifacts/${generationId}/retry`).set('Content-Type', 'application/json').send(generationRetryBody())
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('stops generation mutation if the write flag flips during personal SSO', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockImplementationOnce(async () => { vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); return json(authority) })
    const result = await auth('post', '/api/welding/plans/p/versions/v/renders').set('Content-Type', 'application/json').send(generationCreateBody())
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reads one fixed review state', async () => {
    upstream({ schema: 'yuantus.welding_review_state/1', plan_id: 'p', item_version_id: 'v', state: 'Draft',
      draft_seq: 1, content_hash: 'a'.repeat(64), is_current: true, approval: null, final_generation: null,
      publication: null, final_profile: null, allowed_actions: [], issues: [] })
    expect((await auth('get', '/api/welding/plans/p/versions/v/review-state')).status).toBe(200)
    upstream({ schema: 'yuantus.welding_review_state/1', plan_id: 'p', item_version_id: 'v', state: 'Released',
      draft_seq: 1, content_hash: 'a'.repeat(64), is_current: true, approval: null,
      final_generation: { ...finalGenerationStatus(), status: 'Ready', draft_seq: 1,
        plan_content_hash: 'a'.repeat(64), files: published().files },
      publication: published(), final_profile: null, allowed_actions: ['revise'], issues: [] })
    expect((await auth('get', '/api/welding/plans/p/versions/v/review-state')).status).toBe(200)
  })

  it('validates one original plan basis with the read gate alone', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    upstream({ schema: 'yuantus.welding_plan_validation/1', plan_id: 'p', item_version_id: 'v',
      draft_seq: 1, content_hash: 'a'.repeat(64), ready: true, issues: [] })
    expect((await auth('post', '/api/welding/plans/p/versions/v/validate').set('Content-Type', 'application/json')
      .send(JSON.stringify({ expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64) }))).status).toBe(200)
    upstream({ schema: 'yuantus.welding_plan_validation/1', plan_id: 'p', item_version_id: 'other',
      draft_seq: 1, content_hash: 'a'.repeat(64), ready: false, issues: ['not-ready'] })
    expect((await auth('post', '/api/welding/plans/p/versions/v/validate').set('Content-Type', 'application/json')
      .send(JSON.stringify({ expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64) }))).status).toBe(502)
  })

  it('reads the actual plan-scoped official publication directory', async () => {
    upstream({ schema: 'yuantus.welding_publication_directory/1', plan_id: 'p',
      total: 0, limit: 20, offset: 0, items: [], current_publication: null })
    expect((await auth('get', '/api/welding/plans/p/publications')).status).toBe(200)
  })

  it('binds review history pagination and rejects a different target', async () => {
    const history = { schema: 'yuantus.welding_review_history/1', plan_id: 'p', item_version_id: 'v',
      total: 1, limit: 2, offset: 0, items: [{ event_id: 'event-1', approval: null, action: 'created',
        from_state: null, to_state: 'draft', note: null, actor, created_at: '2026-10-09T00:00:00Z' }] }
    upstream(history)
    expect((await auth('get', '/api/welding/plans/p/versions/v/review-history?limit=2')).status).toBe(200)
    upstream({ ...history, item_version_id: 'other' })
    expect((await auth('get', '/api/welding/plans/p/versions/v/review-history?limit=2')).status).toBe(502)
    for (const query of ['limit=101', 'limit=0', 'limit=2&limit=2', 'url=https://evil.invalid'])
      expect((await auth('get', `/api/welding/plans/p/versions/v/review-history?${query}`)).status).toBe(400)
  })

  it('binds official publication descriptors, directory, and named comparison versions', async () => {
    upstream(published())
    expect((await auth('get', '/api/welding/plans/p/versions/v/publication')).status).toBe(200)
    upstream({ ...published(), files: { ...published().files, pdf: { ...published().files.pdf, url: 'https://evil.invalid' } } })
    expect((await auth('get', '/api/welding/plans/p/versions/v/publication')).status).toBe(502)
    upstream({ schema: 'yuantus.welding_publication_directory/1', plan_id: 'p',
      total: 1, limit: 2, offset: 0, items: [publicationRow()], current_publication: publicationRow() })
    expect((await auth('get', '/api/welding/plans/p/publications?limit=2')).status).toBe(200)
    const side = { item_version_id: 'v', version_label: '1.A', publication_id: 'publication-1', content_hash: 'a'.repeat(64) }
    upstream({ schema: 'yuantus.welding_publication_comparison/1', plan_id: 'p', from: side,
      to: { ...side, item_version_id: 'v2' }, summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
      welds: [], plan_changes: [] })
    expect((await auth('get', '/api/welding/plans/p/publication-comparison?from_version_id=v&to_version_id=v2')).status).toBe(200)
    upstream({ schema: 'yuantus.welding_publication_comparison/1', plan_id: 'p', from: side,
      to: { ...side, item_version_id: 'other' }, summary: {}, welds: [], plan_changes: [] })
    expect((await auth('get', '/api/welding/plans/p/publication-comparison?from_version_id=v&to_version_id=v2')).status).toBe(502)
    upstream({ schema: 'yuantus.welding_publication_comparison/1', plan_id: 'p', from: side,
      to: { ...side, item_version_id: 'v2' }, summary: { added: 0, removed: 0, changed: 1, unchanged: 0 },
      welds: [{ weld_id: 'w1', kind: 'changed', changed_fields: ['outside-finite-fields'] }], plan_changes: [] })
    expect((await auth('get', '/api/welding/plans/p/publication-comparison?from_version_id=v&to_version_id=v2')).status).toBe(502)
  })

  it('closes malformed workflow paths and comparison queries before identity IO', async () => {
    for (const path of ['/api/welding/plans/%ZZ/versions/v/review-state',
      '/api/welding/plans/p/versions/%2F/review-history', '/api/welding/plans/p/publication-comparison',
      '/api/welding/plans/p/publication-comparison?from_version_id=v',
      '/api/welding/plans/p/publication-comparison?from_version_id=v&to_version_id=v2&to_version_id=v3',
      '/api/welding/plans/p/publication-comparison?from_version_id=v%2Fescape&to_version_id=v2',
      '/api/welding/plans/p/publications?limit=51',
      '/api/welding/plans/p/versions/v/publication-comparison?from_version_id=v&to_version_id=v2'])
      expect((await auth('get', path)).status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards original workflow commands and binds action, save point, and state', async () => {
    const base = workflowBase()
    const cases = [
      ['submit', { ...base, review_generation_id: generationId, reviewer_rbac_id: 102 }, workflowAck('submit', 'InReview')],
      ['review', { ...base, approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64), decision: 'approve', opinion: '' }, workflowAck('approve', 'Approved')],
      ['withdraw', { ...base, approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64), reason: 'withdraw' }, workflowAck('withdraw', 'Draft')],
      ['reopen', { ...base, approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64), reason: 'reopen' }, workflowAck('reopen', 'Draft')],
      ['release', { ...base, approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64), expected_decision_hash: 'c'.repeat(64),
        final_generation_id: generationId, expected_final_pdf_sha256: 'e'.repeat(64), expected_final_docx_sha256: 'f'.repeat(64) }, workflowAck('release', 'Released')],
    ] as const
    for (const [command, requestBody, ack] of cases) {
      const body = JSON.stringify(requestBody)
      upstream(ack)
      const result = await auth('post', `/api/welding/plans/p/versions/v/${command}`).set('Content-Type', 'application/json').send(body)
      expect(result.status).toBe(200)
      const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
      expect(call[0]).toBe(`https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/${command}`)
      expect(Buffer.from(call[1].body).toString()).toBe(body)
    }
    upstream({ ...workflowAck('submit', 'InReview'), content_hash: '0'.repeat(64) })
    const wrong = await auth('post', '/api/welding/plans/p/versions/v/submit').set('Content-Type', 'application/json')
      .send(JSON.stringify(cases[0][1]))
    expect(wrong.status).toBe(502)
    expect(wrong.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('binds final-render and revision ACKs to their distinct original requests', async () => {
    const finalBody = { ...workflowBase(), approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64),
      expected_decision_hash: 'c'.repeat(64), template_id: 'welding-approval-appendix', template_version: '1', template_digest: 'd'.repeat(64) }
    const finalAck = { ...finalGenerationAck(), request_id: 'workflow-request', draft_seq: 1,
      plan_content_hash: 'a'.repeat(64), submission_hash: 'b'.repeat(64), decision_hash: 'c'.repeat(64),
      template: { id: finalBody.template_id, version: finalBody.template_version, digest: finalBody.template_digest } }
    upstream(finalAck, 202)
    expect((await auth('post', '/api/welding/plans/p/versions/v/final-renders').set('Content-Type', 'application/json')
      .send(JSON.stringify(finalBody))).status).toBe(202)
    upstream({ ...finalAck, decision_hash: '0'.repeat(64) }, 202)
    expect((await auth('post', '/api/welding/plans/p/versions/v/final-renders').set('Content-Type', 'application/json')
      .send(JSON.stringify(finalBody))).body.error.code).toBe('WELDING_RESULT_UNKNOWN')
    const revisionBody = { ...workflowBase(), source_publication_id: 'publication-1', reason: 'next version' }
    upstream(revisionAck())
    expect((await auth('post', '/api/welding/plans/p/versions/v/revise').set('Content-Type', 'application/json')
      .send(JSON.stringify(revisionBody))).status).toBe(200)
    upstream({ ...revisionAck(), source_publication_id: 'other' })
    expect((await auth('post', '/api/welding/plans/p/versions/v/revise').set('Content-Type', 'application/json')
      .send(JSON.stringify(revisionBody))).body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('resolves only the original finite command with committed ACK or unknown null', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const body = { command: 'submit', body: { ...workflowBase(), review_generation_id: generationId, reviewer_rbac_id: 102 } }
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: 'submit', request_id: 'workflow-request', status: 'unknown', ack: null })
    const original = JSON.stringify(body)
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(original)).status).toBe(200)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(original)
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: 'submit', request_id: 'workflow-request', status: 'committed', ack: workflowAck('submit', 'InReview') })
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(JSON.stringify(body))).status).toBe(200)
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: 'submit', request_id: 'workflow-request', status: 'unknown', ack: workflowAck('submit', 'InReview') })
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(JSON.stringify(body))).status).toBe(502)
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: 'submit', request_id: 'other', status: 'committed', ack: workflowAck('submit', 'InReview') })
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(JSON.stringify(body))).status).toBe(502)
  })

  it('binds final and revision original receipt confirmations and rejects unknown commands before SSO', async () => {
    const finalBody = { ...workflowBase(), approval_request_id: 'approval-1', expected_submission_hash: 'b'.repeat(64),
      expected_decision_hash: 'c'.repeat(64), template_id: 'welding-approval-appendix', template_version: '1', template_digest: 'd'.repeat(64) }
    const finalAck = { ...finalGenerationAck(), request_id: 'workflow-request', draft_seq: 1,
      plan_content_hash: 'a'.repeat(64), submission_hash: 'b'.repeat(64), decision_hash: 'c'.repeat(64),
      template: { id: finalBody.template_id, version: finalBody.template_version, digest: finalBody.template_digest } }
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: 'final-render', request_id: 'workflow-request', status: 'committed', ack: finalAck })
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(JSON.stringify({ command: 'final-render', body: finalBody }))).status).toBe(200)
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: 'revise', request_id: 'workflow-request', status: 'committed', ack: revisionAck() })
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(JSON.stringify({ command: 'revise', body: { ...workflowBase(), source_publication_id: 'publication-1', reason: 'next' } }))).status).toBe(200)
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: 'final-retry', request_id: 'workflow-request', status: 'committed', ack: finalAck })
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(JSON.stringify({ command: 'final-retry', generation_id: generationId, body: { request_id: 'workflow-request', expected_attempt: 0 } }))).status).toBe(200)
    const calls = fetchMock.mock.calls.length
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send('{"command":"delete-anything","body":{"request_id":"workflow-request"}}')).status).toBe(400)
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send('{"command":"final-retry","body":{"request_id":"workflow-request","expected_attempt":0}}')).status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(calls)
  })

  it('preserves explicit Y status and strict duplicate-key rejection on workflow routes', async () => {
    upstream({ detail: 'save point moved' }, 409)
    expect((await auth('post', '/api/welding/plans/p/versions/v/submit').set('Content-Type', 'application/json')
      .send(JSON.stringify(workflowBase()))).status).toBe(409)
    upstream({ detail: 'not visible' }, 404)
    expect((await auth('get', '/api/welding/plans/p/versions/v/publication')).status).toBe(404)
    const original = `{"request_id":"workflow-request","request_id":"other","expected_draft_seq":1,"expected_content_hash":"${'a'.repeat(64)}"}`
    upstream({ detail: 'duplicate key' }, 422)
    expect((await auth('post', '/api/welding/plans/p/versions/v/submit').set('Content-Type', 'application/json')
      .send(original)).status).toBe(422)
    expect(Buffer.from(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body).toString()).toBe(original)
  })

  it('keeps workflow reads and read-only POST gated before identity IO', async () => {
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    expect((await auth('get', '/api/welding/plans/p/versions/v/review-state')).status).toBe(503)
    expect((await auth('get', '/api/welding/plans/p/publications')).status).toBe(503)
    expect((await auth('post', '/api/welding/plans/p/versions/v/validate').set('Content-Type', 'application/json')
      .send(JSON.stringify(workflowBase()))).status).toBe(503)
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve').set('Content-Type', 'application/json')
      .send(JSON.stringify({ command: 'submit', body: workflowBase() }))).status).toBe(503)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gates workflow writes, preserves read-only validation, and reports lost ACK as unknown', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    expect((await auth('post', '/api/welding/plans/p/versions/v/submit').set('Content-Type', 'application/json')
      .send(JSON.stringify(workflowBase()))).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.stubEnv('WELDING_WRITE_ENABLED', 'true')
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockRejectedValueOnce(new Error('lost ACK'))
    const result = await auth('post', '/api/welding/plans/p/versions/v/submit').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...workflowBase(), review_generation_id: generationId, reviewer_rbac_id: 102 }))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('stops a workflow mutation when the write gate flips during personal SSO', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockImplementationOnce(async () => { vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); return json(authority) })
    const result = await auth('post', '/api/welding/plans/p/versions/v/submit').set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...workflowBase(), review_generation_id: generationId, reviewer_rbac_id: 102 }))
    expect(result.status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['submit missing save point', { command: 'submit', body: { request_id: 'workflow-request' } }],
    ['review missing submission', { command: 'review', body: { ...workflowBase(), decision: 'approve', opinion: '' } }],
    ['final-render missing decision', { command: 'final-render', body: { request_id: 'workflow-request' } }],
    ['final-retry missing attempt', { command: 'final-retry', generation_id: generationId, body: { request_id: 'workflow-request' } }],
    ['revise missing reason', { command: 'revise', body: { ...workflowBase(), source_publication_id: 'publication-1' } }],
    ['submit extra envelope key', { command: 'submit', body: workflowOriginal().submit, target_url: 'https://evil.invalid' }],
    ['submit string sequence', { command: 'submit', body: { ...workflowOriginal().submit, expected_draft_seq: '1' } }],
    ['submit uppercase digest', { command: 'submit', body: { ...workflowOriginal().submit, expected_content_hash: 'A'.repeat(64) } }],
    ['submit trailing newline digest', { command: 'submit', body: { ...workflowOriginal().submit, expected_content_hash: `${'a'.repeat(64)}\n` } }],
    ['submit invalid reviewer', { command: 'submit', body: { ...workflowOriginal().submit, reviewer_rbac_id: 0 } }],
    ['review invalid decision', { command: 'review', body: { ...workflowOriginal().review, decision: 'skip' } }],
    ['withdraw empty reason', { command: 'withdraw', body: { ...workflowOriginal().withdraw, reason: '  ' } }],
    ['withdraw Y whitespace reason', { command: 'withdraw', body: { ...workflowOriginal().withdraw, reason: '\u0085' } }],
    ['final-render wrong template', { command: 'final-render', body: { ...workflowOriginal()['final-render'], template_id: 'welding-a4' } }],
    ['submit extra body key', { command: 'submit', body: { ...workflowOriginal().submit, actor_id: 71 } }],
    ['submit long request ID', { command: 'submit', body: { ...workflowOriginal().submit, request_id: 'x'.repeat(65) } }],
    ['submit leading Y whitespace', { command: 'submit', body: { ...workflowOriginal().submit, request_id: '\u0085workflow-request' } }],
    ['review oversized opinion', { command: 'review', body: { ...workflowOriginal().review, opinion: 'x'.repeat(4001) } }],
    ['release missing file digest', { command: 'release', body: { ...workflowBase(), approval_request_id: 'approval-1',
      expected_submission_hash: 'b'.repeat(64), expected_decision_hash: 'c'.repeat(64), final_generation_id: generationId } }],
  ])('rejects incomplete original %s before personal SSO', async (_label, envelope) => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: envelope.command,
      request_id: 'workflow-request', status: 'unknown', ack: null })
    const result = await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve')
      .set('Content-Type', 'application/json').send(JSON.stringify(envelope))
    expect(result.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(Object.entries(workflowOriginal()))('accepts one complete original %s receipt query with write OFF', async (command, body) => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const envelope = { command, body, ...(command === 'final-retry' ? { generation_id: generationId } : {}) }
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command,
      request_id: 'workflow-request', status: 'unknown', ack: null })
    const original = JSON.stringify(envelope)
    const result = await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve')
      .set('Content-Type', 'application/json').send(original)
    expect(result.status).toBe(200)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(original)
  })

  it.each([
    ['submit FEFF request ID', 'submit', { ...workflowOriginal().submit, request_id: '\ufeffworkflow-request' }, workflowAck('submit', 'InReview', { request_id: '\ufeffworkflow-request' })],
    ['withdraw FEFF reason', 'withdraw', { ...workflowOriginal().withdraw, reason: '\ufeff' }, workflowAck('withdraw', 'Draft')],
    ['reject FEFF opinion', 'review', { ...workflowOriginal().review, decision: 'reject', opinion: '\ufeff' }, workflowAck('reject', 'Draft')],
  ] as const)('accepts Y-valid %s in direct ACK and read-only receipt resolution', async (_label, command, body, ack) => {
    const original = JSON.stringify(body)
    upstream(ack)
    const direct = await auth('post', `/api/welding/plans/p/versions/v/${command}`)
      .set('Content-Type', 'application/json').send(original)
    expect(direct.status).toBe(200)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(original)
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const envelope = JSON.stringify({ command, body })
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command, request_id: body.request_id,
      status: 'committed', ack })
    const resolved = await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve')
      .set('Content-Type', 'application/json').send(envelope)
    expect(resolved.status).toBe(200)
    expect(Buffer.from(fetchMock.mock.calls[7][1].body).toString()).toBe(envelope)
  })

  it.each([
    ['revise', 'revise', { ...workflowOriginal().revise, request_id: '\ufeffworkflow-request' },
      { ...revisionAck(), request_id: '\ufeffworkflow-request' }, 200],
    ['final-render', 'final-renders', { ...workflowOriginal()['final-render'], request_id: '\ufeffworkflow-request' },
      { ...finalGenerationAck(), request_id: '\ufeffworkflow-request', draft_seq: 1,
        plan_content_hash: 'a'.repeat(64), submission_hash: 'b'.repeat(64), decision_hash: 'c'.repeat(64),
        template: { id: 'welding-approval-appendix', version: '1', digest: 'd'.repeat(64) } }, 202],
  ] as const)('accepts FEFF request ID for direct and resolved %s ACKs', async (command, directPath, body, ack, status) => {
    const original = JSON.stringify(body)
    upstream(ack, status)
    expect((await auth('post', `/api/welding/plans/p/versions/v/${directPath}`)
      .set('Content-Type', 'application/json').send(original)).status).toBe(status)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(original)
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const envelope = JSON.stringify({ command, body })
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command, request_id: body.request_id,
      status: 'committed', ack })
    expect((await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve')
      .set('Content-Type', 'application/json').send(envelope)).status).toBe(200)
    expect(Buffer.from(fetchMock.mock.calls[7][1].body).toString()).toBe(envelope)
  })

  it.each([
    ['U+0085 ID edge', { command: 'submit', body: { ...workflowOriginal().submit, request_id: '\u0085workflow-request' } }],
    ['U+001C ID edge', { command: 'submit', body: { ...workflowOriginal().submit, request_id: 'workflow-request\u001c' } }],
    ['U+0085-only opinion', { command: 'review', body: { ...workflowOriginal().review, decision: 'reject', opinion: '\u0085' } }],
    ['U+001C-only reason', { command: 'withdraw', body: { ...workflowOriginal().withdraw, reason: '\u001c' } }],
  ] as const)('rejects Python whitespace %s before receipt identity IO', async (_label, envelope) => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const result = await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve')
      .set('Content-Type', 'application/json').send(JSON.stringify(envelope))
    expect(result.status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['final-render', { command: 'final-render', body: { request_id: 'workflow-request' } }],
    ['final-retry', { command: 'final-retry', generation_id: generationId, body: { request_id: 'workflow-request' } }],
  ])('rejects incomplete %s even with a forged committed final ACK', async (_name, envelope) => {
    upstream({ schema: 'yuantus.welding_workflow_resolution/1', command: envelope.command,
      request_id: 'workflow-request', status: 'committed', ack: { ...finalGenerationAck(), request_id: 'workflow-request' } })
    const result = await auth('post', '/api/welding/plans/p/versions/v/workflow-receipts/resolve')
      .set('Content-Type', 'application/json').send(JSON.stringify(envelope))
    expect(result.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['submit', workflowBase(), workflowAck('submit', 'InReview'), 200],
    ['release', { ...workflowBase(), approval_request_id: 'approval-1' }, workflowAck('release', 'Released'), 200],
    ['revise', { ...workflowBase(), source_publication_id: 'publication-1' }, revisionAck(), 200],
    ['final-renders', { request_id: 'workflow-request' }, { ...finalGenerationAck(), request_id: 'workflow-request' }, 202],
  ])('does not accept a false successful %s ACK for an incomplete direct command', async (command, body, ack, status) => {
    upstream(ack, status)
    const result = await auth('post', `/api/welding/plans/p/versions/v/${command}`).set('Content-Type', 'application/json')
      .send(JSON.stringify(body))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })

  it('preserves Y strict 422 for a malformed direct final-render request', async () => {
    const original = '{"request_id":"workflow-request"}'
    upstream({ detail: 'missing fields' }, 422)
    const result = await auth('post', '/api/welding/plans/p/versions/v/final-renders')
      .set('Content-Type', 'application/json').send(original)
    expect(result.status).toBe(422)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(original)
  })

  it.each([
    ['review PDF', '/api/welding/artifacts/550e8400-e29b-41d4-a716-446655440001/files/pdf', 'pdf', readyGeneration()],
    ['final DOCX', '/api/welding/artifacts/550e8400-e29b-41d4-a716-446655440001/files/docx', 'docx', readyGeneration(true)],
    ['formal PDF', '/api/welding/plans/p/versions/v/publication/files/pdf', 'pdf', readyPublication()],
    ['formal DOCX', '/api/welding/plans/p/versions/v/publication/files/docx', 'docx', readyPublication()],
  ] as const)('downloads verified %s through fixed personal paths with write OFF', async (_label, path, format, descriptor) => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const before = spools()
    upstream(descriptor)
    binaryUpstream(binaryResponse(format))
    upstream(descriptor)
    const result = await auth('get', path).buffer(true).parse((response, callback) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => callback(null, Buffer.concat(chunks)))
      response.on('error', callback)
    })
    expect(result.status).toBe(200)
    expect(Buffer.from(result.body).equals(binaryBytes)).toBe(true)
    expect(result.headers['content-type']).toBe(binaryMime(format))
    expect(result.headers['content-length']).toBe(String(binaryBytes.length))
    expect(result.headers['x-artifact-sha256']).toBe(binaryHash)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.headers['content-disposition']).toMatch(/^attachment; filename="welding-(artifact|publication)\.(pdf|docx)"$/)
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      'https://welding.invalid/api/v1/auth/sso/challenge', 'https://welding.invalid/api/v1/auth/sso/login',
      'https://welding.invalid/api/v1/plugins/welding/generation-authority',
      `https://welding.invalid/api/v1/plugins/welding${path.replace('/api/welding', '').replace(/\/files\/(pdf|docx)$/, '')}`,
      'https://welding.invalid/api/v1/auth/sso/challenge', 'https://welding.invalid/api/v1/auth/sso/login',
      'https://welding.invalid/api/v1/plugins/welding/generation-authority',
      `https://welding.invalid/api/v1/plugins/welding${path.replace('/api/welding', '')}`,
      'https://welding.invalid/api/v1/auth/sso/challenge', 'https://welding.invalid/api/v1/auth/sso/login',
      'https://welding.invalid/api/v1/plugins/welding/generation-authority',
      `https://welding.invalid/api/v1/plugins/welding${path.replace('/api/welding', '').replace(/\/files\/(pdf|docx)$/, '')}`,
    ])
    expect(fetchMock.mock.calls[7][1].headers.Authorization).toBe('Bearer secret-bearer')
    expect(result.headers.authorization).toBeUndefined()
    await vi.waitFor(() => expect(spools()).toEqual(before))
  })

  it('rejects binary path, query, and OFF read gate before native or Y IO', async () => {
    for (const path of ['/api/welding/artifacts/%ZZ/files/pdf',
      `/api/welding/artifacts/${generationId}/files/png`,
      `/api/welding/artifacts/${generationId}/files/PDF`,
      `/api/welding/artifacts/${generationId}/files/pdf?x=1`,
      `/api/welding/artifacts/${generationId}/files/pdf?x=1&x=2`,
      '/api/welding/plans/p/versions/v/publication/files/docx?x=1',
      '/api/welding/plans/p/versions/v/publication/files/DOCX',
      '/api/welding/plans/p%2Fescape/versions/v/publication/files/pdf',
      '/api/welding/plans/p/versions/v/publication/files/PDF/extra'])
      expect((await auth('get', path)).status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    expect((await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)).status).toBe(503)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['MIME', binaryResponse('pdf', binaryBytes, { 'Content-Type': 'text/html' })],
    ['length header', binaryResponse('pdf', binaryBytes, { 'Content-Length': '1' })],
    ['SHA header', binaryResponse('pdf', binaryBytes, { 'X-Artifact-SHA256': '0'.repeat(64) })],
    ['content encoding', binaryResponse('pdf', binaryBytes, { 'Content-Encoding': 'gzip' })],
    ['actual bytes', binaryResponse('pdf', Buffer.alloc(binaryBytes.length, 0))],
  ] as const)('withholds %s mismatch bytes and removes private spool', async (_label, response) => {
    const before = spools()
    upstream(readyGeneration())
    binaryUpstream(response)
    const result = await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)
    expect(result.status).toBe(502)
    expect(result.headers['content-type']).toMatch(/application\/json/)
    expect(result.headers['x-artifact-sha256']).toBeUndefined()
    await vi.waitFor(() => expect(spools()).toEqual(before))
  })

  it('withholds spooled bytes after a changed descriptor or fresh Y denial', async () => {
    const before = spools()
    upstream(readyGeneration())
    binaryUpstream(binaryResponse('pdf'))
    upstream({ ...readyGeneration(), files: { ...readyGeneration().files,
      pdf: { ...binaryDescriptor('pdf'), artifact_sha256: '0'.repeat(64) } } })
    expect((await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)).status).toBe(502)
    await vi.waitFor(() => expect(spools()).toEqual(before))
    fetchMock.mockClear()
    upstream(readyGeneration())
    binaryUpstream(binaryResponse('pdf'))
    upstream({ detail: 'source revoked' }, 403)
    expect((await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)).status).toBe(403)
    await vi.waitFor(() => expect(spools()).toEqual(before))
  })

  it('withholds verified bytes if the native session is revoked during final source recheck', async () => {
    const before = spools()
    upstream(readyGeneration())
    binaryUpstream(binaryResponse('pdf'))
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority))
      .mockImplementationOnce(async () => { mocks.query.mockResolvedValue({ rows: [] }); return json(readyGeneration()) })
    const result = await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)
    expect(result.status).toBe(401)
    expect(result.headers['x-artifact-sha256']).toBeUndefined()
    await vi.waitFor(() => expect(spools()).toEqual(before))
  })

  it('binds the same verified Y owner across descriptor, binary, and fresh descriptor', async () => {
    const before = spools()
    const changedOwner = { ...authority, owner: { ...authority.owner, rbac_user_id: 103 } }
    upstream(readyGeneration())
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(changedOwner))
    expect((await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(7)
    expect(spools()).toEqual(before)
    fetchMock.mockClear()
    upstream(readyGeneration())
    binaryUpstream(binaryResponse('pdf'))
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(changedOwner)).mockResolvedValueOnce(json(readyGeneration()))
    expect((await auth('get', `/api/welding/artifacts/${generationId}/files/pdf`)).status).toBe(502)
    await vi.waitFor(() => expect(spools()).toEqual(before))
  })

  it('cancels an incomplete binary stream and deletes its owned spool', async () => {
    const before = spools()
    const abort = new AbortController()
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(binaryBytes.subarray(0, 5)) } })
    upstream(readyGeneration())
    binaryUpstream(new Response(stream, { headers: { 'Content-Type': 'application/pdf',
      'Content-Length': String(binaryBytes.length), 'X-Artifact-SHA256': binaryHash } }))
    const download = weldingPlanDownload(readWeldingProvider(), 'ms-session', 'mt', {
      method: 'GET', path: `/artifacts/${generationId}/files/pdf`, result: 'generation-file',
      write: false, generationId, format: 'pdf',
    }, abort.signal)
    await vi.waitFor(() => expect(spools().length).toBe(before.length + 1))
    abort.abort()
    await expect(download).rejects.toMatchObject({ code: 'WELDING_UPSTREAM_REJECTED', status: 502 })
    await vi.waitFor(() => expect(spools()).toEqual(before))
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it('does no identity or Y IO for an already cancelled download', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(weldingPlanDownload(readWeldingProvider(), 'ms-session', 'mt', {
      method: 'GET', path: `/artifacts/${generationId}/files/pdf`, result: 'generation-file',
      write: false, generationId, format: 'pdf',
    }, abort.signal)).rejects.toMatchObject({ code: 'WELDING_UPSTREAM_REJECTED', status: 502 })
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('can clean a returned private spool more than once', async () => {
    const before = spools()
    upstream(readyGeneration())
    binaryUpstream(binaryResponse('pdf'))
    upstream(readyGeneration())
    const download = await weldingPlanDownload(readWeldingProvider(), 'ms-session', 'mt', {
      method: 'GET', path: `/artifacts/${generationId}/files/pdf`, result: 'generation-file',
      write: false, generationId, format: 'pdf',
    }, new AbortController().signal)
    expect(spools().length).toBe(before.length + 1)
    await Promise.all([download.cleanup(), download.cleanup()])
    await download.cleanup()
    expect(spools()).toEqual(before)
  })

  it('closes a disconnected stalled browser and removes its spool before the deadline', async () => {
    const before = spools()
    const bytes = Buffer.alloc(128 * 1024, 42)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const descriptor = { format: 'pdf' as const, mime_type: 'application/pdf', byte_size: bytes.length, artifact_sha256: digest }
    const status = { ...readyGeneration(), files: { ...readyGeneration().files, pdf: descriptor } }
    upstream(status)
    binaryUpstream(binaryResponse('pdf', bytes, { 'Content-Length': String(bytes.length), 'X-Artifact-SHA256': digest }))
    upstream(status)
    let markStalled!: () => void
    const stalled = new Promise<void>(resolve => { markStalled = resolve })
    let closed = false
    const server = app((_req, res, next) => {
      res.once('close', () => { closed = true })
      res.write = ((..._args: unknown[]) => { res.flushHeaders(); markStalled(); return false }) as typeof res.write
      next()
    })
    const pending = (pinned.setApp(server), request(pinned.url())).get(`/api/welding/artifacts/${generationId}/files/pdf`)
      .set('Authorization', 'Bearer ms-session')
    const settled = pending.then(() => true, () => true)
    await stalled
    expect(closed).toBe(false)
    expect(spools().length).toBe(before.length + 1)
    pending.abort()
    await settled
    await vi.waitFor(() => expect(closed).toBe(true))
    await vi.waitFor(() => expect(spools()).toEqual(before))
  })

  it('expires a connected stalled downstream after five fake minutes and removes the spool', async () => {
    const before = spools()
    const bytes = Buffer.alloc(128 * 1024, 42)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const descriptor = { format: 'pdf' as const, mime_type: 'application/pdf', byte_size: bytes.length, artifact_sha256: digest }
    const status = { ...readyGeneration(), files: { ...readyGeneration().files, pdf: descriptor } }
    upstream(status)
    binaryUpstream(binaryResponse('pdf', bytes, { 'Content-Length': String(bytes.length), 'X-Artifact-SHA256': digest }))
    upstream(status)
    const realTimeout = globalThis.setTimeout.bind(globalThis)
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let markStalled!: () => void
    const stalled = new Promise<void>(resolve => { markStalled = resolve })
    let closed = false
    const server = app((_req, res, next) => {
      res.once('close', () => { closed = true })
      res.write = ((..._args: unknown[]) => { res.flushHeaders(); markStalled(); return false }) as typeof res.write
      next()
    })
    const pending = (pinned.setApp(server), request(pinned.url())).get(`/api/welding/artifacts/${generationId}/files/pdf`)
      .set('Authorization', 'Bearer ms-session')
    const settled = pending.then(() => true, () => true)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      await stalled
      expect(closed).toBe(false)
      expect(spools().length).toBe(before.length + 1)
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      const finished = await Promise.race([settled, new Promise<boolean>(resolve => {
        watchdog = realTimeout(() => resolve(false), 150)
      })])
      expect(finished).toBe(true)
      expect(closed).toBe(true)
    } finally {
      if (watchdog) realClearTimeout(watchdog)
      pending.abort()
      vi.useRealTimers()
      await vi.waitFor(() => expect(spools()).toEqual(before))
    }
  })

  it.each(['post-spool recheck', 'final descriptor recheck', 'final native session'] as const)(
    'expires a connected download waiting at %s without later dispatch', async stage => {
      const before = spools()
      upstream(readyGeneration())
      binaryUpstream(binaryResponse('pdf'))
      upstream(readyGeneration())
      let release!: () => void
      const held = new Promise<{ rows: { id: string }[] }>((resolve, reject) => {
        release = () => stage === 'final descriptor recheck' ? reject(new Error('late native query')) : resolve({ rows: [{ id: 'sid1' }] })
      })
      let entered!: () => void
      const waiting = new Promise<void>(resolve => { entered = resolve })
      let afterBinary = 0
      let afterFinal = 0
      mocks.query.mockImplementation(() => {
        const calls = fetchMock.mock.calls.length
        const hold = stage === 'post-spool recheck' && calls === 8 && ++afterBinary === 1 ||
          stage === 'final descriptor recheck' && calls === 9 ||
          stage === 'final native session' && calls === 12 && ++afterFinal === 2
        if (hold) { entered(); return held }
        return Promise.resolve({ rows: [{ id: 'sid1' }] })
      })
      const realTimeout = globalThis.setTimeout.bind(globalThis)
      const realClearTimeout = globalThis.clearTimeout.bind(globalThis)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let closed = false
      const server = app((_req, res, next) => { res.once('close', () => { closed = true }); next() })
      const pending = (pinned.setApp(server), request(pinned.url())).get(`/api/welding/artifacts/${generationId}/files/pdf`)
        .set('Authorization', 'Bearer ms-session')
      const settled = pending.then(() => true, () => true)
      let watchdog: ReturnType<typeof setTimeout> | undefined
      try {
        await waiting
        expect(spools().length).toBe(before.length + 1)
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        const finished = await Promise.race([settled, new Promise<boolean>(resolve => {
          watchdog = realTimeout(() => resolve(false), 150)
        })])
        expect(finished).toBe(true)
        expect(closed).toBe(true)
        expect(spools()).toEqual(before)
        const dispatched = fetchMock.mock.calls.length
        release()
        await new Promise<void>(resolve => realTimeout(resolve, 0))
        expect(fetchMock).toHaveBeenCalledTimes(dispatched)
      } finally {
        if (watchdog) realClearTimeout(watchdog)
        release()
        pending.abort()
        vi.useRealTimers()
        await vi.waitFor(() => expect(spools()).toEqual(before))
      }
    })
})


const reuseBody = () => ({ request_id: 'reuse-request', source_publication_id: 'publication-1',
  expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64), selected_weld_ids: ['weld-1'],
  target_plan_id: 'target-p', name: 'Target plan', number: 'WP-2',
  product: { item_id: 'target-product', version_id: 'target-product-v1' }, drawing, reason: 'New product' })
const reuseAck = () => ({ schema: 'yuantus.welding_plan_reuse_ack/1', action: 'reuse', request_id: 'reuse-request',
  reuse_id: 'reuse-1', source_plan_id: 'p', source_version_id: 'v', source_publication_id: 'publication-1',
  source_draft_seq: 1, source_content_hash: 'a'.repeat(64), target_plan_id: 'target-p', target_version_id: 'target-v',
  target_version_label: '1.A', target_draft_seq: 1, target_content_hash: 'b'.repeat(64), state: 'Draft',
  reuse_provenance_sha256: 'c'.repeat(64) })
const reuseResolution = (committed = false) => ({ schema: 'yuantus.welding_reuse_resolution/1', command: 'reuse',
  request_id: 'reuse-request', status: committed ? 'committed' : 'unknown', ack: committed ? reuseAck() : null })
const reuseProvenance = () => ({ schema: 'yuantus.welding_reuse_provenance/1', reuse_id: 'reuse-1',
  reuse_provenance_sha256: 'c'.repeat(64), basis: { schema: 'yuantus.welding_reuse/1',
    metadata: { id: 'reuse-1', tenant_id: 'yt', org_id: 'yo', source_plan_id: 'p', source_version_id: 'v',
      source_publication_id: 'publication-1', target_plan_id: 'target-p', target_version_id: 'target-v',
      request_id: 'reuse-request', request_digest: 'd'.repeat(64), reason: 'New product',
      actor: { ...actor, auth_user_id: 88, rbac_user_id: 99 }, created_at: '2026-10-09T00:00:00Z' },
    request: reuseBody(), source: { draft_seq: 1, content_hash: 'a'.repeat(64) },
    target: { version_label: '1.A', content_hash: 'b'.repeat(64),
      payload: { product: reuseBody().product, drawing, bom: null }, sources: { reuse: { schema: 'yuantus.welding_reuse/1', reuse_id: 'reuse-1' } } },
    mappings: [{ source_weld_id: 'weld-1', target_weld_id: 'target-weld', source_values: {}, copy_values: {},
      process_associations: [], resource_associations: [] }] } })

describe('F18 reuse finite relay', () => {
  it('forwards exact reuse bytes and accepts an independent 16-field ACK with a different target hash', async () => {
    const body = '  ' + JSON.stringify(reuseBody(), null, 2) + '\n'
    upstream(reuseAck())
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(200)
    expect(result.body).toEqual(reuseAck())
    expect(result.headers['cache-control']).toBe('no-store')
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/reuse')
    expect(fetchMock.mock.calls[3][1].method).toBe('POST')
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(body)
  })
  it.each([false, true])('resolves original full bytes with write OFF, committed=%s', async committed => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const body = ' ' + JSON.stringify(reuseBody()) + '\n'
    upstream(reuseResolution(committed))
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse-receipts/resolve').set('Content-Type', 'application/json').send(body)
    expect(result.status).toBe(200)
    expect(result.body).toEqual(reuseResolution(committed))
    expect(String(fetchMock.mock.calls[3][0]).endsWith('/plans/p/versions/v/reuse-receipts/resolve')).toBe(true)
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(body)
    expect((await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(body)).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('reads exact target provenance with write OFF and a different historical author', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); upstream(reuseProvenance())
    const result = await auth('get', '/api/welding/plans/target-p/versions/target-v/reuse-provenance')
    expect(result.status).toBe(200); expect(result.body).toEqual(reuseProvenance())
    expect(fetchMock.mock.calls[3][1].method).toBe('GET')
    expect(fetchMock.mock.calls[3][1].body).toBeUndefined()
  })
  it.each([
    ['post', '/api/welding/plans/p/versions/v/reuse?x=1'],
    ['post', '/api/welding/plans/p/versions/v/reuse-receipts/resolve?x=1&x=2'],
    ['get', '/api/welding/plans/target-p/versions/target-v/reuse-provenance?x=1'],
    ['post', '/api/welding/plans/p%2Fescape/versions/v/reuse'],
    ['post', '/api/welding/plans/p/versions/%ZZ/reuse'],
    ['post', '/api/welding/plans/p/versions/v/reuse/extra'],
    ['get', '/api/welding/plans/p/versions/v/reuse'],
    ['post', '/api/welding/plans/target-p/versions/target-v/reuse-provenance'],
  ] as const)('rejects invalid finite %s %s before identity', async (method, path) => {
    expect((await auth(method, path).set('Content-Type', 'application/json').send(method === 'post' ? JSON.stringify(reuseBody()) : undefined)).status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([{ command: 'reuse', body: reuseBody() }, { ...reuseBody(), selected_weld_ids: ['weld-1', 'weld-1'] },
    { ...reuseBody(), reason: '\u0085' }, { ...reuseBody(), extra: true }])('rejects invalid original resolve body before identity', async body => {
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse-receipts/resolve').set('Content-Type', 'application/json').send(JSON.stringify(body))
    expect(result.status).toBe(400); expect(mocks.verifyToken).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([revisionAck(), { ...reuseAck(), source_plan_id: 'wrong' }, { ...reuseAck(), source_version_id: 'wrong' },
    { ...reuseAck(), source_publication_id: 'wrong' }, { ...reuseAck(), source_draft_seq: 2 },
    { ...reuseAck(), source_content_hash: 'e'.repeat(64) }, { ...reuseAck(), target_plan_id: 'wrong' },
    { ...reuseAck(), request_id: 'wrong' }, { ...reuseAck(), target_draft_seq: 2 }, { ...reuseAck(), extra: true }])(
    'retains UNKNOWN after dispatch for an unbound or revision ACK', async ack => {
      upstream(ack)
      const result = await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(JSON.stringify(reuseBody()))
      expect(result.status).toBe(502); expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
  it.each([{ ...reuseResolution(), ack: reuseAck() }, { ...reuseResolution(true), ack: revisionAck() },
    { ...reuseResolution(true), request_id: 'wrong' }])('rejects invalid read-only resolution', async resolution => {
    upstream(resolution)
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse-receipts/resolve').set('Content-Type', 'application/json').send(JSON.stringify(reuseBody()))
    expect(result.status).toBe(502); expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
  })
  it.each(['target', 'scope', 'source', 'request', 'marker'] as const)('withholds wrong provenance %s', async fault => {
    const value = reuseProvenance()
    if (fault === 'target') value.basis.metadata.target_plan_id = 'wrong'
    if (fault === 'scope') value.basis.metadata.org_id = 'wrong'
    if (fault === 'source') value.basis.source.content_hash = 'e'.repeat(64)
    if (fault === 'request') value.basis.metadata.request_id = 'wrong'
    if (fault === 'marker') value.basis.target.sources.reuse.reuse_id = 'wrong'
    upstream(value)
    expect((await auth('get', '/api/welding/plans/target-p/versions/target-v/reuse-provenance')).status).toBe(502)
  })
  it('preserves authoritative same-key body conflict without retry', async () => {
    upstream({ detail: 'original body differs' }, 409)
    expect((await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(JSON.stringify(reuseBody()))).status).toBe(409)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('keeps dispatched transport failure UNKNOWN without retry', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockRejectedValueOnce(new Error('lost reply'))
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(JSON.stringify(reuseBody()))
    expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN'); expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it.each(['reuse', 'reuse-receipts/resolve', 'reuse-provenance'])('keeps the read gate OFF before identity for %s', async name => {
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    const result = name === 'reuse-provenance' ? await auth('get', `/api/welding/plans/target-p/versions/target-v/${name}`) :
      await auth('post', `/api/welding/plans/p/versions/v/${name}`).set('Content-Type', 'application/json').send(JSON.stringify(reuseBody()))
    expect(result.status).toBe(503); expect(mocks.verifyToken).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled()
  })
  it('withholds a wrong personal owner before reuse dispatch', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json({ ...authority, owner: { ...authority.owner, auth_user_id: 99 } }))
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(JSON.stringify(reuseBody()))
    expect(result.status).toBe(502); expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED'); expect(fetchMock).toHaveBeenCalledTimes(3)
  })
  it('keeps a dispatched successful reuse UNKNOWN when the native owner is revoked before delivery', async () => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockImplementationOnce(async () => {
        mocks.query.mockResolvedValue({ rows: [] }); return json(reuseAck())
      })
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(JSON.stringify(reuseBody()))
    expect(result.status).toBe(502); expect(result.body.error.code).toBe('WELDING_RESULT_UNKNOWN'); expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('preserves Y strict domain rejection of an incomplete direct reuse body', async () => {
    upstream({ detail: 'missing fields' }, 422)
    const original = '{"request_id":"reuse-request"}'
    const result = await auth('post', '/api/welding/plans/p/versions/v/reuse').set('Content-Type', 'application/json').send(original)
    expect(result.status).toBe(422); expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(original)
  })

  it('reads initial adoption provenance through a later Y-authorized target revision', async () => {
    upstream(reuseProvenance())
    const result = await auth('get', '/api/welding/plans/target-p/versions/later-target-v/reuse-provenance')
    expect(result.status).toBe(200)
    expect(result.body.basis.metadata.target_version_id).toBe('target-v')
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/target-p/versions/later-target-v/reuse-provenance')
  })

  it.each(['target%plan', 'target/plan', 'target\\plan', '.', '..'])(
    'rejects an unroutable reuse target %s before identity or write dispatch', async targetPlanId => {
      upstream({ ...reuseAck(), target_plan_id: targetPlanId })
      const result = await auth('post', '/api/welding/plans/p/versions/v/reuse')
        .set('Content-Type', 'application/json').send(JSON.stringify({ ...reuseBody(), target_plan_id: targetPlanId }))
      expect(result.status).toBe(400)
      expect(result.body.error.code).toBe('WELDING_INVALID_REQUEST')
      expect(mocks.verifyToken).not.toHaveBeenCalled()
      expect(mocks.query).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })

  it.each(['{"target_plan_id":"target-p"}', '{"target_plan_id":7}'])(
    'leaves target-only domain body %s to Yuantus validation', async original => {
      upstream({ detail: 'domain fields invalid' }, 422)
      const result = await auth('post', '/api/welding/plans/p/versions/v/reuse')
        .set('Content-Type', 'application/json').send(original)
      expect(result.status).toBe(422)
      expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(original)
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

})

// Real Express BFF with synthetic Y responses; Y business authorization is tested in Yuantus.
describe('reuse target selection finite reads', () => {
  const candidate = { item_id: 'part', version_id: 'part-v1', version_label: '1.A', name: 'Selection sentinel', number: 'P-1' }
  const bom = { baseline_id: 'baseline', fingerprint: 'a'.repeat(64), name: 'Selection sentinel', number: 'B-1' }
  const selections = [
    { name: 'reuse-product-candidates', query: 'query=steel&limit=2', result: { items: [candidate] } },
    { name: 'reuse-product-context', query: 'product_id=part&product_version_id=part-v1', result: { schema: 'yuantus.welding_plan_entry/1', product: candidate } },
    { name: 'reuse-bom-candidates', query: 'product_id=part&product_version_id=part-v1', result: { items: [bom] } },
  ]
  const path = (name: string, query: string) => `/api/welding/plans/${name}${query ? `?${query}` : ''}`

  it.each(selections)('selects $name with read ON/write OFF using only the configured GET and private headers', async selection => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    upstream(selection.result)
    const result = await auth('get', path(selection.name, selection.query))
      .set('x-tenant-id', 'foreign').set('x-org-id', 'foreign').set('x-actor-id', '999')
      .set('x-target-url', 'https://evil.invalid').set('Cookie', 'private-browser-cookie')
    expect(result.status).toBe(200)
    expect(result.body).toEqual(selection.result)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[0][0]).toBe('https://welding.invalid/api/v1/auth/sso/challenge')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ provider: 'ms' })
    expect(fetchMock.mock.calls[3][0]).toBe(`https://welding.invalid/api/v1/plugins/welding/plans/${selection.name}?${selection.query}`)
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'GET', redirect: 'error',
      headers: { Accept: 'application/json', Authorization: 'Bearer secret-bearer' } })
    expect(Object.keys(fetchMock.mock.calls[3][1].headers).sort()).toEqual(['Accept', 'Authorization'])
    expect(fetchMock.mock.calls[3][1].body).toBeUndefined()
    expect(result.text).not.toContain('secret-bearer')
  })

  it.each(['part/a', '%', '?', '+', '&', '焊😀'.repeat(32)])('round-trips source ID %s only as a query value', async id => {
    const pair = new URLSearchParams({ product_id: id, product_version_id: id }).toString()
    for (const name of ['reuse-product-context', 'reuse-bom-candidates']) {
      const resultBody = name.endsWith('context') ? { schema: 'yuantus.welding_plan_entry/1',
        product: { ...candidate, item_id: id, version_id: id } } : { items: [{ ...bom, baseline_id: id }] }
      upstream(resultBody)
      const result = await auth('get', path(name, pair))
      expect(result.status).toBe(200)
      expect(result.body).toEqual(resultBody)
      const url = new URL(fetchMock.mock.calls.at(-1)![0])
      expect(url.pathname).toBe(`/api/v1/plugins/welding/plans/${name}`)
      expect([...url.searchParams]).toEqual([['product_id', id], ['product_version_id', id]])
    }
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it('accepts the bounded Unicode metadata and 20 distinct fixed versions, including historical versions', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ ...candidate, version_id: `historical-${i}`,
      version_label: i ? '😀'.repeat(64) : null, name: '😀'.repeat(256), number: '😀'.repeat(128) }))
    upstream({ items })
    expect((await auth('get', path('reuse-product-candidates', 'query=%25_'))).body).toEqual({ items })
    const boms = Array.from({ length: 20 }, (_, i) => ({ ...bom, baseline_id: `baseline-${i}`, name: '😀'.repeat(256), number: '😀'.repeat(256) }))
    upstream({ items: boms })
    expect((await auth('get', path('reuse-bom-candidates', selections[2].query))).body).toEqual({ items: boms })
  })

  it.each(selections)('gates $name with exact read flag before identity or SSO', async selection => {
    for (const flag of [undefined, '', '1', 'TRUE', ' true ', 'false']) {
      vi.stubEnv('WELDING_READ_ENABLED', flag)
      const result = await auth('get', path(selection.name, selection.query))
      expect(result.status).toBe(503)
      expect(result.headers['cache-control']).toBe('no-store')
    }
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(selections)('rejects $name native owner mismatch before SSO', async selection => {
    mocks.verifyToken.mockResolvedValue({ id: 'u1', tenantId: 'foreign' })
    expect((await auth('get', path(selection.name, selection.query))).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(selections)('requires configured provider and an active native session for $name', async selection => {
    vi.stubEnv('WELDING_YUANTUS_PROVIDER', '')
    expect((await auth('get', path(selection.name, selection.query))).status).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.stubEnv('WELDING_YUANTUS_PROVIDER', 'ms')
    mocks.query.mockResolvedValue({ rows: [] })
    expect((await auth('get', path(selection.name, selection.query))).status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(selections)('rejects finite query violations for $name before identity', async selection => {
    const queries = ['', `${selection.query}&purpose=reuse`, `${selection.query}&update=false`,
      `${selection.query}&tenant_id=foreign`, `${selection.query}&url=https://evil.invalid`,
      `${selection.query}&${selection.query.split('&')[0]}`, `${selection.query}&`, 'query=%ZZ']
    if (selection.name.endsWith('product-candidates')) queries.push('query=', 'query=%20x', 'query=x%0A',
      `query=${'x'.repeat(101)}`, 'query=x&limit=0', 'query=x&limit=21', 'query=x&limit=01', 'query=x&limit=1.5')
    else queries.push('product_id=part', 'product_version_id=v', 'product_id=&product_version_id=v',
      `product_id=${'x'.repeat(65)}&product_version_id=v`, 'product_id=%C2%85x&product_version_id=v',
      'product_id=x%00&product_version_id=v', 'product_id=x%0D&product_version_id=v',
      'product_id=%ED%A0%80&product_version_id=v', `${selection.query}&limit=1`)
    for (const query of queries) expect((await auth('get', path(selection.name, query))).status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(selections)('rejects non-GET, nonempty body and arbitrary suffix for $name before identity', async selection => {
    for (const method of ['post', 'put', 'delete'] as const)
      expect((await auth(method, path(selection.name, selection.query))).status).toBe(400)
    expect((await auth('get', path(selection.name, selection.query)).set('Content-Type', 'application/json').send('{}')).status).toBe(400)
    expect((await auth('get', path(`${selection.name}/extra`, selection.query))).status).toBe(400)
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id'])('withholds a mismatched Y %s before selection dispatch', async key => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json({ ...authority, owner: { ...authority.owner, [key]: key.endsWith('user_id') ? 0 : 'foreign' } }))
    const result = await auth('get', path(selections[0].name, selections[0].query))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each(selections)('withholds $name when the native owner is revoked before delivery', async selection => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockImplementationOnce(async () => {
        mocks.query.mockResolvedValue({ rows: [] }); return json(selection.result)
      })
    const result = await auth('get', path(selection.name, selection.query))
    expect(result.status).toBe(401)
    expect(result.text).not.toContain('Selection sentinel')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each(selections)('preserves authoritative denial for $name without content or retries', async selection => {
    for (const status of [401, 403, 404, 422, 503]) {
      upstream({ detail: 'Selection sentinel' }, status)
      const result = await auth('get', path(selection.name, selection.query))
      expect(result.status).toBe(status === 401 ? 502 : status)
      expect(result.text).not.toContain('Selection sentinel')
      expect(result.headers['cache-control']).toBe('no-store')
    }
    expect(fetchMock).toHaveBeenCalledTimes(20)
  })

  it.each(selections)('never retries $name after a dispatched read transport failure', async selection => {
    fetchMock.mockResolvedValueOnce(json({ state: 'state', nonce: 'nonce', expires_in: 300 }))
      .mockResolvedValueOnce(json({ access_token: 'secret-bearer', token_type: 'bearer', expires_in: 3600, tenant_id: 'yt', user_id: 71 }))
      .mockResolvedValueOnce(json(authority)).mockRejectedValueOnce(new Error('Selection sentinel'))
    const result = await auth('get', path(selection.name, selection.query))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    expect(result.text).not.toContain('Selection sentinel')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['missing name', { item_id: 'part', version_id: 'part-v1', version_label: null, number: 'P' }],
    ['extra field', { ...candidate, private_path: 'Selection sentinel' }],
    ['wrong type', { ...candidate, name: 7 }], ['overlong ID', { ...candidate, item_id: 'x'.repeat(65) }],
    ['overlong label', { ...candidate, version_label: 'x'.repeat(65) }],
    ['overlong name', { ...candidate, name: 'x'.repeat(257) }],
    ['overlong number', { ...candidate, number: 'x'.repeat(129) }],
    ['NUL text', { ...candidate, name: 'x\0y' }], ['invalid Unicode', { ...candidate, name: '\ud800' }],
  ])('withholds %s product metadata from both new product reads', async (_label, invalid) => {
    for (const selection of selections.slice(0, 2)) {
      upstream(selection.name.endsWith('context') ? { schema: 'yuantus.welding_plan_entry/1', product: invalid } : { items: [invalid] })
      const result = await auth('get', path(selection.name, selection.query))
      expect(result.status).toBe(502)
      expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
      expect(result.text).not.toContain('Selection sentinel')
    }
    expect(fetchMock).toHaveBeenCalledTimes(8)
  })

  it.each(['item_id', 'version_id'])('rejects reuse context for the wrong fixed %s', async key => {
    upstream({ schema: 'yuantus.welding_plan_entry/1', product: { ...candidate, [key]: 'other' } })
    const result = await auth('get', path(selections[1].name, selections[1].query))
    expect(result.status).toBe(502)
    expect(result.text).not.toContain('Selection sentinel')
  })

  it.each([
    ['duplicate product pair', 0, { items: [candidate, candidate] }],
    ['product count above requested limit', 0, { items: [candidate, { ...candidate, version_id: 'v2' }, { ...candidate, version_id: 'v3' }] }],
    ['product extra envelope', 0, { items: [candidate], total: 1 }],
    ['context extra envelope', 1, { schema: 'yuantus.welding_plan_entry/1', product: candidate, allowed_actions: ['reuse'] }],
    ['context wrong schema', 1, { schema: 'wrong', product: candidate }],
    ['duplicate BOM ID', 2, { items: [bom, { ...bom, fingerprint: 'b'.repeat(64) }] }],
    ['BOM count above 20', 2, { items: Array.from({ length: 21 }, (_, i) => ({ ...bom, baseline_id: `b-${i}` })) }],
    ['BOM tree', 2, { items: [{ ...bom, nodes: [{ private_path: 'Selection sentinel' }] }] }],
    ['BOM missing field', 2, { items: [{ baseline_id: 'b', fingerprint: bom.fingerprint, name: bom.name }] }],
    ['BOM invalid hash', 2, { items: [{ ...bom, fingerprint: 'A'.repeat(64) }] }],
    ['BOM overlong ID', 2, { items: [{ ...bom, baseline_id: 'x'.repeat(65) }] }],
    ['BOM overlong name', 2, { items: [{ ...bom, name: 'x'.repeat(257) }] }],
    ['BOM overlong number', 2, { items: [{ ...bom, number: 'x'.repeat(257) }] }],
    ['BOM malformed Unicode', 2, { items: [{ ...bom, name: '\ud800' }] }],
  ] as const)('withholds %s without exposing metadata', async (_label, index, body) => {
    upstream(body)
    const selection = selections[index]
    const result = await auth('get', path(selection.name, selection.query))
    expect(result.status).toBe(502)
    expect(result.body.error.code).toBe('WELDING_UPSTREAM_REJECTED')
    expect(result.text).not.toContain('Selection sentinel')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each(selections)('rejects malformed and oversized transport for $name without content', async selection => {
    for (const response of [new Response('{"Selection sentinel":', { headers: { 'content-type': 'application/json' } }),
      new Response('Selection sentinel', { status: 302, headers: { Location: 'https://evil.invalid' } }),
      new Response(JSON.stringify(selection.result), { headers: { 'content-type': 'text/html' } }),
      new Response(JSON.stringify(selection.result), { headers: { 'content-type': 'application/json', 'content-length': String(11 * 1024 * 1024 + 1) } })]) {
      binaryUpstream(response)
      const result = await auth('get', path(selection.name, selection.query))
      expect(result.status).toBe(502)
      expect(result.text).not.toContain('Selection sentinel')
    }
    expect(fetchMock).toHaveBeenCalledTimes(16)
  })

  it('retains ordinary finite query validation and the existing ordinary candidate response contract', async () => {
    upstream({ items: [{ legacy_metadata: 'ordinary' }] })
    expect((await auth('get', '/api/welding/plans/product-candidates?query=steel')).status).toBe(200)
    for (const name of ['product-context', 'bom-candidates']) {
      expect((await auth('get', path(name, 'product_id=part%2Fa&product_version_id=v'))).status).toBe(400)
      expect((await auth('get', path(name, 'product_id=part&product_version_id=v&update=false'))).status).toBe(400)
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

// Boundary positives keep the new read projection from inheriting the legacy nonempty text rule.
describe('reuse selection empty and default-limit boundaries', () => {
  it.each(['reuse-product-candidates', 'reuse-bom-candidates'])('accepts an empty authorized %s result', async name => {
    upstream({ items: [] })
    const query = name.endsWith('product-candidates') ? 'query=x' : 'product_id=part&product_version_id=v'
    const result = await auth('get', `/api/welding/plans/${name}?${query}`)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({ items: [] })
  })

  it('accepts nullable label and empty projected text without introducing a new eligibility rule', async () => {
    const product = { item_id: 'part', version_id: 'v', version_label: null, name: 'Part', number: '' }
    upstream({ schema: 'yuantus.welding_plan_entry/1', product })
    const result = await auth('get', '/api/welding/plans/reuse-product-context?product_id=part&product_version_id=v')
    expect(result.status).toBe(200)
    expect(result.body.product).toEqual(product)
    upstream({ items: [{ baseline_id: 'b', fingerprint: 'a'.repeat(64), name: '', number: '' }] })
    expect((await auth('get', '/api/welding/plans/reuse-bom-candidates?product_id=part&product_version_id=v')).status).toBe(200)
  })

  it('rejects 21 otherwise valid product results when limit is omitted', async () => {
    upstream({ items: Array.from({ length: 21 }, (_, i) => ({ item_id: 'part', version_id: `v-${i}`,
      version_label: null, name: 'Selection sentinel', number: '' })) })
    const result = await auth('get', '/api/welding/plans/reuse-product-candidates?query=x')
    expect(result.status).toBe(502)
    expect(result.text).not.toContain('Selection sentinel')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})

describe('reuse search query Python whitespace boundaries', () => {
  it.each([
    ['U+0085', '\u0085'], ['U+001C', '\u001c'], ['U+001D', '\u001d'], ['U+001E', '\u001e'], ['U+001F', '\u001f'],
  ].flatMap(([label, char]) => [
    { label, side: 'prefix', value: `${char}steel` }, { label, side: 'suffix', value: `steel${char}` },
  ]))('rejects $label at the $side before identity or SSO', async ({ value }) => {
    upstream({ items: [] })
    const query = new URLSearchParams({ query: value }).toString()
    const result = await auth('get', `/api/welding/plans/reuse-product-candidates?${query}`)
    expect(result.status).toBe(400)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(mocks.verifyToken).not.toHaveBeenCalled()
    expect(mocks.query).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['prefix', 'suffix'])('accepts FEFF at the %s of a 100-codepoint reuse query', async side => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const value = side === 'prefix' ? `\ufeff${'x'.repeat(99)}` : `${'x'.repeat(99)}\ufeff`
    const query = new URLSearchParams({ query: value }).toString()
    const selected = { items: [{ item_id: 'part', version_id: 'v', version_label: null, name: 'Part', number: '' }] }
    upstream(selected)
    const result = await auth('get', `/api/welding/plans/reuse-product-candidates?${query}`)
    expect(result.status).toBe(200)
    expect(result.body).toEqual(selected)
    expect(result.headers['cache-control']).toBe('no-store')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[3][0]).toBe(`https://welding.invalid/api/v1/plugins/welding/plans/reuse-product-candidates?${query}`)
    expect(fetchMock.mock.calls[3][1].method).toBe('GET')
    expect(fetchMock.mock.calls[3][1].body).toBeUndefined()
  })
})


describe('F18 fixed assembly relay', () => {
  const selectedSide = (path: string[]) => ({ role: '人工侧', path, item_id: 'part', version_id: 'part-v1', witness: { witness_id: `manual-${path[0]}`, source: 'manual' } })
  const requestBody = () => ({ expected_draft_seq: 2, save_id: 'same-assembly', payload: { schema_version: 1, welds: [{ weld_id: 'w1', display_no: '1', assembly: { a: selectedSide(['a']), b: selectedSide(['b']) } }] }, assembly_change: { expected_content_hash: 'a'.repeat(64), from_fingerprint: 'b'.repeat(64), to_fingerprint: 'c'.repeat(64) } })
  const result = () => ({ schema: 'yuantus.welding_assembly_preview/1', plan_id: 'p', item_version_id: 'v', draft_seq: 2, content_hash: 'a'.repeat(64), from_fingerprint: 'b'.repeat(64), to_fingerprint: 'c'.repeat(64), affected_welds: [{ weld_id: 'w1', reason_codes: ['assembly_adopted', 'missing_occurrence', 'missing_witness', 'occurrence_identity_changed'], before: null, after: assemblyViewResult(), state: 'unknown' }] })
  const path = (name: string) => `/api/welding/plans/p/versions/v/${name}`
  it('allows read-only fixed POST preview when writes are OFF and forwards exact bytes', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); const raw = JSON.stringify(requestBody()); upstream(result())
    const value = await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(raw)
    expect(value.status).toBe(200); expect(value.headers['cache-control']).toBe('no-store'); expect(value.body).toEqual(result())
    expect(fetchMock.mock.calls[3][0]).toBe('https://welding.invalid/api/v1/plugins/welding/plans/p/versions/v/assembly-preview')
    expect(Buffer.from(fetchMock.mock.calls[3][1].body).toString()).toBe(raw)
    expect((await auth('post', path('assembly-apply')).set('Content-Type', 'application/json').send(raw)).status).toBe(503); expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('accepts apply 200 as a save while keeping ordinary create 201', async () => {
    upstream({ ...record('p', 'v', 3), state: 'Draft' })
    expect((await auth('post', path('assembly-apply')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))).status).toBe(200)
    fetchMock.mockReset(); upstream(record('created', 'new-v'), 201)
    expect((await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send(JSON.stringify({ plan_id: 'created' }))).status).toBe(201)
  })
  it.each(['wrong-201', 'seq', 'plan', 'version', 'state'])('marks invalid %s apply ACK unknown', async kind => {
    const value = { ...record('p', 'v', 3), state: 'Draft' }
    if (kind === 'seq') value.draft_seq = 1
    else if (kind === 'plan') value.plan_id = 'other'
    else if (kind === 'version') value.item_version_id = 'other'
    else if (kind === 'state') value.state = 'Released'
    upstream(value, kind === 'wrong-201' ? 201 : 200)
    const response = await auth('post', path('assembly-apply')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))
    expect(response.status).toBe(502); expect(response.body.error.code).toBe('WELDING_RESULT_UNKNOWN')
  })
  const assemblyViewResult = () => {
    return { sides: { a: { selection: selectedSide(['a']), facts: null, provenance: null, unknown: ['missing_occurrence', 'missing_witness'] },
      b: { selection: selectedSide(['b']), facts: { path: ['b'], item_id: 'changed-part', version_id: 'changed-v', quantity: '1e1000', uom: '', find_number: '' },
        provenance: { auth_actor_id: 71, rbac_actor_id: 102, draft_seq: 1, item_version_id: 'v' }, unknown: ['occurrence_identity_changed', 'missing_witness'] } },
      unknown: ['missing_occurrence', 'missing_witness', 'occurrence_identity_changed'] }
  }
  it('retains explicit unknown, nullable facts/unsaved provenance and mismatched occurrence facts', async () => {
    const value = result(); Object.assign(value.affected_welds[0], { after: assemblyViewResult() }); upstream(value)
    const response = await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))
    expect(response.status).toBe(200); expect(response.body).toEqual(value)
  })
  it.each([{ unit: ['mm'] }, { unit: ['in'] }, { unit: { value: 'mm' } }, { unit: 1 }])('rejects nonstring thickness unit $unit in a historical before view', async ({ unit }) => {
    const value = result(), before = assemblyViewResult(), body = requestBody()
    Reflect.deleteProperty(body.payload.welds[0], 'assembly')
    Object.assign(before.sides.a.selection.witness, { thickness: { value: 1, unit } })
    Object.assign(value.affected_welds[0], { before, after: null, reason_codes: ['assembly_cancelled'], state: 'known' }); upstream(value)
    expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(body))).status).toBe(502)
  })
  it.each(['known', 'unknown'])('rejects array-valued %s state with a null after view', async state => {
    const value = result(), body = requestBody(); Reflect.deleteProperty(body.payload.welds[0], 'assembly')
    Object.assign(value.affected_welds[0], { before: assemblyViewResult(), after: null, reason_codes: ['assembly_cancelled'], state: [state] }); upstream(value)
    expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(body))).status).toBe(502)
  })
  it('rejects null after when the original request retains the assembly', async () => {
    const value = result(); Object.assign(value.affected_welds[0], { after: null, state: 'known' }); upstream(value)
    expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))).status).toBe(502)
  })
  it('rejects a nonnull after view when the original request has no assembly', async () => {
    const body = requestBody(); Reflect.deleteProperty(body.payload.welds[0], 'assembly'); upstream(result())
    expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(body))).status).toBe(502)
  })
  it.each(['cancelled', 'removed'])('allows null after for a lawfully %s assembly', async kind => {
    const value = result(), body = requestBody()
    if (kind === 'removed') body.payload.welds = []
    else Reflect.deleteProperty(body.payload.welds[0], 'assembly')
    Object.assign(value.affected_welds[0], { before: assemblyViewResult(), after: null, reason_codes: [kind === 'removed' ? 'weld_removed' : 'assembly_cancelled'], state: 'known' }); upstream(value)
    const response = await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(body))
    expect(response.status).toBe(200); expect(response.body).toEqual(value)
  })
  it('retains nonnull after with nullable facts when both selected occurrences are missing', async () => {
    const value = result(), after = assemblyViewResult()
    Object.assign(after.sides.b, { facts: null, unknown: ['missing_occurrence', 'missing_witness'] })
    after.unknown = ['missing_occurrence', 'missing_witness']; Object.assign(value.affected_welds[0], { after, reason_codes: ['assembly_adopted', 'missing_occurrence', 'missing_witness'] }); upstream(value)
    const response = await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))
    expect(response.status).toBe(200); expect(response.body).toEqual(value)
  })
  it('allows the actual stage missing_mapping row with null before and after', async () => {
    const body = requestBody(); Reflect.deleteProperty(body.payload.welds[0], 'assembly')
    const value = result(); Object.assign(value.affected_welds[0], { reason_codes: ['missing_mapping'], before: null, after: null, state: 'unknown' }); upstream(value)
    const response = await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(body))
    expect(response.status).toBe(200); expect(response.body).toEqual(value)
  })
  it.each(['role', 'path', 'item', 'version', 'witness-added-field', 'witness-omitted', 'material-omitted', 'weld', 'assembly-missing'])('rejects unrequested after selection %s', async kind => {
    const value = result(), after = assemblyViewResult(), body = requestBody(), selected = after.sides.a.selection
    if (kind === 'role') selected.role = '另一次预览的 A 侧'
    else if (kind === 'path') selected.path = ['different-position']
    else if (kind === 'item') selected.item_id = 'different-part'
    else if (kind === 'version') selected.version_id = 'different-version'
    else if (kind === 'witness-added-field') Object.assign(selected.witness, { material: '未请求的声明' })
    else if (kind === 'witness-omitted') Reflect.deleteProperty(selected, 'witness')
    else if (kind === 'material-omitted') Object.assign(body.payload.welds[0].assembly.a.witness, { material: '人工声明' })
    else if (kind === 'weld') value.affected_welds[0].weld_id = 'not-requested'
    else Reflect.deleteProperty(body.payload.welds[0], 'assembly')
    Object.assign(value.affected_welds[0], { after }); upstream(value)
    expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(body))).status).toBe(502)
  })
  it('allows a lawful historical before selection that differs from the pending body', async () => {
    const value = result(), before = assemblyViewResult(), after = assemblyViewResult()
    before.sides.a.selection = { ...selectedSide(['old-position']), role: '旧角色', item_id: 'old-part', version_id: 'old-v' }
    Object.assign(before.sides.a.selection.witness, { material: '旧声明' })
    Object.assign(value.affected_welds[0], { before, after }); upstream(value)
    const response = await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))
    expect(response.status).toBe(200); expect(response.body).toEqual(value)
  })
  it.each(['witness-null', 'thickness-null', 'facts-path', 'unknown', 'known'])('rejects malformed %s assembly view', async kind => {
    const value = result(), after = assemblyViewResult()
    if (kind === 'witness-null') Object.assign(after.sides.a.selection, { witness: null })
    else if (kind === 'thickness-null') Object.assign(after.sides.a.selection.witness, { thickness: null })
    else if (kind === 'facts-path') after.sides.b.facts.path = ['other']
    else if (kind === 'unknown') after.unknown = []
    Object.assign(value.affected_welds[0], { after, ...(kind === 'known' ? { state: 'known' } : {}) }); upstream(value)
    expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))).status).toBe(502)
  })
  it('preserves ordinary upstream denial rather than inventing apply permission from preview', async () => {
    upstream(result()); expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))).status).toBe(200)
    fetchMock.mockReset(); upstream({ detail: 'denied' }, 403)
    expect((await auth('post', path('assembly-apply')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))).status).toBe(403)
  })
  it.each(['plan', 'version', 'seq', 'hash', 'from', 'to', 'duplicate', 'state'])('rejects mismatched %s read-only preview', async kind => {
    const value = result()
    if (kind === 'plan') value.plan_id = 'other'
    else if (kind === 'version') value.item_version_id = 'other'
    else if (kind === 'seq') value.draft_seq++
    else if (kind === 'hash') value.content_hash = 'd'.repeat(64)
    else if (kind === 'from') value.from_fingerprint = 'd'.repeat(64)
    else if (kind === 'to') value.to_fingerprint = 'd'.repeat(64)
    else if (kind === 'duplicate') value.affected_welds.push(value.affected_welds[0])
    else value.affected_welds[0].state = 'confirmed'
    upstream(value); expect((await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(requestBody()))).status).toBe(502)
  })
  it.each([
    ['get', 'assembly-preview'], ['put', 'assembly-apply'], ['post', 'assembly-preview?x=1'], ['post', 'assembly-apply/'],
    ['post', 'assembly-apply/extra'], ['post', '../assembly-apply'],
  ] as const)('rejects %s %s before identity', async (method, name) => {
    const value = await auth(method, path(name)); expect([400, 404]).toContain(value.status); expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.verifyToken).not.toHaveBeenCalled()
  })
  it('rejects assembly Content-Length over 5 MiB before reading a body, and absent/null/mixed command before SSO', async () => {
    const address = relay.address(); if (!address || typeof address === 'string') throw new Error('Relay is not listening')
    // The preflight replies from headers; do not race that early close by uploading 5 MiB.
    const oversized = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: address.port, method: 'POST', path: path('assembly-preview'),
        headers: { Authorization: 'Bearer ms-session', 'Content-Type': 'application/json', 'Content-Length': 5 * 1024 * 1024 + 1 } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode)); res.once('error', reject)
      })
      req.once('error', reject); req.setTimeout(1000, () => req.destroy(new Error('Header preflight timed out'))); req.end()
    })
    expect(oversized).toBe(413); expect(fetchMock).not.toHaveBeenCalled()
    for (const body of [{ ...requestBody(), assembly_change: null }, { expected_draft_seq: 2, save_id: 'same', payload: {} }, { ...requestBody(), review_resolution: {} }]) {
      const value = await auth('post', path('assembly-preview')).set('Content-Type', 'application/json').send(JSON.stringify(body)); expect(value.status).toBe(400); expect(fetchMock).not.toHaveBeenCalled()
    }
  })
  it('rejects wrong ordinary POST create 200', async () => {
    upstream(record('created', 'new-v'), 200)
    expect((await auth('post', '/api/welding/plans').set('Content-Type', 'application/json').send(JSON.stringify({ plan_id: 'created' }))).status).toBe(502)
  })
  const projection = () => ({ baseline_id: 'bom', fingerprint: 'a'.repeat(64), name: '', number: '', captured_depth: -1,
    root: { path: [], item_id: 'part', version_id: 'part-v1', name: '', number: '', version_label: '' },
    occurrences: ['a', 'b'].map(rel => ({ path: [rel], item_id: 'same-part', version_id: 'same-v', name: '', number: '', version_label: '', quantity: '1e1000', uom: '', find_number: '' })) })
  function boundedProjection(bytes = 1024 * 1024, index = 0) {
    const value = projection(); value.baseline_id = `bom-${String(index).padStart(2, '0')}`
    value.occurrences = Array.from({ length: 999 }, (_, i) => ({ ...value.occurrences[0], path: [`rel-${i}`], name: '', number: '', uom: '', find_number: '' }))
    let remaining = bytes - Buffer.byteLength(JSON.stringify(value))
    for (const row of value.occurrences) for (const key of ['name', 'number', 'uom', 'find_number'] as const) {
      const amount = Math.min(256, remaining); row[key] = 'x'.repeat(amount); remaining -= amount
    }
    if (remaining !== 0) throw new Error('Boundary fixture exceeds its lawful metadata capacity')
    return value
  }
  it('accepts 20 exact 1 MiB UTF8 projections including container metadata', async () => {
    const items = Array.from({ length: 20 }, (_, i) => boundedProjection(1024 * 1024, i)), raw = JSON.stringify({ items })
    expect(Buffer.byteLength(JSON.stringify(items[0]))).toBe(1024 * 1024); expect(Buffer.byteLength(raw)).toBe(20 * 1024 * 1024 + 31)
    upstream({ items }); const value = await auth('get', '/api/welding/plans/bom-candidates?product_id=part&product_version_id=part-v1')
    expect(value.status).toBe(200); expect(value.body.items).toHaveLength(20)
  })
  it('rejects 21 candidates, duplicate baselines and a single projection above 1 MiB', async () => {
    for (const items of [Array.from({ length: 21 }, (_, i) => ({ ...projection(), baseline_id: `bom-${i}` })), [projection(), projection()], [boundedProjection(1024 * 1024 + 1)]]) {
      fetchMock.mockReset(); upstream({ items }); expect((await auth('get', '/api/welding/plans/bom-candidates?product_id=part&product_version_id=part-v1')).status).toBe(502)
    }
  })
  it('rejects declared and streamed over-21-MiB transport while the parsed 20 choices are lawful', async () => {
    const items = Array.from({ length: 20 }, (_, i) => boundedProjection(1024 * 1024, i)), raw = JSON.stringify({ items }), limit = 21 * 1024 * 1024
    binaryUpstream(new Response(raw, { headers: { 'content-type': 'application/json', 'content-length': String(limit + 1) } }))
    expect((await auth('get', '/api/welding/plans/bom-candidates?product_id=part&product_version_id=part-v1')).status).toBe(502)
    fetchMock.mockReset(); binaryUpstream(new Response(raw + ' '.repeat(limit + 1 - Buffer.byteLength(raw)), { headers: { 'content-type': 'application/json' } }))
    expect((await auth('get', '/api/welding/plans/bom-candidates?product_id=part&product_version_id=part-v1')).status).toBe(502)
  })
  it('retains the full authorized BOM projection with duplicate item positions', async () => {
    upstream({ items: [projection()] }); const value = await auth('get', '/api/welding/plans/bom-candidates?product_id=part&product_version_id=part-v1')
    expect(value.status).toBe(200); expect(value.body).toEqual({ items: [projection()] })
  })
  it.each(['root', 'duplicate', 'parent', 'count', 'metadata-only'])('rejects malformed %s full BOM response', async kind => {
    const value = projection()
    if (kind === 'root') value.root.version_id = 'other'
    else if (kind === 'duplicate') value.occurrences[1].path = ['a']
    else if (kind === 'parent') value.occurrences[1].path = ['missing', 'child']
    else if (kind === 'count') value.occurrences = Array.from({ length: 1000 }, (_, i) => ({ ...value.occurrences[0], path: [`rel-${i}`] }))
    upstream({ items: [kind === 'metadata-only' ? { baseline_id: 'bom', fingerprint: 'a'.repeat(64), name: '', number: '' } : value] })
    expect((await auth('get', '/api/welding/plans/bom-candidates?product_id=part&product_version_id=part-v1')).status).toBe(502)
  })
})
