/**
 * G44 — the integration read-allowlist matcher, and the three lockstep tripwires around it.
 *
 * The matcher is the fail-closed switch that decides which `/api/integration` requests an `mst_` open-API
 * token may even attempt. Over-matching is the dangerous direction, so most of this file is denials:
 *
 *   1. the hand-written positives/negatives an auditor would want to read;
 *   2. a BYPASS battery — case, trailing slash, `..`, percent-encoding, doubled slashes, matrix params,
 *      lookalike prefixes — every one of which must be REFUSED;
 *   3. LOCKSTEP A: the declared set, diffed against the plugin's real ROUTES table, must contain only GET
 *      routes that exist, and must REJECT every other (method, path) the plugin registers — including
 *      every write, every dry-run, every apply, and `GET /api/integration/health` (registered outside
 *      the ROUTES table with no `requireAccess` of its own);
 *   4. LOCKSTEP B: the declared set must equal the mechanical rule the module's header states — every GET
 *      gated exactly `requireAccess(req, 'read')`, minus the three that reach the customer's own system;
 *   5. LOCKSTEP C: the declared set must equal the path set published in the OpenAPI contract.
 *
 * All source scans split on /\r?\n/ and are guarded by population assertions, so a CRLF checkout or a
 * style change cannot turn these tripwires into vacuous passes (the pre-existing
 * `multitable-oapi-allowlist-guard-tripwire.test.ts` scan does NOT do this and reads 0 routes on a CRLF
 * Windows checkout — see the verification doc).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type { IntegrationOapiReadRoute } from '../../src/integration/oapi-integration-read-allowlist'
import {
  INTEGRATION_OAPI_READ_ROUTES,
  INTEGRATION_OAPI_READ_SCOPE,
  isIntegrationApiPath,
  isIntegrationApiTokenBearer,
  isIntegrationOapiReadAllowlistRequest,
  isIntegrationOapiReadPath,
} from '../../src/integration/oapi-integration-read-allowlist'
import { isOapiAllowlistRequest } from '../../src/multitable/oapi-read-allowlist'
import { ALL_API_TOKEN_SCOPES } from '../../src/multitable/api-tokens'

const MST = 'Bearer mst_test0000000000000000'
const JWT = 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y'

const REPO_ROOT = join(__dirname, '../../../..')
const PLUGIN_ROUTES_FILE = join(REPO_ROOT, 'plugins/plugin-integration-core/lib/http-routes.cjs')
const OPENAPI_FILE = join(REPO_ROOT, 'packages/openapi/src/paths/integration.yml')

const pluginSource = readFileSync(PLUGIN_ROUTES_FILE, 'utf8')
const pluginLines = pluginSource.split(/\r?\n/)

/** Substitute every Express `:param` with one fixed non-slash probe token. */
function concrete(expressPath: string): string {
  return expressPath.replace(/:[^/]+/g, 'probe1')
}

// ---------------------------------------------------------------------------------------------
// Source scans (plugin ROUTES table + per-handler gate)
// ---------------------------------------------------------------------------------------------

interface PluginRoute {
  method: string
  path: string
  handler: string
}

const PLUGIN_ROUTES: PluginRoute[] = (() => {
  const re = /^\s*\[\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\]\s*,?\s*$/
  const out: PluginRoute[] = []
  for (const line of pluginLines) {
    const m = line.match(re)
    if (!m) continue
    out.push({ method: m[1], path: m[2], handler: m[3] })
  }
  return out
})()

