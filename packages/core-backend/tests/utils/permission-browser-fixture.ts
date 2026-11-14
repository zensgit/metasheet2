/// <reference lib="dom" />

// Isolated real UserManagementView plus a synthetic subject request panel.
// Scope mode also mounts real RoleDelegationView. This is not the full login or
// workbench. Vite is loopback, configFile/envFile off. Two contexts each install
// auth_token. API calls are proxied to the real listener and never fulfilled.
// The Chromium route allowlist only filters browser requests.
// It is not OS or native egress isolation.
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import express, { type RequestHandler } from 'express'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import type { Plugin, ViteDevServer } from 'vite'
import request from 'supertest'
import { authService } from '../../src/auth/AuthService'
import { query, transaction } from '../../src/db/pg'
import { authenticate } from '../../src/middleware/auth'
import { findObjectSheet, type MultitableProvisioningQueryFn } from '../../src/multitable/provisioning'
import { adminUsersRouter } from '../../src/routes/admin-users'

const BUSINESS_PATH = '/api/integration/stock-preparation/preflight'
const HARNESS_PATH = '/__permission-browser-harness'
const STOCK_PREP_ADMIN_ROLE_ID = 'stock-prep_admin'
const PROTECTED_ROLE_IDS = [
  'admin',
  'stock-prep',
  'stock-prep_admin',
  'stock-prep_puller',
  'stock-prep_developer',
  'stock-prep_frontline',
] as const

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const webRoot = path.join(repoRoot, 'apps', 'web')

export type PermissionBrowserMutation = {
  context: 'admin' | 'subject'
  method: string
  pathname: string
  status: number
}
export type SubjectPreflightReading = {
  status: number
  code: string
  ready: boolean | null
  ledgerPresent: boolean | null
  ledgerMode: string | null
}
export type PermissionBrowserAdmission = {
  namespace: string
  hasRole: boolean
  enabled: boolean
  effective: boolean
}
export type PermissionBrowserReread = {
  roles: string[]
  permissions: string[]
  admission: PermissionBrowserAdmission | null
}
export type SubjectDelegationReading = {
  status: number
  code: string
}
export type PermissionBrowserScopeRead = {
  adminNamespaces: string[]
  groupIds: string[]
}
export type PermissionBrowserMode = 'lifecycle' | 'scope'

type HttpResult = { status: number; body: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(`PERMISSION_BROWSER_${code}`)
}

function assertAllowedDatabase(): void {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is required')
  const parsed = new URL(raw)
  const name = parsed.pathname.replace(/^\//, '')
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('permission browser suite refuses a non-loopback DATABASE_URL')
  }
  if (name !== 'permission_boundaries_synthetic' && name !== 'metasheet_test') {
    throw new Error('permission browser suite refuses a database that is not the synthetic or CI test database')
  }
}

async function requireOneRow(sql: string, params: unknown[], label: string): Promise<void> {
  const found = await query(sql, params)
  if (found.rows.length !== 1) {
    throw new Error(`${label} is absent; refusing to create or rewrite it`)
  }
}

function mintToken(id: string, orgId: string): string {
  return authService.createToken({
    id,
    email: `${id}@example.test`,
    name: 'synthetic',
    role: 'user',
    tenantId: orgId,
    permissions: [],
    created_at: new Date(),
    updated_at: new Date(),
  })
}

function createApiApp(): express.Express {
  const app = express()
  app.use(express.json())
  const loaded = createRequire(import.meta.url)(
    '../../../../plugins/plugin-integration-core/lib/http-routes.cjs',
  ) as {
    registerIntegrationRoutes?: (input: {
      context: {
        api: {
          multitable: {
            provisioning: {
              findObjectSheet: (input: { projectId: string; objectId: string }) => Promise<unknown>
              resolveFieldIds: () => never
              ensureObject: () => never
            }
          }
          http: { addRoute: (method: string, path: string, handler: RequestHandler) => void }
        }
      }
      services: Record<string, unknown>
    }) => void
  }
  if (typeof loaded.registerIntegrationRoutes !== 'function') {
    throw new Error('registerIntegrationRoutes export is missing')
  }
  const inert: object = new Proxy({}, {
    get(): () => never {
      return () => {
        throw new Error('unexpected synthetic service call')
      }
    },
  })
  const services: Record<string, unknown> = {}
  for (const name of [
    'externalSystemRegistry',
    'adapterRegistry',
    'pipelineRegistry',
    'pipelineRunner',
    'deadLetterStore',
    'stagingInstaller',
    'templateRegistry',
    'readSourceConfigStore',
    'readSourceCompositionConfigStore',
    'bridgeAgentChecklistStore',
  ]) {
    services[name] = inert
  }
  const provisioningQuery: MultitableProvisioningQueryFn = async (sql, params) => {
    const result = await query(sql, params)
    return { rows: result.rows, rowCount: result.rowCount }
  }
  app.use(adminUsersRouter())
  loaded.registerIntegrationRoutes({
    context: {
      api: {
        multitable: {
          provisioning: {
            findObjectSheet: ({ projectId, objectId }) => findObjectSheet(provisioningQuery, projectId, objectId),
            resolveFieldIds: () => {
              throw new Error('unexpected existing object')
            },
            ensureObject: () => {
              throw new Error('unexpected write')
            },
          },
        },
        http: {
          addRoute: (method, routePath, handler) => {
            if (method.toUpperCase() === 'GET' && routePath === BUSINESS_PATH) {
              app.get(routePath, authenticate, handler)
            }
          },
        },
      },
    },
    services,
  })
  return app
}

function harnessHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head>
    <body>
    <p data-testid="permission-browser-harness-label">隔离的真实 Vue 权限页骨架，不是完整登录或工作台。</p>
    <div id="app"></div>
    <script type="module">
    import { createApp, h, ref } from 'vue'
    import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
    import { createPinia } from 'pinia'
    import UserManagementView from '/src/views/UserManagementView.vue'
    import { apiFetch } from '/src/utils/api.ts'
    const harness = new URLSearchParams(location.search).get('harness')
    if (harness === 'subject') {
      createApp({
        setup() {
          const status = ref('未请求')
          const code = ref('none')
          const ready = ref('absent')
          const ledgerPresent = ref('absent')
          const ledgerMode = ref('absent')
          const done = ref('0')
          let ticket = 0
          async function readPreflight() {
            ticket += 1
            const current = String(ticket)
            status.value = '请求中'
            code.value = 'none'
            ready.value = 'absent'
            ledgerPresent.value = 'absent'
            ledgerMode.value = 'absent'
            const response = await apiFetch('/api/integration/stock-preparation/preflight')
            let nextCode = 'unknown'
            let nextReady = 'absent'
            let nextPresent = 'absent'
            let nextMode = 'absent'
            try {
              const payload = await response.json()
              if (payload && payload.ok === true) {
                nextCode = 'ok'
                const data = payload.data || {}
                if (data.ready === true || data.ready === false) nextReady = String(data.ready)
                const ledger = data.checks && data.checks.confirmationLedger
                if (ledger && (ledger.present === true || ledger.present === false)) nextPresent = String(ledger.present)
                if (ledger && typeof ledger.mode === 'string') nextMode = ledger.mode
              } else if (payload && payload.error && typeof payload.error.code === 'string') {
                nextCode = payload.error.code
              }
            } catch { nextCode = 'unreadable' }
            status.value = String(response.status)
            code.value = nextCode
            ready.value = nextReady
            ledgerPresent.value = nextPresent
            ledgerMode.value = nextMode
            done.value = current
          }
          return () => h('main', [
            h('h1', { 'data-testid': 'subject-harness-heading' }, '主体备料预检'),
            h('p', '此页只使用已放入本上下文的 auth_token，向已注册的备料预检发真实请求。它不是完整登录或工作台。'),
            h('button', { 'data-testid': 'subject-preflight', type: 'button', onClick: () => { void readPreflight() } }, '读取备料预检'),
            h('p', { 'data-testid': 'subject-preflight-status' }, status.value),
            h('p', { 'data-testid': 'subject-preflight-code' }, code.value),
            h('p', { 'data-testid': 'subject-preflight-ready' }, ready.value),
            h('p', { 'data-testid': 'subject-preflight-ledger-present' }, ledgerPresent.value),
            h('p', { 'data-testid': 'subject-preflight-ledger-mode' }, ledgerMode.value),
            h('p', { 'data-testid': 'subject-preflight-done' }, done.value),
          ])
        },
      }).mount('#app')
    } else {
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:pathMatch(.*)*', component: UserManagementView }],
      })
      createApp({ setup() { return () => h(RouterView) } }).use(createPinia()).use(router).mount('#app')
    }
    document.body.dataset.permissionHarness = harness === 'subject' ? 'subject' : 'admin'
    </script></body></html>`
}

function scopeHarnessHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"></head>
    <body>
    <p data-testid="permission-browser-harness-label">隔离的真实 Vue 权限页骨架，不是完整登录或工作台。</p>
    <div id="app"></div>
    <script type="module">
    import { createApp, h, ref } from 'vue'
    import { createRouter, createMemoryHistory, RouterView } from 'vue-router'
    import { createPinia } from 'pinia'
    import UserManagementView from '/src/views/UserManagementView.vue'
    import RoleDelegationView from '/src/views/RoleDelegationView.vue'
    import { apiFetch } from '/src/utils/api.ts'
    const harness = new URLSearchParams(location.search).get('harness')
    if (harness === 'subject') {
      const params = new URLSearchParams(location.search)
      const targetId = params.get('targetId') || ''
      const roleId = params.get('roleId') || ''
      createApp({
        setup() {
          const status = ref('未请求')
          const code = ref('none')
          const done = ref('0')
          let ticket = 0
          async function delegate() {
            ticket += 1
            const current = String(ticket)
            status.value = '请求中'
            code.value = 'none'
            const path = '/api/admin/role-delegation/users/' + encodeURIComponent(targetId) + '/roles/assign'
            const response = await apiFetch(path, {
              method: 'POST',
              body: JSON.stringify({ roleId: roleId }),
            })
            let nextCode = 'unknown'
            try {
              const payload = await response.json()
              if (payload && payload.ok === true) nextCode = 'ok'
              else if (payload && payload.error && typeof payload.error.code === 'string') nextCode = payload.error.code
            } catch { nextCode = 'unreadable' }
            status.value = String(response.status)
            code.value = nextCode
            done.value = current
          }
          return () => h('main', [
            h('h1', { 'data-testid': 'subject-harness-heading' }, '主体委派操作'),
            h('p', '此页只使用已放入本上下文的 auth_token，向角色委派分配接口发真实请求。它不是完整登录或工作台。'),
            h('button', { 'data-testid': 'subject-delegation', type: 'button', onClick: () => { void delegate() } }, '委派分配角色'),
            h('p', { 'data-testid': 'subject-delegation-status' }, status.value),
            h('p', { 'data-testid': 'subject-delegation-code' }, code.value),
            h('p', { 'data-testid': 'subject-delegation-done' }, done.value),
          ])
        },
      }).mount('#app')
    } else {
      const View = harness === 'delegation' ? RoleDelegationView : UserManagementView
      const router = createRouter({
        history: createMemoryHistory(),
        routes: [{ path: '/:pathMatch(.*)*', component: View }],
      })
      createApp({ setup() { return () => h(RouterView) } }).use(createPinia()).use(router).mount('#app')
    }
    document.body.dataset.permissionHarness = harness === 'subject' ? 'subject' : harness === 'delegation' ? 'delegation' : 'admin'
    </script></body></html>`
}

