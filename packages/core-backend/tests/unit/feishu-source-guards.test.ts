/**
 * Source guards for the Feishu integration, shared by every slice that adds Feishu code. This file is
 * owned by the shared-foundation slice; later slices only append to the importer allowlist below.
 *
 *  G-S1  no Feishu module reads a Feishu credential from the environment
 *  G-S2  no legacy QR login script and no legacy authorization address in any source or public asset
 *  G-S3  no legacy token endpoint; the current token path is written once, in endpoints.ts
 *  G-S4  a Feishu host name is written only in endpoints.ts
 *  G-S5  the importers of the Feishu modules are exactly the allowlist
 *  also: the transport is the only requester; redirects are set once, to manual; production code does
 *        not name the endpoint test seam; the Feishu admin route is not mounted by the entry point.
 *
 * Forbidden literals are assembled from fragments, so that this file does not contain them and the
 * guards do not match themselves; a case below reads this file and asserts exactly that. Each scanner
 * takes a map of files, so a case can hand it a file that violates the rule.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  NON_LITERAL_SPECIFIER,
  collectImportEdges,
  importEdgeViolations,
  importSpecifiers,
  listAllFiles,
  type ImportEdge,
} from '../helpers/import-edge-allowlist'

const BACKEND = path.resolve(__dirname, '..', '..')
const ROOT = path.resolve(BACKEND, '..', '..')
const SRC = path.join(BACKEND, 'src')
const WEB_SRC = path.join(ROOT, 'apps', 'web', 'src')
const PUBLIC_DIRS = [path.join(ROOT, 'apps', 'web', 'public'), path.join(BACKEND, 'public')]
const THIS_FILE = path.join(BACKEND, 'tests', 'unit', 'feishu-source-guards.test.ts')

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json', '.html', '.htm', '.css', '.scss', '.svg',
  '.txt', '.yml', '.yaml', '.sql', '.md',
])

/** `rel path -> text` of every text file below `root`; paths are relative to `root` with `/` separators. */
function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>()
  if (!existsSync(root)) return files
  for (const file of listAllFiles(root)) {
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue
    files.set(path.relative(root, file).split(path.sep).join('/'), readFileSync(file, 'utf8'))
  }
  return files
}

// ── forbidden literals, assembled ─────────────────────────────────────────────────────────────────
const dot = (...parts: string[]): string => parts.join('.')
const LEGACY_QR_SCRIPT = ['Lark', 'SSO', 'SDK', 'Web', 'QR', 'Code'].join('')
const LEGACY_AUTHORIZE = `${dot('passport', 'feishu', 'cn')}/suite/passport/oauth/authorize`
const LEGACY_LARK_PASSPORT = dot('passport', 'larksuite')
const LEGACY_USER_TOKEN_PATH = ['authen', 'v2', 'oauth', 'token'].join('/')
const LEGACY_TENANT_TOKEN_PATH = ['auth', 'v3', 'tenant_access_token'].join('/')
const CURRENT_TOKEN_PATH = ['', 'oauth', 'v3', 'token'].join('/')
const ENV_PREFIX = ['FEI', 'SHU_'].join('')
const HOST_SUFFIXES = [dot('feishu', 'cn'), dot('feishu', 'net'), dot('feishucdn', 'com'), dot('larksuite', 'com'), dot('larkoffice', 'com'), dot('larksuitecdn', 'com')]

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const ENV_READ_RE = new RegExp(
  `process\\s*\\.\\s*env\\s*(?:\\.|\\[\\s*['"\`])\\s*${ENV_PREFIX}|\\b${ENV_PREFIX}APP_(?:ID|SECRET)\\b`,
)
const HOST_RE = new RegExp(`(?:${HOST_SUFFIXES.map(escapeRe).join('|')})`, 'i')

// ── G-S1 ───────────────────────────────────────────────────────────────────────────────────────────
const CHANNEL_FILE_RES: readonly RegExp[] = [
  /^integrations\/feishu\//,
  /^directory\/adapters\/feishu-/,
  /^auth\/adapters\/feishu-/,
  /^notifications\/adapters\/feishu-/,
  /^services\/feishu-/,
  /^routes\/admin-directory-feishu\.ts$/,
]

function envReadViolations(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([file]) => CHANNEL_FILE_RES.some((re) => re.test(file)))
    .filter(([, text]) => ENV_READ_RE.test(text))
    .map(([file]) => file)
    .sort()
}

