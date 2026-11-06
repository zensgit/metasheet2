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
// FIX (round 2): parse the file with the TypeScript compiler API (`typescript`, already a backend
// devDependency — see `node -e "require('typescript').version"`) and walk the AST for the
// exported `VariableStatement` whose declaration is named `DETAIL_LEAF_FIELD_TYPES` with an
// `ArrayLiteralExpression` initializer, then read each element via `ts.isStringLiteralLike`
// (covers both single- and double-quoted `StringLiteral`s AND no-substitution template literals)
// and its `.text` (the compiler's own unescaped literal value, not a regex capture group) — a
// real parse of a real declaration node, not a text-shape-dependent guess.
//
// CORRECTION (round 3, gate finding R2): the round-2 walk fixed the QUOTE-STYLE gap but not the
// SCOPING gap it set out to fix — `visit` recursed into every descendant via unconditional
// `ts.forEachChild(node, visit)` (namespace bodies, function bodies, everything) and OVERWROTE
// the captured `members` on every matching declaration found, last-write-wins. A trailing
// `export namespace X { export const DETAIL_LEAF_FIELD_TYPES = [...] }` — legal TS, and NOT the
// module's real exported binding (`import { DETAIL_LEAF_FIELD_TYPES }` resolves to the top-level
// one, not `X.DETAIL_LEAF_FIELD_TYPES`) — would silently WIN over the genuine top-level array and
// this reader would report its members as "the" web literal with no error: a parser bypass.
// FIX: only walk `sourceFile.statements` (the file's top-level statement list; no recursion at
// all — a namespace/function/class body is never visited) and require EXACTLY ONE matching
// top-level exported declaration; fail loud, not silently pick one, on zero OR more than one
// match. See `readDetailLeafFieldTypesFromSourceFile` below.
const WEB_DETAIL_FIELD_SOURCE_PATH = join(__dirname, '../../../../apps/web/src/approvals/detailField.ts')
const DETAIL_LEAF_FIELD_TYPES_NAME = 'DETAIL_LEAF_FIELD_TYPES'

function readDetailLeafFieldTypesFromSourceFile(sourceFile: ts.SourceFile, sourcePath: string): string[] {
  const matches: string[][] = []

  // Top-level ONLY: `sourceFile.statements` is the file's flat statement list. No
  // `ts.forEachChild` recursion — a declaration nested inside a namespace, function, class, or
  // block is never a candidate, by construction, regardless of its name.
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement)
      || !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      continue
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name)
        || declaration.name.text !== DETAIL_LEAF_FIELD_TYPES_NAME
      ) {
        continue
      }
      if (!declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
        // Fail-closed intentionally (kept from round 2): an `as const` / `satisfies` wrapper or
        // an identifier initializer is a real source-shape change this reader must not guess
        // through silently — it must be taught the new shape, not default to "no members".
        throw new Error(
          `${sourcePath}: top-level exported '${DETAIL_LEAF_FIELD_TYPES_NAME}' declaration's `
          + `initializer is not a plain array literal — the web source shape changed; update `
          + `this test's AST walk.`,
        )
      }
      matches.push(
        declaration.initializer.elements.map((element) => {
          if (!ts.isStringLiteralLike(element)) {
            throw new Error(
              `${sourcePath}: ${DETAIL_LEAF_FIELD_TYPES_NAME} array element `
              + `'${element.getText(sourceFile)}' is not a string literal — the web source `
              + `shape changed; update this test's AST walk.`,
            )
          }
          return element.text
        }),
      )
    }
  }

  if (matches.length === 0) {
    throw new Error(
      `Could not locate a TOP-LEVEL exported 'const ${DETAIL_LEAF_FIELD_TYPES_NAME} = [...]' `
      + `array-literal declaration in ${sourcePath} — the web source shape changed; update this `
      + `test's AST walk.`,
    )
  }
  if (matches.length > 1) {
    // Fail loud rather than silently picking the first or last one (gate finding R2) — an
    // ambiguous file is a real problem for whatever imports the name, not just for this reader.
    throw new Error(
      `Found ${matches.length} TOP-LEVEL exported '${DETAIL_LEAF_FIELD_TYPES_NAME}' declarations `
      + `in ${sourcePath} — ambiguous; this reader refuses to silently pick one (gate finding R2).`,
    )
  }
  return matches[0]
}

function readWebDetailLeafFieldTypes(): string[] {
  const source = readFileSync(WEB_DETAIL_FIELD_SOURCE_PATH, 'utf-8')
  const sourceFile = ts.createSourceFile(WEB_DETAIL_FIELD_SOURCE_PATH, source, ts.ScriptTarget.Latest, true)
  return readDetailLeafFieldTypesFromSourceFile(sourceFile, WEB_DETAIL_FIELD_SOURCE_PATH)
}

function parseThrowaway(source: string): ts.SourceFile {
  return ts.createSourceFile('throwaway.ts', source, ts.ScriptTarget.Latest, true)
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

  it('parser is quote-style agnostic: single-, double-quoted, and template-literal members are all captured', () => {
    // Positive control for the F2 fix (not the shipped source): a minimal top-level source with
    // a double-quoted AND a no-substitution template-literal member, read through the SAME shared
    // helper the real reader uses — proves the walk does not silently drop non-single-quoted
    // literals the way the old regex-based reader did.
    const sourceFile = parseThrowaway(
      `export const DETAIL_LEAF_FIELD_TYPES: readonly string[] = ['text', "attachment", \`number\`]`,
    )
    expect(readDetailLeafFieldTypesFromSourceFile(sourceFile, 'throwaway.ts')).toEqual([
      'text',
      'attachment',
      'number',
    ])
  })

  it('R2: a same-named declaration nested inside a namespace does NOT win over the real top-level one', () => {
    // Regression pin for gate finding R2: the round-2 walk recursed into every descendant and
    // last-write-wins overwrote `members`, so a trailing namespace-scoped declaration with the
    // SAME name would silently replace the genuine top-level export's members in the result —
    // even though `import { DETAIL_LEAF_FIELD_TYPES } from '...'` resolves to the top-level
    // binding, never `SomeNamespace.DETAIL_LEAF_FIELD_TYPES`. The fixed reader must ignore the
    // namespace-nested one entirely and return only the top-level array's members.
    const sourceFile = parseThrowaway(
      `export const DETAIL_LEAF_FIELD_TYPES: readonly string[] = ['text']\n`
      + `export namespace Decoy {\n`
      + `  export const DETAIL_LEAF_FIELD_TYPES: readonly string[] = ['attachment']\n`
      + `}\n`,
    )
    expect(readDetailLeafFieldTypesFromSourceFile(sourceFile, 'throwaway.ts')).toEqual(['text'])
  })

  it('R2: two top-level exported declarations with the same name is ambiguous and throws loud', () => {
    const sourceFile = parseThrowaway(
      `export const DETAIL_LEAF_FIELD_TYPES: readonly string[] = ['text']\n`
      + `export const DETAIL_LEAF_FIELD_TYPES: readonly string[] = ['number']\n`,
    )
    expect(() => readDetailLeafFieldTypesFromSourceFile(sourceFile, 'throwaway.ts')).toThrow(/ambiguous/)
  })

  it('fails loud (not silently empty) when no top-level exported declaration exists', () => {
    const sourceFile = parseThrowaway(`export const SOMETHING_ELSE: readonly string[] = ['text']`)
    expect(() => readDetailLeafFieldTypesFromSourceFile(sourceFile, 'throwaway.ts')).toThrow(
      /Could not locate a TOP-LEVEL exported/,
    )
  })
})
