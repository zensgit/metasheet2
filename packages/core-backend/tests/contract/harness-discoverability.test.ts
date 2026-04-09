/**
 * Harness discoverability contract.
 *
 * Asserts that the federated PLM test infrastructure (scripts, configs,
 * specs, docs) exists and is correctly wired. If someone renames a file
 * or removes a script, this test fails immediately — before a confused
 * developer spends time wondering why "npm run test:e2e:handoff" 404s.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const PKG_ROOT = resolve(__dirname, '..', '..')
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8'))
const scripts: Record<string, string> = pkg.scripts ?? {}

const SCRIPTS_DOC = resolve(PKG_ROOT, 'tests', 'PACKAGE_SCRIPTS.md')
const scriptsMd = existsSync(SCRIPTS_DOC) ? readFileSync(SCRIPTS_DOC, 'utf8') : ''

describe('Federated PLM harness discoverability', () => {
  it('package.json has test:contract script pointing to vitest contract tests', () => {
    expect(scripts['test:contract']).toBeDefined()
    expect(scripts['test:contract']).toContain('tests/contract')
  })

  it('package.json has test:e2e:handoff script pointing to Playwright config', () => {
    expect(scripts['test:e2e:handoff']).toBeDefined()
    expect(scripts['test:e2e:handoff']).toContain('tests/e2e/playwright.config.ts')
  })

  it('PACKAGE_SCRIPTS.md documents both commands', () => {
    expect(scriptsMd).toContain('test:contract')
    expect(scriptsMd).toContain('test:e2e:handoff')
  })

  it('Playwright config exists', () => {
    expect(existsSync(resolve(PKG_ROOT, 'tests', 'e2e', 'playwright.config.ts'))).toBe(true)
  })

  it('handoff journey spec exists', () => {
    expect(existsSync(resolve(PKG_ROOT, 'tests', 'e2e', 'handoff-journey.spec.ts'))).toBe(true)
  })

  it('E2E README exists', () => {
    expect(existsSync(resolve(PKG_ROOT, 'tests', 'e2e', 'README.md'))).toBe(true)
  })

  it('Pact consumer artifact exists', () => {
    expect(existsSync(resolve(PKG_ROOT, 'tests', 'contract', 'pacts', 'metasheet2-yuantus-plm.json'))).toBe(true)
  })
})
