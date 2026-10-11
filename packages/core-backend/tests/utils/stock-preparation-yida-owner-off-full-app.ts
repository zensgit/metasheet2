import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual, types } from 'node:util'
import type { Page, Request, Response } from '@playwright/test'
import { createYidaProtocolExample, validateYidaStaticConfig } from '../../../../plugins/plugin-integration-core/lib/yida-static-plan.mjs'

export const ownerOffPrefix = '/api/integration/yida-owner-send'
const serverIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const disabledEnvelope = { ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } }
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error('APP_BROWSER_YIDA_OWNER_OFF_' + code)
}
export function ownerOffDraftBody() {
  const example = createYidaProtocolExample('primary')
  const validated = validateYidaStaticConfig(example.config)
  check(validated.valid && validated.normalized, 'SYNTHETIC_CONFIG_REQUIRED')
  return { config: validated.normalized, rowsText: example.text, allocation: { mode: 'original' } }
}

/** One closed request/response window; never extends the general API allowlist. */
export function createYidaOwnerOffWindow(origin: string, token: string) {
  const counts = { ownerPosts: 0, ownerResponses: 0, backgroundOverviewRequests: 0,
    openingBusinessRequests: 0, otherBusinessRequests: 0, externalRequests: 0, expectedConsoleErrors: 0 }
  let armed = false
  let accepted: Request | undefined
  let serverCorrelationId = ''
  let responseStatusChecked = false
  return {
    counts,
    arm() { check(!armed && !accepted, 'DRAFT_ALREADY_ARMED'); armed = true },
    acceptRequest(request: Request) {
      const target = new URL(request.url()), headers = request.headers()
      if (!armed && !accepted) counts.openingBusinessRequests += 1
      check(armed && !accepted && target.origin === origin && target.pathname === ownerOffPrefix + '/drafts'
        && target.search === '' && request.method() === 'POST'
        && isDeepStrictEqual(request.postDataJSON(), ownerOffDraftBody()), 'EXACT_ARMED_DRAFT_REQUIRED')
      check(headers.authorization === 'Bearer ' + token && headers['content-type'] === 'application/json'
        && !['cookie', 'x-tenant-id', 'x-workspace-id', 'x-user-role', 'x-permissions'].some(key => key in headers),
      'CAPTURED_SESSION_ONLY_REQUIRED')
      armed = false; accepted = request; counts.ownerPosts += 1
    },
    async acceptResponse(response: Response) {
      check(response.request() === accepted && counts.ownerResponses === 0, 'EXACT_RESPONSE_IDENTITY_REQUIRED')
      check(response.status() === 403, 'EXACT_DISABLED_STATUS_REQUIRED')
      responseStatusChecked = true
      check(isDeepStrictEqual(await response.json(), disabledEnvelope), 'EXACT_DISABLED_RESPONSE_REQUIRED')
      const headers = response.headers(), id = headers['x-correlation-id']
      check(headers['cache-control'] === 'no-store' && headers['x-content-type-options'] === 'nosniff'
        && typeof id === 'string' && serverIdPattern.test(id), 'PRIVATE_RESPONSE_HEADERS_REQUIRED')
      serverCorrelationId = id; counts.ownerResponses += 1
    },
    consoleRefusal(url: string, text: string) {
      if (accepted && responseStatusChecked && url === origin + ownerOffPrefix + '/drafts'
        && text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)') {
        counts.expectedConsoleErrors += 1
        check(counts.expectedConsoleErrors <= 1, 'DUPLICATE_REFUSAL_CONSOLE_ERROR')
        return true
      }
      return false
    },
    result() {
      check(!armed && counts.ownerPosts === 1 && counts.ownerResponses === 1 && serverCorrelationId,
        'ONE_REAL_DISABLED_DRAFT_REQUIRED')
      check(counts.openingBusinessRequests === 0 && counts.otherBusinessRequests === 0 && counts.externalRequests === 0,
        'NO_OTHER_BUSINESS_REQUESTS_REQUIRED')
      return { counts: { ...counts }, serverCorrelationId }
    },
  }
}
export type YidaOwnerOffWindow = ReturnType<typeof createYidaOwnerOffWindow>

