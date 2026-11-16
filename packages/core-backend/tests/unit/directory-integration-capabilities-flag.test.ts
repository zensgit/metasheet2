import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { isDirectoryIntegrationCapabilitiesEnabled } from '../../src/integrations/directory-integration-capabilities-flag'

const SRC = path.resolve(__dirname, '..', '..', 'src')
const FLAG_MODULE = path.join(SRC, 'integrations', 'directory-integration-capabilities-flag.ts')
const KEY = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED'

const OFF_VALUES: ReadonlyArray<string | undefined> = [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', ' true ', '1', 'yes', 'on']

let saved: string | undefined = process.env[KEY]
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

describe('DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED', () => {
  it('is on only for the exact string true, from the env passed in', () => {
    for (const value of OFF_VALUES) {
      expect(isDirectoryIntegrationCapabilitiesEnabled(value === undefined ? {} : { [KEY]: value })).toBe(false)
    }
    expect(isDirectoryIntegrationCapabilitiesEnabled({ [KEY]: 'true' })).toBe(true)
  })

  it('reads the environment on every call and does not cache it', () => {
    for (const value of OFF_VALUES) withEnv(value, () => expect(isDirectoryIntegrationCapabilitiesEnabled()).toBe(false))
    withEnv('true', () => expect(isDirectoryIntegrationCapabilitiesEnabled()).toBe(true))
    withEnv('true', () => {
      expect(isDirectoryIntegrationCapabilitiesEnabled()).toBe(true)
      process.env[KEY] = 'false'
      expect(isDirectoryIntegrationCapabilitiesEnabled()).toBe(false)
    })
  })

  it('is a pure module with one literal comparison and no folding', () => {
    const text = readFileSync(FLAG_MODULE, 'utf8')
    const source = ts.createSourceFile(FLAG_MODULE, text, ts.ScriptTarget.Latest, true)
    expect(text).toContain("env.DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED === 'true'")
    const code = source.statements.map((statement) => statement.getText(source)).join('\n')
    expect(code).not.toMatch(/\.trim\(\)|toLowerCase\(\)|toUpperCase\(\)/)
    expect(source.statements.some((statement) => ts.isImportDeclaration(statement))).toBe(false)
  })
})
