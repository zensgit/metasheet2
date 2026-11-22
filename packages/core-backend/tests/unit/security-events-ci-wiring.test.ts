import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isQuotedInTestExclude, parseYamlDocument, realDbStepWholeFileArgs, requireExecutableRealDbStep,
} from '../../../../scripts/ops/ci-realdb-step-contract.mjs'

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
const file = 'tests/integration/security-events-schema.db.test.ts'
const workflow = read('../../../../.github/workflows/plugin-tests.yml')
afterEach(() => { expect(expect.getState().assertionCalls).toBeGreaterThan(0) })

describe('E1-A required whole-file DB registration', () => {
  it('runs in the required approval lane and stays excluded from the default no-DB run', () => {
    expect(() => requireExecutableRealDbStep(workflow, 'approval-real-db-integration')).not.toThrow()
    expect(realDbStepWholeFileArgs(workflow, 'approval-real-db-integration').filter((item: string) => item === file)).toEqual([file])
    const config = read('../../vitest.config.ts')
    expect(isQuotedInTestExclude(config, file)).toBe(true)
    expect(config.split(`'${file}'`)).toHaveLength(2)
    for (const name of ['vitest.e1a.config.ts', 'vitest.e1a-db.config.ts']) {
      expect(existsSync(new URL('../../' + name, import.meta.url))).toBe(false)
    }
    expect(read('../../vitest.integration.config.ts')).toContain('tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)')
  })
  it('runs the same twelve cases under each PG14–17 fence lane without a name filter or soft failure', () => {
    const source = read('../../../../.github/workflows/permission-authorization-operation-realdb.yml')
    const doc = parseYamlDocument(source)
    const job = doc.jobs['authorization-operation']
    expect(job.strategy.matrix['postgres-major']).toEqual(['14', '15', '16', '17'])
    expect(job.if).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    const steps = job.steps.filter((step: { id?: string }) => step.id === 'security-events-schema-realdb')
    expect(steps).toHaveLength(1)
    const step = steps[0]
    expect(step.if).toBeUndefined()
    expect(step['continue-on-error']).toBeUndefined()
    expect(step['working-directory']).toBe('packages/core-backend')
    expect(step.env).toEqual({ DATABASE_URL: '${{ env.PERMISSION_COMMAND_PG_BASE_URL }}', EXPECT_DB: '1', E1A_PG_MAJOR: '${{ matrix.postgres-major }}' })
    expect(step.run).toContain('node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts')
    expect(step.run.split(file)).toHaveLength(2)
    expect(step.run).toContain('node ../../scripts/ops/vitest-zero-skip.mjs ../../artifacts/e1a-realdb/vitest.json 1')
    expect(step.run).not.toMatch(/--testNamePattern|(?:^|\s)-t\s|\|\|\s*true|continue-on-error/)
    const db = read('../integration/security-events-schema.db.test.ts')
    expect(db.match(/\bit\('/g)).toHaveLength(12)
    expect(db).not.toMatch(/\b(?:it|describe)\.(?:skip|todo|only)|describeIf/)
    expect(db).toContain("process.env.EXPECT_DB !== '1'")
    expect(db).toContain('expect(after).toEqual(baseline)')
    expect(db).toContain('expect(await currentCatalog()).toEqual(rawBaseline)')
    expect(source.match(/packages\/core-backend\/src\/security-events\/\*\*/g)).toHaveLength(2)
  })
})
