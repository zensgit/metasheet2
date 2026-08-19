import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// Contract test for the LAB-0 host inventory DRAFT.
//
// Hermetic by construction: every probe is injected, so no test below opens a
// socket, spawns a shell, reaches a database, or touches a host. The one
// subprocess case runs the script with both optional probes disabled and no
// connection string, so it too performs no I/O beyond reading local memory and
// a temp directory's filesystem stats.
//
// The assertions are grouped by the three claims this tool has to earn:
//   1. classifiers are exact at their boundaries (a class that is wrong by one
//      major version or one byte is worse than UNKNOWN, because it reads as a
//      fact);
//   2. the emitted block is values-free — the discriminating case feeds
//      credential-bearing sentinels through the config and proves none reaches
//      stdout;
//   3. the tool is non-mutating — pinned against the source itself, since
//      "we did not write anything this time" is not a property a behavioural
//      test can establish.

import {
  CATALOG_READ_SQL,
  ENV_VAR,
  SEALED_EXPORT_ENV,
  SIX_FIELD_ORDER,
  TOKEN,
  artifactRootHardlinkSupportedField,
  classifyArtifactRootFilesystem,
  classifyDiskFree,
  classifyFactsProvider,
  classifyMemory,
  classifyNodeMajor,
  classifyPostgresMajor,
  formatReport,
  postgresMajorField,
  runInventory,
} from './stock-preparation-lab0-inventory.mjs'

const SCRIPT_PATH = fileURLToPath(new URL('./stock-preparation-lab0-inventory.mjs', import.meta.url))
const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8')
const GIB = 1024 * 1024 * 1024

// Credential-bearing inputs the tool is handed and must never echo.
const SENTINEL_PG_URL = 'postgres://SENTINELUSER:SENTINELSECRET@SENTINELHOST.invalid:5432/SENTINELDB'
const SENTINEL_HEALTH_URL = 'http://SENTINELRUNTIME.invalid:9901/api/health'
const SENTINEL_ARTIFACT_ROOT = 'Z:\\SENTINELARTIFACTROOT\\blobs\\staging'
const SENTINELS = [
  'SENTINELUSER', 'SENTINELSECRET', 'SENTINELHOST', 'SENTINELDB', 'SENTINELRUNTIME',
  'SENTINELARTIFACTROOT',
]

function goodProbes(overrides = {}) {
  return {
    artifactRootFilesystem: () => 'NTFS',
    diskFreeBytes: () => 64 * GIB,
    health: async () => true,
    memory: () => ({ freeBytes: 24 * GIB, totalBytes: 64 * GIB }),
    nodeMajor: () => '20',
    postgresCatalog: async () => ({
      canCreateDatabase: true,
      canCreateRole: true,
      connected: true,
      driverAvailable: true,
      serverVersionNum: '170002',
    }),
    powerShellMajor: (executable) => (executable === 'powershell' ? 5 : 7),
    tcpReachable: async () => true,
    ...overrides,
  }
}