export async function runConfiguredYidaOwnerOffBrowser(page: Page, window: YidaOwnerOffWindow,
  settled: () => Promise<void>) {
  const panel = page.getByTestId('stock-prep-yida-preview-panel')
  await panel.getByTestId('sp-yida-preview-mode').selectOption('protocol')
  await panel.getByTestId('sp-yida-protocol-example-primary').click()
  await panel.getByTestId('sp-yida-run').click()
  await panel.getByTestId('sp-yida-summary').waitFor()
  check(await panel.getByTestId('sp-yida-summary').innerText()
    === '共 2 行；计划创建 2；计划更新 0；无效 0；本地重复键 0。', 'REAL_PRIMARY_PREVIEW_REQUIRED')
  await panel.getByTestId('sp-yida-owner-open').click()
  const owner = page.getByTestId('stock-prep-yida-owner-send-panel')
  await owner.waitFor()
  await settled()
  check(window.counts.ownerPosts === 0 && window.counts.otherBusinessRequests === 0,
    'OPENING_MUST_NOT_REQUEST_BUSINESS_API')
  check(await owner.getByTestId('sp-yida-owner-save').isEnabled(), 'REAL_SDK_SAVE_MUST_BE_ENABLED')
  window.arm()
  await owner.getByTestId('sp-yida-owner-save').click()
  await owner.getByTestId('sp-yida-owner-error').filter({ hasText: 'YIDA_OWNER_RUNTIME_DISABLED' }).waitFor()
  await owner.getByTestId('sp-yida-owner-disabled').waitFor()
  await settled()
  check(await owner.getByTestId('sp-yida-owner-error').innerText() === 'YIDA_OWNER_RUNTIME_DISABLED'
    && !await owner.getByTestId('sp-yida-owner-save').isEnabled(), 'ERROR_RETAINED_AND_RETRY_DISABLED_REQUIRED')
  for (const testId of ['sp-yida-owner-draft', 'sp-yida-owner-confirmation', 'sp-yida-owner-grant',
    'sp-yida-owner-preview', 'sp-yida-owner-approve', 'sp-yida-owner-submit']) {
    check(await owner.getByTestId(testId).count() === 0, 'NO_DRAFT_GRANT_OR_CONTINUATION_REQUIRED')
  }
  // Re-settle actual transports; no fabricated response, JS click, timer or retry.
  await settled()
  return { ...window.result(), evidence: { parentPrimaryPreview: true, openingNoBusinessRequests: true,
    realSdkDraftPost: true, exactDisabled403: true, noTargetOperationOrGrant: true,
    errorRetained: true, retryDisabled: true, approvalAndSubmissionAbsent: true }, previewRuns: 1 }
}

/** Closed durable table inventory; counts expose no stored values. */
export const ownerOffTables = [
  'integration_yida_credential_materials', 'integration_yida_credential_audit',
  'integration_yida_draft_targets', 'integration_yida_draft_operations', 'integration_yida_draft_rows', 'integration_yida_draft_audit',
  'integration_yida_approved_target', 'integration_yida_approved_target_audit',
  'integration_yida_send_approvals', 'integration_yida_send_revocations', 'integration_yida_send_admissions', 'integration_yida_send_approval_audit',
  'integration_yida_delivery_ledger', 'integration_yida_delivery_audit',
] as const
/** Transparent observation of the shared native pg query path. This finite SQL
 * census is acceptance evidence for these fixtures, not a SQL authorization policy. */
export function observeYidaOwnerOffQueries(client: { prototype: object }) {
  const descriptor = Object.getOwnPropertyDescriptor(client.prototype, 'query')
  assert(descriptor && typeof descriptor.value === 'function' && descriptor.configurable,
    'APP_YIDA_OWNER_OFF_NATIVE_QUERY_REQUIRED')
  const original = descriptor.value
  const scopes = new AsyncLocalStorage<'census' | 'positive-control'>()
  const tables = ownerOffTables.map(table => new RegExp('\\b' + table + '\\b', 'iu'))
  const counts = { ownerTableQueryAttempts: 0, ownerTableWriteAttempts: 0 }
  const controlCounts = { queries: 0, writes: 0 }
  let positiveControlVerified = false
  let restored = false
  const wrapper = function (this: unknown, ...args: unknown[]) {
    const scope = scopes.getStore()
    if (!restored && scope !== 'census') {
      const first = args[0]
      const sql = typeof first === 'string' ? first : first && typeof first === 'object' && !types.isProxy(first)
        ? Object.getOwnPropertyDescriptor(first, 'text')?.value : undefined
      if (typeof sql === 'string' && tables.some(table => table.test(sql))) {
        const write = /\b(?:insert|update|delete|truncate|merge|copy|create|alter|drop|call|do)\b/iu.test(sql)
        if (scope === 'positive-control') { controlCounts.queries += 1; if (write) controlCounts.writes += 1 }
        else { counts.ownerTableQueryAttempts += 1; if (write) counts.ownerTableWriteAttempts += 1 }
      }
    }
    return Reflect.apply(original, this, args)
  }
  Object.defineProperty(client.prototype, 'query', { ...descriptor, value: wrapper })
  return {
    suspend<T>(work: () => T): T { return scopes.run('census', work) },
    async positiveControl(work: () => Promise<unknown>) {
      assert(!positiveControlVerified && controlCounts.queries === 0, 'APP_YIDA_OWNER_OFF_NATIVE_QUERY_CONTROL_DUPLICATE')
      await scopes.run('positive-control', work)
      assert.deepEqual(controlCounts, { queries: 1, writes: 0 }, 'APP_YIDA_OWNER_OFF_NATIVE_QUERY_CONTROL_REQUIRED')
      positiveControlVerified = true
    },
    verify() {
      assert.deepEqual(counts, { ownerTableQueryAttempts: 0, ownerTableWriteAttempts: 0 }, 'APP_YIDA_OWNER_OFF_QUERY_ATTEMPT_FORBIDDEN')
      assert(positiveControlVerified, 'APP_YIDA_OWNER_OFF_NATIVE_QUERY_CONTROL_REQUIRED')
      return { ...counts, nativeQueryPositiveControl: true }
    },
    restore() {
      if (restored) return
      assert.equal(Object.getOwnPropertyDescriptor(client.prototype, 'query')?.value, wrapper,
        'APP_YIDA_OWNER_OFF_QUERY_OBSERVER_CHANGED')
      Object.defineProperty(client.prototype, 'query', descriptor)
      restored = true
      // Existing Automation observers may have captured this wrapper as their
      // original client-own method. It remains a completely inactive native
      // forwarder there; this observer never changes their client-own identity.
    },
  }
}
export async function ownerOffDatabaseCounts(query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>) {
  const counts = []
  for (const table of ownerOffTables) {
    const result = await query(`SELECT count(*)::int AS count FROM ${table}`)
    assert.equal(result.rows.length, 1, 'APP_YIDA_OWNER_OFF_COUNT_REQUIRED')
    assert.equal(result.rows[0].count, 0, 'APP_YIDA_OWNER_OFF_DURABLE_ROWS_FORBIDDEN')
    counts.push(result.rows[0].count)
  }
  return counts
}

