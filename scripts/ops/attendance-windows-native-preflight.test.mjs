import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8')
}

test('Windows native preflight and common helpers fail closed on SHA, isolation, and externals', () => {
  const common = read('scripts/ops/attendance-windows-native-common.ps1')
  const preflight = read('scripts/ops/attendance-windows-native-preflight.ps1')
  const pin = JSON.parse(read('scripts/ops/attendance-windows-native-qa-v2.pin.json'))
  const matrix = JSON.parse(read('scripts/ops/attendance-windows-native-qa-risk-matrix.json'))

  assert.equal(pin.expectedSourceSha, '676ed2433813139216d77685021a5b5c1acdb235')
  assert.equal(pin.deploymentAuthorized, false)
  assert.equal(pin.status, 'DRAFT_HOLD')
  assert.equal(matrix.expectedSourceSha, pin.expectedSourceSha)
  assert.equal(matrix.cases.length, 10)
  assert.ok(matrix.cases.some((item) => item.id === 'PQA-10'))

  assert.match(common, /function Assert-WindowsNativeExactSourceSha/)
  assert.match(common, /Exact source SHA mismatch/)
  assert.match(common, /deploymentAuthorized=false/)
  assert.match(preflight, /Assert-WindowsNativeExactSourceSha/)
  assert.match(preflight, /metasheet_windows_qa/)
  assert.match(preflight, /Attendance opt-in is forbidden/)
  assert.match(preflight, /External integration configuration is forbidden/)
  assert.match(preflight, /External delivery configuration is forbidden/)
  assert.match(preflight, /Assert-WindowsNativeLoopbackHost/)
  assert.match(preflight, /Draft\/HOLD internal synthetic QA only/)
})

test('Windows native lifecycle scripts keep PowerShell 5.1-safe PM2 handling and no WSL', () => {
  const files = [
    'scripts/ops/attendance-windows-native-common.ps1',
    'scripts/ops/attendance-windows-native-preflight.ps1',
    'scripts/ops/attendance-windows-native-start.ps1',
    'scripts/ops/attendance-windows-native-stop.ps1',
    'scripts/ops/attendance-windows-native-healthcheck.ps1',
    'scripts/ops/attendance-windows-native-bootstrap-admin.ps1',
    'scripts/ops/attendance-onprem-start-pm2.ps1',
  ]
  for (const rel of files) {
    const text = read(rel)
    assert.doesNotMatch(text, /wsl\.exe|wsl\s+-/i, rel)
  }

  const start = read('scripts/ops/attendance-windows-native-start.ps1')
  assert.match(start, /Remove-WindowsNativePm2Apps/)
  assert.match(start, /Run windows-native-stop\.bat before starting again/)
  assert.match(start, /\$ErrorActionPreference = 'Continue'/)

  const stop = read('scripts/ops/attendance-windows-native-stop.ps1')
  assert.match(stop, /\$ErrorActionPreference = 'Continue'/)

  const startPm2 = read('scripts/ops/attendance-onprem-start-pm2.ps1')
  assert.match(startPm2, /Get-Command 'pm2\.cmd'/)
  assert.match(startPm2, /Windows PowerShell 5\.1 converts native stderr/)
})

test('package build and verify pin exact source SHA and Windows native assets', () => {
  const build = read('scripts/ops/attendance-onprem-package-build.sh')
  const verify = read('scripts/ops/attendance-onprem-package-verify.sh')
  const workflow = read('.github/workflows/attendance-onprem-package-build.yml')
  const envExample = read('docker/app.env.attendance-windows-native.qa.example')
  const ecosystem = read('ecosystem.windows-native.config.cjs')

  assert.match(build, /SOURCE_SHA/)
  assert.match(build, /sourceSha/)
  assert.match(build, /QA_TOOLING_SHA/)
  assert.match(build, /qaToolingSha/)
  assert.match(build, /WINDOWS_NATIVE_QA_V2/)
  assert.match(build, /DRAFT_HOLD/)
  assert.match(build, /windows-native-start\.bat/)
  assert.match(build, /attendance-windows-native-qa-v2\.pin\.json/)
  assert.match(build, /attendance-windows-native-qa-runner\.mjs/)
  assert.match(build, /packages\/mssql-readonly-utils/)

  assert.match(verify, /verify_exact_source_sha/)
  assert.match(verify, /Exact source SHA mismatch/)
  assert.match(verify, /manifest\.qaToolingSha mismatch/)
  assert.match(verify, /verify_windows_native_gateway/)
  assert.match(verify, /verify_workspace_runtime_dependencies/)
  assert.match(verify, /metasheet_windows_qa/)
  assert.match(verify, /PQA-10/)

  assert.match(workflow, /Verify Windows QA product source pin/)
  assert.match(workflow, /git diff --quiet "\$pin_sha" "\$\{GITHUB_SHA\}"/)
  assert.match(workflow, /Product runtime differs from the pinned Windows QA source SHA/)
  assert.match(workflow, /Reject release publication for Draft\/HOLD QA/)
  assert.match(
    workflow,
    /inputs\.run_windows_native_qa_v2 != true && inputs\.publish_release == 'true'/,
  )

  assert.match(envExample, /POSTGRES_DB=metasheet_windows_qa/)
  assert.match(envExample, /WINDOWS_NATIVE_GATEWAY_HOST=127\.0\.0\.1/)
  assert.match(ecosystem, /metasheet-windows-gateway/)
  assert.match(ecosystem, /attendance-windows-native-gateway\.mjs/)
})
