/**
 * Phase 3 release-gate email:real-send bridge.
 *
 * Binds the existing `verify:multitable-email:real-send` package script
 * (which itself runs `tsx scripts/ops/multitable-email-real-send-smoke.ts`)
 * into the Phase 3 release-gate aggregator as the `email:real-send`
 * sub-gate.
 *
 * Hard constraints from PR R3 design review:
 *
 * 1. Bridge spawns `pnpm verify:multitable-email:real-send`, never
 *    `tsx scripts/ops/...` directly. This routes through the existing
 *    package script, so aggregator does not drift when the email
 *    script path or executor changes.
 *
 * 2. Bridge injects independent output paths via EMAIL_REAL_SEND_JSON
 *    and EMAIL_REAL_SEND_MD env vars so the child report goes to
 *    `<phase3-output>/children/email-real-send/report.{json,md}`,
 *    never the default `output/multitable-email-real-send-smoke/`
 *    location. Eliminates stale-report and concurrent-overwrite
 *    risks.
 *
 * 3. Fail-closed status translation. Only two source-state shapes
 *    map to non-fail outcomes:
 *      - exit=0 AND status=pass AND ok=true        → pass (exit 0)
 *      - exit=2 AND status=blocked                  → blocked (exit 2)
 *    Every other shape — including missing report, parse failure,
 *    exit/status mismatch, spawn error, signal-kill — maps to fail
 *    (exit 1). sourceExitCode, sourceStatus, sourceReportPath are
 *    preserved in the bridge result. stdout / stderr appear only as
 *    redacted 1200-char samples, never as raw streams.
 *
 * 4. All sample text and structured fields run through the Phase 3
 *    redactor before surfacing into the bridge result.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { redactString } from './multitable-phase3-release-gate-redact.mjs'

export const EMAIL_SUB_GATE_ID = 'email:real-send'

const SAMPLE_MAX_LENGTH = 1200
const SPAWN_MAX_BUFFER = 20 * 1024 * 1024

/**
 * Default runScript implementation. Always spawns `pnpm <script>`,
 * never `tsx` directly.
 */
export function defaultRunScript({ jsonPath, mdPath, env }) {
  return spawnSync('pnpm', ['verify:multitable-email:real-send'], {
    cwd: process.cwd(),
    env: {
      ...env,
      EMAIL_REAL_SEND_JSON: jsonPath,
      EMAIL_REAL_SEND_MD: mdPath,
    },
    encoding: 'utf8',
    maxBuffer: SPAWN_MAX_BUFFER,
  })
}

function compactSample(value) {
  const redacted = redactString(value ?? '')
  if (!redacted) return ''
  return redacted.length > SAMPLE_MAX_LENGTH
    ? `${redacted.slice(0, SAMPLE_MAX_LENGTH - 3)}...`
    : redacted
}

