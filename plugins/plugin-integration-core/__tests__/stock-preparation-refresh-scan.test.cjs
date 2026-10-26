'use strict'

// Batch-refresh step 4, PR-3a — P3-C1 SOURCE SCANS (plan-final §3.2 SC-1..SC-5; AMB-14): the wiring the
// behavioural suites prove for the paths they drive, pinned for EVERY call site, so a new caller (or a reorder)
// that skips the governance turns this red before any test of it exists.
//
//   SC-1  every `applyStockPreparationPlan(` call passes `writeFenceRequired: true` and `governance`.
//   SC-2  the chunk route passes `refreshGovernanceGate:` inside its lease callback; the chunk lib refuses a
//         missing gate, consults it and runs the writer's tripwire BEFORE the job turns `running`.
//   SC-3  every route call of the four lib entries that plan through `computeDryRun` (dry-run, reconcile,
//         mvp-persist, apply) carries `refreshGovernance: refreshGovernanceFor(` — exactly four sites.
//   SC-4  the carry consults INSIDE its lease (after the lease is taken, before the ledger pre-flight), then the
//         two rows-based refusals; it never refuses on a suspended pull (`assertPullNotSuspended(` absent).
//   SC-5  `computeDryRun` probes the target fields, THEN consults, THEN runs the B2a pre-read pin and the source
//         read — and each of the four planning entries threads `refreshGovernance: input.refreshGovernance`.
//   SC-6  (PR-3b) each large non-write route — expansion start, run, plan, approve — calls `consultLargeLane(` once,
//         on one line, naming its own lane, AFTER PR B's pilot gate and BEFORE its first IO (the job write and the
//         observation; the B2a claim, the adapter load and the source read; the field probe, the existing-row read,
//         the foreign-row guard and the plan; the probes, the approval and its bump); the plan hands the plan lib
//         `governanceVerdict: planGovernance`; five `consultLargeLane(` sites in all (four routes + the chunk gate).
//   SC-7  (PR-3b, O-1) the large plan's planner call is an explicit literal with no `continuation` key and no spread;
//         the plan validates its verdict before its first storage read and records / deletes it on every plan, outside
//         the plan revision; the approval runs `assertLargePlanApprovable(` before the manual-confirm count, the binder
//         and the storage write.
//
// The scanner strips comments and string bodies before matching, so a mention in prose never satisfies a scan.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const read = (name) => fs.readFileSync(path.join(LIB, name), 'utf8')

const tests = []
const test = (name, fn) => tests.push([name, fn])

