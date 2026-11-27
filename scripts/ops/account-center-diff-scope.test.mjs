import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ALLOWED_FILES, parseArgs, parseNameStatus, violationsFor } from './account-center-diff-scope.mjs'

const CLI = fileURLToPath(new URL('./account-center-diff-scope.mjs', import.meta.url))
const SPEC = fileURLToPath(import.meta.url)
const API = 'apps/web/src/utils/api.ts'
const FEED = 'apps/web/src/components/AuthorizationAuditFeed.vue'
const AUDIT_SPEC = 'apps/web/tests/adminAuditView.spec.ts'
const OUTSIDE = 'outside.txt'
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const options = (base, head, slice = '06f-U') => ['--base', base, '--head', head, '--slice', slice]

function put(root, file, content) {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'account-center-scope-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Scope Test', GIT_AUTHOR_EMAIL: 'scope@example.test',
    GIT_COMMITTER_NAME: 'Scope Test', GIT_COMMITTER_EMAIL: 'scope@example.test',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  }
  // These commands operate only in an automatically removed synthetic repository.
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  git('init', '--quiet')
  for (const file of [...ALLOWED_FILES['06f-U'], API, OUTSIDE]) put(root, file, `original ${file}\n`)
  const localCli = join(root, 'scripts/ops/account-center-diff-scope.mjs')
  mkdirSync(dirname(localCli), { recursive: true })
  copyFileSync(CLI, localCli)
  const commit = () => {
    git('add', '--all')
    git('commit', '--quiet', '--no-gpg-sign', '-m', 'scope fixture')
    return git('rev-parse', 'HEAD')
  }
  const base = commit()
  const run = (head, slice = '06f-U', args = options(base, head, slice)) => {
    const result = spawnSync(process.execPath, [localCli, ...args], { cwd: root, env, encoding: 'utf8' })
    assert.ifError(result.error)
    assert.equal(result.signal, null)
    assert.equal(result.stderr, '')
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.exitCode, result.status)
    assert.match(receipt.checkerSha256, /^[0-9a-f]{64}$/)
    return { code: result.status, receipt }
  }
  return { root, git, base, commit, run }
}

test('slice sets are explicit, unique and contain only the assigned files', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(ALLOWED_FILES).map(([slice, files]) => [slice, files.length])), {
    '06a-C': 19, '06a-M': 13, '06a-U': 12, '06f-U': 6, '06f-D': 2, coordination: 3,
  })
  for (const [slice, files] of Object.entries(ALLOWED_FILES)) {
    assert.equal(new Set(files).size, files.length)
    assert.equal(violationsFor(files.map((path) => ({ status: 'M', paths: [path] })), slice).length, 0)
    assert.equal(files.includes(API), false)
  }
  assert.deepEqual(ALLOWED_FILES.coordination, [
    'packages/core-backend/tests/unit/account-center-web-wiring.guard.test.ts',
    'scripts/ops/account-center-diff-scope.mjs',
    'scripts/ops/account-center-diff-scope.test.mjs',
  ])
})

test('parses A M D T and both rename and copy paths without splitting path whitespace', () => {
  assert.deepEqual(parseNameStatus('A\0one space\0M\0two\ttabs\0D\0three\nlines\0T\0four\0R100\0old\0new\0C75\0source\0copy\0'), [
    { status: 'A', paths: ['one space'] }, { status: 'M', paths: ['two\ttabs'] },
    { status: 'D', paths: ['three\nlines'] }, { status: 'T', paths: ['four'] },
    { status: 'R100', paths: ['old', 'new'] }, { status: 'C75', paths: ['source', 'copy'] },
  ])
  assert.deepEqual(parseNameStatus(Buffer.from('M\0file\0')), [{ status: 'M', paths: ['file'] }])
  assert.deepEqual(parseNameStatus('R050\0old\0new\0C075\0source\0copy\0'), [
    { status: 'R050', paths: ['old', 'new'] }, { status: 'C075', paths: ['source', 'copy'] },
  ])
})

