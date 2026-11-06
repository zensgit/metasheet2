/**
 * Import-edge allowlists for modules that only named files may import. An edge is one module load,
 * as (importing file, module specifier): an `import … from` or `export … from` statement, an
 * `import x = require(…)`, a `require(…)` call, a dynamic `import(…)` or an `import(…)` type, with the
 * specifier written as a string literal or a template literal without substitutions. A load whose
 * specifier is computed is an edge to NON_LITERAL_SPECIFIER, so it cannot hide a module name. The
 * allowlist is an exact multiset of edges, so an importer that is not named, a re-export, or a second
 * import of the same module from an allowed file is a violation, whatever directory it lives in.
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export type ImportEdge = readonly [file: string, specifier: string]

/** The specifier recorded for a `require(…)` or `import(…)` whose argument is not a literal. */
export const NON_LITERAL_SPECIFIER = '<non-literal>'

/** Every TypeScript and JavaScript source extension; files with any other extension are not parsed. */
export const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function literalText(node: ts.Node | undefined): string | null {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text
  return null
}

/**
 * Module specifiers of every module load in `source`, in source order, anywhere in the file: static
 * imports and re-exports, `import x = require(…)`, `require(…)`, dynamic `import(…)` and `import(…)`
 * types. `fileName` selects how the text is parsed (TypeScript or JavaScript) by its extension.
 */
export function importSpecifiers(source: string, fileName = 'm.ts'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      specifiers.push(literalText(node.moduleSpecifier) ?? NON_LITERAL_SPECIFIER)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifiers.push(literalText(node.moduleReference.expression) ?? NON_LITERAL_SPECIFIER)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
      if (isRequire || isDynamicImport) specifiers.push(literalText(node.arguments[0]) ?? NON_LITERAL_SPECIFIER)
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined
      specifiers.push(literalText(argument) ?? NON_LITERAL_SPECIFIER)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

/** Every file below `dir`, whatever its extension. */
export function listAllFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? listAllFiles(full) : [full]
  })
}

/** Every TypeScript or JavaScript source file below `dir`. */
export function listSourceFiles(dir: string): string[] {
  return listAllFiles(dir).filter((file) => SOURCE_EXTENSIONS.includes(path.extname(file)))
}

/**
 * The edges of every file below `root` whose text mentions a module matched by `pattern`: each load
 * whose specifier matches `pattern`, and each load with a computed specifier. A file that mentions the
 * module but is not a TypeScript or JavaScript source is an edge to its own extension, so no file
 * under `root` can name the module unseen. Files are relative to `root`.
 */
export function collectImportEdges(root: string, pattern: RegExp, read: (file: string) => string): ImportEdge[] {
  const edges: ImportEdge[] = []
  for (const file of listAllFiles(root)) {
    const source = read(file)
    if (!pattern.test(source)) continue
    const relative = path.relative(root, file)
    if (!SOURCE_EXTENSIONS.includes(path.extname(file))) {
      edges.push([relative, `<unparsed ${path.extname(file) || 'file'}>`])
      continue
    }
    for (const specifier of importSpecifiers(source, file)) {
      if (specifier === NON_LITERAL_SPECIFIER || pattern.test(specifier)) edges.push([relative, specifier])
    }
  }
  return edges
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
