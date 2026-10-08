import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const suite = 'tests/integration/multitable-recovery-archive-key-registry-realdb.test.ts'

function occurrences(source: string, value: string): number {
  return source.split(value).length - 1
}

describe('Time Machine D2 key-registry real-DB CI wiring', () => {
  test('keeps the suite out of the no-DB lane and in the executable multitable real-DB step', () => {
    const vitestConfig = readFileSync(
      join(repoRoot, 'packages/core-backend/vitest.config.ts'),
      'utf8',
    )
    expect(occurrences(vitestConfig, `'${suite}'`)).toBe(1)

    const workflow = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
    const stepId = '        id: multitable-real-db-integration'
    const stepIdOffset = workflow.indexOf(stepId)
    expect(stepIdOffset).toBeGreaterThanOrEqual(0)
    const stepEnd = workflow.indexOf('\n      - name:', stepIdOffset)
    expect(stepEnd).toBeGreaterThan(stepIdOffset)
    const step = workflow.slice(stepIdOffset, stepEnd)

    expect(step).toContain("if: matrix.node-version == '20.x'")
    expect(step).toContain("METASHEET_REAL_DB_TEST_STEP: '1'")
    expect(step).toContain('vitest --config vitest.integration.config.ts run')
    expect(occurrences(step, suite)).toBe(1)
  })

  test('the wired suite exists', () => {
    expect(existsSync(join(repoRoot, 'packages/core-backend', suite))).toBe(true)
  })
})
