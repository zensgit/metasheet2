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
    }, null, 2))
    writeFile(path.join(readinessRoot, 'gates', 'report.json'), JSON.stringify({ ok: true }, null, 2))
    writeFile(path.join(readinessRoot, 'smoke', 'report.json'), JSON.stringify({ ok: true }, null, 2))
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
    assert.deepEqual(
      handoffJson.embedHostNavigationProtection.missingChecks,
      ['api.embed-host.discard-unsaved-form-draft'],
    )
    assert.match(handoffMd, /## Embed Host Acceptance/)
    assert.match(handoffMd, /Overall embed-host acceptance: \*\*FAIL\*\*/)
    assert.match(handoffMd, /### Embed Host Protocol Evidence/)
    assert.match(handoffMd, /### Embed Host Navigation Protection/)
    assert.match(handoffMd, /### Embed Host Busy Deferred Replay/)
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
