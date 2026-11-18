import * as ts from 'typescript'

/**
 * Gate E (#4844): classify literal BEGINs on caller ports, private lease helpers
 * and exact exclusive callbacks. The independent census below walks ALL scopes,
 * with no signature/export/wrapper filter: removing those shapes cannot hide SQL.
 *
 * OWNS requires an awaited unconditional same-binding idle assertion. New lease
 * helpers additionally have only direct exclusive-callback callers; a lease type
 * or function name alone proves nothing. Wrapper/idle imports are exact and may
 * not be shadowed. This is a syntactic guard, not a TypeChecker or driver proof.
 * Receiver/type aliases, aliased proof/wrapper names, arbitrary closures and
 * computed receivers remain unclassified; literal .query BEGINs still fail the
 * independent census comparison. Dynamic SQL, extracted/renamed query functions
 * and dynamic property names are outside this literal-query domain (explicitly
 * tested). Protocol I/T/E and lease privacy need separate runtime gates.
 */

const CONNECTION_TYPE_NAMES = new Set([
  'AttendanceW4TransactionClientV1',
  'AttendanceSessionLeaseV1',
  'AttendanceOwningSessionV1',
])
const IDLE_PROOF_CALLEE_NAME = 'assertConnectionIsIdleV1'
const EXCLUSIVE_CALLEE_NAME = 'withAttendanceExclusiveIdleSessionV1'
const BEGIN_STATEMENT_PATTERN = /^\s*(BEGIN\b|START\s+TRANSACTION\b)/i

export type TxnOwnershipBucket = 'OWNS' | 'JOINS' | 'NESTED' | 'UNKNOWN'

export interface TxnOwnershipAllowlistEntryV1 {
  readonly file: string
  readonly enclosingFunction: string
  readonly bucket: 'JOINS' | 'NESTED'
  /** Reviewed justification required; never infer a joining/nested exception. */
  readonly reason: string
}

export const TXN_OWNERSHIP_ALLOWLIST_V1: readonly TxnOwnershipAllowlistEntryV1[] = []

export interface BeginSiteV1 {
  readonly key: string
  readonly file: string
  readonly enclosingFunction: string
  readonly connParamName: string
  readonly statementText: string
  readonly bucket: TxnOwnershipBucket
  readonly reason?: string
  readonly start: number
}

type Scope = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

/** Retain the original pool-acquisition domain; do not exempt new files. */
function exportedFunctionDeclarations(source: ts.SourceFile): ts.FunctionDeclaration[] {
  return source.statements.filter((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && !!node.name && !!node.body && hasExportModifier(node))
}

function connectionType(type: ts.TypeNode | undefined): boolean {
  if (!type) return false
  if (ts.isUnionTypeNode(type)) return type.types.every(connectionType)
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
    && CONNECTION_TYPE_NAMES.has(type.typeName.text)
}

function paramName(param: ts.ParameterDeclaration): string | null {
  return ts.isIdentifier(param.name) ? param.name.text : null
}

function isFunctionLikeBoundary(node: ts.Node): boolean {
  return ts.isFunctionLike(node)
}

interface RawCall {
  readonly node: ts.CallExpression
  readonly start: number
}

function collectOwnScopeCalls(
  fn: Scope,
  predicate: (call: ts.CallExpression) => boolean,
): RawCall[] {
  const out: RawCall[] = []
  const visit = (node: ts.Node): void => {
    if (isFunctionLikeBoundary(node)) return
    if (ts.isCallExpression(node) && predicate(node)) out.push({ node, start: node.getStart() })
    node.forEachChild(visit)
  }
  if (fn.body) visit(fn.body)
  return out.sort((a, b) => a.start - b.start)
}

function matchBeginCall(call: ts.CallExpression, connName: string): string | null {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'query'
    || !ts.isIdentifier(callee.expression) || callee.expression.text !== connName) return null
  const sql = call.arguments[0]
  return sql && ts.isStringLiteralLike(sql) && BEGIN_STATEMENT_PATTERN.test(sql.text) ? sql.text : null
}

function bindingContains(binding: ts.BindingName, name: string): boolean {
  return ts.isIdentifier(binding) ? binding.text === name
    : binding.elements.some(element => !ts.isOmittedExpression(element) && bindingContains(element.name, name))
}

/** Conservative binding identity: reject shadowing or writes, including in closures,
 * destructuring, loop targets and compound assignments. No name-only rebind proof. */
