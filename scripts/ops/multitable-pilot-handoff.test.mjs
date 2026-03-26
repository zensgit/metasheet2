import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'

const repoRoot = '/Users/huazhou/Downloads/Github/metasheet2-multitable-next'

function writeFile(filePath, content, executable = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  if (executable) {
    fs.chmodSync(filePath, 0o755)
  }
}

test('multitable pilot handoff promotes embed-host readiness evidence into top-level artifacts', () => {
  const stamp = `test-handoff-${Date.now()}`
  const packageName = `metasheet-multitable-onprem-${stamp}`
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-handoff-'))
  const readinessRoot = path.join(repoRoot, 'output/playwright/multitable-pilot-ready-local', stamp)
  const handoffOutputRoot = path.join(tmpRoot, 'handoff-output')
  const gateRoot = path.join(repoRoot, 'output/releases/multitable-onprem/gates', `${stamp}-gate`)
  const gateReportPath = path.join(gateRoot, 'report.json')
  const packageJsonPath = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.json`)
  const releaseBuildRoot = path.join(repoRoot, 'output/releases/multitable-onprem/.build', packageName)
  const releasePackageRoot = path.join(repoRoot, 'output/releases/multitable-onprem/.build', packageName, packageName)
  const deliveryRoot = path.join(repoRoot, 'output/delivery/multitable-onprem', packageName)
  const releaseTgz = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.tgz`)
  const releaseZip = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.zip`)

  try {
    writeFile(path.join(readinessRoot, 'readiness.md'), '# readiness\n')
    writeFile(path.join(readinessRoot, 'readiness.json'), JSON.stringify({
      ok: false,
      localRunner: {
        required: true,
        available: true,
        ok: true,
        runMode: 'local',
        report: path.join(readinessRoot, 'smoke', 'local-report.json'),
        reportMd: path.join(readinessRoot, 'smoke', 'local-report.md'),
        runnerReport: path.join(readinessRoot, 'smoke', 'report.json'),
        serviceModes: {
          backend: 'reused',
          web: 'started',
        },
        embedHostAcceptance: {
          available: true,
          ok: true,
        },
      },
      embedHostProtocol: {
        available: true,
        ok: true,
        requiredWhenPresent: [
          'ui.embed-host.ready',
          'ui.embed-host.state-query.initial',
        ],
        observedChecks: [
          'ui.embed-host.ready',
          'ui.embed-host.state-query.initial',
        ],
        missingChecks: [],
      },
      embedHostNavigationProtection: {
        available: true,
        ok: false,
        requiredWhenPresent: [
          'ui.embed-host.form-ready',
          'api.embed-host.discard-unsaved-form-draft',
        ],
        observedChecks: ['ui.embed-host.form-ready'],
        missingChecks: ['api.embed-host.discard-unsaved-form-draft'],
      },
      embedHostDeferredReplay: {
        available: true,
        ok: true,
        requiredWhenPresent: [
          'ui.embed-host.navigate.deferred',
          'ui.embed-host.navigate.replayed',
        ],
        observedChecks: [
          'ui.embed-host.navigate.deferred',
          'ui.embed-host.navigate.replayed',
        ],
        missingChecks: [],
      },
      gates: {
        operatorCommandEntries: [
          {
            name: 'showArtifacts',
            command: '/tmp/operator-commands.sh show-artifacts',
          },
          {
            name: 'rerunGate',
            command: '/tmp/operator-commands.sh rerun-gate',
          },
        ],
        operatorChecklist: [
          {
            step: 1,
            title: 'Review the canonical gate report before promotion or replay',
            artifact: '/tmp/gate/report.json',
          },
          {
            step: 2,
            title: 'Use the helper instead of rebuilding replay commands by hand',
            artifact: '/tmp/gate/operator-commands.sh',
          },
        ],
      },
    }, null, 2))
    writeFile(path.join(readinessRoot, 'gates', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'gates', 'report.md'), '# gate report\n')
    writeFile(path.join(readinessRoot, 'gates', 'release-gate.log'), 'gate log\n')
    writeFile(path.join(readinessRoot, 'gates', 'operator-commands.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(readinessRoot, 'smoke', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'smoke', 'report.md'), '# smoke report\n')
    writeFile(path.join(readinessRoot, 'smoke', 'local-report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'smoke', 'local-report.md'), '# local report\n')
    writeFile(path.join(readinessRoot, 'profile', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'profile', 'summary.md'), '# profile\n')

    writeFile(packageJsonPath, JSON.stringify({ name: packageName }, null, 2))
    writeFile(releaseTgz, 'tgz')
    writeFile(releaseZip, 'zip')
    writeFile(`${releaseTgz}.sha256`, 'sha')
    writeFile(`${releaseZip}.sha256`, 'sha')
    writeFile(path.join(repoRoot, 'output/releases/multitable-onprem', 'SHA256SUMS'), 'checksums\n')

    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-deploy-easy.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-package-install.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-healthcheck.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.service.example'), '[Unit]\n')
    writeFile(path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.timer.example'), '[Timer]\n')

    writeFile(path.join(deliveryRoot, 'DELIVERY.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(deliveryRoot, 'DELIVERY.md'), '# delivery\n')

    writeFile(gateReportPath, JSON.stringify({
      ok: true,
      packageName,
      packageJson: packageJsonPath,
      operatorCommands: [
        {
          name: 'showSignoffEvidence',
          command: '/tmp/release-gate/operator-commands.sh show-signoff-evidence',
        },
        {
          name: 'rerunGate',
          command: 'pnpm verify:multitable-onprem:release-gate',
        },
      ],
      operatorChecklist: [
        {
          step: 1,
          title: 'Review gate status and package identity',
          artifact: '/tmp/release-gate/report.md',
        },
        {
          step: 2,
          title: 'Confirm tgz and zip verify reports are present and PASS',
          artifact: '/tmp/release-gate/verify-tgz.json',
        },
      ],
      signoffRecoveryPath: {
        step1RunPreflight: 'bash ./artifacts/preflight/multitable-onprem-preflight.sh',
        step2RepairInstruction: 'run the first quick fix',
        step2RepairHelper: 'artifacts/preflight/multitable-onprem-repair-helper.sh',
        step3ReturnEvidence: [
          '/opt/metasheet/output/preflight/multitable-onprem-preflight.json',
          '/opt/metasheet/output/preflight/multitable-onprem-preflight.md',
        ],
      },
    }, null, 2))
    writeFile(path.join(gateRoot, 'report.md'), '# gate\n')
    writeFile(path.join(gateRoot, 'operator-commands.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(gateRoot, 'logs', 'build.log'), 'build\n')
    writeFile(path.join(gateRoot, 'logs', 'verify-tgz.log'), 'verify tgz\n')
    writeFile(path.join(gateRoot, 'logs', 'verify-zip.log'), 'verify zip\n')
    writeFile(path.join(gateRoot, 'logs', 'delivery.log'), 'delivery\n')

    execFileSync('node', ['scripts/ops/multitable-pilot-handoff.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        READINESS_ROOT: readinessRoot,
        HANDOFF_OUTPUT_ROOT: handoffOutputRoot,
        ONPREM_GATE_REPORT_JSON: gateReportPath,
        REQUIRE_ONPREM_GATE: 'true',
        REQUIRE_EXPLICIT_ONPREM_GATE: 'true',
      },
      stdio: 'pipe',
    })

    const handoffRoot = path.join(handoffOutputRoot, stamp)
    const handoffJson = JSON.parse(fs.readFileSync(path.join(handoffRoot, 'handoff.json'), 'utf8'))
    const handoffMd = fs.readFileSync(path.join(handoffRoot, 'handoff.md'), 'utf8')

    assert.equal(handoffJson.embedHostAcceptance.ok, false)
    assert.equal(handoffJson.embedHostProtocol.available, true)
    assert.equal(handoffJson.embedHostProtocol.ok, true)
    assert.equal(handoffJson.embedHostNavigationProtection.ok, false)
    assert.equal(handoffJson.embedHostDeferredReplay.ok, true)
    assert.equal(handoffJson.pilotRunner.runMode, 'local')
    assert.equal(handoffJson.localRunner.available, true)
    assert.equal(handoffJson.artifactChecks.readinessGate.readinessGateReportMd, true)
    assert.equal(handoffJson.artifactChecks.readinessGate.readinessGateLog, true)
    assert.equal(handoffJson.artifactChecks.readinessGate.readinessGateOperatorCommands, true)
    assert.equal(handoffJson.readinessGateOperatorContract.operatorCommandEntries.length, 2)
    assert.equal(handoffJson.readinessGateOperatorContract.operatorChecklist.length, 2)
    assert.equal(handoffJson.onPremReleaseGateOperatorContract.operatorCommandEntries.length, 2)
    assert.equal(handoffJson.onPremReleaseGateOperatorContract.operatorChecklist.length, 2)
    assert.equal(handoffJson.artifactChecks.readinessGate.operatorCommandEntries.length, 2)
    assert.equal(handoffJson.artifactChecks.readinessGate.operatorChecklist.length, 2)
    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.operatorCommandEntries.length, 2)
    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.operatorChecklist.length, 2)
    assert.equal(handoffJson.localRunner.serviceModes.backend, 'reused')
    assert.equal(handoffJson.localRunner.serviceModes.web, 'started')
    assert.deepEqual(
      handoffJson.embedHostNavigationProtection.missingChecks,
      ['api.embed-host.discard-unsaved-form-draft'],
    )
    assert.match(handoffMd, /## Embed Host Acceptance/)
    assert.match(handoffMd, /## Pilot Runner/)
    assert.match(handoffMd, /Run mode: `local`/)
    assert.match(handoffMd, /Backend mode: `reused`/)
    assert.match(handoffMd, /Web mode: `started`/)
    assert.match(handoffMd, /Overall embed-host acceptance: \*\*FAIL\*\*/)
    assert.match(handoffMd, /### Embed Host Protocol Evidence/)
    assert.match(handoffMd, /### Embed Host Navigation Protection/)
    assert.match(handoffMd, /### Embed Host Busy Deferred Replay/)
    assert.match(handoffMd, /## Readiness Gate Operator Contract/)
    assert.match(handoffMd, /Operator commands: `showArtifacts`, `rerunGate`/)
    assert.match(handoffMd, /Operator checklist: `1\. Review the canonical gate report before promotion or replay`, `2\. Use the helper instead of rebuilding replay commands by hand`/)
    assert.match(handoffMd, /## On-Prem Release Gate Operator Contract/)
    assert.match(handoffMd, /Operator commands: `showSignoffEvidence`, `rerunGate`/)
    assert.match(handoffMd, /Operator checklist: `1\. Review gate status and package identity`, `2\. Confirm tgz and zip verify reports are present and PASS`/)
    assert.match(handoffMd, /gates\/report\.md: `present`/)
    assert.match(handoffMd, /gates\/release-gate\.log: `present`/)
    assert.match(handoffMd, /gates\/operator-commands\.sh: `present`/)
    assert.match(handoffMd, /smoke\/report\.md: `present`/)
  } finally {
    fs.rmSync(readinessRoot, { recursive: true, force: true })
    fs.rmSync(handoffOutputRoot, { recursive: true, force: true })
    fs.rmSync(gateRoot, { recursive: true, force: true })
    fs.rmSync(packageJsonPath, { force: true })
    fs.rmSync(releaseTgz, { force: true })
    fs.rmSync(releaseZip, { force: true })
    fs.rmSync(`${releaseTgz}.sha256`, { force: true })
    fs.rmSync(`${releaseZip}.sha256`, { force: true })
    fs.rmSync(releaseBuildRoot, { recursive: true, force: true })
    fs.rmSync(deliveryRoot, { recursive: true, force: true })
  }
})

test('multitable pilot handoff falls back to staging runner report names when staging readiness omits explicit report paths', () => {
  const stamp = `test-handoff-staging-${Date.now()}`
  const packageName = `metasheet-multitable-onprem-${stamp}`
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-handoff-staging-'))
  const readinessRoot = path.join(repoRoot, 'output/playwright/multitable-pilot-ready-staging', stamp)
  const handoffOutputRoot = path.join(tmpRoot, 'handoff-output')
  const gateRoot = path.join(repoRoot, 'output/releases/multitable-onprem/gates', `${stamp}-gate`)
  const gateReportPath = path.join(gateRoot, 'report.json')
  const packageJsonPath = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.json`)
  const releaseBuildRoot = path.join(repoRoot, 'output/releases/multitable-onprem/.build', packageName)
  const releasePackageRoot = path.join(repoRoot, 'output/releases/multitable-onprem/.build', packageName, packageName)
  const deliveryRoot = path.join(repoRoot, 'output/delivery/multitable-onprem', packageName)
  const releaseTgz = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.tgz`)
  const releaseZip = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.zip`)

  try {
    writeFile(path.join(readinessRoot, 'readiness.md'), '# readiness\n')
    writeFile(path.join(readinessRoot, 'readiness.json'), JSON.stringify({
      ok: true,
      pilotRunner: {
        required: true,
        available: true,
        ok: true,
        runMode: 'staging',
        serviceModes: {
          backend: 'reused',
          web: 'reused',
        },
        embedHostAcceptance: {
          available: true,
          ok: true,
        },
      },
      embedHostProtocol: { available: true, ok: true, requiredWhenPresent: [], observedChecks: [], missingChecks: [] },
      embedHostNavigationProtection: { available: true, ok: true, requiredWhenPresent: [], observedChecks: [], missingChecks: [] },
      embedHostDeferredReplay: { available: true, ok: true, requiredWhenPresent: [], observedChecks: [], missingChecks: [] },
    }, null, 2))
    writeFile(path.join(readinessRoot, 'gates', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'gates', 'report.md'), '# gate report\n')
    writeFile(path.join(readinessRoot, 'gates', 'release-gate.log'), 'gate log\n')
    writeFile(path.join(readinessRoot, 'gates', 'operator-commands.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(readinessRoot, 'smoke', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'smoke', 'report.md'), '# smoke report\n')
    writeFile(path.join(readinessRoot, 'smoke', 'staging-report.json'), JSON.stringify({ ok: true, runMode: 'staging' }, null, 2))
    writeFile(path.join(readinessRoot, 'smoke', 'staging-report.md'), '# staging report\n')
    writeFile(path.join(readinessRoot, 'profile', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'profile', 'summary.md'), '# profile\n')

    writeFile(packageJsonPath, JSON.stringify({ name: packageName }, null, 2))
    writeFile(releaseTgz, 'tgz')
    writeFile(releaseZip, 'zip')
    writeFile(`${releaseTgz}.sha256`, 'sha')
    writeFile(`${releaseZip}.sha256`, 'sha')
    writeFile(path.join(repoRoot, 'output/releases/multitable-onprem', 'SHA256SUMS'), 'checksums\n')

    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-deploy-easy.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-package-install.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-healthcheck.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.service.example'), '[Unit]\n')
    writeFile(path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.timer.example'), '[Timer]\n')

    writeFile(path.join(deliveryRoot, 'DELIVERY.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(deliveryRoot, 'DELIVERY.md'), '# delivery\n')

    writeFile(gateReportPath, JSON.stringify({
      ok: true,
      packageName,
      packageJson: packageJsonPath,
      signoffRecoveryPath: {
        step1RunPreflight: 'bash ./artifacts/preflight/multitable-onprem-preflight.sh',
        step2RepairInstruction: 'run the first quick fix',
        step2RepairHelper: 'artifacts/preflight/multitable-onprem-repair-helper.sh',
        step3ReturnEvidence: [
          '/opt/metasheet/output/preflight/multitable-onprem-preflight.json',
          '/opt/metasheet/output/preflight/multitable-onprem-preflight.md',
        ],
      },
    }, null, 2))
    writeFile(path.join(gateRoot, 'report.md'), '# gate\n')
    writeFile(path.join(gateRoot, 'operator-commands.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(gateRoot, 'logs', 'build.log'), 'build\n')
    writeFile(path.join(gateRoot, 'logs', 'verify-tgz.log'), 'verify tgz\n')
    writeFile(path.join(gateRoot, 'logs', 'verify-zip.log'), 'verify zip\n')
    writeFile(path.join(gateRoot, 'logs', 'delivery.log'), 'delivery\n')

    execFileSync('node', ['scripts/ops/multitable-pilot-handoff.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        READINESS_ROOT: readinessRoot,
        HANDOFF_OUTPUT_ROOT: handoffOutputRoot,
        ONPREM_GATE_REPORT_JSON: gateReportPath,
        REQUIRE_ONPREM_GATE: 'true',
        REQUIRE_EXPLICIT_ONPREM_GATE: 'true',
        PILOT_RUN_MODE: 'staging',
      },
      stdio: 'pipe',
    })

    const handoffRoot = path.join(handoffOutputRoot, stamp)
    const handoffJson = JSON.parse(fs.readFileSync(path.join(handoffRoot, 'handoff.json'), 'utf8'))

    assert.equal(handoffJson.pilotRunner.runMode, 'staging')
    assert.match(handoffJson.pilotRunner.report, /staging-report\.json$/)
    assert.match(handoffJson.pilotRunner.reportMd, /staging-report\.md$/)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'gates', 'report.md')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'gates', 'release-gate.log')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'gates', 'operator-commands.sh')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'smoke', 'report.md')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'smoke', 'staging-report.json')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'smoke', 'staging-report.md')), true)
  } finally {
    fs.rmSync(readinessRoot, { recursive: true, force: true })
    fs.rmSync(handoffOutputRoot, { recursive: true, force: true })
    fs.rmSync(gateRoot, { recursive: true, force: true })
    fs.rmSync(packageJsonPath, { force: true })
    fs.rmSync(releaseTgz, { force: true })
    fs.rmSync(releaseZip, { force: true })
    fs.rmSync(`${releaseTgz}.sha256`, { force: true })
    fs.rmSync(`${releaseZip}.sha256`, { force: true })
    fs.rmSync(releaseBuildRoot, { recursive: true, force: true })
    fs.rmSync(deliveryRoot, { recursive: true, force: true })
  }
})

