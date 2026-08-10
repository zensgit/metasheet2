import * as ts from 'typescript'

/**
 * Small, source-text ordering primitives for pinning WHERE in `index.ts`'s
 * real Express app assembly a route sits relative to the middleware it must
 * run behind. Deliberately narrow: this module answers "does marker A occur
 * exactly once, before marker B, inside the same enclosing method" — nothing
 * about behaviour, nothing sweeping the file's DML surface (that is
 * `attendance-w6-call-path-closure.ts`'s job, over a different domain).
 */

export interface AssemblyMarker {
  readonly label: string
  /** An exact, unique source-text needle. Callers are expected to verify
   *  uniqueness themselves via `locateMarkers`'s `occurrences` field. */
  readonly needle: string
}

export interface MarkerLocation {
  readonly label: string
  /** Index of the FIRST occurrence, or -1 if the needle is absent. */
  readonly index: number
  /** Total non-overlapping occurrences. */
  readonly occurrences: number
}

/** Every non-overlapping occurrence of `needle` in `text`. */
function occurrencesOf(text: string, needle: string): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const idx = text.indexOf(needle, from)
    if (idx === -1) break
    out.push(idx)
    from = idx + needle.length
  }
  return out
}

export function locateMarkers(text: string, markers: readonly AssemblyMarker[]): MarkerLocation[] {
  return markers.map((marker) => {
    const occurrences = occurrencesOf(text, marker.needle)
    return { label: marker.label, index: occurrences[0] ?? -1, occurrences: occurrences.length }
  })
}

/**
 * NAMED declaration boundaries only — constructor, class method, or
 * top-level named function. Anonymous callback literals (arrow functions,
 * function expressions passed as `app.use(...)` arguments) are deliberately
 * NOT boundaries here: a marker one line inside an inline middleware
 * callback and a marker that is itself a bare `this.app.use(x())` call are
 * both, in the sense this module cares about, registered "from" the same
 * enclosing method — the callback is not a second registration site.
 */
function isNamedFunctionBoundary(node: ts.Node): boolean {
  return (
    ts.isConstructorDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    (ts.isFunctionDeclaration(node) && node.name !== undefined)
  )
}

/**
 * The INNERMOST named constructor/method/function whose span contains `pos`,
 * or `null` if `pos` is not inside one. Climbs PAST anonymous arrow/function
 * expressions on the way down (see `isNamedFunctionBoundary`), so a marker
 * nested inside an inline callback still resolves to the enclosing method
 * that registers it. Used to prove "these markers are registered from the
 * SAME assembly method", not merely "somewhere in the same file" — a marker
 * relocated into a genuinely DIFFERENT named method (invoked at a different
 * time, or not at all on some path) would still be caught.
 */
export function enclosingFunctionLikeAt(source: ts.SourceFile, pos: number): ts.Node | null {
  let found: ts.Node | null = null
  const walk = (node: ts.Node): void => {
    if (pos < node.getFullStart() || pos > node.getEnd()) return
    if (isNamedFunctionBoundary(node)) found = node
    node.forEachChild(walk)
  }
  source.forEachChild(walk)
  return found
}

/** A short, human-readable label for a function-like node found by
 *  `enclosingFunctionLikeAt`: its method/constructor name, or `<anonymous>`. */
export function functionLikeLabel(node: ts.Node): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  return '<anonymous>'
}