// ── G-S2 ───────────────────────────────────────────────────────────────────────────────────────────
function legacyLoginViolations(files: ReadonlyMap<string, string>): string[] {
  const literals = [LEGACY_QR_SCRIPT, LEGACY_AUTHORIZE, LEGACY_LARK_PASSPORT]
  return [...files]
    .filter(([, text]) => literals.some((literal) => text.includes(literal)))
    .map(([file]) => file)
    .sort()
}

// ── G-S3 ───────────────────────────────────────────────────────────────────────────────────────────
function legacyTokenEndpointViolations(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([, text]) => text.includes(LEGACY_USER_TOKEN_PATH) || text.includes(LEGACY_TENANT_TOKEN_PATH))
    .map(([file]) => file)
    .sort()
}

const countOf = (text: string, needle: string): number => text.split(needle).length - 1

/** Files other than endpoints.ts that write the current token path, plus a count problem in endpoints.ts. */
function currentTokenPathViolations(files: ReadonlyMap<string, string>): string[] {
  const violations = [...files]
    .filter(([file, text]) => file !== 'integrations/feishu/endpoints.ts' && text.includes(CURRENT_TOKEN_PATH))
    .map(([file]) => `elsewhere: ${file}`)
  const endpoints = files.get('integrations/feishu/endpoints.ts')
  const count = endpoints === undefined ? 0 : countOf(endpoints, CURRENT_TOKEN_PATH)
  if (count !== 1) violations.push(`endpoints.ts writes the token path ${count} times`)
  return violations.sort()
}

// ── G-S4 ───────────────────────────────────────────────────────────────────────────────────────────
function hostLiteralViolations(files: ReadonlyMap<string, string>, allowed: (file: string) => boolean): string[] {
  return [...files]
    .filter(([file, text]) => !allowed(file) && HOST_RE.test(text))
    .map(([file]) => file)
    .sort()
}

// ── G-S5 ───────────────────────────────────────────────────────────────────────────────────────────
/** A module specifier that loads a Feishu integration module, with any directory prefix and any .js/.ts suffix. */
const FEISHU_MODULE = /(?:^|\/)integrations\/feishu(?:\/[^/]+)?$/
const FEISHU_MODULE_MENTION = /integrations\/feishu/
/** A specifier that loads the Feishu admin route. */
const FEISHU_ROUTE_MODULE = /(?:^|\/)admin-directory-feishu(?:\.[cm]?[jt]s)?$/
const FEISHU_ROUTE_MENTION = /admin-directory-feishu/

/**
 * Files outside integrations/feishu that load a Feishu module, as (file, specifier). Later slices append
 * their own importers here: the directory adapter and the contact client, the identity adapter and the
 * OAuth client, the sender and the message client, and the entry-point wiring of each route.
 */
const FEISHU_IMPORT_ALLOWLIST: ReadonlyArray<ImportEdge> = [
  ['routes/admin-directory-feishu.ts', '../integrations/feishu/redaction'],
  ['routes/admin-directory-feishu.ts', '../integrations/feishu/token'],
  ['routes/admin-directory-feishu.ts', '../integrations/feishu/verify'],
  ['services/feishu-message-sender.ts', '../integrations/feishu/config'],
  ['services/feishu-message-sender.ts', '../integrations/feishu/errors'],
  ['services/feishu-message-sender.ts', '../integrations/feishu/message-client'],
  ['services/feishu-message-sender.ts', '../integrations/feishu/redaction'],
  ['services/feishu-message-sender.ts', '../integrations/feishu/token'],
]

/** Importers of the Feishu admin route: none until the entry point mounts it. */
const FEISHU_ROUTE_IMPORT_ALLOWLIST: ReadonlyArray<ImportEdge> = []

const FORBIDDEN_IMPORTERS = [
  'directory/directory-sync.ts',
  'services/NotificationService.ts',
  'auth/dingtalk-oauth.ts',
  'routes/auth.ts',
]

function feishuImportEdges(files: ReadonlyMap<string, string>): ImportEdge[] {
  const edges: ImportEdge[] = []
  for (const [file, text] of files) {
    if (file.startsWith('integrations/feishu/')) continue
    if (!FEISHU_MODULE_MENTION.test(text)) continue
    for (const specifier of importSpecifiers(text, file)) {
      if (specifier === NON_LITERAL_SPECIFIER || FEISHU_MODULE.test(specifier)) edges.push([file, specifier])
    }
  }
  return edges
}

function feishuRouteImportEdges(files: ReadonlyMap<string, string>): ImportEdge[] {
  const edges: ImportEdge[] = []
  for (const [file, text] of files) {
    if (file === 'routes/admin-directory-feishu.ts') continue
    if (!FEISHU_ROUTE_MENTION.test(text)) continue
    for (const specifier of importSpecifiers(text, file)) {
      if (specifier === NON_LITERAL_SPECIFIER || FEISHU_ROUTE_MODULE.test(specifier)) edges.push([file, specifier])
    }
  }
  return edges
}