/** The gate expression at the top of each handler body, keyed by handler name. */
const HANDLER_GATES: Map<string, string> = (() => {
  const start = pluginLines.findIndex((l) => /^\s*const handlers = \{\s*$/.test(l))
  const defRe = /^\s{4}async\s+([A-Za-z0-9_]+)\s*\(/
  const gateRe = /require(?:Access|TableActionAccess)\s*\(([^)]*)\)/
  const out = new Map<string, string>()
  if (start < 0) return out
  let current: string | null = null
  for (let i = start; i < pluginLines.length; i++) {
    const def = pluginLines[i].match(defRe)
    if (def) {
      current = def[1]
      continue
    }
    if (!current) continue
    const gate = pluginLines[i].match(gateRe)
    if (gate && !out.has(current)) out.set(current, gate[0])
  }
  return out
})()

/** The three read-tier GETs deliberately withheld: each constructs an adapter and reaches the source. */
const OUTBOUND_EXCLUSIONS = [
  '/api/integration/external-systems/:id/objects',
  '/api/integration/external-systems/:id/schema',
  '/api/integration/stock-preparation/source-preflight',
] as const

const DECLARED_PATHS = INTEGRATION_OAPI_READ_ROUTES.map((r) => r.expressPath)
const DECLARED_SET = new Set<string>(DECLARED_PATHS)

describe('G44 source scans are not vacuous', () => {
  test('the plugin ROUTES table and the per-handler gate scan both found a real population', () => {
    expect(PLUGIN_ROUTES.length).toBeGreaterThan(100)
    expect(PLUGIN_ROUTES.filter((r) => r.method === 'GET').length).toBeGreaterThan(40)
    expect(HANDLER_GATES.size).toBeGreaterThan(80)
  })
})

describe('G44 integration read-allowlist matcher — positives', () => {
  test('every declared route is admitted for an mst_ GET', () => {
    const rejected = INTEGRATION_OAPI_READ_ROUTES.filter(
      (r) => !isIntegrationOapiReadAllowlistRequest('GET', concrete(r.expressPath), MST),
    )
    expect(rejected.map((r) => r.expressPath)).toEqual([])
    expect(INTEGRATION_OAPI_READ_ROUTES.length).toBe(24)
  })

  test('the global OAPI switch admits them too (index.ts consults only that one)', () => {
    const rejected = INTEGRATION_OAPI_READ_ROUTES.filter(
      (r) => !isOapiAllowlistRequest('GET', concrete(r.expressPath), MST),
    )
    expect(rejected.map((r) => r.expressPath)).toEqual([])
  })

  test('the scope is declared, read-only, and has no write sibling', () => {
    expect(INTEGRATION_OAPI_READ_SCOPE).toBe('integration:read')
    expect(ALL_API_TOKEN_SCOPES).toContain('integration:read')
    expect(ALL_API_TOKEN_SCOPES.filter((s) => s.startsWith('integration:'))).toEqual(['integration:read'])
  })

  test('subtree + bearer predicates are segment-anchored and prefix-exact', () => {
    expect(isIntegrationApiTokenBearer(MST)).toBe(true)
    expect(isIntegrationApiTokenBearer(JWT)).toBe(false)
    expect(isIntegrationApiTokenBearer('mst_abc')).toBe(false)
    expect(isIntegrationApiTokenBearer(undefined)).toBe(false)
    expect(isIntegrationApiPath('/api/integration')).toBe(true)
    expect(isIntegrationApiPath('/api/integration/runs')).toBe(true)
    expect(isIntegrationApiPath('/api/integrations/runs')).toBe(false)
    expect(isIntegrationApiPath('/api/integration-core/runs')).toBe(false)
    expect(isIntegrationApiPath('/api/multitable/records')).toBe(false)
  })
})

describe('G44 integration read-allowlist matcher — credential and method denials', () => {
  test('DENIES a non-mst_ bearer and a missing header on every declared route', () => {
    for (const route of INTEGRATION_OAPI_READ_ROUTES) {
      const path = concrete(route.expressPath)
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, JWT)).toBe(false)
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, undefined)).toBe(false)
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, 'Bearer mst')).toBe(false)
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, 'bearer mst_x')).toBe(false)
    }
  })

  test('DENIES every non-GET method on every declared route (including HEAD, which Express would route to the GET handler)', () => {
    for (const route of INTEGRATION_OAPI_READ_ROUTES) {
      const path = concrete(route.expressPath)
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'get', 'Get']) {
        expect(isIntegrationOapiReadAllowlistRequest(method, path, MST)).toBe(false)
      }
    }
  })
})