function readSourceReport(jsonPath) {
  if (!existsSync(jsonPath)) return { ok: false, report: null, parseError: null }
  try {
    const raw = readFileSync(jsonPath, 'utf8')
    return { ok: true, report: JSON.parse(raw), parseError: null }
  } catch (err) {
    return {
      ok: false,
      report: null,
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

function buildBridgeResult({
  gateLabel,
  status,
  exitCode,
  reason,
  startedAt,
  sourceExitCode,
  sourceStatus,
  sourceReportPath,
  stdoutSample,
  stderrSample,
}) {
  return {
    tool: 'multitable-phase3-release-gate',
    gate: gateLabel,
    status,
    exitCode,
    reason,
    startedAt,
    completedAt: new Date().toISOString(),
    sourceExitCode,
    sourceStatus,
    sourceReportPath,
    stdoutSample,
    stderrSample,
  }
}

/**
 * Run the email real-send sub-gate. `runScript` is injectable for
 * tests; in production it defaults to `defaultRunScript` which
 * spawns `pnpm verify:multitable-email:real-send`.
 */
export function runEmailRealSendSubGate({
  outputDir,
  env = process.env,
  runScript = defaultRunScript,
}) {
  if (!outputDir) {
    throw new Error('runEmailRealSendSubGate: outputDir is required')
  }
  const startedAt = new Date().toISOString()
  const childDir = path.resolve(outputDir, 'children/email-real-send')
  const jsonPath = path.join(childDir, 'report.json')
  const mdPath = path.join(childDir, 'report.md')
  mkdirSync(childDir, { recursive: true })

  const failClosed = (reason, partial = {}) =>
    buildBridgeResult({
      gateLabel: EMAIL_SUB_GATE_ID,
      status: 'fail',
      exitCode: 1,
      reason,
      startedAt,
      sourceExitCode: partial.sourceExitCode ?? null,
      sourceStatus: partial.sourceStatus ?? null,
      sourceReportPath: jsonPath,
      stdoutSample: partial.stdoutSample ?? '',
      stderrSample: partial.stderrSample ?? '',
    })

  let result
  try {
    result = runScript({ jsonPath, mdPath, env })
  } catch (err) {
    return failClosed('Spawn error before email script could run.', {
      stderrSample: compactSample(err instanceof Error ? err.message : String(err)),
    })
  }

  if (result && result.error) {
    return failClosed(
      `Spawn returned an error: ${redactString(
        result.error instanceof Error ? result.error.message : String(result.error),
      )}`,
      {
        stdoutSample: compactSample(result.stdout),
        stderrSample: compactSample(result.stderr || (result.error?.message ?? '')),
        sourceExitCode: result.status ?? null,
      },
    )
  }

  const sourceExitCode = result?.status
  const stdoutSample = compactSample(result?.stdout)
  const stderrSample = compactSample(result?.stderr)

  if (sourceExitCode === null || sourceExitCode === undefined) {
    return failClosed(
      'Email script exit code was null (killed by signal or spawn aborted).',
      { stdoutSample, stderrSample },
    )
  }

  const { ok: parseOk, report: sourceReport, parseError } = readSourceReport(jsonPath)

  if (!parseOk || !sourceReport) {
    const why = parseError
      ? `Email script report.json failed to parse: ${redactString(parseError)}`
      : `Email script did not write a report.json at ${jsonPath}.`
    return failClosed(why, {
      sourceExitCode,
      stdoutSample,
      stderrSample,
    })
  }

  const sourceStatus = sourceReport.status ?? null
  const sourceOk = sourceReport.ok

  const passConsistent =
    sourceExitCode === 0 && sourceStatus === 'pass' && sourceOk === true
  const blockedConsistent = sourceExitCode === 2 && sourceStatus === 'blocked'

  if (passConsistent) {
    return buildBridgeResult({
      gateLabel: EMAIL_SUB_GATE_ID,
      status: 'pass',
      exitCode: 0,
      reason: 'Email real-send smoke passed (exit=0, status=pass, ok=true).',
      startedAt,
      sourceExitCode,
      sourceStatus,
      sourceReportPath: jsonPath,
      stdoutSample,
      stderrSample,
    })
  }
  if (blockedConsistent) {
    return buildBridgeResult({
      gateLabel: EMAIL_SUB_GATE_ID,
      status: 'blocked',
      exitCode: 2,
      reason:
        'Email real-send smoke blocked (exit=2, status=blocked). Missing required env: MULTITABLE_EMAIL_TRANSPORT=smtp, MULTITABLE_EMAIL_REAL_SEND_SMOKE=1, CONFIRM_SEND_EMAIL=1, MULTITABLE_EMAIL_SMOKE_TO.',
      startedAt,
      sourceExitCode,
      sourceStatus,
      sourceReportPath: jsonPath,
      stdoutSample,
      stderrSample,
    })
  }

  return failClosed(
    `Fail-closed: source signals did not match pass or blocked contracts. exit=${sourceExitCode} status=${sourceStatus} ok=${sourceOk}.`,
    {
      sourceExitCode,
      sourceStatus,
      stdoutSample,
      stderrSample,
    },
  )
}
