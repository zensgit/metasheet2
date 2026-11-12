import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function readRepoFile(...segments) {
  return readFileSync(path.join(repoRoot, ...segments), 'utf8')
}

function assertContains(haystack, needle, label) {
  assert.ok(
    String(haystack).includes(needle),
    `${label} must include ${needle}`,
  )
}

test('backend media dependencies use HTTPS bootstrap then system trust with bounded retries', () => {
  const raw = readRepoFile('Dockerfile.backend')
  const runner = raw.split('FROM node:20-slim AS runner')[1]
  assert.ok(runner)
  const ca = runner.indexOf('install -y --no-install-recommends ca-certificates')
  const https = runner.indexOf("sed -i 's|http://deb.debian.org|https://deb.debian.org|g'")
  const media = runner.indexOf('install -y --no-install-recommends ffmpeg')
  const bootstrap = runner.indexOf('require("tls").rootCertificates')
  const cleanup = runner.indexOf('rm /tmp/elearning-apt-bootstrap-ca.pem')
  assert.ok(bootstrap >= 0 && https > bootstrap && ca > https && cleanup > ca && media > cleanup)
  const aptCommands = runner.match(/apt-get[^\n]+/g)
  assert.equal(aptCommands?.length, 4)
  for (const [index, command] of aptCommands.entries()) {
    assert.match(command, /-o Acquire::Retries=3/)
    assert.match(command, /-o Acquire::https::Timeout=30/)
    if (index < 2) {
      assert.match(command, /-o Acquire::https::CaInfo=\/tmp\/elearning-apt-bootstrap-ca.pem/)
    } else {
      assert.doesNotMatch(command, /CaInfo/)
    }
    if (/\bupdate\b/.test(command)) assert.match(command, /-o APT::Update::Error-Mode=any/)
  }
  assert.match(runner, /test -s \/etc\/ssl\/certs\/ca-certificates.crt/)
  assert.doesNotMatch(runner, /^(?:ENV|ARG).*NODE_(?:EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED)/m)
  assert.ok(runner.indexOf('command -v ffprobe') > media)
  assert.doesNotMatch(runner, /--allow-unauthenticated|trusted=yes|Verify-Peer=false|Verify-Host=false|\|\|\s*true/)
})

test('frontend build gets a bounded build-only heap budget', () => {
  const raw = readRepoFile('Dockerfile.frontend')
  const stages = raw.split(/^FROM nginx:[^\n]+$/m)
  assert.equal(stages.length, 2)
  assert.match(stages[0], /^RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @metasheet\/web build$/m)
  assert.doesNotMatch(stages[0], /^(?:ENV|ARG) NODE_OPTIONS/m)
  assert.doesNotMatch(stages[1], /NODE_OPTIONS|max-old-space-size/)
})

test('frontend range fill flag is a default-off build argument only', () => {
  const raw = readRepoFile('Dockerfile.frontend')
  const runtime = raw.split(/^FROM nginx:[^\n]+$/m)[1]
  assert.ok(runtime)
  const arg = raw.indexOf('ARG VITE_MULTITABLE_RANGE_FILL_ENABLED=false')
  const env = raw.match(/^ENV VITE_MULTITABLE_RANGE_FILL_ENABLED=\$\{?VITE_MULTITABLE_RANGE_FILL_ENABLED}?$/m)
  const build = raw.indexOf('pnpm --filter @metasheet/web build')
  assert.ok(arg >= 0 && env && env.index > arg && build > env.index)
  assert.doesNotMatch(runtime, /VITE_MULTITABLE_RANGE_FILL_ENABLED/)
})

test('frontend heap fix retains typecheck before bundling', () => {
  const pkg = JSON.parse(readRepoFile('apps', 'web', 'package.json'))
  // Since 2026-10-07 the script itself pins a 4 GB heap for both tools: GitHub-hosted runners of a
  // private repository are 2 vCPU / 8 GB, where Node's default heap (~2 GB) is too small for
  // `vue-tsc -b` on apps/web. The contract is unchanged — type-check runs first, the bundler
  // second, nothing is skipped — and stays byte-pinned so neither half can be dropped quietly.
  assert.equal(
    pkg.scripts.build,
    'node --max-old-space-size=4096 node_modules/vue-tsc/bin/vue-tsc.js -b && node --max-old-space-size=4096 node_modules/vite/bin/vite.js build',
  )
  const raw = readRepoFile('Dockerfile.frontend')
  assert.match(raw, /^RUN pnpm install --frozen-lockfile$/m)
  assert.doesNotMatch(raw, /--noCheck|SKIP_TYPECHECK|\|\|\s*true/)
})

