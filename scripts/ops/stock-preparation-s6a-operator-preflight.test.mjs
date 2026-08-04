import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Contract test for the S6-A operator preflight tool (offline, values-free).
// Covers docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md
// §4's five private artifacts and the seven distinct operator mistakes that all
// collapsed into the single opaque SEALED_EXPORT_INTERNAL_ERROR token. No server,
// no database, no network — every scenario below only writes throwaway synthetic
// material under os.tmpdir().

import {
  REASON,
  buildDraftFromRawBinding,
  runPreflight,
} from './stock-preparation-s6a-operator-preflight.mjs'

const require = createRequire(import.meta.url)
const SCRIPT_PATH = fileURLToPath(new URL('./stock-preparation-s6a-operator-preflight.mjs', import.meta.url))
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..')

const { ENV, FEATURE_FLAG } = require(
  path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-config.cjs'),
)
const { BINDING_DRAFT_FIELDS } = require(
  path.join(REPO_ROOT, 'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs'),
)

// ---------------------------------------------------------------------------
// Fixture builder — a fully-valid operator environment, all synthetic.
// ---------------------------------------------------------------------------
function buildGoodOperatorMaterial(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-s6a-preflight-test-'))
  const identityKeyPath = path.join(dir, 'identity.key')
  const evidenceKeyPath = path.join(dir, 'evidence.key')
  const qualificationKeyPath = path.join(dir, 'qualification.key')
  const signerPemPath = path.join(dir, 'signer.pem')
  const specPath = path.join(dir, 'spec.json')

  fs.writeFileSync(identityKeyPath, overrides.identityKeyBytes ?? crypto.randomBytes(64))
  fs.writeFileSync(evidenceKeyPath, overrides.evidenceKeyBytes ?? crypto.randomBytes(64))
  fs.writeFileSync(qualificationKeyPath, overrides.qualificationKeyBytes ?? crypto.randomBytes(64))

  if (overrides.signerPemBytes) {
    fs.writeFileSync(signerPemPath, overrides.signerPemBytes)
  } else {
    const { privateKey } = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(signerPemPath, privateKey.export({ format: 'pem', type: 'pkcs8' }))
  }

  const nowPlusHour = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const spec = overrides.spec ?? {
    binding: {
      approvedConfigVersionId: 'sentinel-config-version',
      bindingExpiresAt: nowPlusHour,
      bindingId: 'sentinel-binding-id',
      bindingVersion: 'sentinel-binding-version',
      externalSystemId: 'sentinel-external-system-id',
      signerExpiresAt: nowPlusHour,
      tableRef: 'dbo.SentinelTable',
      tenantId: 'sentinel-tenant',
      workspaceId: null,
    },
    externalSystem: {
      config: {
        sealedSnapshotSqlServer: {
          database: 'sentinel-database',
          encrypt: true,
          instanceName: null,
          port: 1433,
          server: 'SENTINEL-SERVER-HOSTNAME',
          trustServerCertificate: false,
        },
      },
      credentials: {
        sealedSnapshotSqlServer: {
          password: 'SENTINEL-PASSWORD-DO-NOT-LEAK',
          user: 'SENTINEL-USER',
        },
      },
      id: 'sentinel-external-system-id',
      kind: 'data-source:sql-readonly',
      role: 'source',
      status: 'active',
      tenantId: 'sentinel-tenant',
      workspaceId: null,
    },
  }
  fs.writeFileSync(specPath, JSON.stringify(spec))

  return { dir, evidenceKeyPath, identityKeyPath, qualificationKeyPath, signerPemPath, specPath }
}

