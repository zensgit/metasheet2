/**
 * Real-app router-isolation smoke test.
 *
 * INVARIANT: a router mounted with `app.use('/api', someRouter)` must only handle the paths it owns.
 *
 * Express runs a PATH-LESS `router.use(middleware)` for EVERY request that enters that router — and a
 * router mounted at '/api' is entered by every `/api/*` request, including ones that belong to routers
 * mounted AFTER it. So a path-less `router.use(...)` inside such a router can intercept, reject, or
 * short-circuit foreign traffic (e.g. all of `/api/multitable/*`, `/api/workflow/*`, `/api/admin/*`)
 * before it ever reaches its own router. Middleware in a router mounted at a shared prefix must
 * therefore be bound to the paths that router actually owns (`router.use('/thing', mw)`), never added
 * path-less.
 *
 * Route-level UNIT tests structurally cannot catch this: they mount one router in isolation, so every
 * path exercised belongs to that router and a leak is invisible. Only real app assembly shows it.
 *
 * The runtime check sends an AUTHENTICATED request to an `/api` path that no router owns; unconditional
 * interception comes back as the router's rejection instead of 404. A second structural check derives
 * every imported router mounted at the shared `/api` prefix and rejects path-less `router.use(...)`
 * regardless of request-dependent branches inside that middleware. Together they cover both the live
 * assembled chain and the conditional-interception shape that one probe cannot exercise exhaustively.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'net'
import ts from 'typescript'

// A path deliberately owned by NO router. If any /api router intercepts foreign traffic, it answers this.
const UNOWNED_API_PATH = '/api/__router_isolation_probe__/no-router-owns-this'
const CORE_BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

type ImportedBinding = {
  importedName: 'default' | string
  moduleSpecifier: string
}

type SharedPrefixRouter = ImportedBinding & {
  localName: string
}

function walkAst(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walkAst(child, visit))
}

function parseSource(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function importedBindings(sourceFile: ts.SourceFile): Map<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (!clause) continue
    const moduleSpecifier = statement.moduleSpecifier.text
    if (clause.name) {
      bindings.set(clause.name.text, { importedName: 'default', moduleSpecifier })
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          importedName: element.propertyName?.text ?? element.name.text,
          moduleSpecifier,
        })
      }
    }
  }
  return bindings
}

function isThisAppUse(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'use') return false
  const receiver = node.expression.expression
  return ts.isPropertyAccessExpression(receiver)
    && receiver.name.text === 'app'
    && receiver.expression.kind === ts.SyntaxKind.ThisKeyword
}

function discoverSharedPrefixRouters(): SharedPrefixRouter[] {
  const indexPath = resolve(CORE_BACKEND_ROOT, 'src/index.ts')
  const sourceFile = parseSource(indexPath)
  const imports = importedBindings(sourceFile)
  const routers: SharedPrefixRouter[] = []

  walkAst(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !isThisAppUse(node)) return
    const [mountPath, ...handlers] = node.arguments
    if (!mountPath || !ts.isStringLiteralLike(mountPath) || mountPath.text !== '/api') return

    for (const handler of handlers) {
      if (ts.isIdentifier(handler)) {
        const imported = imports.get(handler.text)
        if (!imported || !imported.moduleSpecifier.includes('/routes/')) continue
        routers.push({ localName: handler.text, ...imported })
        continue
      }
      if (ts.isCallExpression(handler) && ts.isIdentifier(handler.expression)) {
        const imported = imports.get(handler.expression.text)
        if (imported?.moduleSpecifier.includes('/routes/')) {
          throw new Error(
            `router-isolation smoke: shared-prefix router factory ${handler.expression.text} ` +
              'is not structurally inspected; extend the guard before using this mount shape',
          )
        }
      }
    }
  })

  return routers
}

function resolveImportedModule(moduleSpecifier: string): string {
  const basePath = resolve(CORE_BACKEND_ROOT, 'src', moduleSpecifier)
  const candidates = [`${basePath}.ts`, `${basePath}.tsx`, resolve(basePath, 'index.ts')]
  const match = candidates.find((candidate) => existsSync(candidate))
  if (!match) throw new Error(`router-isolation smoke: cannot resolve ${moduleSpecifier}`)
  return match
}

function exportedRouterBinding(sourceFile: ts.SourceFile, importedName: string): string | null {
  if (importedName !== 'default') return importedName
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      return statement.expression.text
    }
  }
  return null
}

function isLiteralExpressPath(node: ts.Expression | undefined): boolean {
  if (!node) return false
  if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) return true
  return ts.isArrayLiteralExpression(node)
    && node.elements.length > 0
    && node.elements.every((element) => ts.isExpression(element) && isLiteralExpressPath(element))
}

function pathlessUseViolations(router: SharedPrefixRouter): string[] {
  const modulePath = resolveImportedModule(router.moduleSpecifier)
  const sourceFile = parseSource(modulePath)
  const routerBinding = exportedRouterBinding(sourceFile, router.importedName)
  if (!routerBinding) {
    return [`${router.localName} (${router.moduleSpecifier}): exported router binding could not be resolved`]
  }

  const violations: string[] = []
  walkAst(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
    if (node.expression.name.text !== 'use') return
    if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== routerBinding) return
    if (isLiteralExpressPath(node.arguments[0])) return

    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    violations.push(`${router.localName} (${router.moduleSpecifier}:${location.line + 1}:${location.character + 1})`)
  })
  return violations
}

describe('router isolation — no /api router may intercept traffic it does not own', () => {
  let server: MetaSheetServer
  let baseUrl = ''
  let authToken = ''
  const probeUserId = 'test-user-router-isolation'

  beforeAll(async () => {
    // Setup HARD-FAILS. A silent `return` here would leave every assertion below unexecuted while the
    // suite still reported green — the exact false-green this test exists to prevent.
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) throw new Error('router-isolation smoke: cannot bind an ephemeral port')

    server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
    await server.start()
    const address = server.getAddress()
    if (!address || !address.port) throw new Error('router-isolation smoke: server did not report an address')
    baseUrl = `http://127.0.0.1:${address.port}`

    const tokenRes = await fetch(`${baseUrl}/api/auth/dev-token?userId=${encodeURIComponent(probeUserId)}`)
    if (tokenRes.status !== 200) {
      throw new Error(`router-isolation smoke: dev-token request failed (${tokenRes.status})`)
    }
    const tokenJson = (await tokenRes.json()) as { token?: string }
    if (!tokenJson.token) throw new Error('router-isolation smoke: dev-token response carried no token')
    authToken = tokenJson.token
  })

  afterAll(async () => {
    if (server && (server as unknown as { stop?: () => Promise<void> }).stop) {
      await server.stop()
    }
  })

  it('an unauthenticated /api request is rejected by the auth chain (probe is behind auth)', async () => {
    // Positive control: proves the probe path really does traverse the /api middleware chain, so a 404
    // in the next test means "fell through the routers", not "never entered the app".
    const res = await fetch(`${baseUrl}${UNOWNED_API_PATH}`)
    expect(res.status).toBe(401)
  })

  it('an AUTHENTICATED request to an /api path no router owns falls through to 404 (no router intercepts foreign traffic)', async () => {
    const res = await fetch(`${baseUrl}${UNOWNED_API_PATH}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    })

    // 404 = every /api router correctly declined a path it does not own.
    // Anything else (typically 403/503 from a guard) = some router under /api is running middleware
    // against traffic belonging to other routers — it would reject those routers' real requests too.
    expect(
      res.status,
      `Expected 404 for an /api path no router owns, got ${res.status}. Some router mounted under /api is ` +
        `intercepting foreign traffic — most likely a PATH-LESS router.use(middleware) in a router mounted ` +
        `at app.use('/api', ...). Bind that middleware to the paths the router owns instead.`,
    ).toBe(404)
  })

  it('routers mounted at the shared /api prefix bind every router.use middleware to an owned path', () => {
    const routers = discoverSharedPrefixRouters()
    expect(routers.length, 'Expected at least one imported router mounted at app.use(\'/api\', ...)').toBeGreaterThan(0)

    const violations = routers.flatMap(pathlessUseViolations)
    expect(
      violations,
      `Shared-prefix routers contain path-less router.use middleware:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
