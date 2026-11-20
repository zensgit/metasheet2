/**
 * Unrun command checks. A plain object fails the real session WeakSet.
 * A swapping getter is refused before any receipt SELECT. brandBrowser is
 * private, so this file does not cast a synthetic browser into a branded
 * mismatch pass. Two minted browsers remain a native case.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  executeAdminLoginGrantEnable,
  readAdminLoginGrantCommandReceipt,
  type AdminLoginGrantCommandEnableInput,
  type AdminLoginGrantCommandReadInput,
} from '../../src/auth/admin-login-grant-command'
import { AdminGrantActorInputError } from '../../src/auth/admin-grant-local-credential'
import {
  assertAuthenticatedSessionContext,
  SecurityActionProofContractError,
} from '../../src/auth/security-action-proof'
import { STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX } from '../../src/auth/strict-login-grant-store'
import { contextFor } from '../helpers/security-action-proof-harness'

const ORIGIN = 'https://directory.invalid'
const here = dirname(fileURLToPath(import.meta.url))
const commandSource = readFileSync(join(here, '../../src/auth/admin-login-grant-command.ts'), 'utf8')

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = end.length === 0 ? source.length : source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function order(source: string, parts: readonly string[]): void {
  let cursor = 0
  for (const part of parts) {
    const found = source.indexOf(part, cursor)
    expect(found, part).toBeGreaterThanOrEqual(cursor)
    cursor = found + part.length
  }
}

function readInput(): AdminLoginGrantCommandReadInput {
  const session = contextFor()
  return {
    publicOrigin: ORIGIN,
    context: session,
    browser: {
      session,
      bindingId: 'binding-1',
      origin: ORIGIN,
      nonceDigest: 'ab'.repeat(32),
      tokenIssuedAt: session.tokenIssuedAt,
    },
    intent: {
      purpose: 'admin_login_grant_enable',
      commandId: 'command-1',
      actorId: session.userId,
      orgId: 'org-1',
      provider: 'dingtalk',
      connectionId: '11111111-1111-4111-8111-111111111111',
      applicationRevision: '1',
      targets: [],
    },
  } as unknown as AdminLoginGrantCommandReadInput
}

describe('admin login grant command capture', () => {
  it('refuses a plain session through the real WeakSet before a receipt result', async () => {
    const plain = {
      publicOrigin: ORIGIN,
      context: { userId: 'user-1', sessionId: 'sid-1', tokenIssuedAt: 1, orgId: null },
      browser: { session: { userId: 'user-1' } },
      intent: { purpose: 'admin_login_grant_enable' },
    } as AdminLoginGrantCommandReadInput
    await expect(readAdminLoginGrantCommandReceipt(plain)).rejects.toMatchObject({
      name: 'SecurityActionProofContractError',
      code: 'SECURITY_ACTION_CONTEXT_REQUIRED',
    })
    expect(() => assertAuthenticatedSessionContext({ userId: 'user-1' })).toThrow(SecurityActionProofContractError)
  })

  it('refuses a swapping context and browser getter before the receipt SELECT', async () => {
    const first = contextFor('actor-a', 'sid-a', 'org-a')
    const second = contextFor('actor-b', 'sid-b', 'org-b')
    let contextReads = 0
    let browserReads = 0
    const input = {
      publicOrigin: ORIGIN,
      context: first,
      browser: { session: first },
      intent: { purpose: 'admin_login_grant_enable' },
    }
    Object.defineProperty(input, 'context', {
      configurable: true,
      enumerable: true,
      get() {
        contextReads += 1
        return contextReads === 1 ? first : second
      },
    })
    Object.defineProperty(input, 'browser', {
      configurable: true,
      enumerable: true,
      get() {
        browserReads += 1
        return browserReads === 1 ? { session: first } : { session: second }
      },
    })
    await expect(readAdminLoginGrantCommandReceipt(input as AdminLoginGrantCommandReadInput)).rejects.toMatchObject({
      name: 'AdminLoginGrantCommandError',
      code: 'ADMIN_LOGIN_GRANT_COMMAND_REFUSED',
    })
    expect(contextReads).toBe(0)
    expect(browserReads).toBe(0)
  })

  it('does not surface a throwing accessor and refuses an unbranded browser value', async () => {
    const session = contextFor()
    const throwing = {
      publicOrigin: ORIGIN,
      context: session,
      browser: { session },
      intent: { purpose: 'admin_login_grant_enable' },
    }
    Object.defineProperty(throwing, 'browser', {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error('accessor-secret')
      },
    })
    try {
      await readAdminLoginGrantCommandReceipt(throwing as AdminLoginGrantCommandReadInput)
      throw new Error('accessor was accepted')
    } catch (error) {
      expect(error).toMatchObject({ code: 'ADMIN_LOGIN_GRANT_COMMAND_REFUSED' })
      expect((error as Error).message).not.toContain('accessor-secret')
    }
    await expect(readAdminLoginGrantCommandReceipt(readInput())).rejects.toBeInstanceOf(AdminGrantActorInputError)
  })

  it('refuses a revoked proxy on both entry points without a database', async () => {
    const session = contextFor()
    const readProxy = Proxy.revocable({
      publicOrigin: ORIGIN,
      context: session,
      browser: { session },
      intent: { purpose: 'admin_login_grant_enable' },
    }, {})
    readProxy.revoke()
    await expect(readAdminLoginGrantCommandReceipt(readProxy.proxy as AdminLoginGrantCommandReadInput)).rejects.toMatchObject({
      name: 'AdminLoginGrantCommandError',
      code: 'ADMIN_LOGIN_GRANT_COMMAND_REFUSED',
    })
    const enableProxy = Proxy.revocable({
      publicOrigin: ORIGIN,
      context: session,
      browser: { session },
      intent: { purpose: 'admin_login_grant_enable' },
      proof: 'proof-value',
    }, {})
    enableProxy.revoke()
    await expect(executeAdminLoginGrantEnable(enableProxy.proxy as AdminLoginGrantCommandEnableInput)).rejects.toMatchObject({
      name: 'AdminLoginGrantCommandError',
      code: 'ADMIN_LOGIN_GRANT_COMMAND_REFUSED',
    })
    await expect(readAdminLoginGrantCommandReceipt([] as unknown as AdminLoginGrantCommandReadInput)).rejects.toMatchObject({
      code: 'ADMIN_LOGIN_GRANT_COMMAND_REFUSED',
    })
  })
})

describe('admin login grant command source', () => {
  it('imports the replay list from the store and returns the authorization queryable', () => {
    expect(commandSource).toContain("import type { StrictLoginGrantBundle } from './strict-login-grant-store'")
    expect(commandSource).not.toContain('StrictLoginGrantCaller')
    expect(commandSource).toContain('STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS')
    expect(commandSource).not.toContain('Array.isArray(input)')
    const migrationImport = commandSource.slice(
      commandSource.indexOf("from '../db/migrations/zzzz20261118120000_strict_login_grant_scope'") - 80,
      commandSource.indexOf("from '../db/migrations/zzzz20261118120000_strict_login_grant_scope'"),
    )
    expect(migrationImport).not.toContain('STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS')
    expect(commandSource).toContain('function actorPlanReader(): AuthorizationInputQueryable')
    expect(commandSource).not.toContain('as Array<')
    expect(commandSource).not.toContain('import(')
    expect(commandSource).not.toContain('resolveAdminGrantTargetSet')
    expect(commandSource).not.toContain('createUserSession')
    expect(commandSource).not.toContain('changeRequiredPasswordWithProvenance')
    expect(commandSource).not.toContain('ADMIN_GRANT_SESSION_ASSERTION_UNRELEASED')
    expect(commandSource).not.toContain('ADMIN_GRANT_ACTOR_INPUTS_UNRELEASED')
    expect(commandSource).not.toContain('ADMIN_GRANT_CONSUME_BRAND')
    expect(commandSource).not.toContain('productionAvailable')
    expect(commandSource).not.toContain(STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX)
    expect(commandSource).not.toContain('input.context')
    expect(commandSource).not.toContain('input.browser')
    expect(commandSource).not.toContain('input.proof')
    expect(commandSource).not.toContain('input.publicOrigin')
    expect(commandSource).not.toContain('input.intent')
  })

  it('captures data descriptors once, locks the binding, and reconciles one read', () => {
    order(between(commandSource, 'function captureCommandInput', 'async function openActorRoot'), [
      'Object.getOwnPropertyDescriptors',
      "'value' in descriptor",
      'bindServices(captured.publicOrigin)',
      'assertAuthenticatedSessionContext(context)',
      'assertAdminGrantBrowserContext(browser, bound.origin)',
      'browser.session !== context',
      'normalizeAdminGrantIntent(captured.intent)',
    ])
    order(between(commandSource, 'async function authorizeActor', 'async function selectReceipt'), [
      'statements.lockWatermark',
      'statements.lockSession',
      'statements.lockBinding',
      'browserService.assertCurrent',
    ])
    const execute = between(commandSource, 'export async function executeAdminLoginGrantEnable', '')
    order(execute, [
      'const captured = captureCommand(input)',
      'const existing = await readCaptured(captured)',
      'retainAdminGrantBrowserContext',
      'try {',
      'captured.proof',
      'prepareConsume(captured.context, { intent, proof: captured.proof })',
      'consumeOnTx',
      "error.code === 'STRICT_LOGIN_GRANT_GRANT_OCCUPIED'",
      'const again = await readCaptured(captured)',
    ])
    expect(execute.split('prepareConsume(').length - 1).toBe(1)
    expect(execute.split('consumeOnTx(').length - 1).toBe(1)
    expect(execute.split('readCaptured(').length - 1).toBe(2)
  })
})
