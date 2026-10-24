import express, { Router, type Request, type RequestHandler, type Response } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import { lstat, open, readdir } from 'node:fs/promises'
import { extname, isAbsolute, join, posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { apiPathEquals, apiPathHasPrefix } from '../auth/api-path-policy'
import { weldingPlanRequest, type WeldingAuthority, type WeldingPlanOperation } from '../integrations/welding/client'
import { WeldingError, readWeldingProvider, weldingAvailable, type WeldingProvider } from '../integrations/welding/provider'
import { requireWeldingSession, type WeldingSession } from '../integrations/welding/session'

export const WELDING_CAD_PIN = 'b05b3684664f215ced015f09f23d300fcccf8ba49ea4e8826e1a373070083bb8'
const TICKET_PATH = '/api/welding/cad-assets/tickets'
const BODY_MAX = 1024
const DEADLINE_MS = 30000
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.json': 'application/json' }
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
type Scope = { purpose: 'editor' | 'history' | 'preparation'; plan_id: string; version_id: string; context_id?: string; change_id?: string; side?: 'before' | 'after' }
type Ticket = { token: string; session: WeldingSession; authority: WeldingAuthority; provider: WeldingProvider; root: string; scope: Scope; expires: number }
type Bundle = { root: string; assets: Map<string, Buffer> }

function invalid(): never { throw new WeldingError('WELDING_INVALID_REQUEST', 400) }
function unavailable(): never { throw new WeldingError('WELDING_UNAVAILABLE', 503) }
function safeId(value: unknown): value is string {
  if (typeof value !== 'string' || !value || Array.from(value).length > 64 || value.trim() !== value ||
    /^[\u001c-\u001f\u0085]|[\u001c-\u001f\u0085]$/.test(value) ||
    /[\r\n\0/\\%]/.test(value) || value === '.' || value === '..') return false
  try { encodeURIComponent(value); return true } catch { return false }
}
function scopeFromBody(body: unknown): Scope {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid()
  const value = body as Record<string, unknown>
  const keys = Object.keys(value).sort().join(',')
  const editor = value.purpose === 'editor' && keys === 'context_id,plan_id,purpose,version_id'
  const history = value.purpose === 'history' && keys === 'change_id,plan_id,purpose,side,version_id'
  const preparation = value.purpose === 'preparation' && keys === 'context_id,plan_id,purpose,side,version_id'
  if ((!editor && !history && !preparation) || !safeId(value.plan_id) || !safeId(value.version_id) ||
    (editor || preparation) && !safeId(value.context_id) || history && !safeId(value.change_id) ||
    (history || preparation) && !['before', 'after'].includes(value.side as string)) return invalid()
  return value as Scope
}
function operation(scope: Scope): WeldingPlanOperation {
  const planId = scope.plan_id, versionId = scope.version_id
  const path = `/plans/${encodeURIComponent(planId)}/versions/${encodeURIComponent(versionId)}`
  if (scope.purpose === 'editor') return { method: 'GET', write: false, result: 'cad-context',
    path: `${path}/cad-contexts/${encodeURIComponent(scope.context_id!)}`, planId, versionId, contextId: scope.context_id }
  if (scope.purpose === 'preparation') return { method: 'GET', write: false, result: 'source-preparation',
    path: `${path}/source-change-preparations/${encodeURIComponent(scope.context_id!)}`, planId, versionId, contextId: scope.context_id }
  return { method: 'GET', write: false, result: 'source-document',
    path: `${path}/source-changes/${encodeURIComponent(scope.change_id!)}/documents/${scope.side}`,
    planId, versionId, changeId: scope.change_id, side: scope.side }
}
function pinMatches(scope: Scope, body: Buffer, pin: string): boolean {
  try {
    const value = JSON.parse(body.toString('utf8')) as Record<string, unknown>
    if (scope.purpose === 'editor') return value.editor_url === `/welding-cad/${pin}/welding-frame.html` &&
      (value.origin as Record<string, unknown>)?.bundle_sha256 === pin
    if (scope.purpose === 'preparation') {
      const change = value.source_change as Record<string, { document?: { view_bundle_sha256?: unknown } }>
      return change?.[scope.side!]?.document?.view_bundle_sha256 === pin
    }
    return value.view_bundle_sha256 === pin
  } catch { return false }
}
function assetRoot(): string {
  const root = process.env.WELDING_CAD_ASSET_ROOT
  if (!root || !isAbsolute(root) || root.trim() !== root) return unavailable()
  return root
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const chunks: Buffer[] = []
    let size = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, limit + 1 - size))
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (!bytesRead) return Buffer.concat(chunks, size)
      size += bytesRead
      if (size > limit) throw Error()
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally { await file.close() }
}
async function loadBundle(root: string, pin: string): Promise<Bundle> {
  try {
    if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw Error()
    const manifestPath = join(root, 'manifest.json')
    if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink()) throw Error()
    const raw = await readBounded(manifestPath, 128 * 1024)
    if (sha(raw) !== pin) throw Error()
    const manifest = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    if (Object.keys(manifest).sort().join(',') !== 'adapter_schema,files,schema' ||
      manifest.schema !== 'yuantus.welding_cad_web/v1' || manifest.adapter_schema !== 'vemcad-weld-source/1' ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw Error()
    const files = manifest.files as Record<string, unknown>
    if (Object.keys(files).length < 1 || Object.keys(files).length > 512) throw Error()
    const seen = new Set<string>(), assets = new Map<string, Buffer>()
    let total = 0
    for (const [name, digest] of Object.entries(files)) {
      if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').includes('..') ||
        posix.normalize(name) !== name || seen.has(name.toLowerCase()) || !MIME[extname(name)] ||
        typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw Error()
      seen.add(name.toLowerCase())
      let path = root
      for (const part of name.split('/')) {
        path = join(path, part)
        if ((await lstat(path)).isSymbolicLink()) throw Error()
      }
      if (!(await lstat(path)).isFile()) throw Error()
      const data = await readBounded(path, 4 * 1024 * 1024)
      total += data.length
      if (total > 32 * 1024 * 1024 || sha(data) !== digest) throw Error()
      assets.set(name, data)
    }
    for (const required of ['welding-frame.html', 'welding-frame.js', 'welding-history.html', 'welding-history.js',
      'welding-history.css', 'bridge/welding_readonly_bridge.js', 'package.json', 'scripts/validate_welding_source.js'])
      if (!assets.has(required)) throw Error()
    if (assets.get('package.json')!.toString('utf8') !== '{"type":"module"}\n' &&
      !isDeepStrictEqual(JSON.parse(assets.get('package.json')!.toString('utf8')), { type: 'module' })) throw Error()
    const actual = new Set<string>()
    async function walk(dir: string, prefix = ''): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const name = prefix + entry.name
        if (entry.isSymbolicLink()) throw Error()
        if (entry.isDirectory()) await walk(join(dir, entry.name), `${name}/`)
        else if (entry.isFile()) actual.add(name)
        else throw Error()
      }
    }
    await walk(root)
    if (actual.size !== assets.size + 1 || !actual.has('manifest.json') ||
      [...assets.keys()].some(name => !actual.has(name))) throw Error()
    return { root, assets }
  } catch { return unavailable() }
}
function publicAsset(name: string): boolean { return name !== 'package.json' && !name.startsWith('scripts/') }
function fail(res: Response, error: unknown): void {
  const reason = error instanceof WeldingError ? error : new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
  if (!res.headersSent && !res.destroyed) res.status(reason.status).json({ error: { code: reason.code } })
  else if (!res.destroyed) res.destroy()
}
function active(signal: AbortSignal): void {
  if (signal.aborted) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
}
async function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  active(signal)
  let rejectAbort!: (reason: WeldingError) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(new WeldingError('WELDING_UPSTREAM_REJECTED', 502))
  signal.addEventListener('abort', onAbort, { once: true })
  try { const result = await Promise.race([work(), aborted]); active(signal); return result }
  finally { signal.removeEventListener('abort', onAbort) }
}

