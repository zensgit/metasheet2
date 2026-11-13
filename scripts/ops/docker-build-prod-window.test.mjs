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
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
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
const SUMMARY_RUN = deploySteps.find((step) => step.name === 'Write deploy summary (preflight + runbooks)').run
const STATUS_RUN = deploySteps.find((step) => step.id === 'window_status').run

const SHA_NEW = 'a'.repeat(40)
const SHA_OLD = 'b'.repeat(40)
const FAKE_SECRET = 'harness-fake-jwt-value-QXJx7mPLtw'
const EXCLUDED = 'zzzz20260919090000_create_approval_template_group_backfill_batches'
const BASE_MIGRATIONS = Array.from({ length: 9 }, (_, i) => `zzzz2026010${i + 1}120000_harness_base_${i + 1}`)
const INPLAY = Array.from({ length: 5 }, (_, i) => `zzzz2026110${i + 1}120000_harness_new_${i + 1}`)
const IMAGE_MIGRATIONS = [...BASE_MIGRATIONS, EXCLUDED, ...INPLAY]
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const INPLAY_SHA = sha256(INPLAY.join('\n'))
// A distinctive database size for the worlds that check what the public outputs carry.
const DB_BYTES = '987654321'
const DB_KB = String(Math.ceil(Number(DB_BYTES) / 1024))
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
// Skipped only off Linux (a macOS machine without a newer bash); on Linux (CI) a missing bash >= 4
// is a failure, not a silent skip.
const SKIP = BASH || process.platform === 'linux' ? false : 'no bash with BASH_VERSINFO[0] >= 4 found (set HARNESS_BASH)'
const which = (name) => spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim()
const REAL = { flock: which('flock'), setsid: which('setsid'), timeout: which('timeout'), tar: which('tar') }
const TAR_IS_GNU = /GNU tar/.test(spawnSync(REAL.tar || 'tar', ['--version'], { encoding: 'utf8' }).stdout ?? '')
const STANDINS = ['flock', 'setsid', 'timeout'].filter((name) => !REAL[name])
const REDUCED = STANDINS.length > 0
  ? ` [reduced fidelity: ${STANDINS.join('/')} stand-ins, not the real binaries]`
  : ''
const STUBS = ['docker', 'docker-compose', 'ssh', 'curl', 'git', 'crontab', 'loginctl', 'busctl', 'date', 'sleep', 'df', 'tar']

// ---------- processes ----------
function run(cmd, args, options) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    options.onSpawn?.(child)
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

