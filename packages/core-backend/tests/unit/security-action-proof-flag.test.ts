import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

vi.mock('../../src/db/pg', () => ({ pool: null, query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: { get: () => ({ query: vi.fn(), transaction: vi.fn(), getInternalPool: () => null }) },
}))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))

import { isSecurityActionProofEnabled } from '../../src/auth/security-action-proof-flag'
import { securityActionsRouter } from '../../src/routes/security-actions'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const FLAG_MODULE = path.join(SRC, 'auth', 'security-action-proof-flag.ts')
const SERVICE_MODULE = path.join(SRC, 'auth', 'security-action-proof.ts')
const ROUTE_MODULE = path.join(SRC, 'routes', 'security-actions.ts')
const KEY = 'SECURITY_ACTION_PROOF_ENABLED'

const OFF_VALUES: ReadonlyArray<string | undefined> = [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', ' true ', '1', 'yes']

let saved: string | undefined
function withEnv(value: string | undefined, run: () => void): void {
  saved = process.env[KEY]
  if (value === undefined) delete process.env[KEY]
  else process.env[KEY] = value
  try {
    run()
  } finally {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
  }
}
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

/** Property accesses of `<x>.SECURITY_ACTION_PROOF_ENABLED` and string literals equal to the key, in one source file. */
function keyReadSites(file: string): number {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let sites = 0
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === KEY) sites += 1
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === KEY) sites += 1
    if (ts.isStringLiteral(node) && node.text === KEY && !ts.isElementAccessExpression(node.parent)) sites += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

function processEnvSites(file: string): number {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let sites = 0
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process') sites += 1
    ts.forEachChild(node, visit)
  }
  visit(source)
  return sites
}

describe('SECURITY_ACTION_PROOF_ENABLED', () => {
  it('is on only for the exact string true', () => {
    for (const value of OFF_VALUES) {
      expect(isSecurityActionProofEnabled(value === undefined ? {} : { [KEY]: value })).toBe(false)
      withEnv(value, () => expect(isSecurityActionProofEnabled()).toBe(false))
    }
    expect(isSecurityActionProofEnabled({ [KEY]: 'true' })).toBe(true)
    withEnv('true', () => expect(isSecurityActionProofEnabled()).toBe(true))
  })

  it('leaves the router unmounted for every value other than the exact string true', () => {
    for (const value of OFF_VALUES) withEnv(value, () => expect(securityActionsRouter()).toBeNull())
    withEnv('true', () => {
      const router = securityActionsRouter()
      expect(router).not.toBeNull()
      expect(typeof router).toBe('function')
    })
  })

  it('is read by the flag module only, through one predicate the route and the service both call', () => {
    const flag = readFileSync(FLAG_MODULE, 'utf8')
    expect(flag).toContain("env.SECURITY_ACTION_PROOF_ENABLED === 'true'")
    expect(flag).not.toMatch(/\.trim\(\)|toLowerCase\(\)|toUpperCase\(\)/)
    expect(keyReadSites(FLAG_MODULE)).toBe(1)
    expect(processEnvSites(FLAG_MODULE)).toBe(1)
    for (const module of [SERVICE_MODULE, ROUTE_MODULE]) {
      const source = readFileSync(module, 'utf8')
      expect(source).toContain("from './security-action-proof-flag'".replace('./', module === ROUTE_MODULE ? '../auth/' : './'))
      expect(source).toMatch(/isSecurityActionProofEnabled\(\)/)
      expect(keyReadSites(module)).toBe(0)
      expect(processEnvSites(module)).toBe(0)
    }
  })
})
