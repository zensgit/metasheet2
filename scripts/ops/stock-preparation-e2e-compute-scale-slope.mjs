#!/usr/bin/env node
'use strict'

// Stock-preparation E2E functional smoke — R9 scale-leg slope aggregator.
//
// Before the R9 restructure, stock-preparation-e2e-functional-smoke.mjs ran the primary walk (3 rows),
// the mid-tier calibration walk and the rejection arm all in ONE process against ONE database, and fit a
// two-point slope (primary duration/row-count vs. mid-tier duration/row-count) in-process, because all
// three arms' S fields lived in the same module. They no longer can: migrations/073's
// uniq_integration_sealed_export_stock_prep_single_customer index allows AT MOST ONE ACTIVE sealed-export
// binding in the ENTIRE table (a RATIFIED, deliberately single-customer constraint — see the migration's
// own comment), and there is no retirement path, so each arm now runs in its OWN GitHub Actions job
// against its OWN ephemeral Postgres + SQL Server (functional-smoke / scale-midtier / scale-rejection —
// see .github/workflows/stock-preparation-e2e-functional-smoke.yml). Those jobs cannot share process
// state, so this script reassembles the slope from the JOB OUTPUTS they publish instead.
//
// Honesty discipline carried over from the main harness: any data point this script cannot obtain makes
// every figure that depends on it NOT_RUN, never a fabricated number. But NOT_RUN is also this script's
// correct answer at a DEFAULT dispatch (no scale requested, the scale jobs are skipped by workflow-level
// gates) — so a wiring bug that silently drops a real duration (wrong `needs[]` key, wrong summary.txt
// field name, a skipped extraction step) would ALSO read as an innocuous NOT_RUN unless this script
// separately checks its own plumbing. It does: a job that reports `success` MUST have published its timed
// duration, and a scale dispatch whose scale-midtier/scale-rejection job was skipped anyway is a gate
// malfunction — both are treated as this script's OWN failure (non-zero exit), distinct from and on top
// of whatever each arm's own job coloring already reports about that arm's S6-A outcome.
//
// Values-free: every field below is a fixed enum/token, a row count, or a millisecond duration — never a
// row payload.

import fs from 'node:fs'
import path from 'node:path'

const SUMMARY_HEADER = 'STOCK_PREPARATION_E2E_SCALE_SLOPE'
const OUT_DIR = process.env.E2E_OUT_DIR || path.join(process.cwd(), 'output/stock-preparation-e2e-scale-slope')

function readToken(name, fallback = 'NOT_RUN') {
  const raw = process.env[name]
  return raw === undefined || raw === '' ? fallback : raw
}

function readNumber(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '' || raw === 'NOT_RUN') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function readJobResult(name) {
  // needs.<job>.result is ALWAYS one of success/failure/cancelled/skipped for a job that is a dependency
  // (even a skipped one) — an empty value here means the workflow did not wire this env var at all, which
  // is itself a plumbing defect, not a legitimate "unknown" state.
  const raw = process.env[name]
  return raw === undefined || raw === '' ? '<UNWIRED>' : raw
}

const S = {}
const plumbingFailures = []

// ── raw per-arm evidence (always reported, regardless of whether the slope itself is computable) ───────
const primaryJobResult = readJobResult('PRIMARY_JOB_RESULT')
const midTierJobResult = readJobResult('MIDTIER_JOB_RESULT')
const rejectionJobResult = readJobResult('REJECTION_JOB_RESULT')

S.primaryJobResult = primaryJobResult
S.primaryRun = readToken('PRIMARY_RUN')
S.primaryRowCount = readToken('PRIMARY_ROW_COUNT')
S.primaryDurationMs = readToken('PRIMARY_DURATION_MS')
S.midTierJobResult = midTierJobResult
S.midTierRun = readToken('MIDTIER_RUN')
S.midTierRowCount = readToken('MIDTIER_ROW_COUNT')
S.midTierDurationMs = readToken('MIDTIER_DURATION_MS')
S.rejectionJobResult = rejectionJobResult
S.rejectionRun = readToken('REJECTION_RUN')
S.rejectionRowCount = readToken('REJECTION_ROW_COUNT')
S.rejectionDurationMs = readToken('REJECTION_DURATION_MS')

