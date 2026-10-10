/**
 * R-41 follow-up — tripwire for the FIXED-SENTENCE allow-lists of directory/directory-failure-text.ts.
 *
 * WHY. classifyDirectoryFailureText shows a caught error's OWN message only when the error is an instance of a
 * class on the caller's allow-list (`fixedSentenceClasses`): DINGTALK_CONFIG_FIXED_SENTENCES and
 * DIRECTORY_TEST_FIXED_SENTENCES (routes/admin-directory.ts), DIRECTORY_FAILURE_FIXED_SENTENCES
 * (directory/directory-sync.ts) and any inline list. That is safe only while every construction of a listed
 * class is handed a literal, the caller's own input or our own ids — which R-41 checked by hand. One
 * `new DirectoryValidationError(err.message)` anywhere would put provider / driver / transport text back into an
 * admin body, a persisted column or the outbound DingTalk alert, with every R-41 test still green.
 *
 * HOW. TypeScript compiler API, one program per scan (noResolve / noLib, so identifiers resolve to their LOCAL
 * declarations: a catch binding is told apart from a same-named parameter by symbol, not by name).
 *  1. The lists are read FROM SOURCE, never hard-coded here: every variable typed `…FixedSentenceErrorClass…`,
 *     every array literal in a `fixedSentenceClasses:` position, and every array literal passed where a
 *     same-file function declares a `FixedSentenceErrorClass` parameter. Elements may be classes (imported
 *     names are traced to their exported name) or spreads of another list; anything else, a list that is not an
 *     array literal, or a consumer position fed by something that is neither a list nor a pass-through
 *     parameter FAILS CLOSED. Adding a class to a list therefore extends this guard by itself.
 *  2. Every `new <Listed>(…)` (aliases, `ns.Listed`, `require` destructuring and `export { X as Y }` re-exports
 *     included) and every `super(…)` inside a subclass of a listed class — across packages/core-backend/src
 *     and plugins/<name>/lib, plugins/<name>/index.cjs — has each argument checked. It is RED when the value
 *     of an argument
 *       (a) reads `.message` / `.stack` / `.errmsg` / `.responseBody` / `.detail` / `.cause` (dot, bracket or
 *           destructuring);
 *       (b) references a binding introduced by `catch (x)`, by the first parameter of a `.catch(cb)` /
 *           `.then(_, cb)` callback, or of an `.on('error', cb)` listener (resolved by symbol);
 *       (c) — the same, through `String(x)` or a template interpolation (reported separately).
 *     The value is followed through same-file locals (initializer and every assignment, destructuring
 *     included) and through parameters of same-file functions to their same-file call sites. Positions that
 *     cannot carry text are not followed: the condition of `?:`, comparisons, `!`, `typeof`.
 *       (d) a constructed instance whose message is rewritten afterwards (`e.message = …`,
 *           `Object.assign(new Listed(…), …)`, `Object.defineProperty(e, …)`) is red as well.
 *     The listed classes' OWN `super(…)` calls are held to the same rules.
 *  3. A subclass of a listed class anywhere is red unless it is in ALLOWED_SUBCLASSES (empty — a subclass can
 *     carry any message and inherits the `instanceof`).
 *  4. Backstop: every VALUE reference to a listed class must be a `new` callee, an `extends` target, the
 *     right side of `instanceof`, an import / export specifier or an element of a discovered list.
 *     `const C = Listed; new C(m)`, `Reflect.construct(Listed, …)` or handing the class to a factory is red.
 *  5. ARGUMENTS_OUTSIDE_MESSAGE exempts one constructor argument position that, by the class's own
 *     constructor, never reaches the message; the exemption is re-verified against that constructor on every
 *     run (RecoveryConflictError keeps its argument only as `cause`).
 *  6. Non-vacuity: the discovered list keys and the per-class construction counts are pinned, and every listed
 *     class must be declared exactly once.
 *
 * NOT COVERED, deliberately: a value carried in from another FILE (an exported helper's parameter, a module
 * field, a function's return value — calls are walked into their arguments only); `this.x` fields; dynamic
 * property names; text produced by a listed class's own method overrides (no subclass may exist, see 3).
 * The self-tests at the bottom build in-memory sources and prove each rule fires.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../..')
const CORE_SRC = 'packages/core-backend/src'

/** (a): property reads that carry provider, driver, transport or caught text. */
const TEXT_PROPERTIES: ReadonlySet<string> = new Set(['message', 'stack', 'errmsg', 'responseBody', 'detail', 'cause'])
/** (d): properties whose rewrite after construction changes what the classifier shows. */
const MESSAGE_PROPERTIES: ReadonlySet<string> = new Set(['message', 'stack'])

// ── pins ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The allow-lists discovered today: `<file> <const name>` or `<file> inline#<n>` (n counts inline lists per file). */
const EXPECTED_LISTS: readonly string[] = [
  `${CORE_SRC}/directory/directory-sync.ts DIRECTORY_FAILURE_FIXED_SENTENCES`,
  `${CORE_SRC}/routes/admin-directory.ts DINGTALK_CONFIG_FIXED_SENTENCES`,
  `${CORE_SRC}/routes/admin-directory.ts DIRECTORY_TEST_FIXED_SENTENCES`,
  `${CORE_SRC}/routes/admin-directory.ts inline#1`,
]

/**
 * Constructions per listed class (`new` + `super(…)` from an allowed subclass), pinned so the guard cannot go
 * vacuous: a class whose sites stop being found, or one added to a list, shows up here first.
 */
const EXPECTED_CONSTRUCTION_COUNTS: Readonly<Record<string, number>> = {
  DingTalkConfigValidationError: 9,
  DingTalkCorpNotAllowedError: 2,
  DirectoryConflictError: 19,
  DirectoryNotFoundError: 10,
  DirectorySyncLeaseLostError: 1,
  DirectoryTenantChangeBlockedError: 1,
  DirectoryValidationError: 41,
  EncryptionMaterialError: 1,
  LoginAliasClaimError: 2,
  LoginNameRuleError: 1,
  PasswordPolicyError: 1,
  RecoveryConflictError: 1,
}

/** `<file> :: <subclass>` → why a subclass of a listed class may exist. Empty: none does today. */
const ALLOWED_SUBCLASSES: Readonly<Record<string, string>> = {}

interface ArgumentExemption { index: number; reason: string }
/** Constructor argument positions that never reach the message — each re-verified against the constructor. */
const ARGUMENTS_OUTSIDE_MESSAGE: Readonly<Record<string, ArgumentExemption>> = {
  RecoveryConflictError: {
    index: 0,
    reason: 'db/recovery-conflict.ts: the constructor calls super(RECOVERY_CONFLICT_HTTP_MESSAGE) and keeps its one argument (the 40001 driver error translateRecoveryConflict caught) only as `cause`; the classifier reads `.message` alone.',
  },
}

