import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Contract guard for the SSH host-key-pinning security sweep (2026-08-12).
//
// Every workflow that SSHes to the production deploy host MUST verify the host
// identity (StrictHostKeyChecking=yes against a DEPLOY_KNOWN_HOSTS-derived
// known_hosts, fail-closed if the secret is absent/garbage). An unauthenticated
// responder (MITM / wrong host) could otherwise harvest the deploy key + the
// commands/secrets streamed over the connection.
//
// This test is intentionally standalone (`node --test`, no build) so it does NOT
// edit plugin-tests.yml and therefore does NOT perturb the sealed-export s6a pin.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = path.join(repoRoot, '.github', 'workflows')

// The workflows hardened by this sweep (canonical pinned pattern) + the two
// pre-existing canonical references the pattern was copied from.
const PINNED_WORKFLOWS = [
  'attendance-remote-env-reconcile-prod.yml',
  'attendance-remote-log-snapshot-prod.yml',
  'attendance-remote-metrics-prod.yml',
  'attendance-remote-preflight-prod.yml',
  'attendance-remote-upload-cleanup-prod.yml',
  'docker-build.yml',
  'yjs-staging-validation.yml',
  // canonical references (already pinned before this sweep)
  'attendance-remote-storage-prod.yml',
  'attendance-remote-docker-gc-prod.yml',
]

// docker-build.yml pins TWO SSH steps (sync + deploy); the rest pin exactly one.
const EXPECTED_PINNED_BLOCKS = { 'docker-build.yml': 2 }

function read(name) {
  return readFileSync(path.join(workflowsDir, name), 'utf8')
}

// A raw string uses the insecure option in an EXECUTABLE (non-comment) line.
function hasExecutableInsecure(raw) {
  return raw
    .split('\n')
    .some((line) => line.includes('StrictHostKeyChecking=no') && !line.trimStart().startsWith('#'))
}

function assertPinnedHostIdentity(raw) {
  assert.match(raw, /DEPLOY_KNOWN_HOSTS: \$\{\{ secrets\.DEPLOY_KNOWN_HOSTS \}\}/)
  assert.match(raw, /DEPLOY_KNOWN_HOSTS is required/)
  assert.match(raw, /decoded_known_hosts=.*base64 -d/)
  assert.match(raw, /ssh-ed25519\|ssh-rsa\|ecdsa-sha2\|ssh-dss/)
  assert.match(raw, /did not resolve to a recognizable key/)
  assert.match(raw, /StrictHostKeyChecking=yes/)
  assert.match(raw, /UserKnownHostsFile=\$HOME\/\.ssh\/known_hosts/)
  assert.match(raw, /GlobalKnownHostsFile=\/dev\/null/)
  assert.ok(!hasExecutableInsecure(raw), 'no executable StrictHostKeyChecking=no line may remain')
}

test('each hardened/canonical production SSH workflow pins the deploy-host identity', () => {
  for (const name of PINNED_WORKFLOWS) {
    assertPinnedHostIdentity(read(name))
  }
})

test('every pinned SSH step (=yes) is present in the expected count per file', () => {
  for (const name of PINNED_WORKFLOWS) {
    const raw = read(name)
    const pinned = (raw.match(/StrictHostKeyChecking=yes -o UserKnownHostsFile=\$HOME\/\.ssh\/known_hosts/g) || []).length
    const expected = EXPECTED_PINNED_BLOCKS[name] ?? 1
    assert.equal(
      pinned,
      expected,
      `${name}: expected ${expected} pinned ssh_opts block(s), found ${pinned}`,
    )
  }
})