function stableBinding(fn: Scope, name: string, parameter?: ts.ParameterDeclaration): boolean {
  let stable = !fn.parameters.some(param => param !== parameter && bindingContains(param.name, name))
  const writesName = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return node.text === name
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return false
    let found = false
    node.forEachChild(child => { if (writesName(child)) found = true })
    return found
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && node !== parameter
      && bindingContains(node.name, name)) stable = false
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node))
      && node.name?.text === name) stable = false
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && writesName(node.left)) stable = false
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && !ts.isVariableDeclarationList(node.initializer) && writesName(node.initializer)) stable = false
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && writesName(node.operand)) stable = false
    node.forEachChild(visit)
  }
  if (fn.body) visit(fn.body)
  return stable
}

/** Exact unaliased import, with no competing declaration anywhere in the file.
 * Test fixtures include these imports too; ambient/name-stamped fake guards fail. */
function trustedImport(source: ts.SourceFile, name: string, module: string): boolean {
  let imports = 0
  let shadowed = false
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.name.text === name) {
      const declaration = node.parent.parent.parent
      if ((!node.propertyName || node.propertyName.text === name)
        && ts.isImportDeclaration(declaration) && ts.isStringLiteral(declaration.moduleSpecifier)
        && declaration.moduleSpecifier.text === module) imports++
      else shadowed = true
    }
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && bindingContains(node.name, name)) shadowed = true
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node))
      && node.name?.text === name) shadowed = true
    if (ts.isImportClause(node) && node.name?.text === name) shadowed = true
    if (ts.isNamespaceImport(node) && node.name.text === name) shadowed = true
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.left.text === name
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) shadowed = true
    node.forEachChild(visit)
  }
  visit(source)
  return imports === 1 && !shadowed
}

function enclosingDeclaration(node: ts.Node): ts.FunctionDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current)) return current
    current = current.parent
  }
  return undefined
}

function exclusiveCallback(source: ts.SourceFile, fn: Scope): ts.ParameterDeclaration | undefined {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined
  const call = fn.parent
  if (!ts.isCallExpression(call) || call.arguments[1] !== fn
    || !ts.isIdentifier(call.expression) || call.expression.text !== EXCLUSIVE_CALLEE_NAME
    || !trustedImport(source, EXCLUSIVE_CALLEE_NAME, './attendance-owning-session')
    || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name)
    || fn.parameters[0].dotDotDotToken || fn.parameters[0].initializer) return undefined
  const lease = fn.parameters[0]
  return stableBinding(fn, lease.name.getText(), lease) ? lease : undefined
}

/** Every use of a private helper must be a direct call with the actual callback
 * lease in this parameter position. Escapes, aliases and mixed callers refuse. */