// ── scanner: a pure function of (repo-relative path → text), shared by the real tree and the self-tests ────

type SourceMap = ReadonlyMap<string, string>
interface ScanOptions {
  allowedSubclasses: Readonly<Record<string, string>>
  argumentsOutsideMessage: Readonly<Record<string, ArgumentExemption>>
}
interface Construction { file: string; line: number; cls: string; kind: 'new' | 'super' }
interface Scan {
  lists: Map<string, string[]>
  classes: string[]
  declarations: Map<string, string[]>
  constructions: Construction[]
  violations: string[]
  subclasses: Array<{ key: string; where: string; parent: string }>
  unplaced: string[]
  exemptionFailures: string[]
  failures: string[]
}

const VROOT = '/vroot/'
const COMPARISON_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
])
const ASSIGNMENT_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
])

function scriptKindOf(file: string): ts.ScriptKind {
  if (/\.(c|m)?js$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function buildProgram(files: SourceMap, roots: readonly string[]): ts.Program {
  const toRel = (f: string) => (f.startsWith(VROOT) ? f.slice(VROOT.length) : f)
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(toRel(fileName))
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true, scriptKindOf(fileName))
    },
    getDefaultLibFileName: () => `${VROOT}lib.d.ts`,
    writeFile: () => undefined,
    getCurrentDirectory: () => VROOT,
    getDirectories: () => [],
    fileExists: (f) => files.has(toRel(f)),
    readFile: (f) => files.get(toRel(f)),
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  return ts.createProgram({
    rootNames: roots.map((r) => VROOT + r),
    options: {
      noResolve: true, noLib: true, allowJs: true, checkJs: false, noEmit: true, types: [],
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleDetection: ts.ModuleDetectionKind.Force,
    },
    host,
  })
}

const relOf = (sf: ts.SourceFile) => sf.fileName.slice(VROOT.length)
const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
const at = (node: ts.Node) => `${relOf(node.getSourceFile())}:${lineOf(node)}`

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression
  return e
}
/** Climb parentheses / type assertions upward from an expression. */
function outermost(expr: ts.Node): ts.Node {
  let e = expr
  while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isNonNullExpression(e.parent) || ts.isSatisfiesExpression(e.parent) || ts.isTypeAssertionExpression(e.parent))) e = e.parent
  return e
}
const typeMentionsFixedSentence = (t: ts.TypeNode | undefined) => !!t && /\bFixedSentenceErrorClass\b/.test(t.getText())
const isFunctionLike = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration =>
  !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n))
const isRequireCall = (e: ts.Expression) => {
  const u = unwrap(e)
  return ts.isCallExpression(u) && ts.isIdentifier(u.expression) && u.expression.text === 'require'
}

function walk(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node)
  ts.forEachChild(node, (c) => walk(c, fn))
}

/** The exported name an identifier stands for: through import specifiers, `require` destructuring and re-export aliases. */
function originalNameOf(id: ts.Identifier, checker: ts.TypeChecker, reexports: ReadonlyMap<string, string>): string {
  return originalNameOfSymbol(checker.getSymbolAtLocation(id), id.text, reexports)
}
function originalNameOfSymbol(sym: ts.Symbol | undefined, fallback: string, reexports: ReadonlyMap<string, string>): string {
  const decl = sym?.declarations?.[0]
  let name = fallback
  if (decl) {
    if (ts.isImportSpecifier(decl)) name = (decl.propertyName ?? decl.name).text
    else if (ts.isBindingElement(decl)) {
      const prop = decl.propertyName ?? decl.name
      if (ts.isIdentifier(prop) || ts.isStringLiteral(prop)) name = prop.text
    } else if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const init = unwrap(decl.initializer)
      if (ts.isPropertyAccessExpression(init) && isRequireCall(init.expression)) name = init.name.text
    }
  }
  return reexports.get(name) ?? name
}

/** The class an expression names, or undefined (only identifiers and `x.Name` name a class here). */
function classNameOf(expr: ts.Expression, checker: ts.TypeChecker, reexports: ReadonlyMap<string, string>): string | undefined {
  const e = unwrap(expr)
  if (ts.isIdentifier(e)) return originalNameOf(e, checker, reexports)
  if (ts.isPropertyAccessExpression(e)) return reexports.get(e.name.text) ?? e.name.text
  return undefined
}

// ── phase 1: the allow-lists ────────────────────────────────────────────────────────────────────────────────

interface ListDiscovery { lists: Map<string, string[]>; listArrays: Set<ts.ArrayLiteralExpression>; failures: string[] }

