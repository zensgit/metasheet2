/**
 * B4 (docs/development/multitable-remaining-development-inventory-and-sequencing-20260712.md §5):
 * server ⟷ FE parity guard for the ALWAYS-read-only field predicate.
 *
 * Why this file exists (feedback_mock_is_not_the_contract.md — "client filter must mirror server
 * predicate, pin BOTH directions"): apps/web's client-side mirror
 * (apps/web/src/multitable/utils/field-permissions.ts, `isFieldAlwaysReadOnly`) was hand-written to
 * match this package's `isFieldAlwaysReadOnly` (permission-derivation.ts:58-68). A same-PR mirror that
 * is only exercised against ITS OWN hardcoded case table (the apps/web-side spec,
 * apps/web/tests/multitable-b4-field-always-readonly.spec.ts) is a wire-vs-fixture blind spot — see the
 * formula-catalog-web-parity precedent in this same directory, which proved (via an adversarial delete)
 * that a same-PR mirror can drift silently while its own spec stays green.
 *
 * This test closes that gap from the side that CAN see both: packages/core-backend has no reason NOT to
 * import its own predicate live, and apps/web's helper file
 * (apps/web/src/multitable/utils/field-permissions.ts) has ZERO runtime dependencies beyond a
 * type-only import from a dependency-free types.ts — so it is a plain, side-effect-free TS module a
 * Node/vitest environment can import directly via a relative path (no @metasheet/core-backend →
 * apps/web workspace dependency needed, no bundler). Both predicates are therefore LIVE here, not
 * copies — a change to EITHER side that breaks parity turns this test red.
 *
 * This runs in the required `plugin-tests.yml` gate's "Run core-backend tests" step (default `vitest`
 * run, tests/unit/** is not in the DB-gated exclude list) — no hand-kept CI filter needed, unlike the
 * apps/web-side spec.
 *
 * Anti-fixture hardening (mirrors formula-catalog-web-parity.test.ts's rationale): if the relative
 * import path to the FE helper ever breaks, or the server source file becomes unreadable, that must
 * fail LOUD (an import error / thrown exception), not silently pass with a vacuously-true case table.
 * The "canary" test additionally scans the SERVER predicate's source text for its known condition
 * anchors and bounds its `===` comparison count — if the predicate legitimately grows a NEW branch
 * (e.g. a new always-read-only field kind), that test fails loud as a reminder to update: (a) the FE
 * mirror, (b) this file's CASES table, (c) the canary's expected anchors/count.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isFieldAlwaysReadOnly as isFieldAlwaysReadOnlyServer } from '../../src/multitable/permission-derivation'
// LIVE import of the FE mirror across the package boundary — see file header. Relative path, not a
// workspace package import: apps/web is not (and must not become) a runtime dependency of
// @metasheet/core-backend.
// eslint-disable-next-line import/no-relative-packages
import { isFieldAlwaysReadOnly as isFieldAlwaysReadOnlyFE } from '../../../../apps/web/src/multitable/utils/field-permissions'

type Case = {
  label: string
  field: { type: string; property?: Record<string, unknown> }
  expected: boolean
}

const CASES: Case[] = [
  { label: 'formula type', field: { type: 'formula', property: {} }, expected: true },
  { label: 'lookup type', field: { type: 'lookup', property: {} }, expected: true },
  { label: 'rollup type', field: { type: 'rollup', property: {} }, expected: true },
  { label: 'system type: autoNumber', field: { type: 'autoNumber', property: {} }, expected: true },
  { label: 'system type: createdTime', field: { type: 'createdTime', property: {} }, expected: true },
  { label: 'system type: modifiedTime', field: { type: 'modifiedTime', property: {} }, expected: true },
  { label: 'system type: createdBy', field: { type: 'createdBy', property: {} }, expected: true },
  { label: 'system type: modifiedBy', field: { type: 'modifiedBy', property: {} }, expected: true },
  { label: 'mirror link (non-empty mirrorOf)', field: { type: 'link', property: { mirrorOf: 'fld_forward' } }, expected: true },
  { label: 'raw property.readonly (lowercase)', field: { type: 'string', property: { readonly: true } }, expected: true },
  { label: 'raw property.readOnly (camelCase)', field: { type: 'string', property: { readOnly: true } }, expected: true },
  // Edge cases — the predicate is deliberately NARROW; neither side may overreach.
  { label: 'empty-string mirrorOf does NOT trip (server checks .length > 0)', field: { type: 'link', property: { mirrorOf: '' } }, expected: false },
  { label: 'non-string mirrorOf does NOT trip (server type-guards typeof === \'string\')', field: { type: 'link', property: { mirrorOf: 123 as unknown as string } }, expected: false },
  // Negative leg — ordinary editable fields must stay editable.
  { label: 'ordinary string field, no special property', field: { type: 'string', property: {} }, expected: false },
  { label: 'field with no property key at all', field: { type: 'string' }, expected: false },
  { label: 'forward link (no mirrorOf) stays editable', field: { type: 'link', property: {} }, expected: false },
  { label: 'owning side of a two-way link (mirrorFieldId, not mirrorOf) stays editable', field: { type: 'link', property: { mirrorFieldId: 'fld_mirror' } }, expected: false },
  { label: 'select field stays editable', field: { type: 'select', property: {} }, expected: false },
]

describe('B4 — server isFieldAlwaysReadOnly ⟷ FE isFieldAlwaysReadOnly parity', () => {
  it('sanity: both predicates imported live and callable (anti-fixture: a broken import path must fail LOUD)', () => {
    expect(typeof isFieldAlwaysReadOnlyServer).toBe('function')
    expect(typeof isFieldAlwaysReadOnlyFE).toBe('function')
    // Trivially exercise both so a stub/no-op import can't silently satisfy "callable".
    expect(isFieldAlwaysReadOnlyServer({ type: 'formula', property: {} })).toBe(true)
    expect(isFieldAlwaysReadOnlyFE({ type: 'formula', property: {} })).toBe(true)
  })

  for (const { label, field, expected } of CASES) {
    it(`${label} → server=${expected}, FE=${expected} (agree)`, () => {
      const serverResult = isFieldAlwaysReadOnlyServer(field)
      const feResult = isFieldAlwaysReadOnlyFE(field)
      expect(serverResult, `server predicate for "${label}"`).toBe(expected)
      expect(feResult, `FE predicate for "${label}"`).toBe(expected)
      expect(feResult, `FE/server DISAGREE for "${label}"`).toBe(serverResult)
    })
  }
})

// --- Source-scan canary: fails loud if the SERVER predicate grows a new branch this file's CASES /
// the FE mirror don't yet know about. Deliberately structural (condition anchors + a bounded `===`
// count), not a full golden-text snapshot, so it survives harmless comment/whitespace edits while still
// catching a genuine new condition.
const SERVER_PATH = resolve(__dirname, '../../src/multitable/permission-derivation.ts')

function extractFunctionBody(source: string, fnName: string): string {
  const marker = `export function ${fnName}(`
  const startIdx = source.indexOf(marker)
  if (startIdx === -1) throw new Error(`function ${fnName} not found in ${SERVER_PATH}`)
  const braceStart = source.indexOf('{', startIdx)
  if (braceStart === -1) throw new Error(`no opening brace found for ${fnName}`)
  let depth = 0
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(braceStart + 1, i)
    }
  }
  throw new Error(`unbalanced braces extracting ${fnName}`)
}

describe('B4 — canary: server predicate source shape (fails loud on an unmirrored new branch)', () => {
  it('sanity: the server source file is readable and the function body is non-trivial', () => {
    const source = readFileSync(SERVER_PATH, 'utf8')
    const body = extractFunctionBody(source, 'isFieldAlwaysReadOnly')
    expect(body.length).toBeGreaterThan(100)
  })

  it('contains exactly the known condition anchors — a removed anchor is a behavior change requiring an update here + the FE mirror', () => {
    const source = readFileSync(SERVER_PATH, 'utf8')
    const body = extractFunctionBody(source, 'isFieldAlwaysReadOnly')
    const anchors = [
      "field.type === 'formula'",
      "field.type === 'lookup'",
      "field.type === 'rollup'",
      'isSystemFieldType(field.type)',
      'property.mirrorOf',
      'property.mirrorOf.length > 0',
      'property.readonly === true',
      'property.readOnly === true',
    ]
    for (const anchor of anchors) {
      expect(body.includes(anchor), `missing expected anchor: ${anchor}`).toBe(true)
    }
  })

  it('bounded comparison count — a NEW branch (more `===` checks) must fail loud until this file + the FE mirror are updated', () => {
    const source = readFileSync(SERVER_PATH, 'utf8')
    const body = extractFunctionBody(source, 'isFieldAlwaysReadOnly')
    const equalityCount = (body.match(/===/g) ?? []).length
    // Measured at authoring time: 3 (type checks) + 1 (typeof mirrorOf guard) + 2 (readonly/readOnly) = 6.
    // If this legitimately grows, update this expectation AND add the new case to CASES above AND to
    // apps/web/src/multitable/utils/field-permissions.ts's isFieldAlwaysReadOnly.
    expect(equalityCount).toBe(6)
  })
})
