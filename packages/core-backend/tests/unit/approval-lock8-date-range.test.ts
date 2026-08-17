import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DATE_RANGE_DATE_TYPES,
  pruneHiddenFormData,
  resolveVisibilityFieldReference,
  readVisibilityReferenceValue,
  validateApprovalFormData,
} from '../../src/services/ApprovalGraphExecutor'
import type { FormSchema } from '../../src/types/approval-product'

// Lock-8 L8-B (docs/development/approval-lock8-field-vocabulary-20260817.md §1.2) — date_range
// (日期区间): a start+end date pair. This file covers:
//   - registration completeness (N-1 style census over the props allowlist + dateType enum)
//   - publish-time props validation (dateType/startLabel/endLabel required, no absent-default;
//     durationLabel optional; unknown keys fail-closed)
//   - OD-L8-4: detail-column exclusion (positive edit) + number positive control
//   - OD-L8-5: per-type visibility predicate — bare reference refused, dotted .start/.end admitted
//   - OD-L8-8: duration is DERIVED/DISPLAY-ONLY — the value shape is strictly { start, end }, so a
//     submitted `duration` key is rejected outright (not silently dropped, not trusted)
//   - MS-3 submit-time value validation (shape, per-dateType-arm validity, B-1 start<=end,
//     values-free error text)
//   - condition-branch exclusion (mirrors record-link's own non-scalar-value precedent)

const pgState = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  pool: { query: vi.fn(), connect: vi.fn() },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildRuntimeGraph(policyOverrides?: Record<string, unknown>) {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
    policy: { allowRevoke: true, ...policyOverrides },
  }
}

