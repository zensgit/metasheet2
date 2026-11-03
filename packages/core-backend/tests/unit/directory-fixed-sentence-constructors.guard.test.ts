/**
 * R-41 follow-up — tripwire for the FIXED-SENTENCE allow-lists of directory/directory-failure-text.ts.
 *
 * WHY. classifyDirectoryFailureText shows a caught error's OWN message only when the error is an instance of a
 * class on the caller's allow-list (`fixedSentenceClasses`): DINGTALK_CONFIG_FIXED_SENTENCES and
 * DIRECTORY_TEST_FIXED_SENTENCES (routes/admin-directory.ts), DIRECTORY_FAILURE_FIXED_SENTENCES
 * (directory/directory-sync.ts) and an inline list in routes/admin-directory.ts. That is safe only while every
 * listed instance carries a literal, the caller's own input or our own ids — which R-41 checked by hand. One
 * `new DirectoryValidationError(err.message)` (or one caught listed instance enriched in place with driver text)
 * would put provider / driver / transport text back into an admin body, a persisted column or the outbound
 * DingTalk alert, with every R-41 test still green.
 *
 * HOW. TypeScript compiler API, one program per scan (noResolve / noLib, so identifiers resolve to their LOCAL
 * declarations: a catch binding is told apart from a same-named parameter by symbol, not by name). A key spelled
 * statically — a string literal, a `+` concatenation of them, a template of static parts (`'mess' + 'age'`) — counts
 * as that key everywhere below.
 *  1. LISTS are read FROM SOURCE, never hard-coded here, scanning EVERY file (no word pre-filter): every variable
 *     typed `…FixedSentenceErrorClass…`, every array literal in a `fixedSentenceClasses:` position, and every array
 *     literal passed where a same-file function declares a `FixedSentenceErrorClass` parameter. Elements may be
 *     classes (imported names are traced to their exported name) or spreads of another list. It FAILS CLOSED on: a
 *     list that is not an array literal; an element that is neither a class name nor a spread of a list; a consumer
 *     position fed by something that is neither a list nor the list parameter of a followed pass-through; a list
 *     constant that is exported or referenced anywhere but a consumer position or a spread into another list
 *     (`(LIST as any).push(X)`, handing it elsewhere); a function with a `FixedSentenceErrorClass` parameter that is
 *     exported, re-exported, referenced as a value, or is a method / callback / anonymous function — only direct
 *     same-file calls are followed, so a cross-file caller could hand it an inline list unseen; such a pass-through's
 *     list PARAMETER used other than as a consumer value (a `fixedSentenceClasses` value, or the list argument of a
 *     direct same-file pass-through call) — reassigned, `.push`ed, spread, aliased; `fixedSentenceClasses` written as
 *     a property or spelled as a string, whole or concatenated (computed keys, element access, reflective writes);
 *     and at the SINK: a classifyDirectoryFailureText call whose options are not an inline object or carry a spread
 *     or computed key, the classifier used as a value or re-exported, or `export *` from its module. Adding a class
 *     to a list therefore extends this guard by itself.
 *  2. CONSTRUCTIONS. Every `new <Listed>(…)` (aliases, `ns.Listed`, `require` destructuring and `export { X as Y }`
 *     re-exports included), every `super(…)` inside a subclass of a listed class, and every listed class's OWN
 *     `super(…)` — across packages/core-backend/src and plugins/<name>/lib, plugins/<name>/index.cjs — has each
 *     argument checked; and `arguments` read anywhere in a listed class's constructor is red (it reaches the message
 *     without a parameter name). It is RED when the value of an argument
 *       (a) reads `.message` / `.stack` / `.errmsg` / `.responseBody` / `.detail` / `.cause` / `.hint` / `.where` /
 *           `.reason` (dot, static-string bracket, or destructuring);
 *       (b) references a binding introduced by `catch (x)`, by the first parameter of a `.catch(cb)` /
 *           `.then(_, cb)` callback, or of an `.on('error' | <non-literal event>, cb)` listener (resolved by symbol);
 *       (c) — the same, through `String(x)` or a template interpolation (reported separately).
 *     The value is followed through same-file locals and module-level bindings: their initializer, every
 *     assignment (`=`, `+=`, `||=`, `??=`, `&&=`), every write into them (`x.p = v`, `x[k] = v` — key and value),
 *     every mutating call on them (`push` / `unshift` / `splice` / `set` / `add` / `fill` / `append`, on the
 *     binding or a member path rooted at it) and `Object.assign(x, …)`; destructuring included. Parameters of
 *     same-file functions are followed to the arguments of their same-file call sites, to their default value and
 *     to writes into them. A call to anything is walked into its callee expression and its arguments (never into
 *     the callee's body). Positions that cannot carry text are not followed: the condition of `?:`, comparisons,
 *     `!`, `typeof`.
 *  3. MESSAGE REWRITES. (d) Every write of `message` / `stack` on any target other than `this` anywhere in the
 *     scanned tree (every file parsed) — `x.message = …` (and compound / bracket / destructuring-assignment forms),
 *     `Object.defineProperty(x, 'message', …)`, `Object.defineProperties(x, { message })`,
 *     `Object.assign(x, { message })`, `Reflect.set` / `Reflect.defineProperty(x, 'message', …)` — is pinned in
 *     ALLOWED_MESSAGE_REWRITES with a reason; a new one is red whatever the target (a caught, instanceof-narrowed
 *     listed instance enriched in place is the realistic case). Every `this.message` / `this.stack` write outside a
 *     listed class is pinned the same way in ALLOWED_THIS_MESSAGE_REWRITES (none today). A fresh listed instance
 *     handed to Object.assign / defineProperty / Reflect.set is red outright. Inside a listed class, a
 *     `this.message` / `this.stack` write in the constructor has its value held to rules (a)–(c); anywhere else in
 *     the class, and a `message` / `stack` / `toString` member, is red.
 *  4. SUBCLASSES of a listed class anywhere are red unless in ALLOWED_SUBCLASSES (empty — a subclass can carry any
 *     message and inherits the `instanceof`).
 *  5. BACKSTOP: every VALUE reference to a listed class must be a `new` callee, an `extends` target, the right side
 *     of `instanceof`, an import / export specifier or an element of a discovered list. `const C = Listed;
 *     new C(m)`, `Reflect.construct(Listed, …)` or handing the class to a factory is red.
 *  6. ARGUMENTS_OUTSIDE_MESSAGE exempts one `new <Listed>(…)` argument position (and the same position of a
 *     subclass's `super(…)`, which calls that constructor) that, by the class's own constructor, never reaches the
 *     message. It is re-verified on every run against the WHOLE constructor — body AND parameter list, so another
 *     parameter's default (`text = String(cause)`) counts: the exempt parameter may appear only as
 *     `Object.assign(this, { cause })` or in a comparison with `undefined` (RecoveryConflictError keeps its argument
 *     only as `cause`). It never applies to the class's OWN `super(…)`, which is Error's message, and `arguments`
 *     (rule 2) cannot route around it.
 *  7. Non-vacuity: the discovered list keys are pinned exactly; the per-class construction counts are LOWER bounds
 *     over an EXACT set of classes (concurrent additions merge cleanly, a lost site or a newly listed class is
 *     red); every listed class must be declared exactly once; each exemption is shown load-bearing on the real
 *     tree. The two rewrite censuses (rule 3) are exact.
 *
 * NOT COVERED, deliberately (each is a value the guard cannot see into today; the named sites are values-free by
 * inspection):
 *  - classes whose message a route echoes through its own `instanceof` branch and NOT through the classifier: this
 *    guard's family is the classes on the lists only. Today nine — LocalDirectoryMembershipHistoryError (slice C,
 *    #6079; a fixed sentence, no parameter) / LocalDirectoryValidationError /
 *    LocalDirectoryNotFoundError / LocalDirectoryConflictError (routes/admin-directory-local.ts:81-96),
 *    OrgTransferValidationError / OrgTransferNotFoundError / OrgTransferConflictError
 *    (routes/admin-directory-org-transfers.ts:98-107), DirectorySyncInProgressError and
 *    DirectorySyncFrozenByTransferError (routes/admin-directory.ts:729-781) — answer `error.message` as it is;
 *  - values parked on a global or shared object and read back (`globalThis.lastError`, `process.x`, a module
 *    namespace): only rule (a)'s property names on the read path catch them;
 *  - function RETURN values, same-file or not: a call is walked into its arguments, not into the callee's body.
 *    Following bodies would make the walk property-insensitive in the wrong direction — `new
 *    LoginAliasClaimError(result.code, result.kind)` (auth/login-alias-service.ts:177, :248) would reach
 *    claimLoginAlias's catch branch, whose `message` does carry driver text but is never read there. Sites resting
 *    on a return value today: login-alias-service.ts:177, :248 (claimNonEmptyLoginAliases → mapClaimFailure:
 *    fixed codes), security/encrypted-secrets.ts:153 `new EncryptionMaterialError(issues)` (getEncryptionMaterialIssues
 *    push-accumulates literals), directory/directory-sync.ts `new PasswordPolicyError(passwordValidation.errors)`
 *    (validatePassword in auth/password-policy.ts: fixed policy sentences);
 *  - values from other FILES: an exported helper's parameter, imported constants or module state, `this.x` fields;
 *  - aliasing through calls: a local mutated by a function it was handed to (`collect(parts)`);
 *  - property names that are not static strings: a key held in a variable (`const k = 'message'; e[k] = t`,
 *    `Object.defineProperty(e, k, …)`), `Object.assign(e, source)` with a non-literal source, aliased `Object` /
 *    `Reflect` (`const { assign } = Object`), and the classifier's module reached through a path built at runtime
 *    (`await import(dir + name)`);
 *  - error values that arrive other than through `catch` / `.catch` / `.then(_, cb)` / `.on(…)`: node-style
 *    callbacks `(err, result) => …`, custom rejection hooks (Promise.allSettled results are covered only through
 *    their `.reason` reads, rule a).
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

/** (a): property reads that carry provider, driver, transport or caught text (pg's `detail` / `hint` / `where`, allSettled's `reason`). */
const TEXT_PROPERTIES: ReadonlySet<string> = new Set(['message', 'stack', 'errmsg', 'responseBody', 'detail', 'cause', 'hint', 'where', 'reason'])
/** (d): properties whose rewrite changes what the classifier shows. */
const MESSAGE_PROPERTIES: ReadonlySet<string> = new Set(['message', 'stack'])
/** Mutating calls whose arguments flow into the binding they are called on (`splice` from its third argument). */
const MUTATING_METHODS: ReadonlySet<string> = new Set(['push', 'unshift', 'splice', 'set', 'add', 'fill', 'append'])

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
 * vacuous. Each count is a LOWER BOUND (found >= pinned): a class whose sites stop being found is red, while two
 * concurrent changes that each add a site merge cleanly (an exact pin bumped 41→42 in both would leave main at 43
 * and red — main merges with strict=false and no queue). The SET of classes is exact: a class added to or dropped
 * from a list is red until pinned or unpinned here. Lower a count in the same change that removes sites.
 */
