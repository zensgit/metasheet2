import { createHash } from 'node:crypto'
import { query, transaction } from '../db/pg'
import { acquireSourceSyncFreezeLock } from './source-sync-freeze-lock'

type Client = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }
type Scope = 'integration' | 'enterprise'

export class DirectoryConnectionError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code)
    this.name = 'DirectoryConnectionError'
  }
}

function scopeValue(value: unknown): Scope {
  if (value !== 'integration' && value !== 'enterprise') {
    throw new DirectoryConnectionError('DIRECTORY_DISABLE_SCOPE_INVALID', 400)
  }
  return value
}

async function targets(client: Client, integrationId: string, scope: Scope) {
  const source = await client.query(
    `SELECT id, org_id, corp_id FROM directory_integrations WHERE id = $1 AND provider = 'dingtalk'`, [integrationId],
  )
  const row = source.rows[0]
  if (!row) throw new DirectoryConnectionError('DIRECTORY_CONNECTION_NOT_FOUND', 404)
  if (scope === 'enterprise' && (!String(row.org_id ?? '').trim() || !String(row.corp_id ?? '').trim())) {
    throw new DirectoryConnectionError('DIRECTORY_ENTERPRISE_ID_UNRESOLVED', 409)
  }
  const result = await client.query(
    `SELECT id, config->>'appKey' AS app_key, config->'connectionDisabled' = 'true'::jsonb AS disabled,
            (config IS NULL OR jsonb_typeof(config) = 'object') AS config_valid
       FROM directory_integrations
      WHERE provider = 'dingtalk' AND org_id = $1 AND corp_id = $2
        AND ($3 = 'enterprise' OR id = $4::uuid)
      ORDER BY id`, [row.org_id, row.corp_id, scope, integrationId],
  )
  return { ...result, orgId: String(row.org_id), corpId: String(row.corp_id) }
}

export async function previewDirectoryConnectionDisable(integrationId: string, scope: unknown) {
  const result = await targets({ query }, integrationId, scopeValue(scope))
  return { integrationCount: result.rows.length, disabledCount: result.rows.filter((row) => row.disabled === true).length }
}

export async function disableDirectoryConnection(integrationId: string, rawScope: unknown) {
  const scope = scopeValue(rawScope)
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await client.query("SET LOCAL lock_timeout = '5s'")
    const result = await targets(client, integrationId, scope)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [enterpriseLockKey(result.orgId, result.corpId)])
    const selected = await targets(client, integrationId, scope)
    const ids = selected.rows.map((row) => String(row.id))
    const selectedKeys = [...new Set(selected.rows.map((row) => String(row.app_key ?? '')).filter(Boolean))].sort()
    for (const key of selectedKeys) await lockApp(client, key)
    for (const id of ids) await acquireSourceSyncFreezeLock(client, id)
    const fresh = await targets(client, integrationId, scope)
    if (fresh.orgId !== result.orgId || fresh.corpId !== result.corpId || JSON.stringify(fresh.rows.map((row) => String(row.id))) !== JSON.stringify(ids)) {
      throw new DirectoryConnectionError('DIRECTORY_CONNECTION_CHANGED', 409)
    }
    if (fresh.rows.some((row) => row.config_valid === false)) throw new DirectoryConnectionError('DIRECTORY_CONNECTION_CONFIG_INVALID', 409)
    const keys = fresh.rows.map((row) => String(row.app_key ?? '')).filter(Boolean)
    const shared = await client.query(
      `SELECT 1 FROM directory_integrations
        WHERE provider = 'dingtalk' AND NOT (id = ANY($1::uuid[]))
          AND config->>'appKey' = ANY($2::text[]) LIMIT 1`, [ids, keys],
    )
    if (shared.rows.length) throw new DirectoryConnectionError('DIRECTORY_CONNECTION_APP_SHARED', 409)
    await client.query(
      `UPDATE directory_integrations
          SET config = COALESCE(config, '{}'::jsonb) || jsonb_build_object('connectionDisabled', true, 'connectionDisabledAppKey', config->>'appKey')
                || CASE WHEN $2 = 'enterprise' THEN '{"enterpriseConnectionDisabled":true}'::jsonb ELSE '{}'::jsonb END,
              sync_enabled = FALSE, updated_at = NOW()
        WHERE id = ANY($1::uuid[]) AND provider = 'dingtalk'`, [ids, scope],
    )
    return { integrationIds: ids, disabled: true as const }
  }).catch(connectionConflict)
}

