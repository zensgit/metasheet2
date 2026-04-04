import fs from 'fs/promises'
import path from 'path'

const RELEASE_ROOT = path.resolve('output/releases/multitable-onprem')
const DELIVERY_ROOT = path.resolve('output/delivery/multitable-onprem')
const VERIFY_ROOT = path.join(RELEASE_ROOT, 'verify')
const DEFAULT_PREFLIGHT_REPORT_JSON = '/opt/metasheet/output/preflight/multitable-onprem-preflight.json'
const DEFAULT_PREFLIGHT_REPORT_MD = '/opt/metasheet/output/preflight/multitable-onprem-preflight.md'

const packageJsonPath = process.env.PACKAGE_JSON || ''
const deliveryRootOverride = process.env.DELIVERY_OUTPUT_ROOT || ''
const onPremGateOperatorCommandScript = process.env.ONPREM_GATE_OPERATOR_COMMAND_SCRIPT || ''

const docsToCopy = [
  'docs/deployment/multitable-windows-onprem-easy-start-20260319.md',
  'docs/deployment/multitable-onprem-package-layout-20260319.md',
  'docs/deployment/multitable-onprem-customer-delivery-checklist-20260319.md',
  'docs/deployment/multitable-internal-pilot-runbook-20260319.md',
  'docs/deployment/multitable-pilot-quickstart-20260319.md',
  'docs/deployment/multitable-pilot-team-checklist-20260319.md',
  'docs/deployment/multitable-pilot-daily-triage-template-20260319.md',
  'docs/deployment/multitable-pilot-go-no-go-template-20260319.md',
  'docs/deployment/multitable-pilot-expansion-decision-template-20260323.md',
  'docs/deployment/multitable-uat-signoff-template-20260323.md',
  'docs/deployment/multitable-customer-delivery-signoff-template-20260323.md',
  'docs/deployment/multitable-platform-rc-notes-20260404.md',
]

async function exists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function findLatestPackageJson() {
  if (packageJsonPath) return path.resolve(packageJsonPath)
  const entries = await fs.readdir(RELEASE_ROOT)
  const candidates = entries
    .filter((name) => name.endsWith('.json'))
    .filter((name) => name !== 'package.json')
    .sort()
  const latest = candidates.at(-1)
  if (!latest) {
    throw new Error(`No package metadata json found under ${RELEASE_ROOT}`)
  }
  return path.join(RELEASE_ROOT, latest)
}

async function copyFileOrThrow(from, to) {
  if (!(await exists(from))) {
    throw new Error(`Missing required file: ${from}`)
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
}

async function copyFileIfExists(from, to) {
  if (!(await exists(from))) return false
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.copyFile(from, to)
  return true
}

async function writeAtomic(filePath, content) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(tmpPath, content, 'utf8')
  await fs.rename(tmpPath, filePath)
}

async function writeExecutable(filePath, content) {
  await writeAtomic(filePath, content)
  await fs.chmod(filePath, 0o755)
}