const EXPECTED_CONSTRUCTION_COUNTS: Readonly<Record<string, number>> = {
  DingTalkConfigValidationError: 9,
  DingTalkCorpNotAllowedError: 2,
  DirectoryConflictError: 19,
  DirectoryNotFoundError: 10,
  DirectorySyncLeaseLostError: 1,
  DirectoryTenantChangeBlockedError: 1,
  DirectoryUserPaginationError: 1,
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
/** `new <Listed>(…)` argument positions that never reach the message — each re-verified against the constructor. */
const ARGUMENTS_OUTSIDE_MESSAGE: Readonly<Record<string, ArgumentExemption>> = {
  RecoveryConflictError: {
    index: 0,
    reason: 'db/recovery-conflict.ts: the constructor calls super(RECOVERY_CONFLICT_HTTP_MESSAGE) and keeps its one argument (the 40001 driver error translateRecoveryConflict caught) only as `cause`; the classifier reads `.message` alone.',
  },
}

interface RewriteAllowance { count: number; reason: string }
/** Every `message` / `stack` write on a non-`this` target in the scanned tree: `<file> :: <form>` → count + why. */
const ALLOWED_MESSAGE_REWRITES: Readonly<Record<string, RewriteAllowance>> = {
  [`${CORE_SRC}/multitable/field-codecs.ts :: confirm.message =`]: {
    count: 1,
    reason: 'A button field\'s confirm-dialog config object (`{ enabled, message }`) being normalised from the field property; not an error.',
  },
  [`${CORE_SRC}/routes/admin-failure-envelope.ts :: wrapped.stack =`]: {
    count: 1,
    reason: 'toLoggableError wraps a non-Error thrown value in a plain `new Error(…)` for the LOG only and restores that value\'s own stack; a plain Error is on no allow-list.',
  },
}

/**
 * `this.message` / `this.stack` writes OUTSIDE the listed classes (whose own writes the construction rules hold):
 * `<file> :: this.<prop> in <class>` → count + why. Empty today — exact, so a new one is red.
 */
const ALLOWED_THIS_MESSAGE_REWRITES: Readonly<Record<string, RewriteAllowance>> = {}

/** Problems of found construction counts against the pins: an exact class set, each count a lower bound. */
function constructionPinProblems(found: Readonly<Record<string, number>>, pinned: Readonly<Record<string, number>>): string[] {
  const problems: string[] = []
  for (const cls of Object.keys(found).sort()) {
    if (!(cls in pinned)) problems.push(`${cls}: on a list but not pinned (${found[cls]} constructions found) — pin it`)
    else if (found[cls] < pinned[cls]) problems.push(`${cls}: ${found[cls]} constructions found, pinned at least ${pinned[cls]} — sites stopped being found (or lower the pin in the change that removed them)`)
  }
  for (const cls of Object.keys(pinned).sort()) if (!(cls in found)) problems.push(`${cls}: pinned but on no list — remove the pin`)
  return problems
}

// ── scanner: pure functions of (repo-relative path → text), shared by the real tree and the self-tests ─────

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
const LISTENER_METHODS: ReadonlySet<string> = new Set(['on', 'once', 'addListener', 'prependListener', 'prependOnceListener'])

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

const relOf = (sf: ts.SourceFile) => (sf.fileName.startsWith(VROOT) ? sf.fileName.slice(VROOT.length) : sf.fileName)
const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
const at = (node: ts.Node) => `${relOf(node.getSourceFile())}:${lineOf(node)}`
const snippet = (node: ts.Node) => node.getText().replace(/\s+/g, ' ').slice(0, 60)

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
const isExported = (decl: ts.Declaration) => (ts.getCombinedModifierFlags(decl) & (ts.ModifierFlags.Export | ts.ModifierFlags.Default)) !== 0
/**
 * The string an expression spells statically: a string literal, a `+` concatenation of such strings, or a template
 * whose substitutions are themselves static (`'mess' + 'age'`, `\`fixed${'Sentence'}Classes\``) — so a key cannot
 * dodge a rule by being cut in two. Undefined for anything else (an identifier holding a string is not followed).
 */
const literalText = (e: ts.Node | undefined): string | undefined => {
  if (!e) return undefined
  const u = ts.isExpression(e as ts.Expression) ? unwrap(e as ts.Expression) : e
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(u.left)
    const right = literalText(u.right)
    return left !== undefined && right !== undefined ? left + right : undefined
  }
  if (ts.isTemplateExpression(u)) {
    let out = u.head.text
    for (const span of u.templateSpans) {
      const part = literalText(span.expression)
      if (part === undefined) return undefined
      out += part + span.literal.text
    }
    return out
  }
  return undefined
}
const isStaticStringExpression = (n: ts.Node) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)
  || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken)
function inTypePosition(node: ts.Node): boolean {
  for (let p = node.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isTypeNode(p)) return true
    if (ts.isStatement(p) || ts.isBlock(p)) return false
  }
  return false
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

// ── message / stack rewrites (rule d) — syntactic, shared by the tree-wide census and the listed-class check ──

interface MessageRewrite { prop: string; target: ts.Expression; value: ts.Node | undefined; form: string }

/** `x.message` / `x['stack']` → its target and property. */
function messageAccess(e: ts.Expression): { target: ts.Expression; prop: string } | undefined {
  const u = unwrap(e)
  if (ts.isPropertyAccessExpression(u) && MESSAGE_PROPERTIES.has(u.name.text)) return { target: u.expression, prop: u.name.text }
  if (ts.isElementAccessExpression(u)) {
    const key = literalText(u.argumentExpression)
    if (key && MESSAGE_PROPERTIES.has(key)) return { target: u.expression, prop: key }
  }
  return undefined
}