function isMutation(method: string, pathname: string): boolean {
  if (method !== 'POST' && method !== 'PATCH') return false
  return pathname.includes('/roles/')
    || pathname.includes('/admission')
    || pathname.includes('/scope-groups/')
    || pathname.includes('/member-groups/')
}

function readEnvelopeId(body: unknown, key: 'item' | 'user'): string {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) return ''
  const record = key === 'item' ? body.data.item : body.data.user
  if (!isRecord(record) || typeof record.id !== 'string' || record.id.length === 0) return ''
  return record.id
}

// Browser-origin allowlist only. continue() does not fulfill or rewrite the request.
// Aborting other origins is not OS or native egress isolation.
async function installOriginFirewall(context: BrowserContext, origin: string, violations: string[]): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) {
      violations.push('EXTERNAL_REQUEST')
      await route.abort('blockedbyclient')
      return
    }
    await route.continue()
  })
}

function watchMutations(
  context: BrowserContext,
  label: 'admin' | 'subject',
  bucket: PermissionBrowserMutation[],
): void {
  context.on('response', (response) => {
    const url = new URL(response.url())
    const method = response.request().method()
    if (!url.pathname.startsWith('/api/')) return
    if (!isMutation(method, url.pathname)) return
    bucket.push({ context: label, method, pathname: url.pathname, status: response.status() })
  })
}