// ── plumbing self-check: a job that reports success must have published its timed evidence ─────────────
// A silent absence here would otherwise be indistinguishable from an honest NOT_RUN (see the header
// comment) — this is what makes the two distinguishable.
function checkDurationPublishedOnSuccess(label, jobResult, durationEnvName) {
  if (jobResult === 'success' && readNumber(durationEnvName) === null) {
    plumbingFailures.push(`${label}_DURATION_ABSENT_DESPITE_SUCCESS`)
  }
}
checkDurationPublishedOnSuccess('PRIMARY', primaryJobResult, 'PRIMARY_DURATION_MS')

// functional-smoke (the primary arm) runs on EVERY workflow_dispatch, scale requested or not — unlike the
// scale jobs, it is never expected to be skipped/cancelled.
if (primaryJobResult !== 'success' && primaryJobResult !== 'failure') {
  plumbingFailures.push('PRIMARY_JOB_DID_NOT_EXECUTE')
}

// scaleRequested is computed independently from the SAME raw input the two scale jobs' own workflow-level
// `if:` gates use (never inferred from job skip/run status, which would make this check circular).
const scaleRequestedInput = process.env.SCALE_REQUESTED_INPUT || ''
const scaleRequested = scaleRequestedInput !== '' && scaleRequestedInput !== '3'
S.scaleRequested = String(scaleRequested)

let slopeNotRunReason = null

if (!scaleRequested) {
  slopeNotRunReason = 'SCALE_NOT_REQUESTED'
  // The scale jobs' own gate should have skipped them entirely — if either instead ran (success or
  // failure), the gate did not do its job, which is a plumbing bug in the WORKFLOW, not an S6-A finding.
  if (midTierJobResult !== 'skipped') plumbingFailures.push('MIDTIER_JOB_RAN_BUT_SCALE_NOT_REQUESTED')
  if (rejectionJobResult !== 'skipped') plumbingFailures.push('REJECTION_JOB_RAN_BUT_SCALE_NOT_REQUESTED')
} else {
  checkDurationPublishedOnSuccess('MIDTIER', midTierJobResult, 'MIDTIER_DURATION_MS')
  checkDurationPublishedOnSuccess('REJECTION', rejectionJobResult, 'REJECTION_DURATION_MS')
  if (midTierJobResult === 'skipped') {
    plumbingFailures.push('MIDTIER_JOB_DID_NOT_RUN_DESPITE_SCALE_REQUESTED')
    slopeNotRunReason = 'MIDTIER_JOB_SKIPPED'
  }
  // Run 30889715065 is why this exists. The mid-tier arm FAILED (HTTP 503,
  // SEALED_EXPORT_INTERNAL_ERROR) after 2812ms, and this aggregator fitted a line straight through that
  // number: slope 0.972 ms/row, extrapolating 24999 rows to ~24.7s. That figure was meaningless — 2812ms
  // is how long the arm took to FAIL, not how long a successful walk of 2500 rows takes.
  //
  // The independent tell was already in the same run: the rejection arm really did walk 25000 rows in
  // 2560ms, an order of magnitude away from what the fit predicted for that row count. Two numbers from
  // one run contradicting each other is what a bad fit looks like.
  //
  // A missing data point was already refused. A data point from a FAILED run is not missing — it is
  // WRONG, which is worse, because it produces a confident number instead of a NOT_RUN. Both arms must
  // have PASSED before either is fitted.
  if (slopeNotRunReason === null && S.primaryRun !== 'PASS') {
    slopeNotRunReason = 'PRIMARY_RUN_NOT_PASS'
  }
  if (slopeNotRunReason === null && S.midTierRun !== 'PASS') {
    slopeNotRunReason = 'MIDTIER_RUN_NOT_PASS'
  }
  if (rejectionJobResult === 'skipped') {
    plumbingFailures.push('REJECTION_JOB_DID_NOT_RUN_DESPITE_SCALE_REQUESTED')
    // The rejection arm's own outcome is NOT part of the two-point slope fit (see below) — its being
    // skipped when it should not be is a plumbing failure worth flagging, but it does not by itself make
    // the slope NOT_RUN the way a skipped mid-tier job does.
  }
}

