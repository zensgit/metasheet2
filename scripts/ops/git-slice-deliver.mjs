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

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let publishManifest = null
  let repoUrl = null
  let remoteBranch = null
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
      case '--publish-manifest':
        publishManifest = argv[index + 1] ?? publishManifest
        index += 1
        break
      case '--repo-url':
        repoUrl = argv[index + 1] ?? repoUrl
        index += 1
        break
      case '--remote-branch':
        remoteBranch = argv[index + 1] ?? remoteBranch
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

  if (!publishManifest && !listSlices && !listGroups) {
    throw Object.assign(
      new Error('Provide --publish-manifest for git-slice-deliver.'),
      {
        code: 'PUBLISH_MANIFEST_REQUIRED',
        exitCode: 1,
      },
    )
  }

  return {
    sliceName,
    publishManifest,
    repoUrl,
    remoteBranch,
    outputDir,
    writeManifest,
    json,
    verify,
    listSlices,
    listGroups,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-deliver.mjs [options]

Options:
  --slice <name>             Slice name. Default: directory-migration-baseline
  --publish-manifest <path>  Publish manifest path
  --repo-url <url>           Override delivery URL. Default: publish manifest repoUrl
  --remote-branch <name>     Remote branch name. Default: landed branch name
  --output-dir <path>        Write deliver packet artifacts
  --write-manifest <path>    Write manifest JSON to the given path
  --verify                   Verify delivery by pushing to a temporary bare repo
  --list-slices              Print available slices
  --list-groups              Print groups for the selected slice
  --json                     Print JSON
  --help, -h                 Show help`)
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

async function loadPublishManifest(filePath, sliceName) {
  const resolvedPath = path.resolve(filePath)
  const raw = await fs.readFile(resolvedPath, 'utf8')
  const data = JSON.parse(raw)

  if (data.slice && data.slice !== sliceName) {
    throw Object.assign(
      new Error(`Publish manifest slice mismatch: expected ${sliceName}, got ${data.slice}.`),
      {
        code: 'PUBLISH_MANIFEST_SLICE_MISMATCH',
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

function parseLsRemoteHead(output, branchName) {
  if (!output.trim()) {
    return {
      branchExists: false,
      remoteHead: null,
      remoteRef: `refs/heads/${branchName}`,
    }
  }

  const firstLine = output.trim().split('\n')[0]
  const [remoteHead, remoteRef] = firstLine.split(/\s+/)
  return {
    branchExists: Boolean(remoteHead),
    remoteHead: remoteHead ?? null,
    remoteRef: remoteRef ?? `refs/heads/${branchName}`,
  }
}

function parseGitHubRepo(repoUrl) {
  const httpsMatch = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
      webUrl: `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`,
    }
  }
  const sshMatch = repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      webUrl: `https://github.com/${sshMatch[1]}/${sshMatch[2]}`,
    }
  }
  return null
}

function buildRemoteUrls(repoUrl, baseSha, remoteBranchName) {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) {
    return {
      branchUrl: null,
      compareUrl: null,
      pullRequestUrl: null,
    }
  }

  return {
    branchUrl: `${parsed.webUrl}/tree/${remoteBranchName}`,
    compareUrl: `${parsed.webUrl}/compare/${baseSha}...${remoteBranchName}?expand=1`,
    pullRequestUrl: `${parsed.webUrl}/compare/${baseSha}...${remoteBranchName}?expand=1`,
  }
}

function generateRequestPull({ baseSha, repoUrl, remoteBranchName }) {
  return runGit(['request-pull', baseSha, repoUrl, remoteBranchName])
}

function buildDeliverSummary(report) {
  return `# Git Slice Deliver Summary

- slice: \`${report.slice}\`
- baseRef: \`${report.baseRef}\`
- baseSha: \`${report.baseSha}\`
- landedBranch: \`${report.landedBranchName}\`
- landedHead: \`${report.landedHead}\`
- remoteBranch: \`${report.remoteBranchName}\`
- remoteHead: \`${report.remoteHead}\`
- repoUrl: \`${report.repoUrl}\`
- commitCount: \`${report.commitCount}\`
- sliceFilesCount: \`${report.sliceFilesCount}\`
- branchReadyForPush: \`${report.branchReadyForPush}\`
- remoteBranchExists: \`${report.remoteBranchExists}\`
- remoteHeadMatchesLandedHead: \`${report.remoteHeadMatchesLandedHead}\`
- requestPullRemoteReady: \`${report.requestPullRemoteReady}\`
- deliverReady: \`${report.deliverReady}\`
`
}

