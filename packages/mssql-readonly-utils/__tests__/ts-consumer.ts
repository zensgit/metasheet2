import {
  buildGenericWhereClause,
  buildLegacyTlsOptions,
  buildSimpleSelectQuery,
  normalizeLimit,
  normalizeTimeout,
  parseSqlServerEndpoint,
  quoteSqlServerIdentifier,
  type WhereClause,
} from '..'

const endpoint = parseSqlServerEndpoint({ host: 'db.internal', port: 1433 })
const quoted: string = quoteSqlServerIdentifier('dbo.items')
const genericWhere: WhereClause = {
  status: 'open',
  $or: [
    { updated_at: { $gt: '2026-06-01T00:00:00.000Z' } },
    { updated_at: '2026-06-01T00:00:00.000Z', id: { $gt: 42 } },
  ],
}
const where = buildGenericWhereClause(genericWhere)
const tls = buildLegacyTlsOptions({ legacyTls: true })
const genericTimeout = normalizeTimeout(0, { allowZero: true })
const k3Limit = normalizeLimit(10001, { defaultLimit: 1000, maxLimit: 10000, overMax: 'clamp' })
const request = { input(_name: string, _value: unknown) { return this } }
const sql = buildSimpleSelectQuery({ request, table: 'dbo.t_ICItem', filters: { FNumber: 'MAT-001' } })

void endpoint
void quoted
void where
void tls
void genericTimeout
void k3Limit
void sql
