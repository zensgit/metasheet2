import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const deployScript = process.env.DEPLOY_SCRIPT_UNDER_TEST
  || path.join(repoRoot, 'scripts/ops/deploy-dingtalk-staging.sh')
const buildScript = process.env.BUILD_SCRIPT_UNDER_TEST
  || path.join(repoRoot, 'scripts/ops/build-dingtalk-staging-images.sh')
const goodSha = '0123456789abcdef0123456789abcdef01234567'
const otherSha = '89abcdef0123456789abcdef0123456789abcdef'
const goodBackendImageId = `sha256:${'1'.repeat(64)}`
const otherBackendImageId = `sha256:${'2'.repeat(64)}`
const goodWebImageId = `sha256:${'3'.repeat(64)}`

async function executable(file, contents) {
  await writeFile(file, contents)
  await chmod(file, 0o755)
}

async function makeHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dingtalk-staging-identity-'))
  const bin = path.join(root, 'bin')
  const envFile = path.join(root, 'app.env')
  const composeFile = path.join(root, 'compose.yml')
  const validator = path.join(root, 'validate-env')
  const commandLog = path.join(root, 'commands.log')
  const provenanceFile = path.join(root, 'image-provenance.json')
  const archiveRoot = path.join(root, 'archive-root')
  const archiveFile = path.join(root, 'source.tar')
  await mkdir(bin)
  await mkdir(archiveRoot)
  await writeFile(envFile, `IMAGE_OWNER=zensgit\nIMAGE_TAG=${goodSha}\n`)
  await writeFile(composeFile, 'services: {}\n')
  await writeFile(commandLog, '')
  await writeFile(path.join(archiveRoot, 'Dockerfile.backend'), 'FROM scratch\n')
  await writeFile(path.join(archiveRoot, 'Dockerfile.frontend'), 'FROM scratch\n')
  const archiveResult = spawnSync('tar', [
    '-cf',
    archiveFile,
    '-C',
    archiveRoot,
    'Dockerfile.backend',
    'Dockerfile.frontend',
  ], { encoding: 'utf8' })
  assert.equal(archiveResult.status, 0, archiveResult.stderr)
  await writeFile(provenanceFile, `${JSON.stringify({
    schema: 'metasheet-dingtalk-staging-image-provenance/v1',
    commit: goodSha,
    backendImage: `ghcr.io/zensgit/metasheet2-backend:${goodSha}`,
    backendImageId: goodBackendImageId,
    webImage: `ghcr.io/zensgit/metasheet2-web:${goodSha}`,
    webImageId: goodWebImageId,
  })}\n`)
  await chmod(provenanceFile, 0o600)
  await executable(validator, '#!/usr/bin/env bash\nexit 0\n')

  await executable(path.join(bin, 'docker'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${FAKE_COMMAND_LOG}"

if [[ "\${1:-}" == "compose" && "\${2:-}" == "version" ]]; then
  echo "Docker Compose version v2"
  exit 0
fi
if [[ "\${1:-}" == "compose" ]]; then
  if [[ " $* " == *" ps -q --all backend "* ]]; then
    printf '%s\\n' "\${FAKE_BACKEND_IDS:-backend-one}"
  elif [[ " $* " == *" ps "* ]]; then
    echo "backend running"
  fi
  exit 0
fi
if [[ "\${1:-}" == "inspect" ]]; then
  target="\${!#}"
  if [[ " $* " == *".State.Running"* ]]; then
    printf '%s\\n' "\${FAKE_BACKEND_RUNNING:-true}"
  elif [[ " $* " == *".Config.Image"* ]]; then
    printf '%s\\n' "\${FAKE_BACKEND_IMAGE:-ghcr.io/zensgit/metasheet2-backend:${goodSha}}"
  elif [[ " $* " == *"{{.Image}}"* ]]; then
    printf '%s\\n' "\${FAKE_BACKEND_IMAGE_ID:-${goodBackendImageId}}"
  elif [[ " $* " == *"org.opencontainers.image.revision"* ]]; then
    printf '%s\\n' "\${FAKE_BACKEND_REVISION:-${goodSha}}"
  elif [[ " $* " == *"com.docker.compose.project"* ]]; then
    printf '%s\\n' "\${FAKE_COMPOSE_PROJECT:-metasheet2-dingtalk-staging}"
  elif [[ " $* " == *"com.docker.compose.service"* ]]; then
    case "\${target}" in
      backend-one) echo backend ;;
      postgres-one) echo postgres ;;
      redis-one) echo redis ;;
      web-one) echo web ;;
      orphan-one) echo legacy-backend ;;
      legacy-one) echo backend ;;
      *) echo unknown ;;
    esac
  fi
  exit 0