function exclusiveHelperParameter(source: ts.SourceFile, fn: ts.FunctionDeclaration, index: number): boolean {
  if (!fn.name || hasExportModifier(fn) || fn.parent !== source) return false
  let calls = 0
  let valid = true
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === fn.name!.text && node !== fn.name) {
      const call = node.parent
      if (!ts.isCallExpression(call) || call.expression !== node) valid = false
      else {
        calls++
        let callback: ts.Node | undefined = call.parent
        while (callback && !isFunctionLikeBoundary(callback)) callback = callback.parent
        if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) valid = false
        else {
          const lease = exclusiveCallback(source, callback)
          const arg = call.arguments[index]
          // A direct callback expression or returned/awaited own-body call only.
          let expression: ts.Node = call
          if (ts.isAwaitExpression(expression.parent)) expression = expression.parent
          const direct = callback.body === expression
            || (ts.isReturnStatement(expression.parent) && expression.parent.expression === expression
              && expression.parent.parent === callback.body)
          if (!lease || !arg || !ts.isIdentifier(arg) || arg.text !== lease.name.getText() || !direct) valid = false
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return valid && calls > 0
}

function unconditionalIdleProof(source: ts.SourceFile, fn: Scope, connName: string, before: number): boolean {
  if (!fn.body || !ts.isBlock(fn.body)
    || !trustedImport(source, IDLE_PROOF_CALLEE_NAME, './w4c0-identity')) return false
  return fn.body.statements.some(statement => {
    if (statement.end >= before || !ts.isExpressionStatement(statement)
      || !ts.isAwaitExpression(statement.expression)) return false
    const call = statement.expression.expression
    return ts.isCallExpression(call) && ts.isIdentifier(call.expression)
      && call.expression.text === IDLE_PROOF_CALLEE_NAME && call.arguments.length === 1
      && ts.isIdentifier(call.arguments[0]) && call.arguments[0].text === connName
  })
}

function ancestorKindPath(fn: Scope, node: ts.Node): string {
  const kinds: string[] = []
  let current = node
  while (current.parent && current.parent !== fn) {
    current = current.parent
    kinds.push(ts.SyntaxKind[current.kind])
  }
  return kinds.reverse().join('>')
}

export function discoverBeginSitesV1(
  source: ts.SourceFile,
  fileLabel: string,
  allowlist: readonly TxnOwnershipAllowlistEntryV1[] = TXN_OWNERSHIP_ALLOWLIST_V1,
): BeginSiteV1[] {
  const out: BeginSiteV1[] = []
  const ordinals = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if ((ts.isFunctionDeclaration(node) && node.name && node.body)
      || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const fn = node as Scope
      const callbackLease = exclusiveCallback(source, fn)
      // Generic closures are deliberately left for the broader census to catch.
      if (ts.isFunctionDeclaration(fn) || callbackLease) {
        const name = ts.isFunctionDeclaration(fn) ? fn.name?.text : enclosingDeclaration(fn)?.name?.text
        if (name) for (const [index, param] of fn.parameters.entries()) {
          const connName = paramName(param)
          if (!connName || (!callbackLease && !connectionType(param.type))) continue
          const begins = collectOwnScopeCalls(fn, call => matchBeginCall(call, connName) !== null)
          if (begins.length === 0) continue
          const legacy = param.type && ts.isTypeReferenceNode(param.type)
            && ts.isIdentifier(param.type.typeName) && param.type.typeName.text === 'AttendanceW4TransactionClientV1'
          const leaseProvenance = callbackLease === param
            || (ts.isFunctionDeclaration(fn) && exclusiveHelperParameter(source, fn, index))
          for (const { node: call, start } of begins) {
            const owns = (legacy || leaseProvenance) && stableBinding(fn, connName, param)
              && unconditionalIdleProof(source, fn, connName, start)
            const allow = allowlist.find(entry => entry.file === fileLabel
              && entry.enclosingFunction === name && entry.reason.trim().length > 0)
            const baseKey = `${name}//${ancestorKindPath(fn, call)}//BEGIN`
            const ordinal = ordinals.get(baseKey) ?? 0
            ordinals.set(baseKey, ordinal + 1)
            out.push({
              key: `${baseKey}//#${ordinal}`, file: fileLabel, enclosingFunction: name,
              connParamName: connName, statementText: matchBeginCall(call, connName)!,
              bucket: owns ? 'OWNS' : allow?.bucket ?? 'UNKNOWN',
              reason: owns ? undefined : allow?.reason, start,
            })
          }
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return out.sort((a, b) => a.start - b.start)
}

export interface IndependentBeginCallSiteV1 {
  readonly enclosingFunction: string
  readonly receiverName: string
  readonly statementText: string
  readonly start: number
}

/** Independent unpruned AST traversal: no shared discovery, type, proof, ownership
 * or callback-recognition helpers. Includes private functions, arbitrary closures,
 * methods, property receivers and literal computed .query access. Member-by-member
 * start offsets are diagnostics for completeness, never stable identity keys. */
export function independentDiscoverBeginCallSitesV1(source: ts.SourceFile): IndependentBeginCallSiteV1[] {
  const out: IndependentBeginCallSiteV1[] = []
  const visit = (node: ts.Node, owner: string): void => {
    if (ts.isFunctionDeclaration(node) && node.name) owner = node.name.text
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const receiver = ts.isPropertyAccessExpression(callee) && callee.name.text === 'query'
        ? callee.expression
        : ts.isElementAccessExpression(callee) && callee.argumentExpression
          && ts.isStringLiteralLike(callee.argumentExpression) && callee.argumentExpression.text === 'query'
          ? callee.expression : undefined
      const sql = node.arguments[0]
      if (receiver && sql && ts.isStringLiteralLike(sql) && /^\s*(BEGIN\b|START\s+TRANSACTION\b)/i.test(sql.text)) {
        out.push({
          enclosingFunction: owner, receiverName: receiver.getText(source),
          statementText: sql.text, start: node.getStart(source),
        })
      }
    }
    node.forEachChild(child => visit(child, owner))
  }
  visit(source, '<module>')
  return out
}

/** Pool-owned acquisitions outside the caller-client domain. Recognize only
 * unconditional own-body connect statements; every unproven BEGIN remains in
 * the broad independent census and causes a mismatch.
 */
export function discoverPoolOwnedBeginSitesV1(source: ts.SourceFile): IndependentBeginCallSiteV1[] {
  const out: IndependentBeginCallSiteV1[] = []
  const bindingContains = (binding: ts.BindingName, name: string): boolean => ts.isIdentifier(binding)
    ? binding.text === name : binding.elements.some(element => !ts.isOmittedExpression(element) && bindingContains(element.name,name))
  for (const fn of exportedFunctionDeclarations(source)) {
    const parameters = new Set(fn.parameters.map(paramName).filter(Boolean))
    const bindings: ts.VariableDeclaration[] = []
    const assignments: {target:ts.Node,end:number}[] = []
    const localNames = new Set<string>()
    const walk = (node:ts.Node):void => {
      if (ts.isVariableDeclaration(node)) bindings.push(node)
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) localNames.add(node.name.text)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assignments.push({target:node.left,end:node.end})
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
        assignments.push({target:node.initializer,end:node.end})
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator===ts.SyntaxKind.PlusPlusToken || node.operator===ts.SyntaxKind.MinusMinusToken)) {
        assignments.push({target:node.operand,end:node.end})
      }
      node.forEachChild(walk)
    }
    fn.body!.forEachChild(walk)
    const neverCall = (statement:ts.Statement):boolean => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)
        || !ts.isIdentifier(statement.expression.expression)) return false
      const name=statement.expression.expression.text
      return !fn.parameters.some(parameter=>bindingContains(parameter.name,name)) && !localNames.has(name) && !bindings.some(binding=>bindingContains(binding.name,name))
        && source.statements.some(node=>ts.isFunctionDeclaration(node) && node.name?.text===name && node.type?.kind===ts.SyntaxKind.NeverKeyword)
    }
    const acquired: {name:string,end:number,declaration:ts.VariableDeclaration}[] = []
    const isConnect = (value:ts.Expression):boolean => ts.isAwaitExpression(value)
      && ts.isCallExpression(value.expression) && value.expression.arguments.length===0
      && ts.isPropertyAccessExpression(value.expression.expression) && value.expression.expression.name.text==='connect'
      && ts.isIdentifier(value.expression.expression.expression) && parameters.has(value.expression.expression.expression.text)
    for (const statement of fn.body!.statements) {
      if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer && isConnect(declaration.initializer)) {
            acquired.push({name:declaration.name.text,end:statement.end,declaration})
          }
        }
      }
      if (ts.isTryStatement(statement) && !statement.finallyBlock && statement.tryBlock.statements.length===1
        && statement.catchClause?.block.statements.length===1 && neverCall(statement.catchClause.block.statements[0])) {
        const body=statement.tryBlock.statements[0]
        if (!ts.isExpressionStatement(body) || !ts.isBinaryExpression(body.expression)
          || body.expression.operatorToken.kind!==ts.SyntaxKind.EqualsToken || !ts.isIdentifier(body.expression.left)
          || !isConnect(body.expression.right)) continue
        const name=body.expression.left.text
        const declaration=bindings.find(binding=>ts.isIdentifier(binding.name) && binding.name.text===name && !binding.initializer
          && ts.isVariableDeclarationList(binding.parent) && ts.isVariableStatement(binding.parent.parent)
          && binding.parent.parent.parent===fn.body && binding.parent.parent.end<=statement.pos)
        if (declaration) acquired.push({name,end:statement.end,declaration})
      }
    }
    for (const acquisition of acquired) {
      if (fn.parameters.some(parameter=>bindingContains(parameter.name,acquisition.name)) || bindings.some(binding=>binding!==acquisition.declaration && bindingContains(binding.name,acquisition.name))
        || localNames.has(acquisition.name)) continue
      const writesTarget = (target:ts.Node):boolean => {
        if(ts.isIdentifier(target)) return target.text===acquisition.name
        if(ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) return false
        let found=false
        target.forEachChild(child=>{if(writesTarget(child)) found=true})
        return found
      }
      const writes=assignments.filter(assignment=>writesTarget(assignment.target))
      if (writes.some(write=>write.end>acquisition.end) || writes.length>1) continue
      for (const {node} of collectOwnScopeCalls(fn,call=>matchBeginCall(call,acquisition.name)!==null)) {
        if (node.getStart()<=acquisition.end) continue
        out.push({enclosingFunction:fn.name!.text,receiverName:acquisition.name,statementText:matchBeginCall(node,acquisition.name)!,start:node.getStart()})
      }
    }
  }
  return out
}
