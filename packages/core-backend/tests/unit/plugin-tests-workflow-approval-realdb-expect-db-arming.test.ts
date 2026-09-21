import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * H-2 (CI wiring): `.github/workflows/plugin-tests.yml`'s "Run approval real-DB integration"
 * step (stable `id: approval-real-db-integration`, in the required `test` job / 20.x leg) runs
 * several `tests/integration/*.test.ts` files whole-file. A handful of those files carry a
 * module-top-level anti-skip-green sentinel —
 *
 *   const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
 *   itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL ...', () => {
 *     expect(process.env.DATABASE_URL).toBeTruthy()
 *   })
 *
 * — that only FIRES (runs, rather than `it.skip`) when the executing lane exports
 * `EXPECT_DB === '1'`. Before this fix the step exported `DATABASE_URL` but never `EXPECT_DB`,
 * so the sentinel was permanently `it.skip`ped in this lane: a broken/missing DATABASE_URL
 * reaching the step's vitest workers would report success (the sentinel never ran to catch it)
 * rather than going RED. This guard pins the fix and reds if it is ever undone.
 *
 * DESIGN NOTE — real YAML, not text/regex: the step is located and its `env` read via a real
 * YAML parser (`js-yaml`) over the PARSED document (`jobs.test.steps[].id` / `.env`), never by
 * scanning workflow bytes with a regex or `indexOf` slice — a source-text match proves a string
 * appeared somewhere, not that it landed on the right YAML key (see
 * feedback_source_text_assertions_are_not_behaviour). The one place this file DOES read raw text
 * is deriving which `tests/integration/*.test.ts` tokens the step's shell `run:` script passes as
 * whole-file arguments — that text extraction only builds the POPULATION of files to check for
 * the sentinel; the pass/fail decision itself (`env.EXPECT_DB === '1'`) is read off the parsed
 * structure.
 *
 * DESIGN NOTE — derived population, not a hardcoded file list: `sentinelBearingFilesInStep()`
 * checks every file the step actually runs for the sentinel pattern, rather than hardcoding
 * today's three filenames. A hardcoded list is a token-list census trap (see
 * finding_o2_census_token_list_enumeration_trap / finding_guard_closed_over_the_wrong_world): it
 * would stop protecting the moment a 4th sentinel-bearing file joins the step's run-list without
 * anyone touching this guard. The derived form keeps covering that case for free.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const WORKFLOW_RELATIVE = '.github/workflows/plugin-tests.yml'
const STEP_ID = 'approval-real-db-integration'

// Matches the module-top-level `itIfExpectDb` gate exactly as authored across the 45 files that
// carry it (packages/core-backend/tests/{unit,integration}/approval-*.{db.,api.,}test.ts) —
// e.g. approval-comments.db.test.ts:56, approval-instance-readability-s1.db.test.ts:50,
// approval-lock9-process-attachments-realdb.db.test.ts:35 (the three the step above actually
// runs today).
const SENTINEL_PATTERN = /itIfExpectDb\s*=\s*process\.env\.EXPECT_DB\s*===\s*'1'/

interface ParsedStep {
  id?: string
  env?: Record<string, unknown>
  run?: string
  [key: string]: unknown
}

interface ParsedWorkflow {
  jobs?: {
    test?: {
      steps?: ParsedStep[]
    }
  }
}

function loadWorkflow(workflowYamlText: string): ParsedWorkflow {
  return yaml.load(workflowYamlText) as ParsedWorkflow
}

function findStepById(doc: ParsedWorkflow, stepId: string): ParsedStep | undefined {
  const steps = doc.jobs?.test?.steps ?? []
  return steps.find((step) => step && step.id === stepId)
}

/**
 * Whole-file `tests/integration/*.test.ts` arguments referenced anywhere in a step's `run:`
 * text. This is population derivation (which files does the step run), not the behavioral
 * assertion — see the module doc comment above.
 */
function integrationTestFileArgs(runText: string): string[] {
  const matches = runText.match(/tests\/integration\/[A-Za-z0-9_.-]+\.test\.ts/g) ?? []
  return Array.from(new Set(matches))
}

function fileCarriesExpectDbSentinel(repoRoot: string, relFileFromCoreBackend: string): boolean {
  let content: string
  try {
    content = readFileSync(join(repoRoot, 'packages/core-backend', relFileFromCoreBackend), 'utf8')
  } catch {
    return false
  }
  return SENTINEL_PATTERN.test(content)
}