// Code only: comments and string / template bodies replaced by spaces (offsets preserved, newlines kept).
function codeOnly(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { out += ' '; i += 1 }
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) { out += source[i] === '\n' ? '\n' : ' '; i += 1 }
      out += '  '
      i += 2
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      out += quote
      i += 1
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') { out += '  '; i += 2; continue }
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += quote
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// The balanced (...) argument text of the call whose name starts at `index` (code-only offsets).
function callArgsAt(code, index) {
  const open = code.indexOf('(', index)
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(' || code[i] === '{' || code[i] === '[') depth += 1
    else if (code[i] === ')' || code[i] === '}' || code[i] === ']') {
      depth -= 1
      if (depth === 0) return { start: open, end: i, text: code.slice(open, i + 1) }
    }
  }
  throw new Error('unbalanced call')
}

// Every CALL of `name(` in `code` (not its declaration, not a property / method of another name).
function callsOf(code, name) {
  const out = []
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$.])${name}\\(`, 'g')
  let match
  while ((match = pattern.exec(code)) !== null) {
    const at = match.index + match[1].length
    const before = code.slice(Math.max(0, at - 16), at)
    if (/function\s*$/.test(before)) continue
    out.push({ at, ...callArgsAt(code, at) })
  }
  return out
}

// The [start, end] offsets of the body of `async function name(` / `function name(` (code-only offsets, which are
// also the raw source's).
function functionSpan(code, name) {
  const at = code.search(new RegExp(`(async\\s+)?function\\s+${name}\\(`))
  assert.ok(at >= 0, `function ${name} exists`)
  const params = callArgsAt(code, code.indexOf(name, at))
  const brace = code.indexOf('{', params.end)
  let depth = 0
  for (let i = brace; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return { start: brace, end: i + 1 }
    }
  }
  throw new Error(`unbalanced body of ${name}`)
}
function functionBody(code, name) {
  const span = functionSpan(code, name)
  return code.slice(span.start, span.end)
}

const libFiles = fs.readdirSync(LIB).filter((name) => name.endsWith('.cjs'))
const raw = Object.fromEntries(libFiles.map((name) => [name, read(name)]))
const code = Object.fromEntries(libFiles.map((name) => [name, codeOnly(raw[name])]))
const HR = code['http-routes.cjs']
const TA = code['stock-preparation-table-actions.cjs']
const LB = code['stock-preparation-large-bom-jobs.cjs']

// A statement with a string literal (`job.status = 'running'`): found in the RAW text, accepted only where the
// code-only text at the same offset is code (not a comment) — the literal's body is blank there.
function rawCodeIndexOf(file, span, literal, codePrefix) {
  const rawBody = raw[file].slice(span.start, span.end)
  const codeBody = code[file].slice(span.start, span.end)
  let from = 0
  for (;;) {
    const at = rawBody.indexOf(literal, from)
    if (at < 0) return -1
    if (codeBody.startsWith(codePrefix, at)) return at
    from = at + 1
  }
}

test('SC-1 every applyStockPreparationPlan( call in lib/ passes writeFenceRequired: true and governance (the small apply and the large chunk, at least)', () => {
  const sites = []
  for (const [file, text] of Object.entries(code)) {
    for (const call of callsOf(text, 'applyStockPreparationPlan')) sites.push({ file, ...call })
  }
  const files = new Set(sites.map((site) => site.file))
  assert.ok(files.has('stock-preparation-table-actions.cjs') && files.has('stock-preparation-large-bom-jobs.cjs'), 'the scan sees both known writers')
  for (const site of sites) {
    assert.match(site.text, /\bwriteFenceRequired:\s*true\b/, `${site.file}: writeFenceRequired: true`)
    assert.match(site.text, /(^|[\s,{])governance(\s*:|\s*,|\s*\})/, `${site.file}: governance`)
  }
})

test('SC-2 the chunk route hands refreshGovernanceGate: INSIDE its lease callback; the chunk lib refuses a missing gate, consults it and runs assertWriterAdmitsPlan( before the job turns running', () => {
  const leaseCalls = []
  const leasePattern = /chunkWriteLock\.withProjectWriteLease\(/g
  let match
  while ((match = leasePattern.exec(HR)) !== null) leaseCalls.push(callArgsAt(HR, match.index))
  assert.equal(leaseCalls.length, 1, 'one chunk lease')
  assert.match(leaseCalls[0].text, /refreshGovernanceGate:\s*\(\{\s*target\s*\}\)\s*=>\s*consultLargeLane\(/, 'the gate is wired inside the lease callback')
  const span = functionSpan(LB, 'runLargeBomCheckpointApplyJobChunk')
  const body = LB.slice(span.start, span.end)
  const absent = body.search(/typeof input\.refreshGovernanceGate !== /)
  const gate = body.indexOf('input.refreshGovernanceGate(')
  const tripwire = body.indexOf('assertWriterAdmitsPlan(')
  const running = rawCodeIndexOf('stock-preparation-large-bom-jobs.cjs', span, "job.status = 'running'", "job.status = '")
  const write = body.indexOf('applyStockPreparationPlan(')
  for (const [label, at] of [['absent refusal', absent], ['gate', gate], ['tripwire', tripwire], ['running', running], ['writer', write]]) assert.ok(at >= 0, `${label} present`)
  assert.ok(absent < gate && gate < tripwire && tripwire < running && running < write, 'refuse-absent < gate < tripwire < running < write')
  assert.equal(body.split('input.refreshGovernanceGate(').length, 2, 'one gate call per chunk')
})

test('SC-3 every route call of dryRunStockPreparationAction / prepareStockPreparationConfirmationDecisions / prepareStockPreparationMvpSnapshot / applyStockPreparationAction carries refreshGovernance: refreshGovernanceFor( — exactly four sites', () => {
  const names = ['dryRunStockPreparationAction', 'prepareStockPreparationConfirmationDecisions', 'prepareStockPreparationMvpSnapshot', 'applyStockPreparationAction']
  let total = 0
  for (const name of names) {
    const calls = callsOf(HR, name)
    assert.equal(calls.length, 1, `${name}: one route call site`)
    for (const call of calls) assert.match(call.text, /refreshGovernance:\s*refreshGovernanceFor\(/, `${name} threads the handle`)
    total += calls.length
  }
  assert.equal(total, 4)
  // ...and nothing else in the route module plans through those entries under another name.
  assert.equal((HR.match(/refreshGovernance:\s*refreshGovernanceFor\(/g) || []).length, 4)
})

test('SC-4 the carry takes its lease, THEN consults (refreshGovernanceFor( ... .consult), THEN the two rows-based refusals, THEN the ledger pre-flight; assertPullNotSuspended( never appears in the carry handler', () => {
  const leasePattern = /projectWriteLock\.withProjectWriteLease\(carryWriteScope,/g
  const leases = []
  let match
  while ((match = leasePattern.exec(HR)) !== null) leases.push(callArgsAt(HR, match.index))
  assert.equal(leases.length, 1, 'one carry lease')
  const callback = leases[0].text
  const consult = callback.search(/refreshGovernanceFor\(tenantId\)\.consult\(/)
  const recovery = callback.indexOf('assertNoUnfinishedExecution(')
  const runbook = callback.indexOf('assertNoRunbookOnlyHold(')
  const binding = callback.indexOf('assertCarryConfirmDecisionBinding(')
  for (const [label, at] of [['consult', consult], ['recovery', recovery], ['runbook', runbook], ['binding', binding]]) assert.ok(at >= 0, `${label} inside the carry lease`)
  assert.ok(consult < recovery && recovery < runbook && runbook < binding, 'consult < recovery < runbook-only < ledger pre-flight')
  const handlerStart = HR.lastIndexOf('async', HR.indexOf('projectWriteLock.withProjectWriteLease(carryWriteScope,'))
  const handlerEnd = leases[0].end
  assert.equal(HR.slice(handlerStart, handlerEnd).includes('assertPullNotSuspended('), false)
})

test('SC-5 computeDryRun: assertTargetFieldsExist( < consultForPlanning( < assertB2aReadHardeningBeforeExpansion( < expandPlmProjectBom( ; the four planning entries thread refreshGovernance: input.refreshGovernance', () => {
  const body = functionBody(TA, 'computeDryRun')
  const probe = body.indexOf('assertTargetFieldsExist(')
  const consult = body.indexOf('consultForPlanning(')
  const b2a = body.indexOf('assertB2aReadHardeningBeforeExpansion(')
  const read = body.indexOf('expandPlmProjectBom(')
  for (const [label, at] of [['probe', probe], ['consult', consult], ['b2a', b2a], ['read', read]]) assert.ok(at >= 0, `${label} present`)
  assert.ok(probe < consult && consult < b2a && b2a < read)
  for (const name of ['dryRunStockPreparationAction', 'prepareStockPreparationConfirmationDecisions', 'prepareStockPreparationMvpSnapshot', 'applyStockPreparationAction']) {
    const entry = functionBody(TA, name)
    const calls = callsOf(entry, 'computeDryRun')
    assert.equal(calls.length, 1, `${name}: one computeDryRun`)
    assert.match(calls[0].text, /refreshGovernance:\s*input\.refreshGovernance\b/, `${name} threads the handle`)
  }
  assert.equal(callsOf(TA, 'computeDryRun').length, 4, 'no fifth planning entry')
})

test('SC-6 (PR-3b) each large non-write route calls consultLargeLane( once, on one line, for its own lane, AFTER assertLargeLaneAllowedForPilot( and BEFORE its first IO; the plan hands the lib governanceVerdict: planGovernance; five consultLargeLane( sites in all', () => {
  const ROUTES = {
    tableActionLargeBomExpansionJobStart: { lane: 'large_expansion_start', io: ['createLargeBomBackgroundExpansionJob(', 'observeGeneration('] },
    tableActionLargeBomExpansionJobRun: { lane: 'large_expansion_run', io: ['assertB2aReadAuthorization(', 'b2aTableActionSourceObjects(', 'loadTableActionSourceAdapter(', 'runLargeBomBackgroundExpansionJob('] },
    tableActionLargeBomExpansionJobPlan: { lane: 'large_plan', io: ['assertTargetFieldsExist(', 'readExistingStockPreparationRows(', 'assertTargetSheetHoldsNoForeignActiveRows(', 'loadTableScopeConflictPolicies(', 'planLargeBomBackgroundExpansionJob(', 'resolveInstalledFieldProperties('] },
    tableActionLargeBomApplyJobStart: { lane: 'large_approve', io: ['assertTargetFieldsExist(', 'assertTargetSheetHoldsNoForeignActiveRows(', 'resolveInstalledFieldProperties(', 'createLargeBomCheckpointApplyJob(', 'bumpGeneration('] },
  }
  const rawRoutes = raw['http-routes.cjs']
  for (const [handler, spec] of Object.entries(ROUTES)) {
    const start = HR.indexOf(`    async ${handler}(req, res) {`)
    assert.ok(start >= 0, `${handler} exists`)
    const end = HR.indexOf('\n    },', start)
    const body = HR.slice(start, end)
    const rawBody = rawRoutes.slice(start, end)
    const consults = callsOf(body, 'consultLargeLane')
    assert.equal(consults.length, 1, `${handler}: exactly one consult`)
    const consultAt = consults[0].at
    const pilotAt = body.indexOf('assertLargeLaneAllowedForPilot(')
    assert.ok(pilotAt >= 0 && pilotAt < consultAt, `${handler}: the consult follows PR B's pilot gate`)
    for (const io of spec.io) {
      const at = body.indexOf(io)
      assert.ok(at >= 0, `${handler}: ${io} present (the scan is not vacuous)`)
      assert.ok(consultAt < at, `${handler}: the consult precedes ${io}`)
    }
    const lineStart = rawBody.lastIndexOf('\n', consultAt) + 1
    const consultLine = rawBody.slice(lineStart, rawBody.indexOf('\n', consultAt))
    assert.ok(consultLine.includes(`, '${spec.lane}')`), `${handler}: the consult names lane ${spec.lane}: ${consultLine.trim()}`)
    assert.ok(/\)\s*$/.test(consultLine), `${handler}: the consult is a single-line call (C-06 slicing rule)`)
  }
  const planStart = HR.indexOf('    async tableActionLargeBomExpansionJobPlan(req, res) {')
  const planBody = HR.slice(planStart, HR.indexOf('\n    },', planStart))
  assert.match(planBody, /const planGovernance = await consultLargeLane\(/, 'the plan keeps the verdict')
  const planCalls = callsOf(planBody, 'planLargeBomBackgroundExpansionJob')
  assert.equal(planCalls.length, 1)
  assert.match(planCalls[0].text, /\bgovernanceVerdict:\s*planGovernance\b/, 'the verdict rides into the plan')
  assert.equal(callsOf(HR, 'consultLargeLane').length, 5, 'four non-write routes + the chunk gate')
})

test('SC-7 (PR-3b, O-1) the large plan hands the planner an explicit literal — no `continuation` key, no spread — validates its verdict before the first storage read and records / deletes it on every plan, outside the plan revision; the approval runs assertLargePlanApprovable( before the manual-confirm count, the binder and the storage write', () => {
  const planBody = functionBody(LB, 'planLargeBomBackgroundExpansionJob')
  const plannerCalls = callsOf(planBody, 'planStockPreparationConflicts')
  assert.equal(plannerCalls.length, 1, 'one planner call')
  assert.equal(/(^|[\s,{])continuation\b/.test(plannerCalls[0].text), false, 'the planner input names no `continuation`')
  assert.equal(plannerCalls[0].text.includes('...'), false, 'no spread into the planner input')
  const verdictAt = planBody.indexOf('normalizeLargePlanGovernanceVerdict(')
  const firstRead = planBody.indexOf('storage.get(')
  assert.ok(verdictAt >= 0 && firstRead >= 0 && verdictAt < firstRead, 'the verdict is validated before the first storage read')
  assert.match(planBody, /if \(governanceVerdict\) job\.governanceVerdict = governanceVerdict/)
  assert.match(planBody, /else delete job\.governanceVerdict/)
  assert.equal(functionBody(LB, 'largeBomPlanRevision').includes('governanceVerdict'), false, 'the verdict is outside the plan revision')
  const approveBody = functionBody(LB, 'createLargeBomCheckpointApplyJob')
  const refuse = approveBody.indexOf('assertLargePlanApprovable(')
  assert.ok(refuse >= 0, 'the approval refuses')
  for (const later of ['countManualConfirmDecisions(', 'writeGenerationBinder(', 'storage.set(']) {
    const at = approveBody.indexOf(later)
    assert.ok(at >= 0 && refuse < at, `the approval refusal precedes ${later}`)
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-refresh-scan.test.cjs', tests)