/** Wires the minimal INSERT-only DB mock a successful `createTemplate` call needs. */
function mockSuccessfulCreate(tplId: string, verId: string) {
  pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = normalize(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (s.startsWith('INSERT INTO approval_templates')) {
      return {
        rows: [{
          id: tplId, key: String(params?.[0]), name: String(params?.[1]), description: null, category: null,
          visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: null,
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('INSERT INTO approval_template_versions')) {
      return {
        rows: [{
          id: verId, template_id: tplId, version: 1, status: 'draft',
          form_schema: JSON.parse(String(params?.[1])),
          approval_graph: JSON.parse(String(params?.[2])),
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_templates')) {
      return {
        rows: [{
          id: tplId, key: `key-${tplId}`, name: 'Date Range Tpl', description: null, category: null,
          visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: verId,
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled query: ${s}`)
  })
}

describe('Lock-8 L8-B date_range field contract (approval-lock8-field-vocabulary-20260817.md §1.2)', () => {
  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  const wrap = (field: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({
    key: `dr-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Date Range Tpl',
    formSchema: { fields: [field, ...extra] },
    approvalGraph: buildRuntimeGraph(),
  })
  const create = async (request: unknown) => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    return new ApprovalProductService().createTemplate(request as never)
  }

  it('N-1 style census: the props allowlist is EXACTLY dateType/startLabel/endLabel/durationLabel', async () => {
    const { DATE_RANGE_FIELD_ALLOWED_PROP_KEYS } = await import('../../src/services/ApprovalProductService')
    // Mutation-provable: dropping/adding a member here reds this exact-equality assertion
    // directly — the census IS the test, not a claim about it (mirrors L8-C's own N-1 pattern).
    expect([...DATE_RANGE_FIELD_ALLOWED_PROP_KEYS].sort()).toEqual(
      ['dateType', 'durationLabel', 'endLabel', 'startLabel'].sort(),
    )
  })

  it('the runtime dateType enum is EXACTLY the two shipped value contracts times three granularities', () => {
    expect([...DATE_RANGE_DATE_TYPES].sort()).toEqual(['date', 'date_half_day', 'date_minute'].sort())
  })

  it('dateType is required with NO absent-default (§1.2) — missing/off-enum both reject at publish', async () => {
    await expect(create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { startLabel: '起始', endLabel: '结束' },
    }))).rejects.toThrow(/date_range props\.dateType must be one of/)
    await expect(create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'week', startLabel: '起始', endLabel: '结束' },
    }))).rejects.toThrow(/date_range props\.dateType must be one of/)
  })

  it('startLabel/endLabel are required non-blank strings (C-7 控件名称 1/2)', async () => {
    await expect(create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'date', endLabel: '结束' },
    }))).rejects.toThrow(/date_range props\.startLabel is required/)
    await expect(create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'date', startLabel: '   ', endLabel: '结束' },
    }))).rejects.toThrow(/date_range props\.startLabel is required/)
    await expect(create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'date', startLabel: '起始' },
    }))).rejects.toThrow(/date_range props\.endLabel is required/)
  })

  it('durationLabel is OPTIONAL, but must be a non-blank string when present', async () => {
    await expect(create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'date', startLabel: '起始', endLabel: '结束', durationLabel: '' },
    }))).rejects.toThrow(/date_range props\.durationLabel must be a non-blank string/)
  })

  it('rejects an unknown props key (fail-closed, mirrors record-link/L8-C shape)', async () => {
    await expect(create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'date', startLabel: '起始', endLabel: '结束', exact: true },
    }))).rejects.toThrow(/date_range props may only contain/)
  })

  it('accepts and canonicalizes a fully-specified date_range field (durationLabel present)', async () => {
    mockSuccessfulCreate('tpl-dr', 'ver-dr')
    const result = await create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'date_minute', startLabel: '起始', endLabel: '结束', durationLabel: '时长' },
    }))
    const field = result.formSchema.fields[0]
    expect(field.type).toBe('date_range')
    expect(field.props).toEqual({
      dateType: 'date_minute', startLabel: '起始', endLabel: '结束', durationLabel: '时长',
    })
  })

  it('accepts a date_range field with durationLabel OMITTED (optional, no key emitted)', async () => {
    mockSuccessfulCreate('tpl-dr2', 'ver-dr2')
    const result = await create(wrap({
      id: 'range', type: 'date_range', label: '日期区间',
      props: { dateType: 'date', startLabel: '起始', endLabel: '结束' },
    }))
    const field = result.formSchema.fields[0]
    expect(field.props).toEqual({ dateType: 'date', startLabel: '起始', endLabel: '结束' })
    expect(Object.prototype.hasOwnProperty.call(field.props, 'durationLabel')).toBe(false)
  })

  describe('OD-L8-4: detail-column eligibility — date_range EXCLUDED (positive edit)', () => {
    it('date_range as a detail column FAILS publish', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细',
        columns: [{
          id: 'when', type: 'date_range', label: '区间',
          props: { dateType: 'date', startLabel: '起', endLabel: '止' },
        }],
      }))).rejects.toThrow(/date_range cannot nest inside a detail group/)
    })

    it('positive control: number STAYS admitted as a detail column throughout', async () => {
      mockSuccessfulCreate('tpl-dc', 'ver-dc')
      const result = await create(wrap({
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'qty', type: 'number', label: '数量' }],
      }))
      expect(result.formSchema.fields[0].columns?.[0].type).toBe('number')
    })
  })

  describe('OD-L8-5: per-type visibility predicate — bare refused, dotted .start/.end admitted', () => {
    it('a bare whole-value reference to a date_range field is refused ("never as one comparable value")', async () => {
      await expect(create(wrap(
        { id: 'range', type: 'date_range', label: '区间', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } },
        [{ id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'range', operator: 'notEmpty' } }],
      ))).rejects.toThrow(/cannot reference a date_range field as a single value/)
    })

    it('a dotted .start endpoint reference IS admitted and round-trips through publish', async () => {
      mockSuccessfulCreate('tpl-vis-s', 'ver-vis-s')
      const result = await create(wrap(
        { id: 'range', type: 'date_range', label: '区间', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } },
        [{ id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'range.start', operator: 'notEmpty' } }],
      ))
      expect(result.formSchema.fields[1].visibilityRule).toEqual({ fieldId: 'range.start', operator: 'notEmpty' })
    })

    it('a dotted .end endpoint reference IS admitted and round-trips through publish', async () => {
      mockSuccessfulCreate('tpl-vis-e', 'ver-vis-e')
      const result = await create(wrap(
        { id: 'range', type: 'date_range', label: '区间', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } },
        [{ id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'range.end', operator: 'notEmpty' } }],
      ))
      expect(result.formSchema.fields[1].visibilityRule).toEqual({ fieldId: 'range.end', operator: 'notEmpty' })
    })

    it('a malformed dotted address (unknown suffix) is rejected exactly like a missing field', async () => {
      await expect(create(wrap(
        { id: 'range', type: 'date_range', label: '区间', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } },
        [{ id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'range.middle', operator: 'notEmpty' } }],
      ))).rejects.toThrow(/must reference an existing field/)
    })

    it('a dotted .start suffix off a NON-date_range base is rejected (endpoint grammar is date_range-only)', async () => {
      await expect(create(wrap(
        { id: 'amount', type: 'number', label: '金额' },
        [{ id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'amount.start', operator: 'notEmpty' } }],
      ))).rejects.toThrow(/must reference an existing field/)
    })

    it('self-reference via a dotted endpoint is rejected (a field cannot depend on its own endpoint)', async () => {
      await expect(create(wrap(
        { id: 'range', type: 'date_range', label: '区间', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' },
          visibilityRule: { fieldId: 'range.end', operator: 'notEmpty' } },
      ))).rejects.toThrow(/cannot reference itself/)
    })
  })

  describe('condition-branch exclusion (silently-never-matches fail-closed, mirrors record-link)', () => {
    it('rejects simple condition rules comparing a date_range field', async () => {
      const request = {
        key: `dr-cond-${Date.now()}`,
        name: 'Date Range Cond',
        formSchema: {
          fields: [{
            id: 'range', type: 'date_range', label: '区间',
            props: { dateType: 'date', startLabel: 'S', endLabel: 'E' },
          }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'route',
              type: 'condition',
              config: {
                branches: [{ edgeKey: 'edge-yes', rules: [{ fieldId: 'range', operator: 'eq', value: 'anything' }] }],
                defaultEdgeKey: 'edge-no',
              },
            },
            { key: 'yes', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
            { key: 'no', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-route', source: 'start', target: 'route' },
            { key: 'edge-yes', source: 'route', target: 'yes' },
            { key: 'edge-no', source: 'route', target: 'no' },
            { key: 'edge-yes-end', source: 'yes', target: 'end' },
            { key: 'edge-no-end', source: 'no', target: 'end' },
          ],
          policy: { allowRevoke: true },
        },
      }
      await expect(create(request)).rejects.toThrow(/cannot reference date_range field/)
    })
  })
})