function envFromMaterial(material) {
  return {
    [ENV.artifactRoot]: material.dir,
    [ENV.evidenceKeyFile]: material.evidenceKeyPath,
    [ENV.identityKeyFile]: material.identityKeyPath,
    [ENV.provisioningDatabaseRole]: 'sentinel_provisioning_role',
    [ENV.provisioningDatabaseUrl]: 'postgres://sentinel:SENTINEL-DB-SECRET@127.0.0.1:5432/sentinel_db',
    [ENV.provisioningSpecFile]: material.specPath,
    [ENV.qualificationKeyFile]: material.qualificationKeyPath,
    [ENV.qualificationKeyId]: 'sentinel-qualification-key-id',
    [ENV.runtimeDatabaseRole]: 'sentinel_runtime_role',
    [ENV.runtimeDatabaseUrl]: 'postgres://sentinel:SENTINEL-DB-SECRET@127.0.0.1:5432/sentinel_runtime_db',
    [ENV.signerPrivateKeyFile]: material.signerPemPath,
  }
}

function checkById(result, id) {
  const check = result.checks.find((c) => c.id === id)
  assert.ok(check, `expected a check named ${id}`)
  return check
}

function cleanup(material) {
  fs.rmSync(material.dir, { force: true, recursive: true })
}

// ---------------------------------------------------------------------------
// Positive control: a fully-correct environment must PASS end to end.
// ---------------------------------------------------------------------------
test('fully-correct environment: every check PASSes and preflightPass=PASS, exitCode=0', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const result = runPreflight({ env: envFromMaterial(material) })
    assert.equal(result.preflightPass, 'PASS')
    assert.equal(result.exitCode, 0)
    assert.equal(result.baselineAvailable, true)
    assert.ok(result.checks.length >= 14, 'expected at least 14 distinct checks')
    for (const check of result.checks) {
      assert.equal(check.status, 'PASS', `${check.id} unexpectedly ${check.status} (${check.reason})`)
    }
  } finally {
    cleanup(material)
  }
})

// ---------------------------------------------------------------------------
// Each of the seven named mistake classes: must FAIL AND name the right input.
// A test that only asserted "it failed" would be worthless per the task brief —
// so every assertion below pins both the check id (the input) and the reason.
// ---------------------------------------------------------------------------
test('mistake 1: missing file (identityKeyFile) -> FAIL, IDENTITY_KEY_FILE, FILE_NOT_FOUND', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    env[ENV.identityKeyFile] = path.join(material.dir, 'does-not-exist.key')
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'IDENTITY_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.FILE_NOT_FOUND)
    // no other file-based check should have been blamed for this
    assert.equal(checkById(result, 'QUALIFICATION_KEY_FILE').status, 'PASS')
    assert.equal(checkById(result, 'SIGNER_PRIVATE_KEY_FILE').status, 'PASS')
  } finally {
    cleanup(material)
  }
})

test('mistake 2: wrong key length (qualificationKeyFile) -> FAIL, QUALIFICATION_KEY_FILE, KEY_LENGTH_OUT_OF_RANGE', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const shortKeyPath = path.join(material.dir, 'too-short.key')
    fs.writeFileSync(shortKeyPath, crypto.randomBytes(10))
    env[ENV.qualificationKeyFile] = shortKeyPath
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'QUALIFICATION_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.KEY_LENGTH_OUT_OF_RANGE)
    assert.equal(checkById(result, 'IDENTITY_KEY_FILE').status, 'PASS')
  } finally {
    cleanup(material)
  }
})

test('mistake 2b: wrong key length, too long (evidenceKeyFile) -> FAIL, EVIDENCE_KEY_FILE, KEY_LENGTH_OUT_OF_RANGE', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const longKeyPath = path.join(material.dir, 'too-long.key')
    fs.writeFileSync(longKeyPath, crypto.randomBytes(256))
    env[ENV.evidenceKeyFile] = longKeyPath
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'EVIDENCE_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.KEY_LENGTH_OUT_OF_RANGE)
  } finally {
    cleanup(material)
  }
})