// Leaked processes of a scenario are found two ways. Every process it starts carries
// H_TAG=<unique> in its environment (read from /proc on Linux; macOS no longer shows other
// processes' environments). And the step runs as the leader of its own process group, while
// the window leads its own session: every process left in one of those groups (`ps -o pgid`)
// is a leaked window, helper or follower.
//
// A process group id is a pid, and pids are reused. world.groups maps each registered group id
// to its leader as seen at registration ("<start time>|<command line>"), or to null once the
// leader is gone. A live leader that does not match is another process that got the same pid:
// that group is dropped and never killed. A group seen empty is dropped too; while a group has
// members its id cannot be given to a new process.
function processTable() {
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,lstart=,command='], { encoding: 'utf8' }).stdout ?? ''
  const rows = []
  for (const line of listing.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/)
    // Zombies are dead and only wait for their parent to reap them.
    if (m && !m[3].startsWith('Z')) rows.push({ pid: Number(m[1]), pgid: Number(m[2]), identity: `${m[4].replace(/\s+/g, ' ')}|${m[5]}` })
  }
  return rows
}
function identityOf(pid, table = processTable()) {
  return table.find((row) => row.pid === pid)?.identity ?? null
}
// Registers a process group of this scenario; `expect` (a RegExp) must match the command line of
// a live leader, or the group is not registered (a window pid read late from window.pid).
function trackGroup(world, pid, expect = null) {
  if (!(pid > 1) || world.groups.has(pid)) return
  const identity = identityOf(pid)
  if (identity !== null && expect && !expect.test(identity.slice(identity.indexOf('|') + 1))) return
  world.groups.set(pid, identity)
}
function scanTagged(world) {
  const found = new Map()
  const needle = `H_TAG=${world.tag}`
  const table = processTable()
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        if (readFileSync(`/proc/${entry}/environ`, 'latin1').split('\0').includes(needle)) found.set(Number(entry), identityOf(Number(entry), table))
      } catch {}
    }
  }
  for (const [pgid, leader] of [...world.groups]) {
    const live = identityOf(pgid, table)
    if (live !== null && live !== leader) { world.groups.delete(pgid); continue }
    if (live === null) world.groups.set(pgid, null)
    const members = table.filter((row) => row.pgid === pgid)
    if (members.length === 0) { world.groups.delete(pgid); continue }
    for (const row of members) found.set(row.pid, row.identity)
  }
  found.delete(process.pid)
  return found
}
function taggedPids(world) {
  return [...scanTagged(world).keys()]
}
// SIGKILL only a process that is still the one the scan found (same start time and command).
function killTagged(world) {
  const found = scanTagged(world)
  const table = processTable()
  for (const [pid, identity] of found) {
    if (identity === null || identityOf(pid, table) !== identity) continue
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}
async function assertNoLeftovers(world) {
  let left = []
  for (let i = 0; i < 50; i += 1) {
    left = taggedPids(world)
    if (left.length === 0) return
    await sleepMs(100)
  }
  const detail = left.map((pid) => spawnSync('ps', ['-o', 'pid=,pgid=,command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim() || String(pid))
  killTagged(world)
  assert.fail(`processes of this scenario were still running after it ended: ${JSON.stringify(detail)}`)
}
// Window pids of every run of this world become leak-scan process groups.
function addWindowGroups(world) {
  const runs = path.join(world.windowHome, 'runs')
  if (!existsSync(runs)) return
  for (const entry of readdirSync(runs)) {
    const pid = Number((readIf(path.join(runs, entry, 'window.pid')) ?? '').trim())
    trackGroup(world, pid, /\bwindow\.sh\b/)
  }
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
  const root = realpathSync(mkdtempSync(path.join(tmpBase, 'deploy-window-')))
  const tag = `${path.basename(root)}-${process.pid}`
  const world = { root, tag, holders: [], groups: new Map(), absent: new Set(options.absentTools ?? []) }
  t.after(() => {
    for (const holder of world.holders) { try { holder.kill('SIGKILL') } catch {} }
    if (world.windowHome) addWindowGroups(world)
    killTagged(world)
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
  if (options.attVolume) {
    // The compose file's attendance-import named volume, mounted at /app/uploads/attendance-import
    // of the backend: the double keeps its contents outside the container filesystem.
    const vol = path.join(ds, 'volumes/attendance-import/org1')
    mkdirSync(vol, { recursive: true })
    writeFileSync(path.join(vol, 'upload.csv'), 'a,b\n')
    mkdirSync(path.join(ds, 'ctr/metasheet-backend/fs/app/uploads/attendance-import'), { recursive: true })
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
  for (const [i, name] of STUBS.entries()) {
    if (world.absent.has(name)) assert.equal(resolved[i], `missing:${name}`, `${name} is absent from PATH`)
    else assert.equal(resolved[i], path.join(world.bin, name), `${name} must resolve to the test double`)
  }
  const result = await run(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], {
    cwd: world.work, env, detached: true, onSpawn: (child) => trackGroup(world, child.pid),
  })
  if (options.waitForRc) {
    for (let i = 0; i < 1200 && !existsSync(path.join(runDir, 'rc')); i += 1) await sleepMs(100)
  }
  // The bootstrap returns only after the window exits (or the session dropped); give a detached
  // window a moment to finish its exit trap, then require that nothing of this scenario survives.
  addWindowGroups(world)
  await assertNoLeftovers(world)
  options.afterRun?.()
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
const isReadBack = (call) => /^cp metasheet-backend:\/app\/\S+ -$/.test(call.args)
const isPgIsready = (call) => /^exec metasheet-postgres sh -c exec pg_isready /.test(call.args)
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
    ...(appdata ? [['app-data copy-in', firstIndex(r, isCpIn, upBackend)], ['app-data read-back', firstIndex(r, isReadBack, upBackend)]] : []),
    ['start new backend', firstIndex(r, isStart('metasheet-backend'), upBackend)],
    ['up web', firstIndex(r, isUpWeb)],
  ]
  assertOrdered(order)
  if (!appdata) {
    assert.ok(!any(r, isTarOut), 'no app-data copy when there is none')
    assert.ok(!any(r, isCpIn))
    assert.ok(!any(r, isReadBack))
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
  assert.match(r.deployLog, /^\[deploy-window\] backup ok sha256=[0-9a-f]{64} file=db\.dump$/m)
  assert.match(readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8'), /^backup bytes=\d+ toc_entries=\d+$/m, 'dump size and TOC count stay in the host detail log')
  // Backup set beside the dump, host only: run dir 700, files 600; env snapshot taken before the rewrite.
  assert.equal(statSync(r.runDir).mode & 0o777, 0o700)
  for (const file of ['db.dump', 'meta.txt', 'globals.sql', 'shim-candidates.txt', 'RESTORE-README.txt', 'migrate.out', 'window-detail.log']) {
    assert.ok(existsSync(path.join(r.runDir, file)), `${file} kept on the host`)
    assert.equal(statSync(path.join(r.runDir, file)).mode & 0o077, 0, `${file} is private to the deploy user`)
  }
  assert.equal(readFileSync(path.join(r.runDir, 'env-snapshot.app.env'), 'utf8'), readFileSync(path.join(r.world.orig, 'app.env'), 'utf8'))
  // Public-log rule: raw host-check, docker logs, dump and env values stay off the streamed log.
  for (const raw of ['harness host check private output', 'server listening', 'outbound webhook ops switch: off', 'PGDMP', 'harness globals', 'harness-db-pass']) {
    assert.ok(!r.deployLog.includes(raw), `deploy.log must not carry: ${raw}`)
  }
  assert.match(r.deployLog, /ops_switch=off/)
  // Of the deploy user's crontab only the docker GC / prune count is logged.
  assert.match(r.deployLog, /^\[deploy-window\] crontab docker_gc_entries=0$/m)
  assert.doesNotMatch(r.deployLog, /crontab entries=/)
  // No git auto-gc/maintenance during the prologue sync, and only there.
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
  const preRestart = r.calls.find((call) => call.kind === 'hostcheck' && call.args === 'pre-restart-old')
  assert.ok(preRestart, 'host check pre-restart-old runs before the old version is restarted')
  for (const start of starts) assert.ok(preRestart.index < start.index, 'pre-restart-old host check precedes every start')
  for (const start of starts) {
    assert.match(start.meta.target, /^ctr-(backend|web)-1@sha256:old/, 'the old, stopped containers are started, not new ones')
    assert.equal(start.meta.appenv_orig, '1', 'docker/app.env restored before the old start')
    assert.equal(start.meta.dotenv_orig, '1', '.env restored before the old start')
  }
  assert.ok(!any(r, isUp), 'never up / recreate on the way back')
  envUnchanged(r)
}

// Runs the deploy summary step on a deploy.log (none when null) with the given rc outputs.
async function runSummary(world, { deployLog, syncRc = '0', deployRc, drill = 'none' }) {
  const dir = mkdtempSync(path.join(world.root, 'summary-'))
  symlinkSync(path.join(repoRoot, 'scripts'), path.join(dir, 'scripts'))
  mkdirSync(path.join(dir, 'output/deploy'), { recursive: true })
  if (deployLog !== null) writeFileSync(path.join(dir, 'output/deploy/deploy.log'), deployLog)
  const summary = path.join(dir, 'step-summary.out')
  const result = await run(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', SUMMARY_RUN], {
    cwd: dir,
    env: {
      PATH: process.env.PATH, HOME: world.runnerHome, LANG: 'C', GITHUB_STEP_SUMMARY: summary, GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'example/metasheet2', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', SYNC_RC: syncRc, DEPLOY_RC: deployRc ?? '',
      DRILL_FAIL_STAGE: drill, RESTORE_PROOF: 'ref:harness-restore-1', PRE_COMMIT_ABORT: 'restart-old', H_TAG: world.tag,
    },
  })
  assert.equal(result.status, 0, `summary step exits 0: ${result.stderr.slice(-800)}`)
  const text = readFileSync(summary, 'utf8')
  assert.equal(readFileSync(path.join(dir, 'output/deploy/step-summary.md'), 'utf8'), text, 'the archived copy equals the summary')
  return text
}
// Every path under the host home with its type, mode, size, mtime and content hash (symlinks by
// target): reading files changes none of these.
function hostTree(dir, rel = '', out = {}) {
  for (const entry of readdirSync(path.join(dir, rel)).sort()) {
    const relPath = path.join(rel, entry)
    const full = path.join(dir, relPath)
    const st = lstatSync(full)
    const base = `${st.mode.toString(8)} ${st.mtimeMs}`
    if (st.isSymbolicLink()) out[relPath] = `link ${readlinkSync(full)}`
    else if (st.isDirectory()) { out[relPath] = `dir ${base}`; hostTree(dir, relPath, out) }
    else out[relPath] = `file ${base} ${st.size} ${sha256(readFileSync(full))}`
  }
  return out
}

// Runs the read-only window status step, unmodified, through the ssh double, and requires that
// it changed nothing under the host home, made exactly one ssh call and no docker or git call.
async function runStatus(world, runId, runText = STATUS_RUN) {
  const dir = mkdtempSync(path.join(world.root, 'status-'))
  const before = hostTree(world.hostHome)
  const callsBefore = parseCalls(path.join(world.root, 'calls.tsv')).length
  const result = await run(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', runText], {
    cwd: dir,
    detached: true,
    onSpawn: (child) => trackGroup(world, child.pid),
    env: {
      PATH: world.PATH, HOME: world.runnerHome, LANG: 'C', LC_ALL: 'C', TMPDIR: path.join(world.root, 'tmp'),
      GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: '1',
      DEPLOY_HOST: 'deploy-host', DEPLOY_USER: 'deploy', DEPLOY_SSH_KEY_B64: Buffer.from('harness private key\n').toString('base64'),
      DEPLOY_KNOWN_HOSTS: Buffer.from('deploy-host ssh-ed25519 AAAAC3NzaharnessKey\n').toString('base64'),
      H_TAG: world.tag, H_ROOT: world.root, H_CALLS: path.join(world.root, 'calls.tsv'), H_HOST_HOME: world.hostHome,
      H_CLOCK_START: String(Date.now() / 1000), H_EPOCH: String(QUIET_EPOCH),
    },
  })
  await assertNoLeftovers(world)
  assert.equal(result.status, 0, `the status step exits 0: ${result.stderr.slice(-800)}`)
  assert.deepEqual(hostTree(world.hostHome), before, 'the status step changed nothing on the host')
  const added = parseCalls(path.join(world.root, 'calls.tsv')).slice(callsBefore)
  assert.deepEqual(added.map((call) => call.kind), ['ssh'], 'exactly one ssh session and nothing else')
  const log = readFileSync(path.join(dir, 'output/deploy/window-status.log'), 'utf8')
  assert.match(log, /^\[deploy-status\] ssh rc=0$/m)
  assert.ok(!log.includes(FAKE_SECRET), 'no secret in the status log')
  assert.ok(!existsSync(path.join(dir, 'output/deploy/deploy.log')), 'the status step does not write deploy.log')
  return log
}

const REMINDER = /unset PROD_HEALTH_PROBE_SILENCE after verification/i
const ENV_WARNING = /do not start the old containers/i
// For every non-drill deploy outcome the summary's last line is the probe-silence reminder.
function checkSummaryTail(text) {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  assert.match(lines.at(-1), REMINDER, `last summary line: ${lines.at(-1)}`)
  assert.equal(text.split('\n').filter((line) => REMINDER.test(line)).length, 1, 'the reminder appears once')
}

// Production state before the deploy stays in host files: deploy.log, the step summary and the
// status output carry no old commit, image id or digest, no in-play or excluded migration name,
// no database size and no ledger count (L0, L0 + n) in a key=value or migrate --list form.
const OLD_STATE_VALUES = [SHA_OLD, '1'.repeat(64), '3'.repeat(64), 'sha256:oldbackendimage', 'sha256:oldwebimage', ...INPLAY, EXCLUDED, DB_BYTES, DB_KB]
const LEDGER_COUNTS = new Set([String(BASE_MIGRATIONS.length), String(BASE_MIGRATIONS.length + INPLAY.length)])
function assertNoPreDeployState(label, text) {
  for (const value of OLD_STATE_VALUES) assert.ok(!text.includes(value), `${label} must not carry ${value}`)
  assert.doesNotMatch(text, /\b(Applied|Pending): \d/, `${label}: no migrate --list counts`)
  assert.doesNotMatch(text, /\b(ledger|before|after|now|inplay|L0)[=:] ?\d/i, `${label}: no ledger count`)
  assert.doesNotMatch(text, /\b(bytes|[a-z_]*kb)=\d/, `${label}: no size measured on the host`)
  for (const [, key, value] of text.matchAll(/([A-Za-z_]+)=(\d+)\b/g)) {
    assert.ok(!LEDGER_COUNTS.has(value) || ['rc', 'raw_rc', 'elapsed_s'].includes(key), `${label}: ${key}=${value} looks like a ledger count`)
  }
}
// Runs the summary and the status step on a finished window and checks all three public outputs;
// control: the host detail log does hold the values.
async function checkPublicOutputs(world, r, { drill = 'none', reachedInplay = true } = {}) {
  const summary = await runSummary(world, { deployLog: r.deployLog, deployRc: r.out.deploy_rc, drill })
  const status = await runStatus(world, r.runId)
  for (const [label, text] of [['deploy.log', r.deployLog], ['step summary', summary], ['status output', status]]) {
    assertNoPreDeployState(label, text)
    assert.ok(!text.includes(INPLAY_SHA), `${label} must not carry the expected pending-set hash (a repository secret)`)
  }
  const detail = readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8')
  assert.ok(detail.includes(`running_backend_commit=${SHA_OLD}`), 'control: the detail log holds the running commit')
  assert.ok(detail.includes('sha256:oldbackendimage'), 'control: the detail log holds the old image id')
  if (reachedInplay) {
    assert.ok(detail.includes(`inplay name=${INPLAY[0]}`), 'control: the detail log holds the in-play names')
    assert.ok(detail.includes(`database_kb=${DB_KB}`), 'control: the detail log holds the database size')
    assert.match(detail, new RegExp(`^ledger before=${BASE_MIGRATIONS.length} inplay=${INPLAY.length} `, 'm'), 'control: the detail log holds the ledger count')
  }
  assert.equal(statSync(path.join(r.runDir, 'window-detail.log')).mode & 0o077, 0, 'the detail log is private to the deploy user')
  assert.match(status, /^\[deploy-status\] state phase=/m, 'the status step still prints the phase')
  return { summary, status }
}

// ---------- scenarios ----------
const CONCURRENCY = Number(process.env.HARNESS_CONCURRENCY) || Math.max(2, Math.min(6, os.availableParallelism?.() ?? os.cpus().length))

it('a bash with BASH_VERSINFO[0] >= 4 is available (required on Linux)', { skip: SKIP }, () => {
  assert.ok(BASH, 'no bash >= 4 found: install one or set HARNESS_BASH')
})

describe('production deploy window: remote_deploy step run against test doubles', { concurrency: CONCURRENCY, skip: SKIP }, () => {
  const scenario = (name, fn) => it(name, { timeout: 300_000 }, fn)

  scenario('1 happy path with app data: full order, IMAGE_TAG on every compose call, .env written at the commit', async (t) => {
    const world = makeWorld(t, { appdata: true })
    const r = await runWindow(t, world, { env: { H_DB_BYTES: DB_BYTES, H_DUMP_MODE: 'slow' } })
    checkHappy(r, { appdata: true })
    const { summary } = await checkPublicOutputs(world, r)
    // The slow dump outlasts a heartbeat interval: its progress line carries no size.
    assert.match(r.deployLog, /^\[deploy-window\] heartbeat phase=backup elapsed_s=\d+$/m)
    assert.match(readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8'), /^heartbeat phase=backup bytes=\d+$/m)
    assert.match(r.deployLog, /^\[deploy-window\] pending_set=match$/m)
    assert.match(r.deployLog, /^\[deploy-window\] exclusion_proof=ok$/m)
    assert.match(r.deployLog, /^\[deploy-window\] migrate rc=0 sqlstate=none$/m)
    assert.match(r.deployLog, /^\[deploy-window\] ledger=committed post_commit_checks=ok$/m)
    assert.match(r.deployLog, /^\[deploy-window\] appdata copy=ok sha256=[0-9a-f]{64} file=appdata\.tar$/m)
    assert.match(summary, /^- `pending_set=match`$/m)
    assert.match(summary, /window-detail\.log/)
    assert.match(readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8'), new RegExp(`^migration "${INPLAY[0]}" was executed successfully$`, 'm'),
      'the per-migration lines are in the host detail log')
  })

  scenario('1 happy path without app data: no copy-out, no copy-in', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world)
    checkHappy(r, { appdata: false })
    const summary = await runSummary(world, { deployLog: r.deployLog, deployRc: r.out.deploy_rc })
    checkSummaryTail(summary)
    assert.doesNotMatch(summary, ENV_WARNING)
  })

  const REFUSALS = [
    ['pull fails', {}, { H_PULL_RC: '1' }],
    ['pulled revision label differs', {}, { H_NEW_REV_BACKEND: 'f'.repeat(40) }],
    ['pulled web revision label differs', {}, { H_NEW_REV_WEB: 'f'.repeat(40) }],
    ['pulled web image has no repo digest', {}, { H_NO_DIGEST: 'web' }],
    ['pulled backend image has no repo digest', {}, { H_NO_DIGEST: 'backend' }],
    ['pre-pull disk gate', {}, { H_DF_FREE_KB: String(1024 * 1024) }],
    ['post-pull disk gate (database larger than the free space)', {}, { H_DB_BYTES: String(200 * 1024 ** 3) }],
    ['in-play sha mismatch', {}, { EXPECTED_PENDING_SHA256: 'f'.repeat(64) }],
    ['in-play sha with a trailing newline is refused (names joined by newline without a trailing one)', {}, { EXPECTED_PENDING_SHA256: sha256(INPLAY.join('\n') + '\n') }],
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
    ['host re-validation: the expected pending-set hash from the secret is not hex', {}, { EXPECTED_PENDING_SHA256: 'not-a-hash' }],
    ['host re-validation: restore_proof free text', {}, { RESTORE_PROOF: 'yes' }],
    ['host re-validation: a tunable that is not a positive integer', {}, { DEPLOY_WINDOW_DRAIN_S: '0' }],
  ]
  for (const [label, worldOptions, env] of REFUSALS) {
    scenario(`2 refusal before any stop: ${label} -> 70, env files byte-identical`, async (t) => {
      const world = makeWorld(t, worldOptions)
      const r = await runWindow(t, world, { env })
      checkRefused(r)
      if (env.H_HOSTCHECK_FAIL) assert.deepEqual(r.hostChecks, ['pre-stop'])
      if (env.H_PULL_RC || env.H_NEW_REV_BACKEND || env.H_NEW_REV_WEB || env.H_NO_DIGEST || env.H_DB_BYTES) assert.ok(any(r, isPull), 'reached the pull')
      if (env.H_NEW_REV_WEB) assert.match(r.windowLog, /pulled web image revision label does not equal the dispatched commit/)
      if (env.H_NO_DIGEST) assert.match(r.windowLog, new RegExp(`pulled ${env.H_NO_DIGEST} image has no repo digest`))
      // The abort file present at the start is refused there, before the pull.
      if (worldOptions.abort) {
        assert.match(r.windowLog, /abort file present at start/)
        assert.ok(!any(r, isPull), 'refused before the pull')
      }
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
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'fail-rollback', H_DB_BYTES: DB_BYTES } })
    checkRestoredOld(r)
    await checkPublicOutputs(world, r)
    assert.match(r.deployLog, /^\[deploy-window\] old version restarted revision=match$/m)
    assert.ok(readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8').includes(`old version restarted backend_commit=${SHA_OLD} web_commit=${SHA_OLD}`))
    assert.ok(first(r, isLatest) >= 0)
    assert.ok(firstIndex(r, isStart('metasheet-backend')) > firstIndex(r, isLatest))
    assert.doesNotMatch(r.windowLog, /command not found/, 'fetch_json_with_retry is defined when the old version is verified')
    assert.equal(dotEnvTag(r), SHA_OLD)
    const summary = await runSummary(world, { deployLog: r.deployLog, deployRc: r.out.deploy_rc })
    checkSummaryTail(summary)
    assert.doesNotMatch(summary, ENV_WARNING, 'no env warning when .env still names the old image')
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
    const world = makeWorld(t, { appdata: true })
    const r = await runWindow(t, world, { env: { H_NEW_HEALTH_FAIL: '1', H_DB_BYTES: DB_BYTES } })
    await checkPublicOutputs(world, r)
    assertCommon(r, 73)
    assert.equal(r.state.phase, 'needs-owner')
    const starts = r.docker.filter((call) => /^start /.test(call.args))
    assert.deepEqual(starts.map((call) => call.args), ['start metasheet-backend'])
    assert.match(starts[0].meta.target, /^new-backend-/, 'only the new backend was started')
    const stopNew = first(r, (call) => isStop('metasheet-backend')(call) && /^new-backend-/.test(call.meta.target), starts[0].index)
    assert.ok(stopNew >= 0, 'the unverified new backend is stopped')
    assert.ok(!any(r, isUpWeb), 'web never upped')
    assert.equal(r.state.env_written, 'new')
    const summary = await runSummary(world, { deployLog: r.deployLog, deployRc: r.out.deploy_rc })
    checkSummaryTail(summary)
    assert.match(summary, ENV_WARNING, 'rc 73 always carries the env warning')
    const status = await runStatus(world, r.runId)
    assert.match(status, /^\[deploy-status\] state phase=needs-owner$/m)
    assert.match(status, /^\[deploy-status\] state env_written=new$/m)
    assert.match(status, /^\[deploy-status\] run rc=73$/m)
    assert.match(status, /^\[deploy-status\] marker === DEPLOY START ===$/m)
    assert.match(status, /^\[deploy-status\] outcome=needs-owner rc=73 raw_rc=\d*$/m)
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

  it(`11 host state the window cannot read -> 75: the state file is neither read nor replaced${REDUCED}`, { timeout: 300_000, skip: process.getuid?.() === 0 ? 'root reads any file' : false }, async (t) => {
    const state = `phase=needs-owner\nrun=1-1\nsha=${SHA_OLD}\nenv_written=new\n`
    const world = makeWorld(t, { state })
    const statePath = path.join(world.windowHome, 'state')
    chmodSync(statePath, 0o000)
    let modeAfter = null
    const r = await runWindow(t, world, { afterRun: () => { modeAfter = statSync(statePath).mode & 0o777; chmodSync(statePath, 0o600) } })
    assertCommon(r, 75)
    assert.equal(modeAfter, 0, 'the unreadable state file was not replaced by a new one')
    assert.equal(r.stateText, state, 'state byte-identical')
    assert.match(r.windowLog, /host window state cannot be read/)
    assert.deepEqual(r.calls.filter((call) => ['docker', 'git'].includes(call.kind)).map((call) => call.args), [])
  })

  // The summary step on synthetic deploy logs: every operator-action arm, including the
  // outcomes after which the follower saw no window line (255, 76, a missing rc).
  it('summary: operator actions for sync 75 / sync 1 / 72 / 73 / 74 / 76 / 255 / missing rc / 0', { timeout: 300_000 }, async (t) => {
    const world = makeWorld(t)
    const log = (...lines) => ['=== WINDOW PREFLIGHT START ===', ...lines, ''].join('\n')
    const state = (phase, envWritten) => `[deploy-window] state phase=${phase} env_written=${envWritten} backend_verified=0 web_verified=0`
    const outcome = (rc) => `[deploy-window] outcome=needs-owner rc=${rc} raw_rc=1`
    const appdata = '[deploy-window] appdata copy=ok sha256=' + '0'.repeat(64) + ' file=appdata.tar'
    const cases = [
      ['sync refused 75', { syncRc: '75', deployLog: null }, { syncRefused: true }],
      ['sync failed 1', { syncRc: '1', deployLog: null }, {}],
      ['72', { deployRc: '72', deployLog: log(state('stopped', 'old'), outcome(72)) }, { line72: true, envWritten: 'old' }],
      ['73 with app data', { deployRc: '73', deployLog: log(appdata, state('starting-new', 'new'), outcome(73), '[deploy-window] warning env_written=new: never start the old containers; .env already names the new image') }, { env: true, appdata: true, envWritten: 'new' }],
      ['74 with env_written=old', { deployRc: '74', deployLog: log(state('migrating', 'old'), outcome(74)) }, { env: true, envWritten: 'old' }],
      ['74 with app data', { deployRc: '74', deployLog: log(appdata, state('committed', 'new'), outcome(74)) }, { env: true, appdata: true, envWritten: 'new' }],
      ['76', { deployRc: '76', deployLog: log(state('stopping', 'old')) }, { env: true, readHost: true }],
      ['255', { deployRc: '255', deployLog: log(appdata, state('backed-up', 'old')) }, { env: true, readHost: true, appdata: true }],
      ['missing rc', { deployLog: log(state('preflight', 'old')) }, { env: true, readHost: true }],
      ['missing rc and no deploy.log', { deployLog: null }, { env: true, readHost: true }],
      ['0', { deployRc: '0', deployLog: log(appdata, state('done-new', 'new')) }, { envWritten: 'new' }],
    ]
    for (const [label, input, want] of cases) {
      const summary = await runSummary(world, input)
      checkSummaryTail(summary)
      const check = (flag, pattern, what) => (flag ? assert.match : assert.doesNotMatch)(summary, pattern, `${label}: ${what}`)
      check(want.env, ENV_WARNING, 'never start the old containers')
      check(want.env, /The migration may have committed, whatever env_written says: do NOT start the old containers; do NOT run scripts\/ops\/deploy-attendance-prod\.sh or the env-reconcile workflow; do not run a bare docker compose up\./, 'unconditional recovery rule')
      check(want.readHost, /^- Read the host state first \(metasheet2-deploy-window\/state/m, 'read-host-state line')
      check(want.line72, /Pre-commit abort with production down/, '72 line')
      check(want.syncRefused, /Sync refused \(75\)/, 'sync 75 line')
      check(want.appdata, /App data: this run copied the backend's local files to appdata\.tar/, 'app-data line')
      if (want.envWritten) assert.match(summary, new RegExp(`^- Last env_written seen in the log: \`${want.envWritten}\`$`, 'm'), label)
    }
  })

  async function runSync(t, world, env = {}) {
    const output = path.join(world.root, 'sync_output')
    const script = path.join(world.root, 'sync_deploy.sh')
    writeFileSync(script, SYNC_RUN)
    const result = await run(BASH, ['--noprofile', '--norc', '-e', '-o', 'pipefail', script], {
      cwd: world.work,
      detached: true,
      onSpawn: (child) => trackGroup(world, child.pid),
      env: {
        PATH: world.PATH, HOME: world.runnerHome, LANG: 'C', TMPDIR: path.join(world.root, 'tmp'), GITHUB_OUTPUT: output,
        DEPLOY_HOST: 'deploy-host', DEPLOY_USER: 'deploy', DEPLOY_SSH_KEY_B64: Buffer.from('k\n').toString('base64'),
        DEPLOY_KNOWN_HOSTS: 'deploy-host ssh-ed25519 AAAAC3NzaharnessKey', DEPLOY_PATH: 'sync-target', DEPLOY_SYNC_MIN_FREE_KB: '1048576',
        H_TAG: world.tag, H_ROOT: world.root, H_DS: world.ds, H_CALLS: path.join(world.root, 'calls.tsv'), H_HOST_HOME: world.hostHome,
        H_CLOCK_START: String(Date.now() / 1000), H_EPOCH: String(QUIET_EPOCH), H_REAL_TAR: REAL.tar, H_TAR_IS_GNU: TAR_IS_GNU ? '1' : '0',
        ...env,
      },
    })
    await assertNoLeftovers(world)
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
      ['tunable zero', { DEPLOY_WINDOW_DRAIN_S: '0' }, false],
      ['tunable with a unit', { DEPLOY_BACKUP_TIMEOUT_S: '20m' }, false],
      ['expected window longer than a day', { DEPLOY_WINDOW_EXPECTED_MIN: '1441' }, false],
      ['own-session cancel not a boolean', { DEPLOY_WINDOW_CANCEL_OWN_SESSIONS: 'yes' }, false],
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
      const r = await runWindow(t, world, { env: { DRILL_FAIL_STAGE: drill, H_DB_BYTES: DB_BYTES } })
      checkRefused(r, rc)
      await checkPublicOutputs(world, r, { drill })
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
    // The read-only status step shows what the follower missed.
    const status = await runStatus(world, r.runId)
    assert.match(status, new RegExp(`^\\[deploy-status\\] read-only host state for run=${r.runId}-1 `, 'm'))
    assert.match(status, /^\[deploy-status\] state phase=done-new$/m)
    assert.match(status, /^\[deploy-status\] run rc=0$/m)
    for (const marker of ['WINDOW PREFLIGHT START', 'STOP WRITES START', 'BACKUP END', 'MIGRATE END', 'DEPLOY END', 'VERSION VERIFY END']) {
      assert.match(status, new RegExp(`^\\[deploy-status\\] marker === ${marker} ===$`, 'm'))
    }
    assert.match(status, /^\[deploy-status\] outcome=done-new rc=0 raw_rc=\d*$/m)
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
    if (r.rcFile === '71') assert.ok(ledgerRead > kill, 'a restart of the old version follows a ledger read after the kill')
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
    assert.match(r.deployLog, /^\[deploy-window\] migrate rc=1 sqlstate=23505$/m)
    assert.doesNotMatch(r.deployLog, /failed to execute migration|was executed successfully/, 'the per-migration lines stay on the host')
    assert.match(readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8'), /^failed to execute migration "[^"]+"$/m)
  })

  scenario('18 app data present, post-start count mismatch -> 73: copy-in before the start, web never upped', async (t) => {
    const world = makeWorld(t, { appdata: true })
    const r = await runWindow(t, world, { env: { H_APPDATA_AFTER_EXTRA: '1' } })
    assertCommon(r, 73)
    const up = firstIndex(r, isUpNoStartBackend)
    assertOrdered([['up --no-start backend', up], ['copy-in', firstIndex(r, isCpIn, up)], ['start new backend', firstIndex(r, isStart('metasheet-backend'), up)]])
    assert.ok(!any(r, isUpWeb))
  })

  scenario('app data present, the read-back from the created backend misses a file -> 73: the new backend is never started', async (t) => {
    const world = makeWorld(t, { appdata: true })
    const r = await runWindow(t, world, { env: { H_CP_IN_SHORT: '1' } })
    assertCommon(r, 73)
    assert.match(r.windowLog, /app data read back from the created backend does not match the copy-out record/)
    const up = firstIndex(r, isUpNoStartBackend)
    assertOrdered([['up --no-start backend', up], ['copy-in', firstIndex(r, isCpIn, up)], ['read-back', firstIndex(r, isReadBack, up)]])
    assert.ok(!any(r, (call) => /^start /.test(call.args)), 'neither the new nor the old backend is started')
    assert.ok(!any(r, isUpWeb))
  })

  scenario('app data present, the new backend deletes an expired draft at its first start -> accepted, done-new', async (t) => {
    const world = makeWorld(t, { appdata: true })
    const r = await runWindow(t, world, { env: { H_CLEANUP_ON_START: '1' } })
    checkHappy(r, { appdata: true })
    const detail = readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8')
    assert.match(detail, /^appdata read_back files=2 bytes=16$/m)
    assert.match(detail, /^appdata after_start files=1 bytes=11$/m)
    assert.match(r.windowLog, /^\[deploy-window\] appdata read_back=match$/m)
    assert.match(r.windowLog, /appdata after_start has fewer files than the copy; accepted/)
    assert.doesNotMatch(r.windowLog, /files=\d/, 'app-data counts stay in the host detail log')
  })

  scenario('app data present and the attendance-import volume holds a file -> the read-back leaves the volume out, done-new', async (t) => {
    const world = makeWorld(t, { appdata: true, attVolume: true })
    const r = await runWindow(t, world)
    checkHappy(r, { appdata: true })
    assert.ok(any(r, (call) => call.args === 'cp metasheet-backend:/app/uploads -'), 'the uploads path is read back too')
    assert.match(readFileSync(path.join(r.runDir, 'appdata.readback.list'), 'utf8'), /uploads\/attendance-import\/org1\/upload\.csv$/m,
      'control: the read-back stream did carry the volume file')
    assert.match(readFileSync(path.join(r.runDir, 'window-detail.log'), 'utf8'), /^appdata read_back files=2 bytes=16$/m)
  })

  scenario('app data present with the attendance-import volume, the read-back misses a file outside it -> 73: never started', async (t) => {
    const world = makeWorld(t, { appdata: true, attVolume: true })
    const r = await runWindow(t, world, { env: { H_CP_IN_SHORT: '1' } })
    assertCommon(r, 73)
    assert.match(r.windowLog, /app data read back from the created backend does not match the copy-out record/)
    assert.ok(!any(r, (call) => /^start /.test(call.args)), 'neither the new nor the old backend is started')
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
    assert.match(r.windowLog, /abort file present at boundary=after-stop/)
    assert.ok(!any(r, isDump), 'stopped at the boundary right after the stop, before the dump')
  })

  scenario('abort file created during the pull -> 70 at the boundary before the stop', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_ABORT_ON: 'pull' } })
    checkRefused(r)
    assert.ok(any(r, isPull))
    assert.match(r.windowLog, /abort file present at boundary=before-stop/)
  })

  for (const [point, label] of [['dump', 'pg_dump'], ['restore', 'the dump verification']]) {
    scenario(`abort file created during ${label} -> 71 at the boundary after the backup, no migration`, async (t) => {
      const world = makeWorld(t)
      const r = await runWindow(t, world, { env: { H_ABORT_ON: point } })
      checkRestoredOld(r)
      assert.match(r.windowLog, /abort file present at boundary=after-backup/)
      assert.ok(any(r, isDump))
      assert.ok(!any(r, isPgIsready), 'stopped before the readiness probe of the migration')
      assert.ok(!any(r, isLatest), 'no migration after the abort')
    })
  }

  scenario('abort file created at the readiness probe before the migration -> 71 at the boundary before the migration', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_ABORT_ON: 'pg-isready' } })
    checkRestoredOld(r)
    assert.match(r.windowLog, /abort file present at boundary=before-migrate/)
    assert.ok(!any(r, isLatest), 'no migration after the abort')
  })

  scenario('a client connects during the backup and stays -> 71 at the check after the backup, no migration', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_LATE_SESSION: 'after-backup' } })
    checkRestoredOld(r)
    assert.match(r.windowLog, /a database session is still connected after the backup/)
    assert.ok(!any(r, isPgIsready), 'stopped before the readiness probe of the migration')
    assert.ok(!any(r, isLatest))
  })

  scenario('a client connects right before the migration -> 71 at the pre-migration check, no migration', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_LATE_SESSION: 'before-migrate' } })
    checkRestoredOld(r)
    assert.match(r.windowLog, /a database session connected before the migration/)
    assert.ok(!any(r, isLatest))
  })

  scenario('the session count cannot be read -> not zero: 71 at the drain, no pg_dump', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_SESSION_COUNT_FAIL: '1' } })
    checkRestoredOld(r)
    assert.match(r.windowLog, /sessions at=stop-writes client_backends=unreadable/)
    assert.ok(!any(r, isDump), 'no backup after an unreadable count')
    assert.ok(!any(r, isLatest))
  })

  scenario('TERM at migrating after the batch committed -> 74: .env new, nothing started', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'term-after-commit' } })
    assertCommon(r, 74)
    assert.equal(r.state.phase, 'needs-owner')
    assert.equal(r.state.env_written, 'new')
    assert.equal(dotEnvTag(r), SHA_NEW)
    const latest = firstIndex(r, isLatest)
    const kill = firstIndex(r, (call) => call.args === `kill metasheet-window-migrate-${r.runId}-1`, latest)
    assert.ok(kill > latest, 'the one-off is killed')
    assert.match(r.windowLog, /migrate resolve result=committed/)
    assert.ok(!any(r, (call) => /^start /.test(call.args)), 'the old version is never started on the migrated schema')
    assert.ok(!any(r, isUp))
  })

  for (const [label, migrate, rcLine] of [['migrate rc 1', 'fail-committed', /resolve result=unreadable/], ['migrate rc 0', 'ok', /migrate exited 0 but the ledger is not L0 \+ n/]]) {
    scenario(`${label}, then the ledger cannot be read -> 74: nothing started, env_written old, the outcome warns`, async (t) => {
      const world = makeWorld(t)
      const r = await runWindow(t, world, { env: { H_MIGRATE: migrate, H_PSQL_FAIL_AFTER_MIGRATE: '1' } })
      assertCommon(r, 74)
      assert.equal(r.state.phase, 'needs-owner')
      assert.equal(r.state.env_written, 'old')
      assert.match(r.windowLog, rcLine)
      const ledger = readFileSync(path.join(world.ds, 'ledger'), 'utf8').split('\n').filter(Boolean)
      assert.deepEqual(ledger, [...BASE_MIGRATIONS, ...INPLAY], 'the batch did commit')
      assert.ok(!any(r, (call) => /^start /.test(call.args)), 'an unreadable ledger is never treated as rolled back')
      assert.ok(!any(r, isUp))
      assert.match(r.windowLog, /warning env_written=old: /)
      const summary = await runSummary(world, { deployLog: r.deployLog, deployRc: r.out.deploy_rc })
      checkSummaryTail(summary)
      assert.match(summary, ENV_WARNING)
    })
  }

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

  scenario('dump TOC has data only for kysely_migration_lock, not for the ledger table -> 71', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_TOC_LOCK_ONLY: '1' } })
    checkRestoredOld(r)
    assert.match(r.windowLog, /the dump has no kysely_migration data/)
    assert.ok(!existsSync(path.join(r.runDir, 'db.dump')))
    assert.ok(!any(r, isLatest))
  })

  scenario('an old container gone after the commit -> 73 with a message that does not claim it ran again', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_WEB_GONE_AFTER_COMMIT: '1' } })
    assertCommon(r, 73)
    assert.match(r.windowLog, /metasheet-web is gone or its state cannot be read after the commit/)
    assert.doesNotMatch(r.windowLog, /was running again/)
    assert.ok(!any(r, (call) => /^start /.test(call.args)), 'nothing started')
    assert.ok(!any(r, isUp), 'nothing created')
  })

  it('summary: rc 93 is no drill (only deploy and migrate drills exist)', { timeout: 300_000 }, async (t) => {
    const world = makeWorld(t)
    const summary = await runSummary(world, { deployLog: '', deployRc: '93' })
    assert.match(summary, /Remote exit code: `93` \(meaning: remote failure \(see stages\/logs\)\)/)
    assert.doesNotMatch(summary, /smoke stage/)
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

  for (const [label, env] of [['app-data copy-out fails after writing part of the archive', { H_TAR_OUT_RC: '1' }], ['app-data archive cannot be listed', { H_TAR_OUT_GARBAGE: '1' }]]) {
    scenario(`${label} -> 71: the unverified appdata.tar is deleted`, async (t) => {
      const world = makeWorld(t, { appdata: true })
      const r = await runWindow(t, world, { env })
      // Web was stopped, the backend not yet: only web is started again.
      checkRestoredOld(r, ['metasheet-web'])
      assert.ok(!any(r, isStop('metasheet-backend')))
      assert.ok(!any(r, isDump))
      assert.match(r.windowLog, env.H_TAR_OUT_RC ? /app data copy-out failed rc=1/ : /app data archive cannot be listed/)
      assert.ok(!existsSync(path.join(r.runDir, 'appdata.tar')), 'no partial appdata.tar is left in the run directory')
    })
  }

  for (const [label, env] of [['ops-switch line is not off (normal delivery)', { H_OPS_SWITCH: 'on (subscription webhook sends paused)' }], ['/api/plugins does not answer', { H_PLUGINS_FAIL: '1' }]]) {
    scenario(`new backend check fails: ${label} -> 73, web never upped`, async (t) => {
      const world = makeWorld(t)
      const r = await runWindow(t, world, { env })
      assertCommon(r, 73)
      assert.ok(!any(r, isUpWeb))
      assert.ok(any(r, (call) => isStop('metasheet-backend')(call) && /^new-backend-/.test(call.meta.target)))
    })
  }

  scenario('the .env write fails after the commit -> 74: env_written stays old, nothing started, the outcome says so', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_ENV_RO_AT_MIGRATE: '1' } })
    assertCommon(r, 74)
    assert.equal(r.state.phase, 'needs-owner')
    assert.equal(r.state.env_written, 'old', 'env_written is set only after the read-back')
    assert.equal(dotEnvTag(r), SHA_OLD)
    const ledger = readFileSync(path.join(world.ds, 'ledger'), 'utf8').split('\n').filter(Boolean)
    assert.deepEqual(ledger, [...BASE_MIGRATIONS, ...INPLAY], 'the migration committed')
    assert.doesNotMatch(r.windowLog, /persisted IMAGE_OWNER and IMAGE_TAG/, 'a failed write is not reported as persisted')
    assert.doesNotMatch(r.windowLog, /env_written=new/)
    assert.match(r.windowLog, /^\[deploy-window\] warning env_written=old: .*start nothing until the owner has read the ledger$/m)
    assert.ok(!any(r, (call) => /^start /.test(call.args)), 'nothing started')
    assert.ok(!any(r, isUp), 'nothing created')
  })

  it('.env not writable by the deploy user -> 70 before anything is stopped', { timeout: 300_000, skip: process.getuid?.() === 0 ? 'root can write any file' : false }, async (t) => {
    const world = makeWorld(t)
    chmodSync(path.join(world.repo, '.env'), 0o444)
    const r = await runWindow(t, world)
    checkRefused(r)
    assert.match(r.windowLog, /\.env is not a regular file the deploy user can read and write/)
    assert.ok(!any(r, isPull), 'refused before the pull')
  })

  scenario('new web refuses its first requests after the start -> the window waits for its port, done-new', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_WEB_REFUSE_FIRST: '3' } })
    checkHappy(r, { appdata: false })
    assert.equal(readFileSync(path.join(world.ds, 'web_refused'), 'utf8'), '3', 'the first requests to the new web were refused')
  })

  scenario('new web never answers on its port -> 73: the new web stopped, the verified backend left running', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_WEB_REFUSE_FIRST: '1000' } })
    assertCommon(r, 73)
    assert.match(r.windowLog, /new web did not answer on its port/)
    assert.ok(any(r, (call) => isStop('metasheet-web')(call) && /^new-web-/.test(call.meta.target)), 'the unverified new web is stopped')
    assert.ok(!any(r, (call) => isStop('metasheet-backend')(call) && /^new-backend-/.test(call.meta.target)), 'the verified backend keeps running')
  })

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
    const status = await runStatus(world, r.runId)
    assert.match(status, /^\[deploy-status\] state absent$/m)
    assert.match(status, /^\[deploy-status\] run rc absent: /m)
    assert.doesNotMatch(status, /marker|outcome=/)
  })

  scenario('read-only status step on a host with no run directory: absent lines, only key=value state lines, exit 0', async (t) => {
    const state = `phase=needs-owner\nnote=$(touch x) with spaces\nenv_written=new\nsha=${SHA_NEW}\nold_backend_image=ghcr.io/zensgit/metasheet2-backend:${SHA_OLD}\nledger_before=9\nrc=73\n`
    const world = makeWorld(t, { state })
    const status = await runStatus(world, '424242')
    assert.match(status, /^\[deploy-status\] state phase=needs-owner$/m)
    assert.match(status, /^\[deploy-status\] state env_written=new$/m)
    assert.match(status, /^\[deploy-status\] state rc=73$/m)
    assert.doesNotMatch(status, /state (sha|old_backend_image|ledger_before)=/, 'only the allowed state keys are printed')
    assertNoPreDeployState('status output', status)
    assert.doesNotMatch(status, /note=|touch/, 'a line that is not a plain key=value is not printed')
    assert.match(status, /^\[deploy-status\] run rc absent: /m)
    assert.match(status, /^\[deploy-status\] window\.log absent$/m)
    assert.equal(readFileSync(path.join(world.windowHome, 'state'), 'utf8'), state)
  })

  scenario('negative control: a status step that writes on the host fails the read-only check', async (t) => {
    const world = makeWorld(t, { state: 'phase=done-new\n' })
    const mutated = mutate(STATUS_RUN, '\nexit 0\nWINDOW_STATUS\n', '\ntouch "${status_home}/abort"\nexit 0\nWINDOW_STATUS\n')
    await assert.rejects(runStatus(world, '424243', mutated), /changed nothing on the host/)
    assert.ok(existsSync(path.join(world.windowHome, 'abort')), 'the mutation really wrote on the host')
  })

  scenario('restart of the old version: pre-restart-old host check fails -> 72, nothing started', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_MIGRATE: 'fail-rollback', H_HOSTCHECK_FAIL: 'pre-restart-old' } })
    assertCommon(r, 72)
    assert.equal(r.state.phase, 'needs-owner')
    assert.deepEqual(r.hostChecks, ['pre-stop', 'pre-restart-old'])
    assert.ok(!any(r, (call) => /^start /.test(call.args)))
    envUnchanged(r)
  })

  it('the leak detector finds a left-over process of a scenario (positive control)', async (t) => {
    const world = makeWorld(t)
    // A detached shell that leaves a grandchild in its group, as a leaked helper would.
    const child = spawn(BASH, ['-c', '/bin/sleep 30 & echo $!; wait'], {
      env: { PATH: process.env.PATH, H_TAG: world.tag }, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    trackGroup(world, child.pid)
    const grandchild = Number(await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(String(chunk).trim()))))
    try {
      assert.ok(taggedPids(world).includes(grandchild), 'the grandchild is found')
      await assert.rejects(assertNoLeftovers(world), /still running/)
      // SIGKILL is asynchronous: give the killed processes up to 2 s to disappear.
      let left = taggedPids(world)
      for (let i = 0; i < 20 && left.length > 0; i += 1) {
        await sleepMs(100)
        left = taggedPids(world)
      }
      assert.deepEqual(left, [], 'the detector kills what it reports')
    } finally {
      try { process.kill(-child.pid, 'SIGKILL') } catch {}
    }
  })

  it('the leak detector leaves alone a process group whose leader is not the one it registered (reused pid)', async (t) => {
    const world = makeWorld(t)
    // An unrelated group leader, not tagged: stands for a process that got a registered pid again.
    const other = spawn('/bin/sleep', ['30'], { env: { PATH: process.env.PATH }, detached: true, stdio: 'ignore' })
    try {
      await sleepMs(200)
      trackGroup(world, other.pid, /\bwindow\.sh\b/)
      assert.ok(!world.groups.has(other.pid), 'a late-read window pid whose command is not the window is not registered')
      world.groups.set(other.pid, 'Thu Jan  1 00:00:00 1970|bash window.sh')
      assert.deepEqual(taggedPids(world), [], 'a group with a different leader is not reported')
      assert.ok(!world.groups.has(other.pid), 'and is dropped')
      world.groups.set(other.pid, 'Thu Jan  1 00:00:00 1970|bash window.sh')
      killTagged(world)
      await sleepMs(200)
      assert.equal(other.exitCode, null, 'the unrelated process was not killed')
      assert.equal(other.signalCode, null, 'the unrelated process was not killed')
    } finally {
      try { process.kill(other.pid, 'SIGKILL') } catch {}
    }
  })

  scenario('negative control: a window that leaves its heartbeat helper running fails the leak check', async (t) => {
    const world = makeWorld(t)
    const mutated = mutate(REMOTE_RUN, 'stop_helpers() {\n', 'stop_helpers() {\n  return 0\n')
    await assert.rejects(runWindow(t, world, { runText: mutated }), /still running/)
  })

  // ---------- prologue exits, bootstrap and host tool probes ----------
  scenario('pre-existing SHA guard in the prologue ends as 70 refused-unchanged (the rc comes from the window phase)', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { DEPLOY_IMAGE_TAG: 'latest', DEPLOY_EXPECTED_COMMIT: 'latest' } })
    checkRefused(r)
    assert.ok(!any(r, isPull))
  })

  scenario('compose v2 missing in the prologue ends as 70 refused-unchanged (the rc comes from the window phase)', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { env: { H_COMPOSE_MISSING: '1' } })
    checkRefused(r)
    assert.deepEqual(r.calls.filter((call) => call.kind === 'docker-compose').map((call) => call.args), ['--version'], 'only the docker-compose double ran')
  })

  scenario('neither compose v2 nor docker-compose in the prologue ends as 70 refused-unchanged', async (t) => {
    const world = makeWorld(t, { absentTools: ['docker-compose'] })
    const r = await runWindow(t, world, { env: { H_COMPOSE_MISSING: '1' } })
    checkRefused(r)
    assert.match(r.deployLog, /neither 'docker compose' nor 'docker-compose' is available/)
    assert.deepEqual(r.calls.filter((call) => call.kind === 'docker-compose'), [], 'no docker-compose call')
  })

  scenario('bootstrap: the run directory already exists -> 76, nothing runs (a run directory is never reused)', async (t) => {
    const world = makeWorld(t)
    const r = await runWindow(t, world, { preRunDir: true })
    assert.equal(r.out.deploy_rc, '76')
    assert.equal(r.rcFile, '')
    assert.deepEqual(r.calls.filter((call) => ['docker', 'git'].includes(call.kind)), [])
  })

  scenario('host without setsid: the window still starts (nohup only) and refuses 70', async (t) => {
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

  scenario('drain probe with the import and sync tables absent proceeds (older schemas)', async (t) => {
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
    // digest lines whose pinned prefix cannot take one.
    const unbounded = code.map((line) => line.replace(/\b(werr|wlog|fail|echo)\s+"[^"]*"/g, '$1 MESSAGE'))
      .filter((line) => /\bdocker\s+(stop|start|exec|inspect|kill|cp|image\s+inspect)\b/.test(line))
      .filter((line) => !/\btimeout\s+\S+\s+docker\b/.test(line))
      .filter((line) => !/^(backend|web)_repo_digest="\$\(docker image inspect /.test(line.trim()))
    assert.deepEqual(unbounded, [])
    // Every compose pull/run/up and the owner host-check call carry the time bound of the design's
    // timeout table (pull 900, list 120, migrate 900, post-commit list 120, backend up 300, web up 300,
    // host check 400): with production stopped and the lock held, nothing may wait forever.
    const plain = code.map((line) => line.replace(/\b(werr|wlog|fail|echo)\s+"[^"]*"/g, '$1 MESSAGE'))
    const composeCalls = plain.filter((line) => /\bdocker compose\b.*\s(pull|run|up)\s/.test(line))
    const bounds = [
      [/ pull backend web /, '900'],
      [/ run .*--name "metasheet-window-list-/, '120'],
      [/ run .*--name "metasheet-window-migrate-/, '900'],
      [/ run .*--name "metasheet-window-postlist-/, '120'],
      [/ up --no-start --no-deps --force-recreate backend /, '300'],
      [/ up -d --no-deps --force-recreate web /, '300'],
    ]
    assert.equal(composeCalls.length, bounds.length, `compose pull/run/up lines: ${JSON.stringify(composeCalls)}`)
    for (const [pattern, seconds] of bounds) {
      const lines = composeCalls.filter((line) => pattern.test(line))
      assert.equal(lines.length, 1, `one compose line matches ${pattern}`)
      assert.equal(lines[0].match(/\btimeout\s+(\S+)\s+docker compose\b/)?.[1], seconds, `${pattern} is bounded by timeout ${seconds}`)
    }
    const hostCheckCalls = plain.filter((line) => /"\$check" "\$phase"/.test(line))
    assert.equal(hostCheckCalls.length, 1)
    assert.match(hostCheckCalls[0], /^\s*timeout 400 "\$check" "\$phase" /, 'the host check is bounded by timeout 400')
    // A second TERM cannot cut the exit mapping short: both handlers ignore TERM first.
    const body = (name) => text.match(new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}$`, 'm'))?.[1].split('\n').map((line) => line.trim())
    assert.equal(body('on_term')?.[0], "trap '' TERM", 'on_term ignores TERM first')
    assert.deepEqual(body('on_exit')?.slice(0, 2), ['local raw=$? final', "trap '' TERM"], 'on_exit ignores TERM right after reading $?')
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
    // The real stop verification catches the running web: refused in phase stopping, the old
    // version restarted (71), and no migration.
    assert.equal(r.rcFile, '71')
    assert.ok(r.windowLog.includes('[deploy-window][error] metasheet-web is not stopped'), 'the stop verification reports the running web')
    assert.ok(!any(r, isLatest), 'no migration while the web is running')
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
