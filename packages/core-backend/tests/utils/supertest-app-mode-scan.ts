/**
 * AST scanner for supertest "app-mode" call sites (#4154 slice — anti-regression tripwire input).
 *
 * An app-mode site is `request(<expr>)` where the default import of 'supertest' is called with
 * anything other than a URL string: passing an app makes supertest bind a fresh `listen(0)`
 * ephemeral-port listener for that request, which is the cross-talk mechanism being eradicated.
 *
 * SAFE (not counted): `request('http://…')` string/template literals, and `request(x.url())`
 * (the pinned-server transport — `usePinnedServer().url()` returns a base URL, which supertest
 * never listens on).
 *
 * This is a syntax-level (ts.createSourceFile) walk — no type checking — so it is fast enough to
 * run inside a unit test over the whole tests/unit tree.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export interface AppModeScanResult {
  /** repo-relative-ish file name (relative to the scanned root) → app-mode call count */
  counts: Record<string, number>
  totalSites: number
}

function supertestDefaultImportName(source: ts.SourceFile): string | null {
  for (const stmt of source.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text === 'supertest' &&
      stmt.importClause?.name
    ) {
      return stmt.importClause.name.text
    }
  }
  return null
}

function isSafeTransportArg(arg: ts.Expression): boolean {
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg)) {
    return true
  }
  // pinned.url() — any zero-ish-arg call of a property named `url`
  if (
    ts.isCallExpression(arg) &&
    ts.isPropertyAccessExpression(arg.expression) &&
    arg.expression.name.text === 'url'
  ) {
    return true
  }
  return false
}

export function countAppModeSites(fileName: string, content: string): number {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.ES2022, true)
  const requestName = supertestDefaultImportName(source)
  if (!requestName) return 0

  let count = 0
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === requestName &&
      node.arguments.length >= 1 &&
      !isSafeTransportArg(node.arguments[0])
    ) {
      count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

// Recursive by design (owner P2): a top-level-only readdir would let a future test placed in a
// subdirectory bypass the zero-tolerance ban. Keys are root-relative POSIX paths.
export function scanAppModeSites(rootDir: string): AppModeScanResult {
  const counts: Record<string, number> = {}
  let totalSites = 0
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && (entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts'))) files.push(full)
    }
  }
  walk(rootDir)
  files.sort()
  for (const filePath of files) {
    const rel = path.relative(rootDir, filePath).split(path.sep).join('/')
    const fileCount = countAppModeSites(rel, fs.readFileSync(filePath, 'utf8'))
    if (fileCount > 0) {
      counts[rel] = fileCount
      totalSites += fileCount
    }
  }
  return { counts, totalSites }
}
