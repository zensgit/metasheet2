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
