import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const workflowPath = resolve(process.cwd(), '../../.github/workflows/attendance-web-guard.yml')
const workflow = readFileSync(workflowPath, 'utf8')

describe('attendance web guard workflow contract', () => {
  it('creates one stable check for every pull request', () => {
    const pullRequestStart = workflow.indexOf('\n  pull_request:')
    const pushStart = workflow.indexOf('\n  push:', pullRequestStart)
    expect(pullRequestStart).toBeGreaterThan(-1)
    expect(pushStart).toBeGreaterThan(pullRequestStart)
    expect(workflow.slice(pullRequestStart, pushStart)).toBe('\n  pull_request:')
    expect(workflow).toContain('name: Report success for unrelated changes')
    expect(workflow).toContain("if: steps.changes.outputs.relevant == 'false'")
  })

  it('keeps this contract spec in the classifier and targeted run list', () => {
    expect(workflow.match(/apps\/web\/tests\/attendance-web-guard-workflow\.spec\.ts/g)).toHaveLength(2)
    expect(workflow).toContain(' attendance-web-guard-workflow.spec --reporter=dot')
    expect(workflow).toContain("if: steps.changes.outputs.relevant == 'true'")
  })
})
