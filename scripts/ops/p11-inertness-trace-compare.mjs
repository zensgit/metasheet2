#!/usr/bin/env node
/**
 * P1-1 settlement coordination, S5 G1 — compares two directories of normalised entry traces written by
 * `packages/core-backend/tests/integration/attendance-p11-inertness-baseline.db.test.ts`
 * (`P11_TRACE_DIR`), one from the base `d671019f2b` and one from the head, and exits non-zero unless
 * every difference is on the allow-list below.
 *
 *   node scripts/ops/p11-inertness-trace-compare.mjs <base-dir> <head-dir> [--resources strict|report]
 *
 * Exit codes: 0 no unexplained difference; 1 at least one; 2 bad arguments or unreadable input.
 *
 * Any two directories work, so run the head against itself first (two runs on one machine) to see the
 * noise floor; a difference that also shows up head-vs-head is not attributable to the change.
 *
 * What is compared, per entry (`<entry>.json`, format `p11-inertness-trace/v1`):
 *  - `steps`, in order: each checkout (`acquire`) and return (`release`, with whether pg was asked to
 *    destroy the connection) on the main pool, and each statement (borrow label, normalised text,
 *    bind-value count, success or SQLSTATE, the advisory-lock kinds held after it). Any insertion,
 *    removal or change is a difference.
 *  - other top-level fields (e.g. the sweep's `candidateBorrows`) are printed, never compared: they
 *    depend on rows other suites left in the shared database.
 * `_meta.json`: the entry list and pool size must match. `_resources.json`: active resources by type
 *  after boot and after the entries. The after-boot counts are always reported only (the server's own
 *  start-up work may still be in flight, and a head-vs-head run differed there); for the after-entries
 *  counts `--resources strict` (default) treats a difference as a difference and `--resources report`
 *  only prints it.
 * Files of any other format in the directories (e.g. `hotpath.json`) are skipped.
 *
 * Blind spot: the traces fold every string and numeric literal (`'?'`, `<n>`), so a statement whose
 * only change is a literal (a setting name, an enum value, an inlined constant) compares as the same.
 * The traces also never carry bind values. Literal-level changes need a reading of the diff itself.
 *
 * Allow-list. The contract allows exactly two production changes (BASELINE.md, first-package goal:
 * 「状态不确定连接销毁、生产嵌套访问计数」). Neither can show up in these traces:
 *  1. 「状态不确定连接销毁」 — a releaser passes the runner's error to `release(err)` only when the
 *     runner marked it uncertain (ROLLBACK failed, or COMMIT failed with something other than
 *     40001 / 40P01), and `index.ts`'s providers now forward that argument. Every traced entry takes
 *     its happy path or a refusal that rolls back cleanly, so the releasers pass `undefined` on both
 *     refs and every `release` step reads `destroy: false` on both. Expected difference: none.
 *  2. 「生产嵌套访问计数」 — the head's main-pool `connect` notes the access in the coordination context.
 *     Outside a context (always, for these entries) it returns at once; it sends no statement, takes
 *     no lock and starts no timer. Expected difference: none in `steps`, none in `_resources`.
 * So the allow-list is empty, deliberately: an entry is only ever added with the change it explains,
 * the trace lines it may touch, and why.
 */
import fs from 'node:fs'
import path from 'node:path'

const TRACE_FORMAT = 'p11-inertness-trace/v1'

/**
 * Each entry: { change, entry (exact id or '*'), matches(line) → boolean, why }. A difference line is
 * allowed only if some entry matches it. Empty on purpose (see the header).
 */
const ALLOWED_DIFFERENCES = Object.freeze([])

function usage(message) {
  if (message) process.stderr.write(`${message}\n`)
  process.stderr.write('usage: node scripts/ops/p11-inertness-trace-compare.mjs <base-dir> <head-dir> [--resources strict|report] [--order borrow|strict]\n')
  process.exit(2)
}

