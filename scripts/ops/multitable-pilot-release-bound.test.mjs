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
    'if [[ "${1:-}" == "scripts/ops/multitable-pilot-ready-release-bound.sh" ]]; then',
    '  ready_root="$PWD/${OUTPUT_ROOT}"',
    '  mkdir -p "${ready_root}/gates"',
    "  cat > \"${ready_root}/readiness.json\" <<'JSON'",
    '{',
    '  "ok": true,',
    '  "embedHostProtocol": {',
    '    "available": true,',
    '    "ok": true,',
    '    "requiredWhenPresent": ["ui.embed-host.ready"],',
    '    "observedChecks": ["ui.embed-host.ready"],',
    '    "missingChecks": []',
    '  },',
    '  "embedHostNavigationProtection": {',
    '    "available": true,',
    '    "ok": false,',
    '    "requiredWhenPresent": ["ui.embed-host.form-ready", "api.embed-host.discard-unsaved-form-draft"],',
    '    "observedChecks": ["ui.embed-host.form-ready"],',
    '    "missingChecks": ["api.embed-host.discard-unsaved-form-draft"]',
    '  }',
    '}',
    'JSON',
    "  printf '%s\\n' '# readiness' > \"${ready_root}/readiness.md\"",
    "  printf '%s\\n' '{\"ok\":true}' > \"${ready_root}/gates/report.json\"",
    "  printf '%s\\n' '# gate report' > \"${ready_root}/gates/report.md\"",
    "  printf '%s\\n' 'gate log' > \"${ready_root}/gates/release-gate.log\"",
    "  printf '%s\\n' '#!/usr/bin/env bash' > \"${ready_root}/gates/operator-commands.sh\"",
    '  chmod +x "${ready_root}/gates/operator-commands.sh"',
    '  exit 0',
    'fi',
    'if [[ "${1:-}" == "scripts/ops/multitable-pilot-handoff-release-bound.sh" ]]; then',
    '  stamp="$(basename "${READINESS_ROOT}")"',
    '  handoff_root="$PWD/${HANDOFF_OUTPUT_ROOT}/${stamp}"',
    '  mkdir -p "${handoff_root}"',
    "  cat > \"${handoff_root}/handoff.json\" <<'JSON'",
    '{',
    '  "localRunner": {',
    '    "available": true,',
    '    "ok": true,',
    '    "runMode": "staging",',
    '    "report": "/tmp/staging-report.json",',
    '    "reportMd": "/tmp/staging-report.md",',
    '    "serviceModes": {',
    '      "backend": "reused",',
    '      "web": "started"',
    '    }',
    '  },',
    '  "artifactChecks": {',
    '    "preflight": {',
    '      "preflightReportJsonDefault": "/opt/metasheet/output/preflight/multitable-onprem-preflight.json",',
    '      "preflightReportMdDefault": "/opt/metasheet/output/preflight/multitable-onprem-preflight.md"',
    '    },',
    '    "readinessGate": {',
    '      "operatorCommandEntries": [',
    '        { "name": "showArtifacts", "command": "/tmp/gates/operator-commands.sh show-artifacts" },',
    '        { "name": "rerunGate", "command": "/tmp/gates/operator-commands.sh rerun-gate" }',
    '      ],',
    '      "operatorChecklist": [',
    '        { "step": 1, "title": "Review the canonical gate report before promotion or replay", "artifact": "/tmp/gates/report.json" },',
    '        { "step": 2, "title": "Use the helper instead of rebuilding replay commands by hand", "artifact": "/tmp/gates/operator-commands.sh" }',
    '      ]',
    '    }',
    '  },',
    '  "readinessGateOperatorContract": {',
    '    "helper": "/tmp/gates/operator-commands.sh",',
    '    "operatorCommandEntries": [',
    '      { "name": "showArtifacts", "command": "/tmp/gates/operator-commands.sh show-artifacts" },',
    '      { "name": "rerunGate", "command": "/tmp/gates/operator-commands.sh rerun-gate" }',
    '    ],',
    '    "operatorChecklist": [',
    '      { "step": 1, "title": "Review the canonical gate report before promotion or replay", "artifact": "/tmp/gates/report.json" },',
    '      { "step": 2, "title": "Use the helper instead of rebuilding replay commands by hand", "artifact": "/tmp/gates/operator-commands.sh" }',
    '    ]',
    '  },',
    '  "onPremReleaseGateOperatorContract": {',
    '    "helper": "/tmp/release-gate/operator-commands.sh",',
    '    "operatorCommandEntries": [',
    '      { "name": "showSignoffEvidence", "command": "/tmp/release-gate/operator-commands.sh show-signoff-evidence" },',
    '      { "name": "rerunGate", "command": "pnpm verify:multitable-onprem:release-gate" }',
    '    ],',
    '    "operatorChecklist": [',
    '      { "step": 1, "title": "Review gate status and package identity", "artifact": "/tmp/release-gate/report.md" },',
    '      { "step": 2, "title": "Confirm tgz and zip verify reports are present and PASS", "artifact": "/tmp/release-gate/verify-tgz.json" }',
    '    ]',
    '  },',
    '  "recommendedTemplates": {',
    '    "goNoGo": "docs/multitable-pilot-go-no-go-template-20260319.md"',
    '  },',
    '  "embedHostAcceptance": {',
    '    "ok": false',
    '  },',
    '  "embedHostProtocol": {',
    '    "available": true,',
    '    "ok": true',
    '  },',
    '  "embedHostNavigationProtection": {',
    '    "available": true,',
    '    "ok": false,',
    '    "missingChecks": ["api.embed-host.discard-unsaved-form-draft"]',
    '  },',
    '  "embedHostDeferredReplay": {',
    '    "available": true,',
    '    "ok": true',
    '  }',
    '}',
    'JSON',
    "  printf '%s\\n' '# handoff' > \"${handoff_root}/handoff.md\"",
    '  exit 0',
    'fi',
    'exec /bin/bash "$@"',
    '',
  ].join('\n'), { mode: 0o755 })
}

