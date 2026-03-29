#!/usr/bin/env node

import fs from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
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

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function isConfigLockError(error) {
  const message = String(error?.message ?? '')
  return (
    message.includes('could not lock config file') ||
    message.includes('.git/config.lock') ||
    message.includes('unable to write upstream branch configuration')
  )
}

function runGitWithRetry(args, extra = {}) {
  const attempts = extra.attempts ?? 5
  const delayMs = extra.delayMs ?? 250
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return runGit(args, extra)
    } catch (error) {
      lastError = error
      if (!isConfigLockError(error) || attempt === attempts - 1) {
        throw error
      }
      sleepSync(delayMs)
    }
  }

  throw lastError
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
  let submitManifest = null
  let branchName = null
  let branchPrefix = 'landed'
  let baseRef = null
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
      case '--submit-manifest':
        submitManifest = argv[index + 1] ?? submitManifest
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
      case '--base-ref':
        baseRef = argv[index + 1] ?? baseRef
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

  if (!submitManifest && !listSlices && !listGroups) {
    throw Object.assign(
      new Error('Provide --submit-manifest for git-slice-land.'),
      {
        code: 'SUBMIT_MANIFEST_REQUIRED',
        exitCode: 1,
      },
    )
  }

  return {
    sliceName,
    submitManifest,
    branchName,
    branchPrefix,
    baseRef,
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
  console.log(`Usage: node scripts/ops/git-slice-land.mjs [options]

Options:
  --slice <name>            Slice name. Default: directory-migration-baseline
  --submit-manifest <path>  Submit manifest path
  --branch-name <name>      Landed branch name
  --branch-prefix <name>    Prefix for auto-generated landed branches. Default: landed
  --base-ref <ref>          Override base ref from submit manifest
  --worktree-dir <path>     Keep or create the temporary worktree at a fixed path
  --output-dir <path>       Write per-group landed patches and manifest
  --write-manifest <path>   Write manifest JSON to the given path
  --verify                  Run a full ephemeral landing and delete the branch afterwards
  --keep-worktree           Keep the generated worktree on disk for inspection
  --list-slices             Print available slices
  --list-groups             Print groups for the selected slice
  --json                    Print JSON
  --help, -h                Show help`)
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
  const contents = await fs.readFile(filePath)
  return createHash('sha256').update(contents).digest('hex')
}

async function loadSubmitManifest(filePath, sliceName) {
  const resolvedPath = path.resolve(filePath)
  const raw = await fs.readFile(resolvedPath, 'utf8')
  const data = JSON.parse(raw)

  if (data.slice && data.slice !== sliceName) {
    throw Object.assign(
      new Error(`Submit manifest slice mismatch: expected ${sliceName}, got ${data.slice}.`),
      {
        code: 'SUBMIT_MANIFEST_SLICE_MISMATCH',
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

function requireValue(value, errorMessage, code, extra = {}) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(errorMessage), {
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

function buildBranchName(prefix, sliceName) {
  const parts = [
    sanitizeBranchPart(prefix || 'landed'),
    sanitizeBranchPart(sliceName),
    sanitizeBranchPart(timestampSlug()),
    process.pid,
    randomBytes(3).toString('hex'),
  ].filter(Boolean)
  return parts.join('/')
}

function parseAheadBehind(baseRef, worktreePath) {
  const output = runGit(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], {
    cwd: worktreePath,
  })
  const [behindCount, aheadCount] = output
    .trim()
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10) || 0)
  return {
    behindCount,
    aheadCount,
  }
}

function repoIsDirty(worktreePath) {
  return runGit(['status', '--porcelain'], { cwd: worktreePath }).trim().length > 0
}

async function collectPatchArtifacts({ baseSha, worktreePath, patchDir }) {
  await fs.mkdir(patchDir, { recursive: true })

  runGit(
    [
      'format-patch',
      '--full-index',
      '--binary',
      '--abbrev=40',
      '--output-directory',
      patchDir,
      `${baseSha}..HEAD`,
    ],
    { cwd: worktreePath },
  )

  const entries = (await fs.readdir(patchDir))
    .filter((entry) => entry.endsWith('.patch'))
    .sort((left, right) => left.localeCompare(right))

  return Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(patchDir, entry)
      const stats = await fs.stat(absolutePath)
      return {
        fileName: entry,
        path: absolutePath,
        bytes: stats.size,
        sha256: await sha256File(absolutePath),
      }
    }),
  )
}

