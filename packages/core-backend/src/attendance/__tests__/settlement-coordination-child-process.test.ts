/**
 * Process-level properties that an in-process test cannot see (Codex S3-CX-01 / S3-CX-03): the child
 * runs real coordination code on fakes with nothing else keeping it alive.
 *  - A connection that reports an error between two statements must not take the process down: the
 *    port rejects and the process exits 0.
 *  - The CLI's default backoff keeps the process alive: the second attempt and the terminal outcome
 *    happen before exit, including the exhausted and the aborted case.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(__dirname, '../../../../..')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const CHILD = path.resolve(__dirname, '../../../tests/helpers/settlement-coordination-child.ts')

function run(scenario: string): { status: number | null; stdout: string; stderr: string } {
  expect(fs.existsSync(TSX_CLI)).toBe(true)
  const result = spawnSync(process.execPath, [TSX_CLI, CHILD, scenario], { encoding: 'utf8', timeout: 30_000 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('settlement coordination in a child process', () => {
  it('a connection error between two statements: the port rejects and the process exits 0 (no unhandled error event)', () => {
    const { status, stdout, stderr } = run('connection-error')
    expect({ status, stderr: stderr.includes("Unhandled 'error' event") }).toEqual({ status: 0, stderr: false })
    expect(stdout).toMatch(/^PORT_REJECTED .*not queryable/m)
  })

  it('CLI default backoff: the second attempt runs and commits before the process exits', () => {
    const { status, stdout } = run('cli-retry-succeeds')
    expect(status).toBe(0)
    expect(stdout).toMatch(/^FINISHED_OK committed \d+$/m)
  })

  it('CLI default backoff: when every attempt is refused the final refusal is reported before exit', () => {
    const { status, stdout } = run('cli-retry-exhausted')
    expect(status).toBe(0)
    expect(stdout).toMatch(/^FINISHED_ERROR ATTENDANCE_COORDINATION_CONNECTION_UNAVAILABLE \d+$/m)
  })

  it('CLI default backoff: an abort during the sleep ends it at once with the abort code', () => {
    const { status, stdout } = run('cli-retry-aborted')
    expect(status).toBe(0)
    const match = stdout.match(/^FINISHED_ERROR ATTENDANCE_COORDINATION_ABORTED (\d+)$/m)
    expect(match).not.toBeNull()
    expect(Number((match as RegExpMatchArray)[1])).toBeLessThan(2000)
  })
})