// ---------------------------------------------------------------------------
// Boundary proof for the hand-written KEY_LENGTH_OUT_OF_RANGE label. The
// mistake-2 tests above use 10 and 256 bytes — comfortably inside the
// failure region, so an off-by-one in diagnoseSymmetricKeyFile (e.g. `< 33`
// instead of `< 32`) would be invisible there. These four assertions sit
// exactly on the runbook's documented "32-128 random bytes" boundary, where
// a hand-written label could silently drift from the product's own
// readSymmetricKey bounds. The PASS cases additionally prove the label is
// genuinely inert on the accept side, not merely absent on the reject side.
// ---------------------------------------------------------------------------
test('key length boundary: exactly 32 bytes PASSes (runbook lower bound, inclusive)', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const boundaryKeyPath = path.join(material.dir, 'exactly-32.key')
    fs.writeFileSync(boundaryKeyPath, crypto.randomBytes(32))
    env[ENV.identityKeyFile] = boundaryKeyPath
    const result = runPreflight({ env })
    const check = checkById(result, 'IDENTITY_KEY_FILE')
    assert.equal(check.status, 'PASS')
    assert.equal(check.reason, REASON.CHECK_PASSED)
  } finally {
    cleanup(material)
  }
})

test('key length boundary: exactly 128 bytes PASSes (runbook upper bound, inclusive)', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const boundaryKeyPath = path.join(material.dir, 'exactly-128.key')
    fs.writeFileSync(boundaryKeyPath, crypto.randomBytes(128))
    env[ENV.identityKeyFile] = boundaryKeyPath
    const result = runPreflight({ env })
    const check = checkById(result, 'IDENTITY_KEY_FILE')
    assert.equal(check.status, 'PASS')
    assert.equal(check.reason, REASON.CHECK_PASSED)
  } finally {
    cleanup(material)
  }
})

test('key length boundary: exactly 31 bytes FAILs with KEY_LENGTH_OUT_OF_RANGE (one below lower bound)', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const boundaryKeyPath = path.join(material.dir, 'exactly-31.key')
    fs.writeFileSync(boundaryKeyPath, crypto.randomBytes(31))
    env[ENV.identityKeyFile] = boundaryKeyPath
    const result = runPreflight({ env })
    const check = checkById(result, 'IDENTITY_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.KEY_LENGTH_OUT_OF_RANGE)
  } finally {
    cleanup(material)
  }
})

test('key length boundary: exactly 129 bytes FAILs with KEY_LENGTH_OUT_OF_RANGE (one above upper bound)', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const boundaryKeyPath = path.join(material.dir, 'exactly-129.key')
    fs.writeFileSync(boundaryKeyPath, crypto.randomBytes(129))
    env[ENV.identityKeyFile] = boundaryKeyPath
    const result = runPreflight({ env })
    const check = checkById(result, 'IDENTITY_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.KEY_LENGTH_OUT_OF_RANGE)
  } finally {
    cleanup(material)
  }
})

test('mistake 3: wrong PEM type (RSA instead of Ed25519) -> FAIL, SIGNER_PRIVATE_KEY_FILE, PEM_WRONG_KEY_TYPE', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const rsaPemPath = path.join(material.dir, 'rsa.pem')
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    fs.writeFileSync(rsaPemPath, privateKey.export({ format: 'pem', type: 'pkcs8' }))
    env[ENV.signerPrivateKeyFile] = rsaPemPath
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'SIGNER_PRIVATE_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.PEM_WRONG_KEY_TYPE)
  } finally {
    cleanup(material)
  }
})

test('mistake 3b: PEM does not parse at all -> FAIL, SIGNER_PRIVATE_KEY_FILE, PEM_PARSE_FAILED', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const garbagePemPath = path.join(material.dir, 'garbage.pem')
    fs.writeFileSync(garbagePemPath, 'not a pem file at all\n')
    env[ENV.signerPrivateKeyFile] = garbagePemPath
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'SIGNER_PRIVATE_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.PEM_PARSE_FAILED)
  } finally {
    cleanup(material)
  }
})

test('mistake 4: non-absolute artifact root -> FAIL, ARTIFACT_ROOT, PATH_NOT_ABSOLUTE', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    env[ENV.artifactRoot] = 'relative/artifact/root'
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'ARTIFACT_ROOT')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.PATH_NOT_ABSOLUTE)
  } finally {
    cleanup(material)
  }
})

