import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { SOURCE_EXTENSIONS, moduleLoads } from './import-edge-allowlist'
import { GRAPH_ROOTS } from './runtime-module-closure'

export const eventRoot = 'packages/core-backend/src/security-events/'
export const entry = eventRoot + 'directory-observations.ts'
export type Sources = ReadonlyMap<string, string>
export function sourcesAt(root: string): Sources {
  const list = (args: string[]) => execFileSync('git', ['ls-files', '-z', ...args, '--', ...GRAPH_ROOTS],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  const source = (file: string) => SOURCE_EXTENSIONS.includes(path.extname(file))
    && !/(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\./.test(file)
  const untracked = list(['--others', '--exclude-standard']).filter(source)
  if (untracked.length) throw new Error('EVENT_UNINDEXED_SOURCES: stage source paths before checking or writing registration: ' + untracked.join(', '))
  return new Map(list(['--cached']).filter(source).filter(file => existsSync(path.join(root, file)))
    .map(file => [file, readFileSync(path.join(root, file), 'utf8')]))
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const trees = new Map<string, ts.SourceFile>()
function parse(file: string, source: string): ts.SourceFile {
  let tree = trees.get(file)
  if (!tree || tree.text !== source) {
    tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    trees.set(file, tree)
  }
  return tree
}

function enclosingSymbol(node: ts.Node, tree: ts.SourceFile): string {
  let parent = node.parent
  while (parent) {
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name) return parent.name.getText(tree)
    parent = parent.parent
  }
  return '<module>'
}

function importTarget(file: string, specifier: string): string {
  if (specifier.startsWith('.')) return path.posix.join(path.posix.dirname(file), specifier)
  if (specifier.startsWith('@/')) return 'packages/core-backend/src/' + specifier.slice(2)
  const packagePrefix = '@metasheet/core-backend/'
  if (specifier.startsWith(packagePrefix)) {
    const target = path.posix.join('packages/core-backend', specifier.slice(packagePrefix.length))
    return target.replace(/^packages\/core-backend\/dist\//, 'packages/core-backend/src/')
  }
  return specifier
}

/** Register loading expressions and their enclosing symbols, independent of other file contents. */
export function eventEdges(sources: Sources) {
  const edges: string[][] = []
  for (const [file, source] of sources) {
    const tree = parse(file, source)
    const visit = (node: ts.Node) => {
      const isLoad = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier
        || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node)
        || ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || ts.isIdentifier(node.expression) && node.expression.text === 'require')
      if (isLoad) {
        const load = moduleLoads(ts.isImportTypeNode(node) ? 'type Module = ' + node.getText(tree) : node.getText(tree), file)[0]
        if (load) {
          const target = importTarget(file, load.specifier)
          if (file.startsWith(eventRoot) || target.includes('security-events') || load.specifier === '<non-literal>') {
            edges.push([file, target.replace(/\.js$/, '').replace(/\.ts$/, ''), load.kind, String(load.typeOnly),
              enclosingSymbol(node, tree), hash(node.getText(tree))])
          }
        }
      }
      if (ts.isIdentifier(node) && (['createRequire', 'eval', 'Function'].includes(node.text)
        || (node.text === 'require' && !(ts.isCallExpression(node.parent) && node.parent.expression === node)))) {
        edges.push([file, node.text, 'loader-reference', enclosingSymbol(node, tree), hash(node.parent.getText(tree))])
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return edges.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
}

/** Production consumers load only the observation entry point, including type-only loads. */
export function eventImportViolations(edges: string[][]): string[][] {
  return edges.filter(([file, target]) => !file.startsWith(eventRoot)
    && (target === eventRoot.slice(0, -1) || target.startsWith(eventRoot))
    && target !== entry.slice(0, -3))
}

/** Event-table SQL belongs only to the event implementation and schema migrations. */
export function eventSqlViolations(sources: Sources): string[] {
  const violations: string[] = []
  for (const [file, source] of sources) {
    if (file.startsWith(eventRoot) || file.startsWith('packages/core-backend/src/db/migrations/') || !/security_event(?:s|_deliveries)/.test(source)) continue
    const tree = parse(file, source)
    const visit = (node: ts.Node) => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
        && /\bsecurity_event(?:s|_deliveries)\b/i.test(node.getText(tree))) {
        violations.push(file + ':' + enclosingSymbol(node, tree))
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return violations.sort()
}

export function processStoreViolations(sources: Sources): string[] {
  const violations: string[] = []
  const counts = new Map<string, number>()
  for (const [file, source] of sources) {
    if (!/EventConnections|W1Capacity|EventRetryBuffer/.test(source)) continue
    const tree = parse(file, source)
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
        && ['EventConnections', 'W1Capacity', 'EventRetryBuffer'].includes(node.expression.text)) {
        const name = node.expression.text
        counts.set(name, (counts.get(name) ?? 0) + 1)
        if (file !== eventRoot + 'process-store.ts') violations.push(file + ':' + name)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  for (const name of ['EventConnections', 'W1Capacity', 'EventRetryBuffer']) if (counts.get(name) !== 1) violations.push(name + ':count')
  return violations.sort()
}

/** Byte registration covers the event implementation and shared connection configuration. */
export function eventClosure(sources: Sources) {
  return [...sources].filter(([file]) => file.startsWith(eventRoot) || file === 'packages/core-backend/src/integration/db/connection-config.ts').map(([file, source]) => ({ file, sha256: hash(source) })).sort((a, b) => compare(a.file, b.file))
}

const logRoots = /\/src\/(?:auth|rbac|admin|directory|security|middleware|multitable|services|gateway)\//
const auditTables = /\b(?:audit_logs|operation_audit_logs|authorization_operation_audit)\b/
export type PopulationEntry = { file: string; symbol: string; category: string; ordinal: number; sha256: string }

/** Conservative population: audit references, warning/error calls, audit SQL and writer declarations. */
export function sourcePopulation(sources: Sources): PopulationEntry[] {
  const entries: PopulationEntry[] = []
  for (const [file, source] of [...sources].sort(([a], [b]) => compare(a, b))) {
    const tree = parse(file, source)
    const auditNames = new Set(['auditLog'])
    const logNames = new Set<string>()
    const ordinals = new Map<string, number>()
    const add = (node: ts.Node, category: string) => {
      let parent: ts.Node | undefined = node.parent, symbol = '<module>'
      while (parent) {
        if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name) {
          symbol = parent.name.getText(tree); break
        }
        parent = parent.parent
      }
      const key = symbol + '/' + category
      const ordinal = (ordinals.get(key) ?? 0) + 1
      ordinals.set(key, ordinal)
      entries.push({ file, symbol, category, ordinal, sha256: hash(node.getText(tree)) })
    }
    const aliases = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === 'auditLog') auditNames.add(node.name.text)
      if (ts.isBindingElement(node) && node.propertyName?.getText(tree) === 'auditLog' && ts.isIdentifier(node.name)) auditNames.add(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isIdentifier(node.initializer) && auditNames.has(node.initializer.text)) auditNames.add(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isPropertyAccessExpression(node.initializer)
        && ['warn', 'error'].includes(node.initializer.name.text)) logNames.add(node.name.text)
      if (ts.isBindingElement(node) && ['warn', 'error'].includes(node.propertyName?.getText(tree) ?? node.name.getText(tree))
        && ts.isIdentifier(node.name)) logNames.add(node.name.text)
      ts.forEachChild(node, aliases)
    }
    aliases(tree)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression
        const method = ts.isPropertyAccessExpression(expression) ? expression.name.text
          : ts.isElementAccessExpression(expression) && expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression)
            ? expression.argumentExpression.text : ts.isIdentifier(expression) ? expression.text : ''
        if (auditNames.has(method)) add(node, 'audit-call')
        if (logRoots.test(file) && (['warn', 'error'].includes(method) || logNames.has(method))) add(node, 'warning-or-error')
        if (node.arguments.some(argument => auditTables.test(argument.getText(tree)))) add(node, 'audit-sql-or-wrapper')
      }
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
        && auditTables.test(node.getText(tree))) add(node, 'audit-sql-text')
      if (ts.isIdentifier(node) && auditNames.has(node.text) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) add(node, 'audit-reference')
      if (file.endsWith('/rbac/authorization-input-writers.ts') && ts.isObjectLiteralExpression(node)
        && node.properties.some(property => ts.isPropertyAssignment(property) && property.name.getText(tree) === 'id')) add(node, 'authorization-writer')
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  return entries
}

export function entryViolations(sources: Sources): string[] {
  const tree = parse(entry, sources.get(entry) ?? '')
  const names: string[] = [], violations: string[] = []
  for (const statement of tree.statements) {
    if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) violations.push('indirect export')
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (!ts.isFunctionDeclaration(statement) || !statement.name) { violations.push('non-function export'); continue }
    names.push(statement.name.text)
    if (statement.parameters.length !== 1 || statement.type?.getText(tree) !== 'void'
      || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) violations.push('entry contract')
  }
  if (names.sort().join(',') !== 'recordDirectoryRunObservation,recordDirectorySchedulerObservation') violations.push('export set')
  return violations
}

