import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

function readScript(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

test('Windows apply helper bootstraps SYSTEM-safe tool PATH and resolves pnpm from common locations', () => {
  const script = readScript('scripts/ops/multitable-onprem-apply-package.ps1')

  assert.match(script, /function Initialize-WindowsSystemToolPath/)
  assert.match(script, /C:\\Users\\Administrator\\AppData\\Roaming/)
  assert.match(script, /Join-Path \$base 'nodejs'/)
  assert.match(script, /foreach \(\$leaf in @\('pnpm\.exe', 'pnpm\.cmd', 'pnpm\.ps1'\)\)/)
  assert.match(script, /Initialize-WindowsSystemToolPath/)
  assert.match(script, /\$pnpmInstallPath = Resolve-PnpmInstallCommand/)
  assert.match(script, /\$pnpmPath = \$pnpmInstallPath/)
})

test('PM2 startup helper initializes SYSTEM profile env before invoking PM2', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /function Initialize-WindowsSystemProfileEnv/)
  assert.match(script, /Set-EnvIfMissing -Name 'USERPROFILE'/)
  assert.match(script, /Set-EnvIfMissing -Name 'HOME'/)
  assert.match(script, /Set-EnvIfMissing -Name 'HOMEPATH'/)
  assert.match(script, /Set-EnvIfMissing -Name 'PM2_HOME'/)
  assert.match(script, /\$homeDrive = \$pathRoot\.TrimEnd\('\\'\)/)
  assert.match(script, /\$homePath = \$profileRoot\.Substring\(\$homeDrive\.Length\)/)
  assert.match(script, /-not \$homePath\.StartsWith\('\\'\)/)
  assert.doesNotMatch(script, /\$profileRoot\.Substring\(\$pathRoot\.Length - 1\)/)
  assert.match(script, /Initialize-WindowsSystemToolPath/)
  assert.match(script, /Initialize-WindowsSystemProfileEnv/)
})

test('PM2 startup helper replaces stale app definitions instead of restart-only reuse', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /function Get-Pm2AppProcess/)
  assert.match(script, /function Test-Pm2AppMatchesTarget/)
  assert.match(script, /pm_exec_path/)
  assert.match(script, /pm_cwd/)
  assert.match(script, /packages\\core-backend\\dist\\src\\index\.js/)
  assert.match(script, /deleting stale pm2 app definition/)
  assert.match(script, /delete \$Pm2AppName/)
  assert.match(script, /--update-env/)
})

test('PM2 startup helper retires sensitive test-only env keys absent from app.env', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /\$RetiredSensitiveEnvKeys = @\(/)
  assert.match(script, /'METASHEET_C6_TEST_FAILURE_INJECTION_ENABLED'/)
  assert.match(script, /'INTEGRATION_CORE_C6_TEST_FAILURE_INJECTION_JSON'/)
  assert.match(script, /function Get-AppEnvKeySet/)
  assert.match(script, /function Clear-RetiredSensitiveEnvKeysAbsentFromFile/)
  assert.match(script, /Remove-Item -Path \("Env:\{0\}" -f \$key\) -ErrorAction SilentlyContinue/)
  assert.match(script, /function Test-Pm2AppHasRetiredSensitiveEnvKey/)
  assert.match(script, /if \(\$EnvFileKeys\.ContainsKey\(\$key\)\)/)
  assert.match(script, /if \(\$null -ne \$App\.pm2_env\.PSObject\.Properties\[\$key\]\)/)
  assert.match(script, /\$envFileKeys = Get-AppEnvKeySet -EnvFile \$envFile/)
  assert.match(script, /Clear-RetiredSensitiveEnvKeysAbsentFromFile -KeyNames \$RetiredSensitiveEnvKeys -EnvFileKeys \$envFileKeys/)
  assert.match(script, /deleting pm2 app definition for \$Pm2AppName to retire sensitive\/test-only env keys/)
  assert.match(script, /pm2 delete failed while retiring env keys/)
})

test('PM2 startup helper deletes existing app when jlist cannot inspect retired-key state', () => {
  const script = readScript('scripts/ops/attendance-onprem-start-pm2.ps1')

  assert.match(script, /function Test-RetiredSensitiveEnvKeyRetirementRequired/)
  assert.match(script, /if \(-not \$EnvFileKeys\.ContainsKey\(\$key\)\) \{\s+return \$true\s+\}/)
  assert.match(script, /Test-RetiredSensitiveEnvKeyRetirementRequired -KeyNames \$RetiredSensitiveEnvKeys -EnvFileKeys \$envFileKeys/)
  assert.match(script, /pm2 jlist did not return \$Pm2AppName; deleting existing pm2 app definition to retire sensitive\/test-only env keys/)
  assert.match(script, /pm2 delete failed while retiring env keys for \$Pm2AppName after jlist fallback/)

  const fallbackBlockStart = script.indexOf('pm2 jlist did not return $Pm2AppName; deleting existing pm2 app definition')
  const restartBlockStart = script.indexOf('pm2 jlist did not return $Pm2AppName; falling back to restart')
  assert.ok(fallbackBlockStart > -1)
  assert.ok(restartBlockStart > fallbackBlockStart)
})
