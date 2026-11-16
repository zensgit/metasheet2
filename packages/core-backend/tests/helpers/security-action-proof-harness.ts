/**
 * Stand-ins for the action proof service unit tests. The transaction runner records begin, every
 * statement, commit and rollback; it answers each statement by the identity of its SECURITY_ACTION_SQL
 * constant (not by substring), delegates the privilege data statement to the classifier's stand-in so
 * the real classifier runs, can fail a chosen statement with a SQLSTATE-shaped error, and can run a hook
 * before a chosen statement (to change the state between the two transactions). Any statement it does
 * not know is an error, so an unplanned statement cannot pass.
 *
 * Test files must mock `../../src/db/pg`, `../../src/integration/db/connection-pool` and
 * `../../src/audit/audit` before importing this helper.
 */
import type { Request } from 'express'
import { randomUUID } from 'node:crypto'
import { authService } from '../../src/auth/AuthService'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import {
  createSecurityActionProofService,
  readAuthenticatedSessionContext,
  SECURITY_ACTION_SQL,
} from '../../src/auth/security-action-proof'
import type {
  AuthenticatedSessionContext,
  SecurityActionAuditEvent,
  SecurityActionProofServiceDeps,
  SecurityActionTargetResolver,
  SecurityActionVerifyRequest,
} from '../../src/auth/security-action-proof'
import type { SecurityActionPurpose } from '../../src/auth/external-login-assurance'
import { privilegeFixture, privilegeHarness, privilegeRow } from './security-action-privilege-harness'
import type { PrivilegeRow } from './security-action-privilege-harness'

export const USER = 'user-' + 'a'.repeat(8)
export const SESSION = 'sid-' + 'b'.repeat(8)
export const ORG = 'org-' + 'c'.repeat(8)
export const CONNECTION = '11111111-2222-4333-8444-555555555555'
export const TARGET_IDENTITY = '66666666-7777-4888-8999-000000000000'
export const PASSWORD_HASH = '$2a$04$synthetic.hash.that.is.not.a.secret.value'
export const TARGET_WITNESS = 'a'.repeat(64)

export type StatementKey = keyof typeof SECURITY_ACTION_SQL | 'privilegeData' | 'xid' | 'lockUser' | 'unknown'

const KEY_BY_SQL = new Map<string, StatementKey>(
  (Object.keys(SECURITY_ACTION_SQL) as Array<keyof typeof SECURITY_ACTION_SQL>).map((key) => [SECURITY_ACTION_SQL[key], key]),
)

export function statementKey(sql: string): StatementKey {
  const known = KEY_BY_SQL.get(sql)
  if (known) return known
  if (sql.includes('pg_current_xact_id')) return 'xid'
  if (sql.includes('FROM users u')) return 'privilegeData'
  // The access-graph mutex statement (directory/access-graph-mutex.ts).
  if (/FROM users\s+WHERE id = \$1::text\s+FOR UPDATE/.test(sql)) return 'lockUser'
  return 'unknown'
}

export type AccountState = {
  password_hash: unknown
  local_password_set: unknown
  must_change_password: unknown
  activation_status: unknown
  is_active: unknown
  role: unknown
  deleted_at: unknown
  purged_at: unknown
  access_generation: unknown
}

export type ProofRowState = Record<string, unknown>

export type HarnessState = {
  isolation: string
  /** Transaction ids answered to the probes, in order; the last one repeats. */
  xids: string[]
  session: { user_id: unknown; live: unknown } | null
  /** Milliseconds; `null` means no watermark row. */
  watermarkMs: string | null
  /** Microseconds; derived from `watermarkMs` when null. */
  watermarkUs: string | null
  failures: number
  retryAfter: number
  account: AccountState | null
  member: boolean
  userExists: boolean
  privilege: PrivilegeRow
  issuedReturning: { created_at: Date; expires_at: Date } | null
  proof: ProofRowState | null
  consumeRows: number
  reload: { status: unknown; live: unknown } | null
}

export function accountState(overrides: Partial<AccountState> = {}): AccountState {
  return {
    password_hash: PASSWORD_HASH,
    local_password_set: true,
    must_change_password: false,
    activation_status: 'activated',
    is_active: true,
    role: 'user',
    deleted_at: null,
    purged_at: null,
    access_generation: '3',
    ...overrides,
  }
}

export function defaultState(overrides: Partial<HarnessState> = {}): HarnessState {
  const created = new Date('2026-01-01T00:00:00.000Z')
  return {
    isolation: 'read committed',
    xids: ['100'],
    session: { user_id: USER, live: true },
    watermarkMs: null,
    watermarkUs: null,
    failures: 0,
    retryAfter: 1,
    account: accountState(),
    member: true,
    userExists: true,
    privilege: privilegeRow({ id: USER }),
    issuedReturning: { created_at: created, expires_at: new Date(created.getTime() + 300_000) },
    proof: null,
    consumeRows: 1,
    reload: null,
    ...overrides,
  }
}

