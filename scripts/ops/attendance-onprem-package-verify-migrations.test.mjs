import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const verifyScriptPath = path.join(repoRoot, 'scripts/ops/attendance-onprem-package-verify.sh')

const upgradeMigrationNames = [
  'zzzz20260318123000_formalize_meta_comments',
  'zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions',
]

function writeFile(root, rel, contents = '') {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, contents)
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeMinimumPackage(pkgRoot, options = {}) {
  const {
    omitDistMigration,
    extraSourceMigration,
    omitSupersededAuditMarker,
  } = options

  const placeholderFiles = [
    'apps/web/package.json',
    'packages/core-backend/package.json',
    'plugins/plugin-attendance/plugin.json',
    'plugins/plugin-attendance/index.cjs',
    'scripts/ops/attendance-onprem-start-pm2.ps1',
    'scripts/ops/attendance-windows-native-common.ps1',
    'scripts/ops/attendance-windows-native-preflight.ps1',
    'scripts/ops/attendance-windows-native-start.ps1',
    'scripts/ops/attendance-windows-native-stop.ps1',
    'scripts/ops/attendance-windows-native-healthcheck.ps1',
    'scripts/ops/attendance-windows-native-bootstrap-admin.ps1',
    'scripts/ops/multitable-onprem-bootstrap-admin.ps1',
    'scripts/ops/attendance-onprem-package-install.sh',
    'scripts/ops/attendance-onprem-package-upgrade.sh',
    'scripts/ops/attendance-onprem-publish-web-dist.sh',
    'scripts/ops/attendance-onprem-publish-web-dist.ps1',
    'run-migrate.bat',
    'scripts/ops/attendance-wsl-portproxy-refresh.ps1',
    'scripts/ops/attendance-wsl-portproxy-task.ps1',
    'docker/app.env.example',
    'docs/deployment/attendance-windows-native-qa-20260727.md',
    'ops/nginx/attendance-onprem.conf.example',
    'docs/deployment/attendance-windows-onprem-easy-start-20260306.md',
    'docs/deployment/attendance-windows-wsl-onprem-20260306.md',
    'docs/deployment/attendance-windows-wsl-direct-commands-20260306.md',
    'docs/deployment/attendance-windows-wsl-customer-profiled-commands-20260306.md',
  ]

  for (const rel of placeholderFiles) {
    writeFile(pkgRoot, rel, `${rel}\n`)
  }

  writeFile(
    pkgRoot,
    'packages/core-backend/package.json',
    JSON.stringify({ name: '@metasheet/core-backend', dependencies: {} })
  )
  writeFile(
    pkgRoot,
    'plugins/plugin-attendance/package.json',
    JSON.stringify({ name: '@metasheet/plugin-attendance', dependencies: {} })
  )

  writeFile(pkgRoot, 'apps/web/dist/index.html', '<html>attendance</html>\n')
  writeFile(pkgRoot, 'packages/core-backend/dist/src/index.js', 'module.exports = {}\n')
  writeFile(pkgRoot, 'packages/core-backend/dist/src/db/migrate.js', 'module.exports = {}\n')
  const providerLines = [
    'const marker = "MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL";',
    'const legacy = "032_create_approval_records";',
  ]
  if (!omitSupersededAuditMarker) {
    providerLines.push('const audit = "20250926_create_audit_tables";')
  }
  providerLines.push('module.exports = { marker, legacy };', '')
  writeFile(
    pkgRoot,
    'packages/core-backend/dist/src/db/migration-provider.js',
    providerLines.join('\n')
  )

  writeFile(
    pkgRoot,
    'docker/app.env.attendance-onprem.template',
    'JWT_SECRET=change-me\nBCRYPT_SALT_ROUNDS=12\n'
  )
  writeFile(
    pkgRoot,
    'docker/app.env.attendance-onprem.ready.env',
    'JWT_SECRET=change-me\nBCRYPT_SALT_ROUNDS=12\n'
  )
  writeFile(
    pkgRoot,
    'docker/app.env.attendance-windows-native.qa.example',
    [
      'JWT_SECRET=change-me',
      'ATTENDANCE_IMPORT_UPLOAD_DIR=storage/attendance-import',
      'WINDOWS_NATIVE_GATEWAY_HOST=127.0.0.1',
      '',
    ].join('\n')
  )
  writeFile(
    pkgRoot,
    'pnpm-workspace.yaml',
    "packages:\n  - 'packages/*'\n  - 'plugins/*'\n"
  )

  writeFile(
    pkgRoot,
    'start-pm2.bat',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\ops\\attendance-onprem-start-pm2.ps1" -RootDir "%~dp0."\n'
  )
  writeFile(pkgRoot, 'start-pm2-remote.bat', 'call "%~dp0start-pm2.bat"\n')
  for (const [name, script] of [
    ['windows-native-preflight.bat', 'attendance-windows-native-preflight.ps1'],
    ['windows-native-start.bat', 'attendance-windows-native-start.ps1'],
    ['windows-native-stop.bat', 'attendance-windows-native-stop.ps1'],
    ['windows-native-healthcheck.bat', 'attendance-windows-native-healthcheck.ps1'],
    ['windows-native-bootstrap-admin.bat', 'attendance-windows-native-bootstrap-admin.ps1'],
  ]) {
    writeFile(
      pkgRoot,
      name,
      `powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\ops\\${script}" -RootDir "%~dp0."\n`
    )
  }
  writeFile(
    pkgRoot,
    'deploy-run34.bat',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\ops\\attendance-onprem-deploy-run.ps1" -RootDir "%~dp0."\n'
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-onprem-deploy-run.ps1',
    'scripts\\ops\\attendance-onprem-publish-web-dist.ps1\n'
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-windows-native-common.ps1',
    'PM2 cleanup failed\n'
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-windows-native-preflight.ps1',
    [
      'Assert-WindowsNativeLoopbackHost',
      'Attendance opt-in is forbidden',
      'External integration configuration is forbidden',
      '',
    ].join('\n')
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-windows-native-start.ps1',
    [
      'attendance-windows-native-preflight.ps1',
      'attendance-onprem-deploy-run.ps1',
      'Run windows-native-stop.bat before starting again',
      'Remove-WindowsNativePm2Apps',
      '',
    ].join('\n')
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-windows-native-bootstrap-admin.ps1',
    'multitable-onprem-bootstrap-admin.ps1\n'
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-windows-native-gateway.mjs',
    [
      "const headers = {}; headers['x-forwarded-for'] = remoteAddress",
      "throw new Error('gateway host must be loopback')",
      '',
    ].join('\n')
  )
  writeFile(
    pkgRoot,
    'ecosystem.windows-native.config.cjs',
    'module.exports={apps:[{name:"metasheet-windows-gateway"}]}\n'
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-onprem-bootstrap.sh',
    'bash scripts/ops/attendance-onprem-publish-web-dist.sh\n'
  )
  writeFile(
    pkgRoot,
    'scripts/ops/attendance-onprem-update.sh',
    'bash scripts/ops/attendance-onprem-publish-web-dist.sh\n'
  )

  writeFile(
    pkgRoot,
    'packages/core-backend/src/db/migrations/20250925_create_view_tables.sql',
    'select 1;\n'
  )
  writeFile(
    pkgRoot,
    'packages/core-backend/src/db/migrations/20250926_create_audit_tables.sql',
    'select 1;\n'
  )
  writeFile(
    pkgRoot,
    'packages/core-backend/migrations/056_add_users_must_change_password.sql',
    'alter table users add column if not exists must_change_password boolean;\n'
  )

  for (const migrationName of upgradeMigrationNames) {
    writeFile(
      pkgRoot,
      `packages/core-backend/src/db/migrations/${migrationName}.ts`,
      'export async function up() {}\n'
    )

    if (migrationName !== omitDistMigration) {
      writeFile(
        pkgRoot,
        `packages/core-backend/dist/src/db/migrations/${migrationName}.js`,
        'exports.up = async function up() {};\n'
      )
    }
  }

  if (extraSourceMigration) {
    writeFile(
      pkgRoot,
      `packages/core-backend/src/db/migrations/${extraSourceMigration}.ts`,
      'export async function up() {}\n'
    )
  }
}

