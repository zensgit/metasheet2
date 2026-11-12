// Executable harness for the production deploy window in .github/workflows/docker-build.yml.
//
// It loads the workflow with js-yaml, takes the `remote_deploy` step's own `run` text and runs it
// with bash 5 against PATH test doubles (scripts/ops/fixtures/docker-build-prod-window/): `ssh`
// runs the remote side locally with HOME at a temp "host" directory, `docker` is a
// scenario-driven double with an ordered call log, and curl, git, crontab, loginctl, busctl,
// date, sleep, df and tar are doubles too; python3 is real and edits temp copies of app.env and
// .env. No container, network, host or registry is touched.
//
// Expected exit codes, call orders and effects come from the deploy window design (phases 0-5,
// the ledger branch and the exit-code table), not from the workflow text: a disagreement fails
// here. flock, setsid and timeout are the real binaries where they exist (Linux CI); where they
// do not (macOS) perl/bash stand-ins are used and the lock/detach scenarios say so.
//
// Run: NODE_PATH=<dir with js-yaml> node --test scripts/ops/docker-build-prod-window.test.mjs
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const yaml = createRequire(import.meta.url)('js-yaml')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FIXTURES = path.join(repoRoot, 'scripts/ops/fixtures/docker-build-prod-window')
const workflow = yaml.load(readFileSync(path.join(repoRoot, '.github/workflows/docker-build.yml'), 'utf8'))
const deploySteps = workflow.jobs.deploy.steps
const REMOTE_RUN = deploySteps.find((step) => step.id === 'remote_deploy').run
const SYNC_RUN = deploySteps.find((step) => step.id === 'sync_deploy').run
const VALIDATE = workflow.jobs.build.steps.find((step) => step.id === 'validate_deploy_inputs')

const SHA_NEW = 'a'.repeat(40)
const SHA_OLD = 'b'.repeat(40)
const FAKE_SECRET = 'harness-fake-jwt-value-QXJx7mPLtw'
const EXCLUDED = 'zzzz20260919090000_create_approval_template_group_backfill_batches'
const BASE_MIGRATIONS = Array.from({ length: 9 }, (_, i) => `zzzz2026010${i + 1}120000_harness_base_${i + 1}`)
const INPLAY = Array.from({ length: 5 }, (_, i) => `zzzz2026110${i + 1}120000_harness_new_${i + 1}`)
const IMAGE_MIGRATIONS = [...BASE_MIGRATIONS, EXCLUDED, ...INPLAY]
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const INPLAY_SHA = sha256(INPLAY.join('\n'))
// Wednesday 2026-11-11 12:00 UTC: no blocking entry of the quiet schedule within 90 minutes.
const QUIET_EPOCH = Date.UTC(2026, 10, 11, 12, 0, 0) / 1000
// Wednesday 2026-11-11 01:40 UTC: the 02:05 entry falls inside [now, now + 90 min].
const BUSY_EPOCH = Date.UTC(2026, 10, 11, 1, 40, 0) / 1000

// ---------- tools ----------
function bashMajor(candidate) {
  if (!candidate || !existsSync(candidate)) return 0
  const result = spawnSync(candidate, ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf8' })
  return result.status === 0 ? Number(result.stdout.trim()) : 0
}
function findBash5() {
  const candidates = [process.env.HARNESS_BASH, '/opt/homebrew/bin/bash', '/usr/local/bin/bash', '/bin/bash', '/usr/bin/bash']
  return candidates.find((candidate) => bashMajor(candidate) >= 4) ?? null
}
const BASH = findBash5()
const SKIP = BASH ? false : 'no bash with BASH_VERSINFO[0] >= 4 found (set HARNESS_BASH)'
const which = (name) => spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
const REAL = { flock: which('flock'), setsid: which('setsid'), timeout: which('timeout'), tar: which('tar') }
const TAR_IS_GNU = /GNU tar/.test(spawnSync(REAL.tar || 'tar', ['--version'], { encoding: 'utf8' }).stdout ?? '')
const STANDINS = ['flock', 'setsid', 'timeout'].filter((name) => !REAL[name])
const REDUCED = STANDINS.length > 0
  ? ` [reduced fidelity: ${STANDINS.join('/')} stand-ins, not the real binaries]`
  : ''
const STUBS = ['docker', 'ssh', 'curl', 'git', 'crontab', 'loginctl', 'busctl', 'date', 'sleep', 'df', 'tar']

// ---------- processes ----------
function run(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 240_000)
    child.on('close', (status, signal) => {
      clearTimeout(timer)
      resolve({ status, signal, stdout, stderr })
    })
  })
}
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Every process a scenario starts carries H_TAG=<unique>; a tagged process alive after the
// scenario has ended is a leaked window, helper or follower.
function taggedPids(tag) {
  const needle = `H_TAG=${tag}`
  const pids = []
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        if (readFileSync(`/proc/${entry}/environ`, 'latin1').split('\0').includes(needle)) pids.push(Number(entry))
      } catch {}
    }
  } else {
    const listing = spawnSync('ps', ['-E', '-ww', '-A', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout ?? ''
    for (const line of listing.split('\n')) {
      if (line.includes(` ${needle} `) || line.endsWith(` ${needle}`)) pids.push(Number(line.trim().split(/\s+/)[0]))
    }
  }
  return pids.filter((pid) => pid !== process.pid)
}
function killTagged(tag) {
  for (const pid of taggedPids(tag)) {
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}
async function assertNoLeftovers(tag) {
  let left = []
  for (let i = 0; i < 50; i += 1) {
    left = taggedPids(tag)
    if (left.length === 0) return
    await sleepMs(100)
  }
  const detail = process.platform === 'linux'
    ? left.map((pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0/g, ' ') } catch { return String(pid) } })
    : left
  killTagged(tag)
  assert.fail(`processes of this scenario were still running after it ended: ${JSON.stringify(detail)}`)
}

// A lock holder independent of the window (flock(2) through perl, same lock family as util-linux).
async function holdLock(lockPath) {
  mkdirSync(path.dirname(lockPath), { recursive: true })
  const child = spawn('perl', ['-e', 'use Fcntl ":flock"; open(F, ">>", $ARGV[0]) or die; flock(F, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 600', lockPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('exit', () => reject(new Error('lock holder exited')))
  })
  return child
}