export type Statement = { key: StatementKey; sql: string; params: unknown[]; tx: number }
export type HarnessEvent =
  | { type: 'begin'; tx: number }
  | { type: 'commit'; tx: number }
  | { type: 'rollback'; tx: number }
  | { type: 'statement'; tx: number; key: StatementKey }
  | { type: 'verifyPassword' }
  | { type: 'audit'; result: string }

export type HarnessOptions = {
  /** Fail this statement (by key) with an error carrying `code` (omitted when `null`). */
  failAt?: { key: StatementKey; code?: string | null; occurrence?: number }
  /** Called before the statement with this key is answered; `occurrence` counts from 1. */
  before?: Partial<Record<StatementKey, (state: HarnessState, occurrence: number, params: unknown[]) => void>>
}

export type Answerer = { query: Queryable['query']; statements: Statement[]; events: HarnessEvent[] }

export function answerer(state: HarnessState, options: HarnessOptions = {}, events: HarnessEvent[] = [], txOf: () => number = () => 0): Answerer {
  const statements: Statement[] = []
  const occurrences = new Map<StatementKey, number>()
  let probes = 0
  const query: Queryable['query'] = async (sql, params = []) => {
    const key = statementKey(sql)
    const tx = txOf()
    statements.push({ key, sql, params, tx })
    events.push({ type: 'statement', tx, key })
    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    options.before?.[key]?.(state, occurrence, params)
    if (options.failAt && options.failAt.key === key && (options.failAt.occurrence ?? occurrence) === occurrence) {
      const error = new Error('synthetic_private_sql_detail_' + randomUUID())
      if (options.failAt.code !== null) Object.assign(error, { code: options.failAt.code ?? '42P01' })
      throw error
    }
    const rows = await answer(key, sql, params, state, () => state.xids[Math.min(probes++, state.xids.length - 1)])
    return { rows, rowCount: rows.length }
  }
  return { query, statements, events }
}

async function answer(key: StatementKey, sql: string, params: unknown[], state: HarnessState, nextXid: () => string): Promise<Array<Record<string, unknown>>> {
  switch (key) {
    case 'setReadCommitted':
    case 'setLockTimeout':
    case 'setStatementTimeout':
    case 'advisoryLock':
    case 'supersede':
    case 'insertFailed':
      return []
    case 'isolation':
      return [{ isolation: state.isolation }]
    case 'xid':
      return [{ xid: nextXid() }]
    case 'session':
    case 'sessionForShare':
      return state.session ? [{ user_id: state.session.user_id, live: state.session.live }] : []
    case 'watermark':
      if (state.watermarkMs === null) return []
      return [{ revoked_after_ms: state.watermarkMs, revoked_after_us: state.watermarkUs ?? `${state.watermarkMs}000` }]
    case 'failureCount':
      return [{ failures: state.failures, retry_after: state.retryAfter }]
    case 'account':
      return state.account ? [{ ...state.account }] : []
    case 'membership':
      return state.member ? [{ present: 1 }] : []
    case 'userKeyShare':
      return state.userExists ? [{ present: 1 }] : []
    case 'lockUser':
      return state.userExists
        ? [{ id: params[0], name: null, email: null, username: null, mobile: null, activation_status: 'activated', is_active: true, access_generation: state.account?.access_generation ?? '0', deleted_at: null, purged_at: null }]
        : []
    case 'insertIssued':
      return state.issuedReturning ? [{ ...state.issuedReturning }] : []
    case 'lockProof':
      return state.proof ? [{ ...state.proof }] : []
    case 'consume':
      return state.consumeRows === 1 && state.proof
        ? [{ id: state.proof.id, created_at: state.proof.created_at, method: state.proof.method, assurance: state.proof.assurance, privilege_class: state.proof.privilege_class }]
        : []
    case 'reloadProof':
      return state.reload ? [{ ...state.reload }] : []
    case 'privilegeData': {
      // The classifier's own stand-in answers its data statement, so the real classifier runs here.
      const delegate = privilegeHarness(privilegeFixture({ rows: [state.privilege] }))
      return (await delegate.executor.query(sql, params)).rows
    }
    default:
      throw new Error('Unexpected statement')
  }
}

