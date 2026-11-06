/**
 * The real-PostgreSQL suite for the capability tables is excluded from the no-DB run and named whole in
 * the approval real-DB step of the plugin-tests workflow; the suite itself fails when it is asked to run
 * against a database and none is configured.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import config from '../../vitest.config'

const BACKEND = path.resolve(__dirname, '..', '..')
const ROOT = path.resolve(BACKEND, '..', '..')
const DB_SPEC = 'tests/integration/directory-integration-capabilities.db.test.ts'
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'plugin-tests.yml')

type Step = { id?: string; run?: string }

function approvalRealDbRun(): string {
  const doc = yaml.load(readFileSync(WORKFLOW, 'utf8')) as { jobs: Record<string, { steps: Step[] }> }
  const step = doc.jobs['approval-db'].steps.find((candidate) => candidate.id === 'approval-real-db-integration')
  if (!step?.run) throw new Error('approval real-DB step not found')
  return step.run
}

describe('real-DB suite wiring', () => {
  it('exists', () => {
    expect(existsSync(path.join(BACKEND, DB_SPEC))).toBe(true)
  })

  it('is excluded from the no-DB vitest run, exactly once', () => {
    const exclude = (config as { test?: { exclude?: string[] } }).test?.exclude ?? []
    expect(exclude.filter((entry) => entry === DB_SPEC)).toHaveLength(1)
  })

  it('is named whole, exactly once, in the approval real-DB step', () => {
    const run = approvalRealDbRun()
    expect(run.split(`  ${DB_SPEC} \\\n`).length - 1).toBe(1)
    expect(run.split(DB_SPEC).length - 1).toBe(1)
  })

  it('carries the sentinel that fails a database-expected run without a database', () => {
    const text = readFileSync(path.join(BACKEND, DB_SPEC), 'utf8')
    expect(text).toContain("process.env.EXPECT_DB === '1'")
    expect(text).toMatch(/sentinel[\s\S]*?expect\(process\.env\.DATABASE_URL\)\.toBeTruthy\(\)/)
  })
})