// ---------- the fake world ----------
const ctrFields = (fields) => fields
function makeWorld(t, options = {}) {
  const tmpBase = realpathSync(os.tmpdir())
  const root = realpathSync(mkdtempSync(path.join(tmpBase, 'd5-window-')))
  const tag = `${path.basename(root)}-${process.pid}`
  const world = { root, tag, holders: [] }
  t.after(() => {
    for (const holder of world.holders) { try { holder.kill('SIGKILL') } catch {} }
    killTagged(tag)
    if (!process.env.HARNESS_KEEP) rmSync(root, { recursive: true, force: true })
  })
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const exclude = new Set(options.absentTools ?? [])
  for (const name of [...STUBS, ...STANDINS]) {
    if (exclude.has(name)) continue
    symlinkSync(path.join(FIXTURES, name), path.join(bin, name))
  }
  symlinkSync(BASH, path.join(bin, 'bash'))
  let basePath = process.env.PATH
  if (exclude.size > 0) {
    // A tool is made absent with a symlink farm of every other executable on PATH.
    const farm = path.join(root, 'farm')
    mkdirSync(farm)
    const seen = new Set()
    for (const dir of process.env.PATH.split(path.delimiter)) {
      let entries = []
      try { entries = readdirSync(dir) } catch { continue }
      for (const entry of entries) {
        if (seen.has(entry) || exclude.has(entry) || entry === 'bash') continue
        seen.add(entry)
        try { symlinkSync(path.join(dir, entry), path.join(farm, entry)) } catch {}
      }
    }
    basePath = farm
  }
  world.PATH = [bin, basePath].join(path.delimiter)

  const runnerHome = path.join(root, 'runner-home')
  const work = path.join(root, 'work')
  const hostHome = path.join(root, 'host')
  const repo = path.join(hostHome, 'metasheet2')
  const windowHome = path.join(hostHome, 'metasheet2-deploy-window')
  const ds = path.join(root, 'ds')
  const orig = path.join(root, 'orig')
  for (const dir of [runnerHome, work, path.join(repo, 'docker'), path.join(repo, 'scripts/ops'), windowHome,
    path.join(ds, 'ctr'), path.join(ds, 'img'), path.join(ds, 'oneoff'), path.join(ds, 'dockerroot'), orig, path.join(root, 'tmp')]) {
    mkdirSync(dir, { recursive: true })
  }
  const appEnv = options.appEnv ?? [
    'DATABASE_URL=postgres://metasheet:harness-db-pass@postgres:5432/metasheet',
    'JWT_SECRET=',
    'BCRYPT_SALT_ROUNDS=12',
    '',
  ].join('\n')
  const dotEnv = `IMAGE_OWNER=zensgit\nIMAGE_TAG=${SHA_OLD}\n`
  writeFileSync(path.join(repo, 'docker/app.env'), appEnv)
  writeFileSync(path.join(repo, '.env'), dotEnv)
  writeFileSync(path.join(orig, 'app.env'), appEnv)
  writeFileSync(path.join(orig, 'dotenv'), dotEnv)
  writeFileSync(path.join(repo, 'docker-compose.app.yml'), 'services: {}\n')
  writeFileSync(path.join(repo, 'docker/nginx.conf'), '# harness\n')
  symlinkSync(path.join(FIXTURES, 'attendance-preflight.sh'), path.join(repo, 'scripts/ops/attendance-preflight.sh'))
  for (const file of ['docker-compose.app.yml', 'docker/nginx.conf', 'scripts/ops/attendance-preflight.sh']) {
    mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
    copyFileSync(path.join(repo, file), path.join(work, file))
    chmodSync(path.join(work, file), 0o644)
  }
  if (options.hostCheck !== false) {
    mkdirSync(path.join(windowHome, 'host-checks'), { recursive: true })
    symlinkSync(path.join(FIXTURES, 'host-check'), path.join(windowHome, 'host-checks/10-owner-check'))
  }

  // docker double state
  const project = 'metasheet2'
  const labels = (service) => ({
    'com.docker.compose.project': project,
    'com.docker.compose.service': service,
    'com.docker.compose.oneoff': 'False',
    'com.docker.compose.project.working_dir': repo,
    'com.docker.compose.project.config_files': path.join(repo, 'docker-compose.app.yml'),
    ...(options.labels?.[service] ?? {}),
  })
  const image = (ref, id, rev, digest) => {
    for (const key of [ref, id]) {
      const dir = path.join(ds, 'img', key.replace(/[/:@]/g, '_'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'rev'), rev)
      writeFileSync(path.join(dir, 'id'), id)
      writeFileSync(path.join(dir, 'digests'), `${digest}\n`)
    }
  }
  const oldBackendRef = `ghcr.io/zensgit/metasheet2-backend:${SHA_OLD}`
  const oldWebRef = `ghcr.io/zensgit/metasheet2-web:${SHA_OLD}`
  image(oldBackendRef, 'sha256:oldbackendimage', SHA_OLD, `ghcr.io/zensgit/metasheet2-backend@sha256:${'1'.repeat(64)}`)
  image(oldWebRef, 'sha256:oldwebimage', SHA_OLD, `ghcr.io/zensgit/metasheet2-web@sha256:${'3'.repeat(64)}`)
  image('postgres:15-alpine', 'sha256:pgimage', '', 'postgres@sha256:' + '4'.repeat(64))
  image('redis:7-alpine', 'sha256:redisimage', '', 'redis@sha256:' + '5'.repeat(64))
  const containers = {
    'metasheet-postgres': ctrFields({ running: 'true', health: 'healthy', id: 'ctr-postgres-1', image_id: 'sha256:pgimage', config_image: 'postgres:15-alpine', volume: `${project}_metasheet-postgres-data`, labels: labels('postgres') }),
    'metasheet-redis': ctrFields({ running: 'true', health: 'healthy', id: 'ctr-redis-1', image_id: 'sha256:redisimage', config_image: 'redis:7-alpine', volume: '', labels: labels('redis') }),
    'metasheet-backend': ctrFields({ running: 'true', health: 'healthy', id: 'ctr-backend-1', image_id: 'sha256:oldbackendimage', config_image: oldBackendRef, volume: '', labels: labels('backend') }),
    'metasheet-web': ctrFields({ running: 'true', health: 'none', id: 'ctr-web-1', image_id: 'sha256:oldwebimage', config_image: oldWebRef, volume: '', labels: labels('web') }),
  }
  for (const [name, override] of Object.entries(options.containers ?? {})) Object.assign(containers[name], override)
  for (const [name, fields] of Object.entries(containers)) {
    const dir = path.join(ds, 'ctr', name)
    mkdirSync(path.join(dir, 'fs/app'), { recursive: true })
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'labels') {
        for (const [label, labelValue] of Object.entries(value)) writeFileSync(path.join(dir, `label.${label}`), labelValue)
      } else {
        writeFileSync(path.join(dir, key), value)
      }
    }
  }
  if (options.appdata) {
    const att = path.join(ds, 'ctr/metasheet-backend/fs/app/data/attachments')
    mkdirSync(path.join(att, 'sheet-1'), { recursive: true })
    writeFileSync(path.join(att, 'a.txt'), 'hello')
    writeFileSync(path.join(att, 'sheet-1/b.bin'), 'hello world')
  }
  if (options.extraNames) writeFileSync(path.join(ds, 'extra_names'), options.extraNames.join('\n') + '\n')
  writeFileSync(path.join(ds, 'ledger'), BASE_MIGRATIONS.join('\n') + '\n')
  if (options.crontab) writeFileSync(path.join(root, 'crontab'), options.crontab)
  if (options.state !== undefined) writeFileSync(path.join(windowHome, 'state'), options.state)
  if (options.abort) writeFileSync(path.join(windowHome, 'abort'), '')
  if (options.priorDump) {
    mkdirSync(path.join(windowHome, 'runs/100-1'), { recursive: true })
    writeFileSync(path.join(windowHome, 'runs/100-1/db.dump'), 'PGDMP an earlier verified dump\n')
  }
  writeFileSync(path.join(root, 'calls.tsv'), '')
  Object.assign(world, { bin, runnerHome, work, hostHome, repo, windowHome, ds, orig, project })
  return world
}

let runCounter = 7000
function windowEnv(world, options) {
  const runId = String(runCounter += 1)
  const runDir = path.join(world.windowHome, 'runs', `${runId}-1`)
  const env = {
    PATH: world.PATH,
    HOME: world.runnerHome,
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: path.join(world.root, 'tmp'),
    GITHUB_OUTPUT: path.join(world.root, 'github_output'),
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: SHA_NEW,
    DEPLOY_HOST: 'deploy-host',
    DEPLOY_USER: 'deploy',
    DEPLOY_SSH_KEY_B64: Buffer.from('harness private key\n').toString('base64'),
    DEPLOY_KNOWN_HOSTS: Buffer.from('deploy-host ssh-ed25519 AAAAC3NzaharnessKey\n').toString('base64'),
    DEPLOY_PATH: '',
    DEPLOY_COMPOSE_FILE: '',
    DEPLOY_IMAGE_OWNER: 'zensgit',
    DEPLOY_IMAGE_TAG: SHA_NEW,
    DEPLOY_EXPECTED_COMMIT: SHA_NEW,
    DEPLOY_BACKEND_HEALTH_URL: 'http://127.0.0.1:8900/health',
    DEPLOY_WEB_BUILD_INFO_URL: 'http://127.0.0.1:8081/build-info.json',
    DEPLOY_JWT_SECRET: FAKE_SECRET,
    DEPLOY_BCRYPT_SALT_ROUNDS: '12',
    ENABLE_YJS_COLLAB: 'false',
    DRILL_FAIL_STAGE: 'none',
    EXPECTED_PENDING_SHA256: INPLAY_SHA,
    RESTORE_PROOF: 'ref:harness-restore-1',
    PRE_COMMIT_ABORT: 'restart-old',
    DEPLOY_WINDOW_PULL_BUDGET_KB: '3145728',
    DEPLOY_WINDOW_RESERVE_KB: '2097152',
    DEPLOY_BACKUP_TIMEOUT_S: '1200',
    DEPLOY_BACKUP_VERIFY_TIMEOUT_S: '900',
    DEPLOY_WINDOW_EXPECTED_MIN: '90',
    DEPLOY_WINDOW_DRAIN_S: '60',
    DEPLOY_WINDOW_QUEUED_MAX_AGE_S: '86400',
    DEPLOY_WINDOW_MIN_HOST_CHECKS: '1',
    DEPLOY_WINDOW_CANCEL_OWN_SESSIONS: 'false',
    H_TAG: world.tag,
    H_ROOT: world.root,
    H_DS: world.ds,
    H_CALLS: path.join(world.root, 'calls.tsv'),
    H_REPO: world.repo,
    H_ORIG: world.orig,
    H_HOST_HOME: world.hostHome,
    H_RUN_DIR: runDir,
    H_CLOCK_START: String(Date.now() / 1000),
    H_CLOCK_SPEED: '20',
    H_EPOCH: String(QUIET_EPOCH),
    H_REAL_TAR: REAL.tar,
    H_TAR_IS_GNU: TAR_IS_GNU ? '1' : '0',
    H_IMAGE_MIGRATIONS: IMAGE_MIGRATIONS.join(','),
    H_CRONTAB_FILE: path.join(world.root, 'crontab'),
    ...options.env,
  }
  return { env, runId, runDir }
}