/** `runTransaction` stand-in: records begin / statements / commit / rollback and rethrows. */
export function fakeRunner(state: HarnessState, options: HarnessOptions = {}) {
  const events: HarnessEvent[] = []
  let current = 0
  let count = 0
  const answers = answerer(state, options, events, () => current)
  const runTransaction = async <T>(work: (executor: Queryable) => Promise<T>): Promise<T> => {
    const tx = ++count
    current = tx
    events.push({ type: 'begin', tx })
    try {
      const result = await work({ query: answers.query })
      events.push({ type: 'commit', tx })
      return result
    } catch (error) {
      events.push({ type: 'rollback', tx })
      throw error
    } finally {
      current = 0
    }
  }
  return { runTransaction, events, statements: answers.statements }
}

/** A caller transaction handle for `consume`. */
export function fakeClient(state: HarnessState, options: HarnessOptions = {}) {
  const events: HarnessEvent[] = []
  const answers = answerer(state, options, events, () => 1)
  const client: Queryable = { query: answers.query }
  return { client, events, statements: answers.statements }
}

export const okResolver: SecurityActionTargetResolver = async (_executor, request) => ({
  ok: true,
  kind: request.targetIdentityId === null ? 'empty_slot' : 'identity_revision',
  witness: TARGET_WITNESS,
})

export type ServiceOverrides = Partial<SecurityActionProofServiceDeps> & {
  state?: HarnessState
  options?: HarnessOptions
  passwordOk?: boolean
}

export function serviceWith(overrides: ServiceOverrides = {}) {
  const state = overrides.state ?? defaultState()
  const runner = fakeRunner(state, overrides.options)
  const audits: SecurityActionAuditEvent[] = []
  const verifyCalls: Array<{ hash: string }> = []
  const deps: SecurityActionProofServiceDeps = {
    isPurposeAvailable: () => true,
    resolvers: {
      external_identity_bind: okResolver,
      external_identity_unbind: okResolver,
      login_grant_enable: okResolver,
      login_grant_disable: okResolver,
    },
    runTransaction: runner.runTransaction,
    verifyPassword: async (_password, hash) => {
      verifyCalls.push({ hash })
      runner.events.push({ type: 'verifyPassword' })
      return overrides.passwordOk !== false
    },
    recordAudit: async (event) => {
      audits.push(event)
      runner.events.push({ type: 'audit', result: event.meta.result })
    },
    policyRevision: 1,
    ...overrides,
  }
  const service = createSecurityActionProofService(deps)
  return { service, state, runner, audits, verifyCalls, deps }
}

export function verifyRequest(overrides: Partial<Record<string, unknown>> = {}): SecurityActionVerifyRequest {
  const base: Record<string, unknown> = {
    purpose: 'external_identity_unbind',
    connectionId: CONNECTION,
    targetIdentityId: TARGET_IDENTITY,
    expectedBindingRevision: 4,
    method: 'local_password',
    password: 'correct horse battery staple',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key]
    else base[key] = value
  }
  return base as SecurityActionVerifyRequest
}

export function bindRequest(): SecurityActionVerifyRequest {
  return verifyRequest({ purpose: 'external_identity_bind', targetIdentityId: undefined, expectedBindingRevision: undefined })
}

export function tokenFor(userId: string, sid: string | undefined, orgId: string | null = ORG): string {
  return authService.createToken(
    { id: userId, email: null, name: userId, role: 'user', permissions: [], created_at: new Date(), updated_at: new Date(), ...(orgId ? { tenantId: orgId } : {}) },
    sid === undefined ? {} : { sid },
  )
}

export function requestShape(userId: string, token: string, orgId: string | null = ORG, extra: Record<string, unknown> = {}): Request {
  return {
    user: { id: userId },
    ...(orgId ? { authenticatedTenantId: orgId } : {}),
    headers: { authorization: `Bearer ${token}` },
    ...extra,
  } as unknown as Request
}

/** The only construction path: a real token, a request-shaped object, the real reader. */
export function contextFor(userId: string = USER, sid: string = SESSION, orgId: string | null = ORG): AuthenticatedSessionContext {
  const context = readAuthenticatedSessionContext(requestShape(userId, tokenFor(userId, sid, orgId), orgId))
  if (!context) throw new Error('context construction failed')
  return context
}

export function issuedProofRow(overrides: ProofRowState = {}): ProofRowState {
  return {
    id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
    user_id: USER,
    session_id: SESSION,
    org_id: ORG,
    purpose: 'external_identity_unbind' satisfies SecurityActionPurpose,
    connection_id: CONNECTION,
    target_kind: 'identity_revision',
    target_witness: TARGET_WITNESS,
    method: 'local_password',
    method_connection_id: null,
    assurance: 'local_password',
    status: 'issued',
    proof_hash: null,
    client_binding_digest: null,
    policy_revision: 1,
    access_generation: '3',
    credential_witness: null,
    privilege_witness: null,
    privilege_class: 'standard',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    created_at_us: String(new Date('2026-01-01T00:00:00.000Z').getTime()) + '000',
    live: true,
    ...overrides,
  }
}
