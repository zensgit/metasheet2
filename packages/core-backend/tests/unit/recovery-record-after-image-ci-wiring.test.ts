import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import { expect, test } from 'vitest'

test('recovery image PG proof is a whole-file post-migration CI argument, excluded from no-DB tests', () => {
  const root = path.resolve(__dirname, '../../../..')
  const suite = 'tests/integration/multitable-recovery-record-after-image-realdb.test.ts'
  const workflow = yaml.load(readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8')) as {
    jobs: { test: { steps: Array<{ id?: string; name?: string; if?: string; env?: Record<string, string>;
      run?: string; 'continue-on-error'?: unknown }> } }
  }
  const steps = workflow.jobs.test.steps
  const index = steps.findIndex(step => step.id === 'multitable-real-db-integration')
  expect(index).toBeGreaterThan(steps.findIndex(step => step.name === 'Run DB migrations'))
  expect(steps.findIndex(step => step.name === 'Run DB migrations')).toBeGreaterThanOrEqual(0)
  const step = steps[index]
  expect(step?.env?.METASHEET_REAL_DB_TEST_STEP).toBe('1')
  expect(step?.env?.DATABASE_URL).toBeTruthy()
  expect(step?.if).toBe("matrix.node-version == '20.x'")
  expect(step?.['continue-on-error']).toBeUndefined()
  const command = (step?.run ?? '').replace(/\\\r?\n/gu, ' ')
  expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /u)
  expect(command.split(/\s+/u).filter(token => token === suite)).toHaveLength(1)
  expect(command).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/u)
  const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(root,
    'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  let excluded = 0
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude'
      && ts.isArrayLiteralExpression(node.initializer)) {
      excluded += node.initializer.elements.filter(item => ts.isStringLiteral(item) && item.text === suite).length
    }
    ts.forEachChild(node, visit)
  }
  visit(config)
  expect(excluded).toBe(1)
  expect(readFileSync(path.join(root, 'packages/core-backend', suite), 'utf8'))
    .toContain('SA06AQ recovery record after-image')
})
