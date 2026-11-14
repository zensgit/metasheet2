/**
 * Where tokens are signed and verified in the backend.
 *
 * Invariants:
 *  - a token is verified against the session secret in exactly one place, the one that applies the
 *    session-token rule (`AuthService.verifySessionTokenPayload`);
 *  - session tokens are signed in exactly two places (`AuthService.createToken` and the
 *    development-token route), and neither payload carries a `type` claim;
 *  - every other token this service signs states its purpose first, in a literal payload `type`
 *    claim, and is signed and verified with the key resolver of its own module.
 *
 * The population is read from the source tree, not listed: every code file under `src`, each file
 * among them that loads `jsonwebtoken`, and each `sign`, `verify` and `decode` call made through that
 * binding. A call the tables below do not classify fails the check. So does `jsonwebtoken` loaded or
 * used in any form other than a default or namespace import called as `<binding>.sign(…)`,
 * `<binding>.verify(…)` or `<binding>.decode(…)`, and so does any other token library.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = path.resolve(__dirname, '../../src')
const CODE_FILE = /\.(?:[cm]?ts|tsx|[cm]?js|jsx|vue)$/
const TOKEN_LIBRARY = 'jsonwebtoken'
const TOKEN_LIBRARY_LIKE = /jwt|jose|jws|jsonwebtoken|paseto/i
const MODULE_SPECIFIER = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g

type TokenCall = 'sign' | 'verify' | 'decode'

interface TokenSite {
  file: string
  line: number
  call: TokenCall
  /** Nearest enclosing named function, method or route registration. */
  within: string
  /** Source text of the key argument (`sign` and `verify`). */
  key: string
  /** `sign` only: what the payload argument is, once resolved to an object literal. */
  payload: PayloadShape | null
}

interface PayloadShape {
  literal: boolean
  /** Name of the first property when it is `type: '<string literal>'`. */
  statesTypeFirst: boolean
  /** Every property name the literal can produce, through conditional literal spreads too. */
  keys: string[]
  /** A spread whose properties cannot be read from the source text. */
  opaqueSpread: boolean
}

interface TokenScan {
  /** Files that load the token library. */
  users: string[]
  sites: TokenSite[]
  offenders: string[]
}

// ---- classification ----------------------------------------------------------------------------

/** The one place a token is verified against the session secret. */
const SESSION_VERIFY = { file: 'auth/AuthService.ts', within: 'verifySessionTokenPayload', key: 'this.config.jwtSecret' }

/** The places a session token is signed. */
const SESSION_SIGNERS = [
  { file: 'auth/AuthService.ts', within: 'createToken', key: 'this.config.jwtSecret' },
  { file: 'routes/auth.ts', within: "authRouter.get('/dev-token')", key: 'secret' },
]

/** Modules that issue purpose-bound tokens, each with the key resolver its tokens are signed and verified with. */
const PURPOSE_TOKEN_KEYS: Record<string, string> = {
  'auth/invite-tokens.ts': 'getInviteSecret()',
  'multitable/restore-preview-identity.ts': 'getSecret()',
}

/** `decode` reads a token without verifying it; these are the places that do, each for a token's own expiry. */
const DECODE_SITES = [
  { file: 'auth/invite-tokens.ts', within: 'getInviteTokenExpiry' },
  { file: 'routes/auth.ts', within: "authRouter.get('/dev-token')" },
]

// ---- scanning ----------------------------------------------------------------------------------

function readSourceTree(root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full)
      } else if (CODE_FILE.test(entry.name)) {
        files.set(path.relative(root, full).split(path.sep).join('/'), readFileSync(full, 'utf8'))
      }
    }
  }
  walk(root)
  return files
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  return null
}

