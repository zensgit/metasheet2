#!/usr/bin/env node
// PR merge watcher — waits for a PR to land, distinguishing a KNOWN infrastructure flake from a
// real failure, and refusing to conflate "not required" with "not failing".
//
// WHY THIS EXISTS AS A REVIEWABLE FILE. It was written inline during a session and used to decide
// whether a red check blocked a merge. The owner's review said: "监视器脚本不在两张 PR 的 diff
// 中,所以我尚未审阅其实现". A tool that influences merge decisions but cannot be read is not
// evidence — so it lands here, or it does not count.
//
// THREE THINGS IT GETS RIGHT, EACH BECAUSE AN EARLIER VERSION GOT THEM WRONG:
//
// 1. THE REQUIRED SET IS READ FROM THE API, NEVER HARDCODED. The first version baked in nine
//    literal names. main's required set grows; a stale literal silently turns a blocking red into
//    an ignored one. Reading branch protection each poll is the only form that cannot drift.
//
// 2. THE FLAKE CRITERION IS EVALUATED ON THE FAILING STEP'S OWN LOG LINES. An earlier version
//    grepped the WHOLE run for `57P01`, found nothing, and reported "not the known flake" — the
//    evidence existed but in a step the scan never narrowed to. Scanning the wrong span is
//    indistinguishable from absence.
//
// 3. IT FAILS CLOSED, LOUDLY. An earlier version used `grep -ci … || echo 0`, which emitted
//    "0\n0"; the integer comparison then crashed and execution fell through to a branch that
//    PRINTED A CONCLUSION ("not the known flake"). A tool that prints a verdict after its own
//    logic dies is worse than one that stops. Every uncertain path here throws.
//
// It does NOT arm auto-merge and does NOT merge. It observes and reports.

import { execFileSync } from 'node:child_process'

const REPO = process.env.WATCH_REPO || 'zensgit/metasheet2'
const POLL_MS = Number(process.env.WATCH_POLL_MS || 45_000)
const MAX_POLLS = Number(process.env.WATCH_MAX_POLLS || 90)
const MAX_RERUNS = Number(process.env.WATCH_MAX_RERUNS || 3)

// The one flake this tool is allowed to dismiss, stated as a conjunction so that no single
// coincidence is enough. All three must hold on the SAME failing step.
const FLAKE = {
  name: 'postgres 57P01 teardown race',
  step: 'attendance integration tests',
  markers: ['57P01', 'Unhandled Errors'],
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

/** Required contexts, READ LIVE. Throws rather than guessing — an empty set would make every
 *  red look non-blocking, which is the most dangerous possible failure for this tool. */
function requiredContexts(branch = 'main') {
  const raw = gh(['api', `repos/${REPO}/branches/${branch}/protection`,
    '--jq', '.required_status_checks.contexts[]'])
  const set = new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))
  if (set.size === 0) throw new Error('required-contexts read came back EMPTY; refusing to treat every red as non-blocking')
  return set
}

/** True only if all three flake criteria hold on the failing step's own lines. */
function isKnownFlake(detailsUrl, prNumber) {
  const job = /\/job\/(\d+)/.exec(detailsUrl)?.[1]
  if (!job) return false
  const log = gh(['run', 'view', '--job', job, '--log'])
  const stepLines = log.split('\n').filter((l) => l.includes(FLAKE.step)).join('\n')
  if (!stepLines) return false
  if (!FLAKE.markers.every((m) => stepLines.includes(m))) return false
  // and the diff must not touch what the failing step exercises
  const files = gh(['pr', 'diff', String(prNumber), '--name-only']).split('\n')
  return !files.some((f) => f.toLowerCase().includes('attendance'))
}

export function pollOnce(prNumber, required) {
  const d = JSON.parse(gh(['pr', 'view', String(prNumber), '--json',
    'headRefOid,state,mergedAt,mergeCommit,mergeStateStatus,statusCheckRollup']))
  const checks = d.statusCheckRollup ?? []
  const req = checks.filter((c) => required.has(c.name))
  return {
    state: d.state,
    head: d.headRefOid?.slice(0, 9),
    mergeState: d.mergeStateStatus,
    mergedAt: d.mergedAt,
    mergeSha: d.mergeCommit?.oid?.slice(0, 9),
    green: req.filter((c) => c.conclusion === 'SUCCESS').map((c) => c.name),
    red: req.filter((c) => c.conclusion === 'FAILURE'),
    running: req.filter((c) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED').map((c) => c.name),
    // recorded, never treated as blocking — but never hidden either
    nonRequiredRed: checks.filter((c) => c.conclusion === 'FAILURE' && !required.has(c.name)).map((c) => c.name),
  }
}

async function main() {
  const prs = process.argv.slice(2)
  if (prs.length === 0) throw new Error('usage: pr-merge-watch.mjs <pr> [pr...]')
  const pending = new Set(prs)
  const reruns = new Map()

  for (let i = 0; i < MAX_POLLS && pending.size > 0; i++) {
    const required = requiredContexts()   // re-read every poll; it can change under us
    for (const pr of [...pending]) {
      const s = pollOnce(pr, required)
      if (s.state === 'MERGED') { console.log(`#${pr} MERGED @${s.mergedAt} sha=${s.mergeSha}`); pending.delete(pr); continue }
      if (s.state === 'CLOSED') { console.log(`#${pr} CLOSED without merge`); pending.delete(pr); continue }
      if (s.nonRequiredRed.length) console.log(`#${pr} non-required red (recorded, NOT blocking): ${s.nonRequiredRed.join(', ')}`)
      if (s.red.length) {
        const names = s.red.map((c) => c.name).join(', ')
        const flake = s.red.every((c) => isKnownFlake(c.detailsUrl, pr))
        const n = reruns.get(pr) ?? 0
        if (flake && n < MAX_RERUNS) {
          reruns.set(pr, n + 1)
          console.log(`#${pr} ${FLAKE.name} on [${names}] -> rerun ${n + 1}/${MAX_RERUNS}`)
          const run = /\/runs\/(\d+)/.exec(s.red[0].detailsUrl)?.[1]
          if (run) gh(['run', 'rerun', run, '--failed'])
        } else {
          console.log(`#${pr} REQUIRED red, NOT the known flake: ${names} — stopping, needs a human`)
          pending.delete(pr)
        }
      } else {
        console.log(`#${pr} ${s.head} ${s.mergeState} required ${s.green.length}/${required.size} green`
          + (s.running.length ? `, running: ${s.running.join(', ')}` : ''))
      }
    }
    if (pending.size) await new Promise((r) => setTimeout(r, POLL_MS))
  }
  if (pending.size) console.log(`timed out, still open: ${[...pending].join(', ')}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`pr-merge-watch: ${e.message}`); process.exit(1) })
}