fi
if [[ "\${1:-}" == "ps" ]]; then
  if [[ " $* " == *" --filter publish=18900 "* ]]; then
    ingress_ids="\${FAKE_INGRESS_CONTAINER_IDS:-backend-one}"
    if [[ "\${FAKE_TRUNCATE_INGRESS_IDS_WITHOUT_NO_TRUNC:-0}" == "1" && " $* " != *" --no-trunc "* ]]; then
      while IFS= read -r ingress_id; do
        printf '%.12s\\n' "\${ingress_id}"
      done <<< "\${ingress_ids}"
    else
      printf '%s\\n' "\${ingress_ids}"
    fi
  elif [[ " $* " == *" --filter label=com.docker.compose.project=\${FAKE_COMPOSE_PROJECT:-metasheet2-dingtalk-staging} "* ]]; then
    printf '%s\\n' "\${FAKE_PROJECT_CONTAINER_IDS:-backend-one
postgres-one
redis-one
web-one}"
  else
    printf '%s\\n' "\${FAKE_WRONG_PROJECT_CONTAINER_IDS:-}"
  fi
  exit 0
fi
if [[ "\${1:-}" == "build" ]]; then
  exit 0
fi
if [[ "\${1:-}" == "image" && "\${2:-}" == "inspect" ]]; then
  if [[ " $* " == *"org.opencontainers.image.revision"* ]]; then
    printf '%s\\n' "\${FAKE_IMAGE_REVISION:-${goodSha}}"
  elif [[ " $* " == *"{{.Id}}"* ]]; then
    if [[ " $* " == *"metasheet2-backend"* ]]; then
      printf '%s\\n' "\${FAKE_BUILT_BACKEND_IMAGE_ID:-${goodBackendImageId}}"
    else
      printf '%s\\n' "\${FAKE_BUILT_WEB_IMAGE_ID:-${goodWebImageId}}"
    fi
  fi
  exit 0
fi
echo "unexpected docker invocation" >&2
exit 97
`)

  await executable(path.join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${FAKE_HEALTH_JSON+x}" ]]; then
  printf '%s\\n' "\${FAKE_HEALTH_JSON}"
else
  printf '%s\\n' '{"ok":true,"build":{"commit":"${goodSha}"}}'
fi
`)

  await executable(path.join(bin, 'stat'), `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${FAKE_PROVENANCE_UID:-}" && " $* " == *"%u"* ]]; then
  printf '%s\\n' "\${FAKE_PROVENANCE_UID}"
  exit 0
fi
exec /usr/bin/stat "$@"
`)

  await executable(path.join(bin, 'git'), `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" rev-parse HEAD "* ]]; then
  printf '%s\\n' "\${FAKE_SOURCE_SHA:-${goodSha}}"
  exit 0
fi
if [[ " $* " == *" status --porcelain --untracked-files=all "* ]]; then
  [[ "\${FAKE_STATUS_FAIL:-0}" != "1" ]] || exit 99
  printf '%s' "\${FAKE_SOURCE_DIRTY:-}"
  exit 0
fi
if [[ " $* " == *" archive --format=tar "* ]]; then
  cat "\${FAKE_ARCHIVE_FILE}"
  exit 0
fi
exit 98
`)

  return {
    root,
    envFile,
    composeFile,
    validator,
    commandLog,
    provenanceFile,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_COMMAND_LOG: commandLog,
      FAKE_ARCHIVE_FILE: archiveFile,
    },
  }
}