function parseCalls(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    const [kind, tag, owner, metaText, ...rest] = line.split('\t')
    const meta = {}
    for (const pair of (metaText ?? '').split(' ')) {
      const at = pair.indexOf('=')
      if (at > 0) meta[pair.slice(0, at)] = pair.slice(at + 1)
    }
    return { index, kind, tag, owner, metaText, meta, args: rest.join('\t') }
  })
}
const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null)
function parseOutput(file) {
  const out = {}
  for (const line of (readIf(file) ?? '').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

// Runs the remote_deploy step text (or a mutated copy) as GitHub would: bash -e -o pipefail.
async function runWindow(t, world, options = {}) {
  const { env, runId, runDir } = windowEnv(world, options)
  if (options.preRunDir) mkdirSync(runDir, { recursive: true })
  const script = path.join(world.root, 'remote_deploy.sh')
  writeFileSync(script, options.runText ?? REMOTE_RUN)
  // Every stubbed tool must resolve to the double, never to a real binary on this machine.
  const resolved = spawnSync(BASH, ['-c', `for t in ${STUBS.join(' ')}; do command -v "$t" || echo "missing:$t"; done`], { env, encoding: 'utf8' }).stdout.trim().split('\n')
  for (const [i, name] of STUBS.entries()) assert.equal(resolved[i], path.join(world.bin, name), `${name} must resolve to the test double`)
  const result = await run(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], { cwd: world.work, env })
  if (options.waitForRc) {
    for (let i = 0; i < 1200 && !existsSync(path.join(runDir, 'rc')); i += 1) await sleepMs(100)
  }
  // The bootstrap returns only after the window exits (or the session dropped); give a detached
  // window a moment to finish its exit trap, then require that nothing of this scenario survives.
  await assertNoLeftovers(world.tag)
  const r = {
    world, runId, runDir, result,
    out: parseOutput(env.GITHUB_OUTPUT),
    deployLog: readIf(path.join(world.work, 'output/deploy/deploy.log')) ?? '',
    windowLog: readIf(path.join(runDir, 'window.log')) ?? '',
    rcFile: (readIf(path.join(runDir, 'rc')) ?? '').trim(),
    stateText: readIf(path.join(world.windowHome, 'state')),
    calls: parseCalls(path.join(world.root, 'calls.tsv')),
    appEnv: readFileSync(path.join(world.repo, 'docker/app.env'), 'utf8'),
    dotEnv: readFileSync(path.join(world.repo, '.env'), 'utf8'),
    hostChecks: (readIf(path.join(world.root, 'hostchecks.log')) ?? '').split('\n').filter(Boolean),
  }
  r.state = {}
  for (const line of (r.stateText ?? '').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) r.state[line.slice(0, at)] = line.slice(at + 1)
  }
  r.docker = r.calls.filter((call) => call.kind === 'docker')
  if (process.env.HARNESS_DEBUG) {
    t.diagnostic(`deploy_rc=${r.out.deploy_rc} rc=${r.rcFile}\n${r.windowLog.split('\n').slice(-40).join('\n')}\n${r.result.stderr.slice(-2000)}`)
  }
  return r
}

// ---------- call-log helpers ----------
const composeSub = (call) => call.args.match(/^compose(?: -p \S+| --project-directory \S+| -f \S+)* (\S+)/)?.[1] ?? null
const first = (r, predicate, from = -1) => r.docker.findIndex((call) => call.index > from && predicate(call))
const firstIndex = (r, predicate, from = -1) => { const at = first(r, predicate, from); return at < 0 ? -1 : r.docker[at].index }
const any = (r, predicate) => r.docker.some(predicate)
const isStop = (name) => (call) => new RegExp(`^stop -t \\d+ ${name}$`).test(call.args)
const isStart = (name) => (call) => call.args === `start ${name}`
const isPull = (call) => composeSub(call) === 'pull'
const isUp = (call) => composeSub(call) === 'up'
const isRun = (call) => composeSub(call) === 'run'
const isLatest = (call) => isRun(call) && /migrate\.js --latest$/.test(call.args)
const isList = (call) => isRun(call) && /migrate\.js --list/.test(call.args)
const isUpNoStartBackend = (call) => isUp(call) && / up --no-start --no-deps --force-recreate backend$/.test(call.args)
const isUpWeb = (call) => isUp(call) && / up -d --no-deps --force-recreate web$/.test(call.args)
const isDump = (call) => /^exec metasheet-postgres sh -c exec pg_dump -Fc /.test(call.args)
const isRestoreRead = (call) => /^exec -i metasheet-postgres pg_restore -f \/dev\/null$/.test(call.args)
const isTarOut = (call) => /^exec metasheet-backend tar -C \/ --one-file-system -cf - /.test(call.args)
const isCpIn = (call) => call.args === 'cp - metasheet-backend:/'
const isLedgerRead = (call) => /^exec metasheet-postgres sh -c .*psql.* SELECT count\(\*\) FROM kysely_migration$/.test(call.args)
const sqlOf = (call) => (/^exec metasheet-postgres sh -c .*exec psql/.test(call.args) ? call.args : '')

function assertOrdered(labelled) {
  for (const [label, index] of labelled) assert.ok(index >= 0, `${label} must happen`)
  for (let i = 1; i < labelled.length; i += 1) {
    assert.ok(labelled[i - 1][1] < labelled[i][1], `${labelled[i - 1][0]} must come before ${labelled[i][0]}`)
  }
}

// Checks that hold for every window scenario.
function assertCommon(r, rc, { runnerRc = rc } = {}) {
  assert.deepEqual(r.calls.filter((call) => call.kind === 'UNMODELED').map((call) => call.args), [], 'every call is modelled')
  assert.equal(r.result.status, 0, `the remote_deploy step itself exits 0 (stderr: ${r.result.stderr.slice(-500)})`)
  assert.equal(r.out.deploy_rc, String(runnerRc), 'deploy_rc output')
  assert.equal(r.rcFile, String(rc), 'host rc file')
  assert.notEqual(r.rcFile, '255')
  assert.ok(!existsSync(path.join(r.runDir, 'window.sh')), 'window.sh is removed when the window exits')
  assert.match(r.windowLog, /^\[deploy-window\] raw_rc=\d+$/m, 'raw_rc is logged')
  for (const [label, text] of [['window.log', r.windowLog], ['state', r.stateText ?? ''], ['rc', r.rcFile],
    ['deploy.log', r.deployLog], ['step stdout', r.result.stdout], ['step stderr', r.result.stderr],
    ['ssh argv', r.calls.filter((call) => call.kind === 'ssh').map((call) => call.args).join('\n')]]) {
    assert.ok(!text.includes(FAKE_SECRET), `the fake DEPLOY_JWT_SECRET value must not appear in ${label}`)
  }
  assert.ok(!(readIf(path.join(r.world.root, 'github_output')) ?? '').includes(FAKE_SECRET))
  // postgres and redis are never stopped, started, removed or (re)created; nothing is pruned.
  for (const call of r.docker) {
    assert.doesNotMatch(call.args, /^(stop|start|kill|restart|rm)\b.*metasheet-(postgres|redis)\b/, call.args)
    assert.doesNotMatch(call.args, /^(rm|system|volume|container rm|network rm)\b/, call.args)
    if (composeSub(call)) {
      assert.ok(['version', 'pull', 'run', 'up'].includes(composeSub(call)), `compose ${composeSub(call)} is not a window action`)
      assert.doesNotMatch(call.args, /\b(postgres|redis)$/, call.args)
    }
    // Every compose call that resolves an image names the dispatched tag explicitly.
    if (['pull', 'run', 'up'].includes(composeSub(call))) {
      assert.equal(call.tag, SHA_NEW, `IMAGE_TAG on ${call.args}`)
      assert.equal(call.owner, 'zensgit', `IMAGE_OWNER on ${call.args}`)
    }
  }
}
const envUnchanged = (r) => {
  assert.equal(r.appEnv, readFileSync(path.join(r.world.orig, 'app.env'), 'utf8'), 'docker/app.env byte-identical to the input')
  assert.equal(r.dotEnv, readFileSync(path.join(r.world.orig, 'dotenv'), 'utf8'), '.env byte-identical to the input')
}
const dotEnvTag = (r) => r.dotEnv.match(/^IMAGE_TAG=(.*)$/m)?.[1]