describe('G44 integration read-allowlist matcher — path bypass battery (every case must be REFUSED)', () => {
  const BYPASS_ATTEMPTS: ReadonlyArray<readonly [string, string]> = [
    ['uppercase whole path', '/API/INTEGRATION/PIPELINES'],
    ['mixed case segment', '/api/Integration/pipelines'],
    ['mixed case leaf', '/api/integration/Pipelines'],
    ['trailing slash', '/api/integration/pipelines/'],
    ['trailing slash on param route', '/api/integration/pipelines/p1/'],
    ['double slash prefix', '//api/integration/pipelines'],
    ['internal double slash', '/api/integration//pipelines'],
    ['literal dot-dot climb into a write route', '/api/integration/pipelines/../table-actions/a1/apply'],
    ['literal dot-dot as an id', '/api/integration/pipelines/../..'],
    ['single dot segment', '/api/integration/./pipelines'],
    ['percent-encoded dot-dot', '/api/integration/pipelines/%2e%2e/table-actions'],
    ['percent-encoded path separator before a write leg', '/api/integration/pipelines%2fp1%2frun'],
    ['percent-encoded leading segment', '/api/%69ntegration/pipelines'],
    ['query string smuggled into the path value', '/api/integration/pipelines?x=1'],
    ['fragment smuggled into the path value', '/api/integration/pipelines#x'],
    ['matrix parameter', '/api/integration/pipelines;a=b'],
    ['null byte', '/api/integration/pipelines%00'],
    ['trailing whitespace', '/api/integration/pipelines '],
    ['leading whitespace', ' /api/integration/pipelines'],
    ['lookalike plural prefix', '/api/integrations/pipelines'],
    ['lookalike hyphen prefix', '/api/integration-core/pipelines'],
    ['lookalike suffix on a leaf', '/api/integration/pipelines-archive'],
    ['deeper segment under a leaf route', '/api/integration/runs/r1'],
    ['deeper segment under a param route', '/api/integration/pipelines/p1/run'],
    ['sibling of a declared param route', '/api/integration/external-systems/s1/objects'],
    ['second withheld outbound route', '/api/integration/external-systems/s1/schema'],
    ['third withheld outbound route', '/api/integration/stock-preparation/source-preflight'],
    ['ungated plugin health route', '/api/integration/health'],
    ['admin-tier sibling of a declared route', '/api/integration/stock-preparation/source-binding'],
    ['stock-prep operator board under the declared projects route', '/api/integration/stock-preparation/projects/230920006/board'],
    ['empty id segment', '/api/integration/pipelines//'],
    ['bare subtree root', '/api/integration'],
    ['bare subtree root with slash', '/api/integration/'],
  ]

  for (const [label, path] of BYPASS_ATTEMPTS) {
    test(`REFUSES ${label}: ${path}`, () => {
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, MST)).toBe(false)
      // and the global switch must agree — it is the one index.ts actually calls.
      expect(isOapiAllowlistRequest('GET', path, MST)).toBe(false)
    })
  }
})

