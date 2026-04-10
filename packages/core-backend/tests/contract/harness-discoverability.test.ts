import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PKG_ROOT = resolve(__dirname, '..', '..')
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, 'package.json'), 'utf8'))
const scripts: Record<string, string> = pkg.scripts ?? {}
const docsPath = resolve(PKG_ROOT, 'tests', 'PACKAGE_SCRIPTS.md')
const docs = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : ''

describe('PLM consumer pact harness discoverability', () => {
  it('package.json exposes test:contract for the pact suite', () => {
    expect(scripts['test:contract']).toBeDefined()
    expect(scripts['test:contract']).toContain('tests/contract')
  })

  it('PACKAGE_SCRIPTS.md documents test:contract', () => {
    expect(docs).toContain('test:contract')
  })

  it('contract README exists', () => {
    expect(existsSync(resolve(PKG_ROOT, 'tests', 'contract', 'README.md'))).toBe(true)
  })

  it('consumer pact artifact exists', () => {
    expect(existsSync(resolve(PKG_ROOT, 'tests', 'contract', 'pacts', 'metasheet2-yuantus-plm.json'))).toBe(true)
  })
})
