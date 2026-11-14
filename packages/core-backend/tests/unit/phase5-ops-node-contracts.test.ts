import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '../../../..')
const nodeSuites = [
  'scripts/ops/phase5-snapshot-populate-contract.test.mjs',
  'scripts/ops/phase5-ci-run-contract.test.mjs',
]

interface WorkflowDoc {
  jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>
}

function runArtifactSummary(input: unknown, outcome: 'success' | 'failure' | 'cancelled') {
  const workflowPath = join(repoRoot, '.github/workflows/phase5-slo-validation.yml')
  const workflow = load(readFileSync(workflowPath, 'utf8')) as WorkflowDoc
  const script = workflow.jobs.validate.steps.find(
    (step) => step.name === 'Write values-free artifact summary',
  )?.run
  if (!script) throw new Error('Phase 5 artifact summary step is missing its run script')

  const dir = mkdtempSync(join(tmpdir(), 'phase5-summary-contract-'))
  const artifactDir = join(dir, 'artifacts')
  mkdirSync(artifactDir)
  if (input !== undefined) writeFileSync(join(artifactDir, 'phase5.json'), JSON.stringify(input))
  try {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PHASE5_ARTIFACT_DIR: artifactDir,
        PHASE5_RUNNER_OUTCOME: outcome,
      },
      timeout: 10_000,
    })
    if (result.error) throw result.error
    expect(result.status, result.stderr).toBe(0)
    return readFileSync(join(artifactDir, 'summary.json'), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Phase 5 ops Node contract suites in the required backend unit lane', () => {
  for (const suite of nodeSuites) {
    it(`${suite} runs at least one test and has no skips`, () => {
      const suitePath = join(repoRoot, suite)
      expect(existsSync(suitePath), `${suite} must exist`).toBe(true)

      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', suitePath], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180_000,
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      expect(result.error, output).toBeUndefined()
      expect(result.status, output).toBe(0)

      const tests = output.match(/^# tests (\d+)$/m)
      const skipped = output.match(/^# skipped (\d+)$/m)
      const todo = output.match(/^# todo (\d+)$/m)
      expect(tests, `${suite} must emit a TAP test count`).not.toBeNull()
      expect(Number(tests?.[1]), `${suite} must execute tests`).toBeGreaterThan(0)
      expect(skipped, `${suite} must emit a TAP skip count`).not.toBeNull()
      expect(Number(skipped?.[1]), `${suite} must not be skip-shaped green`).toBe(0)
      expect(todo, `${suite} must emit a TAP todo count`).not.toBeNull()
      expect(Number(todo?.[1]), `${suite} must not contain TODO tests`).toBe(0)
    }, 200_000)
  }

  it('projects only whitelisted values and binds PASS to report and runner success', () => {
    const input = {
      metrics_url: 'https://secret.example/private',
      authorityCode: 'never-export-this',
      summary: { overall_status: 'pass', passed: 5, failed: 0, na: 0 },
    }
    expect(JSON.parse(runArtifactSummary(input, 'success'))).toEqual({
      status: 'pass', runner_outcome: 'success', passed: 5, failed: 0, na: 0,
    })
    const failedRunner = runArtifactSummary(input, 'failure')
    expect(JSON.parse(failedRunner)).toEqual({
      status: 'fail', runner_outcome: 'failure', passed: 5, failed: 0, na: 0,
    })
    expect(failedRunner).not.toContain('secret.example')
    expect(failedRunner).not.toContain('never-export-this')
  })

  it('reports unavailable for missing, unknown, or malformed summaries', () => {
    for (const input of [
      undefined,
      { summary: { overall_status: 'unknown', passed: 1, failed: 0, na: 0 } },
      { summary: { overall_status: 'pass', passed: -1, failed: 0, na: 0 } },
    ]) {
      expect(JSON.parse(runArtifactSummary(input, 'failure'))).toEqual({
        status: 'unavailable', runner_outcome: 'failure',
      })
    }
  })
})
