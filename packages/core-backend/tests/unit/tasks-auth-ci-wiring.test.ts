import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const setupPath = join(repoRoot, 'packages/core-backend/tests/tasks-auth/setup.ts')
const gatePath = join(repoRoot, 'packages/core-backend/tests/tasks-auth/tasks-auth-gate.ts')
const configPath = join(repoRoot, 'packages/core-backend/vitest.tasks-auth.config.ts')
const unitConfigPath = join(repoRoot, 'packages/core-backend/vitest.config.ts')

const GUARDS = [
  "if (process.env.RBAC_BYPASS !== 'false')",
  "if (process.env.RBAC_TOKEN_TRUST !== 'false')",
  "if (process.env.PRODUCT_MODE !== 'plm-workbench')",
  "if (process.env.RBAC_OPTIONAL === '1')",
  "if (process.env.TASKS_ENABLED !== 'true')",
]

function countLiteral(text: string, literal: string): number {
  const pattern = new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  return [...text.matchAll(pattern)].length
}

describe('tasks auth CI wiring', () => {
  it('pins the five setup guards after assignment and keeps this file in the unit run', () => {
    expect(existsSync(gatePath)).toBe(true)
    expect(existsSync(setupPath)).toBe(true)
    expect(existsSync(configPath)).toBe(true)
    const setup = readFileSync(setupPath, 'utf8')
    const assignedAt = setup.indexOf("process.env.TASKS_ENABLED = 'true'")
    expect(assignedAt).toBeGreaterThanOrEqual(0)
    for (const guard of GUARDS) {
      expect(countLiteral(setup, guard)).toBe(1)
      expect(setup.indexOf(guard)).toBeGreaterThan(assignedAt)
    }
    const unitCfg = readFileSync(unitConfigPath, 'utf8')
    expect(unitCfg.includes('tests/unit/tasks-auth-ci-wiring.test.ts')).toBe(false)
  })

  it('runs the pre-install wiring contract', () => {
    execFileSync(process.execPath, ['--test', 'scripts/ops/tasks-auth-ci-wiring.test.mjs'], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
  })
})
