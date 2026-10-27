import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const workflowPath = '.github/workflows/local-org-workspace-db.yml'
const nativePath = 'packages/core-backend/tests/integration/local-organization-workspace.db.test.ts'
const nativeArg = 'tests/integration/local-organization-workspace.db.test.ts'
const contractPath = 'packages/core-backend/tests/unit/local-org-workspace-ci-contract.test.ts'
const configPath = 'packages/core-backend/vitest.config.ts'
const integrationConfigPath = 'packages/core-backend/vitest.integration.config.ts'
const EXPECTED_NATIVE_CASES = 22 // Explicit manual manifest: sentinel1 + business21; loops do not add cases.

interface Step {
  run?: string; if?: unknown; shell?: string
  'continue-on-error'?: unknown; env?: Record<string, unknown>
}
interface Job {
  if?: unknown; 'continue-on-error'?: unknown; env?: Record<string, unknown>
  services?: Record<string, { image?: string }>; steps?: Step[]
}
interface Workflow {
  on: Record<string, { paths?: string[]; branches?: string[] }>
  env?: Record<string, unknown>; jobs: Record<string, Job>
}
function read(path: string) { return readFileSync(join(root, path), 'utf8') }
function source(path: string) { return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true) }
function property(object: ts.ObjectLiteralExpression, key: string) {
  const entry = object.properties.find(node =>
    ts.isPropertyAssignment(node) && node.name.getText().replace(/['"]/g, '') === key)
  return entry && ts.isPropertyAssignment(entry) ? entry.initializer : undefined
}
function testConfig(path: string) {
  const file = source(path)
  let result: ts.ObjectLiteralExpression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'defineConfig') {
      const config = node.arguments[0]
      if (config && ts.isObjectLiteralExpression(config)) {
        const test = property(config, 'test')
        if (test && ts.isObjectLiteralExpression(test)) result = test
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(result).toBeDefined()
  return result!
}
function commands(step: Step) {
  return (step.run ?? '').split('\n').filter(line => !line.trimStart().startsWith('#'))
    .join('\n').replace(/\\\r?\n/g, ' ').split('\n').map(line => line.trim()).filter(Boolean)
}
function nativeCommands(step: Step) {
  return commands(step).filter(line => /\bvitest\b/.test(line) && line.split(/\s+/).includes(nativeArg))
}
function unconditional(step: Step) {
  expect(step.if).toBeUndefined()
  expect(step['continue-on-error'] ?? false).toBe(false)
}

describe('local organization workspace native lane source contract', () => {
  it('PR and main-push path triggers cover runtime, helpers, migration stream, native/unit tests and lane configuration', () => {
    const doc = yaml.load(read(workflowPath)) as Workflow
    const paths = [
      'packages/core-backend/src/index.ts',
      'packages/core-backend/src/directory/local-organization-workspace.ts',
      'packages/core-backend/src/directory/local-organization-member-projection.ts',
      'packages/core-backend/src/routes/admin-directory-local.ts',
      'packages/core-backend/src/routes/admin-local-organization-workspace.ts',
      'packages/core-backend/src/directory/access-graph-mutex.ts',
      'packages/core-backend/src/directory/org-membership-history.ts',
      'packages/core-backend/src/directory/local-directory-org.ts',
      'packages/core-backend/src/directory/deprovision-ledger.ts',
      'packages/core-backend/src/db/migrations/**',
      nativePath, contractPath, configPath, integrationConfigPath, workflowPath,
    ]
    for (const event of ['pull_request', 'push']) {
      expect(doc.on[event]?.paths).toEqual(expect.arrayContaining(paths))
      expect(doc.on[event]?.paths).not.toContain('!'+nativePath)
    }
    expect(doc.on.push.branches).toContain('main')
  })

  it('one unconditional PostgreSQL lane migrates before an unfiltered whole-file verbose EXPECT_DB=1 execution', () => {
    const doc = yaml.load(read(workflowPath)) as Workflow
    const lanes = Object.values(doc.jobs).filter(job => (job.steps ?? []).some(step => nativeCommands(step).length > 0))
    expect(lanes).toHaveLength(1)
    const job = lanes[0]!
    expect(job.if).toBeUndefined()
    expect(job['continue-on-error'] ?? false).toBe(false)
    expect(Object.values(job.services ?? {}).some(service => /^postgres:/.test(service.image ?? ''))).toBe(true)
    const steps = job.steps ?? []
    const index = steps.findIndex(step => nativeCommands(step).length > 0)
    const native = steps[index]!
    unconditional(native)
    const env = { ...doc.env, ...job.env, ...native.env }
    expect(env.EXPECT_DB).toBe('1')
    expect(typeof env.DATABASE_URL).toBe('string')
    expect(String(env.DATABASE_URL).length).toBeGreaterThan(0)
    const runs = nativeCommands(native)
    expect(runs).toHaveLength(1)
    // Plain command only: no shell conditions, pipe/masking, name/file filters or sharding.
    expect(runs[0]).toBe(
      'pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run ' + nativeArg + ' --reporter=verbose',
    )
    expect(commands(native).some(line => /^(?:if|case|exit)\b|\|\||&&/.test(line))).toBe(false)
    const migrationSteps = steps.slice(0, index).filter(step =>
      commands(step).some(line => /^pnpm --filter @metasheet\/core-backend (?:db:migrate|migrate)$/.test(line)))
    expect(migrationSteps).toHaveLength(1)
    const migration = migrationSteps[0]!
    unconditional(migration)
    expect(commands(migration).some(line => /^(?:if|case|exit)\b|\|\||&&/.test(line))).toBe(false)
    const migrationEnv = { ...doc.env, ...job.env, ...migration.env }
    expect(migrationEnv.DATABASE_URL).toBe(env.DATABASE_URL)
    // This lane uses the actual migrations; no schema/fixture bootstrap or conditional migration.
    for (const required of ['20260324150000', '20260715090000', '20260724170000', '20260728100000']) {
      expect(String(migrationEnv.MIGRATION_EXCLUDE ?? '')).not.toContain(required)
    }
    expect((native.run ?? '')).not.toMatch(/--(?:testNamePattern|passWithNoTests|exclude|shard|changed|related)(?:\s|=|$)|(?:^|\s)-t(?:\s|=|$)/)
  })

  it('AST confirms explicit no-DB exclusion, retained unit contract and unchanged 30s/15s integration budgets', () => {
    const config = testConfig(configPath)
    expect(property(config, 'include')).toBeUndefined()
    const excluded = property(config, 'exclude')
    expect(excluded && ts.isArrayLiteralExpression(excluded)).toBe(true)
    const entries = excluded && ts.isArrayLiteralExpression(excluded)
      ? excluded.elements.filter(ts.isStringLiteral).map(entry => entry.text) : []
    expect(entries).toContain(nativeArg)
    expect(entries).not.toContain('tests/unit/local-org-workspace-ci-contract.test.ts')
    const integration = testConfig(integrationConfigPath)
    expect(property(integration, 'testTimeout')?.getText()).toBe('30000')
    expect(property(integration, 'hookTimeout')?.getText()).toBe('15000')
  })

  it('AST counts the finite sentinel-inclusive manifest and guards against focused or unreachable native execution', () => {
    const file = source(nativePath)
    const names: string[] = []
    let dbSentinelGuard = false
    let databaseAssertion = false
    const focused: string[] = []
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'itIfExpectDb') {
        dbSentinelGuard = node.initializer?.getText(file) === "process.env.EXPECT_DB === '1' ? it : it.skip"
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(file)
        if (['it', 'itIfExpectDb'].includes(callee) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
          names.push(node.arguments[0].text)
        }
        if (/^(?:it|test|describe)\.(?:only|skip|todo)$/.test(callee)) focused.push(callee)
        if (callee === 'expect(process.env.DATABASE_URL).toBeTruthy') databaseAssertion = true
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    expect(names).toHaveLength(EXPECTED_NATIVE_CASES)
    expect(new Set(names).size).toBe(EXPECTED_NATIVE_CASES)
    expect(names[0]).toBe('sentinel: EXPECT_DB lane must have DATABASE_URL')
    expect(dbSentinelGuard).toBe(true)
    expect(databaseAssertion).toBe(true)
    expect(focused).toEqual([])
    expect(names.some(name => name.includes('canonical both-leg zero-row evidence trace'))).toBe(true)
    expect(names.some(name => name.includes('POST waits on users mutex'))).toBe(true)
    expect(names.some(name => name.includes('FOR SHARE NOWAIT'))).toBe(true)
    expect(names.some(name => name.includes('production apply sees the fresh local sibling'))).toBe(true)
  })
})