describe('G44 LOCKSTEP A — diffed against the plugin ROUTES table', () => {
  test('every declared path is a real GET route in the plugin ROUTES table', () => {
    const getPaths = new Set(PLUGIN_ROUTES.filter((r) => r.method === 'GET').map((r) => r.path))
    const phantom = DECLARED_PATHS.filter((p) => !getPaths.has(p))
    expect(
      phantom,
      `${phantom.length} allowlist entry/entries name a path the plugin does not register as GET:\n` +
        phantom.map((p) => `  - ${p}`).join('\n'),
    ).toEqual([])
  })

  test('each declared entry names the handler the plugin actually binds to that path', () => {
    const byPath = new Map(PLUGIN_ROUTES.filter((r) => r.method === 'GET').map((r) => [r.path, r.handler]))
    const mismatched = INTEGRATION_OAPI_READ_ROUTES.filter((r) => byPath.get(r.expressPath) !== r.handler)
    expect(mismatched.map((r) => r.expressPath)).toEqual([])
  })

  test('every OTHER registered (method, path) in the plugin is REJECTED — no over-match, no write reachable', () => {
    const leaked = PLUGIN_ROUTES.filter((r) => {
      if (r.method === 'GET' && DECLARED_SET.has(r.path)) return false
      return isIntegrationOapiReadAllowlistRequest(r.method, concrete(r.path), MST)
    })
    expect(
      leaked,
      `${leaked.length} plugin route(s) are admitted by the allowlist but are NOT declared read routes:\n` +
        leaked.map((r) => `  - ${r.method} ${r.path} (${r.handler})`).join('\n'),
    ).toEqual([])
  })

  test('the write surface is specifically unreachable (run / dry-run / apply / ensure / persist / install)', () => {
    const writes = PLUGIN_ROUTES.filter((r) => r.method !== 'GET')
    expect(writes.length).toBeGreaterThan(50)
    for (const route of writes) {
      const path = concrete(route.path)
      // The write METHOD is never admitted. That is the whole claim this test makes — deliberately.
      expect(
        isIntegrationOapiReadAllowlistRequest(route.method, path, MST),
        `${route.method} ${route.path} must never be token-reachable`,
      ).toBe(false)
    }
  })

  /**
   * GET on a write route's PATH is a different question, and asserting "never admitted" here would be
   * false: a write path can collide with a declared read pattern in two innocuous ways, and in both the
   * router sends the GET to a DECLARED read handler.
   *   1. same path, different method — `/external-systems` is a declared GET list AND a POST upsert;
   *   2. a static write leaf captured by a declared `:id` — `POST /templates/preview` shares its path
   *      with `GET /templates/:id`, so a GET there is `templatesGet` with `id='preview'` (a 404 lookup).
   * Neither reaches a write handler, because the method is still GET. The general form of this claim is
   * proved against the real router by the anti-bypass property test further down; this test just pins
   * the two known collisions by name so a future reader is not surprised by them.
   */
  test('GET on a write path only ever lands on a declared READ handler (the two known collisions, by name)', () => {
    // same path, different method
    expect(PLUGIN_ROUTES.some((r) => r.method === 'POST' && r.path === '/api/integration/external-systems')).toBe(true)
    expect(DECLARED_SET.has('/api/integration/external-systems')).toBe(true)
    expect(isIntegrationOapiReadAllowlistRequest('POST', '/api/integration/external-systems', MST)).toBe(false)

    // static write leaf captured by a declared `:id`
    expect(PLUGIN_ROUTES.some((r) => r.method === 'POST' && r.path === '/api/integration/templates/preview')).toBe(true)
    expect(DECLARED_SET.has('/api/integration/templates/preview')).toBe(false)
    expect(isIntegrationOapiReadAllowlistRequest('GET', '/api/integration/templates/preview', MST)).toBe(true)
    expect(isIntegrationOapiReadAllowlistRequest('POST', '/api/integration/templates/preview', MST)).toBe(false)

    // THE INVENTORY. Every write path on which a GET is admitted, pinned exactly. Each one is a
    // method-collision of the two shapes above; the safety claim (each such GET lands on a DECLARED
    // read handler in the real router) is carried by the anti-bypass property test, not by this list.
    // This list exists so that GROWING it is a reviewed event rather than a silent one.
    const getAdmittedWritePaths = PLUGIN_ROUTES.filter(
      (r) => r.method !== 'GET' && isIntegrationOapiReadAllowlistRequest('GET', concrete(r.path), MST),
    ).map((r) => r.path)
    expect([...new Set(getAdmittedWritePaths)].sort()).toEqual([
      '/api/integration/external-systems',
      '/api/integration/external-systems/:id',
      '/api/integration/pipelines',
      '/api/integration/read-source-compositions',
      '/api/integration/read-source-configs',
      '/api/integration/table-actions/:actionId/conflict-policies',
      '/api/integration/templates',
      '/api/integration/templates/:id',
      '/api/integration/templates/derive',
      '/api/integration/templates/preview',
    ])
  })

  test('the `mst_` token cannot reach POST run or any dry-run by name', () => {
    const named = [
      ['POST', '/api/integration/pipelines/p1/run'],
      ['POST', '/api/integration/pipelines/p1/dry-run'],
      ['POST', '/api/integration/pipelines/p1/external-write/dry-run'],
      ['POST', '/api/integration/pipelines/p1/external-write/apply'],
      ['POST', '/api/integration/table-actions/a1/dry-run'],
      ['POST', '/api/integration/table-actions/a1/apply'],
      ['POST', '/api/integration/read-source-configs/c1/read'],
      ['POST', '/api/integration/read-source-compositions/c1/run'],
      ['POST', '/api/integration/stock-preparation/generation/run'],
      ['POST', '/api/integration/external-systems/s1/test'],
      ['DELETE', '/api/integration/external-systems/s1'],
      ['PUT', '/api/integration/table-actions/a1/conflict-policies'],
      ['DELETE', '/api/integration/table-actions/a1/conflict-policies'],
    ] as const
    for (const [method, path] of named) {
      expect(isIntegrationOapiReadAllowlistRequest(method, path, MST)).toBe(false)
      expect(isOapiAllowlistRequest(method, path, MST)).toBe(false)
    }
  })
})

