import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { encodeAdminGrantIntent } from '../../src/auth/admin-login-grant-intent'
import {
  AdminGrantProofContractError,
  AdminGrantProofError,
  canonicalAdminGrantOrigin,
  captureAdminGrantConsumeInput,
  captureAdminGrantIssueInput,
  createAdminGrantProofService,
} from '../../src/auth/admin-grant-proof'
import { SecurityActionProofContractError } from '../../src/auth/security-action-proof'
import {
  adminGrantIntentDigest,
  hashAdminGrantProofSecret,
  parseAdminGrantProof,
} from '../../src/auth/admin-grant-proof-storage'

const here = dirname(fileURLToPath(import.meta.url))
const backend = join(here, '../..')
const codecPath = join(backend, 'src/auth/admin-login-grant-intent.ts')
const migrationPath = join(backend, 'src/db/migrations/zzzz20261118100000_admin_grant_proof_sets.ts')
const storagePath = join(backend, 'src/auth/admin-grant-proof-storage.ts')
const CODEC_SHA256 = 'c8d71eceff979cf90f51814d22e8715021af33f43ff3984b326efaa319faf4ba'
const ORIGIN = 'https://grant.example'

function pin(index: number) {
  return {
    userId: `target-${index}`,
    identityId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    bindingRevision: '1',
    evidenceId: `evidence-${index}`,
    evidenceWitness: `witness-${index}`,
    accessGeneration: '1',
    privilegeWitness: 'ab'.repeat(32),
  }
}

function intent(targetCount: number, commandId = 'command-1') {
  return {
    purpose: 'admin_login_grant_enable' as const,
    commandId,
    actorId: 'actor-1',
    orgId: 'org-1',
    provider: 'dingtalk' as const,
    connectionId: '11111111-1111-4111-8111-111111111111',
    applicationRevision: '1',
    targets: Array.from({ length: targetCount }, (_item, index) => pin(index + 1)),
  }
}

function issueInput(targetCount: number, commandId = 'command-1') {
  return {
    intent: intent(targetCount, commandId),
    method: 'local_password' as const,
    password: 'phrase-value',
  }
}

function expectStructuralSessionRefused(error: unknown): void {
  expect(error).toBeInstanceOf(SecurityActionProofContractError)
  expect((error as SecurityActionProofContractError).code).toBe('SECURITY_ACTION_CONTEXT_REQUIRED')
}

