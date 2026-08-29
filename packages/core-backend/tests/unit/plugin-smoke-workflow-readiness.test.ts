import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

function workflowStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}`
  const start = workflow.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)

  const end = workflow.indexOf('\n      - name:', start + marker.length)
  return workflow.slice(start, end === -1 ? workflow.length : end)
}

describe('plugin smoke workflow readiness', () => {
  const workflow = readFileSync(
    join(repoRoot, '.github/workflows/plugin-tests.yml'),
    'utf8',
  )

  test('waits for a live backend with a bounded fail-loud probe', () => {
    const startStep = workflowStep(workflow, 'Start core backend (background)')

    expect(startStep).toContain('HOST: 127.0.0.1')
    expect(startStep).toContain('for attempt in $(seq 1 60); do')
    expect(startStep).toContain('curl -fsS http://127.0.0.1:8900/health')
    expect(startStep).toContain('kill -0 "${server_pid}"')
    expect(startStep).toContain('cat server.log')
    expect(startStep).toContain('exit 1')
    expect(startStep).not.toContain('sleep 5')
  })

  test('uses the same explicit IPv4 origin for smoke and diagnostic probes', () => {
    const smokeStep = workflowStep(workflow, 'Run plugin smoke test')
    const snapshotStep = workflowStep(
      workflow,
      'Config snapshot (non-blocking)',
    )
    const adminStep = workflowStep(workflow, 'Admin KV list (non-blocking)')

    expect(smokeStep).toContain('API_ORIGIN: http://127.0.0.1:8900')
    expect(snapshotStep).toContain(
      'curl -sf http://127.0.0.1:8900/metrics/config',
    )
    expect(adminStep).toContain('API_ORIGIN: http://127.0.0.1:8900')
    expect(`${smokeStep}\n${snapshotStep}\n${adminStep}`).not.toContain(
      'localhost:8900',
    )
  })
})
