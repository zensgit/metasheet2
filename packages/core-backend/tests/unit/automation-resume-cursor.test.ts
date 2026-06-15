import { describe, it, expect } from 'vitest'
import {
  parseResumeCursor,
  type ConditionBranchResumeCursor,
} from '../../src/multitable/automation-resume-cursor'

function validBranchCursor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'condition_branch',
    parentStepIndex: 2,
    branchKey: 'high_amount',
    branchActionIndex: 1,
    stepKey: '2.branch.high_amount.1',
    parentJobId: 'exec_1:job:2',
    branchJobId: 'exec_1:job:2:branch:high_amount:1',
    upstreamJobId: null,
    branchActionFingerprint: { count: 3, hash: 'abc123' },
    ...overrides,
  }
}

describe('parseResumeCursor — A6-3-3 fail-closed safety invariant', () => {
  it('treats only NULL / undefined (or a JSON null) as the top-level (A6-2 legacy) path', () => {
    expect(parseResumeCursor(null)).toEqual({ kind: 'top_level' })
    expect(parseResumeCursor(undefined)).toEqual({ kind: 'top_level' })
    expect(parseResumeCursor('null')).toEqual({ kind: 'top_level' }) // JSON-encoded SQL NULL only
  })

  it('rejects a non-null { kind: "top_level" } OBJECT (corruption, not the legacy path)', () => {
    // The fail-open we are closing: a stored object must never force top-level resume.
    expect(parseResumeCursor({ kind: 'top_level' })).toEqual({ kind: 'invalid', reason: 'unknown_kind' })
    expect(parseResumeCursor('{"kind":"top_level"}')).toEqual({ kind: 'invalid', reason: 'unknown_kind' })
  })

  it('parses a valid condition_branch cursor (object or JSON string)', () => {
    const parsed = parseResumeCursor(validBranchCursor())
    expect(parsed.kind).toBe('condition_branch')
    const cursor = (parsed as { kind: 'condition_branch'; cursor: ConditionBranchResumeCursor }).cursor
    expect(cursor).toMatchObject({
      parentStepIndex: 2,
      branchKey: 'high_amount',
      branchActionIndex: 1,
      stepKey: '2.branch.high_amount.1',
      upstreamJobId: null,
      branchActionFingerprint: { count: 3, hash: 'abc123' },
    })
    // JSON-encoded column value parses identically.
    expect(parseResumeCursor(JSON.stringify(validBranchCursor()))).toEqual(parsed)
  })

  // The crux: a non-null but malformed / unknown cursor must NEVER become top_level.
  it('fails closed (invalid) on any non-null malformed value — never top-level fallback', () => {
    const cases: Array<[unknown, string]> = [
      [{}, 'empty object (no kind)'],
      [{ kind: 'unknown' }, 'unknown kind'],
      [{ kind: 'condition_branch' }, 'missing all branch fields'],
      [validBranchCursor({ branchKey: '' }), 'empty branchKey'],
      [validBranchCursor({ parentStepIndex: -1 }), 'negative parentStepIndex'],
      [validBranchCursor({ parentStepIndex: 1.5 }), 'non-integer parentStepIndex'],
      [validBranchCursor({ branchActionIndex: 'x' }), 'non-number branchActionIndex'],
      [validBranchCursor({ stepKey: 123 }), 'non-string stepKey'],
      [validBranchCursor({ upstreamJobId: 42 }), 'bad upstreamJobId'],
      [validBranchCursor({ branchActionFingerprint: { count: -1, hash: 'h' } }), 'bad fingerprint count'],
      [validBranchCursor({ branchActionFingerprint: null }), 'missing fingerprint'],
      ['not json at all', 'unparseable string'],
      [42, 'number'],
      [true, 'boolean'],
      [['condition_branch'], 'array'],
    ]
    for (const [input, label] of cases) {
      const result = parseResumeCursor(input)
      expect(result.kind, `expected invalid for: ${label}`).toBe('invalid')
      expect(result.kind, `must NOT be top_level for: ${label}`).not.toBe('top_level')
    }
  })

  it('reports a reason for invalid cursors (operator-debuggable, non-secret)', () => {
    expect(parseResumeCursor({}).kind).toBe('invalid')
    const r1 = parseResumeCursor({}) as { kind: 'invalid'; reason: string }
    expect(r1.reason).toBe('unknown_kind')
    const r2 = parseResumeCursor(validBranchCursor({ stepKey: '' })) as { kind: 'invalid'; reason: string }
    expect(r2.reason).toBe('bad_stepKey')
    const r3 = parseResumeCursor('not json') as { kind: 'invalid'; reason: string }
    expect(r3.reason).toBe('unparseable_json')
  })
})
