// D21 in-transaction re-authorization of a bound YiDa row (design baseline v2.3 §7.2; slice Y5): the host function
// with synthetic dependencies, the approval service's verdict mapping with a memory database, and two static pins.
// Real locks, triggers and barriers are the real-DB file's (stock-preparation-yida-send-approvals-realdb.test.ts).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { AUTHORIZATION_PROTOCOL_GAPS, AuthorizationVersionProtocolError } from '../../src/multitable/authz-version-protocol'
import { isNamespaceAdmissionControlledResource } from '../../src/rbac/namespace-admission'
import {
  createYidaSendApprovalService, type YidaSendAuthorityPrimitives, type YidaSendAuthoritySelection,
} from '../../src/integration/yida-send-approval-service'
import {
  reauthorizeYidaSourceBinding, YIDA_SOURCE_REAUTHORIZATION_HANDLED_GAPS,
  type YidaSheetSourceField, type YidaSourceReauthorizationDependencies, type YidaSourceReauthorizationLockedAuthority,
} from '../../src/integration/yida-sheet-source'
import { createYidaSourceReauthorizationHostDependencies } from '../../src/integration/yida-source-reauthorization-host'

type Data = Record<string, unknown>
const actor = Object.freeze({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null })
const F = { project: 'fld_project', line: 'fld_line', qty: 'fld_qty', desc: 'fld_description', note: 'fld_note', decoy: 'description' }
const fields: YidaSheetSourceField[] = [
  { id: F.project, type: 'string' }, { id: F.line, type: 'string', property: { stockPreparation: { key: true } } }, { id: F.qty, type: 'number' },
  { id: F.desc, type: 'string' }, { id: F.note, type: 'string' }, { id: F.decoy, type: 'string' },
]
// The compiler's per-row binding: `label` is a concat of the key column and `partNote`, a column no target maps directly.
const binding = (patch: Data = {}) => Object.freeze({
  sheetId: 'sheet_bound', recordId: 'rec_bound', keyFieldId: F.line, keyValue: 'LINE-1', projectNo: 'SYN-P1',
  fieldBindings: { projectNo: F.project, lineId: F.line, quantity: F.qty, description: F.desc, partNote: F.note },
  fieldDependencies: { project: [F.project], line: [F.line], qty: [F.qty], description: [F.desc], label: [F.line, F.note] },
  ...patch,
})
const trx = Object.freeze({ query: async () => ({ rows: [] }) })
const lockConflict = () => new AuthorizationVersionProtocolError('AUTHZ_VERSION_CONFLICT', { sqlState: '40P01' })
type Knobs = Partial<{
  registry: { sheetId: string; status: string } | null
  locked: Partial<YidaSourceReauthorizationLockedAuthority>; lockError: unknown
  access: Partial<{ canRead: boolean; canExport: boolean; live: boolean; bounded: boolean }>
  readable: string[]; readableRecords: string[]; role: string; gaps: Array<{ id: string }>
  failing: keyof YidaSourceReauthorizationDependencies
}>
function harness(knobs: Knobs = {}) {
  const calls: string[] = []
  const locked: YidaSourceReauthorizationLockedAuthority = {
    permissionCodes: ['integration:admin', 'multitable:read'], isAdmin: false,
    record: { recordId: 'rec_bound', sheetId: 'sheet_bound', data: { [F.line]: 'LINE-1' }, deletedAt: null },
    ...knobs.locked,
  }
  const failing = (name: string) => { if (knobs.failing === name) throw new Error('synthetic dependency failure') }
  const dependencies: YidaSourceReauthorizationDependencies = {
    async lockAuthority(given, input) {
      calls.push('lock:' + JSON.stringify(input) + ':' + String(given === trx))
      if (knobs.lockError) throw knobs.lockError
      failing('lockAuthority')
      return locked
    },
    isLockConflict: error => error instanceof AuthorizationVersionProtocolError && error.code === 'AUTHZ_VERSION_CONFLICT',
    protocolGaps: knobs.gaps ?? AUTHORIZATION_PROTOCOL_GAPS,
    async sessionReplicationRole() { calls.push('session-role'); failing('sessionReplicationRole'); return knobs.role ?? 'origin' },
    async lockProjectRegistration(_trx, input) {
      calls.push(`registry:${input.tenantId}:${input.projectNo}`)
      failing('lockProjectRegistration')
      return knobs.registry === undefined ? { sheetId: 'sheet_bound', status: 'active' } : knobs.registry
    },
    async resolveSheetAccess(_trx, input) {
      calls.push('access:' + JSON.stringify(input))
      failing('resolveSheetAccess')
      return { canRead: true, canExport: true, live: true, bounded: false, capabilities: { canRead: true, canEditRecord: false, canCreateRecord: false }, ...knobs.access }
    },
    async loadFields(_trx, sheetId) { calls.push('fields:' + sheetId); failing('loadFields'); return fields },
    async readableFieldIds(_trx, _sheet, userId) {
      calls.push('readable-fields:' + userId)
      failing('readableFieldIds')
      return new Set(knobs.readable ?? fields.map(field => field.id))
    },
    async readableRecordIds(_trx, _sheet, userId, isAdminRole, ids) {
      calls.push(`readable-records:${userId}:${String(isAdminRole)}:${ids.join(',')}`)
      failing('readableRecordIds')
      return new Set(knobs.readableRecords ?? ids)
    },
  }
  return { dependencies, calls }
}
async function verdictOf(knobs: Knobs = {}, who: unknown = actor, bound: unknown = binding()) {
  const h = harness(knobs)
  const verdict = await reauthorizeYidaSourceBinding(trx, who, bound, h.dependencies)
  expect(Object.isFrozen(verdict)).toBe(true)
  expect(Object.getPrototypeOf(verdict)).toBe(Object.prototype)
  return { verdict, calls: h.calls }
}
const refused = (code: string) => ({ authorized: false, code })

