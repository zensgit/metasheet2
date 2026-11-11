/**
 * The real-PostgreSQL suite of the user notification endpoints and preferences is excluded from the
 * no-database run and named whole in the approval real-database step of the plugin-tests workflow, a
 * step that arms the database-expected sentinel on the Node 20 matrix entry. The suite itself fails when
 * it is asked to run against a database and none is configured.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import {
  REAL_DB_STEP_IDS,
  extractStepById,
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  parseYamlDocument,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
} from '../../../../scripts/ops/ci-realdb-step-contract.mjs'

const BACKEND = path.resolve(__dirname, '..', '..')
const ROOT = path.resolve(BACKEND, '..', '..')
const DB_SPEC = 'tests/integration/notification-endpoints-preferences.db.test.ts'
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'plugin-tests.yml')
const VITEST_CONFIG = path.join(BACKEND, 'vitest.config.ts')
const PREDECESSOR = 'tests/integration/directory-integration-lifecycle-history-readable.db.test.ts'
const STEP = REAL_DB_STEP_IDS.approval

const workflow = () => readFileSync(WORKFLOW, 'utf8')

describe('user notification endpoints and preferences real-DB suite wiring', () => {
  it('exists', () => {
    expect(existsSync(path.join(BACKEND, DB_SPEC))).toBe(true)
  })

  it('is excluded from the no-DB vitest run, as one quoted entry of test.exclude', () => {
    const config = readFileSync(VITEST_CONFIG, 'utf8')
    expect(isQuotedInTestExclude(config, DB_SPEC)).toBe(true)
    expect(config.split(`'${DB_SPEC}'`).length - 1).toBe(1)
  })

  it('is run by the approval real-DB step under the shared step contract', () => {
    expect(() => requireExecutableRealDbStep(workflow(), STEP)).not.toThrow()
  })

  it('is a whole-file argument of that step, exactly once, right after the lifecycle history suite', () => {
    expect(isSuiteWiredInRealDbStep(workflow(), STEP, DB_SPEC)).toBe(true)
    const args = realDbStepWholeFileArgs(workflow(), STEP)
    expect(args.filter((arg) => arg === DB_SPEC)).toHaveLength(1)
    expect(args.indexOf(DB_SPEC)).toBe(args.indexOf(PREDECESSOR) + 1)
    expect(args.indexOf(PREDECESSOR)).toBeGreaterThanOrEqual(0)
  })

  it('is not an argument of the other real-DB step, and no other step of the workflow names it', () => {
    expect(realDbStepWholeFileArgs(workflow(), REAL_DB_STEP_IDS.multitable)).not.toContain(DB_SPEC)
    const doc = parseYamlDocument(workflow()) as { jobs: Record<string, { steps?: Array<{ id?: string; run?: string }> }> }
    const naming = Object.entries(doc.jobs).flatMap(([job, { steps = [] }]) =>
      steps.filter((candidate) => (candidate.run ?? '').includes(DB_SPEC)).map((candidate) => `${job}/${candidate.id ?? ''}`),
    )
    expect(naming).toEqual([`approval-db/${STEP}`])
  })

  it('runs in a step that arms the database-expected sentinel', () => {
    const step = extractStepById(workflow(), STEP) as { env?: Record<string, string> } | null
    expect(step?.env?.EXPECT_DB).toBe('1')
  })

  it('carries the sentinel that fails a database-expected run without a database, at module top level', () => {
    const text = readFileSync(path.join(BACKEND, DB_SPEC), 'utf8')
    expect(sentinelPlacement(text)).toBe('top-level')
    expect(text).toContain("const EXPECT_DB = process.env.EXPECT_DB === '1'\nconst itIfExpectDb = EXPECT_DB ? it : it.skip\n")
  })

  it('tells a nested sentinel from a top-level one', () => {
    const body = "itIfExpectDb('sentinel: x', () => { expect(process.env.DATABASE_URL).toBeTruthy() })"
    const head = "const EXPECT_DB = process.env.EXPECT_DB === '1'\nconst itIfExpectDb = EXPECT_DB ? it : it.skip\n"
    expect(sentinelPlacement(`${head}${body}\ndescribeIfDatabase('x', () => {})`)).toBe('top-level')
    expect(sentinelPlacement(`${head}describeIfDatabase('x', () => {\n${body}\n})`)).toBe('nested')
    expect(sentinelPlacement(`${head}describeIfDatabase('x', () => {})`)).toBe('missing')
  })

  it('reads no environment value other than the connection string and the sentinel switch', () => {
    const text = readFileSync(path.join(BACKEND, DB_SPEC), 'utf8')
    const names = new Set((text.match(/process\.env\.[A-Z_]+/g) ?? []).map((reference) => reference.replace('process.env.', '')))
    expect([...names].sort()).toEqual(['DATABASE_URL', 'EXPECT_DB'])
  })
})

/**
 * Where the database-expected sentinel call sits: a direct statement of the module, inside another call
 * (for example the database-gated describe), or absent. Only the first can fail when the gated describe
 * is skipped.
 */
function sentinelPlacement(source: string): 'top-level' | 'nested' | 'missing' {
  const file = ts.createSourceFile('db-spec.ts', source, ts.ScriptTarget.Latest, true)
  const isSentinelCall = (node: ts.Node): boolean =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'itIfExpectDb' &&
    /sentinel/.test(node.arguments[0]?.getText(file) ?? '') &&
    /expect\(process\.env\.DATABASE_URL\)\.toBeTruthy\(\)/.test(node.getText(file))
  const topLevel = file.statements.some((statement) => ts.isExpressionStatement(statement) && isSentinelCall(statement.expression))
  if (topLevel) return 'top-level'
  let found = false
  const visit = (node: ts.Node): void => {
    if (isSentinelCall(node)) found = true
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found ? 'nested' : 'missing'
}
