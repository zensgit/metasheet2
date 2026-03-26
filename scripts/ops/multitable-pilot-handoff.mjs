import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const pilotRunMode = process.env.PILOT_RUN_MODE === 'staging' ? 'staging' : 'local'
const readinessRootName = pilotRunMode === 'staging'
  ? 'multitable-pilot-ready-staging'
  : 'multitable-pilot-ready-local'
const handoffRootName = pilotRunMode === 'staging'
  ? 'multitable-pilot-handoff-staging'
  : 'multitable-pilot-handoff'
const ROOT = path.join(repoRoot, 'output/playwright', readinessRootName)
const RELEASE_ROOT = path.join(repoRoot, 'output/releases/multitable-onprem')
const DELIVERY_ROOT = path.join(repoRoot, 'output/delivery/multitable-onprem')
const RELEASE_GATE_ROOT = path.join(repoRoot, 'output/releases/multitable-onprem/gates')
const outputRoot = process.env.HANDOFF_OUTPUT_ROOT || path.join(repoRoot, 'output/playwright', handoffRootName)
const sourceRoot = process.env.READINESS_ROOT || ''
const onPremGateReportOverride = process.env.ONPREM_GATE_REPORT_JSON || ''
const requireOnPremGate = process.env.REQUIRE_ONPREM_GATE === 'true'
const requireExplicitOnPremGate = process.env.REQUIRE_EXPLICIT_ONPREM_GATE === 'true'

const runbookPath = path.join(repoRoot, 'docs/deployment/multitable-internal-pilot-runbook-20260319.md')
const quickstartPath = path.join(repoRoot, 'docs/deployment/multitable-pilot-quickstart-20260319.md')
const feedbackTemplatePath = path.join(repoRoot, 'docs/deployment/multitable-pilot-feedback-template-20260319.md')
const teamChecklistPath = path.join(repoRoot, 'docs/deployment/multitable-pilot-team-checklist-20260319.md')
const dailyTriageTemplatePath = path.join(repoRoot, 'docs/deployment/multitable-pilot-daily-triage-template-20260319.md')
const goNoGoTemplatePath = path.join(repoRoot, 'docs/deployment/multitable-pilot-go-no-go-template-20260319.md')
const pilotExpansionDecisionTemplatePath = path.join(repoRoot, 'docs/deployment/multitable-pilot-expansion-decision-template-20260323.md')
const uatSignoffTemplatePath = path.join(repoRoot, 'docs/deployment/multitable-uat-signoff-template-20260323.md')
const customerDeliverySignoffTemplatePath = path.join(repoRoot, 'docs/deployment/multitable-customer-delivery-signoff-template-20260323.md')
const issueTemplatePath = path.join(repoRoot, '.github/ISSUE_TEMPLATE/multitable-pilot-feedback.yml')
const defaultPreflightReportJson = '/opt/metasheet/output/preflight/multitable-onprem-preflight.json'
const defaultPreflightReportMd = '/opt/metasheet/output/preflight/multitable-onprem-preflight.md'

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readOptionalJsonFile(filePath) {
  if (!(await exists(filePath))) return null
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

function summarizeEmbedEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return {
      available: false,
      ok: true,
      requiredWhenPresent: [],
      observedChecks: [],
      missingChecks: [],
    }
  }
  return {
    available: Boolean(evidence.available),
    ok: Boolean(evidence.ok),
    requiredWhenPresent: Array.isArray(evidence.requiredWhenPresent) ? evidence.requiredWhenPresent : [],
    observedChecks: Array.isArray(evidence.observedChecks) ? evidence.observedChecks : [],
    missingChecks: Array.isArray(evidence.missingChecks) ? evidence.missingChecks : [],
  }
}

function summarizeLocalRunner(localRunner) {
  if (!localRunner || typeof localRunner !== 'object') {
    return {
      required: false,
      available: false,
      ok: true,
      runMode: 'local',
      report: null,
      reportMd: null,
      runnerReport: null,
      serviceModes: {
        backend: 'unknown',
        web: 'unknown',
      },
      embedHostAcceptance: {
        available: false,
        ok: true,
      },
    }
  }
  return {
    required: Boolean(localRunner.required),
    available: Boolean(localRunner.available),
    ok: localRunner.ok !== false,
    runMode: typeof localRunner.runMode === 'string' && localRunner.runMode ? localRunner.runMode : 'local',
    report: typeof localRunner.report === 'string' ? localRunner.report : null,
    reportMd: typeof localRunner.reportMd === 'string' ? localRunner.reportMd : null,
    runnerReport: typeof localRunner.runnerReport === 'string' ? localRunner.runnerReport : null,
    serviceModes: {
      backend: localRunner?.serviceModes?.backend ?? 'unknown',
      web: localRunner?.serviceModes?.web ?? 'unknown',
    },
    embedHostAcceptance: {
      available: Boolean(localRunner?.embedHostAcceptance?.available),
      ok: localRunner?.embedHostAcceptance?.ok !== false,
    },
  }
}