for (const input of ['M\0path', 'M\0', 'M\0\0', 'R100\0old\0', 'C50\0old\0', 'X\0file\0', 'U\0file\0', 'R101\0a\0b\0', 'R\0a\0b\0', 'M\0path\0\0']) {
  test(`rejects malformed NUL input ${JSON.stringify(input)}`, () => assert.throws(() => parseNameStatus(input)))
}

test('rejects undecodable path bytes instead of changing the path', () => {
  assert.throws(() => parseNameStatus(Buffer.from([77, 0, 255, 0])))
})

test('checks A M T and both copy endpoints', () => {
  for (const status of ['A', 'M', 'T']) {
    assert.equal(violationsFor([{ status, paths: [FEED] }], '06f-U').length, 0)
    assert.equal(violationsFor([{ status, paths: [API] }], '06f-U').length, 1)
  }
  for (const paths of [[FEED, API], [API, FEED]]) {
    assert.equal(violationsFor([{ status: 'C100', paths }], '06f-U').length, 1)
  }
  assert.equal(violationsFor([{ status: 'C100', paths: [FEED, AUDIT_SPEC] }], '06f-U').length, 0)
})

test('rejects an api-only commit in both UI slices and accepts the restored snapshot', (t) => {
  const repo = fixture(t)
  put(repo.root, API, 'changed API\n')
  const head = repo.commit()
  for (const slice of ['06a-U', '06f-U']) {
    const result = repo.run(head, slice)
    assert.equal(result.code, 1)
    assert.deepEqual(result.receipt.changes, [{ status: 'M', paths: [API] }])
    assert.deepEqual(result.receipt.violations, [{ path: API, reason: 'outside slice' }])
    assert.equal(result.receipt.base, repo.base)
    assert.equal(result.receipt.head, head)
    assert.equal(result.receipt.slice, slice)
  }
  put(repo.root, API, `original ${API}\n`)
  const restored = repo.run(repo.commit())
  assert.equal(restored.code, 0)
  assert.equal(restored.receipt.result, 'EMPTY (not a completion proof)')
})

for (const [label, file] of [['outside', OUTSIDE], ['inside', FEED]]) {
  test(`rejects deletion ${label} the slice`, (t) => {
    const repo = fixture(t)
    rmSync(join(repo.root, file))
    const result = repo.run(repo.commit())
    assert.equal(result.code, 1)
    assert.deepEqual(result.receipt.changes, [{ status: 'D', paths: [file] }])
    assert.ok(result.receipt.violations.some((entry) => entry.path === file && entry.reason === 'deletion is not allowed'))
  })
}

for (const [label, from, to, expected] of [
  ['inside to outside', FEED, 'elsewhere.vue', 1],
  ['outside to inside', OUTSIDE, 'apps/web/tests/authorizationAuditFeed.spec.ts', 1],
  ['inside to inside', FEED, AUDIT_SPEC, 0],
]) {
  test(`checks rename ${label}`, (t) => {
    const repo = fixture(t)
    // Remove an existing destination in the base so the next diff is a pure rename.
    if (ALLOWED_FILES['06f-U'].includes(to)) {
      rmSync(join(repo.root, to))
      repo.base = repo.commit()
    }
    renameSync(join(repo.root, from), join(repo.root, to))
    const head = repo.commit()
    const result = repo.run(head, '06f-U', options(repo.base, head))
    assert.equal(result.code, expected)
    assert.deepEqual(result.receipt.changes, [{ status: 'R100', paths: [from, to] }])
  })
}

const INVALID_ARGS = [
  ['missing base', ['--head', SHA, '--slice', '06f-U']],
  ['missing head', ['--base', SHA, '--slice', '06f-U']],
  ['missing slice', ['--base', SHA, '--head', OTHER_SHA]],
  ['unknown slice', options(SHA, OTHER_SHA, 'unknown')],
  ['empty slice', options(SHA, OTHER_SHA, '')],
  ['empty base', options('', OTHER_SHA)],
  ['zero base', options('0'.repeat(40), OTHER_SHA)],
  ['zero head', options(SHA, '0'.repeat(40))],
  ['short SHA', options('abc1234', OTHER_SHA)],
  ['uppercase SHA', options(SHA.toUpperCase(), OTHER_SHA)],
  ['duplicate base', [...options(SHA, OTHER_SHA), '--base', SHA]],
  ['duplicate head', [...options(SHA, OTHER_SHA), '--head', OTHER_SHA]],
  ['duplicate slice', [...options(SHA, OTHER_SHA), '--slice', '06f-U']],
  ['position argument', [...options(SHA, OTHER_SHA), 'extra']],
  ['unknown option', [...options(SHA, OTHER_SHA), '--other', 'value']],
  ['missing value', ['--base']],
]