function describeObjectLiteral(literal: ts.ObjectLiteralExpression): PayloadShape {
  const shape: PayloadShape = { literal: true, statesTypeFirst: false, keys: [], opaqueSpread: false }
  const first = literal.properties[0]
  if (
    first
    && ts.isPropertyAssignment(first)
    && propertyNameText(first.name) === 'type'
    && (ts.isStringLiteral(first.initializer) || ts.isNoSubstitutionTemplateLiteral(first.initializer))
    && first.initializer.text.length > 0
  ) {
    shape.statesTypeFirst = true
  }
  const collect = (node: ts.ObjectLiteralExpression) => {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        collectSpread(property.expression)
        continue
      }
      const name = propertyNameText(property.name)
      if (name === null) shape.opaqueSpread = true
      else shape.keys.push(name)
    }
  }
  const collectSpread = (expression: ts.Expression) => {
    if (ts.isParenthesizedExpression(expression)) return collectSpread(expression.expression)
    if (ts.isConditionalExpression(expression)) {
      collectSpread(expression.whenTrue)
      collectSpread(expression.whenFalse)
      return
    }
    if (ts.isObjectLiteralExpression(expression)) return collect(expression)
    shape.opaqueSpread = true
  }
  collect(literal)
  return shape
}

function enclosingName(node: ts.Node): { name: string; scope: ts.Node | null } {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) {
      return { name: current.name.getText(), scope: current }
    }
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return { name: parent.name.text, scope: current }
      if (
        ts.isCallExpression(parent)
        && ts.isPropertyAccessExpression(parent.expression)
        && parent.arguments[0]
        && ts.isStringLiteral(parent.arguments[0])
      ) {
        return { name: `${parent.expression.getText()}('${parent.arguments[0].text}')`, scope: current }
      }
    }
  }
  return { name: '(module)', scope: null }
}

function resolvePayload(argument: ts.Expression | undefined, scope: ts.Node | null): PayloadShape {
  const notLiteral: PayloadShape = { literal: false, statesTypeFirst: false, keys: [], opaqueSpread: true }
  if (!argument) return notLiteral
  if (ts.isObjectLiteralExpression(argument)) return describeObjectLiteral(argument)
  if (!ts.isIdentifier(argument) || !scope) return notLiteral
  // A payload named by a variable: the one declaration of that name in the enclosing function.
  const declarations: ts.VariableDeclaration[] = []
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === argument.text) declarations.push(node)
    ts.forEachChild(node, find)
  }
  find(scope)
  const [declaration] = declarations
  if (declarations.length !== 1 || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) return notLiteral
  if (!(ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const)) return notLiteral
  return describeObjectLiteral(declaration.initializer)
}

function scanTokenSites(files: Map<string, string>): TokenScan {
  const scan: TokenScan = { users: [], sites: [], offenders: [] }

  for (const [file, text] of files) {
    for (const match of text.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[2]
      const bare = !specifier.startsWith('.') && !specifier.startsWith('/')
      if (bare && specifier !== TOKEN_LIBRARY && TOKEN_LIBRARY_LIKE.test(specifier)) {
        scan.offenders.push(`${file}: loads a token library other than ${TOKEN_LIBRARY} (${specifier})`)
      }
    }
    if (!text.includes(TOKEN_LIBRARY)) continue
    if (!/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(file)) {
      scan.offenders.push(`${file}: mentions ${TOKEN_LIBRARY} in a file this check cannot parse`)
      continue
    }

    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
    const bindings = new Set<string>()
    const importNodes = new Set<ts.Node>()
    let loads = false

    const visitLoads = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === TOKEN_LIBRARY) {
        loads = true
        importNodes.add(node)
        const clause = node.importClause
        if (!clause) {
          scan.offenders.push(`${file}: imports ${TOKEN_LIBRARY} without a binding`)
        } else if (!clause.isTypeOnly) {
          if (clause.name) bindings.add(clause.name.text)
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.add(clause.namedBindings.name.text)
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              if (!element.isTypeOnly) scan.offenders.push(`${file}: imports ${element.name.text} from ${TOKEN_LIBRARY} by name`)
            }
          }
        }
      } else if (
        (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === TOKEN_LIBRARY)
        || (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          && ts.isStringLiteral(node.moduleReference.expression) && node.moduleReference.expression.text === TOKEN_LIBRARY)
        || (ts.isCallExpression(node)
          && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === TOKEN_LIBRARY)
      ) {
        loads = true
        scan.offenders.push(`${file}: loads ${TOKEN_LIBRARY} other than through a default or namespace import`)
      }
      ts.forEachChild(node, visitLoads)
    }
    visitLoads(source)
    if (!loads) continue
    scan.users.push(file)

    const visitUses = (node: ts.Node) => {
      if (importNodes.has(node)) return
      if (ts.isIdentifier(node) && bindings.has(node.text)) {
        const parent = node.parent
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (ts.isQualifiedName(parent) && parent.left === node) {
          // A type taken from the library's namespace.
        } else if (
          ts.isPropertyAccessExpression(parent)
          && parent.expression === node
          && ['sign', 'verify', 'decode'].includes(parent.name.text)
          && ts.isCallExpression(parent.parent)
          && parent.parent.expression === parent
        ) {
          const call = parent.parent
          const callName = parent.name.text as TokenCall
          const enclosing = enclosingName(call)
          scan.sites.push({
            file,
            line,
            call: callName,
            within: enclosing.name,
            key: callName === 'decode' ? '' : (call.arguments[1]?.getText() ?? ''),
            payload: callName === 'sign' ? resolvePayload(call.arguments[0], enclosing.scope) : null,
          })
        } else if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
          // A property that happens to share the binding's name.
        } else {
          scan.offenders.push(`${file}:${line}: uses the ${TOKEN_LIBRARY} binding other than as <binding>.sign(…), <binding>.verify(…) or <binding>.decode(…)`)
        }
      }
      ts.forEachChild(node, visitUses)
    }
    visitUses(source)
  }
  return scan
}

