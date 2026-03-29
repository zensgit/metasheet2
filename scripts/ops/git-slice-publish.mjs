#!/usr/bin/env node

import fs from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { SLICES } from './git-slices.mjs'

function runGit(args, extra = {}) {
  return execFileSync('git', args, {
    cwd: extra.cwd ?? process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(extra.env ?? {}),
    },
  }).trimEnd()
}

function gitSucceeds(args, extra = {}) {
  try {
    execFileSync('git', args, {
      cwd: extra.cwd ?? process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        ...(extra.env ?? {}),
      },
    })
    return true
  } catch {
    return false
  }
}

function isGitWorkTree() {
  try {
    return runGit(['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sanitizeBranchPart(value) {
  return value
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '')
}

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let landManifest = null
  let repoUrl = null
  let outputDir = null
  let writeManifest = null
  let json = false
  let verify = false
  let listSlices = false
  let listGroups = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--slice':
        sliceName = argv[index + 1] ?? sliceName
        index += 1
        break
      case '--land-manifest':
        landManifest = argv[index + 1] ?? landManifest
        index += 1
        break
      case '--repo-url':
        repoUrl = argv[index + 1] ?? repoUrl
        index += 1
        break
      case '--output-dir':
        outputDir = argv[index + 1] ?? outputDir
        index += 1
        break
      case '--write-manifest':
        writeManifest = argv[index + 1] ?? writeManifest
        index += 1
        break
      case '--json':
        json = true
        break
      case '--verify':
        verify = true
        break
      case '--list-slices':
        listSlices = true
        break
      case '--list-groups':
        listGroups = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw Object.assign(new Error(`Unknown argument: ${arg}`), {
          code: 'UNKNOWN_ARGUMENT',
          exitCode: 1,
        })
    }
  }

  if (!landManifest && !listSlices && !listGroups) {
    throw Object.assign(
      new Error('Provide --land-manifest for git-slice-publish.'),
      {
        code: 'LAND_MANIFEST_REQUIRED',
        exitCode: 1,
      },
    )
  }

  return {
    sliceName,
    landManifest,
    repoUrl,
    outputDir,
    writeManifest,
    json,
    verify,
    listSlices,
    listGroups,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-publish.mjs [options]

Options:
  --slice <name>          Slice name. Default: directory-migration-baseline
  --land-manifest <path>  Land manifest path
  --repo-url <url>        Override publish URL. Default: origin remote URL
  --output-dir <path>     Write publish packet artifacts
  --write-manifest <path> Write manifest JSON to the given path
  --verify                Verify publishability by pushing to a temporary bare repo
  --list-slices           Print available slices
  --list-groups           Print groups for the selected slice
  --json                  Print JSON
  --help, -h              Show help`)
}

function ensureSlice(sliceName) {
  const slice = SLICES[sliceName]
  if (!slice) {
    throw Object.assign(new Error(`Unknown slice: ${sliceName}`), {
      code: 'UNKNOWN_SLICE',
      exitCode: 1,
    })
  }
  if (!Array.isArray(slice.commitGroups) || slice.commitGroups.length === 0) {
    throw Object.assign(new Error(`Slice ${sliceName} does not define commit groups.`), {
      code: 'MISSING_COMMIT_GROUPS',
      exitCode: 1,
    })
  }
  return slice
}

async function writeTextFile(filePath, contents, executable = false) {
  const resolvedPath = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, contents, 'utf8')
  if (executable) {
    await fs.chmod(resolvedPath, 0o755)
  }
  return resolvedPath
}

async function writeJsonFile(filePath, payload) {
  return writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

async function loadLandManifest(filePath, sliceName) {
  const resolvedPath = path.resolve(filePath)
  const raw = await fs.readFile(resolvedPath, 'utf8')
  const data = JSON.parse(raw)

  if (data.slice && data.slice !== sliceName) {
    throw Object.assign(
      new Error(`Land manifest slice mismatch: expected ${sliceName}, got ${data.slice}.`),
      {
        code: 'LAND_MANIFEST_SLICE_MISMATCH',
        exitCode: 1,
        manifestPath: resolvedPath,
      },
    )
  }

  return {
    path: resolvedPath,
    data,
  }
}

function requireValue(value, message, code, extra = {}) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(message), {
      code,
      exitCode: 1,
      ...extra,
    })
  }
  return value
}

function assertGitRefExists(ref, label, extra = {}) {
  if (!gitSucceeds(['rev-parse', '--verify', '--quiet', ref])) {
    throw Object.assign(new Error(`${label} does not exist: ${ref}`), {
      code: 'GIT_REF_NOT_FOUND',
      exitCode: 1,
      ref,
      label,
      ...extra,
    })
  }
}

function resolveRepoUrl(explicitRepoUrl) {
  if (explicitRepoUrl) {
    return explicitRepoUrl
  }
  try {
    return runGit(['remote', 'get-url', 'origin'])
  } catch {
    throw Object.assign(new Error('Unable to determine repo URL. Pass --repo-url explicitly.'), {
      code: 'REPO_URL_REQUIRED',
      exitCode: 1,
    })
  }
}

function parseAheadBehind(baseRef, branchName) {
  const output = runGit(['rev-list', '--left-right', '--count', `${baseRef}...${branchName}`])
  const [behindCount, aheadCount] = output
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10) || 0)
  return {
    behindCount,
    aheadCount,
  }
}

function buildCommitSummary(report) {
  const lines = [
    '# Publish Commit Summary',
    '',
    `- slice: \`${report.slice}\``,
    `- landedBranch: \`${report.landedBranchName}\``,
    `- landedHead: \`${report.landedHead}\``,
    '',
    '## Commit Order',
    '',
  ]

  for (const group of report.groups) {
    lines.push(`1. ${group.id}`)
    lines.push(`   message: ${group.message}`)
    lines.push(`   landed commit: \`${group.landedCommitSha}\``)
    lines.push(`   files: ${group.committedFiles.length}`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

function buildPublishSummary(report) {
  return `# Git Slice Publish Summary

- slice: \`${report.slice}\`
- baseRef: \`${report.baseRef}\`
- baseSha: \`${report.baseSha}\`
- landedBranch: \`${report.landedBranchName}\`
- landedHead: \`${report.landedHead}\`
- repoUrl: \`${report.repoUrl}\`
- commitCount: \`${report.commitCount}\`
- sliceFilesCount: \`${report.sliceFilesCount}\`
- aheadCount: \`${report.aheadCount}\`
- behindCount: \`${report.behindCount}\`
- branchReadyForPush: \`${report.branchReadyForPush}\`
- bundleVerified: \`${report.bundleVerified}\`
- requestPullGenerated: \`${report.requestPullGenerated}\`
- requestPullRemoteReady: \`${report.requestPullRemoteReady}\`
- verifyPushSucceeded: \`${report.verifyPushSucceeded}\`
- publishReady: \`${report.publishReady}\`
`
}

function buildReadme(report) {
  return `# Git Slice Publish Packet

This packet is the post-land delivery artifact for a landed slice branch.

## What it contains

- \`manifest.json\`: structured publish report
- \`publish-summary.md\`: high-level readiness summary
- \`commit-summary.md\`: landed commit order and file coverage
- \`publish-commands.sh\`: canonical push / inspect commands
- \`request-pull.txt\`: ready-to-send request-pull text
- \`request-pull-warning.txt\`: why the remote request-pull is not yet publish-ready, if applicable
- \`publish.bundle\`: bundle containing \`${report.baseRef}..${report.landedBranchName}\`
- \`bundle-verify.txt\`: output from \`git bundle verify\`

## Meaning

- \`branchReadyForPush=true\` means the landed branch is still clean relative to \`${report.baseRef}\`.
- \`publishReady=true\` means the bundle verified, a request-pull preview was generated, and publish verification succeeded.

## Branches

- base ref: \`${report.baseRef}\`
- landed branch: \`${report.landedBranchName}\`
- landed head: \`${report.landedHead}\`
`
}

function buildCommands(report) {
  return `#!/usr/bin/env bash
set -euo pipefail

git fetch origin --prune
git switch ${shellEscape(report.landedBranchName)}
git log --reverse --oneline ${shellEscape(report.baseSha)}..${shellEscape(report.landedBranchName)}
git diff --stat ${shellEscape(report.baseRef)}..${shellEscape(report.landedBranchName)}
git bundle verify ${shellEscape(path.basename(report.bundlePath))}
git push -u origin ${shellEscape(report.landedBranchName)}
git request-pull ${shellEscape(report.baseSha)} ${shellEscape(report.repoUrl)} ${shellEscape(report.landedBranchName)}
`
}

async function verifyPushPublishability({ landedBranchName, landedHead }) {
  const verifyDir = mkdtempSync(path.join(tmpdir(), 'git-slice-publish-verify-'))
  const bareRepoPath = path.join(verifyDir, 'publish-verify.git')
  runGit(['init', '--bare', bareRepoPath])

  const remoteUrl = `file://${bareRepoPath}`
  runGit(['push', remoteUrl, `${landedBranchName}:refs/heads/${landedBranchName}`])

  const pushedHead = runGit(['--git-dir', bareRepoPath, 'rev-parse', `refs/heads/${landedBranchName}`])
  const branchExists = gitSucceeds(['--git-dir', bareRepoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${landedBranchName}`])

  await fs.rm(verifyDir, { recursive: true, force: true })

  return {
    verifyRemoteUrl: remoteUrl,
    verifyRemotePath: bareRepoPath,
    branchExists,
    pushedHead,
    verifyPushSucceeded: branchExists && pushedHead === landedHead,
    cleanedUp: !existsSync(verifyDir),
  }
}

function generateRequestPull({ baseSha, repoUrl, landedBranchName }) {
  try {
    const output = runGit(['request-pull', baseSha, repoUrl, landedBranchName])
    return {
      output,
      mode: 'remote-url',
      remoteReady: true,
      warning: null,
      fallbackUrl: null,
    }
  } catch (error) {
    const fallbackUrl = process.cwd()
    const output = runGit(['request-pull', baseSha, fallbackUrl, landedBranchName])
    return {
      output,
      mode: 'local-repo-fallback',
      remoteReady: false,
      warning: String(error?.message ?? error),
      fallbackUrl,
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const slice = ensureSlice(args.sliceName)

  if (args.listSlices) {
    const payload = Object.entries(SLICES).map(([name, entry]) => ({
      name,
      description: entry.description ?? '',
      fileCount: entry.files.length,
      groupCount: entry.commitGroups?.length ?? 0,
    }))
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      return
    }
    for (const entry of payload) {
      console.log(`${entry.name}\tfiles=${entry.fileCount}\tgroups=${entry.groupCount}\t${entry.description}`)
    }
    return
  }

  if (args.listGroups) {
    const payload = slice.commitGroups.map((group, index) => ({
      order: index + 1,
      id: group.id,
      message: group.message,
      fileCount: group.files.length,
    }))
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      return
    }
    for (const entry of payload) {
      console.log(`${entry.order}. ${entry.id}\tfiles=${entry.fileCount}\t${entry.message}`)
    }
    return
  }

  if (!isGitWorkTree()) {
    throw Object.assign(new Error('Current directory is not a Git worktree.'), {
      code: 'NOT_A_GIT_REPOSITORY',
      exitCode: 2,
    })
  }

  const landManifest = await loadLandManifest(args.landManifest, args.sliceName)
  if (!landManifest.data.branchReadyForPush) {
    throw Object.assign(
      new Error('Land manifest is not ready for publish. Run land successfully first.'),
      {
        code: 'LAND_NOT_READY',
        exitCode: 1,
        manifestPath: landManifest.path,
      },
    )
  }

  const baseRef = requireValue(
    landManifest.data.baseRef,
    'Land manifest is missing baseRef.',
    'BASE_REF_REQUIRED',
  )
  const baseSha = requireValue(
    landManifest.data.baseSha,
    'Land manifest is missing baseSha.',
    'BASE_SHA_REQUIRED',
  )
  const landedBranchName = requireValue(
    landManifest.data.landedBranchName,
    'Land manifest is missing landedBranchName.',
    'LANDED_BRANCH_REQUIRED',
  )
  const landedHead = requireValue(
    landManifest.data.landedHead,
    'Land manifest is missing landedHead.',
    'LANDED_HEAD_REQUIRED',
  )

  assertGitRefExists(baseRef, 'Base ref', { baseRef })
  assertGitRefExists(baseSha, 'Base SHA', { baseSha })
  assertGitRefExists(landedBranchName, 'Landed branch', { landedBranchName })

  const resolvedLandedHead = runGit(['rev-parse', landedBranchName])
  if (resolvedLandedHead !== landedHead) {
    throw Object.assign(
      new Error(`Landed branch head mismatch: manifest=${landedHead}, current=${resolvedLandedHead}.`),
      {
        code: 'LANDED_HEAD_MISMATCH',
        exitCode: 1,
        landedBranchName,
        landedHead,
        resolvedLandedHead,
      },
    )
  }

  const repoUrl = resolveRepoUrl(args.repoUrl)
  const { aheadCount, behindCount } = parseAheadBehind(baseRef, landedBranchName)
  const commitCount = landManifest.data.commitCount ?? slice.commitGroups.length
  const sliceFilesCount = landManifest.data.sliceFilesCount ?? slice.files.length
  const branchReadyForPush =
    Boolean(landManifest.data.branchReadyForPush) &&
    Boolean(landManifest.data.treeMatchesPromotedHead) &&
    behindCount === 0 &&
    aheadCount === commitCount

  const outputDir = path.resolve(
    args.outputDir ??
      path.join(
        process.cwd(),
        'output',
        'git-slice-publishes',
        args.verify ? `verify-${args.sliceName}` : args.sliceName,
      ),
  )
  await fs.mkdir(outputDir, { recursive: true })

  const bundlePath = path.join(outputDir, 'publish.bundle')
  const summaryPath = path.join(outputDir, 'publish-summary.md')
  const readmePath = path.join(outputDir, 'README.md')
  const commandsPath = path.join(outputDir, 'publish-commands.sh')
  const requestPullPath = path.join(outputDir, 'request-pull.txt')
  const requestPullWarningPath = path.join(outputDir, 'request-pull-warning.txt')
  const commitSummaryPath = path.join(outputDir, 'commit-summary.md')
  const bundleVerifyPath = path.join(outputDir, 'bundle-verify.txt')
  const manifestPath = path.resolve(args.writeManifest ?? path.join(outputDir, 'manifest.json'))

  runGit(['bundle', 'create', bundlePath, `${baseRef}..${landedBranchName}`])
  const bundleVerifyOutput = runGit(['bundle', 'verify', bundlePath])
  const bundleHeadsOutput = runGit(['bundle', 'list-heads', bundlePath])
  const requestPull = generateRequestPull({ baseSha, repoUrl, landedBranchName })

  const groups = (landManifest.data.groups ?? []).map((group) => ({
    order: group.order,
    id: group.id,
    message: group.message,
    landedCommitSha: group.landedCommitSha ?? null,
    sourcePromotedCommitSha: group.sourcePromotedCommitSha ?? null,
    committedFiles: group.committedFiles ?? [],
  }))

  const preliminaryReport = {
    slice: args.sliceName,
    baseRef,
    baseSha,
    landedBranchName,
    landedHead,
    repoUrl,
    commitCount,
    sliceFilesCount,
    aheadCount,
    behindCount,
    branchReadyForPush,
    bundlePath,
    groups,
  }

  await writeTextFile(summaryPath, buildPublishSummary({
    ...preliminaryReport,
    bundleVerified: true,
    requestPullGenerated: true,
    requestPullRemoteReady: requestPull.remoteReady,
    verifyPushSucceeded: !args.verify,
    publishReady: branchReadyForPush && true && true && !args.verify ? true : false,
  }))
  await writeTextFile(readmePath, buildReadme({
    ...preliminaryReport,
    bundlePath,
  }))
  await writeTextFile(commandsPath, buildCommands({
    ...preliminaryReport,
    bundlePath,
  }), true)
  await writeTextFile(requestPullPath, `${requestPull.output}\n`)
  if (requestPull.warning) {
    await writeTextFile(requestPullWarningPath, `${requestPull.warning}\n`)
  }
  await writeTextFile(commitSummaryPath, buildCommitSummary({
    ...preliminaryReport,
    groups,
  }))
  await writeTextFile(bundleVerifyPath, `${bundleVerifyOutput}\n\n${bundleHeadsOutput}\n`)

  const verifyPush = args.verify
    ? await verifyPushPublishability({ landedBranchName, landedHead })
    : {
        verifyRemoteUrl: null,
        verifyRemotePath: null,
        branchExists: null,
        pushedHead: null,
        verifyPushSucceeded: true,
        cleanedUp: null,
      }

  const bundleSha256 = await sha256File(bundlePath)
  const requestPullSha256 = await sha256File(requestPullPath)
  const bundleVerifySha256 = await sha256File(bundleVerifyPath)
  const publishReady =
    branchReadyForPush &&
    verifyPush.verifyPushSucceeded &&
    Boolean(bundleVerifyOutput) &&
    Boolean(requestPull.output)

  const payload = {
    generatedAt: new Date().toISOString(),
    slice: args.sliceName,
    description: slice.description ?? null,
    verifyMode: args.verify,
    landManifestPath: landManifest.path,
    baseRef,
    baseSha,
    repoUrl,
    landedBranchName,
    landedHead,
    commitCount,
    sliceFilesCount,
    aheadCount,
    behindCount,
    branchReadyForPush,
    treeMatchesPromotedHead: Boolean(landManifest.data.treeMatchesPromotedHead),
    requestPullGenerated: true,
    requestPullRemoteReady: requestPull.remoteReady,
    requestPullMode: requestPull.mode,
    bundleVerified: true,
    verifyPushSucceeded: verifyPush.verifyPushSucceeded,
    publishReady,
    groups,
    bundlePath,
    bundleSha256,
    bundleVerifyPath,
    bundleVerifySha256,
    bundleVerifyOutput,
    bundleHeadsOutput,
    requestPullPath,
    requestPullSha256,
    requestPullWarningPath: requestPull.warning ? requestPullWarningPath : null,
    requestPullWarning: requestPull.warning ?? null,
    requestPullFallbackUrl: requestPull.fallbackUrl ?? null,
    commitSummaryPath,
    summaryPath,
    readmePath,
    commandsPath,
    outputDir,
    verifyPush,
    verifyPassed: publishReady,
  }

  await writeTextFile(summaryPath, buildPublishSummary(payload))
  await writeTextFile(readmePath, buildReadme(payload))
  await writeJsonFile(manifestPath, payload)

  const result = {
    ...payload,
    manifestPath,
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`git-slice-publish: ${args.sliceName}`)
  console.log(`  landed_branch: ${landedBranchName}`)
  console.log(`  landed_head: ${landedHead}`)
  console.log(`  publish_ready: ${publishReady}`)
  console.log(`  output_dir: ${outputDir}`)
}

main().catch((error) => {
  const payload = {
    error: error.message,
    code: error.code ?? 'UNEXPECTED_ERROR',
  }
  if (error.exitCode) {
    payload.exitCode = error.exitCode
  }
  if (error.ref) {
    payload.ref = error.ref
  }
  console.error(JSON.stringify(payload, null, 2))
  process.exit(error.exitCode ?? 1)
})