test('mistake 5: missing env var (provisioningDatabaseRole) -> FAIL, PROVISIONING_DATABASE_ROLE, ENV_VAR_UNSET', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    delete env[ENV.provisioningDatabaseRole]
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'PROVISIONING_DATABASE_ROLE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.ENV_VAR_UNSET)
    // an unrelated text field must still pass
    assert.equal(checkById(result, 'RUNTIME_DATABASE_ROLE').status, 'PASS')
  } finally {
    cleanup(material)
  }
})

test('mistake 6: non-null workspaceId (binding.workspaceId) -> FAIL, PROVISIONING_SPEC_FILE, SPEC_WORKSPACE_ID_NOT_NULL', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const spec = JSON.parse(fs.readFileSync(material.specPath, 'utf8'))
    spec.binding.workspaceId = 'not-null-workspace'
    const badSpecPath = path.join(material.dir, 'bad-workspace-spec.json')
    fs.writeFileSync(badSpecPath, JSON.stringify(spec))
    env[ENV.provisioningSpecFile] = badSpecPath
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'PROVISIONING_SPEC_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.SPEC_WORKSPACE_ID_NOT_NULL)
  } finally {
    cleanup(material)
  }
})

test('mistake 6b: non-null workspaceId (externalSystem.workspaceId) -> FAIL, PROVISIONING_SPEC_FILE, SPEC_WORKSPACE_ID_NOT_NULL', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const spec = JSON.parse(fs.readFileSync(material.specPath, 'utf8'))
    spec.externalSystem.workspaceId = 'not-null-workspace'
    const badSpecPath = path.join(material.dir, 'bad-workspace-spec-2.json')
    fs.writeFileSync(badSpecPath, JSON.stringify(spec))
    env[ENV.provisioningSpecFile] = badSpecPath
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'PROVISIONING_SPEC_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.SPEC_WORKSPACE_ID_NOT_NULL)
  } finally {
    cleanup(material)
  }
})

test('mistake 7: mismatched external-system identity -> FAIL, SPEC_EXTERNAL_SYSTEM_CONSISTENCY, first-party token', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const spec = JSON.parse(fs.readFileSync(material.specPath, 'utf8'))
    spec.externalSystem.id = 'DOES-NOT-MATCH-BINDING-EXTERNAL-SYSTEM-ID'
    const badSpecPath = path.join(material.dir, 'bad-identity-spec.json')
    fs.writeFileSync(badSpecPath, JSON.stringify(spec))
    env[ENV.provisioningSpecFile] = badSpecPath
    const result = runPreflight({ env })
    assert.equal(result.preflightPass, 'FAIL')
    const check = checkById(result, 'SPEC_EXTERNAL_SYSTEM_CONSISTENCY')
    assert.equal(check.status, 'FAIL')
    // reused verbatim from the product's own ratified failure vocabulary, not invented here
    assert.equal(check.reason, 'SEALED_EXPORT_BINDING_UNQUALIFIED')
    // the shallow shape check (PROVISIONING_SPEC_FILE) must not be tripped by this —
    // only the deeper self-consistency check should name this specific input.
    assert.equal(checkById(result, 'PROVISIONING_SPEC_FILE').status, 'PASS')
  } finally {
    cleanup(material)
  }
})

test('mistake 7b: mismatched tenantId between binding and externalSystem is also caught', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    const spec = JSON.parse(fs.readFileSync(material.specPath, 'utf8'))
    spec.externalSystem.tenantId = 'a-different-tenant-entirely'
    const badSpecPath = path.join(material.dir, 'bad-tenant-spec.json')
    fs.writeFileSync(badSpecPath, JSON.stringify(spec))
    env[ENV.provisioningSpecFile] = badSpecPath
    const result = runPreflight({ env })
    const check = checkById(result, 'SPEC_EXTERNAL_SYSTEM_CONSISTENCY')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, 'SEALED_EXPORT_BINDING_UNQUALIFIED')
  } finally {
    cleanup(material)
  }
})

