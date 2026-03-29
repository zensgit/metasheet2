#!/usr/bin/env node

import fs from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
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

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function timestampSlug() {
  return new Date()
    .toISOString()
    .replace(/[:]/g, '')
    .replace(/\./g, '')
    .replace('T', '-')
    .replace('Z', 'z')
}

function sanitizeBranchPart(value) {
  return value
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^-+|-+$/g, '')
}

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let manifestPath = null
  let bundlePath = null
  let repoUrl = null
  let baseRef = null
  let branchName = null
  let branchPrefix = 'replayed'
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
      case '--manifest':
        manifestPath = argv[index + 1] ?? manifestPath
        index += 1
        break
      case '--bundle-path':
        bundlePath = argv[index + 1] ?? bundlePath
        index += 1
        break
      case '--repo-url':
        repoUrl = argv[index + 1] ?? repoUrl
        index += 1
        break
      case '--base-ref':
        baseRef = argv[index + 1] ?? baseRef
        index += 1
        break
      case '--branch-name':
        branchName = argv[index + 1] ?? branchName
        index += 1
        break
      case '--branch-prefix':
        branchPrefix = argv[index + 1] ?? branchPrefix
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

  if (!manifestPath && !listSlices && !listGroups) {
    throw Object.assign(new Error('Provide --manifest for git-slice-replay.'), {
      code: 'MANIFEST_REQUIRED',
      exitCode: 1,
    })
  }

  return {
    sliceName,
    manifestPath,
    bundlePath,
    repoUrl,
    baseRef,
    branchName,
    branchPrefix,
    outputDir,
    writeManifest,
    json,
    verify,
    listSlices,
    listGroups,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-replay.mjs [options]

Options:
  --slice <name>          Slice name. Default: directory-migration-baseline
  --manifest <path>       Handoff manifest path
  --bundle-path <path>    Override bundle path from manifest
  --repo-url <url>        Override repository URL from manifest
  --base-ref <ref>        Override base ref from manifest
  --branch-name <name>    Replay branch name
  --branch-prefix <name>  Prefix for auto-generated replay branches. Default: replayed
  --output-dir <path>     Write replay report and regenerated patches
  --write-manifest <path> Write report JSON to the given path
  --verify                Mark this replay as verify mode
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

function buildAutoBranchName(options) {
  const prefix = sanitizeBranchPart(options.branchPrefix || 'replayed')
  const slicePart = sanitizeBranchPart(options.sliceName)
  const nonce = randomBytes(3).toString('hex')
  return `${prefix}/${slicePart}-${timestampSlug()}-${process.pid}-${nonce}`
}

function buildBranchName(options) {
  return options.branchName || buildAutoBranchName(options)
}

async function writeTextFile(filePath, contents) {
  const resolvedPath = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, contents, 'utf8')
  return resolvedPath
}

