#!/usr/bin/env node
'use strict'

// Stock Preparation S6-A operator preflight (offline, values-free).
//
// WHY THIS EXISTS
// ----------------
// docs/operations/stock-preparation-s6a-sqlserver-onprem-runbook-20260731.md §4
// tells the operator to create five private artifacts (identity key, evidence
// key, qualification key, Ed25519 PKCS8 signer key, provisioning spec) and
// gives zero commands. At least seven distinct operator mistakes (missing
// file, wrong key length, wrong PEM type, non-absolute artifact root, missing
// env var, non-null workspaceId, mismatched external-system identity) all
// collapse into the single opaque `SEALED_EXPORT_INTERNAL_ERROR` token, and
// were previously discoverable only inside the one non-repeatable flag-on
// window (§6).
//
// This tool does NOT re-implement any product validation rule. Every PASS/FAIL
// verdict below is produced by calling the product's own exported, pure
// (env + files, no DB, no network) validators:
//
//   plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-config.cjs
//     -> loadStockPreparationProvisioningConfig({ env })
//     -> loadStockPreparationRuntimeConfig({ env })
//     -> ENV (the env-var name table), FEATURE_FLAG
//
//   plugins/plugin-integration-core/lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs
//     -> deriveStockPreparationSqlServerSourceAnchors({ binding, externalSystem, identityKey })
//        (used only for the SPEC_EXTERNAL_SYSTEM_CONSISTENCY check below)
//
// HOW SPECIFICITY IS OBTAINED
// ---------------------------
// Both config loaders throw the exact same token for every distinct failure,
// by design (see failure-vocabulary.cjs). To get specificity without
// re-deriving the accept/reject decision, each env-var-scoped check performs
// an ISOLATED SWAP: build a synthetic, self-generated "known-good" baseline
// environment (fresh random keys, a fresh Ed25519 keypair, a synthetic
// provisioning spec — never the operator's real secrets), then substitute
// ONLY the operator's real value for the one input under test and call the
// real loader. The loader's own verdict (PASS/FAIL) is always authoritative;
// a lightweight, read-only, non-secret-revealing diagnostic (file exists?,
// byte length in range?, PEM parses as Ed25519?, path absolute?, spec JSON
// valid?, workspaceId literally null?) is used ONLY to choose a closed-set
// REASON label to attach to an already-determined FAIL — a label can never
// turn a FAIL into a PASS. Every one of those diagnostics either restates a
// fact from the runbook itself (32-128 bytes; Ed25519 PKCS8; absolute path;
// workspaceId must be JSON null) or is a generic OS/JSON primitive; none of
// them re-derive the product's own closed-key-set spec-shape rule, which is
// intentionally left to the generic VALIDATOR_REJECTED fallback.
//
// SPEC_EXTERNAL_SYSTEM_CONSISTENCY reads the operator's REAL provisioning
// spec file to check that binding.externalSystemId/tenantId/workspaceId agree
// with externalSystem.id/tenantId/workspaceId/kind/role/status (the "mismatched
// external-system identity" mistake class) via the product's own
// deriveStockPreparationSqlServerSourceAnchors. It NEVER reads
// externalSystem.config/credentials from the real file (those carry the SQL
// Server host/user/password) — a fixed, synthetic, structurally-valid
// placeholder is spliced in instead, so this check cannot be tripped by (or
// leak) real connection material. It cannot verify that the declared
// external-system record matches whatever is approved server-side in the
// database — that comparison happens only during the live, DB-connected
// provisioning run and is out of reach for an offline tool (see NOT_RUN
// handling below).
//
// Hard rules honoured throughout: read-only w.r.t. plugins/packages; no DB;
// no network; never print a secret, file content, connection string,
// credential, or a path that could contain one — only fixed env-var NAMES
// (which are public, non-secret, and already named in the runbook) and
// closed-set reason tokens are ever written to stdout.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const RUNTIME_CONFIG_MODULE_PATH = path.join(
  REPO_ROOT,
  'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-config.cjs',
)
const SOURCE_AUTHORITY_MODULE_PATH = path.join(
  REPO_ROOT,
  'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-sqlserver-source-authority.cjs',
)
const RUNTIME_STORE_MODULE_PATH = path.join(
  REPO_ROOT,
  'plugins/plugin-integration-core/lib/sealed-export/stock-preparation-runtime-store.cjs',
)
const FAILURE_VOCABULARY_MODULE_PATH = path.join(
  REPO_ROOT,
  'plugins/plugin-integration-core/lib/sealed-export/failure-vocabulary.cjs',
)