// ---------------------------------------------------------------------------
// Negative control: "check could not run" must be distinguishable from
// "check failed". Point the synthetic-baseline tmpRoot at a FILE (not a
// directory) so fs.mkdtempSync deterministically throws ENOTDIR, and confirm
// every baseline-dependent isolated check reports NOT_RUN — never PASS, never
// a bare FAIL — while the baseline-INDEPENDENT checks (which don't need the
// synthetic material at all) still run for real and can still PASS.
// ---------------------------------------------------------------------------
test('negative control: baseline unavailable -> NOT_RUN (not FAIL, not PASS) for dependent checks; independent checks still run', () => {
  const material = buildGoodOperatorMaterial()
  const notADirectory = path.join(material.dir, 'this-is-a-file-not-a-directory')
  fs.writeFileSync(notADirectory, 'x')
  try {
    const env = envFromMaterial(material)
    const result = runPreflight({ env, tmpRoot: notADirectory })
    assert.equal(result.baselineAvailable, false)
    assert.equal(result.preflightPass, 'FAIL')
    assert.equal(result.exitCode, 1)

    const dependentIds = [
      'ARTIFACT_ROOT',
      'IDENTITY_KEY_FILE',
      'SIGNER_PRIVATE_KEY_FILE',
      'QUALIFICATION_KEY_ID',
      'QUALIFICATION_KEY_FILE',
      'PROVISIONING_DATABASE_ROLE',
      'PROVISIONING_DATABASE_URL',
      'PROVISIONING_SPEC_FILE',
      'EVIDENCE_KEY_FILE',
      'RUNTIME_DATABASE_ROLE',
      'RUNTIME_DATABASE_URL',
    ]
    for (const id of dependentIds) {
      const check = checkById(result, id)
      assert.equal(check.status, 'NOT_RUN', `${id} should be NOT_RUN, was ${check.status}`)
      assert.equal(check.reason, REASON.BASELINE_UNAVAILABLE)
    }

    // These do not depend on the synthetic baseline and must still produce a
    // real verdict — proving NOT_RUN above is not just "everything is broken".
    assert.equal(checkById(result, 'SPEC_EXTERNAL_SYSTEM_CONSISTENCY').status, 'PASS')
    assert.equal(checkById(result, 'AGGREGATE_PROVISIONING_CONFIG').status, 'PASS')
    assert.equal(checkById(result, 'AGGREGATE_RUNTIME_CONFIG').status, 'PASS')
  } finally {
    fs.rmSync(notADirectory, { force: true })
    cleanup(material)
  }
})

// ---------------------------------------------------------------------------
// Drift pin: the hand-written binding-draft mapping used for the
// SPEC_EXTERNAL_SYSTEM_CONSISTENCY check must produce exactly the product's
// own exported BINDING_DRAFT_FIELDS key set. If that constant is ever
// renamed/extended upstream, this test REDs instead of the check silently
// mis-diagnosing.
// ---------------------------------------------------------------------------
test('drift pin: buildDraftFromRawBinding key set matches product BINDING_DRAFT_FIELDS exactly', () => {
  const rawBinding = {
    approvedConfigVersionId: 'x',
    bindingExpiresAt: 'x',
    bindingId: 'x',
    bindingVersion: 'x',
    externalSystemId: 'x',
    signerExpiresAt: 'x',
    tableRef: 'x',
    tenantId: 'x',
    workspaceId: null,
  }
  const draft = buildDraftFromRawBinding(rawBinding)
  assert.deepEqual(Object.keys(draft).sort(), [...BINDING_DRAFT_FIELDS].sort())
})