export const weldingCadPreflight: RequestHandler = (req, res, next) => {
  const ticket = apiPathEquals(req.path, TICKET_PATH)
  const ticketNamespace = apiPathHasPrefix(req.path, '/api/welding/cad-assets')
  if (!ticketNamespace && !req.path.toLowerCase().startsWith('/welding-cad/')) return next()
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    weldingAvailable()
    if (req.originalUrl.includes('?')) invalid()
    if (ticketNamespace) {
      if (!ticket) invalid()
      if (req.method !== 'POST' || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity' ||
        req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json' ||
        req.headers['content-length'] && !/^\d+$/.test(req.headers['content-length'])) invalid()
      if (req.headers['content-length'] && Number(req.headers['content-length']) > BODY_MAX)
        throw new WeldingError('WELDING_INVALID_REQUEST', 413)
    } else if (req.method !== 'GET' || req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) invalid()
    next()
  } catch (error) { fail(res, error) }
}
const rawBody = express.raw({ type: () => true, inflate: false, limit: BODY_MAX })
export const weldingCadRawBody: RequestHandler = (req, res, next) => {
  if (!apiPathEquals(req.path, TICKET_PATH)) return next()
  rawBody(req, res, error => { if (error) fail(res, new WeldingError('WELDING_INVALID_REQUEST', error.type === 'entity.too.large' ? 413 : 400)); else next() })
}

