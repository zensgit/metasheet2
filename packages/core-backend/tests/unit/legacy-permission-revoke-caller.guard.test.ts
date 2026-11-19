import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { listFiles, SOURCE_EXTENSIONS } from '../helpers/authorization-input-scan'

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SRC = 'packages/core-backend/src'
const WRITER_FILE = `${SRC}/admin/legacy-permission-revoke.ts`
const CALLER_FILE = `${SRC}/admin/authorization-exception-write.ts`
const READERS = [`${SRC}/admin/authorization-operation-snapshot.ts`, `${SRC}/admin/authorization-operation-service.ts`]
const WRITER_NAME = 'revokeLockedLegacyUserPermission'
const PURE_HELPER = 'removeMatchingLegacyPermission'
const MODULE_STEM = 'legacy-permission-revoke'
const MODULE_NAME = './legacy-permission-revoke'

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isSatisfiesExpression(expression)) expression = expression.expression
  return expression
}

function constantText(expression: ts.Expression): string | undefined {
  const value = unwrap(expression)
  if (ts.isStringLiteralLike(value)) return value.text
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantText(value.left)
    const right = constantText(value.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  if (ts.isTemplateExpression(value)) {
    let result = value.head.text
    for (const span of value.templateSpans) {
      const text = constantText(span.expression)
      if (text === undefined) return undefined
      result += text + span.literal.text
    }
    return result
  }
  return undefined
}

function isRegisteredWriterMetadata(file: string, node: ts.Node): boolean {
  if (file !== `${SRC}/rbac/authorization-input-writers.ts`) return false
  let expression = node
  while (ts.isTemplateSpan(expression.parent) || ts.isTemplateExpression(expression.parent)) expression = expression.parent
  if (!ts.isTemplateExpression(expression) || expression.head.text !== '' || expression.templateSpans.length !== 1) return false
  const span = expression.templateSpans[0]
  if (!ts.isIdentifier(span.expression) || span.expression.text !== 'SRC' || span.literal.text !== `/admin/${MODULE_STEM}.ts`) return false
  const property = expression.parent
  if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'file'
    || property.initializer !== expression || !ts.isObjectLiteralExpression(property.parent)) return false
  return property.parent.properties.some(candidate => ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name)
    && candidate.name.text === 'id' && ts.isStringLiteral(candidate.initializer) && candidate.initializer.text === 'W-26')
}

function callerProblems(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const problems: string[] = []
  let imports = 0
  let writes = 0
  let declarations = 0
  const literalTargetsModule = (value: string) => value.includes(MODULE_STEM)
  const visit = (node: ts.Node) => {
    if ((ts.isBinaryExpression(node) || ts.isTemplateExpression(node)) && !isRegisteredWriterMetadata(file,node)
      && literalTargetsModule(constantText(node) ?? '')) problems.push('computed module')
    if (ts.isElementAccessExpression(node) && node.argumentExpression && constantText(node.argumentExpression) === WRITER_NAME) problems.push('computed writer')
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && (literalTargetsModule(node.text) || (ts.isTemplateHead(node) && node.text.includes('legacy-permission-'))) && !isRegisteredWriterMetadata(file,node)) {
      const parent = node.parent
      if (!ts.isImportDeclaration(parent) || parent.moduleSpecifier !== node || node.text !== MODULE_NAME) problems.push('indirect module reference')
      else {
        imports++
        const clause = parent.importClause
        const bindings = clause?.namedBindings
        const symbol = READERS.includes(file) ? PURE_HELPER : file === CALLER_FILE ? WRITER_NAME : null
        if (!symbol || !clause || clause.isTypeOnly || clause.name || !bindings || !ts.isNamedImports(bindings)
          || bindings.elements.length !== 1 || bindings.elements[0].propertyName || bindings.elements[0].isTypeOnly
          || bindings.elements[0].name.text !== symbol) problems.push('unauthorized import')
      }
    }
    if (ts.isIdentifier(node) && node.text === WRITER_NAME) {
      const p = node.parent
      if (ts.isImportSpecifier(p)) return
      if (ts.isFunctionDeclaration(p) && p.name === node) {
        declarations++
        if (file !== WRITER_FILE || p.parent !== tree || !p.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) problems.push('writer declaration')
      } else if (ts.isCallExpression(p) && p.expression === node) {
        writes++
        let owner: ts.Node | undefined = p.parent
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
        const first = p.arguments[0]
        const second = p.arguments[1]
        if (file !== CALLER_FILE || !owner || !ts.isFunctionDeclaration(owner) || owner.name?.text !== 'writeAuthorizationException'
          || owner.parent !== tree || owner.parameters[0]?.name.getText(tree) !== 'tx'
          || p.arguments.length !== 2 || !first || !ts.isIdentifier(first) || first.text !== 'tx' || !second
          || !ts.isCallExpression(second) || second.expression.getText(tree) !== 'Object.freeze'
          || second.arguments.length !== 1 || !ts.isObjectLiteralExpression(second.arguments[0])) problems.push('writer caller or token')
        else {
          const fields = second.arguments[0].properties
          const keys = fields.map(field => field.name?.getText(tree)).sort()
          if (keys.join(',') !== 'actorId,expected,permission,plan,userId'
            || fields.some(field => !(ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field)))
            || !fields.some(f => ts.isPropertyAssignment(f) && f.name.getText(tree) === 'plan' && f.initializer.getText(tree) === 'input.plan')) problems.push('writer data')
        }
      } else problems.push('detached writer')
    }
    ts.forEachChild(node,visit)
  }
  visit(tree)
  if (imports !== (file === CALLER_FILE || READERS.includes(file) ? 1 : 0)) problems.push('import count')
  if (writes !== (file === CALLER_FILE ? 1 : 0)) problems.push('call count')
  if (declarations !== (file === WRITER_FILE ? 1 : 0)) problems.push('declaration count')
  return problems
}

