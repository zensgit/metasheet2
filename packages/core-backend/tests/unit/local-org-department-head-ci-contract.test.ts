import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const workflowPath = '.github/workflows/local-org-department-head-db.yml'
const nativePath = 'packages/core-backend/tests/integration/local-org-department-head.db.test.ts'
const nativeArg = 'tests/integration/local-org-department-head.db.test.ts'
const configPath = 'packages/core-backend/vitest.config.ts'
const contractPath = 'packages/core-backend/tests/unit/local-org-department-head-ci-contract.test.ts'
const migrationPath = 'packages/core-backend/src/db/migrations/zzzz20261027090000_add_local_department_head.ts'

interface Step { run?: string; if?: unknown; 'continue-on-error'?: boolean; env?: Record<string, unknown> }
interface Job {
  if?: unknown
  env?: Record<string, unknown>
  services?: Record<string, { image?: string }>
  steps?: Step[]
}
interface Workflow {
  on: Record<string, { paths?: string[]; branches?: string[] }>
  env?: Record<string, unknown>
  jobs: Record<string, Job>
}
function read(path: string) { return readFileSync(join(root, path), 'utf8') }
function workflow() { return yaml.load(read(workflowPath)) as Workflow }
function commands(step: Step): string[] {
  return (step.run ?? '').split('\n').filter((line) => !line.trimStart().startsWith('#'))
    .join('\n').replace(/\\\r?\n/g, ' ').split('\n').map((line) => line.trim()).filter(Boolean)
}
function nativeCommands(step: Step): string[] {
  return commands(step).filter((line) => /\bvitest\b/.test(line) && line.split(/\s+/).includes(nativeArg))
}
function property(object: ts.ObjectLiteralExpression, key: string) {
  const node = object.properties.find((entry) =>
    ts.isPropertyAssignment(entry) && entry.name.getText().replace(/['"]/g, '') === key)
  return node && ts.isPropertyAssignment(node) ? node.initializer : undefined
}
function defaultTestConfig() {
  const source = ts.createSourceFile(configPath, read(configPath), ts.ScriptTarget.Latest, true)
  let result: ts.ObjectLiteralExpression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'defineConfig') {
      const config = node.arguments[0]
      if (config && ts.isObjectLiteralExpression(config)) {
        const test = property(config, 'test')
        if (test && ts.isObjectLiteralExpression(test)) result = test
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(result).toBeDefined()
  return result!
}

describe('native local head dedicated DB lane contract', () => {
  it('PR and main-push triggers include runtime, migration, both tests, config and workflow', () => {
    const doc = workflow()
    const inputs = [
      'packages/core-backend/src/directory/local-directory-department-head.ts',
      'packages/core-backend/src/services/ApprovalDirectoryOrg.ts',
      'packages/core-backend/src/routes/admin-directory-local.ts',
      migrationPath, nativePath, contractPath, configPath, workflowPath,
    ]
    for (const event of ['pull_request', 'push']) {
      expect(doc.on[event]?.paths).toEqual(expect.arrayContaining(inputs))
    }
    expect(doc.on.push.branches).toContain('main')
  })

  it('an unconditional PostgreSQL job migrates before the whole native file with EXPECT_DB=1', () => {
    const doc = workflow()
    const jobs = Object.values(doc.jobs).filter((job) =>
      (job.steps ?? []).some((step) => nativeCommands(step).length > 0))
    expect(jobs).toHaveLength(1)
    const job = jobs[0]!
    expect(job.if).toBeUndefined()
    expect(Object.values(job.services ?? {}).some((service) => /^postgres:/.test(service.image ?? ''))).toBe(true)
    const steps = job.steps ?? []
    const index = steps.findIndex((step) => nativeCommands(step).length > 0)
    const step = steps[index]!
    expect(step.if).toBeUndefined()
    expect(step['continue-on-error'] ?? false).toBe(false)
    const env = { ...doc.env, ...job.env, ...step.env }
    expect(env.EXPECT_DB).toBe('1')
    expect(typeof env.DATABASE_URL).toBe('string')
    expect(String(env.DATABASE_URL).length).toBeGreaterThan(0)
    const run = nativeCommands(step)
    expect(run).toHaveLength(1)
    expect(run[0]).toMatch(/--config\s+vitest\.integration\.config\.ts\s+run\s/)
    expect(run[0]).toContain('--reporter=verbose')
    expect(run[0]).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests|--exclude)(?:\s|=|$)/)
    expect(run[0]).not.toMatch(/\|\||continue-on-error/)
    const migration = steps.slice(0, index).filter((candidate) =>
      commands(candidate).some((line) => /pnpm\s+--filter\s+@metasheet\/core-backend\s+(?:db:migrate|migrate)(?:\s|$)/.test(line)))
    expect(migration).toHaveLength(1)
    expect(migration[0]!.if).toBeUndefined()
    const migrationEnv = { ...doc.env, ...job.env, ...migration[0]!.env }
    expect(String(migrationEnv.MIGRATION_EXCLUDE ?? '')).not.toContain('20261027090000')
  })

  it('default no-DB config really excludes the native file and retains the unit contract', () => {
    const config = defaultTestConfig()
    expect(property(config, 'include')).toBeUndefined()
    const excluded = property(config, 'exclude')
    expect(excluded && ts.isArrayLiteralExpression(excluded)).toBe(true)
    const entries = excluded && ts.isArrayLiteralExpression(excluded)
      ? excluded.elements.filter(ts.isStringLiteral).map((entry) => entry.text) : []
    expect(entries).toContain(nativeArg)
    expect(entries).not.toContain('tests/unit/local-org-department-head-ci-contract.test.ts')
    const native = read(nativePath).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(native).toContain("process.env.EXPECT_DB === '1' ? it : it.skip")
    expect(native).toContain('expect(process.env.DATABASE_URL).toBeTruthy()')
    expect(native).toContain('LOCAL_HEAD_BASELINE:')
    expect(native).toContain('OLD_DIRECT_MANAGER_CONTROL:')
  })
})