// Production always uses the compiled-in pin; the argument lets tests verify a small real manifest with the same loader.
export function weldingCadHostRouter(pin = WELDING_CAD_PIN): Router {
  const assetPath = `/welding-cad/${pin}/`
  const router = Router()
  const tickets = new Map<string, Ticket>()
  let bundle: Bundle | undefined
  const prune = () => { for (const [key, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(key) }
  const installed = async (signal: AbortSignal): Promise<Bundle> => {
    const root = assetRoot()
    if (!bundle || bundle.root !== root) bundle = await bounded(signal, () => loadBundle(root, pin))
    active(signal)
    return bundle
  }
  const current = async (ticket: Ticket, signal: AbortSignal): Promise<void> => {
    active(signal)
    weldingAvailable()
    if (ticket.expires <= Date.now() || assetRoot() !== ticket.root || !isDeepStrictEqual(readWeldingProvider(), ticket.provider))
      throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
    await bounded(signal, () => requireWeldingSession(ticket.token, ticket.session.tenantId, ticket.provider, ticket.session))
    active(signal)
    weldingAvailable()
    if (ticket.expires <= Date.now() || assetRoot() !== ticket.root || !isDeepStrictEqual(readWeldingProvider(), ticket.provider))
      throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
  }
  const domain = async (ticket: Pick<Ticket, 'token' | 'session' | 'provider' | 'scope'>, signal: AbortSignal) => {
    const result = await bounded(signal, () => weldingPlanRequest(ticket.provider, ticket.token, ticket.session.tenantId,
      operation(ticket.scope), signal))
    if (result.status !== 200 || !pinMatches(ticket.scope, result.body, pin)) throw new WeldingError('WELDING_UPSTREAM_REJECTED', 502)
    return result.authority
  }
  const run = (res: Response, task: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
    const close = () => { if (!res.writableFinished) controller.abort() }
    res.once('close', close)
    void task(controller.signal).catch(error => fail(res, error)).finally(() => { clearTimeout(timer); res.off('close', close) })
  }
  router.post(TICKET_PATH, (req, res) => run(res, async signal => {
    weldingAvailable()
    if (!Buffer.isBuffer(req.body) || req.body.length > BODY_MAX) invalid()
    let scope: Scope
    try { scope = scopeFromBody(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body))) }
    catch { return invalid() }
    const header = req.headers.authorization || ''
    if (!header.startsWith('Bearer ') || header.length > 16391) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
    prune()
    if (tickets.size >= 256) throw new WeldingError('WELDING_INVALID_REQUEST', 429)
    const provider = readWeldingProvider(), root = assetRoot()
    if ((await installed(signal)).root !== root) return unavailable()
    const token = header.slice(7)
    const session = await bounded(signal, () => requireWeldingSession(token, req.authenticatedTenantId, provider))
    const authority = await domain({ token, session, provider, scope }, signal)
    await bounded(signal, () => requireWeldingSession(token, req.authenticatedTenantId, provider, session))
    active(signal); weldingAvailable()
    if (root !== assetRoot() || !isDeepStrictEqual(readWeldingProvider(), provider)) return unavailable()
    prune()
    if (tickets.size >= 256) throw new WeldingError('WELDING_INVALID_REQUEST', 429)
    const expires = Math.min(Date.now() + 60000, session.exp * 1000)
    if (expires <= Date.now()) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
    const key = randomBytes(32).toString('hex')
    tickets.set(key, { token, session, authority, provider, root, scope, expires })
    setTimeout(() => tickets.delete(key), Math.max(0, expires - Date.now())).unref()
    const name = scope.purpose === 'editor' ? 'welding-frame.html' : 'welding-history.html'
    res.setHeader('Set-Cookie', `welding_cad_ticket=${key}; Max-Age=${Math.max(1, Math.floor((expires - Date.now()) / 1000))}; Path=${assetPath}; HttpOnly; Secure; SameSite=Strict`)
    res.status(201).json({ asset_url: `${assetPath}${name}`, bundle_sha256: pin, expires_at: new Date(expires).toISOString() })
  }))
  router.use('/welding-cad/', (req, res) => run(res, async signal => {
    weldingAvailable()
    if (req.method !== 'GET' || req.originalUrl.includes('?')) invalid()
    const match = /^\/welding-cad\/([0-9a-f]{64})\/([A-Za-z0-9_./-]+)$/.exec(req.originalUrl)
    if (!match || match[1] !== pin || !publicAsset(match[2])) throw new WeldingError('WELDING_INVALID_REQUEST', 404)
    const name = match[2]
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).filter(part => part.startsWith('welding_cad_ticket=')) || []
    if (cookie.length !== 1 || !/^welding_cad_ticket=[0-9a-f]{64}$/.test(cookie[0])) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
    prune()
    const key = cookie[0].slice('welding_cad_ticket='.length), ticket = tickets.get(key)
    if (!ticket) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
    try {
      if (ticket.scope.purpose === 'editor' && name === 'welding-history.html' ||
        ticket.scope.purpose !== 'editor' && name === 'welding-frame.html') throw new WeldingError('WELDING_SESSION_REQUIRED', 403)
      const installedBundle = await installed(signal)
      const bytes = installedBundle.assets.get(name)
      if (!bytes || !publicAsset(name)) throw new WeldingError('WELDING_INVALID_REQUEST', 404)
      await current(ticket, signal)
      const authority = await domain(ticket, signal)
      if (!isDeepStrictEqual(authority.owner, ticket.authority.owner)) throw new WeldingError('WELDING_SESSION_REQUIRED', 403)
      await current(ticket, signal)
      active(signal)
      if (tickets.get(key) !== ticket) throw new WeldingError('WELDING_SESSION_REQUIRED', 401)
      res.setHeader('Content-Type', MIME[extname(name)])
      res.setHeader('Content-Length', String(bytes.length))
      if (extname(name) === '.html') res.setHeader('Content-Security-Policy', CSP)
      res.status(200).send(bytes)
    } catch (error) { tickets.delete(key); throw error }
  }))
  return router
}
