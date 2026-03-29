#!/usr/bin/env node

import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
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

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function parseArgs(argv) {
  let sliceName = 'directory-migration-baseline'
  let groupId = null
  let sourceBranch = null
  let manifestPath = null
  let baseRef = null
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

  if (!sourceBranch && !manifestPath && !listSlices && !listGroups) {
    throw Object.assign(
      new Error('Provide either --source-branch or --manifest for git-slice-handoff.'),
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
    outputDir,
    writeManifest,
    json,
    verify,
    listSlices,
    listGroups,
  }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-slice-handoff.mjs [options]

Options:
  --slice <name>          Slice name. Default: directory-migration-baseline
  --group <id>            Build handoff for a single commit group
  --source-branch <name>  Promoted source branch to package
  --manifest <path>       Promote manifest/report with branchName + baseRef
  --base-ref <ref>        Base ref. Default: current branch upstream or manifest baseRef
  --output-dir <path>     Write handoff bundle, patch series, README, and manifest
  --write-manifest <path> Write manifest JSON to the given path
  --verify                Run full handoff validation and mark output as verify artifacts
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

async function writeTextFile(filePath, contents) {
  const resolvedPath = path.resolve(filePath)
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true })
  await fs.writeFile(resolvedPath, contents, 'utf8')
  return resolvedPath
}

