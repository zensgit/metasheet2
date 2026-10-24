import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import {
  SOURCE_PLAN_DRAFT_SECTIONS,
  compileSourcePlanDraft,
  createEmptySourcePlanDraft,
  createSyntheticSourcePlanDraft,
  parseSourcePlanDraftJson,
  parseBomActiveStateInputs,
  SOURCE_PLAN_DRAFT_MAX_JSON_BYTES,
  type SourcePlanDraft,
} from '../src/services/integration/stockPreparation/sourcePlanDraft'

// This is the production CJS normalizer and expander. Only their external read boundary
// uses in-memory synthetic records; no backend contract or result is substituted.
const require = createRequire(import.meta.url)
const { normalizeStockPreparationBomReadPlan, expandPlmProjectBom } = require(
  '../../../plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs',
)

function renamedLayout(prefix: string): SourcePlanDraft {
  const draft = createEmptySourcePlanDraft()
  for (const [sectionIndex, section] of SOURCE_PLAN_DRAFT_SECTIONS.entries()) {
    for (const [fieldIndex, field] of section.fields.entries()) {
      draft.roles[section.key][field.key] = field.kind === 'object'
        ? `${prefix}_${sectionIndex}_Table`
        : `${prefix}_${sectionIndex}_${fieldIndex}_column`
    }
  }
  return draft
}

function syntheticSource(draft: SourcePlanDraft) {
  // The fixture is the user's proposed layout, independent of the compiler's output.
  // If compilation rewires a role, these records do not follow it.
  const plan = draft.roles
  const project = 'SYN-PROJECT'
  const path = 'SYN-PATH'
  const order = 'SYN-ORDER'
  const root = 'SYN-ROOT'
  const child = 'SYN-CHILD'
  const bom = 'SYN-BOM'
  const data: Record<string, Array<Record<string, unknown>>> = {
    [plan.pathExAttr.object]: [{ [plan.pathExAttr.matchField]: project, [plan.pathExAttr.pathIdField]: path }],
    [plan.pathInfo.object]: [{ [plan.pathInfo.idField]: path }],
    [plan.orderHead.object]: [{ [plan.orderHead.idField]: order, [plan.orderHead.pathIdField]: path }],
    [plan.orderDetail.object]: [{
      [plan.orderDetail.orderIdField]: order,
      [plan.orderDetail.componentIdField]: root,
      [plan.orderDetail.quantityField]: '2',
      [plan.orderDetail.versionField]: 'V1',
    }],
    [plan.part.object]: [
      {
        [plan.part.idField]: root,
        [plan.part.codeField]: 'SYN-A-001',
        [plan.part.nameField]: 'Synthetic assembly',
        [plan.part.versionField]: 'V2',
      },
      {
        [plan.part.idField]: child,
        [plan.part.codeField]: 'SYN-B-001',
        [plan.part.nameField]: 'Synthetic child',
        [plan.part.versionField]: 'V3',
      },
    ],
    [plan.bomHead.object]: [{
      [plan.bomHead.parentPartField]: root,
      [plan.bomHead.bomIdField]: bom,
      [plan.bomHead.versionField]: 'V1',
      [plan.bomHead.activeField]: true,
    }],
    [plan.bomDetail.object]: [{
      [plan.bomDetail.bomParentField]: bom,
      [plan.bomDetail.componentIdField]: child,
      [plan.bomDetail.quantityField]: '3',
    }],
  }
  const calls: Array<{ object: string; filters: Record<string, unknown> }> = []
  const sourceAdapter = {
    async read(input: { object: string; filters: Record<string, unknown> }) {
      calls.push({ object: input.object, filters: { ...input.filters } })
      const records = (data[input.object] || []).filter((row) =>
        Object.entries(input.filters).every(([field, expected]) => row[field] === expected),
      )
      return { records, done: true }
    },
  }
  return { sourceAdapter, calls, project, root, child }
}

function exportedEnvelope(draft: SourcePlanDraft = createSyntheticSourcePlanDraft()): Record<string, unknown> {
  const result = compileSourcePlanDraft(draft)
  expect(result.ok).toBe(true)
  return JSON.parse(JSON.stringify(result.envelope)) as Record<string, unknown>
}

const brokenObjectNames = [
  'sales..order_line',
  'order_line.',
  '.order_line',
  'db.sales.order_line',
  'sales_schema.1order_line',
  '1order_line',
  'order_line;sentinel_drop_marker',
  "order_line' OR sentinel_quote_marker",
  'sales.select',
  'from_orders',
  'b'.repeat(129),
  `ab.${'c'.repeat(126)}`,
]