function readPreflightFields(body: unknown): Omit<SubjectPreflightReading, 'status'> {
  if (!isRecord(body)) {
    return { code: 'unreadable', ready: null, ledgerPresent: null, ledgerMode: null }
  }
  if (body.ok === true && isRecord(body.data)) {
    const checks = isRecord(body.data.checks) ? body.data.checks : null
    const ledger = checks && isRecord(checks.confirmationLedger) ? checks.confirmationLedger : null
    return {
      code: 'ok',
      ready: body.data.ready === true ? true : body.data.ready === false ? false : null,
      ledgerPresent: ledger && (ledger.present === true || ledger.present === false) ? ledger.present === true : null,
      ledgerMode: ledger && typeof ledger.mode === 'string' ? ledger.mode : null,
    }
  }
  const error = isRecord(body.error) ? body.error : null
  return {
    code: error && typeof error.code === 'string' ? error.code : 'unknown',
    ready: null,
    ledgerPresent: null,
    ledgerMode: null,
  }
}

export type PermissionBrowserFixture = {
  adminPage: Page
  subjectPage: Page
  mode: PermissionBrowserMode
  roleId: string
  subjectId: string
  subjectEmail: string
  targetId: string
  targetEmail: string
  groupId: string
  groupName: string
  violations: string[]
  pageErrors: string[]
  mutations: () => PermissionBrowserMutation[]
  reread: () => Promise<PermissionBrowserReread>
  readSubjectPreflight: () => Promise<SubjectPreflightReading>
  readSubjectDelegation: () => Promise<SubjectDelegationReading>
  readScopes: () => Promise<PermissionBrowserScopeRead>
  openUserAdmin: () => Promise<void>
  openDelegation: (userId: string) => Promise<void>
  subjectTokenUnchanged: () => Promise<boolean>
  cleanup: () => Promise<void>
}

async function createOwnedScopeFixtures(
  app: express.Express,
  adminToken: string,
  runHex: string,
  ownedUserIds: string[],
  ownedGroupIds: string[],
): Promise<{ targetId: string; targetEmail: string; groupId: string; groupName: string }> {
  const groupName = `pb${runHex}`
  const groupResponse = await request(app)
    .post('/api/admin/role-delegation/member-groups')
    .auth(adminToken, { type: 'bearer' })
    .send({ name: groupName })
  const groupId = groupResponse.status === 200 ? readEnvelopeId(groupResponse.body, 'item') : ''
  if (groupId) ownedGroupIds.push(groupId)
  if (!groupId) throw new Error(`PERMISSION_BROWSER_GROUP_CREATE_${groupResponse.status}`)

  const targetEmail = `pb-target-${runHex}@example.test`
  const userResponse = await request(app)
    .post('/api/admin/users')
    .auth(adminToken, { type: 'bearer' })
    .send({ name: `pb target ${runHex}`, email: targetEmail })
  const targetId = userResponse.status === 200 ? readEnvelopeId(userResponse.body, 'user') : ''
  if (targetId) ownedUserIds.push(targetId)
  if (!targetId) throw new Error(`PERMISSION_BROWSER_TARGET_USER_CREATE_${userResponse.status}`)
  return { targetId, targetEmail, groupId, groupName }
}