describe('G44 LOCKSTEP B — the declared set equals the stated mechanical rule', () => {
  test('declared set === { GET routes gated exactly requireAccess(req, "read") } − { the 3 outbound probes }', () => {
    const readTierGets = PLUGIN_ROUTES.filter(
      (r) => r.method === 'GET' && HANDLER_GATES.get(r.handler) === "requireAccess(req, 'read')",
    ).map((r) => r.path)
    expect(readTierGets.length).toBeGreaterThan(20)

    const expected = readTierGets.filter((p) => !OUTBOUND_EXCLUSIONS.includes(p as never)).sort()
    expect([...DECLARED_PATHS].sort()).toEqual(expected)
  })

  test('the three withheld outbound probes really are read-tier (so their absence is a choice, not an accident)', () => {
    const byPath = new Map(PLUGIN_ROUTES.filter((r) => r.method === 'GET').map((r) => [r.path, r.handler]))
    for (const path of OUTBOUND_EXCLUSIONS) {
      const handler = byPath.get(path)
      expect(handler, `${path} is no longer a registered GET`).toBeTruthy()
      expect(HANDLER_GATES.get(handler as string)).toBe("requireAccess(req, 'read')")
      expect(DECLARED_SET.has(path)).toBe(false)
    }
  })

  test('no admin-tier or stock-prep-vocabulary GET is declared', () => {
    const byPath = new Map(PLUGIN_ROUTES.filter((r) => r.method === 'GET').map((r) => [r.path, r.handler]))
    for (const path of DECLARED_PATHS) {
      const gate = HANDLER_GATES.get(byPath.get(path) as string)
      expect(gate, `${path} has no discoverable gate`).toBeTruthy()
      expect(gate).not.toContain("'admin'")
      expect(gate).not.toContain('STOCK_PREP_')
    }
  })
})

describe('G44 LOCKSTEP C — the declared set equals the published OpenAPI contract', () => {
  const contractPaths = (() => {
    const src = readFileSync(OPENAPI_FILE, 'utf8')
    const out: string[] = []
    for (const line of src.split(/\r?\n/)) {
      const m = line.match(/^ {2}(\/api\/integration\/\S*):\s*$/)
      if (m) out.push(m[1])
    }
    return out
  })()

  test('the contract scan is not vacuous', () => {
    expect(contractPaths.length).toBe(INTEGRATION_OAPI_READ_ROUTES.length)
  })

  test('contract path set === allowlist path set (OpenAPI {param} ⇄ Express :param)', () => {
    const fromAllowlist = DECLARED_PATHS.map((p) => p.replace(/:([^/]+)/g, '{$1}')).sort()
    expect([...contractPaths].sort()).toEqual(fromAllowlist)
  })

  test('every contract operation is a GET and carries the integration:read token-scope marker', () => {
    const src = readFileSync(OPENAPI_FILE, 'utf8')
    const lines = src.split(/\r?\n/)
    const methodLines = lines.filter((l) => /^ {4}(get|post|put|patch|delete):\s*$/.test(l))
    expect(methodLines.length).toBe(INTEGRATION_OAPI_READ_ROUTES.length)
    expect(methodLines.every((l) => l.trim() === 'get:')).toBe(true)

    const scopeMarkers = lines.filter((l) => l.trim() === 'x-api-token-scope: integration:read')
    expect(scopeMarkers.length).toBe(INTEGRATION_OAPI_READ_ROUTES.length)
  })
})