function parseArgs(argv) {
  const positional = []
  let resources = 'strict'
  let order = 'borrow'
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--resources') {
      const value = argv[i + 1]
      if (value !== 'strict' && value !== 'report') usage('--resources takes strict or report')
      resources = value
      i += 1
    } else if (arg === '--order') {
      const value = argv[i + 1]
      if (value !== 'borrow' && value !== 'strict') usage('--order takes borrow or strict')
      order = value
      i += 1
    } else if (arg.startsWith('--')) {
      usage(`unknown option ${arg}`)
    } else {
      positional.push(arg)
    }
  }
  if (positional.length !== 2) usage('two trace directories are required')
  return { baseDir: positional[0], headDir: positional[1], resources, order }
}

function readDir(dir) {
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch (error) {
    usage(`cannot read ${dir}: ${error.code ?? error.message}`)
  }
  const out = new Map()
  for (const name of names) {
    let data
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch (error) {
      usage(`cannot parse ${path.join(dir, name)}: ${error.message}`)
    }
    out.set(name, data)
  }
  return out
}

function stepLine(step) {
  if (step.k === 'acquire') return `acquire ${step.b}`
  if (step.k === 'release') return `release ${step.b} destroy=${step.destroy === true}`
  const outcome = step.ok === true ? 'ok' : step.ok === false ? `ERR:${step.code ?? '?'}` : 'unsettled'
  const locks = Array.isArray(step.locks) && step.locks.length > 0 ? ` locks=[${step.locks.join(',')}]` : ''
  return `q ${step.b} ${outcome} n=${step.n ?? 0}${locks} ${step.sql ?? ''}`
}

/**
 * Per-borrow view (the default, `--order borrow`): one line per checkout — its statements in order, then
 * how it was returned — with the borrow label dropped and the lines sorted. An entry that runs work
 * concurrently (parallel queries, post-commit handlers) interleaves its borrows differently from run to
 * run, and checkout order (hence the labels) varies with it; a changed statement, an extra or missing
 * checkout, or a statement moved between transactions still shows. `--order strict` compares the full
 * step order instead.
 */
function borrowLines(steps) {
  const order = []
  const byBorrow = new Map()
  for (const step of steps ?? []) {
    const borrow = step.b ?? '?'
    if (!byBorrow.has(borrow)) {
      byBorrow.set(borrow, [])
      order.push(borrow)
    }
    if (step.k === 'acquire') continue
    if (step.k === 'release') {
      byBorrow.get(borrow).push(`release destroy=${step.destroy === true}`)
      continue
    }
    byBorrow.get(borrow).push(stepLine(step).replace(/^q \S+ /, 'q '))
  }
  return order.map((borrow) => byBorrow.get(borrow).join(' ⏎ ')).sort()
}

/** Line diff (longest common subsequence); returns [{ op: ' ' | '-' | '+', line }]. */
function diffLines(a, b) {
  const n = a.length
  const m = b.length
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i] })
      i += 1
      j += 1
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      out.push({ op: '-', line: a[i] })
      i += 1
    } else {
      out.push({ op: '+', line: b[j] })
      j += 1
    }
  }
  while (i < n) out.push({ op: '-', line: a[i++] })
  while (j < m) out.push({ op: '+', line: b[j++] })
  return out
}

function allowed(entry, line) {
  return ALLOWED_DIFFERENCES.find((rule) => (rule.entry === '*' || rule.entry === entry) && rule.matches(line)) ?? null
}

function printDiff(diff) {
  const changed = diff.map((row, index) => (row.op === ' ' ? -1 : index)).filter((index) => index >= 0)
  const show = new Set()
  for (const index of changed) for (let k = Math.max(0, index - 2); k <= Math.min(diff.length - 1, index + 2); k += 1) show.add(k)
  let last = -1
  for (const index of [...show].sort((x, y) => x - y)) {
    if (last >= 0 && index > last + 1) process.stdout.write('    …\n')
    process.stdout.write(`  ${diff[index].op} ${diff[index].line}\n`)
    last = index
  }
}