function goodEnv(overrides = {}) {
  return {
    [ENV_VAR.diskPath]: os.tmpdir(),
    [ENV_VAR.factsProvider]: '@lab0-operator',
    [ENV_VAR.healthUrl]: SENTINEL_HEALTH_URL,
    [ENV_VAR.postgresUrl]: SENTINEL_PG_URL,
    [SEALED_EXPORT_ENV.artifactRoot]: SENTINEL_ARTIFACT_ROOT,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Classifier boundaries.
// ---------------------------------------------------------------------------
test('classifyPostgresMajor: 15/16/17 boundaries are exact, everything else is PG_OTHER', () => {
  assert.equal(classifyPostgresMajor('150000'), TOKEN.PG15)
  assert.equal(classifyPostgresMajor('159999'), TOKEN.PG15)
  assert.equal(classifyPostgresMajor('160000'), TOKEN.PG16)
  assert.equal(classifyPostgresMajor('170002'), TOKEN.PG17)
  assert.equal(classifyPostgresMajor('179999'), TOKEN.PG17)
  assert.equal(classifyPostgresMajor('180000'), TOKEN.PG_OTHER)
  assert.equal(classifyPostgresMajor('140012'), TOKEN.PG_OTHER)
})

test('classifyPostgresMajor: absent/garbage input is UNKNOWN, never a version', () => {
  for (const bad of [null, undefined, '', 'seventeen', '0', '-1', {}]) {
    assert.equal(classifyPostgresMajor(bad), TOKEN.UNKNOWN, `expected UNKNOWN for ${String(bad)}`)
  }
})

test('postgresMajorField projects the class back onto the six-field template vocabulary', () => {
  assert.equal(postgresMajorField(TOKEN.PG15), '15')
  assert.equal(postgresMajorField(TOKEN.PG16), '16')
  assert.equal(postgresMajorField(TOKEN.PG17), '17')
  assert.equal(postgresMajorField(TOKEN.PG_OTHER), TOKEN.OTHER)
  assert.equal(postgresMajorField(TOKEN.UNKNOWN), TOKEN.UNKNOWN)
})

test('classifyDiskFree: 40 GiB and 10 GiB water marks are inclusive lower bounds', () => {
  assert.equal(classifyDiskFree(40 * GIB), TOKEN.DISK_GE_40GIB)
  assert.equal(classifyDiskFree(40 * GIB - 1), TOKEN.DISK_10_TO_40GIB)
  assert.equal(classifyDiskFree(10 * GIB), TOKEN.DISK_10_TO_40GIB)
  assert.equal(classifyDiskFree(10 * GIB - 1), TOKEN.DISK_LT_10GIB)
  assert.equal(classifyDiskFree(null), TOKEN.UNKNOWN)
  assert.equal(classifyDiskFree(-1), TOKEN.UNKNOWN)
})

test('classifyMemory: 16 GiB is an inclusive lower bound', () => {
  assert.equal(classifyMemory(16 * GIB), TOKEN.MEM_GE_16GIB)
  assert.equal(classifyMemory(16 * GIB - 1), TOKEN.MEM_LT_16GIB)
  assert.equal(classifyMemory(null), TOKEN.UNKNOWN)
})

test('classifyNodeMajor: only major 20 answers YES to node20Available', () => {
  assert.equal(classifyNodeMajor('20'), TOKEN.NODE20)
  assert.equal(classifyNodeMajor('22'), TOKEN.NODE22)
  assert.equal(classifyNodeMajor('18'), TOKEN.NODE_OTHER)
  assert.equal(classifyNodeMajor('x'), TOKEN.UNKNOWN)
})

test('classifyFactsProvider: handle shapes accepted, anything else refused rather than echoed', () => {
  assert.equal(classifyFactsProvider('@lab0-operator'), '@lab0-operator')
  assert.equal(classifyFactsProvider('lab0-operator'), '@lab0-operator')
  assert.equal(classifyFactsProvider('  @lab0-operator  '), '@lab0-operator')
  assert.equal(classifyFactsProvider(''), TOKEN.UNSET)
  assert.equal(classifyFactsProvider(undefined), TOKEN.UNSET)
  // A pasted hostname / email / connection string must not be printed back.
  assert.equal(classifyFactsProvider('operator@example.com'), TOKEN.INVALID_FORMAT)
  assert.equal(classifyFactsProvider('db.internal.example'), TOKEN.INVALID_FORMAT)
  assert.equal(classifyFactsProvider('a'.repeat(40)), TOKEN.INVALID_FORMAT)
})

test('classifyArtifactRootFilesystem: NTFS/ReFS are exact (case-insensitive), everything else is OTHER, absence is UNRESOLVED', () => {
  assert.equal(classifyArtifactRootFilesystem('NTFS'), TOKEN.NTFS)
  assert.equal(classifyArtifactRootFilesystem('ntfs'), TOKEN.NTFS)
  assert.equal(classifyArtifactRootFilesystem('ReFS'), TOKEN.REFS)
  assert.equal(classifyArtifactRootFilesystem('REFS'), TOKEN.REFS)
  assert.equal(classifyArtifactRootFilesystem('FAT32'), TOKEN.OTHER)
  assert.equal(classifyArtifactRootFilesystem('exFAT'), TOKEN.OTHER)
  assert.equal(classifyArtifactRootFilesystem(null), TOKEN.UNRESOLVED)
  assert.equal(classifyArtifactRootFilesystem(undefined), TOKEN.UNRESOLVED)
  assert.equal(classifyArtifactRootFilesystem(''), TOKEN.UNRESOLVED)
  assert.equal(classifyArtifactRootFilesystem('   '), TOKEN.UNRESOLVED)
})

test('artifactRootHardlinkSupportedField: only NTFS/ReFS answer YES, OTHER is NO, everything else is UNKNOWN', () => {
  assert.equal(artifactRootHardlinkSupportedField(TOKEN.NTFS), TOKEN.YES)
  assert.equal(artifactRootHardlinkSupportedField(TOKEN.REFS), TOKEN.YES)
  assert.equal(artifactRootHardlinkSupportedField(TOKEN.OTHER), TOKEN.NO)
  assert.equal(artifactRootHardlinkSupportedField(TOKEN.UNRESOLVED), TOKEN.UNKNOWN)
  assert.equal(artifactRootHardlinkSupportedField(TOKEN.NOT_CONFIGURED), TOKEN.UNKNOWN)
})

// ---------------------------------------------------------------------------
// 2. Orchestration outcomes.
// ---------------------------------------------------------------------------
test('fully-known host: every six-field value is determinate, lab0Status=COMPLETE, exit 0', async () => {
  const result = await runInventory({ env: goodEnv(), probes: goodProbes() })
  assert.equal(result.lab0Status, TOKEN.COMPLETE)
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.sixField, {
    canCreateIsolatedTestDatabase: TOKEN.YES,
    canCreateSelectOnlyTestPrincipal: TOKEN.YES,
    factsProvider: '@lab0-operator',
    metasheetTestRuntimeAvailable: TOKEN.YES,
    postgresMajorVersion: '17',
    postgresServiceAvailable: TOKEN.YES,
  })
  assert.equal(result.fields.node20Available, TOKEN.YES)
  assert.equal(result.fields.powershell51Available, TOKEN.YES)
  assert.equal(result.fields.pwsh7Available, TOKEN.YES)
  assert.equal(result.fields.diskFreeClass, TOKEN.DISK_GE_40GIB)
  assert.equal(result.fields.freeDiskAtLeast40GiB, TOKEN.YES)
  assert.equal(result.fields.artifactRootFilesystem, TOKEN.NTFS)
  assert.equal(result.fields.artifactRootHardlinkSupported, TOKEN.YES)
  assert.equal(result.fields.externalWrite, 'false')
})

test('the exact 2026-08-03 host shape reproduces that reply and BLOCKS on it', async () => {
  // Runtime down, PostgreSQL up and major 17, admin capabilities unknowable
  // because the catalog read could not be performed. This is the shape that
  // cost issue #4695 a full owner<->operator round-trip.
  const result = await runInventory({
    env: goodEnv(),
    probes: goodProbes({
      health: async () => null,
      postgresCatalog: async () => ({ connected: false, driverAvailable: false }),
      tcpReachable: async () => true,
    }),
  })
  assert.equal(result.sixField.metasheetTestRuntimeAvailable, TOKEN.UNKNOWN)
  assert.equal(result.sixField.postgresServiceAvailable, TOKEN.YES)
  assert.equal(result.sixField.postgresMajorVersion, TOKEN.UNKNOWN)
  assert.equal(result.sixField.canCreateIsolatedTestDatabase, TOKEN.UNKNOWN)
  assert.equal(result.sixField.canCreateSelectOnlyTestPrincipal, TOKEN.UNKNOWN)
  assert.equal(result.fields.postgresDriverAvailable, TOKEN.NO)
  assert.equal(result.lab0Status, TOKEN.BLOCKED)
  assert.equal(result.exitCode, 1)
})

test('health FAIL (reachable but non-2xx) is NO, not UNKNOWN — the two are different facts', async () => {
  const result = await runInventory({
    env: goodEnv(),
    probes: goodProbes({ health: async () => false }),
  })
  assert.equal(result.fields.metasheetRuntimeHealth, TOKEN.FAIL)
  assert.equal(result.sixField.metasheetTestRuntimeAvailable, TOKEN.NO)
  // lab0Status describes whether the INVENTORY is complete, not whether the
  // host is ready. A determinate NO is a complete inventory; #4695's readiness
  // verdict is computed from the block, not by this tool.
  assert.equal(result.lab0Status, TOKEN.COMPLETE)
})

test('a connected session without CREATEDB/CREATEROLE answers NO, not UNKNOWN', async () => {
  const result = await runInventory({
    env: goodEnv(),
    probes: goodProbes({
      postgresCatalog: async () => ({
        canCreateDatabase: false,
        canCreateRole: false,
        connected: true,
        driverAvailable: true,
        serverVersionNum: '160004',
      }),
    }),
  })
  assert.equal(result.sixField.canCreateIsolatedTestDatabase, TOKEN.NO)
  assert.equal(result.sixField.canCreateSelectOnlyTestPrincipal, TOKEN.NO)
  assert.equal(result.sixField.postgresMajorVersion, '16')
  // Determinate NOs are a COMPLETE inventory: the machine is answerable and
  // simply says no. Only UNKNOWN blocks.
  assert.equal(result.lab0Status, TOKEN.COMPLETE)
})

test('no connection string configured: PostgreSQL fields are UNKNOWN and nothing is probed', async () => {
  let tcpCalls = 0
  let catalogCalls = 0
  const env = goodEnv()
  delete env[ENV_VAR.postgresUrl]
  const result = await runInventory({
    env,
    probes: goodProbes({
      postgresCatalog: async () => {
        catalogCalls += 1
        return { connected: true, driverAvailable: true, serverVersionNum: '170002' }
      },
      tcpReachable: async () => {
        tcpCalls += 1
        return true
      },
    }),
  })
  assert.equal(tcpCalls, 0)
  assert.equal(catalogCalls, 0)
  assert.equal(result.sixField.postgresServiceAvailable, TOKEN.UNKNOWN)
  assert.equal(result.sixField.postgresMajorVersion, TOKEN.UNKNOWN)
  assert.equal(result.lab0Status, TOKEN.BLOCKED)
})

test('artifact-root env var unset: NOT_CONFIGURED, hardlink UNKNOWN, and the probe is never called', async () => {
  let probeCalls = 0
  const env = goodEnv()
  delete env[SEALED_EXPORT_ENV.artifactRoot]
  const result = await runInventory({
    env,
    probes: goodProbes({
      artifactRootFilesystem: () => {
        probeCalls += 1
        return 'NTFS'
      },
    }),
  })
  assert.equal(probeCalls, 0)
  assert.equal(result.fields.artifactRootFilesystem, TOKEN.NOT_CONFIGURED)
  assert.equal(result.fields.artifactRootHardlinkSupported, TOKEN.UNKNOWN)
})

test('artifact-root probe returns null (non-Windows or unresolvable path): UNRESOLVED, hardlink UNKNOWN', async () => {
  const result = await runInventory({
    env: goodEnv(),
    probes: goodProbes({ artifactRootFilesystem: () => null }),
  })
  assert.equal(result.fields.artifactRootFilesystem, TOKEN.UNRESOLVED)
  assert.equal(result.fields.artifactRootHardlinkSupported, TOKEN.UNKNOWN)
})

test('artifact-root volume is a non-NTFS/ReFS filesystem: OTHER, hardlink NO — the class-2 risk case', async () => {
  const result = await runInventory({
    env: goodEnv(),
    probes: goodProbes({ artifactRootFilesystem: () => 'FAT32' }),
  })
  assert.equal(result.fields.artifactRootFilesystem, TOKEN.OTHER)
  assert.equal(result.fields.artifactRootHardlinkSupported, TOKEN.NO)
})

test('artifact-root volume is ReFS: hardlink YES, same as NTFS', async () => {
  const result = await runInventory({
    env: goodEnv(),
    probes: goodProbes({ artifactRootFilesystem: () => 'ReFS' }),
  })
  assert.equal(result.fields.artifactRootFilesystem, TOKEN.REFS)
  assert.equal(result.fields.artifactRootHardlinkSupported, TOKEN.YES)
})

test('a missing or malformed factsProvider blocks instead of emitting a bare template', async () => {
  const missing = await runInventory({
    env: goodEnv({ [ENV_VAR.factsProvider]: '' }),
    probes: goodProbes(),
  })
  assert.equal(missing.sixField.factsProvider, TOKEN.UNSET)
  assert.equal(missing.lab0Status, TOKEN.BLOCKED)

  const malformed = await runInventory({
    env: goodEnv({ [ENV_VAR.factsProvider]: 'ops@corp.example' }),
    probes: goodProbes(),
  })
  assert.equal(malformed.sixField.factsProvider, TOKEN.INVALID_FORMAT)
  assert.equal(malformed.lab0Status, TOKEN.BLOCKED)
})

// ---------------------------------------------------------------------------
// 3. Values-free output.
// ---------------------------------------------------------------------------
test('report contains none of the credential-bearing inputs it was handed', async () => {
  const result = await runInventory({ env: goodEnv(), probes: goodProbes() })
  const report = formatReport(result)
  for (const sentinel of SENTINELS) {
    assert.ok(!report.includes(sentinel), `report leaked sentinel ${sentinel}`)
  }
  assert.ok(!report.includes('5432'))
  assert.ok(!report.includes('9901'))
  assert.ok(!report.includes(os.tmpdir()))
})

test('every emitted value is a closed token (or the shape-validated handle)', async () => {
  const result = await runInventory({ env: goodEnv(), probes: goodProbes() })
  const allowed = new Set([
    ...Object.values(TOKEN),
    '15', '16', '17',
    '@lab0-operator',
  ])
  for (const line of formatReport(result).split('\n')) {
    if (!line.includes('=') || line.startsWith('===')) continue
    const [name, value] = [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]
    if (name === 'inventoryTool' || name === 'mutationsPerformed' || name === 'businessRowsRead') continue
    assert.ok(allowed.has(value), `field ${name} emitted unregistered value ${value}`)
  }
})

test('the six-field block matches #4695 comment 5161121847 field-for-field, in order', async () => {
  assert.deepEqual(SIX_FIELD_ORDER, [
    'metasheetTestRuntimeAvailable',
    'postgresServiceAvailable',
    'postgresMajorVersion',
    'canCreateIsolatedTestDatabase',
    'canCreateSelectOnlyTestPrincipal',
    'factsProvider',
  ])
  const result = await runInventory({ env: goodEnv(), probes: goodProbes() })
  const report = formatReport(result)
  const block = report.slice(report.indexOf('=== #4695'))
  const emitted = block
    .split('\n')
    .filter((line) => line.includes('=') && !line.startsWith('===') && !line.startsWith('lab0Status'))
    .map((line) => line.slice(0, line.indexOf('=')))
  assert.deepEqual(emitted, SIX_FIELD_ORDER)
})

test('formatReport fails closed on an unregistered token AND on a leaked input', () => {
  // Two discriminating negative controls. Without them, the leak assertions
  // above would still pass for a tool whose guards had been deleted.
  const base = {
    config: { diskPath: os.tmpdir(), healthUrl: SENTINEL_HEALTH_URL, postgresUrl: SENTINEL_PG_URL },
    exitCode: 0,
    lab0Status: TOKEN.COMPLETE,
  }

  // (a) a status field carrying free text is refused by the closed-set guard.
  assert.throws(
    () => formatReport({
      ...base,
      fields: { externalWrite: TOKEN.FALSE, nodeMajorClass: 'v20.11.1' },
      sixField: {},
    }),
    /LAB0_UNREGISTERED_TOKEN/,
  )

  // (b) factsProvider is exempt from the closed set by design, so the composed
  // self-scan is the only thing standing between it and a leaked URL.
  assert.throws(
    () => formatReport({
      ...base,
      fields: { externalWrite: TOKEN.FALSE, nodeMajorClass: TOKEN.NODE20 },
      sixField: { factsProvider: SENTINEL_HEALTH_URL },
    }),
    /LAB0_INPUT_LEAKED_INTO_REPORT/,
  )
})

// ---------------------------------------------------------------------------
// 4. Non-mutation, pinned against the source.
// ---------------------------------------------------------------------------
test('exactly one SQL statement exists and it is a read-only catalog SELECT', () => {
  assert.ok(CATALOG_READ_SQL.startsWith('SELECT '))
  for (const verb of [
    'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'GRANT',
    'REVOKE', 'TRUNCATE', 'COPY', 'SET ', 'CALL ', 'DO ',
  ]) {
    assert.ok(!CATALOG_READ_SQL.includes(verb), `catalog SQL must not contain ${verb}`)
  }
  // No business relation: the only relation referenced is the system view.
  assert.ok(CATALOG_READ_SQL.includes('FROM pg_roles'))
  const queryCalls = SOURCE.split('client.query(').length - 1
  assert.equal(queryCalls, 1, 'exactly one query call site is allowed')
  assert.ok(SOURCE.includes('client.query(CATALOG_READ_SQL)'))
})

test('no filesystem write API and no package-installing command appear in the source', () => {
  for (const api of [
    'writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync',
    'mkdtempSync', 'createWriteStream', 'copyFileSync', 'chmodSync',
  ]) {
    assert.ok(!SOURCE.includes(api), `source must not use ${api}`)
  }
  for (const command of ['npm ', 'pnpm ', 'yarn ', 'Invoke-WebRequest', 'curl ', 'winget', 'choco']) {
    assert.ok(!SOURCE.includes(command), `source must not shell out to ${command.trim()}`)
  }
})

test('the only child processes are the two read-only PowerShell probes (version + artifact-root volume format)', () => {
  const spawnCalls = SOURCE.split('spawnSync(').length - 1
  assert.equal(spawnCalls, 2)
  assert.ok(SOURCE.includes("'-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'"))
  assert.ok(SOURCE.includes("'-NoProfile', '-NonInteractive', '-Command', "))
  assert.ok(SOURCE.includes('Get-Volume'))
  assert.ok(SOURCE.includes('.FileSystem'))
  for (const api of ['spawn(', 'exec(', 'execSync(', 'execFile(', 'fork(']) {
    assert.ok(!SOURCE.includes(api), `source must not use ${api}`)
  }
  // Both PowerShell call sites read state; neither may mutate a volume, a
  // file, or anything else reachable through the shell.
  for (const verb of [
    'Set-Volume', 'Format-Volume', 'Initialize-Volume', 'Repair-Volume',
    'New-Item', 'Remove-Item', 'Set-Content', 'Out-File', 'New-Volume',
    'ConvertTo-', 'New-Hardlink', 'New-Item -ItemType HardLink',
  ]) {
    assert.ok(!SOURCE.includes(verb), `source must not use PowerShell verb ${verb}`)
  }
})

test('the only HTTP request is an unauthenticated GET', () => {
  const fetchCalls = SOURCE.split('fetch(').length - 1
  assert.equal(fetchCalls, 1)
  assert.ok(SOURCE.includes("method: 'GET'"))
  for (const method of ["'POST'", "'PUT'", "'PATCH'", "'DELETE'"]) {
    assert.ok(!SOURCE.includes(method), `source must not issue ${method}`)
  }
  // No credential is ever attached to the probe.
  for (const header of ['Authorization', 'Bearer', 'METASHEET_ADMIN_TOKEN', 'Cookie']) {
    assert.ok(!SOURCE.includes(header), `source must not attach ${header}`)
  }
})

// ---------------------------------------------------------------------------
// 5. End-to-end, still hermetic: both optional probes off, no connection string.
// ---------------------------------------------------------------------------
test('CLI run with probes disabled emits a BLOCKED report and exit code 1', () => {
  const env = {
    ...process.env,
    [ENV_VAR.diskPath]: os.tmpdir(),
    [ENV_VAR.factsProvider]: '@lab0-operator',
    [ENV_VAR.probeHealth]: '0',
    [ENV_VAR.probePowerShell]: '0',
  }
  delete env[ENV_VAR.postgresUrl]
  delete env[ENV_VAR.healthUrl]
  // Guarantee NOT_CONFIGURED regardless of whether this host happens to have
  // the real S6-A product env var set, so this subprocess run stays hermetic.
  delete env[SEALED_EXPORT_ENV.artifactRoot]

  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', env })
  } catch (error) {
    stdout = String(error.stdout || '')
    status = error.status
  }
  assert.equal(status, 1)
  assert.ok(stdout.includes('lab0Status=BLOCKED'))
  assert.ok(stdout.includes('metasheetTestRuntimeAvailable=UNKNOWN'))
  assert.ok(stdout.includes('postgresServiceAvailable=UNKNOWN'))
  assert.ok(stdout.includes('factsProvider=@lab0-operator'))
  assert.ok(stdout.includes('mutationsPerformed=0'))
  assert.ok(stdout.includes('businessRowsRead=0'))
  // A disabled probe must report UNKNOWN, never a fabricated NO.
  assert.ok(stdout.includes('powershell51Available=UNKNOWN'))
  // An unset product env var is NOT_CONFIGURED, not UNKNOWN/UNRESOLVED.
  assert.ok(stdout.includes('artifactRootFilesystem=NOT_CONFIGURED'))
  assert.ok(stdout.includes('artifactRootHardlinkSupported=UNKNOWN'))
  assert.ok(!stdout.includes(os.tmpdir()))
})