/**
 * THE anti-bypass proof, stated as a property instead of a list of guesses.
 *
 * A bypass is not "the matcher matched something odd"; it is "the matcher admitted a request that the
 * REAL Express router then dispatches to a handler outside the declared set". So this block builds an
 * Express app from the plugin's ACTUAL ROUTES table (all 122 registrations, same order, each handler
 * answering with its own name), fires every probe in the corpus at it, and asserts the implication:
 *
 *     matcher admits (method, path)  ⟹  Express dispatches it to a DECLARED GET handler
 *
 * The converse is deliberately NOT asserted. The matcher is narrower than the router by design (case,
 * trailing slash, HEAD), and every such disagreement is a token getting 401 where a session user gets
 * 200 — fail-closed, harmless, and pinned as such below.
 *
 * This is also where the two percent-encoding cases are settled with evidence rather than intuition:
 * `%2f` and `%2E%2E` inside a single segment are admitted, and the router agrees they are ONE segment,
 * dispatching them to the declared `pipelinesGet` with a decoded-but-opaque `id`. No write leg and no
 * undeclared handler is reachable through either.
 */
describe('G44 anti-bypass property — matcher ⟹ real Express dispatch lands on a declared GET', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any
  let port = 0

  const DECLARED_HANDLERS = new Set(INTEGRATION_OAPI_READ_ROUTES.map((r) => r.handler))

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express')
    const app = express()
    for (const route of PLUGIN_ROUTES) {
      const verb = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
      app[verb](route.path, (_req: unknown, res: { json: (b: unknown) => void }) =>
        res.json({ handler: route.handler }),
      )
    }
    app.use((_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
      res.status(404).json({ handler: null }),
    )
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        port = server.address().port
        resolve()
      })
    })
  })

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function dispatch(method: string, path: string): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require('node:http')
    return new Promise((resolve) => {
      const req = http.request(
        { port, method, path },
        (res: NodeJS.ReadableStream & { statusCode: number }) => {
          let buf = ''
          res.on('data', (c: Buffer) => (buf += String(c)))
          res.on('end', () => {
            try {
              resolve((JSON.parse(buf) as { handler: string | null }).handler)
            } catch {
              resolve(null)
            }
          })
        },
      )
      req.on('error', () => resolve(null))
      req.end()
    })
  }

  /** Declared paths + every bypass attempt + every plugin route, across every interesting method. */
  const PROBE_CORPUS: Array<readonly [string, string]> = (() => {
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
    const paths = new Set<string>()
    for (const r of INTEGRATION_OAPI_READ_ROUTES) paths.add(concrete(r.expressPath))
    for (const r of PLUGIN_ROUTES) paths.add(concrete(r.path))
    for (const p of [
      '/API/INTEGRATION/PIPELINES',
      '/api/Integration/pipelines',
      '/api/integration/pipelines/',
      '/api/integration/pipelines//',
      '//api/integration/pipelines',
      '/api/integration//pipelines',
      '/api/integration/pipelines/../table-actions/a1/apply',
      '/api/integration/pipelines/%2e%2e/table-actions',
      '/api/integration/pipelines/%2E%2E',
      '/api/integration/pipelines/p1%2frun',
      '/api/integration/pipelines/p1%2Frun',
      '/api/integration/pipelines%2fp1%2frun',
      '/api/integration/pipelines;a=b',
      '/api/integration/pipelines ',
      '/api/integration/health',
      '/api/integration/external-systems/s1/objects',
      '/api/integration/external-systems/s1/schema',
      '/api/integration/stock-preparation/source-preflight',
      '/api/integration/stock-preparation/projects/230920006/board',
      '/api/integration',
      '/api/integration/',
      '/api/integrations/pipelines',
      '/api/integration-core/pipelines',
    ]) {
      paths.add(p)
    }
    const out: Array<readonly [string, string]> = []
    for (const p of paths) for (const m of methods) out.push([m, p] as const)
    return out
  })()

  test('the probe corpus is large enough to be meaningful', () => {
    expect(PROBE_CORPUS.length).toBeGreaterThan(700)
  })

  test('EVERY admitted (method, path) dispatches to a DECLARED GET handler — no undeclared handler, no write leg', async () => {
    const violations: string[] = []
    for (const [method, path] of PROBE_CORPUS) {
      if (!isIntegrationOapiReadAllowlistRequest(method, path, MST)) continue
      // Only GET can ever be admitted; assert it rather than assume it.
      if (method !== 'GET') {
        violations.push(`${method} ${path}: a non-GET method was admitted`)
        continue
      }
      const handler = await dispatch(method, path)
      if (handler === null || !DECLARED_HANDLERS.has(handler)) {
        violations.push(`${method} ${path}: admitted but dispatched to ${handler ?? '<404/none>'}`)
      }
    }
    expect(
      violations,
      `${violations.length} admitted request(s) reach a handler outside the declared read set — this is ` +
        `the bypass class this allowlist exists to prevent:\n` + violations.map((v) => `  - ${v}`).join('\n'),
    ).toEqual([])
  }, 60000)

  test('percent-encoded separators/dots stay ONE segment for BOTH layers (admitted, and provably still the declared GET)', async () => {
    for (const path of [
      '/api/integration/pipelines/p1%2frun',
      '/api/integration/pipelines/p1%2Frun',
      '/api/integration/pipelines/%2E%2E',
      '/api/integration/pipelines/%2e%2e',
    ]) {
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, MST)).toBe(true)
      expect(await dispatch('GET', path)).toBe('pipelinesGet')
      // and the write leg they were shaped to reach stays unreachable
      expect(isIntegrationOapiReadAllowlistRequest('POST', path, MST)).toBe(false)
    }
    // The POST run leg the `%2f` shape imitates is a different, unadmitted route.
    expect(await dispatch('POST', '/api/integration/pipelines/p1/run')).toBe('pipelinesRun')
    expect(isIntegrationOapiReadAllowlistRequest('POST', '/api/integration/pipelines/p1/run', MST)).toBe(false)
  }, 30000)

  test('the router-wider cases are fail-CLOSED under-matches, not over-matches', async () => {
    // Express dispatches these to a declared GET; the matcher refuses them, so a token 401s. Safe.
    for (const path of ['/API/INTEGRATION/PIPELINES', '/api/Integration/pipelines', '/api/integration/pipelines/']) {
      expect(await dispatch('GET', path)).toBe('pipelinesList')
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, MST)).toBe(false)
    }
    // HEAD is dispatched to the GET handler by Express but refused by the matcher.
    expect(isIntegrationOapiReadAllowlistRequest('HEAD', '/api/integration/pipelines', MST)).toBe(false)
  }, 30000)

  test('the literal `..` climb and the doubled slash are refused by BOTH layers (Express does not normalise them)', async () => {
    for (const path of [
      '/api/integration/pipelines/../table-actions/a1/apply',
      '/api/integration/pipelines/%2e%2e/table-actions',
      '/api/integration//pipelines',
      '/api/integration/pipelines;a=b',
    ]) {
      expect(isIntegrationOapiReadAllowlistRequest('GET', path, MST)).toBe(false)
      expect(await dispatch('GET', path)).toBeNull()
    }
  }, 30000)
})