test('docker images carry commit trace metadata for backend and web', () => {
  const backendDockerfile = readRepoFile('Dockerfile.backend')
  const frontendDockerfile = readRepoFile('Dockerfile.frontend')

  for (const [label, raw] of [
    ['backend Dockerfile', backendDockerfile],
    ['frontend Dockerfile', frontendDockerfile],
  ]) {
    assertContains(raw, 'ARG VCS_REF=unknown', label)
    assertContains(raw, 'ARG BUILD_IMAGE_TAG=unknown', label)
    assertContains(raw, 'ARG BUILD_IMAGE_SOURCE=unknown', label)
    assertContains(raw, 'ARG BUILD_CREATED=unknown', label)
    assertContains(raw, 'org.opencontainers.image.revision', label)
    assertContains(raw, 'org.opencontainers.image.source', label)
    assertContains(raw, 'org.opencontainers.image.created', label)
  }

  assertContains(backendDockerfile, 'ENV METASHEET_BUILD_COMMIT=${VCS_REF}', 'backend Dockerfile')
  assertContains(backendDockerfile, 'ENV METASHEET_BUILD_IMAGE_TAG=${BUILD_IMAGE_TAG}', 'backend Dockerfile')
  assertContains(frontendDockerfile, 'apps/web/dist/build-info.json', 'frontend Dockerfile')
  assertContains(frontendDockerfile, 'METASHEET_BUILD_COMMIT', 'frontend Dockerfile')
})

test('docker-build workflow deploys exact commit images and verifies served backend/web commits', () => {
  const raw = readRepoFile('.github', 'workflows', 'docker-build.yml')

  assertContains(raw, 'deploy_production:', 'docker-build workflow explicit production authorization input')
  assertContains(raw, "github.event_name == 'workflow_dispatch' && inputs.deploy_production == true", 'docker-build workflow production deploy gate')
  assertContains(raw, '--build-arg VCS_REF="${GITHUB_SHA}"', 'docker-build workflow')
  assertContains(raw, '--build-arg BUILD_IMAGE_TAG="${GITHUB_SHA}"', 'docker-build workflow')
  assertContains(raw, '--build-arg BUILD_IMAGE_SOURCE="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"', 'docker-build workflow')
  assertContains(raw, 'DEPLOY_IMAGE_TAG: ${{ github.sha }}', 'docker-build workflow')
  assertContains(raw, 'DEPLOY_EXPECTED_COMMIT: ${{ github.sha }}', 'docker-build workflow')
  assertContains(raw, 'DEPLOY_IMAGE_TAG must be an exact 40-character commit SHA', 'remote deploy guard')
  assertContains(raw, '[deploy-trace] expected_commit=${DEPLOY_EXPECTED_COMMIT}', 'remote deploy trace log')
  assertContains(raw, 'backend_repo_digest="$(docker image inspect "${backend_image}"', 'remote deploy digest log')
  assertContains(raw, 'web_repo_digest="$(docker image inspect "${web_image}"', 'remote deploy digest log')
  assertContains(raw, '=== VERSION VERIFY START ===', 'remote deploy version stage')
  assertContains(raw, 'DEPLOY_BACKEND_HEALTH_URL', 'backend version probe URL')
  assertContains(raw, 'DEPLOY_WEB_BUILD_INFO_URL', 'web version probe URL')
  assertContains(raw, 'fetch_json_with_retry', 'version probe retry loop')
  assertContains(raw, 'response is not a JSON object', 'version probe JSON type guard')
  assert.ok(
    !raw.includes("or '<missing>'"),
    'remote deploy command array must not embed single-quoted Python strings inside shell single-quoted entries',
  )
  assertContains(raw, 'backend commit mismatch', 'backend version assertion')
  assertContains(raw, 'web commit mismatch', 'web version assertion')
  assertContains(raw, 'Deploy version: expected=${DEPLOY_EXPECTED_COMMIT} backend=ok web=ok', 'version verify success marker')
  assertContains(raw, '### Deploy Traceability', 'deploy summary')
  assertContains(raw, 'Version verify: **${version_stage}**', 'deploy summary')
  assertContains(raw, 'docs/operations/deploy-immutable-traceability-runbook.md', 'deploy summary runbook')
})

