import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type TransactionSettings,
} from 'kysely'

/** One statement as the database would have received it, with the connection that sent it. */
export type RecordedStatement = { sql: string; params: readonly unknown[]; connection?: number }

/** Answers one statement with rows, or throws the error the database would raise. */
export type StatementResponder = (statement: RecordedStatement) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>

/**
 * A Kysely instance that compiles real PostgreSQL SQL and records every statement, including the
 * transaction control statements, in the order the driver sends them. Every acquired connection
 * gets its own number, recorded with each statement it sends. No database is contacted.
 */
export function createRecordingKysely<DB>(responder: StatementResponder): { db: Kysely<DB>; log: RecordedStatement[] } {
  const log: RecordedStatement[] = []
  const numbers = new WeakMap<DatabaseConnection, number>()
  let acquired = 0
  const connectionNumber = (connection: DatabaseConnection) => numbers.get(connection) ?? -1
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      acquired += 1
      const number = acquired
      const connection: DatabaseConnection = {
        async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
          const statement = { sql: compiled.sql, params: compiled.parameters, connection: number }
          log.push(statement)
          const rows = await responder(statement)
          return { rows: rows as R[], numAffectedRows: BigInt(rows.length) }
        },
        // eslint-disable-next-line require-yield
        async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error('recording kysely: streaming is not supported')
        },
      }
      numbers.set(connection, number)
      return connection
    },
    async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings) {
      log.push({
        sql: settings.isolationLevel ? `start transaction isolation level ${settings.isolationLevel}` : 'begin',
        params: [],
        connection: connectionNumber(connection),
      })
    },
    async commitTransaction(connection: DatabaseConnection) {
      log.push({ sql: 'commit', params: [], connection: connectionNumber(connection) })
    },
    async rollbackTransaction(connection: DatabaseConnection) {
      log.push({ sql: 'rollback', params: [], connection: connectionNumber(connection) })
    },
    async releaseConnection() {},
    async destroy() {},
  }
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { db, log }
}

/** Active creator row as returned by the shared user access lock. */
export const ACTIVE_LOCKED_ACCOUNT = Object.freeze({
  role: 'user',
  is_active: true,
  activation_status: 'activated',
  access_generation: 0,
  deleted_at: null,
  purged_at: null,
})

export type IssuanceAnswers = {
  isolation?: string
  account?: Record<string, unknown> | null
  sessionRows?: Record<string, unknown>[]
  revoked?: unknown
  tokenRow?: Record<string, unknown> | null
  revokeOldRows?: Record<string, unknown>[]
}

/** Classifies a recorded statement of the issuance path. */
export function issuanceStatementKind(sql: string): string {
  const text = sql.trim()
  if (text === 'begin' || text.startsWith('start transaction')) return 'begin'
  if (text === 'commit') return 'commit'
  if (text === 'rollback') return 'rollback'
  if (/^SET TRANSACTION ISOLATION LEVEL/i.test(text)) return 'isolation'
  if (text.includes("current_setting('transaction_isolation')")) return 'isolation-probe'
  if (text.includes('AS previous') && text.includes('lock_timeout')) return 'lock-timeout'
  if (text.includes('pg_advisory_xact_lock_shared')) return 'advisory-shared'
  if (/FROM users WHERE id = \$1 FOR SHARE/.test(text)) return 'users-for-share'
  if (/\bFROM users\b/i.test(text)) return 'users-read'
  if (text.includes("set_config('lock_timeout', $1, true)")) return 'lock-timeout-restore'
  if (/FROM user_sessions/i.test(text)) return 'session-read'
  if (/user_session_revocations/i.test(text)) return 'watermark-read'
  if (/^insert into "multitable_api_tokens"/i.test(text)) return 'token-insert'
  if (/^update "multitable_api_tokens"/i.test(text)) return 'token-update'
  if (/^select .* from "multitable_api_tokens"/i.test(text)) return 'token-select'
  return 'other'
}

/** Answers the issuance statements as for an active creator with a live session and no watermark. */
export function issuanceResponder(answers: IssuanceAnswers = {}): StatementResponder {
  return ({ sql }) => {
    switch (issuanceStatementKind(sql)) {
      case 'isolation-probe':
        return [{ isolation: answers.isolation ?? 'read committed' }]
      case 'lock-timeout':
        return [{ previous: '0' }]
      case 'users-for-share':
        return answers.account === null ? [] : [{ ...ACTIVE_LOCKED_ACCOUNT, ...(answers.account ?? {}) }]
      case 'users-read':
        // Any other read of the users row is answered as the same account, with the session row and
        // watermark answers, so an assertion on statement shape is what decides.
        return answers.account === null ? [] : [{
          ...ACTIVE_LOCKED_ACCOUNT,
          ...(answers.account ?? {}),
          session_count: (answers.sessionRows ?? [{ present: 1 }]).length,
          revoked: 'revoked' in answers ? answers.revoked : false,
        }]
      case 'session-read':
        return answers.sessionRows ?? [{ present: 1 }]
      case 'watermark-read':
        return [{ revoked: 'revoked' in answers ? answers.revoked : false }]
      case 'token-select':
        return answers.tokenRow === null ? [] : [answers.tokenRow ?? {}]
      case 'token-update':
        return answers.revokeOldRows ?? [{ id: 'old-token' }]
      default:
        return []
    }
  }
}