function discoverLists(files: SourceMap): ListDiscovery {
  const roots = [...files.keys()].filter((f) => /FixedSentenceErrorClass|fixedSentenceClasses/.test(files.get(f) ?? ''))
  const program = buildProgram(files, roots)
  const checker = program.getTypeChecker()
  const failures: string[] = []
  const listArrays = new Set<ts.ArrayLiteralExpression>()
  /** declaration node of a named list → its key and array. */
  const named = new Map<ts.Node, { key: string; array: ts.ArrayLiteralExpression }>()
  const inline: Array<{ key: string; array: ts.ArrayLiteralExpression }> = []
  const noReexports = new Map<string, string>()

  for (const sf of program.getSourceFiles()) {
    const rel = relOf(sf)
    let inlineCount = 0
    const fixedParams = new Map<ts.Symbol, number[]>()
    const consumers: ts.Expression[] = []
    walk(sf, (node) => {
      if (ts.isVariableDeclaration(node) && typeMentionsFixedSentence(node.type) && ts.isIdentifier(node.name)) {
        const init = node.initializer ? unwrap(node.initializer) : undefined
        if (init && ts.isArrayLiteralExpression(init)) {
          named.set(node, { key: `${rel} ${node.name.text}`, array: init })
        } else {
          failures.push(`${at(node)} allow-list ${node.name.text} is not an array literal — the guard cannot read it`)
        }
      }
      if (isFunctionLike(node) || ts.isMethodDeclaration(node)) {
        const indexes = node.parameters.map((p, i) => (typeMentionsFixedSentence(p.type) ? i : -1)).filter((i) => i >= 0)
        const fnName = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.name
          : ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined
        const sym = fnName && ts.isIdentifier(fnName) ? checker.getSymbolAtLocation(fnName) : undefined
        if (sym && indexes.length > 0) fixedParams.set(sym, indexes)
      }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText() === 'fixedSentenceClasses') {
        consumers.push(ts.isPropertyAssignment(node) ? node.initializer : node.name)
      }
    })
    walk(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = unwrap(node.expression)
      const sym = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee) : undefined
      const indexes = sym ? fixedParams.get(sym) : undefined
      for (const i of indexes ?? []) if (node.arguments[i]) consumers.push(node.arguments[i])
    })
    for (const consumer of consumers) {
      const value = unwrap(consumer)
      if (ts.isArrayLiteralExpression(value)) {
        inlineCount += 1
        inline.push({ key: `${rel} inline#${inlineCount}`, array: value })
        continue
      }
      if (ts.isIdentifier(value)) {
        const decl = (ts.isShorthandPropertyAssignment(consumer.parent) && consumer.parent.name === consumer
          ? checker.getShorthandAssignmentValueSymbol(consumer.parent)
          : checker.getSymbolAtLocation(value))?.declarations?.[0]
        if (decl && ts.isVariableDeclaration(decl) && typeMentionsFixedSentence(decl.type)) continue
        if (decl && ts.isParameter(decl) && typeMentionsFixedSentence(decl.type)) continue
      }
      failures.push(`${at(consumer)} a fixed-sentence consumer is fed by \`${consumer.getText()}\`, neither a discovered list nor a pass-through parameter`)
    }
  }

  const lists = new Map<string, string[]>()
  const resolving = new Set<ts.ArrayLiteralExpression>()
  const classesOf = (array: ts.ArrayLiteralExpression): string[] => {
    if (resolving.has(array)) {
      failures.push(`${at(array)} allow-list spreads itself`)
      return []
    }
    resolving.add(array)
    listArrays.add(array)
    const out: string[] = []
    for (const element of array.elements) {
      if (ts.isSpreadElement(element)) {
        const target = unwrap(element.expression)
        const decl = ts.isIdentifier(target) ? checker.getSymbolAtLocation(target)?.declarations?.[0] : undefined
        const list = decl ? named.get(decl) : undefined
        if (list) out.push(...classesOf(list.array))
        else failures.push(`${at(element)} allow-list spread of \`${element.expression.getText()}\` is not a discovered list`)
        continue
      }
      const e = unwrap(element)
      if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
        out.push(classNameOf(e, checker, noReexports) as string)
        continue
      }
      failures.push(`${at(element)} allow-list element \`${element.getText()}\` is not a class name`)
    }
    resolving.delete(array)
    return out
  }
  for (const { key, array } of [...named.values(), ...inline]) lists.set(key, [...new Set(classesOf(array))].sort())
  return { lists, listArrays, failures }
}

// ── phase 2: constructions, subclasses, references ─────────────────────────────────────────────────────────