describe('G44 does not disturb the multitable allowlist', () => {
  test('the multitable read/write surface is unchanged by the new term', () => {
    expect(isOapiAllowlistRequest('GET', '/api/multitable/records', MST)).toBe(true)
    expect(isOapiAllowlistRequest('POST', '/api/multitable/records', MST)).toBe(true)
    expect(isOapiAllowlistRequest('GET', '/api/multitable/records/r1/history', MST)).toBe(false)
    expect(isOapiAllowlistRequest('POST', '/api/multitable/records/r1/lock', MST)).toBe(false)
  })

  test('the integration matcher never claims a multitable path', () => {
    for (const path of [
      '/api/multitable/records',
      '/api/multitable/fields',
      '/api/comments',
      '/api/comments/summary',
    ]) {
      expect(isIntegrationOapiReadPath('GET', path)).toBe(false)
    }
  })
})

/**
 * THE SUBTREE AND-CONSTRAINT — the one shape the lockstep tests structurally cannot see.
 *
 * Every row of the table carries TWO independent path strings: `expressPath` (diffed against the
 * plugin's ROUTES table by LOCKSTEP A/B) and a hand-written `pattern` (what actually decides
 * admission). Nothing forces them to agree. A row with a legitimate `expressPath` and a `pattern`
 * naming a branch OUTSIDE `/api/integration` would satisfy every other assertion in this file — and it
 * would be the worst possible result, because the app-level gate only intercepts the subtree
 * (`integration-api-token-gate.ts`), so the global switch (`multitable/oapi-read-allowlist.ts:129`)
 * would admit an `mst_` bearer onto a route with no token guard behind it at all.
 *
 * `isIntegrationOapiReadPath` therefore AND-composes the subtree test over the table. These tests
 * inject exactly that bad row, assert the constraint holds, and restore the table.
 */