function buildReadme(report) {
  return `# Git Slice Deliver Packet

This packet is the post-publish delivery artifact for a landed slice branch.

## What it contains

- \`manifest.json\`: structured delivery report
- \`deliver-summary.md\`: high-level delivery summary
- \`deliver-commands.sh\`: canonical push / inspect commands
- \`remote-head.txt\`: resolved remote head after delivery
- \`request-pull-remote.txt\`: request-pull generated against the delivered remote branch
- \`compare-url.txt\`: GitHub compare URL, when derivable from repo URL

## Meaning

- \`deliverReady=true\` means the branch was pushed (or verify-pushed), the remote ref resolves to the landed head, and a remote request-pull was generated.
- \`requestPullRemoteReady=true\` means the remote delivery target is already serving the delivered branch.

## Branches

- base ref: \`${report.baseRef}\`
- landed branch: \`${report.landedBranchName}\`
- delivered remote branch: \`${report.remoteBranchName}\`
- landed head: \`${report.landedHead}\`
- remote head: \`${report.remoteHead}\`
`
}

function buildCommands(report) {
  return `#!/usr/bin/env bash
set -euo pipefail

git fetch origin --prune
git show --stat ${shellEscape(report.landedHead)}
git push ${shellEscape(report.repoUrl)} ${shellEscape(`refs/heads/${report.landedBranchName}:refs/heads/${report.remoteBranchName}`)}
git ls-remote --heads ${shellEscape(report.repoUrl)} ${shellEscape(`refs/heads/${report.remoteBranchName}`)}
git request-pull ${shellEscape(report.baseSha)} ${shellEscape(report.repoUrl)} ${shellEscape(report.remoteBranchName)}
`
}