function at(site: TokenSite): string {
  return `${site.file}:${site.line} (${site.call} in ${site.within})`
}

function matches(site: TokenSite, rule: { file: string; within: string; key?: string }): boolean {
  return site.file === rule.file && site.within === rule.within && (rule.key === undefined || site.key === rule.key)
}

/** Every way the scanned tree departs from the invariants in the file header. Empty when it holds. */
function tokenSiteOffenders(scan: TokenScan): string[] {
  const offenders = [...scan.offenders]
  const sessionVerifies: TokenSite[] = []
  const sessionSigns = SESSION_SIGNERS.map(() => [] as TokenSite[])
  const decodes = DECODE_SITES.map(() => [] as TokenSite[])

  for (const site of scan.sites) {
    if (site.call === 'decode') {
      const index = DECODE_SITES.findIndex((rule) => matches(site, rule))
      if (index < 0) offenders.push(`${at(site)}: reads a token without verifying it, at a place that is not classified`)
      else decodes[index].push(site)
      continue
    }

    if (site.call === 'verify') {
      if (matches(site, SESSION_VERIFY)) {
        sessionVerifies.push(site)
      } else if (site.key === SESSION_VERIFY.key) {
        offenders.push(`${at(site)}: verifies a token against the session secret outside ${SESSION_VERIFY.within}`)
      } else if (PURPOSE_TOKEN_KEYS[site.file] === undefined || site.key !== PURPOSE_TOKEN_KEYS[site.file]) {
        offenders.push(`${at(site)}: verifies a token with a key that is not classified (${site.key || 'none'})`)
      }
      continue
    }

    const payload = site.payload as PayloadShape
    const signer = SESSION_SIGNERS.findIndex((rule) => matches(site, rule))
    if (signer >= 0) {
      sessionSigns[signer].push(site)
      if (!payload.literal || payload.opaqueSpread) offenders.push(`${at(site)}: signs a session token whose payload cannot be read from the source text`)
      if (payload.keys.includes('type')) offenders.push(`${at(site)}: signs a session token that carries a type claim`)
    } else if (PURPOSE_TOKEN_KEYS[site.file] === undefined || site.key !== PURPOSE_TOKEN_KEYS[site.file]) {
      offenders.push(`${at(site)}: signs a token with a key that is not classified (${site.key || 'none'})`)
    } else if (!payload.literal || !payload.statesTypeFirst) {
      offenders.push(`${at(site)}: signs a purpose-bound token whose payload does not start with a literal type claim`)
    }
  }

  if (sessionVerifies.length !== 1) {
    offenders.push(`expected exactly one verification against the session secret, in ${SESSION_VERIFY.within}; found ${sessionVerifies.length}`)
  }
  SESSION_SIGNERS.forEach((rule, index) => {
    if (sessionSigns[index].length !== 1) offenders.push(`expected exactly one session token signer in ${rule.file} ${rule.within}; found ${sessionSigns[index].length}`)
  })
  DECODE_SITES.forEach((rule, index) => {
    if (decodes[index].length !== 1) offenders.push(`expected exactly one unverified read in ${rule.file} ${rule.within}; found ${decodes[index].length}`)
  })
  for (const file of Object.keys(PURPOSE_TOKEN_KEYS)) {
    const signs = scan.sites.filter((site) => site.file === file && site.call === 'sign').length
    const verifies = scan.sites.filter((site) => site.file === file && site.call === 'verify').length
    if (signs === 0 || verifies === 0) offenders.push(`${file}: expected at least one signer and one verifier of purpose-bound tokens; found ${signs} and ${verifies}`)
  }
  return offenders
}