function run(script, env) {
  return spawnSync('bash', [script], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
}

function deployEnv(harness, overrides = {}) {
  return {
    ...harness.env,
    COMPOSE_FILE: harness.composeFile,
    ENV_FILE: harness.envFile,
    ENV_VALIDATOR: harness.validator,
    DEPLOY_IMAGE_OWNER: 'zensgit',
    DEPLOY_IMAGE_TAG: goodSha,
    DEPLOY_EXPECTED_COMMIT: goodSha,
    DEPLOY_IMAGE_PROVENANCE_FILE: harness.provenanceFile,
    ...overrides,
  }
}

function buildEnv(harness, overrides = {}) {
  return {
    ...harness.env,
    SOURCE_DIR: repoRoot,
    IMAGE_OWNER: 'zensgit',
    IMAGE_TAG: goodSha,
    IMAGE_PROVENANCE_FILE: harness.provenanceFile,
    ...overrides,
  }
}

async function withHarness(t) {
  const harness = await makeHarness()
  t.after(() => rm(harness.root, { recursive: true, force: true }))
  return harness
}

test('test matrix retains the worker-drain CI wiring guard', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/plugin-tests.yml'), 'utf8')
  const marker = '\n  test:\n'
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, 'missing workflow job test')
  const bodyStart = start + marker.length
  const nextJob = workflow.slice(bodyStart).search(/\n  [a-z0-9_-]+:\n/)
  const testJob = nextJob === -1
    ? workflow.slice(bodyStart)
    : workflow.slice(bodyStart, bodyStart + nextJob)
  assert.match(
    testJob,
    /node --test scripts\/ops\/dingtalk-worker-drain-ci-wiring\.test\.mjs/,
  )
})

test('deploy accepts one attested healthy backend for project and ingress', async (t) => {
  const h = await withHarness(t)
  const result = run(deployScript, deployEnv(h))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /WORKER_DRAIN_GATE_PASS expected_project_workers=1 observed_project_workers=1 managed_project_old_workers=0 staging_ingress_workers=1 staging_ingress_unmanaged_workers=0/)
  const log = await readFile(h.commandLog, 'utf8')
  assert.match(log, /compose --project-name metasheet2-dingtalk-staging /)
  assert.match(log, /compose .* pull backend/)
  assert.match(log, /compose .* up -d --remove-orphans backend/)
  assert.doesNotMatch(log, /backend web/)
  assert.match(log, /compose .* ps -q --all backend/)
  assert.match(log, /ps --no-trunc -q --filter publish=18900/)
  assert.match(log, /ps -q --filter label=com\.docker\.compose\.project=metasheet2-dingtalk-staging/)
  assert.match(log, /inspect -f \{\{\.Image\}\} backend-one/)
})

test('deploy full scope explicitly updates backend and web', async (t) => {
  const h = await withHarness(t)
  const result = run(deployScript, deployEnv(h, { STAGING_DEPLOY_SCOPE: 'full' }))
  assert.equal(result.status, 0, result.stderr)
  const log = await readFile(h.commandLog, 'utf8')
  assert.match(log, /compose .* pull backend web/)
  assert.match(log, /compose .* up -d --remove-orphans backend web/)
})

test('deploy uses the backend Compose project as the exact service selector', async (t) => {
  const h = await withHarness(t)
  const result = run(deployScript, deployEnv(h, {
    FAKE_WRONG_PROJECT_CONTAINER_IDS: 'orphan-one',
  }))
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /WORKER_DRAIN_GATE_PASS/)
})

test('deploy compares the full ingress container identity', async (t) => {
  const h = await withHarness(t)
  const fullContainerId = 'a'.repeat(64)
  const result = run(deployScript, deployEnv(h, {
    FAKE_BACKEND_IDS: fullContainerId,
    FAKE_INGRESS_CONTAINER_IDS: fullContainerId,
    FAKE_TRUNCATE_INGRESS_IDS_WITHOUT_NO_TRUNC: '1',
  }))
  assert.equal(result.status, 0, result.stderr)
  const log = await readFile(h.commandLog, 'utf8')
  assert.match(log, /ps --no-trunc -q --filter publish=18900/)
})

