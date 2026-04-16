#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const STACK = [
  { pr: 888, branch: 'codex/yjs-internal-rollout-202605', parent: null },
  { pr: 889, branch: 'codex/yjs-rollout-execution-20260416', parent: 888 },
  { pr: 890, branch: 'codex/yjs-rollout-report-20260416', parent: 889 },
  { pr: 891, branch: 'codex/yjs-rollout-packet-20260416', parent: 890 },
  { pr: 892, branch: 'codex/yjs-rollout-signoff-20260416', parent: 891 },
  { pr: 893, branch: 'codex/yjs-rollout-stack-advance-20260416', parent: 892 },
  { pr: 894, branch: 'codex/yjs-rollout-gate-20260416', parent: 893 },
]

function printHelp() {
  console.log(`Usage: node scripts/ops/advance-yjs-rollout-stack.mjs [options]

Checks the Yjs rollout PR stack and optionally retargets children to main once their parent PR is merged.

Options:
  --apply                Perform gh pr edit --base main for eligible child PRs
  --enable-auto-merge    After retargeting, enable gh pr merge --auto --squash
  --json                 Print JSON output
  --help                 Show this help
`)
}

function parseArgs(argv) {
  const opts = {
    apply: false,
    enableAutoMerge: false,
    showJson: false,
  }

  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true
    } else if (arg === '--enable-auto-merge') {
      opts.enableAutoMerge = true
    } else if (arg === '--json') {
      opts.showJson = true
    } else if (arg === '--help') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown argument: ${arg}`)
      printHelp()
      process.exit(1)
    }
  }

  return opts
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `gh ${args.join(' ')} exited with status ${result.status}`)
  }

  return result.stdout.trim()
}

function loadPr(prNumber) {
  return JSON.parse(runGh([
    'pr',
    'view',
    String(prNumber),
    '--json',
    'number,state,mergedAt,mergeStateStatus,reviewDecision,baseRefName,headRefName,url,autoMergeRequest',
  ]))
}

function renderSummary(entry) {
  const status = entry.pr
  const line = `#${status.number} ${status.headRefName} -> ${status.baseRefName} [${status.state}]`
  const actions = entry.actions?.length ? ` actions=${entry.actions.join('+')}` : ''
  const reason = entry.reason ? ` reason=${entry.reason}` : ''
  return `${line}${actions}${reason}`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const statusMap = new Map()

  for (const item of STACK) {
    statusMap.set(item.pr, loadPr(item.pr))
  }

  const decisions = []

  for (const item of STACK) {
    const pr = statusMap.get(item.pr)
    if (!item.parent) {
      decisions.push({
        pr,
        actions: [],
        reason: pr.state === 'OPEN' ? 'root PR still controls the stack' : 'root PR already merged',
      })
      continue
    }

    const parent = statusMap.get(item.parent)

    if (pr.state !== 'OPEN') {
      decisions.push({ pr, actions: [], reason: 'already merged or closed' })
      continue
    }

    if (!parent?.mergedAt) {
      decisions.push({ pr, actions: [], reason: `waiting for parent #${item.parent}` })
      continue
    }

    const actions = []

    if (pr.baseRefName !== 'main') {
      actions.push('retarget-to-main')
    }

    if (opts.enableAutoMerge && !pr.autoMergeRequest) {
      actions.push('enable-auto-merge')
    }

    decisions.push({ pr, actions, reason: `parent #${item.parent} merged` })
  }

  const applied = []
  if (opts.apply) {
    for (const decision of decisions) {
      if (decision.actions.includes('retarget-to-main')) {
        runGh(['pr', 'edit', String(decision.pr.number), '--base', 'main'])
        applied.push(`retarget:${decision.pr.number}`)
      }
      if (opts.enableAutoMerge && decision.actions.includes('enable-auto-merge')) {
        runGh(['pr', 'merge', String(decision.pr.number), '--auto', '--squash'])
        applied.push(`auto-merge:${decision.pr.number}`)
      }
    }
  }

  const output = {
    apply: opts.apply,
    applied,
    decisions: decisions.map((decision) => ({
      number: decision.pr.number,
      state: decision.pr.state,
      baseRefName: decision.pr.baseRefName,
      headRefName: decision.pr.headRefName,
      mergedAt: decision.pr.mergedAt,
      actions: decision.actions,
      reason: decision.reason,
      url: decision.pr.url,
    })),
  }

  if (opts.showJson) {
    console.log(JSON.stringify(output, null, 2))
    return
  }

  for (const decision of decisions) {
    console.log(renderSummary(decision))
  }

  if (opts.apply) {
    console.log(applied.length > 0 ? `Applied retargets: ${applied.join(', ')}` : 'No retargets applied')
  }
}

await main()