test('multitable pilot release-bound promotes embed-host evidence into top-level report', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-bound-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  createFakeBash(binDir)

  const stamp = `test-release-bound-${Date.now()}`
  const readyOutputRoot = `output/playwright/test-ready-local/${stamp}`
  const handoffOutputRoot = 'output/playwright/test-handoff'
  const reportRoot = `output/playwright/test-release-bound/${stamp}`
  const handoffRoot = path.join(repoRoot, handoffOutputRoot, stamp)
  const gateReportPath = path.join(tmpRoot, 'gate', 'report.json')
  fs.mkdirSync(path.dirname(gateReportPath), { recursive: true })
  fs.writeFileSync(gateReportPath, JSON.stringify({ ok: true }, null, 2))
  writeFile(path.join(handoffRoot, 'handoff.json'), JSON.stringify({
    localRunner: {
      available: true,
      ok: true,
      runMode: 'staging',
      report: '/tmp/staging-report.json',
      reportMd: '/tmp/staging-report.md',
      serviceModes: {
        backend: 'reused',
        web: 'started',
      },
    },
    artifactChecks: {
      preflight: {
        preflightReportJsonDefault: '/opt/metasheet/output/preflight/multitable-onprem-preflight.json',
        preflightReportMdDefault: '/opt/metasheet/output/preflight/multitable-onprem-preflight.md',
      },
      readinessGate: {
        operatorCommandEntries: [
          { name: 'showArtifacts', command: '/tmp/gates/operator-commands.sh show-artifacts' },
          { name: 'rerunGate', command: '/tmp/gates/operator-commands.sh rerun-gate' },
        ],
        operatorChecklist: [
          {
            step: 1,
            title: 'Review the canonical gate report before promotion or replay',
            artifact: '/tmp/gates/report.json',
          },
          {
            step: 2,
            title: 'Use the helper instead of rebuilding replay commands by hand',
            artifact: '/tmp/gates/operator-commands.sh',
          },
        ],
      },
    },
    readinessGateOperatorContract: {
      helper: '/tmp/gates/operator-commands.sh',
      operatorCommandEntries: [
        { name: 'showArtifacts', command: '/tmp/gates/operator-commands.sh show-artifacts' },
        { name: 'rerunGate', command: '/tmp/gates/operator-commands.sh rerun-gate' },
      ],
      operatorChecklist: [
        {
          step: 1,
          title: 'Review the canonical gate report before promotion or replay',
          artifact: '/tmp/gates/report.json',
        },
        {
          step: 2,
          title: 'Use the helper instead of rebuilding replay commands by hand',
          artifact: '/tmp/gates/operator-commands.sh',
        },
      ],
    },
    onPremReleaseGateOperatorContract: {
      helper: '/tmp/release-gate/operator-commands.sh',
      operatorCommandEntries: [
        { name: 'showSignoffEvidence', command: '/tmp/release-gate/operator-commands.sh show-signoff-evidence' },
        { name: 'rerunGate', command: 'pnpm verify:multitable-onprem:release-gate' },
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
    },
    recommendedTemplates: {
      goNoGo: 'docs/multitable-pilot-go-no-go-template-20260319.md',
    },
    embedHostAcceptance: { ok: false },
    embedHostProtocol: { available: true, ok: true },
    embedHostNavigationProtection: {
      available: true,
      ok: false,
      missingChecks: ['api.embed-host.discard-unsaved-form-draft'],
    },
    embedHostDeferredReplay: { available: true, ok: true },
  }, null, 2))
  writeFile(path.join(handoffRoot, 'handoff.md'), '# handoff\n')

  try {
    execFileSync('bash', ['scripts/ops/multitable-pilot-release-bound.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ONPREM_GATE_REPORT_JSON: gateReportPath,
        RUN_MODE: 'staging',
        RUN_STAMP: stamp,
        READY_OUTPUT_ROOT: readyOutputRoot,
        HANDOFF_OUTPUT_ROOT: handoffOutputRoot,
        REPORT_ROOT: reportRoot,
      },
      stdio: 'pipe',
    })

    const reportJsonPath = path.join(repoRoot, reportRoot, 'report.json')
    const reportMdPath = path.join(repoRoot, reportRoot, 'report.md')
    const report = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'))
    const reportMd = fs.readFileSync(reportMdPath, 'utf8')

    assert.equal(report.ok, false)
    assert.equal(report.embedHostAcceptance.ok, false)
    assert.equal(report.runMode, 'staging')
    assert.match(report.readinessGateReport, /gates\/report\.json$/)
    assert.match(report.readinessGateReportMd, /gates\/report\.md$/)
    assert.match(report.readinessGateLog, /gates\/release-gate\.log$/)
    assert.match(report.readinessGateOperatorCommands, /gates\/operator-commands\.sh$/)
    assert.equal(report.readinessGateOperatorContract.operatorCommandEntries.length, 2)
    assert.equal(report.readinessGateOperatorContract.operatorChecklist.length, 2)
    assert.equal(report.onPremReleaseGateOperatorContract.operatorCommandEntries.length, 2)
    assert.equal(report.onPremReleaseGateOperatorContract.operatorChecklist.length, 2)
    assert.equal(report.pilotRunner.runMode, 'staging')
    assert.equal(report.localRunner.available, true)
    assert.equal(report.localRunner.serviceModes.backend, 'reused')
    assert.equal(report.localRunner.serviceModes.web, 'started')
    assert.equal(report.embedHostProtocol.available, true)
    assert.equal(report.embedHostProtocol.ok, true)
    assert.equal(report.embedHostNavigationProtection.ok, false)
    assert.equal(report.embedHostDeferredReplay.ok, true)
    assert.deepEqual(
      report.embedHostNavigationProtection.missingChecks,
      ['api.embed-host.discard-unsaved-form-draft'],
    )
    assert.match(reportMd, /## Embed Host Acceptance/)
    assert.match(reportMd, /## Pilot Runner/)
    assert.match(reportMd, /Run mode: `staging`/)
    assert.match(reportMd, /Readiness gate markdown: `.*gates\/report\.md`/)
    assert.match(reportMd, /Readiness gate log: `.*gates\/release-gate\.log`/)
    assert.match(reportMd, /Readiness gate helper: `.*gates\/operator-commands\.sh`/)
    assert.match(reportMd, /## Readiness Gate Operator Contract/)
    assert.match(reportMd, /Operator commands: showArtifacts, rerunGate/)
    assert.match(reportMd, /Operator checklist: 1\. Review the canonical gate report before promotion or replay, 2\. Use the helper instead of rebuilding replay commands by hand/)
    assert.match(reportMd, /## On-Prem Release Gate Operator Contract/)
    assert.match(reportMd, /Operator commands: showSignoffEvidence, rerunGate/)
    assert.match(reportMd, /Operator checklist: 1\. Review gate status and package identity, 2\. Confirm tgz and zip verify reports are present and PASS/)
    assert.match(reportMd, /prepare:multitable-pilot:release-bound:staging/)
    assert.match(reportMd, /verify:multitable-pilot:ready:staging:release-bound/)
    assert.match(reportMd, /prepare:multitable-pilot:handoff:staging:release-bound/)
    assert.match(reportMd, /smoke\/report\.md/)
    assert.match(reportMd, /Backend mode: `reused`/)
    assert.match(reportMd, /Web mode: `started`/)
    assert.match(reportMd, /Overall embed-host acceptance: \*\*FAIL\*\*/)
    assert.match(reportMd, /Protocol evidence available: `true`/)
    assert.match(reportMd, /Navigation protection status: \*\*FAIL\*\*/)
    assert.match(reportMd, /Busy deferred replay status: \*\*PASS\*\*/)
  } finally {
    fs.rmSync(path.join(repoRoot, readyOutputRoot), { recursive: true, force: true })
    fs.rmSync(path.join(repoRoot, handoffOutputRoot), { recursive: true, force: true })
    fs.rmSync(path.join(repoRoot, reportRoot), { recursive: true, force: true })
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

test('multitable pilot release-bound falls back to staging runner report basenames when handoff omits explicit report paths', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multitable-release-bound-staging-fallback-'))
  const binDir = path.join(tmpRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })

  const fakeBashPath = path.join(binDir, 'bash')
  fs.writeFileSync(fakeBashPath, [
    '#!/bin/bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == "scripts/ops/multitable-pilot-ready-release-bound.sh" ]]; then',
    '  ready_root="$PWD/${OUTPUT_ROOT}"',
    '  mkdir -p "${ready_root}/gates" "${ready_root}/smoke"',
    "  printf '%s\\n' '{\"ok\":true}' > \"${ready_root}/readiness.json\"",
    "  printf '%s\\n' '# readiness' > \"${ready_root}/readiness.md\"",
    "  printf '%s\\n' '{\"ok\":true}' > \"${ready_root}/gates/report.json\"",
    "  printf '%s\\n' '# gate report' > \"${ready_root}/gates/report.md\"",
    "  printf '%s\\n' 'gate log' > \"${ready_root}/gates/release-gate.log\"",
    "  printf '%s\\n' '#!/usr/bin/env bash' > \"${ready_root}/gates/operator-commands.sh\"",
    '  chmod +x "${ready_root}/gates/operator-commands.sh"',
    "  printf '%s\\n' '{}' > \"${ready_root}/smoke/staging-report.json\"",
    "  printf '%s\\n' '# staging report' > \"${ready_root}/smoke/staging-report.md\"",
    '  exit 0',
    'fi',
    'if [[ "${1:-}" == "scripts/ops/multitable-pilot-handoff-release-bound.sh" ]]; then',
    '  stamp="$(basename "${READINESS_ROOT}")"',
    '  handoff_root="$PWD/${HANDOFF_OUTPUT_ROOT}/${stamp}"',
    '  mkdir -p "${handoff_root}"',
    "  cat > \"${handoff_root}/handoff.json\" <<'JSON'",
    '{',
    '  "pilotRunner": {',
    '    "available": true,',
    '    "ok": true,',
    '    "runMode": "staging",',
    '    "serviceModes": {',
    '      "backend": "reused",',
    '      "web": "reused"',
    '    }',
    '  },',
    '  "recommendedTemplates": {},',
    '  "artifactChecks": {},',
    '  "embedHostAcceptance": { "ok": true },',
    '  "embedHostProtocol": { "available": true, "ok": true },',
    '  "embedHostNavigationProtection": { "available": true, "ok": true },',
    '  "embedHostDeferredReplay": { "available": true, "ok": true }',
    '}',
    'JSON',
    "  printf '%s\\n' '# handoff' > \"${handoff_root}/handoff.md\"",
    '  exit 0',
    'fi',
    'exec /bin/bash "$@"',
    '',
  ].join('\n'), { mode: 0o755 })

  const stamp = `test-release-bound-staging-fallback-${Date.now()}`
  const readyOutputRoot = `output/playwright/test-ready-staging/${stamp}`
  const handoffOutputRoot = 'output/playwright/test-handoff-staging-fallback'
  const reportRoot = `output/playwright/test-release-bound-staging/${stamp}`
  const handoffRoot = path.join(repoRoot, handoffOutputRoot, stamp)
  const gateReportPath = path.join(tmpRoot, 'gate', 'report.json')
  fs.mkdirSync(path.dirname(gateReportPath), { recursive: true })
  fs.writeFileSync(gateReportPath, JSON.stringify({ ok: true }, null, 2))
  writeFile(path.join(handoffRoot, 'handoff.json'), JSON.stringify({
    pilotRunner: {
      available: true,
      ok: true,
      runMode: 'staging',
      serviceModes: {
        backend: 'reused',
        web: 'reused',
      },
    },
    recommendedTemplates: {},
    artifactChecks: {},
    embedHostAcceptance: { ok: true },
    embedHostProtocol: { available: true, ok: true },
    embedHostNavigationProtection: { available: true, ok: true },
    embedHostDeferredReplay: { available: true, ok: true },
  }, null, 2))
  writeFile(path.join(handoffRoot, 'handoff.md'), '# handoff\n')

  try {
    execFileSync('bash', ['scripts/ops/multitable-pilot-release-bound.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ONPREM_GATE_REPORT_JSON: gateReportPath,
        RUN_MODE: 'staging',
        RUN_STAMP: stamp,
        READY_OUTPUT_ROOT: readyOutputRoot,
        HANDOFF_OUTPUT_ROOT: handoffOutputRoot,
        REPORT_ROOT: reportRoot,
      },
      stdio: 'pipe',
    })

    const reportJsonPath = path.join(repoRoot, reportRoot, 'report.json')
    const reportMdPath = path.join(repoRoot, reportRoot, 'report.md')
    const report = JSON.parse(fs.readFileSync(reportJsonPath, 'utf8'))
    const reportMd = fs.readFileSync(reportMdPath, 'utf8')

    assert.equal(report.ok, true)
    assert.match(reportMd, /staging-report\.json/)
    assert.match(reportMd, /staging-report\.md/)
  } finally {
    fs.rmSync(path.join(repoRoot, readyOutputRoot), { recursive: true, force: true })
    fs.rmSync(path.join(repoRoot, handoffOutputRoot), { recursive: true, force: true })
    fs.rmSync(path.join(repoRoot, reportRoot), { recursive: true, force: true })
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})