const deployCases = [
  {
    name: 'mutable image tag',
    overrides: { DEPLOY_IMAGE_TAG: 'latest', DEPLOY_EXPECTED_COMMIT: 'latest' },
    error: /full 40-character lowercase commit SHA/,
    beforeMutation: true,
  },
  {
    name: 'production Compose project',
    overrides: { COMPOSE_PROJECT_NAME: 'metasheet2' },
    error: /COMPOSE_PROJECT_NAME must be metasheet2-dingtalk-staging/,
    beforeMutation: true,
  },
  {
    name: 'invalid deploy scope',
    overrides: { STAGING_DEPLOY_SCOPE: 'frontend' },
    error: /STAGING_DEPLOY_SCOPE must be backend or full/,
    beforeMutation: true,
  },
  {
    name: 'multiple managed backend workers',
    overrides: { FAKE_BACKEND_IDS: 'backend-old\nbackend-new' },
    error: /exactly one backend worker/,
  },
  {
    name: 'missing managed backend worker',
    overrides: { FAKE_BACKEND_IDS: '   ' },
    error: /exactly one backend worker/,
  },
  {
    name: 'multiple containers on staging backend ingress',
    overrides: { FAKE_INGRESS_CONTAINER_IDS: 'backend-one\nlegacy-one' },
    error: /staging backend ingress must resolve to exactly one running container/,
  },
  {
    name: 'staging ingress points at an unmanaged worker',
    overrides: { FAKE_INGRESS_CONTAINER_IDS: 'legacy-one' },
    error: /staging backend ingress does not resolve to the managed backend worker/,
  },
  {
    name: 'orphan service in managed Compose project',
    overrides: { FAKE_PROJECT_CONTAINER_IDS: 'backend-one\npostgres-one\nredis-one\nweb-one\norphan-one' },
    error: /missing, duplicate, or orphan service/,
  },
  {
    name: 'missing service in managed Compose project',
    overrides: { FAKE_PROJECT_CONTAINER_IDS: 'backend-one\npostgres-one\nredis-one' },
    error: /missing, duplicate, or orphan service/,
  },
  {
    name: 'duplicate service in managed Compose project',
    overrides: { FAKE_PROJECT_CONTAINER_IDS: 'backend-one\npostgres-one\nredis-one\nweb-one\nweb-one' },
    error: /missing, duplicate, or orphan service/,
  },
  {
    name: 'non-running managed backend worker',
    overrides: { FAKE_BACKEND_RUNNING: 'false' },
    error: /worker is not running/,
  },
  {
    name: 'stale configured image',
    overrides: { FAKE_BACKEND_IMAGE: `ghcr.io/zensgit/metasheet2-backend:${otherSha}` },
    error: /image does not match the pinned deploy image/,
    hidden: otherSha,
  },
  {
    name: 'stale served build',
    overrides: { FAKE_HEALTH_JSON: JSON.stringify({ ok: true, build: { commit: otherSha } }) },
    error: /health build identity does not match/,
    hidden: otherSha,
  },
  {
    name: 'stale immutable revision label',
    overrides: { FAKE_BACKEND_REVISION: otherSha },
    error: /worker revision does not match/,
    hidden: otherSha,
  },
  {
    name: 'image ID different from build provenance',
    overrides: { FAKE_BACKEND_IMAGE_ID: otherBackendImageId },
    error: /image ID does not match build provenance/,
    hidden: otherBackendImageId,
  },
  {
    name: 'missing served build identity',
    overrides: { FAKE_HEALTH_JSON: JSON.stringify({ ok: true, build: { commit: null } }) },
    error: /health build identity does not match/,
  },
  {
    name: 'unhealthy response with matching build',
    overrides: { FAKE_HEALTH_JSON: JSON.stringify({ ok: false, build: { commit: goodSha } }) },
    error: /health build identity does not match/,
  },
  {
    name: 'mismatched expected commit',
    overrides: { DEPLOY_EXPECTED_COMMIT: otherSha },
    error: /DEPLOY_EXPECTED_COMMIT must match/,
    beforeMutation: true,
  },
  {
    name: 'newline log injection in image owner',
    overrides: { DEPLOY_IMAGE_OWNER: 'invalid\nWORKER_DRAIN_GATE_PASS forged=1' },
    error: /DEPLOY_IMAGE_OWNER has an invalid format/,
    beforeMutation: true,
    hidden: 'forged=1',
  },
  {
    name: 'invalid pull posture',
    overrides: { SKIP_PULL: 'true' },
    error: /SKIP_PULL must be 0 or 1/,
    beforeMutation: true,
  },
  {
    name: 'health target outside managed loopback',
    overrides: { BACKEND_HEALTH_URL: 'file:///tmp/forged.json' },
    error: /managed loopback health endpoint/,
    beforeMutation: true,
    hidden: 'forged',
  },
]