export async function createPermissionBrowserFixture(
  mode: PermissionBrowserMode = 'lifecycle',
): Promise<PermissionBrowserFixture> {
  assertAllowedDatabase()
  if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
    throw new Error('permission browser fixture requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false')
  }
  if (process.env.PRODUCT_MODE !== 'plm-workbench') {
    throw new Error('permission browser fixture requires PRODUCT_MODE=plm-workbench')
  }

  const runHex = randomBytes(6).toString('hex')
  const operatorRoleId = `stock-prep_pb${runHex}`
  const orgId = `pb-${runHex}`
  const adminId = randomUUID()
  const subjectId = randomUUID()
  const ownedUserIds = [adminId, subjectId]
  const ownedGroupIds: string[] = []
  let targetId = ''
  let targetEmail = ''
  let groupId = ''
  const groupName = `pb${runHex}`
  if ((PROTECTED_ROLE_IDS as readonly string[]).includes(operatorRoleId) || operatorRoleId.endsWith('_admin')) {
    throw new Error('refusing to use a built-in or delegated-admin role id')
  }

  const violations: string[] = []
  const pageErrors: string[] = []
  const mutations: PermissionBrowserMutation[] = []
  let adminToken = ''
  let subjectToken = ''
  let seedStarted = false
  let httpServer: Server | undefined
  let vite: ViteDevServer | undefined
  let browser: Browser | undefined
  let adminContext: BrowserContext | undefined
  let subjectContext: BrowserContext | undefined
  let adminPage: Page | undefined
  let subjectPage: Page | undefined
  let preflightReads = 0
  const app = createApiApp()

  async function cleanupOwnedFixtures(): Promise<void> {
    if (!seedStarted) return
    await transaction(async (client) => {
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [operatorRoleId])
      await client.query(
        `DELETE FROM user_roles
          WHERE user_id::text = ANY($1::text[])
             OR role_id = $2`,
        [ownedUserIds, operatorRoleId],
      )
      await client.query('DELETE FROM user_permissions WHERE user_id::text = ANY($1::text[])', [ownedUserIds])
      await client.query('DELETE FROM user_namespace_admissions WHERE user_id::text = ANY($1::text[])', [ownedUserIds])
      await client.query('DELETE FROM user_orgs WHERE user_id::text = ANY($1::text[])', [ownedUserIds])
      await client.query('DELETE FROM delegated_role_admin_scopes WHERE admin_user_id::text = ANY($1::text[])', [ownedUserIds])
      await client.query(
        `DELETE FROM delegated_role_admin_member_groups
          WHERE admin_user_id::text = ANY($1::text[])
             OR group_id::text = ANY($2::text[])`,
        [ownedUserIds, ownedGroupIds],
      )
      await client.query(
        `DELETE FROM platform_member_group_members
          WHERE user_id::text = ANY($1::text[])
             OR group_id::text = ANY($2::text[])`,
        [ownedUserIds, ownedGroupIds],
      )
      await client.query('DELETE FROM platform_member_groups WHERE id::text = ANY($1::text[])', [ownedGroupIds])
      await client.query('DELETE FROM user_invites WHERE user_id::text = ANY($1::text[])', [ownedUserIds])
      const auditResourceIds = [
        `${subjectId}:${operatorRoleId}`,
        `${adminId}:${operatorRoleId}`,
        `${subjectId}:stock-prep`,
        `${adminId}:stock-prep`,
        `${subjectId}:${STOCK_PREP_ADMIN_ROLE_ID}`,
      ]
      for (const userId of ownedUserIds) {
        auditResourceIds.push(`${userId}:${operatorRoleId}`, `${userId}:stock-prep`)
      }
      for (const ownedGroupId of ownedGroupIds) {
        auditResourceIds.push(`group:${ownedGroupId}`, `${subjectId}:stock-prep:group:${ownedGroupId}`)
        for (const userId of ownedUserIds) auditResourceIds.push(`${ownedGroupId}:${userId}`)
      }
      await client.query(
        `DELETE FROM audit_logs
          WHERE resource_id = ANY($1::text[])
             OR action_details->>'userId' = ANY($2::text[])
             OR action_details->>'adminUserId' = ANY($2::text[])
             OR action_details->>'groupId' = ANY($3::text[])
             OR action_details->>'roleId' = $4
             OR action_details->>'operatorRoleId' = $4`,
        [auditResourceIds, ownedUserIds, ownedGroupIds, operatorRoleId],
      )
      await client.query('DELETE FROM users WHERE id::text = ANY($1::text[])', [ownedUserIds])
      await client.query(
        'DELETE FROM roles WHERE id = $1 AND NOT (id = ANY($2::text[]))',
        [operatorRoleId, [...PROTECTED_ROLE_IDS]],
      )
    })
  }

  async function cleanup(): Promise<void> {
    await adminContext?.close().catch(() => undefined)
    await subjectContext?.close().catch(() => undefined)
    adminContext = undefined
    subjectContext = undefined
    await browser?.close().catch(() => undefined)
    browser = undefined
    const http = vite?.httpServer as { closeAllConnections?: () => void } | undefined
    http?.closeAllConnections?.()
    await vite?.close().catch(() => undefined)
    vite = undefined
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer?.close(() => resolve())
      })
      httpServer = undefined
    }
    await cleanupOwnedFixtures()
    seedStarted = false
  }

  async function reread(): Promise<PermissionBrowserReread> {
    const accessResponse = await request(app).get(`/api/admin/users/${subjectId}/access`).auth(adminToken, { type: 'bearer' })
    const admissionResponse = await request(app).get(`/api/admin/users/${subjectId}/member-admission`).auth(adminToken, { type: 'bearer' })
    if (accessResponse.status !== 200 || admissionResponse.status !== 200) {
      throw new Error(`reread failed access=${accessResponse.status} admission=${admissionResponse.status}`)
    }
    const accessBody = accessResponse.body as HttpResult['body']
    const admissionBody = admissionResponse.body as HttpResult['body']
    if (!isRecord(accessBody) || accessBody.ok !== true || !isRecord(accessBody.data)) {
      throw new Error('reread access envelope missing')
    }
    if (!isRecord(admissionBody) || admissionBody.ok !== true || !isRecord(admissionBody.data)) {
      throw new Error('reread admission envelope missing')
    }
    const roles = Array.isArray(accessBody.data.roles)
      ? accessBody.data.roles.filter((item): item is string => typeof item === 'string')
      : []
    const permissions = Array.isArray(accessBody.data.permissions)
      ? accessBody.data.permissions.filter((item): item is string => typeof item === 'string')
      : []
    const rows = Array.isArray(admissionBody.data.namespaceAdmissions) ? admissionBody.data.namespaceAdmissions : []
    const match = rows.find((item) => isRecord(item) && item.namespace === 'stock-prep')
    const admission = isRecord(match)
      ? {
        namespace: 'stock-prep',
        hasRole: match.hasRole === true,
        enabled: match.enabled === true,
        effective: match.effective === true,
      }
      : null
    return { roles, permissions, admission }
  }

  async function assertContextToken(page: Page, expected: string, label: string): Promise<void> {
    const stored = await page.evaluate(() => localStorage.getItem('auth_token'))
    if (stored !== expected) {
      throw new Error(`${label} auth_token changed or is missing`)
    }
  }

  try {
    await requireOneRow('SELECT id FROM roles WHERE id = $1', ['admin'], 'built-in role admin')
    await requireOneRow('SELECT id FROM roles WHERE id = $1', [STOCK_PREP_ADMIN_ROLE_ID], 'built-in role stock-prep_admin')
    await requireOneRow('SELECT code FROM permissions WHERE code = $1', ['stock-prep:read'], 'catalogue permission stock-prep:read')
    seedStarted = true
    await transaction(async (client) => {
      for (const id of ownedUserIds) {
        const isPlatformAdmin = id === adminId
        await client.query(
          `INSERT INTO users (
             id, username, email, name, password_hash, role, is_admin, is_active,
             activation_status, must_change_password, local_password_set
           ) VALUES ($1, $1, $2, 'synthetic', 'synthetic', $3, $4, true, 'activated', false, true)`,
          [id, `${id}@example.test`, isPlatformAdmin ? 'admin' : 'user', isPlatformAdmin],
        )
      }
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [adminId, 'admin'])
      await client.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [operatorRoleId, `browser ${runHex}`])
      await client.query(
        'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)',
        [operatorRoleId, 'stock-prep:read'],
      )
      for (const id of ownedUserIds) {
        await client.query('INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, $2, true)', [id, orgId])
      }
    })
    adminToken = mintToken(adminId, orgId)
    subjectToken = mintToken(subjectId, orgId)
    check(adminToken !== subjectToken, 'DISTINCT_SYNTHETIC_AUTH_REQUIRED')

    httpServer = createHttpServer(app)
    await new Promise<void>((resolve, reject) => {
      httpServer?.once('error', reject)
      httpServer?.listen(0, '127.0.0.1', () => {
        httpServer?.removeListener('error', reject)
        resolve()
      })
    })
    const apiAddress = httpServer.address()
    check(apiAddress && typeof apiAddress !== 'string', 'API_ADDRESS_REQUIRED')
    const apiOrigin = `http://127.0.0.1:${apiAddress.port}`
    if (mode === 'scope') {
      const seeded = await createOwnedScopeFixtures(app, adminToken, runHex, ownedUserIds, ownedGroupIds)
      targetId = seeded.targetId
      targetEmail = seeded.targetEmail
      groupId = seeded.groupId
    }

    const cacheDir = path.join(repoRoot, 'tmp', 'permission-browser', randomUUID(), 'cache')
    await mkdir(cacheDir, { recursive: true })
    const webRequire = createRequire(path.join(webRoot, 'package.json'))
    const { createServer } = await import(pathToFileURL(webRequire.resolve('vite')).href) as typeof import('vite')
    const { default: vue } = await import(pathToFileURL(webRequire.resolve('@vitejs/plugin-vue')).href) as {
      default: () => Plugin
    }
    const { chromium } = await import(pathToFileURL(webRequire.resolve('@playwright/test')).href) as typeof import('@playwright/test')
    const html = mode === 'scope' ? scopeHarnessHtml() : harnessHtml()
    vite = await createServer({
      root: webRoot,
      configFile: false,
      envFile: false,
      cacheDir,
      resolve: { alias: { '@': path.join(webRoot, 'src') } },
      define: {
        'import.meta.env.VITE_API_URL': '""',
        'import.meta.env.VITE_API_BASE': '""',
      },
      plugins: [
        vue(),
        {
          name: 'permission-browser-harness',
          configureServer(server) {
            server.middlewares.use(HARNESS_PATH, async (_incoming, response, next) => {
              try {
                response.setHeader('Content-Type', 'text/html; charset=utf-8')
                response.end(await server.transformIndexHtml(HARNESS_PATH, html))
              } catch {
                next(new Error('PERMISSION_BROWSER_HARNESS_FAILED'))
              }
            })
          },
        } as Plugin,
      ],
      optimizeDeps: { include: ['vue', 'vue-router', 'pinia'] },
      server: {
        host: '127.0.0.1',
        port: 0,
        hmr: false,
        proxy: {
          '/api': { target: apiOrigin, changeOrigin: false },
        },
      },
    })
    const uiServer = vite.httpServer
    check(uiServer, 'UI_SERVER_REQUIRED')
    await new Promise<void>((resolve, reject) => {
      uiServer.once('error', reject)
      void Promise.resolve(uiServer.listen(0, '127.0.0.1', () => {
        uiServer.removeListener('error', reject)
        resolve()
      })).catch(reject)
    })
    const uiAddress = uiServer.address()
    check(uiAddress && typeof uiAddress !== 'string', 'UI_ADDRESS_REQUIRED')
    const origin = `http://127.0.0.1:${uiAddress.port}`

    browser = await chromium.launch({ headless: true })

    const openContext = async (token: string, harness: 'admin' | 'subject'): Promise<{ context: BrowserContext; page: Page }> => {
      const context = await browser!.newContext({
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN',
        serviceWorkers: 'block',
      })
      await context.addInitScript(({ authToken, ownedOrigin }) => {
        if (location.origin === ownedOrigin) localStorage.setItem('auth_token', authToken)
      }, { authToken: token, ownedOrigin: origin })
      await installOriginFirewall(context, origin, violations)
      watchMutations(context, harness, mutations)
      const page = await context.newPage()
      page.on('pageerror', (error) => {
        pageErrors.push(error.message.slice(0, 300))
      })
      page.setDefaultTimeout(60000)
      let userQuery = ''
      if (harness === 'admin') userQuery = `&userId=${encodeURIComponent(subjectId)}`
      else if (mode === 'scope') {
        userQuery = `&targetId=${encodeURIComponent(targetId)}&roleId=${encodeURIComponent(operatorRoleId)}`
      }
      await page.goto(`${origin}${HARNESS_PATH}?harness=${harness}${userQuery}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
      await assertContextToken(page, token, harness)
      return { context, page }
    }

    const admin = await openContext(adminToken, 'admin')
    const subject = await openContext(subjectToken, 'subject')
    adminContext = admin.context
    subjectContext = subject.context
    adminPage = admin.page
    subjectPage = subject.page
    await adminPage.getByTestId('permission-browser-harness-label').waitFor()
    if (mode === 'scope') await subjectPage.getByTestId('subject-delegation').waitFor()
    else await subjectPage.getByTestId('subject-preflight').waitFor()
    let delegationReads = 0

    const gotoAdminHarness = async (harness: 'admin' | 'delegation', extra: string): Promise<void> => {
      await adminPage!.goto(
        `${origin}${HARNESS_PATH}?harness=${harness}${extra}`,
        { waitUntil: 'domcontentloaded', timeout: 120000 },
      )
      await assertContextToken(adminPage!, adminToken, 'admin')
    }

    return {
      adminPage,
      subjectPage,
      mode,
      roleId: operatorRoleId,
      subjectId,
      subjectEmail: `${subjectId}@example.test`,
      targetId,
      targetEmail,
      groupId,
      groupName,
      violations,
      pageErrors,
      mutations: () => mutations.slice(),
      reread,
      async readSubjectPreflight() {
        await assertContextToken(subjectPage!, subjectToken, 'subject')
        preflightReads += 1
        const ticket = String(preflightReads)
        const pending = subjectPage!.waitForResponse(
          (response) => new URL(response.url()).pathname === BUSINESS_PATH,
          { timeout: 30000 },
        )
        await subjectPage!.getByTestId('subject-preflight').click()
        const response = await pending
        const header = response.request().headers().authorization
        if (header !== `Bearer ${subjectToken}`) {
          throw new Error('subject preflight did not use the original auth_token')
        }
        const fields = readPreflightFields(await response.json())
        await subjectPage!.waitForFunction((expected) => {
          return document.querySelector('[data-testid="subject-preflight-done"]')?.textContent === expected
        }, ticket)
        const statusText = (await subjectPage!.getByTestId('subject-preflight-status').innerText()).trim()
        const code = (await subjectPage!.getByTestId('subject-preflight-code').innerText()).trim()
        const readyText = (await subjectPage!.getByTestId('subject-preflight-ready').innerText()).trim()
        const presentText = (await subjectPage!.getByTestId('subject-preflight-ledger-present').innerText()).trim()
        const modeText = (await subjectPage!.getByTestId('subject-preflight-ledger-mode').innerText()).trim()
        const shownReady = readyText === 'true' ? true : readyText === 'false' ? false : null
        const shownPresent = presentText === 'true' ? true : presentText === 'false' ? false : null
        const shownMode = modeText === 'absent' ? null : modeText
        if (statusText !== String(response.status()) || code !== fields.code
          || shownReady !== fields.ready || shownPresent !== fields.ledgerPresent || shownMode !== fields.ledgerMode) {
          throw new Error(`subject harness disagreed with preflight status ${response.status()}`)
        }
        await assertContextToken(subjectPage!, subjectToken, 'subject')
        return { status: response.status(), ...fields }
      },
      async readSubjectDelegation() {
        if (mode !== 'scope' || !targetId) throw new Error('PERMISSION_BROWSER_SCOPE_ONLY')
        await assertContextToken(subjectPage!, subjectToken, 'subject')
        delegationReads += 1
        const ticket = String(delegationReads)
        const delegationPath = `/api/admin/role-delegation/users/${targetId}/roles/assign`
        const pending = subjectPage!.waitForResponse(
          (response) => new URL(response.url()).pathname === delegationPath
            && response.request().method() === 'POST',
          { timeout: 30000 },
        )
        await subjectPage!.getByTestId('subject-delegation').click()
        const response = await pending
        const header = response.request().headers().authorization
        if (header !== `Bearer ${subjectToken}`) {
          throw new Error('subject delegation did not use the original auth_token')
        }
        const fields = readPreflightFields(await response.json())
        await subjectPage!.waitForFunction((expected) => {
          return document.querySelector('[data-testid="subject-delegation-done"]')?.textContent === expected
        }, ticket)
        const statusText = (await subjectPage!.getByTestId('subject-delegation-status').innerText()).trim()
        const code = (await subjectPage!.getByTestId('subject-delegation-code').innerText()).trim()
        if (statusText !== String(response.status()) || code !== fields.code) {
          throw new Error(`subject harness disagreed with delegation status ${response.status()}`)
        }
        await assertContextToken(subjectPage!, subjectToken, 'subject')
        return { status: response.status(), code: fields.code }
      },
      async readScopes() {
        const response = await request(app)
          .get(`/api/admin/role-delegation/users/${subjectId}/scopes`)
          .auth(adminToken, { type: 'bearer' })
        if (response.status !== 200) throw new Error(`PERMISSION_BROWSER_SCOPE_READ_${response.status}`)
        if (!isRecord(response.body) || response.body.ok !== true || !isRecord(response.body.data)) {
          throw new Error('PERMISSION_BROWSER_SCOPE_READ_ENVELOPE')
        }
        const data = response.body.data
        const adminNamespaces = Array.isArray(data.adminNamespaces)
          ? data.adminNamespaces.filter((item: unknown): item is string => typeof item === 'string')
          : []
        const groupIds = Array.isArray(data.groupAssignments)
          ? data.groupAssignments.flatMap((item: unknown) => (
            isRecord(item) && typeof item.groupId === 'string' ? [item.groupId] : []
          ))
          : []
        return { adminNamespaces, groupIds }
      },
      async openUserAdmin() {
        await gotoAdminHarness('admin', `&userId=${encodeURIComponent(subjectId)}`)
        await adminPage!.getByTestId('permission-browser-harness-label').waitFor()
      },
      async openDelegation(userId: string) {
        if (mode !== 'scope') throw new Error('PERMISSION_BROWSER_SCOPE_ONLY')
        await gotoAdminHarness('delegation', `&userId=${encodeURIComponent(userId)}`)
        await adminPage!.getByTestId('scope-explanation').waitFor()
      },
      async subjectTokenUnchanged() {
        const stored = await subjectPage!.evaluate(() => localStorage.getItem('auth_token'))
        const adminStored = await adminPage!.evaluate(() => localStorage.getItem('auth_token'))
        return stored === subjectToken && adminStored === adminToken && stored !== adminStored
      },
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
