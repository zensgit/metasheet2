import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DETAIL_LEAF_FIELD_TYPES as BACKEND_DETAIL_LEAF_FIELD_TYPES } from '../../src/services/ApprovalProductService'

// CROSS-PACKAGE MIRROR PIN (approval-detail-leaf-attachment-pin-20260904).
//
// Two independent lists claim to describe the same thing — "which field types are valid leaf
// columns inside an approval `detail` group" — and until this fix they did NOT agree:
//
//   - backend: `DETAIL_LEAF_FIELD_TYPES` in ApprovalProductService.ts, DERIVED by subtracting a
//     named exclusion set from `FORM_FIELD_TYPES` (a runtime `Set`, imported directly below).
//   - frontend: `DETAIL_LEAF_FIELD_TYPES` in apps/web/src/approvals/detailField.ts, an explicit
//     8-member literal `readonly FormFieldType[]` (no shared derivation — a hand-authored array).
//
// The backend set used to include `attachment` (excluded only behind the
// APPROVAL_ATTACHMENTS_ENABLED flag, at a DIFFERENT call site than this one — see
// approval-detail-attachment-leaf-probe.test.ts); the web literal never did. This test reads the
// FRONTEND source file directly (this repo's cross-package census idiom — see
// apps/web/tests/approval-lock8-field-type-census.test.ts / packages/core-backend/tests/unit/
// approval-lock8-field-type-census.test.ts for the sibling single-package censuses) and asserts
// SET equality against the real backend export, so neither side can silently drift from the
// other again: a member added to (or removed from) EITHER side with no matching change on the
// other reds this test.
//
// Deliberately does NOT re-derive the web list as a regex/AST parse of arbitrary TS — the web
// module exports `DETAIL_LEAF_FIELD_TYPES` as a simple top-level `[...]` array literal assigned
// directly to a `const`, so a narrow, anchored regex against that exact declaration is a faithful
// read of the real array (not a re-declared parallel guess at its contents) while staying
// import-free (importing the .vue-adjacent web module tree from a backend vitest project is not
// wired up here, and would drag in Vue/Element-Plus tooling this package doesn't need).

const WEB_DETAIL_FIELD_SOURCE_PATH = join(__dirname, '../../../../apps/web/src/approvals/detailField.ts')

function readWebDetailLeafFieldTypes(): string[] {
  const source = readFileSync(WEB_DETAIL_FIELD_SOURCE_PATH, 'utf-8')
  const match = source.match(/export const DETAIL_LEAF_FIELD_TYPES: readonly FormFieldType\[\] = \[([\s\S]*?)\]/)
  if (!match) {
    throw new Error(
      `Could not locate 'export const DETAIL_LEAF_FIELD_TYPES: readonly FormFieldType[] = [...]' in ${WEB_DETAIL_FIELD_SOURCE_PATH} — the web source shape changed; update this test's anchor regex.`,
    )
  }
  // Strip whole-line `//` comments before scanning for `'…'` literals so a comment mentioning a
  // quoted word inside the array body (e.g. an explanatory aside) can never be mistaken for a
  // member — a parse bug here fails toward a spurious red (extra member), not a false green.
  const body = match[1].split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  const members = [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
  if (members.length === 0) {
    throw new Error(`Parsed zero members out of DETAIL_LEAF_FIELD_TYPES in ${WEB_DETAIL_FIELD_SOURCE_PATH} — anchor regex is likely broken, not the source.`)
  }
  return members
}

describe('cross-package leaf-set mirror: backend DETAIL_LEAF_FIELD_TYPES === web DETAIL_LEAF_FIELD_TYPES', () => {
  it('reads a non-empty web literal (sanity anchor — a broken parse must not silently pass as "equal")', () => {
    expect(readWebDetailLeafFieldTypes().length).toBeGreaterThan(0)
  })

  it('the two sets are equal (same members, either order) — a drift on either side reds this', () => {
    const webTypes = readWebDetailLeafFieldTypes()
    const webSet = new Set(webTypes)
    expect(webSet.size).toBe(webTypes.length) // the web literal itself has no duplicates
    expect([...BACKEND_DETAIL_LEAF_FIELD_TYPES].sort()).toEqual([...webSet].sort())
  })

  it('neither set admits attachment (the specific defect this fix closes)', () => {
    expect(BACKEND_DETAIL_LEAF_FIELD_TYPES.has('attachment')).toBe(false)
    expect(readWebDetailLeafFieldTypes()).not.toContain('attachment')
  })
})
