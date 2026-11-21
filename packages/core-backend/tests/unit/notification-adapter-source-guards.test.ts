import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSourceFiles } from '../helpers/import-edge-allowlist'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const REGISTRY_MODULE = 'notifications/adapters/notification-adapter.ts'
const TEST_SEAM = '__notificationAdapterRegistryForTests'
const TEST_SEAM_DECLARATION = /^export\s+const\s+__notificationAdapterRegistryForTests\s*=/m

function testSeamViolations(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([file, text]) => {
      // Exempt only the declaration, so the registry module cannot call its own test seam.
      const source = file === REGISTRY_MODULE ? text.replace(TEST_SEAM_DECLARATION, '') : text
      return source.includes(TEST_SEAM)
    })
    .map(([file]) => file)
    .sort()
}

describe('production code does not reference the notification adapter test seam', () => {
  it('holds for every backend source file', () => {
    const sources = new Map(listSourceFiles(SRC).map((file) => [
      path.relative(SRC, file).split(path.sep).join('/'),
      readFileSync(file, 'utf8'),
    ]))
    expect(sources.has(REGISTRY_MODULE)).toBe(true)
    expect(sources.get(REGISTRY_MODULE)).toMatch(TEST_SEAM_DECLARATION)
    expect(testSeamViolations(sources)).toEqual([])
  })

  it('allows the declaration and sources that use the production registry API', () => {
    expect(testSeamViolations(new Map([
      [REGISTRY_MODULE, `export const ${TEST_SEAM} = { restore() {} }`],
      ['notifications/sender.ts', "import { resolveNotificationAdapter } from './adapters/notification-adapter'"],
    ]))).toEqual([])
  })

  it.each([
    `${TEST_SEAM}.restore()`,
    `import { ${TEST_SEAM} as registry } from './adapters/notification-adapter'`,
    `export { ${TEST_SEAM} } from './adapters/notification-adapter'`,
    `adapters.${TEST_SEAM}.replace(new Map())`,
    `adapters['${TEST_SEAM}'].restore()`,
    `export const ${TEST_SEAM} = { restore() {} }`,
  ])('rejects a reference outside the declaring module: %s', (source) => {
    expect(testSeamViolations(new Map([['notifications/sender.ts', source]])))
      .toEqual(['notifications/sender.ts'])
  })

  it('rejects a use after the declaration in the registry module itself', () => {
    expect(testSeamViolations(new Map([
      [REGISTRY_MODULE, `export const ${TEST_SEAM} = { restore() {} }\n${TEST_SEAM}.restore()`],
    ]))).toEqual([REGISTRY_MODULE])
  })
})