function checkHappy(r, { appdata }) {
  assertCommon(r, 0)
  assert.equal(r.state.phase, 'done-new')
  const latest = r.docker[first(r, isLatest)]
  assert.ok(latest, 'the --latest run happens')
  assert.equal(latest.meta.dotenv_tag, SHA_OLD, '.env still names the old image while the migration runs')
  const envWrite = firstIndex(r, (call) => call.meta.dotenv_tag === SHA_NEW)
  const upBackend = firstIndex(r, isUpNoStartBackend)
  const order = [
    ['pull', firstIndex(r, isPull)],
    ['stop web', firstIndex(r, isStop('metasheet-web'))],
    ...(appdata ? [['app-data copy-out', firstIndex(r, isTarOut)]] : []),
    ['stop backend', firstIndex(r, isStop('metasheet-backend'))],
    ['pg_dump', firstIndex(r, isDump)],
    ['pg_restore read', firstIndex(r, isRestoreRead)],
    ['migrate --latest', latest.index],
    ['.env write', envWrite],
    ['up --no-start backend', upBackend],
    ...(appdata ? [['app-data copy-in', firstIndex(r, isCpIn, upBackend)]] : []),
    ['start new backend', firstIndex(r, isStart('metasheet-backend'), upBackend)],
    ['up web', firstIndex(r, isUpWeb)],
  ]
  assertOrdered(order)
  if (!appdata) {
    assert.ok(!any(r, isTarOut), 'no app-data copy when there is none')
    assert.ok(!any(r, isCpIn))
  }
  // The new backend is started once, the old containers never.
  assert.deepEqual(r.docker.filter((call) => /^start /.test(call.args)).map((call) => call.args), ['start metasheet-backend'])
  assert.match(r.docker.find(isStart('metasheet-backend')).meta.target, /^new-backend-/)
  // The migrate invocation: exclusion constant once, on the --latest run only, plus pinned timeouts.
  assert.equal(r.docker.filter((call) => call.args.includes('MIGRATION_EXCLUDE=')).length, 1)
  assert.match(latest.args, / run --rm --no-deps -T /)
  for (const flag of [`-e MIGRATION_EXCLUDE=${EXCLUDED}`, '-e MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=false', '-e ALLOW_DB_RESET=false',
    '-e DB_QUERY_TIMEOUT=30000', '-e DB_STATEMENT_TIMEOUT=30000', `-e APP_NAME=metasheet-window-migrate-${r.runId}-1`]) {
    assert.ok(latest.args.includes(flag), `--latest carries ${flag}`)
  }
  assert.equal(dotEnvTag(r), SHA_NEW)
  assert.doesNotMatch(r.appEnv, /MIGRATION_EXCLUDE|MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL|ALLOW_DB_RESET/)
  assert.match(r.appEnv, new RegExp(`^JWT_SECRET=${FAKE_SECRET}$`, 'm'), 'the secret reached the window through its environment')
  const ledger = readFileSync(path.join(r.world.ds, 'ledger'), 'utf8').split('\n').filter(Boolean)
  assert.deepEqual(ledger, [...BASE_MIGRATIONS, ...INPLAY])
  assert.deepEqual(r.hostChecks, ['pre-stop', 'post-backend'])
  // Markers in the streamed log, in window order.
  assertOrdered(['=== WINDOW PREFLIGHT START ===', '=== WINDOW PREFLIGHT END ===', '=== STOP WRITES START ===', '=== STOP WRITES END ===',
    '=== BACKUP START ===', '=== BACKUP END ===', '=== MIGRATE START ===', '=== MIGRATE END ===', '=== DEPLOY START ===',
    '=== DEPLOY END ===', '=== VERSION VERIFY END ==='].map((marker) => [marker, r.deployLog.indexOf(marker)]))
  assert.match(r.deployLog, /\[deploy-window\] backup ok sha256=[0-9a-f]{64} bytes=\d+ toc_entries=\d+ file=db\.dump/)
  // Backup set beside the dump, host only: run dir 700, files 600; env snapshot taken before the rewrite.
  assert.equal(statSync(r.runDir).mode & 0o777, 0o700)
  for (const file of ['db.dump', 'meta.txt', 'globals.sql', 'shim-candidates.txt', 'RESTORE-README.txt', 'migrate.out']) {
    assert.ok(existsSync(path.join(r.runDir, file)), `${file} kept on the host`)
    assert.equal(statSync(path.join(r.runDir, file)).mode & 0o077, 0, `${file} is private to the deploy user`)
  }
  assert.equal(readFileSync(path.join(r.runDir, 'env-snapshot.app.env'), 'utf8'), readFileSync(path.join(r.world.orig, 'app.env'), 'utf8'))
  // Public-log rule: raw host-check, docker logs, dump and env values stay off the streamed log.
  for (const raw of ['harness host check private output', 'server listening', 'outbound webhook ops switch: off', 'PGDMP', 'harness globals', 'harness-db-pass']) {
    assert.ok(!r.deployLog.includes(raw), `deploy.log must not carry: ${raw}`)
  }
  assert.match(r.deployLog, /ops_switch=off/)
  // Main-session decision: no git auto-gc/maintenance during the prologue sync, and only there.
  const gitCalls = r.calls.filter((call) => call.kind === 'git')
  for (const sub of ['fetch origin main', 'merge --ff-only origin/main']) {
    const call = gitCalls.find((entry) => entry.args === sub)
    assert.ok(call, `git ${sub} runs`)
    assert.match(call.metaText, /^count=2 gc\.auto=0 maintenance\.auto=false$/, `git ${sub} runs without auto gc/maintenance`)
  }
  assert.match(gitCalls.find((entry) => /^diff --quiet [0-9a-f]{40} -- /.test(entry.args)).metaText, /^count=<unset>$/)
}

function checkRefused(r, rc = 70) {
  assertCommon(r, rc)
  assert.ok(!any(r, (call) => /^stop /.test(call.args)), 'nothing is stopped')
  assert.ok(!any(r, (call) => /^start /.test(call.args)), 'nothing is started')
  assert.ok(!any(r, isUp), 'nothing is created')
  envUnchanged(r)
  assert.equal(r.state.phase, 'refused-unchanged')
}

// 4F restarts whatever the window stopped (by default both), only the old containers, env first.
function checkRestoredOld(r, stopped = ['metasheet-backend', 'metasheet-web']) {
  assertCommon(r, 71)
  assert.equal(r.state.phase, 'done-restored-old')
  const starts = r.docker.filter((call) => /^start /.test(call.args))
  assert.deepEqual(starts.map((call) => call.args).sort(), stopped.map((name) => `start ${name}`).sort())
  for (const start of starts) {
    assert.match(start.meta.target, /^ctr-(backend|web)-1@sha256:old/, 'the old, stopped containers are started, not new ones')
    assert.equal(start.meta.appenv_orig, '1', 'docker/app.env restored before the old start')
    assert.equal(start.meta.dotenv_orig, '1', '.env restored before the old start')
  }
  assert.ok(!any(r, isUp), 'never up / recreate on the way back')
  envUnchanged(r)
}

// ---------- scenarios ----------
const CONCURRENCY = Number(process.env.HARNESS_CONCURRENCY) || Math.max(2, Math.min(6, os.availableParallelism?.() ?? os.cpus().length))

