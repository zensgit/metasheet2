import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AutomationReadLedgerError, checkedReadBudget, checkedReadPreview, checkedReadSelector,
  checkedReadSourceReference, checkedReadTriggers, checkedReadRecordCondition } from '../../../src/integration/automation-read-contracts'

describe('Closed record condition consent description (not authority)', () => {
  const saved = { mode: 'saved_conditions', schemaRevision: 'abcdef12-3456-4789-abcd-0123456789ab', businessTimeZone: 'Asia/Singapore' }
  it.each([{ mode: 'unconditional' }, saved, { ...saved, businessTimeZone: 'UTC' }])('captures and freezes only its own primitives %#', input => {
    const supplied = { ...input }
    const result = checkedReadRecordCondition(supplied)
    expect(result).toEqual(input)
    expect(result).not.toBe(supplied)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(supplied)).toBe(false)
    expect(Reflect.set(result, 'mode', 'changed')).toBe(false)
    supplied.mode = 'changed'
    expect(result.mode).not.toBe('changed')
  })
  it('accepts a null-prototype descriptor without retaining it', () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, saved)
    expect(Object.getPrototypeOf(checkedReadRecordCondition(value))).toBe(Object.prototype)
  })
  it.each([null, undefined, [], {}, 'unconditional', { mode: 'unknown' }, { mode: 'UNCONDITIONAL' },
    { mode: 'unconditional', schemaRevision: saved.schemaRevision },
    { mode: 'unconditional', businessTimeZone: 'UTC' },
    { mode: 'saved_conditions' }, { mode: 'saved_conditions', schemaRevision: saved.schemaRevision },
    { ...saved, extra: true }, { ...saved, schemaRevision: saved.schemaRevision.toUpperCase() },
    { ...saved, schemaRevision: ' '+saved.schemaRevision }, { ...saved, schemaRevision: saved.schemaRevision+'\n' },
    { ...saved, schemaRevision: null }, { ...saved, businessTimeZone: '' }, { ...saved, businessTimeZone: ' UTC' },
    { ...saved, businessTimeZone: 'UTC ' }, { ...saved, businessTimeZone: 'Not/AZone' },
    { ...saved, businessTimeZone: 'x'.repeat(129) }, { ...saved, businessTimeZone: {} }, new Date(0),
  ])('rejects malformed or noncanonical descriptor %#', value => {
    expect(() => checkedReadRecordCondition(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  for (const key of ['mode', 'schemaRevision', 'businessTimeZone']) {
    it('does not execute the own accessor ' + key, () => {
      let hooks = 0
      const value = { ...saved }
      Object.defineProperty(value, key, { enumerable: true, get() { hooks++; throw new Error('synthetic-private-hook') } })
      expect(() => checkedReadRecordCondition(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
      expect(hooks).toBe(0)
    })
    it('rejects nonenumerable own data ' + key, () => {
      const value = { ...saved }
      Object.defineProperty(value, key, { enumerable: false })
      expect(() => checkedReadRecordCondition(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    })
  }
  it.each(['toJSON', Symbol('private')])('rejects hidden extras without serialization %#', key => {
    let hooks = 0
    const value = { ...saved }
    Object.defineProperty(value, key, { get() { hooks++; return () => saved } })
    expect(() => checkedReadRecordCondition(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
    expect(hooks).toBe(0)
  })
  it('rejects inherited material and normalizes descriptor inspection failures', () => {
    expect(() => checkedReadRecordCondition(Object.create(saved))).toThrow('AUTOMATION_READ_INPUT_INVALID')
    const value = new Proxy(saved, { ownKeys() { throw new Error('synthetic-private-inspection') } })
    let caught: unknown
    try { checkedReadRecordCondition(value) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID', message: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(caught).not.toHaveProperty('cause')
  })
})

describe('Private Automation read contracts (no authority granted by validation)', () => {
  const budget = { maxRows: 100, maxPages: 5, maxReadCount: 3, timeoutMs: 2000 }
  const selector = { ruleId: 'rule', actionId: 'action', systemId: 'system', targetId: 'target' }
  const result = { status: 'ready', canApply: false, counts: { add: 1, update: 2, skip: 3, inactive: 4, manual_confirm: 5 } }
  it('copies closed primitive contracts; does not retain caller-owned objects', () => {
    expect(checkedReadBudget(budget)).toEqual(budget)
    expect(checkedReadSelector(selector)).toEqual(selector)
    const copy = checkedReadPreview(result)
    expect(copy).toEqual(result)
    expect(copy).not.toBe(result)
    expect(copy.counts).not.toBe(result.counts)
  })
  it('does not invoke serialization hooks from a preview provider', () => {
    const supplied = { ...result, counts: { ...result.counts } }
    Object.defineProperty(supplied, 'toJSON', { value: () => { throw new Error('private-provider-detail') } })
    Object.defineProperty(supplied.counts, 'toJSON', { value: () => ({ add: 100, token: 'forbidden' }) })
    expect(checkedReadPreview(supplied)).toEqual(result)
    expect(JSON.parse(JSON.stringify(checkedReadPreview(supplied)))).toEqual(result)
  })
  it.each([null, {}, { ...selector, sql: 'SELECT' }, { ...selector, systemId: ' x' }, { ...selector, targetId: '' }])('rejects selector case %#', value => {
    expect(() => checkedReadSelector(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it.each([null, {}, { ...budget, unlimited: true }, ...[0, -1, Infinity, NaN, 1.5, 2147483648, '10'].map(maxRows => ({ ...budget, maxRows }))])('rejects budget case %#', value => {
    expect(() => checkedReadBudget(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
  it.each([null, {}, { ...result, rows: [] }, { ...result, canApply: true }, { ...result, token: 'no-token' },
    { ...result, status: 'failed' }, { ...result, status: { toString: () => 'ready' } },
    ...[-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(add => ({ ...result, counts: { ...result.counts, add } })),
    { ...result, counts: { ...result.counts, host: 'not-a-count' } },
  ])('rejects non-summary result case %#', value => {
    expect(() => checkedReadPreview(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  })
})

describe('Closed Automation read trigger sets', () => {
  function rejected(value: unknown) {
    expect(() => checkedReadTriggers(value)).toThrow('AUTOMATION_READ_INPUT_INVALID')
  }
  it.each([['manual'], ['schedule'], ['record'], ['manual', 'schedule'], ['record', 'manual'],
    ['manual', 'schedule', 'record']].map(value => ({ value })))('copies and freezes a closed nonempty trigger set %#', ({ value }) => {
    const captured = checkedReadTriggers(value)
    expect(captured).toEqual(value)
    expect(captured).not.toBe(value)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(value)).toBe(false)
    value[0] = 'changed-after-capture'
    expect(captured[0]).not.toBe(value[0])
    expect(Reflect.set(captured, '0', 'changed-output')).toBe(false)
  })
  it.each([null, undefined, 'manual', {}, [], ['manual', 'manual'], ['record', 'record'],
    ['manual', 'schedule', 'record', 'manual'], [' manual'], ['MANUAL'], ['webhook'], [true], [1],
    [undefined], [null], [() => 'manual'], [Symbol('manual')], new Set(['manual']),
    { 0: 'manual', length: 1 }, new Array(1)].map(value => ({ value })))('rejects malformed trigger data %#', ({ value }) => {
    rejected(value)
  })
  it.each(['extra', 'toJSON', Symbol('hidden')])('rejects extra own array material %# without invoking it', key => {
    let hooks = 0
    const value = ['manual']
    Object.defineProperty(value, key, { value() { hooks += 1; return ['manual'] } })
    rejected(value)
    expect(hooks).toBe(0)
  })
  it('rejects index getters, hidden indices and custom prototypes with zero hook calls', () => {
    let hooks = 0
    const accessor = ['manual']
    Object.defineProperty(accessor, '0', { enumerable: true, get() { hooks += 1; return 'manual' } })
    rejected(accessor)
    const hidden = ['manual']
    Object.defineProperty(hidden, '0', { enumerable: false, value: 'manual' })
    rejected(hidden)
    const inherited = ['manual']
    Object.setPrototypeOf(inherited, { toJSON() { hooks += 1; return ['manual'] } })
    rejected(inherited)
    const object = { toString() { hooks += 1; return 'manual' }, valueOf() { hooks += 1; return 'manual' } }
    rejected([object])
    expect(hooks).toBe(0)
  })
  it('sanitizes inspection failures instead of retaining private causes', () => {
    const value = new Proxy(['manual'], { ownKeys() { throw new Error('synthetic-private-hook') } })
    let caught: unknown
    try { checkedReadTriggers(value) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AutomationReadLedgerError)
    expect(caught).toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID', message: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(caught).not.toHaveProperty('cause')
    expect(String(caught)).not.toContain('synthetic-private-hook')
  })
})

describe('Private original Connection reference (validation is not current-owner authority)', () => {
  const reference = { connectionId: 'synthetic-original-connection',
    connectionIncarnation: 'abcdef12-3456-4789-abcd-0123456789ab' }
  function rejected(value: unknown) {
    let caught: unknown
    try { checkedReadSourceReference(value) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AutomationReadLedgerError)
    expect(caught).toMatchObject({ code: 'AUTOMATION_READ_INPUT_INVALID', message: 'AUTOMATION_READ_INPUT_INVALID' })
    expect(caught).not.toHaveProperty('cause')
    expect(caught).not.toHaveProperty('details')
  }
  it('returns a detached frozen two-primitive snapshot, without freezing the caller', () => {
    const supplied = { ...reference }
    const result = checkedReadSourceReference(supplied)
    expect(result).toEqual(reference)
    expect(result).not.toBe(supplied)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(supplied)).toBe(false)
    expect(Reflect.ownKeys(result).sort()).toEqual(['connectionId', 'connectionIncarnation'])
    supplied.connectionId = 'changed-after-capture'
    supplied.connectionIncarnation = '11111111-1111-4111-8111-111111111111'
    expect(result).toEqual(reference)
    expect(Reflect.set(result, 'connectionId', 'changed-output')).toBe(false)
    expect(Reflect.set(result, 'connectionIncarnation', supplied.connectionIncarnation)).toBe(false)
    expect(JSON.parse(JSON.stringify(result))).toEqual(reference)
  })
  it('accepts null-prototype data but returns an ordinary detached data object', () => {
    const supplied = Object.assign(Object.create(null) as Record<string, unknown>, reference)
    const result = checkedReadSourceReference(supplied)
    expect(result).toEqual(reference)
    expect(result).not.toBe(supplied)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(Object.isFrozen(result)).toBe(true)
  })
  it.each([null, undefined, false, 1, 'synthetic', [], {},
    { connectionId: reference.connectionId }, { connectionIncarnation: reference.connectionIncarnation },
    { connectionId: reference.connectionId, otherIncarnation: reference.connectionIncarnation },
    { ...reference, authority: true }, { ...reference, validationRevision: reference.connectionIncarnation },
  ].map(value => ({ value })))('rejects missing/wrong/extra shape %#', ({ value }) => { rejected(value) })
  it.each(['hidden', Symbol('hidden')])('rejects additional own hidden material %#', key => {
    const supplied = { ...reference }
    Object.defineProperty(supplied, key, { value: true, enumerable: false })
    rejected(supplied)
  })
  it.each(['connectionId', 'connectionIncarnation'] as const)('requires enumerable own data for %s', field => {
    const supplied = { ...reference }
    Object.defineProperty(supplied, field, { value: reference[field], enumerable: false })
    rejected(supplied)
  })
  it.each(['connectionId', 'connectionIncarnation'] as const)('never invokes a %s getter', field => {
    let calls = 0
    const supplied = { ...reference }
    Object.defineProperty(supplied, field, { enumerable: true, get() { calls += 1; throw new Error('synthetic-private-hook') } })
    rejected(supplied)
    expect(calls).toBe(0)
  })
  it.each(['connectionId', 'connectionIncarnation'] as const)('rejects setter-only %s without invoking it', field => {
    let calls = 0
    const supplied = { ...reference }
    Object.defineProperty(supplied, field, { enumerable: true, set(_value: unknown) { calls += 1 } })
    rejected(supplied)
    expect(calls).toBe(0)
  })
  it.each([true, false])('rejects own toJSON with enumerable=%s and zero hook calls', enumerable => {
    let calls = 0
    const supplied = { ...reference }
    Object.defineProperty(supplied, 'toJSON', { enumerable, value() { calls += 1; return reference } })
    rejected(supplied)
    expect(calls).toBe(0)
  })
  it('rejects a hidden toJSON accessor without reading it', () => {
    let calls = 0
    const supplied = { ...reference }
    Object.defineProperty(supplied, 'toJSON', { get() { calls += 1; return () => reference } })
    rejected(supplied)
    expect(calls).toBe(0)
  })
  it('rejects custom/inherited prototypes and never invokes inherited serializers', () => {
    let calls = 0
    const prototype = { toJSON() { calls += 1; return reference } }
    rejected(Object.assign(Object.create(prototype) as Record<string, unknown>, reference))
    rejected(Object.create(reference))
    rejected(Object.assign(new Date(0), reference))
    expect(calls).toBe(0)
  })
  it.each(['connectionId', 'connectionIncarnation'] as const)('does not coerce or serialize object-valued %s', field => {
    let calls = 0
    const value = { toJSON() { calls += 1; return reference[field] },
      toString() { calls += 1; return reference[field] }, valueOf() { calls += 1; return reference[field] } }
    rejected({ ...reference, [field]: value })
    expect(calls).toBe(0)
  })
  it.each([
    'x', 'x'.repeat(255), '\u4e2d'.repeat(255), '\u{1f680}'.repeat(127), `${'\u{1f680}'.repeat(127)}x`,
    'synthetic connection', 'synthetic\u00a0connection',
  ])('accepts canonical ID boundary %# without trimming or rewriting', connectionId => {
    expect(checkedReadSourceReference({ ...reference, connectionId })).toEqual({ ...reference, connectionId })
  })
  it.each(['x'.repeat(256), '\u4e2d'.repeat(256), '\u{1f680}'.repeat(128), `${'\u{1f680}'.repeat(127)}xx`])(
    'rejects ID longer than 255 UTF-16 code units %#', connectionId => {
      expect(connectionId.length).toBe(256)
      rejected({ ...reference, connectionId })
    },
  )
  const trimCharacters = [0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
  it.each(trimCharacters)('rejects leading/trailing ECMAScript trim character %# without normalizing', point => {
    const character = String.fromCodePoint(point)
    rejected({ ...reference, connectionId: `${character}synthetic` })
    rejected({ ...reference, connectionId: `synthetic${character}` })
  })
  it.each([...Array.from({ length: 32 }, (_value, point) => point), 127])('rejects embedded ASCII control %#', point => {
    rejected({ ...reference, connectionId: `synthetic${String.fromCodePoint(point)}connection` })
  })
  it.each([undefined, null, '', true, 1, 1n, Symbol('synthetic'), () => 'synthetic'].map(value => ({ value })))(
    'requires primitive nonempty ID %#', ({ value }) => { rejected({ ...reference, connectionId: value }) },
  )
  it.each([
    reference.connectionIncarnation.toUpperCase(), reference.connectionIncarnation.replace('a', 'A'),
    reference.connectionIncarnation.replaceAll('-', ''), `{${reference.connectionIncarnation}}`,
    `urn:uuid:${reference.connectionIncarnation}`, ` ${reference.connectionIncarnation}`, `${reference.connectionIncarnation} `,
    `${reference.connectionIncarnation}\n`, reference.connectionIncarnation.replace('a', 'g'),
    reference.connectionIncarnation.slice(1), `${reference.connectionIncarnation}0`,
    'abcdef12-345-4789-abcd-0123456789ab', '', null, undefined, 1, ['abcdef12-3456-4789-abcd-0123456789ab'],
  ].map(value => ({ value })))('rejects noncanonical UUID case %# without lowercasing or parsing', ({ value }) => {
    rejected({ ...reference, connectionIncarnation: value })
  })
})

// The rule-authority suite below exercises the actual revision migration.
it.each(['automation-live-authority-realdb', 'automation-read-ledger-realdb',
  'automation-read-execution-audit-realdb',
  'automation-read-record-activation-realdb',
  'automation-record-after-image-realdb', 'automation-record-after-image-retention-realdb',
  'automation-read-schedule-activation-realdb',
  'automation-read-date-schedule-realdb',
  'automation-read-owner-realdb',
  'automation-read-authoring-realdb',
  'automation-read-rule-authority-realdb', 'automation-read-target-authority-realdb',
  'automation-read-target-records-realdb', 'automation-read-installed-material-realdb',
  'automation-read-source-authority-realdb', 'automation-read-source-pointer-realdb',
  'automation-read-profiles-realdb', 'automation-read-material-epochs-realdb',
  'automation-read-authority-realdb', 'automation-read-runtime-realdb',
  'automation-read-delivery-realdb', 'automation-read-recovery-realdb'])('wires %s as a whole EXPECT_DB suite and excludes no-DB skip-green', name => {
  const root = path.resolve(__dirname, '..', '..', '..', '..', '..')
  const spec = `tests/integration/${name}.test.ts`
  const workflow = yaml.load(readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8')) as {
    jobs: { test: { steps: Array<{ id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown }> } }
  }
  const step = workflow.jobs.test.steps.find(entry => entry.id === 'external-system-delete-bind-lock-protocol-real-db')
  expect(step?.env?.EXPECT_DB).toBe('1')
  expect(step?.env?.DATABASE_URL).toBeTruthy()
  expect(step?.if).toBe("matrix.node-version == '20.x'")
  expect(step?.['continue-on-error']).toBeUndefined()
  const command = (step?.run ?? '').replace(/\\\r?\n/g, ' ')
  expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /)
  expect(command.split(/\s+/).filter(token => token === spec)).toHaveLength(1)
  expect(command).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
  const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  let excluded = false
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      excluded ||= node.initializer.elements.some(entry => ts.isStringLiteral(entry) && entry.text === spec)
    }
    ts.forEachChild(node, visit)
  }
  visit(config)
  expect(excluded).toBe(true)
})