async function main() {
  const resolvedPackageJsonPath = await findLatestPackageJson()
  const raw = await fs.readFile(resolvedPackageJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  const packageName = pkg?.name
  if (!packageName) {
    throw new Error(`Package metadata missing name: ${resolvedPackageJsonPath}`)
  }

  const outRoot = deliveryRootOverride ? path.resolve(deliveryRootOverride) : DELIVERY_ROOT
  const bundleRoot = path.join(outRoot, packageName)
  const bundleRootTmp = path.join(outRoot, '.tmp', `${packageName}-${Date.now()}`)

  const tgzPath = path.join(RELEASE_ROOT, pkg.archive)
  const zipPath = path.join(RELEASE_ROOT, pkg.archiveZip)
  const checksumIndex = path.join(RELEASE_ROOT, pkg.checksumFile)
  const tgzSha = `${tgzPath}.sha256`
  const zipSha = `${zipPath}.sha256`
  const tgzVerifyJson = path.join(VERIFY_ROOT, `${pkg.archive}.verify.json`)
  const tgzVerifyMd = path.join(VERIFY_ROOT, `${pkg.archive}.verify.md`)
  const zipVerifyJson = path.join(VERIFY_ROOT, `${pkg.archiveZip}.verify.json`)
  const zipVerifyMd = path.join(VERIFY_ROOT, `${pkg.archiveZip}.verify.md`)
  const releasePackageRoot = path.join(RELEASE_ROOT, '.build', packageName, packageName)
  const deployEasyScript = path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-deploy-easy.sh')
  const packageInstallScript = path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-package-install.sh')
  const healthcheckScript = path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-healthcheck.sh')
  const preflightScript = path.resolve('scripts/ops/multitable-onprem-preflight.sh')
  const repairHelperScript = path.resolve('scripts/ops/multitable-onprem-repair-helper.sh')
  const healthcheckService = path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.service.example')
  const healthcheckTimer = path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.timer.example')
  const resolvedOnPremGateOperatorCommandScript = onPremGateOperatorCommandScript
    ? path.resolve(onPremGateOperatorCommandScript)
    : ''
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
    `export PREFLIGHT_REPORT_JSON=${DEFAULT_PREFLIGHT_REPORT_JSON}`,
    `export PREFLIGHT_REPORT_MD=${DEFAULT_PREFLIGHT_REPORT_MD}`,
    '',
  ].join('\n')

  await fs.rm(bundleRootTmp, { recursive: true, force: true })
  await fs.mkdir(bundleRootTmp, { recursive: true })

  await copyFileOrThrow(resolvedPackageJsonPath, path.join(bundleRootTmp, path.basename(resolvedPackageJsonPath)))
  await copyFileOrThrow(tgzPath, path.join(bundleRootTmp, path.basename(tgzPath)))
  await copyFileOrThrow(zipPath, path.join(bundleRootTmp, path.basename(zipPath)))
  await copyFileOrThrow(tgzSha, path.join(bundleRootTmp, path.basename(tgzSha)))
  await copyFileOrThrow(zipSha, path.join(bundleRootTmp, path.basename(zipSha)))
  await copyFileOrThrow(checksumIndex, path.join(bundleRootTmp, path.basename(checksumIndex)))

  for (const docRel of docsToCopy) {
    const abs = path.resolve(docRel)
    await copyFileOrThrow(abs, path.join(bundleRootTmp, 'docs', path.basename(docRel)))
  }

  const copiedVerifyReports = {
    tgzVerifyJson: await copyFileIfExists(tgzVerifyJson, path.join(bundleRootTmp, 'verify', path.basename(tgzVerifyJson))),
    tgzVerifyMd: await copyFileIfExists(tgzVerifyMd, path.join(bundleRootTmp, 'verify', path.basename(tgzVerifyMd))),
    zipVerifyJson: await copyFileIfExists(zipVerifyJson, path.join(bundleRootTmp, 'verify', path.basename(zipVerifyJson))),
    zipVerifyMd: await copyFileIfExists(zipVerifyMd, path.join(bundleRootTmp, 'verify', path.basename(zipVerifyMd))),
  }
  const copiedOperatorArtifacts = {
    onPremGateOperatorCommandScript: await copyFileIfExists(
      resolvedOnPremGateOperatorCommandScript,
      path.join(bundleRootTmp, 'ops', 'onprem-release-gate-operator-commands.sh'),
    ),
    deployEasyScript: await copyFileIfExists(
      deployEasyScript,
      path.join(bundleRootTmp, 'ops', 'multitable-onprem-deploy-easy.sh'),
    ),
    packageInstallScript: await copyFileIfExists(
      packageInstallScript,
      path.join(bundleRootTmp, 'ops', 'multitable-onprem-package-install.sh'),
    ),
    healthcheckScript: await copyFileIfExists(
      healthcheckScript,
      path.join(bundleRootTmp, 'ops', 'multitable-onprem-healthcheck.sh'),
    ),
    preflightScript: await copyFileIfExists(
      preflightScript,
      path.join(bundleRootTmp, 'ops', 'multitable-onprem-preflight.sh'),
    ),
    repairHelperScript: await copyFileIfExists(
      repairHelperScript,
      path.join(bundleRootTmp, 'ops', 'multitable-onprem-repair-helper.sh'),
    ),
    healthcheckService: await copyFileIfExists(
      healthcheckService,
      path.join(bundleRootTmp, 'ops', 'metasheet-healthcheck.service.example'),
    ),
    healthcheckTimer: await copyFileIfExists(
      healthcheckTimer,
      path.join(bundleRootTmp, 'ops', 'metasheet-healthcheck.timer.example'),
    ),
  }
  await writeExecutable(
    path.join(bundleRootTmp, 'ops', 'multitable-onprem-package-install.env.example.sh'),
    `${packageInstallEnvTemplate}\n`,
  )
  await writeExecutable(
    path.join(bundleRootTmp, 'ops', 'multitable-onprem-deploy-easy.env.example.sh'),
    `${deployEasyEnvTemplate}\n`,
  )
  await writeExecutable(
    path.join(bundleRootTmp, 'ops', 'multitable-onprem-healthcheck.env.example.sh'),
    `${healthcheckEnvTemplate}\n`,
  )
  await writeExecutable(
    path.join(bundleRootTmp, 'ops', 'multitable-onprem-preflight.env.example.sh'),
    `${preflightEnvTemplate}\n`,
  )
  const preflightEnvTemplateRel = 'ops/multitable-onprem-preflight.env.example.sh'
  const preflightHelperRel = 'ops/multitable-onprem-preflight.sh'
  const repairHelperRel = 'ops/multitable-onprem-repair-helper.sh'
  const signoffRecoveryPath = {
    step1RunPreflight: `set -a && source ./${preflightEnvTemplateRel} && set +a && bash ./${preflightHelperRel}`,
    step2RepairInstruction: 'If preflight fails, run the first command shown under "One-Line Quick Fix Commands" in the generated preflight report.',
    step2RepairHelper: repairHelperRel,
    step3ReturnEvidence: [DEFAULT_PREFLIGHT_REPORT_JSON, DEFAULT_PREFLIGHT_REPORT_MD],
  }

  const summaryMd = [
    '# Multitable On-Prem Delivery Bundle',
    '',
    `- Package name: \`${packageName}\``,
    `- Product mode: \`${pkg.productMode ?? 'unknown'}\``,
    `- Attendance only: \`${String(pkg.attendanceOnly)}\``,
    `- Bundle root: \`${bundleRoot}\``,
    '',
    '## Sign-Off Blockers',
    '',
    `- Required preflight json: \`${DEFAULT_PREFLIGHT_REPORT_JSON}\``,
    `- Required preflight markdown: \`${DEFAULT_PREFLIGHT_REPORT_MD}\``,
    '- Do not complete customer delivery, UAT, or final sign-off until both preflight files are returned.',
    `- Step 1 command: \`${signoffRecoveryPath.step1RunPreflight}\``,
    '- If preflight fails, run the first line shown under `One-Line Quick Fix Commands` in the generated preflight report.',
    `- Repair helper path: \`${repairHelperRel}\``,
    `- Return both files: \`${DEFAULT_PREFLIGHT_REPORT_JSON}\`, \`${DEFAULT_PREFLIGHT_REPORT_MD}\``,
    '',
    '## Included package files',
    '',
    `- \`${path.basename(tgzPath)}\``,
    `- \`${path.basename(zipPath)}\``,
    `- \`${path.basename(tgzSha)}\``,
    `- \`${path.basename(zipSha)}\``,
    `- \`${path.basename(checksumIndex)}\``,
    `- \`${path.basename(resolvedPackageJsonPath)}\``,
    '',
    '## Included docs',
    '',
    ...docsToCopy.map((item) => `- \`${path.basename(item)}\``),
    '',
    '## Included verify reports',
    '',
    `- \`${path.basename(tgzVerifyJson)}\`: ${copiedVerifyReports.tgzVerifyJson ? 'present' : 'missing'}`,
    `- \`${path.basename(tgzVerifyMd)}\`: ${copiedVerifyReports.tgzVerifyMd ? 'present' : 'missing'}`,
    `- \`${path.basename(zipVerifyJson)}\`: ${copiedVerifyReports.zipVerifyJson ? 'present' : 'missing'}`,
    `- \`${path.basename(zipVerifyMd)}\`: ${copiedVerifyReports.zipVerifyMd ? 'present' : 'missing'}`,
    '',
    '## Included operator helpers',
    '',
    `- \`ops/onprem-release-gate-operator-commands.sh\`: ${copiedOperatorArtifacts.onPremGateOperatorCommandScript ? 'present' : 'missing'}`,
    `- \`ops/multitable-onprem-package-install.sh\`: ${copiedOperatorArtifacts.packageInstallScript ? 'present' : 'missing'}`,
    `- \`ops/multitable-onprem-deploy-easy.sh\`: ${copiedOperatorArtifacts.deployEasyScript ? 'present' : 'missing'}`,
    `- \`ops/multitable-onprem-healthcheck.sh\`: ${copiedOperatorArtifacts.healthcheckScript ? 'present' : 'missing'}`,
    `- \`ops/multitable-onprem-preflight.sh\`: ${copiedOperatorArtifacts.preflightScript ? 'present' : 'missing'}`,
    `- \`ops/multitable-onprem-repair-helper.sh\`: ${copiedOperatorArtifacts.repairHelperScript ? 'present' : 'missing'}`,
    '- `ops/multitable-onprem-package-install.env.example.sh`: present',
    '- `ops/multitable-onprem-deploy-easy.env.example.sh`: present',
    '- `ops/multitable-onprem-healthcheck.env.example.sh`: present',
    '- `ops/multitable-onprem-preflight.env.example.sh`: present',
    `- \`ops/metasheet-healthcheck.service.example\`: ${copiedOperatorArtifacts.healthcheckService ? 'present' : 'missing'}`,
    `- \`ops/metasheet-healthcheck.timer.example\`: ${copiedOperatorArtifacts.healthcheckTimer ? 'present' : 'missing'}`,
    '',
    '## Recommended first document for the customer',
    '',
    `- \`${path.basename(docsToCopy[0])}\``,
    '',
    '## Recommended templates',
    '',
    '- Customer delivery receipt: `multitable-customer-delivery-signoff-template-20260323.md`',
    '- Controlled rollout / UAT acceptance: `multitable-uat-signoff-template-20260323.md`',
    '- Internal pilot expansion decision: `multitable-pilot-expansion-decision-template-20260323.md`',
    '- Internal pilot checkpoint review: `multitable-pilot-go-no-go-template-20260319.md`',
    '',
    '## Operator helpers',
    '',
    '- On-prem release gate helper: `ops/onprem-release-gate-operator-commands.sh`',
    '- Package install env template: `ops/multitable-onprem-package-install.env.example.sh`',
    '- Deploy env template: `ops/multitable-onprem-deploy-easy.env.example.sh`',
    '- Healthcheck env template: `ops/multitable-onprem-healthcheck.env.example.sh`',
    '- Preflight env template: `ops/multitable-onprem-preflight.env.example.sh`',
    '- Package installer helper: `ops/multitable-onprem-package-install.sh`',
    '- Deploy helper: `ops/multitable-onprem-deploy-easy.sh`',
    '- Healthcheck helper: `ops/multitable-onprem-healthcheck.sh`',
    '- Preflight helper: `ops/multitable-onprem-preflight.sh`',
    '- Preflight repair helper: `ops/multitable-onprem-repair-helper.sh`',
    '- Preflight report outputs: `PREFLIGHT_REPORT_JSON`, `PREFLIGHT_REPORT_MD` from the preflight env template',
    '- Systemd healthcheck units: `ops/metasheet-healthcheck.service.example`, `ops/metasheet-healthcheck.timer.example`',
    '',
  ].join('\n')

  const manifest = {
    package: pkg,
    bundleRoot,
    packageJson: resolvedPackageJsonPath,
    createdAt: new Date().toISOString(),
    expectedOperatorEvidence: {
      preflightReportJson: DEFAULT_PREFLIGHT_REPORT_JSON,
      preflightReportMd: DEFAULT_PREFLIGHT_REPORT_MD,
    },
    signoffBlockers: [
      `Do not complete customer delivery, UAT, or final sign-off until ${DEFAULT_PREFLIGHT_REPORT_JSON} and ${DEFAULT_PREFLIGHT_REPORT_MD} are returned.`,
    ],
    signoffRecoveryPath,
    includedDocs: docsToCopy.map((item) => path.basename(item)),
    recommendedTemplates: {
      customerDeliverySignoff: 'multitable-customer-delivery-signoff-template-20260323.md',
      uatSignoff: 'multitable-uat-signoff-template-20260323.md',
      pilotExpansionDecision: 'multitable-pilot-expansion-decision-template-20260323.md',
      pilotGoNoGo: 'multitable-pilot-go-no-go-template-20260319.md',
    },
    operatorArtifacts: {
      onPremGateOperatorCommandScript: copiedOperatorArtifacts.onPremGateOperatorCommandScript
        ? 'ops/onprem-release-gate-operator-commands.sh'
        : null,
      packageInstallScript: copiedOperatorArtifacts.packageInstallScript
        ? 'ops/multitable-onprem-package-install.sh'
        : null,
      packageInstallEnvTemplate: 'ops/multitable-onprem-package-install.env.example.sh',
      deployEasyScript: copiedOperatorArtifacts.deployEasyScript
        ? 'ops/multitable-onprem-deploy-easy.sh'
        : null,
      deployEasyEnvTemplate: 'ops/multitable-onprem-deploy-easy.env.example.sh',
      healthcheckScript: copiedOperatorArtifacts.healthcheckScript
        ? 'ops/multitable-onprem-healthcheck.sh'
        : null,
      healthcheckEnvTemplate: 'ops/multitable-onprem-healthcheck.env.example.sh',
      preflightScript: copiedOperatorArtifacts.preflightScript
        ? 'ops/multitable-onprem-preflight.sh'
        : null,
      repairHelperScript: copiedOperatorArtifacts.repairHelperScript
        ? 'ops/multitable-onprem-repair-helper.sh'
        : null,
      preflightEnvTemplate: 'ops/multitable-onprem-preflight.env.example.sh',
      preflightReportJsonDefault: DEFAULT_PREFLIGHT_REPORT_JSON,
      preflightReportMdDefault: DEFAULT_PREFLIGHT_REPORT_MD,
      healthcheckService: copiedOperatorArtifacts.healthcheckService
        ? 'ops/metasheet-healthcheck.service.example'
        : null,
      healthcheckTimer: copiedOperatorArtifacts.healthcheckTimer
        ? 'ops/metasheet-healthcheck.timer.example'
        : null,
    },
    verifyReports: {
      tgzVerifyJson: copiedVerifyReports.tgzVerifyJson ? path.basename(tgzVerifyJson) : null,
      tgzVerifyMd: copiedVerifyReports.tgzVerifyMd ? path.basename(tgzVerifyMd) : null,
      zipVerifyJson: copiedVerifyReports.zipVerifyJson ? path.basename(zipVerifyJson) : null,
      zipVerifyMd: copiedVerifyReports.zipVerifyMd ? path.basename(zipVerifyMd) : null,
    },
  }

  await writeAtomic(path.join(bundleRootTmp, 'DELIVERY.md'), `${summaryMd}\n`)
  await writeAtomic(path.join(bundleRootTmp, 'DELIVERY.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await fs.rm(bundleRoot, { recursive: true, force: true })
  await fs.mkdir(path.dirname(bundleRoot), { recursive: true })
  await fs.rename(bundleRootTmp, bundleRoot)

  process.stdout.write(`[multitable-onprem-delivery-bundle] bundle_root=${bundleRoot}\n`)
  process.stdout.write(`[multitable-onprem-delivery-bundle] package_json=${resolvedPackageJsonPath}\n`)
}

main().catch((error) => {
  process.stderr.write(`[multitable-onprem-delivery-bundle] ERROR: ${error.message}\n`)
  process.exit(1)
})
