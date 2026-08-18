/**
 * W7-1b (#4556) — B3: the CONTEXT-SHAPE derive-and-diff completeness gate.
 *
 * Authority: #4556 comments 5293034619 + 5293478713.
 *
 * The frozen-context SHAPE is a second widening surface, independent of
 * W7-1a-M's provenance-value domain, and it is the one the predecessor design
 * saw only one site of. This suite is its "漏一点即红" instrument: reuse of
 * W7-1a-M's METHOD, retargeted — not reuse of its file.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  W7_CONTEXT_SHAPE_LEDGER_V1,
  deriveContextShapeSurfaceV1,
  diffContextShapeV1,
  enclosingUnitV1,
  resolveRepoRootV1,
  scanRootsV1,
} from '../utils/w7-context-shape-scan'

const repoRoot = resolveRepoRootV1(__dirname)
const derivation = deriveContextShapeSurfaceV1({ repoRoot })

describe('W7-1b context-shape widening — derive-and-diff completeness', () => {
  it('every derived shape gate is ledgered, and every ledger entry is still derived', () => {
    const violations = diffContextShapeV1(derivation, W7_CONTEXT_SHAPE_LEDGER_V1)
    expect(violations.map((v) => `${v.kind}: ${v.detail}`)).toEqual([])
  })

  it('non-vacuity: the walk really covered the tree and found both families', () => {
    // A derive-and-diff over an empty derivation passes vacuously, which is the
    // failure mode this floor exists to block.
    expect(derivation.filesWalked).toBeGreaterThan(200)
    expect(derivation.sites.length).toBeGreaterThanOrEqual(W7_CONTEXT_SHAPE_LEDGER_V1.length)
    const families = new Set(derivation.sites.map((s) => s.family))
    // BOTH families must be non-empty — the `hand_parser` one is the most
    // missable, and it is the entire reason this is a derivation.
    expect(families.has('validator_call'), 'validator-calling family empty').toBe(true)
    expect(families.has('hand_parser'), 'hand-parser family empty — X7 would be invisible').toBe(true)
  })

  it('non-vacuity: the scan roots reach OUTSIDE packages/core-backend/src', () => {
    // X7 lives in core-backend, but the `apps/web` duplicate family that W7-1a-M
    // found proves the roots must not be narrowed to one package.
    const files = scanRootsV1(repoRoot)
    expect(files.some((f) => f.startsWith('plugins/')), 'plugins/ not walked').toBe(true)
    expect(files.some((f) => f.startsWith('packages/core-backend/src/')), 'core-backend not walked').toBe(true)
  })

  it('every MUST_WIDEN ledger entry really derives as WIDENED at this head', () => {
    const bySite = new Map(derivation.sites.map((s) => [`${s.file}::${s.text}`, s]))
    for (const entry of W7_CONTEXT_SHAPE_LEDGER_V1) {
      if (entry.verdict !== 'MUST_WIDEN') continue
      const site = bySite.get(`${entry.file}::${entry.text}`)
      expect(site, `MUST_WIDEN entry not derived: ${entry.file} — ${entry.text}`).toBeDefined()
      expect(site!.widened, `ledgered MUST_WIDEN but not widened: ${entry.text}`).toBe(true)
    }
  })

  it('every ledger entry carries a non-trivial note', () => {
    for (const entry of W7_CONTEXT_SHAPE_LEDGER_V1) {
      expect(String(entry.note ?? '').length, `no reason recorded for ${entry.text}`).toBeGreaterThan(20)
    }
  })

  it('the enclosing-unit expansion is STRUCTURAL, not a fixed window', () => {
    // A fixed ±N window both under-reads a far arm and over-reads a neighbour's
    // members; this asserts the expansion walks to declaration boundaries.
    const lines = [
      'export function alpha() {',
      '  const a = 1',
      '  return a',
      '}',
      'export function beta() {',
      '  if (schemaVersion !== 1) return false',
      '  return true',
      '}',
    ]
    const unit = enclosingUnitV1(lines, 5)
    expect(unit).toContain('export function beta()')
    expect(unit, 'the expansion leaked into the PREVIOUS declaration').not.toContain('export function alpha()')
  })

  // -------------------------------------------------------------------------
  // The three RED conditions, each demonstrated individually.
  // -------------------------------------------------------------------------

  function scanPlanted(fileName: string, source: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-1b-shape-'))
    try {
      fs.mkdirSync(path.join(dir, 'planted'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'planted', fileName), source, 'utf8')
      return deriveContextShapeSurfaceV1({ repoRoot: dir, files: [`planted/${fileName}`] })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('RED (a): a NEW un-ledgered shape gate reds the diff', () => {
    const planted = scanPlanted(
      'new-gate.ts',
      ['export function gate(ctx: unknown) {', '  if (!validateFrozenContextShape(ctx)) return false', '  return true', '}', ''].join('\n'),
    )
    expect(planted.sites.length).toBeGreaterThan(0)
    const violations = diffContextShapeV1(planted, W7_CONTEXT_SHAPE_LEDGER_V1)
    expect(violations.some((v) => v.kind === 'unledgered_site')).toBe(true)
  })

  it('RED (b): a ledger entry whose construct no longer exists reds the diff', () => {
    const violations = diffContextShapeV1(derivation, [
      ...W7_CONTEXT_SHAPE_LEDGER_V1,
      {
        file: 'packages/core-backend/src/attendance/w4c1-segment-calculator.ts',
        text: 'if (!someGateThatWasDeleted(input.context)) {',
        family: 'validator_call', verdict: 'MUST_WIDEN', note: 'a construct that no longer exists in the tree',
      },
    ])
    expect(violations.some((v) => v.kind === 'stale_ledger_entry')).toBe(true)
  })

  it('RED (c): CLASS/VERDICT DRIFT reds even when the id set is IDENTICAL', () => {
    // The condition that (a) and (b) alone cannot catch: same file, same text,
    // same id — but reclassified. A gate rewritten from one form into another
    // would otherwise slip through with the id set unchanged.
    const drifted = W7_CONTEXT_SHAPE_LEDGER_V1.map((e) =>
      e.text.includes('input.context')
        ? { ...e, family: 'hand_parser' as const }
        : e,
    )
    const violations = diffContextShapeV1(derivation, drifted)
    expect(violations.some((v) => v.kind === 'verdict_drift')).toBe(true)
    // ...and the id set really was identical, so (a)/(b) could not have caught it.
    expect(violations.some((v) => v.kind === 'unledgered_site')).toBe(false)
    expect(violations.some((v) => v.kind === 'stale_ledger_entry')).toBe(false)
  })

  it('NEGATIVE CONTROL on the derivation: a v1-ONLY gate is NOT reported as widened', () => {
    // If `widened` were computed loosely, every MUST_WIDEN assertion above would
    // pass for the wrong reason.
    const planted = scanPlanted(
      'v1-only.ts',
      ['export function gate(ctx: unknown) {', '  if (!validateFrozenContextShape(ctx)) return false', '  return true', '}', ''].join('\n'),
    )
    const site = planted.sites.find((s) => s.text.includes('validateFrozenContextShape('))
    expect(site).toBeDefined()
    expect(site!.widened, 'a v1-only gate must not derive as widened').toBe(false)
  })
})
