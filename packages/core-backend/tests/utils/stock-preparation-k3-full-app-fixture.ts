import { isDeepStrictEqual } from 'node:util'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
type JsonObject = Record<string, unknown>

function requireFixture(condition: unknown, code: string): asserts condition {
  // Never attach actual/expected values to an assertion: failures stay values-free.
  if (!condition) throw new Error(`APP_CONFIGURED_K3_${code}`)
}

function object(value: unknown): JsonObject {
  requireFixture(value !== null && typeof value === 'object' && !Array.isArray(value), 'OBJECT_REQUIRED')
  return value as JsonObject
}

function fixtureFailure(error: unknown, phase: string, operation: 'SETUP' | 'VERIFICATION') {
  const source = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
  const sqlState = typeof source?.code === 'string' && /^[0-9A-Z]{5}$/.test(source.code) ? source.code : null
  const reason = typeof source?.message === 'string' && /^APP_CONFIGURED_K3_[A-Z0-9_]+$/.test(source.message)
    ? source.message : `APP_CONFIGURED_K3_${operation}_FAILED`
  // A fixed internal phase and a five-character SQLSTATE are the only new diagnostics.
  // Do not preserve message, detail, query, response, actual/expected or error cause.
  return Object.assign(new Error(`${reason}_AT_${phase}${sqlState ? `_SQLSTATE_${sqlState}` : ''}`), {
    phase,
    ...(sqlState ? { code: sqlState } : {}),
  })
}

/** Only the parent-owned synthetic database and real application HTTP origin enter here.
 * This helper never seeds a read config, approval, or adapter implementation.
 * The browser creates both approved versions through the production workbench.
 */