/** Existing routes on the real logged-in host. Opaque markers stay private. */
export async function probeYidaOwnerOffLogs(origin: string, token: string) {
  const marker = () => 'SYN_PRIVATE_' + randomBytes(20).toString('hex')
  const sentinels: string[] = [], serverIds: string[] = []
  const cases = [
    { kind: 'draft', method: 'POST', status: 403, code: 'YIDA_OWNER_RUNTIME_DISABLED' },
    { kind: 'dynamic', method: 'POST', status: 400, code: 'YIDA_OWNER_HTTP_INPUT' },
    { kind: 'unknown', method: 'POST', status: 404, code: 'NOT_FOUND' },
  ] as const
  for (const item of cases) {
    const clientCorrelation = marker(), clientRequest = marker(), body = marker()
    const path = item.kind === 'draft' ? '' : marker(), query = item.kind === 'draft' ? '' : marker()
    sentinels.push(clientCorrelation, clientRequest, body, ...(item.kind === 'draft' ? [] : [path, query]))
    const suffix = item.kind === 'draft' ? '/drafts'
      : item.kind === 'dynamic' ? '/approvals/' + path + '/revoke?private=' + query : '/' + path + '?private=' + query
    const response = await fetch(origin + ownerOffPrefix + suffix, { method: item.method, redirect: 'error',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'x-correlation-id': clientCorrelation, 'x-request-id': clientRequest },
      ...(item.method === 'POST' ? { body: JSON.stringify({ ...ownerOffDraftBody(), rowsText: body }) } : {}),
      signal: AbortSignal.timeout(10000) })
    assert.equal(response.status, item.status, 'APP_YIDA_OWNER_OFF_LOG_HTTP_STATUS')
    assert.deepEqual(await response.json(), { ok: false, error: { code: item.code } }, 'APP_YIDA_OWNER_OFF_LOG_ENVELOPE')
    assert.equal(response.headers.get('cache-control'), 'no-store', 'APP_YIDA_OWNER_OFF_LOG_NO_STORE')
    const serverId = response.headers.get('x-correlation-id')
    assert(serverId && serverIdPattern.test(serverId) && serverId !== clientCorrelation && serverId !== clientRequest,
      'APP_YIDA_OWNER_OFF_SERVER_CORRELATION_REQUIRED')
    serverIds.push(serverId)
  }
  assert.equal(new Set(sentinels).size, 13, 'APP_YIDA_OWNER_OFF_DISTINCT_SENTINELS_REQUIRED')
  assert.equal(new Set(serverIds).size, 3, 'APP_YIDA_OWNER_OFF_DISTINCT_SERVER_IDS_REQUIRED')
  const positiveId = 'SYN_PUBLIC_' + randomBytes(20).toString('hex')
  const positive = await fetch(origin + '/api/method-probe', { method: 'DELETE', redirect: 'error',
    headers: { authorization: 'Bearer ' + token, 'x-correlation-id': positiveId, 'x-request-id': positiveId },
    signal: AbortSignal.timeout(10000) })
  assert.equal(positive.status, 200, 'APP_YIDA_OWNER_OFF_ORDINARY_HTTP_STATUS')
  assert.deepEqual(await positive.json(), { ok: true, method: 'DELETE', overridden: false }, 'APP_YIDA_OWNER_OFF_ORDINARY_HTTP_ENVELOPE')
  assert.equal(positive.headers.get('x-correlation-id'), positiveId, 'APP_YIDA_OWNER_OFF_ORDINARY_CORRELATION_CHANGED')
  return { serverIds, sentinels, positiveId }
}