const {
  ENV,
  FEATURE_FLAG,
  loadStockPreparationProvisioningConfig,
  loadStockPreparationRuntimeConfig,
} = require(RUNTIME_CONFIG_MODULE_PATH)

const {
  BINDING_DRAFT_FIELDS,
  CANONICAL_OBJECT_VERSION,
  CONNECTOR_KIND,
  deriveStockPreparationSqlServerSourceAnchors,
} = require(SOURCE_AUTHORITY_MODULE_PATH)

const { OBJECT_KEY, RELATION_ID } = require(RUNTIME_STORE_MODULE_PATH)

const { isTrustedSealedExportError } = require(FAILURE_VOCABULARY_MODULE_PATH)

// ---------------------------------------------------------------------------
// Closed-set reason tokens this tool ever emits, beyond a first-party
// SEALED_EXPORT_* token surfaced verbatim from a trusted product error.
// ---------------------------------------------------------------------------
const REASON = Object.freeze({
  BASELINE_UNAVAILABLE: 'BASELINE_UNAVAILABLE',
  CHECK_PASSED: 'CHECK_PASSED',
  ENV_VAR_UNSET: 'ENV_VAR_UNSET',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  JSON_INVALID: 'JSON_INVALID',
  KEY_LENGTH_OUT_OF_RANGE: 'KEY_LENGTH_OUT_OF_RANGE',
  PATH_NOT_ABSOLUTE: 'PATH_NOT_ABSOLUTE',
  PEM_PARSE_FAILED: 'PEM_PARSE_FAILED',
  PEM_WRONG_KEY_TYPE: 'PEM_WRONG_KEY_TYPE',
  PREREQUISITE_CHECK_FAILED: 'PREREQUISITE_CHECK_FAILED',
  SPEC_WORKSPACE_ID_NOT_NULL: 'SPEC_WORKSPACE_ID_NOT_NULL',
  VALIDATOR_REJECTED: 'VALIDATOR_REJECTED',
})

const SYNTHETIC_SOURCE_CONFIG = Object.freeze({
  sealedSnapshotSqlServer: Object.freeze({
    database: 'preflight-synthetic-database',
    encrypt: true,
    instanceName: null,
    port: 1433,
    server: 'preflight-synthetic-server',
    trustServerCertificate: false,
  }),
})
const SYNTHETIC_SOURCE_CREDENTIALS = Object.freeze({
  sealedSnapshotSqlServer: Object.freeze({
    password: 'preflight-synthetic-password',
    user: 'preflight-synthetic-user',
  }),
})

function notRun(id, envVar, reason) {
  return Object.freeze({ id, envVar, reason, status: 'NOT_RUN' })
}

function passed(id, envVar) {
  return Object.freeze({ id, envVar, reason: REASON.CHECK_PASSED, status: 'PASS' })
}

function failed(id, envVar, reason) {
  return Object.freeze({ id, envVar, reason, status: 'FAIL' })
}

function reasonFromError(error, fallback = REASON.VALIDATOR_REJECTED) {
  return isTrustedSealedExportError(error) && typeof error.reason === 'string'
    ? error.reason
    : fallback
}

// ---------------------------------------------------------------------------
// Read-only, non-secret-revealing diagnostics. Each returns a label or null.
// A label is NEVER used to decide PASS — only to explain an already-thrown
// FAIL from the real loader. See the module header for the provenance of
// each rule (runbook text vs. generic OS/JSON primitive).
// ---------------------------------------------------------------------------
function statOrNull(filePath) {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function diagnoseSymmetricKeyFile(filePath) {
  const stat = statOrNull(filePath)
  if (!stat || !stat.isFile()) return REASON.FILE_NOT_FOUND
  if (stat.size < 32 || stat.size > 128) return REASON.KEY_LENGTH_OUT_OF_RANGE
  return null
}

function diagnoseSignerPemFile(filePath) {
  const stat = statOrNull(filePath)
  if (!stat || !stat.isFile() || stat.size < 1) return REASON.FILE_NOT_FOUND
  if (stat.size > 16 * 1024) return null
  let privateKey
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(filePath))
  } catch {
    return REASON.PEM_PARSE_FAILED
  }
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    return REASON.PEM_WRONG_KEY_TYPE
  }
  return null
}