test('NO workflow in .github/workflows uses StrictHostKeyChecking=no in an executable line', () => {
  const offenders = []
  for (const entry of readdirSync(workflowsDir)) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue
    const raw = readFileSync(path.join(workflowsDir, entry), 'utf8')
    raw.split('\n').forEach((line, i) => {
      if (line.includes('StrictHostKeyChecking=no') && !line.trimStart().startsWith('#')) {
        offenders.push(`${entry}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(offenders, [], `unpinned SSH host-key checking found:\n${offenders.join('\n')}`)
})

// Mutation / positive control: the guard must be load-bearing — reintroducing
// the insecure option, or dropping the known_hosts secret, must make it fail.
test('host-identity contract is load-bearing (mutation red)', () => {
  const raw = read('docker-build.yml')

  // Flipping ANY pinned block back to =no must trip the executable-insecure check.
  assert.throws(
    () => assertPinnedHostIdentity(raw.replace('StrictHostKeyChecking=yes', 'StrictHostKeyChecking=no')),
    /no executable StrictHostKeyChecking=no/,
  )
  // Removing the known_hosts secret wiring must trip the pinning assertions.
  assert.throws(
    () => assertPinnedHostIdentity(raw.split('DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}').join('')),
    /did not match/,
  )
  // A comment mentioning the insecure option must NOT be treated as executable.
  assert.ok(!hasExecutableInsecure('  # never use StrictHostKeyChecking=no here\n'))
})

// ═══════════════════════════════════════════════════════════════════════════════
// Tier 2 (2026-08-19): the 3 shared resolve-*-token.sh scripts + the 15 caller
// workflows that must wire DEPLOY_KNOWN_HOSTS into the invoking step.
//
// This is a SET-EQUALITY census over three mechanically discovered sets — not a
// substring spot-check. Adding a new deploy-key SSH script, a new resolver
// caller, or dropping a wiring must turn exactly this contract red.
// ═══════════════════════════════════════════════════════════════════════════════

const scriptsDir = path.join(repoRoot, 'scripts')

// Set 2: the resolver scripts pinned by tier 2.
const PINNED_RESOLVER_SCRIPTS = [
  'scripts/ops/resolve-attendance-smoke-token.sh',
  'scripts/ops/resolve-k3wise-smoke-token.sh',
  'scripts/ops/resolve-metrics-scrape-token.sh',
]

// REGISTERED-NOT-RESOLVED (separate governance, deliberately EXCLUDED from the
// pin family): the on-prem installer scripts authenticate with a
// customer-supplied SSH_KEY against customer-controlled hosts (not the
// production deploy identity), and phase5-deploy-prometheus-rules.sh scp's to an
// arbitrary operator-supplied PROMETHEUS_HOST (warn-only, no pinned identity to
// assert). Growing THIS list is a contract change, same as shrinking the pinned
// set.
const REGISTERED_NOT_RESOLVED_INSECURE = [
  'scripts/ops/dingtalk-onprem-docker-gc.sh', // 2 ssh sites
  'scripts/ops/install-dingtalk-onprem-docker-gc.sh', // 1 ssh site
]

function* walkShellScripts(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkShellScripts(full)
    } else if (entry.name.endsWith('.sh')) {
      yield full
    }
  }
}

function repoRel(p) {
  return path.relative(repoRoot, p).split(path.sep).join('/')
}

test('script census: EXACTLY the 3 resolver scripts use the production deploy key (DEPLOY_SSH_KEY_B64)', () => {
  const found = []
  for (const file of walkShellScripts(scriptsDir)) {
    if (readFileSync(file, 'utf8').includes('DEPLOY_SSH_KEY_B64')) {
      found.push(repoRel(file))
    }
  }
  assert.deepEqual(found.sort(), [...PINNED_RESOLVER_SCRIPTS].sort())
})

test('script census: executable StrictHostKeyChecking=no in scripts/ is EXACTLY the registered-not-resolved on-prem set', () => {
  const found = []
  for (const file of walkShellScripts(scriptsDir)) {
    if (hasExecutableInsecure(readFileSync(file, 'utf8'))) {
      found.push(repoRel(file))
    }
  }
  assert.deepEqual(found.sort(), [...REGISTERED_NOT_RESOLVED_INSECURE].sort())
})

function assertPinnedResolverScript(raw, label) {
  // Fail-closed known-hosts requirement, routed through warn_or_fail…
  assert.match(raw, /DEPLOY_KNOWN_HOSTS is required to pin the deploy-host identity/, label)
  assert.match(raw, /warn_or_fail "DEPLOY_KNOWN_HOSTS is required to pin the deploy-host identity[^"]*"/, label)
  assert.match(raw, /warn_or_fail "DEPLOY_KNOWN_HOSTS did not resolve to a recognizable key"/, label)
  // …and BEFORE the ssh attempt (behaviour proven separately by the PATH-shadow
  // stub test; this is the static ordering counterpart).
  const requiredIdx = raw.indexOf('DEPLOY_KNOWN_HOSTS is required to pin')
  const malformedIdx = raw.indexOf('did not resolve to a recognizable key')
  const sshIdx = raw.indexOf('ssh "${ssh_opts[@]}"')
  assert.ok(sshIdx > 0, `${label}: ssh invocation must exist`)
  assert.ok(requiredIdx > 0 && requiredIdx < sshIdx, `${label}: known-hosts requirement must precede ssh`)
  assert.ok(malformedIdx > 0 && malformedIdx < sshIdx, `${label}: malformed-pin rejection must precede ssh`)
  // Pinned ssh options on the ONE ssh_opts array.
  assert.match(raw, /-o StrictHostKeyChecking=yes/, label)
  assert.match(raw, /-o "UserKnownHostsFile=\$\{tmp_known_hosts\}"/, label)
  assert.match(raw, /-o GlobalKnownHostsFile=\/dev\/null/, label)
  assert.ok(!hasExecutableInsecure(raw), `${label}: no executable StrictHostKeyChecking=no`)
  // tmp known_hosts is tracked + cleaned by the existing trap.
  assert.match(raw, /tmp_known_hosts=""/, label)
  assert.match(raw, /rm -f "\$\{tmp_known_hosts\}"/, label)
  assert.match(raw, /trap cleanup_tmp_key EXIT/, label)
  assert.match(raw, /tmp_known_hosts="\$\(mktemp /, label)
}

test('each pinned resolver script requires DEPLOY_KNOWN_HOSTS fail-closed BEFORE ssh and pins all three options', () => {
  for (const rel of PINNED_RESOLVER_SCRIPTS) {
    assertPinnedResolverScript(readFileSync(path.join(repoRoot, rel), 'utf8'), rel)
  }
})

test('K3 configured-token fast path stays UNTOUCHED: it exits before the known-hosts requirement', () => {
  const raw = readFileSync(path.join(repoRoot, 'scripts/ops/resolve-k3wise-smoke-token.sh'), 'utf8')
  const fastPathIdx = raw.indexOf('if [[ -n "${secret_token}" ]]')
  const requiredIdx = raw.indexOf('DEPLOY_KNOWN_HOSTS is required to pin')
  assert.ok(fastPathIdx > 0, 'configured-token fast path must exist')
  assert.ok(requiredIdx > fastPathIdx, 'known-hosts requirement must come AFTER the fast-path exit')
  // The fast path block still exits without touching ssh/known-hosts.
  const fastPathBlock = raw.slice(fastPathIdx, raw.indexOf('fi', fastPathIdx))
  assert.match(fastPathBlock, /exit 0/)
  assert.ok(!fastPathBlock.includes('DEPLOY_KNOWN_HOSTS'), 'fast path must not depend on DEPLOY_KNOWN_HOSTS')
})

// ── Set 3: the 15 caller workflows ─────────────────────────────────────────────

const EXPECTED_RESOLVER_CALLERS = {
  // script basename → sorted list of workflow files that invoke it
  'resolve-attendance-smoke-token.sh': [
    'attendance-import-perf-baseline.yml',
    'attendance-import-perf-highscale.yml',
    'attendance-import-perf-longrun.yml',
    'attendance-locale-zh-smoke-prod.yml',
    'attendance-strict-gates-prod.yml',
  ],
  'resolve-k3wise-smoke-token.sh': [
    'docker-build.yml',
    'integration-composition-postdeploy-smoke.yml',
    'integration-k3wise-postdeploy-smoke.yml',
    'integration-read-selfservice-postdeploy-smoke.yml',
    'stock-preparation-mvp-postdeploy-smoke.yml',
    'stock-preparation-prep-line-extended-smoke.yml',
  ],
  'resolve-metrics-scrape-token.sh': [
    'attendance-remote-metrics-prod.yml',
    'phase5-nightly-validation-regression.yml',
    'phase5-nightly-validation.yml',
    'phase5-nightly.yml',
  ],
}

const RESOLVER_BASENAMES = Object.keys(EXPECTED_RESOLVER_CALLERS)

// An invocation line runs the script; a `paths:` filter entry merely lists it.
function isInvocationLine(line) {
  if (line.trimStart().startsWith('#')) return false
  if (/^\s*-\s*['"]?scripts\//.test(line)) return false // path-filter list entry
  return RESOLVER_BASENAMES.some((name) => line.includes(name))
}

function discoverCallers() {
  const found = {}
  for (const name of RESOLVER_BASENAMES) found[name] = []
  for (const entry of readdirSync(workflowsDir)) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue
    const lines = readFileSync(path.join(workflowsDir, entry), 'utf8').split('\n')
    for (const name of RESOLVER_BASENAMES) {
      if (lines.some((line) => isInvocationLine(line) && line.includes(name))) {
        found[name].push(entry)
      }
    }
  }
  for (const name of RESOLVER_BASENAMES) found[name].sort()
  return found
}

test('caller census: EXACTLY 15 workflows invoke the resolver scripts (set equality per script)', () => {
  assert.deepEqual(discoverCallers(), EXPECTED_RESOLVER_CALLERS)
  const total = Object.values(EXPECTED_RESOLVER_CALLERS).reduce((n, list) => n + list.length, 0)
  assert.equal(total, 15)
})

test('caller-discovery scanner is itself discriminating (negative controls)', () => {
  assert.ok(isInvocationLine('          scripts/ops/resolve-k3wise-smoke-token.sh'))
  assert.ok(isInvocationLine('            x="$(FOO=1 bash scripts/ops/resolve-metrics-scrape-token.sh)"'))
  assert.ok(!isInvocationLine("      - 'scripts/ops/resolve-attendance-smoke-token.sh'"), 'path filter entry must not count')
  assert.ok(!isInvocationLine('  # scripts/ops/resolve-attendance-smoke-token.sh'), 'comment must not count')
})

// Structural (indentation-derived, not fixed-width) step/job scoping.
function stepBlockContaining(lines, idx) {
  let start = -1
  let stepIndent = -1
  for (let i = idx; i >= 0; i--) {
    const m = lines[i].match(/^(\s*)- (name|uses):/)
    if (m) {
      start = i
      stepIndent = m[1].length
      break
    }
  }
  assert.ok(start >= 0, 'invocation must live inside a step')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)- (name|uses):/)
    if (m && m[1].length === stepIndent) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

function jobHeaderBefore(lines, idx) {
  // Job-level env lives between the job key and its `steps:` — find the
  // enclosing job's pre-steps region for the given invocation line.
  let stepsIdx = -1
  for (let i = idx; i >= 0; i--) {
    if (/^\s{2,4}steps:\s*$/.test(lines[i])) {
      stepsIdx = i
      break
    }
  }
  assert.ok(stepsIdx >= 0, 'invocation must live under a steps: block')
  let jobIdx = 0
  for (let i = stepsIdx; i >= 0; i--) {
    if (/^\s{2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      jobIdx = i
      break
    }
  }
  return lines.slice(jobIdx, stepsIdx).join('\n')
}

// The full shell command block: the invocation line plus any preceding
// backslash-continued prefix lines.
function commandBlock(lines, idx) {
  let start = idx
  while (start > 0 && lines[start - 1].trimEnd().endsWith('\\')) start--
  return lines.slice(start, idx + 1).join('\n')
}

const ENV_MAP_LINE = 'DEPLOY_KNOWN_HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}'

function assertCallerWired(lines, entry) {
  let checked = 0
  for (let idx = 0; idx < lines.length; idx++) {
    if (!isInvocationLine(lines[idx])) continue
    checked++
    // (1) DEPLOY_KNOWN_HOSTS must be mapped in the invoking step's env, or in
    //     the enclosing job's env when the step has no own mapping.
    const step = stepBlockContaining(lines, idx)
    const wired = step.includes(ENV_MAP_LINE) || jobHeaderBefore(lines, idx).includes(ENV_MAP_LINE)
    assert.ok(wired, `${entry}:${idx + 1}: invoking step must map ${ENV_MAP_LINE}`)
    // (2) Where the script is invoked behind an explicit VAR=… env prefix, the
    //     prefix allowlist must ALSO carry DEPLOY_KNOWN_HOSTS (the prefix is the
    //     wiring convention there; env alone is not the documented contract).
    const block = commandBlock(lines, idx)
    const scriptAt = RESOLVER_BASENAMES.reduce((min, name) => {
      const at = block.indexOf(name)
      return at >= 0 && (min < 0 || at < min) ? at : min
    }, -1)
    const beforeScript = block.slice(0, scriptAt)
    const prefixStyle = /[A-Z_][A-Z0-9_]*=/.test(beforeScript)
    if (prefixStyle) {
      assert.ok(
        /DEPLOY_KNOWN_HOSTS=/.test(block),
        `${entry}:${idx + 1}: env-prefix invocation must carry DEPLOY_KNOWN_HOSTS=`,
      )
    }
  }
  assert.ok(checked > 0, `${entry}: expected at least one resolver invocation`)
  return checked
}

test('every resolver caller wires DEPLOY_KNOWN_HOSTS into the invoking step (env map + inline prefix where used)', () => {
  for (const list of Object.values(EXPECTED_RESOLVER_CALLERS)) {
    for (const entry of list) {
      assertCallerWired(readFileSync(path.join(workflowsDir, entry), 'utf8').split('\n'), entry)
    }
  }
})

// Mutation / positive controls: each tier-2 assertion must be load-bearing.
test('tier-2 contract is load-bearing (mutation red)', () => {
  // (a) Script: flipping the pin back to =no must go red.
  const script = readFileSync(path.join(repoRoot, 'scripts/ops/resolve-attendance-smoke-token.sh'), 'utf8')
  assert.throws(
    () => assertPinnedResolverScript(script.replace('StrictHostKeyChecking=yes', 'StrictHostKeyChecking=no'), 'mutated'),
    /mutated/,
  )
  // (b) Script: deleting the UserKnownHostsFile pin must go red.
  assert.throws(
    () => assertPinnedResolverScript(script.replace('-o "UserKnownHostsFile=${tmp_known_hosts}" ', ''), 'mutated'),
    /mutated/,
  )
  // (c) Script: deleting the GlobalKnownHostsFile pin must go red.
  assert.throws(
    () => assertPinnedResolverScript(script.replace('-o GlobalKnownHostsFile=/dev/null ', ''), 'mutated'),
    /mutated/,
  )
  // (d) Script: deleting the fail-closed requirement must go red.
  assert.throws(
    () => assertPinnedResolverScript(script.split('DEPLOY_KNOWN_HOSTS is required to pin the deploy-host identity').join('X'), 'mutated'),
    /mutated/,
  )

  // (e) Caller (step-env style): deleting the step's DEPLOY_KNOWN_HOSTS env line
  //     must go red EVEN THOUGH other steps in the same file still map it —
  //     proves the check is step-scoped, not a whole-file substring.
  const dockerBuild = readFileSync(path.join(workflowsDir, 'docker-build.yml'), 'utf8').split('\n')
  const invocationIdx = dockerBuild.findIndex((line) => isInvocationLine(line))
  assert.ok(invocationIdx > 0)
  const mutatedStepEnv = dockerBuild.filter((line, i) => !(
    line.includes(ENV_MAP_LINE)
    && Math.abs(i - invocationIdx) < 20
  ))
  assert.ok(mutatedStepEnv.length < dockerBuild.length, 'mutation must actually remove the env line')
  assert.throws(() => assertCallerWired(mutatedStepEnv, 'docker-build.yml[mutated]'), /must map/)

  // (f) Caller (job-env + inline-prefix style): deleting the inline prefix line
  //     must go red even with the job env intact.
  const attendance = readFileSync(path.join(workflowsDir, 'attendance-import-perf-baseline.yml'), 'utf8').split('\n')
  const noPrefix = attendance.filter((line) => !line.includes('DEPLOY_KNOWN_HOSTS="${DEPLOY_KNOWN_HOSTS}"'))
  assert.ok(noPrefix.length < attendance.length)
  assert.throws(() => assertCallerWired(noPrefix, 'attendance-import-perf-baseline.yml[mutated]'), /must carry DEPLOY_KNOWN_HOSTS=/)
  // …and deleting the job env line must go red too.
  const noJobEnv = attendance.filter((line) => !line.includes(ENV_MAP_LINE))
  assert.ok(noJobEnv.length < attendance.length)
  assert.throws(() => assertCallerWired(noJobEnv, 'attendance-import-perf-baseline.yml[mutated]'), /must map/)

  // (g) Census: a brand-new caller workflow must break set equality.
  const discovered = discoverCallers()
  discovered['resolve-k3wise-smoke-token.sh'].push('some-new-caller.yml')
  assert.notDeepEqual(discovered, EXPECTED_RESOLVER_CALLERS)
})
