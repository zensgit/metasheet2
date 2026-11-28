/**
 * iPaaS S-line S2-a — the step-output library (multitable/automation-step-outputs.ts).
 *
 * Library only, no caller: a rule-derived plan, a rule-derived per-execution value store that layers on the
 * synthetic slice's createRunValueStore, the strict `{{steps.<key>.output.<selector>}}` resolver, the
 * business-key bound, the module-private execution registry, and the closed `step.output` builder.
 *
 * Guards covered here (ADR §10.2, U lane): G9 container layer + resolver table, G10 in-memory half,
 * G12 container-layer row/byte caps. Each guarantee-type block has a witnessed-red mutant (see PR body).
 */
import { describe, expect, it } from 'vitest'
import {
  RUN_VALUE_MAX_STRING_LENGTH,
  RUN_VALUE_STORE_MAX_ROWS,
  isRunValueStoreError,
  projectRow,
} from '../../src/multitable/automation-run-values'
import * as stepOutputs from '../../src/multitable/automation-step-outputs'
import {
  EXECUTION_STEP_OUTPUTS_MAX_BYTES,
  STEP_KEY_MAX_PER_RULE,
  STEP_OUTPUT_MAX_BYTES,
  STEP_OUTPUT_MAX_ROWS,
  STEP_OUTPUT_OUTCOMES,
  STEP_OUTPUT_REASON_OUTCOME,
  STEP_BUSINESS_KEY_MAX_LENGTH,
  activeStepOutputExecutionCount,
  buildStepOutput,
  createRunValueStoreFromRule,
  deriveStepOutputPlan,
  isUsableBusinessKey,
  parseStepOutputReference,
  requireBusinessKey,
  runWithStepOutputs,
  stepOutputsForExecution,
  type StepOutputRuleStep,
} from '../../src/multitable/automation-step-outputs'

const scopeA = { runId: 'exec-a', tenantId: 'tenant-a' }
const scopeB = { runId: 'exec-b', tenantId: 'tenant-a' }
const SENTINEL = 'SENTINEL-S2A-7f3c'
const SENTINEL_COLUMN = 'SENTINEL_S2A_7f3c'

function code(fn: () => unknown): string {
  try { fn() } catch (error) { return isRunValueStoreError(error) ? error.code : 'FOREIGN_ERROR' }
  return 'NO_ERROR'
}
async function codeAsync(fn: () => Promise<unknown>): Promise<string> {
  try { await fn() } catch (error) { return isRunValueStoreError(error) ? error.code : 'FOREIGN_ERROR' }
  return 'NO_ERROR'
}

/** read(k=read, cols id/qty) → lookup(k=lookup, key from read.first.id) → transform(rows from lookup). */
const BASE_RULE: readonly StepOutputRuleStep[] = [
  { type: 'call_connection', stepKey: 'read', output: { columns: ['id', 'qty'] } },
  { type: 'call_connection', stepKey: 'lookup', output: { columns: ['code', 'name'] }, scalarRefs: ['{{steps.read.output.first.id}}'] },
  { type: 'transform_records', stepKey: 'mapped', output: { columns: ['code'] }, rowRefs: [{ fromStep: 'lookup' }] },
  { type: 'send_notification' },
]

