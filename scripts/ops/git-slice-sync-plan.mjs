#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { SLICES } from './git-slices.mjs'

function runGit(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
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

function normalizePath(filePath) {
  return filePath.replace(/^[^A-Za-z0-9._-]+\s*/, '').trim()
}

function parseStatusLine(line) {
  const indexStatus = line[0] ?? ' '
  const worktreeStatus = line[1] ?? ' '
  const filePath = normalizePath(line.slice(3))

  return {
    raw: line,
    indexStatus,
    worktreeStatus,
    filePath,
    untracked: indexStatus === '?' && worktreeStatus === '?',
  }
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function intersectPaths(left, right) {
  const rightSet = new Set(right)
  return left.filter((filePath) => rightSet.has(filePath))
}

function subtractPaths(left, right) {
  const rightSet = new Set(right)
  return left.filter((filePath) => !rightSet.has(filePath))
}

function bucketForPath(filePath) {
  if (filePath.startsWith('packages/')) return 'packages'
  if (filePath.startsWith('docs/')) return 'docs'
  if (filePath.startsWith('scripts/')) return 'scripts'
  if (filePath.startsWith('apps/')) return 'apps'
  if (filePath.startsWith('plugins/')) return 'plugins'
  if (filePath.startsWith('docker/')) return 'docker'
  return 'root'
}

function summarizePathBuckets(files) {
  const buckets = new Map()

  for (const file of files) {
    const bucket = bucketForPath(file)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }

  return Object.fromEntries([...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function ensureSlice(sliceName) {
  const slice = SLICES[sliceName]
  if (!slice) {
    throw Object.assign(new Error(`Unknown slice: ${sliceName}`), {
      code: 'UNKNOWN_SLICE',
      exitCode: 1,
    })
  }
  return slice
}

function resolveUpstream(explicitUpstream) {
  if (explicitUpstream) {
    return explicitUpstream
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

function collectCommitFiles(commit, sliceFilesSet) {
  const output = runGit(['show', '--name-only', '--format=%H%x09%s', commit])
  const lines = output.split('\n')
  const header = lines[0] ?? ''
  const [sha, subject = ''] = header.split('\t')
  const files = lines
    .slice(1)
    .map((value) => value.trim())
    .filter(Boolean)
  const overlapFiles = uniqueSorted(files.filter((file) => sliceFilesSet.has(file)))

  return {
    sha,
    subject,
    files,
    overlapFiles,
  }
}

function collectDirtyStatus(sliceFiles) {
  const output = runGit(['status', '--short', '--', ...sliceFiles])
  const lines = output.split('\n').filter(Boolean)
  const files = lines.map(parseStatusLine)
  const trackedChanged = files.filter((file) => !file.untracked).map((file) => file.filePath)
  const untracked = files.filter((file) => file.untracked).map((file) => file.filePath)

  return {
    files,
    dirtyPaths: uniqueSorted(files.map((file) => file.filePath)),
    trackedChangedPaths: uniqueSorted(trackedChanged),
    untrackedPaths: uniqueSorted(untracked),
  }
}

function buildSuggestions(plan) {
  const suggestions = []

  if (plan.stageReadiness.safeToStage) {
    suggestions.push('当前切片与 upstream behind 提交无路径重叠，可先独立 stage 或导出 patch。')
  } else {
    suggestions.push('当前切片与 upstream behind 提交存在路径重叠，先处理 upstream 再收口该切片。')
  }

  if (!plan.syncReadiness.githubSyncReady) {
    suggestions.push('当前分支仍然落后 upstream，暂时不能宣称代码已与 GitHub 同步。')
  }

  if (plan.localDirtyPaths.length > 0) {
    suggestions.push('优先用 stage command 固化当前切片 dirty 文件，避免与其他 200+ 脏改动继续混杂。')
  }

  if (plan.localAheadOverlapPaths.length > 0) {
    suggestions.push('本地 ahead 提交已经触及切片路径，整理提交时应保留既有提交意图，不要把切片和其他功能改动硬拼在一起。')
  }

  if (plan.patch?.path) {
    suggestions.push(`已导出 patch：${plan.patch.path}，可作为切片交接或归档证据。`)
  }

  return suggestions
}

async function maybeWritePatch(sliceFiles, patchFile) {
  if (!patchFile) {
    return null
  }

  const output = runGit(['diff', '--binary', '--no-ext-diff', '--', ...sliceFiles])
  const patchPath = path.resolve(patchFile)
  await fs.mkdir(path.dirname(patchPath), { recursive: true })
  await fs.writeFile(patchPath, output, 'utf8')

  return {
    path: patchPath,
    bytes: Buffer.byteLength(output, 'utf8'),
    empty: output.length === 0,
  }
}

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let upstream = null
  let json = false
  let verify = false
  let patchFile = null
  let stageCommand = false
  let listSlices = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--slice':
        sliceName = argv[index + 1] ?? sliceName
        index += 1
        break
      case '--upstream':
        upstream = argv[index + 1] ?? upstream
        index += 1
        break
      case '--json':
        json = true
        break
      case '--verify':
        verify = true
        break
      case '--patch-file':
        patchFile = argv[index + 1] ?? patchFile
        index += 1
        break
      case '--stage-command':
        stageCommand = true
        break
      case '--list-slices':
        listSlices = true
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { sliceName, upstream, json, verify, patchFile, stageCommand, listSlices }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-sync-plan.mjs [options]

Options:
  --slice <name>         Slice name. Default: directory-migration-baseline
  --upstream <ref>       Upstream ref. Default: branch upstream
  --list-slices          Print available slices
  --json                 Print JSON
  --verify               Exit non-zero when GitHub sync is not yet ready
  --patch-file <path>    Write binary-safe patch for the slice
  --stage-command        Print the git add command for the slice
  --help, -h             Show help`)
}

async function buildSyncPlan(options) {
  const slice = ensureSlice(options.sliceName)
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const upstream = resolveUpstream(options.upstream)
  const head = runGit(['rev-parse', 'HEAD'])
  const mergeBase = runGit(['merge-base', 'HEAD', upstream])
  const upstreamOnly = runGit(['rev-list', '--reverse', `HEAD..${upstream}`]).split('\n').filter(Boolean)
  const localOnly = runGit(['rev-list', '--reverse', `${upstream}..HEAD`]).split('\n').filter(Boolean)
  const sliceFiles = [...slice.files]
  const sliceFilesSet = new Set(sliceFiles)

  const dirtyStatus = collectDirtyStatus(sliceFiles)
  const upstreamBehindCommits = upstreamOnly.map((commit) => collectCommitFiles(commit, sliceFilesSet))
  const localAheadCommits = localOnly.map((commit) => collectCommitFiles(commit, sliceFilesSet))

  const upstreamBehindSliceCommits = upstreamBehindCommits.filter((commit) => commit.overlapFiles.length > 0)
  const localAheadSliceCommits = localAheadCommits.filter((commit) => commit.overlapFiles.length > 0)
  const upstreamBehindPaths = uniqueSorted(
    upstreamBehindSliceCommits.flatMap((commit) => commit.overlapFiles),
  )
  const localAheadOverlapPaths = uniqueSorted(
    localAheadSliceCommits.flatMap((commit) => commit.overlapFiles),
  )
  const localTouchedPaths = uniqueSorted([
    ...dirtyStatus.dirtyPaths,
    ...localAheadOverlapPaths,
  ])
  const overlapPaths = intersectPaths(localTouchedPaths, upstreamBehindPaths)
  const upstreamOnlyPaths = subtractPaths(upstreamBehindPaths, localTouchedPaths)
  const localOnlyPaths = subtractPaths(localTouchedPaths, upstreamBehindPaths)
  const patch = await maybeWritePatch(sliceFiles, options.patchFile)

  const plan = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    description: slice.description,
    branch,
    upstream,
    head,
    mergeBase,
    divergence: {
      upstreamOnlyCount: upstreamOnly.length,
      localOnlyCount: localOnly.length,
    },
    sliceFilesCount: sliceFiles.length,
    sliceBuckets: summarizePathBuckets(sliceFiles),
    dirtyStatus: {
      changedCount: dirtyStatus.dirtyPaths.length,
      trackedChangedCount: dirtyStatus.trackedChangedPaths.length,
      untrackedCount: dirtyStatus.untrackedPaths.length,
    },
    localDirtyPaths: dirtyStatus.dirtyPaths,
    localTrackedChangedPaths: dirtyStatus.trackedChangedPaths,
    localUntrackedPaths: dirtyStatus.untrackedPaths,
    localAheadOverlapCount: localAheadSliceCommits.length,
    upstreamBehindOverlapCount: upstreamBehindSliceCommits.length,
    localAheadOverlapPaths,
    upstreamBehindPaths,
    overlapPaths,
    upstreamOnlyPaths,
    localOnlyPaths,
    upstreamBehindCommits,
    upstreamBehindSliceCommits,
    localAheadCommits,
    localAheadSliceCommits,
    stageCommand: `git add -- ${sliceFiles.map(shellEscape).join(' ')}`,
    patch,
    stageReadiness: {
      safeToStage: overlapPaths.length === 0,
      reason:
        overlapPaths.length === 0
          ? 'No upstream-behind paths overlap the current local slice changes.'
          : 'Some upstream-behind paths overlap the current local slice changes.',
    },
    syncReadiness: {
      githubSyncReady: overlapPaths.length === 0 && upstreamOnly.length === 0,
      reason:
        overlapPaths.length > 0
          ? 'Local slice changes overlap paths touched by upstream-behind commits.'
          : upstreamOnly.length > 0
            ? 'Current branch is still behind upstream.'
            : 'No upstream-behind commits remain for this branch.',
    },
  }

  plan.verifyPassed = plan.syncReadiness.githubSyncReady
  plan.suggestions = buildSuggestions(plan)
  return plan
}

function printHuman(plan) {
  console.log('Git slice sync plan')
  console.log(`  generated_at: ${plan.generatedAt}`)
  console.log(`  slice: ${plan.slice}`)
  console.log(`  description: ${plan.description}`)
  console.log(`  branch: ${plan.branch}`)
  console.log(`  upstream: ${plan.upstream}`)
  console.log(`  head: ${plan.head}`)
  console.log(`  merge_base: ${plan.mergeBase}`)
  console.log(`  divergence: upstream_only=${plan.divergence.upstreamOnlyCount} local_only=${plan.divergence.localOnlyCount}`)
  console.log(`  slice_files: ${plan.sliceFilesCount}`)
  console.log('  slice_buckets:')
  for (const [bucket, count] of Object.entries(plan.sliceBuckets)) {
    console.log(`    - ${bucket}: ${count}`)
  }
  console.log(`  local_dirty: ${plan.dirtyStatus.changedCount} (tracked=${plan.dirtyStatus.trackedChangedCount}, untracked=${plan.dirtyStatus.untrackedCount})`)
  console.log(`  upstream_overlap_commits: ${plan.upstreamBehindOverlapCount}`)
  console.log(`  local_ahead_overlap_commits: ${plan.localAheadOverlapCount}`)
  if (plan.localDirtyPaths.length > 0) {
    console.log('  local_dirty_paths:')
    plan.localDirtyPaths.forEach((file) => console.log(`    - ${file}`))
  }
  if (plan.upstreamBehindPaths.length > 0) {
    console.log('  upstream_behind_paths:')
    plan.upstreamBehindPaths.forEach((file) => console.log(`    - ${file}`))
  }
  if (plan.localAheadOverlapPaths.length > 0) {
    console.log('  local_ahead_overlap_paths:')
    plan.localAheadOverlapPaths.forEach((file) => console.log(`    - ${file}`))
  }
  console.log(`  overlap_paths: ${plan.overlapPaths.length}`)
  if (plan.overlapPaths.length > 0) {
    plan.overlapPaths.forEach((file) => console.log(`    - ${file}`))
  }
  console.log(`  stage_ready: ${plan.stageReadiness.safeToStage ? 'yes' : 'no'}`)
  console.log(`  github_sync_ready: ${plan.syncReadiness.githubSyncReady ? 'yes' : 'no'}`)
  console.log(`  stage_command: ${plan.stageCommand}`)
  if (plan.patch) {
    console.log(`  patch: ${plan.patch.path} (${plan.patch.bytes} bytes${plan.patch.empty ? ', empty' : ''})`)
  }
  console.log(`  verify_passed: ${plan.verifyPassed ? 'yes' : 'no'}`)
  console.log('  suggestions:')
  for (const suggestion of plan.suggestions) {
    console.log(`    - ${suggestion}`)
  }
}

function printError(error, options) {
  const errorReport = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    error: error.code ?? 'GIT_SLICE_SYNC_PLAN_ERROR',
    message: error.message,
    cwd: process.cwd(),
  }

  if (options.stageCommand) {
    console.error(errorReport.message)
  } else if (options.json) {
    console.log(JSON.stringify(errorReport, null, 2))
  } else {
    console.error('Git slice sync plan')
    console.error(`  error: ${errorReport.error}`)
    console.error(`  message: ${errorReport.message}`)
    console.error(`  cwd: ${errorReport.cwd}`)
  }

  process.exit(error.exitCode ?? 1)
}

let options

try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  printError(error, {
    sliceName: 'directory-migration-baseline',
    json: process.argv.includes('--json'),
    stageCommand: process.argv.includes('--stage-command'),
  })
}

if (options.listSlices) {
  console.log(Object.keys(SLICES).join('\n'))
  process.exit(0)
}

if (!isGitWorkTree()) {
  printError(
    Object.assign(new Error('Current working directory is not a Git working tree.'), {
      code: 'NOT_A_GIT_REPOSITORY',
      exitCode: 2,
    }),
    options,
  )
}

try {
  const plan = await buildSyncPlan(options)

  if (options.stageCommand) {
    console.log(plan.stageCommand)
  } else if (options.json) {
    console.log(JSON.stringify(plan, null, 2))
  } else {
    printHuman(plan)
  }

  if (options.verify && !plan.verifyPassed) {
    process.exit(1)
  }
} catch (error) {
  printError(error, options)
}
