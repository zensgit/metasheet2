#!/usr/bin/env node

import fs from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
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

function isGitWorkTree() {
  try {
    return runGit(['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function shellEscape(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
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
  let groupId = null
  let sourceBranch = null
  let manifestPath = null
  let baseRef = null
  let branchName = null
  let branchPrefix = 'promoted'
  let worktreeDir = null
  let outputDir = null
  let writeManifest = null
  let json = false
  let verify = false
  let keepWorktree = false
  let listSlices = false
  let listGroups = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--slice':
        sliceName = argv[index + 1] ?? sliceName
        index += 1
        break
      case '--group':
        groupId = argv[index + 1] ?? groupId
        index += 1
        break
      case '--source-branch':
        sourceBranch = argv[index + 1] ?? sourceBranch
        index += 1
        break
      case '--manifest':
        manifestPath = argv[index + 1] ?? manifestPath
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
      case '--worktree-dir':
        worktreeDir = argv[index + 1] ?? worktreeDir
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
      case '--keep-worktree':
        keepWorktree = true
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

  if (verify && keepWorktree) {
    throw Object.assign(new Error('Use either --verify or --keep-worktree, not both.'), {
      code: 'VERIFY_KEEP_WORKTREE_CONFLICT',
      exitCode: 1,
    })
  }

  if (!sourceBranch && !manifestPath && !listSlices && !listGroups) {
    throw Object.assign(
      new Error('Provide either --source-branch or --manifest for git-slice-promote.'),
      {
        code: 'SOURCE_BRANCH_REQUIRED',
        exitCode: 1,
      },
    )
  }

  return {
    sliceName,
    groupId,
    sourceBranch,
    manifestPath,
    baseRef,
    branchName,
    branchPrefix,
    worktreeDir,
    outputDir,
    writeManifest,
    json,
    verify,
    keepWorktree,
    listSlices,
    listGroups,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-promote.mjs [options]

Options:
  --slice <name>          Slice name. Default: directory-migration-baseline
  --group <id>            Promote a single commit group
  --source-branch <name>  Materialized source branch to replay
  --manifest <path>       Materialize manifest/report with branchName + baseRef
  --base-ref <ref>        Base ref. Default: current branch upstream or manifest baseRef
  --branch-name <name>    Promoted branch name
  --branch-prefix <name>  Prefix for auto-generated promoted branches. Default: promoted
  --worktree-dir <path>   Keep or create the temporary worktree at a fixed path
  --output-dir <path>     Write per-group promoted patches and manifest
  --write-manifest <path> Write manifest JSON to the given path
  --verify                Run a full ephemeral promotion and delete the branch afterwards
  --keep-worktree         Keep the generated worktree on disk for inspection
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

function ensureGroup(slice, groupId) {
  const group = slice.commitGroups.find((entry) => entry.id === groupId)
  if (!group) {
    throw Object.assign(new Error(`Unknown commit group: ${groupId}`), {
      code: 'UNKNOWN_COMMIT_GROUP',
      exitCode: 1,
    })
  }
  return group
}

function buildSliceCoverage(slice) {
  const sliceFiles = uniqueSorted(slice.files)
  const fileCounts = new Map()

  for (const group of slice.commitGroups) {
    for (const filePath of group.files) {
      fileCounts.set(filePath, (fileCounts.get(filePath) ?? 0) + 1)
    }
  }

  const assigned = uniqueSorted([...fileCounts.keys()])
  const duplicates = [...fileCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([filePath, count]) => ({ path: filePath, count }))
  const unassigned = sliceFiles.filter((filePath) => !fileCounts.has(filePath))
  const extra = assigned.filter((filePath) => !sliceFiles.includes(filePath))

  return {
    sliceFiles,
    duplicates,
    unassigned,
    extra,
    complete: duplicates.length === 0 && unassigned.length === 0 && extra.length === 0,
  }
}

function ensureSliceCoverage(sliceName, slice) {
  const coverage = buildSliceCoverage(slice)
  if (!coverage.complete) {
    throw Object.assign(
      new Error(
        `Slice ${sliceName} has incomplete commit groups (duplicates=${coverage.duplicates.length}, unassigned=${coverage.unassigned.length}, extra=${coverage.extra.length}).`,
      ),
      {
        code: 'INVALID_SLICE_COVERAGE',
        exitCode: 1,
        coverage,
      },
    )
  }
  return coverage
}

function resolveUpstream(explicitBaseRef) {
  if (explicitBaseRef) {
    return explicitBaseRef
  }

  try {
    const upstream = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    if (!upstream) {
      throw new Error('Missing upstream')
    }
    return upstream
  } catch {
    throw Object.assign(new Error('Current branch does not have an upstream tracking branch.'), {
      code: 'NO_UPSTREAM',
      exitCode: 1,
    })
  }
}

function ensureBranchAvailable(branchName) {
  if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])) {
    throw Object.assign(new Error(`Local branch already exists: ${branchName}`), {
      code: 'BRANCH_ALREADY_EXISTS',
      exitCode: 1,
    })
  }
}

function buildAutoBranchName(options) {
  const prefix = sanitizeBranchPart(options.branchPrefix || 'promoted')
  const slicePart = sanitizeBranchPart(options.sliceName)
  const nonce = randomBytes(3).toString('hex')
  return `${prefix}/${slicePart}-${timestampSlug()}-${process.pid}-${nonce}`
}

function buildBranchName(options) {
  if (options.branchName) {
    ensureBranchAvailable(options.branchName)
    return options.branchName
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = buildAutoBranchName(options)
    if (!gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`])) {
      return candidate
    }
  }

  throw Object.assign(new Error('Failed to generate a unique local branch name for promotion.'), {
    code: 'AUTO_BRANCH_NAME_COLLISION',
    exitCode: 1,
  })
}

function resolveCommitIdentity() {
  let name = process.env.GIT_AUTHOR_NAME ?? ''
  let email = process.env.GIT_AUTHOR_EMAIL ?? ''

  if (!name) {
    try {
      name = runGit(['config', '--get', 'user.name'])
    } catch {
      name = 'Codex Promote'
    }
  }
  if (!email) {
    try {
      email = runGit(['config', '--get', 'user.email'])
    } catch {
      email = 'codex-promote@example.invalid'
    }
  }

  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? name,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? email,
  }
}

function isConfigLockError(error) {
  const message = `${error?.message ?? ''}\n${error?.stderr ?? ''}`
  return message.includes('could not lock config file .git/config: File exists')
}

async function runGitWithRetry(args, extra = {}) {
  const retries = extra.retries ?? 0
  const delayMs = extra.delayMs ?? 150

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return runGit(args, extra)
    } catch (error) {
      if (attempt >= retries || !isConfigLockError(error)) {
        throw error
      }
      await sleep(delayMs * (attempt + 1))
    }
  }

  return ''
}

function createWorktreeLocation(worktreeDir) {
  if (worktreeDir) {
    return {
      tempParent: null,
      worktreePath: path.resolve(worktreeDir),
    }
  }

  const tempParent = mkdtempSync(path.join(tmpdir(), 'git-slice-promote-'))
  return {
    tempParent,
    worktreePath: path.join(tempParent, 'worktree'),
  }
}

async function writeJsonFile(filePath, payload) {
  const resolvedPath = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return resolvedPath
}

async function cleanupWorktree(worktreePath, tempParent, branchName, deleteBranch) {
  const cleanup = {
    worktreeRemoved: false,
    branchDeleted: false,
    tempParentRemoved: false,
  }

  if (worktreePath && existsSync(worktreePath)) {
    try {
      runGit(['worktree', 'remove', '--force', worktreePath])
      cleanup.worktreeRemoved = true
    } catch {
      // best effort
    }
  }

  if (deleteBranch && branchName) {
    try {
      runGit(['branch', '-D', branchName])
      cleanup.branchDeleted = true
    } catch {
      // best effort
    }
  }

  if (tempParent && existsSync(tempParent)) {
    try {
      await fs.rm(tempParent, { recursive: true, force: true })
      cleanup.tempParentRemoved = true
    } catch {
      // best effort
    }
  }

  return cleanup
}

async function exportCommitPatch(worktreePath, commitSha, exportDir, order, groupId) {
  await fs.mkdir(exportDir, { recursive: true })
  const patchOutput = runGit(['format-patch', '--stdout', '--full-index', '--binary', '--abbrev=40', '-1', commitSha], {
    cwd: worktreePath,
  })
  const fileName = `${String(order).padStart(2, '0')}-${groupId}.patch`
  const patchPath = path.join(exportDir, fileName)
  await fs.writeFile(patchPath, patchOutput, 'utf8')
  return {
    patchPath,
    patchBytes: Buffer.byteLength(patchOutput, 'utf8'),
  }
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
    data: parsed,
  }
}

function readCommitSubjects(commits) {
  return commits.map((commitSha) => ({
    sha: commitSha,
    message: runGit(['show', '--quiet', '--format=%s', commitSha]),
  }))
}

function zipSelectedSourceCommits(slice, selectedGroups, sourceSummaries) {
  const fullGroups = slice.commitGroups

  const fullSliceMatch =
    sourceSummaries.length === fullGroups.length &&
    fullGroups.every((group, index) => sourceSummaries[index]?.message === group.message)

  if (fullSliceMatch) {
    return {
      mappingMode: 'full-slice',
      selected: selectedGroups.map((group) => {
        const groupIndex = fullGroups.findIndex((entry) => entry.id === group.id)
        return {
          group,
          source: sourceSummaries[groupIndex],
        }
      }),
    }
  }

  const selectedMatch =
    sourceSummaries.length === selectedGroups.length &&
    selectedGroups.every((group, index) => sourceSummaries[index]?.message === group.message)

  if (selectedMatch) {
    return {
      mappingMode: 'selected-groups',
      selected: selectedGroups.map((group, index) => ({
        group,
        source: sourceSummaries[index],
      })),
    }
  }

  throw Object.assign(
    new Error(
      `Source branch layout does not match slice commit groups for ${slice.description ?? slice}.`,
    ),
    {
      code: 'SOURCE_BRANCH_LAYOUT_MISMATCH',
      exitCode: 1,
      expectedMessages: fullGroups.map((group) => group.message),
      actualMessages: sourceSummaries.map((entry) => entry.message),
      selectedGroupMessages: selectedGroups.map((group) => group.message),
    },
  )
}

async function resolveSourceContext(options, slice, selectedGroups) {
  let manifest = null
  let sourceBranch = options.sourceBranch
  let baseRef = options.baseRef

  if (options.manifestPath) {
    manifest = await loadManifest(options.manifestPath, options.sliceName)
    sourceBranch = sourceBranch ?? manifest.data.branchName ?? null
    baseRef = baseRef ?? manifest.data.baseRef ?? null
  }

  if (!sourceBranch) {
    throw Object.assign(
      new Error('Unable to resolve source branch. Provide --source-branch or --manifest.'),
      {
        code: 'SOURCE_BRANCH_REQUIRED',
        exitCode: 1,
      },
    )
  }

  const resolvedBaseRef = resolveUpstream(baseRef)
  const baseSha = runGit(['rev-parse', resolvedBaseRef])

  if (!gitSucceeds(['rev-parse', '--verify', `${sourceBranch}^{commit}`])) {
    throw Object.assign(new Error(`Source branch does not exist: ${sourceBranch}`), {
      code: 'UNKNOWN_SOURCE_BRANCH',
      exitCode: 1,
    })
  }

  const sourceHead = runGit(['rev-parse', sourceBranch])
  if (!gitSucceeds(['merge-base', '--is-ancestor', baseSha, sourceHead])) {
    throw Object.assign(
      new Error(`Source branch ${sourceBranch} is not based on ${resolvedBaseRef}.`),
      {
        code: 'SOURCE_BRANCH_BASE_MISMATCH',
        exitCode: 1,
      },
    )
  }

  const sourceCommits = runGit(['rev-list', '--reverse', `${baseSha}..${sourceBranch}`])
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)

  if (sourceCommits.length === 0) {
    throw Object.assign(new Error(`Source branch ${sourceBranch} has no commits on top of ${resolvedBaseRef}.`), {
      code: 'SOURCE_BRANCH_HAS_NO_COMMITS',
      exitCode: 1,
    })
  }

  const sourceSummaries = readCommitSubjects(sourceCommits)
  const mapping = zipSelectedSourceCommits(slice, selectedGroups, sourceSummaries)

  return {
    manifestPath: manifest?.path ?? null,
    manifest: manifest?.data ?? null,
    sourceBranch,
    sourceHead,
    baseRef: resolvedBaseRef,
    baseSha,
    sourceCommits,
    sourceSummaries,
    mappingMode: mapping.mappingMode,
    selected: mapping.selected,
  }
}

async function cherryPickGroup(selection, order, context) {
  const sourceCommitSha = selection.source.sha
  const sourceMessage = selection.source.message

  try {
    runGit(['cherry-pick', sourceCommitSha], {
      cwd: context.worktreePath,
      env: context.commitEnv,
    })
  } catch (error) {
    try {
      runGit(['cherry-pick', '--abort'], { cwd: context.worktreePath })
    } catch {
      // best effort
    }

    throw Object.assign(
      new Error(
        `Failed to cherry-pick ${sourceCommitSha} for group ${selection.group.id}: ${error.message}`,
      ),
      {
        code: 'PROMOTE_CHERRY_PICK_FAILED',
        exitCode: 1,
        groupId: selection.group.id,
        sourceCommitSha,
      },
    )
  }

  const promotedCommitSha = runGit(['rev-parse', 'HEAD'], {
    cwd: context.worktreePath,
  })
  const committedFiles = runGit(['show', '--name-only', '--format=', promotedCommitSha], {
    cwd: context.worktreePath,
  })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)

  const result = {
    id: selection.group.id,
    message: selection.group.message,
    sourceCommitSha,
    sourceMessage,
    order,
    promotedCommitSha,
    committedFiles,
    cherryPickCommand: `git cherry-pick ${shellEscape(sourceCommitSha)}`,
  }

  if (context.outputDir) {
    const patchMeta = await exportCommitPatch(
      context.worktreePath,
      promotedCommitSha,
      context.outputDir,
      order,
      selection.group.id,
    )
    result.patchPath = patchMeta.patchPath
    result.patchBytes = patchMeta.patchBytes
  }

  return result
}

async function buildPromotion(options) {
  const slice = ensureSlice(options.sliceName)
  const coverage = ensureSliceCoverage(options.sliceName, slice)
  const selectedGroups = options.groupId
    ? [ensureGroup(slice, options.groupId)]
    : slice.commitGroups
  const sourceContext = await resolveSourceContext(options, slice, selectedGroups)
  const branchName = buildBranchName(options)
  const location = createWorktreeLocation(options.worktreeDir)
  const commitEnv = resolveCommitIdentity()
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : null

  let cleanup = {
    worktreeRemoved: false,
    branchDeleted: false,
    tempParentRemoved: false,
  }
  let manifest
  let worktreeCreated = false

  try {
    await runGitWithRetry(['worktree', 'add', '--detach', location.worktreePath, sourceContext.baseRef], {
      retries: 4,
      delayMs: 200,
    })
    worktreeCreated = true
    runGit(['switch', '-c', branchName, '--no-track'], {
      cwd: location.worktreePath,
    })

    const groupResults = []
    for (const [index, selection] of sourceContext.selected.entries()) {
      groupResults.push(
        await cherryPickGroup(selection, index + 1, {
          worktreePath: location.worktreePath,
          outputDir,
          commitEnv,
        }),
      )
    }

    const head = runGit(['rev-parse', 'HEAD'], { cwd: location.worktreePath })
    const commits = runGit(['rev-list', '--reverse', `${sourceContext.baseSha}..HEAD`], {
      cwd: location.worktreePath,
    })
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)

    manifest = {
      generatedAt: new Date().toISOString(),
      slice: options.sliceName,
      description: slice.description,
      baseRef: sourceContext.baseRef,
      baseSha: sourceContext.baseSha,
      sourceBranch: sourceContext.sourceBranch,
      sourceHead: sourceContext.sourceHead,
      sourceManifestPath: sourceContext.manifestPath,
      sourceCommitCount: sourceContext.sourceCommits.length,
      selectedSourceCommitCount: sourceContext.selected.length,
      sourceMappingMode: sourceContext.mappingMode,
      branchName,
      head,
      verifyMode: options.verify,
      keepWorktree: options.keepWorktree,
      selectedGroupsCount: selectedGroups.length,
      sliceFilesCount: coverage.sliceFiles.length,
      coverage: {
        complete: coverage.complete,
        duplicateAssignments: coverage.duplicates,
        unassignedFiles: coverage.unassigned,
        extraFiles: coverage.extra,
      },
      commitCount: commits.length,
      commits,
      worktreePath: options.keepWorktree ? location.worktreePath : null,
      outputDir,
      verifyPassed: groupResults.length === selectedGroups.length && commits.length === selectedGroups.length,
      groups: groupResults,
      cleanup,
    }

    if (outputDir) {
      manifest.outputManifestPath = await writeJsonFile(path.join(outputDir, 'manifest.json'), manifest)
    }
    if (options.writeManifest) {
      manifest.writeManifestPath = await writeJsonFile(options.writeManifest, manifest)
    }

    if (!options.keepWorktree) {
      cleanup = await cleanupWorktree(location.worktreePath, location.tempParent, branchName, options.verify)
      manifest.cleanup = cleanup
      manifest.worktreePath = null
    }

    return manifest
  } catch (error) {
    if (worktreeCreated && !options.keepWorktree) {
      cleanup = await cleanupWorktree(location.worktreePath, location.tempParent, branchName, true)
    }
    error.cleanup = cleanup
    throw error
  }
}

function printHuman(report) {
  console.log('Git slice promote')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  slice: ${report.slice}`)
  console.log(`  description: ${report.description}`)
  console.log(`  base_ref: ${report.baseRef}`)
  console.log(`  base_sha: ${report.baseSha}`)
  console.log(`  source_branch: ${report.sourceBranch}`)
  console.log(`  source_head: ${report.sourceHead}`)
  console.log(`  source_mapping_mode: ${report.sourceMappingMode}`)
  console.log(`  branch_name: ${report.branchName}`)
  console.log(`  head: ${report.head}`)
  console.log(`  verify_mode: ${report.verifyMode ? 'yes' : 'no'}`)
  console.log(`  keep_worktree: ${report.keepWorktree ? 'yes' : 'no'}`)
  console.log(`  commit_count: ${report.commitCount}`)
  console.log(`  verify_passed: ${report.verifyPassed ? 'yes' : 'no'}`)
  if (report.outputDir) {
    console.log(`  output_dir: ${report.outputDir}`)
  }
  if (report.outputManifestPath) {
    console.log(`  output_manifest_path: ${report.outputManifestPath}`)
  }
  if (report.writeManifestPath) {
    console.log(`  write_manifest_path: ${report.writeManifestPath}`)
  }
  console.log('  groups:')
  report.groups.forEach((group) => {
    console.log(`    - ${group.order}. ${group.id}: ${group.message}`)
    console.log(`      source_commit_sha=${group.sourceCommitSha}`)
    console.log(`      promoted_commit_sha=${group.promotedCommitSha}`)
    console.log(`      committed_files=${group.committedFiles.length}`)
    if (group.patchPath) {
      console.log(`      patch_path=${group.patchPath}`)
    }
  })
  console.log('  cleanup:')
  console.log(`    worktree_removed=${report.cleanup.worktreeRemoved ? 'yes' : 'no'}`)
  console.log(`    branch_deleted=${report.cleanup.branchDeleted ? 'yes' : 'no'}`)
  console.log(`    temp_parent_removed=${report.cleanup.tempParentRemoved ? 'yes' : 'no'}`)
}

function printError(error, options) {
  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    error: error.code ?? 'GIT_SLICE_PROMOTE_ERROR',
    message: error.message,
    cwd: process.cwd(),
    cleanup: error.cleanup ?? null,
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error('Git slice promote')
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

  if (!isGitWorkTree()) {
    throw Object.assign(new Error('Current working directory is not a Git working tree.'), {
      code: 'NOT_A_GIT_REPOSITORY',
      exitCode: 2,
    })
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

  const report = await buildPromotion(options)

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
