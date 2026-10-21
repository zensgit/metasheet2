/**
 * P3-1 CSV export row cap (contract §5) — fix round P3-E, gate-2 finding.
 *
 * Gate 2 found every assertion on `APPROVAL_EXPORT_ROW_CAP` lived only in
 * `tests/integration/approval-export-csv.db.test.ts`, which runs in the `approval-realdb-
 * export-csv` GitHub Actions lane — confirmed (via `gh api repos/zensgit/metasheet2/branches/
 * main/protection`) to be ADVISORY, not a required check on `main`. That meant reverting the cap
 * from 500 back to 5000 would keep every REQUIRED check green: nothing gated would notice.
 *
 * This file lives in `tests/unit/`, which the DEFAULT `vitest.config.ts` collects — the config
 * required check `test (20.x)` (`plugin-tests.yml`'s `Run core-backend tests` step) actually runs.
 * It imports `resolveApprovalExportLimit` directly from `src/routes/approvals.ts` — the SAME
 * function the `?format=csv` branch of `GET /api/approvals` calls to compute its effective limit
 * (not a re-derivation of the clamping logic) — so this test exercises production code, and a
 * regression in either the cap's VALUE or its CLAMPING behavior now fails a required check.
 *
 * Positive control: `it('the cap is exactly 500', …)` pins the literal value by hand (not derived
 * from anything else), so a mutation that changes `APPROVAL_EXPORT_ROW_CAP` away from 500 reds
 * this assertion directly — proven by mutation in the accompanying report (mutate 500 -> 5000 in
 * `src/routes/approvals.ts`, run this file, confirm red, restore, `cmp` byte-identical).
 */
import { describe, expect, it } from 'vitest'
import { APPROVAL_EXPORT_ROW_CAP, resolveApprovalExportLimit } from '../../src/routes/approvals'

describe('APPROVAL_EXPORT_ROW_CAP', () => {
  it('the cap is exactly 500 — a silent change here must fail this test directly', () => {
    // Hand-typed literal, NOT derived from the constant under test.
    expect(APPROVAL_EXPORT_ROW_CAP).toBe(500)
  })
})

describe('resolveApprovalExportLimit — the CSV route\'s own effective-limit computation', () => {
  it('an absent ?limit= falls back to the full cap (an export with no ?limit= returns up to the cap)', () => {
    expect(resolveApprovalExportLimit(undefined)).toBe(APPROVAL_EXPORT_ROW_CAP)
    expect(resolveApprovalExportLimit(undefined)).toBe(500)
  })

  it('an invalid or negative ?limit= falls back to the full cap (parsePaging fallback semantics)', () => {
    expect(resolveApprovalExportLimit('abc')).toBe(500)
    expect(resolveApprovalExportLimit('-5')).toBe(500)
    expect(resolveApprovalExportLimit('')).toBe(500)
  })

  it('a ?limit= above the cap is clamped DOWN to the cap — it can never be raised past it', () => {
    expect(resolveApprovalExportLimit('999999999')).toBe(500)
    expect(resolveApprovalExportLimit('501')).toBe(500)
  })

  it('a ?limit= at or below the cap is honored verbatim — the cap does not silently override a smaller ask', () => {
    expect(resolveApprovalExportLimit('1')).toBe(1)
    expect(resolveApprovalExportLimit('500')).toBe(500)
  })

  it('?limit=0 is honored as an honest zero, not treated as "absent" (matches capped=true semantics)', () => {
    // `parsePaging` treats 0 as a valid, finite, non-negative value distinct from "absent/invalid"
    // (which fall back to the cap) — this is what lets the route report `capped=true` honestly for
    // a genuine `?limit=0` rather than silently substituting the full cap.
    expect(resolveApprovalExportLimit('0')).toBe(0)
  })

  // NIT-3 fix (gate-3 finding): renamed from "DISCRIMINATING: fallback/clamp is NOT a hard-coded
  // 500 independent of the cap constant". Gate 3 mutated `APPROVAL_EXPORT_ROW_CAP` (500 -> 5000)
  // and ran this file: this assertion stayed GREEN (it re-reads the mutated constant and compares
  // against itself), so despite its old name it discriminates NOTHING about a cap-VALUE change —
  // that is caught only by the literal `the cap is exactly 500` test above. What this assertion
  // DOES catch, and the ONLY thing it catches: `resolveApprovalExportLimit` clamping against a
  // hard-coded literal (e.g. a future rewrite as `Math.min(parsed, 500)`) instead of the live
  // `APPROVAL_EXPORT_ROW_CAP` export — because it uses the CONSTANT, not a literal, as the expected
  // value, both sides move together under a cap-value change and a hard-coded rewrite is the only
  // thing that can desync them. Its own prior name overstated what it discriminates; this name does
  // not.
  it('WIRING (not a cap-VALUE discriminator — see the literal test above for that): the clamp reads the live APPROVAL_EXPORT_ROW_CAP export, not an independent hard-coded literal', () => {
    expect(resolveApprovalExportLimit('999999999')).toBe(APPROVAL_EXPORT_ROW_CAP)
  })
})
