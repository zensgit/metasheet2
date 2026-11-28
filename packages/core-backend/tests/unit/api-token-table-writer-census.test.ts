/**
 * The API token table writer registry matches production references and statement counts.
 * Each registered writer records its session checks, users row lock and transaction isolation.
 * Direct table references and non-literal writes match their registered forms and counts.
 * The registered adapter retains its insert, update and delete markers, and its interpolated
 * statement count matches the authorization input writer registry.
 * The parameterized migration helper retains its registered source marker.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS } from '../../src/rbac/authorization-input-writers'

const REPO = path.resolve(__dirname, '../../../..')
const CORE = 'packages/core-backend/src'

type WriteKind = 'INSERT' | 'UPDATE' | 'DELETE' | 'MERGE' | 'TRUNCATE'

type WriterRow = {
  file: string
  writer: string
  kind: WriteKind
  /** What the writer leaves for the issuance fence to see. */
  fenceSignal: string
  /** How the writer holds the creator users row before writing tokens. */
  usersRowLock: string
  /** Whether the transaction around the write pins READ COMMITTED. */
  readCommitted: 'pinned' | 'single-statement' | 'caller-transaction'
  /** Whether a configuration flag decides if the write runs. */
  flagGated: boolean
}

const WRITERS: readonly WriterRow[] = [
  {
    file: `${CORE}/multitable/api-token-service.ts`,
    writer: 'ApiTokenService.createToken',
    kind: 'INSERT',
    fenceSignal: 'issuer: runs the issuance fence before the insert',
    usersRowLock: 'shared user access key, then FOR SHARE',
    readCommitted: 'pinned',
    flagGated: false,
  },
  {
    file: `${CORE}/multitable/api-token-service.ts`,
    writer: 'ApiTokenService.revokeToken (owner delete)',
    kind: 'UPDATE',
    fenceSignal: 'none',
    usersRowLock: 'none',
    readCommitted: 'single-statement',
    flagGated: false,
  },
  {
    file: `${CORE}/multitable/api-token-service.ts`,
    writer: 'ApiTokenService.validateToken (last_used_at)',
    kind: 'UPDATE',
    fenceSignal: 'none',
    usersRowLock: 'none',
    readCommitted: 'single-statement',
    flagGated: false,
  },
  {
    file: `${CORE}/multitable/api-token-service.ts`,
    writer: 'ApiTokenService.rotateToken (revoke old)',
    kind: 'UPDATE',
    fenceSignal: 'issuer: runs the issuance fence before the revoke',
    usersRowLock: 'shared user access key, then FOR SHARE',
    readCommitted: 'pinned',
    flagGated: false,
  },
  {
    file: `${CORE}/multitable/api-token-service.ts`,
    writer: 'ApiTokenService.rotateToken (insert new)',
    kind: 'INSERT',
    fenceSignal: 'issuer: runs the issuance fence before the insert',
    usersRowLock: 'shared user access key, then FOR SHARE',
    readCommitted: 'pinned',
    flagGated: false,
  },
  {
    file: `${CORE}/auth/strict-credential-chain.ts`,
    writer: 'applySelectedCredentialLegs (token leg)',
    kind: 'UPDATE',
    fenceSignal: 'access_generation (advanced here with a legacy effect, otherwise by the calling transaction)',
    usersRowLock: 'FOR UPDATE (reselectHeldUser)',
    readCommitted: 'caller-transaction',
    flagGated: true,
  },
  {
    file: `${CORE}/admin/user-recycle.ts`,
    writer: 'applyRecycleMove',
    kind: 'UPDATE',
    fenceSignal: 'is_active = FALSE',
    usersRowLock: 'UPDATE users first',
    readCommitted: 'caller-transaction',
    flagGated: false,
  },
  {
    file: `${CORE}/admin/user-recycle.ts`,
    writer: 'applyRecyclePurge',
    kind: 'UPDATE',
    fenceSignal: 'is_active = FALSE',
    usersRowLock: 'UPDATE users first',
    readCommitted: 'caller-transaction',
    flagGated: false,
  },
  {
    file: `${CORE}/auth/dingtalk-identity-repair.ts`,
    writer: 'revoke (apply, reanchor, rollback)',
    kind: 'UPDATE',
    fenceSignal: 'access_generation (advanced before revoke)',
    usersRowLock: 'FOR UPDATE after the exclusive user access key',
    readCommitted: 'pinned',
    flagGated: false,
  },
]

