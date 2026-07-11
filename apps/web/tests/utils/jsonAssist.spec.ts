import { describe, expect, it } from 'vitest'
import { analyzeJsonText, formatJsonText } from '../../src/utils/jsonAssist'

// IU-5a (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5):
// pure-function coverage for the shared JSON-assist helper consumed by JsonAssist.vue across the
// four IU-5a sites. See jsonAssist.ts's header comment for the no-echo safety invariant this
// module exists to enforce — the sentinel case below is the load-bearing assertion.
describe('analyzeJsonText', () => {
  it('reports empty for a blank/whitespace-only string', () => {
    expect(analyzeJsonText('')).toEqual({ status: 'empty', line: null, column: null })
    expect(analyzeJsonText('   \n  ')).toEqual({ status: 'empty', line: null, column: null })
  })

  it('reports valid for well-formed JSON', () => {
    expect(analyzeJsonText('{"a": 1}')).toEqual({ status: 'valid', line: null, column: null })
    expect(analyzeJsonText('[]')).toEqual({ status: 'valid', line: null, column: null })
  })

  it('reports invalid with a line/column when the parser exposes a position', () => {
    // `{"a": 1,}` fails on the trailing comma; Node's V8 reports "at position 8" for this shape.
    const result = analyzeJsonText('{"a": 1,}')
    expect(result.status).toBe('invalid')
    expect(result.line).toBe(1)
    expect(typeof result.column).toBe('number')
  })

  it('computes line numbers from newlines preceding the failure position, not just column 0', () => {
    // Missing colon on line 3 — V8 reports "Expected ':' ... at position 18", which
    // `positionToLineColumn` independently re-derives as line 3 (not by trusting V8's own
    // "(line N column N)" suffix, which not all SyntaxError shapes carry).
    const text = '{\n  "a": 1,\n  "b" 2\n}'
    const result = analyzeJsonText(text)
    expect(result.status).toBe('invalid')
    expect(result.line).toBe(3)
    // No-leak tripwire on the WITH-position return path (path parity with the SENTINEL case, which
    // exercises the no-position path): the analysis object carries ONLY numbers/status, never a
    // forwarded error message (V8 embeds an input snippet in error.message).
    expect(Object.keys(result).sort()).toEqual(['column', 'line', 'status'])
  })

  it('falls back to invalid with no line/column when the parser gives no position', () => {
    const result = analyzeJsonText('')
    // (already covered as empty above) — exercise a message shape with no position instead:
    const truncated = analyzeJsonText('{')
    expect(truncated.status).toBe('invalid')
    // "Unexpected end of JSON input" carries no position in V8 — line/column may be null.
    void result
  })

  it('SENTINEL: never echoes secret-shaped input back — analysis carries no text, only numbers', () => {
    const secret = 'sk-SECRET-TOKEN-do-not-leak-9f8e7d6c5b4a'
    const text = `{"apiKey": ${secret}}` // invalid JSON (bareword value) — triggers the catch path
    const result = analyzeJsonText(text)
    expect(result.status).toBe('invalid')
    // The analysis result is plainly typed as numbers-or-null — assert the serialized result
    // (the only thing a caller could render) contains no substring of the secret.
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('sk-SECRET-TOKEN')
    // Structural no-leak tripwire (quality-gate finding): the substring scan above is Node-version
    // dependent (V8's SyntaxError snippet window may or may not cover the secret). The EXACT key set
    // is version-independent — any extra field (e.g. a forwarded error message) turns this red.
    expect(Object.keys(result).sort()).toEqual(['column', 'line', 'status'])
  })
})

describe('formatJsonText', () => {
  it('round-trips valid JSON with 2-space indentation', () => {
    expect(formatJsonText('{"a":1,"b":[1,2]}')).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}')
  })

  it('is idempotent on already-formatted text', () => {
    const once = formatJsonText('{"a":1}')
    expect(formatJsonText(once ?? '')).toBe(once)
  })

  it('returns null for invalid JSON instead of throwing', () => {
    expect(formatJsonText('{not valid')).toBeNull()
    expect(formatJsonText('')).toBeNull()
  })
})