// ── the rest of the Feishu directory ───────────────────────────────────────────────────────────────
const REQUESTER_RE =
  /\b(?:fetch|axios|got)\s*\(|from\s+['"](?:node:)?https?['"]|from\s+['"](?:axios|undici|node-fetch|got)['"]|\bXMLHttpRequest\b|globalThis\s*\.\s*fetch|require\s*\(\s*['"](?:node:)?https?['"]/

/** Block comments and line comments removed: what a comment says cannot issue a request or set an option. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function feishuDirFiles(files: ReadonlyMap<string, string>): Array<[string, string]> {
  return [...files].filter(([file]) => file.startsWith('integrations/feishu/'))
}

function requesterViolations(files: ReadonlyMap<string, string>): string[] {
  return feishuDirFiles(files)
    .filter(([file, text]) => file !== 'integrations/feishu/transport.ts' && REQUESTER_RE.test(withoutComments(text)))
    .map(([file]) => file)
    .sort()
}

function redirectSettings(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = []
  for (const [file, text] of feishuDirFiles(files)) {
    for (const match of withoutComments(text).matchAll(/\bredirect\s*:\s*([^,}\n]+)/g)) found.push(`${file}: ${match[1].trim()}`)
  }
  return found.sort()
}

function testSeamViolations(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([file, text]) => file !== 'integrations/feishu/endpoints.ts' && text.includes('__feishuEndpointsForTests'))
    .map(([file]) => file)
    .sort()
}

// ── the real tree ──────────────────────────────────────────────────────────────────────────────────
const src = readTree(SRC)
const web = readTree(WEB_SRC)
const publicAssets = new Map<string, string>()
for (const dir of PUBLIC_DIRS) for (const [file, text] of readTree(dir)) publicAssets.set(`${dir}/${file}`, text)
const prefixed = (prefix: string, files: ReadonlyMap<string, string>): Map<string, string> =>
  new Map([...files].map(([file, text]) => [`${prefix}/${file}`, text]))
const allSources = new Map<string, string>([...src, ...prefixed('web', web), ...publicAssets])

describe('the scanned tree is not empty', () => {
  it('reads the backend sources, the web sources and the Feishu directory', () => {
    expect(src.size).toBeGreaterThan(500)
    expect(web.size).toBeGreaterThan(100)
    expect(feishuDirFiles(src).map(([file]) => file)).toEqual(
      expect.arrayContaining([
        'integrations/feishu/endpoints.ts',
        'integrations/feishu/errors.ts',
        'integrations/feishu/transport.ts',
        'integrations/feishu/token.ts',
        'integrations/feishu/config.ts',
        'integrations/feishu/redaction.ts',
        'integrations/feishu/verify.ts',
      ]),
    )
  })
})

describe('G-S1: no Feishu credential is read from the environment', () => {
  it('holds for every Feishu module', () => {
    expect(envReadViolations(src)).toEqual([])
  })

  it('sees an environment read, in any spelling, in a Feishu module and in no other file', () => {
    const read = `const id = process.env.${ENV_PREFIX}APP_ID`
    expect(envReadViolations(new Map([['integrations/feishu/config.ts', read]]))).toEqual(['integrations/feishu/config.ts'])
    expect(envReadViolations(new Map([['directory/adapters/feishu-directory-adapter.ts', `process.env['${ENV_PREFIX}X']`]]))).toHaveLength(1)
    expect(envReadViolations(new Map([['auth/adapters/feishu-identity-adapter.ts', `const { ${ENV_PREFIX}APP_SECRET: s } = env`]]))).toHaveLength(1)
    expect(envReadViolations(new Map([['routes/admin-directory-feishu.ts', `process . env . ${ENV_PREFIX}Y`]]))).toHaveLength(1)
    expect(envReadViolations(new Map([['routes/other.ts', read]]))).toEqual([])
  })
})

describe('G-S2: no legacy QR login script and no legacy authorization address', () => {
  it('holds for the backend sources, the web sources and the public assets', () => {
    expect(legacyLoginViolations(allSources)).toEqual([])
  })

  it('sees each literal', () => {
    for (const literal of [LEGACY_QR_SCRIPT, LEGACY_AUTHORIZE, LEGACY_LARK_PASSPORT]) {
      expect(legacyLoginViolations(new Map([['a.ts', `x('${literal}')`]]))).toEqual(['a.ts'])
    }
  })
})

describe('G-S3: no legacy token endpoint; the current token path is written once', () => {
  it('holds for the backend sources', () => {
    expect(legacyTokenEndpointViolations(src)).toEqual([])
    expect(currentTokenPathViolations(src)).toEqual([])
  })

  it('sees each legacy path, a second writing of the current path, and a missing one', () => {
    expect(legacyTokenEndpointViolations(new Map([['a.ts', LEGACY_USER_TOKEN_PATH]]))).toEqual(['a.ts'])
    expect(legacyTokenEndpointViolations(new Map([['a.ts', LEGACY_TENANT_TOKEN_PATH]]))).toEqual(['a.ts'])
    const endpoints = 'integrations/feishu/endpoints.ts'
    expect(currentTokenPathViolations(new Map([[endpoints, `path: '${CURRENT_TOKEN_PATH}'`]]))).toEqual([])
    expect(currentTokenPathViolations(new Map([[endpoints, `'${CURRENT_TOKEN_PATH}' '${CURRENT_TOKEN_PATH}'`]]))).toHaveLength(1)
    expect(currentTokenPathViolations(new Map([[endpoints, `'${CURRENT_TOKEN_PATH}'`], ['b.ts', CURRENT_TOKEN_PATH]]))).toEqual(['elsewhere: b.ts'])
    expect(currentTokenPathViolations(new Map())).toHaveLength(1)
  })
})

describe('G-S4: a Feishu host name is written only in endpoints.ts', () => {
  const onlyEndpoints = (file: string): boolean => file === 'integrations/feishu/endpoints.ts'

  it('holds for the backend sources and the web sources', () => {
    expect(hostLiteralViolations(src, onlyEndpoints)).toEqual([])
    expect(hostLiteralViolations(web, () => false)).toEqual([])
  })

  it('sees a host name in another file, in every listed domain, and allows it in endpoints.ts', () => {
    for (const suffix of HOST_SUFFIXES) {
      expect(hostLiteralViolations(new Map([['a.ts', `const u = 'https://open.${suffix}/x'`]]), onlyEndpoints)).toEqual(['a.ts'])
    }
    expect(hostLiteralViolations(new Map([['integrations/feishu/endpoints.ts', `'https://open.${HOST_SUFFIXES[0]}'`]]), onlyEndpoints)).toEqual([])
    expect(hostLiteralViolations(new Map([['a.ts', `'https://open.${HOST_SUFFIXES[0].toUpperCase()}'`]]), onlyEndpoints)).toEqual(['a.ts'])
  })

  it('endpoints.ts does write the hosts (the guard is not vacuous)', () => {
    expect(HOST_RE.test(src.get('integrations/feishu/endpoints.ts') ?? '')).toBe(true)
  })
})

describe('G-S5: importers of the Feishu modules are exactly the allowlist', () => {
  it('under the backend sources', () => {
    expect(importEdgeViolations(feishuImportEdges(src), FEISHU_IMPORT_ALLOWLIST)).toEqual([])
  })

  it('the same holds through the shared edge collector (any load form, any directory)', () => {
    const found = collectImportEdges(SRC, FEISHU_MODULE_MENTION, (file) => readFileSync(file, 'utf8')).filter(
      ([file, specifier]) => !file.startsWith(`integrations${path.sep}feishu${path.sep}`) && (specifier === NON_LITERAL_SPECIFIER || FEISHU_MODULE.test(specifier)),
    )
    expect(importEdgeViolations(found.map(([file, specifier]): ImportEdge => [file.split(path.sep).join('/'), specifier]), FEISHU_IMPORT_ALLOWLIST)).toEqual([])
  })

  it('the directory sync, the notification service and the two login entry points do not import them', () => {
    for (const file of FORBIDDEN_IMPORTERS) {
      const text = src.get(file)
      expect(text, `${file} exists`).toBeDefined()
      const specifiers = importSpecifiers(text as string, file)
      expect(specifiers.filter((specifier) => FEISHU_MODULE.test(specifier) || FEISHU_ROUTE_MODULE.test(specifier)), file).toEqual([])
    }
  })

  it('sees a new importer, a second load, a dynamic and a template load, a require, a re-export and a .js suffix', () => {
    const edge = (text: string, file = 'x/new.ts'): ImportEdge[] => feishuImportEdges(new Map([[file, text]]))
    const violations = (found: ImportEdge[]): string[] => importEdgeViolations(found, FEISHU_IMPORT_ALLOWLIST)
    expect(violations(edge("import { a } from '../integrations/feishu/token'"))).toContain('unexpected: x/new.ts -> ../integrations/feishu/token')
    expect(violations(edge("import('../integrations/feishu/token')"))).toHaveLength(FEISHU_IMPORT_ALLOWLIST.length + 1)
    expect(violations(edge('import(`../integrations/feishu/token`)'))).toHaveLength(FEISHU_IMPORT_ALLOWLIST.length + 1)
    expect(violations(edge("const t = require('../integrations/feishu/token.js')"))).toHaveLength(FEISHU_IMPORT_ALLOWLIST.length + 1)
    expect(violations(edge("export * from '../integrations/feishu/token'"))).toHaveLength(FEISHU_IMPORT_ALLOWLIST.length + 1)
    expect(violations(edge("const n = 'integrations/feishu'; import(n)"))).toHaveLength(FEISHU_IMPORT_ALLOWLIST.length + 1)
    // a second load from an allowed file is a violation
    const twice = edge(
      "import { a } from '../integrations/feishu/verify'\nimport { b } from '../integrations/feishu/verify'",
      'routes/admin-directory-feishu.ts',
    )
    expect(violations(twice).some((line) => line.startsWith('unexpected: routes/admin-directory-feishu.ts'))).toBe(true)
  })

  it('no file loads the Feishu admin route: the entry point does not mount it', () => {
    expect(importEdgeViolations(feishuRouteImportEdges(src), FEISHU_ROUTE_IMPORT_ALLOWLIST)).toEqual([])
    expect(feishuRouteImportEdges(new Map([['index.ts', "import { adminDirectoryFeishuRouter } from './routes/admin-directory-feishu'"]]))).toEqual([
      ['index.ts', './routes/admin-directory-feishu'],
    ])
  })
})

describe('the transport is the only requester in the Feishu directory', () => {
  it('holds', () => {
    expect(requesterViolations(src)).toEqual([])
  })

  it('sees a direct request, a client library and a node http import', () => {
    for (const text of ['fetch(url)', 'await axios(x)', "import https from 'node:https'", "import x from 'undici'", 'globalThis.fetch', 'new XMLHttpRequest()']) {
      expect(requesterViolations(new Map([['integrations/feishu/token.ts', text]])), text).toEqual(['integrations/feishu/token.ts'])
    }
    expect(requesterViolations(new Map([['integrations/feishu/transport.ts', 'fetch(url)']]))).toEqual([])
    expect(requesterViolations(new Map([['integrations/feishu/token.ts', 'fetchFn?: typeof fetch']]))).toEqual([])
    expect(requesterViolations(new Map([['integrations/feishu/token.ts', '// fetch(url) is not allowed here\n/* axios(x) */']]))).toEqual([])
  })
})