/** Files that name the table without writing rows. */
const NON_WRITERS: readonly string[] = [
  `${CORE}/db/types.ts`,
  `${CORE}/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts`,
  `${CORE}/db/migrations/zzzz20260629120000_add_api_token_base_sheet_scope.ts`,
]

/** Registered parameterized writers retain their markers and the registry's statement count. */
const JUDGED_DYNAMIC_WRITERS: ReadonlyArray<{ file: string; exemption: string; markers: readonly string[]; why: string }> = [
  {
    file: `${CORE}/data-adapters/PostgresAdapter.ts`,
    exemption: 'DX-03',
    markers: [
      'INSERT INTO ${this.sanitizeIdentifier(table)}',
      'UPDATE ${this.sanitizeIdentifier(table)}',
      'DELETE FROM ${this.sanitizeIdentifier(table)}',
    ],
    why: 'external data source adapter: its own pg.Pool from the configured host and credentials (connect())',
  },
]

/** The parameterized migration helper retains its registered source marker. */
const UNJUDGED_DYNAMIC_WRITERS: ReadonlyArray<{ file: string; marker: string }> = [
  { file: `${CORE}/db/migrations/_patterns.ts`, marker: 'db.updateTable(tableName as any)' },
]

const SCAN_ROOTS = ['packages', 'plugins', 'scripts']
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.cjs', '.mjs', '.sql'])
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'tests', '__tests__', '__fixtures__', 'fixtures', 'test-results'])

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || name.endsWith('.d.ts')
}

function listScannedFiles(): string[] {
  const files: string[] = []
  const walk = (relative: string) => {
    const absolute = path.join(REPO, relative)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = path.posix.join(relative, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child)
      } else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name)) && !isTestFile(entry.name)) {
        files.push(child)
      }
    }
  }
  for (const root of SCAN_ROOTS) walk(root)
  return files.sort()
}

