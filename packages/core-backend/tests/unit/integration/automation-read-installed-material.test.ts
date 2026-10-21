import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AutomationInstalledMaterialError,
  loadAutomationReadInstalledMaterial as load,
  type AutomationReadInstalledMaterialInput,
  type AutomationInstalledMaterialErrorCode,
} from '../../../src/integration/automation-read-installed-material'
import { canonicalizeConfig } from '../../../src/multitable/automation-action-idempotency'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

type Row = Record<string, unknown>
type Fixture = { isolation: unknown; xids: unknown[]; registry: Row[]; ledger: Row[]; fields: Row[];
  schemas: Row[]; sheets: Row[]; bases: Row[]; epochs: Row[] }
const privateDetail = 'synthetic_private_driver_detail'
const stamp = '2026-10-01T00:00:00.123456Z'
const changedStamp = '2026-10-01T00:00:00.123457Z'
const baseId = 'synthetic-actual-base'
const revision = '11111111-1111-4111-8111-111111111111'
function input(): AutomationReadInstalledMaterialInput {
  return { tenantId: 'synthetic-tenant', workspaceId: null, projectId: 'synthetic-project',
    objectId: 'synthetic-object', sheetId: 'synthetic-sheet', fieldIdMap: { ext_spec: 'physical_spec' } }
}
function registry(overrides: Row = {}): Row {
  const scope = input()
  return { sheet_id: scope.sheetId, project_id: scope.projectId, object_id: scope.objectId,
    plugin_name: 'plugin-integration-core', created_at: stamp, updated_at: stamp, ...overrides }
}
function candidate(overrides: Row = {}): Row {
  return { fieldId: 'ext_spec', ownership: 'plm_system', preserveOnRefresh: false, extension: true, ...overrides }
}
function install(overrides: Row = {}): Row {
  const scope = input()
  return { id: 'synthetic-install', tenant_id: scope.tenantId, workspace_id: null, project_id: scope.projectId,
    object_id: scope.objectId, pack_id: 'synthetic-pack', pack_version: '1', mode: 'install', status: 'installed',
    installed_fields_json: [candidate()], summary_json: { created: 1 }, warnings_json: [],
    last_install_at: stamp, created_at: stamp, ...overrides }
}
function field(overrides: Row = {}): Row {
  return { id: 'physical_spec', sheet_id: input().sheetId, name: 'Synthetic field', type: 'string',
    property: { stockPreparation: { ownership: 'plm_system', preserveOnRefresh: false, extension: true,
      packId: 'synthetic-pack', packVersion: 1 }, nested: { array: ['synthetic-private-cell-definition'] } },
    order: 0, created_at: stamp, updated_at: stamp, ...overrides }
}
function fixture(overrides: Partial<Fixture> = {}): Fixture {
  return { isolation: 'read committed', xids: ['100', '100'], registry: [{ raw_registry: registry() }],
    ledger: [{ raw_install: install() }], fields: [{ raw_field: field() }], schemas: [{ consistent: true }],
    sheets: [{ id: input().sheetId, base_id: baseId, deleted_at: null }], bases: [{ id: baseId, deleted_at: null }],
    epochs: [{ kind: 'sheet', scope: { id: input().sheetId }, revision }, { kind: 'base', scope: { id: baseId }, revision },
      { kind: 'pack', scope: { tenantId: input().tenantId, projectId: input().projectId, objectId: input().objectId }, revision }],
    ...overrides }
}
function empty(): Fixture { return fixture({ ledger: [], fields: [] }) }
function harness(data = fixture(), options: { failAt?: string; onQuery?: (sql: string) => void } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probe = 0
  const trx: Queryable = {
    async query(sql, params = []) {
      calls.push({ sql, params })
      options.onQuery?.(sql)
      if (options.failAt && sql.includes(options.failAt)) throw Object.assign(new Error(privateDetail), { code: '55P03', detail: privateDetail })
      let rows: Row[]
      if (sql.includes('current_setting')) rows = [{ isolation: data.isolation }]
      else if (sql.includes('pg_current_xact_id')) rows = [{ xid: data.xids[probe++ % data.xids.length] }]
      else if (sql.startsWith('LOCK TABLE')) rows = []
      else if (sql.includes('AS consistent')) rows = data.schemas
      else if (sql.includes('FROM meta_sheets')) rows = data.sheets
      else if (sql.includes('FROM meta_bases')) rows = data.bases
      else if (sql.includes('FROM automation_read_material_epochs')) rows = data.epochs
      else if (sql.includes('FROM plugin_multitable_object_registry')) rows = data.registry
      else if (sql.includes('FROM integration_stock_prep_pack_installs')) rows = data.ledger
      else if (sql.includes('FROM meta_fields')) rows = data.fields
      else throw new Error('Unexpected query')
      return { rows, rowCount: rows.length }
    },
  }
  return { trx, calls }
}
async function refused(promise: Promise<unknown>, code: AutomationInstalledMaterialErrorCode) {
  const error: unknown = await promise.then(() => undefined, caught => caught)
  expect(error).toBeInstanceOf(AutomationInstalledMaterialError)
  expect(error).toMatchObject({ name: 'AutomationInstalledMaterialError', code, message: code })
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('details')
  expect(String(error)).not.toContain(privateDetail)
}
function loadFixture(data: Fixture, scope = input()) { return load(harness(data).trx, scope) }
const denied = 'AUTOMATION_INSTALLED_DENIED'
const unavailable = 'AUTOMATION_INSTALLED_UNAVAILABLE'