function buildCommitSummary(report) {
  const lines = [
    '# Deliver Commit Summary',
    '',
    `- slice: \`${report.slice}\``,
    `- landedBranch: \`${report.landedBranchName}\``,
    `- remoteBranch: \`${report.remoteBranchName}\``,
    `- landedHead: \`${report.landedHead}\``,
    `- remoteHead: \`${report.remoteHead}\``,
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

function pushBranch({ targetUrl, sourceBranchName, remoteBranchName }) {
  const refspec = `refs/heads/${sourceBranchName}:refs/heads/${remoteBranchName}`
  const output = runGit(['push', targetUrl, refspec])
  return {
    refspec,
    output,
  }
}

function resolveRemoteBranch({ verify, remoteBranchName }) {
  if (verify) {
    return remoteBranchName
  }
  return remoteBranchName
}

async function verifyDelivery({ repoUrl, landedBranchName, remoteBranchName, landedHead }) {
  const verifyDir = mkdtempSync(path.join(tmpdir(), 'git-slice-deliver-verify-'))
  const bareRepoPath = path.join(verifyDir, 'deliver-verify.git')
  runGit(['init', '--bare', bareRepoPath])

  const remoteUrl = `file://${bareRepoPath}`
  const baseRef = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const localBaseBranchName = baseRef.replace(/^origin\//, '')
  runGit(['push', remoteUrl, `${baseRef}:refs/heads/${localBaseBranchName}`])
  const pushResult = pushBranch({
    targetUrl: remoteUrl,
    sourceBranchName: landedBranchName,
    remoteBranchName,
  })
  const lsRemoteOutput = runGit(['ls-remote', '--heads', remoteUrl, `refs/heads/${remoteBranchName}`])
  const { branchExists, remoteHead, remoteRef } = parseLsRemoteHead(lsRemoteOutput, remoteBranchName)
  const requestPullOutput = generateRequestPull({
    baseSha: runGit(['rev-parse', baseRef]),
    repoUrl: remoteUrl,
    remoteBranchName,
  })

  await fs.rm(verifyDir, { recursive: true, force: true })

  return {
    deliveryRepoUrl: remoteUrl,
    deliveryRepoPath: bareRepoPath,
    remoteBranchExists: branchExists,
    remoteHead,
    remoteRef,
    remoteHeadMatchesLandedHead: remoteHead === landedHead,
    pushOutput: pushResult.output,
    pushRefspec: pushResult.refspec,
    requestPullOutput,
    cleanedUp: !existsSync(verifyDir),
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

  const publishManifest = await loadPublishManifest(args.publishManifest, args.sliceName)
  if (!publishManifest.data.publishReady) {
    throw Object.assign(
      new Error('Publish manifest is not ready for deliver. Run publish successfully first.'),
      {
        code: 'PUBLISH_NOT_READY',
        exitCode: 1,
        manifestPath: publishManifest.path,
      },
    )
  }

  const baseRef = requireValue(
    publishManifest.data.baseRef,
    'Publish manifest is missing baseRef.',
    'BASE_REF_REQUIRED',
  )
  const baseSha = requireValue(
    publishManifest.data.baseSha,
    'Publish manifest is missing baseSha.',
    'BASE_SHA_REQUIRED',
  )
  const landedBranchName = requireValue(
    publishManifest.data.landedBranchName,
    'Publish manifest is missing landedBranchName.',
    'LANDED_BRANCH_REQUIRED',
  )
  const landedHead = requireValue(
    publishManifest.data.landedHead,
    'Publish manifest is missing landedHead.',
    'LANDED_HEAD_REQUIRED',
  )
  const repoUrl = requireValue(
    args.repoUrl ?? publishManifest.data.repoUrl,
    'Unable to determine repo URL. Pass --repo-url explicitly.',
    'REPO_URL_REQUIRED',
  )
  const remoteBranchName = requireValue(
    args.remoteBranch ?? publishManifest.data.remoteBranchName ?? landedBranchName,
    'Unable to determine remote branch.',
    'REMOTE_BRANCH_REQUIRED',
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

  const outputDir = path.resolve(
    args.outputDir ??
      path.join(
        process.cwd(),
        'output',
        'git-slice-deliveries',
        args.sliceName,
        args.verify ? 'verify' : 'deliver',
      ),
  )
  await fs.mkdir(outputDir, { recursive: true })

  const summaryPath = path.join(outputDir, 'deliver-summary.md')
  const readmePath = path.join(outputDir, 'README.md')
  const commandsPath = path.join(outputDir, 'deliver-commands.sh')
  const remoteHeadPath = path.join(outputDir, 'remote-head.txt')
  const requestPullPath = path.join(outputDir, 'request-pull-remote.txt')
  const compareUrlPath = path.join(outputDir, 'compare-url.txt')
  const commitSummaryPath = path.join(outputDir, 'commit-summary.md')
  const manifestPath = path.resolve(args.writeManifest ?? path.join(outputDir, 'manifest.json'))

  const groups = (publishManifest.data.groups ?? []).map((group) => ({
    order: group.order,
    id: group.id,
    message: group.message,
    landedCommitSha: group.landedCommitSha ?? null,
    sourcePromotedCommitSha: group.sourcePromotedCommitSha ?? null,
    committedFiles: group.committedFiles ?? [],
  }))

  const remoteUrls = buildRemoteUrls(repoUrl, baseSha, remoteBranchName)

  let deliveryResult
  if (args.verify) {
    deliveryResult = await verifyDelivery({
      repoUrl,
      landedBranchName,
      remoteBranchName: resolveRemoteBranch({
        verify: true,
        remoteBranchName,
      }),
      landedHead,
    })
  } else {
    const pushResult = pushBranch({
      targetUrl: repoUrl,
      sourceBranchName: landedBranchName,
      remoteBranchName,
    })
    const lsRemoteOutput = runGit(['ls-remote', '--heads', repoUrl, `refs/heads/${remoteBranchName}`])
    const { branchExists, remoteHead, remoteRef } = parseLsRemoteHead(lsRemoteOutput, remoteBranchName)
    const requestPullOutput = generateRequestPull({
      baseSha,
      repoUrl,
      remoteBranchName,
    })
    deliveryResult = {
      deliveryRepoUrl: repoUrl,
      deliveryRepoPath: null,
      remoteBranchExists: branchExists,
      remoteHead,
      remoteRef,
      remoteHeadMatchesLandedHead: remoteHead === landedHead,
      pushOutput: pushResult.output,
      pushRefspec: pushResult.refspec,
      requestPullOutput,
      cleanedUp: null,
    }
  }

  const remoteHead = deliveryResult.remoteHead
  const deliverReady =
    Boolean(publishManifest.data.publishReady) &&
    Boolean(deliveryResult.remoteBranchExists) &&
    Boolean(deliveryResult.remoteHeadMatchesLandedHead) &&
    Boolean(deliveryResult.requestPullOutput)

  const payload = {
    generatedAt: new Date().toISOString(),
    slice: args.sliceName,
    description: slice.description ?? null,
    verifyMode: args.verify,
    publishManifestPath: publishManifest.path,
    baseRef,
    baseSha,
    repoUrl,
    landedBranchName,
    landedHead,
    remoteBranchName,
    remoteHead,
    remoteRef: deliveryResult.remoteRef,
    commitCount: publishManifest.data.commitCount ?? slice.commitGroups.length,
    sliceFilesCount: publishManifest.data.sliceFilesCount ?? slice.files.length,
    branchReadyForPush: Boolean(publishManifest.data.branchReadyForPush),
    publishReady: Boolean(publishManifest.data.publishReady),
    remoteBranchExists: Boolean(deliveryResult.remoteBranchExists),
    remoteHeadMatchesLandedHead: Boolean(deliveryResult.remoteHeadMatchesLandedHead),
    requestPullRemoteReady: Boolean(deliveryResult.requestPullOutput),
    deliverReady,
    groups,
    deliveryRepoUrl: deliveryResult.deliveryRepoUrl,
    deliveryRepoPath: deliveryResult.deliveryRepoPath,
    pushRefspec: deliveryResult.pushRefspec,
    pushOutput: deliveryResult.pushOutput,
    requestPullPath,
    summaryPath,
    readmePath,
    commandsPath,
    remoteHeadPath,
    compareUrlPath: remoteUrls.compareUrl ? compareUrlPath : null,
    compareUrl: remoteUrls.compareUrl,
    branchUrl: remoteUrls.branchUrl,
    pullRequestUrl: remoteUrls.pullRequestUrl,
    outputDir,
    verifyPush: {
      verifyRemoteUrl: args.verify ? deliveryResult.deliveryRepoUrl : null,
      verifyRemotePath: args.verify ? deliveryResult.deliveryRepoPath : null,
      verifyPushSucceeded: Boolean(deliveryResult.remoteHeadMatchesLandedHead),
      cleanedUp: deliveryResult.cleanedUp,
    },
    verifyPassed: deliverReady,
  }

  await writeTextFile(summaryPath, buildDeliverSummary(payload))
  await writeTextFile(readmePath, buildReadme(payload))
  await writeTextFile(commandsPath, buildCommands(payload), true)
  await writeTextFile(remoteHeadPath, `${remoteHead ?? ''}\n`)
  await writeTextFile(requestPullPath, `${deliveryResult.requestPullOutput}\n`)
  if (remoteUrls.compareUrl) {
    await writeTextFile(compareUrlPath, `${remoteUrls.compareUrl}\n`)
  }
  await writeTextFile(commitSummaryPath, buildCommitSummary(payload))

  const result = {
    ...payload,
    requestPullSha256: await sha256File(requestPullPath),
    remoteHeadSha256: await sha256File(remoteHeadPath),
    compareUrlSha256: remoteUrls.compareUrl ? await sha256File(compareUrlPath) : null,
    commitSummarySha256: await sha256File(commitSummaryPath),
    summarySha256: await sha256File(summaryPath),
    manifestPath,
  }

  await writeJsonFile(manifestPath, result)

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`git-slice-deliver: ${args.sliceName}`)
  console.log(`  landed_branch: ${landedBranchName}`)
  console.log(`  remote_branch: ${remoteBranchName}`)
  console.log(`  deliver_ready: ${deliverReady}`)
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
  console.error(JSON.stringify(payload, null, 2))
  process.exit(error.exitCode ?? 1)
})
