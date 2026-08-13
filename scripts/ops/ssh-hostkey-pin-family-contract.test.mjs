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
