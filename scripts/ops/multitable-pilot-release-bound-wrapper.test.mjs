import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 })
}

test('multitable pilot ready release-bound dispatches to staging-ready when RUN_MODE=staging', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-ready-release-bound-staging-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const envLogPath = path.join(tmpRoot, 'ready-env.log')
  const gateReportPath = path.join(tmpRoot, 'gate', 'report.json')
  fs.mkdirSync(path.dirname(gateReportPath), { recursive: true })
  fs.writeFileSync(gateReportPath, JSON.stringify({ ok: true }, null, 2))

  writeExecutable(
    path.join(binDir, 'bash'),
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "scripts/ops/multitable-pilot-ready-staging.sh" ]]; then',
      '  {',
      '    printf "SCRIPT=%s\\n" "${1:-}"',
      '    printf "REQUIRE_ONPREM_GATE=%s\\n" "${REQUIRE_ONPREM_GATE:-}"',
      '    printf "REQUIRE_EXPLICIT_ONPREM_GATE=%s\\n" "${REQUIRE_EXPLICIT_ONPREM_GATE:-}"',
      '    printf "ONPREM_GATE_REPORT_JSON=%s\\n" "${ONPREM_GATE_REPORT_JSON:-}"',
      '  } > "${FAKE_READY_ENV_LOG}"',
      '  exit 0',
      'fi',
      'exec /bin/bash "$@"',
      '',
    ].join('\n'),
  )

  execFileSync('bash', ['scripts/ops/multitable-pilot-ready-release-bound.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_READY_ENV_LOG: envLogPath,
      RUN_MODE: 'staging',
      ONPREM_GATE_REPORT_JSON: gateReportPath,
    },
    stdio: 'pipe',
  })

  const log = fs.readFileSync(envLogPath, 'utf8')
  assert.match(log, /SCRIPT=scripts\/ops\/multitable-pilot-ready-staging\.sh/)
  assert.match(log, /REQUIRE_ONPREM_GATE=true/)
  assert.match(log, /REQUIRE_EXPLICIT_ONPREM_GATE=true/)
  assert.match(log, new RegExp(`ONPREM_GATE_REPORT_JSON=${gateReportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('multitable pilot handoff release-bound forwards staging run mode to handoff', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-handoff-release-bound-staging-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const envLogPath = path.join(tmpRoot, 'handoff-env.log')
  const gateReportPath = path.join(tmpRoot, 'gate', 'report.json')
  const readinessRoot = path.join(tmpRoot, 'readiness-root')
  fs.mkdirSync(path.dirname(gateReportPath), { recursive: true })
  fs.writeFileSync(gateReportPath, JSON.stringify({ ok: true }, null, 2))

  writeExecutable(
    path.join(binDir, 'node'),
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "scripts/ops/multitable-pilot-handoff.mjs" ]]; then',
      '  {',
      '    printf "PILOT_RUN_MODE=%s\\n" "${PILOT_RUN_MODE:-}"',
      '    printf "REQUIRE_ONPREM_GATE=%s\\n" "${REQUIRE_ONPREM_GATE:-}"',
      '    printf "REQUIRE_EXPLICIT_ONPREM_GATE=%s\\n" "${REQUIRE_EXPLICIT_ONPREM_GATE:-}"',
      '    printf "ONPREM_GATE_REPORT_JSON=%s\\n" "${ONPREM_GATE_REPORT_JSON:-}"',
      '    printf "READINESS_ROOT=%s\\n" "${READINESS_ROOT:-}"',
      '  } > "${FAKE_HANDOFF_ENV_LOG}"',
      '  exit 0',
      'fi',
      'exec /usr/bin/env node "$@"',
      '',
    ].join('\n'),
  )

  execFileSync('bash', ['scripts/ops/multitable-pilot-handoff-release-bound.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_HANDOFF_ENV_LOG: envLogPath,
      RUN_MODE: 'staging',
      ONPREM_GATE_REPORT_JSON: gateReportPath,
      READINESS_ROOT: readinessRoot,
    },
    stdio: 'pipe',
  })

  const log = fs.readFileSync(envLogPath, 'utf8')
  assert.match(log, /PILOT_RUN_MODE=staging/)
  assert.match(log, /REQUIRE_ONPREM_GATE=true/)
  assert.match(log, /REQUIRE_EXPLICIT_ONPREM_GATE=true/)
  assert.match(log, new RegExp(`ONPREM_GATE_REPORT_JSON=${gateReportPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.match(log, new RegExp(`READINESS_ROOT=${readinessRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})