function makeArchive(options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-package-verify-'))
  const packageName = 'metasheet-attendance-onprem-v2.7.2-run34'
  const stagingRoot = path.join(tempRoot, 'staging')
  const pkgRoot = path.join(stagingRoot, packageName)
  const archivePath = path.join(tempRoot, `${packageName}.tgz`)

  writeMinimumPackage(pkgRoot, options)

  const tar = spawnSync('tar', ['-czf', archivePath, '-C', stagingRoot, packageName], {
    encoding: 'utf8',
  })
  assert.equal(tar.status, 0, tar.stderr || tar.stdout)

  writeFile(tempRoot, 'SHA256SUMS', `${sha256(archivePath)}  ${path.basename(archivePath)}\n`)
  return { archivePath, tempRoot }
}

function withArchive(options, assertion) {
  const { archivePath, tempRoot } = makeArchive(options)

  try {
    assertion(archivePath)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

function runVerify(archivePath) {
  return spawnSync('bash', [verifyScriptPath, archivePath], {
    cwd: repoRoot,
    env: { ...process.env, VERIFY_SHA: '1', VERIFY_NO_GITHUB_LINKS: '1' },
    encoding: 'utf8',
  })
}

test('accepts a package with compiled migration coverage for upgraded databases', () => {
  withArchive({}, (archivePath) => {
    const result = runVerify(archivePath)

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stderr, /Package verify OK/)
  })
})

test('rejects a package whose compiled provider lacks the superseded audit marker', () => {
  withArchive({ omitSupersededAuditMarker: true }, (archivePath) => {
    const result = runVerify(archivePath)

    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      /migration-provider\.js must no-op the superseded audit SQL on upgraded on-prem databases/
    )
  })
})

test('rejects a package missing an issue 1907 upgraded-database migration in dist', () => {
  const missingMigration = 'zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions'
  withArchive({ omitDistMigration: missingMigration }, (archivePath) => {
    const result = runVerify(archivePath)

    assert.notEqual(result.status, 0)
    assert.match(
      result.stderr,
      new RegExp(`Required package content missing: packages/core-backend/dist/src/db/migrations/${missingMigration}\\.js`)
    )
  })
})

test('rejects a package when a source TS migration lacks compiled JS', () => {
  const extraSourceMigration = 'zzzz20260601000000_future_attendance_package_guard'
  withArchive({ extraSourceMigration }, (archivePath) => {
    const result = runVerify(archivePath)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, new RegExp(extraSourceMigration))
    assert.match(result.stderr, /Package missing compiled JS for one or more core backend TS migrations/)
  })
})