describe('Lock-8 L8-B submit-time value validation (MS-3, ApprovalGraphExecutor)', () => {
  it('accepts a well-formed { start, end } pair for each dateType arm', () => {
    const civil: FormSchema = {
      fields: [{ id: 'r', type: 'date_range', label: 'R', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } }],
    }
    expect(validateApprovalFormData(civil, { r: { start: '2026-08-01', end: '2026-08-10' } })).toEqual([])

    const minute: FormSchema = {
      fields: [{ id: 'r', type: 'date_range', label: 'R', props: { dateType: 'date_minute', startLabel: 'S', endLabel: 'E' } }],
    }
    expect(validateApprovalFormData(minute, {
      r: { start: '2026-08-01T09:00:00', end: '2026-08-01T18:00:00' },
    })).toEqual([])
  })

  it('rejects a shape other than exactly { start, end } — no extra keys, incl. a submitted "duration" (OD-L8-8)', () => {
    const schema: FormSchema = {
      fields: [{ id: 'r', type: 'date_range', label: 'R', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } }],
    }
    expect(validateApprovalFormData(schema, {
      r: { start: '2026-08-01', end: '2026-08-10', duration: 9 },
    })).toEqual(['r must be exactly { start, end }'])
    expect(validateApprovalFormData(schema, { r: { start: '2026-08-01' } }))
      .toEqual(['r must be exactly { start, end }'])
    expect(validateApprovalFormData(schema, { r: '2026-08-01' }))
      .toEqual(['r must be an object'])
  })

  it('the civil-date arm rejects a datetime endpoint; the minute arm accepts it (B-2)', () => {
    const civil: FormSchema = {
      fields: [{ id: 'r', type: 'date_range', label: 'R', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } }],
    }
    expect(validateApprovalFormData(civil, {
      r: { start: '2026-08-01T00:00:00', end: '2026-08-10' },
    })).toEqual(['r start and end must be valid dates for the declared date type'])

    const minute: FormSchema = {
      fields: [{ id: 'r', type: 'date_range', label: 'R', props: { dateType: 'date_minute', startLabel: 'S', endLabel: 'E' } }],
    }
    expect(validateApprovalFormData(minute, {
      r: { start: '2026-08-01T00:00:00', end: '2026-08-10T00:00:00' },
    })).toEqual([])
  })

  it('B-1: start > end fails values-free — the error carries the field id ONLY, never either endpoint', () => {
    const schema: FormSchema = {
      fields: [{ id: 'r', type: 'date_range', label: 'R', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } }],
    }
    const errors = validateApprovalFormData(schema, { r: { start: '2026-08-10', end: '2026-08-01' } })
    expect(errors).toEqual(['r start must not be after end'])
    // Values-free: neither endpoint's literal string appears anywhere in the error text.
    expect(errors.join(' ')).not.toContain('2026-08-10')
    expect(errors.join(' ')).not.toContain('2026-08-01')
  })

  it('positive control: start === end succeeds (comparison-selected, not vacuous)', () => {
    const schema: FormSchema = {
      fields: [{ id: 'r', type: 'date_range', label: 'R', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } }],
    }
    expect(validateApprovalFormData(schema, { r: { start: '2026-08-05', end: '2026-08-05' } })).toEqual([])
  })
})