test('multitable pilot handoff prefers canonical on-prem gate artifact paths over default gate-root guesses', () => {
  const stamp = `test-handoff-onprem-paths-${Date.now()}`
  const packageName = `metasheet-multitable-onprem-${stamp}`
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-handoff-onprem-paths-'))
  const readinessRoot = path.join(repoRoot, 'output/playwright/multitable-pilot-ready-local', stamp)
  const handoffOutputRoot = path.join(tmpRoot, 'handoff-output')
  const gateReportPath = path.join(tmpRoot, 'gate-report.json')
  const customGateRoot = path.join(tmpRoot, 'custom-gate')
  const customGateMd = path.join(customGateRoot, 'custom-report.md')
  const customGateHelper = path.join(customGateRoot, 'helpers', 'operator-commands.sh')
  const customGateLogs = path.join(customGateRoot, 'logs-alt')
  const packageJsonPath = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.json`)
  const releaseBuildRoot = path.join(repoRoot, 'output/releases/multitable-onprem/.build', packageName)
  const releasePackageRoot = path.join(repoRoot, 'output/releases/multitable-onprem/.build', packageName, packageName)
  const deliveryRoot = path.join(repoRoot, 'output/delivery/multitable-onprem', packageName)
  const releaseTgz = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.tgz`)
  const releaseZip = path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.zip`)

  try {
    writeFile(path.join(readinessRoot, 'readiness.md'), '# readiness\n')
    writeFile(path.join(readinessRoot, 'readiness.json'), JSON.stringify({
      ok: true,
      localRunner: {
        required: true,
        available: true,
        ok: true,
        runMode: 'local',
        report: path.join(readinessRoot, 'smoke', 'local-report.json'),
        reportMd: path.join(readinessRoot, 'smoke', 'local-report.md'),
        runnerReport: path.join(readinessRoot, 'smoke', 'report.json'),
        serviceModes: {
          backend: 'reused',
          web: 'reused',
        },
        embedHostAcceptance: {
          available: true,
          ok: true,
        },
      },
      embedHostProtocol: { available: true, ok: true, requiredWhenPresent: [], observedChecks: [], missingChecks: [] },
      embedHostNavigationProtection: { available: true, ok: true, requiredWhenPresent: [], observedChecks: [], missingChecks: [] },
      embedHostDeferredReplay: { available: true, ok: true, requiredWhenPresent: [], observedChecks: [], missingChecks: [] },
    }, null, 2))
    writeFile(path.join(readinessRoot, 'gates', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'gates', 'report.md'), '# gate report\n')
    writeFile(path.join(readinessRoot, 'gates', 'release-gate.log'), 'gate log\n')
    writeFile(path.join(readinessRoot, 'gates', 'operator-commands.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(readinessRoot, 'smoke', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'smoke', 'report.md'), '# smoke report\n')
    writeFile(path.join(readinessRoot, 'smoke', 'local-report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'smoke', 'local-report.md'), '# local report\n')
    writeFile(path.join(readinessRoot, 'profile', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'profile', 'summary.md'), '# profile\n')

    writeFile(packageJsonPath, JSON.stringify({ name: packageName }, null, 2))
    writeFile(releaseTgz, 'tgz')
    writeFile(releaseZip, 'zip')
    writeFile(`${releaseTgz}.sha256`, 'sha')
    writeFile(`${releaseZip}.sha256`, 'sha')
    writeFile(path.join(repoRoot, 'output/releases/multitable-onprem', 'SHA256SUMS'), 'checksums\n')

    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-deploy-easy.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-package-install.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'scripts/ops/multitable-onprem-healthcheck.sh'), '#!/usr/bin/env bash\n', true)
    writeFile(path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.service.example'), '[Unit]\n')
    writeFile(path.join(releasePackageRoot, 'ops/systemd/metasheet-healthcheck.timer.example'), '[Timer]\n')

    writeFile(path.join(deliveryRoot, 'DELIVERY.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(deliveryRoot, 'DELIVERY.md'), '# delivery\n')

    writeFile(gateReportPath, JSON.stringify({
      ok: true,
      packageName,
      packageJson: packageJsonPath,
      outputRoot: customGateRoot,
      reportMdPath: customGateMd,
      operatorCommandsPath: customGateHelper,
      logRoot: customGateLogs,
    }, null, 2))
    writeFile(customGateMd, '# custom gate report\n')
    writeFile(customGateHelper, '#!/usr/bin/env bash\n', true)
    writeFile(path.join(customGateLogs, 'build.log'), 'build\n')
    writeFile(path.join(customGateLogs, 'verify-tgz.log'), 'verify tgz\n')
    writeFile(path.join(customGateLogs, 'verify-zip.log'), 'verify zip\n')
    writeFile(path.join(customGateLogs, 'delivery.log'), 'delivery\n')

    execFileSync('node', ['scripts/ops/multitable-pilot-handoff.mjs'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        READINESS_ROOT: readinessRoot,
        HANDOFF_OUTPUT_ROOT: handoffOutputRoot,
        ONPREM_GATE_REPORT_JSON: gateReportPath,
        REQUIRE_ONPREM_GATE: 'true',
        REQUIRE_EXPLICIT_ONPREM_GATE: 'true',
      },
      stdio: 'pipe',
    })

    const handoffRoot = path.join(handoffOutputRoot, stamp)
    const handoffJson = JSON.parse(fs.readFileSync(path.join(handoffRoot, 'handoff.json'), 'utf8'))

    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.reportMd, true)
    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.operatorCommands, true)
    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.buildLog, true)
    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.verifyTgzLog, true)
    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.verifyZipLog, true)
    assert.equal(handoffJson.artifactChecks.onPremReleaseGate.deliveryLog, true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'release-gate', 'report.md')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'release-gate', 'operator-commands.sh')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'release-gate', 'logs', 'build.log')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'release-gate', 'logs', 'verify-tgz.log')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'release-gate', 'logs', 'verify-zip.log')), true)
    assert.equal(fs.existsSync(path.join(handoffRoot, 'release-gate', 'logs', 'delivery.log')), true)
  } finally {
    fs.rmSync(readinessRoot, { recursive: true, force: true })
    fs.rmSync(handoffOutputRoot, { recursive: true, force: true })
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.rmSync(packageJsonPath, { force: true })
    fs.rmSync(releaseTgz, { force: true })
    fs.rmSync(releaseZip, { force: true })
    fs.rmSync(`${releaseTgz}.sha256`, { force: true })
    fs.rmSync(`${releaseZip}.sha256`, { force: true })
    fs.rmSync(releaseBuildRoot, { recursive: true, force: true })
    fs.rmSync(deliveryRoot, { recursive: true, force: true })
  }
})