export type Coverage = { coverage: string; reason?: string }
export type DirectoryFixture = {
  version: number
  contracts: { file: string; callHash: string; state: string; [key: string]: unknown }[]
  edges: string[][]
  closure: { file: string; sha256: string }[]
  population: (PopulationEntry & Coverage)[]
}

/** Carry reviewed annotations only when the source expression itself is unchanged. */
export function regenerateDirectoryFixture(sources: Sources, previous: DirectoryFixture): DirectoryFixture {
  const population = sourcePopulation(sources)
  const key = (item: PopulationEntry) => JSON.stringify([item.file, item.symbol, item.category, item.sha256])
  const old = new Map<string, (PopulationEntry & Coverage)[]>()
  for (const item of previous.population) old.set(key(item), [...(old.get(key(item)) ?? []), item])
  const contracts = previous.contracts.map(contract => {
    if (!population.some(item => item.file === contract.file && item.sha256 === contract.callHash)) throw new Error('EVENT_CONTRACT_SOURCE_CHANGED')
    return contract
  })
  return { version: 2, contracts, edges: eventEdges(sources), closure: eventClosure(sources),
    population: population.map(item => {
      const annotation = old.get(key(item))?.shift()
      return { ...item, coverage: annotation?.coverage ?? 'pending_contract', ...(annotation?.reason ? { reason: annotation.reason } : {}) }
    }) }
}
