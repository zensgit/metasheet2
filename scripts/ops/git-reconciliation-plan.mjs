#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

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

function bucketForPath(filePath) {
  if (filePath.startsWith('apps/')) return 'apps'
  if (filePath.startsWith('packages/')) return 'packages'
  if (filePath.startsWith('docs/')) return 'docs'
  if (filePath.startsWith('scripts/')) return 'scripts'
  if (filePath.startsWith('docker/')) return 'docker'
  if (filePath.startsWith('plugins/')) return 'plugins'
  if (filePath.startsWith('output/')) return 'output'
  if (filePath.startsWith('.claude/')) return 'claude'
  if (filePath.startsWith('.github/')) return 'github'
  return 'root'
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function summarizeBuckets(files) {
  const buckets = new Map()
  for (const file of files) {
    const bucket = bucketForPath(file)
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  return Object.fromEntries([...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function normalizeStatusPath(rawValue) {
  const trimmed = rawValue.trim()
  if (trimmed.includes(' -> ')) {
    return trimmed.split(' -> ').at(-1)?.trim() ?? trimmed
  }
  return trimmed
}

function parseStatusLine(line) {
  const indexStatus = line[0] ?? ' '
  const worktreeStatus = line[1] ?? ' '
  const filePath = normalizeStatusPath(line.slice(3))

  return {
    raw: line,
    indexStatus,
    worktreeStatus,
    filePath,
    untracked: indexStatus === '?' && worktreeStatus === '?',
  }
}

function resolveUpstream() {
  try {
    const upstream = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    return upstream || null
  } catch {
    return null
  }
}

async function loadSlices() {
  const sliceModuleUrl = new URL('./git-slices.mjs', import.meta.url)

  try {
    const module = await import(sliceModuleUrl)
    return {
      source: 'git-slices.mjs',
      slices: module.SLICES ?? {},
    }
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error
    }

    return {
      source: 'fallback-empty',
      slices: {},
    }
  }
}

function buildSliceIndex(slices) {
  const pathToSlices = new Map()
  for (const [sliceName, slice] of Object.entries(slices)) {
    for (const filePath of slice.files) {
      const entries = pathToSlices.get(filePath) ?? []
      entries.push(sliceName)
      pathToSlices.set(filePath, entries)
    }
  }
  return pathToSlices
}

function classifyUncoveredPath(filePath) {
  const normalized = filePath.toLowerCase()

  if (
    filePath.startsWith('output/') ||
    filePath.startsWith('.claude/') ||
    filePath.startsWith('packages/openapi/dist/') ||
    filePath.includes('/node_modules/')
  ) {
    return {
      id: 'generated-artifacts-and-vendor-churn',
      description: 'Generated artifacts, vendor churn, and local tooling residue.',
      kind: 'cleanup',
      priority: 1,
    }
  }

  if (
    filePath.startsWith('docs/development/') &&
    (
      normalized.includes('claude-task-pack') ||
      normalized.includes('claude-verification-template')
    )
  ) {
    return {
      id: 'claude-task-pack-archives',
      description: 'Claude execution packs and verification templates awaiting archival or separate delivery.',
      kind: 'docs',
      priority: 2,
    }
  }

  if (
    normalized.includes('dingtalkauthcallbackview.spec') ||
    normalized.includes('directorymanagementview.spec') ||
    normalized.includes('loginview.spec') ||
    normalized.includes('admin-directory-routes.test') ||
    normalized.includes('directory-sync.test') ||
    normalized.includes('auth-login-routes.test') ||
    filePath === 'packages/openapi/src/admin-directory.yml' ||
    filePath === 'packages/openapi/src/paths/auth.yml' ||
    normalized.endsWith('scripts/dingtalk-directory-smoke.mjs') ||
    normalized.endsWith('scripts/dingtalk-oauth-smoke.mjs')
  ) {
    return {
      id: 'dingtalk-runtime-contract-followups',
      description: 'DingTalk runtime contracts, targeted tests, and smoke verification follow-up set.',
      kind: 'business',
      priority: 3,
    }
  }

  if (
    filePath === 'package.json' ||
    filePath === 'scripts/ops/git-reconciliation-plan.mjs' ||
    filePath === 'scripts/openapi-check.mjs' ||
    normalized.includes('repo-baseline-reconciliation')
  ) {
    return {
      id: 'reconciliation-tooling-and-entrypoints',
      description: 'Baseline planning scripts, root entrypoints, and reconciliation reports.',
      kind: 'ops',
      priority: 4,
    }
  }

  if (
    filePath.startsWith('docs/deployment/dingtalk-') ||
    filePath.startsWith('docs/development/dingtalk-')
  ) {
    return {
      id: 'dingtalk-rollout-docs-backlog',
      description: 'DingTalk rollout, OAuth, and ops hardening documentation backlog outside the final slice commits.',
      kind: 'docs',
      priority: 5,
    }
  }

  if (
    normalized.includes('attendance') ||
    normalized.includes('authservice') ||
    normalized.includes('jwt-middleware') ||
    normalized.includes('session-registry') ||
    normalized.includes('loginview') ||
    normalized.includes('sessioncenterview') ||
    normalized.includes('usermanagementview') ||
    normalized.includes('useauth') ||
    normalized.includes('plugin-attendance') ||
    normalized.includes('admin-users') ||
    normalized.endsWith('/auth.ts')
  ) {
    return {
      id: 'attendance-auth-followups',
      description: 'Attendance, auth, and admin user featureline follow-up work.',
      kind: 'business',
      priority: 6,
    }
  }

  if (
    filePath.startsWith('.github/') ||
    filePath.startsWith('docker/') ||
    filePath.startsWith('.env') ||
    filePath.startsWith('packages/core-backend/.env') ||
    normalized.includes('observability') ||
    normalized.includes('connection-pool') ||
    normalized.includes('eventbusservice') ||
    normalized.includes('cache-test') ||
    normalized.includes('openapi-check') ||
    filePath === 'run-migrate.bat'
  ) {
    return {
      id: 'runtime-contracts-and-observability',
      description: 'Runtime env, observability, infra, and deployment contract follow-ups.',
      kind: 'ops',
      priority: 7,
    }
  }

  if (
    filePath.startsWith('scripts/ops/') ||
    normalized.includes('ssh-recovery') ||
    normalized.includes('git-slice-') ||
    normalized.includes('remote-git-')
  ) {
    return {
      id: 'git-and-remote-ops-followups',
      description: 'Remaining Git, SSH, and remote-ops tooling follow-ups outside landed slices.',
      kind: 'ops',
      priority: 8,
    }
  }

  if (
    normalized.includes('plm') ||
    normalized.includes('workflow') ||
    normalized.includes('kanban') ||
    normalized.includes('snapshot') ||
    normalized.includes('spreadsheet') ||
    normalized.includes('gridview') ||
    normalized.includes('pluginmanagerview') ||
    normalized.includes('plugin-view-gantt') ||
    normalized.includes('plugin-intelligent-restore') ||
    normalized.includes('plugin-audit-logger') ||
    normalized.includes('multitable')
  ) {
    return {
      id: 'plm-workflow-followups',
      description: 'PLM, workflow, spreadsheet, and related plugin featureline follow-up work.',
      kind: 'business',
      priority: 9,
    }
  }

  if (filePath.startsWith('docs/')) {
    return {
      id: 'docs-backlog-and-rollout-notes',
      description: 'Documentation backlog that should be reconciled after source slices settle.',
      kind: 'docs',
      priority: 10,
    }
  }

  return {
    id: 'misc-followups',
    description: 'Remaining uncategorized changes that need manual triage.',
    kind: 'manual',
    priority: 11,
  }
}

function parseArgs(argv) {
  let json = false
  let verify = false
  let outputDir = null
  let listSlices = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--json':
        json = true
        break
      case '--verify':
        verify = true
        break
      case '--output-dir':
        outputDir = argv[index + 1] ?? outputDir
        index += 1
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

  return { json, verify, outputDir, listSlices }
}

function printHelp() {
  console.log(`Usage: node scripts/ops/git-reconciliation-plan.mjs [options]

Options:
  --json                Print JSON
  --verify              Exit non-zero only when reconciliation classification is incomplete
  --output-dir <dir>    Write report.json and summary.md
  --list-slices         Print available Git slices
  --help, -h            Show help`)
}

function buildSuggestions(report) {
  const suggestions = []

  if (report.behind > 0) {
    suggestions.push('当前分支仍然落后 upstream，新的业务 slice 收口前应先处理 overlapping upstream 提交。')
  }

  if (report.coveredSlices.length > 0) {
    const topCovered = report.coveredSlices
      .slice(0, 2)
      .map((entry) => `${entry.slice}(${entry.coveredDirtyCount})`)
      .join('、')
    suggestions.push(`已有 dirty 文件已落在既有 slice 中，优先保持这些已收口业务线的提交意图：${topCovered}。`)
  }

  const generated = report.candidateGroups.find((group) => group.id === 'generated-artifacts-and-vendor-churn')
  if (generated && generated.pathCount > 0) {
    suggestions.push('优先把 output、vendor 和 openapi/dist 这类生成物单独清理，不要让它们继续污染业务 slice。')
  }

  const nextBusiness = report.candidateGroups.find((group) => group.kind === 'business')
  if (nextBusiness) {
    suggestions.push(`下一条真实业务 slice 建议先从 ${nextBusiness.id} 开始，目前涉及 ${nextBusiness.pathCount} 个路径。`)
  }

  if (report.uncoveredDirtyCount > 0) {
    suggestions.push('先用 reconciliation report 固化剩余 dirty tree，再决定哪些路径进入下一条 slice，哪些属于清理项。')
  }

  return suggestions
}

function buildReport(slices, sliceCatalogSource) {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'])
  const upstream = resolveUpstream()
  const head = runGit(['rev-parse', 'HEAD'])
  const ahead = upstream ? runGit(['rev-list', '--count', `${upstream}..HEAD`]) : '0'
  const behind = upstream ? runGit(['rev-list', '--count', `HEAD..${upstream}`]) : '0'
  const dirtyLines = runGit(['status', '--short', '--untracked-files=all'])
    .split('\n')
    .filter(Boolean)
  const dirtyFiles = dirtyLines.map(parseStatusLine)
  const dirtyPaths = uniqueSorted(dirtyFiles.map((entry) => entry.filePath))
  const sliceIndex = buildSliceIndex(slices)

  const coveredPathEntries = []
  const uncoveredPaths = []

  for (const filePath of dirtyPaths) {
    const matchedSlices = uniqueSorted(sliceIndex.get(filePath) ?? [])
    if (matchedSlices.length > 0) {
      coveredPathEntries.push({ path: filePath, slices: matchedSlices })
    } else {
      uncoveredPaths.push(filePath)
    }
  }

  const coveredSlicesMap = new Map()
  for (const entry of coveredPathEntries) {
    for (const sliceName of entry.slices) {
      const slice = slices[sliceName]
      const existing = coveredSlicesMap.get(sliceName) ?? {
        slice: sliceName,
        description: slice.description,
        dirtyPaths: [],
        suggestedCommits: slice.suggestedCommits ?? [],
      }
      existing.dirtyPaths.push(entry.path)
      coveredSlicesMap.set(sliceName, existing)
    }
  }

  const coveredSlices = [...coveredSlicesMap.values()]
    .map((entry) => {
      const dirtyPathsForSlice = uniqueSorted(entry.dirtyPaths)
      return {
        slice: entry.slice,
        description: entry.description,
        coveredDirtyCount: dirtyPathsForSlice.length,
        buckets: summarizeBuckets(dirtyPathsForSlice),
        samplePaths: dirtyPathsForSlice.slice(0, 8),
        dirtyPaths: dirtyPathsForSlice,
        suggestedCommits: entry.suggestedCommits,
        stageCommand: `git add -- ${dirtyPathsForSlice.map(shellEscape).join(' ')}`,
      }
    })
    .sort((left, right) => right.coveredDirtyCount - left.coveredDirtyCount || left.slice.localeCompare(right.slice))

  const multiSliceCoveredPaths = coveredPathEntries
    .filter((entry) => entry.slices.length > 1)
    .sort((left, right) => left.path.localeCompare(right.path))

  const candidateGroupMap = new Map()
  for (const filePath of uncoveredPaths) {
    const classification = classifyUncoveredPath(filePath)
    const existing = candidateGroupMap.get(classification.id) ?? {
      ...classification,
      paths: [],
    }
    existing.paths.push(filePath)
    candidateGroupMap.set(classification.id, existing)
  }

  const candidateGroups = [...candidateGroupMap.values()]
    .map((group) => {
      const paths = uniqueSorted(group.paths)
      return {
        id: group.id,
        description: group.description,
        kind: group.kind,
        priority: group.priority,
        pathCount: paths.length,
        buckets: summarizeBuckets(paths),
        samplePaths: paths.slice(0, 10),
        paths,
        stageCommand: `git add -- ${paths.map(shellEscape).join(' ')}`,
      }
    })
    .sort((left, right) => left.priority - right.priority || right.pathCount - left.pathCount || left.id.localeCompare(right.id))

  const accountedForCount = coveredPathEntries.length + uncoveredPaths.length
  const verifyPassed = accountedForCount === dirtyPaths.length

  const report = {
    generatedAt: new Date().toISOString(),
    sliceCatalogSource,
    branch,
    upstream,
    head,
    ahead: Number(ahead),
    behind: Number(behind),
    dirty: dirtyPaths.length > 0,
    dirtyPathCount: dirtyPaths.length,
    coveredDirtyCount: coveredPathEntries.length,
    uncoveredDirtyCount: uncoveredPaths.length,
    multiSliceCoveredCount: multiSliceCoveredPaths.length,
    dirtyBuckets: summarizeBuckets(dirtyPaths),
    coveredSlices,
    multiSliceCoveredPaths,
    uncoveredPaths,
    uncoveredBuckets: summarizeBuckets(uncoveredPaths),
    candidateGroups,
    classification: {
      accountedForCount,
      verifyPassed,
    },
    suggestions: [],
  }

  report.suggestions = buildSuggestions(report)
  return report
}

function renderMarkdown(report) {
  const lines = [
    '# Repo Baseline Reconciliation Plan',
    '',
    `- generatedAt: \`${report.generatedAt}\``,
    `- branch: \`${report.branch}\``,
    `- upstream: \`${report.upstream ?? 'none'}\``,
    `- ahead/behind: \`${report.ahead}/${report.behind}\``,
    `- dirtyPathCount: \`${report.dirtyPathCount}\``,
    `- coveredDirtyCount: \`${report.coveredDirtyCount}\``,
    `- uncoveredDirtyCount: \`${report.uncoveredDirtyCount}\``,
    '',
    '## Existing Slice Coverage',
    '',
  ]

  if (report.coveredSlices.length === 0) {
    lines.push('- No current dirty paths are covered by existing slices.')
  } else {
    for (const slice of report.coveredSlices) {
      lines.push(`- \`${slice.slice}\`: ${slice.coveredDirtyCount} paths`)
      lines.push(`  - buckets: ${Object.entries(slice.buckets).map(([bucket, count]) => `${bucket}=${count}`).join(', ')}`)
      lines.push(`  - sample: ${slice.samplePaths.join(', ')}`)
    }
  }

  lines.push('', '## Remaining Candidate Groups', '')
  if (report.candidateGroups.length === 0) {
    lines.push('- No uncovered dirty paths remain.')
  } else {
    for (const group of report.candidateGroups) {
      lines.push(`- \`${group.id}\` (${group.kind}): ${group.pathCount} paths`)
      lines.push(`  - description: ${group.description}`)
      lines.push(`  - buckets: ${Object.entries(group.buckets).map(([bucket, count]) => `${bucket}=${count}`).join(', ')}`)
      lines.push(`  - sample: ${group.samplePaths.join(', ')}`)
      lines.push(`  - stage: \`${group.stageCommand}\``)
    }
  }

  lines.push('', '## Suggestions', '')
  for (const suggestion of report.suggestions) {
    lines.push(`- ${suggestion}`)
  }

  return `${lines.join('\n')}\n`
}

async function maybeWriteOutputs(report, outputDir) {
  if (!outputDir) {
    return null
  }

  const resolvedDir = path.resolve(outputDir)
  await fs.mkdir(resolvedDir, { recursive: true })
  const jsonPath = path.join(resolvedDir, 'report.json')
  const markdownPath = path.join(resolvedDir, 'summary.md')
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await fs.writeFile(markdownPath, renderMarkdown(report), 'utf8')

  return {
    outputDir: resolvedDir,
    jsonPath,
    markdownPath,
  }
}

function printHuman(report, outputs) {
  console.log('Repo baseline reconciliation plan')
  console.log(`  generated_at: ${report.generatedAt}`)
  console.log(`  branch: ${report.branch}`)
  console.log(`  upstream: ${report.upstream ?? 'none'}`)
  console.log(`  ahead/behind: ${report.ahead}/${report.behind}`)
  console.log(`  dirty_paths: ${report.dirtyPathCount}`)
  console.log(`  covered_by_existing_slices: ${report.coveredDirtyCount}`)
  console.log(`  uncovered_dirty_paths: ${report.uncoveredDirtyCount}`)
  console.log(`  multi_slice_covered_paths: ${report.multiSliceCoveredCount}`)
  console.log('  covered_slices:')
  for (const slice of report.coveredSlices) {
    console.log(`    - ${slice.slice}: ${slice.coveredDirtyCount}`)
  }
  console.log('  candidate_groups:')
  for (const group of report.candidateGroups) {
    console.log(`    - ${group.id}: ${group.pathCount} (${group.kind})`)
  }
  console.log('  suggestions:')
  for (const suggestion of report.suggestions) {
    console.log(`    - ${suggestion}`)
  }
  if (outputs) {
    console.log(`  report_json: ${outputs.jsonPath}`)
    console.log(`  summary_md: ${outputs.markdownPath}`)
  }
}

const options = parseArgs(process.argv.slice(2))
const { source: sliceCatalogSource, slices } = await loadSlices()

if (options.listSlices) {
  console.log(Object.keys(slices).join('\n'))
  process.exit(0)
}

if (!isGitWorkTree()) {
  const errorReport = {
    generatedAt: new Date().toISOString(),
    error: 'NOT_A_GIT_REPOSITORY',
    message: 'Current working directory is not a Git working tree.',
    cwd: process.cwd(),
  }

  if (options.json) {
    console.log(JSON.stringify(errorReport, null, 2))
  } else {
    console.error('Repo baseline reconciliation plan')
    console.error(`  error: ${errorReport.error}`)
    console.error(`  message: ${errorReport.message}`)
    console.error(`  cwd: ${errorReport.cwd}`)
  }

  process.exit(2)
}

const report = buildReport(slices, sliceCatalogSource)
const outputs = await maybeWriteOutputs(report, options.outputDir)
const payload = outputs ? { ...report, outputs } : report

if (options.json) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  printHuman(report, outputs)
}

if (options.verify && !report.classification.verifyPassed) {
  process.exit(1)
}