// ---- the tree as it is -------------------------------------------------------------------------

describe('token signing and verification sites', () => {
  const tree = readSourceTree(SRC_ROOT)
  const scan = scanTokenSites(tree)

  it('reads a real source tree', () => {
    expect(tree.size).toBeGreaterThan(500)
    for (const file of [SESSION_VERIFY.file, ...SESSION_SIGNERS.map((rule) => rule.file), ...Object.keys(PURPOSE_TOKEN_KEYS)]) {
      expect(tree.has(file), file).toBe(true)
      expect(scan.users, file).toContain(file)
    }
  })

  it('a token is verified against the session secret in exactly one place, and every other site is classified', () => {
    // The whole list is the message: every offender, one per line.
    const offenders = tokenSiteOffenders(scan)
    expect(offenders, `\n${offenders.join('\n')}\n`).toEqual([])
  })

  it('the one verification against the session secret is the one that applies the session-token rule', () => {
    const verifies = scan.sites.filter((site) => site.call === 'verify' && site.key === SESSION_VERIFY.key)
    expect(verifies.map((site) => [site.file, site.within])).toEqual([[SESSION_VERIFY.file, SESSION_VERIFY.within]])
    const text = tree.get(SESSION_VERIFY.file) ?? ''
    const start = text.indexOf(`private ${SESSION_VERIFY.within}(`)
    expect(start).toBeGreaterThan(-1)
    const body = text.slice(start, text.indexOf('\n  }\n', start))
    expect(body).toContain('isSessionTokenPayload(payload)')
  })

  it('every purpose-bound token states its purpose first, and the session token signers are the classified two', () => {
    const purposeSigners = scan.sites.filter((site) => site.call === 'sign' && PURPOSE_TOKEN_KEYS[site.file] !== undefined)
    expect(purposeSigners.length).toBeGreaterThanOrEqual(2)
    for (const site of purposeSigners) {
      expect(site.payload?.statesTypeFirst, at(site)).toBe(true)
      expect(site.payload?.keys[0], at(site)).toBe('type')
    }
    const sessionSigners = scan.sites.filter((site) => site.call === 'sign' && PURPOSE_TOKEN_KEYS[site.file] === undefined)
    expect(sessionSigners.map((site) => [site.file, site.within]).sort()).toEqual(
      SESSION_SIGNERS.map((rule) => [rule.file, rule.within]).sort(),
    )
    for (const site of sessionSigners) expect(site.payload?.keys, at(site)).not.toContain('type')
  })
})

// ---- the check itself can fail -----------------------------------------------------------------