function main() {
  const { baseDir, headDir, resources, order } = parseArgs(process.argv.slice(2))
  const base = readDir(baseDir)
  const head = readDir(headDir)
  let unexplained = 0
  const note = (line) => process.stdout.write(`${line}\n`)

  // _meta
  const baseMeta = base.get('_meta.json')
  const headMeta = head.get('_meta.json')
  if (!baseMeta || !headMeta) {
    note(`META missing in ${!baseMeta ? 'base' : 'head'}`)
    unexplained += 1
  } else {
    if (JSON.stringify(baseMeta.entries) !== JSON.stringify(headMeta.entries)) {
      note(`META entry lists differ: base ${JSON.stringify(baseMeta.entries)} head ${JSON.stringify(headMeta.entries)}`)
      unexplained += 1
    }
    if (baseMeta.poolMax !== headMeta.poolMax) {
      note(`META pool size differs: base ${baseMeta.poolMax} head ${headMeta.poolMax}`)
      unexplained += 1
    }
    note(`META node base ${baseMeta.node} head ${headMeta.node}; pool ${baseMeta.poolMax}`)
  }

  // _resources
  const baseRes = base.get('_resources.json')
  const headRes = head.get('_resources.json')
  if (!baseRes || !headRes) {
    note(`RESOURCES missing in ${!baseRes ? 'base' : 'head'}`)
    unexplained += 1
  } else {
    for (const phase of ['afterBoot', 'afterEntries']) {
      const a = baseRes[phase] ?? {}
      const b = headRes[phase] ?? {}
      const kinds = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      const differing = kinds.filter((kind) => (a[kind] ?? 0) !== (b[kind] ?? 0))
      if (differing.length === 0) {
        note(`RESOURCES ${phase}: same (${kinds.map((kind) => `${kind}=${a[kind] ?? 0}`).join(' ')})`)
        continue
      }
      // The boot snapshot is taken while the server's own start-up work may still be in flight, so its
      // counts vary from run to run (a head-against-head run differed there); it is reported only. The
      // after-entries snapshot is taken once every entry has gone quiet and is the stable evidence that no
      // timer or handle was added.
      const reportOnly = resources === 'report' || phase === 'afterBoot'
      note(`RESOURCES ${phase}: ${differing.map((kind) => `${kind} base=${a[kind] ?? 0} head=${b[kind] ?? 0}`).join('; ')}${reportOnly ? ' (report only)' : ''}`)
      if (!reportOnly) unexplained += 1
    }
  }

  // entries
  const isTrace = (data) => data && data.format === TRACE_FORMAT && typeof data.entry === 'string'
  const names = [...new Set([...base.keys(), ...head.keys()])].filter((name) => !name.startsWith('_')).sort()
  for (const name of names) {
    const a = base.get(name)
    const b = head.get(name)
    if ((a && !isTrace(a)) || (b && !isTrace(b))) {
      note(`SKIP ${name} (not a ${TRACE_FORMAT} file)`)
      continue
    }
    if (!a || !b) {
      note(`ENTRY ${name}: missing in ${!a ? 'base' : 'head'}`)
      unexplained += 1
      continue
    }
    const entry = a.entry
    const extra = Object.keys(a).filter((key) => !['format', 'entry', 'steps'].includes(key))
    for (const key of extra) note(`ENTRY ${entry}: ${key} base=${JSON.stringify(a[key])} head=${JSON.stringify(b[key])} (report only)`)
    const view = order === 'borrow' ? borrowLines : (steps) => (steps ?? []).map(stepLine)
    const diff = diffLines(view(a.steps), view(b.steps))
    const changed = diff.filter((row) => row.op !== ' ')
    if (changed.length === 0) {
      note(`ENTRY ${entry}: same (${(a.steps ?? []).length} steps)`)
      continue
    }
    const open = changed.filter((row) => !allowed(entry, row.line))
    note(`ENTRY ${entry}: ${changed.length} differing line(s), ${changed.length - open.length} on the allow-list`)
    printDiff(diff)
    if (open.length > 0) unexplained += 1
  }

  note(unexplained === 0 ? 'RESULT no unexplained difference' : `RESULT ${unexplained} unexplained difference group(s)`)
  process.exit(unexplained === 0 ? 0 : 1)
}

main()
