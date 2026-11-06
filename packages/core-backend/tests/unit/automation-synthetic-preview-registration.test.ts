/**
 * C1/S2 first slice — the real-PG proofs cannot silently stop running: both whole files are in the
 * EXPECT_DB plugin-tests step (20.x, no continue-on-error, no test filter) and excluded from the no-DB
 * default runner, so `describeIfDatabase` can never skip-green them.
 */
import { requiredSuiteJob } from '../../../../scripts/ops/plugin-tests-workflow-contract.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const SPECS = [
  'tests/integration/automation-synthetic-preview-realdb.test.ts',
  'tests/integration/automation-synthetic-preview-host-realdb.test.ts',
]

describe('synthetic integration preview real-DB registration', () => {
  it.each(SPECS)('%s runs as a whole file in an EXPECT_DB lane and is excluded from the no-DB runner', (spec) => {
    const workflow = yaml.load(readFileSync(path.join(ROOT, '.github/workflows/plugin-tests.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Array<{ id?: string; if?: string; env?: Record<string, string>; run?: string; 'continue-on-error'?: unknown }> }>
    }
    const step = requiredSuiteJob(workflow, 'runtime-db').steps.find((entry: { id?: string }) => entry.id === 'automation-synthetic-preview-real-db')
    expect(step?.env?.EXPECT_DB).toBe('1')
    expect(step?.env?.DATABASE_URL).toBeTruthy()
    expect(step?.if).toBe("matrix.node-version == '20.x'")
    expect(step?.['continue-on-error']).toBeUndefined()
    const command = (step?.run ?? '').replace(/\\\r?\n/g, ' ')
    expect(command).toMatch(/vitest --config vitest\.integration\.config\.ts run /)
    expect(command.split(/\s+/).filter((token) => token === spec)).toHaveLength(1)
    expect(command).not.toMatch(/(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
    const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(ROOT, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
    let excluded = false
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
        excluded ||= node.initializer.elements.some((entry) => ts.isStringLiteral(entry) && entry.text === spec)
      }
      ts.forEachChild(node, visit)
    }
    visit(config)
    expect(excluded).toBe(true)
  })
})