test('validates all CLI arguments before reading objects', (t) => {
  const repo = fixture(t)
  for (const [label, args] of INVALID_ARGS) {
    assert.throws(() => parseArgs(args), label)
    assert.equal(repo.run(repo.base, '06f-U', args).code, 2, label)
  }
  assert.deepEqual(parseArgs(options(SHA, OTHER_SHA)), { base: SHA, head: OTHER_SHA, slice: '06f-U' })
})

test('rejects missing objects, non-commit objects and a non-ancestor base', (t) => {
  const repo = fixture(t)
  assert.equal(repo.run(OTHER_SHA).code, 2)
  assert.equal(repo.run(repo.base, '06f-U', options(OTHER_SHA, repo.base)).code, 2)
  const blob = repo.git('rev-parse', `${repo.base}:${API}`)
  assert.equal(repo.run(blob).code, 2)
  put(repo.root, FEED, 'changed feed\n')
  const head = repo.commit()
  assert.equal(repo.run(repo.base, '06f-U', options(head, repo.base)).code, 2)
})

test('accepts the six-file F diff, rejects it for M, and ignores uncommitted files', (t) => {
  const repo = fixture(t)
  for (const file of ALLOWED_FILES['06f-U']) put(repo.root, file, `changed ${file}\n`)
  const head = repo.commit()
  put(repo.root, API, 'uncommitted API\n')
  const result = repo.run(head)
  assert.equal(result.code, 0)
  assert.equal(result.receipt.changes.length, 6)
  assert.equal(repo.run(head, '06a-M').code, 1)
  assert.equal(repo.run(repo.base).receipt.result, 'EMPTY (not a completion proof)')
})

test('runs the checker when called through a symlinked path and rejects missing arguments', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'account-center-link-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const link = join(root, 'linked-account-center-diff-scope.mjs')
  symlinkSync(CLI, link)
  const result = spawnSync(process.execPath, [link], { encoding: 'utf8' })
  assert.ifError(result.error)
  assert.equal(result.status, 2)
})

// A nested test run must report on its own, not as a child of this runner.
function standaloneTestEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'))
}

for (const [label, find, replacement, name] of [
  ['path membership', "if (!allowed.has(path)) violations.push({ path, reason: 'outside slice' })", '',
    'rejects an api-only commit'],
  ['deletion', "if (record.status === 'D') violations.push({ path, reason: 'deletion is not allowed' })", '',
    'rejects deletion inside'],
  ['rename source', 'for (const path of record.paths)', 'for (const path of record.paths.slice(-1))',
    'checks rename outside to inside'],
]) {
  test(`contract assertions reject removal of ${label} enforcement`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'account-center-contract-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const source = readFileSync(CLI, 'utf8')
    assert.equal(source.split(find).length, 2)
    writeFileSync(join(root, 'account-center-diff-scope.mjs'), source.replace(find, replacement))
    copyFileSync(SPEC, join(root, 'account-center-diff-scope.test.mjs'))
    const result = spawnSync(process.execPath, [
      '--test', '--test-reporter=tap', `--test-name-pattern=^${name}`, join(root, 'account-center-diff-scope.test.mjs'),
    ], { encoding: 'utf8', env: standaloneTestEnv() })
    assert.ifError(result.error)
    assert.equal(result.status, 1)
    assert.match(result.stdout, /ERR_ASSERTION/)
    assert.match(result.stdout, /# fail 1\b/)
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/)
    t.diagnostic(`${label}: nested contract exit 1, one ERR_ASSERTION failure`)
  })
}