test('manual production deploy script rejects mutable tags and verifies served commits', () => {
  const raw = readRepoFile('scripts', 'ops', 'deploy-attendance-prod.sh')

  assertContains(raw, 'DEPLOY_IMAGE_TAG must be set to a full 40-character commit SHA', 'manual deploy script')
  assertContains(raw, 'DEPLOY_IMAGE_TAG must be a full 40-character commit SHA', 'manual deploy script')
  assertContains(raw, 'DEPLOY_EXPECTED_COMMIT must match DEPLOY_IMAGE_TAG', 'manual deploy script')
  assertContains(raw, 'Backend repo digest:', 'manual deploy script')
  assertContains(raw, 'Web repo digest:', 'manual deploy script')
  assertContains(raw, 'DEPLOY_BACKEND_HEALTH_URL', 'manual deploy script')
  assertContains(raw, 'DEPLOY_WEB_BUILD_INFO_URL', 'manual deploy script')
  assertContains(raw, 'fetch_json_with_retry', 'manual deploy script')
  assertContains(raw, 'response is not a JSON object', 'manual deploy script')
  assertContains(raw, 'backend commit mismatch', 'manual deploy script')
  assertContains(raw, 'web commit mismatch', 'manual deploy script')
})

test('backend health response exposes normalized build metadata', () => {
  const raw = readRepoFile('packages', 'core-backend', 'src', 'index.ts')
  const buildInfo = readRepoFile('packages', 'core-backend', 'src', 'config', 'build-info.ts')

  assertContains(raw, "import { getBuildInfo } from './config/build-info'", 'backend index')
  assertContains(raw, 'build: getBuildInfo()', 'backend health handler')
  assertContains(buildInfo, 'METASHEET_BUILD_COMMIT', 'build info helper')
  assertContains(buildInfo, 'METASHEET_BUILD_IMAGE_TAG', 'build info helper')
  assertContains(buildInfo, 'METASHEET_BUILD_IMAGE_DIGEST', 'build info helper')
  assertContains(buildInfo, "trimmed === 'unknown'", 'build info helper')
})

const DESTRUCTIVE_DOCKER = [
  [/\bvolume\s+(rm|prune)\b/, 'volume removal'],
  [/\b(image|container|builder|network)\s+prune\b/, 'prune'],
  [/\bnetwork\s+rm\b/, 'network removal'],
  [/\bcompose\b.*\srm(\s|$)/, 'compose rm'],
  [/\bdocker\s+(container\s+)?(stop|restart|kill|rm|start|pause|update)\b.*\bmetasheet-(postgres|redis)\b/, 'a direct action on postgres or redis'],
]
function destructiveDockerUses(line) {
  return DESTRUCTIVE_DOCKER.filter(([pattern]) => pattern.test(line)).map(([, label]) => label)
}
// `docker compose [-p X] [--project-directory X] [-f X] up|run <flags> <services>`; null for other lines.
// Quoted operator messages are not docker calls.
function composeUpRunCall(line) {
  const plain = line.replace(/\b(echo|wlog|werr|fail)\s+"[^"]*"/g, '$1 MESSAGE')
  const match = plain.match(/\bdocker compose\b(.*)$/)
  if (!match) return null
  const tokens = match[1].trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  let i = 0
  while (i < tokens.length && ['-p', '--project-directory', '-f'].includes(tokens[i])) i += 2
  const sub = tokens[i++]
  if (sub !== 'up' && sub !== 'run') return null
  const flags = []
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const flag = tokens[i++]
    flags.push(flag)
    if (flag === '--name' || flag === '-e') i += 1
  }
  const services = []
  if (sub === 'up') {
    while (i < tokens.length && /^[a-z][a-z0-9_-]*$/.test(tokens[i])) services.push(tokens[i++])
  } else if (i < tokens.length && /^[a-z][a-z0-9_-]*$/.test(tokens[i])) {
    services.push(tokens[i])
  }
  return { sub, flags, services, line }
}