export async function createK3FullAppFixture(input: {
  root: string
  origin: string
  ownerToken: string
  ownerId: string
  tenantId: string
  query: Query
}) {
  const { root, origin, ownerToken, ownerId, tenantId, query } = input
  const appUrl = new URL(origin)
  requireFixture(appUrl.protocol === 'http:' && appUrl.hostname === '127.0.0.1'
    && appUrl.origin === origin && !appUrl.username && !appUrl.password, 'LOCAL_APP_REQUIRED')
  const requireCore = createRequire(path.join(root, 'packages/core-backend/package.json'))
  const bcrypt = requireCore('bcryptjs') as { hash(value: string, rounds: number): Promise<string> }
  const { buildK3WiseMaterialListB4Config } = requireCore(path.join(root,
    'plugins/plugin-integration-core/lib/read-source-k3-material-list-b4-contract.cjs')) as {
    buildK3WiseMaterialListB4Config(input: { systemId: string }): JsonObject
  }
  const { validateReadSourceConfig } = requireCore(path.join(root,
    'plugins/plugin-integration-core/lib/read-source-config.cjs')) as {
    validateReadSourceConfig(config: unknown): { valid: boolean; normalized: JsonObject }
  }
  const systemId = `k3-full-app-${randomUUID()}`
  const uniqueMaterialId = '101'
  const ambiguousMaterialId = '102'
  const credentials = {
    username: randomBytes(24).toString('base64url'),
    password: randomBytes(32).toString('base64url'),
    acctId: randomBytes(24).toString('base64url'),
  }
  const sessions = new Set<string>()
  const counters = {
    loginRequests: 0, b4ReadRequests: 0, bl2ReadRequests: 0,
    externalWriteRequests: 0, unexpectedK3Requests: 0,
    invalidCredentials: 0, invalidSession: 0, invalidReadRequests: 0,
  }
  let closed = false
  let closing: Promise<void> | undefined
  const materialRows = [
    { FItemID: uniqueMaterialId, FNumber: 'SYN-MATERIAL-UNIQUE', FName: 'Synthetic unique material', FModel: 'Model-U', FUnitID: 'PCS' },
    { FItemID: ambiguousMaterialId, FNumber: 'SYN-MATERIAL-AMBIGUOUS', FName: 'Synthetic ambiguous material', FModel: 'Model-A', FUnitID: 'PCS' },
  ]
  const reply = (res: ServerResponse, status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    let data = ''
    for await (const chunk of req) {
      data += String(chunk)
      requireFixture(Buffer.byteLength(data) <= 65536, 'REQUEST_TOO_LARGE')
    }
    return JSON.parse(data)
  }
  const server = createServer(async (req, res) => {
    const route = req.url ?? ''
    const known = ['/K3API/Login', '/K3API/Material/GetList', '/K3API/BOM/GetList'].includes(route)
    if (/\/(?:Save|Submit|Audit)(?:[/.?]|$)/i.test(route)) counters.externalWriteRequests++
    if (req.method !== 'POST' || !known) {
      counters.unexpectedK3Requests++
      reply(res, 404, { success: false })
      return
    }
    try {
      const body = object(await readBody(req))
      if (route === '/K3API/Login') {
        counters.loginRequests++
        if (body.username !== credentials.username || body.password !== credentials.password
          || body.acctId !== credentials.acctId || body.lcid !== 2052
          || !isDeepStrictEqual(Object.keys(body).sort(), ['acctId', 'lcid', 'password', 'username'])) {
          counters.invalidCredentials++
          reply(res, 401, { success: false })
          return
        }
        const sessionId = randomBytes(32).toString('base64url')
        sessions.add(sessionId)
        reply(res, 200, { success: true, sessionId })
        return
      }
      if (typeof req.headers['x-k3-session'] !== 'string' || !sessions.has(req.headers['x-k3-session'])) {
        counters.invalidSession++
        reply(res, 401, { success: false })
        return
      }
      const data = object(body.Data)
      const bounded = data.Top === 10 && data.PageSize === 10 && data.PageIndex === 1
        && isDeepStrictEqual(Object.keys(body), ['Data'])
      if (route === '/K3API/Material/GetList') {
        const valid = bounded && data.Fields === 'FItemID,FNumber,FName,FModel,FUnitID'
          && data.OrderBy === 'FNumber'
          && isDeepStrictEqual(Object.keys(data).sort(), ['Fields', 'OrderBy', 'PageIndex', 'PageSize', 'Top'])
        if (!valid) {
          counters.invalidReadRequests++
          reply(res, 400, { success: false })
          return
        }
        counters.b4ReadRequests++
        reply(res, 200, { StatusCode: 200, Data: { ROWCOUNT: 2, PAGESIZE: 10, PAGEINDEX: 1, DATA: materialRows } })
        return
      }
      const valid = bounded && data.Fields === 'FBOMNumber' && data.OrderBy === '' && data.SelectPage === 2
        && [uniqueMaterialId, ambiguousMaterialId].some(key => data.Filter === `[FPercentItemID] = ${key}`)
        && isDeepStrictEqual(Object.keys(data).sort(), ['Fields', 'Filter', 'OrderBy', 'PageIndex', 'PageSize', 'SelectPage', 'Top'])
      if (!valid) {
        counters.invalidReadRequests++
        reply(res, 400, { success: false })
        return
      }
      counters.bl2ReadRequests++
      const rows = data.Filter === `[FPercentItemID] = ${uniqueMaterialId}`
        ? [{ FBOMNumber: 'SYN-BOM-UNIQUE' }]
        : [{ FBOMNumber: 'SYN-BOM-FIRST' }, { FBOMNumber: 'SYN-BOM-SECOND' }]
      reply(res, 200, { StatusCode: 200, Data: { ROWCOUNT: rows.length, PAGESIZE: 10, PAGEINDEX: 1, DATA: rows } })
    } catch {
      counters.invalidReadRequests++
      if (!res.headersSent) reply(res, 400, { success: false })
      else res.end()
    }
  })
  const stats = () => ({ ...counters, closed })
  const close = async () => {
    if (closing) return closing
    closing = new Promise<void>((resolve, reject) => {
      if (!server.listening) { closed = true; resolve(); return }
      server.close(error => {
        if (error) { reject(new Error('APP_CONFIGURED_K3_CLOSE_FAILED')); return }
        sessions.clear()
        closed = true
        resolve()
      })
      server.closeIdleConnections()
    })
    return closing
  }
  const http = async (token: string, route: string, body: unknown, expectedStatus: number, errorCode?: string) => {
    const response = await fetch(origin + route, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    const envelope = object(await response.json())
    requireFixture(response.status === expectedStatus, 'HTTP_STATUS_INVALID')
    if (errorCode) {
      requireFixture(envelope.ok === false && object(envelope.error).code === errorCode, 'HTTP_DENIAL_INVALID')
    } else requireFixture(envelope.ok === true, 'HTTP_ENVELOPE_INVALID')
    return envelope.data
  }
  const b4Config = buildK3WiseMaterialListB4Config({ systemId })
  const bl2Config = { version: 1, systemId, requiredKind: 'erp:k3-wise-webapi',
    object: 'material-bom-list', mode: 'resolver_lookup', readPath: '/K3API/BOM/GetList', readMethod: 'POST',
    operations: ['read'], keyField: 'FPercentItemID', keyEncoding: 'numeric_id',
    containerPaths: ['Data.DATA'], resolverRule: 'exactly_one', fieldMap: [{ source: 'FBOMNumber', target: 'bom_number' }] }
  const normalized = (config: JsonObject, version: unknown) => {
    const result = validateReadSourceConfig({ ...config, version })
    requireFixture(result.valid, 'CANONICAL_CONFIG_INVALID')
    return result.normalized
  }
  let phase = 'SETUP_LISTEN'
  try {
    // Port ownership is established by the unmodified network guard from this real listen.
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    requireFixture(address && typeof address !== 'string', 'LISTENER_REQUIRED')
    const baseUrl = `http://127.0.0.1:${address.port}`
    phase = 'SETUP_SYSTEM_HTTP'
    const created = object(await http(ownerToken, '/api/integration/external-systems', {
      id: systemId, name: 'Synthetic full application K3 source', kind: 'erp:k3-wise-webapi',
      role: 'source', status: 'active', config: { baseUrl, authMode: 'login' }, credentials,
    }, 201))
    requireFixture(created.id === systemId && created.status === 'active', 'SYSTEM_CREATION_INVALID')
    phase = 'SETUP_SYSTEM_PERSISTENCE'
    const persisted = (await query(`SELECT count(*)::int AS count,
      COALESCE(bool_and(tenant_id=$2 AND workspace_id IS NULL AND status='active' AND kind='erp:k3-wise-webapi'),false) AS scoped,
      COALESCE(bool_and(credentials_encrypted LIKE 'enc:%'),false) AS encrypted,
      COALESCE(bool_and(config->>'baseUrl'=$3 AND config->>'authMode'='login'),false) AS endpoint_matches
      FROM integration_external_systems WHERE id=$1`, [systemId, tenantId, baseUrl])).rows[0]
    requireFixture(persisted?.count === 1 && persisted.scoped === true && persisted.encrypted === true
      && persisted.endpoint_matches === true, 'ENCRYPTED_SYSTEM_PERSISTENCE_REQUIRED')
    phase = 'SETUP_CONFIGS_ABSENT'
    requireFixture((await query('SELECT count(*)::int AS count FROM integration_read_source_configs WHERE system_id=$1',
      [systemId])).rows[0]?.count === 0, 'BROWSER_MUST_CREATE_CONFIGS')

    const verifyBrowserResultAndPermissions = async (resultK3: unknown) => {
      phase = 'BROWSER_RESULT'
      const result = object(resultK3)
      for (const field of ['b4ConfigId', 'bl2ConfigId']) {
        requireFixture(typeof result[field] === 'string' && String(result[field]).length > 0, 'BROWSER_HANDLE_REQUIRED')
      }
      requireFixture(result.b4ConfigId !== result.bl2ConfigId, 'DISTINCT_BROWSER_CONFIGS_REQUIRED')
      requireFixture(Number.isSafeInteger(result.b4Version) && Number(result.b4Version) > 0
        && Number.isSafeInteger(result.bl2Version) && Number(result.bl2Version) > 0, 'BROWSER_VERSIONS_REQUIRED')
      requireFixture(counters.loginRequests > 0 && counters.b4ReadRequests > 0 && counters.bl2ReadRequests >= 2,
        'BROWSER_REAL_K3_IO_REQUIRED')
      for (const [id, version, canonical] of [
        [result.b4ConfigId, result.b4Version, b4Config], [result.bl2ConfigId, result.bl2Version, bl2Config],
      ] as const) {
        phase = canonical === b4Config ? 'BROWSER_B4_PERSISTENCE' : 'BROWSER_BL2_PERSISTENCE'
        const rows = (await query(`SELECT tenant_id,workspace_id,system_id,version,status,created_by,updated_by,config
          FROM integration_read_source_configs WHERE id=$1`, [id])).rows
        const row = rows[0]
        requireFixture(rows.length === 1 && row.tenant_id === tenantId && row.workspace_id === tenantId
          && row.system_id === systemId && row.version === version && row.status === 'approved'
          && row.created_by === ownerId && row.updated_by === ownerId
          && isDeepStrictEqual(row.config, normalized(canonical, version)), 'APPROVED_BROWSER_CONFIG_PERSISTENCE_REQUIRED')
        phase = canonical === b4Config ? 'BROWSER_B4_AUDIT' : 'BROWSER_BL2_AUDIT'
        const audit = (await query(`SELECT action,actor,detail FROM integration_read_source_config_audit WHERE config_id=$1
          AND action IN ('save_version','status_change')`, [id])).rows
        requireFixture(audit.some(entry => entry.action === 'save_version' && entry.actor === ownerId)
          && audit.some(entry => entry.action === 'status_change' && entry.actor === ownerId
            && object(entry.detail).from === 'draft' && object(entry.detail).to === 'approved'), 'BROWSER_APPROVAL_AUDIT_REQUIRED')
      }
      phase = 'BROWSER_CONFIG_COUNT'
      requireFixture((await query('SELECT count(*)::int AS count FROM integration_read_source_configs WHERE system_id=$1',
        [systemId])).rows[0]?.count === 2, 'EXACT_BROWSER_CONFIG_COUNT_REQUIRED')

      const readOnlyRole = `k3-fixture-reader-${randomUUID()}`
      phase = 'READ_ROLE_INSERT'
      await query("INSERT INTO roles (id,name) VALUES ($1,'Synthetic K3 integration reader')", [readOnlyRole])
      // The migrated permission vocabulary has an FK but does not seed integration:read.
      // This is synthetic authority bootstrap in the parent-owned temporary DB only.
      phase = 'READ_PERMISSION_VOCABULARY'
      const permissionCount = (await query("SELECT count(*)::int AS count FROM permissions WHERE code='integration:read'")).rows[0]?.count
      requireFixture(permissionCount === 0 || permissionCount === 1, 'READ_PERMISSION_VOCABULARY_INVALID')
      let fixtureReadPermissionSeeded = false
      if (permissionCount === 0) {
        const inserted = await query(`INSERT INTO permissions (code,name) VALUES ('integration:read','Synthetic K3 integration read')
          ON CONFLICT (code) DO NOTHING RETURNING 1 AS seeded`)
        fixtureReadPermissionSeeded = inserted.rows.length === 1 && inserted.rows[0]?.seeded === 1
      }
      phase = 'READ_ROLE_PERMISSION'
      await query("INSERT INTO role_permissions (role_id,permission_code) VALUES ($1,'integration:read')", [readOnlyRole])
      const login = async (memberTenant: string, canRead: boolean, principal: 'READER' | 'NONE' | 'OTHER') => {
        const id = randomUUID()
        const identifier = `k3-fixture-${randomUUID()}@example.invalid`
        const password = randomBytes(32).toString('base64url')
        phase = `${principal}_USER_INSERT`
        await query(`INSERT INTO users (id,email,name,password_hash,role,permissions,is_active,must_change_password,activation_status,local_password_set)
          VALUES ($1,$2,'Synthetic K3 permission principal',$3,'user','[]'::jsonb,true,false,'activated',true)`,
        [id, identifier, await bcrypt.hash(password, 10)])
        phase = `${principal}_MEMBERSHIP_INSERT`
        await query('INSERT INTO user_orgs (user_id,org_id,is_active) VALUES ($1,$2,true)', [id, memberTenant])
        if (canRead) {
          phase = `${principal}_ROLE_ASSIGNMENT`
          await query('INSERT INTO user_roles (user_id,role_id) VALUES ($1,$2)', [id, readOnlyRole])
          phase = `${principal}_NAMESPACE_ADMISSION`
          await query(`INSERT INTO user_namespace_admissions (user_id,namespace,enabled,source,granted_by,updated_by)
            VALUES ($1,'integration',true,'synthetic_fixture',$2,$2)`, [id, ownerId])
        }
        phase = `${principal}_PASSWORD_LOGIN`
        const response = await fetch(origin + '/api/auth/login', { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier, password }),
          signal: AbortSignal.timeout(20000) })
        const envelope = object(await response.json())
        const data = object(envelope.data)
        const user = object(data.user)
        requireFixture(response.status === 200 && envelope.success === true && typeof data.token === 'string'
          && user.id === id && user.tenantId === memberTenant && user.role !== 'admin'
          && Array.isArray(user.permissions) && user.permissions.includes('integration:read') === canRead
          && !user.permissions.includes('integration:write') && !user.permissions.includes('integration:admin'), 'REAL_MEMBER_LOGIN_REQUIRED')
        return data.token
      }
      const reader = await login(tenantId, true, 'READER')
      const none = await login(tenantId, false, 'NONE')
      const other = await login(randomUUID(), true, 'OTHER')
      const scopeSuffix = `?workspaceId=${encodeURIComponent(tenantId)}`
      const readRoute = (id: unknown) => `/api/integration/read-source-configs/${encodeURIComponent(String(id))}/read${scopeSuffix}`
      phase = 'READER_B4_READ'
      const b4 = object(await http(reader, readRoute(result.b4ConfigId), { inputs: {} }, 200))
      const b4Data = object(b4.data)
      const primary = object(object(b4Data.containers).primary)
      requireFixture(object(b4.evidence).ok === true && b4Data.recordCount === 2 && Array.isArray(primary.records)
        && isDeepStrictEqual(primary.records, materialRows.map(({ FUnitID, ...row }) => ({ ...row, baseUnit: FUnitID }))), 'READER_B4_DATA_REQUIRED')
      phase = 'READER_BL2_READ'
      const bl2 = object(await http(reader, readRoute(result.bl2ConfigId), { inputs: { key: uniqueMaterialId } }, 200))
      const resolver = object(object(bl2.data).resolver)
      requireFixture(object(bl2.evidence).ok === true && resolver.target === 'bom_number'
        && resolver.value === 'SYN-BOM-UNIQUE', 'READER_BL2_DATA_REQUIRED')
      phase = 'READER_BL2_AMBIGUOUS'
      const ambiguous = object(await http(reader, readRoute(result.bl2ConfigId), { inputs: { key: ambiguousMaterialId } }, 200))
      requireFixture(object(ambiguous.evidence).ok === false
        && object(ambiguous.evidence).errorCode === 'K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS'
        && ambiguous.data === null, 'BOM_AMBIGUITY_MUST_FAIL_CLOSED')
      const noIo = async (operation: () => Promise<unknown>) => {
        const before = stats()
        await operation()
        requireFixture(isDeepStrictEqual(stats(), before), 'DENIED_REQUEST_MADE_K3_IO')
      }
      await noIo(async () => {
        phase = 'READER_SAVE_DENIED'
        await http(reader, '/api/integration/read-source-configs', { config: b4Config }, 403, 'FORBIDDEN')
        phase = 'READER_APPROVE_DENIED'
        await http(reader, `/api/integration/read-source-configs/${result.b4ConfigId}/approve`, {}, 403, 'FORBIDDEN')
        phase = 'READER_RETIRE_DENIED'
        await http(reader, `/api/integration/read-source-configs/${result.b4ConfigId}/retire`, {}, 403, 'FORBIDDEN')
        phase = 'READER_PROBE_DENIED'
        await http(reader, `/api/integration/external-systems/${systemId}/read-source-probe`, { config: b4Config }, 403, 'FORBIDDEN')
        phase = 'READER_SYNC_DENIED'
        await http(reader, '/api/integration/stock-preparation/mvp/erp-materials/sync', {}, 403, 'FORBIDDEN')
        for (const id of [result.b4ConfigId, result.bl2ConfigId]) {
          const body = id === result.b4ConfigId ? { inputs: {} } : { inputs: { key: uniqueMaterialId } }
          phase = id === result.b4ConfigId ? 'NONE_B4_DENIED' : 'NONE_BL2_DENIED'
          await http(none, readRoute(id), body, 403, 'FORBIDDEN')
          phase = id === result.b4ConfigId ? 'OTHER_B4_DENIED' : 'OTHER_BL2_DENIED'
          await http(other, readRoute(id), body, 404, 'READ_SOURCE_CONFIG_NOT_FOUND')
          phase = id === result.b4ConfigId ? 'OTHER_B4_SCOPE_FORGERY' : 'OTHER_BL2_SCOPE_FORGERY'
          await http(other, `${readRoute(id)}&tenantId=${encodeURIComponent(tenantId)}`, body, 403, 'TENANT_MISMATCH')
        }
      })
      // Additional synthetic configs exercise lifecycle without changing either UI-created approval.
      phase = 'LIFECYCLE_DRAFT_CREATE'
      const draft = object(await http(ownerToken, `/api/integration/read-source-configs${scopeSuffix}`, {
        config: { ...bl2Config, fieldMap: [{ source: 'FBOMNumber', target: 'fixture_bom_number' }] },
      }, 201))
      requireFixture(typeof draft.id === 'string' && draft.status === 'draft'
        && draft.id !== result.bl2ConfigId, 'EXTRA_LIFECYCLE_CONFIG_REQUIRED')
      phase = 'LIFECYCLE_DRAFT_READ_DENIED'
      await noIo(() => http(reader, readRoute(draft.id), { inputs: { key: uniqueMaterialId } }, 409, 'READ_SOURCE_CONFIG_NOT_APPROVED'))
      phase = 'LIFECYCLE_APPROVE'
      await http(ownerToken, `/api/integration/read-source-configs/${draft.id}/approve${scopeSuffix}`, {}, 200)
      phase = 'LIFECYCLE_RETIRE'
      await http(ownerToken, `/api/integration/read-source-configs/${draft.id}/retire${scopeSuffix}`, {}, 200)
      phase = 'LIFECYCLE_RETIRED_READ_DENIED'
      await noIo(() => http(reader, readRoute(draft.id), { inputs: { key: uniqueMaterialId } }, 409, 'READ_SOURCE_CONFIG_NOT_APPROVED'))
      phase = 'FINAL_UI_APPROVALS_RETAINED'
      requireFixture((await query(`SELECT count(*)::int AS count FROM integration_read_source_configs
        WHERE id=ANY($1::text[]) AND status='approved'`, [[result.b4ConfigId, result.bl2ConfigId]])).rows[0]?.count === 2,
      'UI_APPROVALS_MUST_REMAIN_ACTIVE')
      phase = 'FINAL_K3_COUNTERS'
      requireFixture(counters.externalWriteRequests === 0 && counters.unexpectedK3Requests === 0
        && counters.invalidCredentials === 0 && counters.invalidSession === 0 && counters.invalidReadRequests === 0,
      'K3_REQUEST_CONTRACT_VIOLATION')
      return { realK3Login: true, encryptedCredentials: true, approvedVersionsPersisted: true, fixtureReadPermissionSeeded,
        sameTenantReaderRead: true, readerWritesDenied: true, noPermissionDenied: true,
        crossTenantDenied: true, unapprovedReadDenied: true, bomAmbiguityFailClosed: true,
        deniedRequestsNoK3Io: true, externalWriteRequests: counters.externalWriteRequests,
        unexpectedK3Requests: counters.unexpectedK3Requests, loginRequests: counters.loginRequests,
        b4ReadRequests: counters.b4ReadRequests, bl2ReadRequests: counters.bl2ReadRequests }
    }
    return { browserInput: { systemId, uniqueMaterialId, ambiguousMaterialId },
      verifyBrowserResultAndPermissions: async (resultK3: unknown) => {
        try { return await verifyBrowserResultAndPermissions(resultK3) } catch (error) {
          throw fixtureFailure(error, phase, 'VERIFICATION')
        }
      }, close, stats }
  } catch (error) {
    await close()
    // HTTP, JSON, DB and crypto libraries may carry sensitive material in errors.
    throw fixtureFailure(error, phase, 'SETUP')
  }
}