const TABLE = /\bmultitable_api_tokens\b/i
const KYSELY_WRITE = /\b(insertInto|updateTable|deleteFrom|replaceInto|mergeInto)\(\s*['"`]multitable_api_tokens(?:\s+as\s+\w+)?['"`]/g
const RAW_WRITE = /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?multitable_api_tokens\b/gi

function kindOf(verb: string): WriteKind {
  const word = verb.replace(/\s+/g, ' ').toUpperCase()
  if (word === 'INSERTINTO' || word === 'INSERT INTO' || word === 'REPLACEINTO') return 'INSERT'
  if (word === 'UPDATETABLE' || word === 'UPDATE') return 'UPDATE'
  if (word === 'DELETEFROM' || word === 'DELETE FROM') return 'DELETE'
  if (word === 'MERGEINTO' || word === 'MERGE INTO') return 'MERGE'
  return 'TRUNCATE'
}

function writesIn(source: string): WriteKind[] {
  const kinds: WriteKind[] = []
  for (const match of source.matchAll(KYSELY_WRITE)) kinds.push(kindOf(match[1]))
  for (const match of source.matchAll(RAW_WRITE)) kinds.push(kindOf(match[1]))
  return kinds.sort()
}

/** Positions where a statement uses the table name directly. */
const DIRECT_REFERENCES: readonly RegExp[] = [
  /\b(?:insertInto|updateTable|deleteFrom|replaceInto|mergeInto|selectFrom|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*['"`]multitable_api_tokens(?:\s+as\s+\w+)?['"`]/g,
  /\b(?:FROM|JOIN|UPDATE|INTO|ON|REFERENCES|TABLE(?:\s+IF(?:\s+NOT)?\s+EXISTS)?)\s+(?:ONLY\s+)?(?:"?public"?\s*\.\s*)?"?multitable_api_tokens\b/gi,
]

/** Occurrences outside a direct position, each with the exact source line it stands on. */
const OTHER_REFERENCES: ReadonlyArray<{ file: string; line: string; why: string }> = [
  { file: `${CORE}/db/types.ts`, line: '  multitable_api_tokens: MultitableApiTokensTable', why: 'the table key of the Kysely schema type' },
  {
    file: `${CORE}/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts`,
    line: '  // ── multitable_api_tokens ───────────────────────────────────────────',
    why: 'section comment in the migration that creates the table',
  },
]

/** Every occurrence of the table name that no direct position covers, as `file: line`. */
function indirectReferences(file: string, source: string): string[] {
  const covered: Array<[number, number]> = []
  for (const pattern of DIRECT_REFERENCES) {
    for (const match of source.matchAll(pattern)) covered.push([match.index!, match.index! + match[0].length])
  }
  const out: string[] = []
  for (const match of source.matchAll(/\bmultitable_api_tokens\b/gi)) {
    const at = match.index!
    if (covered.some(([start, end]) => at >= start && at < end)) continue
    const lineStart = source.lastIndexOf('\n', at) + 1
    const lineEnd = source.indexOf('\n', at)
    out.push(`${file}: ${source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)}`)
  }
  return out
}

/** Writes whose table is not a literal: builder writes on an expression, sql.table/sql.id, SQL write verbs on `${...}`. */
const NON_LITERAL_WRITES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'builder write on an expression', pattern: /\b(?:insertInto|updateTable|deleteFrom|replaceInto|mergeInto)\(\s*(?!['"`\s])/g },
  { kind: 'sql.table or sql.id', pattern: /\bsql\s*\.\s*(?:table|id)\s*\(/g },
  { kind: 'SQL write verb on an interpolated table', pattern: /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?\$\{/gi },
]

/** Judged non-literal writes in files that name the table, with the reason they cannot reach it. */
const JUDGED_NON_LITERAL_WRITES: ReadonlyArray<{ file: string; kind: string; count: number; marker: string; why: string }> = [
  {
    file: `${CORE}/admin/user-recycle.ts`,
    kind: 'SQL write verb on an interpolated table',
    count: 2,
    marker: "for (const table of ['audit_logs', 'audit_logs_archive'])",
    why: 'scrubPurgedUserAuditIdentity: the table iterates over the two audit tables only',
  },
]

function nonLiteralWrites(source: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const { kind, pattern } of NON_LITERAL_WRITES) {
    const count = [...source.matchAll(pattern)].length
    if (count > 0) out[kind] = count
  }
  return out
}

function tally(kinds: readonly WriteKind[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const kind of kinds) out[kind] = (out[kind] ?? 0) + 1
  return out
}

describe('U15 multitable_api_tokens writer census', () => {
  const files = listScannedFiles()
  const mentioning = files.filter((file) => TABLE.test(fs.readFileSync(path.join(REPO, file), 'utf8')))

  it('the scan sees the core backend sources', () => {
    expect(files).toContain(`${CORE}/multitable/api-token-service.ts`)
    expect(files.length).toBeGreaterThan(500)
  })

  it('every file that names the table is a registered writer or a registered non-writer', () => {
    const registered = new Set([...WRITERS.map((row) => row.file), ...NON_WRITERS])
    expect(mentioning.filter((file) => !registered.has(file))).toEqual([])
    expect([...registered].filter((file) => !mentioning.includes(file))).toEqual([])
  })

  it('each writer file has exactly the registered write statements', () => {
    const writerFiles = [...new Set(WRITERS.map((row) => row.file))].sort()
    const found = Object.fromEntries(writerFiles.map((file) => [file, tally(writesIn(fs.readFileSync(path.join(REPO, file), 'utf8')))]))
    const expected = Object.fromEntries(writerFiles.map((file) => [file, tally(WRITERS.filter((row) => row.file === file).map((row) => row.kind))]))
    expect(found).toEqual(expected)
  })

  it('non-writer files contain no write statement on the table', () => {
    for (const file of NON_WRITERS.filter((name) => !name.includes('/db/migrations/'))) {
      expect(writesIn(fs.readFileSync(path.join(REPO, file), 'utf8')), file).toEqual([])
    }
  })

  it('every registry row states its fence signal, users-row lock and READ COMMITTED column', () => {
    for (const row of WRITERS) {
      expect(row.fenceSignal.length, row.writer).toBeGreaterThan(0)
      expect(row.usersRowLock.length, row.writer).toBeGreaterThan(0)
      expect(['pinned', 'single-statement', 'caller-transaction']).toContain(row.readCommitted)
    }
  })

  it('the issuer rows pin READ COMMITTED in the service source', () => {
    const source = fs.readFileSync(path.join(REPO, CORE, 'multitable/api-token-service.ts'), 'utf8')
    expect(source).toContain("'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'")
    expect(source).toContain('lockUserAccessShared(client, userId)')
  })

  it('every occurrence of the table name is a direct use or a registered reference', () => {
    const found = mentioning.flatMap((file) => indirectReferences(file, fs.readFileSync(path.join(REPO, file), 'utf8')))
    expect(found.sort()).toEqual(OTHER_REFERENCES.map(({ file, line }) => `${file}: ${line}`).sort())
  })

  it('in files that name the table, every write on a non-literal table is judged', () => {
    const found = Object.fromEntries(mentioning
      .map((file) => [file, nonLiteralWrites(fs.readFileSync(path.join(REPO, file), 'utf8'))] as const)
      .filter(([, kinds]) => Object.keys(kinds).length > 0))
    const expected: Record<string, Record<string, number>> = {}
    for (const row of JUDGED_NON_LITERAL_WRITES) {
      expected[row.file] = { ...(expected[row.file] ?? {}), [row.kind]: row.count }
      expect(fs.readFileSync(path.join(REPO, row.file), 'utf8'), row.file).toContain(row.marker)
    }
    expect(found).toEqual(expected)
  })

  it('the direct-use and non-literal checks see the shapes they are meant to catch', () => {
    const probe = 'probe.ts'
    expect(indirectReferences(probe, "const TOKENS = 'multitable_api_tokens' as const")).toHaveLength(1)
    expect(indirectReferences(probe, "await sql`DELETE FROM ${sql.table('multitable_api_tokens')}`.execute(db)")).toHaveLength(1)
    expect(indirectReferences(probe, "export const tables = ['multitable_api_tokens']")).toHaveLength(1)
    expect(indirectReferences(probe, "db.deleteFrom('multitable_api_tokens').execute()")).toEqual([])
    expect(indirectReferences(probe, "db.updateTable('multitable_api_tokens as t')")).toEqual([])
    expect(indirectReferences(probe, "'UPDATE multitable_api_tokens SET revoked = TRUE'")).toEqual([])
    expect(nonLiteralWrites('db.deleteFrom(TOKENS).execute()')).toEqual({ 'builder write on an expression': 1 })
    expect(nonLiteralWrites("await sql`DELETE FROM ${sql.table(TOKENS)}`.execute(db)")).toEqual({
      'sql.table or sql.id': 1,
      'SQL write verb on an interpolated table': 1,
    })
    expect(nonLiteralWrites('client.query(`UPDATE ${table} SET x = 1`)')).toEqual({ 'SQL write verb on an interpolated table': 1 })
    expect(nonLiteralWrites("db.deleteFrom('multitable_api_tokens')")).toEqual({})
    expect(writesIn("db.updateTable('multitable_api_tokens as t').set({})")).toEqual(['UPDATE'])
  })

  it('the judged dynamic writers hold exactly the pinned template writes, as their exemption records', () => {
    for (const { file, exemption, markers } of JUDGED_DYNAMIC_WRITERS) {
      const source = fs.readFileSync(path.join(REPO, file), 'utf8')
      for (const marker of markers) expect(source, `${file}: ${marker}`).toContain(marker)
      expect(nonLiteralWrites(source), file).toEqual({ 'SQL write verb on an interpolated table': markers.length })
      const entry = AUTHORIZATION_INPUT_DYNAMIC_EXEMPTIONS.find((row) => row.id === exemption)
      expect(entry, exemption).toBeDefined()
      expect(entry!.file).toBe(file)
      expect(entry!.form).toBe('template_substitution')
      expect(entry!.count).toBe(markers.length)
    }
  })

  it('the migration helper retains its registered source marker', () => {
    for (const { file, marker } of UNJUDGED_DYNAMIC_WRITERS) {
      expect(fs.readFileSync(path.join(REPO, file), 'utf8'), file).toContain(marker)
    }
  })
})

/** Production files that name the token service, with their create and rotate call sites. */
const ISSUANCE_SITES: ReadonlyArray<{ file: string; createToken: number; rotateToken: number }> = [
  { file: `${CORE}/routes/api-tokens.ts`, createToken: 1, rotateToken: 1 },
  { file: `${CORE}/middleware/api-token-auth.ts`, createToken: 0, rotateToken: 0 },
  { file: `${CORE}/multitable/api-tokens.ts`, createToken: 0, rotateToken: 0 },
]

const SERVICE_MENTION = /\bApiTokenService\b|api-token-service/

describe('U15 API token issuance call sites', () => {
  const files = listScannedFiles().filter((file) => file !== `${CORE}/multitable/api-token-service.ts`)
  const naming = files.filter((file) => SERVICE_MENTION.test(fs.readFileSync(path.join(REPO, file), 'utf8')))

  it('every production file that names the token service is registered', () => {
    expect(naming).toEqual(ISSUANCE_SITES.map((site) => site.file).sort())
  })

  it('each registered file has exactly the registered create and rotate calls', () => {
    for (const site of ISSUANCE_SITES) {
      const source = fs.readFileSync(path.join(REPO, site.file), 'utf8')
      expect([...source.matchAll(/\.createToken\(/g)].length, site.file).toBe(site.createToken)
      expect([...source.matchAll(/\.rotateToken\(/g)].length, site.file).toBe(site.rotateToken)
    }
  })

  it('both route call sites pass the credential built from the authenticating bearer token', () => {
    const source = fs.readFileSync(path.join(REPO, CORE, 'routes/api-tokens.ts'), 'utf8')
    const create = source.slice(source.indexOf('apiTokenService.createToken('))
    expect(create.slice(0, create.indexOf('res.status(201)'))).toContain('}, issuanceCredential(req, userId))')
    expect(source).toContain('apiTokenService.rotateToken(req.params.id, userId, issuanceCredential(req, userId))')
    expect([...source.matchAll(/issuanceCredential\(req, userId\)/g)]).toHaveLength(2)
  })

  it('only the token service mints the API token prefix', () => {
    const minting = files.filter((file) => /\bgeneratePlainTextToken\b|TOKEN_PREFIX \+ randomBytes/.test(fs.readFileSync(path.join(REPO, file), 'utf8')))
    expect(minting).toEqual([])
  })
})

describe('U15 issuance fence real-database workflow trigger', () => {
  // The recycle slice of this workflow creates tokens through the service, so a change to the
  // issuance fence module alone must still trigger it, on pull requests and on pushes to main.
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/admin-users-realdb-review.yml'), 'utf8')
  const pushAt = workflow.indexOf('\n  push:\n')
  const triggers = { pull_request: workflow.slice(workflow.indexOf('\n  pull_request:\n'), pushAt), push: workflow.slice(pushAt, workflow.indexOf('\npermissions:')) }

  it.each(Object.keys(triggers) as Array<keyof typeof triggers>)('%s paths include the token service and the issuance fence module', (trigger) => {
    expect(workflow.indexOf('\n  pull_request:\n')).toBeGreaterThan(0)
    expect(pushAt).toBeGreaterThan(workflow.indexOf('\n  pull_request:\n'))
    for (const file of ['multitable/api-token-service.ts', 'multitable/api-token-issuance.ts']) {
      expect(triggers[trigger], `${trigger}: ${file}`).toContain(`      - '${CORE}/${file}'\n`)
    }
  })
})