function embedEvidenceSection(title, evidence) {
  return [
    title,
    '',
    `- Available in readiness: \`${evidence.available ? 'true' : 'false'}\``,
    `- Status: **${evidence.ok ? 'PASS' : 'FAIL'}**`,
    evidence.requiredWhenPresent.length
      ? `- Required when present: ${evidence.requiredWhenPresent.map((item) => `\`${item}\``).join(', ')}`
      : '- Required when present: none',
    evidence.observedChecks.length
      ? `- Observed checks: ${evidence.observedChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Observed checks: none',
    evidence.missingChecks.length
      ? `- Missing checks: ${evidence.missingChecks.map((item) => `\`${item}\``).join(', ')}`
      : '- Missing checks: none',
    '',
  ]
}

async function resolveLatestReadinessRoot() {
  if (sourceRoot) return path.resolve(sourceRoot)
  const entries = await fs.readdir(ROOT, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const latest = dirs.at(-1)
  if (!latest) {
    throw new Error(`No readiness runs found under ${ROOT}`)
  }
  return path.join(ROOT, latest)
}

async function resolveLatestReleasePackage() {
  const entries = await fs.readdir(RELEASE_ROOT, { withFileTypes: true })
  const jsonFiles = entries
    .filter((entry) =>
      entry.isFile() &&
      entry.name.startsWith('metasheet-multitable-onprem-') &&
      entry.name.endsWith('.json') &&
      !entry.name.endsWith('.verify.json') &&
      !entry.name.endsWith('.build-report.json'),
    )
    .map((entry) => entry.name)
    .sort()
  const latest = jsonFiles.at(-1)
  if (!latest) {
    throw new Error(`No on-prem release metadata found under ${RELEASE_ROOT}`)
  }
  const releaseJsonPath = path.join(RELEASE_ROOT, latest)
  const raw = JSON.parse(await fs.readFile(releaseJsonPath, 'utf8'))
  const packageName = raw?.name
  if (!packageName) {
    throw new Error(`Release metadata missing package name: ${releaseJsonPath}`)
  }
  const releasePackageRoot = path.join(RELEASE_ROOT, '.build', packageName, packageName)
  const deliveryBundleRoot = path.join(DELIVERY_ROOT, packageName)
  return {
    packageName,
    releaseJsonPath,
    releasePackageRoot,
    deliveryBundleRoot,
    releaseMetadata: raw,
  }
}

async function resolveLatestOnPremGate() {
  if (requireExplicitOnPremGate && !onPremGateReportOverride) {
    throw new Error('REQUIRE_EXPLICIT_ONPREM_GATE=true requires ONPREM_GATE_REPORT_JSON')
  }
  const explicit = onPremGateReportOverride ? path.resolve(onPremGateReportOverride) : null
  const reportPath = explicit || await (async () => {
    try {
      const entries = await fs.readdir(RELEASE_GATE_ROOT, { withFileTypes: true })
      const dirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      const latest = dirs.at(-1)
      if (!latest) return null
      return path.join(RELEASE_GATE_ROOT, latest, 'report.json')
    } catch {
      return null
    }
  })()
  if (!reportPath || !(await exists(reportPath))) return null
  const raw = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  const gateRoot = path.dirname(reportPath)
  return {
    reportPath,
    reportMdPath: path.join(gateRoot, 'report.md'),
    operatorCommandsPath: path.join(gateRoot, 'operator-commands.sh'),
    logsRoot: path.join(gateRoot, 'logs'),
    packageName: raw?.packageName ?? null,
    packageJson: raw?.packageJson ? path.resolve(raw.packageJson) : null,
    raw,
  }
}

async function safeCopy(from, to) {
  if (!(await exists(from))) return false
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  return true
}

async function writeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  await fs.chmod(filePath, 0o755)
}

function rel(filePath) {
  return path.relative(process.cwd(), filePath) || '.'
}

async function main() {
  const readinessRoot = await resolveLatestReadinessRoot()
  const onPremGate = await resolveLatestOnPremGate()
  if (requireOnPremGate && !onPremGate) {
    throw new Error('REQUIRE_ONPREM_GATE=true but no on-prem release gate report was found')
  }
  const release = onPremGate?.packageJson && await exists(onPremGate.packageJson)
    ? await (async () => {
      const raw = JSON.parse(await fs.readFile(onPremGate.packageJson, 'utf8'))
      const packageName = raw?.name
      if (!packageName) throw new Error(`On-prem gate package metadata missing name: ${onPremGate.packageJson}`)
      return {
        packageName,
        releaseJsonPath: onPremGate.packageJson,
        releasePackageRoot: path.join(RELEASE_ROOT, '.build', packageName, packageName),
        deliveryBundleRoot: path.join(DELIVERY_ROOT, packageName),
        releaseMetadata: raw,
      }
    })()
    : await resolveLatestReleasePackage()
  const stamp = path.basename(readinessRoot)
  const handoffRoot = path.join(outputRoot, stamp)

  await fs.mkdir(handoffRoot, { recursive: true })

  const readinessMd = path.join(readinessRoot, 'readiness.md')
  const readinessJson = path.join(readinessRoot, 'readiness.json')
  const readinessGateReport = path.join(readinessRoot, 'gates', 'report.json')
  const readinessGateReportMd = path.join(readinessRoot, 'gates', 'report.md')
  const readinessGateLog = path.join(readinessRoot, 'gates', 'release-gate.log')
  const readinessGateOperatorCommands = path.join(readinessRoot, 'gates', 'operator-commands.sh')
  const smokeReport = path.join(readinessRoot, 'smoke', 'report.json')
  const smokeReportMd = path.join(readinessRoot, 'smoke', 'report.md')
  const profileReport = path.join(readinessRoot, 'profile', 'report.json')
  const profileSummary = path.join(readinessRoot, 'profile', 'summary.md')
  const smokeGridImport = path.join(readinessRoot, 'smoke', 'grid-import.png')
  const smokeImportMappingReconcile = path.join(readinessRoot, 'smoke', 'import-mapping-reconcile.png')
  const smokeImportPeopleRepairReconcile = path.join(readinessRoot, 'smoke', 'import-people-repair-reconcile.png')
  const smokeGridImportPeopleManualFix = path.join(readinessRoot, 'smoke', 'grid-import-people-manual-fix.png')
  const smokeGridHydrated = path.join(readinessRoot, 'smoke', 'grid-hydrated.png')
  const smokeFormComments = path.join(readinessRoot, 'smoke', 'form-comments.png')
  const smokeFieldManagerPropReconcile = path.join(readinessRoot, 'smoke', 'field-manager-prop-reconcile.png')
  const smokeFieldManagerTypeReconcile = path.join(readinessRoot, 'smoke', 'field-manager-type-reconcile.png')
  const smokeFieldManagerTargetRemoval = path.join(readinessRoot, 'smoke', 'field-manager-target-removal.png')
  const smokeViewManagerPropReconcile = path.join(readinessRoot, 'smoke', 'view-manager-prop-reconcile.png')
  const smokeViewManagerFieldSchemaReconcile = path.join(readinessRoot, 'smoke', 'view-manager-field-schema-reconcile.png')
  const smokeViewManagerTargetRemoval = path.join(readinessRoot, 'smoke', 'view-manager-target-removal.png')
  const releaseJson = release.releaseJsonPath
  const releaseTgz = path.join(RELEASE_ROOT, `${release.packageName}.tgz`)
  const releaseZip = path.join(RELEASE_ROOT, `${release.packageName}.zip`)
  const releaseTgzSha = `${releaseTgz}.sha256`
  const releaseZipSha = `${releaseZip}.sha256`
  const releaseChecksumIndex = path.join(RELEASE_ROOT, 'SHA256SUMS')
  const deliveryJson = path.join(release.deliveryBundleRoot, 'DELIVERY.json')
  const deliveryMd = path.join(release.deliveryBundleRoot, 'DELIVERY.md')
  const onPremGateReportJson = onPremGate?.reportPath ?? null
  const onPremGateReportMd = onPremGate?.reportMdPath ?? null
  const onPremGateOperatorCommands = onPremGate?.operatorCommandsPath ?? null
  const onPremGateBuildLog = onPremGate ? path.join(onPremGate.logsRoot, 'build.log') : null
  const onPremGateVerifyTgzLog = onPremGate ? path.join(onPremGate.logsRoot, 'verify-tgz.log') : null
  const onPremGateVerifyZipLog = onPremGate ? path.join(onPremGate.logsRoot, 'verify-zip.log') : null
  const onPremGateDeliveryLog = onPremGate ? path.join(onPremGate.logsRoot, 'delivery.log') : null
  const packageVerifyScript = path.join(repoRoot, 'scripts/ops/multitable-onprem-package-verify.sh')
  const onPremReleaseGateScript = path.join(repoRoot, 'scripts/ops/multitable-onprem-release-gate.sh')
  const deployEasyScript = path.join(release.releasePackageRoot, 'scripts/ops/multitable-onprem-deploy-easy.sh')
  const packageInstallScript = path.join(release.releasePackageRoot, 'scripts/ops/multitable-onprem-package-install.sh')
  const healthcheckScript = path.join(release.releasePackageRoot, 'scripts/ops/multitable-onprem-healthcheck.sh')
  const preflightScript = path.join(repoRoot, 'scripts/ops/multitable-onprem-preflight.sh')
  const repairHelperScript = path.join(repoRoot, 'scripts/ops/multitable-onprem-repair-helper.sh')
  const healthcheckService = path.join(release.releasePackageRoot, 'ops/systemd/metasheet-healthcheck.service.example')
  const healthcheckTimer = path.join(release.releasePackageRoot, 'ops/systemd/metasheet-healthcheck.timer.example')
  const packageInstallEnvTemplate = [
    '#!/usr/bin/env bash',
    '# Fill the placeholder values, then run:',
    '#   set -a',
    '#   source ./multitable-onprem-package-install.env.example.sh',
    '#   set +a',
    '#   ./multitable-onprem-package-install.sh',
    '',
    'export ENV_FILE=/opt/metasheet/docker/app.env',
    'export API_BASE=http://127.0.0.1/api',
    'export ADMIN_EMAIL=admin@your-company.local',
    "export ADMIN_PASSWORD='ReplaceWithStrongPassword123!'",
    'export ADMIN_NAME=Administrator',
    'export VERIFY_LOGIN=1',
    'export SERVICE_MANAGER=pm2',
    'export CHECK_NGINX=1',
    'export EXPECT_PRODUCT_MODE=platform',
    'export INSTALL_DEPS=1',
    'export BUILD_WEB=0',
    'export BUILD_BACKEND=0',
    'export RUN_MIGRATIONS=1',
    'export START_SERVICE=1',
    '',
  ].join('\n')
  const deployEasyEnvTemplate = [
    '#!/usr/bin/env bash',
    '# Fill the placeholder values, then run:',
    '#   set -a',
    '#   source ./multitable-onprem-deploy-easy.env.example.sh',
    '#   set +a',
    '#   ./multitable-onprem-deploy-easy.sh',
    '',
    'export ENV_FILE=/opt/metasheet/docker/app.env',
    'export API_BASE=http://127.0.0.1/api',
    'export ADMIN_EMAIL=admin@your-company.local',
    "export ADMIN_PASSWORD='ReplaceWithStrongPassword123!'",
    'export ADMIN_NAME=Administrator',
    'export VERIFY_LOGIN=1',
    'export SERVICE_MANAGER=pm2',
    'export CHECK_NGINX=1',
    'export EXPECT_PRODUCT_MODE=platform',
    'export INSTALL_DEPS=1',
    'export BUILD_WEB=0',
    'export BUILD_BACKEND=0',
    'export RUN_MIGRATIONS=1',
    'export START_SERVICE=1',
    '',
  ].join('\n')
  const healthcheckEnvTemplate = [
    '#!/usr/bin/env bash',
    '# Fill the placeholder values, then run:',
    '#   set -a',
    '#   source ./multitable-onprem-healthcheck.env.example.sh',
    '#   set +a',
    '#   ./multitable-onprem-healthcheck.sh',
    '',
    'export BASE_URL=http://127.0.0.1',
    'export API_BASE=http://127.0.0.1/api',
    'export SERVICE_MANAGER=auto',
    'export CHECK_NGINX=1',
    'export EXPECT_PRODUCT_MODE=platform',
    '# export AUTH_TOKEN=<paste-jwt-if-you-want-/auth/me-validation>',
    '',
  ].join('\n')
  const preflightEnvTemplate = [
    '#!/usr/bin/env bash',
    '# Fill the placeholder values, then run:',
    '#   set -a',
    '#   source ./multitable-onprem-preflight.env.example.sh',
    '#   set +a',
    '#   ./multitable-onprem-preflight.sh',
    '',
    'export ENV_FILE=/opt/metasheet/docker/app.env',
    'export EXPECT_PRODUCT_MODE=platform',
    'export REQUIRE_DEPLOYMENT_MODEL=onprem',
    'export REQUIRE_STORAGE_DIRS=1',
    `export PREFLIGHT_REPORT_JSON=${defaultPreflightReportJson}`,
    `export PREFLIGHT_REPORT_MD=${defaultPreflightReportMd}`,
    '',
  ].join('\n')

  const readinessPayload = await readOptionalJsonFile(readinessJson)
  const embedHostProtocol = summarizeEmbedEvidence(readinessPayload?.embedHostProtocol)
  const embedHostNavigationProtection = summarizeEmbedEvidence(readinessPayload?.embedHostNavigationProtection)
  const embedHostDeferredReplay = summarizeEmbedEvidence(readinessPayload?.embedHostDeferredReplay)
  const readinessGateOperatorCommandEntries = Array.isArray(readinessPayload?.gates?.operatorCommandEntries)
    ? readinessPayload.gates.operatorCommandEntries
    : []
  const readinessGateOperatorChecklist = Array.isArray(readinessPayload?.gates?.operatorChecklist)
    ? readinessPayload.gates.operatorChecklist
    : []
  const localRunner = summarizeLocalRunner(readinessPayload?.pilotRunner ?? readinessPayload?.localRunner)
  const defaultRunnerReportBase = localRunner.runMode === 'staging' ? 'staging-report' : 'local-report'
  const smokeRunnerReport = localRunner.report ?? path.join(readinessRoot, 'smoke', `${defaultRunnerReportBase}.json`)
  const smokeRunnerReportMd = localRunner.reportMd ?? path.join(readinessRoot, 'smoke', `${defaultRunnerReportBase}.md`)
  const effectiveLocalRunner = {
    ...localRunner,
    report: smokeRunnerReport,
    reportMd: smokeRunnerReportMd,
  }
  const smokeRunnerReportBase = path.basename(smokeRunnerReport)
  const smokeRunnerReportMdBase = path.basename(smokeRunnerReportMd)
  const embedHostAcceptance = {
    ok: embedHostProtocol.ok && embedHostNavigationProtection.ok && embedHostDeferredReplay.ok,
    protocol: embedHostProtocol,
    navigationProtection: embedHostNavigationProtection,
    deferredReplay: embedHostDeferredReplay,
  }

  const copied = {
    readinessMd: await safeCopy(readinessMd, path.join(handoffRoot, 'readiness.md')),
    readinessJson: await safeCopy(readinessJson, path.join(handoffRoot, 'readiness.json')),
    readinessGateReport: await safeCopy(readinessGateReport, path.join(handoffRoot, 'gates', 'report.json')),
    readinessGateReportMd: await safeCopy(readinessGateReportMd, path.join(handoffRoot, 'gates', 'report.md')),
    readinessGateLog: await safeCopy(readinessGateLog, path.join(handoffRoot, 'gates', 'release-gate.log')),
    readinessGateOperatorCommands: await safeCopy(
      readinessGateOperatorCommands,
      path.join(handoffRoot, 'gates', 'operator-commands.sh'),
    ),
    smokeReport: await safeCopy(smokeReport, path.join(handoffRoot, 'smoke', 'report.json')),
    smokeReportMd: await safeCopy(smokeReportMd, path.join(handoffRoot, 'smoke', 'report.md')),
    smokeLocalReport: await safeCopy(smokeRunnerReport, path.join(handoffRoot, 'smoke', smokeRunnerReportBase)),
    smokeLocalReportMd: await safeCopy(smokeRunnerReportMd, path.join(handoffRoot, 'smoke', smokeRunnerReportMdBase)),
    smokeGridImport: await safeCopy(smokeGridImport, path.join(handoffRoot, 'smoke', 'grid-import.png')),
    smokeImportMappingReconcile: await safeCopy(
      smokeImportMappingReconcile,
      path.join(handoffRoot, 'smoke', 'import-mapping-reconcile.png'),
    ),
    smokeImportPeopleRepairReconcile: await safeCopy(
      smokeImportPeopleRepairReconcile,
      path.join(handoffRoot, 'smoke', 'import-people-repair-reconcile.png'),
    ),
    smokeGridImportPeopleManualFix: await safeCopy(
      smokeGridImportPeopleManualFix,
      path.join(handoffRoot, 'smoke', 'grid-import-people-manual-fix.png'),
    ),
    smokeGridHydrated: await safeCopy(smokeGridHydrated, path.join(handoffRoot, 'smoke', 'grid-hydrated.png')),
    smokeFormComments: await safeCopy(smokeFormComments, path.join(handoffRoot, 'smoke', 'form-comments.png')),
    smokeFieldManagerPropReconcile: await safeCopy(
      smokeFieldManagerPropReconcile,
      path.join(handoffRoot, 'smoke', 'field-manager-prop-reconcile.png'),
    ),
    smokeFieldManagerTypeReconcile: await safeCopy(
      smokeFieldManagerTypeReconcile,
      path.join(handoffRoot, 'smoke', 'field-manager-type-reconcile.png'),
    ),
    smokeFieldManagerTargetRemoval: await safeCopy(
      smokeFieldManagerTargetRemoval,
      path.join(handoffRoot, 'smoke', 'field-manager-target-removal.png'),
    ),
    smokeViewManagerPropReconcile: await safeCopy(
      smokeViewManagerPropReconcile,
      path.join(handoffRoot, 'smoke', 'view-manager-prop-reconcile.png'),
    ),
    smokeViewManagerFieldSchemaReconcile: await safeCopy(
      smokeViewManagerFieldSchemaReconcile,
      path.join(handoffRoot, 'smoke', 'view-manager-field-schema-reconcile.png'),
    ),
    smokeViewManagerTargetRemoval: await safeCopy(
      smokeViewManagerTargetRemoval,
      path.join(handoffRoot, 'smoke', 'view-manager-target-removal.png'),
    ),
    profileReport: await safeCopy(profileReport, path.join(handoffRoot, 'profile', 'report.json')),
    profileSummary: await safeCopy(profileSummary, path.join(handoffRoot, 'profile', 'summary.md')),
    releaseJson: await safeCopy(releaseJson, path.join(handoffRoot, 'release', path.basename(releaseJson))),
    releaseTgz: await safeCopy(releaseTgz, path.join(handoffRoot, 'release', path.basename(releaseTgz))),
    releaseZip: await safeCopy(releaseZip, path.join(handoffRoot, 'release', path.basename(releaseZip))),
    releaseTgzSha: await safeCopy(releaseTgzSha, path.join(handoffRoot, 'release', path.basename(releaseTgzSha))),
    releaseZipSha: await safeCopy(releaseZipSha, path.join(handoffRoot, 'release', path.basename(releaseZipSha))),
    releaseChecksumIndex: await safeCopy(releaseChecksumIndex, path.join(handoffRoot, 'release', path.basename(releaseChecksumIndex))),
    deliveryJson: await safeCopy(deliveryJson, path.join(handoffRoot, 'delivery', 'DELIVERY.json')),
    deliveryMd: await safeCopy(deliveryMd, path.join(handoffRoot, 'delivery', 'DELIVERY.md')),
    onPremGateReportJson: await safeCopy(
      onPremGateReportJson,
      path.join(handoffRoot, 'release-gate', 'report.json'),
    ),
    onPremGateReportMd: await safeCopy(
      onPremGateReportMd,
      path.join(handoffRoot, 'release-gate', 'report.md'),
    ),
    onPremGateOperatorCommands: await safeCopy(
      onPremGateOperatorCommands,
      path.join(handoffRoot, 'release-gate', 'operator-commands.sh'),
    ),
    onPremGateBuildLog: await safeCopy(
      onPremGateBuildLog,
      path.join(handoffRoot, 'release-gate', 'logs', 'build.log'),
    ),
    onPremGateVerifyTgzLog: await safeCopy(
      onPremGateVerifyTgzLog,
      path.join(handoffRoot, 'release-gate', 'logs', 'verify-tgz.log'),
    ),
    onPremGateVerifyZipLog: await safeCopy(
      onPremGateVerifyZipLog,
      path.join(handoffRoot, 'release-gate', 'logs', 'verify-zip.log'),
    ),
    onPremGateDeliveryLog: await safeCopy(
      onPremGateDeliveryLog,
      path.join(handoffRoot, 'release-gate', 'logs', 'delivery.log'),
    ),
    packageVerifyScript: await safeCopy(
      packageVerifyScript,
      path.join(handoffRoot, 'artifacts', 'package-verify', path.basename(packageVerifyScript)),
    ),
    onPremReleaseGateScript: await safeCopy(
      onPremReleaseGateScript,
      path.join(handoffRoot, 'artifacts', 'release-gate', path.basename(onPremReleaseGateScript)),
    ),
    deployEasyScript: await safeCopy(
      deployEasyScript,
      path.join(handoffRoot, 'artifacts', 'deploy', path.basename(deployEasyScript)),
    ),
    packageInstallScript: await safeCopy(
      packageInstallScript,
      path.join(handoffRoot, 'artifacts', 'deploy', path.basename(packageInstallScript)),
    ),
    preflightScript: await safeCopy(
      preflightScript,
      path.join(handoffRoot, 'artifacts', 'preflight', path.basename(preflightScript)),
    ),
    repairHelperScript: await safeCopy(
      repairHelperScript,
      path.join(handoffRoot, 'artifacts', 'preflight', path.basename(repairHelperScript)),
    ),
    healthcheckScript: await safeCopy(
      healthcheckScript,
      path.join(handoffRoot, 'artifacts', 'healthcheck', path.basename(healthcheckScript)),
    ),
    healthcheckService: await safeCopy(
      healthcheckService,
      path.join(handoffRoot, 'artifacts', 'healthcheck', path.basename(healthcheckService)),
    ),
    healthcheckTimer: await safeCopy(
      healthcheckTimer,
      path.join(handoffRoot, 'artifacts', 'healthcheck', path.basename(healthcheckTimer)),
    ),
    runbook: await safeCopy(runbookPath, path.join(handoffRoot, 'docs', path.basename(runbookPath))),
    quickstart: await safeCopy(quickstartPath, path.join(handoffRoot, 'docs', path.basename(quickstartPath))),
    feedbackTemplate: await safeCopy(
      feedbackTemplatePath,
      path.join(handoffRoot, 'docs', path.basename(feedbackTemplatePath)),
    ),
    teamChecklist: await safeCopy(
      teamChecklistPath,
      path.join(handoffRoot, 'docs', path.basename(teamChecklistPath)),
    ),
    dailyTriageTemplate: await safeCopy(
      dailyTriageTemplatePath,
      path.join(handoffRoot, 'docs', path.basename(dailyTriageTemplatePath)),
    ),
    goNoGoTemplate: await safeCopy(
      goNoGoTemplatePath,
      path.join(handoffRoot, 'docs', path.basename(goNoGoTemplatePath)),
    ),
    pilotExpansionDecisionTemplate: await safeCopy(
      pilotExpansionDecisionTemplatePath,
      path.join(handoffRoot, 'docs', path.basename(pilotExpansionDecisionTemplatePath)),
    ),
    uatSignoffTemplate: await safeCopy(
      uatSignoffTemplatePath,
      path.join(handoffRoot, 'docs', path.basename(uatSignoffTemplatePath)),
    ),
    customerDeliverySignoffTemplate: await safeCopy(
      customerDeliverySignoffTemplatePath,
      path.join(handoffRoot, 'docs', path.basename(customerDeliverySignoffTemplatePath)),
    ),
    issueTemplate: await safeCopy(
      issueTemplatePath,
      path.join(handoffRoot, 'docs', 'issue-template', path.basename(issueTemplatePath)),
    ),
  }
  await writeExecutable(
    path.join(handoffRoot, 'artifacts', 'deploy', 'multitable-onprem-package-install.env.example.sh'),
    `${packageInstallEnvTemplate}\n`,
  )
  await writeExecutable(
    path.join(handoffRoot, 'artifacts', 'deploy', 'multitable-onprem-deploy-easy.env.example.sh'),
    `${deployEasyEnvTemplate}\n`,
  )
  await writeExecutable(
    path.join(handoffRoot, 'artifacts', 'healthcheck', 'multitable-onprem-healthcheck.env.example.sh'),
    `${healthcheckEnvTemplate}\n`,
  )
  await writeExecutable(
    path.join(handoffRoot, 'artifacts', 'preflight', 'multitable-onprem-preflight.env.example.sh'),
    `${preflightEnvTemplate}\n`,
  )

  const readinessGateOk = copied.readinessMd &&
    copied.readinessJson &&
    copied.readinessGateReport &&
    copied.readinessGateReportMd &&
    copied.readinessGateLog &&
    copied.readinessGateOperatorCommands
  const packageVerifyOk = copied.releaseJson && copied.releaseTgz && copied.releaseZip && copied.releaseTgzSha && copied.releaseZipSha && copied.releaseChecksumIndex && copied.packageVerifyScript
  const deployOk = copied.deployEasyScript && copied.packageInstallScript
  const preflightOk = copied.preflightScript && copied.repairHelperScript
  const healthcheckOk = copied.healthcheckScript && copied.healthcheckService && copied.healthcheckTimer
  const onPremGateOk = copied.onPremGateReportJson && copied.onPremGateReportMd && copied.onPremGateOperatorCommands && copied.onPremGateVerifyTgzLog && copied.onPremGateVerifyZipLog && copied.onPremGateDeliveryLog && copied.onPremReleaseGateScript

  const manifest = {
    ok: readinessGateOk && packageVerifyOk && deployOk && preflightOk && healthcheckOk && onPremGateOk,
    sourceReadinessRoot: readinessRoot,
    sourceReleaseRoot: RELEASE_ROOT,
    sourceOnPremGateReport: onPremGate?.reportPath ?? null,
    onPremGateBinding: {
      required: requireOnPremGate,
      explicitRequired: requireExplicitOnPremGate,
      explicitReport: onPremGateReportOverride ? path.resolve(onPremGateReportOverride) : null,
    },
    packageName: release.packageName,
    handoffRoot,
    expectedOperatorEvidence: {
      readinessGateReport: path.join(handoffRoot, 'gates', 'report.json'),
      readinessGateOperatorCommands: path.join(handoffRoot, 'gates', 'operator-commands.sh'),
      preflightReportJson: defaultPreflightReportJson,
      preflightReportMd: defaultPreflightReportMd,
    },
    readinessGateOperatorContract: {
      helper: copied.readinessGateOperatorCommands
        ? path.join(handoffRoot, 'gates', 'operator-commands.sh')
        : null,
      operatorCommandEntries: readinessGateOperatorCommandEntries,
      operatorChecklist: readinessGateOperatorChecklist,
    },
    embedHostAcceptance,
    pilotRunner: effectiveLocalRunner,
    localRunner: effectiveLocalRunner,
    embedHostProtocol,
    embedHostNavigationProtection,
    embedHostDeferredReplay,
    signoffBlockers: [
      `Do not close checkpoint, expansion, UAT, or customer sign-off until ${defaultPreflightReportJson} and ${defaultPreflightReportMd} are returned.`,
    ],
    signoffRecoveryPath: {
      step1RunPreflight: 'set -a && source ./artifacts/preflight/multitable-onprem-preflight.env.example.sh && set +a && bash ./artifacts/preflight/multitable-onprem-preflight.sh',
      step2RepairInstruction: 'If preflight fails, run the first command shown under "One-Line Quick Fix Commands" in the generated preflight report.',
      step2RepairHelper: 'artifacts/preflight/multitable-onprem-repair-helper.sh',
      step3ReturnEvidence: [defaultPreflightReportJson, defaultPreflightReportMd],
    },
    artifactChecks: {
      onPremReleaseGate: {
        ok: onPremGateOk,
        reportJson: copied.onPremGateReportJson,
        reportMd: copied.onPremGateReportMd,
        operatorCommands: copied.onPremGateOperatorCommands,
        buildLog: copied.onPremGateBuildLog,
        verifyTgzLog: copied.onPremGateVerifyTgzLog,
        verifyZipLog: copied.onPremGateVerifyZipLog,
        deliveryLog: copied.onPremGateDeliveryLog,
        releaseGateScript: copied.onPremReleaseGateScript,
      },
      packageVerify: {
        ok: packageVerifyOk,
        releaseJson: copied.releaseJson,
        releaseTgz: copied.releaseTgz,
        releaseZip: copied.releaseZip,
        releaseTgzSha: copied.releaseTgzSha,
        releaseZipSha: copied.releaseZipSha,
        releaseChecksumIndex: copied.releaseChecksumIndex,
        packageVerifyScript: copied.packageVerifyScript,
      },
      deploy: {
        ok: deployOk,
        deployEasyScript: copied.deployEasyScript,
        packageInstallScript: copied.packageInstallScript,
        deployEasyEnvTemplate: true,
        packageInstallEnvTemplate: true,
      },
      preflight: {
        ok: preflightOk,
        preflightScript: copied.preflightScript,
        repairHelperScript: copied.repairHelperScript,
        preflightEnvTemplate: true,
        preflightReportJsonDefault: defaultPreflightReportJson,
        preflightReportMdDefault: defaultPreflightReportMd,
      },
      healthcheck: {
        ok: healthcheckOk,
        healthcheckScript: copied.healthcheckScript,
        healthcheckEnvTemplate: true,
        healthcheckService: copied.healthcheckService,
        healthcheckTimer: copied.healthcheckTimer,
      },
      deliveryBundle: {
        ok: copied.deliveryJson && copied.deliveryMd,
        deliveryJson: copied.deliveryJson,
        deliveryMd: copied.deliveryMd,
      },
      readinessGate: {
        ok: readinessGateOk,
        readinessMd: copied.readinessMd,
        readinessJson: copied.readinessJson,
        readinessGateReport: copied.readinessGateReport,
        readinessGateReportMd: copied.readinessGateReportMd,
        readinessGateLog: copied.readinessGateLog,
        readinessGateOperatorCommands: copied.readinessGateOperatorCommands,
        operatorCommandEntries: readinessGateOperatorCommandEntries,
        operatorChecklist: readinessGateOperatorChecklist,
        smokeReport: copied.smokeReport,
        smokeReportMd: copied.smokeReportMd,
        localRunner: effectiveLocalRunner,
        embedHostProtocol,
        embedHostNavigationProtection,
        embedHostDeferredReplay,
      },
    },
    recommendedTemplates: {
      quickstart: copied.quickstart ? path.join(handoffRoot, 'docs', path.basename(quickstartPath)) : null,
      dailyTriage: copied.dailyTriageTemplate ? path.join(handoffRoot, 'docs', path.basename(dailyTriageTemplatePath)) : null,
      goNoGo: copied.goNoGoTemplate ? path.join(handoffRoot, 'docs', path.basename(goNoGoTemplatePath)) : null,
      pilotExpansionDecision: copied.pilotExpansionDecisionTemplate ? path.join(handoffRoot, 'docs', path.basename(pilotExpansionDecisionTemplatePath)) : null,
      uatSignoff: copied.uatSignoffTemplate ? path.join(handoffRoot, 'docs', path.basename(uatSignoffTemplatePath)) : null,
      customerDeliverySignoff: copied.customerDeliverySignoffTemplate ? path.join(handoffRoot, 'docs', path.basename(customerDeliverySignoffTemplatePath)) : null,
      feedback: copied.feedbackTemplate ? path.join(handoffRoot, 'docs', path.basename(feedbackTemplatePath)) : null,
    },
    copied,
    generatedAt: new Date().toISOString(),
  }

  const summary = [
    '# Multitable Pilot Handoff',
    '',
    `- Source readiness root: \`${readinessRoot}\``,
    `- Source release root: \`${RELEASE_ROOT}\``,
    `- Source on-prem gate: \`${onPremGate?.reportPath ?? 'not found'}\``,
    `- On-prem gate binding required: \`${requireOnPremGate ? 'true' : 'false'}\``,
    `- On-prem explicit gate required: \`${requireExplicitOnPremGate ? 'true' : 'false'}\``,
    `- Package name: \`${release.packageName}\``,
    `- Handoff root: \`${handoffRoot}\``,
    `- Readiness package copied: **${Boolean(readinessGateOk) ? 'YES' : 'NO'}**`,
    '',
    '## Sign-Off Blockers',
    '',
    `- Required preflight json: \`${defaultPreflightReportJson}\``,
    `- Required preflight markdown: \`${defaultPreflightReportMd}\``,
    '- Do not close checkpoint, expansion, UAT, or customer sign-off until both preflight files are returned.',
    `- Step 1 command: \`${manifest.signoffRecoveryPath.step1RunPreflight}\``,
    '- If preflight fails, run the first line shown under `One-Line Quick Fix Commands` in the generated preflight report.',
    `- Repair helper path: \`${manifest.signoffRecoveryPath.step2RepairHelper}\``,
    `- Return both files: \`${defaultPreflightReportJson}\`, \`${defaultPreflightReportMd}\``,
    '',
    '## Embed Host Acceptance',
    '',
    `- Overall embed-host acceptance: **${embedHostAcceptance.ok ? 'PASS' : 'FAIL'}**`,
    '- Treat this section as required whenever smoke includes any `ui.embed-host.*` checks.',
    '',
    ...embedEvidenceSection('### Embed Host Protocol Evidence', embedHostProtocol),
    ...embedEvidenceSection('### Embed Host Navigation Protection', embedHostNavigationProtection),
    ...embedEvidenceSection('### Embed Host Busy Deferred Replay', embedHostDeferredReplay),
    '## Pilot Runner',
    '',
    `- Required in readiness: \`${effectiveLocalRunner.required ? 'true' : 'false'}\``,
    `- Available in readiness: \`${effectiveLocalRunner.available ? 'true' : 'false'}\``,
    `- Status: **${effectiveLocalRunner.ok ? 'PASS' : 'FAIL'}**`,
    `- Run mode: \`${effectiveLocalRunner.runMode}\``,
    `- Backend mode: \`${effectiveLocalRunner.serviceModes.backend}\``,
    `- Web mode: \`${effectiveLocalRunner.serviceModes.web}\``,
    `- Wrapper embed-host acceptance: **${effectiveLocalRunner.embedHostAcceptance.ok ? 'PASS' : 'FAIL'}**`,
    `- Runner report json: \`${effectiveLocalRunner.report ?? 'missing'}\``,
    `- Runner report markdown: \`${effectiveLocalRunner.reportMd ?? 'missing'}\``,
    `- Raw runner report: \`${effectiveLocalRunner.runnerReport ?? 'missing'}\``,
    '',
    '## Included Files',
    '',
    `- readiness.md: ${copied.readinessMd ? '`present`' : '`missing`'}`,
    `- readiness.json: ${copied.readinessJson ? '`present`' : '`missing`'}`,
    `- gates/report.json: ${copied.readinessGateReport ? '`present`' : '`missing`'}`,
    `- gates/report.md: ${copied.readinessGateReportMd ? '`present`' : '`missing`'}`,
    `- gates/release-gate.log: ${copied.readinessGateLog ? '`present`' : '`missing`'}`,
    `- gates/operator-commands.sh: ${copied.readinessGateOperatorCommands ? '`present`' : '`missing`'}`,
    `- smoke/report.json: ${copied.smokeReport ? '`present`' : '`missing`'}`,
    `- smoke/report.md: ${copied.smokeReportMd ? '`present`' : '`missing`'}`,
    `- smoke/${smokeRunnerReportBase}: ${copied.smokeLocalReport ? '`present`' : '`missing`'}`,
    `- smoke/${smokeRunnerReportMdBase}: ${copied.smokeLocalReportMd ? '`present`' : '`missing`'}`,
    `- smoke/grid-import.png: ${copied.smokeGridImport ? '`present`' : '`missing`'}`,
    `- smoke/import-mapping-reconcile.png: ${copied.smokeImportMappingReconcile ? '`present`' : '`missing`'}`,
    `- smoke/import-people-repair-reconcile.png: ${copied.smokeImportPeopleRepairReconcile ? '`present`' : '`missing`'}`,
    `- smoke/grid-import-people-manual-fix.png: ${copied.smokeGridImportPeopleManualFix ? '`present`' : '`missing`'}`,
    `- smoke/grid-hydrated.png: ${copied.smokeGridHydrated ? '`present`' : '`missing`'}`,
    `- smoke/form-comments.png: ${copied.smokeFormComments ? '`present`' : '`missing`'}`,
    `- smoke/field-manager-prop-reconcile.png: ${copied.smokeFieldManagerPropReconcile ? '`present`' : '`missing`'}`,
    `- smoke/field-manager-type-reconcile.png: ${copied.smokeFieldManagerTypeReconcile ? '`present`' : '`missing`'}`,
    `- smoke/field-manager-target-removal.png: ${copied.smokeFieldManagerTargetRemoval ? '`present`' : '`missing`'}`,
    `- smoke/view-manager-prop-reconcile.png: ${copied.smokeViewManagerPropReconcile ? '`present`' : '`missing`'}`,
    `- smoke/view-manager-field-schema-reconcile.png: ${copied.smokeViewManagerFieldSchemaReconcile ? '`present`' : '`missing`'}`,
    `- smoke/view-manager-target-removal.png: ${copied.smokeViewManagerTargetRemoval ? '`present`' : '`missing`'}`,
    `- profile/report.json: ${copied.profileReport ? '`present`' : '`missing`'}`,
    `- profile/summary.md: ${copied.profileSummary ? '`present`' : '`missing`'}`,
    `- release/${path.basename(releaseJson)}: ${copied.releaseJson ? '`present`' : '`missing`'}`,
    `- release/${path.basename(releaseTgz)}: ${copied.releaseTgz ? '`present`' : '`missing`'}`,
    `- release/${path.basename(releaseZip)}: ${copied.releaseZip ? '`present`' : '`missing`'}`,
    `- release/${path.basename(releaseChecksumIndex)}: ${copied.releaseChecksumIndex ? '`present`' : '`missing`'}`,
    `- release-gate/report.json: ${copied.onPremGateReportJson ? '`present`' : '`missing`'}`,
    `- release-gate/report.md: ${copied.onPremGateReportMd ? '`present`' : '`missing`'}`,
    `- release-gate/operator-commands.sh: ${copied.onPremGateOperatorCommands ? '`present`' : '`missing`'}`,
    `- release-gate/logs/build.log: ${copied.onPremGateBuildLog ? '`present`' : '`missing`'}`,
    `- release-gate/logs/verify-tgz.log: ${copied.onPremGateVerifyTgzLog ? '`present`' : '`missing`'}`,
    `- release-gate/logs/verify-zip.log: ${copied.onPremGateVerifyZipLog ? '`present`' : '`missing`'}`,
    `- release-gate/logs/delivery.log: ${copied.onPremGateDeliveryLog ? '`present`' : '`missing`'}`,
    `- delivery/DELIVERY.json: ${copied.deliveryJson ? '`present`' : '`missing`'}`,
    `- delivery/DELIVERY.md: ${copied.deliveryMd ? '`present`' : '`missing`'}`,
    `- artifacts/package-verify/${path.basename(packageVerifyScript)}: ${copied.packageVerifyScript ? '`present`' : '`missing`'}`,
    `- artifacts/release-gate/${path.basename(onPremReleaseGateScript)}: ${copied.onPremReleaseGateScript ? '`present`' : '`missing`'}`,
    `- artifacts/deploy/${path.basename(packageInstallScript)}: ${copied.packageInstallScript ? '`present`' : '`missing`'}`,
    `- artifacts/deploy/${path.basename(deployEasyScript)}: ${copied.deployEasyScript ? '`present`' : '`missing`'}`,
    '- artifacts/deploy/multitable-onprem-package-install.env.example.sh: `present`',
    '- artifacts/deploy/multitable-onprem-deploy-easy.env.example.sh: `present`',
    `- artifacts/preflight/${path.basename(preflightScript)}: ${copied.preflightScript ? '`present`' : '`missing`'}`,
    `- artifacts/preflight/${path.basename(repairHelperScript)}: ${copied.repairHelperScript ? '`present`' : '`missing`'}`,
    '- artifacts/preflight/multitable-onprem-preflight.env.example.sh: `present`',
    `- artifacts/healthcheck/${path.basename(healthcheckScript)}: ${copied.healthcheckScript ? '`present`' : '`missing`'}`,
    '- artifacts/healthcheck/multitable-onprem-healthcheck.env.example.sh: `present`',
    `- artifacts/healthcheck/${path.basename(healthcheckService)}: ${copied.healthcheckService ? '`present`' : '`missing`'}`,
    `- artifacts/healthcheck/${path.basename(healthcheckTimer)}: ${copied.healthcheckTimer ? '`present`' : '`missing`'}`,
    `- runbook: ${copied.runbook ? '`present`' : '`missing`'}`,
    `- quickstart: ${copied.quickstart ? '`present`' : '`missing`'}`,
    `- feedback template: ${copied.feedbackTemplate ? '`present`' : '`missing`'}`,
    `- team checklist: ${copied.teamChecklist ? '`present`' : '`missing`'}`,
    `- daily triage template: ${copied.dailyTriageTemplate ? '`present`' : '`missing`'}`,
    `- go / no-go template: ${copied.goNoGoTemplate ? '`present`' : '`missing`'}`,
    `- pilot expansion decision template: ${copied.pilotExpansionDecisionTemplate ? '`present`' : '`missing`'}`,
    `- UAT sign-off template: ${copied.uatSignoffTemplate ? '`present`' : '`missing`'}`,
    `- customer delivery sign-off template: ${copied.customerDeliverySignoffTemplate ? '`present`' : '`missing`'}`,
    `- issue template: ${copied.issueTemplate ? '`present`' : '`missing`'}`,
    '',
    '## Recommended Templates',
    '',
    `- Team quickstart: \`docs/${path.basename(quickstartPath)}\``,
    `- Daily issue review: \`docs/${path.basename(dailyTriageTemplatePath)}\``,
    `- Pilot checkpoint: \`docs/${path.basename(goNoGoTemplatePath)}\``,
    `- Pilot expansion decision: \`docs/${path.basename(pilotExpansionDecisionTemplatePath)}\``,
    `- Controlled rollout / UAT sign-off: \`docs/${path.basename(uatSignoffTemplatePath)}\``,
    `- Customer delivery receipt: \`docs/${path.basename(customerDeliverySignoffTemplatePath)}\``,
    `- Feedback intake: \`docs/${path.basename(feedbackTemplatePath)}\``,
    '',
    '## Readiness Gate Operator Contract',
    '',
    `- Helper: ${copied.readinessGateOperatorCommands ? '`gates/operator-commands.sh`' : '`missing`'}`,
    readinessGateOperatorCommandEntries.length
      ? `- Operator commands: ${readinessGateOperatorCommandEntries.map((item) => `\`${item.name}\``).join(', ')}`
      : '- Operator commands: none',
    readinessGateOperatorChecklist.length
      ? `- Operator checklist: ${readinessGateOperatorChecklist.map((item) => `\`${item.step}. ${item.title}\``).join(', ')}`
      : '- Operator checklist: none',
    '',
    '## Operator Helpers',
    '',
    '- Readiness gate helper: `gates/operator-commands.sh`',
    '- On-prem release gate helper: `release-gate/operator-commands.sh`',
    '- Release-bound helper: `release-bound/operator-commands.sh`',
    '- Package install env template: `artifacts/deploy/multitable-onprem-package-install.env.example.sh`',
    '- Deploy env template: `artifacts/deploy/multitable-onprem-deploy-easy.env.example.sh`',
    `- Package installer helper: \`artifacts/deploy/${path.basename(packageInstallScript)}\``,
    `- Deploy helper: \`artifacts/deploy/${path.basename(deployEasyScript)}\``,
    '- Preflight env template: `artifacts/preflight/multitable-onprem-preflight.env.example.sh`',
    `- Preflight helper: \`artifacts/preflight/${path.basename(preflightScript)}\``,
    `- Preflight repair helper: \`artifacts/preflight/${path.basename(repairHelperScript)}\``,
    '- Preflight report outputs: `PREFLIGHT_REPORT_JSON`, `PREFLIGHT_REPORT_MD` from the preflight env template',
    '- Healthcheck env template: `artifacts/healthcheck/multitable-onprem-healthcheck.env.example.sh`',
    `- Healthcheck helper: \`artifacts/healthcheck/${path.basename(healthcheckScript)}\``,
    '',
    '## Next Step',
    '',
    '- Give the pilot team the `docs/` bundle, the available smoke screenshots, and the readiness artifacts.',
    '- Start with the quickstart, not the runbook.',
    '- Explicitly mention that import preview mappings now auto-track background renames and require `Reconcile draft` only after the mapped field becomes non-importable.',
    '- Explicitly mention that if a picked person repair becomes stale after field drift, the operator should click `Reconcile draft` before retrying.',
    '- Explicitly mention that people import mismatches can now be repaired from the result panel with `Select person`.',
    '- Explicitly mention that manager dialogs now protect dirty drafts, auto-reconcile upstream renames, block invalid saves after upstream type changes until `Reload latest`, and auto-close stale config targets after backend removal.',
    '- Include the on-prem release gate report when handing off a package, so field teams can confirm the package, verify reports, and delivery bundle were validated together.',
    `- Require the field operator to return \`${defaultPreflightReportJson}\` and \`${defaultPreflightReportMd}\` before checkpoint, expansion review, UAT, or customer sign-off.`,
    '- Collect feedback with the template or GitHub issue form.',
    '',
  ].join('\n')

  await fs.writeFile(path.join(handoffRoot, 'handoff.md'), `${summary}\n`, 'utf8')
  await fs.writeFile(path.join(handoffRoot, 'handoff.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  process.stdout.write(`[multitable-pilot-handoff] handoff_root=${rel(handoffRoot)}\n`)
  process.stdout.write(`[multitable-pilot-handoff] source_readiness_root=${rel(readinessRoot)}\n`)
  if (!manifest.ok) {
    process.stderr.write('[multitable-pilot-handoff] ERROR: readiness artifacts missing\n')
    process.exit(1)
  }
}

main().catch((error) => {
  process.stderr.write(`[multitable-pilot-handoff] ERROR: ${error.message}\n`)
  process.exit(1)
})
