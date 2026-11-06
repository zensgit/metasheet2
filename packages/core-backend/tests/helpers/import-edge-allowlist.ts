/**
 * Import-edge allowlists for modules that only named files may import. An edge is one
 * `import … from` or `export … from` statement, as (importing file, module specifier); the allowlist
 * is an exact multiset of such edges, so an importer that is not named, a re-export, or a second
 * import of the same module from an allowed file is a violation, whatever directory it lives in.
 */
import ts from 'typescript'

export type ImportEdge = readonly [file: string, specifier: string]

/** Module specifiers of every `import … from` and `export … from` statement, so re-exports count as edges. */
export function importSpecifiers(source: string): string[] {
  const file = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) specifiers.push(statement.moduleSpecifier.text)
  }
  return specifiers
}

/**
 * Every difference between the edges found and the allowlist: `unexpected: <file> -> <specifier>` for
 * an edge the allowlist does not name (each allowlisted edge matches one found edge only), and
 * `missing: <file> -> <specifier>` for an allowlisted edge that was not found. Empty when the found
 * edges are exactly the allowlist.
 */
export function importEdgeViolations(found: ReadonlyArray<ImportEdge>, allowlist: ReadonlyArray<ImportEdge>): string[] {
  const remaining = allowlist.map((edge): ImportEdge => [edge[0], edge[1]])
  const violations: string[] = []
  for (const [file, specifier] of found) {
    const index = remaining.findIndex((edge) => edge[0] === file && edge[1] === specifier)
    if (index === -1) violations.push(`unexpected: ${file} -> ${specifier}`)
    else remaining.splice(index, 1)
  }
  for (const [file, specifier] of remaining) violations.push(`missing: ${file} -> ${specifier}`)
  return violations.sort()
}