const repoSource = (file: string) => fs.readFileSync(path.join(REPO_ROOT,file),'utf8')
describe('legacy permission revoke caller and root ownership', () => {
  it('allows exactly one tx-bound writer and the two pure readers across backend and plugins', () => {
    const files=listFiles(REPO_ROOT,{roots:[SRC,'plugins'],exclude:[`${SRC}/db/migrations`]})
      .filter(f=>SOURCE_EXTENSIONS.has(path.extname(f)))
    for (const f of [CALLER_FILE,WRITER_FILE,...READERS]) expect(files).toContain(f)
    const problems=files.flatMap(file => {
      const content=repoSource(file)
      return callerProblems(file,content).map(p=>file+' '+p)
    })
    expect(problems).toEqual([])
  })
  const importer = repoSource(CALLER_FILE)
  const writer = repoSource(WRITER_FILE)
  it('requires the same tx and frozen data from the shared writer', () => {
    expect(callerProblems(CALLER_FILE,importer)).toEqual([])
    for (const [a,b] of [
      ['revokeLockedLegacyUserPermission(tx,','revokeLockedLegacyUserPermission(other,'],
      ['plan: input.plan, permission:', 'plan: other, permission:'],
      ['Object.freeze({ actorId, userId, plan:', 'Object.freeze({ callback, actorId, userId, plan:'],
      ['Object.freeze({ actorId, userId, plan:', '({ actorId, userId, plan:'],
      ['export async function writeAuthorizationException(', 'export async function alternate('],
      ['revokeLockedLegacyUserPermission(tx,','(()=>revokeLockedLegacyUserPermission(tx,'],
    ]) {
      expect(importer).toContain(a)
      expect(callerProblems(CALLER_FILE,importer.replace(a,b))).not.toEqual([])
    }
  })
  it('rejects additional writers, aliases, raw callbacks, exports and module loaders', () => {
    expect(callerProblems(WRITER_FILE,writer)).toEqual([])
    expect(callerProblems(WRITER_FILE,writer.replace('export async function '+WRITER_NAME,'async function '+WRITER_NAME))).not.toEqual([])
    for (const src of [
      `import { ${WRITER_NAME} } from '${MODULE_NAME}'`, `export * from '${MODULE_NAME}'`,
      `import { ${WRITER_NAME} as alternate } from '${MODULE_NAME}'`, `export { ${WRITER_NAME} } from '${MODULE_NAME}'`,
      `await import('${MODULE_NAME}')`, `require('./legacy-permission-'+'revoke')`,
      "const path='./legacy-permission-'+'revoke'; await import(path)", 'api["revokeLocked"+"LegacyUserPermission"](tx,data)',
      `const alternate=${WRITER_NAME}`, `function f(tx) { return ${WRITER_NAME}(tx,data) }`,
      "const p=`./legacy-permission-${suffix}`", "const p=`foo${x}legacy-permission-revoke`",
    ]) {
      expect(callerProblems('foreign.ts',src),src).not.toEqual([])
    }
    expect(callerProblems(CALLER_FILE,importer+'\n'+importer)).not.toEqual([])
  })
  it('keeps receipt lookup and effect previews restricted to the pure array helper', () => {
    for (const file of READERS) {
      const content=repoSource(file)
      expect(callerProblems(file,content)).toEqual([])
      expect(callerProblems(file,content.replace(PURE_HELPER,WRITER_NAME))).not.toEqual([])
    }
  })
})
