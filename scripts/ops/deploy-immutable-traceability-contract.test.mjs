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
