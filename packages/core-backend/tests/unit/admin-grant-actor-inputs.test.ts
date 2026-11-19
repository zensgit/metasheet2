import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import {
  ADMIN_GRANT_BROWSER_COOKIE_NAME,
  adminGrantBrowserBindingDigest,
  adminGrantBrowserNonceDigest,
  adminGrantBrowserStatements,
  assertAdminGrantBrowserContext,
  canonicalAdminGrantBrowserOrigin,
  createAdminGrantBrowserContext,
  formatAdminGrantBrowserSetCookie,
  parseAdminGrantBrowserCookie,
} from '../../src/auth/admin-grant-browser-context'
import {
  ADMIN_GRANT_ACTOR_INPUT_CODES,
  AdminGrantActorInputError,
  adminGrantCredentialStatements,
  changeRequiredPasswordWithProvenance,
} from '../../src/auth/admin-grant-local-credential'
import { SecurityActionProofContractError } from '../../src/auth/security-action-proof'
import { contextFor } from '../helpers/security-action-proof-harness'
import {
  ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_CODE,
  adminGrantActorInputDropStatements,
  adminGrantActorInputUpStatements,
  quoteAdminGrantActorInputIdent,
} from '../../src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs'

const ROOT = path.resolve(__dirname, '..', '..')
const BROWSER_SOURCE = readFileSync(path.join(ROOT, 'src/auth/admin-grant-browser-context.ts'), 'utf8')
const CREDENTIAL_SOURCE = readFileSync(path.join(ROOT, 'src/auth/admin-grant-local-credential.ts'), 'utf8')
const MIGRATION_SOURCE = readFileSync(path.join(ROOT, 'src/db/migrations/zzzz20261118090000_admin_grant_actor_inputs.ts'), 'utf8')
const ORIGIN = 'https://grant.example'
const NONCE = Buffer.alloc(32, 7)
const NONCE_TEXT = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc'
const NONCE_DIGEST = 'ef4844182f8e0484bcdae1e1f5ee07692a8b315a03ad1f6a081a5e084e05a139'
const BINDING_DIGEST = 'e1366502c4c8e842483e12ef7731b812e7575f32dc7a04857a69cc2d3069fa34'
const BCRYPT_SHAPE = `$2a$10$${ 'a'.repeat(53) }`

function between(source: string, start: string, end?: string): string {
  const from = source.indexOf(start)
  if (from < 0) throw new Error(`missing slice ${start}`)
  if (end === undefined) return source.slice(from)
  const to = source.indexOf(end, from + start.length)
  if (to < from) throw new Error(`missing slice end ${end}`)
  return source.slice(from, to)
}

function order(source: string, markers: readonly string[]): void {
  let cursor = -1
  for (const marker of markers) {
    const found = source.indexOf(marker, cursor + 1)
    expect(found, marker).toBeGreaterThan(cursor)
    cursor = found
  }
}

function topLevelUpdates(statements: readonly string[]): string[] {
  const found: string[] = []
  for (const statement of statements) {
    const visible = statement.replace(/\$fn\$[\s\S]*?\$fn\$/g, ' ')
    for (const part of visible.split(';')) {
      const trimmed = part.trim()
      if (/^UPDATE\b/i.test(trimmed)) found.push(trimmed)
    }
  }
  return found
}

