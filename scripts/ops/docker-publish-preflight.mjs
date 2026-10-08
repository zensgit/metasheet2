import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const packages = ['metasheet2-backend', 'metasheet2-web']
class PublishDenied extends Error {}

function requireCondition(condition, code) {
  if (!condition) throw new PublishDenied(code)
}

function booleanInput(value) {
  if (value === undefined || value === '' || value === 'false') return false
  requireCondition(value === 'true', 'PUBLISH_INVALID_BOOLEAN')
  return true
}

export function authorizePublication(event, context) {
  if (context.eventName !== 'workflow_dispatch') return { publish: false }
  const inputs = event.inputs ?? {}
  const publish = booleanInput(inputs.publish_images)
  const deploy = booleanInput(inputs.deploy_production)
  requireCondition(!deploy || publish, 'PUBLISH_REQUIRED_FOR_DEPLOY')
  if (!publish) return { publish: false }
  requireCondition(context.repository === 'zensgit/metasheet2', 'PUBLISH_REPOSITORY_MISMATCH')
  requireCondition(context.ref === 'refs/heads/main', 'PUBLISH_MAIN_REQUIRED')
  requireCondition(typeof inputs.publish_sha === 'string' && /^[0-9a-f]{40}$/.test(inputs.publish_sha)
    && inputs.publish_sha === context.sha, 'PUBLISH_SHA_MISMATCH')
  requireCondition(['public', 'private'].includes(inputs.expected_visibility), 'PUBLISH_VISIBILITY_REQUIRED')
  return { publish: true, visibility: inputs.expected_visibility }
}

function readPackage(name) {
  try {
    return JSON.parse(execFileSync('gh', [
      'api', '--hostname', 'github.com', '--method', 'GET',
      `/users/zensgit/packages/container/${name}`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 1024 * 1024 }))
  } catch {
    throw new PublishDenied('PUBLISH_PACKAGE_READ_FAILED')
  }
}

export function verifyPackageVisibility(visibility, read = readPackage) {
  requireCondition(['public', 'private'].includes(visibility), 'PUBLISH_VISIBILITY_REQUIRED')
  for (const name of packages) {
    let metadata
    try {
      metadata = read(name)
    } catch {
      throw new PublishDenied('PUBLISH_PACKAGE_READ_FAILED')
    }
    requireCondition(metadata?.name === name && metadata?.package_type === 'container'
      && metadata?.owner?.login === 'zensgit', 'PUBLISH_PACKAGE_IDENTITY_MISMATCH')
    requireCondition(metadata.visibility === visibility, 'PUBLISH_VISIBILITY_MISMATCH')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2]
    requireCondition(['authorize', 'visibility'].includes(mode), 'PUBLISH_INVALID_MODE')
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    const authorization = authorizePublication(event, {
      eventName: process.env.GITHUB_EVENT_NAME,
      repository: process.env.GITHUB_REPOSITORY,
      ref: process.env.GITHUB_REF,
      sha: process.env.GITHUB_SHA,
    })
    if (mode === 'authorize') {
      appendFileSync(process.env.GITHUB_OUTPUT, `publish_requested=${authorization.publish}\n`)
    } else {
      requireCondition(authorization.publish, 'PUBLISH_NOT_AUTHORIZED')
      verifyPackageVisibility(authorization.visibility)
      appendFileSync(process.env.GITHUB_OUTPUT, 'verified=true\n')
    }
    console.log('PUBLISH_PREFLIGHT_OK')
  } catch (error) {
    console.error(error instanceof PublishDenied ? error.message : 'PUBLISH_PREFLIGHT_FAILED')
    process.exitCode = 1
  }
}
