import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { ownerOffDraftBody } from './stock-preparation-yida-owner-off-full-app'

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
type Data = Record<string, unknown>
function data(value: unknown): Data {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_YIDA_AUTO_MAIN_OBJECT_REQUIRED')
  return value as Data
}

/** Called only inside the original isolated, migrated, configured main app.
 * No router, principal, resolver, plugin capability, consumer or sender is
 * replaced. Its owner's token comes from the original password login. All
 * material was created by the preceding real initialization UI. Send stays OFF.
 * This is not the new finite-authorization browser journey. */
export async function verifyYidaAutomationMainDefaultOff(input: {
  origin: string; ownerToken: string; ownerId: string; tenantId: string; sheetId: string
  currentProjectNo: string; operationId: string; rowKeys: readonly string[]; query: Query
  hashPassword(password: string): Promise<string>
}) {
  const { origin, ownerToken, query } = input
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED), 'APP_YIDA_AUTO_MAIN_OFF_REQUIRED')
  assert([undefined, 'false'].includes(process.env.INTEGRATION_YIDA_OWNER_SEND_ENABLED), 'APP_YIDA_AUTO_OWNER_OFF_REQUIRED')
  assert.equal(new URL(origin).hostname, '127.0.0.1')
  const prefix = '/api/integration/yida-automation-authorizations'
  const headers = (token: string | null) => ({ 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) })
  async function http(method: 'GET' | 'POST', route: string, body?: unknown, token: string | null = ownerToken,
    extra: Record<string, string> = {}) {
    const response = await fetch(origin + route, { method, headers: { ...headers(token), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(10000) })
    // Drain the ORIGINAL body before asserting a status; this is not a receipt
    // fabricated from REQUEST_FINISHED, and no raw response is published.
    const payload: unknown = await response.json()
    return { status: response.status, body: data(payload), noStore: response.headers.get('cache-control') === 'no-store' }
  }
  const counts = async () => (await query(`SELECT
    (SELECT count(*)::int FROM integration_yida_auto_grants) AS grants,
    (SELECT count(*)::int FROM integration_yida_auto_requests) AS requests,
    (SELECT count(*)::int FROM integration_yida_auto_admissions) AS admissions,
    (SELECT count(*)::int FROM integration_yida_delivery_ledger) AS ledgers,
    (SELECT count(*)::int FROM integration_yida_auto_outbox_links) AS links`)).rows[0]
  assert.deepEqual(await counts(), { grants: 0, requests: 0, admissions: 0, ledgers: 0, links: 0 })
  const slot = randomUUID()
  const saved = await http('POST', `/api/multitable/sheets/${encodeURIComponent(input.sheetId)}/automations`, {
    name: 'Synthetic full-app finite YiDa', enabled: true, triggerType: 'schedule.interval', triggerConfig: { intervalMs: 60000 },
    actionType: 'integration_yida_send_authorized', actionConfig: { authorizationSlot: slot },
    actions: null, conditions: null, executionMode: 'legacy',
  })
  assert.equal(saved.status, 200, 'APP_YIDA_AUTO_MAIN_RULE_HTTP_REQUIRED')
  const rule = data(data(saved.body.data).rule)
  assert.equal(rule.actionType, 'integration_yida_send_authorized')
  assert.equal(rule.createdBy, input.ownerId)
  assert.equal(typeof rule.id, 'string')
  assert.match(String(rule.integrationAuthorityRevision), /^[a-f0-9-]{36}$/u)
  const stored = (await query('SELECT integration_authority_revision::text AS revision FROM automation_rules WHERE id=$1', [rule.id])).rows
  assert.deepEqual(stored, [{ revision: rule.integrationAuthorityRevision }])
  const listed = await http('GET', `/api/multitable/sheets/${encodeURIComponent(input.sheetId)}/automations`)
  assert.equal(listed.status, 200)
  const listedRules = data(listed.body.data).rules
  assert(Array.isArray(listedRules) && listedRules.some(value => {
    const row = data(value); return row.id === rule.id && row.integrationAuthorityRevision === rule.integrationAuthorityRevision
  }), 'APP_YIDA_AUTO_MAIN_RULE_VERSION_READ_REQUIRED')
  // Check actual durable member handles, then use the original synthetic input's
  // project as an untrusted consent claim. The REAL host must reload/decrypt
  // that operation and validate membership; this fixture mints no selection proof.
  const rows = (await query('SELECT row_key FROM integration_yida_draft_rows WHERE operation_id=$1 ORDER BY ordinal', [input.operationId])).rows
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.row_key), input.rowKeys)
  const originalRows = JSON.parse(ownerOffDraftBody().rowsText) as unknown[]
  const projectNo = data(originalRows[0]).projectNo
  assert.equal(typeof projectNo, 'string'); assert(originalRows.every(row => data(row).projectNo === projectNo))
  assert.notEqual(projectNo, input.currentProjectNo, 'APP_YIDA_AUTO_MAIN_PROJECT_NEGATIVE_REQUIRED')
  const consent = { confirmationId: randomUUID(), ruleId: rule.id, expectedRuleRevision: rule.integrationAuthorityRevision,
    actionId: slot, projectNo, operationId: input.operationId, rowKeys: [...input.rowKeys],
    allowedTriggers: ['manual'], maxExecutions: 2, ttlMs: 900000 }
  const negatives = [
    await http('POST', prefix, consent, null),
    await http('POST', prefix, consent, 'synthetic-invalid-jwt'),
    await http('POST', prefix, { ...consent, tenantId: input.tenantId }),
    await http('POST', prefix, consent, ownerToken, { 'x-tenant-id': input.tenantId }),
    await http('POST', prefix, { ...consent, expectedRuleRevision: randomUUID() }),
    await http('POST', prefix, { ...consent, projectNo: input.currentProjectNo }),
  ]
  assert.deepEqual(negatives.map(item => item.status), [401, 401, 400, 400, 403, 403], 'APP_YIDA_AUTO_MAIN_NEGATIVE_HTTP_REQUIRED')
  assert.deepEqual(await counts(), { grants: 0, requests: 0, admissions: 0, ledgers: 0, links: 0 })
  const approved = await http('POST', prefix, consent)
  assert.equal(approved.status, 201, 'APP_YIDA_AUTO_MAIN_CREATE_REQUIRED'); assert.equal(approved.noStore, true)
  const grant = data(approved.body.data), grantId = grant.grantId
  assert.equal(typeof grantId, 'string'); assert.equal(grant.canSend, false); assert.equal(grant.maxExecutions, 2)
  const replay = await http('POST', prefix, consent)
  assert.equal(replay.status, 200); assert.equal(data(replay.body.data).grantId, grantId)
  assert.equal(data(replay.body.data).reused, true)
  // Two genuine password-logins: a different same-tenant administrator and a
  // different-tenant administrator. Neither receives an owner/admin bypass.
  for (const tenant of [input.tenantId, randomUUID()]) {
    const id = randomUUID(), identifier = `synthetic-yida-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('base64url')
    await query(`INSERT INTO users(id,email,name,password_hash,role,permissions,is_active,must_change_password,activation_status,local_password_set)
      VALUES($1,$2,'Synthetic YiDa negative administrator',$3,'admin','[]'::jsonb,true,false,'activated',true)`,
    [id, identifier, await input.hashPassword(password)])
    await query('INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,$2,true)', [id, tenant])
    await query("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [id])
    const login = await http('POST', '/api/auth/login', { identifier, password }, null)
    assert.equal(login.status, 200)
    const session = data(login.body.data), user = data(session.user)
    assert.equal(user.id, id); assert.equal(user.tenantId, tenant); assert.equal(typeof session.token, 'string')
    assert.equal((await http('GET', prefix + '/' + grantId, undefined, session.token as string)).status, 403)
    assert.equal((await http('POST', prefix + '/' + grantId + '/revoke', {}, session.token as string)).status, 403)
  }
  const requestKey = randomUUID()
  const accepted = await http('POST', prefix + '/' + grantId + '/requests', { requestKey })
  assert.equal(accepted.status, 202, 'APP_YIDA_AUTO_MAIN_QUEUE_REQUIRED')
  const reservation = data(accepted.body.data)
  assert.equal(reservation.deliveryQueued, true); assert.equal(reservation.canSend, false)
  const repeated = await http('POST', prefix + '/' + grantId + '/requests', { requestKey })
  assert.equal(repeated.status, 200); assert.equal(data(repeated.body.data).requestId, reservation.requestId)
  let observedTick = false
  const deadline = performance.now() + 8000
  while (performance.now() < deadline) {
    const consumer = (await query(`SELECT c.attempts FROM integration_yida_auto_outbox_links l
      JOIN meta_automation_outbox_consumer c ON c.outbox_id=l.outbox_id AND c.consumer_key=l.consumer_key
      WHERE l.grant_id=$1 AND l.request_id=$2`, [grantId, reservation.requestId])).rows
    if (consumer.length === 1 && Number(consumer[0].attempts) > 0) { observedTick = true; break }
    await delay(100)
  }
  assert(observedTick, 'APP_YIDA_AUTO_MAIN_ACTUAL_LOOP_REQUIRED')
  assert.deepEqual(await counts(), { grants: 1, requests: 1, admissions: 0, ledgers: 0, links: 1 })
  const observed = await http('GET', prefix + '/' + grantId)
  assert.equal(observed.status, 200)
  assert.equal(data(observed.body.data).usedExecutions, 0)
  const revoked = await http('POST', prefix + '/' + grantId + '/revoke', {})
  assert.equal(revoked.status, 200); assert.equal(data(revoked.body.data).revoked, true)
  assert.equal((await http('POST', prefix + '/' + grantId + '/requests', { requestKey: randomUUID() })).status, 403)
  assert.deepEqual(await counts(), { grants: 1, requests: 1, admissions: 0, ledgers: 0, links: 1 })
  return Object.freeze({ realMain: true, realPasswordJwt: true, installedPlugin: true, ruleVersionRoundTrip: true,
    refusedProjectMismatch: true, refusedVersionMismatch: true, refusedScopeClaims: true,
    refusedForeignOwnerAndTenant: true, originalLoopObserved: true, originalRequestReplay: true,
    originalRevocation: true, defaultOff: true, grants: 1, requests: 1, admissions: 0, ledgers: 0,
    externalSend: false, newSa06dBrowserProof: false })
}
