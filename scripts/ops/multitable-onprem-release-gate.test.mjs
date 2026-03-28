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

function createFakeBash(binDir) {
  const fakeBashPath = path.join(binDir, 'bash')
  fs.writeFileSync(fakeBashPath, [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == "scripts/ops/multitable-onprem-package-verify.sh" ]]; then',
    '  mkdir -p "$(dirname "${VERIFY_REPORT_JSON}")"',
    "  printf '%s\\n' '{\"ok\":true}' > \"${VERIFY_REPORT_JSON}\"",
    "  printf '%s\\n' '# verify report' > \"${VERIFY_REPORT_MD}\"",
    '  exit 0',
    'fi',
    'exec /bin/bash "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
}

function createFakeNode(binDir) {
  const fakeNodePath = path.join(binDir, 'node')
  fs.writeFileSync(fakeNodePath, [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == "scripts/ops/multitable-onprem-delivery-bundle.mjs" ]]; then',
    '  package_name="$("$REAL_NODE" -e "const fs=require(\'fs\');const raw=JSON.parse(fs.readFileSync(process.argv[1],\'utf8\'));process.stdout.write(raw.name)" "${PACKAGE_JSON}")"',
    '  delivery_root="$PWD/output/delivery/multitable-onprem/${package_name}"',
    '  mkdir -p "${delivery_root}/verify"',
    "  printf '%s\\n' '{\"ok\":true,\"verifyReports\":{\"tgzVerifyJson\":\"verify/a.tgz.verify.json\",\"tgzVerifyMd\":\"verify/a.tgz.verify.md\",\"zipVerifyJson\":\"verify/a.zip.verify.json\",\"zipVerifyMd\":\"verify/a.zip.verify.md\"},\"recommendedTemplates\":{},\"operatorArtifacts\":{}}' > \"${delivery_root}/DELIVERY.json\"",
    "  printf '%s\\n' '# delivery bundle' > \"${delivery_root}/DELIVERY.md\"",
    "  printf '%s\\n' '{\"ok\":true}' > \"${delivery_root}/verify/${package_name}.tgz.verify.json\"",
    "  printf '%s\\n' '# tgz verify' > \"${delivery_root}/verify/${package_name}.tgz.verify.md\"",
    "  printf '%s\\n' '{\"ok\":true}' > \"${delivery_root}/verify/${package_name}.zip.verify.json\"",
    "  printf '%s\\n' '# zip verify' > \"${delivery_root}/verify/${package_name}.zip.verify.md\"",
    '  exit 0',
    'fi',
    'exec "$REAL_NODE" "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
}

test('multitable on-prem release gate writes canonical artifact paths into report json and markdown', () => {
  const stamp = `test-onprem-gate-${Date.now()}`
  const packageName = `metasheet-multitable-onprem-${stamp}`
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-onprem-gate-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakeBash(binDir)
  createFakeNode(binDir)

  const releaseRoot = path.join(repoRoot, 'output/releases/multitable-onprem')
  const packageJsonPath = path.join(releaseRoot, `${packageName}.json`)
  const archiveTgz = path.join(releaseRoot, `${packageName}.tgz`)
  const archiveZip = path.join(releaseRoot, `${packageName}.zip`)
  const checksumIndex = path.join(releaseRoot, 'SHA256SUMS')
  const gateRoot = path.join(tmpRoot, 'gate-root')
  const reportJsonPath = path.join(gateRoot, 'report.json')
  const reportMdPath = path.join(gateRoot, 'report.md')

  try {
    writeFile(packageJsonPath, JSON.stringify({
      name: packageName,
      archive: `${packageName}.tgz`,
      archiveZip: `${packageName}.zip`,
      checksumFile: 'SHA256SUMS',
    }, null, 2))
    writeFile(archiveTgz, 'tgz')
    writeFile(archiveZip, 'zip')
    writeFile(path.join(releaseRoot, `${packageName}.tgz.sha256`), 'sha')
    writeFile(path.join(releaseRoot, `${packageName}.zip.sha256`), 'sha')
    writeFile(checksumIndex, 'checksums\n')

    execFileSync('bash', ['scripts/ops/multitable-onprem-release-gate.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        REAL_NODE: process.execPath,
        BUILD_PACKAGE: 'false',
        PACKAGE_JSON: packageJsonPath,
        OUTPUT_ROOT: gateRoot,
      },
      stdio: 'pipe',
    })

    const report = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'))
    const reportMd = fs.readFileSync(reportMdPath, 'utf8')

    assert.match(report.outputRoot, /gate-root$/)
    assert.match(report.reportPath, /gate-root\/report\.json$/)
    assert.match(report.reportMdPath, /gate-root\/report\.md$/)
    assert.match(report.logRoot, /gate-root\/logs$/)
    assert.match(report.operatorCommandsPath, /gate-root\/operator-commands\.sh$/)
    assert.equal(report.operatorCommandScript, report.operatorCommandsPath)
    assert.equal(fs.existsSync(report.operatorCommandsPath), true)
    assert.match(reportMd, /Report json: `.*gate-root\/report\.json`/)
    assert.match(reportMd, /Report markdown: `.*gate-root\/report\.md`/)
    assert.match(reportMd, /Log root: `.*gate-root\/logs`/)
    assert.match(reportMd, /Operator helper: `.*gate-root\/operator-commands\.sh`/)
  } finally {
    fs.rmSync(path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.json`), { force: true })
    fs.rmSync(path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.tgz`), { force: true })
    fs.rmSync(path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.zip`), { force: true })
    fs.rmSync(path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.tgz.sha256`), { force: true })
    fs.rmSync(path.join(repoRoot, 'output/releases/multitable-onprem', `${packageName}.zip.sha256`), { force: true })
    fs.rmSync(path.join(repoRoot, 'output/delivery/multitable-onprem', packageName), { recursive: true, force: true })
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})
