import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
const express = createRequire(resolve('../..', 'package.json'))(resolve('../..', 'packages/core-backend/node_modules/express'))
const fixture = vi.hoisted(() => ({ origin: '', key: '', verifyToken: vi.fn(), readTokenPayload: vi.fn(), resolveSessionTenantId: vi.fn(), query: vi.fn() }))
vi.mock('../../../packages/core-backend/src/auth/AuthService', () => ({ authService: fixture }))
vi.mock('../../../packages/core-backend/src/db/pg', () => ({ query: fixture.query }))
vi.mock('../../../packages/core-backend/src/integrations/welding/provider', async () => ({ ...await vi.importActual<typeof import('../../../packages/core-backend/src/integrations/welding/provider')>('../../../packages/core-backend/src/integrations/welding/provider'), readWeldingProvider: () => ({ metasheetTenantId: 'mt', origin: fixture.origin, provider: 'ms', tenantId: 'tenant', orgId: 'org', issuer: 'https://fixture.invalid', clientId: 'welding', kid: 'proof', privateKeyFile: fixture.key }) }))
import { weldingPreflight, weldingPlanRawBody, weldingRouter } from '../../../packages/core-backend/src/routes/welding'
import { createWeldingPlanClient, type WorkflowOriginal, type WorkflowAction } from '../src/services/welding/planClient'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }, hash = 'a'.repeat(64)
const target = { plan_id: 'plan', item_version_id: 'v1' }, basis = { expected_draft_seq: 1, expected_content_hash: hash }
const originals = (): WorkflowOriginal[] => [
  { ...target, action: 'submit', body: { ...basis, request_id: 'original-submit', review_generation_id: '00000000-0000-4000-8000-000000000009', reviewer_rbac_id: 20 } },
  { ...target, action: 'review', body: { ...basis, request_id: 'original-review', approval_request_id: 'approval', expected_submission_hash: hash, decision: 'approve', opinion: '' } },
  { ...target, action: 'withdraw', body: { ...basis, request_id: 'original-withdraw', approval_request_id: 'approval', expected_submission_hash: hash, reason: '撤回' } },
  { ...target, action: 'reopen', body: { ...basis, request_id: 'original-reopen', approval_request_id: 'approval', expected_submission_hash: hash, reason: '重编' } },
]
const finalBasis = { generation_id: '00000000-0000-4000-8000-000000000010', render_key: hash, ...target, draft_seq: 1, plan_content_hash: hash, generation_content_hash: hash, purpose: 'final' as const, approval_request_id: 'approval', submission_hash: hash, decision_hash: hash, template: { id: 'welding-approval-appendix' as const, version: '1' as const, digest: hash } }
const finalCreate = { ...basis, request_id: 'original-final', approval_request_id: 'approval', expected_submission_hash: hash, expected_decision_hash: hash, template_id: finalBasis.template.id, template_version: finalBasis.template.version, template_digest: hash }
const finalAck = (body: { request_id: string }) => ({ schema: 'yuantus.welding_final_generation_ack/1', request_id: body.request_id, ...finalBasis })
const ack = (action: WorkflowAction, body: any) => ({ schema: 'yuantus.welding_plan_workflow_ack/1', request_id: body.request_id, action: action === 'review' ? body.decision : action, ...target, draft_seq: action === 'reopen' ? 2 : 1, content_hash: hash, state: action === 'release' ? 'Released' : action === 'submit' ? 'InReview' : action === 'review' ? body.decision === 'approve' ? 'Approved' : 'Draft' : 'Draft', approval_request_id: 'approval', publication_id: action === 'release' ? 'publication' : null })
const reuseBody = () => ({ request_id: 'original-reuse', source_publication_id: 'publication', ...basis, selected_weld_ids: ['w1'], target_plan_id: 'independent', name: 'Independent', number: 'R1', product: { item_id: 'other', version_id: 'p2' }, drawing: { item_id: 'drawing', version_id: 'd2', file_id: 'f2', file_role: 'drawing', expected_checksum: hash }, bom: null, reason: ' 原因\n保留 ' })
const reuseAck = (body: ReturnType<typeof reuseBody>) => ({ schema: 'yuantus.welding_plan_reuse_ack/1', action: 'reuse', request_id: body.request_id, reuse_id: 'reuse', source_plan_id: 'plan', source_version_id: 'v1', source_publication_id: body.source_publication_id, source_draft_seq: body.expected_draft_seq, source_content_hash: body.expected_content_hash, target_plan_id: body.target_plan_id, target_version_id: 'target-v1', target_version_label: 'A', target_draft_seq: 1, target_content_hash: 'b'.repeat(64), state: 'Draft', reuse_provenance_sha256: 'c'.repeat(64) })
const reuseProvenance = () => {
  const body = reuseBody()
  return { schema: 'yuantus.welding_reuse_provenance/1', reuse_id: 'reuse', reuse_provenance_sha256: 'c'.repeat(64), basis: { schema: 'yuantus.welding_reuse/1', metadata: { id: 'reuse', tenant_id: 'tenant', org_id: 'org', source_plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', target_plan_id: body.target_plan_id, target_version_id: 'target-v1', request_id: body.request_id, request_digest: hash, reason: body.reason, actor: { auth_user_id: 99, rbac_user_id: 199, display_name: 'Historical actor' }, created_at: '2026-10-09T00:00:00Z' }, request: body, source: { draft_seq: 1, content_hash: hash }, target: { version_label: 'A', content_hash: 'b'.repeat(64), payload: { schema_version: 1, product: body.product, drawing: body.drawing, bom: null, welds: [], process_refs: [] }, sources: { reuse: { schema: 'yuantus.welding_reuse/1', reuse_id: 'reuse' } } }, mappings: [{ source_weld_id: 'w1', target_weld_id: 'new-w1', source_values: {}, copy_values: {}, process_associations: [], resource_associations: [] }] } }
}
let upstream: Server, adapter: Server, direct: Server, mode = 'normal', status = 200, directMode = 'normal'
const requests: any[] = [], nativeRequests: any[] = [], client = createWeldingPlanClient()
const out = resolve(process.env.WELDING_FOUNDATION_OUTPUT_DIR ?? '../../artifacts/welding-f15b/workflow-ui-c1-1', `http-${process.env.WELDING_FOUNDATION_RUN_LABEL ?? 'manual'}`)
async function listen(server: Server) { await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())) }
async function send(original: WorkflowOriginal) {
  if (original.action === 'submit') return client.submitWorkflowPlan('plan', 'v1', original.body)
  if (original.action === 'review') return client.reviewWorkflowPlan('plan', 'v1', original.body)
  if (original.action === 'withdraw') return client.withdrawWorkflowPlan('plan', 'v1', original.body)
  if (original.action === 'final-render') return client.createFinalGeneration('plan', 'v1', original.body)
  if (original.action === 'final-retry') return client.retryFinalGeneration(original.basis, original.body)
  if (original.action === 'release') return client.releaseWorkflowPlan('plan', 'v1', original.body)
  return client.reopenWorkflowPlan('plan', 'v1', original.body)
}
beforeAll(async () => {
  mkdirSync(out, { recursive: true }); fixture.key = resolve(out, 'fixture-key.pem'); writeFileSync(fixture.key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }))
  upstream = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk.toString(); const body = raw ? JSON.parse(raw) : null
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization?.startsWith('Bearer ') ? 'Bearer present' : null, body: req.url?.endsWith('/sso/login') ? { state: body.state, assertion_present: typeof body.id_token === 'string' } : body })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/v1/auth/sso/challenge') return res.end(JSON.stringify({ state: 'state', nonce: 'nonce', expires_in: 300 }))
    if (req.url === '/api/v1/auth/sso/login') return res.end(JSON.stringify({ access_token: 'fixture-Y-token', token_type: 'bearer', expires_in: 3600, tenant_id: 'tenant', user_id: 7 }))
    if (req.url?.endsWith('/generation-authority')) return res.end(JSON.stringify({ schema: 'yuantus.welding_generation_authority/1', owner }))
    if (status !== 200) { res.statusCode = status; return res.end(JSON.stringify({ error: 'controlled' })) }
    let value: any
    if (req.url?.endsWith('/review-state')) value = { schema: 'yuantus.welding_review_state/1', ...target, state: 'Draft', draft_seq: 1, content_hash: hash, is_current: true, approval: null, final_generation: null, publication: null, final_profile: null, allowed_actions: ['submit'], issues: [] }
    else if (req.url?.includes('/review-history?')) { const offset = Number(new URL(req.url, fixture.origin).searchParams.get('offset')); value = { schema: 'yuantus.welding_review_history/1', ...target, total: offset, limit: 50, offset, items: [] } }
    else if (req.url?.endsWith('/validate')) value = { schema: 'yuantus.welding_plan_validation/1', ...target, draft_seq: 1, content_hash: hash, ready: false, issues: ['source-review-or-binding-incomplete'] }
    else if (req.url?.endsWith('/final-renders') || req.url?.endsWith('/retry')) { res.statusCode = 202; value = finalAck(body) }
    else if (req.url?.endsWith('/workflow-receipts/resolve')) value = { schema: 'yuantus.welding_workflow_resolution/1', command: body.command, request_id: body.body.request_id, status: mode === 'unknown' ? 'unknown' : 'committed', ack: mode === 'unknown' ? null : ['final-render', 'final-retry'].includes(body.command) ? finalAck(body.body) : ack(body.command, body.body) }
    else if (req.url?.endsWith('/reuse-provenance')) value = reuseProvenance()
    else if (req.url?.endsWith('/reuse')) value = { ...reuseAck(body), ...(mode === 'wrong-ack' ? { target_draft_seq: 2 } : {}) }
    else if (req.url?.endsWith('/reuse-receipts/resolve')) value = { schema: 'yuantus.welding_reuse_resolution/1', command: 'reuse', request_id: body.request_id, status: mode === 'unknown' ? 'unknown' : 'committed', ack: mode === 'unknown' ? null : reuseAck(body) }
    else value = { ...ack(req.url!.split('/').at(-1) as WorkflowAction, body), ...(mode === 'wrong-ack' ? { approval_request_id: 'wrong' } : {}) }
    res.end(JSON.stringify(value))
  }); fixture.origin = await listen(upstream)
  const app = express(); app.use(weldingPreflight); app.use(weldingPlanRawBody); app.use(express.json())
  app.use((req, res, next) => { nativeRequests.push({ path: req.url, method: req.method, authorization: req.headers.authorization, cache: req.headers['cache-control'], raw: Buffer.isBuffer(req.body) ? req.body.toString() : undefined }); if (req.headers.authorization !== 'Bearer native-http') return res.sendStatus(401); req.authenticatedTenantId = 'mt'; next() })
  app.use(weldingRouter()); adapter = createServer(app); const origin = await listen(adapter)
  direct = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (directMode === 'oversize') { res.setHeader('Content-Length', String(24 * 1024 * 1024 + 1)); return res.end('{}') }
    if (directMode === 'redirect') { res.statusCode = 302; res.setHeader('Location', fixture.origin); return res.end() }
    if (directMode === 'abort') { res.write('{'); return }
    res.end('{}')
  }); await listen(direct)
  writeFileSync(resolve(out, 'inputs.json'), JSON.stringify({ utc: new Date().toISOString(), boundary: 'actual frontend planClient + apiFetch, actual Express weldingRouter/preflight/raw body, actual integration client/session/assertion signing with real loopback HTTP; provider URL fixture bypasses HTTPS production config; native AuthService/session SQL rows and Y SSO/domain business responses controlled; no real Y DB/worker/SSO acceptance', files: ['apps/web/src/services/welding/planClient.ts','apps/web/src/utils/api.ts','packages/core-backend/src/routes/welding.ts','packages/core-backend/src/integrations/welding/client.ts','packages/core-backend/src/integrations/welding/provider.ts','packages/core-backend/src/integrations/welding/session.ts'].map(path => ({ path: resolve('../..', path), sha256: createHash('sha256').update(readFileSync(resolve('../..', path))).digest('hex') })), origin }, null, 2))
  ;(globalThis as any).httpAdapterOrigin = origin
})
beforeEach(() => {
  mode = 'normal'; status = 200; directMode = 'normal'; requests.length = 0; nativeRequests.length = 0
  localStorage.setItem('auth_token', 'native-http'); vi.stubEnv('VITE_API_URL', (globalThis as any).httpAdapterOrigin)
  for (const [key, value] of Object.entries({ WELDING_READ_ENABLED: 'true', WELDING_WRITE_ENABLED: 'true', RBAC_TOKEN_TRUST: '', RBAC_BYPASS: '' })) vi.stubEnv(key, value)
  fixture.verifyToken.mockResolvedValue({ id: 'u1', tenantId: 'mt' }); fixture.readTokenPayload.mockReturnValue({ userId: 'u1', tenantId: 'mt', sid: 'sid1', iat: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 300 }); fixture.resolveSessionTenantId.mockResolvedValue('mt'); fixture.query.mockResolvedValue({ rows: [{ id: 'sid1' }] })
})
afterEach(() => { writeFileSync(resolve(out, `requests-${Date.now()}.json`), JSON.stringify({ mode, status, requests, nativeRequests }, null, 2)); vi.unstubAllEnvs() })
afterAll(async () => { await Promise.all([close(upstream), close(adapter), close(direct)]); writeFileSync(resolve(out, 'closed.json'), JSON.stringify({ utc: new Date().toISOString(), all_closed: !upstream.listening && !adapter.listening && !direct.listening })) })