// ── the two-point fit itself (primary vs. mid-tier only — exactly what computeS6AScaleSlope() fit
// in-process before this restructure; the rejection arm was never one of the two fitted points) ─────────
const primaryMs = readNumber('PRIMARY_DURATION_MS')
const primaryN = readNumber('PRIMARY_ROW_COUNT')
const midTierMs = readNumber('MIDTIER_DURATION_MS')
const midTierN = readNumber('MIDTIER_ROW_COUNT')
const maxBusinessLines = readNumber('MAX_BUSINESS_LINES')

if (slopeNotRunReason === null) {
  if (primaryMs === null || primaryN === null) {
    slopeNotRunReason = 'PRIMARY_DURATION_ABSENT'
  } else if (midTierMs === null || midTierN === null) {
    slopeNotRunReason = 'MIDTIER_DURATION_ABSENT'
  } else if (midTierN === primaryN) {
    slopeNotRunReason = 'DEGENERATE_ROW_COUNTS'
  }
}

if (slopeNotRunReason !== null) {
  S.slopeNotRunReason = slopeNotRunReason
  S.s6aScaleSlopeMsPerRow = 'NOT_RUN'
  S.s6aScaleSlopeInterceptMs = 'NOT_RUN'
  S.s6aScalePredictedFullScaleMs = 'NOT_RUN'
  S.s6aScalePredictedAtRejectionRowCountMs = 'NOT_RUN'
} else {
  S.slopeNotRunReason = 'NOT_APPLICABLE'
  const slope = (midTierMs - primaryMs) / (midTierN - primaryN)
  const intercept = primaryMs - slope * primaryN
  S.s6aScaleSlopeMsPerRow = Number(slope.toFixed(3))
  S.s6aScaleSlopeInterceptMs = Number(intercept.toFixed(1))
  if (maxBusinessLines === null) {
    // MAX_BUSINESS_LINES is published unconditionally by the primary arm (see s6aBoundMaxBusinessLines in
    // stock-preparation-e2e-functional-smoke.mjs's main()) as soon as that process starts, regardless of
    // which phase it reaches — its absence here despite a computable slope is its own anomaly, reported
    // rather than silently defaulting to a guessed bound.
    S.s6aScalePredictedFullScaleMs = 'NOT_RUN'
    S.s6aScalePredictedAtRejectionRowCountMs = 'NOT_RUN'
    plumbingFailures.push('MAX_BUSINESS_LINES_ABSENT')
  } else {
    S.s6aScalePredictedFullScaleMs = Math.round(intercept + slope * maxBusinessLines)
    // One over the product's OWN declared bound — the SAME relationship
    // stock-preparation-e2e-functional-smoke.mjs's S6A_REJECTION_ROW_COUNT uses, never independently
    // invented here.
    S.s6aScalePredictedAtRejectionRowCountMs = Math.round(intercept + slope * (maxBusinessLines + 1))
  }
}

S.slopePlumbingCheck = plumbingFailures.length === 0 ? 'PASS' : 'FAIL'
if (plumbingFailures.length > 0) {
  S.slopePlumbingFailures = plumbingFailures.join('|')
}

const lines = [SUMMARY_HEADER]
for (const [key, value] of Object.entries(S)) lines.push(`${key}=${value}`)
const block = lines.join('\n')
process.stdout.write(`${block}\n`)
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), `${block}\n`)

// This job's own exit code is about ITS plumbing, never about whether an individual arm's S6-A walk
// passed or failed — that is already reflected in that arm's OWN job coloring (functional-smoke /
// scale-midtier / scale-rejection). A red arm with a legitimately-absent duration is not a plumbing bug.
process.exitCode = plumbingFailures.length > 0 ? 1 : 0
