import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
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
// CORRECTION (approval-detail-leaf-attachment-pin-20260904 round 2, gate F2): the prior version
// of this reader was a hand-anchored regex over the array body
// (`export const DETAIL_LEAF_FIELD_TYPES: readonly FormFieldType[] = [([\s\S]*?)]`) that then
// scanned ONLY for single-quoted `'…'` literals inside the captured body. Two independent gaps:
// (a) it is text-shape dependent — a member written with double quotes (`"attachment"`, valid TS,
// unchanged runtime behavior) would silently NOT be captured, so a mutation that adds such a
// member would go undetected by this test even though the web array genuinely changed; (b) the
// declaration match itself was a plain `source.match(...)` with no `^`-anchoring or scoping to a
// single top-level statement, so it would silently match the FIRST textual occurrence of that
// exact substring anywhere in the file (including inside a comment, had one ever been written to
// contain it) rather than a specific parsed declaration node.
//
// FIX: parse the file with the TypeScript compiler API (`typescript`, already a backend
// devDependency — see `node -e "require('typescript').version"`) and walk the AST for the
// exported `VariableStatement` whose declaration is named `DETAIL_LEAF_FIELD_TYPES` with an
// `ArrayLiteralExpression` initializer, then read each element via `ts.isStringLiteralLike`
// (covers both single- and double-quoted `StringLiteral`s AND no-substitution template literals)
// and its `.text` (the compiler's own unescaped literal value, not a regex capture group) — a
// real parse of a real declaration node, not a text-shape-dependent guess.
const WEB_DETAIL_FIELD_SOURCE_PATH = join(__dirname, '../../../../apps/web/src/approvals/detailField.ts')
const DETAIL_LEAF_FIELD_TYPES_NAME = 'DETAIL_LEAF_FIELD_TYPES'

function readWebDetailLeafFieldTypes(): string[] {
  const source = readFileSync(WEB_DETAIL_FIELD_SOURCE_PATH, 'utf-8')
  const sourceFile = ts.createSourceFile(WEB_DETAIL_FIELD_SOURCE_PATH, source, ts.ScriptTarget.Latest, true)

  let members: string[] | undefined

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableStatement(node)
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name)
          && declaration.name.text === DETAIL_LEAF_FIELD_TYPES_NAME
          && declaration.initializer
          && ts.isArrayLiteralExpression(declaration.initializer)
        ) {
          members = declaration.initializer.elements.map((element) => {
            if (!ts.isStringLiteralLike(element)) {
              throw new Error(
                `${WEB_DETAIL_FIELD_SOURCE_PATH}: ${DETAIL_LEAF_FIELD_TYPES_NAME} array element `
                + `'${element.getText(sourceFile)}' is not a string literal — the web source `
                + `shape changed; update this test's AST walk.`,
              )
            }
            return element.text
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  if (!members) {
    throw new Error(
      `Could not locate an exported 'const ${DETAIL_LEAF_FIELD_TYPES_NAME} = [...]' array-literal `
      + `declaration in ${WEB_DETAIL_FIELD_SOURCE_PATH} — the web source shape changed; update `
      + `this test's AST walk.`,
    )
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

  it('parser is quote-style agnostic: a double-quoted literal in a throwaway array is still captured', () => {
    // Positive control for the F2 fix itself (not the shipped source): a minimal source string
    // with a double-quoted member, parsed the same way, proves the AST walk does not silently
    // drop non-single-quoted literals the way the old regex-based reader did.
    const sourceFile = ts.createSourceFile(
      'throwaway.ts',
      `export const DETAIL_LEAF_FIELD_TYPES: readonly string[] = ['text', "attachment"]`,
      ts.ScriptTarget.Latest,
      true,
    )
    const found: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name)
            && declaration.name.text === DETAIL_LEAF_FIELD_TYPES_NAME
            && declaration.initializer
            && ts.isArrayLiteralExpression(declaration.initializer)
          ) {
            for (const element of declaration.initializer.elements) {
              if (ts.isStringLiteralLike(element)) found.push(element.text)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    expect(found).toEqual(['text', 'attachment'])
  })
})