export async function assertDirectoryConnectionEnabled(integrationId: string, client: Client = { query }) {
  const result = await client.query(
    `SELECT config->'connectionDisabled' = 'true'::jsonb AS disabled
       FROM directory_integrations WHERE id = $1 AND provider = 'dingtalk'`, [integrationId],
  )
  if (!result.rows.length) throw new DirectoryConnectionError('DIRECTORY_CONNECTION_NOT_FOUND', 404)
  if (result.rows[0].disabled === true) throw new DirectoryConnectionError('DIRECTORY_CONNECTION_DISABLED', 409)
}

/** Serialize registered-app egress against disable; the callback must encompass the actual HTTP attempt(s). */
export async function withDingTalkConnectionOperation<T>(appKey: string | undefined, operation: () => Promise<T>): Promise<T> {
  let operationStarted = false
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await client.query("SET LOCAL lock_timeout = '5s'")
    if (appKey) await lockApp(client, appKey)
    const result = await client.query(
      `SELECT id FROM directory_integrations
        WHERE provider = 'dingtalk'
          AND (($1 <> '' AND (config->>'appKey' = $1 OR config->>'connectionDisabledAppKey' = $1))
            OR ($1 = '' AND config->'connectionDisabled' = 'true'::jsonb)) ORDER BY id`, [appKey ?? ''],
    )
    if (!appKey && result.rows.length) throw new DirectoryConnectionError('DIRECTORY_CONNECTION_SCOPE_REQUIRED', 409)
    if (appKey && result.rows.length === 0) {
      const stopped = await client.query(
        `SELECT 1 FROM directory_integrations WHERE provider = 'dingtalk'
          AND config->'connectionDisabled' = 'true'::jsonb LIMIT 1`,
      )
      if (stopped.rows.length) throw new DirectoryConnectionError('DIRECTORY_CONNECTION_SCOPE_REQUIRED', 409)
    }
    for (const row of result.rows) await acquireSourceSyncFreezeLock(client, String(row.id))
    for (const row of result.rows) await assertDirectoryConnectionEnabled(String(row.id), client)
    operationStarted = true
    return operation()
  }).catch((error: unknown) => {
    if (!operationStarted && !(error instanceof DirectoryConnectionError)) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') connectionConflict(error)
      throw new DirectoryConnectionError('DIRECTORY_CONNECTION_STATE_UNAVAILABLE', 503)
    }
    connectionConflict(error)
  })
}

function enterpriseLockKey(orgId: string, corpId: string) {
  return JSON.stringify(['directory-connection-enterprise', orgId, corpId])
}

/** New connections must not bypass an enterprise stop; uses the same scope lock as disable. */
export async function withDirectoryEnterpriseRegistration<T>(orgId: string, corpId: string, appKey: string, create: () => Promise<T>): Promise<T> {
  return transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [enterpriseLockKey(orgId, corpId)])
    await lockApp(client, appKey)
    const stopped = await client.query(
      `SELECT 1 FROM directory_integrations WHERE provider = 'dingtalk'
        AND ((org_id = $1 AND corp_id = $2 AND config->'enterpriseConnectionDisabled' = 'true'::jsonb)
          OR (config->'connectionDisabled' = 'true'::jsonb AND (config->>'appKey' = $3 OR config->>'connectionDisabledAppKey' = $3))) LIMIT 1`, [orgId, corpId, appKey],
    )
    if (stopped.rows.length) throw new DirectoryConnectionError('DIRECTORY_ENTERPRISE_CONNECTION_DISABLED', 409)
    return create()
  }).catch(connectionConflict)
}

function connectionConflict(error: unknown): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') {
    throw new DirectoryConnectionError('DIRECTORY_CONNECTION_BUSY', 409)
  }
  throw error
}

async function lockApp(client: Client, appKey: string) {
  const key = createHash('sha256').update(appKey).digest('hex')
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`directory-connection-app:${key}`])
}
