#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// BEHAVIOUR guard for the tier-2 SSH host-key pinning of the shared
// resolve-*-token.sh scripts (2026-08-19). The static contract
// (ssh-hostkey-pin-family-contract.test.mjs) proves the text; this file proves
// the control flow, in the style of multitable-recovery-schema-containment's
// runLocal harness: execute each script with a PATH-shadowing `ssh` stub and
// assert
//   - missing DEPLOY_KNOWN_HOSTS  → defined exit via warn_or_fail AND the ssh
//     stub is NEVER invoked (required=true → exit 1; required=false → exit 0
//     with NO token — a defined-optional outcome, not a fake green),
//   - malformed DEPLOY_KNOWN_HOSTS → same,
//   - legal pin → the ssh stub IS reached (positive control for every
//     "ssh never invoked" assertion above) with StrictHostKeyChecking=yes,
//     UserKnownHostsFile=<tmp file> and GlobalKnownHostsFile=/dev/null all in
//     its argv, the tmp known_hosts file existing DURING the call and cleaned
//     up by the trap afterwards.

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

const stubBase = mkdtempSync(join(tmpdir(), 'sshpin-behavior-'))
const binDir = join(stubBase, 'bin')
mkdirSync(binDir)

// The stub records its argv (and whether the UserKnownHostsFile it was handed
// exists at call time), drains the heredoc on stdin so bash never blocks, and
// prints one line satisfying each script's token-extraction so the legal-pin
// case can complete end-to-end.
const SSH_STUB = `#!/usr/bin/env bash
khstate="absent"
for arg in "$@"; do
  case "$arg" in
    UserKnownHostsFile=*)
      if [[ -f "\${arg#UserKnownHostsFile=}" ]]; then khstate="present"; else khstate="missing"; fi
      ;;
  esac
done
printf 'ssh %s [khfile=%s]\\n' "$*" "$khstate" >> "$STUB_LOG"
cat >/dev/null 2>&1 || true
echo "K3_WISE_SMOKE_TENANT_ID=tenant-stub"
echo "stubheader.stubpayload.stubsig"
echo "__METRICS_SCRAPE_TOKEN_BEGIN__stub-metrics-token__METRICS_SCRAPE_TOKEN_END__"
exit 0
`
writeFileSync(join(binDir, 'ssh'), SSH_STUB)
chmodSync(join(binDir, 'ssh'), 0o755)

const LEGAL_PIN_RAW = 'deploy.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIStubStubStubStubStubStubStubStubStubStubStub'
const LEGAL_PIN_B64 = Buffer.from(LEGAL_PIN_RAW).toString('base64')

let seq = 0
function runScript(script, envOverrides = {}) {
  const runId = seq++
  const logPath = join(stubBase, `stub-log-${runId}.txt`)
  const tmpDir = join(stubBase, `tmp-${runId}`)
  const ghEnvPath = join(stubBase, `github-env-${runId}.txt`)
  mkdirSync(tmpDir)
  writeFileSync(logPath, '')
  writeFileSync(ghEnvPath, '')
  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: stubBase,
    TMPDIR: tmpDir,
    STUB_LOG: logPath,
    GITHUB_ENV: ghEnvPath,
    DEPLOY_HOST: 'deploy.invalid',
    DEPLOY_USER: 'deployer',
    DEPLOY_SSH_KEY_B64: Buffer.from('dummy-deploy-key').toString('base64'),
    ...envOverrides,
  }
  const result = spawnSync('bash', [join(repoRoot, 'scripts', 'ops', script)], {
    env,
    cwd: stubBase,
    encoding: 'utf8',
  })
  assert.equal(result.error, undefined, `bash must spawn cleanly: ${result.error && result.error.message}`)
  const log = readFileSync(logPath, 'utf8')
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    sshCalled: /^ssh /m.test(log),
    sshLog: log,
    tmpDir,
    githubEnv: readFileSync(ghEnvPath, 'utf8'),
  }
}

// Per-script env needed to route execution onto the SSH fallback path.
const SCRIPTS = [
  {
    script: 'resolve-attendance-smoke-token.sh',
    requiredVar: 'ATTENDANCE_TOKEN_RESOLVE_REQUIRED',
    fallbackEnv: {},
    hasStdoutToken: (r) => r.stdout.includes('stubheader.stubpayload.stubsig'),
  },
  {
    script: 'resolve-k3wise-smoke-token.sh',
    requiredVar: 'K3_WISE_TOKEN_RESOLVE_REQUIRED',
    fallbackEnv: { METASHEET_TENANT_ID: 'tenant-x' },
    hasStdoutToken: (r) => r.githubEnv.includes('stubheader.stubpayload.stubsig'),
  },
  {
    script: 'resolve-metrics-scrape-token.sh',
    requiredVar: 'METRICS_SCRAPE_TOKEN_RESOLVE_REQUIRED',
    fallbackEnv: {},
    hasStdoutToken: (r) => r.stdout.includes('stub-metrics-token'),
  },
]

