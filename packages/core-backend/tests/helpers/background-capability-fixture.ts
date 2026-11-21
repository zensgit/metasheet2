import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'

export const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
export const ORG = 'org-alpha'
export const INPUT = { integrationId: ID, eventOrgId: ORG }
export const SEQUENCE = ['settings', 'xid', 'xid', 'probe', 'integration', 'capability']
export const refusal = (reason: string) => ({ effective: false, reason })
type Row = Record<string, unknown>

export const integrationRow = (overrides: Row = {}): Row => ({
  id: ID, org_id: ORG, provider: 'dingtalk', status: 'active', corp_id: 'CorpOne',
  config: { appKey: 'AppOne' }, ...overrides,
})

export const capabilityRow = (overrides: Row = {}): Row => ({
  integration_id: ID, bound_provider: 'dingtalk', bound_org_id: ORG, revision: '17',
  directory_enabled: false, directory_bound_tenant: null, directory_bound_app_scope: null,
  login_enabled: false, login_bound_tenant: null, login_bound_app_scope: null,
  notification_enabled: true, notification_bound_tenant: 'CorpOne', notification_bound_app_scope: 'AppOne',
  ...overrides,
})

export interface Script {
  settings?: Row[]
  xids?: unknown[]
  probe?: Row[]
  integrations?: Row[]
  capabilities?: Row[]
  /** Malformed-row tests deliberately bypass the real SQL predicate. */
  ignorePair?: boolean
  failAt?: number
  error?: unknown
}

export function scripted(script: Script = {}) {
  const statements: Array<{ kind: string; sql: string; params?: unknown[] }> = []
  let xid = 0
  const executor: Queryable = {
    async query(sql, params) {
      const kind = /current_setting/.test(sql) ? 'settings'
        : /pg_current_xact_id/.test(sql) ? 'xid'
          : /to_regclass/.test(sql) ? 'probe'
            : /FROM directory_integrations\b/.test(sql) ? 'integration'
              : /FROM directory_integration_capabilities\b/.test(sql) ? 'capability' : 'unknown'
      statements.push({ kind, sql, params })
      if (script.failAt === statements.length - 1) throw script.error ?? new Error('query failed')
      let rows: Row[]
      switch (kind) {
        case 'settings': rows = script.settings ?? [{ isolation: 'read committed', lock_timeout_ms: '2000' }]; break
        case 'xid': rows = [{ xid: (script.xids ?? ['71', '71'])[xid++] }]; break
        case 'probe': rows = script.probe ?? [{ capabilities: true, history: true }]; break
        case 'integration': rows = (script.integrations ?? [integrationRow()]).filter((row) =>
          script.ignorePair || (row.id === params?.[0] && row.org_id === params?.[1])); break
        case 'capability': rows = script.capabilities ?? [capabilityRow()]; break
        default: throw new Error('unexpected statement')
      }
      return { rows, rowCount: rows.length }
    },
  }
  return { executor, statements }
}