for (const scenario of deployCases) {
  test(`deploy rejects ${scenario.name}`, async (t) => {
    const h = await withHarness(t)
    const result = run(deployScript, deployEnv(h, scenario.overrides))
    assert.equal(result.status, 1)
    assert.match(result.stderr, scenario.error)
    assert.doesNotMatch(result.stderr, /WORKER_DRAIN_GATE_PASS/)
    if (scenario.hidden) assert.doesNotMatch(result.stderr, new RegExp(scenario.hidden))
    if (scenario.beforeMutation) {
      const log = await readFile(h.commandLog, 'utf8')
      assert.equal(log.trim(), 'compose version')
    }
  })
}

test('deploy rejects stale image provenance before Compose mutation', async (t) => {
  const h = await withHarness(t)
  await writeFile(h.provenanceFile, `${JSON.stringify({
    schema: 'metasheet-dingtalk-staging-image-provenance/v1',
    commit: otherSha,
    backendImage: `ghcr.io/zensgit/metasheet2-backend:${goodSha}`,
    backendImageId: goodBackendImageId,
  })}\n`)
  const result = run(deployScript, deployEnv(h))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /image provenance does not match/)
  assert.doesNotMatch(result.stderr, new RegExp(otherSha))
  const log = await readFile(h.commandLog, 'utf8')
  assert.equal(log.trim(), 'compose version')
})

test('deploy rejects group-readable provenance before Compose mutation', async (t) => {
  const h = await withHarness(t)
  await chmod(h.provenanceFile, 0o640)
  const result = run(deployScript, deployEnv(h))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /permissions must be 0400 or 0600/)
  const log = await readFile(h.commandLog, 'utf8')
  assert.equal(log.trim(), 'compose version')
})

test('deploy rejects provenance owned by another user before Compose mutation', async (t) => {
  const h = await withHarness(t)
  const result = run(deployScript, deployEnv(h, { FAKE_PROVENANCE_UID: '4294967294' }))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /must be owned by the deploy user/)
  const log = await readFile(h.commandLog, 'utf8')
  assert.equal(log.trim(), 'compose version')
})

for (const [label, key] of [
  ['env', 'ENV_FILE'],
  ['compose', 'COMPOSE_FILE'],
  ['provenance', 'DEPLOY_IMAGE_PROVENANCE_FILE'],
]) {
  test(`deploy rejects control characters in the ${label} path before Compose mutation`, async (t) => {
    const h = await withHarness(t)
    const injected = path.join(h.root, `${label}\nWORKER_DRAIN_GATE_PASS forged=1`)
    const contents = label === 'env'
      ? `IMAGE_OWNER=zensgit\nIMAGE_TAG=${goodSha}\n`
      : label === 'compose'
        ? 'services: {}\n'
        : await readFile(h.provenanceFile, 'utf8')
    await writeFile(injected, contents)
    if (label === 'provenance') await chmod(injected, 0o600)
    const result = run(deployScript, deployEnv(h, { [key]: injected }))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /deploy path contains control characters/)
    assert.doesNotMatch(result.stderr, /forged=1/)
    const log = await readFile(h.commandLog, 'utf8')
    assert.equal(log.trim(), 'compose version')
  })
}

test('deploy rejects mismatched image reference in provenance before Compose mutation', async (t) => {
  const h = await withHarness(t)
  await writeFile(h.provenanceFile, `${JSON.stringify({
    schema: 'metasheet-dingtalk-staging-image-provenance/v1',
    commit: goodSha,
    backendImage: `ghcr.io/zensgit/metasheet2-backend:${otherSha}`,
    backendImageId: goodBackendImageId,
  })}\n`)
  const result = run(deployScript, deployEnv(h))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /image provenance does not match/)
  assert.doesNotMatch(result.stderr, new RegExp(otherSha))
  const log = await readFile(h.commandLog, 'utf8')
  assert.equal(log.trim(), 'compose version')
})

