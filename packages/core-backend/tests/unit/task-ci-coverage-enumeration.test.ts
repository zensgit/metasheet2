import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const integrationDir = join(repoRoot, 'packages/core-backend/tests/integration')
const DISK_RE = /^task-.*\.db\.test\.ts$/
const REL_RE = /^tests\/integration\/task-.*\.db\.test\.ts$/

function diskFiles(): string[] {
  return readdirSync(integrationDir)
    .filter((name) => DISK_RE.test(name))
    .map((name) => `tests/integration/${name}`)
    .sort()
}

function excludeEntries(): string[] {
  const text = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  return [...text.matchAll(/'(tests\/integration\/[^']+)'/g)]
    .map((match) => match[1])
    .filter((entry) => REL_RE.test(entry))
    .sort()
}

function laneFiles(): string[] {
  const text = readFileSync(join(repoRoot, '.github/workflows/tasks-realdb.yml'), 'utf8')
  return [...new Set([...text.matchAll(/tests\/integration\/task-.*\.db\.test\.ts/g)].map((match) => match[0]))].sort()
}

describe('task CI coverage enumeration', () => {
  it('the task db filename regex is not dead and the set is non-empty', () => {
    expect(DISK_RE.test('task-p0a.db.test.ts')).toBe(true)
    expect(DISK_RE.test('tasks-p0a.db.test.ts')).toBe(false)
    expect(REL_RE.test('tests/integration/task-p0a.db.test.ts')).toBe(true)
    expect(REL_RE.test('tests/integration/other.db.test.ts')).toBe(false)
    expect(diskFiles().length).toBeGreaterThan(0)
  })

  it('disk files, vitest exclude literals, and the real-db lane list are the same set', () => {
    const disk = diskFiles()
    expect(excludeEntries()).toEqual(disk)
    expect(laneFiles()).toEqual(disk)
  })

  it('every task db file imports the RBAC optional sentinel', () => {
    for (const rel of diskFiles()) {
      const text = readFileSync(join(repoRoot, 'packages/core-backend', rel), 'utf8')
      expect(text.includes('assert-rbac-optional-off'), rel).toBe(true)
    }
  })

  it('the enablement walk runs once, in its own step, under the trust-off config', () => {
    const file = 'tests/integration/task-enablement-http.db.test.ts'
    const lane = readFileSync(join(repoRoot, '.github/workflows/tasks-realdb.yml'), 'utf8')
    expect(lane.split(file).length - 1).toBe(1)
    const at = lane.indexOf(file)
    const stepStart = lane.lastIndexOf('- name:', at)
    const next = lane.indexOf('- name:', at)
    const step = lane.slice(stepStart, next === -1 ? undefined : next)
    expect(step).toContain('--config vitest.tasks-enablement.config.ts run')
    expect(step).toContain("RBAC_TOKEN_TRUST: 'false'")
    expect(step.includes('vitest.integration.config.ts')).toBe(false)

    const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.tasks-enablement.config.ts'), 'utf8')
    expect(cfg).toContain(`include: ['${file}']`)
    expect(cfg).toContain("setupFiles: ['./tests/tasks-enablement/setup.ts']")
    expect(cfg).toContain("RBAC_TOKEN_TRUST: 'false'")
    expect(cfg.includes("'./tests/setup.integration.ts'")).toBe(false)
    const setup = readFileSync(join(repoRoot, 'packages/core-backend/tests/tasks-enablement/setup.ts'), 'utf8')
    expect(setup).toContain("process.env.RBAC_TOKEN_TRUST = 'false'")
  })

  it('this enumeration file is not excluded and is not a lane file', () => {
    const unitCfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
    const lane = readFileSync(join(repoRoot, '.github/workflows/tasks-realdb.yml'), 'utf8')
    expect(unitCfg.includes('task-ci-coverage-enumeration.test.ts')).toBe(false)
    expect(lane.includes('task-ci-coverage-enumeration.test.ts')).toBe(false)
  })
})