test('production deploy window never removes, prunes or recreates the data containers', () => {
  const raw = readRepoFile('.github', 'workflows', 'docker-build.yml')
  const lines = raw.split('\n').map((line) => line.trim()).filter((line) => !line.startsWith('#') && !line.startsWith("'#"))
  const dockerLines = lines.filter((line) => /(^|[^A-Za-z0-9_-])docker\s+[a-z]/.test(line))
  // The filter must see the window's real docker calls, or the negatives below prove nothing.
  assert.ok(dockerLines.some((line) => line.includes('docker stop -t 60 metasheet-web')))
  assert.ok(dockerLines.some((line) => line.includes('docker stop -t 60 metasheet-backend')))
  assert.ok(dockerLines.some((line) => /docker compose .* run --rm --no-deps -T .*--latest/.test(line)))
  assert.ok(dockerLines.some((line) => /docker compose .* up --no-start --no-deps --force-recreate backend/.test(line)))
  // Inner `sh -c '...'` programs (psql flags and the like) are not docker's own arguments.
  const ownArgs = dockerLines.map((line) => line.replace(/sh -c '[^']*'/g, 'sh -c PROGRAM'))
  for (const [pattern, label] of [
    [/\brm\s+-f\b/, 'rm -f'],
    [/\bdocker\s+(container\s+)?rm\b/, 'docker rm'],
    [/system\s+prune/, 'system prune'],
    [/\bcompose\b.*\bdown\b/, 'compose down'],
    [/\s-v(\s|$)|--volumes\b/, 'volume removal flag'],
    [/\bup\b.*\b(postgres|redis)\b/, 'up of postgres or redis'],
  ]) {
    assert.deepEqual(ownArgs.filter((line) => pattern.test(line)), [], `no docker line may use ${label}`)
  }
  // Further destructive forms, and every compose up/run names its services and passes --no-deps.
  // Static only: a line in an error branch that no scenario reaches is visible to nothing else.
  for (const line of ownArgs) {
    assert.deepEqual(destructiveDockerUses(line), [], `docker line: ${line}`)
  }
  const composeUpRun = dockerLines.map(composeUpRunCall).filter(Boolean)
  assert.ok(composeUpRun.length >= 5, 'the rule sees the window\'s compose run and up lines')
  for (const call of composeUpRun) {
    assert.ok(call.flags.includes('--no-deps'), `compose ${call.sub} without --no-deps: ${call.line}`)
    assert.ok(call.services.length > 0, `compose ${call.sub} without an explicit service list: ${call.line}`)
    for (const service of call.services) assert.ok(['backend', 'web'].includes(service), `compose ${call.sub} of ${service}: ${call.line}`)
  }
  // Positive controls: each of these lines must be flagged by the checks above.
  const P = 'docker compose -p "$P" --project-directory "$PROJECT_DIR" -f "$F"'
  for (const probe of [
    `timeout 60 ${P} rm -sfv postgres`,
    'timeout 60 docker image prune -af',
    'timeout 60 docker container prune -f',
    'timeout 60 docker builder prune -af',
    'timeout 60 docker network prune -f',
    'timeout 60 docker network rm metasheet2_default',
    'timeout 60 docker volume rm "${P}_metasheet-postgres-data"',
    'timeout 60 docker volume prune -f',
    'timeout 60 docker restart metasheet-postgres',
    'timeout 90 docker stop -t 60 metasheet-postgres',
    'timeout 60 docker kill metasheet-redis',
    `IMAGE_OWNER=o IMAGE_TAG=t timeout 300 ${P} up -d`,
    `IMAGE_OWNER=o IMAGE_TAG=t timeout 300 ${P} up -d --force-recreate backend web`,
    `IMAGE_OWNER=o IMAGE_TAG=t timeout 120 ${P} run --rm -T backend node migrate.js --list`,
  ]) {
    const call = composeUpRunCall(probe)
    const composeBad = call && (!call.flags.includes('--no-deps') || call.services.length === 0)
    assert.ok(destructiveDockerUses(probe).length > 0 || composeBad, `the checks flag: ${probe}`)
  }

  const excludeFlag = '-e "MIGRATION_EXCLUDE='
  assert.equal(raw.split(excludeFlag).length - 1, 1, 'MIGRATION_EXCLUDE is passed exactly once')
  const excludeLine = raw.split('\n').find((line) => line.includes(excludeFlag))
  assert.match(excludeLine, /migrate\.js --latest/)
  assert.match(excludeLine, /-e "MIGRATION_EXCLUDE=\$\{PROD_EXCLUDE_CSV\}"/)

  // The production exclusion list is the staging owner-ruled list (A-3 only), with its tables.
  const lib = readRepoFile('scripts', 'ops', 'attendance-window-runner-pipeline.lib.sh')
  const arrayOf = (text, name) => {
    const match = text.match(new RegExp(`^\\s*${name}=\\(\\n([\\s\\S]*?)\\n\\s*\\)`, 'm'))
    assert.ok(match, `${name} array present`)
    return match[1].split('\n').map((entry) => entry.trim()).filter(Boolean)
  }
  const stagingNames = arrayOf(lib, 'STAGING_OWNER_EXCLUDED_MIGRATIONS')
  assert.deepEqual(stagingNames, ['zzzz20260919090000_create_approval_template_group_backfill_batches'])
  assert.deepEqual(arrayOf(raw, 'PROD_OWNER_EXCLUDED_MIGRATIONS'), stagingNames)
  assert.deepEqual(arrayOf(raw, 'PROD_OWNER_EXCLUDED_TABLES'), arrayOf(lib, 'STAGING_OWNER_EXCLUDED_TABLES'))
  assert.equal(raw.split('PROD_OWNER_EXCLUDED_MIGRATIONS=(').length - 1, 1)
  assert.equal(raw.split('PROD_OWNER_EXCLUDED_TABLES=(').length - 1, 1)
})
