import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * No-DB wiring contract for the tasks dedicated auth config (lock §5.2.1 ② / gate 16).
 *
 * Lives in tests/unit/ so default vitest (plugin-tests.yml "Run core-backend tests")
 * collects it with no workflow edit — plugin-tests.yml is s6a-pinned. Mirrors
 * scripts/ops/elearning-v01-auth-ci-wiring.test.mjs:74-93 (file-shape asserts).
 *
 * Does NOT prove the 403/200 behavioral cells (those land in
 * tests/tasks-auth/tasks-auth-gate.ts at M2, after tasks routes exist).
 */
const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..', '..')
const DEDICATED_CFG = join(pkgRoot, 'vitest.tasks-auth.config.ts')
const SETUP = join(pkgRoot, 'tests/tasks-auth/setup.ts')

describe('tasks dedicated auth config wiring', () => {
  it('dedicated auth config and setup exist and stay isolated from setup.integration.ts', () => {
    expect(existsSync(DEDICATED_CFG), 'vitest.tasks-auth.config.ts must exist').toBe(true)
    expect(existsSync(SETUP), 'tests/tasks-auth/setup.ts must exist').toBe(true)

    const cfg = readFileSync(DEDICATED_CFG, 'utf8')
    expect(cfg).toMatch(/include:\s*\[\s*'tests\/tasks-auth\/tasks-auth-gate\.ts'\s*,?\s*\]/)
    expect(cfg).toMatch(/setupFiles:\s*\[\s*'\.\/tests\/tasks-auth\/setup\.ts'\s*,?\s*\]/)
    expect(cfg).toMatch(/RBAC_BYPASS:\s*'false'/)
    expect(cfg).toMatch(/RBAC_TOKEN_TRUST:\s*'false'/)
    expect(cfg).toMatch(/PRODUCT_MODE:\s*'plm-workbench'/)
    expect(cfg.includes('vitest.integration.config')).toBe(false)
    expect(cfg.includes('--testNamePattern')).toBe(false)
    expect(cfg.includes('describe.skip')).toBe(false)
    expect(cfg.includes("setupFiles: ['./tests/setup.integration.ts']")).toBe(false)
    expect(cfg.includes("setupFiles: ['tests/setup.integration.ts']")).toBe(false)

    const setup = readFileSync(SETUP, 'utf8')
    expect(setup).toMatch(/process\.env\.RBAC_BYPASS = 'false'/)
    expect(setup).toMatch(/process\.env\.RBAC_TOKEN_TRUST = 'false'/)
    expect(setup).toMatch(/process\.env\.PRODUCT_MODE = 'plm-workbench'/)
    expect(setup).toMatch(/if \(!process\.env\.DATABASE_URL\)/)
    expect(setup).toMatch(/refusing skip-shaped green/)
    expect(setup.includes('describe.skip')).toBe(false)
    expect(setup.includes('.skip(')).toBe(false)
  })

  it('this wiring file itself lives under tests/unit/ (default vitest include, no workflow edit)', () => {
    expect(here.replace(/\\/g, '/').endsWith('/tests/unit')).toBe(true)
  })
})