describe('production deploy window: remote_deploy step run against test doubles', { concurrency: CONCURRENCY, skip: SKIP }, () => {
  const scenario = (name, fn) => it(name, { timeout: 300_000 }, fn)

  scenario('1 happy path with app data: full order, IMAGE_TAG on every compose call, .env written at the commit', async (t) => {
    const world = makeWorld(t, { appdata: true })
    checkHappy(await runWindow(t, world), { appdata: true })
  })

  scenario('1 happy path without app data: no copy-out, no copy-in', async (t) => {
    const world = makeWorld(t)
    checkHappy(await runWindow(t, world), { appdata: false })
  })

  const REFUSALS = [
    ['pull fails', {}, { H_PULL_RC: '1' }],
    ['pulled revision label differs', {}, { H_NEW_REV_BACKEND: 'f'.repeat(40) }],
    ['pre-pull disk gate', {}, { H_DF_FREE_KB: String(1024 * 1024) }],
    ['post-pull disk gate (database larger than the free space)', {}, { H_DB_BYTES: String(200 * 1024 ** 3) }],
    ['in-play sha mismatch', {}, { EXPECTED_PENDING_SHA256: 'f'.repeat(64) }],
    ['in-play sha with a trailing newline is refused (names joined by newline without a trailing one: recorded deviation 13)', {}, { EXPECTED_PENDING_SHA256: sha256(INPLAY.join('\n') + '\n') }],
    ['excluded name missing from the image', {}, { H_IMAGE_MIGRATIONS: [...BASE_MIGRATIONS, ...INPLAY].join(',') }],
    ['app.env key in export form', { appEnv: 'DATABASE_URL=postgres://u:p@postgres:5432/db\nexport MIGRATION_EXCLUDE=x\n' }, {}],
    ['app.env key with spaces', { appEnv: 'DATABASE_URL=postgres://u:p@postgres:5432/db\n  ALLOW_DB_RESET = true\n' }, {}],
    ['env guard in the one-off fails', {}, { H_ONEOFF_ENV: 'MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true' }],
    ['--list rc 1', {}, { H_LIST_RC: '1' }],
    ['compose label mismatch', { labels: { web: { 'com.docker.compose.service': 'frontend' } } }, {}],
    ['hashed legacy container', { extraNames: ['0a1b2d_metasheet-backend'] }, {}],
    ['redis unhealthy', { containers: { 'metasheet-redis': { health: 'unhealthy' } } }, {}],
    ['backend not running', { containers: { 'metasheet-backend': { running: 'false' } } }, {}],
    ['host check fails', {}, { H_HOSTCHECK_FAIL: 'pre-stop' }],
    ['no host check installed', { hostCheck: false }, {}],
    ['quiet schedule', {}, { H_EPOCH: String(BUSY_EPOCH) }],
    ['docker GC cron', { crontab: '# keep\n15 4 * * * docker system prune -af\n' }, {}],
    ['abort file at start', { abort: true }, {}],
    ['KillUserProcesses=yes and linger off', {}, { H_KILL_USER_PROCESSES: 'true', H_LINGER: 'no' }],
    ['directory sync with a fresh heartbeat', {}, { H_SYNC_LIVE: '1' }],
    ['young queued import job', {}, { H_IMPORT_BUSY: '1' }],
    ['host file drift from the dispatched commit', {}, { H_GIT_DRIFT: '1' }],
    ['host re-validation: restore_proof unselected on a deploy', {}, { RESTORE_PROOF: 'unselected' }],
    ['host re-validation: pre_commit_abort unselected on a deploy', {}, { PRE_COMMIT_ABORT: 'unselected' }],
    ['host re-validation: drill_fail_stage=smoke', {}, { DRILL_FAIL_STAGE: 'smoke' }],
    ['host re-validation: expected_pending_sha256 not hex', {}, { EXPECTED_PENDING_SHA256: 'not-a-hash' }],
  ]
  for (const [label, worldOptions, env] of REFUSALS) {
    scenario(`2 refusal before any stop: ${label} -> 70, env files byte-identical`, async (t) => {
      const world = makeWorld(t, worldOptions)
      const r = await runWindow(t, world, { env })
      checkRefused(r)
      if (env.H_HOSTCHECK_FAIL) assert.deepEqual(r.hostChecks, ['pre-stop'])
      if (env.H_PULL_RC || env.H_NEW_REV_BACKEND || env.H_DB_BYTES) assert.ok(any(r, isPull), 'reached the pull')
      if (env.H_DF_FREE_KB) assert.ok(!any(r, isPull), 'refused before the pull')
    })
  }

  scenario('2 control: KillUserProcesses=yes with linger on proceeds to done-new', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_KILL_USER_PROCESSES: 'true', H_LINGER: 'yes' } })
    assertCommon(r, 0)
  })

  scenario('3 sessions never drain -> 71: old containers started after the env restore; no pg_dump', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_SESSIONS: 'never' } })
    checkRestoredOld(r)
    assert.ok(!any(r, isDump), 'no pg_dump')
  })

  for (const [label, env] of [['pg_dump writes an empty file', { H_DUMP_MODE: 'empty' }], ['the whole-archive pg_restore read fails', { H_RESTORE_RC: '1' }]]) {
    scenario(`4 ${label} -> 71: partial dump deleted, an earlier verified dump kept`, async (t) => {
      const world = makeWorld(t, { priorDump: true })
      const r = await runWindow(t, world, { env })
      checkRestoredOld(r)
      assert.ok(!existsSync(path.join(r.runDir, 'db.dump.partial')), 'db.dump.partial deleted')
      assert.ok(!existsSync(path.join(r.runDir, 'db.dump')), 'no unverified dump promoted')
      assert.equal(readFileSync(path.join(world.windowHome, 'runs/100-1/db.dump'), 'utf8'), 'PGDMP an earlier verified dump\n')
    })
  }

  scenario('5 migrate rc 1 with the ledger at L0 -> 71: env restored before the old start, no up', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'fail-rollback' } })
    checkRestoredOld(r)
    assert.ok(first(r, isLatest) >= 0)
    assert.ok(firstIndex(r, isStart('metasheet-backend')) > firstIndex(r, isLatest))
    assert.doesNotMatch(r.windowLog, /command not found/, 'fetch_json_with_retry is defined when the old version is verified')
    assert.equal(dotEnvTag(r), SHA_OLD)
  })

  scenario('6 as 5 but the old commit does not come back -> 72 needs-owner', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'fail-rollback', H_OLD_RESTART_WRONG: '1' } })
    assertCommon(r, 72)
    assert.equal(r.state.phase, 'needs-owner')
    assert.ok(!any(r, isUp))
  })

  scenario('7 migrate rc 1 with the ledger at L0+3 of 5 -> 74: nothing started', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'fail-partial', H_PARTIAL: '3' } })
    assertCommon(r, 74)
    assert.equal(r.state.phase, 'needs-owner')
    assert.ok(!any(r, (call) => /^start /.test(call.args)), 'nothing started')
    assert.ok(!any(r, isUp), 'nothing created')
    assert.notEqual(dotEnvTag(r), SHA_NEW)
  })

  scenario('8 migrate rc 0 but the post-commit list shows a non-excluded pending name -> 74: .env new, nothing started', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_POSTLIST_EXTRA: 'zzzz20261201120000_harness_unexpected' } })
    assertCommon(r, 74)
    assert.equal(r.state.phase, 'needs-owner')
    assert.equal(r.state.env_written, 'new')
    assert.equal(dotEnvTag(r), SHA_NEW)
    assert.ok(!any(r, (call) => /^start /.test(call.args)))
    assert.ok(!any(r, isUp))
  })

  scenario('9 migrate timeout, kill, wait, ledger L0 -> 71; default sends no pg_cancel_backend', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'timeout' } })
    checkRestoredOld(r)
    const kill = firstIndex(r, (call) => call.args === `kill metasheet-window-migrate-${r.runId}-1`)
    assert.ok(kill > firstIndex(r, isLatest), 'the one-off migrate container is killed')
    assert.ok(!r.docker.some((call) => /pg_cancel_backend|pg_terminate_backend/.test(call.args)), 'no cancel without the opt-in')
  })

  scenario('9 opt-in DEPLOY_WINDOW_CANCEL_OWN_SESSIONS=true: cancel targets only the window application_name', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'timeout', DEPLOY_WINDOW_CANCEL_OWN_SESSIONS: 'true' } })
    checkRestoredOld(r)
    const cancels = r.docker.filter((call) => /pg_cancel_backend/.test(call.args))
    assert.ok(cancels.length >= 1, 'the opt-in cancel is sent')
    for (const call of cancels) {
      assert.ok(call.args.includes(`application_name = 'metasheet-window-migrate-${r.runId}-1'`), call.args)
    }
    assert.ok(!r.docker.some((call) => /pg_terminate_backend/.test(call.args)))
  })

  scenario('10 new backend health fails -> 73: backend stopped not removed, web never upped, no old start', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_NEW_HEALTH_FAIL: '1' } })
    assertCommon(r, 73)
    assert.equal(r.state.phase, 'needs-owner')
    const starts = r.docker.filter((call) => /^start /.test(call.args))
    assert.deepEqual(starts.map((call) => call.args), ['start metasheet-backend'])
    assert.match(starts[0].meta.target, /^new-backend-/, 'only the new backend was started')
    const stopNew = first(r, (call) => isStop('metasheet-backend')(call) && /^new-backend-/.test(call.meta.target), starts[0].index)
    assert.ok(stopNew >= 0, 'the unverified new backend is stopped')
    assert.ok(!any(r, isUpWeb), 'web never upped')
    assert.equal(r.state.env_written, 'new')
  })

  for (const phase of ['stopped', 'needs-owner']) {
    scenario(`11 host state phase=${phase} -> 75: state byte-identical, no docker or git call${REDUCED}`, async (t) => {
      if (REDUCED) t.diagnostic(`reduced fidelity: ${STANDINS.join(', ')} are stand-ins on this machine`)
      const state = `phase=${phase}\nrun=1-1\nsha=${SHA_OLD}\nenv_written=old\n`
      const world = makeWorld(t, { state })
      const r = await runWindow(t, world)
      assertCommon(r, 75)
      assert.equal(readFileSync(path.join(world.windowHome, 'state'), 'utf8'), state)
      assert.deepEqual(r.calls.filter((call) => ['docker', 'git'].includes(call.kind)).map((call) => call.args), [])
    })
  }

  scenario(`11 lock held by another window -> 75: no state written, no docker or git call${REDUCED}`, async (t) => {
    if (REDUCED) t.diagnostic(`reduced fidelity: ${STANDINS.join(', ')} are stand-ins on this machine`)
    const world = makeWorld(t)
    world.holders.push(await holdLock(path.join(world.windowHome, 'lock')))
    const r = await runWindow(t, world)
    assertCommon(r, 75)
    assert.equal(r.stateText, null, 'a refused run writes no state')
    assert.deepEqual(r.calls.filter((call) => ['docker', 'git'].includes(call.kind)).map((call) => call.args), [])
  })

  async function runSync(t, world, env = {}) {
    const output = path.join(world.root, 'sync_output')
    const script = path.join(world.root, 'sync_deploy.sh')
    writeFileSync(script, SYNC_RUN)
    const result = await run(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], {
      cwd: world.work,
      env: {
        PATH: world.PATH, HOME: world.runnerHome, LANG: 'C', TMPDIR: path.join(world.root, 'tmp'), GITHUB_OUTPUT: output,
        DEPLOY_HOST: 'deploy-host', DEPLOY_USER: 'deploy', DEPLOY_SSH_KEY_B64: Buffer.from('k\n').toString('base64'),
        DEPLOY_KNOWN_HOSTS: 'deploy-host ssh-ed25519 AAAAC3NzaharnessKey', DEPLOY_PATH: 'sync-target', DEPLOY_SYNC_MIN_FREE_KB: '1048576',
        H_TAG: world.tag, H_ROOT: world.root, H_DS: world.ds, H_CALLS: path.join(world.root, 'calls.tsv'), H_HOST_HOME: world.hostHome,
        H_CLOCK_START: String(Date.now() / 1000), H_EPOCH: String(QUIET_EPOCH), H_REAL_TAR: REAL.tar, H_TAR_IS_GNU: TAR_IS_GNU ? '1' : '0',
        ...env,
      },
    })
    await assertNoLeftovers(world.tag)
    return { result, out: parseOutput(output), calls: parseCalls(path.join(world.root, 'calls.tsv')), target: path.join(world.hostHome, 'sync-target') }
  }
  const extracted = (target) => existsSync(path.join(target, 'docker-compose.app.yml')) || existsSync(path.join(target, 'docker/nginx.conf'))
  const tarExtracts = (calls) => calls.filter((call) => call.kind === 'tar' && /-x/.test(call.args))

  scenario(`11b sync-step pre-check with the window lock held -> sync_rc 75, nothing extracted${REDUCED}`, async (t) => {
    if (REDUCED) t.diagnostic(`reduced fidelity: ${STANDINS.join(', ')} are stand-ins on this machine`)
    const world = makeWorld(t)
    world.holders.push(await holdLock(path.join(world.windowHome, 'lock')))
    const s = await runSync(t, world)
    assert.equal(s.out.sync_rc, '75')
    assert.equal(s.result.status, 75)
    assert.deepEqual(tarExtracts(s.calls), [], 'no tar -x on the host')
    assert.ok(!extracted(s.target), 'no host file was replaced')
  })

  scenario(`11b sync-step pre-check with an unfinished state -> sync_rc 75; control: free lock and terminal state extract${REDUCED}`, async (t) => {
    const world = makeWorld(t, { state: 'phase=migrating\n' })
    const refused = await runSync(t, world)
    assert.equal(refused.out.sync_rc, '75')
    assert.deepEqual(tarExtracts(refused.calls), [])
    assert.ok(!extracted(refused.target))
    writeFileSync(path.join(world.windowHome, 'state'), 'phase=done-new\n')
    const allowed = await runSync(t, world)
    assert.equal(allowed.out.sync_rc, '0', allowed.result.stderr.slice(-500))
    assert.ok(tarExtracts(allowed.calls).length >= 1)
    assert.ok(extracted(allowed.target), 'the control run does extract')
  })

  it('12 validate_deploy_inputs refuses unselected/invalid inputs before any build, publish or ssh', { timeout: 300_000 }, async (t) => {
    const world = makeWorld(t)
    const base = {
      DRILL_FAIL_STAGE: 'none', EXPECTED_PENDING_SHA256: INPLAY_SHA, RESTORE_PROOF: 'waived', PRE_COMMIT_ABORT: 'restart-old',
      PROD_HEALTH_PROBE_SILENCE: 'true', DEPLOY_WINDOW_PULL_BUDGET_KB: '3145728', DEPLOY_WINDOW_RESERVE_KB: '2097152',
      DEPLOY_BACKUP_TIMEOUT_S: '1200', DEPLOY_BACKUP_VERIFY_TIMEOUT_S: '900', DEPLOY_WINDOW_EXPECTED_MIN: '90', DEPLOY_WINDOW_DRAIN_S: '60',
      DEPLOY_WINDOW_QUEUED_MAX_AGE_S: '86400', DEPLOY_WINDOW_MIN_HOST_CHECKS: '1', DEPLOY_WINDOW_CANCEL_OWN_SESSIONS: 'false',
    }
    const cases = [
      ['valid production deploy', {}, true],
      ['valid deploy drill with unselected restore_proof and pre_commit_abort', { DRILL_FAIL_STAGE: 'deploy', RESTORE_PROOF: 'unselected', PRE_COMMIT_ABORT: 'unselected', PROD_HEALTH_PROBE_SILENCE: '' }, true],
      ['restore_proof unselected', { RESTORE_PROOF: 'unselected' }, false],
      ['restore_proof free text', { RESTORE_PROOF: 'yes' }, false],
      ['pre_commit_abort unselected', { PRE_COMMIT_ABORT: 'unselected' }, false],
      ['bad hash', { EXPECTED_PENDING_SHA256: 'ABC' }, false],
      ['missing hash on a drill', { DRILL_FAIL_STAGE: 'migrate', EXPECTED_PENDING_SHA256: '' }, false],
      ['drill_fail_stage=smoke', { DRILL_FAIL_STAGE: 'smoke' }, false],
      ['probe silence unset', { PROD_HEALTH_PROBE_SILENCE: '' }, false],
      ['probe silence false', { PROD_HEALTH_PROBE_SILENCE: 'false' }, false],
    ]
    for (const [label, env, ok] of cases) {
      const result = await run(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', VALIDATE.run], {
        cwd: world.work, env: { PATH: world.PATH, HOME: world.runnerHome, LANG: 'C', H_CALLS: path.join(world.root, 'calls.tsv'), H_TAG: world.tag, ...base, ...env },
      })
      if (ok) assert.equal(result.status, 0, `${label}: ${result.stderr}`)
      else assert.notEqual(result.status, 0, `${label} must fail the build job`)
    }
    assert.deepEqual(parseCalls(path.join(world.root, 'calls.tsv')), [], 'validation calls no docker, ssh or other double')
    const steps = workflow.jobs.build.steps
    const at = steps.indexOf(VALIDATE)
    assert.ok(steps.slice(0, at).every((step) => !/docker (build|push|login)|--push|ssh /.test(step.run ?? '') && !/login-action/.test(step.uses ?? '')),
      'nothing before the validation builds, publishes or connects')
  })

  for (const [drill, rc] of [['deploy', 91], ['migrate', 92]]) {
    scenario(`13 drill ${drill} -> ${rc}: nothing stopped, env restored`, async (t) => {
      const world = makeWorld(t)
      const r = await runWindow(t, world, { env: { DRILL_FAIL_STAGE: drill } })
      checkRefused(r, rc)
      // The migrate drill fires right after the in-play check, the deploy drill after the drain probe.
      assert.deepEqual(r.hostChecks, drill === 'deploy' ? ['pre-stop'] : [])
      assert.ok(any(r, isList))
    })
  }

  scenario(`14 ssh drops after the web stop -> runner 255; the detached window completes rc 0 / done-new${REDUCED}`, async (t) => {
    if (REDUCED) t.diagnostic(`reduced fidelity: ${STANDINS.join(', ')} are stand-ins on this machine`)
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_SSH_MODE: 'drop' }, waitForRc: true })
    assert.ok(r.calls.some((call) => call.kind === 'ssh-drop'), 'the session was dropped (HUP and TERM to the remote process group)')
    assert.ok(firstIndex(r, isStop('metasheet-web')) >= 0)
    assertCommon(r, 0, { runnerRc: 255 })
    assert.equal(r.state.phase, 'done-new')
    assert.ok(firstIndex(r, isUpWeb) > r.calls.find((call) => call.kind === 'ssh-drop').index, 'the window went on after the drop')
  })

  for (const [label, env, rc] of [
    ['docker info rc 1 in preflight', { H_INFO_RC: '1' }, 70],
    ['timeout 124 on the web stop', { H_STOP_RC_metasheet_web: '124' }, 71],
    ['rc 125 on up --no-start backend in starting-new', { H_UP_BACKEND_RC: '125' }, 73],
  ]) {
    scenario(`15 generic failure: ${label} -> ${rc}, raw_rc logged, never 255`, async (t) => {
      const world = makeWorld(t)
      const r = await runWindow(t, world, { env })
      assertCommon(r, rc)
      // The failed web stop left both old containers running: 4F verifies them and starts nothing.
    if (rc === 71) checkRestoredOld(r, [])
      if (rc === 73) assert.ok(!any(r, isUpWeb))
    })
  }

  scenario(`16 TERM at migrating with the one-off running -> 71/74: kill before any ledger read; no old start while it lives${REDUCED}`, async (t) => {
    if (REDUCED) t.diagnostic(`reduced fidelity: ${STANDINS.join(', ')} are stand-ins on this machine`)
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'term' } })
    assert.ok(['71', '74'].includes(r.rcFile), `rc ${r.rcFile}`)
    assertCommon(r, Number(r.rcFile))
    const latest = firstIndex(r, isLatest)
    const kill = firstIndex(r, (call) => call.args === `kill metasheet-window-migrate-${r.runId}-1`, latest)
    const ledgerRead = firstIndex(r, isLedgerRead, latest)
    assert.ok(kill > latest, 'the one-off is killed')
    assert.ok(ledgerRead < 0 || kill < ledgerRead, 'kill before any ledger read')
    for (const call of r.docker.filter((entry) => /^start /.test(entry.args))) {
      assert.equal(call.meta.oneoff, '0', 'no start while a window migrate session lives')
    }
  })

  scenario(`16 TERM at migrating and the migrate session never ends -> 74, never 4F${REDUCED}`, async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'term', H_SESSIONS: 'migrate-stuck' } })
    assertCommon(r, 74)
    assert.equal(r.state.phase, 'needs-owner')
    assert.ok(!any(r, (call) => /^start /.test(call.args)), 'no restart of the old version while sessions remain')
  })

  scenario('17 migrate error with a detail value -> 71: the value stays on the host, only the SQLSTATE is public', async (t) => {
    const world = makeWorld(t)
    const detail = 'harness-row-value-7Hq2xZ'
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'fail-rollback', H_DETAIL: detail } })
    checkRestoredOld(r)
    assert.ok(readFileSync(path.join(r.runDir, 'migrate.out'), 'utf8').includes(detail), 'control: the raw output carried the value')
    assert.ok(!r.deployLog.includes(detail), 'absent from deploy.log')
    assert.ok(!r.windowLog.includes(detail), 'absent from window.log')
    assert.match(r.deployLog, /migrate sqlstate=23505/)
    assert.match(r.deployLog, /^failed to execute migration "[^"]+"$/m)
  })

  scenario('18 app data present, post-start count mismatch -> 73: copy-in before the start, web never upped', async (t) => {
    const world = makeWorld(t, { appdata: true })
    const r = await runWindow(t, world, { env: { H_APPDATA_AFTER_EXTRA: '1' } })
    assertCommon(r, 73)
    const up = firstIndex(r, isUpNoStartBackend)
    assertOrdered([['up --no-start backend', up], ['copy-in', firstIndex(r, isCpIn, up)], ['start new backend', firstIndex(r, isStart('metasheet-backend'), up)]])
    assert.ok(!any(r, isUpWeb))
  })

  scenario('19 post-backend host check fails -> 73: web never upped', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_HOSTCHECK_FAIL: 'post-backend' } })
    assertCommon(r, 73)
    assert.deepEqual(r.hostChecks, ['pre-stop', 'post-backend'])
    assert.ok(!any(r, isUpWeb))
  })

  scenario('20 restart of the old version with the stopped containers gone -> 72: no pull, run or up after the stop', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_GONE_ON_BACKEND_STOP: '1' } })
    assertCommon(r, 72)
    assert.equal(r.state.phase, 'needs-owner')
    const stop = firstIndex(r, (call) => /^stop /.test(call.args))
    assert.ok(stop >= 0)
    assert.ok(!r.docker.some((call) => call.index > stop && ['pull', 'run', 'up'].includes(composeSub(call))), 'nothing pulled or recreated')
    assert.ok(!any(r, (call) => /^start /.test(call.args)))
  })

  scenario('21 pre_commit_abort=stay-stopped and the drain fails -> 72: no docker start, env restored', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { PRE_COMMIT_ABORT: 'stay-stopped', H_SESSIONS: 'never' } })
    assertCommon(r, 72)
    assert.equal(r.state.phase, 'needs-owner')
    assert.ok(!any(r, (call) => /^start /.test(call.args)))
    envUnchanged(r)
  })

  // ---------- further rows of the design: ledger branch, trap rows, abort file, phase-0/1/5 checks ----------
  scenario('n = 0 (only the excluded name pending), migrate rc 0 -> committed row, done-new', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_IMAGE_MIGRATIONS: [...BASE_MIGRATIONS, EXCLUDED].join(','), EXPECTED_PENDING_SHA256: sha256('') } })
    assertCommon(r, 0)
    assert.ok(any(r, isDump), 'the window still backs up')
    assert.equal(dotEnvTag(r), SHA_NEW)
  })

  scenario('n = 0, migrate rc 1 -> rolled-back row: 71', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_IMAGE_MIGRATIONS: [...BASE_MIGRATIONS, EXCLUDED].join(','), EXPECTED_PENDING_SHA256: sha256(''), H_MIGRATE: 'fail-empty' } })
    checkRestoredOld(r)
  })

  scenario('migrate rc 1 but the ledger reads L0+n with the in-play names -> committed, continues to done-new', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'fail-committed' } })
    assertCommon(r, 0)
    assert.equal(r.state.phase, 'done-new')
    assert.match(r.windowLog, /migrate rc!=0 but ledger committed/)
  })

  scenario('the migration applied the excluded name too -> neither row: 74, nothing started', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE_IGNORE_EXCLUDE: '1' } })
    assertCommon(r, 74)
    assert.ok(!any(r, (call) => /^start /.test(call.args)))
    assert.ok(!any(r, isUp))
  })

  scenario('TERM in phase committed (post-commit list running) -> 74: .env new, nothing started', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_TERM_ON_POSTLIST: '1' } })
    assertCommon(r, 74)
    assert.equal(r.state.env_written, 'new')
    assert.equal(dotEnvTag(r), SHA_NEW)
    assert.ok(!any(r, (call) => /^start /.test(call.args)))
    assert.ok(!any(r, isUp))
  })

  scenario('TERM in phase starting-new before the backend is verified -> 73: backend stopped, web never upped', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_TERM_ON_LOGS: '1' } })
    assertCommon(r, 73)
    const start = firstIndex(r, isStart('metasheet-backend'))
    assert.ok(any(r, (call) => call.index > start && isStop('metasheet-backend')(call) && /^new-backend-/.test(call.meta.target)))
    assert.ok(!any(r, isUpWeb))
  })

  scenario('abort file created after the stop -> restart old: 71', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_ABORT_ON: 'backend-stop' } })
    checkRestoredOld(r)
    assert.ok(!any(r, isLatest), 'no migration after the abort')
  })

  scenario('abort file created while migrating is ignored -> done-new', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_ABORT_ON: 'migrate' } })
    assertCommon(r, 0)
    assert.equal(r.state.phase, 'done-new')
  })

  scenario('an old container running again after the commit is stopped -> 73', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_WEB_RUNNING_AFTER_COMMIT: '1' } })
    assertCommon(r, 73)
    assert.ok(any(r, (call) => call.index > firstIndex(r, isLatest) && isStop('metasheet-web')(call) && /^ctr-web-1@/.test(call.meta.target)))
    assert.ok(!any(r, isUp), 'nothing new is started')
  })

  for (const [label, worldOptions, env] of [
    ['attendance preflight fails', {}, { H_PREFLIGHT_RC: '3' }],
    ['postgres data mount is not the project volume', { containers: { 'metasheet-postgres': { volume: 'other_metasheet-postgres-data' } } }, {}],
    ['running backend /health commit differs from its image revision', {}, { H_OLD_HEALTH_WRONG: '1' }],
    ['excluded migration already in the ledger (stale exclusion)', {}, { H_LEDGER_EXTRA: EXCLUDED }],
    ['excluded tables already exist', {}, { H_EXCLUDED_TABLES: '1' }],
  ]) {
    scenario(`2 refusal before any stop: ${label} -> 70`, async (t) => {
      const world = makeWorld(t, worldOptions)
      if (env.H_LEDGER_EXTRA) writeFileSync(path.join(world.ds, 'ledger'), [...BASE_MIGRATIONS, env.H_LEDGER_EXTRA].join('\n') + '\n')
      checkRefused(await runWindow(t, world, { env }))
    })
  }

  scenario('dump lacks the kysely_migration data in its TOC -> 71', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_TOC_NO_LEDGER: '1' } })
    checkRestoredOld(r)
    assert.ok(!existsSync(path.join(r.runDir, 'db.dump')))
  })

  scenario('dump timeout with the own-session opt-in -> 71; the cancel names only pg_dump', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_DUMP_MODE: 'timeout', DEPLOY_WINDOW_CANCEL_OWN_SESSIONS: 'true' } })
    checkRestoredOld(r)
    const cancels = r.docker.filter((call) => /pg_cancel_backend/.test(call.args))
    assert.ok(cancels.length >= 1)
    for (const call of cancels) assert.ok(call.args.includes("application_name = 'pg_dump'"), call.args)
    assert.ok(!existsSync(path.join(r.runDir, 'db.dump.partial')))
  })

  scenario('app-data copy-out fails -> 71', async (t) => {
    const world = makeWorld(t, { appdata: true })
    const r = await runWindow(t, world, { env: { H_TAR_OUT_RC: '1' } })
    // Web was stopped, the backend not yet: only web is started again.
    checkRestoredOld(r, ['metasheet-web'])
    assert.ok(!any(r, isStop('metasheet-backend')))
    assert.ok(!any(r, isDump))
  })

  for (const [label, env] of [['ops-switch line is not off (normal delivery)', { H_OPS_SWITCH: 'on (holding deliveries)' }], ['/api/plugins does not answer', { H_PLUGINS_FAIL: '1' }]]) {
    scenario(`new backend check fails: ${label} -> 73, web never upped`, async (t) => {
      const world = makeWorld(t)
      const r = await runWindow(t, world, { env })
      assertCommon(r, 73)
      assert.ok(!any(r, isUpWeb))
      assert.ok(any(r, (call) => isStop('metasheet-backend')(call) && /^new-backend-/.test(call.meta.target)))
    })
  }

  scenario('bootstrap: no window.pid within 30 s -> 76', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { runText: mutate(REMOTE_RUN, `'echo "$$" > window.pid'\n`, `'exit 0'\n`) })
    assert.equal(r.out.deploy_rc, '76')
    assert.equal(r.rcFile, '')
  })

  scenario('bootstrap: the window ends without an rc file -> 76', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { runText: mutate(REMOTE_RUN, `'echo "$$" > window.pid'\n`, `'echo "$$" > window.pid; exit 0'\n`) })
    assert.equal(r.out.deploy_rc, '76')
    assert.equal(r.rcFile, '')
  })

  // ---------- recorded deviations and tool probes ----------
  scenario('pre-existing SHA guard in the prologue ends as 70 refused-unchanged (rc from phase: recorded deviation 5)', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { DEPLOY_IMAGE_TAG: 'latest', DEPLOY_EXPECTED_COMMIT: 'latest' } })
    checkRefused(r)
    assert.ok(!any(r, isPull))
  })

  scenario('compose v2 missing in the prologue ends as 70 refused-unchanged (recorded deviation 5)', async (t) => {
    const world = makeWorld(t)
    checkRefused(await runWindow(t, world, { env: { H_COMPOSE_MISSING: '1' } }))
  })

  scenario('bootstrap: the run directory already exists -> 76, nothing runs (recorded deviation 7)', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { preRunDir: true })
    assert.equal(r.out.deploy_rc, '76')
    assert.equal(r.rcFile, '')
    assert.deepEqual(r.calls.filter((call) => ['docker', 'git'].includes(call.kind)), [])
  })

  scenario('host without setsid: the window still starts and refuses 70 (recorded deviation 8)', async (t) => {
    const world = makeWorld(t, { absentTools: ['setsid'] })
    const r = await runWindow(t, world)
    checkRefused(r)
    assert.ok(!any(r, isPull))
  })

  scenario('host without timeout -> 70 before anything changes', async (t) => {
    const world = makeWorld(t, { absentTools: ['timeout'] })
    checkRefused(await runWindow(t, world))
  })

  scenario('host without flock -> 75, no state written', async (t) => {
    const world = makeWorld(t, { absentTools: ['flock'] })
    const r = await runWindow(t, world)
    assertCommon(r, 75)
    assert.equal(r.stateText, null)
    assert.deepEqual(r.calls.filter((call) => ['docker', 'git'].includes(call.kind)), [])
  })

  scenario('drain probe with the import and sync tables absent proceeds (recorded deviation 16)', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_TABLES_ABSENT: '1' } })
    assertCommon(r, 0)
  })

  // ---------- static assertions on the exact window.sh the bootstrap receives ----------
  async function captureWindow(t) {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_SSH_MODE: 'capture' } })
    const capture = readFileSync(path.join(world.root, 'ssh-capture.txt'), 'utf8')
    const b64 = capture.match(/^window_b64='([A-Za-z0-9+/=]+)'$/m)?.[1]
    assert.ok(b64, 'the bootstrap carries window_b64')
    return { capture, text: Buffer.from(b64, 'base64').toString('utf8'), r }
  }

  it('static: the window text has no SIGPIPE-prone pipes, every compose run has -T and </dev/null, no secret', { timeout: 300_000 }, async (t) => {
    const { capture, text } = await captureWindow(t)
    assert.ok(text.length > 50_000)
    assert.equal(text.split('\n')[0], 'echo "$$" > window.pid', 'window.pid is written first')
    const code = text.split('\n').filter((line) => !/^\s*#/.test(line))
    assert.deepEqual(code.filter((line) => /\|\s*grep\s+-[A-Za-z]*q/.test(line)), [], 'no | grep -q after a producer')
    assert.deepEqual(code.filter((line) => /\|\s*head\b/.test(line)), [], 'no | head after a producer')
    const runs = code.filter((line) => /docker compose\b.*\brun\b/.test(line))
    assert.ok(runs.length >= 3)
    for (const line of runs) {
      assert.match(line, / -T /, line)
      assert.match(line, /<\/dev\/null/, line)
    }
    assert.deepEqual(code.filter((line) => /MIGRATION_EXCLUDE/.test(line) && /app\.env/.test(line) && />/.test(line)), [], 'nothing writes MIGRATION_EXCLUDE into app.env')
    assert.ok(!text.includes(FAKE_SECRET), 'the secret is not part of window.sh')
    assert.ok(!text.includes(Buffer.from(FAKE_SECRET).toString('base64')))
    assert.ok(!capture.includes(FAKE_SECRET), 'the secret crosses ssh only encoded on stdin, never in clear')
    // Every docker stop/start/exec/inspect/kill/cp is bounded by timeout, except the two pinned
    // digest lines whose pinned prefix cannot take one (recorded deviation 2).
    const unbounded = code.map((line) => line.replace(/\b(werr|wlog|fail|echo)\s+"[^"]*"/g, '$1 MESSAGE'))
      .filter((line) => /\bdocker\s+(stop|start|exec|inspect|kill|cp|image\s+inspect)\b/.test(line))
      .filter((line) => !/\btimeout\s+\S+\s+docker\b/.test(line))
      .filter((line) => !/^(backend|web)_repo_digest="\$\(docker image inspect /.test(line.trim()))
    assert.deepEqual(unbounded, [])
  })

  // ---------- negative controls: the harness goes red when the window skips a safety step ----------
  function mutate(text, from, to) {
    const count = text.split(from).length - 1
    assert.equal(count, 1, `mutation anchor must occur exactly once: ${from.slice(0, 60)}`)
    return text.replace(from, to)
  }
  const WEB_STOP = 'timeout 90 docker stop -t 60 metasheet-web >/dev/null 2>>"${RUN_DIR}/docker.err" || fail "docker stop metasheet-web failed"'
  const RESTORE_HEAD = 'restore_env_snapshots() {\n'

  scenario('negative control: a window that skips the web stop fails the happy-path check', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { runText: mutate(REMOTE_RUN, WEB_STOP, 'true') })
    assert.throws(() => checkHappy(r, { appdata: false }), assert.AssertionError)
    assert.ok(!any(r, isStop('metasheet-web')) || r.rcFile !== '0')
  })

  scenario('negative control: a window that skips the env restore fails the refusal and 4F checks', async (t) => {
    const mutated = mutate(REMOTE_RUN, RESTORE_HEAD, `${RESTORE_HEAD}  return 0\n`)
    const refusalWorld = makeWorld(t)
    const refused = await runWindow(t, refusalWorld, { runText: mutated, env: { H_HOSTCHECK_FAIL: 'pre-stop' } })
    assert.equal(refused.rcFile, '70')
    assert.throws(() => checkRefused(refused), assert.AssertionError)
    const restartWorld = makeWorld(t)
    const restarted = await runWindow(t, restartWorld, { runText: mutated, env: { H_MIGRATE: 'fail-rollback' } })
    assert.throws(() => checkRestoredOld(restarted), assert.AssertionError)
  })
})