function resolveWorktreeDir(requestedPath, sliceName, verifyMode) {
  if (requestedPath) {
    const resolved = path.resolve(requestedPath)
    if (existsSync(resolved)) {
      throw Object.assign(new Error(`Worktree path already exists: ${resolved}`), {
        code: 'WORKTREE_PATH_EXISTS',
        exitCode: 1,
      })
    }
    return resolved
  }

  const prefix = verifyMode
    ? `git-slice-land-verify-${sliceName.replace(/[^A-Za-z0-9._-]+/g, '-')}-`
    : `git-slice-land-${sliceName.replace(/[^A-Za-z0-9._-]+/g, '-')}-`
  return mkdtempSync(path.join(tmpdir(), prefix))
}

async function cleanupResources({ worktreePath, branchName, keepWorktree, verifyMode }) {
  const cleanup = {
    worktreeRemoved: false,
    branchDeleted: false,
  }

  if (verifyMode || !keepWorktree) {
    if (existsSync(worktreePath)) {
      runGit(['worktree', 'remove', '--force', worktreePath])
      cleanup.worktreeRemoved = true
    }
  }

  if (verifyMode) {
    if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])) {
      runGit(['branch', '-D', branchName])
      cleanup.branchDeleted = true
    }
  }

  return cleanup
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

  const submitManifest = await loadSubmitManifest(args.submitManifest, args.sliceName)
  const readiness = submitManifest.data.readiness ?? {}
  if (!readiness.sliceReadyForSubmission) {
    throw Object.assign(
      new Error('Submit manifest is not ready for landing. Run attest/submit successfully first.'),
      {
        code: 'SUBMIT_NOT_READY',
        exitCode: 1,
        manifestPath: submitManifest.path,
      },
    )
  }

  const baseRef = args.baseRef ?? requireValue(
    submitManifest.data.baseRef,
    'Submit manifest is missing baseRef.',
    'BASE_REF_REQUIRED',
  )
  const baseSha = requireValue(
    submitManifest.data.baseSha,
    'Submit manifest is missing baseSha.',
    'BASE_SHA_REQUIRED',
  )
  const sourceBranch = requireValue(
    submitManifest.data.promote?.branchName,
    'Submit manifest is missing promote.branchName.',
    'PROMOTED_BRANCH_REQUIRED',
  )
  const sourceHead = requireValue(
    submitManifest.data.promote?.head,
    'Submit manifest is missing promote.head.',
    'PROMOTED_HEAD_REQUIRED',
  )
  const commitGroups = submitManifest.data.promote?.groups ?? []
  if (!Array.isArray(commitGroups) || commitGroups.length !== slice.commitGroups.length) {
    throw Object.assign(
      new Error('Submit manifest promote groups do not match slice commit groups.'),
      {
        code: 'PROMOTE_GROUPS_REQUIRED',
        exitCode: 1,
      },
    )
  }

  assertGitRefExists(baseRef, 'Base ref', { baseRef })
  assertGitRefExists(sourceBranch, 'Promoted branch', { sourceBranch })
  assertGitRefExists(baseSha, 'Base SHA', { baseSha })

  const resolvedSourceHead = runGit(['rev-parse', sourceBranch])
  if (resolvedSourceHead !== sourceHead) {
    throw Object.assign(
      new Error(
        `Promoted branch head mismatch: manifest=${sourceHead}, current=${resolvedSourceHead}.`,
      ),
      {
        code: 'PROMOTED_HEAD_MISMATCH',
        exitCode: 1,
        sourceBranch,
        sourceHead,
        resolvedSourceHead,
      },
    )
  }

  const branchName = args.branchName ?? buildBranchName(args.branchPrefix, args.sliceName)
  const worktreePath = resolveWorktreeDir(args.worktreeDir, args.sliceName, args.verify)

  if (gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`])) {
    throw Object.assign(new Error(`Branch already exists: ${branchName}`), {
      code: 'TARGET_BRANCH_EXISTS',
      exitCode: 1,
      branchName,
    })
  }

  const outputDir = path.resolve(
    args.outputDir ??
      path.join(
        process.cwd(),
        'output',
        'git-slice-landings',
        args.verify ? `verify-${args.sliceName}` : args.sliceName,
      ),
  )
  await fs.mkdir(outputDir, { recursive: true })

  runGitWithRetry(['worktree', 'add', '-b', branchName, worktreePath, baseSha])

  const landedGroups = []
  let cherryPickFailed = false
  const committerName = runGit(['show', '-s', '--format=%an', sourceHead])
  const committerEmail = runGit(['show', '-s', '--format=%ae', sourceHead])
  const landingEnv = {
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
    GIT_AUTHOR_NAME: committerName,
    GIT_AUTHOR_EMAIL: committerEmail,
  }
  try {
    runGitWithRetry(['branch', '--set-upstream-to', baseRef], { cwd: worktreePath })

    for (let index = 0; index < commitGroups.length; index += 1) {
      const group = commitGroups[index]
      const promotedCommitSha = requireValue(
        group.promotedCommitSha,
        `Promoted commit SHA missing for group ${group.id}.`,
        'PROMOTED_COMMIT_REQUIRED',
        { groupId: group.id },
      )

      runGit(['cherry-pick', promotedCommitSha], { cwd: worktreePath, env: landingEnv })
      const landedCommitSha = runGit(['rev-parse', 'HEAD'], { cwd: worktreePath })
      landedGroups.push({
        order: index + 1,
        id: group.id,
        message: group.message,
        sourcePromotedCommitSha: promotedCommitSha,
        landedCommitSha,
        committedFiles: group.committedFiles ?? [],
      })
    }
  } catch (error) {
    cherryPickFailed = true
    if (gitSucceeds(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], { cwd: worktreePath })) {
      try {
        runGit(['cherry-pick', '--abort'], { cwd: worktreePath })
      } catch {
        // Ignore cleanup failure here and surface the original cherry-pick error below.
      }
    }
    throw Object.assign(
      new Error(`Landing failed while cherry-picking promoted commits: ${error.message}`),
      {
        code: 'LAND_CHERRY_PICK_FAILED',
        exitCode: 1,
        cause: error,
      },
    )
  } finally {
    if (cherryPickFailed && args.verify) {
      await cleanupResources({
        worktreePath,
        branchName,
        keepWorktree: false,
        verifyMode: true,
      })
    }
  }

  const landedHead = runGit(['rev-parse', 'HEAD'], { cwd: worktreePath })
  const landedTree = runGit(['rev-parse', 'HEAD^{tree}'], { cwd: worktreePath })
  const sourceTree = runGit(['rev-parse', `${sourceHead}^{tree}`])
  const upstreamRef = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
    cwd: worktreePath,
  })
  const currentBranchName = runGit(['branch', '--show-current'], { cwd: worktreePath })
  const statusOutput = runGit(['status', '--porcelain'], { cwd: worktreePath })
  const dirty = statusOutput.trim().length > 0
  const { aheadCount, behindCount } = parseAheadBehind(baseRef, worktreePath)
  const branchReadyForPush = !dirty && behindCount === 0 && aheadCount === commitGroups.length
  const treeMatchesPromotedHead = landedTree === sourceTree

  const patchDir = path.join(outputDir, 'patches')
  const patches = await collectPatchArtifacts({
    baseSha,
    worktreePath,
    patchDir,
  })

  const summaryPath = path.join(outputDir, 'land-summary.md')
  const readmePath = path.join(outputDir, 'README.md')
  const commandsPath = path.join(outputDir, 'land-commands.sh')
  const manifestPath = path.resolve(args.writeManifest ?? path.join(outputDir, 'manifest.json'))

  const commandsContents = `#!/usr/bin/env bash
set -euo pipefail

git fetch origin ${shellEscape(baseRef)}
git log --oneline --decorate ${shellEscape(baseRef)}..${shellEscape(branchName)}
git diff --stat ${shellEscape(baseRef)}..${shellEscape(branchName)}
git push -u origin ${shellEscape(branchName)}
`

  const summaryContents = `# Git Slice Land Summary

- slice: \`${args.sliceName}\`
- baseRef: \`${baseRef}\`
- baseSha: \`${baseSha}\`
- sourcePromotedBranch: \`${sourceBranch}\`
- sourcePromotedHead: \`${sourceHead}\`
- landedBranch: \`${branchName}\`
- landedHead: \`${landedHead}\`
- aheadCount: \`${aheadCount}\`
- behindCount: \`${behindCount}\`
- dirty: \`${dirty}\`
- treeMatchesPromotedHead: \`${treeMatchesPromotedHead}\`
- branchReadyForPush: \`${branchReadyForPush}\`
`

  const readmeContents = `# Git Slice Land Packet

This packet records the branch created from a submit-ready Git slice.

## Meaning

- \`sliceReadyForSubmission=true\` means the promote/handoff/replay/attest chain is consistent.
- \`branchReadyForPush=true\` means this landed branch is clean, based on \`${baseRef}\`, and ready for a normal \`git push -u origin <branch>\`.

## Branches

- source promoted: \`${sourceBranch}\`
- landed branch: \`${branchName}\`

## Artifacts

- manifest: \`${path.basename(manifestPath)}\`
- summary: \`${path.basename(summaryPath)}\`
- commands: \`${path.basename(commandsPath)}\`
- patches: \`patches/*.patch\`
`

  await writeTextFile(commandsPath, commandsContents, true)
  await writeTextFile(summaryPath, summaryContents)
  await writeTextFile(readmePath, readmeContents)

  let cleanup = {
    worktreeRemoved: false,
    branchDeleted: false,
  }

  if (args.verify && !args.keepWorktree) {
    cleanup = await cleanupResources({
      worktreePath,
      branchName,
      keepWorktree: false,
      verifyMode: true,
    })
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    slice: args.sliceName,
    description: slice.description ?? null,
    verifyMode: args.verify,
    submitManifestPath: submitManifest.path,
    baseRef,
    baseSha,
    sourcePromotedBranch: sourceBranch,
    sourcePromotedHead: sourceHead,
    landedBranchName: branchName,
    landedHead,
    upstreamRef,
    commitCount: commitGroups.length,
    sliceFilesCount: submitManifest.data.promote?.sliceFilesCount ?? slice.files.length,
    aheadCount,
    behindCount,
    dirty,
    treeMatchesPromotedHead,
    branchReadyForPush,
    currentBranchIsLandedBranch: currentBranchName === branchName,
    groups: landedGroups,
    patches,
    outputDir,
    worktreePath,
    summaryPath,
    readmePath,
    commandsPath,
    cleanup,
    verifyPassed:
      branchReadyForPush &&
      treeMatchesPromotedHead &&
      landedGroups.length === commitGroups.length,
  }

  await writeJsonFile(manifestPath, payload)

  const result = {
    ...payload,
    manifestPath,
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`git-slice-land: ${args.sliceName}`)
  console.log(`  landed_branch: ${branchName}`)
  console.log(`  landed_head: ${landedHead}`)
  console.log(`  ahead=${aheadCount} behind=${behindCount} dirty=${dirty}`)
  console.log(`  ready_for_push: ${branchReadyForPush}`)
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
  if (error.groupId) {
    payload.groupId = error.groupId
  }
  console.error(JSON.stringify(payload, null, 2))
  process.exit(error.exitCode ?? 1)
})
