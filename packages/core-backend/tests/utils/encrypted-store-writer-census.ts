/**
 * Source scan behind tests/unit/encrypted-store-census.guard.test.ts (#6164 step 1): every place in
 * the tree that can SEAL a value for storage, so each one can be pinned to an encrypted-store catalog
 * entry of src/security/encrypted-store-probe.ts (or to a reasoned exemption).
 *
 * TypeScript compiler API, syntax only (no checker), so it reads `.ts` / `.mts` / `.cts` and the plugins'
 * `.cjs` / `.js` / `.mjs` alike and never sees comments or string contents. Two kinds of site:
 *   - a REFERENCE to a named sealing writer — a call, a value reference (`xs.map(normalizeStoredSecretValue)`),
 *     a namespace member (`es.encryptStoredSecretValue(…)`), a shorthand property; a local ALIAS of one
 *     introduced by an import / export / destructuring specifier is reported as `<name> (alias)` and its
 *     references are reported under the original name. Declaration positions (the function's own name,
 *     an object key, an import specifier) are not references.
 *   - a CALL of a generic sealing primitive — `.encrypt(…)` / `encrypt(…)` (the plugin security service,
 *     credential stores, ConfigService's SecretManager) and `createCipheriv(…)` / `createCipher(…)`
 *     (any re-implementation, like the attendance plugin's copy of the `enc:` format). An alias of one
 *     introduced by a specifier (`import { createCipheriv as mk }`, `const { encrypt: seal } = security`,
 *     `const { createCipheriv: mk } = require('node:crypto')`) is reported as `<name> (alias)` and its
 *     CALLS are reported under the original name.
 *
 * NOT modelled (known blind spots — a site written this way is invisible to the census):
 *   - a generic primitive captured as a VALUE and called later (`const mk = crypto.createCipheriv`,
 *     `const seal = security.encrypt.bind(security)`) or invoked through `.call` / `.apply` / `.bind`
 *     (`security.encrypt.call(security, v)`) — the callee name is then `call` / the local name;
 *   - a dynamic property name (`store[method](v)`; a string-literal key `store['encrypt'](v)` IS seen);
 *   - an alias created by a re-export in one file and consumed in ANOTHER file (only the alias site is
 *     reported), an alias through plain assignment (`const seal = normalizeStoredSecretValue` IS seen
 *     as a reference, but calls of `seal` are not attributed again);
 *   - code outside the scanned roots (see listCensusFiles).
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const NAMED_SEALING_WRITERS: readonly string[] = [
  'encryptStoredSecretValue',
  'normalizeStoredSecretValue',
  'encryptDingTalkDestinationValue',
  'encryptIntegrationSecretValue',
  'normalizeStoredIntegrationSecretValue',
]

export const GENERIC_SEALING_CALLS: readonly string[] = ['encrypt', 'createCipheriv', 'createCipher']

export interface SealingSite {
  file: string
  name: string
  line: number
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.cjs', '.mjs'])
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '__tests__', 'tests', 'test', 'fixtures', 'coverage'])

export function isScannableFile(name: string): boolean {
  if (/\.d\.[cm]?ts$/.test(name)) return false
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name)) return false
  return SOURCE_EXTENSIONS.has(path.extname(name))
}

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full, out)
    } else if (entry.isFile() && isScannableFile(entry.name)) {
      out.push(full)
    }
  }
}

/**
 * The scanned roots, relative to the repository root: core-backend src/ and scripts/, and for every
 * plugin its entry file (index.*) plus lib/, src/ and engine/.
 */
export function listCensusFiles(repoRoot: string): string[] {
  const files: string[] = []
  walk(path.join(repoRoot, 'packages/core-backend/src'), files)
  walk(path.join(repoRoot, 'packages/core-backend/scripts'), files)
  const pluginsDir = path.join(repoRoot, 'plugins')
  for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    const base = path.join(pluginsDir, plugin.name)
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile() && /^index\.[cm]?[jt]s$/.test(entry.name)) files.push(path.join(base, entry.name))
    }
    for (const sub of ['lib', 'src', 'engine']) walk(path.join(base, sub), files)
  }
  return files.map((f) => path.relative(repoRoot, f).split(path.sep).join('/')).sort()
}

function scriptKindOf(file: string): ts.ScriptKind {
  const ext = path.extname(file)
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS
  if (ext === '.tsx') return ts.ScriptKind.TSX
  return ts.ScriptKind.JS
}

function unwrapCallee(expression: ts.Expression): ts.Expression {
  let target: ts.Expression = expression
  while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target) || ts.isAsExpression(target)) {
    target = target.expression
  }
  return target
}

function calleeName(expression: ts.Expression): string | undefined {
  const target = unwrapCallee(expression)
  if (ts.isIdentifier(target)) return target.text
  if (ts.isPropertyAccessExpression(target)) return target.name.text
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return target.argumentExpression.text
  }
  return undefined
}

/** True when `id` NAMES something here (a declaration, a key, a specifier) rather than referring to it. */
function isDeclarationPosition(id: ts.Identifier): boolean {
  const parent = id.parent
  if (!parent) return false
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) {
    return true
  }
  if (ts.isBindingElement(parent)) return parent.name === id || parent.propertyName === id
  if (ts.isPropertyAssignment(parent)) return parent.name === id
  const named = parent as ts.Node & { name?: ts.Node }
  if (
    named.name === id &&
    (ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent))
  ) {
    return true
  }
  return false
}

/** Every sealing site of ONE source text. */
export function scanSealingSites(file: string, source: string): SealingSite[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file))
  const named = new Set(NAMED_SEALING_WRITERS)
  const generic = new Set(GENERIC_SEALING_CALLS)
  const sites: SealingSite[] = []
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  // Pass 1: local aliases (`import { x as y }`, `export { x as y }`, `const { x: y } = …`) of a named
  // writer (its references count) or of a generic primitive (its calls count).
  const aliases = new Map<string, string>()
  const genericAliases = new Map<string, string>()
  const collectAliases = (node: ts.Node): void => {
    if (
      (ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isBindingElement(node)) &&
      node.propertyName &&
      (ts.isIdentifier(node.propertyName) || ts.isStringLiteral(node.propertyName)) &&
      (named.has(node.propertyName.text) || generic.has(node.propertyName.text)) &&
      ts.isIdentifier(node.name) &&
      node.name.text !== node.propertyName.text
    ) {
      const original = node.propertyName.text
      ;(named.has(original) ? aliases : genericAliases).set(node.name.text, original)
      sites.push({ file, name: `${original} (alias)`, line: lineOf(node) })
    }
    ts.forEachChild(node, collectAliases)
  }
  collectAliases(sf)

  // Pass 2: references to named writers (or their aliases) and calls of generic primitives (or theirs).
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationPosition(node)) {
      if (named.has(node.text)) sites.push({ file, name: node.text, line: lineOf(node) })
      else if (aliases.has(node.text)) sites.push({ file, name: aliases.get(node.text) as string, line: lineOf(node) })
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression)
      if (name && generic.has(name)) sites.push({ file, name, line: lineOf(node) })
      else if (name && ts.isIdentifier(unwrapCallee(node.expression)) && genericAliases.has(name)) {
        sites.push({ file, name: genericAliases.get(name) as string, line: lineOf(node) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sites
}

/** `<file> :: <name>` -> number of sites, over the given files. */
export function countSealingSites(sites: SealingSite[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const site of sites) {
    const key = `${site.file} :: ${site.name}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}
