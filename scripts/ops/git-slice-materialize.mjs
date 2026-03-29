#!/usr/bin/env node

import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
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

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
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
  let baseRef = null
  let sourceRoot = null
  let branchName = null
  let branchPrefix = 'materialized'
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
      case '--base-ref':
        baseRef = argv[index + 1] ?? baseRef
        index += 1
        break
      case '--source-root':
        sourceRoot = argv[index + 1] ?? sourceRoot
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

  return {
    sliceName,
    groupId,
    baseRef,
    sourceRoot,
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
  console.log(`Usage: node scripts/ops/git-slice-materialize.mjs [options]

Options:
  --slice <name>          Slice name. Default: directory-migration-baseline
  --group <id>            Materialize a single commit group
  --base-ref <ref>        Base ref. Default: current branch upstream
  --source-root <path>    Source snapshot root. Default: current working tree
  --branch-name <name>    Materialized branch name
  --branch-prefix <name>  Prefix for auto-generated branch names. Default: materialized
  --worktree-dir <path>   Keep or create the temporary worktree at a fixed path
  --output-dir <path>     Write commit patches and manifest
  --write-manifest <path> Write manifest JSON to the given path
  --verify                Run a full ephemeral materialization and delete the branch afterwards
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
  const prefix = sanitizeBranchPart(options.branchPrefix || 'materialized')
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

  throw Object.assign(new Error('Failed to generate a unique local branch name for materialization.'), {
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
      name = 'Codex Materialize'
    }
  }
  if (!email) {
    try {
      email = runGit(['config', '--get', 'user.email'])
    } catch {
      email = 'codex-materialize@example.invalid'
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

  const tempParent = mkdtempSync(path.join(tmpdir(), 'git-slice-materialize-'))
  return {
    tempParent,
    worktreePath: path.join(tempParent, 'worktree'),
  }
}

async function ensurePathParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

async function syncFileToWorktree(rootDir, worktreePath, filePath) {
  const sourcePath = path.resolve(rootDir, filePath)
  const targetPath = path.resolve(worktreePath, filePath)

  if (existsSync(sourcePath)) {
    await ensurePathParent(targetPath)
    await fs.copyFile(sourcePath, targetPath)
    return {
      path: filePath,
      action: 'copied',
      sourcePath,
      targetPath,
    }
  }

  const existedInWorktree = existsSync(targetPath)
  if (existedInWorktree) {
    await fs.rm(targetPath, { force: true })
  }
  return {
    path: filePath,
    action: existedInWorktree ? 'removed' : 'missing',
    sourcePath,
    targetPath,
  }
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

async function materializeGroup(group, order, context) {
  const syncResults = []
  for (const filePath of group.files) {
    syncResults.push(await syncFileToWorktree(context.rootDir, context.worktreePath, filePath))
  }

  const missingSourceFiles = syncResults
    .filter((entry) => entry.action === 'missing')
    .map((entry) => entry.path)
  if (missingSourceFiles.length > 0) {
    throw Object.assign(
      new Error(`Commit group ${group.id} references files that do not exist in the source worktree: ${missingSourceFiles.join(', ')}`),
      {
        code: 'MISSING_GROUP_FILES',
        exitCode: 1,
        groupId: group.id,
        missingSourceFiles,
      },
    )
  }

  const stageTargets = syncResults
    .filter((entry) => entry.action === 'copied' || entry.action === 'removed')
    .map((entry) => entry.path)

  runGit(['add', '-A', '--', ...stageTargets], {
    cwd: context.worktreePath,
  })

  const stagedFiles = runGit(['diff', '--cached', '--name-only', '--', ...stageTargets], {
    cwd: context.worktreePath,
  })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)

  const stagedPatch = runGit(['diff', '--cached', '--binary', '--', ...stageTargets], {
    cwd: context.worktreePath,
  })

  if (stagedFiles.length === 0 || stagedPatch.length === 0) {
    throw Object.assign(
      new Error(`Commit group ${group.id} does not produce staged changes from ${context.baseRef}.`),
      {
        code: 'EMPTY_GROUP_MATERIALIZATION',
        exitCode: 1,
        groupId: group.id,
      },
    )
  }

  runGit(['commit', '-m', group.message], {
    cwd: context.worktreePath,
    env: context.commitEnv,
  })

  const commitSha = runGit(['rev-parse', 'HEAD'], {
    cwd: context.worktreePath,
  })
  const committedFiles = runGit(['show', '--name-only', '--format=', commitSha], {
    cwd: context.worktreePath,
  })
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)

  const result = {
    id: group.id,
    message: group.message,
    order,
    commitSha,
    stagedFiles,
    committedFiles,
    copiedFiles: syncResults.filter((entry) => entry.action === 'copied').map((entry) => entry.path),
    removedFiles: syncResults.filter((entry) => entry.action === 'removed').map((entry) => entry.path),
    missingSourceFiles,
    stageCommand: `git add -- ${group.files.map(shellEscape).join(' ')}`,
  }

  if (context.outputDir) {
    const patchMeta = await exportCommitPatch(
      context.worktreePath,
      commitSha,
      context.outputDir,
      order,
      group.id,
    )
    result.patchPath = patchMeta.patchPath
    result.patchBytes = patchMeta.patchBytes
  }

  return result
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
      // keep best-effort cleanup silent in the manifest cleanup block
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

async function buildMaterialization(options) {
  const slice = ensureSlice(options.sliceName)
  const coverage = ensureSliceCoverage(options.sliceName, slice)
  const selectedGroups = options.groupId
    ? [ensureGroup(slice, options.groupId)]
    : slice.commitGroups
  const baseRef = resolveUpstream(options.baseRef)
  const baseSha = runGit(['rev-parse', baseRef])
  const branchName = buildBranchName(options)
  const sourceRoot = path.resolve(options.sourceRoot ?? process.cwd())

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
    await runGitWithRetry(['worktree', 'add', '--detach', location.worktreePath, baseRef], {
      retries: 4,
      delayMs: 200,
    })
    worktreeCreated = true
    runGit(['switch', '-c', branchName, '--no-track'], {
      cwd: location.worktreePath,
    })

    const groupResults = []
    for (const [index, group] of selectedGroups.entries()) {
      groupResults.push(
        await materializeGroup(group, index + 1, {
          rootDir: sourceRoot,
          worktreePath: location.worktreePath,
          outputDir,
          baseRef,
          commitEnv,
        }),
      )
    }

    const head = runGit(['rev-parse', 'HEAD'], { cwd: location.worktreePath })
    const commits = runGit(['rev-list', '--reverse', `${baseSha}..HEAD`], {
      cwd: location.worktreePath,
    })
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)

    manifest = {
      generatedAt: new Date().toISOString(),
      slice: options.sliceName,
      description: slice.description,
      baseRef,
      baseSha,
      sourceRoot,
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
  console.log('Git slice materialize')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  slice: ${report.slice}`)
  console.log(`  description: ${report.description}`)
  console.log(`  base_ref: ${report.baseRef}`)
  console.log(`  base_sha: ${report.baseSha}`)
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
    console.log(`      commit_sha=${group.commitSha}`)
    console.log(`      staged_files=${group.stagedFiles.length}`)
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
    error: error.code ?? 'GIT_SLICE_MATERIALIZE_ERROR',
    message: error.message,
    cwd: process.cwd(),
    cleanup: error.cleanup ?? null,
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error('Git slice materialize')
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

  const report = await buildMaterialization(options)

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