describe('admin grant actor inputs', () => {
  it('keeps one canonical https origin', () => {
    expect(canonicalAdminGrantBrowserOrigin(ORIGIN)).toBe(ORIGIN)
    for (const input of [
      '',
      ' http://grant.example',
      'https://grant.example/',
      'https://grant.example:443',
      'https://Grant.example',
      'http://grant.example',
      'https://user:secret@grant.example',
      'https://grant.example/path',
      'https://grant.example?q=1',
      'https://grant.example#fragment',
      ` ${ORIGIN}`,
    ]) {
      expect(() => canonicalAdminGrantBrowserOrigin(input)).toThrow(AdminGrantActorInputError)
    }
    expect(() => createAdminGrantBrowserContext(null as never)).toThrow(AdminGrantActorInputError)
  })

  it('formats and parses only the host cookie', () => {
    const cookie = formatAdminGrantBrowserSetCookie(NONCE_TEXT, 3600)
    expect(cookie).toBe(`${ADMIN_GRANT_BROWSER_COOKIE_NAME}=${NONCE_TEXT}; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Strict`)
    expect(cookie).not.toContain('Domain=')
    expect(parseAdminGrantBrowserCookie(cookie)).toEqual({ state: 'present', nonce: NONCE_TEXT })
    expect(parseAdminGrantBrowserCookie('')).toEqual({ state: 'absent', nonce: null })
    expect(parseAdminGrantBrowserCookie('other=1')).toEqual({ state: 'absent', nonce: null })
    expect(parseAdminGrantBrowserCookie(`${ADMIN_GRANT_BROWSER_COOKIE_NAME}=short`)).toEqual({ state: 'malformed', nonce: null })
    expect(parseAdminGrantBrowserCookie(`${cookie}; ${ADMIN_GRANT_BROWSER_COOKIE_NAME}=${NONCE_TEXT}`)).toEqual({ state: 'malformed', nonce: null })
    expect(() => formatAdminGrantBrowserSetCookie(NONCE_TEXT, 0)).toThrow(AdminGrantActorInputError)
  })

  it('pins the domain-separated digests', () => {
    expect(NONCE.toString('base64url')).toBe(NONCE_TEXT)
    expect(adminGrantBrowserNonceDigest(NONCE)).toBe(NONCE_DIGEST)
    expect(adminGrantBrowserBindingDigest({
      bindingId: 'binding-1',
      userId: 'user-1',
      sessionId: 'sid-1',
      orgId: 'org-1',
      origin: ORIGIN,
      nonceDigest: NONCE_DIGEST,
    })).toBe(BINDING_DIGEST)
    expect(() => adminGrantBrowserNonceDigest(Buffer.alloc(31))).toThrow(AdminGrantActorInputError)
    expect(() => adminGrantBrowserBindingDigest({
      bindingId: 'binding-1',
      userId: 'user-1',
      sessionId: 'sid-1',
      orgId: 'bad\u0000org',
      origin: ORIGIN,
      nonceDigest: NONCE_DIGEST,
    })).toThrow(AdminGrantActorInputError)
  })

  it('qualifies statements and refuses a copied browser context', () => {
    const browser = adminGrantBrowserStatements('public')
    const credential = adminGrantCredentialStatements('public')
    expect(browser.lockUser).toContain('"public"."users"')
    expect(browser.lockUser).toContain('FOR UPDATE')
    expect(browser.shareUser).toContain('FOR SHARE')
    expect(browser.baselineWatermark).toContain('1970-01-01 00:00:00+00')
    expect(browser.baselineWatermark).toContain('DO NOTHING')
    expect(browser.baselineWatermark).not.toContain('DO UPDATE')
    expect(browser.lockWatermark).toContain('FOR UPDATE')
    expect(browser.readWatermark).not.toMatch(/FOR\s+(UPDATE|SHARE)/)
    expect(browser.lockSession).toContain('FOR SHARE')
    expect(browser.readSession).not.toMatch(/FOR\s+(UPDATE|SHARE)/)
    expect(browser.readSession).toContain('SS.US')
    expect(browser.lockBinding).toContain('FOR SHARE')
    expect(browser.readBinding).not.toMatch(/FOR\s+(UPDATE|SHARE)/)
    expect(credential.lockUser).toContain('FOR UPDATE')
    expect(credential.lockUser).not.toContain('password_hash')
    expect(credential.baselineWatermark).toContain('DO NOTHING')
    expect(credential.lockSession).toContain('FOR SHARE')
    expect(credential.advanceWatermark).toContain('GREATEST')
    const assignment = credential.updateCredential.split('RETURNING')[0] ?? ''
    expect(assignment).toContain('password_hash = $1')
    expect(assignment).toContain('must_change_password IS TRUE')
    expect(assignment).not.toContain('local_credential_version')
    expect(assignment).not.toContain('access_generation')
    expect(credential.readCredential).not.toContain('password_hash,')
    expect(() => adminGrantBrowserStatements('Public')).toThrow(AdminGrantActorInputError)
    expect(() => assertAdminGrantBrowserContext({ origin: ORIGIN }, ORIGIN)).toThrow(AdminGrantActorInputError)
    expect(() => assertAdminGrantBrowserContext(contextFor(), ORIGIN)).toThrow(AdminGrantActorInputError)
    const service = createAdminGrantBrowserContext({ publicOrigin: ORIGIN })
    expect(service.publicOrigin).toBe(ORIGIN)
    expect(() => service.assert({ origin: ORIGIN })).toThrow(AdminGrantActorInputError)
  })

  it('refuses a structural session before the transaction', async () => {
    let called = false
    const runner = async () => {
      called = true
      throw new Error('transaction started')
    }
    await expect(changeRequiredPasswordWithProvenance(null as never, runner)).rejects.toMatchObject({
      code: 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
    })
    await expect(changeRequiredPasswordWithProvenance({
      session: { userId: 'user-1', sessionId: 'sid-1', tokenIssuedAt: 10, orgId: null },
      passwordHash: BCRYPT_SHAPE,
    } as never, runner)).rejects.toBeInstanceOf(SecurityActionProofContractError)
    const service = createAdminGrantBrowserContext({ publicOrigin: ORIGIN, transaction: runner })
    const req = { user: { id: 'user-1' }, headers: { origin: ORIGIN } } as Request
    const res = { headersSent: false, append() { return this } } as unknown as Response
    await expect(service.establish(req, res)).rejects.toBeInstanceOf(SecurityActionProofContractError)
    await expect(service.read(req)).rejects.toBeInstanceOf(SecurityActionProofContractError)
    expect(called).toBe(false)
  })

  it('refuses a swapping, throwing, or extra session field before the transaction', async () => {
    let called = false
    const runner = async () => {
      called = true
      throw new Error('transaction started')
    }
    const genuine = contextFor()
    const other = contextFor(`${'user-'}${'c'.repeat(8)}`, `${'sid-'}${'d'.repeat(8)}`)
    let reads = 0
    const swapping: { session: typeof genuine, passwordHash: string } = {
      session: genuine,
      passwordHash: BCRYPT_SHAPE,
    }
    Object.defineProperty(swapping, 'session', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1
        return reads === 1 ? genuine : other
      },
    })
    await expect(changeRequiredPasswordWithProvenance(swapping, runner)).rejects.toMatchObject({
      code: 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
    })
    expect(reads).toBe(0)
    const throwingAccessor: { session: typeof genuine, passwordHash: string } = {
      session: genuine,
      passwordHash: BCRYPT_SHAPE,
    }
    Object.defineProperty(throwingAccessor, 'session', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('accessor-secret')
      },
    })
    await expect(changeRequiredPasswordWithProvenance(throwingAccessor, runner)).rejects.toMatchObject({
      code: 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
    })
    const throwingReflection = new Proxy({
      session: genuine,
      passwordHash: BCRYPT_SHAPE,
    }, {
      getOwnPropertyDescriptor() {
        throw new Error('reflection-secret')
      },
    })
    await expect(changeRequiredPasswordWithProvenance(throwingReflection, runner)).rejects.toMatchObject({
      code: 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
    })
    const revoked = Proxy.revocable({ session: genuine, passwordHash: BCRYPT_SHAPE }, {})
    revoked.revoke()
    await expect(changeRequiredPasswordWithProvenance(revoked.proxy, runner)).rejects.toMatchObject({
      code: 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
    })
    const extra = { session: genuine, passwordHash: BCRYPT_SHAPE }
    Object.defineProperty(extra, 'note', { configurable: true, enumerable: true, value: true })
    await expect(changeRequiredPasswordWithProvenance(extra, runner)).rejects.toMatchObject({
      code: 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
    })
    expect(called).toBe(false)
  })

  it('keeps the producer order in source and does not construct sessions', () => {
    expect(ADMIN_GRANT_ACTOR_INPUT_CODES).not.toContain('authority_witness' as never)
    expect(BROWSER_SOURCE).not.toContain('new WeakSet')
    expect(CREDENTIAL_SOURCE).not.toContain('new WeakSet')
    expect(BROWSER_SOURCE).toContain('new WeakMap')
    expect(BROWSER_SOURCE).toContain('assertAuthenticatedSessionContext')
    expect(CREDENTIAL_SOURCE).toContain('assertAuthenticatedSessionContext')
    expect(BROWSER_SOURCE).not.toContain('session-revocation')
    expect(CREDENTIAL_SOURCE).not.toContain('session-revocation')
    expect(CREDENTIAL_SOURCE).not.toContain('admin-grant-browser-context')
    expect(BROWSER_SOURCE).not.toContain('assertPlatformActorAuthority')
    expect(CREDENTIAL_SOURCE).not.toContain('assertPlatformActorAuthority')
    expect(`${BROWSER_SOURCE}\n${CREDENTIAL_SOURCE}\n${MIGRATION_SOURCE}`).not.toContain('262144')
    order(between(CREDENTIAL_SOURCE, 'async function ensureWatermark', 'export async function changeRequiredPasswordWithProvenance'), [
      'statements.baselineWatermark',
      'statements.lockWatermark',
    ])
    order(between(CREDENTIAL_SOURCE, 'function captureRequiredPasswordChange', 'export async function changeRequiredPasswordWithProvenance'), [
      'Object.getOwnPropertyDescriptors',
      'Reflect.ownKeys',
      "'value' in descriptor",
    ])
    order(between(CREDENTIAL_SOURCE, 'export async function changeRequiredPasswordWithProvenance', 'export async function readAdminGrantLocalCredential'), [
      'captureRequiredPasswordChange',
      'assertAuthenticatedSessionContext',
      'session.userId',
      'isBcryptHash(passwordHash)',
      'await transaction',
      'SET_READ_COMMITTED',
      'statements.lockUser',
      'ensureWatermark',
      'statements.lockSession',
      'statements.updateCredential',
      'statements.insertEstablishment',
      'statements.advanceWatermark',
    ])
    expect(between(CREDENTIAL_SOURCE, 'const CLASSIFY_SQL', 'function qualify')).not.toMatch(/FOR\s+(UPDATE|SHARE)/)
    expect(CREDENTIAL_SOURCE).toContain("tg.tgenabled = 'O'")
    expect(CREDENTIAL_SOURCE).toContain('tg.tgfoid')
    expect(CREDENTIAL_SOURCE).toContain('tg.tgtype = 23')
    expect(CREDENTIAL_SOURCE).toContain('tg.tgtype = 31')
    expect(CREDENTIAL_SOURCE).toContain('tg.tgtype = 34')
    expect(between(CREDENTIAL_SOURCE, 'export async function readAdminGrantLocalCredential')).not.toContain('session.sessionId')
    const establish = between(BROWSER_SOURCE, 'async function establish', 'async function assertCurrent')
    order(establish, ['const headersSent', 'await transaction', 'requireReadyBrowserSchema', 'statements.lockUser', 'statements.baselineWatermark', 'statements.lockWatermark', 'statements.lockSession', 'statements.lockBinding', 'append.call'])
    const current = between(BROWSER_SOURCE, 'async function assertCurrent', 'return Object.freeze')
    order(current, ['requireReadyBrowserSchema', 'statements.readWatermark'])
    expect(current).toContain('statements.readWatermark')
    expect(current).toContain('statements.readSession')
    expect(current).toContain('statements.readBinding')
    expect(current).not.toContain('baselineWatermark')
    expect(current).not.toContain('FOR UPDATE')
    expect(current).not.toContain('FOR SHARE')
    const read = between(BROWSER_SOURCE, 'async function read(', 'async function establish')
    order(read, ['requireReadyBrowserSchema', 'statements.shareUser'])
    expect(read).toContain('statements.shareUser')
    expect(read).not.toContain('baselineWatermark')
    expect(read).not.toContain('statements.lockUser')
  })

  it('installs quoted objects only inside a caller transaction', () => {
    expect(quoteAdminGrantActorInputIdent('public')).toBe('"public"')
    expect(() => quoteAdminGrantActorInputIdent('Public')).toThrow(expect.objectContaining({ code: ADMIN_GRANT_ACTOR_INPUTS_SCHEMA_CODE }))
    const up = adminGrantActorInputUpStatements('public')
    const drop = adminGrantActorInputDropStatements('public')
    const upSql = up.join('\n')
    const dropSql = drop.join('\n')
    expect(up[0]).toBe('ALTER TABLE "public"."users" ADD COLUMN local_credential_version uuid')
    expect(upSql).toContain('NEW.established_at := pg_catalog.clock_timestamp()')
    expect(upSql).toContain('EXECUTE FUNCTION')
    expect(upSql).not.toContain('CREATE EXTENSION')
    expect(upSql).not.toContain('CASCADE')
    expect(upSql).not.toContain('authority_witness')
    expect(topLevelUpdates(['UPDATE "public"."users" SET local_credential_version = pg_catalog.gen_random_uuid()'])).toHaveLength(1)
    expect(topLevelUpdates(up)).toEqual([])
    expect(upSql).toContain("ELSIF TG_OP = 'UPDATE'")
    expect(upSql).toContain('BEFORE INSERT OR UPDATE ON')
    expect(upSql).toContain('NEW.local_credential_version := OLD.local_credential_version')
    expect(dropSql).not.toContain('CASCADE')
    expect(dropSql).toContain('DROP COLUMN IF EXISTS local_credential_version')
    expect(dropSql).not.toContain('DROP TABLE IF EXISTS "public"."users"')
    order(between(MIGRATION_SOURCE, 'export async function up', 'export async function down'), [
      'requireCallerTransaction',
      'applyMigrationTimeouts',
      'usersReady',
      'adminGrantActorInputUpStatements',
    ])
    order(between(MIGRATION_SOURCE, 'export async function down'), [
      'requireCallerTransaction',
      'versionTrigger',
      'lockPresent',
      'retainedHistory',
      'dropInstalled',
    ])
    expect(between(MIGRATION_SOURCE, 'export async function down')).not.toContain('CASCADE')
  })
})