/** The `message` / `stack` members of an object literal (property, shorthand, method, accessor; literal or computed-literal key). */
function messageMembersOf(obj: ts.Node | undefined): Array<{ prop: string; value: ts.Node }> {
  if (!obj || !ts.isExpression(obj as ts.Expression)) return []
  const o = unwrap(obj as ts.Expression)
  if (!ts.isObjectLiteralExpression(o)) return []
  const out: Array<{ prop: string; value: ts.Node }> = []
  for (const p of o.properties) {
    if (!p.name) continue
    const key = ts.isComputedPropertyName(p.name) ? literalText(p.name.expression)
      : ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNoSubstitutionTemplateLiteral(p.name) ? p.name.text : undefined
    if (key && MESSAGE_PROPERTIES.has(key)) out.push({ prop: key, value: ts.isPropertyAssignment(p) ? p.initializer : p })
  }
  return out
}

function messageRewritesAt(node: ts.Node): MessageRewrite[] {
  if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
    const left = unwrap(node.left)
    const direct = messageAccess(left)
    if (direct) return [{ ...direct, value: node.right, form: `${snippet(direct.target)}.${direct.prop} =` }]
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left))) {
      const out: MessageRewrite[] = []
      const pattern = (p: ts.Expression): void => {
        const u = unwrap(p)
        const access = messageAccess(u)
        if (access) {
          out.push({ ...access, value: node.right, form: `destructuring ${snippet(access.target)}.${access.prop} =` })
          return
        }
        if (ts.isObjectLiteralExpression(u)) {
          for (const el of u.properties) {
            if (ts.isPropertyAssignment(el)) pattern(el.initializer)
            else if (ts.isSpreadAssignment(el)) pattern(el.expression)
          }
        } else if (ts.isArrayLiteralExpression(u)) {
          for (const el of u.elements) pattern(ts.isSpreadElement(el) ? el.expression : el)
        } else if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          pattern(u.left)
        }
      }
      pattern(left)
      return out
    }
    return []
  }
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression)
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return []
    const fn = `${callee.expression.text}.${callee.name.text}`
    const [target, second, third] = node.arguments
    if (!target) return []
    if (fn === 'Object.defineProperty' || fn === 'Reflect.defineProperty' || fn === 'Reflect.set') {
      const key = literalText(second)
      return key && MESSAGE_PROPERTIES.has(key) ? [{ prop: key, target, value: third, form: `${fn}(${snippet(target)}, '${key}')` }] : []
    }
    if (fn === 'Object.defineProperties') {
      return messageMembersOf(second).map((m) => ({ prop: m.prop, target, value: m.value, form: `${fn}(${snippet(target)}, { ${m.prop} })` }))
    }
    if (fn === 'Object.assign') {
      return node.arguments.slice(1).flatMap((source) => messageMembersOf(source))
        .map((m) => ({ prop: m.prop, target, value: m.value, form: `Object.assign(${snippet(target)}, { ${m.prop} })` }))
    }
  }
  return []
}
const isThisTarget = (e: ts.Expression) => unwrap(e).kind === ts.SyntaxKind.ThisKeyword

/**
 * (d) tree-wide, every file parsed (no word pre-filter: `e['mess' + 'age'] = …` spells neither word): every
 * `message` / `stack` write on a non-`this` target, `<file> :: <form>` → count.
 */
function censusMessageRewrites(files: SourceMap): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, scriptKindOf(rel))
    walk(sf, (node) => {
      for (const r of messageRewritesAt(node)) {
        if (isThisTarget(r.target)) continue
        const key = `${rel} :: ${r.form}`
        out[key] = (out[key] ?? 0) + 1
      }
    })
  }
  return out
}

/**
 * (d) tree-wide, `this` targets: every `this.message` / `this.stack` write with the class it sits in (`<no class>`
 * outside one), `<file> :: this.<prop> in <class>` → class + count. A listed class's own writes are held to the
 * construction rules instead; the real-tree test pins the rest (none today) so a new one is red.
 */
function censusThisMessageRewrites(files: SourceMap): Map<string, { cls: string; count: number }> {
  const out = new Map<string, { cls: string; count: number }>()
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, scriptKindOf(rel))
    walk(sf, (node) => {
      for (const r of messageRewritesAt(node)) {
        if (!isThisTarget(r.target)) continue
        let cls = '<no class>'
        for (let p = node.parent; p; p = p.parent) {
          if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
            cls = p.name?.text ?? (ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name) ? p.parent.name.text : '<anonymous class>')
            break
          }
        }
        const key = `${rel} :: this.${r.prop} in ${cls}`
        out.set(key, { cls, count: (out.get(key)?.count ?? 0) + 1 })
      }
    })
  }
  return out
}

// ── phase 1: the allow-lists ────────────────────────────────────────────────────────────────────────────────

interface ListDiscovery { lists: Map<string, string[]>; listArrays: Set<ts.ArrayLiteralExpression>; failures: string[] }

/** The classifier the lists feed; its call sites are the sink every list must reach through (rule 1). */
const CLASSIFIER = 'classifyDirectoryFailureText'
const CLASSIFIER_MODULE = 'directory-failure-text'