async function writeJsonFile(filePath, payload) {
  return writeTextFile(filePath, `${JSON.stringify(payload, null, 2)}\n`)
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

function resolveRepoUrl() {
  try {
    return runGit(['remote', 'get-url', 'origin'])
  } catch {
    return null
  }
}

function readCommitSubjects(commits) {
  return commits.map((commitSha, index) => ({
    order: index + 1,
    sha: commitSha,
    message: runGit(['show', '--quiet', '--format=%s', commitSha]),
  }))
}

function mapSelectedGroups(slice, selectedGroups, sourceSummaries, manifestGroups) {
  const fullGroups = slice.commitGroups

  const fullSliceMatch =
    sourceSummaries.length === fullGroups.length &&
    fullGroups.every((group, index) => sourceSummaries[index]?.message === group.message)

  if (selectedGroups.length !== fullGroups.length && fullSliceMatch) {
    throw Object.assign(
      new Error(
        'Selected group handoff requires a source branch or manifest already narrowed to that group; full-slice source branches must be handed off as a whole.',
      ),
      {
        code: 'GROUP_HANDOFF_REQUIRES_GROUP_SOURCE',
        exitCode: 1,
        selectedGroupIds: selectedGroups.map((group) => group.id),
        sourceGroupCount: sourceSummaries.length,
      },
    )
  }

  const selectedMatch =
    sourceSummaries.length === selectedGroups.length &&
    selectedGroups.every((group, index) => sourceSummaries[index]?.message === group.message)

  if (!fullSliceMatch && !selectedMatch) {
    throw Object.assign(
      new Error(`Source branch layout does not match slice commit groups for ${slice.description}.`),
      {
        code: 'SOURCE_BRANCH_LAYOUT_MISMATCH',
        exitCode: 1,
        expectedMessages: fullGroups.map((group) => group.message),
        actualMessages: sourceSummaries.map((entry) => entry.message),
      },
    )
  }

  const manifestById = new Map((manifestGroups ?? []).map((group) => [group.id, group]))
  const mappingMode = fullSliceMatch ? 'full-slice' : 'selected-groups'

  return selectedGroups.map((group) => {
    const sourceIndex = fullSliceMatch
      ? fullGroups.findIndex((entry) => entry.id === group.id)
      : selectedGroups.findIndex((entry) => entry.id === group.id)
    const source = sourceSummaries[sourceIndex]
    const manifestGroup = manifestById.get(group.id) ?? null
    const expectedSourceCommitSha =
      manifestGroup?.promotedCommitSha ?? manifestGroup?.commitSha ?? source.sha

    if (manifestGroup && expectedSourceCommitSha !== source.sha) {
      throw Object.assign(
        new Error(
          `Manifest/source mismatch for group ${group.id}: expected ${expectedSourceCommitSha}, got ${source.sha}.`,
        ),
        {
          code: 'HANDOFF_MANIFEST_MISMATCH',
          exitCode: 1,
          groupId: group.id,
          expectedSourceCommitSha,
          actualSourceCommitSha: source.sha,
        },
      )
    }

    return {
      group,
      source,
      manifestGroup,
      mappingMode,
    }
  })
}

async function hashFile(filePath) {
  const bytes = await fs.readFile(filePath)
  return createHash('sha256').update(bytes).digest('hex')
}

async function buildReadme(report) {
  const lines = [
    `# Git Slice Handoff: ${report.slice}`,
    '',
    `- Source branch: \`${report.sourceBranch}\``,
    `- Source head: \`${report.sourceHead}\``,
    `- Base ref: \`${report.baseRef}\``,
    `- Base SHA: \`${report.baseSha}\``,
    `- Commit count: \`${report.commitCount}\``,
    `- Bundle path: \`${report.bundlePath}\``,
    `- Bundle SHA-256: \`${report.bundleSha256}\``,
    '',
    '## Suggested verification',
    '',
    '```bash',
    `git bundle verify ${shellEscape(report.bundlePath)}`,
    `git log --oneline ${shellEscape(`${report.baseSha}..${report.sourceBranch}`)}`,
    '```',
    '',
    '## Group mapping',
    '',
  ]

  for (const group of report.groups) {
    lines.push(`- ${group.order}. \`${group.id}\``)
    lines.push(`  source: \`${group.sourceCommitSha}\``)
    lines.push(`  message: ${group.message}`)
  }

  lines.push('')
  lines.push('## Patch series')
  lines.push('')

  for (const patchFile of report.patchFiles) {
    lines.push(`- \`${patchFile.fileName}\``)
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

function buildCommitSummary(report) {
  const lines = [
    `# Git Slice Handoff Summary: ${report.slice}`,
    '',
    `- Source branch: \`${report.sourceBranch}\``,
    `- Source head: \`${report.sourceHead}\``,
    `- Base ref: \`${report.baseRef}\``,
    `- Base SHA: \`${report.baseSha}\``,
    '',
    '## Commits',
    '',
  ]

  for (const group of report.groups) {
    lines.push(`1. ${group.id}`)
    lines.push(`   source commit: \`${group.sourceCommitSha}\``)
    lines.push(`   subject: ${group.message}`)
    lines.push(`   patch: \`${group.patchFileName}\``)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

async function buildHandoff(options) {
  const slice = ensureSlice(options.sliceName)
  const coverage = ensureSliceCoverage(options.sliceName, slice)
  const selectedGroups = options.groupId
    ? [ensureGroup(slice, options.groupId)]
    : slice.commitGroups

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
    throw Object.assign(
      new Error(`Source branch ${sourceBranch} has no commits on top of ${resolvedBaseRef}.`),
      {
        code: 'SOURCE_BRANCH_HAS_NO_COMMITS',
        exitCode: 1,
      },
    )
  }

  const sourceSummaries = readCommitSubjects(sourceCommits)
  const selected = mapSelectedGroups(slice, selectedGroups, sourceSummaries, manifest?.data?.groups ?? null)
  const mappingMode = selected[0]?.mappingMode ?? 'unknown'

  const resolvedOutputDir = path.resolve(
    options.outputDir ??
      path.join(
        'output',
        'git-slice-handoffs',
        options.sliceName,
        options.verify ? 'verify' : 'handoff',
      ),
  )
  const patchDir = path.join(resolvedOutputDir, 'patches')
  const bundlePath = path.join(resolvedOutputDir, `${options.sliceName}.bundle`)
  const manifestPath = path.join(resolvedOutputDir, 'manifest.json')
  const readmePath = path.join(resolvedOutputDir, 'README.md')
  const commitSummaryPath = path.join(resolvedOutputDir, 'commit-summary.md')

  await fs.rm(resolvedOutputDir, { recursive: true, force: true })
  await fs.mkdir(patchDir, { recursive: true })

  runGit(['bundle', 'create', bundlePath, sourceBranch, `^${baseSha}`])
  const bundleVerifyOutput = runGit(['bundle', 'verify', bundlePath])

  runGit(
    ['format-patch', '--output-directory', patchDir, '--full-index', '--binary', '--abbrev=40', `${baseSha}..${sourceBranch}`],
  )

  const patchFileNames = (await fs.readdir(patchDir))
    .filter((entry) => entry.endsWith('.patch'))
    .sort((left, right) => left.localeCompare(right))

  if (patchFileNames.length !== sourceCommits.length) {
    throw Object.assign(
      new Error(
        `Patch count mismatch: expected ${sourceCommits.length}, got ${patchFileNames.length}.`,
      ),
      {
        code: 'HANDOFF_PATCH_COUNT_MISMATCH',
        exitCode: 1,
        expectedPatchCount: sourceCommits.length,
        actualPatchCount: patchFileNames.length,
      },
    )
  }

  const bundleSha256 = await hashFile(bundlePath)
  const patchFiles = await Promise.all(
    patchFileNames.map(async (fileName, index) => ({
      order: index + 1,
      fileName,
      path: path.join(patchDir, fileName),
      sha256: await hashFile(path.join(patchDir, fileName)),
    })),
  )

  const groups = selected.map((entry, index) => ({
    order: index + 1,
    id: entry.group.id,
    message: entry.group.message,
    sourceCommitSha: entry.source.sha,
    sourceMessage: entry.source.message,
    patchFileName: patchFiles[index]?.fileName ?? null,
    patchPath: patchFiles[index]?.path ?? null,
    patchSha256: patchFiles[index]?.sha256 ?? null,
  }))

  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    description: slice.description,
    baseRef: resolvedBaseRef,
    baseSha,
    sourceBranch,
    sourceHead,
    sourceManifestPath: manifest?.path ?? null,
    sourceCommitCount: sourceCommits.length,
    selectedSourceCommitCount: selected.length,
    sourceMappingMode: mappingMode,
    verifyMode: options.verify,
    sliceFilesCount: coverage.sliceFiles.length,
    coverage: {
      complete: coverage.complete,
      duplicateAssignments: coverage.duplicates,
      unassignedFiles: coverage.unassigned,
      extraFiles: coverage.extra,
    },
    commitCount: sourceCommits.length,
    commits: sourceCommits,
    outputDir: resolvedOutputDir,
    bundlePath,
    bundleFileName: path.basename(bundlePath),
    bundleRefName: sourceBranch,
    bundleSha256,
    bundleVerifyOutput,
    patchDir,
    patchFiles,
    repoUrl: resolveRepoUrl(),
    currentBranch: runGit(['rev-parse', '--abbrev-ref', 'HEAD']),
    verifyPassed: true,
    groups,
  }

  report.outputManifestPath = await writeJsonFile(manifestPath, report)
  report.readmePath = await writeTextFile(readmePath, await buildReadme(report))
  report.commitSummaryPath = await writeTextFile(commitSummaryPath, buildCommitSummary(report))

  if (options.writeManifest) {
    report.writeManifestPath = await writeJsonFile(options.writeManifest, report)
  }

  return report
}

function printHuman(report) {
  console.log('Git slice handoff')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  slice: ${report.slice}`)
  console.log(`  source_branch: ${report.sourceBranch}`)
  console.log(`  source_head: ${report.sourceHead}`)
  console.log(`  base_ref: ${report.baseRef}`)
  console.log(`  base_sha: ${report.baseSha}`)
  console.log(`  commit_count: ${report.commitCount}`)
  console.log(`  verify_mode: ${report.verifyMode ? 'yes' : 'no'}`)
  console.log(`  verify_passed: ${report.verifyPassed ? 'yes' : 'no'}`)
  console.log(`  output_dir: ${report.outputDir}`)
  console.log(`  bundle_path: ${report.bundlePath}`)
  console.log(`  bundle_sha256: ${report.bundleSha256}`)
  console.log(`  readme_path: ${report.readmePath}`)
  console.log(`  commit_summary_path: ${report.commitSummaryPath}`)
  console.log('  groups:')
  report.groups.forEach((group) => {
    console.log(`    - ${group.order}. ${group.id}: ${group.message}`)
    console.log(`      source_commit_sha=${group.sourceCommitSha}`)
    console.log(`      patch_file=${group.patchFileName}`)
  })
}

function printError(error, options) {
  const report = {
    generatedAt: new Date().toISOString(),
    slice: options.sliceName,
    error: error.code ?? 'GIT_SLICE_HANDOFF_ERROR',
    message: error.message,
    cwd: process.cwd(),
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.error('Git slice handoff')
    console.error(`  error: ${report.error}`)
    console.error(`  message: ${report.message}`)
    console.error(`  cwd: ${report.cwd}`)
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

  const report = await buildHandoff(options)

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
