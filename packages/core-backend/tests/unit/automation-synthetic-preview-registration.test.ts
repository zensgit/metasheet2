/**
 * C1/S2 first slice — the real-PG proofs cannot silently stop running: both whole files are in the
 * EXPECT_DB plugin-tests step (20.x, no continue-on-error, no test filter) and excluded from the no-DB
 * default runner, so `describeIfDatabase` can never skip-green them. The C01 real-browser file is a whole
 * file of the real-host browser launcher (TEST_FILES and its config include) and excluded likewise.
 */
import { requiredSuiteJob } from '../../../../scripts/ops/plugin-tests-workflow-contract.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const BROWSER_SPEC = 'tests/integration/automation-synthetic-preview-browser-realdb.test.ts'
const SPECS = [
  'tests/integration/automation-synthetic-preview-realdb.test.ts',
  'tests/integration/automation-synthetic-preview-host-realdb.test.ts',
]

function excludedFromNoDbRunner(spec: string): boolean {
  const config = ts.createSourceFile('vitest.config.ts', readFileSync(path.join(ROOT, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  let excluded = false
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      excluded ||= node.initializer.elements.some((entry) => ts.isStringLiteral(entry) && entry.text === spec)
    }
    ts.forEachChild(node, visit)
  }
  visit(config)
  return excluded
}

/** The string literals of one top-level array (a TEST_FILES export or a config include). */
function arrayLiterals(file: string, select: (node: ts.Node, source: ts.SourceFile) => ts.ArrayLiteralExpression | undefined): string[] {
  const source = ts.createSourceFile(path.basename(file), readFileSync(path.join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[][] = []
  const visit = (node: ts.Node): void => {
    const array = select(node, source)
    if (array) found.push(array.elements.filter(ts.isStringLiteral).map((entry) => entry.text))
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(found).toHaveLength(1)
  return found[0]
}

describe('synthetic integration preview real-DB registration', () => {
  it('the C01 browser case is a whole file of the real-host browser launcher and excluded from the no-DB runner', () => {
    const launcherFiles = arrayLiterals('scripts/ops/run-stock-preparation-yida-browser-ci.mjs', (node) =>
      ts.isVariableDeclaration(node) && node.name.getText() === 'TEST_FILES' && node.initializer && ts.isCallExpression(node.initializer)
        && ts.isArrayLiteralExpression(node.initializer.arguments[0]) ? node.initializer.arguments[0] : undefined)
    expect(launcherFiles.filter((file) => file === BROWSER_SPEC)).toHaveLength(1)
    const include = arrayLiterals('packages/core-backend/vitest.yida-owner-realdb.config.ts', (node, source) =>
      ts.isPropertyAssignment(node) && node.name.getText(source) === 'include' && ts.isArrayLiteralExpression(node.initializer) ? node.initializer : undefined)
    expect(include.filter((file) => file === BROWSER_SPEC)).toHaveLength(1)
    expect(new Set(include)).toEqual(new Set(launcherFiles))
    expect(excludedFromNoDbRunner(BROWSER_SPEC)).toBe(true)
  })

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
    expect(excludedFromNoDbRunner(spec)).toBe(true)
  })
})