describe('G44 the matcher is AND-constrained to the subtree, whatever a row pattern says', () => {
  const table = INTEGRATION_OAPI_READ_ROUTES as unknown as IntegrationOapiReadRoute[]
  const ESCAPEES: ReadonlyArray<readonly [string, RegExp, string]> = [
    ['a sibling API subtree', /^\/api\/multitable\/records$/, '/api/multitable/records'],
    ['an admin route', /^\/api\/admin\/users$/, '/api/admin/users'],
    ['a lookalike prefix', /^\/api\/integrations\/pipelines$/, '/api/integrations/pipelines'],
    ['a wildcard that swallows everything', /^\/api\/.*$/, '/api/admin/users'],
  ]

  test('the probes are real — each injected pattern genuinely matches its probe path on its own', () => {
    for (const [, pattern, probe] of ESCAPEES) expect(pattern.test(probe)).toBe(true)
  })

  for (const [label, pattern, probe] of ESCAPEES) {
    test(`a hand-written pattern reaching ${label} still cannot admit`, () => {
      const before = table.length
      table.push({ expressPath: '/api/integration/status', handler: 'status', pattern })
      try {
        expect(isIntegrationOapiReadPath('GET', probe)).toBe(false)
        expect(isIntegrationOapiReadAllowlistRequest('GET', probe, MST)).toBe(false)
        // and the global switch stays where it was for a path no multitable term claims
        if (probe === '/api/admin/users' || probe === '/api/integrations/pipelines') {
          expect(isOapiAllowlistRequest('GET', probe, MST)).toBe(false)
        }
      } finally {
        table.pop()
      }
      expect(table.length).toBe(before)
    })
  }

  test('the table is intact afterwards — no injected row leaked into the contract', () => {
    expect(INTEGRATION_OAPI_READ_ROUTES.length).toBe(24)
    expect(INTEGRATION_OAPI_READ_ROUTES.every((r) => r.expressPath.startsWith('/api/integration/'))).toBe(true)
    expect(
      INTEGRATION_OAPI_READ_ROUTES.every((r) => String(r.pattern).startsWith('/^\\/api\\/integration\\/')),
    ).toBe(true)
  })
})