function scanFixedSentenceConstructors(files: SourceMap, options: ScanOptions): Scan {
  const discovery = discoverLists(files)
  const failures = [...discovery.failures]
  const listed = [...new Set([...discovery.lists.values()].flat())].sort()
  const allowedSubclassNames = Object.keys(options.allowedSubclasses).map((k) => k.split(' :: ')[1])
  const family = new Set([...listed, ...allowedSubclassNames])

  // Prefilter by text, widening with `export { Listed as Alias }` re-exports until stable.
  const reexports = new Map<string, string>()
  let names = new Set(family)
  let candidates: string[] = []
  for (;;) {
    const pattern = new RegExp(`\\b(${[...names].map((n) => n.replace(/[$]/g, '\\$')).join('|') || '(?!)'})\\b`)
    candidates = [...files.keys()].filter((f) => pattern.test(files.get(f) ?? ''))
    let grew = false
    for (const f of candidates) {
      const sf = ts.createSourceFile(f, files.get(f) as string, ts.ScriptTarget.ES2022, true, scriptKindOf(f))
      walk(sf, (node) => {
        if (ts.isExportSpecifier(node) && node.propertyName) {
          const original = reexports.get(node.propertyName.text) ?? node.propertyName.text
          if (family.has(original) && !reexports.has(node.name.text)) {
            reexports.set(node.name.text, original)
            names.add(node.name.text)
            grew = true
          }
        }
      })
    }
    if (!grew) break
    names = new Set(names)
  }

  const listFiles = [...files.keys()].filter((f) => /FixedSentenceErrorClass|fixedSentenceClasses/.test(files.get(f) ?? ''))
  const program = buildProgram(files, [...new Set([...candidates, ...listFiles])])
  const checker = program.getTypeChecker()
  // Re-locate the list arrays in THIS program (phase 1 used its own) by position.
  const listArrayAt = new Set([...discovery.listArrays].map((a) => `${relOf(a.getSourceFile())}@${a.getStart()}`))

  const declarations = new Map<string, string[]>()
  const constructions: Construction[] = []
  const violations: string[] = []
  const subclasses: Scan['subclasses'] = []
  const unplaced: string[] = []
  const exemptionFailures: string[] = []
  const classDecls = new Map<string, ts.ClassDeclaration>()

  for (const sf of program.getSourceFiles()) {
    const rel = relOf(sf)

    // Per-file indexes: caught bindings, assignments, call sites.
    const caught = new Set<ts.Symbol>()
    const assignments = new Map<ts.Symbol, ts.Expression[]>()
    const calls: ts.CallExpression[] = []
    const addBinding = (name: ts.BindingName) => {
      if (ts.isIdentifier(name)) {
        const sym = checker.getSymbolAtLocation(name)
        if (sym) caught.add(sym)
        return
      }
      for (const el of name.elements) if (!ts.isOmittedExpression(el)) addBinding(el.name)
    }
    const firstParamOf = (cb: ts.Expression | undefined): ts.ParameterDeclaration | undefined => {
      if (!cb) return undefined
      const e = unwrap(cb)
      if (isFunctionLike(e)) return e.parameters[0]
      if (ts.isIdentifier(e)) {
        const decl = checker.getSymbolAtLocation(e)?.declarations?.[0]
        if (decl && ts.isFunctionDeclaration(decl)) return decl.parameters[0]
        if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isFunctionLike(unwrap(decl.initializer))) {
          return (unwrap(decl.initializer) as ts.ArrowFunction).parameters[0]
        }
      }
      return undefined
    }
    walk(sf, (node) => {
      if (ts.isCatchClause(node) && node.variableDeclaration) addBinding(node.variableDeclaration.name)
      if (ts.isCallExpression(node)) {
        calls.push(node)
        const callee = unwrap(node.expression)
        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text
          let cb: ts.Expression | undefined
          if (method === 'catch') cb = node.arguments[0]
          else if (method === 'then') cb = node.arguments[1]
          else if (['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'].includes(method)) {
            const event = node.arguments[0] ? unwrap(node.arguments[0]) : undefined
            if (event && (ts.isStringLiteral(event) || ts.isNoSubstitutionTemplateLiteral(event)) && event.text === 'error') cb = node.arguments[1]
          }
          const param = firstParamOf(cb)
          if (param) addBinding(param.name)
        }
      }
      if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind) && ts.isIdentifier(unwrap(node.left))) {
        const sym = checker.getSymbolAtLocation(unwrap(node.left))
        if (sym) assignments.set(sym, [...(assignments.get(sym) ?? []), node.right])
      }
    })

    const calleeSymbol = (call: ts.CallExpression): ts.Symbol | undefined => {
      const callee = unwrap(call.expression)
      if (ts.isIdentifier(callee)) return checker.getSymbolAtLocation(callee)
      if (ts.isPropertyAccessExpression(callee)) return checker.getSymbolAtLocation(callee.name)
      return undefined
    }

    /** Findings for one argument VALUE (rules a–c), following same-file locals and parameters. */
    const argumentFindings = (arg: ts.Expression): string[] => {
      const out = new Set<string>()
      const visited = new Set<ts.Symbol>()
      const visit = (node: ts.Node, textual: boolean, via: string): void => {
        if (ts.isTypeNode(node)) return
        if (ts.isConditionalExpression(node)) {
          visit(node.whenTrue, textual, via)
          visit(node.whenFalse, textual, via)
          return
        }
        if (ts.isBinaryExpression(node) && COMPARISON_OPERATORS.has(node.operatorToken.kind)) return
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return
        if (ts.isTypeOfExpression(node)) return
        if (ts.isPropertyAccessExpression(node)) {
          if (TEXT_PROPERTIES.has(node.name.text)) out.add(`(a) reads .${node.name.text}${via}`)
          visit(node.expression, textual, via)
          return
        }
        if (ts.isElementAccessExpression(node)) {
          const key = unwrap(node.argumentExpression)
          if ((ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) && TEXT_PROPERTIES.has(key.text)) out.add(`(a) reads ['${key.text}']${via}`)
          visit(node.expression, textual, via)
          visit(node.argumentExpression, textual, via)
          return
        }
        if (ts.isTemplateSpan(node)) {
          visit(node.expression, true, via)
          return
        }
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'String') {
          for (const a of node.arguments) visit(a, true, via)
          return
        }
        if (ts.isPropertyAssignment(node)) {
          visit(node.initializer, textual, via)
          return
        }
        if (ts.isShorthandPropertyAssignment(node)) {
          const sym = checker.getShorthandAssignmentValueSymbol(node)
          if (sym) symbol(sym, node.name.text, textual, via)
          return
        }
        if (ts.isIdentifier(node)) {
          const sym = checker.getSymbolAtLocation(node)
          if (sym) symbol(sym, node.text, textual, via)
          return
        }
        ts.forEachChild(node, (c) => visit(c, textual, via))
      }
      const symbol = (sym: ts.Symbol, name: string, textual: boolean, via: string): void => {
        if (caught.has(sym)) {
          out.add(textual ? `(c) interpolates caught \`${name}\`${via}` : `(b) passes caught \`${name}\`${via}`)
          return
        }
        if (visited.has(sym)) return
        visited.add(sym)
        const decl = sym.valueDeclaration ?? sym.declarations?.[0]
        if (!decl || decl.getSourceFile() !== sf) return
        const next = `${via} via \`${name}\``
        if (ts.isVariableDeclaration(decl)) {
          if (decl.initializer) visit(decl.initializer, textual, next)
          for (const rhs of assignments.get(sym) ?? []) visit(rhs, textual, next)
          return
        }
        if (ts.isBindingElement(decl)) {
          const prop = decl.propertyName ?? decl.name
          if ((ts.isIdentifier(prop) || ts.isStringLiteral(prop)) && TEXT_PROPERTIES.has(prop.text)) out.add(`(a) destructures ${prop.text}${via}`)
          let root: ts.Node = decl
          while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent
          if (ts.isVariableDeclaration(root) && root.initializer) visit(root.initializer, textual, next)
          if (ts.isParameter(root)) parameter(root, textual, next)
          for (const rhs of assignments.get(sym) ?? []) visit(rhs, textual, next)
          return
        }
        if (ts.isParameter(decl)) parameter(decl, textual, next)
      }
      const parameter = (param: ts.ParameterDeclaration, textual: boolean, via: string): void => {
        const fn = param.parent
        if (ts.isConstructorDeclaration(fn)) return // every `new` site of that class is checked on its own
        const index = fn.parameters.indexOf(param)
        const fnName = ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) ? fn.name
          : (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined
        const fnSym = fnName && ts.isIdentifier(fnName) ? checker.getSymbolAtLocation(fnName) : undefined
        if (!fnSym) return
        for (const call of calls) {
          if (calleeSymbol(call) !== fnSym) continue
          const a = call.arguments[index]
          if (a) visit(a, textual, `${via} from ${at(call)}`)
        }
      }
      visit(arg, false, '')
      return [...out].sort()
    }

    const checkArguments = (args: readonly ts.Expression[], cls: string, label: string, node: ts.Node) => {
      const exemption = options.argumentsOutsideMessage[cls]
      args.forEach((arg, i) => {
        if (exemption && exemption.index === i) return
        for (const finding of argumentFindings(arg)) violations.push(`${at(node)} ${label} argument ${i + 1}: ${finding}`)
      })
    }

    /** (d): the instance's message rewritten after construction. */
    const checkPostConstruction = (newExpr: ts.NewExpression, cls: string) => {
      const outer = outermost(newExpr)
      const isRewriteCall = (call: ts.Node) => {
        if (!ts.isCallExpression(call)) return false
        const callee = unwrap(call.expression)
        return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
          && ['Object', 'Reflect'].includes(callee.expression.text)
          && ['assign', 'defineProperty', 'defineProperties', 'set'].includes(callee.name.text)
      }
      if (isRewriteCall(outer.parent) && (outer.parent as ts.CallExpression).arguments[0] === outer) {
        violations.push(`${at(newExpr)} new ${cls}(…): (d) the instance is handed to ${(outer.parent as ts.CallExpression).expression.getText()} after construction`)
      }
      if (ts.isVariableDeclaration(outer.parent) && outer.parent.initializer === outer && ts.isIdentifier(outer.parent.name)) {
        const sym = checker.getSymbolAtLocation(outer.parent.name)
        walk(sf, (n) => {
          if (ts.isBinaryExpression(n) && ASSIGNMENT_OPERATORS.has(n.operatorToken.kind)) {
            const left = unwrap(n.left)
            const target = ts.isPropertyAccessExpression(left) ? left.expression : ts.isElementAccessExpression(left) ? left.expression : undefined
            const prop = ts.isPropertyAccessExpression(left) ? left.name.text
              : ts.isElementAccessExpression(left) && ts.isStringLiteral(unwrap(left.argumentExpression)) ? (unwrap(left.argumentExpression) as ts.StringLiteral).text : undefined
            if (target && ts.isIdentifier(unwrap(target)) && checker.getSymbolAtLocation(unwrap(target)) === sym && prop && MESSAGE_PROPERTIES.has(prop)) {
              violations.push(`${at(n)} new ${cls}(…) at line ${lineOf(newExpr)}: (d) .${prop} rewritten after construction`)
            }
          }
          if (isRewriteCall(n) && ts.isCallExpression(n) && n.arguments[0] && ts.isIdentifier(unwrap(n.arguments[0])) && checker.getSymbolAtLocation(unwrap(n.arguments[0])) === sym) {
            violations.push(`${at(n)} new ${cls}(…) at line ${lineOf(newExpr)}: (d) the instance is handed to ${n.expression.getText()} after construction`)
          }
        })
      }
    }

    const heritageParent = (cls: ts.ClassLikeDeclaration): string | undefined => {
      for (const clause of cls.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
        for (const t of clause.types) {
          let found: string | undefined
          walk(t.expression, (n) => {
            if (found) return
            if (ts.isIdentifier(n) || ts.isPropertyAccessExpression(n)) {
              const name = classNameOf(n as ts.Expression, checker, reexports)
              if (name && family.has(name)) found = name
            }
          })
          if (found) return found
        }
      }
      return undefined
    }

    const constructorOf = (cls: ts.ClassLikeDeclaration) => cls.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body)
    const superCallsIn = (ctor: ts.ConstructorDeclaration): ts.CallExpression[] => {
      const out: ts.CallExpression[] = []
      walk(ctor, (n) => {
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) out.push(n)
      })
      return out
    }

    walk(sf, (node) => {
      // Declarations of the listed classes themselves: their own super(…) and `this.message = …`.
      if (ts.isClassDeclaration(node) && node.name && listed.includes(node.name.text)) {
        const name = node.name.text
        declarations.set(name, [...(declarations.get(name) ?? []), at(node)])
        classDecls.set(`${rel} :: ${name}`, node)
        const ctor = constructorOf(node)
        if (ctor) {
          for (const call of superCallsIn(ctor)) checkArguments(call.arguments, name, `${name}'s own super(…)`, call)
          walk(ctor, (n) => {
            if (ts.isBinaryExpression(n) && ASSIGNMENT_OPERATORS.has(n.operatorToken.kind) && ts.isPropertyAccessExpression(unwrap(n.left))) {
              const left = unwrap(n.left) as ts.PropertyAccessExpression
              if (left.expression.kind === ts.SyntaxKind.ThisKeyword && MESSAGE_PROPERTIES.has(left.name.text)) {
                for (const finding of argumentFindings(n.right)) violations.push(`${at(n)} ${name}'s own this.${left.name.text}: ${finding}`)
              }
            }
          })
        }
      }
      // Subclasses of a listed (or allowed) class.
      if ((ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
        const parent = heritageParent(node)
        if (parent) {
          const subName = node.name?.text ?? (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : '<anonymous>')
          const key = `${rel} :: ${subName}`
          subclasses.push({ key, where: at(node), parent })
          const ctor = constructorOf(node)
          for (const call of ctor ? superCallsIn(ctor) : []) {
            constructions.push({ file: rel, line: lineOf(call), cls: parent, kind: 'super' })
            checkArguments(call.arguments, parent, `super(…) of ${subName} extends ${parent}`, call)
          }
        }
      }
      // `new Listed(…)`.
      if (ts.isNewExpression(node)) {
        const cls = classNameOf(node.expression, checker, reexports)
        if (cls && family.has(cls)) {
          constructions.push({ file: rel, line: lineOf(node), cls, kind: 'new' })
          checkArguments(node.arguments ?? [], cls, `new ${cls}(…)`, node)
          checkPostConstruction(node, cls)
        }
      }
    })

    // Backstop: every value reference to a listed class is in a known position. Only identifiers whose text can
    // name a listed class in this file (its name, a re-export alias, or a local import / require alias) are resolved.
    const familyOf = (name: string) => family.has(reexports.get(name) ?? name)
    const localNames = new Set(names)
    walk(sf, (n) => {
      if (ts.isImportSpecifier(n) && familyOf((n.propertyName ?? n.name).text)) localNames.add(n.name.text)
      if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) {
        const prop = n.propertyName ?? n.name
        if ((ts.isIdentifier(prop) || ts.isStringLiteral(prop)) && familyOf(prop.text)) localNames.add(n.name.text)
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = unwrap(n.initializer)
        if (ts.isPropertyAccessExpression(init) && isRequireCall(init.expression) && familyOf(init.name.text)) localNames.add(n.name.text)
      }
    })
    const visitRefs = (node: ts.Node, inType: boolean): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return
      const typeContext = inType || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        || (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword)
      if (!typeContext && ts.isIdentifier(node)) checkReference(node)
      ts.forEachChild(node, (c) => visitRefs(c, typeContext))
    }
    const checkReference = (id: ts.Identifier) => {
      if (!localNames.has(id.text)) return
      const parent = id.parent
      // Declaration names and property keys are not references.
      if ((ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)
        || ts.isParameter(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)
        || ts.isPropertySignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isEnumMember(parent)
        || ts.isBindingElement(parent) || ts.isLabeledStatement(parent)) && (parent as { name?: ts.Node }).name === id) return
      if (ts.isBindingElement(parent) && parent.propertyName === id) return
      if (ts.isPropertyAccessExpression(parent) && parent.expression === id && !family.has(originalNameOf(id, checker, reexports))) return
      let cls: string | undefined
      let ref: ts.Node
      if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
        cls = reexports.get(id.text) ?? id.text
        ref = parent
      } else {
        cls = ts.isShorthandPropertyAssignment(parent)
          ? originalNameOfSymbol(checker.getShorthandAssignmentValueSymbol(parent), id.text, reexports)
          : originalNameOf(id, checker, reexports)
        ref = id
      }
      if (!cls || !family.has(cls)) return
      ref = outermost(ref)
      const p = ref.parent
      if (ts.isNewExpression(p) && p.expression === ref) return
      if (ts.isExpressionWithTypeArguments(p) && ts.isHeritageClause(p.parent) && p.parent.token === ts.SyntaxKind.ExtendsKeyword) return
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === ref) return
      if (ts.isArrayLiteralExpression(p) && listArrayAt.has(`${relOf(p.getSourceFile())}@${p.getStart()}`)) return
      unplaced.push(`${at(ref)} ${cls} (${ts.SyntaxKind[p.kind]}: \`${p.getText().slice(0, 80)}\`)`)
    }
    visitRefs(sf, false)
  }

  // Every listed class is declared exactly once.
  for (const name of listed) {
    const found = declarations.get(name) ?? []
    if (found.length !== 1) failures.push(`${name}: expected exactly one class declaration, found ${found.length} (${found.join(', ') || 'none'})`)
  }

  // Exemptions still hold against the constructor: the exempt parameter appears only as `Object.assign(this, { cause })`
  // or in a comparison with `undefined`.
  for (const [cls, exemption] of Object.entries(options.argumentsOutsideMessage)) {
    if (!listed.includes(cls)) {
      exemptionFailures.push(`${cls}: exempted but no longer on any list — remove the stale exemption`)
      continue
    }
    const decl = [...classDecls.entries()].find(([key]) => key.endsWith(` :: ${cls}`))?.[1]
    const ctor = decl?.members.find((m): m is ts.ConstructorDeclaration => ts.isConstructorDeclaration(m) && !!m.body)
    const param = ctor?.parameters[exemption.index]
    if (!ctor || !param || !ts.isIdentifier(param.name)) {
      exemptionFailures.push(`${cls}: no constructor parameter #${exemption.index + 1} to exempt`)
      continue
    }
    const sym = checker.getSymbolAtLocation(param.name)
    walk(ctor.body as ts.Block, (n) => {
      if (!ts.isIdentifier(n)) return
      const isShorthand = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n
      const refSym = isShorthand ? checker.getShorthandAssignmentValueSymbol(n.parent as ts.ShorthandPropertyAssignment) : checker.getSymbolAtLocation(n)
      if (refSym !== sym) return
      const ref = outermost(n)
      const p = ref.parent
      const comparedWithUndefined = ts.isBinaryExpression(p) && COMPARISON_OPERATORS.has(p.operatorToken.kind)
        && [p.left, p.right].some((side) => side !== ref && ts.isIdentifier(unwrap(side)) && (unwrap(side) as ts.Identifier).text === 'undefined')
      const keptAsCause = (isShorthand ? n.parent : ts.isPropertyAssignment(p) && p.initializer === ref ? p : undefined) as ts.ObjectLiteralElementLike | undefined
      const causeInAssignThis = !!keptAsCause && keptAsCause.name?.getText() === 'cause' && ts.isObjectLiteralExpression(keptAsCause.parent)
        && ts.isCallExpression(outermost(keptAsCause.parent).parent)
        && (() => {
          const call = outermost(keptAsCause.parent).parent as ts.CallExpression
          const callee = unwrap(call.expression)
          return ts.isPropertyAccessExpression(callee) && callee.getText() === 'Object.assign'
            && call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword && call.arguments[1] === outermost(keptAsCause.parent)
        })()
      if (!comparedWithUndefined && !causeInAssignThis) {
        exemptionFailures.push(`${cls}: exempt parameter \`${param.name.getText()}\` is used at ${at(n)} (\`${p.getText().slice(0, 80)}\`) — it may reach the message; the exemption no longer holds`)
      }
    })
  }

  return {
    lists: discovery.lists,
    classes: listed,
    declarations,
    constructions,
    violations: [...new Set(violations)].sort(),
    subclasses,
    unplaced: [...new Set(unplaced)].sort(),
    exemptionFailures,
    failures,
  }
}