function basePlan() { return deriveStepOutputPlan({ steps: BASE_RULE }) }

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('1 ★ reference grammar — case table (closed set, whole-value binding only)', () => {
  it.each([
    ['{{steps.k.output.count}}', { stepKey: 'k', selector: 'count' }],
    ['{{steps.k.output.first.c}}', { stepKey: 'k', selector: 'first', column: 'c' }],
    ['{{steps.Read_1.output.first._col_9}}', { stepKey: 'Read_1', selector: 'first', column: '_col_9' }],
  ])('accepts %s', (text, expected) => {
    expect(parseStepOutputReference(text)).toEqual(expected)
    expect(Object.isFrozen(parseStepOutputReference(text))).toBe(true)
  })

  const longKey = `k${'a'.repeat(32)}` // 33 chars, over the 32 limit
  const maxKey = `k${'a'.repeat(31)}` // exactly 32
  const longColumn = `c${'a'.repeat(64)}` // 65 chars, over the 64 limit
  it.each([
    // mixed text / whitespace
    ['prefix {{steps.k.output.count}}'],
    ['{{steps.k.output.count}} suffix'],
    ['{{steps.k.output.count}}{{steps.k.output.count}}'],
    ['{{ steps.k.output.count }}'],
    ['{{steps.k.output.count }}'],
    [' {{steps.k.output.count}}'],
    ['{{steps.k.output.count}}\n'],
    ['\t{{steps.k.output.count}}'],
    ['{{steps.k.output.first. c}}'],
    // index / wildcard / multi-level paths
    ['{{steps.k.output.rows[0]}}'],
    ['{{steps.k.output.first[0]}}'],
    ['{{steps.k.output.*}}'],
    ['{{steps.*.output.count}}'],
    ['{{steps.k.output.first.c.d}}'],
    ['{{steps.k.output.first.c[0]}}'],
    ['{{steps.k.output.count.x}}'],
    ['{{steps.k.output}}'],
    ['{{steps.k}}'],
    // unknown selector, row. root
    ['{{steps.k.output.last.c}}'],
    ['{{steps.k.output.rows}}'],
    ['{{steps.k.output.first}}'],
    ['{{steps.k.output.length}}'],
    ['{{row.x}}'],
    ['{{steps.k.output.first.row.x}}'],
    // wrong case
    ['{{Steps.k.output.count}}'],
    ['{{STEPS.k.output.count}}'],
    ['{{steps.k.Output.count}}'],
    ['{{steps.k.output.Count}}'],
    ['{{steps.k.output.FIRST.c}}'],
    // empty / too long keys and columns, bad shapes
    ['{{steps..output.count}}'],
    ['{{steps.k.output.first.}}'],
    [`{{steps.${longKey}.output.count}}`],
    [`{{steps.k.output.first.${longColumn}}}`],
    ['{{steps.1k.output.count}}'],
    ['{{steps._k.output.count}}'],
    ['{{steps.k-1.output.count}}'],
    ['{{steps.k.output.first.c-1}}'],
    ['{{steps.k.output.first.1c}}'],
    ['{steps.k.output.count}'],
    ['{{{steps.k.output.count}}}'],
    ['steps.k.output.count'],
    [''],
    ['{{}}'],
  ])('refuses %j with RUN_VALUE_REF_SYNTAX', (text) => {
    expect(code(() => parseStepOutputReference(text))).toBe('RUN_VALUE_REF_SYNTAX')
  })

  it('refuses non-string input without coercion', () => {
    const coercible = { toString: () => '{{steps.k.output.count}}' }
    for (const value of [undefined, null, 1, true, ['{{steps.k.output.count}}'], coercible, new String('{{steps.k.output.count}}')]) {
      expect(code(() => parseStepOutputReference(value))).toBe('RUN_VALUE_REF_SYNTAX')
    }
  })

  it('accepts the maximum key length and the maximum column length exactly', () => {
    expect(parseStepOutputReference(`{{steps.${maxKey}.output.count}}`)).toEqual({ stepKey: maxKey, selector: 'count' })
    const maxColumn = `c${'a'.repeat(63)}`
    expect(parseStepOutputReference(`{{steps.k.output.first.${maxColumn}}}`)).toEqual({ stepKey: 'k', selector: 'first', column: maxColumn })
  })

  it('the error never echoes the reference text (values-free)', () => {
    expect.assertions(3)
    try { parseStepOutputReference(`{{steps.k.output.first.${SENTINEL}}} x`) } catch (error) {
      expect(String((error as Error).message)).toBe('RUN_VALUE_REF_SYNTAX')
      expect(JSON.stringify(error)).not.toContain(SENTINEL)
      expect(String((error as Error).stack)).not.toContain(SENTINEL)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('2 ★ prototype-chain names are refused everywhere; the resolver reads own properties only', () => {
  const RESERVED = ['__proto__', 'prototype', 'constructor']

  it.each(RESERVED)('%s as a selector column in a reference', (name) => {
    expect(code(() => parseStepOutputReference(`{{steps.k.output.first.${name}}}`))).toBe('RUN_VALUE_REF_SYNTAX')
  })

  it.each(RESERVED)('%s as a step key in a reference', (name) => {
    expect(code(() => parseStepOutputReference(`{{steps.${name}.output.count}}`))).toBe('RUN_VALUE_REF_SYNTAX')
  })

  it.each(RESERVED)('%s as a selector', (name) => {
    expect(code(() => parseStepOutputReference(`{{steps.k.output.${name}}}`))).toBe('RUN_VALUE_REF_SYNTAX')
  })

  it.each(RESERVED)('%s as a declared step key', (name) => {
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey: name, output: { columns: ['id'] } }] })))
      .toBe('RUN_VALUE_STEP_KEY_INVALID')
  })

  it.each(RESERVED)('%s as a declared output column', (name) => {
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey: 'k', output: { columns: ['id', name] } }] })))
      .toBe('RUN_VALUE_COLUMN_INVALID')
  })

  it.each(RESERVED)('%s as a row-set fromStep', (name) => {
    expect(code(() => deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'k', output: { columns: ['id'] } },
      { type: 'transform_records', rowRefs: [{ fromStep: name }] },
    ] }))).toBe('RUN_VALUE_REF_SYNTAX')
  })

  it('the resolver does not reach inherited members: toString / valueOf / hasOwnProperty are unknown columns', () => {
    const plan = deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'k', output: { columns: ['id'] } },
      { type: 'call_connection', scalarRefs: ['{{steps.k.output.count}}'] },
    ] })
    for (const inherited of ['toString', 'valueOf', 'hasOwnProperty']) {
      const store = createRunValueStoreFromRule(scopeA, plan)
      const handle = store.publish('k', [{ id: 'x' }])
      expect(code(() => store.resolveScalar(handle, `{{steps.k.output.first.${inherited}}}`, 1, scopeA))).toBe('RUN_VALUE_REF_UNKNOWN')
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('plan derivation (second layer behind the S3-a1 save gate)', () => {
  it('derives producers in top-level order, their declared columns, and consumers from the static reference graph', () => {
    const plan = basePlan()
    expect(plan.stepCount).toBe(4)
    expect(plan.producers.map((p) => [p.stepKey, p.position, [...p.columns], [...p.consumers]])).toEqual([
      ['read', 0, ['id', 'qty'], [1]],
      ['lookup', 1, ['code', 'name'], [2]],
      ['mapped', 2, ['code'], []],
    ])
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.producers[0].columns)).toBe(true)
  })

  it('a keyless call_connection may consume; a producer without a stepKey publishes nothing', () => {
    const plan = deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'read', output: { columns: ['id'] } },
      { type: 'call_connection', output: { columns: ['x'] }, scalarRefs: ['{{steps.read.output.count}}'] },
    ] })
    expect(plan.producers.map((p) => [p.stepKey, [...p.consumers]])).toEqual([['read', [1]]])
  })

  it('a stepKey on a type that produces no output is refused', () => {
    for (const type of ['send_notification', 'update_record', 'run_integration_job', 'start_approval', 'Call_connection']) {
      expect(code(() => deriveStepOutputPlan({ steps: [{ type, stepKey: 'k', output: { columns: ['id'] } }] }))).toBe('RUN_VALUE_STEP_KEY_INVALID')
    }
  })

  it.each(['', '1k', '_k', 'k-1', 'k.1', `k${'a'.repeat(32)}`, ' k', 'k ', 'ключ'])('stepKey %j has the wrong shape', (stepKey) => {
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey, output: { columns: ['id'] } }] }))).toBe('RUN_VALUE_STEP_KEY_INVALID')
  })

  it('a non-string stepKey is refused', () => {
    for (const stepKey of [null, 1, true, ['k'], { k: 1 }]) {
      expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey, output: { columns: ['id'] } } as never] })))
        .toBe('RUN_VALUE_STEP_KEY_INVALID')
    }
  })

  it('a duplicate stepKey is refused', () => {
    expect(code(() => deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'k', output: { columns: ['id'] } },
      { type: 'transform_records', stepKey: 'k', output: { columns: ['id'] } },
    ] }))).toBe('RUN_VALUE_STEP_KEY_DUPLICATE')
  })

  it.each(['', '1c', 'c-1', 'c.d', 'c:d', `c${'a'.repeat(64)}`, ' c'])('column %j has the wrong shape', (column) => {
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey: 'k', output: { columns: ['id', column] } }] })))
      .toBe('RUN_VALUE_COLUMN_INVALID')
  })

  it('duplicate, empty or missing column lists are refused', () => {
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey: 'k', output: { columns: ['id', 'id'] } }] }))).toBe('RUN_VALUE_COLUMN_INVALID')
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey: 'k', output: { columns: [] } }] }))).toBe('RUN_VALUE_COLUMN_INVALID')
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey: 'k' }] }))).toBe('RUN_VALUE_COLUMN_INVALID')
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', stepKey: 'k', output: { columns: [1] } } as never] }))).toBe('RUN_VALUE_COLUMN_INVALID')
  })

  it('references: forward, self, unknown key and undeclared column are refused statically', () => {
    const producer: StepOutputRuleStep = { type: 'call_connection', stepKey: 'read', output: { columns: ['id'] } }
    expect(code(() => deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'early', output: { columns: ['id'] }, scalarRefs: ['{{steps.read.output.count}}'] },
      producer,
    ] }))).toBe('RUN_VALUE_FORWARD_REF')
    expect(code(() => deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'read', output: { columns: ['id'] }, scalarRefs: ['{{steps.read.output.count}}'] },
    ] }))).toBe('RUN_VALUE_REF_SELF')
    expect(code(() => deriveStepOutputPlan({ steps: [
      { type: 'transform_records', stepKey: 'self', output: { columns: ['id'] }, rowRefs: [{ fromStep: 'self' }] },
    ] }))).toBe('RUN_VALUE_REF_SELF')
    expect(code(() => deriveStepOutputPlan({ steps: [producer, { type: 'call_connection', scalarRefs: ['{{steps.nope.output.count}}'] }] })))
      .toBe('RUN_VALUE_REF_UNKNOWN')
    expect(code(() => deriveStepOutputPlan({ steps: [producer, { type: 'call_connection', scalarRefs: ['{{steps.read.output.first.qty}}'] }] })))
      .toBe('RUN_VALUE_REF_UNKNOWN')
    expect(code(() => deriveStepOutputPlan({ steps: [producer, { type: 'transform_records', rowRefs: [{ fromStep: 'nope' }] }] })))
      .toBe('RUN_VALUE_REF_UNKNOWN')
    expect(code(() => deriveStepOutputPlan({ steps: [producer, { type: 'call_connection', scalarRefs: ['x {{steps.read.output.count}}'] }] })))
      .toBe('RUN_VALUE_REF_SYNTAX')
  })

  it('row-set references take exactly { fromStep } (no withRow, no extra key, no template string)', () => {
    const producer: StepOutputRuleStep = { type: 'call_connection', stepKey: 'read', output: { columns: ['id'] } }
    for (const ref of [{ fromStep: 'read', withRow: true }, { fromStep: 'read', output: 'x' }, {}, '{{steps.read.output.count}}', { fromStep: 1 }, null]) {
      expect(code(() => deriveStepOutputPlan({ steps: [producer, { type: 'transform_records', rowRefs: [ref] } as never] }))).toBe('RUN_VALUE_REF_SYNTAX')
    }
  })

  it('the step description key set is closed and must be plain data', () => {
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'call_connection', url: 'x' } as never] }))).toBe('RUN_VALUE_INPUT')
    expect(code(() => deriveStepOutputPlan({ steps: [Object.defineProperty({ type: 'call_connection' }, 'stepKey', { enumerable: true, get: () => 'k' })] })))
      .toBe('RUN_VALUE_INPUT')
    expect(code(() => deriveStepOutputPlan({ steps: 'nope' } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => deriveStepOutputPlan(null as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => deriveStepOutputPlan({ steps: [], extra: 1 } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => deriveStepOutputPlan({ steps: [{ type: 'send_notification', output: { columns: ['id'] } }] }))).toBe('RUN_VALUE_INPUT')
  })

  it('only a plan built by deriveStepOutputPlan constructs a rule store (no hand-built plan)', () => {
    const forged = JSON.parse(JSON.stringify(basePlan()))
    expect(code(() => createRunValueStoreFromRule(scopeA, forged))).toBe('RUN_VALUE_INPUT')
    expect(code(() => createRunValueStoreFromRule(scopeA, { ...basePlan() }))).toBe('RUN_VALUE_INPUT')
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('3 ★ G9 container layer', () => {
  function published() {
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    const read = store.publish('read', [{ id: 'M-1', qty: 3 }])
    const lookup = store.publish('lookup', [{ code: 'C-1', name: 'n1' }, { code: 'C-2', name: 'n2' }])
    return { store, read, lookup }
  }

  it('positive control: an earlier, successful producer resolves for its allowlisted consumer', () => {
    const { store, read, lookup } = published()
    expect(store.resolveScalar(read, '{{steps.read.output.first.id}}', 1, scopeA)).toBe('M-1')
    const rows = store.resolveRows(lookup, { fromStep: 'lookup' }, 2, scopeA)
    expect(rows).toEqual([{ code: 'C-1', name: 'n1' }, { code: 'C-2', name: 'n2' }])
    expect(Object.isFrozen(rows)).toBe(true)
    expect(Object.isFrozen(rows[0])).toBe(true)
  })

  it('forward: a consumer positioned before an already-published producer is refused', () => {
    // The producer IS published, so the refusal can only come from the predecessor check, not from
    // "declared but not yet published".
    const plan = deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'first', output: { columns: ['id'] } },
      { type: 'call_connection', stepKey: 'second', output: { columns: ['id'] }, scalarRefs: ['{{steps.first.output.count}}'] },
      { type: 'call_connection', scalarRefs: ['{{steps.second.output.count}}'] },
    ] })
    const store = createRunValueStoreFromRule(scopeA, plan)
    store.publish('first', [{ id: 'a' }])
    const second = store.publish('second', [{ id: 'b' }])
    expect(code(() => store.resolveScalar(second, '{{steps.second.output.count}}', 0, scopeA))).toBe('RUN_VALUE_FORWARD_REF')
    expect(code(() => store.resolveRows(second, { fromStep: 'second' }, 0, scopeA))).toBe('RUN_VALUE_FORWARD_REF')
    // control: the allowlisted later consumer resolves
    expect(store.resolveScalar(second, '{{steps.second.output.count}}', 2, scopeA)).toBe(1)
  })

  it('self: a step resolving its own output is refused', () => {
    const { store, read } = published()
    expect(code(() => store.resolveScalar(read, '{{steps.read.output.count}}', 0, scopeA))).toBe('RUN_VALUE_REF_SELF')
  })

  it('unknown key and undeclared column are refused', () => {
    const { store, read } = published()
    expect(code(() => store.resolveScalar(read, '{{steps.nope.output.count}}', 1, scopeA))).toBe('RUN_VALUE_REF_UNKNOWN')
    expect(code(() => store.resolveRows(read, { fromStep: 'nope' }, 1, scopeA))).toBe('RUN_VALUE_REF_UNKNOWN')
    expect(code(() => store.resolveScalar(read, '{{steps.read.output.first.secret}}', 1, scopeA))).toBe('RUN_VALUE_REF_UNKNOWN')
    expect(code(() => store.publish('nope', [{ id: 'x' }]))).toBe('RUN_VALUE_UNDECLARED')
  })

  it('a consumer outside the static reference graph is refused', () => {
    const { store, read } = published()
    // position 3 (send_notification) and 2 (mapped) never referenced `read`
    expect(code(() => store.resolveScalar(read, '{{steps.read.output.count}}', 3, scopeA))).toBe('RUN_VALUE_CONSUMER_DENIED')
    expect(code(() => store.resolveScalar(read, '{{steps.read.output.count}}', 2, scopeA))).toBe('RUN_VALUE_CONSUMER_DENIED')
  })

  it('a handle from another execution, a handle-shaped plain object, or the wrong producer\'s handle is refused', () => {
    const { store, read, lookup } = published()
    const other = createRunValueStoreFromRule(scopeB, basePlan())
    const otherRead = other.publish('read', [{ id: 'M-1', qty: 3 }])
    expect(code(() => store.resolveScalar(otherRead, '{{steps.read.output.first.id}}', 1, scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
    expect(code(() => store.resolveScalar({ kind: 'run-value-ref' }, '{{steps.read.output.first.id}}', 1, scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
    expect(code(() => store.resolveScalar(Object.freeze(Object.create(null, { kind: { value: 'run-value-ref', enumerable: true } })), '{{steps.read.output.first.id}}', 1, scopeA)))
      .toBe('RUN_VALUE_FOREIGN_REF')
    expect(code(() => store.resolveScalar('read', '{{steps.read.output.first.id}}', 1, scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
    expect(code(() => store.resolveScalar(lookup, '{{steps.read.output.first.id}}', 1, scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
    // right handle, but the caller claims another execution
    expect(code(() => store.resolveScalar(read, '{{steps.read.output.first.id}}', 1, scopeB))).toBe('RUN_VALUE_FOREIGN_REF')
  })

  it('a handle minted by another store with the same scope is refused', () => {
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    const other = createRunValueStoreFromRule(scopeA, basePlan())
    const handle = other.publish('read', [{ id: 'x', qty: 1 }])
    expect(code(() => store.resolveScalar(handle, '{{steps.read.output.count}}', 1, scopeA))).toBe('RUN_VALUE_FOREIGN_REF')
  })

  it('a malformed consumer position is refused', () => {
    const { store, read } = published()
    for (const position of [-1, 1.5, Number.NaN, '1', 99]) {
      expect(code(() => store.resolveScalar(read, '{{steps.read.output.count}}', position as never, scopeA))).toBe('RUN_VALUE_INPUT')
    }
  })

  it('publication is once per output, on exactly the declared columns, finite scalars only', () => {
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    store.publish('read', [{ id: 'x', qty: 1 }])
    // a refused duplicate is not counted: neither the output, its rows nor its bytes
    const before = store.counts()
    expect(code(() => store.publish('read', [{ id: 'x', qty: 1 }]))).toBe('RUN_VALUE_DUPLICATE')
    expect(store.counts()).toEqual(before)
    const fresh = () => createRunValueStoreFromRule(scopeA, basePlan())
    for (const rows of [[{ id: 'x' }], [{ id: 'x', qty: 1, extra: 1 }], [{ id: 'x', qty: Number.NaN }], [{ id: 'x', qty: { n: 1 } }], 'rows', [JSON.parse('{"id":"x","__proto__":{}}')]]) {
      expect(code(() => fresh().publish('read', rows))).toBe('RUN_VALUE_INPUT')
    }
  })

  it('projectRow returns a frozen row and refuses a wrong key name even when the key count matches', () => {
    const row = projectRow({ id: 'x', qty: 1 }, ['id', 'qty'])
    expect(row).toEqual({ id: 'x', qty: 1 })
    expect(Object.isFrozen(row)).toBe(true)
    expect(code(() => projectRow({ id: 'x', extra: 1 }, ['id', 'qty']))).toBe('RUN_VALUE_INPUT')
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    const before = store.counts()
    expect(code(() => store.publish('read', [{ id: 'x', extra: 1 }]))).toBe('RUN_VALUE_INPUT')
    expect(store.counts()).toEqual(before)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('4 ★ G10 in-memory half: isolation and dispose', () => {
  it('two executions\' stores are mutually invisible through the registry', async () => {
    const plan = basePlan()
    await runWithStepOutputs(scopeA, plan, async (storeA) => {
      const handleA = storeA.publish('read', [{ id: 'A', qty: 1 }])
      await runWithStepOutputs(scopeB, plan, async (storeB) => {
        expect(stepOutputsForExecution(scopeA)).toBe(storeA)
        expect(stepOutputsForExecution(scopeB)).toBe(storeB)
        expect(storeB).not.toBe(storeA)
        expect(storeB.counts()).toEqual({ outputs: 0, rows: 0, bytes: 0 })
        expect(code(() => storeB.resolveScalar(handleA, '{{steps.read.output.first.id}}', 1, scopeB))).toBe('RUN_VALUE_FOREIGN_REF')
        // the same execution id under another tenant finds nothing
        expect(stepOutputsForExecution({ runId: scopeA.runId, tenantId: 'tenant-z' })).toBeUndefined()
      })
      expect(stepOutputsForExecution(scopeB)).toBeUndefined()
      expect(storeA.resolveScalar(handleA, '{{steps.read.output.first.id}}', 1, scopeA)).toBe('A')
    })
    expect(activeStepOutputExecutionCount()).toBe(0)
  })

  it('a second open of the same execution id is refused while the first is live', async () => {
    await runWithStepOutputs(scopeA, basePlan(), async () => {
      expect(await codeAsync(() => runWithStepOutputs(scopeA, basePlan(), async () => 1))).toBe('RUN_VALUE_INPUT')
    })
    expect(activeStepOutputExecutionCount()).toBe(0)
  })

  it('after dispose every resolution and publication is RUN_VALUE_DISPOSED (even a malformed one)', () => {
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    const read = store.publish('read', [{ id: 'x', qty: 1 }])
    store.dispose()
    expect(store.disposed).toBe(true)
    expect(store.counts()).toEqual({ outputs: 0, rows: 0, bytes: 0 })
    expect(code(() => store.resolveScalar(read, '{{steps.read.output.first.id}}', 1, scopeA))).toBe('RUN_VALUE_DISPOSED')
    expect(code(() => store.resolveScalar(read, 'not a reference', 1, scopeA))).toBe('RUN_VALUE_DISPOSED')
    expect(code(() => store.resolveRows(read, { fromStep: 'read' }, 1, scopeA))).toBe('RUN_VALUE_DISPOSED')
    expect(code(() => store.publish('lookup', [{ code: 'c', name: 'n' }]))).toBe('RUN_VALUE_DISPOSED')
    expect(code(() => store.resolveRows(read, 'not a reference' as never, 1, scopeA))).toBe('RUN_VALUE_DISPOSED')
    expect(code(() => store.publish('nope', 'rows'))).toBe('RUN_VALUE_DISPOSED')
  })

  it('the success path disposes and unregisters', async () => {
    let captured: ReturnType<typeof createRunValueStoreFromRule> | undefined
    const result = await runWithStepOutputs(scopeA, basePlan(), async (store) => {
      captured = store
      store.publish('read', [{ id: 'x', qty: 1 }])
      return 'done'
    })
    expect(result).toBe('done')
    expect(captured?.disposed).toBe(true)
    expect(stepOutputsForExecution(scopeA)).toBeUndefined()
    expect(activeStepOutputExecutionCount()).toBe(0)
  })

  it('a failed step outcome (returned, not thrown) disposes and unregisters', async () => {
    let captured: ReturnType<typeof createRunValueStoreFromRule> | undefined
    const result = await runWithStepOutputs(scopeA, basePlan(), async (store) => {
      captured = store
      store.publish('read', [{ id: 'x', qty: 1 }])
      expect(code(() => store.resolveScalar(store.publish('lookup', []), '{{steps.lookup.output.first.code}}', 2, scopeA))).toBe('RUN_VALUE_FIRST_NOT_SINGLE')
      return { status: 'failed' as const }
    })
    expect(result).toEqual({ status: 'failed' })
    expect(captured?.disposed).toBe(true)
    expect(activeStepOutputExecutionCount()).toBe(0)
  })

  it('a thrown error disposes, unregisters and propagates unchanged', async () => {
    let captured: ReturnType<typeof createRunValueStoreFromRule> | undefined
    const boom = new Error('boom')
    await expect(runWithStepOutputs(scopeA, basePlan(), async (store) => {
      captured = store
      store.publish('read', [{ id: 'x', qty: 1 }])
      throw boom
    })).rejects.toBe(boom)
    expect(captured?.disposed).toBe(true)
    expect(stepOutputsForExecution(scopeA)).toBeUndefined()
    expect(activeStepOutputExecutionCount()).toBe(0)
    // a synchronous throw inside the callback too
    await expect(runWithStepOutputs(scopeA, basePlan(), () => { throw boom })).rejects.toBe(boom)
    expect(activeStepOutputExecutionCount()).toBe(0)
  })

  it('published values are deep-frozen; resolved rows cannot be mutated', () => {
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    const lookup = store.publish('lookup', [{ code: 'C-1', name: 'n1' }])
    const rows = store.resolveRows(lookup, { fromStep: 'lookup' }, 2, scopeA)
    expect(() => { (rows as unknown as unknown[]).push({}) }).toThrow()
    expect(() => { (rows[0] as Record<string, unknown>).code = 'X' }).toThrow()
    expect(store.resolveRows(lookup, { fromStep: 'lookup' }, 2, scopeA)).toEqual([{ code: 'C-1', name: 'n1' }])
  })

  it('the store, its handles and the module expose no value and no registry', () => {
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    const handle = store.publish('read', [{ id: SENTINEL, qty: 1 }])
    expect(Object.isFrozen(store)).toBe(true)
    expect(JSON.stringify(store)).not.toContain(SENTINEL)
    expect(JSON.stringify(handle)).not.toContain(SENTINEL)
    expect(Object.keys(store).sort()).toEqual(['counts', 'dispose', 'disposed', 'publish', 'resolveRows', 'resolveScalar'])
    for (const exported of Object.values(stepOutputs)) {
      expect(exported instanceof Map || exported instanceof WeakMap || exported instanceof Set).toBe(false)
    }
  })

  it('errors carry the code only (values-free)', () => {
    const store = createRunValueStoreFromRule(scopeA, basePlan())
    const read = store.publish('read', [{ id: SENTINEL, qty: 1 }])
    for (const fn of [
      () => store.resolveScalar(read, `{{steps.read.output.first.${SENTINEL_COLUMN}}}`, 1, scopeA),
      () => store.publish('read', [{ id: SENTINEL, qty: 1 }]),
      () => requireBusinessKey(`${SENTINEL}\u0000`),
    ]) {
      try { fn(); throw new Error('expected a refusal') } catch (error) {
        expect(isRunValueStoreError(error)).toBe(true)
        expect((error as Error).message).toBe((error as { code: string }).code)
        expect(String((error as Error).stack)).not.toContain(SENTINEL)
        expect(String((error as Error).stack)).not.toContain(SENTINEL_COLUMN)
      }
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('5 ★ G12 container layer: rows, bytes, execution total, step-key count', () => {
  const oneColumnPlan = (keys: number) => deriveStepOutputPlan({ steps: Array.from({ length: keys }, (_, i) => ({
    type: 'call_connection', stepKey: `k${i}`, output: { columns: ['c'] },
  })) })
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ c: i }))
  /** One row, one column `c`: canonical JSON is `[{"c":"<s>"}]`, i.e. 10 bytes of framing. */
  const oneRowOfBytes = (bytes: number, unit = 'a') => {
    const unitBytes = Buffer.byteLength(unit, 'utf8')
    const body = bytes - 10
    if (body % unitBytes !== 0) throw new Error('fixture: size not divisible')
    return [{ c: unit.repeat(body / unitBytes) }]
  }

  it('the caps are the ADR §5.6 values', () => {
    expect(STEP_OUTPUT_MAX_ROWS).toBe(100)
    expect(STEP_OUTPUT_MAX_BYTES).toBe(1024 * 1024)
    expect(EXECUTION_STEP_OUTPUTS_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(STEP_KEY_MAX_PER_RULE).toBe(8)
    expect(STEP_BUSINESS_KEY_MAX_LENGTH).toBe(128)
    // the underlying store's own hard limits (既有, re-exported read-only for the rule-derived path)
    expect(RUN_VALUE_STORE_MAX_ROWS).toBe(10_000)
    expect(RUN_VALUE_MAX_STRING_LENGTH).toBe(1024 * 1024)
  })

  it('99 and 100 rows publish; 101 rows fail and publish nothing', () => {
    const store = createRunValueStoreFromRule(scopeA, oneColumnPlan(3))
    store.publish('k0', rowsOf(99))
    store.publish('k1', rowsOf(100))
    const before = store.counts()
    expect(before.rows).toBe(199)
    expect(code(() => store.publish('k2', rowsOf(101)))).toBe('RUN_VALUE_OUTPUT_TOO_LARGE')
    expect(store.counts()).toEqual(before)
    // nothing was consumed: a conforming output can still be published under the same key
    store.publish('k2', rowsOf(1))
    expect(store.counts().outputs).toBe(3)
  })

  it('an output of exactly 1 MiB publishes; one byte more fails (bytes, not characters)', () => {
    const store = createRunValueStoreFromRule(scopeA, oneColumnPlan(4))
    store.publish('k0', oneRowOfBytes(STEP_OUTPUT_MAX_BYTES))
    expect(store.counts().bytes).toBe(STEP_OUTPUT_MAX_BYTES)
    expect(code(() => store.publish('k1', oneRowOfBytes(STEP_OUTPUT_MAX_BYTES + 1)))).toBe('RUN_VALUE_OUTPUT_TOO_LARGE')
    // multi-byte: half as many characters, same byte count
    store.publish('k2', oneRowOfBytes(STEP_OUTPUT_MAX_BYTES, 'é'))
    const before = store.counts()
    expect(code(() => store.publish('k3', oneRowOfBytes(STEP_OUTPUT_MAX_BYTES + 2, 'é')))).toBe('RUN_VALUE_OUTPUT_TOO_LARGE')
    expect(store.counts()).toEqual(before)
  })

  it('the execution total may reach 4 MiB exactly; the output that crosses it fails and publishes nothing', () => {
    const store = createRunValueStoreFromRule(scopeA, oneColumnPlan(6))
    for (let i = 0; i < 4; i++) store.publish(`k${i}`, oneRowOfBytes(STEP_OUTPUT_MAX_BYTES))
    expect(store.counts().bytes).toBe(EXECUTION_STEP_OUTPUTS_MAX_BYTES)
    const before = store.counts()
    expect(code(() => store.publish('k4', [{ c: 1 }]))).toBe('RUN_VALUE_OUTPUT_TOO_LARGE')
    expect(store.counts()).toEqual(before)
    // even an empty output is `[]` (2 bytes) and does not fit in a spent budget
    expect(code(() => store.publish('k5', []))).toBe('RUN_VALUE_OUTPUT_TOO_LARGE')
    expect(store.counts()).toEqual(before)
  })

  const sixColumnPlan = () => deriveStepOutputPlan({ steps: [
    { type: 'call_connection', stepKey: 'wide', output: { columns: ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'] } },
  ] })
  /** 100 rows × 6 columns, every cell the same store-legal 1 MiB string: ~600 MiB of canonical JSON. */
  const hugeOutput = () => {
    const cell = 'a'.repeat(1024 * 1024)
    return Array.from({ length: 100 }, () => ({ c0: cell, c1: cell, c2: cell, c3: cell, c4: cell, c5: cell }))
  }

  it('a huge over-cap output fails with the frozen code (never a foreign RangeError) and publishes nothing', () => {
    const store = createRunValueStoreFromRule(scopeA, sixColumnPlan())
    const before = store.counts()
    expect(code(() => store.publish('wide', hugeOutput()))).toBe('RUN_VALUE_OUTPUT_TOO_LARGE')
    expect(store.counts()).toEqual(before)
  })

  it('bytes are counted incrementally and the publish stops at the first cell that crosses the cap', () => {
    const store = createRunValueStoreFromRule(scopeA, sixColumnPlan())
    const rows = hugeOutput()
    const original = JSON.stringify
    let calls = 0
    const spy = (...args: Parameters<typeof JSON.stringify>) => { calls++; return original(...args) }
    JSON.stringify = spy as typeof JSON.stringify
    let result: string
    try { result = code(() => store.publish('wide', rows)) } finally { JSON.stringify = original }
    expect(result).toBe('RUN_VALUE_OUTPUT_TOO_LARGE')
    // the first 1 MiB cell alone already crosses the 1 MiB cap: nothing after it is serialized (never 6, never 600)
    expect(calls).toBe(1)
    expect(store.counts()).toEqual({ outputs: 0, rows: 0, bytes: 0 })
  })

  it('counted bytes equal the UTF-8 length of the canonical JSON exactly (framing, escapes, multi-byte)', () => {
    const plan = deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'a', output: { columns: ['x', 'long_column_name', 'z'] } },
      { type: 'call_connection', stepKey: 'b', output: { columns: ['only'] } },
      { type: 'call_connection', stepKey: 'e', output: { columns: ['x'] } },
    ] })
    const store = createRunValueStoreFromRule(scopeA, plan)
    const canonical = (rows: readonly Record<string, unknown>[], columns: readonly string[]) =>
      Buffer.byteLength(JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])))), 'utf8')
    const a = [
      { z: null, x: 1, long_column_name: true },
      { long_column_name: false, z: -12.5e-7, x: 'quote " backslash \\ newline \n tab \t ctl \u0001 \u001f' },
      { x: 'é ü 中文 😀', long_column_name: '\ud800 lone surrogate', z: 0 },
      { x: '', long_column_name: '  ', z: 9007199254740991 },
    ]
    const b = [{ only: 'one' }, { only: 2 }]
    let expected = 0
    store.publish('a', a)
    expected += canonical(a, ['x', 'long_column_name', 'z'])
    expect(store.counts().bytes).toBe(expected)
    store.publish('b', b)
    expected += canonical(b, ['only'])
    expect(store.counts().bytes).toBe(expected)
    store.publish('e', [])
    expected += 2 // `[]`
    expect(store.counts().bytes).toBe(expected)
  })

  it('a rule with 8 stepKeys derives; the 9th is refused', () => {
    expect(oneColumnPlan(8).producers).toHaveLength(8)
    expect(code(() => oneColumnPlan(9))).toBe('RUN_VALUE_PLAN_TOO_LARGE')
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('6 first.<column> needs exactly one row; values keep their type', () => {
  const plan = deriveStepOutputPlan({ steps: [
    { type: 'call_connection', stepKey: 'k', output: { columns: ['s', 'n', 'b', 'z'] } },
    { type: 'call_connection', scalarRefs: ['{{steps.k.output.first.s}}'] },
  ] })
  const row = { s: 'text', n: 42, b: false, z: null }

  it.each([[0], [2]])('%i rows → RUN_VALUE_FIRST_NOT_SINGLE', (n) => {
    const store = createRunValueStoreFromRule(scopeA, plan)
    const handle = store.publish('k', Array.from({ length: n }, () => row))
    expect(code(() => store.resolveScalar(handle, '{{steps.k.output.first.s}}', 1, scopeA))).toBe('RUN_VALUE_FIRST_NOT_SINGLE')
    expect(store.resolveScalar(handle, '{{steps.k.output.count}}', 1, scopeA)).toBe(n)
  })

  it('1 row → the value in its original type (no string conversion)', () => {
    const store = createRunValueStoreFromRule(scopeA, plan)
    const handle = store.publish('k', [row])
    expect(store.resolveScalar(handle, '{{steps.k.output.first.s}}', 1, scopeA)).toBe('text')
    expect(store.resolveScalar(handle, '{{steps.k.output.first.n}}', 1, scopeA)).toBe(42)
    expect(store.resolveScalar(handle, '{{steps.k.output.first.b}}', 1, scopeA)).toBe(false)
    expect(store.resolveScalar(handle, '{{steps.k.output.first.z}}', 1, scopeA)).toBeNull()
    expect(store.resolveScalar(handle, '{{steps.k.output.count}}', 1, scopeA)).toBe(1)
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('7 business-key bound (ADR §5.6, mirrors the configured-read key bound)', () => {
  it.each([
    [null], [true], [false], [''], ['   '], ['\t\n'], ['a'.repeat(129)], [`ab\u0000c`], ['a\u001fb'], ['a\u007fb'],
    [Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [undefined], [{}], [['a']], [10n],
  ])('refuses case %#', (value) => {
    expect(isUsableBusinessKey(value)).toBe(false)
    expect(code(() => requireBusinessKey(value))).toBe('RUN_VALUE_KEY_UNUSABLE')
  })

  it.each([[0], [42], [-3.5], ['M-001'], ['a'.repeat(128)], [`  ${'a'.repeat(128)}  `], ['物料-甲']])('accepts %j unchanged', (value) => {
    expect(isUsableBusinessKey(value)).toBe(true)
    expect(requireBusinessKey(value)).toBe(value)
  })

  it('composes with the resolver: a resolved null is not a usable key', () => {
    const plan = deriveStepOutputPlan({ steps: [
      { type: 'call_connection', stepKey: 'k', output: { columns: ['id'] } },
      { type: 'call_connection', scalarRefs: ['{{steps.k.output.first.id}}'] },
    ] })
    const store = createRunValueStoreFromRule(scopeA, plan)
    const handle = store.publish('k', [{ id: null }])
    expect(code(() => requireBusinessKey(store.resolveScalar(handle, '{{steps.k.output.first.id}}', 1, scopeA)))).toBe('RUN_VALUE_KEY_UNUSABLE')
  })
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('8 step.output builder: closed key set, closed outcome/reason, no spread entry', () => {
  const valid = () => ({
    outcome: 'completed' as const,
    reason: 'ok' as const,
    operation: { kind: 'read_source_config' as const, configId: 'cfg-1' },
    counts: { rows: 3, columns: 2, bytes: 120 },
    capReached: false,
    complete: true,
    durationMs: 15,
  })

  it('builds exactly the closed key set, frozen', () => {
    const output = buildStepOutput(valid())
    expect(Object.keys(output).sort()).toEqual(['capReached', 'complete', 'counts', 'durationMs', 'operation', 'outcome', 'reason'])
    expect(Object.keys(output.operation).sort()).toEqual(['configId', 'kind'])
    expect(Object.keys(output.counts).sort()).toEqual(['bytes', 'columns', 'rows'])
    expect(Object.isFrozen(output) && Object.isFrozen(output.operation) && Object.isFrozen(output.counts)).toBe(true)
    const failed = buildStepOutput({ ...valid(), outcome: 'failed', reason: 'source_error', complete: false, errorClass: 'READ_SOURCE_PROBE_REJECTED' })
    expect(Object.keys(failed).sort()).toEqual(['capReached', 'complete', 'counts', 'durationMs', 'errorClass', 'operation', 'outcome', 'reason'])
  })

  it('the outcome set and the reason table are the ADR §4.8 v5 closed sets', () => {
    expect([...STEP_OUTPUT_OUTCOMES]).toEqual(['completed', 'skipped', 'not_started', 'failed'])
    expect({ ...STEP_OUTPUT_REASON_OUTCOME }).toEqual({
      ok: 'completed',
      action_disabled: 'skipped', rule_sheet_unregistered: 'skipped', principal_unauthorized: 'skipped',
      operation_not_found: 'skipped', operation_not_approved: 'skipped', operation_changed: 'skipped',
      kind_not_admitted: 'skipped', mode_not_admitted: 'skipped', columns_not_admitted: 'skipped',
      system_unavailable: 'skipped', system_overrides_request: 'skipped', read_authorization_required: 'skipped',
      write_gate_refused: 'skipped', adapter_refused: 'skipped', busy: 'skipped',
      config_invalid: 'not_started', port_inactive: 'not_started', authority_unavailable: 'not_started',
      input_unresolved: 'not_started', row_unavailable: 'not_started',
      timeout: 'failed', shutdown: 'failed', redirect_refused: 'failed', origin_refused: 'failed',
      request_not_allowed: 'failed', source_error: 'failed', row_cap_reached: 'failed', source_incomplete: 'failed',
      output_not_scalar: 'failed', output_too_large: 'failed', transform_failed: 'failed', yida_plan_rejected: 'failed',
      draft_refused: 'failed',
    })
    expect(Object.keys(STEP_OUTPUT_REASON_OUTCOME)).not.toContain('parity_violation')
    expect(Object.isFrozen(STEP_OUTPUT_REASON_OUTCOME)).toBe(true)
  })

  it('one extra key anywhere is refused (so a spread raw result cannot enter)', () => {
    const raw = { ...valid(), data: { rows: [{ id: SENTINEL }] } }
    expect(code(() => buildStepOutput(raw as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), evidence: {} } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), operation: { kind: 'read_source_config', configId: 'c', workspaceId: 'w' } } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), counts: { rows: 1, columns: 1, bytes: 1, values: 1 } } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), errorClass: undefined } as never))).toBe('RUN_VALUE_INPUT')
  })

  it('an outcome or reason outside the closed set, or a mismatched pair, is refused', () => {
    expect(code(() => buildStepOutput({ ...valid(), outcome: 'succeeded' } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), reason: 'parity_violation' } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), reason: 'toString' } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), reason: '__proto__' } as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), outcome: 'skipped', reason: 'ok' }))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput({ ...valid(), outcome: 'failed', reason: 'input_unresolved' }))).toBe('RUN_VALUE_INPUT')
  })

  it('counts, flags, duration, operation and errorClass are typed narrowly', () => {
    for (const bad of [
      { counts: { rows: -1, columns: 1, bytes: 1 } }, { counts: { rows: 1.5, columns: 1, bytes: 1 } },
      { counts: { rows: '1', columns: 1, bytes: 1 } }, { durationMs: -1 }, { durationMs: Number.NaN }, { durationMs: 1.5 },
      { capReached: 'false' }, { complete: 1 }, { operation: { kind: 'http', configId: 'c' } },
      { operation: { kind: 'read_source_config', configId: '' } }, { operation: { kind: 'read_source_config', configId: `c${SENTINEL} x` } },
      { outcome: 'failed', reason: 'source_error', errorClass: 'raw adapter message' },
      { errorClass: 'READ_SOURCE_PROBE_REJECTED' }, // errorClass never on completed
    ]) {
      expect(code(() => buildStepOutput({ ...valid(), ...bad } as never))).toBe('RUN_VALUE_INPUT')
    }
  })

  it('accessor properties and non-plain inputs are refused', () => {
    const withGetter = Object.defineProperty({ ...valid() }, 'durationMs', { enumerable: true, get: () => 1 })
    expect(code(() => buildStepOutput(withGetter))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput(null as never))).toBe('RUN_VALUE_INPUT')
    expect(code(() => buildStepOutput(new (class { outcome = 'completed' })() as never))).toBe('RUN_VALUE_INPUT')
  })
})