it('F18b real client and repaired BFF preserve full reuse original bytes and resolve with write OFF', async () => {
  const body = reuseBody(), original = { ...target, action: 'reuse' as const, body }
  expect(await client.reusePlan('plan', 'v1', body)).toEqual(reuseAck(body))
  expect(nativeRequests.at(-1).raw).toBe(JSON.stringify(body)); expect(requests.at(-1).body).toEqual(body)
  vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
  expect(await client.resolveReuseReceipt(original)).toEqual(reuseAck(body))
  expect(nativeRequests.at(-1).raw).toBe(JSON.stringify(body)); expect(requests.at(-1).path).toContain('/reuse-receipts/resolve')
})
it('F18b real GET provenance permits later authorized revision and historical actor with write OFF', async () => {
  vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
  expect(await client.readReuseProvenance('independent', 'later-v3', owner)).toEqual(reuseProvenance())
  expect(requests.at(-1).path).toBe('/api/v1/plugins/welding/plans/independent/versions/later-v3/reuse-provenance')
})
it.each([409, 422])('F18b real reuse preserves authoritative %s without client retry', async code => {
  status = code; await expect(client.reusePlan('plan', 'v1', reuseBody())).rejects.toMatchObject({ status: code })
  expect(requests.filter(req => req.path.endsWith('/reuse'))).toHaveLength(1)
})
it('F18b wrong independent ACK is UNKNOWN and full resolver unknown is null', async () => {
  mode = 'wrong-ack'; await expect(client.reusePlan('plan', 'v1', reuseBody())).rejects.toMatchObject({ code: 'WELDING_RESULT_UNKNOWN' })
  mode = 'unknown'; expect(await client.resolveReuseReceipt({ ...target, action: 'reuse', body: reuseBody() })).toBeNull()
})
it('F18b real BFF accepts the maximum escaped reuse body without truncation', async () => {
  const body = reuseBody(), id = '\u0001'.repeat(64)
  const controls = [1, 2, 3, 4, 5, 6, 7, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]
  body.expected_draft_seq = 2147483647
  Object.assign(body, { request_id: id, source_publication_id: id, target_plan_id: '\u0002'.repeat(64), selected_weld_ids: Array.from({ length: 500 }, (_, i) => '\u0001'.repeat(61) + [Math.floor(i / 441), Math.floor(i / 21) % 21, i % 21].map(n => String.fromCharCode(controls[n])).join('')), name: '\u0001'.repeat(128), number: '\u0001'.repeat(128), reason: '\u0001'.repeat(4000), product: { item_id: id, version_id: id }, drawing: { item_id: id, version_id: id, file_id: id, file_role: 'native_cad', expected_checksum: hash }, bom: { baseline_id: id, expected_fingerprint: hash } })
  // The synthetic domain ACK echoes the source publication; actual BFF validates the full original.
  const transport = createWeldingPlanClient()
  await expect(transport.reusePlan('plan', 'v1', body)).resolves.toMatchObject({ request_id: id })
  expect(nativeRequests.at(-1).raw).toBe(JSON.stringify(body)); expect(requests.at(-1).body).toEqual(body)
  writeFileSync(resolve(out, 'reuse-maximum-body.json'), JSON.stringify(body))
  writeFileSync(resolve(out, 'reuse-maximum-size.json'), JSON.stringify({ body_bytes: Buffer.byteLength(JSON.stringify(body)), body_sha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'), selected: body.selected_weld_ids.length, forwarded_exact: true }, null, 2))
})
describe('named workflow HTTP transport through actual MS adapter', () => {
  it('reads independent authority/state/history and validates a ready=false business result', async () => {
    expect(await client.authority()).toEqual(owner); expect((await client.readReviewState('plan', 'v1', owner)).state).toBe('Draft')
    expect((await client.readReviewHistory('plan', 'v1', owner, 50)).offset).toBe(50); expect(await client.validateWorkflowPlan('plan', 'v1', basis)).toEqual({ ready: false, issues: ['source-review-or-binding-incomplete'] })
    expect(nativeRequests.every(req => req.authorization === 'Bearer native-http')).toBe(true)
    expect(requests.some(req => req.path === '/api/v1/plugins/welding/plans/plan/versions/v1/review-history?limit=50&offset=50' && req.method === 'GET')).toBe(true)
    expect(nativeRequests.find(req => req.path.endsWith('/validate')).raw).toBe(JSON.stringify(basis))
  })
  it('dispatches each exact original to its named route and binds reopened seq+1', async () => {
    for (const original of originals()) { const value = await send(original); expect(value.request_id).toBe(original.body.request_id); expect(value.draft_seq).toBe(original.action === 'reopen' ? 2 : 1); expect(nativeRequests.at(-1).raw).toBe(JSON.stringify(original.body)); expect(requests.at(-1).path).toBe(`/api/v1/plugins/welding/plans/plan/versions/v1/${original.action}`) }
  })
  it('resolves committed or unknown without dispatching a business command with write OFF', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false'); const original = originals()[1]
    expect((await client.resolveWorkflowReceipt(original))?.action).toBe('approve'); mode = 'unknown'; expect(await client.resolveWorkflowReceipt(original)).toBeNull()
    expect(requests.filter(req => req.path.endsWith('/review'))).toHaveLength(0)
    await expect(send(original)).rejects.toMatchObject({ status: 503 }); expect(localStorage.getItem('auth_token')).toBe('native-http')
  })
  it.each([403, 409, 503, 401])('preserves native auth when Y returns known domain %s', async code => {
    status = code; await expect(send(originals()[1])).rejects.toMatchObject({ status: code === 401 ? 502 : code, code: 'WELDING_UPSTREAM_REJECTED' }); expect(localStorage.getItem('auth_token')).toBe('native-http')
  })
  it('rejects an ACK for another original approval', async () => { mode = 'wrong-ack'; await expect(send(originals()[1])).rejects.toThrow() })
  it('bounds declared state size, rejects redirects and aborts a real partial stream', async () => {
    vi.stubEnv('VITE_API_URL', `http://127.0.0.1:${(direct.address() as { port: number }).port}`)
    directMode = 'oversize'; await expect(client.readReviewState('plan', 'v1', owner)).rejects.toThrow()
    directMode = 'redirect'; await expect(client.readReviewState('plan', 'v1', owner)).rejects.toThrow()
    directMode = 'abort'; const controller = new AbortController(), job = client.readReviewState('plan', 'v1', owner, { signal: controller.signal, accepts: () => !controller.signal.aborted }); setTimeout(() => controller.abort(), 40); await expect(job).rejects.toThrow()
  })
})


describe('C2 named final HTTP routes through actual MS adapter', () => {
  it('final create and retry use genuine separate named POST routes and require 202 final ACKs', async () => {
    expect(await client.createFinalGeneration('plan', 'v1', finalCreate)).toEqual(finalAck(finalCreate))
    const retry = { request_id: 'original-final-retry', expected_attempt: 2 }
    expect(await client.retryFinalGeneration(finalBasis, retry)).toEqual(finalAck(retry))
    const domain = requests.filter(req => req.path.endsWith('/final-renders') || req.path.endsWith('/retry'))
    expect(domain.map(req => [req.path, req.method, req.body])).toEqual([
      ['/api/v1/plugins/welding/plans/plan/versions/v1/final-renders', 'POST', finalCreate],
      [`/api/v1/plugins/welding/artifacts/${finalBasis.generation_id}/retry`, 'POST', retry],
    ])
  })
  it('final retry resolution includes original G with write OFF and never redispatches retry', async () => {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const body = { request_id: 'original-retry', expected_attempt: 2 }, original = { ...target, action: 'final-retry' as const, body, basis: finalBasis }
    expect(await client.resolveWorkflowReceipt(original)).toEqual(finalAck(body))
    expect(requests.find(req => req.path.endsWith('/workflow-receipts/resolve')).body).toEqual({ command: 'final-retry', generation_id: finalBasis.generation_id, body })
    expect(requests.filter(req => req.path.endsWith('/retry'))).toHaveLength(0)
    mode = 'unknown'; expect(await client.resolveWorkflowReceipt(original)).toBeNull()
  })
  it('release sends the fixed approved point and both Ready hashes to its named route', async () => {
    const { template_id, template_version, template_digest, ...point } = finalCreate
    const body = { ...point, request_id: 'original-release', final_generation_id: finalBasis.generation_id, expected_final_pdf_sha256: hash, expected_final_docx_sha256: hash }
    expect(await client.releaseWorkflowPlan('plan', 'v1', body)).toMatchObject({ state: 'Released', publication_id: 'publication' })
    expect(requests.find(req => req.path.endsWith('/release')).body).toEqual(body)
  })
})

it('F18b P2 actual BFF forwards three bodyless reuse GETs with read ON/write OFF and fixed Unicode pairs', async () => {
  const product = { item_id: 'part/焊?+%&', version_id: 'version/一?+%&', version_label: '历史版', name: 'Frame', number: 'P1' }
  const bom = { baseline_id: 'bom/焊?+%&', fingerprint: hash, name: 'Assembly', number: 'B1' }
  const originalListeners = upstream.listeners('request')
  const paths = ['/api/v1/plugins/welding/plans/reuse-product-candidates', '/api/v1/plugins/welding/plans/reuse-product-context', '/api/v1/plugins/welding/plans/reuse-bom-candidates']
  // Extend only this test's synthetic Y responder; the actual BFF/router/client stay intact.
  upstream.removeAllListeners('request')
  upstream.on('request', async (req, res) => {
    const url = new URL(req.url!, fixture.origin)
    if (!paths.includes(url.pathname)) { for (const listener of originalListeners) listener.call(upstream, req, res); return }
    let raw = ''; for await (const chunk of req) raw += chunk.toString()
    requests.push({ path: req.url, method: req.method, raw, body: raw ? JSON.parse(raw) : null })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(url.pathname.endsWith('/reuse-product-context') ? { schema: 'yuantus.welding_plan_entry/1', product } : { items: [url.pathname.endsWith('/reuse-bom-candidates') ? bom : product] }))
  })
  try {
    vi.stubEnv('WELDING_WRITE_ENABLED', 'false')
    const source = reuseBody(), before = JSON.stringify(source)
    const selection = client as typeof client & {
      reuseProductCandidates(query: string): Promise<typeof product[]>
      reuseProductContext(pair: { item_id: string; version_id: string }): Promise<typeof product>
      reuseBomCandidates(pair: { item_id: string; version_id: string }): Promise<typeof bom[]>
    }
    expect(await selection.reuseProductCandidates('焊?+%&')).toEqual([product])
    expect(await selection.reuseProductContext(product)).toEqual(product)
    expect(await selection.reuseBomCandidates(product)).toEqual([bom])
    const reads = requests.filter(req => paths.includes(new URL(req.path, fixture.origin).pathname))
    expect(reads).toHaveLength(3); expect(reads.map(req => new URL(req.path, fixture.origin).pathname)).toEqual(paths)
    expect(new URL(reads[0].path, fixture.origin).searchParams.get('query')).toBe('焊?+%&')
    for (const req of reads) { expect(req.method).toBe('GET'); expect(req.raw).toBe(''); expect(req.body).toBeNull() }
    for (const req of reads.slice(1)) expect(Object.fromEntries(new URL(req.path, fixture.origin).searchParams)).toEqual({ product_id: product.item_id, product_version_id: product.version_id })
    expect(nativeRequests.map(req => new URL(req.path, 'https://frontend.invalid').pathname)).toEqual(paths.map(path => path.replace('/api/v1/plugins/welding', '/api/welding')))
    expect(nativeRequests.every(req => req.authorization === 'Bearer native-http' && !req.raw)).toBe(true)
    expect(JSON.stringify(source)).toBe(before)
    const beforeDenied = requests.length
    await expect(client.reusePlan('plan', 'v1', source)).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(beforeDenied)
    vi.stubEnv('WELDING_READ_ENABLED', 'false')
    await expect(selection.reuseBomCandidates(product)).rejects.toMatchObject({ status: 503 })
    expect(requests).toHaveLength(beforeDenied)
  } finally {
    upstream.removeAllListeners('request'); for (const listener of originalListeners) upstream.on('request', listener)
  }
})