function countsByClass(scan: Scan): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const cls of scan.classes) counts[cls] = 0
  for (const c of scan.constructions) if (c.cls in counts) counts[c.cls] += 1
  return counts
}

// ── the real tree ───────────────────────────────────────────────────────────────────────────────────────────

const SCANNED_EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs)$/
function readTree(): Map<string, string> {
  const out = new Map<string, string>()
  const add = (abs: string) => {
    const rel = path.relative(REPO, abs).split(path.sep).join('/')
    if (!SCANNED_EXTENSIONS.test(rel) || rel.endsWith('.d.ts') || /\.(test|spec)\.[cm]?[jt]s$/.test(rel) || rel.includes('/__tests__/')) return
    out.set(rel, fs.readFileSync(abs, 'utf8'))
  }
  const walkDir = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue
      const child = path.join(abs, entry.name)
      if (entry.isDirectory()) walkDir(child)
      else if (entry.isFile()) add(child)
    }
  }
  walkDir(path.join(REPO, CORE_SRC))
  for (const plugin of fs.readdirSync(path.join(REPO, 'plugins'), { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue
    const lib = path.join(REPO, 'plugins', plugin.name, 'lib')
    if (fs.existsSync(lib)) walkDir(lib)
    const index = path.join(REPO, 'plugins', plugin.name, 'index.cjs')
    if (fs.existsSync(index)) add(index)
  }
  return out
}

const REAL_OPTIONS: ScanOptions = { allowedSubclasses: ALLOWED_SUBCLASSES, argumentsOutsideMessage: ARGUMENTS_OUTSIDE_MESSAGE }
let realScan: Scan | undefined
const real = (): Scan => (realScan ??= scanFixedSentenceConstructors(readTree(), REAL_OPTIONS))

describe('R-41 fixed-sentence allow-lists: every construction of a listed class (real tree)', () => {
  it('discovers the allow-lists from source, fails closed on nothing, and finds each listed class declared once', () => {
    const scan = real()
    expect(scan.failures).toEqual([])
    expect([...scan.lists.keys()].sort()).toEqual([...EXPECTED_LISTS].sort())
    expect(scan.classes.length).toBeGreaterThan(0)
    for (const cls of scan.classes) expect(scan.declarations.get(cls)?.length, cls).toBe(1)
  }, 60_000)

  it('no argument of any construction reads provider / caught text (rules a–d)', () => {
    expect(real().violations).toEqual([])
  }, 60_000)

  it('no subclass of a listed class exists outside ALLOWED_SUBCLASSES, and no allowance is stale', () => {
    const scan = real()
    expect(scan.subclasses.filter((s) => !(s.key in ALLOWED_SUBCLASSES)).map((s) => `${s.where} ${s.key} extends ${s.parent}`)).toEqual([])
    expect(Object.keys(ALLOWED_SUBCLASSES).filter((k) => !scan.subclasses.some((s) => s.key === k))).toEqual([])
  }, 60_000)

  it('every value reference to a listed class is a construction, an extends, an instanceof, an import / export or a list element', () => {
    expect(real().unplaced).toEqual([])
  }, 60_000)

  it('each argument exemption still holds against its constructor, and each one is load-bearing', () => {
    expect(real().exemptionFailures).toEqual([])
    // Without its exemption, the class's real construction site is red (rule b): the exemption is not dead weight.
    const unexempt = scanFixedSentenceConstructors(readTree(), { ...REAL_OPTIONS, argumentsOutsideMessage: {} })
    for (const cls of Object.keys(ARGUMENTS_OUTSIDE_MESSAGE)) {
      expect(unexempt.violations.filter((v) => v.includes(`new ${cls}(…) argument`)), cls).not.toEqual([])
    }
  }, 60_000)

  it('non-vacuity: the construction count of every listed class is pinned (a newly listed class shows up here with its count)', () => {
    expect(countsByClass(real())).toEqual(EXPECTED_CONSTRUCTION_COUNTS)
    expect(real().constructions.filter((c) => c.kind === 'new').length).toBeGreaterThanOrEqual(80)
  }, 60_000)
})

// ── self-tests: in-memory sources prove each rule fires ─────────────────────────────────────────────────────

const S = 'packages/core-backend/src'
const ERRORS = `
export class FooError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FooError'
  }
}
export class BarError extends Error {}
export class CauseOnlyError extends Error {
  constructor(cause: unknown) {
    super('A fixed sentence.')
    if (cause !== undefined) {
      Object.assign(this, { cause })
    }
  }
}
`
const LISTS = `
import { FooError, CauseOnlyError } from './errors'
import type { FixedSentenceErrorClass } from './failure-text'
export const SAMPLE_FIXED_SENTENCES: readonly FixedSentenceErrorClass[] = [FooError, CauseOnlyError]
`
const SYNTHETIC_OPTIONS: ScanOptions = {
  allowedSubclasses: {},
  argumentsOutsideMessage: { CauseOnlyError: { index: 0, reason: 'synthetic: kept only as cause' } },
}
function synthetic(user: string, extra: Record<string, string> = {}, options: ScanOptions = SYNTHETIC_OPTIONS): Scan {
  return scanFixedSentenceConstructors(new Map([
    [`${S}/x/errors.ts`, ERRORS],
    [`${S}/x/lists.ts`, LISTS],
    [`${S}/x/user.ts`, user],
    ...Object.entries(extra),
  ]), options)
}
const CLEAN_USER = `
import { FooError, CauseOnlyError } from './errors'
export function fail(id: string, input: { name: string }) {
  if (!id) throw new FooError('id is required')
  throw new FooError(\`Unknown name \${input.name} for \${id}\`)
}
export async function run(op: () => Promise<void>) {
  try {
    await op()
  } catch (error) {
    if (error instanceof FooError) throw error
    throw new CauseOnlyError(error)
  }
}
export function chosen(error: { constraint?: unknown }) {
  const constraint = error.constraint
  return new FooError(constraint === 'one_per_org' ? 'This organization already has one' : 'A row with this name exists')
}
`

describe('self-tests: the scanner on in-memory sources', () => {
  it('baseline: clean constructions, an exempt cause argument and a comparison-only use are not flagged; counts are found', () => {
    const scan = synthetic(CLEAN_USER)
    expect(scan.failures).toEqual([])
    expect([...scan.lists.keys()]).toEqual([`${S}/x/lists.ts SAMPLE_FIXED_SENTENCES`])
    expect(scan.violations).toEqual([])
    expect(scan.unplaced).toEqual([])
    expect(scan.exemptionFailures).toEqual([])
    expect(countsByClass(scan)).toEqual({ CauseOnlyError: 1, FooError: 3 })
  })

  const RULE_CASES: Array<[string, string, string]> = [
    ['(a) .message read', `export const f = (err: Error) => new FooError(err.message)`, '(a) reads .message'],
    ['(a) .stack read', `export const f = (err: Error) => new FooError(\`x \${err.stack}\`)`, '(a) reads .stack'],
    ['(a) errmsg read', `export const f = (body: any) => new FooError(body.errmsg)`, '(a) reads .errmsg'],
    ['(a) responseBody read', `export const f = (e: any) => new FooError(JSON.stringify(e.responseBody))`, '(a) reads .responseBody'],
    ['(a) .detail read (bracket)', `export const f = (e: any) => new FooError(e['detail'])`, "(a) reads ['detail']"],
    ['(a) .cause read', `export const f = (e: any) => new FooError(String(e.cause))`, '(a) reads .cause'],
    ['(a) through a local', `export function f(e: Error) { const text = e.message; return new FooError(text) }`, '(a) reads .message via `text`'],
    ['(a) through destructuring', `export function f(e: Error) { const { message } = e; return new FooError(message) }`, '(a) destructures message'],
    ['(a) through a later assignment', `export function f(e: Error) { let t = 'x'; t = e.message; return new FooError(t) }`, '(a) reads .message via `t`'],
    ['(a) through a same-file helper parameter', `function fail(reason: string): never { throw new FooError(reason) }\nexport function g(e: Error) { fail(e.message) }`, '(a) reads .message via `reason` from'],
    ['(b) catch binding passed', `export function f() { try { g() } catch (error) { throw new FooError(error as string) } }`, '(b) passes caught `error`'],
    ['(b) catch binding with an unusual name', `export function f() { try { g() } catch (oops) { throw new FooError(describe(oops)) } }`, '(b) passes caught `oops`'],
    ['(b) destructured catch binding', `export function f() { try { g() } catch ({ code }) { throw new FooError(code) } }`, '(b) passes caught `code`'],
    ['(b) through a local', `export function f() { try { g() } catch (e) { const t = render(e); throw new FooError(t) } }`, '(b) passes caught `e` via `t`'],
    ['(b) .catch callback', `export const f = (p: Promise<void>) => p.catch((e) => { throw new FooError(e) })`, '(b) passes caught `e`'],
    ['(b) .catch with a named handler', `function handler(problem: unknown) { return new FooError(problem as string) }\nexport const f = (p: Promise<void>) => p.catch(handler)`, '(b) passes caught `problem`'],
    ['(b) .on(\'error\') listener', `export const f = (s: any) => s.on('error', (e: unknown) => { throw new FooError(e as string) })`, '(b) passes caught `e`'],
    ['(c) String(caught)', `export function f() { try { g() } catch (error) { throw new FooError(String(error)) } }`, '(c) interpolates caught `error`'],
    ['(c) template of caught', `export function f() { try { g() } catch (error) { throw new FooError(\`failed: \${error}\`) } }`, '(c) interpolates caught `error`'],
    ['(c) .then(_, cb) template', `export const f = (p: Promise<void>) => p.then(() => 1, (e) => new FooError(\`x \${e}\`))`, '(c) interpolates caught `e`'],
    ['(d) .message rewritten after construction', `export function f(t: string) { const e = new FooError('x'); e.message = t; throw e }`, '(d) .message rewritten after construction'],
    ['(d) Object.assign over a fresh instance', `export const f = (t: string) => Object.assign(new FooError('x'), { message: t })`, '(d) the instance is handed to Object.assign'],
  ]
  it.each(RULE_CASES)('%s fires', (_label, body, expected) => {
    const scan = synthetic(`import { FooError } from './errors'\n${body}\n`)
    expect(scan.violations.some((v) => v.includes(expected)), scan.violations.join('\n')).toBe(true)
  })

  it('a catch binding is resolved by SYMBOL: a same-named inner parameter is not a caught value', () => {
    const scan = synthetic(`import { FooError } from './errors'
export function f() {
  try { g() } catch (error) {
    const build = (error: string) => new FooError(error)
    return build('a fixed sentence')
  }
}
export const h = (error: string) => new FooError(error)
`)
    expect(scan.violations).toEqual([])
  })

  it('aliases are followed: an import alias, a namespace import, require destructuring and an export-as re-export', () => {
    const scan = synthetic(`import { FooError as Shown } from './errors'
import * as errs from './errors'
import { Renamed } from './barrel'
const { FooError: Cjs } = require('./errors')
export const a = (e: Error) => new Shown(e.message)
export const b = (e: Error) => new errs.FooError(e.message)
export const c = (e: Error) => new Renamed(e.message)
export const d = (e: Error) => new Cjs(e.message)
`, { [`${S}/x/barrel.ts`]: `export { FooError as Renamed } from './errors'\n` })
    const lines = scan.violations.filter((v) => v.includes('(a) reads .message')).map((v) => v.split(' ')[0])
    expect(lines).toEqual([`${S}/x/user.ts:5`, `${S}/x/user.ts:6`, `${S}/x/user.ts:7`, `${S}/x/user.ts:8`])
  })

  it('a subclass of a listed class is red (declaration, `extends ns.X`, class expression); an allowed one has its super(…) checked', () => {
    const user = `import { FooError } from './errors'
import * as errs from './errors'
export class SubError extends FooError {
  constructor(e: Error) { super(e.message) }
}
export class NsSub extends errs.FooError {}
export const Expr = class extends FooError {}
`
    const scan = synthetic(user)
    expect(scan.subclasses.map((s) => s.key)).toEqual([`${S}/x/user.ts :: SubError`, `${S}/x/user.ts :: NsSub`, `${S}/x/user.ts :: Expr`])
    const allowed = synthetic(user, {}, { ...SYNTHETIC_OPTIONS, allowedSubclasses: { [`${S}/x/user.ts :: SubError`]: 'synthetic' } })
    expect(allowed.violations.some((v) => v.includes('super(…) of SubError extends FooError argument 1: (a) reads .message'))).toBe(true)
    expect(countsByClass(allowed).FooError).toBe(1)
  })

  it('a listed class\'s OWN super(…) is held to the same rules', () => {
    const scan = synthetic('', {
      [`${S}/x/errors.ts`]: ERRORS.replace('super(message)', 'super((message as unknown as Error).message)'),
    })
    expect(scan.violations.some((v) => v.includes("FooError's own super(…) argument 1: (a) reads .message"))).toBe(true)
  })

  it('backstop: a value reference outside the known positions is unplaced', () => {
    const scan = synthetic(`import { FooError } from './errors'
const C = FooError
export const a = (m: string) => new C(m)
export const b = (m: string) => Reflect.construct(FooError, [m])
export const c = { FooError }
`)
    expect(scan.unplaced.map((u) => u.split(' (')[0])).toEqual([
      `${S}/x/user.ts:2 FooError`, `${S}/x/user.ts:4 FooError`, `${S}/x/user.ts:5 FooError`,
    ])
  })

  it('list discovery: spreads and inline lists are followed; a non-array list or an unknown consumer fails closed', () => {
    const spread = synthetic('', {
      [`${S}/x/more.ts`]: `import { BarError } from './errors'
import { SAMPLE_FIXED_SENTENCES } from './lists'
import type { FixedSentenceErrorClass } from './failure-text'
const LOCAL: readonly FixedSentenceErrorClass[] = [BarError]
const WIDER: readonly FixedSentenceErrorClass[] = [...LOCAL]
export const t = (e: unknown) => classify(e, { fallback: 'x', fixedSentenceClasses: [BarError] })
export const u = (e: unknown) => classify(e, { fallback: 'x', fixedSentenceClasses: WIDER })
`,
    })
    expect(spread.failures).toEqual([])
    expect(spread.lists.get(`${S}/x/more.ts WIDER`)).toEqual(['BarError'])
    expect(spread.lists.get(`${S}/x/more.ts inline#1`)).toEqual(['BarError'])
    expect(spread.classes).toContain('BarError')

    const frozen = synthetic('', {
      [`${S}/x/more.ts`]: `import { BarError } from './errors'
import type { FixedSentenceErrorClass } from './failure-text'
export const FROZEN: readonly FixedSentenceErrorClass[] = Object.freeze([BarError])
export const t = (e: unknown, list: unknown[]) => classify(e, { fallback: 'x', fixedSentenceClasses: list as never })
`,
    })
    expect(frozen.failures.some((f) => f.includes('allow-list FROZEN is not an array literal'))).toBe(true)
    expect(frozen.failures.some((f) => f.includes('neither a discovered list nor a pass-through parameter'))).toBe(true)
  })

  it('an exemption is re-verified: a constructor that lets the exempt argument reach the message breaks it', () => {
    const broken = synthetic(CLEAN_USER, {
      [`${S}/x/errors.ts`]: ERRORS.replace("super('A fixed sentence.')", 'super(String(cause))'),
    })
    expect(broken.exemptionFailures.some((f) => f.includes('CauseOnlyError: exempt parameter `cause`'))).toBe(true)
    // Without the exemption the catch binding handed to it is red by rule (b).
    const unexempt = synthetic(CLEAN_USER, {}, { ...SYNTHETIC_OPTIONS, argumentsOutsideMessage: {} })
    expect(unexempt.violations.some((v) => v.includes('new CauseOnlyError(…) argument 1: (b) passes caught `error`'))).toBe(true)
  })

  it('a class added to a list is picked up by itself: its constructions are counted and checked', () => {
    const user = `import { BarError } from './errors'\nexport const f = (e: Error) => new BarError(e.message)\n`
    expect(countsByClass(synthetic(user))).not.toHaveProperty('BarError')
    expect(synthetic(user).violations).toEqual([])
    const widened = synthetic(user, { [`${S}/x/lists.ts`]: LISTS.replace('[FooError, CauseOnlyError]', '[FooError, CauseOnlyError, BarError]') })
    expect(countsByClass(widened).BarError).toBe(1)
    expect(widened.violations.some((v) => v.includes('new BarError(…) argument 1: (a) reads .message'))).toBe(true)
  })
})
