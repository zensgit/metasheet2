import { transaction } from '../db/pg'
import type { StrictLoginGrantCaller } from './strict-login-grant-store'

export type DingTalkLoginSource = Readonly<{
  connectionId: string | null
  corpId: string | null
  orgId: string | null
  appKey: string
  configuredCorp: string | null
  explicit: boolean
  strict: boolean
}>

type Selector = { connectionId?: unknown; corpId?: unknown }
type Environment = Readonly<Record<string, string | undefined>>

export class DingTalkSourceError extends Error {
  readonly code: string
  constructor(readonly statusCode: 403 | 503) {
    super(statusCode === 403
      ? 'DingTalk login is not eligible for this source'
      : 'DingTalk login authorization is unavailable')
    this.code = statusCode === 403 ? 'strict_connection' : 'grant_state_unavailable'
  }
}

export function refuseDingTalkSource(): never {
  throw new DingTalkSourceError(403)
}

function checkedSelector(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value || value !== value.trim()) refuseDingTalkSource()
  return value
}

async function readSource<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof DingTalkSourceError) throw error
    throw new DingTalkSourceError(503)
  }
}

export async function checkEmptyDingTalkScope(client: StrictLoginGrantCaller): Promise<void> {
  await readSource(async () => {
    const { lockEmptyConnectionLoginScope } = await import('./strict-login-grant-store')
    if (!await lockEmptyConnectionLoginScope(client)) refuseDingTalkSource()
  })
}

export function resolveDingTalkLoginSource(
  selector: Selector = {},
  env: Environment = process.env,
): Promise<DingTalkLoginSource> {
  const id = checkedSelector(selector.connectionId)
  const corp = checkedSelector(selector.corpId)
  const appKey = env.DINGTALK_CLIENT_ID?.trim() || env.DINGTALK_APP_KEY?.trim() || ''
  const configuredCorp = env.DINGTALK_CORP_ID?.trim() || null
  if (corp && configuredCorp && corp !== configuredCorp) refuseDingTalkSource()
  return readSource(() => transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    // Select with the server's exchange application before applying a caller's selectors.
    const result = await client.query(
      `SELECT id::text, org_id, corp_id, status FROM directory_integrations
        WHERE provider = 'dingtalk' AND config->>'appKey' = $1
          AND ($2::text IS NULL OR corp_id = $2)
        ORDER BY id LIMIT 2`,
      [appKey, configuredCorp],
    )
    const rows = result.rows
    const explicit = id !== undefined || corp !== undefined
    const row = rows.length === 1 ? rows[0] : undefined
    if (row && appKey && (row.status !== 'active' || !row.corp_id || !row.org_id)) refuseDingTalkSource()
    if (!row || row.status !== 'active' || !row.corp_id || !row.org_id || !appKey) {
      if (explicit) refuseDingTalkSource()
      await checkEmptyDingTalkScope(client)
      return { connectionId: null, orgId: null, corpId: configuredCorp, appKey, configuredCorp, explicit, strict: false }
    }
    if ((id && row.id !== id) || (corp && row.corp_id !== corp)) refuseDingTalkSource()
    const { readConnectionLoginScope } = await import('./strict-login-grant-store')
    const state = await readConnectionLoginScope(client, row.id)
    return { connectionId: row.id, corpId: row.corp_id, orgId: row.org_id, appKey, configuredCorp, explicit, strict: state.scope !== null }
  }))
}

export async function checkOrdinaryDingTalkSource(client: StrictLoginGrantCaller, source: DingTalkLoginSource): Promise<void> {
  if (source.strict) refuseDingTalkSource()
  if (source.connectionId === null) return readSource(async () => {
    const result = await client.query(
      `SELECT id::text, org_id, corp_id, status FROM directory_integrations
        WHERE provider = 'dingtalk' AND config->>'appKey' = $1
          AND ($2::text IS NULL OR corp_id = $2)
        ORDER BY id LIMIT 2`,
      [source.appKey, source.configuredCorp],
    )
    const row = result.rows.length === 1 ? result.rows[0] : undefined
    if (row && source.appKey && (row.status !== 'active' || !row.corp_id || !row.org_id)) refuseDingTalkSource()
    await checkEmptyDingTalkScope(client)
  })
  await readSource(async () => {
    const current = await client.query(
      `SELECT id FROM directory_integrations WHERE id = $1::uuid AND provider = 'dingtalk'
          AND status = 'active' AND org_id = $2 AND corp_id = $3 AND config->>'appKey' = $4
          AND NOT EXISTS (
            SELECT 1 FROM directory_integrations other
             WHERE other.id <> $1::uuid AND other.provider = 'dingtalk' AND other.config->>'appKey' = $4
               AND ($5::text IS NULL OR other.corp_id = $5)
          ) FOR SHARE`,
      [source.connectionId, source.orgId, source.corpId, source.appKey, source.configuredCorp],
    )
    if (current.rows.length !== 1) refuseDingTalkSource()
    const { readConnectionLoginScope } = await import('./strict-login-grant-store')
    if ((await readConnectionLoginScope(client, source.connectionId)).scope) refuseDingTalkSource()
  })
}
