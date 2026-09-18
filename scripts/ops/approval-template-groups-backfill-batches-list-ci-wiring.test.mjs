import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  REAL_DB_STEP_IDS,
  isSuiteWiredInRealDbStep,
  isQuotedInTestExclude,
  realDbStepWholeFileArgs,
} from './ci-realdb-step-contract.mjs'

// Approval form grouping — design lock v2.13 (RATIFIED 2026-09-18), phase 2 slice A-3 backfill,
// batch LIST unit (`listApprovalTemplateGroupBackfillBatches`,
// `src/services/ApprovalTemplateGroupService.ts`; design-gate P1-5 / changesRequired #5,
// `reviews/design-gate-A3-phase2-20260918.md`). CI two-point wiring contract (no DB): the list
// suite proves `created_at DESC` ordering + limit/offset pagination + org scoping + the
// `rolledBackAt` round trip against real Postgres — meaningless without a DB. It needs BOTH
// (1) the vitest.config.ts exclude entry (so the no-DB job cannot skip-green it) AND (2) the
// plugin-tests.yml directory real-DB whole-file step (so a real-DB run actually names it).
// Removing either point makes those proofs silently never execute while exact-head CI stays
// green. This source-level guard (no DB) reddens if either point is dropped. It runs in the no-DB
// `test` job, so it gates every PR. Same per-file dedicated-guard convention as the four sibling
// backfill suites' own guards (schema / preview / execute / rollback).
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/approval-template-groups-backfill-batches-list.db.test.ts'

// Located by the step's EXACT stable `id:` in plugin-tests.yml — never by its `- name:` title.
// Title-prefix anchoring was bypassable: an earlier decoy step whose name merely CONTAINS the
// same prefix would capture the guard while the real step was gutted. The shared helper also
// pins EXECUTABILITY of the located step (if 20.x + env.DATABASE_URL + vitest.integration.config.ts),
// so membership of the path in a step that can never run no longer passes.
const STEP_ID = REAL_DB_STEP_IDS.approval

test('vitest.config.ts excludes the A3 backfill-batches-list suite from the no-DB job', () => {
  const cfg = readFileSync(join(repoRoot, 'packages/core-backend/vitest.config.ts'), 'utf8')
  // Structural check (parses the direct test.exclude array, strips line comments before
  // matching), NOT `cfg.includes(...)` — a plain substring match stays green when the exclude
  // entry is commented out (the path text is still present in the file), which is exactly the
  // failure mode this guard exists to catch.
  assert.ok(
    isQuotedInTestExclude(cfg, FILE),
    `vitest.config.ts must exclude ${FILE} (DATABASE_URL-gated whole file) as a live (non-commented) entry`,
  )
})

test('plugin-tests.yml runs the A3 backfill-batches-list suite as a whole file in the directory real-DB step (id: approval-real-db-integration)', () => {
  const wf = readFileSync(join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  assert.ok(
    isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" (if 20.x + env.DATABASE_URL + `
      + `vitest.integration.config.ts) must run ${FILE} as a whole-file vitest arg`,
  )
  // Negative: must not be the sole (or any) placement under multitable real-DB.
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(FILE),
    false,
    `${FILE} must not be wired into the multitable real-DB step`,
  )
})

test('the A3 backfill-batches-list suite file exists on disk', () => {
  // Third point: both wiring texts can stay intact while the suite is renamed/deleted — vitest
  // exits 0 on an unmatched path argument, so CI stays green and the proof never runs.
  assert.ok(
    existsSync(join(repoRoot, 'packages/core-backend', FILE)),
    `wired suite packages/core-backend/${FILE} must exist on disk`,
  )
})