describe('redirects are never followed', () => {
  it('the Feishu directory sets the redirect option exactly once, to manual', () => {
    expect(redirectSettings(src)).toEqual(["integrations/feishu/transport.ts: 'manual'"])
  })

  it('sees a second or a different setting', () => {
    expect(redirectSettings(new Map([['integrations/feishu/a.ts', "init({ redirect: 'follow' })"]]))).toEqual(["integrations/feishu/a.ts: 'follow'"])
    expect(redirectSettings(new Map([['integrations/feishu/a.ts', "{ redirect: 'error', x: 1 }"]]))).toEqual(["integrations/feishu/a.ts: 'error'"])
  })
})

describe('production code does not name the endpoint test seam', () => {
  it('holds', () => {
    expect(testSeamViolations(src)).toEqual([])
  })

  it('sees a use outside endpoints.ts', () => {
    expect(testSeamViolations(new Map([['integrations/feishu/token.ts', '__feishuEndpointsForTests.replace(x)']]))).toEqual(['integrations/feishu/token.ts'])
    expect(testSeamViolations(new Map([['integrations/feishu/endpoints.ts', 'export const __feishuEndpointsForTests = 1']]))).toEqual([])
  })
})

describe('this file does not contain what it forbids', () => {
  it('holds none of the full literals', () => {
    const own = readFileSync(THIS_FILE, 'utf8')
    for (const literal of [LEGACY_QR_SCRIPT, LEGACY_AUTHORIZE, LEGACY_LARK_PASSPORT, LEGACY_USER_TOKEN_PATH, LEGACY_TENANT_TOKEN_PATH, CURRENT_TOKEN_PATH, `${ENV_PREFIX}APP_ID`, `${ENV_PREFIX}APP_SECRET`]) {
      expect(own.includes(literal), literal).toBe(false)
    }
    for (const suffix of HOST_SUFFIXES) expect(own.includes(suffix), suffix).toBe(false)
  })
})