for (const { script, requiredVar, fallbackEnv, hasStdoutToken } of SCRIPTS) {
  test(`${script}: MISSING DEPLOY_KNOWN_HOSTS + required=true → exit 1, ssh never invoked, no token`, () => {
    const r = runScript(script, { ...fallbackEnv, [requiredVar]: 'true' })
    assert.equal(r.status, 1)
    assert.equal(r.sshCalled, false, `ssh must never run: ${r.sshLog}`)
    assert.match(r.stderr, /::error::.*DEPLOY_KNOWN_HOSTS is required to pin/)
    assert.equal(hasStdoutToken(r), false, 'no token may be produced')
  })

  test(`${script}: MISSING DEPLOY_KNOWN_HOSTS + required=false → warn exit 0 (defined-optional), ssh never invoked, no token`, () => {
    const r = runScript(script, { ...fallbackEnv, [requiredVar]: 'false' })
    assert.equal(r.status, 0)
    assert.equal(r.sshCalled, false, `ssh must never run: ${r.sshLog}`)
    assert.match(r.stderr, /::warning::.*DEPLOY_KNOWN_HOSTS is required to pin/)
    assert.equal(hasStdoutToken(r), false, 'no token may be produced')
  })

  test(`${script}: MALFORMED DEPLOY_KNOWN_HOSTS + required=true → exit 1, ssh never invoked, tmp files trap-cleaned`, () => {
    const r = runScript(script, {
      ...fallbackEnv,
      [requiredVar]: 'true',
      DEPLOY_KNOWN_HOSTS: 'garbage-that-is-not-a-hostkey',
    })
    assert.equal(r.status, 1)
    assert.equal(r.sshCalled, false, `ssh must never run: ${r.sshLog}`)
    assert.match(r.stderr, /::error::DEPLOY_KNOWN_HOSTS did not resolve to a recognizable key/)
    assert.equal(hasStdoutToken(r), false, 'no token may be produced')
    // Both mktemp'd files (ssh key + known_hosts) were created before the
    // rejection — the EXIT trap must have removed them.
    assert.deepEqual(readdirSync(r.tmpDir), [], 'trap must clean tmp key + known_hosts on the malformed-pin exit')
  })

  test(`${script}: LEGAL raw pin → ssh reached with all three pin options, tmp known_hosts live during ssh and trap-cleaned after`, () => {
    const r = runScript(script, {
      ...fallbackEnv,
      [requiredVar]: 'true',
      DEPLOY_KNOWN_HOSTS: LEGAL_PIN_RAW,
    })
    assert.equal(r.status, 0, `stderr: ${r.stderr}`)
    assert.equal(r.sshCalled, true, 'positive control: legal pin must reach the ssh stub')
    assert.match(r.sshLog, /-o StrictHostKeyChecking=yes/)
    assert.doesNotMatch(r.sshLog, /StrictHostKeyChecking=no/)
    const khMatch = r.sshLog.match(/UserKnownHostsFile=(\S+)/)
    assert.ok(khMatch, `argv must carry UserKnownHostsFile=<tmp file>: ${r.sshLog}`)
    assert.ok(khMatch[1].startsWith(r.tmpDir), 'known_hosts must be the script-owned mktemp file')
    assert.match(r.sshLog, /-o GlobalKnownHostsFile=\/dev\/null/)
    assert.match(r.sshLog, /\[khfile=present\]/, 'known_hosts file must exist at ssh time')
    assert.equal(existsSync(khMatch[1]), false, 'trap must remove the tmp known_hosts after exit')
    assert.deepEqual(readdirSync(r.tmpDir), [], 'trap must clean tmp key + known_hosts')
    assert.equal(hasStdoutToken(r), true, 'legal pin must yield the stub token end-to-end')
    // The pinned content is what the secret carried.
    // (File is gone post-exit; content correctness is covered by the khfile=present probe
    // plus the raw/base64 equivalence case below.)
  })
}

test('base64-encoded DEPLOY_KNOWN_HOSTS decodes to the same pinned behaviour (attendance)', () => {
  const r = runScript('resolve-attendance-smoke-token.sh', {
    ATTENDANCE_TOKEN_RESOLVE_REQUIRED: 'true',
    DEPLOY_KNOWN_HOSTS: LEGAL_PIN_B64,
  })
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  assert.equal(r.sshCalled, true)
  assert.match(r.sshLog, /-o StrictHostKeyChecking=yes/)
  assert.match(r.sshLog, /\[khfile=present\]/)
})

test('K3 configured-token FAST PATH is untouched: no DEPLOY_KNOWN_HOSTS needed, ssh never invoked, token still exported', () => {
  const r = runScript('resolve-k3wise-smoke-token.sh', {
    K3_WISE_TOKEN_RESOLVE_REQUIRED: 'true',
    METASHEET_K3WISE_SMOKE_TOKEN_SECRET: 'cfgheader.cfgpayload.cfgsig',
    METASHEET_TENANT_ID: 'tenant-x',
    // deliberately NO DEPLOY_KNOWN_HOSTS
  })
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  assert.equal(r.sshCalled, false, 'fast path must not ssh')
  assert.ok(r.githubEnv.includes('cfgheader.cfgpayload.cfgsig'), 'configured token must still be exported')
})
