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

test('multitable pilot staging delegates to pilot-local with running-services-only flags', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-pilot-staging-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const envLogPath = path.join(tmpRoot, 'pilot-local-env.log')

  writeExecutable(
    path.join(binDir, 'bash'),
    [
      '#!/bin/bash',
      'set -euo pipefail',
      'if [[ "${1:-}" == "scripts/ops/multitable-pilot-local.sh" ]]; then',
      '  {',
      '    printf "RUN_LABEL=%s\\n" "${RUN_LABEL:-}"',
      '    printf "OUTPUT_ROOT=%s\\n" "${OUTPUT_ROOT:-}"',
      '    printf "API_BASE=%s\\n" "${API_BASE:-}"',
      '    printf "WEB_BASE=%s\\n" "${WEB_BASE:-}"',
      '    printf "RUN_MODE=%s\\n" "${RUN_MODE:-}"',
      '    printf "RUNNER_REPORT_BASENAME=%s\\n" "${RUNNER_REPORT_BASENAME:-}"',
      '    printf "AUTO_START_SERVICES=%s\\n" "${AUTO_START_SERVICES:-}"',
      '    printf "REQUIRE_RUNNING_SERVICES=%s\\n" "${REQUIRE_RUNNING_SERVICES:-}"',
      '    printf "ENSURE_PLAYWRIGHT=%s\\n" "${ENSURE_PLAYWRIGHT:-}"',
      '  } > "${FAKE_STAGE_ENV_LOG}"',
      '  exit 0',
      'fi',
      'exec /bin/bash "$@"',
      '',
    ].join('\n'),
  )

  execFileSync('bash', ['scripts/ops/multitable-pilot-staging.sh'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FAKE_STAGE_ENV_LOG: envLogPath,
      RUN_LABEL: 'multitable-pilot-staging-test',
      OUTPUT_ROOT: '/tmp/multitable-pilot-staging-output',
      API_BASE: 'https://pilot.example.test/api',
      WEB_BASE: 'https://pilot.example.test/app',
      ENSURE_PLAYWRIGHT: 'false',
    },
    stdio: 'pipe',
  })

  const log = fs.readFileSync(envLogPath, 'utf8')
  assert.match(log, /RUN_LABEL=multitable-pilot-staging-test/)
  assert.match(log, /OUTPUT_ROOT=\/tmp\/multitable-pilot-staging-output/)
  assert.match(log, /API_BASE=https:\/\/pilot\.example\.test\/api/)
  assert.match(log, /WEB_BASE=https:\/\/pilot\.example\.test\/app/)
  assert.match(log, /RUN_MODE=staging/)
  assert.match(log, /RUNNER_REPORT_BASENAME=staging-report/)
  assert.match(log, /AUTO_START_SERVICES=false/)
  assert.match(log, /REQUIRE_RUNNING_SERVICES=true/)
  assert.match(log, /ENSURE_PLAYWRIGHT=false/)
})