describe('admin grant proof contract', () => {
  it('keeps the frozen codec bytes', () => {
    const digest = createHash('sha256').update(readFileSync(codecPath)).digest('hex')
    expect(digest).toBe(CODEC_SHA256)
  })

  it('accepts 101 targets and a long command before the genuine session assertion', async () => {
    const many = captureAdminGrantIssueInput(issueInput(101))
    expect(many.intent.targets).toHaveLength(101)
    const commandId = `c${'m'.repeat(300000)}`
    const longIntent = intent(1, commandId)
    const encoded = encodeAdminGrantIntent(longIntent)
    expect(Buffer.byteLength(encoded, 'utf8')).toBeGreaterThan(262144)
    expect(captureAdminGrantIssueInput(issueInput(1, commandId)).intent.commandId).toBe(commandId)
    const service = createAdminGrantProofService({ publicOrigin: ORIGIN })
    for (const input of [issueInput(101), issueInput(1, commandId)]) {
      let refused: unknown = null
      try {
        await service.issue({} as never, input)
      } catch (error) {
        refused = error
      }
      expect(refused).not.toBeNull()
      expectStructuralSessionRefused(refused)
    }
  })

  function expectInputShape(error: unknown): void {
    expect(error).toBeInstanceOf(AdminGrantProofContractError)
    expect((error as AdminGrantProofContractError).code).toBe('ADMIN_GRANT_INPUT_SHAPE')
    expect(error).not.toBeInstanceOf(TypeError)
  }

  function revoked<T extends object>(value: T): T {
    const box = Proxy.revocable(value, {})
    box.revoke()
    return box.proxy
  }

  it('maps revoked outer and nested proxies to the input-shape error', () => {
    const secret = randomBytes(32).toString('base64url')
    const proof = `agp1.${randomUUID()}.${secret}`
    expect(parseAdminGrantProof(proof)).not.toBeNull()
    const issueCases = [
      revoked(issueInput(1)),
      { intent: revoked(intent(1)), method: 'local_password' as const, password: 'phrase-value' },
      { intent: { ...intent(1), targets: revoked(intent(1).targets) }, method: 'local_password' as const, password: 'phrase-value' },
      { intent: { ...intent(1), targets: [revoked(pin(1))] }, method: 'local_password' as const, password: 'phrase-value' },
    ]
    for (const input of issueCases) {
      let refused: unknown = null
      try {
        captureAdminGrantIssueInput(input)
      } catch (error) {
        refused = error
      }
      expectInputShape(refused)
    }
    const consumeCases = [
      revoked({ intent: intent(1), proof }),
      { intent: revoked(intent(1)), proof },
      { intent: { ...intent(1), targets: revoked([pin(1)]) }, proof },
      { intent: { ...intent(1), targets: [revoked(pin(1))] }, proof },
    ]
    for (const input of consumeCases) {
      let refused: unknown = null
      try {
        captureAdminGrantConsumeInput(input)
      } catch (error) {
        refused = error
      }
      expectInputShape(refused)
    }
  })

  it('refuses unknown keys, a bad method, NUL, a surrogate, and an actor target', () => {
    expect(() => captureAdminGrantIssueInput({ ...issueInput(1), extra: true })).toThrow(AdminGrantProofContractError)
    expect(() => captureAdminGrantIssueInput({ ...issueInput(1), method: 'other' })).toThrow(AdminGrantProofContractError)
    expect(() => captureAdminGrantIssueInput({ ...issueInput(1), password: 'a\u0000b' })).toThrow(AdminGrantProofContractError)
    expect(() => captureAdminGrantIssueInput({ ...issueInput(1), password: '\uD800' })).toThrow(AdminGrantProofContractError)
    const same = intent(1)
    same.targets[0] = { ...same.targets[0], userId: same.actorId }
    expect(() => captureAdminGrantIssueInput({ intent: same, method: 'local_password', password: 'phrase-value' })).toThrow(AdminGrantProofContractError)
  })

  it('accepts only a canonical https origin and rejects an availability option', () => {
    expect(canonicalAdminGrantOrigin(ORIGIN)).toBe(ORIGIN)
    expect(() => canonicalAdminGrantOrigin('http://grant.example')).toThrow(AdminGrantProofContractError)
    expect(() => canonicalAdminGrantOrigin('https://grant.example/path')).toThrow(AdminGrantProofContractError)
    expect(() => createAdminGrantProofService({ publicOrigin: ORIGIN, availability: true } as never)).toThrow(AdminGrantProofContractError)
  })

  it('parses agp1 and compares the domain-separated secret digest', () => {
    const secret = randomBytes(32).toString('base64url')
    const proof = `agp1.${randomUUID()}.${secret}`
    const parsed = parseAdminGrantProof(proof)
    expect(parsed?.secret).toBe(secret)
    const digest = hashAdminGrantProofSecret(secret)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(adminGrantIntentDigest(encodeAdminGrantIntent(intent(1)))).toMatch(/^[0-9a-f]{64}$/)
    expect(parseAdminGrantProof(`sap1.${randomUUID()}.${secret}`)).toBeNull()
    expect(parseAdminGrantProof(`agp1.${randomUUID()}.${secret.slice(0, 42)}`)).toBeNull()
    expect(captureAdminGrantConsumeInput({ intent: intent(1), proof }).proof).toBe(proof)
  })

  it('uses fixed messages and does not publish an authority digest', () => {
    const storage = readFileSync(storagePath, 'utf8')
    const migration = readFileSync(migrationPath, 'utf8')
    expect(storage.includes('authority_witness')).toBe(false)
    expect(storage.includes('authorityWitness')).toBe(false)
    expect(migration.includes('authority_witness')).toBe(false)
    expect(migration.includes('pg_catalog.sha256')).toBe(true)
    expect(migration.includes('token_issued_at')).toBe(true)
    expect(migration.includes('262144')).toBe(false)
    expect(migration.includes('ordinal <= 100')).toBe(false)
    expect(migration.includes('ordinal < 100')).toBe(false)
    const error = new AdminGrantProofError('ADMIN_GRANT_PROOF_INVALID')
    expect(error.message).toBe('Admin grant proof refused')
    expect(new AdminGrantProofContractError('ADMIN_GRANT_INPUT_SHAPE').message).toBe('Admin grant proof API contract violated')
    const rejected = new AdminGrantProofError('ADMIN_GRANT_CREDENTIAL_REJECTED')
    expect(rejected.status).toBe(403)
    expect(rejected.retryAfter).toBeUndefined()
    const limited = new AdminGrantProofError('ADMIN_GRANT_RATE_LIMITED', 12)
    expect(limited.status).toBe(429)
    expect(limited.retryAfter).toBe(12)
  })

  it('refuses a structural consume result before any proof brand', () => {
    const service = createAdminGrantProofService({ publicOrigin: ORIGIN })
    let refused: unknown = null
    try {
      service.assertConsumedOnTx({} as never, { open: true } as never, {} as never, intent(1))
    } catch (error) {
      refused = error
    }
    expect(refused).not.toBeNull()
    expectStructuralSessionRefused(refused)
  })
})