function diagnoseProvisioningSpecFile(filePath) {
  const stat = statOrNull(filePath)
  if (!stat || !stat.isFile() || stat.size < 1) return REASON.FILE_NOT_FOUND
  if (stat.size > 64 * 1024) return null
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return REASON.JSON_INVALID
  }
  if (
    parsed
    && typeof parsed === 'object'
    && parsed.binding
    && typeof parsed.binding === 'object'
    && parsed.externalSystem
    && typeof parsed.externalSystem === 'object'
    && (parsed.binding.workspaceId !== null || parsed.externalSystem.workspaceId !== null)
  ) {
    return REASON.SPEC_WORKSPACE_ID_NOT_NULL
  }
  return null
}

function diagnoseArtifactRoot(value) {
  if (!path.isAbsolute(value)) return REASON.PATH_NOT_ABSOLUTE
  return null
}

// ---------------------------------------------------------------------------
// Synthetic ("known-good") baseline material. Self-generated, in-memory or in
// a throwaway temp directory — never the operator's real secrets.
// ---------------------------------------------------------------------------
function buildBaselineMaterial(tmpRoot) {
  const tempDir = fs.mkdtempSync(path.join(tmpRoot, 'ms-s6a-preflight-'))
  const identityKeyPath = path.join(tempDir, 'identity.key')
  const evidenceKeyPath = path.join(tempDir, 'evidence.key')
  const qualificationKeyPath = path.join(tempDir, 'qualification.key')
  const signerPemPath = path.join(tempDir, 'signer.pem')
  const specPath = path.join(tempDir, 'provisioning-spec.json')

  fs.writeFileSync(identityKeyPath, crypto.randomBytes(64))
  fs.writeFileSync(evidenceKeyPath, crypto.randomBytes(64))
  fs.writeFileSync(qualificationKeyPath, crypto.randomBytes(64))

  const { privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(signerPemPath, privateKey.export({ format: 'pem', type: 'pkcs8' }))

  const nowPlusHour = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const spec = {
    binding: {
      approvedConfigVersionId: 'preflight-synthetic-config-version',
      bindingExpiresAt: nowPlusHour,
      bindingId: 'preflight-synthetic-binding-id',
      bindingVersion: 'preflight-synthetic-binding-version',
      externalSystemId: 'preflight-synthetic-external-system-id',
      signerExpiresAt: nowPlusHour,
      tableRef: 'dbo.PreflightSyntheticTable',
      tenantId: 'preflight-synthetic-tenant',
      workspaceId: null,
    },
    externalSystem: {
      config: {},
      credentials: {},
      id: 'preflight-synthetic-external-system-id',
      kind: 'preflight-synthetic-kind',
      role: 'preflight-synthetic-role',
      status: 'preflight-synthetic-status',
      tenantId: 'preflight-synthetic-tenant',
      workspaceId: null,
    },
  }
  fs.writeFileSync(specPath, JSON.stringify(spec))

  return Object.freeze({
    evidenceKeyPath,
    identityKeyPath,
    qualificationKeyPath,
    signerPemPath,
    specPath,
    tempDir,
  })
}

function buildBaselineEnvs(material) {
  const provisioning = {
    [ENV.artifactRoot]: material.tempDir,
    [ENV.identityKeyFile]: material.identityKeyPath,
    [ENV.provisioningDatabaseRole]: 'preflight_synthetic_provisioning_role',
    [ENV.provisioningDatabaseUrl]: 'postgres://preflight:synthetic@127.0.0.1:5432/preflight_synthetic',
    [ENV.provisioningSpecFile]: material.specPath,
    [ENV.qualificationKeyFile]: material.qualificationKeyPath,
    [ENV.qualificationKeyId]: 'preflight-synthetic-key-id',
    [ENV.signerPrivateKeyFile]: material.signerPemPath,
  }
  const runtime = {
    [ENV.artifactRoot]: material.tempDir,
    [ENV.evidenceKeyFile]: material.evidenceKeyPath,
    [ENV.identityKeyFile]: material.identityKeyPath,
    [ENV.qualificationKeyFile]: material.qualificationKeyPath,
    [ENV.qualificationKeyId]: 'preflight-synthetic-key-id',
    [ENV.runtimeDatabaseRole]: 'preflight_synthetic_runtime_role',
    [ENV.runtimeDatabaseUrl]: 'postgres://preflight:synthetic@127.0.0.1:5432/preflight_synthetic_runtime',
    [ENV.signerPrivateKeyFile]: material.signerPemPath,
    [FEATURE_FLAG]: 'true',
  }
  return { provisioning, runtime }
}

// ---------------------------------------------------------------------------
// One isolated-swap check: substitute the operator's real value for ONE env
// var into an otherwise-synthetic-good environment, then call the real
// loader. The loader's throw/no-throw is authoritative for PASS/FAIL.
// ---------------------------------------------------------------------------
function isolatedFieldCheck({ id, envVarName, baselineEnv, loaderFn, diagnose, realEnv }) {
  const realValue = realEnv[envVarName]
  const unset = realValue === undefined || realValue === ''
  const label = unset ? REASON.ENV_VAR_UNSET : diagnose ? diagnose(realValue) : null

  const candidateEnv = { ...baselineEnv }
  if (unset) {
    delete candidateEnv[envVarName]
  } else {
    candidateEnv[envVarName] = realValue
  }

  try {
    loaderFn({ env: candidateEnv })
    return passed(id, envVarName)
  } catch (error) {
    return failed(id, envVarName, label || reasonFromError(error))
  }
}

// ---------------------------------------------------------------------------
// Whole-env aggregate checks — run the real loaders against the REAL,
// unmodified environment. These do not depend on synthetic baseline material
// at all, so they remain informative even when baseline construction fails.
// ---------------------------------------------------------------------------
function aggregateCheck(id, envVarLabel, run) {
  try {
    run()
    return passed(id, envVarLabel)
  } catch (error) {
    return failed(id, envVarLabel, reasonFromError(error))
  }
}

// ---------------------------------------------------------------------------
// SPEC_EXTERNAL_SYSTEM_CONSISTENCY — mistake class "mismatched external-
// system identity". Reads the REAL provisioning spec file's binding +
// externalSystem IDENTITY fields only; config/credentials are never read from
// it (a fixed synthetic placeholder is spliced in instead).
// ---------------------------------------------------------------------------
function buildDraftFromRawBinding(rawBinding) {
  // Mirrors plugins/plugin-integration-core/scripts/provision-stock-preparation-
  // sqlserver-sealed-snapshot.cjs's caller, stock-preparation-runtime-provisioning
  // .cjs:60-71 exactly (same field mapping, same constants). Pinned by a test that
  // asserts this key set equals the product's own exported BINDING_DRAFT_FIELDS.
  return Object.freeze({
    approvedConfigVersionId: rawBinding.approvedConfigVersionId,
    bindingVersion: rawBinding.bindingVersion,
    canonicalObjectVersion: CANONICAL_OBJECT_VERSION,
    externalSystemId: rawBinding.externalSystemId,
    objectKey: OBJECT_KEY,
    relationId: RELATION_ID,
    tableRef: rawBinding.tableRef,
    tenantId: rawBinding.tenantId,
    workspaceId: rawBinding.workspaceId,
  })
}

function specExternalSystemConsistencyCheck(realEnv) {
  const id = 'SPEC_EXTERNAL_SYSTEM_CONSISTENCY'
  const envVarName = ENV.provisioningSpecFile
  const specPath = realEnv[envVarName]
  if (!specPath) return notRun(id, envVarName, REASON.PREREQUISITE_CHECK_FAILED)

  const stat = statOrNull(specPath)
  if (!stat || !stat.isFile() || stat.size < 1 || stat.size > 64 * 1024) {
    return notRun(id, envVarName, REASON.PREREQUISITE_CHECK_FAILED)
  }

  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(specPath, 'utf8'))
  } catch {
    return notRun(id, envVarName, REASON.PREREQUISITE_CHECK_FAILED)
  }

  if (
    !parsed
    || typeof parsed !== 'object'
    || !parsed.binding
    || typeof parsed.binding !== 'object'
    || !parsed.externalSystem
    || typeof parsed.externalSystem !== 'object'
  ) {
    return notRun(id, envVarName, REASON.PREREQUISITE_CHECK_FAILED)
  }

  const draft = buildDraftFromRawBinding(parsed.binding)
  // IDENTITY fields only. config/credentials — which carry the real SQL
  // Server host/user/password — are intentionally never read off `parsed`.
  const splicedExternalSystem = Object.freeze({
    config: SYNTHETIC_SOURCE_CONFIG,
    credentials: SYNTHETIC_SOURCE_CREDENTIALS,
    id: parsed.externalSystem.id,
    kind: parsed.externalSystem.kind,
    role: parsed.externalSystem.role,
    status: parsed.externalSystem.status,
    tenantId: parsed.externalSystem.tenantId,
    workspaceId: parsed.externalSystem.workspaceId,
  })
  parsed = null // drop the reference to the real, credential-bearing parse tree

  const identityKey = crypto.randomBytes(32)
  try {
    // The return value carries the spliced (synthetic) connectionConfig only,
    // never real credentials — but it is still discarded unread on principle.
    deriveStockPreparationSqlServerSourceAnchors({
      binding: draft,
      externalSystem: splicedExternalSystem,
      identityKey,
    })
    return passed(id, envVarName)
  } catch (error) {
    return failed(id, envVarName, reasonFromError(error))
  }
}

