import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import unitConfig from '../../vitest.config'

const backend = join(dirname(fileURLToPath(import.meta.url)), '../..')

function source(path: string): string {
  return readFileSync(join(backend, path), 'utf8')
}

describe('admin grant proof boundary', () => {
  it('does not mount the proof router from auth, the app entry, or the security-action router', () => {
    for (const path of ['src/routes/auth.ts', 'src/index.ts', 'src/routes/security-actions.ts']) {
      expect(source(path).includes('admin-grant-proofs')).toBe(false)
    }
  })

  it('keeps the applied attempt variant, the closed domain predicate, and the issuer call', () => {
    const attempt = source('src/auth/security-action-attempt-admission.ts')
    const service = source('src/auth/admin-grant-proof.ts')
    expect(attempt.includes('admin_grant_issue')).toBe(true)
    expect(attempt.includes('function isDomain(error: unknown): boolean')).toBe(true)
    expect(attempt.includes("error.name === 'SecurityActionProofError'")).toBe(true)
    expect(source('src/auth/security-action-proof.ts').includes('agp1')).toBe(false)
    expect(service.includes('runOwnedAttempt')).toBe(true)
    expect(service.includes("kind: 'admin_grant_issue'")).toBe(true)
    expect(service.includes("throw new AdminGrantProofContractError('ADMIN_GRANT_ATTEMPT_VARIANT_UNRELEASED')")).toBe(false)
    expect(service.includes('[preparedAdminGrantProofBrand]: true as const')).toBe(false)
    expect(service.includes('[consumedAdminGrantProofBrand]: true as const')).toBe(false)
  })

  it('keeps proof-set inserts in the storage writer', () => {
    const authFiles = readdirSync(join(backend, 'src/auth')).filter((name) => name.endsWith('.ts'))
    const writers = authFiles.filter((name) => {
      const text = source(`src/auth/${name}`)
      return text.includes('INSERT INTO admin_grant_proof_targets') || text.includes('INSERT INTO admin_grant_proof_seals')
    })
    expect(writers).toEqual(['admin-grant-proof-storage.ts'])
  })

  it('keeps the router unmounted, parser-free, and limited to the configured origin', () => {
    const router = source('src/routes/admin-grant-proofs.ts')
    const service = source('src/auth/admin-grant-proof.ts')
    expect(router.includes('express.json')).toBe(false)
    expect(router.includes('app.use')).toBe(false)
    expect(router.includes('availability')).toBe(false)
    expect(service.includes('publicOrigin: string')).toBe(true)
    expect(service.includes('assertAuthenticatedSessionContext(context)')).toBe(true)
    expect(service.includes('ADMIN_GRANT_SESSION_ASSERTION_UNRELEASED')).toBe(true)
    expect(service.includes("throw new AdminGrantProofContractError('ADMIN_GRANT_SESSION_ASSERTION_UNRELEASED')")).toBe(false)
    expect(service.includes('securityActionProof as')).toBe(false)
    expect(service.includes('productionAvailable: true')).toBe(false)
    expect(router.includes('productionAvailable: true')).toBe(false)
  })

  it('requires the caller transaction before the down locks', () => {
    const migration = source('src/db/migrations/zzzz20261118100000_admin_grant_proof_sets.ts')
    const down = migration.indexOf('export async function down')
    const asserted = migration.indexOf('await assertCallerTransaction(db)', down)
    const rollbackCall = migration.indexOf('await rollbackInstalled(', down)
    const helper = migration.indexOf('async function rollbackInstalled')
    const lock = migration.indexOf('LOCK TABLE', helper)
    expect(helper).toBeGreaterThan(-1)
    expect(asserted).toBeGreaterThan(down)
    expect(rollbackCall).toBeGreaterThan(asserted)
    expect(lock).toBeGreaterThan(helper)
  })

  it('excludes the native spec from unit discovery and names it once in the database workflow', () => {
    const spec = 'tests/integration/admin-grant-proof.db.test.ts'
    expect(unitConfig.test?.exclude?.filter(path => path === spec)).toEqual([spec])
    const workflow = readFileSync(join(backend, '../../.github/workflows/plugin-tests.yml'), 'utf8')
    expect(workflow.split('\n').filter(line => line.trim().startsWith(spec))).toHaveLength(1)
  })
})