describe('reauthorizeYidaSourceBinding (D21, §7.2 checks 1-4 on the caller trx)', () => {
  it('authorized: the hard condition, the registry FOR SHARE, the D21 lock, then checks 2-4 — in that order, on the caller trx; check 2 receives EXACTLY the locked codes and admin-ness; the verdict carries nothing else', async () => {
    const { verdict, calls } = await verdictOf()
    expect(verdict).toEqual({ authorized: true })
    expect(calls).toEqual([
      'session-role',
      'registry:synthetic-tenant:SYN-P1',
      'lock:' + JSON.stringify({ sheetId: 'sheet_bound', actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', recordId: 'rec_bound' }) + ':true',
      'access:' + JSON.stringify({ sheetId: 'sheet_bound', userId: 'synthetic-owner', tenantId: 'synthetic-tenant', permissions: ['integration:admin', 'multitable:read'], isAdminRole: false }),
      'fields:sheet_bound',
      'readable-fields:synthetic-owner',
      'readable-records:synthetic-owner:false:rec_bound',
    ])
  })

  it('check 1 (registry): no row, an archived row or a row naming another sheet refuses REGISTRY before any protocol lock', async () => {
    for (const registry of [null, { sheetId: 'sheet_bound', status: 'archived' }, { sheetId: 'sheet_other', status: 'active' }]) {
      const { verdict, calls } = await verdictOf({ registry })
      expect(verdict).toEqual(refused('REGISTRY'))
      expect(calls.some(call => call.startsWith('lock:'))).toBe(false)
    }
  })

  it('check 2 (table): no read, no export, a dead sheet or the People sheet refuses SHEET; nothing at field or record level is consulted', async () => {
    for (const access of [{ canRead: false }, { canExport: false }, { live: false }, { bounded: true }]) {
      const { verdict, calls } = await verdictOf({ access })
      expect(verdict).toEqual(refused('SHEET'))
      expect(calls.some(call => call.startsWith('fields') || call.startsWith('readable'))).toBe(false)
    }
  })

  it('check 3 (field): every real field id a target depends on must be readable — a directly mapped column, (ii) a column that is only a concat dependency, and (i) by field id never by alias (the visible decoy named like the alias does not stand in)', async () => {
    const readableExcept = (...hidden: string[]) => fields.map(field => field.id).filter(id => !hidden.includes(id))
    expect((await verdictOf({ readable: readableExcept(F.desc) })).verdict).toEqual(refused('FIELD'))
    expect((await verdictOf({ readable: readableExcept(F.note) })).verdict).toEqual(refused('FIELD'))
    // (i): the alias `description` is a readable field id, the real column `fld_description` is hidden.
    expect((await verdictOf({ readable: [...readableExcept(F.desc), 'description'] })).verdict).toEqual(refused('FIELD'))
    // Hiding the decoy alone changes nothing.
    expect((await verdictOf({ readable: readableExcept(F.decoy) })).verdict).toEqual({ authorized: true })
  })

  it('check 3 (Y4-07): the key column is required explicitly, even when no target depends on it', async () => {
    const keyless = binding({ fieldDependencies: { project: [F.project], qty: [F.qty] } })
    expect((await verdictOf({ readable: [F.project, F.qty, F.desc, F.note] }, actor, keyless)).verdict).toEqual(refused('FIELD'))
    expect((await verdictOf({ readable: [F.project, F.qty, F.line] }, actor, keyless)).verdict).toEqual({ authorized: true })
  })

  it('check 4 (record): the locked row must exist, be the bound record of the bound sheet, be live and be readable; the locked admin-ness (not a request) drives the admin bypass of the record primitives', async () => {
    expect((await verdictOf({ locked: { record: null } })).verdict).toEqual(refused('RECORD'))
    expect((await verdictOf({ locked: { record: { recordId: 'rec_bound', sheetId: 'sheet_other', data: {}, deletedAt: null } } })).verdict).toEqual(refused('RECORD'))
    expect((await verdictOf({ locked: { record: { recordId: 'rec_other', sheetId: 'sheet_bound', data: {}, deletedAt: null } } })).verdict).toEqual(refused('RECORD'))
    expect((await verdictOf({ locked: { record: { recordId: 'rec_bound', sheetId: 'sheet_bound', data: {}, deletedAt: '2026-11-06T00:00:00Z' } } })).verdict).toEqual(refused('RECORD'))
    const { verdict, calls } = await verdictOf({ readableRecords: [] })
    expect(verdict).toEqual(refused('RECORD'))
    expect(calls.at(-1)).toBe('readable-records:synthetic-owner:false:rec_bound')
    const admin = await verdictOf({ locked: { isAdmin: true }, readableRecords: [] })
    expect(admin.calls.at(-1)).toBe('readable-records:synthetic-owner:true:rec_bound')
    expect(admin.calls.some(call => call.startsWith('access:') && call.includes('"isAdminRole":true'))).toBe(true)
  })

  it('the D21 lock: a typed conflict (40P01 / 40001 / 55P03) is CONFLICT, never a pass; any other lock failure is PROTOCOL; a dependency failure anywhere is PROTOCOL', async () => {
    expect((await verdictOf({ lockError: lockConflict() })).verdict).toEqual(refused('CONFLICT'))
    expect((await verdictOf({ lockError: new AuthorizationVersionProtocolError('AUTHZ_VERSION_PROTOCOL_UNAVAILABLE', { missingTriggers: ['x'] }) })).verdict).toEqual(refused('PROTOCOL'))
    expect((await verdictOf({ lockError: new Error('synthetic 42P01') })).verdict).toEqual(refused('PROTOCOL'))
    for (const failing of ['sessionReplicationRole', 'lockProjectRegistration', 'resolveSheetAccess', 'loadFields', 'readableFieldIds', 'readableRecordIds'] as const) {
      expect((await verdictOf({ failing })).verdict).toEqual(refused('PROTOCOL'))
    }
  })

  it('a lock conflict met by ANY step (the deadlock victim waits wherever it waits) is CONFLICT, never PROTOCOL or a pass; the host recognizes the typed conflict and exactly the raw 40P01 / 40001 / 55P03', async () => {
    const raw = (code: string) => Object.assign(new Error('synthetic driver error'), { code })
    const host = createYidaSourceReauthorizationHostDependencies()
    for (const conflict of [lockConflict(), raw('40P01'), raw('40001'), raw('55P03')]) expect(host.isLockConflict(conflict)).toBe(true)
    const accessor = Object.defineProperty(new Error('synthetic'), 'code', { get() { throw new Error('synthetic getter') } })
    for (const other of [raw('42P01'), raw('23505'), raw('25P02'), new AuthorizationVersionProtocolError('AUTHZ_VERSION_UNAVAILABLE'),
      new AuthorizationVersionProtocolError('AUTHZ_VERSION_PROTOCOL_UNAVAILABLE'), accessor, null, undefined, '40P01', { code: 40001 }]) {
      expect(host.isLockConflict(other)).toBe(false)
    }
    for (const step of ['lockProjectRegistration', 'resolveSheetAccess', 'readableFieldIds', 'readableRecordIds'] as const) {
      const h = harness()
      const dependencies = { ...h.dependencies, isLockConflict: host.isLockConflict,
        [step]: async () => { throw raw('40P01') } } as YidaSourceReauthorizationDependencies
      expect({ step, verdict: await reauthorizeYidaSourceBinding(trx, actor, binding(), dependencies) }).toEqual({ step, verdict: refused('CONFLICT') })
      const other = { ...dependencies, [step]: async () => { throw raw('42P01') } } as YidaSourceReauthorizationDependencies
      expect({ step, verdict: await reauthorizeYidaSourceBinding(trx, actor, binding(), other) }).toEqual({ step, verdict: refused('PROTOCOL') })
    }
    // A conflict classifier that itself throws is no conflict: PROTOCOL, still never a pass.
    const throwing = { ...harness({ lockError: lockConflict() }).dependencies, isLockConflict: () => { throw new Error('synthetic') } }
    expect(await reauthorizeYidaSourceBinding(trx, actor, binding(), throwing)).toEqual(refused('PROTOCOL'))
  })

  it('hard condition (RA5): a gap-registry entry this host does not handle, or a session whose triggers do not fire, refuses PROTOCOL before any lock', async () => {
    const extra = await verdictOf({ gaps: [...AUTHORIZATION_PROTOCOL_GAPS, { id: 'synthetic-unhandled-writer' }] })
    expect(extra.verdict).toEqual(refused('PROTOCOL'))
    expect(extra.calls).toEqual([])
    const replica = await verdictOf({ role: 'replica' })
    expect(replica.verdict).toEqual(refused('PROTOCOL'))
    expect(replica.calls).toEqual(['session-role'])
    expect((await verdictOf({ gaps: [] })).verdict).toEqual({ authorized: true })
  })

  it('the handled set is exactly the protocol registry of this tree: a new Y5a entry turns this red before it refuses at runtime', () => {
    expect([...YIDA_SOURCE_REAUTHORIZATION_HANDLED_GAPS].sort()).toEqual(AUTHORIZATION_PROTOCOL_GAPS.map(gap => gap.id).sort())
  })

  it('closed inputs: a malformed actor or binding is INPUT and no dependency is called', async () => {
    const bad = [
      [actor, { ...binding(), extra: 1 }], [actor, { ...binding(), sheetId: ' sheet' }], [actor, { ...binding(), fieldDependencies: { x: 'not-a-list' } }],
      [actor, { ...binding(), fieldBindings: { a: 1 } }], [actor, null], [{ ...actor, workspaceId: 'ws' }, binding()], [{ actorId: 'a' }, binding()],
      [Object.create({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }), binding()],
    ] as const
    for (const [who, bound] of bad) {
      const { verdict, calls } = await verdictOf({}, who, bound)
      expect(verdict).toEqual(refused('INPUT'))
      expect(calls).toEqual([])
    }
  })

  it('namespace admission cannot shape the checks: `multitable` is not an admission-controlled resource, so the locked codes are consumed unfiltered', () => {
    expect(isNamespaceAdmissionControlledResource('multitable')).toBe(false)
  })

  it('static pin: neither the re-authorization nor its host wiring reads a request, the token or the RBAC cache', () => {
    const root = path.resolve(__dirname, '..', '..', 'src', 'integration')
    // Code only: the docblocks name what is NOT used (e.g. the request-cache helpers) and must not trip the scan.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
    const forbidden = ['resolveRequestAccess', 'listUserPermissions', 'isAdmin(', 'resolveSheetCapabilities(', 'resolveSheetReadableCapabilities(', 'req.user', "rbac/service'"]
    for (const file of ['yida-source-reauthorization-host.ts']) {
      const text = code(readFileSync(path.join(root, file), 'utf8'))
      expect(text).toContain('lockAuthorizationVersionsForAdmission(')
      for (const token of forbidden) expect({ file, token, found: text.includes(token) }).toEqual({ file, token, found: false })
    }
    const source = readFileSync(path.join(root, 'yida-sheet-source.ts'), 'utf8')
    const reauthorization = code(source.slice(source.indexOf('export async function reauthorizeYidaSourceBinding')))
    expect(reauthorization).toContain('dependencies.lockAuthority(trx')
    for (const token of [/\breq\b/, /\bRequest\b/, /\bcache\b/i, /\brbac\b/i, /\buser\b/]) {
      expect({ token: String(token), found: token.test(reauthorization) }).toEqual({ token: String(token), found: false })
    }
    // The production host hands exactly this re-check to the YiDa owner runtime (absent, a bound row fails closed; the
    // lane fixtures construct their own runtime with a synthetic double, so only this pin watches the real wiring).
    const index = code(readFileSync(path.resolve(__dirname, '..', '..', 'src', 'index.ts'), 'utf8'))
    expect(/reauthorizeSourceBinding:\s*createYidaSourceBindingReauthorizer\(\)/.test(index)).toBe(true)
    expect(index.includes("from './integration/yida-source-reauthorization-host'")).toBe(true)
  })
})

// ── The approval service: verdict mapping, the phase-1 subject lock and the trx handed to the re-authorizer ──
describe('yida-send-approval-service: D21 wiring of approve()', () => {
  const context = { tenantId: 'synthetic-tenant', workspaceId: null as null, ownerId: 'synthetic-owner' }
  const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const targetRef = '0f3a7c2e-1b4d-4e5f-8a9b-0c1d2e3f4a5b'
  function selection(bound: boolean): YidaSendAuthoritySelection {
    const sourceBinding = bound ? Object.freeze(binding()) as unknown as YidaSendAuthoritySelection['sourceBinding'] : null
    return Object.freeze({
      tenantId: context.tenantId, workspaceId: null, ownerId: context.ownerId, operationId: 'synthetic-operation', rowKey: 'synthetic-row',
      targetRef, targetRevision: 'evidence-1', planRevision: sha('plan'), planDigest: sha('plan'),
      credentialRef: 'synthetic-credential', credentialGeneration: 1, businessKeyDigest: sha('key'), rowPayloadDigest: sha('row'),
      sourceRecordDigest: bound ? sha('source-record') : null, creationIdentityDigest: bound ? sha('identity') : null, sourceBinding,
      config: { version: 2 }, selectedRow: { lineId: 'LINE-1' }, source: { rowsText: '[]' }, plan: { rows: [] },
    })
  }
  function service(options: { bound: boolean; reauthorizer?: unknown; omit?: boolean }) {
    const statements: string[] = []
    const inserted: Data[] = []
    const reauthorizations: Array<{ trx: unknown; actor: unknown; binding: unknown }> = []
    const instant = 1_700_000_000_000
    let transactionTrx: Queryable | undefined
    const query: Queryable['query'] = async (sql, params = []) => {
      statements.push(sql)
      if (sql.startsWith('SET TRANSACTION')) return { rows: [], rowCount: null }
      if (sql.includes("current_setting('transaction_isolation')")) return { rows: [{ isolation: 'read committed' }], rowCount: 1 }
      if (sql.includes('pg_current_xact_id')) return { rows: [{ xid: 'synthetic-xid' }], rowCount: 1 }
      if (sql.includes('subject_authorization_versions')) return sql.includes('FOR SHARE') ? { rows: [{ subject_id: context.ownerId, version: '1' }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes('FROM user_roles')) return { rows: [{ role_id: 'integration_admin' }], rowCount: 1 }
      if (sql.includes('FROM role_permissions')) return { rows: [{ role_id: 'integration_admin', permission_code: 'integration:admin' }], rowCount: 1 }
      if (sql.includes('FROM user_permissions')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM users')) return { rows: [{ id: context.ownerId, role: 'user', is_active: true, activation_status: 'activated', permissions: [] }], rowCount: 1 }
      if (sql.includes('FROM user_orgs')) return { rows: [{ user_id: context.ownerId, org_id: context.tenantId, is_active: true }], rowCount: 1 }
      if (sql.includes('FROM user_namespace_admissions')) return { rows: [{ namespace: 'integration', enabled: true }], rowCount: 1 }
      if (sql.startsWith('SELECT slot, target_ref')) return { rows: [{ slot: 1, target_ref: targetRef, tenant_id: context.tenantId, workspace_id: null, owner_id: context.ownerId, evidence_version: 1, status: 'manually_confirmed' }], rowCount: 1 }
      if (sql.includes('FROM integration_yida_send_') || sql.includes('FROM integration_yida_delivery_ledger')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('WITH instant')) return { rows: [{ approved_at_ms: String(instant), expires_at_ms: String(instant + Number(params[0])) }], rowCount: 1 }
      if (sql.includes('clock_timestamp()')) return { rows: [{ now_ms: String(instant) }], rowCount: 1 }
      const insert = /^INSERT INTO (integration_yida_send_approvals|integration_yida_send_approval_audit)\s*\(([^)]+)\)/.exec(sql)
      if (insert) {
        const row = Object.fromEntries(insert[2].split(',').map((column, index) => [column.trim(), params[index]]))
        inserted.push({ table: insert[1], ...row })
        return { rows: [row], rowCount: 1 }
      }
      throw new Error('synthetic fixture: unexpected SQL shape')
    }
    const primitives: YidaSendAuthorityPrimitives = {
      async resolveSelectionInTransaction() { return selection(options.bound) },
      executionPayloadDigest(value, grant) { return sha({ value, grant }) },
      sendBudget() { return Object.freeze({ withinBudget: true }) },
      async prepareInTransaction() { throw new Error('synthetic fixture: no admission here') },
    }
    const reauthorizeSourceBinding = options.omit ? undefined : (async (trx: unknown, who: unknown, bound: unknown) => {
      reauthorizations.push({ trx, actor: who, binding: bound })
      if (typeof options.reauthorizer === 'function') return (options.reauthorizer as () => unknown)()
      return options.reauthorizer
    })
    const approvals = createYidaSendApprovalService({
      database: { async transaction<T>(callback: (trx: Queryable) => Promise<T>) { transactionTrx = { query }; return callback(transactionTrx) } },
      security: { async encrypt(text) { return 'enc:' + Buffer.from(text).toString('base64') }, async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString() } },
      context: { actorId: context.ownerId, tenantId: context.tenantId, workspaceId: null },
      primitives, ...(reauthorizeSourceBinding ? { reauthorizeSourceBinding } : {}),
    })
    const approve = () => approvals.approve({ operationId: 'synthetic-operation', rowKey: 'synthetic-row', confirmationId: 'synthetic-confirmation' })
    return { approve, statements, inserted, reauthorizations, trx: () => transactionTrx, inspect: () => approvals.inspect({ grantId: 'synthetic-grant' }) }
  }
  const codeOf = async (promise: Promise<unknown>) => {
    try { await promise } catch (error) { return (error as { code: string }).code }
    return 'NO_ERROR'
  }

  it('a bound row: the re-authorizer runs on the transaction\'s own trx with the fixed actor and the selection\'s binding, after the subject lock and the live-actor rows and before the grant row; an authorized verdict approves', async () => {
    const s = service({ bound: true, reauthorizer: Object.freeze({ authorized: true }) })
    const granted = await s.approve()
    expect(granted.status).toBe('approved')
    expect(s.reauthorizations).toHaveLength(1)
    expect(s.reauthorizations[0].trx).toBe(s.trx())
    expect(s.reauthorizations[0].actor).toEqual({ actorId: context.ownerId, tenantId: context.tenantId, workspaceId: null })
    expect(s.reauthorizations[0].binding).toBe(selection(true).sourceBinding === null ? null : s.reauthorizations[0].binding)
    expect((s.reauthorizations[0].binding as Data).recordId).toBe('rec_bound')
    expect(s.inserted.map(row => row.table)).toEqual(['integration_yida_send_approvals', 'integration_yida_send_approval_audit'])
    // Phase 1: the subject row is ensured and held FOR SHARE right after the isolation pin, before the live-actor rows.
    expect(s.statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(s.statements[1]).toMatch(/^INSERT INTO subject_authorization_versions \(subject_id\)/)
    expect(s.statements[2]).toMatch(/FROM subject_authorization_versions WHERE subject_id = \$1 FOR SHARE$/)
    expect(s.statements.findIndex(sql => sql.includes('FROM user_roles'))).toBeGreaterThan(2)
  })

  it('a refused check or a lock conflict is CONFLICT; a protocol gap, a malformed or foreign verdict, a thrown re-authorizer or an absent one is UNAVAILABLE; nothing is written in any of them', async () => {
    const cases: Array<[unknown, string]> = [
      [Object.freeze({ authorized: false, code: 'REGISTRY' }), 'YIDA_SEND_APPROVAL_CONFLICT'],
      [Object.freeze({ authorized: false, code: 'SHEET' }), 'YIDA_SEND_APPROVAL_CONFLICT'],
      [Object.freeze({ authorized: false, code: 'FIELD' }), 'YIDA_SEND_APPROVAL_CONFLICT'],
      [Object.freeze({ authorized: false, code: 'RECORD' }), 'YIDA_SEND_APPROVAL_CONFLICT'],
      [Object.freeze({ authorized: false, code: 'CONFLICT' }), 'YIDA_SEND_APPROVAL_CONFLICT'],
      [Object.freeze({ authorized: false, code: 'PROTOCOL' }), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [Object.freeze({ authorized: false, code: 'INPUT' }), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [Object.freeze({ authorized: false, code: 'synthetic-unknown' }), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [{ authorized: true }, 'YIDA_SEND_APPROVAL_UNAVAILABLE'], // not frozen
      [Object.freeze({ authorized: true, extra: 1 }), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [Object.freeze({ authorized: 'yes' }), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [Object.freeze({ authorized: false }), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [Object.freeze(Object.create({ authorized: true })), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [Object.freeze(new Proxy({ authorized: true }, {})), 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [undefined, 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
      [() => { throw new Error('synthetic re-authorization failure') }, 'YIDA_SEND_APPROVAL_UNAVAILABLE'],
    ]
    for (const [reauthorizer, code] of cases) {
      const s = service({ bound: true, reauthorizer })
      expect({ code: await codeOf(s.approve()) }).toEqual({ code })
      expect(s.inserted).toEqual([])
    }
    const absent = service({ bound: true, omit: true })
    expect(await codeOf(absent.approve())).toBe('YIDA_SEND_APPROVAL_UNAVAILABLE')
    expect(absent.inserted).toEqual([])
  })

  it('an unbound (pasted) row never reaches the re-authorizer, with or without the dependency; inspect takes no subject lock', async () => {
    const withIt = service({ bound: false, reauthorizer: Object.freeze({ authorized: false, code: 'FIELD' }) })
    expect((await withIt.approve()).status).toBe('approved')
    expect(withIt.reauthorizations).toEqual([])
    const without = service({ bound: false, omit: true })
    expect((await without.approve()).status).toBe('approved')
    without.statements.length = 0
    await expect(without.inspect()).rejects.toMatchObject({ code: 'YIDA_SEND_APPROVAL_NOT_FOUND' })
    expect(without.statements.some(sql => sql.includes('subject_authorization_versions'))).toBe(false)
  })
})