async function writeJsonFile(filePath, payload) {
  return writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

async function loadManifest(manifestPath, sliceName) {
  const resolvedPath = path.resolve(manifestPath)
  const raw = await fs.readFile(resolvedPath, 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed.slice && parsed.slice !== sliceName) {
    throw Object.assign(
      new Error(`Manifest slice mismatch: expected ${sliceName}, got ${parsed.slice}.`),
      {
        code: 'MANIFEST_SLICE_MISMATCH',
        exitCode: 1,
      },
    )
  }
  return {
    path: resolvedPath,
    dir: path.dirname(resolvedPath),
    data: parsed,
  }
}

function resolveBaseRef(explicitBaseRef, manifest) {
  const resolved = explicitBaseRef ?? manifest.baseRef ?? null
  if (!resolved) {
    throw Object.assign(new Error('Unable to resolve base ref from options or manifest.'), {
      code: 'BASE_REF_REQUIRED',
      exitCode: 1,
    })
  }
  return resolved
}

function resolveRepoUrl(explicitRepoUrl, manifest) {
  const resolved = explicitRepoUrl ?? manifest.repoUrl ?? null
  if (!resolved) {
    throw Object.assign(
      new Error('Unable to resolve repository URL from options or manifest.'),
      {
        code: 'REPO_URL_REQUIRED',
        exitCode: 1,
      },
    )
  }
  return resolved
}

function normalizeFetchRef(baseRef, remoteName = 'origin') {
  if (baseRef.startsWith(`${remoteName}/`)) {
    return baseRef.slice(remoteName.length + 1)
  }
  const remotePrefix = `refs/remotes/${remoteName}/`
  if (baseRef.startsWith(remotePrefix)) {
    return baseRef.slice(remotePrefix.length)
  }
  return baseRef
}

function resolveArtifactPath(candidates, errorCode, message) {
  for (const candidate of candidates) {
    if (!candidate) {
      continue
    }
    const resolved = path.resolve(candidate)
    if (existsSync(resolved)) {
      return resolved
    }
  }

  throw Object.assign(new Error(message), {
    code: errorCode,
    exitCode: 1,
    candidates: candidates.filter(Boolean).map((candidate) => path.resolve(candidate)),
  })
}

async function resolveArtifacts(options, manifestContext) {
  const bundleFileName =
    manifestContext.data.bundleFileName ??
    (manifestContext.data.bundlePath ? path.basename(manifestContext.data.bundlePath) : null) ??
    `${options.sliceName}.bundle`
  const bundlePath = resolveArtifactPath(
    [
      options.bundlePath,
      manifestContext.data.bundlePath,
      path.join(manifestContext.dir, bundleFileName),
    ],
    'MISSING_BUNDLE_FILE',
    `Unable to resolve handoff bundle for slice ${options.sliceName}.`,
  )

  const bundleSha256 = await hashFile(bundlePath)
  if (manifestContext.data.bundleSha256 && bundleSha256 !== manifestContext.data.bundleSha256) {
    throw Object.assign(
      new Error(
        `Bundle SHA mismatch: expected ${manifestContext.data.bundleSha256}, got ${bundleSha256}.`,
      ),
      {
        code: 'BUNDLE_SHA_MISMATCH',
        exitCode: 1,
        expectedBundleSha256: manifestContext.data.bundleSha256,
        actualBundleSha256: bundleSha256,
      },
    )
  }

  const patchFiles = []
  for (const patchFile of manifestContext.data.patchFiles ?? []) {
    const resolvedPath = resolveArtifactPath(
      [
        patchFile.path,
        path.join(manifestContext.dir, 'patches', patchFile.fileName),
      ],
      'MISSING_PATCH_FILE',
      `Unable to resolve handoff patch ${patchFile.fileName}.`,
    )
    const sha256 = await hashFile(resolvedPath)
    if (patchFile.sha256 && sha256 !== patchFile.sha256) {
      throw Object.assign(
        new Error(`Patch SHA mismatch for ${patchFile.fileName}: expected ${patchFile.sha256}, got ${sha256}.`),
        {
          code: 'PATCH_SHA_MISMATCH',
          exitCode: 1,
          expectedPatchSha256: patchFile.sha256,
          actualPatchSha256: sha256,
          patchFileName: patchFile.fileName,
        },
      )
    }
    patchFiles.push({
      ...patchFile,
      path: resolvedPath,
      sha256,
    })
  }

  return {
    bundleFileName,
    bundleRefName: manifestContext.data.bundleRefName ?? manifestContext.data.sourceBranch ?? null,
    bundlePath,
    bundleSha256,
    patchFiles,
  }
}

function createReplayRepoLocation() {
  const tempParent = mkdtempSync(path.join(tmpdir(), 'git-slice-replay-'))
  return {
    tempParent,
    repoPath: path.join(tempParent, 'repo'),
  }
}

async function cleanupReplayRepo(location, branchName) {
  const cleanup = {
    replayRepoRemoved: false,
    branchDeleted: false,
    tempParentRemoved: false,
  }

  if (location.repoPath && existsSync(location.repoPath)) {
    try {
      await fs.rm(location.repoPath, { recursive: true, force: true })
      cleanup.replayRepoRemoved = true
    } catch {
      // best effort
    }
  }

  if (location.tempParent && existsSync(location.tempParent)) {
    try {
      await fs.rm(location.tempParent, { recursive: true, force: true })
      cleanup.tempParentRemoved = true
    } catch {
      // best effort
    }
  }

  if (branchName) {
    cleanup.branchDeleted = true
  }

  return cleanup
}

function readCommitSubjects(repoPath, commits) {
  return commits.map((commitSha, index) => ({
    order: index + 1,
    sha: commitSha,
    message: runGit(['show', '--quiet', '--format=%s', commitSha], { cwd: repoPath }),
  }))
}

function buildExpectedGroups(slice, manifest) {
  const manifestGroups = manifest.groups ?? []
  if (manifestGroups.length === 0) {
    return slice.commitGroups
  }

  return manifestGroups.map((group) => {
    const resolved = slice.commitGroups.find((entry) => entry.id === group.id)
    if (!resolved) {
      throw Object.assign(
        new Error(`Manifest references unknown commit group: ${group.id}.`),
        {
          code: 'UNKNOWN_MANIFEST_GROUP',
          exitCode: 1,
          groupId: group.id,
        },
      )
    }
    return resolved
  })
}

function validateCommitSequence(commits, manifest, expectedGroups, summaries) {
  const manifestCommits = manifest.commits ?? []
  if (manifestCommits.length !== commits.length) {
    throw Object.assign(
      new Error(
        `Replay commit count mismatch: expected ${manifestCommits.length}, got ${commits.length}.`,
      ),
      {
        code: 'REPLAY_COMMIT_COUNT_MISMATCH',
        exitCode: 1,
      },
    )
  }

  for (const [index, commitSha] of commits.entries()) {
    if (manifestCommits[index] !== commitSha) {
      throw Object.assign(
        new Error(
          `Replay commit mismatch at order ${index + 1}: expected ${manifestCommits[index]}, got ${commitSha}.`,
        ),
        {
          code: 'REPLAY_COMMIT_SEQUENCE_MISMATCH',
          exitCode: 1,
          order: index + 1,
        },
      )
    }
  }

  if (expectedGroups.length !== summaries.length) {
    throw Object.assign(
      new Error(
        `Replay group count mismatch: expected ${expectedGroups.length}, got ${summaries.length}.`,
      ),
      {
        code: 'REPLAY_GROUP_COUNT_MISMATCH',
        exitCode: 1,
      },
    )
  }

  const manifestGroups = manifest.groups ?? []
  for (const [index, summary] of summaries.entries()) {
    const expectedGroup = expectedGroups[index]
    const manifestGroup = manifestGroups[index] ?? null
    if (summary.message !== expectedGroup.message) {
      throw Object.assign(
        new Error(
          `Replay subject mismatch for group ${expectedGroup.id}: expected "${expectedGroup.message}", got "${summary.message}".`,
        ),
        {
          code: 'REPLAY_MESSAGE_MISMATCH',
          exitCode: 1,
          order: index + 1,
        },
      )
    }
    if (manifestGroup?.sourceCommitSha && manifestGroup.sourceCommitSha !== summary.sha) {
      throw Object.assign(
        new Error(
          `Replay SHA mismatch for group ${expectedGroup.id}: expected ${manifestGroup.sourceCommitSha}, got ${summary.sha}.`,
        ),
        {
          code: 'REPLAY_GROUP_SHA_MISMATCH',
          exitCode: 1,
          order: index + 1,
        },
      )
    }
  }
}

async function comparePatchSeries(repoPath, baseSha, replayHead, artifacts, outputDir) {
  const patchDir = path.join(outputDir, 'patches')
  await fs.mkdir(patchDir, { recursive: true })
  runGit(['format-patch', '--output-directory', patchDir, '--full-index', '--binary', '--abbrev=40', `${baseSha}..${replayHead}`], {
    cwd: repoPath,
  })

  const replayPatchFileNames = (await fs.readdir(patchDir))
    .filter((entry) => entry.endsWith('.patch'))
    .sort((left, right) => left.localeCompare(right))

  if (replayPatchFileNames.length !== artifacts.patchFiles.length) {
    throw Object.assign(
      new Error(
        `Replay patch count mismatch: expected ${artifacts.patchFiles.length}, got ${replayPatchFileNames.length}.`,
      ),
      {
        code: 'REPLAY_PATCH_COUNT_MISMATCH',
        exitCode: 1,
      },
    )
  }

  const patchComparisons = []
  for (const [index, expectedPatch] of artifacts.patchFiles.entries()) {
    const replayFileName = replayPatchFileNames[index]
    if (replayFileName !== expectedPatch.fileName) {
      throw Object.assign(
        new Error(
          `Replay patch filename mismatch at order ${index + 1}: expected ${expectedPatch.fileName}, got ${replayFileName}.`,
        ),
        {
          code: 'REPLAY_PATCH_FILENAME_MISMATCH',
          exitCode: 1,
          order: index + 1,
        },
      )
    }

    const replayPath = path.join(patchDir, replayFileName)
    const replaySha256 = await hashFile(replayPath)
    if (replaySha256 !== expectedPatch.sha256) {
      throw Object.assign(
        new Error(
          `Replay patch SHA mismatch for ${replayFileName}: expected ${expectedPatch.sha256}, got ${replaySha256}.`,
        ),
        {
          code: 'REPLAY_PATCH_SHA_MISMATCH',
          exitCode: 1,
          patchFileName: replayFileName,
        },
      )
    }

    patchComparisons.push({
      order: index + 1,
      fileName: replayFileName,
      replayPath,
      replaySha256,
      expectedSha256: expectedPatch.sha256,
      matches: true,
    })
  }

  return {
    patchDir,
    patchComparisons,
  }
}

async function buildReadme(report) {
  const lines = [
    `# Git Slice Replay: ${report.slice}`,
    '',
    `- Source manifest: \`${report.sourceManifestPath}\``,
    `- Repo URL: \`${report.repoUrl}\``,
    `- Base ref: \`${report.baseRef}\``,
    `- Base SHA: \`${report.baseSha}\``,
    `- Replay branch: \`${report.replayBranchName}\``,
    `- Replayed head: \`${report.replayedHead}\``,
    `- Bundle path: \`${report.bundlePath}\``,
    `- Bundle SHA-256: \`${report.bundleSha256}\``,
    `- Verify passed: \`${report.verifyPassed}\``,
    '',
    '## Suggested verification',
    '',
    '```bash',
    `git bundle verify ${shellEscape(report.bundlePath)}`,
    `git log --oneline ${shellEscape(`${report.baseSha}..${report.replayedHead}`)}`,
    '```',
    '',
  ]
  return `${lines.join('\n')}\n`
}

function buildReplaySummary(report) {
  const lines = [
    `# Git Slice Replay Summary: ${report.slice}`,
    '',
    `- Replay branch: \`${report.replayBranchName}\``,
    `- Replayed head: \`${report.replayedHead}\``,
    `- Commit count: \`${report.commitCount}\``,
    '',
    '## Groups',
    '',
  ]

  for (const group of report.groups) {
    lines.push(`1. ${group.id}`)
    lines.push(`   replayed SHA: \`${group.replayedCommitSha}\``)
    lines.push(`   subject: ${group.message}`)
    lines.push(`   patch: \`${group.patchFileName}\``)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

async function buildReplay(options) {
  const slice = ensureSlice(options.sliceName)
  const manifestContext = await loadManifest(options.manifestPath, options.sliceName)
  const artifacts = await resolveArtifacts(options, manifestContext)
  const expectedGroups = buildExpectedGroups(slice, manifestContext.data)
  const repoUrl = resolveRepoUrl(options.repoUrl, manifestContext.data)
  const baseRef = resolveBaseRef(options.baseRef, manifestContext.data)
  const fetchRef = normalizeFetchRef(baseRef)
  const replayBranchName = buildBranchName(options)
  const location = createReplayRepoLocation()
  const outputDir = path.resolve(
    options.outputDir ??
      path.join(
        'output',
        'git-slice-replays',
        options.sliceName,
        options.verify ? 'verify' : 'replay',
      ),
  )

  let cleanup = {
    replayRepoRemoved: false,
    branchDeleted: false,
    tempParentRemoved: false,
  }

  try {
    await fs.mkdir(location.repoPath, { recursive: true })
    runGit(['init', '-q'], { cwd: location.repoPath })
    runGit(['remote', 'add', 'origin', repoUrl], { cwd: location.repoPath })
    runGit(['fetch', '--quiet', 'origin', fetchRef], { cwd: location.repoPath })
    runGit(['checkout', '--detach', '--quiet', 'FETCH_HEAD'], { cwd: location.repoPath })

    const fetchedBaseSha = runGit(['rev-parse', 'HEAD'], { cwd: location.repoPath })
    if (manifestContext.data.baseSha && fetchedBaseSha !== manifestContext.data.baseSha) {
      throw Object.assign(
        new Error(
          `Replay base SHA mismatch: expected ${manifestContext.data.baseSha}, got ${fetchedBaseSha}.`,
        ),
        {
          code: 'REPLAY_BASE_SHA_MISMATCH',
          exitCode: 1,
        },
      )
    }

    const bundleVerifyOutput = runGit(['bundle', 'verify', artifacts.bundlePath], {
      cwd: location.repoPath,
    })
    runGit(
      ['fetch', '--quiet', artifacts.bundlePath, `${artifacts.bundleRefName}:refs/heads/${replayBranchName}`],
      { cwd: location.repoPath },
    )
    runGit(['switch', '--quiet', replayBranchName], { cwd: location.repoPath })

    const replayedHead = runGit(['rev-parse', 'HEAD'], { cwd: location.repoPath })
    if (manifestContext.data.sourceHead && replayedHead !== manifestContext.data.sourceHead) {
      throw Object.assign(
        new Error(
          `Replay head mismatch: expected ${manifestContext.data.sourceHead}, got ${replayedHead}.`,
        ),
        {
          code: 'REPLAY_HEAD_MISMATCH',
          exitCode: 1,
        },
      )
    }

    const commits = runGit(['rev-list', '--reverse', `${fetchedBaseSha}..${replayedHead}`], {
      cwd: location.repoPath,
    })
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    const summaries = readCommitSubjects(location.repoPath, commits)
    validateCommitSequence(commits, manifestContext.data, expectedGroups, summaries)

    await fs.rm(outputDir, { recursive: true, force: true })
    await fs.mkdir(outputDir, { recursive: true })
    const replayPatchMeta = await comparePatchSeries(
      location.repoPath,
      fetchedBaseSha,
      replayedHead,
      artifacts,
      outputDir,
    )

    const groups = expectedGroups.map((group, index) => ({
      order: index + 1,
      id: group.id,
      message: group.message,
      replayedCommitSha: commits[index],
      sourceCommitSha: manifestContext.data.groups?.[index]?.sourceCommitSha ?? commits[index],
      patchFileName: replayPatchMeta.patchComparisons[index]?.fileName ?? null,
      patchPath: replayPatchMeta.patchComparisons[index]?.replayPath ?? null,
      patchSha256: replayPatchMeta.patchComparisons[index]?.replaySha256 ?? null,
    }))

    const report = {
      generatedAt: new Date().toISOString(),
      slice: options.sliceName,
      description: slice.description,
      sourceManifestPath: manifestContext.path,
      repoUrl,
      baseRef,
      baseFetchRef: fetchRef,
      baseSha: fetchedBaseSha,
      sourceBranch: manifestContext.data.sourceBranch,
      sourceHead: manifestContext.data.sourceHead,
      replayBranchName,
      replayedHead,
      verifyMode: options.verify,
      commitCount: commits.length,
      commits,
      bundlePath: artifacts.bundlePath,
      bundleFileName: artifacts.bundleFileName,
      bundleRefName: artifacts.bundleRefName,
      bundleSha256: artifacts.bundleSha256,
      bundleVerifyOutput,
      patchDir: replayPatchMeta.patchDir,
      patchComparisons: replayPatchMeta.patchComparisons,
      outputDir,
      verifyPassed: true,
      groups,
      cleanup,
    }

    report.outputManifestPath = await writeJsonFile(path.join(outputDir, 'manifest.json'), report)
    report.readmePath = await writeTextFile(path.join(outputDir, 'README.md'), await buildReadme(report))
    report.replaySummaryPath = await writeTextFile(
      path.join(outputDir, 'replay-summary.md'),
      buildReplaySummary(report),
    )
    if (options.writeManifest) {
      report.writeManifestPath = await writeJsonFile(options.writeManifest, report)
    }

    cleanup = await cleanupReplayRepo(location, replayBranchName)
    report.cleanup = cleanup

    return report
  } catch (error) {
    cleanup = await cleanupReplayRepo(location, replayBranchName)
    error.cleanup = cleanup
    throw error
  }
}

function printHuman(report) {
  console.log('Git slice replay')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  slice: ${report.slice}`)
  console.log(`  source_manifest_path: ${report.sourceManifestPath}`)
  console.log(`  repo_url: ${report.repoUrl}`)
  console.log(`  base_ref: ${report.baseRef}`)
  console.log(`  base_sha: ${report.baseSha}`)
  console.log(`  replay_branch_name: ${report.replayBranchName}`)
  console.log(`  replayed_head: ${report.replayedHead}`)
  console.log(`  commit_count: ${report.commitCount}`)
  console.log(`  verify_mode: ${report.verifyMode ? 'yes' : 'no'}`)
  console.log(`  verify_passed: ${report.verifyPassed ? 'yes' : 'no'}`)
  console.log(`  output_dir: ${report.outputDir}`)
  console.log(`  bundle_path: ${report.bundlePath}`)
  console.log(`  bundle_sha256: ${report.bundleSha256}`)
  console.log(`  replay_summary_path: ${report.replaySummaryPath}`)
  console.log('  groups:')
  report.groups.forEach((group) => {
    console.log(`    - ${group.order}. ${group.id}: ${group.message}`)
    console.log(`      replayed_commit_sha=${group.replayedCommitSha}`)
    console.log(`      patch_file=${path.basename(group.patchPath ?? '')}`)
  })
}

function printError(error, options) {
  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    error: error.code ?? 'GIT_SLICE_REPLAY_ERROR',
    message: error.message,
    cwd: process.cwd(),
    cleanup: error.cleanup ?? null,
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error('Git slice replay')
    console.error(`  error: ${report.error}`)
    console.error(`  message: ${report.message}`)
    console.error(`  cwd: ${report.cwd}`)
    if (report.cleanup) {
      console.error(`  cleanup: ${JSON.stringify(report.cleanup)}`)
    }
  }

  process.exit(error.exitCode ?? 1)
}

let options

try {
  options = parseArgs(process.argv.slice(2))

  if (options.listSlices) {
    const report = Object.entries(SLICES).map(([name, slice]) => ({
      name,
      description: slice.description,
      commitGroupCount: slice.commitGroups?.length ?? 0,
    }))
    if (options.json) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      report.forEach((entry) => {
        console.log(`${entry.name}\t${entry.commitGroupCount}\t${entry.description}`)
      })
    }
    process.exit(0)
  }

  const slice = ensureSlice(options.sliceName)
  if (options.listGroups) {
    const groups = slice.commitGroups.map((group, index) => ({
      order: index + 1,
      id: group.id,
      message: group.message,
      filesCount: group.files.length,
    }))
    if (options.json) {
      console.log(JSON.stringify(groups, null, 2))
    } else {
      groups.forEach((group) => {
        console.log(`${group.order}. ${group.id}\t${group.filesCount}\t${group.message}`)
      })
    }
    process.exit(0)
  }

  const report = await buildReplay(options)
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printHuman(report)
  }

  if (!report.verifyPassed) {
    process.exit(1)
  }
} catch (error) {
  printError(error, options ?? { sliceName: 'unknown', json: false })
}