describe('Lock-8 L8-B OD-L8-5(a) resolver — resolveVisibilityFieldReference / readVisibilityReferenceValue', () => {
  const fields = [
    { id: 'range', type: 'date_range', label: 'R', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } },
    { id: 'amount', type: 'number', label: 'A' },
  ] as FormSchema['fields']

  it('resolves a bare non-date_range reference to the whole field, no endpoint', () => {
    const ref = resolveVisibilityFieldReference('amount', fields)
    expect(ref).toEqual({ field: fields[1] })
  })

  it('refuses a bare reference to a date_range field (null)', () => {
    expect(resolveVisibilityFieldReference('range', fields)).toBeNull()
  })

  it('resolves .start / .end dotted addresses to the date_range field + endpoint', () => {
    expect(resolveVisibilityFieldReference('range.start', fields)).toEqual({ field: fields[0], endpoint: 'start' })
    expect(resolveVisibilityFieldReference('range.end', fields)).toEqual({ field: fields[0], endpoint: 'end' })
  })

  it('refuses an unknown field, a bad suffix, and a dotted suffix off a non-date_range base', () => {
    expect(resolveVisibilityFieldReference('missing', fields)).toBeNull()
    expect(resolveVisibilityFieldReference('range.middle', fields)).toBeNull()
    expect(resolveVisibilityFieldReference('amount.start', fields)).toBeNull()
  })

  it('readVisibilityReferenceValue reads the endpoint value, not the whole object', () => {
    const formData = { range: { start: '2026-08-01', end: '2026-08-10' }, amount: 42 }
    const startRef = resolveVisibilityFieldReference('range.start', fields)!
    const endRef = resolveVisibilityFieldReference('range.end', fields)!
    const wholeRef = resolveVisibilityFieldReference('amount', fields)!
    expect(readVisibilityReferenceValue(startRef, formData)).toBe('2026-08-01')
    expect(readVisibilityReferenceValue(endRef, formData)).toBe('2026-08-10')
    expect(readVisibilityReferenceValue(wholeRef, formData)).toBe(42)
  })
})

describe('Lock-8 L8-B runtime visibility (pruneHiddenFormData / buildVisibilityLookup, dotted endpoint)', () => {
  it('a field visible only when a date_range START endpoint is non-empty is pruned/kept correctly', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'range', type: 'date_range', label: '区间', props: { dateType: 'date', startLabel: 'S', endLabel: 'E' } },
        {
          id: 'note', type: 'text', label: '备注',
          visibilityRule: { fieldId: 'range.start', operator: 'notEmpty' },
        },
      ],
    }
    // start present -> note visible/kept.
    expect(pruneHiddenFormData(schema, {
      range: { start: '2026-08-01', end: '' }, note: 'hello',
    })).toEqual({ range: { start: '2026-08-01', end: '' }, note: 'hello' })
    // start empty -> note hidden/pruned (positive control: the END being non-empty must NOT
    // leak through the wrong endpoint — proves the resolver reads .start, not the whole object).
    expect(pruneHiddenFormData(schema, {
      range: { start: '', end: '2026-08-10' }, note: 'hello',
    })).toEqual({ range: { start: '', end: '2026-08-10' } })
  })

  it('a stale/unresolvable visibilityRule.fieldId hides the dependent field (fail-closed, not a crash)', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'note', type: 'text', label: '备注', visibilityRule: { fieldId: 'gone.start', operator: 'notEmpty' } },
      ],
    }
    expect(pruneHiddenFormData(schema, { note: 'hello' })).toEqual({})
  })
})