describe('strict installed material loader (actual helper with query fixtures; not PostgreSQL locking proof)', () => {
  it('returns live properties/content hash plus actual base and DB epochs, not authority', async () => {
    const data = fixture()
    const result = await loadFixture(data)
    expect(result).toEqual({ installedFieldProperties: [{ fieldId: 'ext_spec', property: field().property }], baseId,
      revisions: { sheet: revision, base: revision, pack: revision },
      fingerprint: createHash('sha256').update(canonicalizeConfig({ scope: input(), registry: registry(),
        ledger: [install()], fields: [field()] })).digest('hex') })
    expect(Object.keys(result).sort()).toEqual(['baseId', 'fingerprint', 'installedFieldProperties', 'revisions'])
    expect(result).not.toHaveProperty('tenantId')
    expect(result).not.toHaveProperty('permissionProof')
  })
  it('locks phantom-bearing tables before exact registry and complete bounded reads', async () => {
    const { trx, calls } = harness()
    await load(trx, input())
    expect(calls).toHaveLength(14)
    expect(calls[0].sql).toContain("current_setting('transaction_isolation')")
    expect(calls[1].sql).toContain('pg_current_xact_id()')
    expect(calls[2].sql).toContain('pg_current_xact_id()')
    expect(calls[3].sql).toContain("current_setting('transaction_isolation')")
    expect(calls[4].sql).toContain('pg_current_xact_id()')
    expect(calls[5].sql).toContain('pg_current_xact_id()')
    expect(calls[6].sql).toContain('LOCK TABLE meta_bases, meta_sheets, meta_fields,')
    expect(calls[6].sql).toContain('plugin_multitable_object_registry, integration_stock_prep_pack_installs IN SHARE MODE NOWAIT')
    expect(calls[10].sql).toContain('FROM automation_read_material_epochs')
    expect(calls[10].sql).toContain('FOR SHARE NOWAIT')
    expect(calls[11].sql).toContain("r.plugin_name = 'plugin-integration-core' FOR SHARE NOWAIT")
    expect(calls[11].sql).toContain('r.sheet_id = $1 AND r.project_id = $2 AND r.object_id = $3')
    expect(calls[11].params).toEqual([input().sheetId, input().projectId, input().objectId])
    expect(calls[12].sql).toContain('i.tenant_id = $1 AND i.project_id = $2 AND i.object_id = $3')
    expect(calls[12].sql).toContain('ORDER BY i.id LIMIT 201')
    expect(calls[12].sql.split('WHERE')[1]).not.toMatch(/workspace|status/u)
    expect(calls[12].params).toEqual([input().tenantId, input().projectId, input().objectId])
    expect(calls[13].sql).toContain('WHERE f.sheet_id = $1 ORDER BY f.id LIMIT 2049')
    expect(calls[13].sql).not.toMatch(/ANY|property\s*->/u)
    expect(calls[13].params).toEqual([input().sheetId])
    for (const call of calls.slice(11)) {
      expect(call.sql).toContain('pg_catalog.to_jsonb(')
      expect(call.sql).toContain("AT TIME ZONE 'UTC'")
      expect(call.sql).toContain('HH24:MI:SS.US')
    }
    expect(calls.map(call => call.sql).join('\n')).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|meta_records)\b/u)
  })
  it('accepts an explicitly empty installation only after positive registry and all-table reads', async () => {
    const scope = input(); scope.fieldIdMap = {}
    const { trx, calls } = harness(empty())
    expect((await load(trx, scope)).installedFieldProperties).toEqual([])
    expect(calls).toHaveLength(14)
  })
  it('accepts exact identity map and resolves actual logical-id field, not deterministic metadata', async () => {
    const scope = input(); scope.fieldIdMap = {}
    const result = await loadFixture(fixture({ fields: [{ raw_field: field({ id: 'ext_spec' }) }] }), scope)
    expect(result.installedFieldProperties.map(entry => entry.fieldId)).toEqual(['ext_spec'])
  })
  it('does not narrow non-pack action map keys to the ledger handle grammar', async () => {
    const scope = input()
    scope.fieldIdMap['自定义字段'] = 'physical_custom'
    scope.fieldIdMap['x'.repeat(121)] = 'physical_long'
    expect((await loadFixture(fixture(), scope)).installedFieldProperties).toHaveLength(1)
  })
  it('does not require projectId to equal any base, or derive physical ids from project/object', async () => {
    const scope = input(); scope.fieldIdMap = { ext_spec: 'arbitrary-existing-field' }
    expect((await loadFixture(fixture({ fields: [{ raw_field: field({ id: 'arbitrary-existing-field' }) }] }), scope))
      .installedFieldProperties[0].fieldId).toBe('ext_spec')
  })
  it('accepts partial install and returns live ownership even if ledger and provenance differ', async () => {
    const live = field({ property: { stockPreparation: { ownership: 'human_preserved', preserveOnRefresh: true,
      extension: true, packId: 'older-synthetic-pack', packVersion: 0 } } })
    const result = await loadFixture(fixture({ ledger: [{ raw_install: install({ status: 'partial', pack_version: '4' }) }],
      fields: [{ raw_field: live }] }))
    expect(result.installedFieldProperties[0].property).toEqual(live.property)
  })
  it('deduplicates cross-pack candidates without adopting ledger ownership', async () => {
    const result = await loadFixture(fixture({ ledger: [{ raw_install: install() }, { raw_install: install({ id: 'second-install',
      pack_id: 'other-pack', installed_fields_json: [candidate({ ownership: 'human_preserved', preserveOnRefresh: true })] }) }] }))
    expect(result.installedFieldProperties).toHaveLength(1)
    expect(result.installedFieldProperties[0].property).toEqual(field().property)
  })
  it('keeps ledger extension false as audit and does not require live stamps on candidates', async () => {
    const result = await loadFixture(fixture({ ledger: [{ raw_install: install({ installed_fields_json: [candidate({ extension: false })] }) }],
      fields: [{ raw_field: field({ property: { custom: { live: true } }, created_at: null, updated_at: null }) }] }))
    expect(result.installedFieldProperties[0].property).toEqual({ custom: { live: true } })
  })
  it('canonical optionSource/customerPack provenance is not an orphan extension marker', async () => {
    const data = empty()
    data.fields = [{ raw_field: field({ property: { stockPreparation: { customerPack: { packId: 'synthetic-pack' },
      optionSource: 'synthetic-options', ownership: 'human_preserved' }, packId: 'synthetic-pack' } }) }]
    const scope = input(); scope.fieldIdMap = { materialType: 'physical_spec' }
    expect((await loadFixture(data, scope)).installedFieldProperties).toEqual([])
  })
  it('does not promote a marker-negative scan into complete install-lifecycle proof', async () => {
    const data = empty()
    data.fields = [{ raw_field: field({ id: 'untracked-adopted-field', property: { stockPreparation: {
      ownership: 'plm_system', preserveOnRefresh: false } } }) }]
    // An ALREADY_STAMPED adoption can look like this: only a later trusted
    // deployment/lifecycle proof can decide whether these inputs are complete.
    expect((await loadFixture(data)).installedFieldProperties).toEqual([])
  })
  it('refuses a live extension marker orphan even with no ledger rows', async () => {
    await refused(loadFixture(fixture({ ledger: [] })), denied)
  })
  it('refuses an existing mapped ext_ field without ledger candidate even when unstamped', async () => {
    await refused(loadFixture(fixture({ ledger: [], fields: [{ raw_field: field({ property: {} }) }] })), denied)
  })
  it('refuses an extra marked field outside otherwise complete candidates', async () => {
    await refused(loadFixture(fixture({ fields: [{ raw_field: field() }, { raw_field: field({ id: 'physical_orphan' }) }] })), denied)
  })
  it('does not let an unrelated map key fulfill a candidate through identity fallback', async () => {
    const scope = input(); scope.fieldIdMap = { notes: 'physical_notes' }
    await refused(loadFixture(fixture({ fields: [{ raw_field: field({ id: 'ext_spec' }) }] }), scope), denied)
  })
  it('refuses a missing candidate despite presence of another plausible logical field', async () => {
    await refused(loadFixture(fixture({ fields: [{ raw_field: field({ id: 'ext_spec' }) }] })), denied)
  })
  it('does not substitute an empty property for missing/null/malformed live property', async () => {
    for (const property of [undefined, null, [], '{}', true, 1]) {
      const raw = field({ property }); if (property === undefined) delete raw.property
      await refused(loadFixture(fixture({ fields: [{ raw_field: raw }] })), unavailable)
    }
  })
  it.each(['registry', 'ledger', 'fields'] as const)('rejects undeclared %s query-envelope keys', async key => {
    const data = fixture(); data[key][0].extra = true
    await refused(loadFixture(data), unavailable)
  })
  it.each(['sheet_id', 'project_id', 'object_id', 'plugin_name'])('registry cannot switch %s identity', async key => {
    await refused(loadFixture(fixture({ registry: [{ raw_registry: registry({ [key]: 'other-synthetic-id' }) }] })), denied)
  })
  it.each([[], [{ raw_registry: registry() }, { raw_registry: registry() }]].map(rows => ({ rows })))('registry must be one positive row', async ({ rows }) => {
    await refused(loadFixture(fixture({ registry: rows })), denied)
  })
  it.each(['tenant_id', 'project_id', 'object_id'])('ledger cannot adopt another %s', async key => {
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ [key]: 'other-synthetic-id' }) }] })), denied)
  })
  it.each(['synthetic-workspace', '', false, 0, []].map(workspace => ({ workspace })))('refuses non-null persisted workspace $workspace', async ({ workspace }) => {
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ workspace_id: workspace }) }] })), denied)
  })
  it.each(['failed', 'pending', 'unknown', null, ['installed']].map(status => ({ status })))('does not filter away unsupported ledger status $status', async ({ status }) => {
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ status }) }] })), denied)
  })
  it.each(['unknown', null, ['install']].map(mode => ({ mode })))('mode must remain exact audit vocabulary $mode', async ({ mode }) => {
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ mode }) }] })), unavailable)
  })
  it.each([null, '{}', {}, false, 1])('installed_fields_json is an actual JSON array, never parsed/fallback %j', async value => {
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ installed_fields_json: value }) }] })), unavailable)
  })
  const invalidCandidates: unknown[] = [null, [], {}, candidate({ extra: true }), candidate({ fieldId: '' }),
    candidate({ fieldId: ' ext_spec' }), candidate({ fieldId: 'x'.repeat(121) }), candidate({ fieldId: 'ext_bad/name' }),
    candidate({ fieldId: '__proto__' }), candidate({ ownership: 'unknown' }), candidate({ ownership: ['plm_system'] }),
    candidate({ preserveOnRefresh: 'false' }), candidate({ extension: 1 })]
  it.each(invalidCandidates.map(entry => ({ entry })))('strictly refuses malformed candidate $entry', async ({ entry }) => {
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ installed_fields_json: [entry] }) }] })), unavailable)
  })
  it.each(['fieldId', 'ownership', 'preserveOnRefresh', 'extension'])('requires candidate key %s explicitly', async key => {
    const entry = candidate(); delete entry[key]
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ installed_fields_json: [entry] }) }] })), unavailable)
  })
  it('rejects duplicate within-pack candidates and duplicate ledger row ids', async () => {
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install({ installed_fields_json: [candidate(), candidate()] }) }] })), unavailable)
    await refused(loadFixture(fixture({ ledger: [{ raw_install: install() }, { raw_install: install() }] })), unavailable)
  })
  it.each(['registry', 'ledger', 'fields'] as const)('rejects incomplete raw %s schema', async key => {
    const data = fixture()
    const alias = { registry: 'raw_registry', ledger: 'raw_install', fields: 'raw_field' }[key]
    const raw = data[key][0][alias] as Row
    delete raw.created_at
    await refused(loadFixture(data), unavailable)
  })
  it('refuses a returned field on another sheet and duplicate returned field ids', async () => {
    await refused(loadFixture(fixture({ fields: [{ raw_field: field({ sheet_id: 'other-sheet' }) }] })), denied)
    await refused(loadFixture(fixture({ fields: [{ raw_field: field() }, { raw_field: field() }] })), unavailable)
  })
  it.each([['name', null], ['type', ''], ['order', 0.1], ['id', ' field'], ['created_at', new Date(0)], ['updated_at', '2026-10-01T00:00:00Z']])(
    'rejects malformed field metadata %s', async (key, value) => {
      await refused(loadFixture(fixture({ fields: [{ raw_field: field({ [String(key)]: value }) }] })), unavailable)
    },
  )
  it('accepts exactly 200 ledger rows and refuses the overflow sentinel', async () => {
    const ledger = Array.from({ length: 200 }, (_value, i) => ({ raw_install: install({ id: `install-${String(i).padStart(3, '0')}`,
      pack_id: `pack-${i}`, installed_fields_json: [] }) }))
    expect((await loadFixture(emptyWith({ ledger }))).installedFieldProperties).toEqual([])
    await refused(loadFixture(emptyWith({ ledger: [...ledger, { raw_install: install({ id: 'install-200', installed_fields_json: [] }) }] })), denied)
  })
  it('accepts exactly 2048 fields and refuses the overflow sentinel', async () => {
    const fields = Array.from({ length: 2048 }, (_value, i) => ({ raw_field: field({ id: `field-${String(i).padStart(4, '0')}`, property: {} }) }))
    expect((await loadFixture(emptyWith({ fields }))).installedFieldProperties).toEqual([])
    await refused(loadFixture(emptyWith({ fields: [...fields, { raw_field: field({ id: 'field-2048', property: {} }) }] })), denied)
  })

  const inputMutations: Array<(scope: Row) => void> = [
    scope => { delete scope.workspaceId }, scope => { delete scope.fieldIdMap }, scope => { scope.extra = true },
    scope => { scope.workspaceId = 'synthetic-workspace' }, scope => { scope.tenantId = ' synthetic-tenant' },
    scope => { scope.projectId = '' }, scope => { scope.objectId = 'bad\nobject' }, scope => { scope.sheetId = 'x'.repeat(256) },
    scope => { scope.fieldIdMap = null }, scope => { scope.fieldIdMap = [] }, scope => { scope.fieldIdMap = '' },
    scope => { scope.fieldIdMap = { ext_spec: 'same', extra: 'same' } },
    scope => { scope.fieldIdMap = { ' ext_spec': 'physical_spec' } }, scope => { scope.fieldIdMap = { ext_spec: ' physical_spec' } },
    scope => { scope.fieldIdMap = { ext_spec: 'constructor' } },
    scope => { scope.fieldIdMap = Object.fromEntries([['__proto__', 'physical_spec']]) },
    scope => { scope.fieldIdMap = { ext_spec: undefined } }, scope => { scope.fieldIdMap = { ext_spec: 'bad\u0000field' } },
    scope => { scope.fieldIdMap = { ['x'.repeat(256)]: 'physical_spec' } },
    scope => { scope.fieldIdMap = Object.fromEntries(Array.from({ length: 2049 }, (_value, i) => [`f${i}`, `p${i}`])) },
  ]
  it.each(inputMutations.map((mutate, index) => ({ mutate, index })))('rejects bad input $index before any SQL', async ({ mutate }) => {
    const scope: Row = input(); mutate(scope)
    const { trx, calls } = harness()
    await refused(load(trx, scope as AutomationReadInstalledMaterialInput), 'AUTOMATION_INSTALLED_INPUT_INVALID')
    expect(calls).toEqual([])
  })
  it('never invokes input accessors or serialization hooks', async () => {
    let calls = 0
    const scope = input()
    Object.defineProperty(scope.fieldIdMap, 'extra', { enumerable: true, get() { calls += 1; throw new Error(privateDetail) } })
    await refused(load(harness().trx, scope), 'AUTOMATION_INSTALLED_INPUT_INVALID')
    const root = input()
    Object.defineProperty(root, 'tenantId', { enumerable: true, get() { calls += 1; return 'synthetic-tenant' } })
    await refused(load(harness().trx, root), 'AUTOMATION_INSTALLED_INPUT_INVALID')
    expect(calls).toBe(0)
  })
  it('captures scope/map before first await so later caller edits cannot switch SQL or candidates', async () => {
    const scope = input()
    const { trx, calls } = harness(fixture(), { onQuery(sql) {
      if (sql.includes('current_setting')) {
        scope.tenantId = 'other-tenant'; scope.projectId = 'other-project'; scope.sheetId = 'other-sheet'
        scope.fieldIdMap.ext_spec = 'other-field'
      }
    } })
    expect((await load(trx, scope)).installedFieldProperties).toEqual([{ fieldId: 'ext_spec', property: field().property }])
    expect(calls[11].params).toEqual([input().sheetId, input().projectId, input().objectId])
    expect(calls[12].params).toEqual([input().tenantId, input().projectId, input().objectId])
  })
  it.each(['repeatable read', 'serializable', null, undefined])('requires actual read committed, not %j', async isolation => {
    const { trx, calls } = harness(fixture({ isolation }))
    await refused(load(trx, input()), 'AUTOMATION_INSTALLED_TRANSACTION_REQUIRED')
    expect(calls).toHaveLength(1)
  })
  it.each([['100', '101'], [undefined, undefined], [1, 1], ['', '']])('rejects autocommit/wrong transaction probes %j', async (...xids) => {
    const { trx, calls } = harness(fixture({ xids }))
    await refused(load(trx, input()), 'AUTOMATION_INSTALLED_TRANSACTION_REQUIRED')
    expect(calls.some(call => call.sql.startsWith('LOCK'))).toBe(false)
  })
  it.each(['LOCK TABLE', 'FROM plugin_multitable_object_registry', 'FROM integration_stock_prep_pack_installs', 'FROM meta_fields'])(
    'missing table/column, NOWAIT and driver errors at %s never escape or fall back', async failAt => {
      await refused(load(harness(fixture(), { failAt }).trx, input()), unavailable)
    },
  )
  it('replaces driver failure during transaction checks with a fixed transaction error', async () => {
    await refused(load(harness(fixture(), { failAt: 'pg_current_xact_id' }).trx, input()), 'AUTOMATION_INSTALLED_TRANSACTION_REQUIRED')
  })
  it('requires the actual epoch helper and rejects a positive ledger without its scope nonce', async () => {
    const data = fixture(); data.epochs = data.epochs.filter(row => row.kind !== 'pack')
    await refused(loadFixture(data), denied)
    data.ledger = []; data.fields = []
    expect((await loadFixture(data)).revisions.pack).toBeNull()
  })
  it('retains a pack tombstone nonce for empty current ledger and keeps epochs separate from content hash', async () => {
    const data = empty()
    const first = await loadFixture(data)
    expect(first.revisions.pack).toBe(revision)
    data.epochs.forEach(row => { row.revision = '22222222-2222-4222-8222-222222222222' })
    const second = await loadFixture(data)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.revisions).not.toEqual(first.revisions)
    expect(Object.isFrozen(second.revisions)).toBe(true)
  })
  it.each(['sheet', 'base'])('never tolerates missing required %s epoch as a legacy schema', async kind => {
    const data = fixture(); data.epochs = data.epochs.filter(row => row.kind !== kind)
    await refused(loadFixture(data), denied)
  })
  it.each(['AS consistent', 'FROM meta_sheets', 'FROM meta_bases', 'FROM automation_read_material_epochs'])(
    'sanitizes actual epoch/source-schema failure at %s', async failAt => {
      await refused(load(harness(fixture(), { failAt }).trx, input()), unavailable)
    },
  )
  it('does not bypass a same-schema refusal or adopt a caller-guessed base', async () => {
    await refused(loadFixture(fixture({ schemas: [{ consistent: false }] })), unavailable)
    const actual = await loadFixture(fixture())
    expect(actual.baseId).toBe(baseId)
    expect(actual.baseId).not.toBe(input().projectId)
  })

  const changes: Array<[string, (data: Fixture, scope: AutomationReadInstalledMaterialInput) => void]> = [
    ['registry microseconds', data => { (data.registry[0].raw_registry as Row).updated_at = changedStamp }],
    ['future registry metadata', data => { (data.registry[0].raw_registry as Row).future_binding = { stamp: 2 } }],
    ['ledger microseconds', data => { (data.ledger[0].raw_install as Row).last_install_at = changedStamp }],
    ['ledger raw ownership', data => { (data.ledger[0].raw_install as Row).installed_fields_json = [candidate({ ownership: 'human_preserved' })] }],
    ['ledger summary', data => { (data.ledger[0].raw_install as Row).summary_json = { created: 2 } }],
    ['ledger warnings', data => { (data.ledger[0].raw_install as Row).warnings_json = ['synthetic_warning'] }],
    ['ledger version', data => { (data.ledger[0].raw_install as Row).pack_version = '2' }],
    ['full live field property', data => { (data.fields[0].raw_field as Row).property = { stockPreparation: { extension: true }, other: { nested: 2 } } }],
    ['unrelated live field', data => { data.fields.push({ raw_field: field({ id: 'physical_unrelated', property: { optionSource: 'synthetic-other' } }) }) }],
    ['field microseconds', data => { (data.fields[0].raw_field as Row).updated_at = changedStamp }],
    ['future field metadata', data => { (data.fields[0].raw_field as Row).future_metadata = ['synthetic'] }],
    ['complete unused map', (_data, scope) => { scope.fieldIdMap.unused = 'physical_unused' }],
  ]
  it.each(changes)('fingerprints %s, not just returned candidate properties', async (_name, mutate) => {
    const first = await loadFixture(fixture())
    const data = fixture(); const scope = input(); mutate(data, scope)
    expect((await loadFixture(data, scope)).fingerprint).not.toBe(first.fingerprint)
  })
  it('plain-object key order is immaterial, unlike installed-field array content/order', async () => {
    const data = fixture()
    data.fields[0].raw_field = Object.fromEntries(Object.entries(data.fields[0].raw_field as Row).reverse())
    expect((await loadFixture(data)).fingerprint).toBe((await loadFixture(fixture())).fingerprint)
  })
  it('copies/freeze all nested returned properties without freezing or aliasing driver rows', async () => {
    const data = fixture()
    const result = await loadFixture(data)
    const frozen = (value: unknown): void => {
      if (value && typeof value === 'object') { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen) }
    }
    frozen(result)
    const property = (data.fields[0].raw_field as Row).property as Row
    expect(Object.isFrozen(property)).toBe(false)
    property.stockPreparation = { ownership: 'human_preserved' }
    const nestedArray = (property.nested as Row).array as string[]
    nestedArray[0] = 'changed-after-read'
    expect(result.installedFieldProperties[0].property).toEqual(field().property)
    expect(Reflect.set(result.installedFieldProperties[0].property, 'extra', true)).toBe(false)
  })
  it.each([undefined, () => true, NaN, Infinity, 1n, Symbol('synthetic'), new Date(0), new Map(), new Set()])(
    'rejects non-JSON metadata without lossy serialization %#', async value => {
      const raw = field(); (raw.property as Row).extra = value
      await refused(loadFixture(fixture({ fields: [{ raw_field: raw }] })), unavailable)
    },
  )
  it('rejects cyclic, sparse, non-enumerable and symbol material without executing hooks', async () => {
    const cyclic: Row = {}; cyclic.self = cyclic
    const sparse = new Array(1)
    const hidden = Object.defineProperty({}, 'hidden', { value: true })
    const symbol = { [Symbol('synthetic')]: true }
    for (const value of [cyclic, sparse, hidden, symbol]) {
      await refused(loadFixture(fixture({ fields: [{ raw_field: field({ property: { value } }) }] })), unavailable)
    }
    let calls = 0
    const property = Object.defineProperty({}, 'unsafe', { enumerable: true, get() { calls += 1; throw new Error(privateDetail) } })
    await refused(loadFixture(fixture({ fields: [{ raw_field: field({ property }) }] })), unavailable)
    await refused(loadFixture(fixture({ fields: [{ raw_field: field({ property: { toJSON() { calls += 1; return {} } } }) }] })), unavailable)
    expect(calls).toBe(0)
  })
})

function emptyWith(overrides: Partial<Fixture>) { return { ...empty(), ...overrides } }
