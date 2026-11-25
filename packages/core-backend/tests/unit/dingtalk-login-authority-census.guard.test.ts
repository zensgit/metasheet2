import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { authoritySites, collectAuthoritySites, residues } from './lib/dingtalk-login-authority-scan'
import { loginAuthorityManifest } from './lib/dingtalk-login-authority-manifest'

const root = path.resolve(__dirname, '../../../..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')
const core = 'packages/core-backend/'
const src = core + 'src/'

function expand(rows: string[]): string[] {
  return rows.flatMap(row => {
    const count = /^(\d+) × (.+)$/.exec(row)
    return count ? Array(Number(count[1])).fill(count[2]) : [row]
  }).sort()
}

// Same git blob id collectAuthoritySites stores for a residue file. Mode 0644 is the `data` label.
function residueBlobLine(text: string): string {
  const bytes = Buffer.from(text)
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  return `data blob ${blob}`
}

// The scanner lists files with git and then reads them. A fresh import sees one in-memory file.
// `scripts/` is required: paths outside the scanner's roots are dropped before the .insyncdl rule.
async function scanInMemoryResidue(file: string, text: string): Promise<string[] | undefined> {
  vi.resetModules()
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    return { ...actual, execFileSync: (() => `${file}\0`) as typeof actual.execFileSync }
  })
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const isProbe = (target: unknown) => String(target).replace(/\\/g, '/').endsWith(file)
    const fakeStat = { isFile: () => true, mode: 0o100644 } as ReturnType<typeof actual.lstatSync>
    return {
      ...actual,
      lstatSync: ((target: Parameters<typeof actual.lstatSync>[0]) => isProbe(target) ? fakeStat : actual.lstatSync(target)) as typeof actual.lstatSync,
      readFileSync: ((target: Parameters<typeof actual.readFileSync>[0]) => isProbe(target) ? Buffer.from(text) : actual.readFileSync(target)) as typeof actual.readFileSync,
    }
  })
  try {
    const loaded = await import('./lib/dingtalk-login-authority-scan')
    return loaded.collectAuthoritySites('/in-memory')[file]
  } finally {
    vi.doUnmock('node:child_process')
    vi.doUnmock('node:fs')
    vi.resetModules()
  }
}

// Each marker belongs to a named source or sink. The multisets above check callers as well,
// including duplicated sites; these pins cover internal checks that remove no caller edge.
const fences: Array<[string, string[]]> = [
  [src + 'routes/auth.ts', ["stateCheck.intent === 'bind'", "stateCheck.intent === 'activate'", "code: 'self_service_disabled'", 'if (loginSource.strict) refuseDingTalkSource()', 'options.requiresEmptyScope || !options.origin']],
  [src + 'auth/dingtalk-login-source.ts', ['if (!await lockEmptyConnectionLoginScope(client)) refuseDingTalkSource()', 'if (current.rows.length !== 1) refuseDingTalkSource()', 'if ((await readConnectionLoginScope(client, source.connectionId)).scope) refuseDingTalkSource()']],
  [src + 'auth/dingtalk-oauth.ts', ['if (storedCorp !== source.corpId) refuseDingTalkSource()', 'if (linked?.corp_id && linked.corp_id !== source.corpId) refuseDingTalkSource()', 'links.rows.length > 1 || linked.integration_id !== source.connectionId', 'if (source.explicit || !describesSameDingTalkPerson(identity, profile, null))', 'if (foreignKey) refuseDingTalkSource()', 'if (canonicalHere) return identityCorpRequiresEmptyScope(client, source)', 'if (emptyScope) await checkEmptyDingTalkScope(client)']],
  [src + 'auth/AuthService.ts', ['Number.isSafeInteger(payload.iat)', 'revoked_after >= to_timestamp($2::double precision)', 'revoked_at IS NULL FOR UPDATE', 'issuedAt: result.issuedAt']],
  [src + 'auth/dingtalk-legacy-resource-scope.ts', ['if (strictSession) return false', "return state.scope ? 'refused' : 'ordinary'", 'return !lock || await store.lockEmptyConnectionLoginScope(caller)', "return state.installation === 'installed' && !state.scope"]],
  [src + 'integrations/dingtalk/interactive-card-callback.ts', ["await checkCardConnectionBeforeDispatch(query, connectionId, true) !== 'ordinary'", 'outcome = await deps.transaction(']],
  [core + 'scripts/dingtalk-corp-backfill.ts', ['requireState(scopes.rowCount === 0)', 'requireState(eligible.rowCount === ids.length)', 'requireState(written.rowCount === ids.length)', 'requireState(audit.rowCount === 1)', "client.query('ROLLBACK')"]],
  [src + 'directory/deprovision-evidence-api.ts', ['FOR SHARE OF i, account NOWAIT', 'integration.rows.length !== 1', 'await readConnectionLoginScope(client, event.integration_id)']],
]