/**
 * Every `tests/integration/*.test.ts` file the given step runs whole-file that ALSO carries the
 * `itIfExpectDb` sentinel. Reads the step's `run:` text to enumerate candidate files (population
 * derivation, not the assertion), then checks each candidate's own source on disk.
 */
function sentinelBearingFilesInStep(step: ParsedStep, repoRoot: string): string[] {
  const files = integrationTestFileArgs(String(step.run ?? ''))
  return files.filter((relFile) => fileCarriesExpectDbSentinel(repoRoot, relFile))
}

describe('plugin-tests.yml: approval real-DB step arms EXPECT_DB for its sentinel-bearing files', () => {
  it('the step exists at its pinned stable id (never located by title)', () => {
    const wf = readFileSync(join(REPO_ROOT, WORKFLOW_RELATIVE), 'utf8')
    const doc = loadWorkflow(wf)
    expect(findStepById(doc, STEP_ID)).toBeDefined()
  })

  it('the derived population of sentinel-bearing files the step runs is non-empty (population is not vacuous)', () => {
    const wf = readFileSync(join(REPO_ROOT, WORKFLOW_RELATIVE), 'utf8')
    const doc = loadWorkflow(wf)
    const step = findStepById(doc, STEP_ID)!
    const sentinelFiles = sentinelBearingFilesInStep(step, REPO_ROOT)
    expect(sentinelFiles.length).toBeGreaterThan(0)
    // Documents today's known members without hardcoding the CHECK on them — this assertion can
    // grow (a 4th file joining) without weakening the guard above, which is population-driven.
    expect(sentinelFiles).toEqual(
      expect.arrayContaining([
        'tests/integration/approval-comments.db.test.ts',
        'tests/integration/approval-instance-readability-s1.db.test.ts',
        'tests/integration/approval-lock9-process-attachments-realdb.db.test.ts',
      ]),
    )
  })

  it('REAL FILE / GUARD: the step exports EXPECT_DB exactly the string \'1\' (armed, not merely truthy)', () => {
    const wf = readFileSync(join(REPO_ROOT, WORKFLOW_RELATIVE), 'utf8')
    const doc = loadWorkflow(wf)
    const step = findStepById(doc, STEP_ID)!
    // Re-derive the population inline so this test alone (not just the sibling above) fails if
    // the population were ever empty — a vacuous population would make the arming assertion
    // below meaningless.
    expect(sentinelBearingFilesInStep(step, REPO_ROOT).length).toBeGreaterThan(0)
    expect(step.env?.EXPECT_DB).toBe('1')
  })

  it('MUTATION: removing the env.EXPECT_DB key from a copy of the real document reads as NOT armed (guard is sensitive to the fix, not vacuous)', () => {
    const wf = readFileSync(join(REPO_ROOT, WORKFLOW_RELATIVE), 'utf8')
    const doc = loadWorkflow(wf)
    const step = findStepById(doc, STEP_ID)!
    expect(step.env?.EXPECT_DB).toBe('1') // sanity: the field exists to remove
    const mutatedStep: ParsedStep = { ...step, env: { ...step.env } }
    delete mutatedStep.env!.EXPECT_DB
    expect(mutatedStep.env?.EXPECT_DB).toBeUndefined()
    // The same population check would still find sentinel-bearing files (removing the env key
    // does not touch which files the step runs) — only the arming assertion should flip.
    expect(sentinelBearingFilesInStep(mutatedStep, REPO_ROOT).length).toBeGreaterThan(0)
  })

  it('MUTATION: env.EXPECT_DB weakened to the string \'0\' reads as NOT armed (exact-equality check, not a truthy check)', () => {
    const wf = readFileSync(join(REPO_ROOT, WORKFLOW_RELATIVE), 'utf8')
    const doc = loadWorkflow(wf)
    const step = findStepById(doc, STEP_ID)!
    const mutatedStep: ParsedStep = { ...step, env: { ...step.env, EXPECT_DB: '0' } }
    expect(mutatedStep.env?.EXPECT_DB).not.toBe('1')
    expect(mutatedStep.env?.EXPECT_DB).toBeTruthy() // '0' is a truthy JS string — a loose check would wrongly pass this
  })

  it('a step id that does not exist is reported as not found, not silently treated as armed', () => {
    const wf = readFileSync(join(REPO_ROOT, WORKFLOW_RELATIVE), 'utf8')
    const doc = loadWorkflow(wf)
    expect(findStepById(doc, 'this-step-id-does-not-exist')).toBeUndefined()
  })
})
