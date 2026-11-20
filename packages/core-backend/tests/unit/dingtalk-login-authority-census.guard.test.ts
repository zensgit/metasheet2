import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
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

// Each marker belongs to a named source or sink. The multisets above check callers as well,
// including duplicated sites; these pins cover internal checks that remove no caller edge.
const fences: Array<[string, string[]]> = [
  [src + 'routes/auth.ts', ["stateCheck.intent === 'bind'", "stateCheck.intent === 'activate'", "code: 'self_service_disabled'", 'if (loginSource.strict) refuseDingTalkSource()', 'options.requiresEmptyScope || !options.origin']],
  [src + 'auth/dingtalk-login-source.ts', ['if (!await lockEmptyConnectionLoginScope(client)) refuseDingTalkSource()', 'if (current.rows.length !== 1) refuseDingTalkSource()', 'if ((await readConnectionLoginScope(client, source.connectionId)).scope) refuseDingTalkSource()']],
  [src + 'auth/dingtalk-oauth.ts', ['if (storedCorp !== source.corpId) refuseDingTalkSource()', 'if (links.rows.length > 1) refuseDingTalkSource()', 'if (foreignKey) refuseDingTalkSource()', 'if (emptyScope) await checkEmptyDingTalkScope(client)']],
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
    const callback = src + 'routes/auth.ts'
    const live = read(callback)
    const added = live.replace('await exchangeCodeForUser(code, loginSource)', 'await (true ? exchangeCodeForUser(code, loginSource) : exchangeCodeForUser(code, loginSource))')
    expect(authoritySites(callback, added)).not.toEqual(authoritySites(callback, live))
    const fourth = src + 'routes/admin-directory.ts'
    const admin = read(fourth)
    expect(authoritySites(fourth, admin.replace('await compensateSupersededDenyGrantForRequest(req, res)', 'return'))).not.toEqual(authoritySites(fourth, admin))
    const residue = Object.keys(residues)[0]
    expect(authoritySites('plugin.cjs', `require('${residue}')`)).toEqual([`reference to ${residue}`])
  })
})