describe('DingTalk session issuers, identity writers and grant consumers', () => {
  it('discovers the current production, plugin, CLI, migration and workflow sites', () => {
    const actual = collectAuthoritySites(root)
    expect(Object.keys(actual).sort()).toEqual(Object.keys(loginAuthorityManifest).sort())
    for (const [file, expected] of Object.entries(loginAuthorityManifest)) expect(actual[file], file).toEqual(expand(expected))
    for (const [file, blob] of Object.entries(residues)) expect(actual[file]).toEqual([`data blob ${blob}`])
  })

  it('keeps the accepted gate predicates at their named sites and the reviewed repair CLI single-purpose', () => {
    for (const [file, markers] of fences) for (const marker of markers) expect(read(file), `${file} ${marker}`).toContain(marker)
    expect(read('scripts/ops/backfill-dingtalk-corp-identities.sh')).toMatch(/^\s*exec node [^\n]+\/scripts\/dingtalk-corp-backfill\.ts"[^\n]+"\$\{REVIEWED_PLAN\}"$/m)
  })

  it('checks foreign and conflicting directory evidence before using an identity or the empty-scope fallback', () => {
    const source = read(src + 'auth/dingtalk-oauth.ts').split('async function identityRequiresEmptyScope(')[1].split('type BackfillTransactionClient')[0]
    const checks = [
      "ORDER BY (NULLIF(account.corp_id, '') IS NOT NULL AND account.corp_id <> $3) DESC",
      'if (linked?.corp_id && linked.corp_id !== source.corpId) refuseDingTalkSource()',
      'if (foreignKey) refuseDingTalkSource()', 'if (!directoryConflict) {',
      'linked.union_id === profile.unionId) return false',
      'if (canonicalHere) return identityCorpRequiresEmptyScope',
      'if (source.explicit || !describesSameDingTalkPerson', 'return true',
      'profile.unionId === identity.provider_union_id', 'owners.rows.length === 1 && owners.rows[0].id === userId',
    ]
    let position = -1
    for (const check of checks) {
      const next = source.indexOf(check, position + 1)
      expect(next, check).toBeGreaterThan(position)
      position = next
    }
  })

  it('the backend entrypoint and TypeScript build do not load the two sync files', () => {
    const configPath = path.join(root, core, 'tsconfig.json')
    const config = ts.readConfigFile(configPath, ts.sys.readFile)
    const sources = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath)).fileNames
    expect(sources).toContain(path.join(root, src, 'index.ts'))
    for (const file of Object.keys(residues)) expect(sources).not.toContain(path.join(root, file))
    expect(JSON.parse(read(core + 'package.json')).scripts.build).toBe('tsc')
    expect(read('Dockerfile.backend')).toContain('CMD ["node", "packages/core-backend/dist/src/index.js"]')
  })

  it('an added or forwarded issuer, SQL write, builder alias, embedded mint and read-only neighbor are distinguished', () => {
    expect(authoritySites('probe.ts', `import { createUserSession as save } from './sessions'; export function other() { return save }`)).toContain('module > createUserSession')
    const alias = `import { createUserSession as save } from './sessions'; function registered() { return save() }`
    expect(authoritySites('probe.ts', alias + '; function added() { return save() }')).toContain('added > alias save for createUserSession')
    const wrapped = `const {createToken: issue} = auth; const mint = issue; function second() { return mint() }`
    expect(authoritySites('probe.ts', wrapped)).toContain('second > alias mint for createToken')
    expect(authoritySites('probe.ts', `export function other(service) { const issue = service['create' + 'Token']; return issue }`)).toContain('other > computed createToken')
    expect(authoritySites('probe.ts', 'async function save(db) { const target="user_external_auth_grants"; await db["updateTable"](target) }')).toContain('save > updateTable user_external_auth_grants')
    expect(authoritySites('probe.ts', 'const sql = `INSERT\n INTO public."user_external_identities" (id) VALUES ($1)`')).toEqual(['module > insert user_external_identities'])
    expect(authoritySites('probe.ts', 'const sql = "UPDATE user_external_" + "auth_grants SET enabled=$1"')).toEqual(['module > update user_external_auth_grants'])
    expect(authoritySites('tool.sh', "node <<'JS'\nconst {createToken: issue} = authService\nJS")).toEqual(['script > createToken'])
    expect(authoritySites('probe.ts', 'db.updateTable(runtimeTable)')).toEqual(['module > updateTable dynamic runtimeTable'])
    expect(authoritySites('probe.ts', 'db.query(`SELECT enabled FROM user_external_auth_grants`)')).toEqual([])
    expect(authoritySites('probe.ts', 'function grant(user) { return __dingtalkOAuthInternalsForTests.ensureGrant(user) }')).toContain('grant > ensureGrant')
    expect(authoritySites('probe.ts', 'function session(service) { const alias = service; return alias.login() }')).toContain('session > member login')
    const callback = src + 'routes/auth.ts'
    const live = read(callback)
    const added = live.replace('await exchangeCodeForUser(code, loginSource)', 'await (true ? exchangeCodeForUser(code, loginSource) : exchangeCodeForUser(code, loginSource))')
    expect(authoritySites(callback, added)).not.toEqual(authoritySites(callback, live))
    const fourth = src + 'routes/admin-directory.ts'
    const admin = read(fourth)
    expect(authoritySites(fourth, admin.replace('await compensateSupersededDenyGrantForRequest(req, res)', 'return'))).not.toEqual(authoritySites(fourth, admin))
    const probe = 'probe/.~sync-residue-name-only.insyncdl'
    residues[probe] = 'not-a-blob'
    try {
      expect(authoritySites('plugin.cjs', `require('${probe}')`)).toEqual([`reference to ${probe}`])
    } finally {
      delete residues[probe]
    }
  })

  it('reports an in-memory sync residue when its text names an issuer or table, and ignores harmless text', async () => {
    const file = 'scripts/probe/.~sync-residue.insyncdl'
    expect(await scanInMemoryResidue(file, 'directory_accounts')).toEqual([residueBlobLine('directory_accounts')])
    expect(await scanInMemoryResidue(file, 'harmless leftover')).toBeUndefined()
  })
})