function discoverLists(files: SourceMap): ListDiscovery {
  // Every file: a word pre-filter would let `{ ['fixed' + 'SentenceClasses']: … }` skip the scan.
  const program = buildProgram(files, [...files.keys()])
  const checker = program.getTypeChecker()
  const failures: string[] = []
  const listArrays = new Set<ts.ArrayLiteralExpression>()
  /** declaration node of a named list → its key and array. */
  const named = new Map<ts.Node, { key: string; array: ts.ArrayLiteralExpression }>()
  const inline: Array<{ key: string; array: ts.ArrayLiteralExpression }> = []
  const noReexports = new Map<string, string>()
  const symbolOfReference = (id: ts.Identifier) => (ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
    ? checker.getShorthandAssignmentValueSymbol(id.parent)
    : checker.getSymbolAtLocation(id))

  for (const sf of program.getSourceFiles()) {
    const rel = relOf(sf)
    let inlineCount = 0
    const fixedParams = new Map<ts.Symbol, number[]>()
    const passThroughs: Array<{ sym: ts.Symbol; name: ts.Identifier; fn: ts.SignatureDeclaration; params: ts.ParameterDeclaration[] }> = []
    const consumers: ts.Expression[] = []
    const fileLists: Array<{ decl: ts.VariableDeclaration; name: ts.Identifier }> = []
    walk(sf, (node) => {
      if (ts.isVariableDeclaration(node) && typeMentionsFixedSentence(node.type) && ts.isIdentifier(node.name)) {
        const init = node.initializer ? unwrap(node.initializer) : undefined
        if (init && ts.isArrayLiteralExpression(init)) {
          named.set(node, { key: `${rel} ${node.name.text}`, array: init })
          fileLists.push({ decl: node, name: node.name })
          if (isExported(node)) failures.push(`${at(node)} allow-list ${node.name.text} is exported — what other files do with it is not seen`)
        } else {
          failures.push(`${at(node)} allow-list ${node.name.text} is not an array literal — the guard cannot read it`)
        }
      }
      if (isFunctionLike(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
        const indexes = node.parameters.map((p, i) => (typeMentionsFixedSentence(p.type) ? i : -1)).filter((i) => i >= 0)
        if (indexes.length > 0) {
          const nameNode = ts.isFunctionDeclaration(node) ? node.name
            : (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name) ? node.parent.name
              : undefined
          const declNode = ts.isFunctionDeclaration(node) ? node : nameNode ? (node.parent as ts.VariableDeclaration) : undefined
          const sym = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined
          if (!nameNode || !declNode || !sym) {
            failures.push(`${at(node)} a FixedSentenceErrorClass parameter on a method, callback or anonymous function — only named same-file functions are followed`)
          } else if (isExported(declNode)) {
            failures.push(`${at(node)} ${nameNode.text} takes a FixedSentenceErrorClass parameter and is exported — a caller in another file could hand it a list unseen`)
          } else {
            fixedParams.set(sym, indexes)
            passThroughs.push({ sym, name: nameNode, fn: node, params: indexes.map((i) => node.parameters[i]) })
          }
        }
      }
      if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && node.name.getText() === 'fixedSentenceClasses') {
        consumers.push(ts.isPropertyAssignment(node) ? node.initializer : node.name)
      }
      // Spelled as a string — also cut in pieces ('fixed' + 'SentenceClasses') — it is a computed key, an element
      // access or a reflective write; none is followed.
      if (isStaticStringExpression(node) && literalText(node) === 'fixedSentenceClasses') {
        failures.push(`${at(node)} 'fixedSentenceClasses' spelled as a string (computed key, element access or reflective write) — not followed`)
      }
      if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
        const left = unwrap(node.left)
        if (ts.isPropertyAccessExpression(left) && left.name.text === 'fixedSentenceClasses') {
          failures.push(`${at(node)} fixedSentenceClasses assigned as a property — not followed`)
        }
      }
    })
    walk(sf, (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = unwrap(node.expression)
      const sym = ts.isIdentifier(callee) ? checker.getSymbolAtLocation(callee) : undefined
      const indexes = sym ? fixedParams.get(sym) : undefined
      for (const i of indexes ?? []) if (node.arguments[i]) consumers.push(node.arguments[i])
    })
    // A pass-through function is followed only through direct same-file calls: any other use fails closed.
    for (const { sym, name } of passThroughs) {
      walk(sf, (n) => {
        if (!ts.isIdentifier(n) || n === name || n.text !== name.text || inTypePosition(n)) return
        if (ts.isExportSpecifier(n.parent)) {
          failures.push(`${at(n)} ${name.text} (takes a FixedSentenceErrorClass parameter) is re-exported — a caller in another file could hand it a list unseen`)
          return
        }
        if (symbolOfReference(n) !== sym) return
        const ref = outermost(n)
        if (ts.isCallExpression(ref.parent) && ref.parent.expression === ref) return
        failures.push(`${at(n)} ${name.text} (takes a FixedSentenceErrorClass parameter) is used as a value (\`${snippet(ref.parent)}\`) — only direct same-file calls are followed`)
      })
    }
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
        // A parameter only when it is a list parameter of a FOLLOWED pass-through (named, same-file, not exported).
        if (decl && ts.isParameter(decl) && passThroughs.some((p) => p.params.includes(decl))) continue
      }
      failures.push(`${at(consumer)} a fixed-sentence consumer is fed by \`${consumer.getText()}\`, neither a discovered list nor a pass-through parameter`)
    }
    const consumerNodes = new Set<ts.Node>(consumers.map((c) => outermost(c)))
    // A pass-through's list PARAMETER is used only as a consumer value: a `fixedSentenceClasses` value or the list
    // argument of a direct same-file pass-through call. A reassignment, a member access (`.push`), a spread, an
    // alias or any other use fails closed — its contents would no longer be the caller's list.
    for (const { fn, name: fnName, params } of passThroughs) {
      for (const param of params) {
        if (!ts.isIdentifier(param.name)) {
          failures.push(`${at(param)} ${fnName.text}: a destructured FixedSentenceErrorClass parameter is not followed`)
          continue
        }
        const paramName = param.name
        const paramSym = checker.getSymbolAtLocation(paramName)
        walk(fn, (n) => {
          if (!ts.isIdentifier(n) || n === paramName || n.text !== paramName.text || inTypePosition(n)) return
          if (symbolOfReference(n) !== paramSym) return
          const ref = outermost(n)
          if (consumerNodes.has(ref) || consumerNodes.has(n)) return
          failures.push(`${at(n)} ${fnName.text}'s list parameter ${paramName.text} is used other than as a consumer value (\`${snippet(ref.parent)}\`) — a reassignment, mutation or alias is not followed`)
        })
      }
    }
    // The sink: every call of the classifier passes an inline options object (no spread, no computed key), and the
    // classifier is referenced only by direct calls — so no list reaches it through a value the guard cannot read.
    if (/classifyDirectoryFailureText|directory-failure-text/.test(sf.text)) {
      const classifierNames = new Set([CLASSIFIER])
      walk(sf, (n) => {
        if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === CLASSIFIER) classifierNames.add(n.name.text)
        if (ts.isBindingElement(n) && ts.isIdentifier(n.name) && ((n.propertyName ?? n.name) as ts.Identifier).text === CLASSIFIER) classifierNames.add(n.name.text)
        if (ts.isExportDeclaration(n) && !n.exportClause && n.moduleSpecifier && literalText(n.moduleSpecifier)?.includes(CLASSIFIER_MODULE)) {
          failures.push(`${at(n)} \`export *\` from the classifier module — a re-exported classifier is not followed`)
        }
      })
      walk(sf, (n) => {
        if (!ts.isIdentifier(n) || !classifierNames.has(n.text) || inTypePosition(n)) return
        const parent = n.parent
        if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return
        if (ts.isBindingElement(parent) && (parent.name === n || parent.propertyName === n)) return
        if (ts.isFunctionDeclaration(parent) && parent.name === n) return
        if (ts.isExportSpecifier(parent)) {
          failures.push(`${at(n)} ${CLASSIFIER} is re-exported — calls under another name are not followed`)
          return
        }
        const ref = outermost(ts.isPropertyAccessExpression(parent) && parent.name === n ? parent : n)
        const call = ref.parent
        if (!ts.isCallExpression(call) || call.expression !== ref) {
          failures.push(`${at(n)} ${CLASSIFIER} is used as a value (\`${snippet(ref.parent)}\`) — only direct calls are followed`)
          return
        }
        const options = call.arguments[1]
        if (!options) return
        const literal = unwrap(options)
        if (!ts.isObjectLiteralExpression(literal)) {
          failures.push(`${at(call)} ${CLASSIFIER} options are \`${snippet(options)}\`, not an inline object — its fixedSentenceClasses is not read`)
          return
        }
        for (const p of literal.properties) {
          if (ts.isSpreadAssignment(p) || (p.name && ts.isComputedPropertyName(p.name))) {
            failures.push(`${at(p)} ${CLASSIFIER} options carry \`${snippet(p)}\` (a spread or computed key) — not followed`)
          }
        }
      })
    }
    // A list constant is referenced only as a consumer value or spread into another list.
    const fileListArrays = new Set<ts.Node>([...named.values(), ...inline].map((l) => l.array))
    for (const { decl, name } of fileLists) {
      const sym = checker.getSymbolAtLocation(name)
      walk(sf, (n) => {
        if (!ts.isIdentifier(n) || n === name || n.text !== name.text || inTypePosition(n)) return
        if (ts.isExportSpecifier(n.parent)) {
          failures.push(`${at(n)} allow-list ${name.text} is re-exported — what other files do with it is not seen`)
          return
        }
        if (symbolOfReference(n) !== sym) return
        const ref = outermost(n)
        if (consumerNodes.has(ref) || consumerNodes.has(n)) return
        if (ts.isSpreadElement(ref.parent) && fileListArrays.has(ref.parent.parent)) return
        failures.push(`${at(n)} allow-list ${name.text} is referenced outside a consumer position (\`${snippet(ref.parent)}\`) — a mutation or hand-off is not followed`)
      })
      void decl
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

  // The files holding a discovered list, so the list arrays exist in this program too.
  const listFiles = [...new Set([...discovery.listArrays].map((a) => relOf(a.getSourceFile())))]
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

    // Per-file indexes: caught bindings, everything that flows into a binding, call sites.
    const caught = new Set<ts.Symbol>()
    const flowsInto = new Map<ts.Symbol, ts.Node[]>()
    const calls: ts.CallExpression[] = []
    const record = (sym: ts.Symbol | undefined, value: ts.Node | undefined) => {
      if (sym && value) flowsInto.set(sym, [...(flowsInto.get(sym) ?? []), value])
    }
    /** The binding a member path is rooted at: `x`, `x.a.b`, `x[k]` → x. */
    const rootSymbolOf = (expr: ts.Expression): ts.Symbol | undefined => {
      let e = unwrap(expr)
      while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) e = unwrap(e.expression)
      return ts.isIdentifier(e) ? checker.getSymbolAtLocation(e) : undefined
    }
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
          else if (LISTENER_METHODS.has(method) && node.arguments[0]) {
            const event = literalText(node.arguments[0])
            if (event === undefined || event === 'error') cb = node.arguments[1]
          }
          const param = firstParamOf(cb)
          if (param) addBinding(param.name)
          // Accumulators: a mutating call on a binding (or a member path rooted at it) flows its arguments in.
          if (MUTATING_METHODS.has(method)) {
            const root = rootSymbolOf(callee.expression)
            node.arguments.forEach((a, i) => { if (method !== 'splice' || i >= 2) record(root, a) })
          }
          if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Object' && method === 'assign' && node.arguments[0]) {
            const root = rootSymbolOf(node.arguments[0])
            for (const source of node.arguments.slice(1)) record(root, source)
          }
        }
      }
      if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
        const left = unwrap(node.left)
        if (ts.isIdentifier(left)) record(checker.getSymbolAtLocation(left), node.right)
        else if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          const root = rootSymbolOf(left)
          record(root, node.right)
          if (ts.isElementAccessExpression(left)) record(root, left.argumentExpression)
        }
      }
    })

    const calleeSymbol = (call: ts.CallExpression): ts.Symbol | undefined => {
      const callee = unwrap(call.expression)
      if (ts.isIdentifier(callee)) return checker.getSymbolAtLocation(callee)
      if (ts.isPropertyAccessExpression(callee)) return checker.getSymbolAtLocation(callee.name)
      return undefined
    }

    /** Findings for one VALUE (rules a–c), following same-file bindings and parameters. */
    const argumentFindings = (arg: ts.Node): string[] => {
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
          const key = literalText(node.argumentExpression)
          if (key && TEXT_PROPERTIES.has(key)) out.add(`(a) reads ['${key}']${via}`)
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
        for (const value of flowsInto.get(sym) ?? []) visit(value, textual, next)
        if (ts.isVariableDeclaration(decl)) {
          if (decl.initializer) visit(decl.initializer, textual, next)
          return
        }
        if (ts.isBindingElement(decl)) {
          const prop = decl.propertyName ?? decl.name
          if ((ts.isIdentifier(prop) || ts.isStringLiteral(prop)) && TEXT_PROPERTIES.has(prop.text)) out.add(`(a) destructures ${prop.text}${via}`)
          if (decl.initializer) visit(decl.initializer, textual, next)
          let root: ts.Node = decl
          while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent
          if (ts.isVariableDeclaration(root) && root.initializer) visit(root.initializer, textual, next)
          if (ts.isParameter(root)) parameter(root, textual, next)
          return
        }
        if (ts.isParameter(decl)) parameter(decl, textual, next)
      }
      const parameter = (param: ts.ParameterDeclaration, textual: boolean, via: string): void => {
        if (param.initializer) visit(param.initializer, textual, via)
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

    /** `exempt`: apply ARGUMENTS_OUTSIDE_MESSAGE — never for a listed class's OWN super(…) (Error's message). */
    const checkArguments = (args: readonly ts.Expression[], cls: string, label: string, node: ts.Node, exempt: boolean) => {
      const exemption = exempt ? options.argumentsOutsideMessage[cls] : undefined
      args.forEach((arg, i) => {
        if (exemption && exemption.index === i) return
        for (const finding of argumentFindings(arg)) violations.push(`${at(node)} ${label} argument ${i + 1}: ${finding}`)
      })
    }

    /** (d) for a fresh instance: handed to Object.assign / defineProperty / Reflect.set right away. */
    const checkFreshInstance = (newExpr: ts.NewExpression, cls: string) => {
      const outer = outermost(newExpr)
      const call = outer.parent
      if (!ts.isCallExpression(call) || call.arguments[0] !== outer) return
      const callee = unwrap(call.expression)
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && ['Object', 'Reflect'].includes(callee.expression.text)
        && ['assign', 'defineProperty', 'defineProperties', 'set'].includes(callee.name.text)) {
        violations.push(`${at(newExpr)} new ${cls}(…): (d) the instance is handed to ${callee.getText()} after construction`)
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
    /** The class member a node sits in (the constructor, a method, a field initializer, …). */
    const memberOf = (node: ts.Node, cls: ts.ClassLikeDeclaration): ts.Node | undefined => {
      for (let p: ts.Node | undefined = node; p && p !== cls; p = p.parent) if (p.parent === cls) return p
      return undefined
    }

    const checkListedClassBody = (node: ts.ClassDeclaration, name: string) => {
      const ctor = constructorOf(node)
      if (ctor) for (const call of superCallsIn(ctor)) checkArguments(call.arguments, name, `${name}'s own super(…)`, call, false)
      // `arguments` reaches the message without a parameter name, around every per-parameter rule and exemption.
      if (ctor) {
        walk(ctor, (n) => {
          if (!ts.isIdentifier(n) || n.text !== 'arguments' || inTypePosition(n)) return
          if (ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return
          violations.push(`${at(n)} ${name}'s constructor reads \`arguments\` — constructor arguments must reach the message by parameter name`)
        })
      }
      for (const member of node.members) {
        const memberName = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : undefined
        if (memberName && (MESSAGE_PROPERTIES.has(memberName) || memberName === 'toString')) {
          if (ts.isPropertyDeclaration(member) && member.initializer) {
            for (const finding of argumentFindings(member.initializer)) violations.push(`${at(member)} ${name}'s own field ${memberName}: ${finding}`)
          } else if (!ts.isPropertyDeclaration(member)) {
            violations.push(`${at(member)} ${name} overrides ${memberName} — its text is not a constructor argument the guard can check`)
          }
        }
      }
      walk(node, (n) => {
        for (const r of messageRewritesAt(n)) {
          if (!isThisTarget(r.target)) continue
          if (memberOf(n, node) === ctor && ctor) {
            for (const finding of r.value ? argumentFindings(r.value) : []) violations.push(`${at(n)} ${name}'s own this.${r.prop}: ${finding}`)
          } else {
            violations.push(`${at(n)} ${name}: (d) this.${r.prop} rewritten outside the constructor`)
          }
        }
      })
    }

    walk(sf, (node) => {
      // Declarations of the listed classes themselves.
      if (ts.isClassDeclaration(node) && node.name && listed.includes(node.name.text)) {
        const name = node.name.text
        declarations.set(name, [...(declarations.get(name) ?? []), at(node)])
        classDecls.set(`${rel} :: ${name}`, node)
        checkListedClassBody(node, name)
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
            checkArguments(call.arguments, parent, `super(…) of ${subName} extends ${parent}`, call, true)
          }
        }
      }
      // `new Listed(…)`.
      if (ts.isNewExpression(node)) {
        const cls = classNameOf(node.expression, checker, reexports)
        if (cls && family.has(cls)) {
          constructions.push({ file: rel, line: lineOf(node), cls, kind: 'new' })
          checkArguments(node.arguments ?? [], cls, `new ${cls}(…)`, node, true)
          checkFreshInstance(node, cls)
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

  // Exemptions still hold against the WHOLE constructor (parameter list included — another parameter's default
  // `text = String(cause)` reaches the message as surely as the body does): the exempt parameter appears only as
  // `Object.assign(this, { cause })` or in a comparison with `undefined`. (`arguments` in a listed class's
  // constructor is red on its own — see checkListedClassBody.)
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
    const paramName = param.name
    walk(ctor, (n) => {
      if (!ts.isIdentifier(n) || n === paramName) return
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
let realTree: Map<string, string> | undefined
const tree = (): Map<string, string> => (realTree ??= readTree())
let realScan: Scan | undefined
const real = (): Scan => (realScan ??= scanFixedSentenceConstructors(tree(), REAL_OPTIONS))

describe('R-41 fixed-sentence allow-lists: every construction of a listed class (real tree)', () => {
  it('discovers the allow-lists from source, fails closed on nothing, and finds each listed class declared once', () => {
    const scan = real()
    expect(scan.failures).toEqual([])
    expect([...scan.lists.keys()].sort()).toEqual([...EXPECTED_LISTS].sort())
    expect(scan.classes.length).toBeGreaterThan(0)
    for (const cls of scan.classes) expect(scan.declarations.get(cls)?.length, cls).toBe(1)
  }, 60_000)

  it('no argument of any construction reads provider / caught text, and no listed class rewrites its own message (rules a–d)', () => {
    expect(real().violations).toEqual([])
  }, 60_000)

  it('every message / stack write on a non-`this` target in the scanned tree is a pinned, reasoned site (rule d)', () => {
    const actual = censusMessageRewrites(tree())
    expect(actual).toEqual(Object.fromEntries(Object.entries(ALLOWED_MESSAGE_REWRITES).map(([k, v]) => [k, v.count])))
  }, 60_000)

  it('every this.message / this.stack write outside the listed classes is a pinned, reasoned site (rule d; none today)', () => {
    const listed = new Set(real().classes)
    const outside = [...censusThisMessageRewrites(tree())].filter(([, v]) => !listed.has(v.cls)).map(([k, v]) => [k, v.count])
    expect(Object.fromEntries(outside)).toEqual(Object.fromEntries(Object.entries(ALLOWED_THIS_MESSAGE_REWRITES).map(([k, v]) => [k, v.count])))
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
    const unexempt = scanFixedSentenceConstructors(tree(), { ...REAL_OPTIONS, argumentsOutsideMessage: {} })
    for (const cls of Object.keys(ARGUMENTS_OUTSIDE_MESSAGE)) {
      expect(unexempt.violations.filter((v) => v.includes(`new ${cls}(…) argument`)), cls).not.toEqual([])
    }
  }, 60_000)

  it('non-vacuity: every listed class keeps at least its pinned construction count, and the listed classes are exactly the pinned set', () => {
    expect(constructionPinProblems(countsByClass(real()), EXPECTED_CONSTRUCTION_COUNTS)).toEqual([])
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
const SAMPLE_FIXED_SENTENCES: readonly FixedSentenceErrorClass[] = [FooError, CauseOnlyError]
export const sample = (e: unknown) => classify(e, { fallback: 'x', fixedSentenceClasses: SAMPLE_FIXED_SENTENCES })
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
export function listed(ids: string[]) {
  const missing: string[] = []
  for (const id of ids) missing.push(id)
  return new FooError(\`Unknown ids: \${missing.join(', ')}\`)
}
`

describe('self-tests: the scanner on in-memory sources', () => {
  it('baseline: clean constructions, an exempt cause argument, a comparison-only use and a clean accumulator are not flagged', () => {
    const scan = synthetic(CLEAN_USER)
    expect(scan.failures).toEqual([])
    expect([...scan.lists.keys()]).toEqual([`${S}/x/lists.ts SAMPLE_FIXED_SENTENCES`])
    expect(scan.violations).toEqual([])
    expect(scan.unplaced).toEqual([])
    expect(scan.exemptionFailures).toEqual([])
    expect(countsByClass(scan)).toEqual({ CauseOnlyError: 1, FooError: 4 })
  })

  const RULE_CASES: Array<[string, string, string]> = [
    ['(a) .message read', `export const f = (err: Error) => new FooError(err.message)`, '(a) reads .message'],
    ['(a) .stack read', `export const f = (err: Error) => new FooError(\`x \${err.stack}\`)`, '(a) reads .stack'],
    ['(a) errmsg read', `export const f = (body: any) => new FooError(body.errmsg)`, '(a) reads .errmsg'],
    ['(a) responseBody read', `export const f = (e: any) => new FooError(JSON.stringify(e.responseBody))`, '(a) reads .responseBody'],
    ['(a) .detail read (bracket)', `export const f = (e: any) => new FooError(e['detail'])`, "(a) reads ['detail']"],
    ['(a) .cause read', `export const f = (e: any) => new FooError(String(e.cause))`, '(a) reads .cause'],
    ['(a) pg .hint read', `export const f = (e: any) => new FooError(e.hint)`, '(a) reads .hint'],
    ['(a) pg .where read', `export const f = (e: any) => new FooError(e.where)`, '(a) reads .where'],
    ['(a) allSettled .reason read', `export const f = (r: any) => new FooError(String(r.reason))`, '(a) reads .reason'],
    ['(a) through a local', `export function f(e: Error) { const text = e.message; return new FooError(text) }`, '(a) reads .message via `text`'],
    ['(a) through destructuring', `export function f(e: Error) { const { message } = e; return new FooError(message) }`, '(a) destructures message'],
    ['(a) through a later assignment', `export function f(e: Error) { let t = 'x'; t = e.message; return new FooError(t) }`, '(a) reads .message via `t`'],
    ['(a) through a same-file helper parameter', `function fail(reason: string): never { throw new FooError(reason) }\nexport function g(e: Error) { fail(e.message) }`, '(a) reads .message via `reason` from'],
    ['(a) through a parameter default', `export function f(e: Error, text = e.message) { return new FooError(text) }`, '(a) reads .message via `text`'],
    ['(a) accumulated with push', `export function f(es: Error[]) { const parts: string[] = []; for (const x of es) parts.push(x.message); return new FooError(parts.join(', ')) }`, '(a) reads .message via `parts`'],
    ['(a) accumulated with unshift', `export function f(x: Error) { const parts: string[] = []; parts.unshift(x.message); return new FooError(\`\${parts}\`) }`, '(a) reads .message via `parts`'],
    ['(a) accumulated with splice', `export function f(x: Error) { const parts: string[] = ['a']; parts.splice(0, 0, x.message); return new FooError(parts.join()) }`, '(a) reads .message via `parts`'],
    ['(a) written into a member of a local', `export function f(x: Error) { const out: any = {}; out.detailText = x.message; return new FooError(out.detailText) }`, '(a) reads .message via `out`'],
    ['(a) Object.assign into a local', `export function f(x: Error) { const out: any = {}; Object.assign(out, { text: x.message }); return new FooError(out.text) }`, '(a) reads .message via `out`'],
    ['(b) catch binding passed', `export function f() { try { g() } catch (error) { throw new FooError(error as string) } }`, '(b) passes caught `error`'],
    ['(b) catch binding with an unusual name', `export function f() { try { g() } catch (oops) { throw new FooError(describe(oops)) } }`, '(b) passes caught `oops`'],
    ['(b) destructured catch binding', `export function f() { try { g() } catch ({ code }) { throw new FooError(code) } }`, '(b) passes caught `code`'],
    ['(b) through a local', `export function f() { try { g() } catch (e) { const t = render(e); throw new FooError(t) } }`, '(b) passes caught `e` via `t`'],
    ['(b) accumulated with Map.set', `export function f() { const seen = new Map<string, unknown>(); try { g() } catch (e) { seen.set('k', e) } return new FooError([...seen.values()].join()) }`, '(b) passes caught `e` via `seen`'],
    ['(b) accumulated with Set.add', `export function f() { const seen = new Set<unknown>(); try { g() } catch (e) { seen.add(e) } return new FooError([...seen].join()) }`, '(b) passes caught `e` via `seen`'],
    ['(b) .catch callback', `export const f = (p: Promise<void>) => p.catch((e) => { throw new FooError(e) })`, '(b) passes caught `e`'],
    ['(b) .catch with a named handler', `function handler(problem: unknown) { return new FooError(problem as string) }\nexport const f = (p: Promise<void>) => p.catch(handler)`, '(b) passes caught `problem`'],
    ['(b) .on(\'error\') listener', `export const f = (s: any) => s.on('error', (e: unknown) => { throw new FooError(e as string) })`, '(b) passes caught `e`'],
    ['(b) .on(<non-literal event>) listener', `export const f = (s: any, ev: string) => s.on(ev, (e: unknown) => { throw new FooError(e as string) })`, '(b) passes caught `e`'],
    ['(c) String(caught)', `export function f() { try { g() } catch (error) { throw new FooError(String(error)) } }`, '(c) interpolates caught `error`'],
    ['(c) template of caught', `export function f() { try { g() } catch (error) { throw new FooError(\`failed: \${error}\`) } }`, '(c) interpolates caught `error`'],
    ['(c) .then(_, cb) template', `export const f = (p: Promise<void>) => p.then(() => 1, (e) => new FooError(\`x \${e}\`))`, '(c) interpolates caught `e`'],
    ['(c) module-level binding written in a catch', `let lastError = ''\nexport function remember() { try { g() } catch (e) { lastError = String(e) } }\nexport const f = () => new FooError(lastError)`, '(c) interpolates caught `e` via `lastError`'],
    ['(c) accumulated with push of String(caught)', `export function f() { const parts: string[] = []; try { g() } catch (e) { parts.push(String(e)) } return new FooError(\`x \${parts.join(', ')}\`) }`, '(c) interpolates caught `e` via `parts`'],
    ['(d) a fresh instance handed to Object.assign', `export const f = (t: string) => Object.assign(new FooError('x'), { code: t })`, '(d) the instance is handed to Object.assign'],
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

  it('an argument exemption never covers the exempt class\'s OWN super(…): a tainted message there is red', () => {
    const viaModuleState = synthetic(CLEAN_USER, {
      [`${S}/x/errors.ts`]: ERRORS
        .replace("super('A fixed sentence.')", 'super(lastFailure)')
        .replace('export class BarError', "let lastFailure = 'A fixed sentence.'\nexport function remember(op: () => void) { try { op() } catch (e) { lastFailure = String(e) } }\nexport class BarError"),
    })
    expect(viaModuleState.violations.some((v) => v.includes("CauseOnlyError's own super(…) argument 1: (c) interpolates caught `e` via `lastFailure`")), viaModuleState.violations.join('\n')).toBe(true)
    const viaGlobal = synthetic(CLEAN_USER, {
      [`${S}/x/errors.ts`]: ERRORS.replace("super('A fixed sentence.')", 'super((globalThis as any).lastError.message)'),
    })
    expect(viaGlobal.violations.some((v) => v.includes("CauseOnlyError's own super(…) argument 1: (a) reads .message"))).toBe(true)
    // The `new CauseOnlyError(error)` argument itself stays exempt.
    expect(viaGlobal.violations.some((v) => v.includes('new CauseOnlyError(…)'))).toBe(false)
  })

  it('a listed class rewriting its own message: this.message outside the constructor, a message field, a message getter', () => {
    const scan = synthetic('', {
      [`${S}/x/errors.ts`]: ERRORS.replace("export class BarError extends Error {}", `export class BarError extends Error {}
export class EnrichedError extends Error {
  constructor(m: string) { super(m) }
  enrich(e: Error) { this.message = e.message }
}
export class FieldError extends Error {
  message = (globalThis as any).last.message
}
export class GetterError extends Error {
  get message() { return 'x' }
}`),
      [`${S}/x/lists.ts`]: LISTS.replace('[FooError, CauseOnlyError]', '[FooError, CauseOnlyError, EnrichedError, FieldError, GetterError]'),
    })
    expect(scan.violations.some((v) => v.includes('EnrichedError: (d) this.message rewritten outside the constructor')), scan.violations.join('\n')).toBe(true)
    expect(scan.violations.some((v) => v.includes("FieldError's own field message: (a) reads .message"))).toBe(true)
    expect(scan.violations.some((v) => v.includes('GetterError overrides message'))).toBe(true)
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

  it('list discovery: spreads, inline lists and a same-file pass-through call are followed; a non-array list or an unknown consumer fails closed', () => {
    const spread = synthetic('', {
      [`${S}/x/more.ts`]: `import { BarError } from './errors'
import type { FixedSentenceErrorClass } from './failure-text'
const LOCAL: readonly FixedSentenceErrorClass[] = [BarError]
const WIDER: readonly FixedSentenceErrorClass[] = [...LOCAL]
function show(e: unknown, classes: readonly FixedSentenceErrorClass[]) { return classify(e, { fallback: 'x', fixedSentenceClasses: classes }) }
function forward(e: unknown, classes: readonly FixedSentenceErrorClass[]) { return show(e, classes) }
export const t = (e: unknown) => classify(e, { fallback: 'x', fixedSentenceClasses: [BarError] })
export const u = (e: unknown) => classify(e, { fallback: 'x', fixedSentenceClasses: WIDER })
export const v = (e: unknown) => show(e, [BarError])
export const w = (e: unknown) => forward(e, [BarError])
`,
    })
    expect(spread.failures).toEqual([])
    expect(spread.lists.get(`${S}/x/more.ts WIDER`)).toEqual(['BarError'])
    expect(spread.lists.get(`${S}/x/more.ts inline#1`)).toEqual(['BarError'])
    expect(spread.lists.get(`${S}/x/more.ts inline#2`)).toEqual(['BarError'])
    // A list parameter forwarded as the list argument of another same-file pass-through stays followed.
    expect(spread.lists.get(`${S}/x/more.ts inline#3`)).toEqual(['BarError'])
    expect(spread.classes).toContain('BarError')

    const frozen = synthetic('', {
      [`${S}/x/more.ts`]: `import { BarError } from './errors'
import type { FixedSentenceErrorClass } from './failure-text'
const FROZEN: readonly FixedSentenceErrorClass[] = Object.freeze([BarError])
export const t = (e: unknown, list: unknown[]) => classify(e, { fallback: 'x', fixedSentenceClasses: list as never })
`,
    })
    expect(frozen.failures.some((f) => f.includes('allow-list FROZEN is not an array literal'))).toBe(true)
    expect(frozen.failures.some((f) => f.includes('neither a discovered list nor a pass-through parameter'))).toBe(true)
  })

  const PASS_THROUGH = `import type { FixedSentenceErrorClass } from './failure-text'
function show(e: unknown, classes: readonly FixedSentenceErrorClass[]) { return classify(e, { fallback: 'x', fixedSentenceClasses: classes }) }
`
  const LIST_FAIL_CASES: Array<[string, Record<string, string>, string]> = [
    ['an exported pass-through function (the cross-file attack: another file calls it with an inline list)', {
      [`${S}/x/wrapper.ts`]: PASS_THROUGH.replace('function show', 'export function show'),
      [`${S}/x/caller.ts`]: `import { show } from './wrapper'\nimport { BarError } from './errors'\nexport const f = (e: Error) => { show(e, [BarError]); throw new BarError(e.message) }\n`,
    }, 'show takes a FixedSentenceErrorClass parameter and is exported'],
    ['an exported arrow pass-through', {
      [`${S}/x/wrapper.ts`]: `import type { FixedSentenceErrorClass } from './failure-text'\nexport const show = (e: unknown, classes: readonly FixedSentenceErrorClass[]) => classify(e, { fallback: 'x', fixedSentenceClasses: classes })\n`,
    }, 'show takes a FixedSentenceErrorClass parameter and is exported'],
    ['a re-exported pass-through function', {
      [`${S}/x/wrapper.ts`]: `${PASS_THROUGH}export { show }\n`,
    }, 'show (takes a FixedSentenceErrorClass parameter) is re-exported'],
    ['a pass-through re-exported under another name', {
      [`${S}/x/wrapper.ts`]: `${PASS_THROUGH}export { show as display }\n`,
    }, 'show (takes a FixedSentenceErrorClass parameter) is re-exported'],
    ['a pass-through referenced as a value (handed to a registry)', {
      [`${S}/x/wrapper.ts`]: `${PASS_THROUGH}register(show)\n`,
    }, 'show (takes a FixedSentenceErrorClass parameter) is used as a value'],
    ['a pass-through called through .call', {
      [`${S}/x/wrapper.ts`]: `${PASS_THROUGH}export const f = (e: unknown, k: any) => show.call(null, e, k)\n`,
    }, 'show (takes a FixedSentenceErrorClass parameter) is used as a value'],
    ['a pass-through on CommonJS exports', {
      [`${S}/x/wrapper.js`]: `function show(e, /** @type {any} */ classes) { return classify(e, { fallback: 'x', fixedSentenceClasses: classes }) }\nmodule.exports = { show }\n`,
    }, 'neither a discovered list nor a pass-through parameter'],
    ['a pass-through method', {
      [`${S}/x/wrapper.ts`]: `import type { FixedSentenceErrorClass } from './failure-text'\nexport class Shower { show(e: unknown, classes: readonly FixedSentenceErrorClass[]) { return classify(e, { fallback: 'x', fixedSentenceClasses: classes }) } }\n`,
    }, 'a FixedSentenceErrorClass parameter on a method, callback or anonymous function'],
    ['an exported list constant', {
      [`${S}/x/more.ts`]: `import { BarError } from './errors'\nimport type { FixedSentenceErrorClass } from './failure-text'\nexport const OUT: readonly FixedSentenceErrorClass[] = [BarError]\n`,
    }, 'allow-list OUT is exported'],
    ['a list constant mutated', {
      [`${S}/x/more.ts`]: `import { BarError, FooError } from './errors'\nimport type { FixedSentenceErrorClass } from './failure-text'\nconst L: readonly FixedSentenceErrorClass[] = [BarError]\n;(L as any).push(FooError)\nexport const t = (e: unknown) => classify(e, { fallback: 'x', fixedSentenceClasses: L })\n`,
    }, 'allow-list L is referenced outside a consumer position'],
    ['fixedSentenceClasses assigned as a property', {
      [`${S}/x/more.ts`]: `import { BarError } from './errors'\nexport function t(e: unknown) { const o: any = { fallback: 'x' }; o.fixedSentenceClasses = [BarError]; return classify(e, o) }\n`,
    }, 'fixedSentenceClasses assigned as a property'],
    ['fixedSentenceClasses as a computed key', {
      [`${S}/x/more.ts`]: `import { BarError } from './errors'\nexport const t = (e: unknown) => classify(e, { fallback: 'x', ['fixedSentenceClasses']: [BarError] })\n`,
    }, "'fixedSentenceClasses' spelled as a string"],
  ]
  it.each(LIST_FAIL_CASES)('list discovery fails closed on %s', (_label, extra, expected) => {
    const scan = synthetic('', extra)
    expect(scan.failures.some((f) => f.includes(expected)), scan.failures.join('\n')).toBe(true)
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

  const REWRITE_CASES: Array<[string, string, string]> = [
    ['a caught, instanceof-narrowed instance enriched in place', `export function f(op: () => void, p: Error) { try { op() } catch (err) { if (err instanceof FooError) err.message = \`\${err.message} (\${p.message})\`; throw err } }`, 'err.message ='],
    ['a let-bound instance rewritten later', `export function f(t: string) { let e; e = new FooError('x'); e.message = t; return e }`, 'e.message ='],
    ['a compound rewrite', `export function f(e: Error, t: string) { e.message += t }`, 'e.message ='],
    ['a bracket rewrite of stack', `export function f(e: Error, t: string) { e['stack'] = t }`, 'e.stack ='],
    ['a holder field rewrite', `export function f(holder: { error: Error }, t: string) { holder.error.message = t }`, 'holder.error.message ='],
    ['a destructuring-assignment rewrite', `export function f(e: Error, o: { t: string }) { ({ t: e.message } = o) }`, 'destructuring e.message ='],
    ['Object.defineProperty', `export function f(e: Error, t: string) { Object.defineProperty(e, 'message', { value: t }) }`, "Object.defineProperty(e, 'message')"],
    ['Object.defineProperties', `export function f(e: Error, t: string) { Object.defineProperties(e, { stack: { value: t } }) }`, 'Object.defineProperties(e, { stack })'],
    ['Object.assign', `export function f(e: Error, message: string) { Object.assign(e, { message }) }`, 'Object.assign(e, { message })'],
    ['Reflect.set', `export function f(e: Error, t: string) { Reflect.set(e, 'message', t) }`, "Reflect.set(e, 'message')"],
    ['Reflect.defineProperty', `export function f(e: Error, t: string) { Reflect.defineProperty(e, 'stack', { value: t }) }`, "Reflect.defineProperty(e, 'stack')"],
  ]
  it.each(REWRITE_CASES)('(d) the tree-wide census finds %s', (_label, body, form) => {
    const census = censusMessageRewrites(new Map([[`${S}/x/user.ts`, `import { FooError } from './errors'\n${body}\n`]]))
    expect(census).toEqual({ [`${S}/x/user.ts :: ${form}`]: 1 })
  })

  it('(d) the census ignores `this` targets and plain reads, and scans plugin CommonJS too', () => {
    expect(censusMessageRewrites(new Map([[`${S}/x/user.ts`, `class A extends Error { constructor() { super('x'); this.message = 'y'; Object.assign(this, { stack: '' }) } }\nexport const r = (e: Error) => e.message\n`]]))).toEqual({})
    expect(censusMessageRewrites(new Map([['plugins/p/lib/x.cjs', `module.exports = (e) => { e.message = 'x' }\n`]]))).toEqual({ 'plugins/p/lib/x.cjs :: e.message =': 1 })
  })
})

describe('self-tests: round-3 holes (each was green against the guard at 5ada6dc8d)', () => {
  it('B1: an exempt parameter used in ANOTHER parameter\'s default value breaks the exemption', () => {
    const scan = synthetic(CLEAN_USER, {
      [`${S}/x/errors.ts`]: ERRORS.replace("constructor(cause: unknown) {\n    super('A fixed sentence.')", 'constructor(cause: unknown, text: string = String(cause)) {\n    super(text)'),
    })
    expect(scan.exemptionFailures.some((f) => f.includes('CauseOnlyError: exempt parameter `cause`')), scan.exemptionFailures.join('\n')).toBe(true)
  })

  it('B1: `arguments` in a listed class\'s constructor is red (exempt class or not)', () => {
    const scan = synthetic(CLEAN_USER, {
      [`${S}/x/errors.ts`]: ERRORS
        .replace('super(message)', 'super(String(arguments[0]))')
        .replace("super('A fixed sentence.')", 'super(String(arguments[0]))'),
    })
    expect(scan.violations.some((v) => v.includes("FooError's constructor reads `arguments`")), scan.violations.join('\n')).toBe(true)
    expect(scan.violations.some((v) => v.includes("CauseOnlyError's constructor reads `arguments`"))).toBe(true)
  })

  const PASS_THROUGH_MISUSE: Array<[string, string]> = [
    ['reassigned', 'classes = [...classes, BarError]'],
    ['pushed into', '(classes as unknown[]).push(BarError)'],
    ['aliased, then the alias pushed into', 'const alias = classes\n  ;(alias as unknown[]).push(BarError)'],
  ]
  it.each(PASS_THROUGH_MISUSE)('B2: a pass-through whose list parameter is %s fails closed', (_label, misuse) => {
    const scan = synthetic('', {
      [`${S}/x/more.ts`]: `import { BarError, FooError } from './errors'
import type { FixedSentenceErrorClass } from './failure-text'
function show(e: unknown, classes: readonly FixedSentenceErrorClass[]) {
  ${misuse}
  return classify(e, { fallback: 'x', fixedSentenceClasses: classes })
}
export const t = (e: unknown) => show(e, [FooError])
`,
    })
    expect(scan.failures.some((f) => f.includes("show's list parameter classes is used other than as a consumer value")), scan.failures.join('\n')).toBe(true)
  })

  const CONCATENATED_KEYS: Array<[string, string]> = [
    ['a + concatenation', "['fixed' + 'SentenceClasses']"],
    ['a static template', "[`fixed${'Sentence'}Classes`]"],
  ]
  it.each(CONCATENATED_KEYS)('B3: a fixedSentenceClasses key built by %s, in a file that spells neither word, fails closed', (_label, key) => {
    const scan = synthetic('', {
      [`${S}/x/concat.ts`]: `import { classifyDirectoryFailureText } from './failure-text'
import { BarError } from './errors'
export const t = (e: unknown) => classifyDirectoryFailureText(e, { fallback: 'x', ${key}: [BarError] })
`,
    })
    expect(scan.failures.some((f) => f.includes("'fixedSentenceClasses' spelled as a string")), scan.failures.join('\n')).toBe(true)
  })

  it('B3: a message key built by concatenation is a rewrite (census) and a read (rule a), even where neither word is spelled', () => {
    expect(censusMessageRewrites(new Map([[`${S}/x/user.ts`, "export function f(e: Error, t: string) { e['st' + 'ack'] = t }\n"]])))
      .toEqual({ [`${S}/x/user.ts :: e.stack =`]: 1 })
    const scan = synthetic("import { FooError } from './errors'\nexport const f = (err: Error) => new FooError(err['mess' + 'age'])\n")
    expect(scan.violations.some((v) => v.includes("(a) reads ['message']")), scan.violations.join('\n')).toBe(true)
  })

  const SINK_MISUSE: Array<[string, string, string]> = [
    ['options held in a variable', "const opts = { fallback: 'x' }\nexport const t = (e: unknown) => classifyDirectoryFailureText(e, opts)", 'options are `opts`, not an inline object'],
    ['options with a spread', "const base = { fallback: 'x' }\nexport const t = (e: unknown) => classifyDirectoryFailureText(e, { ...base })", 'a spread or computed key'],
    ['the classifier used as a value', 'export const c = classifyDirectoryFailureText', 'is used as a value'],
    ['the classifier re-exported', 'export { classifyDirectoryFailureText as classify2 }', 'is re-exported'],
  ]
  it.each(SINK_MISUSE)('B3: the classifier sink fails closed on %s', (_label, body, expected) => {
    const scan = synthetic('', { [`${S}/x/sink.ts`]: `import { classifyDirectoryFailureText } from './failure-text'\n${body}\n` })
    expect(scan.failures.some((f) => f.includes(expected)), scan.failures.join('\n')).toBe(true)
  })

  it('B3: `export *` from the classifier module fails closed', () => {
    const scan = synthetic('', { [`${S}/x/barrel.ts`]: "export * from '../directory/directory-failure-text'\n" })
    expect(scan.failures.some((f) => f.includes('`export *` from the classifier module')), scan.failures.join('\n')).toBe(true)
  })

  it('B3: a this.message / this.stack write in a NON-listed class is counted by the census (pinned: none today)', () => {
    const census = censusThisMessageRewrites(new Map([[`${S}/x/user.ts`, "export class Other extends Error {\n  constructor() { super('x'); this.message = 'y' }\n  later() { this['stack'] = '' }\n}\n"]]))
    expect(Object.fromEntries([...census].map(([k, v]) => [k, v.count]))).toEqual({
      [`${S}/x/user.ts :: this.message in Other`]: 1,
      [`${S}/x/user.ts :: this.stack in Other`]: 1,
    })
  })

  it('pin semantics: a construction count ABOVE its pin passes, below fails, and the class set is exact', () => {
    expect(constructionPinProblems({ A: 42, B: 2 }, { A: 41, B: 2 })).toEqual([])
    expect(constructionPinProblems({ A: 40, B: 2 }, { A: 41, B: 2 })).toHaveLength(1)
    expect(constructionPinProblems({ A: 41, B: 2, C: 1 }, { A: 41, B: 2 })).toHaveLength(1)
    expect(constructionPinProblems({ A: 41 }, { A: 41, B: 2 })).toHaveLength(1)
  })
})