describe('local stock preparation source role draft', () => {
  it('starts with every real role as a string and an independent synthetic layout', () => {
    const empty = createEmptySourcePlanDraft()
    const synthetic = createSyntheticSourcePlanDraft()
    expect(empty.maxReadCount).toBe(200)
    expect(synthetic.maxReadCount).toBe(200)
    expect(SOURCE_PLAN_DRAFT_SECTIONS.map((section) => section.key)).toEqual([
      'pathExAttr', 'pathInfo', 'orderHead', 'orderDetail', 'part', 'bomHead', 'bomDetail',
    ])
    for (const section of SOURCE_PLAN_DRAFT_SECTIONS) {
      expect(Object.keys(empty.roles[section.key])).toEqual(section.fields.map((field) => field.key))
      for (const field of section.fields) {
        expect(empty.roles[section.key][field.key]).toBe('')
        expect(synthetic.roles[section.key][field.key]).toMatch(/^SYN_|^syn_/)
      }
    }
    expect(empty.roles.orderDetail.versionField).toBe('')
    expect(createEmptySourcePlanDraft()).toEqual(empty)
    expect(synthetic.roles.part.object).not.toBe(normalizeStockPreparationBomReadPlan().part.object)
  })

  it.each(['SYN_A', 'SYN_B'])('compiles renamed layout %s through the real normalizer and expander', async (prefix) => {
    const draft = renamedLayout(prefix)
    const before = JSON.stringify(draft)
    const result = compileSourcePlanDraft(draft)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.envelope).not.toBeNull()
    const envelope = result.envelope!
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      kind: 'stock-preparation-plm-role-draft',
      status: 'confirm-required',
      validation: 'structure-only',
    })
    expect(envelope.readPlan.id).toBe('plm.stock-preparation.bom-read.user-draft.v1')
    expect(envelope.readPlan.sourceKind).toBe('data-source:sql-readonly')
    expect(envelope.readPlan.matchField).toBe(draft.roles.pathExAttr.matchField)
    for (const section of SOURCE_PLAN_DRAFT_SECTIONS) {
      const expected = Object.fromEntries(section.fields.map((field) => [
        field.key,
        draft.roles[section.key][field.key].trim(),
      ]))
      expect(envelope.readPlan[section.key]).toEqual(expected)
    }
    expect(normalizeStockPreparationBomReadPlan(envelope.readPlan)).toEqual(envelope.readPlan)
    expect(JSON.stringify(draft)).toBe(before)
    expect(compileSourcePlanDraft(draft)).toEqual(result)

    const source = syntheticSource(draft)
    const expansion = await expandPlmProjectBom({
      sourceAdapter: source.sourceAdapter,
      projectNo: source.project,
      readPlan: envelope.readPlan,
    })
    expect(expansion.valid).toBe(true)
    expect(expansion.rows.map((row: { componentSourceId: string }) => row.componentSourceId)).toEqual([source.root, source.child])
    expect(expansion.rows[0].sourceVersion).toBe('V2')
    expect(expansion.rows[0].orderBomVersion).toBe('V1')
    expect(expansion.rows[1].sourceVersion).toBe('V3')
    expect(expansion.rows[0].totalQuantity).toBe(2)
    expect(expansion.rows[1].totalQuantity).toBe(6)
    expect(source.calls).toContainEqual({
      object: draft.roles.bomHead.object,
      filters: {
        [draft.roles.bomHead.parentPartField]: source.root,
        [draft.roles.bomHead.versionField]: 'V1',
      },
    })

    // In-memory mutation proof: a legal but wrong compiled part object misses the
    // independent source fixture, instead of silently constructing matching data.
    const mutantReadPlan = {
      ...envelope.readPlan,
      part: { ...envelope.readPlan.part, object: 'SYN_UNRELATED_PART' },
    }
    const mutant = await expandPlmProjectBom({
      sourceAdapter: source.sourceAdapter,
      projectNo: source.project,
      readPlan: mutantReadPlan,
    })
    expect(mutant.valid).toBe(false)
    expect(mutant.rows).toHaveLength(0)
  })

  it('omits optional blanks and requires the BOM head version for an order version role', () => {
    const draft = renamedLayout('SYN_C')
    draft.roles.orderDetail.sortField = '   '
    draft.roles.part.specField = ''
    draft.roles.orderDetail.versionField = '  '
    draft.roles.bomHead.versionField = ''
    const optional = compileSourcePlanDraft(draft)
    expect(optional.ok).toBe(true)
    expect(optional.envelope!.readPlan.orderDetail).not.toHaveProperty('sortField')
    expect(optional.envelope!.readPlan.orderDetail).not.toHaveProperty('versionField')
    expect(optional.envelope!.readPlan.part).not.toHaveProperty('specField')
    expect(normalizeStockPreparationBomReadPlan(optional.envelope!.readPlan)).toEqual(optional.envelope!.readPlan)

    draft.roles.orderDetail.versionField = 'OrderBomVersion'
    const missing = compileSourcePlanDraft(draft)
    expect(missing.ok).toBe(false)
    expect(missing.envelope).toBeNull()
    expect(missing.issues).toContainEqual(expect.objectContaining({ path: 'roles.bomHead.versionField', code: 'version-dependency' }))
  })

  it('rejects unknown configuration, identity input, executable strings, and unsafe budgets without echoing values', () => {
    const cases: Array<{ draft: unknown; code: string; path: string; sentinel?: string }> = []
    const unknown = renamedLayout('SYN_D') as SourcePlanDraft & { rawSql?: string }
    unknown.rawSql = 'SELECT private_marker FROM records'
    cases.push({ draft: unknown, code: 'unknown-key', path: 'draft', sentinel: 'private_marker' })

    const identity = renamedLayout('SYN_E') as SourcePlanDraft & { tenantId?: string }
    identity.tenantId = 'tenant_private_marker'
    cases.push({ draft: identity, code: 'unknown-key', path: 'draft', sentinel: 'tenant_private_marker' })

    const nested = renamedLayout('SYN_F')
    nested.roles.part.password = 'credential_private_marker'
    cases.push({ draft: nested, code: 'unknown-key', path: 'roles.part', sentinel: 'credential_private_marker' })

    for (const malicious of ['SELECT * FROM secret', 'javascript:alert(1)', 'https://example.invalid/x', 'password', 'tenant_id']) {
      const draft = renamedLayout('SYN_G')
      draft.roles.bomDetail.object = malicious
      cases.push({ draft, code: 'invalid-identifier', path: 'roles.bomDetail.object', sentinel: malicious })
    }
    for (const budget of [0, 1001, 2.5, '200', true, null]) {
      const draft = { ...renamedLayout('SYN_H'), maxReadCount: budget }
      cases.push({ draft, code: 'invalid-budget', path: 'maxReadCount' })
    }
    for (const entry of cases) {
      const result = compileSourcePlanDraft(entry.draft)
      expect(result.ok).toBe(false)
      expect(result.envelope).toBeNull()
      expect(result.issues).toContainEqual(expect.objectContaining({ path: entry.path, code: entry.code }))
      expect(result.issues.every((problem) => problem.zh.length > 0 && problem.en.length > 0)).toBe(true)
      if (entry.sentinel) expect(JSON.stringify(result.issues)).not.toContain(entry.sentinel)
    }
  })

  it('is local and deterministic, with no network calls', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network call'))
    try {
      const draft = createSyntheticSourcePlanDraft()
      const before = JSON.stringify(draft)
      expect(compileSourcePlanDraft(draft)).toEqual(compileSourcePlanDraft(draft))
      expect(JSON.stringify(draft)).toBe(before)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('round-trips only its own pending review envelope, including omitted optional roles', () => {
    const draft = renamedLayout('SYN_IMPORT')
    draft.roles.part.specField = ''
    draft.roles.orderDetail.sortField = ''
    const result = parseSourcePlanDraftJson(JSON.stringify(exportedEnvelope(draft)))
    expect(result).toEqual({ ok: true, issues: [], draft })

    // The serialized read plan correctly omits optional roles. Re-import restores them as empty
    // editable fields rather than treating their absence as an authority-bearing default.
    expect(result.draft!.roles.part.specField).toBe('')
    expect(result.draft!.roles.orderDetail.sortField).toBe('')
  })

  it('rejects altered approval, identity, source, role, budget, and malformed JSON without echoing input', () => {
    const cases: Array<{ text: string; path: string; code: string; sentinel?: string }> = []

    const approved = exportedEnvelope()
    approved.status = 'approved'
    cases.push({ text: JSON.stringify(approved), path: 'status', code: 'invalid-status' })

    const sourceKind = exportedEnvelope()
    ;(sourceKind.readPlan as Record<string, unknown>).sourceKind = 'data-source:other-system'
    cases.push({ text: JSON.stringify(sourceKind), path: 'readPlan', code: 'unexpected-value' })

    const permission = exportedEnvelope()
    permission.permissions = ['integration:admin']
    cases.push({ text: JSON.stringify(permission), path: 'draft', code: 'invalid-envelope' })

    const extraRole = exportedEnvelope()
    ;((extraRole.readPlan as Record<string, unknown>).part as Record<string, unknown>).principal = 'private_principal_marker'
    cases.push({ text: JSON.stringify(extraRole), path: 'readPlan.part', code: 'unknown-key', sentinel: 'private_principal_marker' })

    const budget = exportedEnvelope()
    ;(budget.readPlan as Record<string, unknown>).maxReadCount = 1001
    cases.push({ text: JSON.stringify(budget), path: 'maxReadCount', code: 'invalid-budget' })

    cases.push({ text: '{ private_json_marker', path: 'draft', code: 'invalid-json', sentinel: 'private_json_marker' })
    cases.push({ text: 'x'.repeat(SOURCE_PLAN_DRAFT_MAX_JSON_BYTES + 1), path: 'draft', code: 'payload-too-large' })

    for (const entry of cases) {
      const result = parseSourcePlanDraftJson(entry.text)
      expect(result.ok).toBe(false)
      expect(result.draft).toBeNull()
      expect(result.issues).toContainEqual(expect.objectContaining({ path: entry.path, code: entry.code }))
      expect(result.issues.every((problem) => problem.zh.length > 0 && problem.en.length > 0)).toBe(true)
      if (entry.sentinel) expect(JSON.stringify(result.issues)).not.toContain(entry.sentinel)
    }
  })

  // ---- Optional sourceProjectComparison / bomActiveState (frontend-only; no backend consumption) ----
  const MAX_SAFE = Number.MAX_SAFE_INTEGER

  function stateDraft(active: unknown, inactive: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...createSyntheticSourcePlanDraft(), bomActiveState: { activeValues: active, inactiveValues: inactive }, ...extra }
  }

  function expectRejected(input: unknown, path: string, code: string, sentinel?: string): void {
    const result = compileSourcePlanDraft(input)
    expect(result.ok).toBe(false)
    expect(result.envelope).toBeNull()
    expect(result.issues).toContainEqual(expect.objectContaining({ path, code }))
    expect(result.issues.every((problem) => problem.zh.length > 0 && problem.en.length > 0)).toBe(true)
    if (sentinel) expect(JSON.stringify(result.issues)).not.toContain(sentinel)
  }

  it('adds neither optional key by default and never puts them in the role/column list', () => {
    const empty = createEmptySourcePlanDraft()
    const synthetic = createSyntheticSourcePlanDraft()
    expect(Object.keys(empty)).toEqual(['roles', 'maxReadCount'])
    expect(Object.keys(synthetic)).toEqual(['roles', 'maxReadCount'])
    const plain = compileSourcePlanDraft(synthetic).envelope!.readPlan
    expect(Object.keys(plain)).toEqual([
      'id', 'sourceKind', 'matchField', 'maxReadCount', ...SOURCE_PLAN_DRAFT_SECTIONS.map((section) => section.key),
    ])
    // An explicit undefined is "absent", not a default.
    const undefinedKeys = compileSourcePlanDraft({ ...synthetic, sourceProjectComparison: undefined, bomActiveState: undefined })
    expect(undefinedKeys.ok).toBe(true)
    expect(JSON.stringify(undefinedKeys.envelope)).toBe(JSON.stringify(compileSourcePlanDraft(synthetic).envelope))

    const configured = compileSourcePlanDraft(stateDraft([1], [0], { sourceProjectComparison: 'case-insensitive' })).envelope!.readPlan
    for (const section of SOURCE_PLAN_DRAFT_SECTIONS) {
      expect(configured[section.key]).toEqual(plain[section.key])
    }
    expect(JSON.stringify(configured.bomHead)).not.toContain('case-insensitive')
  })

  it('round-trips both optional fields with exact scalar types and input order', () => {
    const draft: SourcePlanDraft = {
      ...createSyntheticSourcePlanDraft(),
      sourceProjectComparison: 'case-insensitive',
      bomActiveState: {
        activeValues: [true, 1, '1', null, 0.5, MAX_SAFE, ' padded ', '启用', 'A', 'a'],
        inactiveValues: [false, 0, '0', -MAX_SAFE, '停用', -1.25],
      },
    }
    const before = JSON.stringify(draft)
    const compiled = compileSourcePlanDraft(draft)
    expect(compiled.ok).toBe(true)
    const plan = compiled.envelope!.readPlan
    expect(plan.sourceProjectComparison).toBe('case-insensitive')
    expect(plan.bomActiveState).toEqual(draft.bomActiveState)
    expect(plan.bomActiveState!.activeValues).not.toBe(draft.bomActiveState!.activeValues)
    expect(JSON.stringify(draft)).toBe(before)

    const imported = parseSourcePlanDraftJson(JSON.stringify(compiled.envelope))
    expect(imported).toEqual({ ok: true, issues: [], draft })
    expect(compileSourcePlanDraft(imported.draft)).toEqual(compiled)

    for (const only of [
      { sourceProjectComparison: 'case-sensitive' },
      { bomActiveState: { activeValues: [null], inactiveValues: [0] } },
    ]) {
      const single: SourcePlanDraft = { ...createSyntheticSourcePlanDraft(), ...only } as SourcePlanDraft
      const result = parseSourcePlanDraftJson(JSON.stringify(exportedEnvelope(single)))
      expect(result).toEqual({ ok: true, issues: [], draft: single })
      const keys = Object.keys(result.draft!)
      expect(keys).toEqual(['roles', 'maxReadCount', ...Object.keys(only)])
    }

    const legacy = parseSourcePlanDraftJson(JSON.stringify(exportedEnvelope()))
    expect(legacy.ok).toBe(true)
    expect(Object.keys(legacy.draft!)).toEqual(['roles', 'maxReadCount'])
  })

  it('accepts boundary scalars without trimming or folding and allows 32 entries', () => {
    const boundary = [MAX_SAFE, -MAX_SAFE, 0.1, 1e-7, 'a'.repeat(128), ' x', 'ＡＢ', ' x ', 'null', 'x', 'X', null, true, '1', 1]
    const result = compileSourcePlanDraft(stateDraft(boundary, [0, false]))
    expect(result.ok).toBe(true)
    expect(result.envelope!.readPlan.bomActiveState!.activeValues).toEqual(boundary)
    const thirtyTwo = Array.from({ length: 32 }, (_, index) => index + 100)
    expect(compileSourcePlanDraft(stateDraft(thirtyTwo, [0])).ok).toBe(true)
  })

  it.each([
    'Case-Insensitive', 'CASE-SENSITIVE', 'insensitive', ' case-sensitive', '', null, true, 1, ['case-sensitive'], {}, 'private_enum_marker',
  ])('rejects malformed sourceProjectComparison %#', (value) => {
    expectRejected({ ...createSyntheticSourcePlanDraft(), sourceProjectComparison: value }, 'sourceProjectComparison', 'invalid-comparison', 'private_enum_marker')
  })

  it('rejects a malformed mapping object without echoing keys or values', () => {
    const bad: unknown[] = [
      null, [], 'x', 5, true, new Map(), {},
      { activeValues: [1] },
      { inactiveValues: [0] },
      { activeValues: [1], inactiveValues: [0], extra: [2] },
      { activeValues: [1], inactiveValues: [0], private_key_marker: 'private_value_marker' },
      Object.assign(Object.create({ inherited: 1 }), { activeValues: [1], inactiveValues: [0] }),
    ]
    for (const mapping of bad) {
      const input = { ...createSyntheticSourcePlanDraft(), bomActiveState: mapping }
      const result = compileSourcePlanDraft(input)
      expect(result.ok).toBe(false)
      expect(result.envelope).toBeNull()
      expect(result.issues).toContainEqual(expect.objectContaining({ path: 'bomActiveState', code: 'invalid-state-mapping' }))
      expect(JSON.stringify(result.issues)).not.toContain('private_key_marker')
      expect(JSON.stringify(result.issues)).not.toContain('private_value_marker')
    }
    expectRejected({ ...createSyntheticSourcePlanDraft(), bomActiveState: null }, 'bomActiveState', 'invalid-state-mapping')
  })

  it('rejects value arrays that are not 1 to 32 entries', () => {
    const sparse: unknown[] = new Array(2)
    const cases: unknown[] = ['x', null, undefined, 1, {}, [], Array.from({ length: 33 }, (_, index) => index + 100), sparse]
    for (const value of cases) {
      const isSparse = value === sparse
      expectRejected(stateDraft(value, [0]), 'bomActiveState.activeValues', isSparse ? 'invalid-state-value' : 'invalid-state-values')
      expectRejected(stateDraft([1], value), 'bomActiveState.inactiveValues', isSparse ? 'invalid-state-value' : 'invalid-state-values')
    }
  })

  it('rejects invalid scalars, nested values, and malformed direct JS numbers without echoing them', () => {
    const invalid: unknown[] = [
      Number.NaN, Infinity, -Infinity, MAX_SAFE + 1, -(MAX_SAFE + 1), 1e308 * 10,
      undefined, {}, { private_key_marker: 1 }, [], [1], [[1]], 1n, Symbol('private_value_marker'), () => 1, new Date(0),
      '', '   ', ' ', '　', '\t',
      '\u0000', '\u001f', '\u007f', '\u0080', '\u009f', 'a\tb', 'a\nb', 'private_value_marker\u0000',
      'a'.repeat(129),
    ]
    for (const value of invalid) {
      expectRejected(stateDraft([value], [0]), 'bomActiveState.activeValues', 'invalid-state-value', 'private_value_marker')
      expectRejected(stateDraft([1], [value]), 'bomActiveState.inactiveValues', 'invalid-state-value', 'private_value_marker')
      expectRejected(stateDraft([1, value], [0, value === 1 ? 2 : 3]), 'bomActiveState.activeValues', 'invalid-state-value')
    }
  })

  it('treats types as distinct, 0 and -0 as equal, and rejects duplicates and overlap', () => {
    for (const distinct of [[1, '1'], [1, true], [0, false], [null, 'null'], ['A', 'a'], ['x', ' x'], [0.5, '0.5']]) {
      expect(compileSourcePlanDraft(stateDraft(distinct, [42, 'z'])).ok).toBe(true)
    }
    for (const duplicated of [[0, -0], ['a', 'a'], [0.5, 0.5], [null, null], [true, true], [1, 2, 1]]) {
      expectRejected(stateDraft(duplicated, [42]), 'bomActiveState.activeValues', 'duplicate-state-value')
      expectRejected(stateDraft([42], duplicated), 'bomActiveState.inactiveValues', 'duplicate-state-value')
    }
    for (const [active, inactive] of [[[1], [1]], [[null], [null]], [[0], [-0]], [['a'], ['x', 'a']], [[true], [true]]]) {
      expectRejected(stateDraft(active, inactive), 'bomActiveState', 'overlapping-state-values')
    }
    expect(compileSourcePlanDraft(stateDraft([1], ['1'])).ok).toBe(true)
    expect(compileSourcePlanDraft(stateDraft([true], [1])).ok).toBe(true)
  })

  it('requires a normalized nonblank BOM header active field only when the mapping is present', () => {
    for (const blank of ['', '   ']) {
      const draft = stateDraft([1], [0]) as { roles: SourcePlanDraft['roles'] }
      draft.roles.bomHead.activeField = blank
      expectRejected(draft, 'roles.bomHead.activeField', 'state-field-required')
    }
    const padded = stateDraft([1], [0]) as { roles: SourcePlanDraft['roles'] }
    padded.roles.bomHead.activeField = '  bom_able  '
    const ok = compileSourcePlanDraft(padded)
    expect(ok.ok).toBe(true)
    expect(ok.envelope!.readPlan.bomHead.activeField).toBe('bom_able')

    const legacy = createSyntheticSourcePlanDraft()
    legacy.roles.bomHead.activeField = ''
    const result = compileSourcePlanDraft(legacy)
    expect(result.ok).toBe(true)
    expect(result.envelope!.readPlan.bomHead).not.toHaveProperty('activeField')
  })

  it('imports only exact, valid optional fields and never echoes rejected content', () => {
    const configured: SourcePlanDraft = {
      ...createSyntheticSourcePlanDraft(),
      sourceProjectComparison: 'case-sensitive',
      bomActiveState: { activeValues: [1, '启用'], inactiveValues: [0, '停用'] },
    }
    const cases: Array<{ edit: (plan: Record<string, unknown>) => void; path: string; code: string }> = [
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).private_key_marker = [3] }, path: 'bomActiveState', code: 'invalid-state-mapping' },
      { edit: (p) => { delete (p.bomActiveState as Record<string, unknown>).inactiveValues }, path: 'bomActiveState', code: 'invalid-state-mapping' },
      { edit: (p) => { p.bomActiveState = null }, path: 'bomActiveState', code: 'invalid-state-mapping' },
      { edit: (p) => { p.bomActiveState = [] }, path: 'bomActiveState', code: 'invalid-state-mapping' },
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).activeValues = [[1]] }, path: 'bomActiveState.activeValues', code: 'invalid-state-value' },
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).activeValues = [{ private_key_marker: 1 }] }, path: 'bomActiveState.activeValues', code: 'invalid-state-value' },
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).activeValues = [''] }, path: 'bomActiveState.activeValues', code: 'invalid-state-value' },
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).activeValues = [2, 2] }, path: 'bomActiveState.activeValues', code: 'duplicate-state-value' },
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).activeValues = [] }, path: 'bomActiveState.activeValues', code: 'invalid-state-values' },
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).inactiveValues = 'private_value_marker' }, path: 'bomActiveState.inactiveValues', code: 'invalid-state-values' },
      { edit: (p) => { (p.bomActiveState as Record<string, unknown>).inactiveValues = [1] }, path: 'bomActiveState', code: 'overlapping-state-values' },
      { edit: (p) => { p.sourceProjectComparison = 'CASE-SENSITIVE' }, path: 'sourceProjectComparison', code: 'invalid-comparison' },
      { edit: (p) => { p.sourceProjectComparison = null }, path: 'sourceProjectComparison', code: 'invalid-comparison' },
      { edit: (p) => { p.sourceProjectComparison = ['case-sensitive'] }, path: 'sourceProjectComparison', code: 'invalid-comparison' },
      { edit: (p) => { delete (p.bomHead as Record<string, unknown>).activeField }, path: 'roles.bomHead.activeField', code: 'state-field-required' },
    ]
    for (const entry of cases) {
      const envelope = exportedEnvelope(configured)
      entry.edit(envelope.readPlan as Record<string, unknown>)
      const result = parseSourcePlanDraftJson(JSON.stringify(envelope))
      expect(result.ok).toBe(false)
      expect(result.draft).toBeNull()
      expect(result.issues).toContainEqual(expect.objectContaining({ path: entry.path, code: entry.code }))
      expect(result.issues.every((problem) => problem.zh.length > 0 && problem.en.length > 0)).toBe(true)
      expect(JSON.stringify(result.issues)).not.toContain('private_key_marker')
      expect(JSON.stringify(result.issues)).not.toContain('private_value_marker')
    }

    // A top-level key that is not an allowlisted optional field is still refused.
    const unknownKey = exportedEnvelope(configured)
    ;(unknownKey.readPlan as Record<string, unknown>).sourceProjectComparisonMode = 'case-insensitive'
    expect(parseSourcePlanDraftJson(JSON.stringify(unknownKey)).issues).toContainEqual(
      expect.objectContaining({ path: 'readPlan', code: 'unknown-key' }),
    )
    // Preserve the overflowing JSON number; JSON.stringify(Infinity) would silently produce null.
    const overflow = JSON.stringify(exportedEnvelope(configured)).replace('"activeValues":[1,', '"activeValues":[1e400,')
    expect(parseSourcePlanDraftJson(overflow).issues).toContainEqual(
      expect.objectContaining({ path: 'bomActiveState.activeValues', code: 'invalid-state-value' }),
    )
  })

  it('parses the editor’s two JSON texts without validating or echoing them', () => {
    const ok = parseBomActiveStateInputs('[1,"启用",null]', '[0,"停用"]')
    expect(ok).toEqual({ issues: [], value: { activeValues: [1, '启用', null], inactiveValues: [0, '停用'] } })
    expect(compileSourcePlanDraft({ ...createSyntheticSourcePlanDraft(), bomActiveState: ok.value }).ok).toBe(true)

    // Readable JSON of the wrong shape is the compiler's decision, not the parser's.
    const wrongShape = parseBomActiveStateInputs('{"private_key_marker":1}', '5')
    expect(wrongShape.issues).toEqual([])
    expectRejected({ ...createSyntheticSourcePlanDraft(), bomActiveState: wrongShape.value }, 'bomActiveState.activeValues', 'invalid-state-values', 'private_key_marker')

    for (const [active, inactive, paths] of [
      ['[1, private_json_marker', '[0]', ['bomActiveState.activeValues']],
      ['[1]', '', ['bomActiveState.inactiveValues']],
      ['', 'undefined', ['bomActiveState.activeValues', 'bomActiveState.inactiveValues']],
    ] as const) {
      const result = parseBomActiveStateInputs(active, inactive)
      expect(result.value).toBeNull()
      expect(result.issues.map((problem) => problem.path)).toEqual(paths)
      expect(result.issues.every((problem) => problem.code === 'invalid-state-json' && problem.zh.length > 0 && problem.en.length > 0)).toBe(true)
      expect(JSON.stringify(result.issues)).not.toContain('private_json_marker')
    }
    expect(parseBomActiveStateInputs('1e400', '[0]').value).not.toBeNull()
    expectRejected(stateDraft(JSON.parse('[1e400]'), [0]), 'bomActiveState.activeValues', 'invalid-state-value')
  })

  it('requires the serialized matchField to agree with the role it purports to describe', () => {
    const mismatch = exportedEnvelope()
    ;(mismatch.readPlan as Record<string, unknown>).matchField = 'different_field'
    const result = parseSourcePlanDraftJson(JSON.stringify(mismatch))
    expect(result).toMatchObject({ ok: false, draft: null })
    expect(result.issues).toContainEqual(expect.objectContaining({ path: 'readPlan.matchField', code: 'inconsistent-read-plan' }))
  })

  it('compiles bare and schema-qualified object names and rejects broken qualification without echoing values', () => {
    const bare = renamedLayout('SYN_BARE')
    bare.roles.part.object = '  order_line  '
    bare.roles.part.codeField = '  code_1  '
    const bareResult = compileSourcePlanDraft(bare)
    expect(bareResult.ok).toBe(true)
    expect(bareResult.envelope!.readPlan.part.object).toBe('order_line')
    expect(bareResult.envelope!.readPlan.part.codeField).toBe('code_1')

    const qualified = renamedLayout('SYN_QUAL')
    qualified.roles.bomDetail.object = '  sales_schema.order_line  '
    qualified.roles.pathInfo.object = '_schema_name._table_name'
    qualified.roles.part.object = 'sales_schema.order_1'
    qualified.roles.orderHead.object = `ab.${'c'.repeat(125)}`
    const qualifiedResult = compileSourcePlanDraft(qualified)
    expect(qualifiedResult.ok).toBe(true)
    expect(qualifiedResult.envelope!.readPlan.bomDetail.object).toBe('sales_schema.order_line')
    expect(qualifiedResult.envelope!.readPlan.pathInfo.object).toBe('_schema_name._table_name')
    expect(qualifiedResult.envelope!.readPlan.part.object).toBe('sales_schema.order_1')
    expect(qualifiedResult.envelope!.readPlan.orderHead.object).toBe(`ab.${'c'.repeat(125)}`)
    expect(normalizeStockPreparationBomReadPlan(qualifiedResult.envelope!.readPlan)).toEqual(qualifiedResult.envelope!.readPlan)

    const dottedField = renamedLayout('SYN_FIELD')
    dottedField.roles.part.codeField = 'schema.column'
    const dottedFieldResult = compileSourcePlanDraft(dottedField)
    expect(dottedFieldResult.ok).toBe(false)
    expect(dottedFieldResult.envelope).toBeNull()
    expect(dottedFieldResult.issues).toContainEqual(expect.objectContaining({ path: 'roles.part.codeField', code: 'invalid-identifier' }))
    expect(JSON.stringify(dottedFieldResult.issues)).not.toContain('schema.column')

    const accepted: string[] = []
    for (const objectName of [...brokenObjectNames, '  sales..order_line  ']) {
      const draft = renamedLayout('SYN_BAD')
      draft.roles.part.object = objectName
      const result = compileSourcePlanDraft(draft)
      if (result.ok) {
        accepted.push(objectName)
        continue
      }
      expect(result.envelope).toBeNull()
      expect(result.issues).toContainEqual(expect.objectContaining({ path: 'roles.part.object', code: 'invalid-identifier' }))
      expect(JSON.stringify(result.issues)).not.toContain(objectName)
    }
    expect(accepted).toEqual([])
  })

  it('imports bare and schema-qualified object names and rejects broken qualification without echoing values', () => {
    const bare = renamedLayout('SYN_IMPORT_BARE')
    bare.roles.part.object = 'order_line'
    bare.roles.part.codeField = 'code_1'
    expect(parseSourcePlanDraftJson(JSON.stringify(exportedEnvelope(bare)))).toEqual({ ok: true, issues: [], draft: bare })

    const qualified = renamedLayout('SYN_IMPORT_QUAL')
    qualified.roles.bomDetail.object = 'sales_schema.order_line'
    qualified.roles.pathInfo.object = '_schema_name._table_name'
    qualified.roles.part.object = 'sales_schema.order_1'
    qualified.roles.orderHead.object = `ab.${'c'.repeat(125)}`
    expect(parseSourcePlanDraftJson(JSON.stringify(exportedEnvelope(qualified)))).toEqual({ ok: true, issues: [], draft: qualified })

    const dottedField = exportedEnvelope(renamedLayout('SYN_IMPORT_FIELD'))
    ;((dottedField.readPlan as Record<string, unknown>).part as Record<string, unknown>).codeField = 'schema.column'
    const dottedFieldResult = parseSourcePlanDraftJson(JSON.stringify(dottedField))
    expect(dottedFieldResult.ok).toBe(false)
    expect(dottedFieldResult.draft).toBeNull()
    expect(dottedFieldResult.issues).toContainEqual(expect.objectContaining({ path: 'roles.part.codeField', code: 'invalid-identifier' }))
    expect(JSON.stringify(dottedFieldResult.issues)).not.toContain('schema.column')

    const accepted: string[] = []
    for (const objectName of brokenObjectNames) {
      const envelope = exportedEnvelope(renamedLayout('SYN_IMPORT_BAD'))
      ;((envelope.readPlan as Record<string, unknown>).part as Record<string, unknown>).object = objectName
      const result = parseSourcePlanDraftJson(JSON.stringify(envelope))
      if (result.ok) {
        accepted.push(objectName)
        continue
      }
      expect(result.draft).toBeNull()
      expect(result.issues).toContainEqual(expect.objectContaining({ path: 'roles.part.object', code: 'invalid-identifier' }))
      expect(JSON.stringify(result.issues)).not.toContain(objectName)
    }
    expect(accepted).toEqual([])
  })
})