test('local backend build uses archived exact source, all provenance args, and writes image ID', async (t) => {
  const h = await withHarness(t)
  const result = run(buildScript, buildEnv(h))
  assert.equal(result.status, 0, result.stderr)
  const log = await readFile(h.commandLog, 'utf8')
  const builds = log.split('\n').filter((line) => line.startsWith('build '))
  assert.equal(builds.length, 1)
  for (const invocation of builds) {
    assert.match(invocation, new RegExp(`--build-arg VCS_REF=${goodSha}`))
    assert.match(invocation, new RegExp(`--build-arg BUILD_IMAGE_TAG=${goodSha}`))
    assert.match(invocation, /--build-arg BUILD_IMAGE_SOURCE=https:\/\/github\.com\/zensgit\/metasheet2/)
    assert.match(invocation, /--build-arg BUILD_CREATED=\d{4}-\d{2}-\d{2}T/)
    assert.doesNotMatch(invocation, new RegExp(`${repoRoot}$`))
  }
  const provenance = JSON.parse(await readFile(h.provenanceFile, 'utf8'))
  assert.equal(provenance.commit, goodSha)
  assert.equal(provenance.backendImageId, goodBackendImageId)
  assert.equal(Object.hasOwn(provenance, 'webImageId'), false)
  assert.equal((await stat(h.provenanceFile)).mode & 0o777, 0o600)
})

test('local full build includes the web image in provenance', async (t) => {
  const h = await withHarness(t)
  const result = run(buildScript, buildEnv(h, { STAGING_DEPLOY_SCOPE: 'full' }))
  assert.equal(result.status, 0, result.stderr)
  const log = await readFile(h.commandLog, 'utf8')
  const builds = log.split('\n').filter((line) => line.startsWith('build '))
  assert.equal(builds.length, 2)
  const provenance = JSON.parse(await readFile(h.provenanceFile, 'utf8'))
  assert.equal(provenance.backendImageId, goodBackendImageId)
  assert.equal(provenance.webImageId, goodWebImageId)
})

const buildCases = [
  {
    name: 'image tag is mutable',
    overrides: { IMAGE_TAG: 'latest', FAKE_SOURCE_SHA: 'latest' },
    error: /full 40-character lowercase commit SHA/,
  },
  {
    name: 'checkout SHA differs from tag',
    overrides: { FAKE_SOURCE_SHA: otherSha },
    error: /source checkout does not match IMAGE_TAG/,
  },
  {
    name: 'built image revision differs',
    overrides: { FAKE_IMAGE_REVISION: otherSha },
    error: /built image revision does not match IMAGE_TAG/,
    hidden: otherSha,
    afterBuild: true,
  },
  {
    name: 'uncommitted source exists',
    overrides: { FAKE_SOURCE_DIRTY: ' M packages/core-backend/src/index.ts' },
    error: /source checkout must be clean/,
    hidden: 'packages/core-backend',
  },
  {
    name: 'source cleanliness cannot be verified',
    overrides: { FAKE_STATUS_FAIL: '1' },
    error: /could not verify source checkout cleanliness/,
  },
  {
    name: 'build source is not canonical',
    overrides: { BUILD_SOURCE: 'https://example.invalid/forged' },
    error: /BUILD_SOURCE must be the canonical repository URL/,
  },
  {
    name: 'source path contains control characters',
    overrides: { SOURCE_DIR: `${repoRoot}\nWORKER_DRAIN_GATE_PASS forged=1` },
    error: /build path contains control characters/,
    hidden: 'forged=1',
  },
  {
    name: 'provenance path contains control characters',
    overrides: { IMAGE_PROVENANCE_FILE: '/tmp/provenance\nWORKER_DRAIN_GATE_PASS forged=1' },
    error: /build path contains control characters/,
    hidden: 'forged=1',
  },
]

for (const scenario of buildCases) {
  test(`local build rejects when ${scenario.name}`, async (t) => {
    const h = await withHarness(t)
    const result = run(buildScript, buildEnv(h, scenario.overrides))
    assert.equal(result.status, 1)
    assert.match(result.stderr, scenario.error)
    if (scenario.hidden) assert.doesNotMatch(result.stderr, new RegExp(scenario.hidden))
    const log = await readFile(h.commandLog, 'utf8')
    if (scenario.afterBuild) {
      assert.match(log, /^build /m)
      assert.match(log, /org\.opencontainers\.image\.revision/)
    } else {
      assert.equal(log.trim(), '')
    }
  })
}