// ---------------------------------------------------------------------------
// Top-level orchestration.
// ---------------------------------------------------------------------------
function runPreflight({ env = process.env, tmpRoot = os.tmpdir() } = {}) {
  const checks = []
  let material = null
  let baselineEnvs = null
  let baselineError = null

  try {
    material = buildBaselineMaterial(tmpRoot)
    baselineEnvs = buildBaselineEnvs(material)
    // Positive control: the synthetic baseline itself must satisfy the real
    // loaders before any isolated-swap result can be trusted.
    loadStockPreparationProvisioningConfig({ env: baselineEnvs.provisioning })
    loadStockPreparationRuntimeConfig({ env: baselineEnvs.runtime })
  } catch (error) {
    baselineError = error
    baselineEnvs = null
  }

  const provisioningFieldChecks = [
    { diagnose: diagnoseArtifactRoot, envVarName: ENV.artifactRoot, id: 'ARTIFACT_ROOT' },
    { diagnose: diagnoseSymmetricKeyFile, envVarName: ENV.identityKeyFile, id: 'IDENTITY_KEY_FILE' },
    { diagnose: diagnoseSignerPemFile, envVarName: ENV.signerPrivateKeyFile, id: 'SIGNER_PRIVATE_KEY_FILE' },
    { diagnose: null, envVarName: ENV.qualificationKeyId, id: 'QUALIFICATION_KEY_ID' },
    { diagnose: diagnoseSymmetricKeyFile, envVarName: ENV.qualificationKeyFile, id: 'QUALIFICATION_KEY_FILE' },
    { diagnose: null, envVarName: ENV.provisioningDatabaseRole, id: 'PROVISIONING_DATABASE_ROLE' },
    { diagnose: null, envVarName: ENV.provisioningDatabaseUrl, id: 'PROVISIONING_DATABASE_URL' },
    { diagnose: diagnoseProvisioningSpecFile, envVarName: ENV.provisioningSpecFile, id: 'PROVISIONING_SPEC_FILE' },
  ]
  for (const spec of provisioningFieldChecks) {
    if (!baselineEnvs) {
      checks.push(notRun(spec.id, spec.envVarName, REASON.BASELINE_UNAVAILABLE))
      continue
    }
    checks.push(
      isolatedFieldCheck({
        baselineEnv: baselineEnvs.provisioning,
        diagnose: spec.diagnose,
        envVarName: spec.envVarName,
        id: spec.id,
        loaderFn: loadStockPreparationProvisioningConfig,
        realEnv: env,
      }),
    )
  }

  const runtimeFieldChecks = [
    { diagnose: diagnoseSymmetricKeyFile, envVarName: ENV.evidenceKeyFile, id: 'EVIDENCE_KEY_FILE' },
    { diagnose: null, envVarName: ENV.runtimeDatabaseRole, id: 'RUNTIME_DATABASE_ROLE' },
    { diagnose: null, envVarName: ENV.runtimeDatabaseUrl, id: 'RUNTIME_DATABASE_URL' },
  ]
  for (const spec of runtimeFieldChecks) {
    if (!baselineEnvs) {
      checks.push(notRun(spec.id, spec.envVarName, REASON.BASELINE_UNAVAILABLE))
      continue
    }
    checks.push(
      isolatedFieldCheck({
        baselineEnv: baselineEnvs.runtime,
        diagnose: spec.diagnose,
        envVarName: spec.envVarName,
        id: spec.id,
        loaderFn: loadStockPreparationRuntimeConfig,
        realEnv: env,
      }),
    )
  }

  checks.push(specExternalSystemConsistencyCheck(env))

  checks.push(
    aggregateCheck('AGGREGATE_PROVISIONING_CONFIG', 'AGGREGATE', () => {
      loadStockPreparationProvisioningConfig({ env })
    }),
  )
  checks.push(
    aggregateCheck('AGGREGATE_RUNTIME_CONFIG', 'AGGREGATE', () => {
      loadStockPreparationRuntimeConfig({ env: { ...env, [FEATURE_FLAG]: 'true' } })
    }),
  )

  if (material) {
    try {
      fs.rmSync(material.tempDir, { force: true, recursive: true })
    } catch {
      // best-effort cleanup of our own throwaway synthetic material
    }
  }

  const preflightPass = checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL'
  const exitCode = preflightPass === 'PASS' ? 0 : 1
  return Object.freeze({
    baselineAvailable: Boolean(baselineEnvs),
    baselineErrorSeen: Boolean(baselineError),
    checks: Object.freeze(checks),
    exitCode,
    preflightPass,
  })
}