describe('token site check: each departure is reported', () => {
  const HOLDS: Record<string, string> = {
    'auth/AuthService.ts': `
      import * as jwt from 'jsonwebtoken'
      export class AuthService {
        createToken(user: { id: string }, options: { sid?: string } = {}): string {
          const payload = { userId: user.id, ...(options.sid ? { sid: options.sid } : {}) }
          return jwt.sign(payload, this.config.jwtSecret, { expiresIn: '1h' } as jwt.SignOptions)
        }
        private verifySessionTokenPayload(token: string) {
          const payload: unknown = jwt.verify(token, this.config.jwtSecret, {})
          return isSessionTokenPayload(payload) ? payload : null
        }
      }`,
    'routes/auth.ts': `
      import jwt, { type SignOptions } from 'jsonwebtoken'
      authRouter.get('/dev-token', async (req, res) => {
        const payload = { id: 'dev-user', roles: ['admin'] }
        const token = jwt.sign(payload, secret, { algorithm: 'HS256' })
        const decoded = jwt.decode(token) as { exp?: number } | null
        res.json({ token, decoded })
      })`,
    'auth/invite-tokens.ts': `
      import jwt from 'jsonwebtoken'
      export function issueInviteToken(options: { userId: string }): string {
        const payload = { type: 'invite', userId: options.userId }
        return jwt.sign(payload, getInviteSecret(), { algorithm: 'HS256' })
      }
      export function verifyInviteToken(token: string) {
        return jwt.verify(token, getInviteSecret())
      }
      export function getInviteTokenExpiry(token: string) {
        return jwt.decode(token)
      }`,
    'multitable/restore-preview-identity.ts': `
      import jwt from 'jsonwebtoken'
      export function mint(claims: object): string {
        return jwt.sign(
          { type: 'restore-preview', ...claims },
          getSecret(),
          { algorithm: 'HS256' },
        )
      }
      export function verify(token: string) {
        return jwt.verify(token, getSecret(), { algorithms: ['HS256'] })
      }`,
  }

  function offendersWith(changes: Record<string, string | ((text: string) => string)>): string[] {
    const files = new Map(Object.entries(HOLDS))
    for (const [file, change] of Object.entries(changes)) {
      const before = files.get(file) ?? ''
      const after = typeof change === 'string' ? change : change(before)
      // A change that changes nothing would make its case pass for the wrong reason.
      expect(after, file).not.toBe(before)
      files.set(file, after)
    }
    return tokenSiteOffenders(scanTokenSites(files))
  }

  const swap = (from: string, to: string) => (text: string) => {
    expect(text.split(from).length - 1, from).toBe(1)
    return text.replace(from, to)
  }

  it('a tree that holds reports nothing', () => {
    expect(tokenSiteOffenders(scanTokenSites(new Map(Object.entries(HOLDS))))).toEqual([])
  })

  it.each<[string, Record<string, string | ((text: string) => string)>, RegExp]>([
    [
      'a second verification against the session secret, in another method',
      { 'auth/AuthService.ts': swap('private verifySessionTokenPayload', 'verifyToken(token: string) { return jwt.verify(token, this.config.jwtSecret) }\n private verifySessionTokenPayload') },
      /verifyToken\): verifies a token against the session secret outside verifySessionTokenPayload/,
    ],
    [
      'a second verification against the session secret, in the classified method',
      { 'auth/AuthService.ts': swap('const payload: unknown =', 'jwt.verify(token, this.config.jwtSecret)\n const payload: unknown =') },
      /expected exactly one verification against the session secret.*found 2/,
    ],
    [
      'the one verification moved out of the classified method',
      { 'auth/AuthService.ts': swap('private verifySessionTokenPayload', 'private readClaims') },
      /expected exactly one verification against the session secret.*found 0/,
    ],
    [
      'a verification in a module that is not classified',
      { 'services/other.ts': "import jwt from 'jsonwebtoken'\nexport const read = (token: string, secret: string) => jwt.verify(token, secret)" },
      /services\/other\.ts:2 \(verify in read\): verifies a token with a key that is not classified \(secret\)/,
    ],
    [
      'a purpose module verifying with a key other than its own resolver',
      { 'auth/invite-tokens.ts': swap('jwt.verify(token, getInviteSecret())', 'jwt.verify(token, config.jwtSecret)') },
      /verifyInviteToken\): verifies a token with a key that is not classified \(config\.jwtSecret\)/,
    ],
    [
      'a purpose-bound token that names its purpose in another claim',
      { 'auth/invite-tokens.ts': swap("type: 'invite'", "purpose: 'invite'") },
      /issueInviteToken\): signs a purpose-bound token whose payload does not start with a literal type claim/,
    ],
    [
      'a purpose-bound token whose type claim is not first',
      { 'multitable/restore-preview-identity.ts': swap("{ type: 'restore-preview', ...claims }", "{ ...claims, type: 'restore-preview' }") },
      /mint\): signs a purpose-bound token whose payload does not start with a literal type claim/,
    ],
    [
      'a purpose-bound token whose type claim is not a literal',
      { 'multitable/restore-preview-identity.ts': swap("{ type: 'restore-preview', ...claims }", '{ type: kind, ...claims }') },
      /mint\): signs a purpose-bound token whose payload does not start with a literal type claim/,
    ],
    [
      'a purpose-bound token whose payload is built elsewhere',
      { 'auth/invite-tokens.ts': swap("const payload = { type: 'invite', userId: options.userId }", 'const payload = buildPayload(options)') },
      /issueInviteToken\): signs a purpose-bound token whose payload does not start with a literal type claim/,
    ],
    [
      'a signer in a module that is not classified',
      { 'services/other.ts': "import jwt from 'jsonwebtoken'\nexport function mint(secret: string) { return jwt.sign({ userId: 'u' }, secret) }" },
      /services\/other\.ts:2 \(sign in mint\): signs a token with a key that is not classified \(secret\)/,
    ],
    [
      'a session token that carries a type claim',
      { 'auth/AuthService.ts': swap('{ userId: user.id,', "{ userId: user.id, type: 'access',") },
      /createToken\): signs a session token that carries a type claim/,
    ],
    [
      'a session token that takes a type claim from a conditional spread',
      { 'auth/AuthService.ts': swap('{ sid: options.sid }', "{ sid: options.sid, type: 'access' }") },
      /createToken\): signs a session token that carries a type claim/,
    ],
    [
      'a session token whose payload spreads something the source text does not show',
      { 'routes/auth.ts': swap("{ id: 'dev-user', roles: ['admin'] }", "{ id: 'dev-user', ...extraClaims }") },
      /signs a session token whose payload cannot be read from the source text/,
    ],
    [
      'a second session token signer',
      { 'routes/auth.ts': swap('res.json({ token, decoded })', "res.json({ token, decoded, other: jwt.sign({ id: 'x' }, secret) })") },
      /expected exactly one session token signer in routes\/auth\.ts authRouter\.get\('\/dev-token'\); found 2/,
    ],
    [
      'an unverified read at a place that is not classified',
      { 'auth/invite-tokens.ts': swap('return jwt.verify(token, getInviteSecret())', 'return jwt.decode(token)') },
      /verifyInviteToken\): reads a token without verifying it, at a place that is not classified/,
    ],
    [
      'the library imported by name',
      { 'services/other.ts': "import { verify } from 'jsonwebtoken'\nexport const read = (token: string, secret: string) => verify(token, secret)" },
      /services\/other\.ts: imports verify from jsonwebtoken by name/,
    ],
    [
      'the library loaded with require',
      { 'services/other.ts': "const jwt = require('jsonwebtoken')\nexport const read = (token: string, secret: string) => jwt.verify(token, secret)" },
      /services\/other\.ts: loads jsonwebtoken other than through a default or namespace import/,
    ],
    [
      'the library loaded with a dynamic import',
      { 'services/other.ts': "export const read = async (token: string, secret: string) => (await import('jsonwebtoken')).verify(token, secret)" },
      /services\/other\.ts: loads jsonwebtoken other than through a default or namespace import/,
    ],
    [
      'the binding handed on under another name',
      { 'auth/invite-tokens.ts': swap('export function getInviteTokenExpiry', 'const tokens = jwt\nexport function getInviteTokenExpiry') },
      /auth\/invite-tokens\.ts:\d+: uses the jsonwebtoken binding other than as/,
    ],
    [
      'a method of the binding taken without calling it',
      { 'auth/invite-tokens.ts': swap('export function getInviteTokenExpiry', 'const check = jwt.verify\nexport function getInviteTokenExpiry') },
      /auth\/invite-tokens\.ts:\d+: uses the jsonwebtoken binding other than as/,
    ],
    [
      'another token library',
      { 'services/other.ts': "import { jwtVerify } from 'jose'\nexport const read = jwtVerify" },
      /services\/other\.ts: loads a token library other than jsonwebtoken \(jose\)/,
    ],
    [
      'the library named in a file that cannot be parsed',
      { 'components/Token.vue': "<script setup lang=\"ts\">\nimport jwt from 'jsonwebtoken'\n</script>" },
      /components\/Token\.vue: mentions jsonwebtoken in a file this check cannot parse/,
    ],
  ])('reports %s', (_label, changes, expected) => {
    const offenders = offendersWith(changes)
    expect(offenders.join('\n')).toMatch(expected)
  })
})
