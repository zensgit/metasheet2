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
import yaml from 'js-yaml'
import config from '../../vitest.config'

const BACKEND = path.resolve(__dirname, '..', '..')
const ROOT = path.resolve(BACKEND, '..', '..')
const DB_SPEC = 'tests/integration/notification-endpoints-preferences.db.test.ts'
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'plugin-tests.yml')
const PREDECESSOR = 'tests/integration/directory-integration-lifecycle-history-readable.db.test.ts'

type Step = { id?: string; run?: string; env?: Record<string, string>; if?: string }

function step(job: string, id: string): Step & { run: string } {
  const doc = yaml.load(readFileSync(WORKFLOW, 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
  const found = doc.jobs[job].steps.find((candidate) => candidate.id === id)
  if (!found?.run) throw new Error(`${job}/${id} not found`)
  return found as Step & { run: string }
}

const approvalStep = () => step('approval-db', 'approval-real-db-integration')

describe('user notification endpoints and preferences real-DB suite wiring', () => {
  it('exists', () => {
    expect(existsSync(path.join(BACKEND, DB_SPEC))).toBe(true)
  })

  it('is excluded from the no-DB vitest run, exactly once', () => {
    const exclude = (config as { test?: { exclude?: string[] } }).test?.exclude ?? []
    expect(exclude.filter((entry) => entry === DB_SPEC)).toHaveLength(1)
  })

  it('is named whole, exactly once, in the approval real-DB step, after the lifecycle history suite', () => {
    const { run } = approvalStep()
    expect(run.split(`  ${DB_SPEC} \\\n`).length - 1).toBe(1)
    expect(run.split(DB_SPEC).length - 1).toBe(1)
    expect(run).toContain(`  ${PREDECESSOR} \\\n  ${DB_SPEC} \\\n`)
  })

  it('is not also named in another job of the workflow', () => {
    const text = readFileSync(WORKFLOW, 'utf8')
    expect(text.split(DB_SPEC).length - 1).toBe(1)
    const doc = yaml.load(text) as { jobs: Record<string, { steps: Step[] }> }
    for (const [job, { steps }] of Object.entries(doc.jobs)) {
      if (job === 'approval-db') continue
      for (const candidate of steps) expect(candidate.run ?? '', `${job}/${candidate.id ?? ''}`).not.toContain(DB_SPEC)
    }
  })

  it('runs in a step that arms the database-expected sentinel on the Node 20 matrix entry, with a literal DATABASE_URL and a real vitest call', () => {
    const current = approvalStep()
    expect(current.env?.EXPECT_DB).toBe('1')
    expect(current.if).toBe("matrix.node-version == '20.x'")
    expect(current.env?.DATABASE_URL).toMatch(/^postgresql:\/\//)
    expect(current.run).toContain('vitest --config vitest.integration.config.ts run')
    expect(current.run).toContain(': "${DATABASE_URL:?DATABASE_URL is required')
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