function formatReport(result) {
  const lines = result.checks.map(
    (check) => `${check.id}: status=${check.status} envVar=${check.envVar} reason=${check.reason}`,
  )
  lines.push(`preflightPass=${result.preflightPass}`)
  return lines.join('\n')
}

function buildArtifactGuidance() {
  const specTemplate = {
    binding: {
      approvedConfigVersionId: '<FILL_IN>',
      bindingExpiresAt: '<FILL_IN ISO-8601 timestamp>',
      bindingId: '<FILL_IN>',
      bindingVersion: '<FILL_IN>',
      externalSystemId: '<FILL_IN — must equal externalSystem.id below>',
      signerExpiresAt: '<FILL_IN ISO-8601 timestamp>',
      tableRef: '<FILL_IN>',
      tenantId: '<FILL_IN — must equal externalSystem.tenantId below>',
      workspaceId: null,
    },
    externalSystem: {
      config: {
        sealedSnapshotSqlServer: {
          database: '<FILL_IN>',
          encrypt: true,
          instanceName: null,
          port: 1433,
          server: '<FILL_IN>',
          trustServerCertificate: false,
        },
      },
      credentials: {
        sealedSnapshotSqlServer: {
          password: '<FILL_IN — dedicated SELECT-only login, never the DBA/setup credential>',
          user: '<FILL_IN>',
        },
      },
      id: '<FILL_IN — must equal binding.externalSystemId above>',
      kind: CONNECTOR_KIND,
      role: 'source',
      status: 'active',
      tenantId: '<FILL_IN — must equal binding.tenantId above>',
      workspaceId: null,
    },
  }

  return [
    '=== S6-A private artifact creation commands (runbook §4) ===',
    'Values-free placeholders only. Pick absolute paths OUTSIDE the repo/package,',
    'restrict ACL to the service/provisioning identities, and never print their contents.',
    '',
    '1) identity key (32-128 random bytes):',
    '   openssl rand -out /absolute/path/identity.key 64',
    '',
    '2) evidence key (32-128 random bytes):',
    '   openssl rand -out /absolute/path/evidence.key 64',
    '',
    '3) qualification key (32-128 random bytes):',
    '   openssl rand -out /absolute/path/qualification.key 64',
    '',
    '4) signer key (Ed25519 PKCS8 private PEM):',
    '   openssl genpkey -algorithm ed25519 -out /absolute/path/signer.pem',
    '   # Cross-platform alternative if openssl is unavailable (e.g. Windows):',
    "   node -e \"const {privateKey}=require('crypto').generateKeyPairSync('ed25519');process.stdout.write(privateKey.export({type:'pkcs8',format:'pem'}))\" > /absolute/path/signer.pem",
    '   # `ssh-keygen -t ed25519` produces an OpenSSH-format key, NOT PKCS8 — it',
    "   # will fail this runtime's PEM check. Do not use ssh-keygen for this artifact.",
    '',
    '5) provisioning spec (strict JSON; both workspaceId fields MUST be JSON null):',
    '   Save as UTF-8 JSON at the path named by',
    '   ' + ENV.provisioningSpecFile + ':',
    JSON.stringify(specTemplate, null, 2),
  ].join('\n')
}

const isMain = (() => {
  try {
    return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

function main() {
  const result = runPreflight({ env: process.env })
  process.stdout.write(formatReport(result))
  process.stdout.write('\n\n')
  process.stdout.write(buildArtifactGuidance())
  process.stdout.write('\n')
  process.exitCode = result.exitCode
}

if (isMain) {
  main()
}

export {
  REASON,
  buildArtifactGuidance,
  buildDraftFromRawBinding,
  diagnoseArtifactRoot,
  diagnoseProvisioningSpecFile,
  diagnoseSignerPemFile,
  diagnoseSymmetricKeyFile,
  formatReport,
  runPreflight,
}