// ---------------------------------------------------------------------------
// Values-free proof: sentinel secrets and sentinel-tagged paths must never
// appear in stdout/stderr, whether the run PASSes or FAILs. A whitelist
// projection is not proof; grepping the actual captured output for planted
// sentinels is.
// ---------------------------------------------------------------------------
test('values-free: sentinel secrets, hostnames, and temp paths never appear in CLI output (PASS case)', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = { ...process.env, ...envFromMaterial(material) }
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', env })
    const forbidden = [
      'SENTINEL-PASSWORD-DO-NOT-LEAK',
      'SENTINEL-SERVER-HOSTNAME',
      'SENTINEL-USER',
      'SENTINEL-DB-SECRET',
      'sentinel-tenant',
      'sentinel-external-system-id',
      material.dir,
      material.identityKeyPath,
      material.signerPemPath,
      material.specPath,
    ]
    for (const needle of forbidden) {
      assert.ok(!stdout.includes(needle), `stdout leaked sentinel: ${needle}`)
    }
    assert.match(stdout, /preflightPass=PASS/)
  } finally {
    cleanup(material)
  }
})

test('values-free: sentinel secrets never appear in CLI output even on FAIL', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = { ...process.env, ...envFromMaterial(material) }
    delete env[ENV.identityKeyFile]
    let stdout = ''
    let exitCode = 0
    try {
      stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', env })
    } catch (error) {
      stdout = error.stdout ?? ''
      exitCode = error.status ?? 1
    }
    const forbidden = [
      'SENTINEL-PASSWORD-DO-NOT-LEAK',
      'SENTINEL-SERVER-HOSTNAME',
      'SENTINEL-DB-SECRET',
      material.dir,
      material.specPath,
    ]
    for (const needle of forbidden) {
      assert.ok(!stdout.includes(needle), `stdout leaked sentinel: ${needle}`)
    }
    assert.match(stdout, /preflightPass=FAIL/)
    assert.notEqual(exitCode, 0)
  } finally {
    cleanup(material)
  }
})

// ---------------------------------------------------------------------------
// Subprocess tests: exercise the actual CLI entry point (not just the
// imported function), for one PASS and one FAIL case, asserting both the
// printed report and the process exit code.
// ---------------------------------------------------------------------------
test('CLI subprocess: fully-correct environment exits 0 and reports preflightPass=PASS', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = { ...process.env, ...envFromMaterial(material) }
    const stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', env })
    assert.match(stdout, /preflightPass=PASS/)
    assert.match(stdout, /ARTIFACT_ROOT: status=PASS/)
    assert.match(stdout, /artifact creation commands/)
  } finally {
    cleanup(material)
  }
})

test('CLI subprocess: broken environment exits non-zero and reports preflightPass=FAIL', () => {
  let exitCode = 0
  let stdout = ''
  try {
    stdout = execFileSync(process.execPath, [SCRIPT_PATH], { encoding: 'utf8', env: {} })
  } catch (error) {
    stdout = error.stdout ?? ''
    exitCode = error.status ?? 1
  }
  assert.notEqual(exitCode, 0)
  assert.match(stdout, /preflightPass=FAIL/)
  assert.match(stdout, /ENV_VAR_UNSET/)
})

// ---------------------------------------------------------------------------
// Runtime-only artifact (evidenceKeyFile) is genuinely exercised — it has no
// role in the provisioning-time loader at all, so this pins that coverage
// actually reaches loadStockPreparationRuntimeConfig.
// ---------------------------------------------------------------------------
test('evidenceKeyFile is checked via the runtime loader independent of provisioning fields', () => {
  const material = buildGoodOperatorMaterial()
  try {
    const env = envFromMaterial(material)
    delete env[ENV.evidenceKeyFile]
    const result = runPreflight({ env })
    const check = checkById(result, 'EVIDENCE_KEY_FILE')
    assert.equal(check.status, 'FAIL')
    assert.equal(check.reason, REASON.ENV_VAR_UNSET)
    // provisioning-only fields are untouched by this
    assert.equal(checkById(result, 'PROVISIONING_SPEC_FILE').status, 'PASS')
    assert.equal(checkById(result, 'AGGREGATE_PROVISIONING_CONFIG').status, 'PASS')
    assert.equal(checkById(result, 'AGGREGATE_RUNTIME_CONFIG').status, 'FAIL')
  } finally {
    cleanup(material)
  }
})
